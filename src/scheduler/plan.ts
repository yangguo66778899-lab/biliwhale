/**
 * 今日计划生成（生物钟）。
 *
 * 职责：按窗口与「今天不想看」的概率，算出今天要在哪几个时刻醒来。
 *   - 每个窗口按 `wakes` 取随机时刻（分钟精度，避开端点，互相至少隔 30 分钟）；
 *   - 总次数不超过 `maxWakesPerDay`，且**代码强制**每天最多 3 次（不靠配置自觉）；
 *   - 支持跨零点窗口：`22:00–02:00` 的后半夜时刻会落在**下一天**，用绝对时间戳表示；
 *   - 跨天时可以把昨天没触发的槽位「带过来」，否则 00:30 这种尾巴会被新计划冲掉；
 *   - 「今天不想看」命中时只排一次「醒来写日记」，不取候选、不分享。
 * 不做什么：不判到没到点（tick 负责）、不落盘、不调模型。
 */

import type { RandomSource } from './random.ts';
import { formatHhmm, localDate, parseHhmm } from '../shared/time.ts';

export interface ScheduleWindow {
  start: string;
  end: string;
  wakes: number;
  label: string;
}

export interface PlannedSlot {
  /** 绝对时间戳（毫秒）。跨零点窗口的后半夜槽位会落在下一天。 */
  atMs: number;
  /** `HH:mm`，给人看。 */
  atText: string;
  /** 所属窗口，如 `20:00–24:00`。 */
  window: string;
  kind: 'wake' | 'skip';
  fired: boolean;
  missed: boolean;
}

export interface DayPlan {
  /** 计划生成时所属的本地日。 */
  date: string;
  action: 'wake' | 'skip';
  /** 今天计划醒几次（skip 固定 1）。 */
  targetWakes: number;
  reason: string | null;
  slots: PlannedSlot[];
}

export interface GenerateInput {
  now: Date;
  windows: ScheduleWindow[];
  skipChance: number;
  maxWakesPerDay: number;
  rand: RandomSource;
  /** 上一天剩下的、还没触发的槽位（跨零点的尾巴）。 */
  carryOver?: PlannedSlot[];
  /** 宽限期（分钟）：槽位过了这个时间才算「错过」；宽限期内仍可触发。 */
  graceMinutes?: number;
  /**
   * 今天**已经醒过**几次（重算计划时要扣掉）。
   * 审计 §2.5：不扣就会「每改一次配置 / 每暂停恢复一次，就白送一轮」，实测一天 5 次。
   */
  wakesAlready?: number;
}

/** 每次醒来之间至少隔这么久（分钟）。 */
export const MIN_GAP_MINUTES = 30;
/** 每天最多醒几次：代码硬上限。 */
export const HARD_WAKE_CAP = 3;

/** 计划所依据的那一天 00:00 的时间戳。 */
export function dayStartMs(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
}

/** 窗口 → [from, to) 的分钟区间；`end <= start` 视为跨零点。 */
export function windowRange(window: ScheduleWindow): { from: number; to: number } {
  const from = parseHhmm(window.start) ?? 0;
  const rawTo = parseHhmm(window.end) ?? from + 60;
  const to = rawTo > from ? rawTo : rawTo + 1440;
  return { from, to };
}

export function windowLabel(window: ScheduleWindow): string {
  return `${window.start}–${window.end}${window.label ? `（${window.label}）` : ''}`;
}

function slotAt(baseMs: number, minutes: number, window: ScheduleWindow, kind: PlannedSlot['kind']): PlannedSlot {
  return {
    atMs: baseMs + minutes * 60_000,
    atText: formatHhmm(minutes % 1440),
    window: windowLabel(window),
    kind,
    fired: false,
    missed: false,
  };
}

/**
 * 生成今天的计划。没有可用窗口时返回 null（只能手动跑）。
 */
