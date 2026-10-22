/**
 * 调度心跳（每 30s 一次）。
 *
 * 职责：决定「现在该不该醒」。纯函数，时间/随机/计划全部注入，方便测试。
 *   - 跨天 → 重新生成计划（并把没触发的尾巴带过来）
 *   - 配置变更 → `invalidate` 强制重算，但**不抹掉今天已经醒过几次**
 *   - 到点且在宽限期内 → fire；过了宽限期 → missed（不补发昨天的）
 *   - 暂停 → 什么都不做
 *   - 同一分钟不重复触发
 * 不做什么：不执行一轮（守护进程拿到 fire 后调编排器）、不写文件。
 */

import type { DayPlan, GenerateInput, PlannedSlot, ScheduleWindow } from './plan.ts';
import { generateDayPlan } from './plan.ts';
import type { RandomSource } from './random.ts';
import { localDate, minuteOfDay } from '../shared/time.ts';

export interface TickScheduleConfig {
  windows: ScheduleWindow[];
  skipChance: number;
  maxWakesPerDay: number;
  graceMinutes: number;
}

export interface TickInput {
  now: Date;
  plan: DayPlan | null;
  config: TickScheduleConfig;
  rand: RandomSource;
  paused: boolean;
  /** 上一次触发发生在哪一分钟（一天中的分钟），用于「同一分钟不重复触发」。 */
  lastFiredMinute?: number | null;
  /** 配置变更后置 true，强制重算计划。 */
  invalidate?: boolean;
  /** 今天已经醒过几次（用于重算时扣额度；不传按 0 算）。 */
  wakesAlready?: number;
}

export type TickOutcome =
  | { kind: 'none'; reason?: string }
  | { kind: 'replanned'; plan: DayPlan; generated: boolean }
  | { kind: 'fire'; plan: DayPlan; slot: PlannedSlot }
  | { kind: 'missed'; plan: DayPlan; slot: PlannedSlot };

/** 只要还没触发、没错过的槽位。 */
export function pendingSlots(plan: DayPlan | null): PlannedSlot[] {
  if (!plan) return [];
  return plan.slots.filter((slot) => !slot.fired && !slot.missed);
}

export function tick(input: TickInput): TickOutcome {
  if (input.paused) return { kind: 'none', reason: '已暂停' };

  const nowMs = input.now.getTime();
  let plan = input.plan;

  const stale = plan === null || plan.date !== localDate(input.now);
  if (stale || input.invalidate) {
    const generated = generateDayPlan({
      now: input.now,
      windows: input.config.windows,
      skipChance: input.config.skipChance,
      maxWakesPerDay: input.config.maxWakesPerDay,
      rand: input.rand,
      // 跨天时把「昨天排的、还没到点」的槽位带过来（跨零点窗口的尾巴）；
      // 配置变更时**不带**：用户改了窗口，就该按新窗口重排，旧时刻作废。
      carryOver: stale ? carryOverSlots(plan, nowMs) : [],
      wakesAlready: input.wakesAlready ?? 0,
      graceMinutes: input.config.graceMinutes,
    } satisfies GenerateInput);
    if (!generated) return { kind: 'none', reason: '没有可用的作息窗口，只能手动跑' };
    return { kind: 'replanned', plan: generated, generated: stale };
  }

  if (input.lastFiredMinute != null && input.lastFiredMinute === minuteOfDay(input.now)) {
    return { kind: 'none', reason: '这一分钟已经醒过了' };
  }

  const pending = pendingSlots(plan);
  if (pending.length === 0) return { kind: 'none', reason: '今天的计划都跑完了' };

  const next = pending[0] as PlannedSlot;
  if (nowMs < next.atMs) return { kind: 'none' };

  const graceMs = input.config.graceMinutes * 60_000;
  const updated = markSlot(plan as DayPlan, next, nowMs > next.atMs + graceMs ? 'missed' : 'fired');
  if (nowMs > next.atMs + graceMs) {
    return { kind: 'missed', plan: updated, slot: next };
  }
  return { kind: 'fire', plan: updated, slot: next };
}

/** 把槽位标成已触发/已错过（返回新对象，不改入参）。 */
export function markSlot(plan: DayPlan, slot: PlannedSlot, as: 'fired' | 'missed'): DayPlan {
  return {
    ...plan,
    slots: plan.slots.map((item) => (item.atMs === slot.atMs && item.atText === slot.atText ? { ...item, fired: as === 'fired', missed: as === 'missed' } : item)),
  };
}

/** 还没到点的槽位（跨天时带进新计划）。 */
function carryOverSlots(plan: DayPlan | null, nowMs: number): PlannedSlot[] {
  return pendingSlots(plan).filter((slot) => slot.atMs > nowMs);
}

/** 计划里的人读摘要（状态接口/托盘/日志都用它）。 */
export function summarizePlan(plan: DayPlan | null, now: Date = new Date()): string {
  if (!plan) return '今天还没排计划';
  if (plan.action === 'skip') {
    const slot = plan.slots[0];
    return slot ? `今天不想看，${slot.atText} 醒来写日记` : '今天不想看';
  }
  const pending = pendingSlots(plan);
  if (pending.length === 0) return '今天的计划都跑完了';
  const next = pending[0] as PlannedSlot;
  const waitMin = Math.max(0, Math.round((next.atMs - now.getTime()) / 60_000));
  return `今天醒 ${plan.targetWakes} 次，下一次 ${next.atText}（约 ${waitMin} 分钟后）`;
}
