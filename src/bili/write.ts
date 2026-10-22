/**
 * B 站写能力（M3 只做「发评论 / 楼中楼回复 / 删自己的评论」）。
 *
 * 职责：把写请求的**形状**与**执行**分开：
 *   - `planComment()` 是纯函数：给出 method/path/form（cookie 与 csrf 打码），
 *     dry-run、报告、面板预览都复用它，**绝不**在只读路径里发请求；
 *   - `postComment()` / `deleteComment()` 真正发送：串行、写间隔 5s + 抖动、不重试；
 *   - 错误按 kind 归类（auth / risk / rate / network / business），交给上层决定停写与冷却。
 * 不做什么：不判断「该不该发」（在 gate.ts）、不记账（在编排器）、不读文件。
 *
 * 依据：`docs/bili-readonly-api-spec.md` 的写接口一节；写接口必须带 `csrf=bili_jct` 并做 WBI 签名。
 */

import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import type { AppErrorShape } from '../shared/errors.ts';

/** 我们内部把错误叫 BiliError，实际就是统一的 AppErrorShape（kind/code/message）。 */
type BiliError = AppErrorShape;
import { redact } from '../shared/redact.ts';
import type { Transport } from './http.ts';

export type WriteAction = 'comment' | 'reply' | 'deleteComment';

export interface WritePlan {
  action: WriteAction;
  method: 'POST';
  url: string;
  /** 将要发送的表单（csrf 已打码）。 */
  form: Record<string, string>;
  /** 人话摘要（面板与报告里用）。 */
  summary: string;
}

export interface WriteOutcome {
  ok: boolean;
  action: WriteAction;
  plan: WritePlan;
  dryRun: boolean;
  /** 发出去后的 rpid（拿不到就是 undefined，绝不编）。 */
  rpid?: string;
  error?: BiliError;
}

export interface CommentInput {
  bvid: string;
  aid: number;
  message: string;
  /** 楼中楼：被回复的根评论 rpid。 */
  root?: string;
  /** 楼中楼：直接回复的那条 rpid。 */
  parent?: string;
}

export interface DeleteInput {
  bvid: string;
  aid: number;
  rpid: string;
}

export interface WriterDeps {
  http: Transport;
  /** 每次发送时取一次 csrf（bili_jct），登录后换 cookie 不用重建。 */
  csrf: () => string;
  logger: Logger;
  /** 写间隔（毫秒）；默认 5s + 0–1s 抖动（§7.4 限速）。 */
  minIntervalMs?: number;
  now?: () => number;
  /** 测试注入：跳过节流等待。 */
  skipThrottle?: boolean;
}

const ADD_URL = 'https://api.bilibili.com/x/v2/reply/add';
const DEL_URL = 'https://api.bilibili.com/x/v2/reply/del';
const WRITE_INTERVAL_MS = 5_000;

export class BiliWriter {
  private readonly deps: WriterDeps;
  private lastWriteAt = 0;

  constructor(deps: WriterDeps) {
    this.deps = deps;
  }

  /** 纯函数：算出这次要发的请求长什么样（csrf 打码）。 */
  planComment(input: CommentInput): WritePlan {
    const isReply = Boolean(input.root && input.parent);
    const form: Record<string, string> = {
      oid: String(input.aid),
      type: '1',
      message: input.message,
      plat: '1',
      csrf: maskCsrf(this.deps.csrf()),
    };
    if (isReply) {
      form.root = String(input.root);
      form.parent = String(input.parent);
    }
    return {
      action: isReply ? 'reply' : 'comment',
      method: 'POST',
      url: ADD_URL,
      form,
      summary: isReply
        ? `在 ${input.bvid} 的评论 #${input.root} 下回复 #${input.parent}（${countChars(input.message)} 字）`
        : `在 ${input.bvid} 发一条评论（${countChars(input.message)} 字）`,
    };
  }

  planDelete(input: DeleteInput): WritePlan {
    return {
      action: 'deleteComment',
      method: 'POST',
      url: DEL_URL,
      form: { oid: String(input.aid), type: '1', rpid: String(input.rpid), csrf: maskCsrf(this.deps.csrf()) },
      summary: `删除 ${input.bvid} 下自己发的评论 #${input.rpid}`,
    };
  }

