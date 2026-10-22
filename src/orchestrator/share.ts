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
import { resolveOwner } from '../account/owner.ts';
import type { GateDecision } from './gate.ts';
import { localIso } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';
import { composeShareDm } from './dm.ts';

export type ShareStatus = 'sent' | 'held' | 'unverified' | 'failed' | 'denied' | 'dry_run';

export interface ShareAttempt {
  bvid: string;
  aid: number;
  channel: 'comment' | 'dm' | 'none';
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
  /** 登录账号 mid（发送方身份，用来挡「主人 = 自己」）。不传就取不到 → 主人校验会当作未配置。 */
  selfMid?: () => number;
  now?: () => Date;
  /** 反馈账本：发送成功后记「上次分享时间」，沉默衰减才有参考点（审计 §2.4）。 */
  feedback?: { markShare: (at?: Date) => void };
  /** 测试用：不发真请求、不等待复核间隔。 */
  verifyDelaysMs?: number[];
  skipWait?: boolean;
}

export interface ShareInput {
  /** 挑中的条目（顺序即优先级）。私信渠道要用 title/oneliner 拼合并文案。 */
  items: Array<{
    bvid: string;
    aid: number;
    score: number;
    share: ShareProposal | undefined;
    inDeepRead: boolean;
    title?: string;
    oneliner?: string;
  }>;
  /** 私信渠道的收件人（主人 UID）。没配主人时 dm 渠道会被拒，而不是发给自己。 */
  dmReceiver?: number;
  /** 私信渠道的发送方（登录账号 UID）。 */
  dmSender?: number;
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
  /** 发出去了、rpid 存在，但被 B 站挂起（公开区看不到）。 */
  held: number;
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
  /** 私信渠道：过闸的条目先排队，最后合并成一条发出（§7.8：一轮合并一条）。 */
  const dmQueue: Array<{ attempt: ShareAttempt; item: ShareInput['items'][number] }> = [];
  const report: ShareReport = { attempts, notes, sent: 0, dryRun: 0, denied: 0, failed: 0, unverified: 0, held: 0, stopped: null };

  let riskStop = input.riskStop === true;
  let todayShares = input.todayShares;
  const writesToday = countWritesToday(deps.quota, now());
  let writesThisRun = 0;

