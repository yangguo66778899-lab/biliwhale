/**
 * 账本：判重（seen）、额度（quota）、反馈与沉默（feedback）。
 *
 * 职责：把「她做过什么」记成结构化数据，供闸门与报告使用；配额**只从账本算**，
 *   绝不从报告文本里数行数（参考项目的坑）。
 * 不做什么：不判断该不该发（闸门在 orchestrator/gate.ts），不写报告。
 */

import type { Logger } from '../shared/logger.ts';
import type { QuotaEntry, SeenEntry } from '../shared/types.ts';
import { localIso } from '../shared/time.ts';
import { JsonStore } from './store.ts';

/* ---------- 判重 ---------- */

export interface SeenFile {
  version: number;
  videos: Record<string, SeenEntry>;
}

export class SeenLedger {
  private readonly store: JsonStore<SeenFile>;

  private constructor(store: JsonStore<SeenFile>) {
    this.store = store;
  }

  static open(file: string, logger: Logger): SeenLedger {
    return new SeenLedger(new JsonStore<SeenFile>(file, () => ({ version: 1, videos: {} }), logger, 'seen'));
  }

  get(bvid: string): SeenEntry | undefined {
    return this.store.get().videos[bvid];
  }

  /** 最近 `days` 天内是否已看过（选题去重用）。 */
  seenWithin(bvid: string, days: number, now: Date = new Date()): boolean {
    const entry = this.get(bvid);
    if (!entry) return false;
    const last = Date.parse(entry.lastSeen);
    if (!Number.isFinite(last)) return true;
    return now.getTime() - last <= days * 86_400_000;
  }

  record(input: {
    bvid: string;
    title: string;
    decision: SeenEntry['lastDecision'];
    reason: string;
    now?: Date;
  }): void {
    const now = localIso(input.now ?? new Date());
    this.store.update((current) => {
      const prev = current.videos[input.bvid];
      const next: SeenEntry = {
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
        times: (prev?.times ?? 0) + 1,
        lastDecision: input.decision,
        lastReason: input.reason,
        title: input.title,
      };
      return { version: 1, videos: { ...current.videos, [input.bvid]: next } };
    });
  }

  /** 清掉太久没出现的条目（账本不能无限长）。 */
  prune(keepDays: number, now: Date = new Date()): number {
    let removed = 0;
    this.store.update((current) => {
      const cutoff = now.getTime() - keepDays * 86_400_000;
      const videos: Record<string, SeenEntry> = {};
      for (const [bvid, entry] of Object.entries(current.videos)) {
        const last = Date.parse(entry.lastSeen);
        if (Number.isFinite(last) && last < cutoff) removed += 1;
        else videos[bvid] = entry;
      }
      return { version: 1, videos };
    });
    return removed;
  }

  size(): number {
    return Object.keys(this.store.get().videos).length;
  }

  /** 给 prompt 用：最近看过的 BV 摘要（不要全文）。 */
  recentTitles(limit: number, now: Date = new Date()): Array<{ bvid: string; title: string; decision: string; ageDays: number }> {
    return Object.entries(this.store.get().videos)
      .map(([bvid, entry]) => ({
        bvid,
        title: entry.title,
        decision: entry.lastDecision,
        ageDays: Math.floor((now.getTime() - Date.parse(entry.lastSeen)) / 86_400_000),
      }))
      .filter((x) => Number.isFinite(x.ageDays))
      .sort((a, b) => a.ageDays - b.ageDays)
      .slice(0, limit);
  }
}

/* ---------- 额度 ---------- */

export interface QuotaFile {
  version: number;
  /** 每天分享上限的镜像值：只是为了人读账本时一眼看到当天政策。 */
  shareDaily: number;
  log: QuotaEntry[];
}

export const SHARE_TYPES: ReadonlyArray<QuotaEntry['type']> = ['comment', 'dm'];

export class QuotaLedger {
  private readonly store: JsonStore<QuotaFile>;

  private constructor(store: JsonStore<QuotaFile>) {
    this.store = store;
  }

  static open(file: string, logger: Logger): QuotaLedger {
    return new QuotaLedger(new JsonStore<QuotaFile>(file, () => ({ version: 1, shareDaily: 3, log: [] }), logger, 'quota'));
  }

  add(entry: QuotaEntry): void {
    this.store.update((current) => ({ ...current, log: [...current.log, entry] }));
  }

  entries(): QuotaEntry[] {
    return this.store.get().log;
  }

  /** 某个本地日期已经用掉的分享额度（只算真正发出去的，dry_run 不算）。 */
  sharesOn(dateLocal: string, type: 'all' | 'dm' = 'all'): number {
    return this.store
      .get()
      .log.filter(
        (e) =>
          e.at.slice(0, 10) === dateLocal &&
          e.share &&
          (e.status === 'sent' || e.status === 'held') &&
          SHARE_TYPES.includes(e.type) &&
          (type === 'all' || e.type === 'dm'),
      ).length;
  }

