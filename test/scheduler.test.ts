import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cryptoRandom, scriptedRandom } from '../src/scheduler/random.ts';
import { HARD_WAKE_CAP, MIN_GAP_MINUTES, dayStartMs, describeSlot, generateDayPlan, windowRange } from '../src/scheduler/plan.ts';
import type { DayPlan, ScheduleWindow } from '../src/scheduler/plan.ts';
import { markSlot, pendingSlots, summarizePlan, tick } from '../src/scheduler/tick.ts';
import type { TickScheduleConfig } from '../src/scheduler/tick.ts';
import { formatHhmm, localDate } from '../src/shared/time.ts';

const evening: ScheduleWindow = { start: '20:00', end: '24:00', wakes: 1, label: '晚上' };
const noon: ScheduleWindow = { start: '12:00', end: '14:00', wakes: 1, label: '中午' };
const lateNight: ScheduleWindow = { start: '22:00', end: '02:00', wakes: 1, label: '跨零点' };

function config(over: Partial<TickScheduleConfig> = {}): TickScheduleConfig {
  return { windows: [evening], skipChance: 0, maxWakesPerDay: 1, graceMinutes: 90, ...over };
}

function at(day: string, hhmm: string): Date {
  const [y, mo, d] = day.split('-').map((v) => Number(v)) as [number, number, number];
  const [h, m] = hhmm.split(':').map((v) => Number(v)) as [number, number];
  return new Date(y, mo - 1, d, h, m, 0, 0);
}

test('窗口区间：普通窗口与跨零点窗口', () => {
  assert.deepEqual(windowRange({ start: '20:00', end: '24:00', wakes: 1, label: '' }), { from: 1200, to: 1440 });
  assert.deepEqual(windowRange({ start: '22:00', end: '02:00', wakes: 1, label: '' }), { from: 1320, to: 1560 });
  assert.deepEqual(windowRange({ start: '12:00', end: '14:00', wakes: 1, label: '' }), { from: 720, to: 840 });
});

test('计划：窗口内取时刻，落在 [start+1, end-2] 且不在端点', () => {
  const now = at('2026-10-21', '09:00');
  const plan = generateDayPlan({ now, windows: [evening], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1230]) });
  assert.ok(plan);
  assert.equal(plan?.action, 'wake');
  assert.equal(plan?.slots.length, 1);
  const slot = plan?.slots[0];
  assert.equal(slot?.atText, '20:30');
  assert.equal(slot?.atMs, dayStartMs(now) + 1230 * 60_000);
  assert.equal(slot?.kind, 'wake');

  // 极端值也要夹在区间里
  const early = generateDayPlan({ now, windows: [evening], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([0]) });
  assert.equal(early?.slots[0]?.atText, '20:01');
  const late = generateDayPlan({ now, windows: [evening], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([99999]) });
  assert.equal(late?.slots[0]?.atText, '23:58');
});

test('计划：掷骰命中只排一次「醒来写日记」，不取候选', () => {
  const now = at('2026-10-21', '09:00');
  const plan = generateDayPlan({ now, windows: [evening], skipChance: 0.9, maxWakesPerDay: 3, rand: scriptedRandom([1300], [0.5]) });
  assert.ok(plan);
  assert.equal(plan?.action, 'skip');
  assert.equal(plan?.targetWakes, 1);
  assert.equal(plan?.slots.length, 1);
  assert.equal(plan?.slots[0]?.kind, 'skip');
  assert.match(plan?.reason ?? '', /不想看/);

  const noSkip = generateDayPlan({ now, windows: [evening], skipChance: 0.1, maxWakesPerDay: 1, rand: scriptedRandom([1300], [0.5]) });
  assert.equal(noSkip?.action, 'wake');
});

