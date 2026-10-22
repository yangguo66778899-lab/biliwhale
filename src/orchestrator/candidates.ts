/**
 * 候选收集（Phase 2）。
 *
 * 职责：多源取回 → 归一化 → 去重（判重账本）→ 过滤（时长 / UP / 已看过）→ 排序 → 截断。
 *   全部是确定性代码，模型不参与；为了让模型省 token，候选只带轻量信息。
 *
 * **翻页与补足**（v0.5.1 修的真机问题）：
 *   每个源以前只取第 1 页，一天里刷几轮就把这一页挖空——候选 27 → 17 → 8 → 0，
 *   看着像 bug，其实是「池子只有 85 条 + 判重冷藏 7 天」。
 *   现在：候选不够 `candidateLimit` 时自动往后翻页（`content.candidatePages`，默认 3，1–5），
 *   翻到底就停（某页一条新的都没有时不再继续请求），并在报告里写「候选不足」而不是静默变少。
 *
 * 不做什么：不打分、不判断值不值得（初筛是模型的事）、不发请求给写接口。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { BiliApi } from '../bili/api.ts';
import type { Candidate, BiliVideo, CandidateSource } from '../shared/types.ts';
import type { SeenLedger } from '../state/ledgers.ts';
import { daysAgoText } from '../shared/time.ts';
import { humanDuration } from '../shared/time.ts';

export interface CollectResult {
  candidates: Candidate[];
  /** 每个源（含页码）取回多少（给报告与排障）。 */
  perSource: Record<string, number>;
  errors: string[];
  notes: string[];
  /** 这次一共翻了几个源页（1 = 没补页）。 */
  pages: number;
}

export interface CollectOptions {
  api: BiliApi;
  config: Config;
  seen: SeenLedger;
  logger: Logger;
  /** 有 cookie 才读得到关注动态；没有就别把它当失败。 */
  hasCookie?: boolean;
  now?: Date;
}

/** 判重冷藏天数默认值（可在设置里改；0 = 不去重）。 */
const DEFAULT_SEEN_DEDUPE_DAYS = 7;
/** 每页取多少（热门/关注）。搜索的页大小由 B 站定（约 20–30 条）。 */
const FEED_PAGE_SIZE = 20;
const FOLLOWING_PAGE_SIZE = 15;
/** 补页上限：再大就只是在拖慢一轮，收益很小。 */
const MAX_PAGES = 5;

interface PoolSnapshot {
  candidates: Candidate[];
  mergedCount: number;
  filteredCount: number;
  droppedByDuration: number;
  droppedByUp: number;
  droppedBySeen: number;
}

