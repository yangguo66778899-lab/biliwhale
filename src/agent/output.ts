/**
 * 模型输出的解析与校验。
 *
 * 职责：把模型返回的文本变成**可信的**结构化数据：
 *   - 从 ```json 代码块或裸 JSON 里把对象抠出来；
 *   - 字段级校验、类型纠偏、长度截断、bvid 白名单过滤；
 *   - 不合格时给出「人话原因」，让上层决定是修一次还是降级。
 * 不做什么：不信任模型自报的分数/额度（分数只作参考，闸门用代码再算）。
 */

import type { Result } from '../shared/errors.ts';
import type { RoundResult, ScreenItem, ScreenResult, SelectedItem, ShareProposal, SkipReason, SkippedItem } from '../shared/types.ts';

const SKIP_REASONS: readonly SkipReason[] = [
  'no_subtitle',
  'low_score',
  'duplicate',
  'irrelevant',
  'tool_error',
  'too_old',
  'other',
];

/** 从文本里抠出第一个 JSON 对象；抠不出来返回 null。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fences = [...trimmed.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)];
  for (const fence of fences) {
    const body = fence[1]?.trim();
    if (!body) continue;
    const parsed = tryParse(body);
    if (parsed !== undefined) return parsed;
  }

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // 兜底：抓第一对花括号（模型有时会在 JSON 前后加一句话）
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ---------- 初筛结果 ---------- */

export function validateScreenResult(raw: unknown, allowed: Set<string>): Result<ScreenResult> {
  if (!isObj(raw)) return invalid('初筛结果不是 JSON 对象');
  const list = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.candidates) ? raw.candidates : null;
  if (!list) return invalid('初筛结果缺少 items 数组');
  if (list.length === 0) return invalid('初筛结果 items 是空的');

  const items: ScreenItem[] = [];
  const seen = new Set<string>();
  for (const [idx, entry] of list.entries()) {
    if (!isObj(entry)) return invalid(`items[${idx}] 不是对象`);
    const bvid = str(entry.bvid);
    if (!bvid) return invalid(`items[${idx}] 缺少 bvid`);
    if (!allowed.has(bvid)) return invalid(`items[${idx}] 的 bvid（${bvid}）不在本轮候选里`);
    if (seen.has(bvid)) continue;
    seen.add(bvid);
    const score = clamp(num(entry.score), 0, 20);
    items.push({
      bvid,
      score,
      reason: clip(str(entry.reason), 120),
      deep: typeof entry.deep === 'boolean' ? entry.deep : score > 0,
    });
  }
  if (items.length === 0) return invalid('初筛结果里没有可用的条目');
  return { ok: true, data: { items, notes: clip(str((raw as Record<string, unknown>).notes), 300) } };
}

/* ---------- 最终结果 ---------- */

export interface RoundContext {
  /** 本轮真正深读过的 bvid（只有这些能进 selected）。 */
  deepReadBvids: Set<string>;
  maxVideos: number;
  shareChannels: string[];
  shareMaxChars: number;
  scoreMin: number;
}