test('计划：多窗口 + 每天硬上限 3 + 相互至少 30 分钟', () => {
  const now = at('2026-10-21', '09:00');
  const windows: ScheduleWindow[] = [
    { start: '12:00', end: '14:00', wakes: 2, label: '中午' },
    { start: '20:00', end: '22:00', wakes: 3, label: '晚上' },
  ];
  // 故意给会撞车的随机值：先给 750，再给 745（间隔 5 分钟，应被拒绝）
  const plan = generateDayPlan({ now, windows, skipChance: 0, maxWakesPerDay: 3, rand: scriptedRandom([750, 745, 760, 1000, 1010, 1020]) });
  assert.ok(plan);
  assert.equal(plan?.slots.length, HARD_WAKE_CAP, '硬上限 3 次');
  const times = (plan?.slots ?? []).map((s) => s.atMs).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok((times[i] as number) - (times[i - 1] as number) >= MIN_GAP_MINUTES * 60_000, '槽位间隔必须 ≥30 分钟');
  }
});

test('计划：maxWakesPerDay=0 → 只排计划不自动醒；没有窗口 → null', () => {
  const now = at('2026-10-21', '09:00');
  const zero = generateDayPlan({ now, windows: [evening], skipChance: 0, maxWakesPerDay: 0, rand: scriptedRandom([1300]) });
  assert.equal(zero?.targetWakes, 0);
  assert.equal(zero?.slots.length, 0);

  const none = generateDayPlan({ now, windows: [], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1300]) });
  assert.equal(none, null);

  const sleeping = generateDayPlan({ now, windows: [{ start: '20:00', end: '22:00', wakes: 0, label: '关掉的' }], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1300]) });
  assert.equal(sleeping, null);
});

test('计划：跨零点窗口的后半夜槽位落在下一天，且不会被跨天重算冲掉', () => {
  const now = at('2026-10-21', '09:00');
  // 23:30 → 属于 10-21；给一个 01:30 的值测试下一天
  const plan = generateDayPlan({ now, windows: [lateNight], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1470]) });
  assert.ok(plan);
  const slot = plan?.slots[0];
  assert.equal(slot?.atText, '00:30');
  assert.equal(localDate(new Date(slot?.atMs ?? 0)), '2026-10-22', '后半夜槽位落在第二天');
  assert.equal(describeSlot(slot as never, now), '00:30（明天）');

  // 第二天 00:10 tick：跨天重算，但 00:30 的尾巴要带过来
  const nextDay = at('2026-10-22', '00:10');
  const outcome = tick({
    now: nextDay,
    plan,
    config: { windows: [lateNight], skipChance: 0, maxWakesPerDay: 1, graceMinutes: 90 },
    rand: scriptedRandom([1470]),
    paused: false,
  });
  assert.equal(outcome.kind, 'replanned');
  if (outcome.kind === 'replanned') {
    const carried = outcome.plan.slots.filter((s) => localDate(new Date(s.atMs)) === '2026-10-22');
    assert.ok(carried.length >= 1, '昨天排的 00:30 必须带过来');
  }
});

test('tick：没到点不动，到点触发，过了宽限期算错过', () => {
  const base = at('2026-10-21', '09:00');
  const plan = generateDayPlan({ now: base, windows: [evening], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1230]) }) as DayPlan;
  const cfg = config();

  assert.equal(tick({ now: at('2026-10-21', '20:29'), plan, config: cfg, rand: scriptedRandom([1230]), paused: false }).kind, 'none');

  const fired = tick({ now: at('2026-10-21', '20:30'), plan, config: cfg, rand: scriptedRandom([1230]), paused: false });
  assert.equal(fired.kind, 'fire');
  if (fired.kind === 'fire') {
    assert.equal(fired.slot.atText, '20:30');
    assert.equal(fired.plan.slots[0]?.fired, true, '触发后要标记已触发');
  }

  const late = tick({ now: at('2026-10-21', '22:30'), plan, config: cfg, rand: scriptedRandom([1230]), paused: false });
  assert.equal(late.kind, 'missed', '超过 90 分钟宽限期应记为错过');
  if (late.kind === 'missed') assert.equal(late.plan.slots[0]?.missed, true);
});