export async function collectCandidates(opts: CollectOptions): Promise<CollectResult> {
  const { api, config, logger } = opts;
  const now = opts.now ?? new Date();
  const perSource: Record<string, number> = {};
  const errors: string[] = [];
  const notes: string[] = [];
  const pool: BiliVideo[] = [];
  const maxPages = clampInt(config.content.candidatePages ?? 3, 1, MAX_PAGES);

  const keywords = config.preferences.keywords.length > 0 ? config.preferences.keywords : config.preferences.like;
  const pickedKeywords = keywords.slice(0, 3);
  if (config.content.sources.search && pickedKeywords.length === 0) {
    notes.push('没有可用的搜索关键词（preferences.like / keywords 都是空的），跳过搜索源');
  }

  // 一页一页地取，直到「过滤后的候选够用」或「翻到底」
  let snapshot: PoolSnapshot = emptySnapshot();
  let pages = 0;
  let beforeMerged = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    await collectPage(page);
    pages = page;

    snapshot = selectFromPool(pool, {
      config,
      seen: opts.seen,
      now,
      dedupeDays: Math.max(0, Math.floor(config.content.seenDedupeDays ?? DEFAULT_SEEN_DEDUPE_DAYS)),
    });

    if (snapshot.filteredCount >= config.content.candidateLimit) break; // 够了
    if (fatalError()) break; // 撞风控/掉登录：别再翻
    // 这一页没带来任何新的 bvid → 源见底了（有些接口不认页码，会一直返回第一页）
    if (snapshot.mergedCount === beforeMerged) break;
    beforeMerged = snapshot.mergedCount;
  }

  const dedupeDays = Math.max(0, Math.floor(config.content.seenDedupeDays ?? DEFAULT_SEEN_DEDUPE_DAYS));
  if (pages > 1) notes.push(`候选不够，往后翻了 ${pages} 页（每页都会过一遍判重）`);
  if (snapshot.droppedByDuration > 0) notes.push(`按时长过滤掉 ${snapshot.droppedByDuration} 条`);
  if (snapshot.droppedByUp > 0) notes.push(`按屏蔽 UP 过滤掉 ${snapshot.droppedByUp} 条`);
  if (snapshot.droppedBySeen > 0) notes.push(`最近 ${dedupeDays} 天看过，去重掉 ${snapshot.droppedBySeen} 条`);
  if (snapshot.candidates.length < config.content.screenLimit) {
    const why =
      pages >= maxPages
        ? `已经翻到第 ${pages} 页，今天能翻的新内容差不多就这些`
        : '能翻的都翻了';
    notes.push(`候选只有 ${snapshot.candidates.length} 条（少于送初筛的 ${config.content.screenLimit} 条）：${why}`);
  }

  logger.info(
    'candidates',
    `候选 ${snapshot.candidates.length} 条（合并 ${snapshot.mergedCount}，过滤后 ${snapshot.filteredCount}，翻了 ${pages} 页）`,
    perSource,
  );

  return { candidates: snapshot.candidates, perSource, errors, notes, pages };

  /* ---------------- 内部 ---------------- */

  function fatalError(): boolean {
    return errors.some((line) => line.includes('停止继续取数'));
  }

  function addError(source: string, message: string, kind?: string): void {
    errors.push(`${source}：${message}`);
    perSource[source] = perSource[source] ?? 0;
    if (kind === 'risk' || kind === 'auth') errors.push(`撞风控/掉登录：停止继续取数（${source}）`);
  }

  async function collectPage(page: number): Promise<void> {
    const suffix = page > 1 ? `#p${page}` : '';

    // 1) 关键词搜索（关键词为空时用「喜欢的方向」当关键词）
    if (config.content.sources.search) {
      for (const keyword of pickedKeywords) {
        if (fatalError()) return;
        const res = await api.searchVideos(keyword, { order: 'pubdate', page });
        if (!res.ok) {
          addError(`搜索「${keyword}」${suffix}`, res.error.message, res.error.kind);
          if (res.error.kind === 'risk' || res.error.kind === 'auth') return;
          continue;
        }
        perSource[`search:${keyword}${suffix}`] = res.data.length;
        pool.push(...res.data);
      }
    }

    // 2) 热门（pn 可以翻页）
    if (config.content.sources.hot) {
      const res = await api.popular(FEED_PAGE_SIZE, page);
      if (res.ok) {
        perSource[`hot${suffix}`] = res.data.length;
        pool.push(...res.data);
      } else {
        addError(`热门${suffix}`, res.error.message, res.error.kind);
      }
    }

    // 3) 排行（接口没有分页，只有第 1 页）
    if (config.content.sources.ranking && page === 1) {
      const res = await api.ranking(FEED_PAGE_SIZE);
      if (res.ok) {
        perSource.ranking = res.data.length;
        pool.push(...res.data);
      } else {
        addError('排行', res.error.message, res.error.kind);
      }
    }

    // 4) 关注动态（可能为空，正常；未登录时读不到，也不算失败）
    if (config.content.sources.following) {
      const res = await api.following(FOLLOWING_PAGE_SIZE, page);
      if (res.ok) {
        perSource[`following${suffix}`] = res.data.length;
        pool.push(...res.data);
        if (page === 1 && res.data.length === 0) notes.push('关注动态是空的（可能没关注人，或登录态失效）');
      } else if (!opts.hasCookie && res.error.kind === 'auth') {
        perSource[`following${suffix}`] = 0;
        notes.push('关注动态需要登录：本轮没有 cookie，跳过这一路（不是失败）');
      } else {
        addError(`关注动态${suffix}`, res.error.message, res.error.kind);
      }
    }
  }
}

/* ---------- 纯函数：把池子变成候选（补页判定复用同一份逻辑） ---------- */

export interface SelectOptions {
  config: Config;
  seen: SeenLedger;
  now: Date;
  dedupeDays: number;
}