export function generateDayPlan(input: GenerateInput): DayPlan | null {
  const usable = input.windows.filter((w) => w.wakes > 0);
  if (usable.length === 0) return null;

  const baseMs = dayStartMs(input.now);
  const date = localDate(input.now);
  const carry = (input.carryOver ?? []).filter((slot) => !slot.fired && !slot.missed);
  // 今天已经醒过几次，就把额度扣掉多少（硬上限不因重算而重置）
  const wakesAlready = Math.max(0, Math.floor(input.wakesAlready ?? 0));
  const cap = input.maxWakesPerDay <= 0 ? 0 : Math.min(input.maxWakesPerDay, HARD_WAKE_CAP);
  const remainingCap = Math.max(0, cap - wakesAlready);

  // 掷「今天不想看」——但额度用完就不再排任何槽位（否则 skip 会绕过硬上限，审计 §3.29）
  if (remainingCap > 0 && input.rand.float() < input.skipChance) {
    const window = usable[0] as ScheduleWindow;
    const { from, to } = windowRange(window);
    const at = randomMinute(from, to, input.rand);
    const slot = slotAt(baseMs, at, window, 'skip');
    // 过了宽限期才算过期；宽限期内仍然可以触发（用户 2026-10-22：过了就不补）
    if (isExpired(slot.atMs, input)) {
      return { date, action: 'skip', targetWakes: 0, reason: '今天的时间都过了，不补跑', slots: [...carry] };
    }
    return {
      date,
      action: 'skip',
      targetWakes: 1,
      reason: '今天不想看（掷骰命中）',
      slots: [...carry, slot].sort((a, b) => a.atMs - b.atMs),
    };
  }

  if (cap === 0) {
    return { date, action: 'wake', targetWakes: 0, reason: '每天唤醒次数设为 0：只能手动跑', slots: [...carry] };
  }
  if (remainingCap === 0) {
    return {
      date,
      action: 'wake',
      targetWakes: wakesAlready,
      reason: `今天已经醒过 ${wakesAlready} 次（上限 ${cap}），不再自动醒`,
      slots: [...carry],
    };
  }

  const slots: PlannedSlot[] = [...carry];
  // 已醒次数 + 跨零点带过来的槽位，都要从额度里扣
  let remaining = Math.max(0, remainingCap - carry.length);

  for (const window of usable) {
    for (let i = 0; i < window.wakes && remaining > 0; i += 1) {
      const { from, to } = windowRange(window);
      // 与已有槽位至少隔 MIN_GAP_MINUTES；最多试 20 次，实在挤不下就少醒一次
      let placed: PlannedSlot | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = slotAt(baseMs, randomMinute(from, to, input.rand), window, 'wake');
        if (slots.every((slot) => Math.abs(slot.atMs - candidate.atMs) >= MIN_GAP_MINUTES * 60_000)) {
          placed = candidate;
          break;
        }
      }
      if (!placed) continue;
      slots.push(placed);
      remaining -= 1;
    }
  }

  // 已经过期（超过宽限期）的时刻不排进计划（审计 §3.28 / 用户口径：过了不补，但当天剩余窗口照常醒）
  const future = slots.filter((slot) => !isExpired(slot.atMs, input));
  const dropped = slots.length - future.length;
  return {
    date,
    action: 'wake',
    targetWakes: future.length,
    reason:
      future.length === 0 && dropped > 0
        ? `今天的窗口都过了（${dropped} 个时刻作废，不补跑）`
        : dropped > 0
          ? `有 ${dropped} 个时刻已经过去，不补跑`
          : null,
    slots: future.sort((a, b) => a.atMs - b.atMs),
  };
}

/** 槽位是否已经「过期」（超过宽限期，不再补）。 */
function isExpired(atMs: number, input: GenerateInput): boolean {
  const graceMs = Math.max(0, input.graceMinutes ?? 0) * 60_000;
  return atMs + graceMs <= input.now.getTime();
}

/** 在 [from, to) 里取一分钟，避开两端各一分钟。 */
function randomMinute(from: number, to: number, rand: RandomSource): number {
  const low = from + 1;
  const high = to - 2;
  if (high <= low) return Math.max(0, from);
  return rand.int(low, high);
}

/** 人读的下一次唤醒描述：`20:30（今晚）` / `01:30（明天）`。 */
export function describeSlot(slot: PlannedSlot, now: Date = new Date()): string {
  const slotDate = localDate(new Date(slot.atMs));
  const today = localDate(now);
  const day = slotDate === today ? '今天' : slotDate > today ? '明天' : slotDate;
  return `${slot.atText}（${day}）`;
}
