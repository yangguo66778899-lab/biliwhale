/**
 * 调度循环（守护进程的心跳）。
 *
 * 职责：每 30 秒 tick 一次，把 scheduler 的决定落到状态与执行器上：
 *   - replanned → 写入今天的计划（日志里能看清明天的时刻）
 *   - fire      → 记一次唤醒，然后交给执行器（跳过槽位只写日记）
 *   - missed    → 标记错过并写事件（**不补发**昨天的计划）
 *   - 顺便做休眠检测：两次 tick 间隔 > 5 分钟说明机器睡过，记一条 resume 事件
 * 不做什么：不自己算时间（scheduler/tick 是纯函数），不碰 HTTP。
 */

import type { AppContext } from '../bootstrap.ts';
import type { RoundRunner } from './runner.ts';
import { cryptoRandom } from '../scheduler/random.ts';
import type { RandomSource } from '../scheduler/random.ts';
import { markSlot, tick } from '../scheduler/tick.ts';
import { HARD_WAKE_CAP } from '../scheduler/plan.ts';
import type { TickScheduleConfig } from '../scheduler/tick.ts';
import type { DayPlan } from '../scheduler/plan.ts';
import type { TodayPlan } from '../state/appState.ts';
import type { Config } from '../config/spec.ts';
import { humanError } from '../shared/errors.ts';
import { localIso, minuteOfDay } from '../shared/time.ts';

export interface SchedulerOptions {
  rand?: RandomSource;
  now?: () => Date;
  /** 两次 tick 间隔超过这个值就当机器休眠过。 */
  resumeGapMs?: number;
}

const DEFAULT_RESUME_GAP_MS = 5 * 60_000;

export class Scheduler {
  private readonly ctx: AppContext;
  private readonly runner: RoundRunner;
  private readonly opts: SchedulerOptions;
  private invalidateNext = false;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;

  constructor(ctx: AppContext, runner: RoundRunner, opts: SchedulerOptions = {}) {
    this.ctx = ctx;
    this.runner = runner;
    this.opts = opts;
  }

  /** 配置里的 schedule 变了 → 下一次 tick 重算（保留今天已醒次数）。 */
  invalidate(): void {
    this.invalidateNext = true;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** 跑一次 tick；任何异常都不外抛（定时器里最怕这个）。 */
  async tickOnce(): Promise<void> {
    try {
      await this.tickInner();
    } catch (err) {
      this.lastError = humanError(err);
      this.ctx.logger.error('scheduler', `tick 失败：${this.lastError}`);
      this.ctx.logger.event('tick-error', `调度 tick 失败：${this.lastError}`, { level: 'error', target: 'scheduler' });
    }
  }

  private async tickInner(): Promise<void> {
    const now = this.opts.now?.() ?? new Date();
    const cfg = this.ctx.config.get();
    const state = this.ctx.state.get();

    // 休眠/卡顿检测：间隔过大说明机器睡过，记一条事件
    const gap = this.lastTickAt === null ? 0 : now.getTime() - this.lastTickAt;
    if (this.opts.resumeGapMs !== undefined || DEFAULT_RESUME_GAP_MS) {
      const threshold = this.opts.resumeGapMs ?? DEFAULT_RESUME_GAP_MS;
      if (gap > threshold) {
        this.ctx.logger.event('resume', `两次 tick 间隔 ${Math.round(gap / 60000)} 分钟（可能刚休眠恢复）`, {
          level: 'info',
          target: 'scheduler',
        });
      }
    }

    const baseInput = {
      now,
      config: scheduleConfig(cfg),
      rand: this.opts.rand ?? cryptoRandom,
      paused: state.paused,
      lastFiredMinute: state.lastFiredMinute,
    } as const;

    let outcome = tick({
      ...baseInput,
      plan: state.today ? toDayPlan(state.today) : null,
      invalidate: this.invalidateNext,
      wakesAlready: state.today?.wakes ?? 0,
    });
    this.invalidateNext = false;

    // 刚生成/重算完计划时，可能某个时刻已经到点（开机、恢复、改配置）。
    // 不要干等下一次 tick：立刻再判一次，该补跑就补跑（文档 §7.2 休眠恢复的要求）。
    if (outcome.kind === 'replanned') {
      this.applyPlan(outcome.plan, outcome.generated);
      outcome = tick({ ...baseInput, plan: outcome.plan, invalidate: false });
    }

    switch (outcome.kind) {
      case 'none':
        break;

      case 'replanned': {
        // 只有在「第二次判定」不存在时才会走到这里
        this.applyPlan(outcome.plan, outcome.generated);
        break;
      }

      case 'fire': {
        // 兜底：计划里可能还有旧槽位，但今天已经醒满 3 次就绝不再跑（§2.5 硬约束）
        if ((state.today?.wakes ?? 0) >= HARD_WAKE_CAP) {
          this.ctx.state.savePlanSlots(outcome.plan.date, markSlot(outcome.plan, outcome.slot, 'missed').slots);
          this.ctx.logger.event('wake-skipped', `今天已醒 ${state.today?.wakes} 次（上限 ${HARD_WAKE_CAP}），到点也不再跑`, {
            target: 'scheduler',
          });
          break;
        }
        this.ctx.state.savePlanSlots(outcome.plan.date, outcome.plan.slots);
        this.ctx.state.noteWake(localIso(now), minuteOfDay(now));
        this.ctx.logger.info('scheduler', `到点：${outcome.slot.atText}（${outcome.slot.window}）`);
        this.ctx.logger.event('wake', `到点醒来 ${outcome.slot.atText}（${outcome.slot.window}）`, { target: 'scheduler' });
        await this.runner.runScheduled(outcome.slot);
        break;
      }

      case 'missed': {
        this.ctx.state.savePlanSlots(outcome.plan.date, outcome.plan.slots);
        this.ctx.logger.warn('scheduler', `错过 ${outcome.slot.atText}（超过宽限期 ${cfg.schedule.graceMinutes} 分钟），不补发`);
        this.ctx.logger.event('missed', `错过计划时刻 ${outcome.slot.atText}（超过宽限期），不补发`, {
          level: 'warn',
          target: 'scheduler',
        });
        break;
      }
    }

    this.lastTickAt = now.getTime();
  }

  /** 写入计划并记一条事件（新的���天 / 配置变更重算都走这里）。 */
  private applyPlan(plan: DayPlan, generated: boolean): void {
    this.ctx.state.applyPlan(plan);
    const slots = plan.slots.map((slot) => slot.atText).join('、');
    const what =
      plan.action === 'skip'
        ? `今天不想看，${slots || '（没有时刻）'} 醒来写日记`
        : `今天醒 ${plan.targetWakes} 次：${slots || '（不自动醒）'}`;
    this.ctx.logger.info('scheduler', `${what}${generated ? '' : '（配置变更，已重算）'}`);
    this.ctx.logger.event('plan', `${what}${generated ? '（新的一天）' : '（配置变更重算）'}`, { target: 'scheduler' });
  }
}

/** 状态里的计划 → 纯函数要的形状。 */
export function toDayPlan(today: TodayPlan): DayPlan {
  return {
    date: today.date,
    action: today.action,
    targetWakes: today.targetWakes,
    reason: today.reason,
    slots: today.slots,
  };
}

export function scheduleConfig(cfg: Config): TickScheduleConfig {
  return {
    windows: cfg.schedule.windows.map((window) => ({ ...window })),
    skipChance: cfg.schedule.skipChance,
    maxWakesPerDay: cfg.schedule.maxWakesPerDay,
    graceMinutes: cfg.schedule.graceMinutes,
  };
}
