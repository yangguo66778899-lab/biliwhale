/**
 * 手动写操作（M3 只有一种：删自己在某个视频下的评论）。
 *
 * 职责：把「面板上的手动删除」收进编排器一侧，保证它和自动写一样受开关与风控约束：
 *   - 总写开关/急停/预演/风控冷却都要检查；
 *   - 只删自己发的（rpid 来自我们自己的账本，不接受任意 rpid）；
 *   - 记事件。
 * 不做什么：不自动删（永远由人点）、不猜 aid（账本里没有就拒绝）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { QuotaLedger } from '../state/ledgers.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { BiliWriter } from '../bili/write.ts';

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