/** 合并 → 去重 → 过滤 → 粗排 → 截断。纯函数，不碰网络，方便测试与补页复用。 */
export function selectFromPool(pool: BiliVideo[], opts: SelectOptions): PoolSnapshot {
  const { config, seen, now, dedupeDays } = opts;

  const merged = new Map<string, BiliVideo>();
  for (const video of pool) {
    if (!video.bvid) continue;
    const prev = merged.get(video.bvid);
    if (!prev) {
      merged.set(video.bvid, video);
      continue;
    }
    merged.set(video.bvid, { ...prev, ...preferFilled(prev, video) });
  }

  const excludeUp = new Set(config.content.excludeUp.map((s) => s.trim()).filter(Boolean));
  const includeUp = new Set(config.content.includeUp.map((s) => s.trim()).filter(Boolean));

  const filtered: Candidate[] = [];
  let droppedByDuration = 0;
  let droppedByUp = 0;
  let droppedBySeen = 0;

  for (const video of merged.values()) {
    if (excludeUp.has(video.owner.name)) {
      droppedByUp += 1;
      continue;
    }
    if (video.durationSec > 0) {
      if (video.durationSec < config.content.minDuration || video.durationSec > config.content.maxDuration) {
        droppedByDuration += 1;
        continue;
      }
    }
    if (dedupeDays > 0 && seen.seenWithin(video.bvid, dedupeDays, now)) {
      droppedBySeen += 1;
      continue;
    }
    filtered.push({
      video,
      source: (video.source ?? 'search') as CandidateSource,
      durationText: video.durationSec > 0 ? humanDuration(video.durationSec * 1000) : '时长未知',
      ageText: video.pubdateIso ? daysAgoText(video.pubdateIso, now) : '时间未知',
    });
  }

  const scored = filtered.map((candidate) => ({ candidate, rank: rankScore(candidate, config, includeUp) }));
  scored.sort((a, b) => b.rank - a.rank);
  const candidates = scored.slice(0, config.content.candidateLimit).map((x) => x.candidate);

  return {
    candidates,
    mergedCount: merged.size,
    filteredCount: filtered.length,
    droppedByDuration,
    droppedByUp,
    droppedBySeen,
  };
}

function emptySnapshot(): PoolSnapshot {
  return { candidates: [], mergedCount: 0, filteredCount: 0, droppedByDuration: 0, droppedByUp: 0, droppedBySeen: 0 };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 后到的字段更全时才覆盖（避免用空值把好数据冲掉）。 */
function preferFilled(prev: BiliVideo, next: BiliVideo): Partial<BiliVideo> {
  const out: Partial<BiliVideo> = {};
  if (!prev.desc && next.desc) out.desc = next.desc;
  if (!prev.owner.name && next.owner.name) out.owner = next.owner;
  if (!prev.owner.mid && next.owner.mid) out.owner = { mid: next.owner.mid, name: prev.owner.name || next.owner.name };
  if (!prev.durationSec && next.durationSec) out.durationSec = next.durationSec;
  if (!prev.pubdateIso && next.pubdateIso) out.pubdateIso = next.pubdateIso;
  if (!prev.cid && next.cid) out.cid = next.cid;
  if (!prev.aid && next.aid) out.aid = next.aid;
  if (prev.stats.reply === 0 && next.stats.reply > 0) out.stats = { ...prev.stats, ...next.stats };
  return out;
}

/** 粗排：只用来决定「先给模型看哪 10 条」，真正的判断在初筛。 */
export function rankScore(candidate: Candidate, config: Config, includeUp: Set<string>): number {
  const { video } = candidate;
  let score = 0;
  const text = `${video.title} ${video.desc}`.toLowerCase();
  for (const like of config.preferences.like) {
    if (like && text.includes(like.toLowerCase())) score += 3;
  }
  for (const keyword of config.preferences.keywords) {
    if (keyword && text.includes(keyword.toLowerCase())) score += 2;
  }
  for (const dislike of config.preferences.dislike) {
    if (dislike && text.includes(dislike.toLowerCase())) score -= 4;
  }
  if (includeUp.has(video.owner.name)) score += 5;
  // 评论热度：对数压缩，别让一条爆款压死其它
  score += Math.log10(video.stats.reply + 1) * 2;
  score += Math.log10(video.stats.view + 1) * 0.5;
  // 新鲜度：3 天内的加权
  if (video.pubdateIso) {
    const ageDays = (Date.now() - Date.parse(video.pubdateIso)) / 86_400_000;
    if (ageDays <= 1) score += 3;
    else if (ageDays <= 3) score += 2;
    else if (ageDays <= 7) score += 1;
  }
  return score;
}
