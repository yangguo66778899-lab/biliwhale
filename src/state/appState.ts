/**
 * 主状态文件（state.json）。
 *
 * 职责：跨轮要记住的少量事实——今天的计划、模型发现缓存、预算计数器、监听游标、连续失败数。
 *   记忆不靠对话历史，只靠这个文件 + 日记 + 账本。
 * 不做什么：不存配置（config.json）、不存凭据（secrets.json）。
 */

import type { Logger } from '../shared/logger.ts';
import { localDate } from '../shared/time.ts';
import type { DayPlan, PlannedSlot } from '../scheduler/plan.ts';
import { JsonStore } from './store.ts';

/** 今天的作息计划（scheduler/plan 的持久化形态）。 */
export interface TodayPlan {
  date: string;
  action: 'wake' | 'skip';
  /** 今天计划醒几次（skip 固定 1）。 */
  targetWakes: number;
  /** 今天已经醒了几次（改配置不能把它抹掉）。 */
  wakes: number;
  woke: boolean;
  done: boolean;
  reason: string | null;
  /** 计划里的全部时刻；跨零点窗口的后半夜槽位落在下一天。 */
  slots: PlannedSlot[];
}

export interface ModelCache {
  name: string;
  discoveredAt: string;
  /** key 的短指纹，用来判断「换了 key 要重新发现」，永不存 key 本身。 */
  keyFingerprint: string;
}

export interface BudgetCounter {
  date: string;
  tokens: number;
  costCny: number;
  calls: number;
}

export interface AppStateFile {
  version: number;
  today: TodayPlan | null;
  modelCache: ModelCache | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  /** 手动暂停自动唤醒（手动跑一轮不受影响）。 */
  paused: boolean;
  pausedAt: string | null;
  /** 上一次自动触发发生在哪一分钟（一天中的分钟），用于「同一分钟不重复触发」。 */
  lastFiredMinute: number | null;
  lastFireAt: string | null;
  budget: BudgetCounter;
  cursors: {
    lastCommentSeenAt: string | null;
    lastDmSeenAt: string | null;
  };
  counters: {
    consecutiveFailures: number;
    totalRuns: number;
  };
  riskCooldownUntil: string | null;
}

export function emptyState(): AppStateFile {
  return {
    version: 1,
    today: null,
    modelCache: null,
    lastRunAt: null,
    lastRunStatus: null,
    paused: false,
    pausedAt: null,
    lastFiredMinute: null,
    lastFireAt: null,
    budget: { date: localDate(), tokens: 0, costCny: 0, calls: 0 },
    cursors: { lastCommentSeenAt: null, lastDmSeenAt: null },
    counters: { consecutiveFailures: 0, totalRuns: 0 },
    riskCooldownUntil: null,
  };
}

export class AppStateStore {
  private readonly store: JsonStore<AppStateFile>;

  constructor(file: string, logger: Logger) {
    this.store = new JsonStore<AppStateFile>(file, emptyState, logger, 'state');
  }

  get(): AppStateFile {
    const state = this.normalize(this.store.get());
    // 跨天重置预算计数（读的时候顺手做，避免各处都要记得调）
    const today = localDate();
    if (state.budget.date !== today) {
      const reset: AppStateFile = { ...state, budget: { date: today, tokens: 0, costCny: 0, calls: 0 } };
      this.store.write(reset);
      return reset;
    }
    return state;
  }

  /**
   * 把可能不完整的 state.json 补齐。
   * 手改过、旧版本、或者写了一半的文件都不该让守护进程起不来（文档要求「坏文件不能让程序起不来」）。
   */
  private normalize(raw: AppStateFile): AppStateFile {
    const base = emptyState();
    const state = (raw ?? {}) as Partial<AppStateFile>;
    return {
      ...base,
      ...state,
      version: typeof state.version === 'number' ? state.version : base.version,
      today: state.today ?? null,
      modelCache: state.modelCache ?? null,
      lastRunAt: state.lastRunAt ?? null,
      lastRunStatus: state.lastRunStatus ?? null,
      paused: Boolean(state.paused),
      pausedAt: state.pausedAt ?? null,
      lastFiredMinute: typeof state.lastFiredMinute === 'number' ? state.lastFiredMinute : null,
      lastFireAt: state.lastFireAt ?? null,
      budget: { ...base.budget, ...(state.budget ?? {}) },
      cursors: { ...base.cursors, ...(state.cursors ?? {}) },
      counters: { ...base.counters, ...(state.counters ?? {}) },
      riskCooldownUntil: state.riskCooldownUntil ?? null,
    };
  }

  update(fn: (current: AppStateFile) => AppStateFile | undefined): AppStateFile {
    return this.store.update((current) => fn(this.normalize(current)));
  }

