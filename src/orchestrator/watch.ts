/**
 * 评论 / @ 监听（M4，默认关）。
 *
 * 规则（§7.9）：
 *   - 开关 `listen.comment.enabled`；间隔 ≥60s + 0–20% 抖动；只在作息窗口内听，除非 `allDay`。
 *   - 范围 `scope`：reply / at / both。
 *   - **游标**：`state.cursors.lastCommentSeenAt`。首次运行**只建基线、不倒历史**（否则一开就会把几十条旧回复当新的）。
 *   - 新消息合并成一次处理；按时间排序；去重（同一 sourceRpid 只处理一次）。
 *   - 主人 → 直接回（若 `listen.reply.ownerDirect`，默认关）；陌生人 → 走 M3 的待审队列。
 *   - 不主动去别人评论下留言；不参与争论。
 *
 * 不做什么：不发评论（审批队列负责）、不写报告（返回结果）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { BiliApi } from '../bili/api.ts';
import type { MsgfeedItem } from '../bili/api.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { PendingStore } from '../state/pending.ts';
import { expiresAt, newPendingId } from '../state/pending.ts';
import type { SecretsService } from '../config/secrets.ts';
import { localIso } from '../shared/time.ts';

export interface WatchDeps {
  logger: Logger;
  config: Config;
  api: BiliApi;
  state: AppStateStore;
  pending: PendingStore;
  secrets: SecretsService;
  now?: () => Date;
  /** 拟回复生成器（模型）；没注入就不建草稿。 */
  draft?: (input: { source: string; uname: string; videoTitle: string; maxChars: number }) => Promise<string | null>;
}

export interface WatchResult {
  /** 是否建了基线（首次运行）。 */
  baseline: boolean;
  seen: number;
  created: number;
  skipped: string[];
}

/** 监听一次：读「回复我的」+「@我的」，按游标过滤，陌生人的落成待审草稿。 */
export async function watchComments(deps: WatchDeps): Promise<WatchResult> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const result: WatchResult = { baseline: false, seen: 0, created: 0, skipped: [] };

  if (!cfg.listen.comment.enabled) {
    result.skipped.push('评论监听关着');
    return result;
  }

  const scope = cfg.listen.comment.scope;
  const items: MsgfeedItem[] = [];
  if (scope === 'reply' || scope === 'both') {
    const replies = await deps.api.msgfeedReplies();
    if (!replies.ok) result.skipped.push(`读「回复我的」失败：${replies.error.message}`);
    else items.push(...replies.data);
  }
  if (scope === 'at' || scope === 'both') {
    const ats = await deps.api.msgfeedAts();
    if (!ats.ok) result.skipped.push(`读「@我的」失败：${ats.error.message}`);
    else items.push(...ats.data);
  }
  items.sort((a, b) => a.atMs - b.atMs);
  result.seen = items.length;

  const cursor = deps.state.lastCommentSeenAt();
  // 首次运行：只建基线，不倒历史
  if (!cursor) {
    const newest = items.at(-1);
    deps.state.setCommentSeenAt(localIso(newest ? new Date(newest.atMs) : now()));
    result.baseline = true;
    deps.logger.info('listen', `评论监听建了基线（${items.length} 条历史不再处理）`);
    return result;
  }

  const cursorMs = Date.parse(cursor);
  const fresh = items.filter((item) => Number.isFinite(item.atMs) && item.atMs > cursorMs);
  if (fresh.length === 0) {
    result.skipped.push('没有新的回复/@');
    return result;
  }

  const owner = deps.config.account?.mid && deps.config.account.mid > 0 ? deps.config.account.mid : deps.secrets.selfMid();
  const maxChars = deps.config.listen.reply.maxChars;

  for (const item of fresh) {
    if (item.mid === owner || item.mid === deps.secrets.selfMid()) {
      // 主人自己（或自己）的消息不进审批队列
      result.skipped.push(`自己/主人的消息跳过（${item.uname}）`);
      continue;
    }
    if (deps.pending.has({ root: item.rootRpid || item.sourceRpid, parent: item.sourceRpid })) {
      result.skipped.push('这条已经在待审队列里了');
      continue;
    }
    const draft = deps.draft
      ? await deps.draft({ source: item.content, uname: item.uname, videoTitle: String(item.oid), maxChars })
      : null;
    if (!draft) {
      result.skipped.push(`没生成回复草稿（${item.uname}）`);
      continue;
    }
    deps.pending.add({
      id: newPendingId(now()),
      createdAt: localIso(now()),
      expiresAt: expiresAt(now()),
      status: 'pending',
      bvid: '',
      aid: item.oid,
      root: item.rootRpid || item.sourceRpid,
      parent: item.sourceRpid,
      target: { mid: item.mid, uname: item.uname },
      sourceComment: item.content.slice(0, 200),
      draft,
    });
    result.created += 1;
  }

  const newest = fresh.at(-1);
  deps.state.setCommentSeenAt(localIso(newest ? new Date(newest.atMs) : now()));
  return result;
}

/** 监听间隔：≥60s，加 0–20% 抖动；空闲时退避到 15 分钟。 */
export function nextWatchDelay(config: Config, consecutiveIdle: number): number {
  const base = Math.max(60, config.listen.comment.intervalSec) * 1000;
  const backoff = Math.min(base * Math.pow(1.5, Math.min(consecutiveIdle, 6)), 15 * 60 * 1000);
  const jitter = backoff * 0.2 * Math.random();
  return Math.round(backoff + jitter);
}

/** 私信监听间隔：20–60s（默认 30s）+ 0–20% 抖动。 */
export function nextDmDelay(config: Config): number {
  const base = Math.min(Math.max(config.listen.dm.intervalSec, 20), 60) * 1000;
  return Math.round(base + base * 0.2 * Math.random());
}
