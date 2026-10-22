/**
 * 审批队列（M3）：陌生人回复我们的评论 → 草稿 → 用户决定 → 执行 + 复核。
 *
 * 职责：
 *   - `scanStrangerReplies`：看我们自己发过的评论下面有没有新回复；有就生成草稿（每人每条只一次）
 *   - `approvePending`：批准后真正发楼中楼回复（root + parent 都记），复核，记账
 *   - `rejectPending`：拒绝并留下理由（偏好信号）
 *   - `expirePending`：7 天没处理自动作废
 * 不做什么：不做监听循环（M4）、不写报告（返回结果给编排器）、不绕过闸门（审批只影响「发不发」，仍受写开关/风控/条数限制）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { PendingReply, QuotaEntry } from '../shared/types.ts';
import type { PendingStore } from '../state/pending.ts';
import { expiresAt, newPendingId } from '../state/pending.ts';
import type { RepliedLedger } from '../state/replied.ts';
import type { QuotaLedger } from '../state/ledgers.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { BiliApi } from '../bili/api.ts';
import type { BiliWriter } from '../bili/write.ts';
import type { SecretsService } from '../config/secrets.ts';
import crypto from 'node:crypto';
import { localIso } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';

export interface PendingDeps {
  logger: Logger;
  config: Config;
  quota: QuotaLedger;
  state: AppStateStore;
  pending: PendingStore;
  replied: RepliedLedger;
  api: BiliApi;
  writer: BiliWriter;
  secrets: SecretsService;
  now?: () => Date;
  /** 生成拟回复（生产用模型，测试可注入）。返回 null 表示放弃。 */
  draft?: (input: { source: string; uname: string; videoTitle: string; maxChars: number }) => Promise<string | null>;
}

export interface ScanResult {
  scanned: number;
  created: PendingReply[];
  skipped: string[];
}

/** 扫我们发过的评论下的新回复，把陌生人的落成草稿（每轮最多 maxPerRound 条）。 */
export async function scanStrangerReplies(deps: PendingDeps, options: { maxPerRound?: number } = {}): Promise<ScanResult> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const result: ScanResult = { scanned: 0, created: [], skipped: [] };

  if (!cfg.listen.reply.strangerApproval) {
    result.skipped.push('配置里关了「陌生人回复走审批」，一律不回');
    return result;
  }
  if (!cfg.safety.writeEnabled || cfg.safety.killSwitch) {
    result.skipped.push('写操作被总开关/急停关着，先不生成草稿');
    return result;
  }

  const cap = Math.max(1, options.maxPerRound ?? cfg.listen.reply.maxPerRound ?? 1);
  const selfMid = deps.secrets.selfMid();

  // 只看最近 7 天我们发出去的评论
  const cutoff = new Date(now().getTime() - 7 * 86_400_000).toISOString();
  const ours = deps.quota
    .entries()
    .filter((entry) => entry.type === 'comment' && entry.rpid && entry.status !== 'failed' && entry.at >= cutoff)
    .slice(-10);

  for (const entry of ours) {
    if (result.created.length >= cap) break;
    if (!entry.rpid) continue;
    const aid = aidFromEntry(entry);
    if (!aid) continue;
    result.scanned += 1;

    const thread = await deps.api.threadReplies(aid, entry.rpid);
    if (!thread.ok) {
      result.skipped.push(`读 ${entry.bvid} 的回复失败：${thread.error.message}`);
      continue;
    }
    for (const reply of thread.data.replies) {
      if (result.created.length >= cap) break;
      // 自己回自己的直接跳过：单账号下「主人」就是我们自己。
      // 「主人回复直发」（ownerDirect）要等 M4 有监听循环与双账号场景时才有意义。
      if (reply.mid === selfMid) continue;
      if (deps.pending.has({ root: entry.rpid, parent: reply.rpid })) continue;
      // 只回「直接回复到我们那条评论下面」的人（父级必须是我们），不参与别人的讨论
      if (String(reply.parent) !== String(entry.rpid) && String(reply.root) !== String(entry.rpid)) continue;

      const draftText = await makeDraft(deps, {
        source: reply.message,
        uname: reply.uname,
        videoTitle: entry.bvid,
        maxChars: cfg.listen.reply.maxChars,
      });
      if (!draftText) {
        result.skipped.push(`给 ${reply.uname} 的回复没生成（模型没给）`);
        continue;
      }

      const created = deps.pending.add({
        id: newPendingId(now()),
        createdAt: localIso(now()),
        expiresAt: expiresAt(now()),
        status: 'pending',
        bvid: entry.bvid,
        aid,
        root: String(entry.rpid),
        parent: String(reply.rpid),
        target: { mid: reply.mid, uname: reply.uname },
        sourceComment: truncate(reply.message, 200),
        draft: draftText,
      });
      deps.replied.note({ mid: reply.mid, uname: reply.uname, bvid: entry.bvid, at: localIso(now()) });
      result.created.push(created);
    }
  }

  if (result.created.length > 0) {
    deps.logger.event('pending', `生成 ${result.created.length} 条待审回复`, {
      target: 'pending',
      data: { ids: result.created.map((item) => item.id) },
    });
  }
  return result;
}