  /** 发评论（或楼中楼回复）。dryRun 时只返回 plan，不发请求。 */
  async postComment(input: CommentInput, options: { dryRun: boolean }): Promise<WriteOutcome> {
    const plan = this.planComment(input);
    if (options.dryRun) {
      this.deps.logger.info('bili.write', `预演（未发送）：${plan.summary}`);
      return { ok: true, action: plan.action, plan, dryRun: true };
    }
    const csrf = this.deps.csrf();
    if (!csrf) {
      const error: BiliError = { kind: 'auth', code: 'no_csrf', message: '缺 bili_jct（csrf），无法写：请重新扫码登录' };
      return { ok: false, action: plan.action, plan, dryRun: false, error };
    }

    const form: Record<string, string> = {
      oid: String(input.aid),
      type: '1',
      message: input.message,
      plat: '1',
      csrf,
    };
    if (plan.action === 'reply') {
      form.root = String(input.root);
      form.parent = String(input.parent);
    }

    await this.throttle();
    const res = await this.deps.http.jsonEnvelope<{ rpid?: number; rpid_str?: string }>({
      url: ADD_URL,
      method: 'POST',
      form,
      sign: true,
      noRetry: true,
      timeoutMs: 20_000,
    });

    if (!res.ok) {
      this.deps.logger.warn('bili.write', `发送失败：${res.error.message}`, { kind: res.error.kind });
      return { ok: false, action: plan.action, plan, dryRun: false, error: res.error };
    }
    if (res.data.code !== 0) {
      const error = classifyBusiness(res.data.code, res.data.message);
      return { ok: false, action: plan.action, plan, dryRun: false, error };
    }

    const rpid = pickRpid(res.data.data);
    this.deps.logger.info('bili.write', `已发送：${plan.summary}${rpid ? `（rpid ${rpid}）` : '（没拿到 rpid）'}`);
    return { ok: true, action: plan.action, plan, dryRun: false, ...(rpid ? { rpid } : {}) };
  }

  /** 删自己发的评论（只在面板手动触发，二次确认在 UI 层）。 */
  async deleteComment(input: DeleteInput, options: { dryRun: boolean }): Promise<WriteOutcome> {
    const plan = this.planDelete(input);
    if (options.dryRun) {
      return { ok: true, action: plan.action, plan, dryRun: true };
    }
    const csrf = this.deps.csrf();
    if (!csrf) {
      return { ok: false, action: plan.action, plan, dryRun: false, error: { kind: 'auth', code: 'no_csrf', message: '缺 bili_jct（csrf），无法删除' } };
    }

    await this.throttle();
    const res = await this.deps.http.jsonEnvelope<unknown>({
      url: DEL_URL,
      method: 'POST',
      form: { oid: String(input.aid), type: '1', rpid: String(input.rpid), csrf },
      sign: true,
      noRetry: true,
      timeoutMs: 20_000,
    });
    if (!res.ok) return { ok: false, action: plan.action, plan, dryRun: false, error: res.error };
    if (res.data.code !== 0) {
      return { ok: false, action: plan.action, plan, dryRun: false, error: classifyBusiness(res.data.code, res.data.message) };
    }
    return { ok: true, action: plan.action, plan, dryRun: false };
  }

  /** 写间隔：5s + 0–1s 抖动；测试可以跳过。 */
  private async throttle(): Promise<void> {
    if (this.deps.skipThrottle) return;
    const now = this.deps.now?.() ?? Date.now();
    const interval = this.deps.minIntervalMs ?? WRITE_INTERVAL_MS;
    const wait = this.lastWriteAt === 0 ? 0 : Math.max(0, this.lastWriteAt + interval - now);
    const jitter = wait > 0 ? 0 : Math.floor(Math.random() * 1000);
    if (wait + jitter > 0) await sleep(wait + jitter);
    this.lastWriteAt = this.deps.now?.() ?? Date.now();
  }
}

/** 从响应里取 rpid（数字或字符串都认）；取不到返回 null，绝不编。 */
export function pickRpid(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const raw = record.rpid_str ?? record.rpid;
  if (typeof raw === 'string' && raw.trim().length > 0 && raw !== '0') return raw.trim();
  if (typeof raw === 'number' && raw > 0) return String(raw);
  return null;
}

/** 业务错误 → 我们的错误分类（-101 未登录、-111 csrf、12015 验证码、12051 刷屏…）。 */
export function classifyBusiness(code: number, message: string): BiliError {
  const base = { code, message: message || `code ${code}` };
  if (code === -101) return { kind: 'auth', ...base, message: `${message || '未登录'}（cookie 可能过期了）` };
  if (code === -111) return { kind: 'auth', ...base, message: `${message || 'csrf 校验失败'}（SESSDATA 与 bili_jct 不是同一次会话）` };
  if (code === -412 || code === 412 || code === -352 || code === -509) return { kind: 'risk', ...base };
  if (code === 12015) return { kind: 'risk', ...base, message: `${message || '需要验证码'}（撞风控了）` };
  if (code === 12051) return { kind: 'risk', ...base, message: `${message || '刷屏'}（发太快了）` };
  if (code === 12002 || code === 12009) return { kind: 'rate', ...base };
  return { kind: 'business', ...base };
}

/** 字符数（按码点算，emoji 算一个）。 */
export function countChars(text: string): number {
  return Array.from(text).length;
}

function maskCsrf(csrf: string): string {
  if (!csrf) return '（缺 bili_jct）';
  return `${csrf.slice(0, 4)}…${csrf.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只给日志/报告用：把 plan 打成一行（不含 cookie、csrf 已打码）。 */
export function describePlan(plan: WritePlan): string {
  const form = Object.entries(plan.form)
    .map(([key, value]) => `${key}=${redact(String(value))}`)
    .join('&');
  return `${plan.method} ${plan.url} · ${form}`;
}
