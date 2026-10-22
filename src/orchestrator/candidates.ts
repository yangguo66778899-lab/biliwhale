/**
 * 候选收集（Phase 2）。
 *
 * 职责：多源取回 → 归一化 → 去重（判重账本）→ 过滤（时长 / UP / 已看过）→ 排序 → 截断。
 *   全部是确定性代码，模型不参与；为了让模型省 token，候选只带轻量信息。
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
  /** 每个源取回多少（给报告与排障）。 */
  perSource: Record<string, number>;
  errors: string[];
  notes: string[];
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

/** 最近 7 天看过的视频不再进候选（避免每天都推同一条）。 */
const SEEN_DEDUPE_DAYS = 7;

export async function collectCandidates(opts: CollectOptions): Promise<CollectResult> {
  const { api, config, logger } = opts;
  const now = opts.now ?? new Date();
  const perSource: Record<string, number> = {};
  const errors: string[] = [];
  const notes: string[] = [];
  const pool: BiliVideo[] = [];

  const pushAll = (source: string, list: BiliVideo[]) => {
    perSource[source] = list.length;
    pool.push(...list);
  };

  const addError = (source: string, message: string) => {
    errors.push(`${source}：${message}`);
    perSource[source] = 0;
  };

  // 1) 关键词搜索（关键词为空时用「喜欢的方向」当关键词）
  if (config.content.sources.search) {
    const keywords = config.preferences.keywords.length > 0 ? config.preferences.keywords : config.preferences.like;
    const picked = keywords.slice(0, 3);
    if (picked.length === 0) {
      notes.push('没有可用的搜索关键词（preferences.like / keywords 都是空的），跳过搜索源');
    }
    for (const keyword of picked) {
      const res = await api.searchVideos(keyword, { order: 'pubdate', page: 1 });
      if (!res.ok) {
        addError(`搜索「${keyword}」`, res.error.message);
        if (res.error.kind === 'risk' || res.error.kind === 'auth') break; // 撞风控/掉登录：不再继续取数
        continue;
      }
      pushAll(`search:${keyword}`, res.data);
    }
  }

  // 2) 热门
  if (config.content.sources.hot) {
    const res = await api.popular(20);
    if (res.ok) pushAll('hot', res.data);
    else addError('热门', res.error.message);
  }

  // 3) 排行
  if (config.content.sources.ranking) {
    const res = await api.ranking(20);
    if (res.ok) pushAll('ranking', res.data);
    else addError('排行', res.error.message);
  }

  // 4) 关注动态（可能为空，正常；未登录时读不到，也不算失败）
  if (config.content.sources.following) {
    const res = await api.following(20);
    if (res.ok) {
      pushAll('following', res.data);
      if (res.data.length === 0) notes.push('关注动态是空的（可能没关注人，或登录态失效）');
    } else if (!opts.hasCookie && res.error.kind === 'auth') {
      perSource.following = 0;
      notes.push('关注动态需要登录：本轮没有 cookie，跳过这一路（不是失败）');
    } else {
      addError('关注动态', res.error.message);
    }
  }

  // 归一化 + 去重（同一 bvid 只留一条，来源取先到的那个）
  const merged = new Map<string, BiliVideo>();
  for (const video of pool) {
    if (!video.bvid) continue;
    const prev = merged.get(video.bvid);
    if (!prev) {
      merged.set(video.bvid, video);
      continue;
    }
    // 补齐：后到的条目可能有更全的信息（比如热门里有 stat、搜索里没有）
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
    if (opts.seen.seenWithin(video.bvid, SEEN_DEDUPE_DAYS, now)) {
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

  if (droppedByDuration > 0) notes.push(`按时长过滤掉 ${droppedByDuration} 条`);
  if (droppedByUp > 0) notes.push(`按屏蔽 UP 过滤掉 ${droppedByUp} 条`);
  if (droppedBySeen > 0) notes.push(`最近 ${SEEN_DEDUPE_DAYS} 天看过，去重掉 ${droppedBySeen} 条`);

  // 排序：优先 UP > 偏好关键词命中 > 评论热度 > 新鲜度
  const scored = filtered.map((candidate) => ({ candidate, rank: rankScore(candidate, config, includeUp) }));
  scored.sort((a, b) => b.rank - a.rank);
  const candidates = scored.slice(0, config.content.candidateLimit).map((x) => x.candidate);

  logger.info('candidates', `候选 ${candidates.length} 条（合并 ${merged.size}，过滤后 ${filtered.length}）`, perSource);

  return { candidates, perSource, errors, notes };
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