/** 批准：真正发楼中楼回复 + 复核 + 记账。 */
export async function approvePending(
  deps: PendingDeps,
  id: string,
  options: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; message: string; rpid?: string; verified?: boolean }> {
  const now = deps.now ?? (() => new Date());
  const item = deps.pending.byId(id);
  if (!item) return { ok: false, message: '没有这条草稿' };
  if (item.status !== 'pending') return { ok: false, message: `这条草稿已经是「${item.status}」状态` };

  const cfg = deps.config;
  if (!cfg.safety.writeEnabled) return { ok: false, message: '总写开关关着' };
  if (cfg.safety.killSwitch) return { ok: false, message: '急停开着' };
  if (deps.state.inRiskCooldown(now())) return { ok: false, message: '风控冷却中，先别发' };
  if (cfg.safety.dryRun || options.dryRun) {
    const plan = deps.writer.planComment({ bvid: item.bvid, aid: item.aid, message: item.draft, root: item.root, parent: item.parent });
    return { ok: true, message: `预演：${plan.summary}（未发送）` };
  }

  const at = localIso(now());
  const outcome = await deps.writer.postComment(
    { bvid: item.bvid, aid: item.aid, message: item.draft, root: item.root, parent: item.parent },
    { dryRun: false },
  );
  if (!outcome.ok) {
    const error = outcome.error?.message ?? '发送失败';
    deps.pending.markFailed(item.id, error, at);
    if (outcome.error?.kind === 'risk') {
      deps.state.setRiskCooldown(new Date(now().getTime() + cfg.safety.riskCooldownMin * 60_000).toISOString());
    }
    deps.quota.add({
      at,
      type: 'comment',
      bvid: item.bvid,
      target: String(item.target.mid),
      share: false,
      status: 'failed',
      root: item.root,
      parent: item.parent,
      content: item.draft,
      contentHash: hashOf(item.draft),
      error,
      note: `approval:${item.id}`,
    });
    deps.logger.event('pending', `审批回复发送失败：${error}`, { level: 'warn', target: 'pending', data: { id: item.id } });
    return { ok: false, message: `发送失败：${error}` };
  }

  // 复核（最多两次，够用；失败不重发）
  let verified = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(1_500);
    if (!outcome.rpid) break;
    const check = await deps.api.findReply(item.aid, item.root, outcome.rpid, item.draft);
    if (check.ok && check.data) {
      verified = true;
      break;
    }
  }

  deps.pending.markSent(item.id, outcome.rpid ?? '', at);
  deps.quota.add({
    at,
    type: 'comment',
    bvid: item.bvid,
    target: String(item.target.mid),
    share: false,
    status: verified ? 'sent' : 'unverified',
    ...(outcome.rpid ? { rpid: outcome.rpid } : {}),
    root: item.root,
    parent: item.parent,
    content: item.draft,
    contentHash: hashOf(item.draft),
    ...(verified ? { verifiedAt: at } : { error: '复核没通过' }),
    note: `approval:${item.id}`,
  });

  return {
    ok: true,
    message: verified ? '已发出并复核通过' : '已发出，但复核没通过（标 unverified，不自动重发）',
    ...(outcome.rpid ? { rpid: outcome.rpid } : {}),
    verified,
  };
}

/** 拒绝：记录理由（偏好信号）。 */
export function rejectPending(deps: PendingDeps, id: string, reason = ''): { ok: boolean; message: string } {
  const now = deps.now ?? (() => new Date());
  const item = deps.pending.byId(id);
  if (!item) return { ok: false, message: '没有这条草稿' };
  if (item.status !== 'pending') return { ok: false, message: `这条草稿已经是「${item.status}」状态` };
  deps.pending.reject(id, reason || '你说不发', localIso(now()));
  deps.logger.event('pending', `拒绝了 ${item.target.uname} 的回复草稿`, {
    target: 'pending',
    data: { id, reason: reason || 'unspecified' },
  });
  return { ok: true, message: '已拒绝（理由记下了，以后少推这类）' };
}

/** 过期：返回本次作废条数。 */
export function expirePending(deps: PendingDeps): number {
  const now = deps.now ?? (() => new Date());
  return deps.pending.expire(now());
}

/** 面板/托盘用的摘要：待审几条、最早的是谁。 */
export function pendingSummary(deps: PendingDeps): { count: number; oldest: string | null; items: Array<{ id: string; uname: string; bvid: string }> } {
  const items = deps.pending.pending();
  return {
    count: items.length,
    oldest: items[0]?.createdAt ?? null,
    items: items.map((item) => ({ id: item.id, uname: item.target.uname, bvid: item.bvid })),
  };
}

/* ---------------- 内部 ---------------- */

async function makeDraft(
  deps: PendingDeps,
  input: { source: string; uname: string; videoTitle: string; maxChars: number },
): Promise<string | null> {
  if (deps.draft) {
    const text = await deps.draft(input);
    return text ? clampText(text, input.maxChars) : null;
  }
  // 没有注入生成器时的兜底：不带情绪、不承诺、不争论
  const fallback = `谢谢你看完还回我。${input.source.length > 0 ? '' : ''}`.trim();
  return clampText(fallback, input.maxChars);
}

function clampText(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(single);
  return chars.length > maxChars ? `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…` : single;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function hashOf(text: string): string {
  // 与 share.ts 用同一套算法，便于对账
  return createHash(text);
}

function createHash(text: string): string {
  // 延迟到调用点再 import 太重，这里用简单稳定的实现（非安全用途，只做对账）
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function aidFromEntry(entry: QuotaEntry): number {
  // 账本里存了 aid（M3 起）；老账本没有就跳过，绝不去猜
  return typeof entry.aid === 'number' && entry.aid > 0 ? entry.aid : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给编排器的一行人话。 */
export function describePendingError(err: unknown): string {
  return `审批队列出错：${humanError(err)}`;
}
