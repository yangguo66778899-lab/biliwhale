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

export interface ScanDetail {
  bvid: string;
  root: string;
  /** 这条评论下读到的回复总数。 */
  replies: number;
  /** 其中别人回给我们的条数。 */
  strangers: number;
  /** 这条为什么没生成草稿（没有就是空）。 */
  note: string;
}

export interface ScanResult {
  /** 账本里我们最近的评论数（满足时间/类型条件）。 */
  considered: number;
  /** 真的去读了楼中楼的评论数。 */
  scanned: number;
  created: PendingReply[];
  skipped: string[];
  /** 每条评论的明细，面板直接展示（用户要知道「为什么没有」）。 */
  details: ScanDetail[];
}

/** 扫我们发过的评论下的新回复，把陌生人的落成草稿（每轮最多 maxPerRound 条）。 */
export async function scanStrangerReplies(deps: PendingDeps, options: { maxPerRound?: number } = {}): Promise<ScanResult> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const result: ScanResult = { considered: 0, scanned: 0, created: [], skipped: [], details: [] };

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

  // 账本可能是别的进程（CLI）写的：先重读磁盘，否则会「看不见那条评论」
  deps.quota.reload();

  // 只看最近 7 天、我们自己发出去的评论（含未复核的；它们在 B 站上是真的存在）
  const cutoffMs = now().getTime() - 7 * 86_400_000;
  const ours = deps.quota
    .entries()
    .filter(
      (entry) =>
        entry.type === 'comment' &&
        Boolean(entry.rpid) &&
        entry.status !== 'failed' &&
        entry.status !== 'dry_run' &&
        Date.parse(entry.at) >= cutoffMs,
    )
    .slice(-10);
  result.considered = ours.length;

  if (ours.length === 0) {
    result.skipped.push('最近 7 天没有我们发出去的评论（预演不算；账本里没有 rpid 的也不算）');
    return result;
  }

  for (const entry of ours) {
    if (result.created.length >= cap) break;
    if (!entry.rpid) continue;

    // aid 是写接口的 oid：账本里没有就查一次视频详情补上，不再静默跳过
    let aid = aidFromEntry(entry);
    if (!aid) {
      const video = await deps.api.video(entry.bvid);
      if (video.ok && video.data.aid > 0) {
        aid = video.data.aid;
        result.skipped.push(`${entry.bvid}：账本里缺 aid，已用视频详情补上（${aid}）`);
      } else {
        const reason = video.ok ? '视频详情里没有 aid' : video.error.message;
        result.skipped.push(`${entry.bvid}：拿不到 aid（${reason}），跳过这条评论`);
        result.details.push({ bvid: entry.bvid, root: entry.rpid, replies: 0, strangers: 0, note: `拿不到 aid：${reason}` });
        continue;
      }
    }

    result.scanned += 1;
    const detail: ScanDetail = { bvid: entry.bvid, root: entry.rpid, replies: 0, strangers: 0, note: '' };

    const thread = await deps.api.threadReplies(aid, entry.rpid);
    if (!thread.ok) {
      detail.note = `读回复失败：${thread.error.message}`;
      result.skipped.push(`${entry.bvid}：${detail.note}`);
      result.details.push(detail);
      continue;
    }
    detail.replies = thread.data.replies.length;

    let blocked: string | null = null;
    for (const reply of thread.data.replies) {
      if (result.created.length >= cap) break;
      // 自己回自己的直接跳过：单账号下「主人」就是我们自己。
      // 「主人回复直发」（ownerDirect）要等 M4 有监听循环与双账号场景时才有意义。
      if (reply.mid === selfMid) continue;
      detail.strangers += 1;

      if (deps.pending.has({ root: entry.rpid, parent: reply.rpid })) {
        blocked ??= `有人回了（${reply.uname}），但这条已经进过审批队列了`;
        continue;
      }
      // 只回「直接回复到我们那条评论下面」的人（§7.8）：B 站的楼中楼里，root 永远是我们那条，
      // 所以只有 parent === 我们的 rpid 才算「直接回我们」；回别人的回复不参与。
      const isDirect = String(reply.parent) === String(entry.rpid);
      const sameThread = !reply.root || String(reply.root) === String(entry.rpid);
      if (!isDirect || !sameThread) {
        blocked ??= `有 ${reply.uname} 的回复，但它挂在别人下面（parent=${reply.parent || '0'}，root=${reply.root || '0'}），不是直接回我们`;
        continue;
      }

      const draftText = await makeDraft(deps, {
        source: reply.message,
        uname: reply.uname,
        videoTitle: entry.bvid,
        maxChars: cfg.listen.reply.maxChars,
      });
      if (!draftText) {
        blocked ??= `给 ${reply.uname} 的回复没生成（模型没给）`;
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

    detail.note = blocked ?? (detail.replies === 0 ? '这条评论下还没有任何回复' : `回复 ${detail.replies} 条，都是我们自己发的`);
    result.details.push(detail);
    if (blocked) result.skipped.push(`${entry.bvid}：${blocked}`);
  }

  if (result.created.length > 0) {
    deps.logger.event('pending', `生成 ${result.created.length} 条待审回复`, {
      target: 'pending',
      data: { ids: result.created.map((item) => item.id) },
    });
  } else {
    deps.logger.event('pending', '扫描了回复，但没有新的陌生人回复', {
      target: 'pending',
      level: 'info',
      data: {
        considered: result.considered,
        scanned: result.scanned,
        details: result.details.map((item) => ({ bvid: item.bvid, replies: item.replies, strangers: item.strangers, note: item.note })),
      },
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
