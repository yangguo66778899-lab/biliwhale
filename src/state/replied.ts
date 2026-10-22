/**
 * 「谁回过我们」账本（`replied.json`）。
 *
 * 职责：记住每个回复过我们的用户：回过几次、最近一次什么时候、在哪条视频。
 *   用途：① 同一个人不重复催办；② 面板与报告里能说「这几条是 XX 回的」；
 *   ③ 以后（M4）判断「要不要跟这个人继续聊」的素材。
 * 不做什么：不存对方 cookie/隐私；只存公开的 mid、昵称、时间、bvid。
 */

import type { Logger } from '../shared/logger.ts';
import { JsonStore } from './store.ts';

export interface RepliedEntry {
  mid: number;
  uname: string;
  times: number;
  firstAt: string;
  lastAt: string;
  lastBvid: string;
}

export interface RepliedFile {
  version: number;
  users: Record<string, RepliedEntry>;
}

export class RepliedLedger {
  private readonly store: JsonStore<RepliedFile>;

  private constructor(store: JsonStore<RepliedFile>) {
    this.store = store;
  }

  static open(file: string, logger: Logger): RepliedLedger {
    return new RepliedLedger(new JsonStore<RepliedFile>(file, () => ({ version: 1, users: {} }), logger, 'replied'));
  }

  note(input: { mid: number; uname: string; bvid: string; at: string }): RepliedEntry {
    let entry: RepliedEntry | null = null;
    this.store.update((current) => {
      const key = String(input.mid);
      const existing = current.users[key];
      entry = existing
        ? { ...existing, uname: input.uname || existing.uname, times: existing.times + 1, lastAt: input.at, lastBvid: input.bvid }
        : { mid: input.mid, uname: input.uname, times: 1, firstAt: input.at, lastAt: input.at, lastBvid: input.bvid };
      return { ...current, users: { ...current.users, [key]: entry } };
    });
    return entry as unknown as RepliedEntry;
  }

  get(mid: number): RepliedEntry | null {
    return this.store.get().users[String(mid)] ?? null;
  }

  all(): RepliedEntry[] {
    return Object.values(this.store.get().users).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /** 回过几次（0 = 没回过）。 */
  times(mid: number): number {
    return this.get(mid)?.times ?? 0;
  }
}
