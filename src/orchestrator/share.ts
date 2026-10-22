/**
 * 分享执行器（M3）：把「闸门判定」变成「发或不发」，并且把每一步都留痕。
 *
 * 一次执行做的事（顺序固定，任何一步不过就**不发**）：
 *   1. 内容组装：频道校验（M3 只有 comment）、@ 处理、字数裁剪、空文本拒绝
 *   2. 幂等：内容哈希进账本，同样内容成功发过就拒绝（§10.7）
 *   3. 闸门 gateShare：开关/分数/来源/额度/判重/冷却/沉默/风控，**所有拒绝理由都收集**
 *   4. 每日写总量（safety.maxWritesPerDay）
 *   5. 发送（写间隔在 BiliWriter 里）：dry-run 只出 plan
 *   6. 复核：3 次递增，成功记 sent，失败记 unverified（**绝不自动重发**）
 *   7. 风控：撞 risk 立即停手、设冷却、通知；本轮剩余不再写
 *
 * 不做什么：不做模型调用（文案是模型给的）、不写报告（返回结构给编排器）、不碰日记。
 */

import crypto from 'node:crypto';
import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { QuotaLedger } from '../state/ledgers.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { BiliWriter, WritePlan } from '../bili/write.ts';
import type { BiliApi } from '../bili/api.ts';
import type { ShareProposal } from '../shared/types.ts';
import { gateShare } from './gate.ts';
import type { GateDecision } from './gate.ts';
import { localIso } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';

export type ShareStatus = 'sent' | 'unverified' | 'failed' | 'denied' | 'dry_run';

export interface ShareAttempt {
  bvid: string;
  aid: number;
  channel: 'comment' | 'none';
  status: ShareStatus;
  /** 实际（或将）发送的文本。 */
  content: string;
  contentHash: string;
  key: string;
  rpid?: string;
  verified?: boolean;
  deny: string[];
  notes: string[];
  plan?: WritePlan;
  error?: string;
}

export interface ShareDeps {
  logger: Logger;
  quota: QuotaLedger;
  state: AppStateStore;
  writer: BiliWriter;
  api: BiliApi;
  config: Config;
  now?: () => Date;
  /** 测试用：不发真请求、不等待复核间隔。 */
  verifyDelaysMs?: number[];
  skipWait?: boolean;
}

export interface ShareInput {
  /** 挑中的条目（顺序即优先级）。 */
  items: Array<{ bvid: string; aid: number; score: number; share: ShareProposal | undefined; inDeepRead: boolean }>;
  /** 今天已经用掉的分享额度（发送前快照）。 */
  todayShares: number;
  /** 沉默档位给出的额度。 */
  silenceCap: number;
  /** 本次是否预演（run --dry 或 safety.dryRun）。 */
  dryRun: boolean;
  /** 本轮是否已被风控叫停（跨 item 传播）。 */
  riskStop?: boolean;
}

export interface ShareReport {
  attempts: ShareAttempt[];
  /** 报告里「为什么没发」的行。 */
  notes: string[];
  sent: number;
  dryRun: number;
  denied: number;
  failed: number;
  unverified: number;
  /** 是否因风控/鉴权中途停手。 */
  stopped: null | 'risk' | 'auth';
}

const DEFAULT_VERIFY_DELAYS = [0, 2_000, 6_000];

/** 分享文案组装：@ 处理 + 字数裁剪 + 去多余空白。纯函数，测试好写。 */
export function composeCommentText(input: {
  proposal: ShareProposal | undefined;
  atOwner: boolean;
  atName: string;
  maxChars: number;
}): { ok: boolean; text: string; notes: string[]; reason?: string } {
  const notes: string[] = [];
  const raw = (input.proposal?.text ?? '').replace(/\r\n/g, '\n').trim();
  if (raw.length === 0) return { ok: false, text: '', notes, reason: '模型没给分享文案' };

  // 只保留单行：评论里多行容易被当成刷屏，也更难读
  let text = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join(' ');

  const at = input.atName.trim();
  if (input.atOwner && at.length > 0) {
    const mentioned = text.includes(`@${at}`);
    if (!mentioned) {
      text = `@${at} ${text}`;
      notes.push(`已带上 @${at}`);
    }
  }

  const chars = Array.from(text);
  if (chars.length > input.maxChars) {
    text = `${chars.slice(0, Math.max(0, input.maxChars - 1)).join('').trimEnd()}…`;
    notes.push(`超过 ${input.maxChars} 字，已截断`);
  }
  if (text.trim().length === 0) return { ok: false, text: '', notes, reason: '文案裁剪后为空' };
  return { ok: true, text, notes };
}

