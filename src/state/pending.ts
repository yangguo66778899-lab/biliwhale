/**
 * 待审的回复草稿（`pending/replies.json`）。
 *
 * 职责：陌生人回复我们的评论时，先落成草稿，等用户在面板/托盘决定「发 / 不发」。
 *   - 状态机：pending → sent | rejected | expired | failed
 *   - 过期：默认 7 天，过期自动作废（记事件，不悄悄删）
 *   - 去重：同一 (root, parent) 只生成一次草稿，避免重复催办
 * 不做什么：不发请求、不写日记（由编排器与审批执行器负责）。
 */

import type { Logger } from '../shared/logger.ts';
import type { PendingReply } from '../shared/types.ts';
import { JsonStore } from './store.ts';
import { localIso } from '../shared/time.ts';

export interface PendingFile {
  version: number;
  items: PendingReply[];
}

export const PENDING_TTL_DAYS = 7;

export class PendingStore {
  private readonly store: JsonStore<PendingFile>;
  private readonly logger: Logger;

  private constructor(store: JsonStore<PendingFile>, logger: Logger) {
    this.store = store;
    this.logger = logger;
  }

  static open(file: string, logger: Logger): PendingStore {
    return new PendingStore(new JsonStore<PendingFile>(file, () => ({ version: 1, items: [] }), logger, 'pending'), logger);
  }

  all(): PendingReply[] {
    return this.store.get().items;
  }

  /** 待办（按创建时间正序：先来先处理）。 */
  pending(now: Date = new Date()): PendingReply[] {
    this.expire(now);
    return this.store
      .get()
      .items.filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  count(now: Date = new Date()): number {
    return this.pending(now).length;
  }

  byId(id: string): PendingReply | null {
    return this.store.get().items.find((item) => item.id === id) ?? null;
  }

  /** 同一个 (root, parent) 是否已经有过草稿（含已处理的），避免重复生成。 */
  has(source: { root: string; parent: string }): boolean {
    return this.store.get().items.some((item) => item.root === source.root && item.parent === source.parent);
  }

  add(item: PendingReply): PendingReply {
    this.store.update((current) => ({ ...current, items: [...current.items, item] }));
    this.logger.info('pending', `新增待审草稿 ${item.id}（${item.target.uname} 在 ${item.bvid} 回复了我们）`);
    return item;
  }

  update(id: string, patch: Partial<PendingReply>): PendingReply | null {
    let updated: PendingReply | null = null;
    this.store.update((current) => ({
      ...current,
      items: current.items.map((item) => {
        if (item.id !== id) return item;
        updated = { ...item, ...patch };
        return updated;
      }),
    }));
    return updated;
  }

  /** 标记发出（带 rpid）或失败。 */
  markSent(id: string, rpid: string, at: string): PendingReply | null {
    return this.update(id, { status: 'sent', rpid, decidedAt: at });
  }

  markFailed(id: string, note: string, at: string): PendingReply | null {
    return this.update(id, { status: 'failed', note, decidedAt: at });
  }

  reject(id: string, reason: string, at: string): PendingReply | null {
    return this.update(id, { status: 'rejected', note: reason, decidedAt: at });
  }

  /** 过期处理：返回本次过期的条数。 */
  expire(now: Date = new Date()): number {
    const nowIso = localIso(now);
    let expired = 0;
    this.store.update((current) => {
      let changed = false;
      const items = current.items.map((item) => {
        if (item.status !== 'pending') return item;
        const deadline = Date.parse(item.expiresAt);
        if (!Number.isFinite(deadline) || deadline > now.getTime()) return item;
        changed = true;
        expired += 1;
        return { ...item, status: 'expired' as const, decidedAt: nowIso, note: item.note ?? '超时自动作废' };
      });
      return changed ? { ...current, items } : undefined;
    });
    if (expired > 0) this.logger.info('pending', `${expired} 条待审草稿超时作废`);
    return expired;
  }
}

/** 生成一个短 id（时间 + 随机后缀，可读且不撞）。 */
export function newPendingId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

/** 过期时间 = 现在 + 7 天。 */
export function expiresAt(now: Date = new Date(), days = PENDING_TTL_DAYS): string {
  return localIso(new Date(now.getTime() + days * 86_400_000));
}
