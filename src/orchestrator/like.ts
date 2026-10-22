/**
 * 点赞与动态（M4，默认关）。
 *
 * 两个都是「可选、默认关」的能力，规则很简单，但必须和其它写一样受同一套开关约束：
 *   - 点赞：只对深读过的、且确实喜欢的；不投币、不关注；每日上限 `like.dailyCap`。
 *   - 动态：**一轮里从不自动发**；只能在面板手动、且必须二次确认（`dynamic.requireConfirm`）；
 *     默认关；不群发、不刷屏。
 * 不做什么：不判断内容好不好（模型说喜欢才点）、不写报告（返回结果给调用方）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { QuotaLedger } from '../state/ledgers.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { BiliWriter } from '../bili/write.ts';
import { localIso } from '../shared/time.ts';

export interface LikeDeps {
  logger: Logger;
  config: Config;
  quota: QuotaLedger;
  state: AppStateStore;
  writer: BiliWriter;
  now?: () => Date;
}

export interface LikeResult {
  ok: boolean;
  status: 'sent' | 'dry_run' | 'denied' | 'failed';
  deny: string[];
  note: string;
}

/** 点赞一个视频（默认关；只在深读并喜欢时调用）。 */
export async function likeVideo(
  deps: LikeDeps,
  input: { bvid: string; aid: number; inDeepRead: boolean; dryRun: boolean },
): Promise<LikeResult> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const deny: string[] = [];
  if (!cfg.like.enabled) deny.push('点赞开关关着');
  if (!input.inDeepRead) deny.push('只点深读过的');
  if (!cfg.safety.writeEnabled) deny.push('总写开关关着');
  if (cfg.safety.killSwitch) deny.push('急停开着');
  if (deps.state.inRiskCooldown(now())) deny.push('风控冷却中');

  const today = localIso(now()).slice(0, 10);
  if (deps.quota.countOn(today, 'like') >= cfg.like.dailyCap) deny.push(`今日点赞上限到了（${cfg.like.dailyCap}）`);

  if (deny.length > 0) return { ok: false, status: 'denied', deny, note: deny.join('；') };

  const outcome = await deps.writer.likeVideo({ bvid: input.bvid, aid: input.aid }, true, { dryRun: input.dryRun });
  if (!outcome.ok) {
    const message = outcome.error?.message ?? '点赞失败';
    deps.quota.add({
      at: localIso(now()),
      type: 'like',
      bvid: input.bvid,
      aid: input.aid,
      target: 'like',
      share: false,
      status: 'failed',
      error: message,
    });
    if (outcome.error?.kind === 'risk') {
      deps.state.setRiskCooldown(new Date(now().getTime() + cfg.safety.riskCooldownMin * 60_000).toISOString());
    }
    return { ok: false, status: 'failed', deny: [], note: message };
  }

  deps.quota.add({
    at: localIso(now()),
    type: 'like',
    bvid: input.bvid,
    aid: input.aid,
    target: 'like',
    share: false,
    status: outcome.dryRun ? 'dry_run' : 'sent',
  });
  return { ok: true, status: outcome.dryRun ? 'dry_run' : 'sent', deny: [], note: outcome.plan.summary };
}

/**
 * 发动态：只在面板手动触发；必须二次确认；一轮里永不自动调用。
 * `confirm` 由面板传入（用户点了确认）。
 */
export async function publishDynamic(
  deps: LikeDeps,
  input: { text: string; confirm: boolean; dryRun: boolean },
): Promise<LikeResult> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const deny: string[] = [];
  if (!cfg.dynamic.enabled) deny.push('动态开关关着');
  if (cfg.dynamic.requireConfirm && !input.confirm) deny.push('动态需要二次确认');
  if (!input.text.trim()) deny.push('内容是空的');
  if (!cfg.safety.writeEnabled) deny.push('总写开关关着');
  if (cfg.safety.killSwitch) deny.push('急停开着');
  if (deps.state.inRiskCooldown(now())) deny.push('风控冷却中');
  const today = localIso(now()).slice(0, 10);
  if (deps.quota.countOn(today, 'dynamic') >= cfg.dynamic.dailyCap) deny.push(`今日动态上限到了（${cfg.dynamic.dailyCap}）`);

  if (deny.length > 0) return { ok: false, status: 'denied', deny, note: deny.join('；') };

  const outcome = await deps.writer.postDynamic({ text: input.text.trim() }, { dryRun: input.dryRun });
  if (!outcome.ok) {
    const message = outcome.error?.message ?? '发动态失败';
    deps.quota.add({
      at: localIso(now()),
      type: 'dynamic',
      bvid: '',
      target: 'dynamic',
      share: false,
      status: 'failed',
      content: input.text,
      error: message,
    });
    return { ok: false, status: 'failed', deny: [], note: message };
  }

  deps.quota.add({
    at: localIso(now()),
    type: 'dynamic',
    bvid: '',
    target: 'dynamic',
    share: false,
    status: outcome.dryRun ? 'dry_run' : 'sent',
    content: input.text,
  });
  return { ok: true, status: outcome.dryRun ? 'dry_run' : 'sent', deny: [], note: outcome.plan.summary };
}