/** 幂等键：sha256(bvid | action | target | contentHash)。 */
export function idempotencyKey(parts: { bvid: string; action: string; target: string; contentHash: string }): string {
  const raw = `${parts.bvid}|${parts.action}|${parts.target}|${parts.contentHash}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export function contentHashOf(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

export async function executeShares(deps: ShareDeps, input: ShareInput): Promise<ShareReport> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const attempts: ShareAttempt[] = [];
  const notes: string[] = [];
  const report: ShareReport = { attempts, notes, sent: 0, dryRun: 0, denied: 0, failed: 0, unverified: 0, stopped: null };

  let riskStop = input.riskStop === true;
  let todayShares = input.todayShares;
  const writesToday = countWritesToday(deps.quota, now());
  let writesThisRun = 0;

  for (const item of input.items) {
    const atName = cfg.account.name ?? '';
    const channel: 'comment' | 'none' = item.share?.channel === 'comment' ? 'comment' : 'none';

    const attempt: ShareAttempt = {
      bvid: item.bvid,
      aid: item.aid,
      channel,
      status: 'denied',
      content: '',
      contentHash: '',
      key: '',
      deny: [],
      notes: [],
    };
    attempts.push(attempt);

    // M3 只有评论；私信/动态在 M4
    if (item.share?.channel === 'dm') {
      attempt.deny.push('M3 只支持评论分享（私信在 M4）');
      report.denied += 1;
      continue;
    }

    // 先过闸门、再看文案：这样「开关关着」才是报告里写的原因（而不是「模型没给文案」）
    const decision: GateDecision = gateShare({
      writeEnabled: cfg.safety.writeEnabled,
      killSwitch: cfg.safety.killSwitch,
      dryRun: input.dryRun,
      shareEnabled: cfg.share.enabled,
      channel,
      allowedChannels: cfg.share.enabled ? [cfg.share.via] : [],
      score: item.score,
      minScore: cfg.share.minScore,
      scoreEnabled: cfg.score.enabled,
      deepRead: item.inDeepRead,
      todayShares,
      shareCap: input.silenceCap,
      dailyCap: cfg.share.dailyCap,
      lastShareAt: deps.quota.lastSentAt(item.bvid),
      perVideoDays: cfg.share.perVideoDays,
      silenceCap: input.silenceCap,
      riskCooldown: deps.state.inRiskCooldown(now()) || riskStop,
      now: now(),
    });

    if (!decision.allow) {
      attempt.deny.push(...decision.deny);
      report.denied += 1;
      notes.push(`没发 ${item.bvid}：${decision.deny.join('；')}`);
      continue;
    }

    // 闸门过了，才轮到「有没有东西可发」
    const composed = composeCommentText({
      proposal: item.share,
      atOwner: cfg.share.comment.atOwner,
      atName,
      maxChars: cfg.share.comment.maxChars,
    });
    attempt.content = composed.text;
    attempt.notes = composed.notes;
    if (!composed.ok) {
      attempt.deny.push(`${composed.reason ?? '文案不可用'}（分享开关是开着的，但模型没写这条的文案）`);
      report.denied += 1;
      notes.push(`没发 ${item.bvid}：模型没给分享文案`);
      continue;
    }

    const content = composed.text;
    const contentHash = contentHashOf(content);
    const target = content.includes('@') ? content.slice(0, content.indexOf(' ')) : 'owner';
    const key = idempotencyKey({ bvid: item.bvid, action: 'comment', target, contentHash });
    attempt.contentHash = contentHash;
    attempt.key = key;

    if (deps.quota.hasSentContent(key)) {
      attempt.deny.push('同样内容已经发过（幂等）');
      report.denied += 1;
      continue;
    }

    if (writesToday + writesThisRun + 1 > cfg.safety.maxWritesPerDay) {
      attempt.deny.push(`超过每日写操作总上限（${cfg.safety.maxWritesPerDay}）`);
      report.denied += 1;
      continue;
    }

    // ---- 发送 ----
    const at = localIso(now());
    const outcome = await deps.writer.postComment(
      { bvid: item.bvid, aid: item.aid, message: content },
      { dryRun: input.dryRun },
    );
    attempt.plan = outcome.plan;
    writesThisRun += 1;

    if (!outcome.ok) {
      const kind = outcome.error?.kind ?? 'internal';
      attempt.status = 'failed';
      attempt.error = outcome.error?.message ?? '发送失败';
      report.failed += 1;
      deps.quota.add({
        at,
        type: 'comment',
        bvid: item.bvid,
        aid: item.aid,
        target,
        share: true,
        status: 'failed',
        note: key,
        content,
        contentHash,
        attempts: 1,
        error: attempt.error,
      });
      notes.push(`发送失败 ${item.bvid}：${attempt.error}`);

      if (kind === 'risk') {
        deps.state.setRiskCooldown(new Date(now().getTime() + cfg.safety.riskCooldownMin * 60_000).toISOString());
        riskStop = true;
        report.stopped = 'risk';
        notes.push(`撞风控，已停止本轮所有写操作并冷却 ${cfg.safety.riskCooldownMin} 分钟`);
        deps.logger.event('share', '撞风控，停止写操作', { level: 'warn', target: 'share', data: { bvid: item.bvid, error: attempt.error } });
        break;
      }
      if (kind === 'auth') {
        report.stopped = 'auth';
        notes.push('登录态失效，已停止本轮所有写操作；请重新登录');
        deps.logger.event('share', '登录态失效，停止写操作', { level: 'warn', target: 'share' });
        break;
      }
      continue;
    }

    if (outcome.dryRun) {
      attempt.status = 'dry_run';
      report.dryRun += 1;
      deps.quota.add({
        at,
        type: 'comment',
        bvid: item.bvid,
        aid: item.aid,
        target,
        share: true,
        status: 'dry_run',
        note: key,
        content,
        contentHash,
        attempts: 0,
      });
      notes.push(`预演 ${item.bvid}：将发送「${content}」（未真正发出）`);
      continue;
    }

    // ---- 复核 ----
    const verification = await verifyComment(deps, item.aid, outcome.rpid, content);
    attempt.rpid = outcome.rpid;
    attempt.verified = verification.ok;
    attempt.status = verification.ok ? 'sent' : 'unverified';
    if (verification.ok) report.sent += 1;
    else report.unverified += 1;
    todayShares += 1;

    deps.quota.add({
      at,
      type: 'comment',
      bvid: item.bvid,
      aid: item.aid,
      target,
      share: true,
      status: verification.ok ? 'sent' : 'unverified',
      ...(outcome.rpid ? { rpid: outcome.rpid } : {}),
      note: key,
      content,
      contentHash,
      attempts: verification.attempts,
      ...(verification.ok ? { verifiedAt: localIso(now()) } : {}),
      ...(verification.note ? { error: verification.note } : {}),
    });

    if (verification.ok) {
      notes.push(`已发 ${item.bvid}${outcome.rpid ? `（rpid ${outcome.rpid}）` : '（没拿到 rpid）'}，复核通过`);
    } else {
      notes.push(`已发 ${item.bvid} 但复核没通过（${verification.note ?? '列表里没找到'}）→ 标 unverified，不自动重发`);
      deps.logger.event('share', '复核未通过', { level: 'warn', target: 'share', data: { bvid: item.bvid, rpid: outcome.rpid ?? null } });
    }
  }

  if (attempts.length === 0) notes.push('这一轮没有可分享的条目');
  return report;
}

/** 复核：最多 3 次、间隔递增；任意一次找到就算过。 */
async function verifyComment(
  deps: ShareDeps,
  aid: number,
  rpid: string | undefined,
  content: string,
): Promise<{ ok: boolean; attempts: number; note?: string }> {
  if (!rpid) return { ok: false, attempts: 0, note: '没取到 rpid（绝不编）' };
  const delays = deps.verifyDelaysMs ?? DEFAULT_VERIFY_DELAYS;
  let attempts = 0;
  for (const delay of delays) {
    if (delay > 0 && !deps.skipWait) await sleep(delay);
    attempts += 1;
    const found = await deps.api.findComment(aid, rpid);
    if (!found.ok) {
      if (found.error.kind === 'risk' || found.error.kind === 'auth') {
        return { ok: false, attempts, note: `复核时撞到 ${found.error.kind}：${found.error.message}` };
      }
      continue;
    }
    if (found.data) return { ok: true, attempts };
  }
  void content;
  return { ok: false, attempts, note: '三次都没在最新评论里找到这条' };
}

function countWritesToday(quota: QuotaLedger, now: Date): number {
  const date = localIso(now).slice(0, 10);
  return quota.entries().filter((entry) => entry.at.slice(0, 10) === date && entry.status === 'sent').length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把执行结果压成报告里的几行（不掺 UI 文案）。 */
export function summarizeShares(report: ShareReport): string {
  const parts: string[] = [];
  if (report.sent > 0) parts.push(`发出 ${report.sent} 条`);
  if (report.dryRun > 0) parts.push(`预演 ${report.dryRun} 条`);
  if (report.unverified > 0) parts.push(`未复核 ${report.unverified} 条`);
  if (report.failed > 0) parts.push(`失败 ${report.failed} 条`);
  if (report.denied > 0) parts.push(`没发 ${report.denied} 条`);
  if (parts.length === 0) return '这一轮没有分享动作';
  const tail = report.stopped === 'risk' ? '；撞风控已停手' : report.stopped === 'auth' ? '；登录失效已停手' : '';
  return `${parts.join('，')}${tail}`;
}

/** 给编排器用：把异常包成一行人话（不吞）。 */
export function describeShareError(err: unknown): string {
  return `分享执行出错：${humanError(err)}`;
}