  /** 某类操作在某个本地日期的次数（收藏/点赞/动态各自的日上限用）。 */
  countOn(dateLocal: string, type: QuotaEntry['type']): number {
    return this.store.get().log.filter((e) => e.at.slice(0, 10) === dateLocal && e.type === type && e.status !== 'failed').length;
  }

  lastSentAt(bvid: string, type: 'all' | 'share' = 'share'): string | null {
    const matched = this.store
      .get()
      .log.filter(
        (e) =>
          e.bvid === bvid &&
          (e.status === 'sent' || e.status === 'held') &&
          (type === 'all' ? true : e.share && SHARE_TYPES.includes(e.type)),
      )
      .sort((a, b) => b.at.localeCompare(a.at));
    return matched[0]?.at ?? null;
  }

  /**
   * 丢掉内存缓存、从磁盘重读。
   * 用途：CLI 另起进程发过评论后，守护进程里的账本还是旧的，扫描回复会「看不见那条评论」。
   */
  reload(): void {
    this.store.read();
  }

  /** 幂等键查重：同样内容成功发过就不许再发。 */
  hasSentContent(key: string): boolean {
    // held 也算已发：评论真实存在（只是公开区看不到），不能再发一遍
    return this.store.get().log.some((e) => (e.status === 'sent' || e.status === 'held') && e.note === key);
  }

  prune(beforeIso: string): number {
    let removed = 0;
    this.store.update((current) => {
      const log = current.log.filter((e) => {
        const keep = e.at >= beforeIso;
        if (!keep) removed += 1;
        return keep;
      });
      return { ...current, log };
    });
    return removed;
  }
}

/* ---------- 反馈与沉默 ---------- */

export interface FeedbackFile {
  version: number;
  /** 用户最后一次表态（点赞/回复/私信）。 */
  lastUserSignalAt: string | null;
  /** 我们最后一次分享。用户从没表态过时，沉默天数从这里算。 */
  lastShareAt: string | null;
  /** 已经问过「在忙吗」的次数，只问一次。 */
  askedOnce: boolean;
  notes: string[];
}

export class FeedbackLedger {
  private readonly store: JsonStore<FeedbackFile>;

  private constructor(store: JsonStore<FeedbackFile>) {
    this.store = store;
  }

  static open(file: string, logger: Logger): FeedbackLedger {
    return new FeedbackLedger(
      new JsonStore<FeedbackFile>(
        file,
        () => ({ version: 1, lastUserSignalAt: null, lastShareAt: null, askedOnce: false, notes: [] }),
        logger,
        'feedback',
      ),
    );
  }

  get(): FeedbackFile {
    return this.store.get();
  }

  markUserSignal(at: Date = new Date()): void {
    this.store.update((current) => ({ ...current, lastUserSignalAt: localIso(at) }));
  }

  markShare(at: Date = new Date()): void {
    this.store.update((current) => ({ ...current, lastShareAt: localIso(at) }));
  }

  markAsked(): void {
    this.store.update((current) => ({ ...current, askedOnce: true }));
  }

  /** 沉默天数：先看用户表态，没有就看我们上次分享；都没有 → null（从没开始）。 */
  silenceDays(now: Date = new Date()): number | null {
    const cur = this.store.get();
    const ref = cur.lastUserSignalAt ?? cur.lastShareAt;
    if (!ref) return null;
    const t = Date.parse(ref);
    if (!Number.isFinite(t)) return null;
    return Math.floor((now.getTime() - t) / 86_400_000);
  }
}

/* ---------- 沉默档位（纯函数，方便测试） ---------- */

export type SilenceBand = 'normal' | 'quiet' | 'silent';

export interface SilenceDecision {
  band: SilenceBand;
  /** 今天允许分享几条。 */
  shareCap: number;
  /** 是否该主动问一句「在忙吗」（只问一次，由调用方记状态）。 */
  askOnce: boolean;
  /** 给人看的一句话。 */
  text: string;
}

export function decideSilence(
  days: number | null,
  cfg: { dailyCap: number; silentAfterDays: number; silentStopDays: number },
): SilenceDecision {
  if (days == null) {
    return { band: 'normal', shareCap: cfg.dailyCap, askOnce: false, text: '还没开始分享过' };
  }
  if (days < cfg.silentAfterDays) {
    return { band: 'normal', shareCap: cfg.dailyCap, askOnce: false, text: `正常（用户 ${days} 天前有表态）` };
  }
  if (days < cfg.silentStopDays) {
    return {
      band: 'quiet',
      shareCap: Math.min(1, cfg.dailyCap),
      askOnce: true,
      text: `收声中（${days} 天没回应，额度降到 1 条/天）`,
    };
  }
  return { band: 'silent', shareCap: 0, askOnce: false, text: `已静默（${days} 天没回应，不分享，日记照写）` };
}
