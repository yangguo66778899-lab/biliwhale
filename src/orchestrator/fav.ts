/**
 * 收藏（M4）：判据在代码里，不靠模型自觉。
 *
 * 判据（§10.2，缺一不可）：
 *   1. 说得清为什么留：理由 ≥ `fav.minReasonChars`（默认 6 字）
 *   2. 同类已 ≥ 2 条时，要说明「比它们好/不同在哪」（我们看的是当天已收藏记录的同 UP/同主题）
 *   3. 每天 ≤ `fav.dailyCap`（默认 3）
 *   4. 同一视频 30 天内只收一次（`fav.perVideoDays`）
 *   5. 开关 `fav.enabled`（默认开）、总写开关、急停、风控冷却、预演
 * 不做什么：不自己挑视频（候选来自本轮决定）、不读字幕、不调模型。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { QuotaLedger } from '../state/ledgers.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { BiliWriter } from '../bili/write.ts';
import type { BiliApi } from '../bili/api.ts';
import { localIso } from '../shared/time.ts';

export type FavStatus = 'sent' | 'unverified' | 'failed' | 'denied' | 'dry_run';

export interface FavCandidate {
  bvid: string;
  aid: number;
  /** 模型给的理由。 */
  reason: string;
  /** 同一个 UP 或同一主题当天已经收藏了几条（用来要求「说明更好在哪」）。 */
  sameKindCount: number;
  /** 在深读集合里（只收真的看过的）。 */
  inDeepRead: boolean;
}

export interface FavAttempt {
  bvid: string;
  status: FavStatus;
  reason: string;
  deny: string[];
  notes: string[];
  plan?: { summary: string };
  error?: string;
  verified?: boolean;
}

export interface FavDeps {
  logger: Logger;
  config: Config;
  quota: QuotaLedger;
  state: AppStateStore;
  writer: BiliWriter;
  api: BiliApi;
  now?: () => Date;
}

export interface FavReport {
  attempts: FavAttempt[];
  sent: number;
  dryRun: number;
  denied: number;
  failed: number;
  unverified: number;
  notes: string[];
}

const FAV_TYPE = 'fav' as const;

