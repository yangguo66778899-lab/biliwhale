/**
 * B 站写能力（M3：评论/楼中楼/删自己的评论；M4：收藏/点赞/私信/动态）。
 *
 * 职责：把写请求的**形状**与**执行**分开：
 *   - `planXxx()` 是纯函数：给出 method/path/form（cookie 与 csrf 打码），
 *     dry-run、报告、面板预览都复用它，**绝不**在只读路径里发请求；
 *   - 执行方法真正发送：串行、写间隔（默认 5s + 抖动；私信 1s）、不重试；
 *   - 错误按 kind 归类（auth / risk / rate / network / business），交给上层决定停写与冷却。
 * 不做什么：不判断「该不该发」（gate / fav 判据 / 开关在编排器）、不记账、不读文件。
 *
 * 依据：`docs/bili-readonly-api-spec.md` 的写接口一节；写接口必须带 `csrf=bili_jct`。
 * **私信与动态的接口形状是照着公开实现写的，还没有在你的账号上验过**（M4 验收记录里标了 ⏳）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import type { AppErrorShape } from '../shared/errors.ts';
import { redact } from '../shared/redact.ts';
import type { Transport } from './http.ts';

/** 我们内部把错误叫 BiliError，实际就是统一的 AppErrorShape（kind/code/message）。 */
type BiliError = AppErrorShape;

export type WriteAction =
  | 'comment'
  | 'reply'
  | 'deleteComment'
  | 'fav'
  | 'unfav'
  | 'like'
  | 'unlike'
  | 'dm'
  | 'dynamic';

export interface WritePlan {
  action: WriteAction;
  method: 'POST';
  url: string;
  /** 将要发送的表单（csrf 与 cookie 已打码）。 */
  form: Record<string, string>;
  /** 人话摘要（面板与报告里用）。 */
  summary: string;
}

export interface WriteOutcome {
  ok: boolean;
  action: WriteAction;
  plan: WritePlan;
  dryRun: boolean;
  /** 发出去后的 rpid（评论才有；拿不到就是 undefined，绝不编）。 */
  rpid?: string;
  /** 私信才有：这条消息的 msg_key / 序号（拿不到就不填）。 */
  messageId?: string;
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

export interface FavInput {
  bvid: string;
  aid: number;
  /** 目标收藏夹；空 = 默认收藏夹（由代码用 add_media_ids 空串表示）。 */
  mediaId?: string;
}

export interface LikeInput {
  bvid: string;
  aid: number;
}

export interface DmInput {
  /** 收信人 mid（只允许主人，白名单在上层）。 */
  receiverId: number;
  text: string;
  /** 自己的 mid（发送时要带）。 */
  senderId: number;
  /** 设备 id，web 端固定值（可配）。 */
  devId?: string;
}

export interface DynamicInput {
  text: string;
  /** 可选：图片 URL 列表（M4 只支持纯文本，留空）。 */
  images?: string[];
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
const FAV_URL = 'https://api.bilibili.com/x/v3/fav/resource/deal';
const LIKE_URL = 'https://api.bilibili.com/x/web-interface/archive/like';
const DM_URL = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg';
const DYNAMIC_URL = 'https://api.bilibili.com/x/dynamic/feed/create/dyn';
const WRITE_INTERVAL_MS = 5_000;
const DM_INTERVAL_MS = 1_000;

export class BiliWriter {
  private readonly deps: WriterDeps;
  private lastWriteAt = 0;

  constructor(deps: WriterDeps) {
    this.deps = deps;
  }

  /* ---------------- 评论（M3） ---------------- */

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
    if (!csrf) return this.noCsrf(plan);

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

    const res = await this.send({ url: ADD_URL, form, plan });
    if (!res.ok) return res.outcome;
    const rpid = pickRpid(res.data);
    return { ok: true, action: plan.action, plan, dryRun: false, ...(rpid ? { rpid } : {}) };
  }

  /** 删自己发的评论（只在面板手动触发，二次确认在 UI 层）。 */
  async deleteComment(input: DeleteInput, options: { dryRun: boolean }): Promise<WriteOutcome> {
    const plan = this.planDelete(input);
    if (options.dryRun) return { ok: true, action: plan.action, plan, dryRun: true };
    const csrf = this.deps.csrf();
    if (!csrf) return this.noCsrf(plan);

    const res = await this.send({ url: DEL_URL, form: { oid: String(input.aid), type: '1', rpid: String(input.rpid), csrf }, plan });
    return res.ok ? { ok: true, action: plan.action, plan, dryRun: false } : res.outcome;
  }

