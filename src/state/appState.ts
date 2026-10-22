/**
 * 主状态文件（state.json）。
 *
 * 职责：跨轮要记住的少量事实——今天的计划、模型发现缓存、预算计数器、监听游标、连续失败数。
 *   记忆不靠对话历史，只靠这个文件 + 日记 + 账本。
 * 不做什么：不存配置（config.json）、不存凭据（secrets.json）。
 */

import type { Logger } from '../shared/logger.ts';
import { localDate } from '../shared/time.ts';
import { JsonStore } from './store.ts';

export interface TodayPlan {
  date: string;
  action: 'wake' | 'skip';
  /** 一天中的分钟数（跨零点窗口也安全）。 */
  atMinute: number;
  atText: string;
  window: string;
  fired: boolean;
  woke: boolean;
  wakes: number;
  targetWakes: number;
  done: boolean;
  reason: string | null;
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
    const state = this.store.get();
    // 跨天重置预算计数（读的时候顺手做，避免各处都要记得调）
    const today = localDate();
    if (state.budget.date !== today) {
      const reset: AppStateFile = { ...state, budget: { date: today, tokens: 0, costCny: 0, calls: 0 } };
      this.store.write(reset);
      return reset;
    }
    return state;
  }

  update(fn: (current: AppStateFile) => AppStateFile | undefined): AppStateFile {
    return this.store.update(fn);
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

  setRiskCooldown(untilIso: string | null): void {
    this.update((state) => ({ ...state, riskCooldownUntil: untilIso }));
  }

  inRiskCooldown(now: Date = new Date()): boolean {
    const until = this.store.get().riskCooldownUntil;
    if (!until) return false;
    return Date.parse(until) > now.getTime();
  }
}
