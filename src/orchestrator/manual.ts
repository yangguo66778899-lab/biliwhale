/**
 * 手动写操作（面板上人点的那几个）：
 *   - 删自己在某个视频下的评论（M3）
 *   - 手动发一条私信（M4：测试消息 / 今天的公开日记 / 今天上下文里的视频信息）
 *
 * 职责：保证手动写和自动写受**同一套**开关与风控约束（总写开关 / 急停 / 预演 / 风控冷却），
 *   并且做防呆：只删自己的（rpid 来自账本）、只发今天出现过的 BV、私信 ≤500。
 * 不做什么：不自动删/发（永远由人点）、不猜 aid、不调模型。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { QuotaLedger } from '../state/ledgers.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { BiliWriter } from '../bili/write.ts';
import { resolveOwner } from '../account/owner.ts';

export interface ManualDeleteDeps {
  logger: Logger;
  config: Config;
  quota: QuotaLedger;
  state: AppStateStore;
  writer: BiliWriter;
  now?: () => Date;
}

export async function deleteOwnComment(
  deps: ManualDeleteDeps,
  input: { bvid: string; rpid: string },
  options: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;

  if (!input.bvid || !input.rpid) return { ok: false, message: '缺少 bvid 或 rpid' };
  if (!cfg.safety.writeEnabled) return { ok: false, message: '总写开关关着' };
  if (cfg.safety.killSwitch) return { ok: false, message: '急停开着' };
  if (deps.state.inRiskCooldown(now())) return { ok: false, message: '风控冷却中，先别动' };

  // 只认我们自己账本里的记录：不让人从面板删别人的评论
  const entry = deps.quota
    .entries()
    .filter((item) => item.bvid === input.bvid && String(item.rpid ?? '') === String(input.rpid) && item.type === 'comment')
    .pop();
  if (!entry) return { ok: false, message: '账本里没有这条评论（只允许删自己发过的）' };
  const aid = typeof entry.aid === 'number' && entry.aid > 0 ? entry.aid : 0;
  if (aid === 0) return { ok: false, message: '账本里没有这条视频的 aid，先对账再删' };

  const outcome = await deps.writer.deleteComment({ bvid: input.bvid, aid, rpid: input.rpid }, { dryRun: options.dryRun === true });
  if (!outcome.ok) return { ok: false, message: outcome.error?.message ?? '删除失败' };

  deps.logger.event('share', `删除了自己在 ${input.bvid} 下的评论`, {
    target: 'share',
    data: { rpid: input.rpid, dryRun: options.dryRun === true },
  });
  return { ok: true, message: options.dryRun === true ? `预演：${outcome.plan.summary}` : '已删除' };
}

export interface ManualDmDeps extends ManualDeleteDeps {
  secrets: { selfMid(): number };
  chat: { append(line: { at: string; from: 'owner' | 'self'; text: string; manual?: boolean }): void };
  now?: () => Date;
}

/**
 * 面板手动发私信：测试消息 / 今天的公开日记 / 今天上下文里的视频信息。
 * 只发给主人（配置里的 account.ownerMid，必须是另一个号）；只发今天报告里出现过的 BV；≤500 字。
 */
export async function sendManualDm(
  deps: ManualDmDeps,
  input: { text?: string; kind?: 'diary' | 'video_info'; bvid?: string; diary?: string; videoText?: string },
): Promise<{ ok: boolean; message: string }> {
  const cfg = deps.config;
  if (!cfg.safety.writeEnabled) return { ok: false, message: '总写开关关着' };
  if (cfg.safety.killSwitch) return { ok: false, message: '急停开着' };

  const owner = resolveOwner(cfg, deps.secrets.selfMid());
  if (!owner.ok) return { ok: false, message: owner.problem ?? '主人还没配置' };
  const receiver = owner.mid;

  let text = input.text?.trim() ?? '';
  if (input.kind === 'diary') {
    if (!input.diary) return { ok: false, message: '今天还没有公开日记' };
    text = input.diary.slice(0, 480);
  } else if (input.kind === 'video_info') {
    if (!input.bvid) return { ok: false, message: '缺少 bvid' };
    if (!input.videoText) return { ok: false, message: `${input.bvid} 不在今天的上下文里（只发今天出现过的视频）` };
    text = input.videoText;
  }
  if (!text) return { ok: false, message: '内容是空的' };

  const chars = Array.from(text);
  if (chars.length > cfg.listen.dm.maxChars) text = `${chars.slice(0, cfg.listen.dm.maxChars - 1).join('')}…`;

  const outcome = await deps.writer.sendDm({ receiverId: receiver, text, senderId: deps.secrets.selfMid() }, { dryRun: cfg.safety.dryRun });
  if (!outcome.ok) return { ok: false, message: outcome.error?.message ?? '发送失败' };

  // 预演不发、也不记聊天（否则记录里会出现一条没真正发出的消息）
  if (!outcome.dryRun) deps.chat.append({ at: (deps.now?.() ?? new Date()).toISOString(), from: 'self', text, manual: true });
  return { ok: true, message: outcome.dryRun ? `预演：${outcome.plan.summary}（未发送）` : '已发送' };
}