export async function executeFavorites(deps: FavDeps, input: { items: FavCandidate[]; dryRun: boolean }): Promise<FavReport> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const report: FavReport = { attempts: [], sent: 0, dryRun: 0, denied: 0, failed: 0, unverified: 0, notes: [] };
  const date = localIso(now()).slice(0, 10);
  const todayCount = deps.quota.countOn(date, FAV_TYPE);

  for (const item of input.items) {
    const attempt: FavAttempt = { bvid: item.bvid, status: 'denied', reason: item.reason, deny: [], notes: [] };
    report.attempts.push(attempt);

    if (!cfg.fav.enabled) {
      attempt.deny.push('收藏开关关着');
    } else if (!item.inDeepRead) {
      attempt.deny.push('只收深读过的');
    } else if (!cfg.safety.writeEnabled) {
      attempt.deny.push('总写开关关着');
    } else if (cfg.safety.killSwitch) {
      attempt.deny.push('急停开着');
    } else if (deps.state.inRiskCooldown(now())) {
      attempt.deny.push('风控冷却中');
    }

    const reasonChars = Array.from((item.reason ?? '').trim()).length;
    if (reasonChars < cfg.fav.minReasonChars) {
      attempt.deny.push(`理由太短（${reasonChars} < ${cfg.fav.minReasonChars} 字）：说不清为什么留就不收`);
    }
    if (item.sameKindCount >= 2) {
      const explained = /比|不同|更|不如|相较|区别/.test(item.reason ?? '');
      if (!explained) attempt.deny.push('同类已经收过 2 条以上，得说明这一条好在哪/不同在哪');
    }
    if (todayCount + report.sent + report.dryRun >= cfg.fav.dailyCap) {
      attempt.deny.push(`今日收藏额度用完（${todayCount}/${cfg.fav.dailyCap}）`);
    }
    const lastAt = deps.quota.lastSentAt(item.bvid, 'all');
    if (lastAt) {
      const days = (now().getTime() - Date.parse(lastAt)) / 86_400_000;
      if (days < cfg.fav.perVideoDays) attempt.deny.push(`同一视频冷却中（${Math.floor(days)}/${cfg.fav.perVideoDays} 天）`);
    }

    if (attempt.deny.length > 0) {
      report.denied += 1;
      report.notes.push(`没收藏 ${item.bvid}：${attempt.deny.join('；')}`);
      continue;
    }

    const at = localIso(now());
    const outcome = await deps.writer.favVideo({ bvid: item.bvid, aid: item.aid }, { dryRun: input.dryRun });
    attempt.plan = { summary: outcome.plan.summary };

    if (!outcome.ok) {
      attempt.status = 'failed';
      attempt.error = outcome.error?.message ?? '收藏失败';
      report.failed += 1;
      deps.quota.add({
        at,
        type: FAV_TYPE,
        bvid: item.bvid,
        aid: item.aid,
        target: 'fav',
        share: false,
        status: 'failed',
        content: item.reason,
        error: attempt.error,
      });
      report.notes.push(`收藏失败 ${item.bvid}：${attempt.error}`);
      if (outcome.error?.kind === 'risk') {
        deps.state.setRiskCooldown(new Date(now().getTime() + cfg.safety.riskCooldownMin * 60_000).toISOString());
        report.notes.push('撞风控，已停止本轮收藏');
        break;
      }
      continue;
    }

    if (outcome.dryRun) {
      attempt.status = 'dry_run';
      report.dryRun += 1;
      deps.quota.add({
        at,
        type: FAV_TYPE,
        bvid: item.bvid,
        aid: item.aid,
        target: 'fav',
        share: false,
        status: 'dry_run',
        content: item.reason,
      });
      report.notes.push(`预演收藏 ${item.bvid}（未真的收藏）`);
      continue;
    }

    // 复核：收藏夹里有没有这个视频（最多 2 次）
    let verified = false;
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      if (attemptIndex > 0) await sleep(1000);
      const check = await deps.api.favContains(item.aid);
      if (check.ok && check.data.length > 0) {
        verified = true;
        break;
      }
    }
    attempt.verified = verified;
    attempt.status = verified ? 'sent' : 'unverified';
    if (verified) report.sent += 1;
    else report.unverified += 1;

    deps.quota.add({
      at,
      type: FAV_TYPE,
      bvid: item.bvid,
      aid: item.aid,
      target: 'fav',
      share: false,
      status: verified ? 'sent' : 'unverified',
      content: item.reason,
      ...(verified ? { verifiedAt: at } : { error: '复核没在收藏夹里看到' }),
    });
    report.notes.push(verified ? `已收藏 ${item.bvid}（复核通过）` : `收藏 ${item.bvid} 但复核没通过（标 unverified，不重试）`);
  }

  if (report.attempts.length === 0) report.notes.push('这一轮没有要收藏的');
  return report;
}

/** 收藏判据的纯函数版本（给测试与面板预览用）。 */
export function canFavorite(input: {
  enabled: boolean;
  writeEnabled: boolean;
  killSwitch: boolean;
  riskCooldown: boolean;
  reason: string;
  minReasonChars: number;
  sameKindCount: number;
  todayCount: number;
  dailyCap: number;
  lastFavAt: string | null;
  perVideoDays: number;
  inDeepRead: boolean;
  now?: Date;
}): { allow: boolean; deny: string[] } {
  const deny: string[] = [];
  const now = input.now ?? new Date();
  if (!input.enabled) deny.push('收藏开关关着');
  if (!input.writeEnabled) deny.push('总写开关关着');
  if (input.killSwitch) deny.push('急停开着');
  if (input.riskCooldown) deny.push('风控冷却中');
  if (!input.inDeepRead) deny.push('只收深读过的');
  if (Array.from(input.reason.trim()).length < input.minReasonChars) deny.push('理由太短');
  if (input.sameKindCount >= 2 && !/比|不同|更|不如|相较|区别/.test(input.reason)) deny.push('同类已 ≥2 条，要说明好在哪');
  if (input.todayCount >= input.dailyCap) deny.push('今日收藏额度用完');
  if (input.lastFavAt) {
    const days = (now.getTime() - Date.parse(input.lastFavAt)) / 86_400_000;
    if (days < input.perVideoDays) deny.push('同一视频冷却中');
  }
  return { allow: deny.length === 0, deny };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