  for (const item of input.items) {
    // 主人是「另一个人」：@ 用主人昵称，不用登录账号的昵称。
    const owner = resolveOwner(cfg, deps.selfMid?.() ?? 0);
    const atName = owner.name;
    const channel: 'comment' | 'dm' | 'none' =
      item.share?.channel === 'comment' ? 'comment' : item.share?.channel === 'dm' ? 'dm' : 'none';

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

    // 私信渠道：同样过闸（分数/额度/冷却/深读都在上面判过），过了就排队，最后合并成一条
    if (channel === 'dm') {
      attempt.content = item.oneliner ?? '';
      attempt.notes.push('排队：与本轮其它私信分享合并成一条');
      dmQueue.push({ attempt, item });
      continue;
    }

    // 闸门过了，才轮到「有没有东西可发」
    // 评论 @ 是「通知主人」的手段：主人没配好、或昵称没填（@ 不到人）都别发——
    // 否则就是一条没人被通知到的评论（真机上真的发生过：@ 是空的）。
    if (attempt.channel === 'comment' && cfg.share.comment.atOwner) {
      const why = !owner.ok
        ? owner.problem ?? '主人还没配置'
        : owner.name.trim().length === 0
          ? '主人昵称还没填（评论里 @ 不到人）：去面板「账号」页按 UID 自动取，或手填'
          : null;
      if (why) {
        attempt.deny.push(why);
        report.denied += 1;
        notes.push(`没发 ${item.bvid}：${why}`);
        continue;
      }
    }

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
    const verification = await verifyComment(deps, item.aid, outcome.rpid);
    attempt.rpid = outcome.rpid;
    attempt.verified = verification.ok;
    attempt.status = verification.ok ? 'sent' : verification.held ? 'held' : 'unverified';
    // 只要真的发出去了（含被挂起）就记一笔：沉默衰减看的是「我们最近有没有开口」
    if (verification.ok || verification.held) deps.feedback?.markShare(now());
    if (verification.ok) report.sent += 1;
    else if (verification.held) report.held += 1;
    else report.unverified += 1;
    todayShares += 1;

    deps.quota.add({
      at,
      type: 'comment',
      bvid: item.bvid,
      aid: item.aid,
      target,
      share: true,
      status: verification.ok ? 'sent' : verification.held ? 'held' : 'unverified',
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
    } else if (verification.held) {
      notes.push(
        `已发 ${item.bvid}（rpid ${outcome.rpid}），但 B 站把它挂起了：${verification.note ?? '公开区看不到'}` +
          `——公开评论区看不到，主人可能收不到 @ 通知；不自动重发`,
      );
      deps.logger.event('share', '评论被 B 站挂起（已发出但公开区不可见）', {
        level: 'warn',
        target: 'share',
        data: { bvid: item.bvid, rpid: outcome.rpid ?? null, state: verification.state ?? null },
      });
    } else {
      notes.push(`已发 ${item.bvid} 但复核没通过（${verification.note ?? '列表里没找到'}）→ 标 unverified，不自动重发`);
      deps.logger.event('share', '复核未通过', { level: 'warn', target: 'share', data: { bvid: item.bvid, rpid: outcome.rpid ?? null } });
    }
  }

  await flushShareDm(deps, input, report, notes, dmQueue, {
    writesToday: countWritesToday(deps.quota, now()) + report.sent + report.held,
    dryRun: input.dryRun,
    now,
  });

  if (attempts.length === 0) notes.push('这一轮没有可分享的条目');
  return report;
}

/**
 * 复核：最多 3 次、间隔递增。
 *
 * 三种结论不能混为一谈（真机踩过：三条评论其实都发出去了，却被一律报「复核未通过」）：
 *   - `visible`：公开评论区能看到 → 复核通过；
 *   - `found` 但不可见：评论真实存在（rpid 查得到），只是 B 站挂起了（state=17 审核/仅自己可见）→ `held`；
 *   - 完全查不到 → `unverified`（不自动重发）。
 */
async function verifyComment(
  deps: ShareDeps,
  aid: number,
  rpid: string | undefined,
): Promise<{ ok: boolean; held: boolean; state?: number; attempts: number; note?: string }> {
  if (!rpid) return { ok: false, held: false, attempts: 0, note: '没取到 rpid（绝不编）' };
  const delays = deps.verifyDelaysMs ?? DEFAULT_VERIFY_DELAYS;
  let attempts = 0;
  let held = false;
  let heldState: number | undefined;
  for (const delay of delays) {
    if (delay > 0 && !deps.skipWait) await sleep(delay);
    attempts += 1;
    const found = await deps.api.findOwnComment(aid, rpid);
    if (!found.ok) {
      if (found.error.kind === 'risk' || found.error.kind === 'auth') {
        return { ok: false, held: false, attempts, note: `复核时撞到 ${found.error.kind}：${found.error.message}` };
      }
      continue;
    }
    if (found.data.visible) return { ok: true, held: false, attempts };
    // 存在但不可见：先记下来，后面几次可能审核放行
    if (found.data.found) {
      held = true;
      heldState = found.data.state;
    }
  }
  if (held) {
    return {
      ok: false,
      held: true,
      ...(heldState !== undefined ? { state: heldState } : {}),
      attempts,
      note: heldState === undefined ? '评论存在但不在公开列表里' : `评论存在，但被 B 站挂起了（state=${heldState}）`,
    };
  }
  return { ok: false, held: false, attempts, note: '三次都没在评论列表里找到这条' };
}

function countWritesToday(quota: QuotaLedger, now: Date): number {
  const date = localIso(now).slice(0, 10);
  return quota.entries().filter((entry) => entry.at.slice(0, 10) === date && (entry.status === 'sent' || entry.status === 'held')).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 私信分享的实际发送（合并成一条）。
 *
 * 为什么放在这里而不是 round.ts：它必须和评论分享共用同一道闸门与账本，
 * 否则就是一条绕过 §10.1 的写入通道（审计 §3.2）。
 */
async function flushShareDm(
  deps: ShareDeps,
  input: ShareInput,
  report: ShareReport,
  notes: string[],
  queue: Array<{ attempt: ShareAttempt; item: ShareInput['items'][number] }>,
  ctx: { writesToday: number; dryRun: boolean; now: () => Date },
): Promise<void> {
  if (queue.length === 0) return;
  const cfg = deps.config;
  const receiver = input.dmReceiver ?? 0;
  const denyAll = (reason: string): void => {
    for (const entry of queue) {
      entry.attempt.deny.push(reason);
      report.denied += 1;
      notes.push(`没发 ${entry.item.bvid}：${reason}`);
    }
  };

  if (receiver <= 0) {
    denyAll('主人还没配置（私信分享必须发给主人，不能发给自己）');
    return;
  }
  if (cfg.safety.killSwitch) {
    denyAll('急停开关开着');
    return;
  }
  if (deps.state.inRiskCooldown(ctx.now())) {
    denyAll('撞风控后的冷却期内，不发');
    return;
  }
  if (ctx.writesToday + 1 > cfg.safety.maxWritesPerDay) {
    denyAll(`超过每日写操作总上限（${cfg.safety.maxWritesPerDay}）`);
    return;
  }

  const items = queue.map((entry) => ({
    bvid: entry.item.bvid,
    title: entry.item.title ?? entry.item.bvid,
    desc: '',
    understanding: entry.item.oneliner ?? '',
  }));
  const text = composeShareDm(items, cfg.share.dm.maxChars);
  const contentHash = contentHashOf(text);
  const at = localIso(ctx.now());

  const outcome = await deps.writer.sendDm(
    { receiverId: receiver, text, senderId: input.dmSender ?? 0 },
    { dryRun: ctx.dryRun },
  );

  for (const entry of queue) {
    entry.attempt.status = outcome.ok ? (outcome.dryRun ? 'dry_run' : 'sent') : 'failed';
    entry.attempt.content = text;
    entry.attempt.contentHash = contentHash;
    entry.attempt.key = idempotencyKey({
      bvid: entry.item.bvid,
      action: 'dm',
      target: String(receiver),
      contentHash,
    });
    entry.attempt.plan = outcome.plan;
    if (!outcome.ok) entry.attempt.error = outcome.error?.message ?? '私信发送失败';

    deps.quota.add({
      at,
      type: 'dm',
      bvid: entry.item.bvid,
      aid: entry.item.aid,
      target: String(receiver),
      share: true,
      status: outcome.ok ? (outcome.dryRun ? 'dry_run' : 'sent') : 'failed',
      note: entry.attempt.key,
      content: text,
      contentHash,
      attempts: 1,
      ...(entry.attempt.error ? { error: entry.attempt.error } : {}),
      ...(outcome.ok && !outcome.dryRun ? { verifiedAt: at } : {}),
    });
  }

  if (!outcome.ok) {
    report.failed += queue.length;
    notes.push(`私信分享失败：${outcome.error?.message ?? '未知原因'}`);
    if (outcome.error?.kind === 'risk') {
      deps.state.setRiskCooldown(new Date(ctx.now().getTime() + cfg.safety.riskCooldownMin * 60_000).toISOString());
      report.stopped = 'risk';
      notes.push(`撞风控，已停止本轮所有写操作并冷却 ${cfg.safety.riskCooldownMin} 分钟`);
      deps.logger.event('share', '私信分享撞风控，停止写操作', { level: 'warn', target: 'share' });
    }
    return;
  }

  if (outcome.dryRun) {
    report.dryRun += 1;
    notes.push(`预演私信分享（合并 ${queue.length} 条视频，未发送）：${text}`);
  } else {
    report.sent += 1;
    deps.feedback?.markShare(ctx.now());
    notes.push(`私信分享已发（合并 ${queue.length} 条视频）`);
    deps.logger.event('share', '私信分享已发', { target: 'share', data: { count: queue.length } });
  }
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