export function validateRoundResult(raw: unknown, ctx: RoundContext): Result<RoundResult> {
  if (!isObj(raw)) return invalid('最终结果不是 JSON 对象');

  const diary = isObj(raw.diary) ? raw.diary : null;
  if (!diary) return invalid('缺少 diary 对象');
  const diaryPublic = str(diary.public).trim();
  const diaryPrivate = str(diary.private).trim();
  if (!diaryPublic) return invalid('diary.public 是空的：公开日记必须写');
  if (!diaryPrivate) return invalid('diary.private 是空的：私人日记必须写');

  const selectedRaw = Array.isArray(raw.selected) ? raw.selected : [];
  const selected: SelectedItem[] = [];
  for (const [idx, entry] of selectedRaw.entries()) {
    if (!isObj(entry)) return invalid(`selected[${idx}] 不是对象`);
    const bvid = str(entry.bvid);
    if (!bvid) return invalid(`selected[${idx}] 缺少 bvid`);
    if (!ctx.deepReadBvids.has(bvid)) {
      return invalid(`selected[${idx}] 的 ${bvid} 没有深读过（只从深读里挑）`);
    }
    const why = str(entry.why).trim();
    if (why.length < 6) return invalid(`selected[${idx}] 的 why 太短（至少 6 个字，说清为什么值得）`);
    const oneliner = str(entry.oneliner).trim();
    if (oneliner.length < 2) return invalid(`selected[${idx}] 的 oneliner 太短`);

    const share = normalizeShare(entry.share, ctx);
    selected.push({ bvid, score: clamp(num(entry.score), 0, 20), why: clip(why, 600), oneliner: clip(oneliner, 120), ...(share ? { share } : {}) });
    if (selected.length >= Math.max(ctx.maxVideos, 1)) break;
  }

  const skippedRaw = Array.isArray(raw.skipped) ? raw.skipped : [];
  const skipped: SkippedItem[] = [];
  for (const [idx, entry] of skippedRaw.entries()) {
    if (!isObj(entry)) return invalid(`skipped[${idx}] 不是对象`);
    const bvid = str(entry.bvid);
    if (!bvid) return invalid(`skipped[${idx}] 缺少 bvid`);
    const reason = SKIP_REASONS.includes(str(entry.reason) as SkipReason) ? (str(entry.reason) as SkipReason) : 'other';
    skipped.push({ bvid, reason, ...(str(entry.note) ? { note: clip(str(entry.note), 120) } : {}) });
  }

  const favorite = isObj(raw.favorite) && str(raw.favorite.bvid) ? { bvid: str(raw.favorite.bvid), reason: clip(str(raw.favorite.reason), 200) } : null;
  const dynamic = isObj(raw.dynamic) && str(raw.dynamic.text) ? { text: clip(str(raw.dynamic.text), 500) } : null;

  return {
    ok: true,
    data: {
      selected,
      skipped,
      favorite,
      dynamic,
      diary: { public: clip(diaryPublic, 6000), private: clip(diaryPrivate, 6000) },
      report_md: clip(str(raw.report_md), 20000),
      notify: clip(str(raw.notify).trim() || buildNotifyFallback(selected), 500),
      notes: clip(str(raw.notes), 1000),
    },
  };
}

function normalizeShare(raw: unknown, ctx: RoundContext): ShareProposal | null {
  if (!isObj(raw)) return null;
  const channel = str(raw.channel);
  if (channel !== 'comment' && channel !== 'dm') return null;
  if (!ctx.shareChannels.includes(channel)) return null;
  const text = clip(str(raw.text).trim(), ctx.shareMaxChars);
  if (!text) return null;
  return { channel, text, reason: clip(str(raw.reason), 200) };
}

function buildNotifyFallback(selected: SelectedItem[]): string {
  if (selected.length === 0) return '今天没挑出什么，日记照写了。';
  const first = selected[0];
  return first ? `今天挑中 ${selected.length} 条，最好的一条：${first.oneliner}` : '今天没挑出什么。';
}

/** 降级时用的最小结果（模型彻底不可用 / 输出修不好）。 */
export function fallbackRoundResult(input: { reason: string; skipped: SkippedItem[] }): RoundResult {
  return {
    selected: [],
    skipped: input.skipped,
    favorite: null,
    dynamic: null,
    diary: {
      public: `今天没看成。${input.reason}\n\n不是不想看，是真的没跑通 —— 我把原因留在报告里了，明天再试。`,
      private: `本轮失败：${input.reason}。\n\n偏好校准：这次没有新信息，不改判断。下次如果同一个原因再出现，应该先修它，而不是硬跑。`,
    },
    report_md: '',
    notify: `今天没跑通：${input.reason}`,
    notes: 'degraded：模型输出不可用，已用确定性模板收尾',
  };
}

/* ---------- 小工具 ---------- */

function invalid<T = never>(message: string): Result<T> {
  return { ok: false, error: { kind: 'parse', code: 'parse', message } };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