test('tick：暂停、同一分钟去重、计划跑完', () => {
  const plan = generateDayPlan({ now: at('2026-10-21', '09:00'), windows: [evening], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1230]) }) as DayPlan;
  const cfg = config();

  assert.equal(tick({ now: at('2026-10-21', '20:30'), plan, config: cfg, rand: scriptedRandom([1230]), paused: true }).kind, 'none');
  assert.equal(
    tick({ now: at('2026-10-21', '20:30'), plan, config: cfg, rand: scriptedRandom([1230]), paused: false, lastFiredMinute: 20 * 60 + 30 }).kind,
    'none',
  );

  const done = markSlot(plan, plan.slots[0] as never, 'fired');
  assert.equal(pendingSlots(done).length, 0);
  assert.equal(tick({ now: at('2026-10-21', '21:00'), plan: done, config: cfg, rand: scriptedRandom([1230]), paused: false }).kind, 'none');
});

test('tick：跨天重算，且配置变更强制重算', () => {
  const plan = generateDayPlan({ now: at('2026-10-21', '09:00'), windows: [evening], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1230]) }) as DayPlan;
  const nextDay = at('2026-10-22', '08:00');
  const replanned = tick({ now: nextDay, plan, config: config(), rand: scriptedRandom([1230]), paused: false });
  assert.equal(replanned.kind, 'replanned');
  if (replanned.kind === 'replanned') {
    assert.equal(replanned.generated, true);
    assert.equal(replanned.plan.date, '2026-10-22');
  }

  const invalidated = tick({ now: at('2026-10-21', '15:00'), plan, config: config({ windows: [noon] }), rand: scriptedRandom([780]), paused: false, invalidate: true });
  assert.equal(invalidated.kind, 'replanned');
  if (invalidated.kind === 'replanned') {
    assert.equal(invalidated.generated, false, '配置变更不是「新的一天」');
    assert.equal(invalidated.plan.slots[0]?.window.includes('12:00'), true);
  }
});

test('summarizePlan 说人话', () => {
  const now = at('2026-10-21', '19:00');
  const plan = generateDayPlan({ now, windows: [evening], skipChance: 0, maxWakesPerDay: 1, rand: scriptedRandom([1260]) }) as DayPlan;
  assert.match(summarizePlan(plan, now), /下一次 21:00（约 120 分钟后）/);

  const skip = generateDayPlan({ now, windows: [evening], skipChance: 1, maxWakesPerDay: 1, rand: scriptedRandom([1260], [0]) }) as DayPlan;
  assert.match(summarizePlan(skip, now), /不想看/);
  assert.equal(summarizePlan(null), '今天还没排计划');
});

test('随机源：crypto 的 int 落在区间内，scripted 按序取值', () => {
  for (let i = 0; i < 50; i += 1) {
    const value = cryptoRandom.int(10, 20);
    assert.ok(value >= 10 && value <= 20);
    const f = cryptoRandom.float();
    assert.ok(f >= 0 && f < 1);
  }
  const scripted = scriptedRandom([5, 6], [0.3]);
  assert.equal(scripted.int(0, 10), 5);
  assert.equal(scripted.int(0, 10), 6);
  assert.equal(scripted.int(0, 10), 5);
  assert.ok(Math.abs(scripted.float() - 0.3) < 1e-9);
});

test('计划在真实默认配置下能生成（不依赖注入）', () => {
  const now = new Date();
  for (let i = 0; i < 20; i += 1) {
    const plan = generateDayPlan({ now, windows: [evening], skipChance: 0.2, maxWakesPerDay: 1, rand: cryptoRandom });
    assert.ok(plan);
    if (plan && plan.slots.length > 0) {
      const slot = plan.slots[0] as { atText: string; atMs: number };
      assert.match(slot.atText, /^\d{2}:\d{2}$/);
      const minutes = (slot.atMs - dayStartMs(now)) / 60_000;
      assert.ok(minutes >= 1201 && minutes <= 1438, `时刻 ${formatHhmm(Math.round(minutes))} 应落在窗口内`);
    }
  }
});