  /* ---------------- 收藏（M4） ---------------- */

  planFav(input: FavInput, add: boolean): WritePlan {
    const form: Record<string, string> = {
      rid: String(input.aid),
      type: '2',
      add_media_ids: add ? (input.mediaId ?? '') : '',
      del_media_ids: add ? '' : (input.mediaId ?? ''),
      csrf: maskCsrf(this.deps.csrf()),
    };
    return {
      action: add ? 'fav' : 'unfav',
      method: 'POST',
      url: FAV_URL,
      form,
      summary: `${add ? '收藏' : '取消收藏'} ${input.bvid}${input.mediaId ? `（收藏夹 ${input.mediaId}）` : '（默认收藏夹）'}`,
    };
  }

  async favVideo(input: FavInput, options: { dryRun: boolean }): Promise<WriteOutcome> {
    return this.simpleWrite(this.planFav(input, true), options);
  }

  async unfavVideo(input: FavInput, options: { dryRun: boolean }): Promise<WriteOutcome> {
    return this.simpleWrite(this.planFav(input, false), options);
  }

  /* ---------------- 点赞（M4） ---------------- */

  planLike(input: LikeInput, like: boolean): WritePlan {
    return {
      action: like ? 'like' : 'unlike',
      method: 'POST',
      url: LIKE_URL,
      form: { aid: String(input.aid), like: like ? '1' : '0', csrf: maskCsrf(this.deps.csrf()) },
      summary: `${like ? '点赞' : '取消点赞'} ${input.bvid}`,
    };
  }

  async likeVideo(input: LikeInput, like: boolean, options: { dryRun: boolean }): Promise<WriteOutcome> {
    return this.simpleWrite(this.planLike(input, like), options);
  }

  /* ---------------- 私信（M4） ---------------- */

  planDm(input: DmInput): WritePlan {
    const content = JSON.stringify({ content: input.text });
    return {
      action: 'dm',
      method: 'POST',
      url: DM_URL,
      form: {
        'msg[sender_uid]': String(input.senderId),
        'msg[receiver_id]': String(input.receiverId),
        'msg[receiver_type]': '1',
        'msg[msg_type]': '1',
        'msg[dev_id]': input.devId ?? 'BiliWhale',
        'msg[timestamp]': String(Math.floor((this.deps.now?.() ?? Date.now()) / 1000)),
        'msg[content]': content,
        csrf: maskCsrf(this.deps.csrf()),
      },
      summary: `给 ${input.receiverId} 发一条私信（${countChars(input.text)} 字）`,
    };
  }

  /**
   * 发私信。注意：接口形状照公开实现写的，**还没在真账号上验过**。
   * 私信限速 1s（§7.11「连续发送间隔 ≥1s」）。
   */
  async sendDm(input: DmInput, options: { dryRun: boolean }): Promise<WriteOutcome> {
    const plan = this.planDm(input);
    if (options.dryRun) {
      this.deps.logger.info('bili.write', `预演（未发送）：${plan.summary}`);
      return { ok: true, action: 'dm', plan, dryRun: true };
    }
    const csrf = this.deps.csrf();
    if (!csrf) return this.noCsrf(plan);

    const res = await this.send(
      {
        url: DM_URL,
        form: {
          'msg[sender_uid]': String(input.senderId),
          'msg[receiver_id]': String(input.receiverId),
          'msg[receiver_type]': '1',
          'msg[msg_type]': '1',
          'msg[dev_id]': input.devId ?? 'BiliWhale',
          'msg[timestamp]': String(Math.floor((this.deps.now?.() ?? Date.now()) / 1000)),
          'msg[content]': JSON.stringify({ content: input.text }),
          csrf,
        },
        plan,
        intervalMs: DM_INTERVAL_MS,
        sign: false,
      },
    );
    if (!res.ok) return res.outcome;
    const messageId = pickMessageId(res.data);
    return { ok: true, action: 'dm', plan, dryRun: false, ...(messageId ? { messageId } : {}) };
  }

  /* ---------------- 动态（M4，默认关） ---------------- */

  planDynamic(input: DynamicInput): WritePlan {
    const dynReq = JSON.stringify({
      content: { contents: [{ raw_text: input.text, type: 1, biz_id: '' }] },
      scene: 1,
      meta: { app_meta: { from_src: 'biliwhale' } },
    });
    return {
      action: 'dynamic',
      method: 'POST',
      url: DYNAMIC_URL,
      form: { dyn_req: dynReq, csrf: maskCsrf(this.deps.csrf()) },
      summary: `发一条动态（${countChars(input.text)} 字）`,
    };
  }