  addUsage(input: { promptTokens: number; completionTokens: number; costCny: number; calls?: number }): void {
    this.update((state) => {
      const today = localDate();
      const base = state.budget.date === today ? state.budget : { date: today, tokens: 0, costCny: 0, calls: 0 };
      return {
        ...state,
        budget: {
          date: today,
          tokens: base.tokens + input.promptTokens + input.completionTokens,
          costCny: Math.round((base.costCny + input.costCny) * 1e6) / 1e6,
          calls: base.calls + (input.calls ?? 1),
        },
      };
    });
  }

  noteRun(status: AppStateFile['lastRunStatus'], atIso: string): void {
    this.update((state) => {
      const failures = status === 'failed' || status === 'interrupted' ? state.counters.consecutiveFailures + 1 : 0;
      return {
        ...state,
        lastRunAt: atIso,
        lastRunStatus: status,
        counters: { consecutiveFailures: failures, totalRuns: state.counters.totalRuns + 1 },
      };
    });
  }

  setModelCache(cache: ModelCache): void {
    this.update((state) => ({ ...state, modelCache: cache }));
  }

  /** 监听游标：「评论/@」与「私信」各自一条，首次运行只建基线、不倒历史。 */
  lastCommentSeenAt(): string | null {
    return this.store.get().cursors?.lastCommentSeenAt ?? null;
  }

  lastDmSeenAt(): string | null {
    return this.store.get().cursors?.lastDmSeenAt ?? null;
  }

  setCommentSeenAt(atIso: string | null): void {
    this.update((state) => ({ ...state, cursors: { ...state.cursors, lastCommentSeenAt: atIso } }));
  }

  setDmSeenAt(atIso: string | null): void {
    this.update((state) => ({ ...state, cursors: { ...state.cursors, lastDmSeenAt: atIso } }));
  }

  setRiskCooldown(untilIso: string | null): void {
    this.update((state) => ({ ...state, riskCooldownUntil: untilIso }));
  }

  inRiskCooldown(now: Date = new Date()): boolean {
    const until = this.store.get().riskCooldownUntil;
    if (!until) return false;
    return Date.parse(until) > now.getTime();
  }

  /* ---------- 作息计划 ---------- */

  /**
   * 把 scheduler 生成的计划写进状态。
   * 同一天重算时保留「今天已经醒过几次」——改配置不能把它抹掉。
   */
  applyPlan(plan: DayPlan): TodayPlan {
    const current = this.store.get();
    const sameDay = current.today?.date === plan.date;
    const next: TodayPlan = {
      date: plan.date,
      action: plan.action,
      targetWakes: plan.targetWakes,
      wakes: sameDay ? (current.today?.wakes ?? 0) : 0,
      woke: sameDay ? (current.today?.woke ?? false) : false,
      done: plan.slots.length === 0,
      reason: plan.reason,
      slots: plan.slots,
    };
    this.store.update((state) => ({ ...state, today: next }));
    return next;
  }

  /** 收到 fire/missed 之后回写槽位状态。 */
  savePlanSlots(date: string, slots: PlannedSlot[]): void {
    this.store.update((state) => {
      if (!state.today || state.today.date !== date) return undefined;
      const pending = slots.filter((slot) => !slot.fired && !slot.missed);
      return { ...state, today: { ...state.today, slots, done: pending.length === 0 } };
    });
  }

  /** 记一次自动唤醒（wakes/time 都前进）。 */
  noteWake(atIso: string, minute: number): void {
    this.store.update((state) => {
      const firedToday = state.today;
      const nextToday = firedToday
        ? { ...firedToday, wakes: firedToday.wakes + 1, woke: true }
        : null;
      return { ...state, today: nextToday, lastFireAt: atIso, lastFiredMinute: minute };
    });
  }

  setPaused(paused: boolean, atIso: string): void {
    this.store.update((state) => ({ ...state, paused, pausedAt: paused ? atIso : null }));
  }

  isPaused(): boolean {
    return this.store.get().paused;
  }

  /** 下一次到点的时间（毫秒）；没有就 null。健康接口与托盘都用它。 */
  nextWakeAtMs(now: Date = new Date()): number | null {
    const slots = this.store.get().today?.slots ?? [];
    const pending = slots.filter((slot) => !slot.fired && !slot.missed).sort((a, b) => a.atMs - b.atMs);
    const next = pending[0];
    if (!next) return null;
    void now;
    return next.atMs;
  }

  /** 清除过期的「上次触发分钟」（跨天时用）。 */
  resetFireMinute(): void {
    this.store.update((state) => ({ ...state, lastFiredMinute: null }));
  }
}