  /** 发动态。默认关；只在面板二次确认后调用，一轮里**从不自动发**。 */
  async postDynamic(input: DynamicInput, options: { dryRun: boolean }): Promise<WriteOutcome> {
    const plan = this.planDynamic(input);
    if (options.dryRun) return { ok: true, action: 'dynamic', plan, dryRun: true };
    const csrf = this.deps.csrf();
    if (!csrf) return this.noCsrf(plan);

    const dynReq = JSON.stringify({
      content: { contents: [{ raw_text: input.text, type: 1, biz_id: '' }] },
      scene: 1,
      meta: { app_meta: { from_src: 'biliwhale' } },
    });
    const res = await this.send({ url: DYNAMIC_URL, form: { dyn_req: dynReq, csrf }, plan, sign: false });
    return res.ok ? { ok: true, action: 'dynamic', plan, dryRun: false } : res.outcome;
  }

  /* ---------------- 内部：统一发送 ---------------- */

  private async simpleWrite(plan: WritePlan, options: { dryRun: boolean }): Promise<WriteOutcome> {
    if (options.dryRun) {
      this.deps.logger.info('bili.write', `预演（未发送）：${plan.summary}`);
      return { ok: true, action: plan.action, plan, dryRun: true };
    }
    const csrf = this.deps.csrf();
    if (!csrf) return this.noCsrf(plan);

    // 用真 csrf 替换打码值
    const form: Record<string, string> = { ...plan.form, csrf };
    const res = await this.send({ url: plan.url, form, plan });
    return res.ok ? { ok: true, action: plan.action, plan, dryRun: false } : res.outcome;
  }

  private noCsrf(plan: WritePlan): WriteOutcome {
    return {
      ok: false,
      action: plan.action,
      plan,
      dryRun: false,
      error: { kind: 'auth', code: 'no_csrf', message: '缺 bili_jct（csrf），无法写：请重新扫码登录' },
    };
  }

  private async send(input: {
    url: string;
    form: Record<string, string>;
    plan: WritePlan;
    intervalMs?: number;
    sign?: boolean;
  }): Promise<{ ok: true; data: unknown } | { ok: false; outcome: WriteOutcome }> {
    await this.throttle(input.intervalMs);
    const res = await this.deps.http.jsonEnvelope<unknown>({
      url: input.url,
      method: 'POST',
      form: input.form,
      sign: input.sign ?? true,
      noRetry: true,
      timeoutMs: 20_000,
    });

    if (!res.ok) {
      this.deps.logger.warn('bili.write', `发送失败：${res.error.message}`, { kind: res.error.kind });
      return { ok: false, outcome: { ok: false, action: input.plan.action, plan: input.plan, dryRun: false, error: res.error } };
    }
    if (res.data.code !== 0) {
      const error = classifyBusiness(res.data.code, res.data.message);
      return { ok: false, outcome: { ok: false, action: input.plan.action, plan: input.plan, dryRun: false, error } };
    }
    this.deps.logger.info('bili.write', `已发送：${input.plan.summary}`);
    return { ok: true, data: res.data.data };
  }

  /** 写间隔：默认 5s + 0–1s 抖动（私信 1s）；测试可以跳过。 */
  private async throttle(intervalMs?: number): Promise<void> {
    if (this.deps.skipThrottle) return;
    const now = this.deps.now?.() ?? Date.now();
    const interval = intervalMs ?? this.deps.minIntervalMs ?? WRITE_INTERVAL_MS;
    const wait = this.lastWriteAt === 0 ? 0 : Math.max(0, this.lastWriteAt + interval - now);
    const jitter = wait > 0 ? 0 : Math.floor(Math.random() * Math.min(1000, interval));
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

/** 私信响应里的消息标识（不同版本叫法不一样，都没有就不填）。 */
export function pickMessageId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ['msg_key', 'msgKey', 'msgid', 'msg_id']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && value > 0) return String(value);
  }
  const msg = record['msg'] as Record<string, unknown> | undefined;
  if (msg && typeof msg === 'object') {
    const nested = msg['msg_key'] ?? msg['msgid'];
    if (typeof nested === 'string' || typeof nested === 'number') return String(nested);
  }
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
  if (code === 21007) return { kind: 'business', ...base, message: `${message || '内容不合法'}（私信可能超长）` };
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
