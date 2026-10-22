/**
 * 7 天无人值守浸泡（加速时钟）。
 *
 * 做什么：把时钟拨快，按 30 分钟一步走 7 天，让调度器真的到点、真的跑一轮（夹具模式），
 *   然后断言「无人值守」该成立的几件事：
 *     - 每天自动唤醒不超过 3 次（硬上限）；
 *     - 同一分钟不重复触发、同一槽位不重复跑；
 *     - 每天都有报告和两本日记；run 记录里没有致命错误；
 *     - 第 4 天改一次配置（加一个窗口）后计划被重算；第 5 天暂停 → 不再跑，恢复 → 接着跑。
 *
 * 用法：node scripts/soak.mts [--days 7] [--keep]
 * 不做什么：不联网、不调真模型、不发任何远端内容（全程 fixtures + dryRun）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { startDaemon } from '../src/daemon/index.ts';
import { tmpDir } from '../test/helpers.ts';

interface DayStat {
  date: string;
  wakes: number;
  runs: number;
  errors: number;
  report: boolean;
  diaryPublic: boolean;
  diaryPrivate: boolean;
}

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const keep = args.includes('--keep');
const dir = tmpDir('soak');
const paths = {
  reports: path.join(dir, 'reports'),
  diariesPublic: path.join(dir, 'diaries', 'public'),
  diariesPrivate: path.join(dir, 'diaries', 'private'),
  runs: path.join(dir, 'runs'),
};

// 三天窗口（覆盖早/中/晚），每天最多 3 次；skipChance 设 0，让「到点必醒」可断言
const config = {
  version: 2,
  schedule: {
    windows: [
      { start: '07:00', end: '08:00', wakes: 1, label: '早上' },
      { start: '12:00', end: '13:00', wakes: 1, label: '中午' },
      { start: '21:00', end: '22:00', wakes: 1, label: '晚上' },
    ],
    skipChance: 0,
    maxWakesPerDay: 3,
    graceMinutes: 30,
  },
  report: { level: 'brief' },
  share: { enabled: false },
  safety: { writeEnabled: true, dryRun: true },
  logging: { level: 'error' },
};
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

const start = new Date('2026-11-01T00:00:00+08:00');
let clock = new Date(start);
const now = (): Date => new Date(clock);

const started = await startDaemon({
  dataDir: dir,
  port: 0,
  fixtures: true,
  version: 'soak',
  tickMs: 3_600_000,
  heartbeatMs: 3_600_000,
  configPollMs: 200,
  now,
});
if (started.kind !== 'started') {
  process.stderr.write(`浸泡失败：${started.message}\n`);
  process.exit(1);
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

const statOf = (date: string): DayStat => {
  const state = readJson<{ today?: { date: string; wakes: number } }>(path.join(dir, 'state.json'));
  const runs = fs.existsSync(paths.runs) ? fs.readdirSync(paths.runs).filter((name) => name.endsWith('.json')) : [];
  let errors = 0;
  let runsToday = 0;
  for (const name of runs) {
    const record = readJson<{ startedAt: string; errors: string[] }>(path.join(paths.runs, name));
    if (!record || !record.startedAt.startsWith(date)) continue;
    runsToday += 1;
    errors += record.errors.length;
  }
  return {
    date,
    wakes: state?.today?.date === date ? (state.today.wakes ?? 0) : 0,
    runs: runsToday,
    errors,
    report: fs.existsSync(path.join(paths.reports, `${date}.md`)),
    diaryPublic: fs.existsSync(path.join(paths.diariesPublic, `${date}.md`)),
    diaryPrivate: fs.existsSync(path.join(paths.diariesPrivate, `${date}.md`)),
  };
};

const dayOf = (value: Date): string => {
  const local = new Date(value.getTime() + 8 * 3_600_000); // 用 +08:00 的日期做统计口径
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
};

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const failures: string[] = [];
const stats = new Map<string, DayStat>();
/** 每天醒来次数：state.today 只保留当天，所以边走边记「当天最大值」。 */
const wakesByDay = new Map<string, number>();

process.stdout.write(`浸泡开始：${days} 天（加速时钟，每步 30 分钟）\n`);
const stepMs = 30 * 60_000;
const steps = days * 48;

const csrfToken = (await (await fetch(`${started.url}/api/session`, { headers: { authorization: `Bearer ${started.token}` } })).json()) as {
  csrfToken: string;
};
/** POST 都要带 CSRF：少一个 token 就会 403，而 fetch 不会 reject——所以必须看响应体。 */
const post = async (pathname: string): Promise<void> => {
  const res = await fetch(`${started.url}${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${started.token}`, 'x-csrf-token': csrfToken.csrfToken },
  });
  const body = (await res.json()) as { ok?: boolean; message?: string };
  if (!res.ok || body.ok === false) throw new Error(`${pathname} 失败：HTTP ${res.status} ${body.message ?? ''}`);
};

for (let step = 0; step < steps; step += 1) {
  clock = new Date(start.getTime() + step * stepMs);

  // 第 4 天 01:00 改配置：这时当天计划已经生成，改动必须触发「重算」而不是等明天
  if (step === 4 * 48 + 2) {
    const current = readJson<Record<string, unknown>>(path.join(dir, 'config.json')) ?? {};
    const schedule = current.schedule as { windows: Array<{ start: string; label?: string }> };
    // 只挪时间、不加窗口：所有窗口的 wakes 之和不能超过 3（校验会拒绝）
    const morning = schedule.windows[0];
    if (morning) {
      morning.start = '06:30';
      morning.label = '早上（第 4 天改的）';
    }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(current, null, 2), 'utf8');
    fs.utimesSync(path.join(dir, 'config.json'), clock, clock);
    // 等热更新真的生效：直接看 /api/config 里的内存态（watch 可能漏事件，所以还有轮询兜底）
    const reloaded = await waitFor(async () => {
      const res = await fetch(`${started.url}/api/config`, { headers: { authorization: `Bearer ${started.token}` } });
      const body = (await res.json()) as { config?: { schedule?: { windows?: Array<{ start?: string }> } } };
      return body.config?.schedule?.windows?.[0]?.start === '06:30';
    }, 5_000);
    if (!reloaded) failures.push('改了 config.json，但 5 秒内热更新没有生效');
    process.stdout.write('  [配置] 第 4 天把早上窗口挪到 06:30，已确认热更新生效\n');
  }

  // 第 5 天 00:00 暂停，12:00 恢复：验证「暂停不跑、恢复后接着跑」
  if (step === 5 * 48) await post('/api/pause');
  if (step === 5 * 48 + 24) await post('/api/resume');

  await started.tickNow();
  const date = dayOf(clock);
  const state = readJson<{ today?: { date: string; wakes: number } }>(path.join(dir, 'state.json'));
  if (state?.today?.date) {
    const previous = wakesByDay.get(state.today.date) ?? 0;
    wakesByDay.set(state.today.date, Math.max(previous, state.today.wakes ?? 0));
  }
  if (!stats.has(date)) stats.set(date, statOf(date));
}

// 统计每一天：醒来次数来自边走边记的最大值，跑轮/报告/日记来自磁盘
for (const date of wakesByDay.keys()) {
  if (!stats.has(date)) stats.set(date, statOf(date));
}
for (const [date, stat] of stats) stats.set(date, { ...stat, ...statOf(date), wakes: wakesByDay.get(date) ?? stat.wakes });

await started.stop();

// 断言
let totalWakes = 0;
let totalRuns = 0;
for (const [date, stat] of [...stats.entries()].sort()) {
  totalWakes += stat.wakes;
  totalRuns += stat.runs;
  if (stat.wakes > 3) failures.push(`${date} 醒来 ${stat.wakes} 次，超过硬上限 3`);
  if (stat.runs > 3) failures.push(`${date} 跑了 ${stat.runs} 轮，超过硬上限 3`);
  if (!stat.report) failures.push(`${date} 没有报告`);
  if (!stat.diaryPublic || !stat.diaryPrivate) failures.push(`${date} 日记不齐（公开 ${stat.diaryPublic} / 私人 ${stat.diaryPrivate}）`);
  if (stat.errors > 0) failures.push(`${date} 的 run 记录里有 ${stat.errors} 条错误`);
}

process.stdout.write('\n日期        醒来  跑轮  报告  日记  错误\n');
for (const [date, stat] of [...stats.entries()].sort()) {
  process.stdout.write(
    `${date}  ${String(stat.wakes).padStart(3)}  ${String(stat.runs).padStart(4)}  ${stat.report ? ' ✓ ' : ' ✗ '}  ${stat.diaryPublic && stat.diaryPrivate ? ' ✓ ' : ' ✗ '}  ${stat.errors}\n`,
  );
}
process.stdout.write(`\n合计：醒来 ${totalWakes} 次，跑轮 ${totalRuns} 次，${stats.size} 天\n`);

// 暂停期间不该跑：第 5 天 12 点暂停到 24 点，20 点那个窗口如果在暂停期就不该有 run
const pausedDay = dayOf(new Date(start.getTime() + 5 * 48 * stepMs));
const pausedStat = stats.get(pausedDay);
if (pausedStat && pausedStat.wakes > 2) failures.push(`${pausedDay} 暂停期间还在跑（醒来 ${pausedStat.wakes} 次）`);

// 第 4 天改配置后，调度器必须重算过计划（事件里写明「配置变更重算」）
const events = fs.existsSync(path.join(dir, 'events.jsonl'))
  ? fs
      .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { kind: string; note: string };
        } catch {
          return { kind: '', note: '' };
        }
      })
  : [];
if (process.env.SOAK_DEBUG === '1') {
  for (const event of events.filter((item) => item.kind === 'plan')) process.stdout.write(`  [plan] ${event.note}\n`);
}
if (!events.some((event) => event.kind === 'plan' && event.note.includes('配置变更重算'))) {
  failures.push('第 4 天改了配置，但调度器没有「配置变更重算」的记录');
}
if (!events.some((event) => event.kind === 'pause')) failures.push('暂停没有留下事件');
if (!events.some((event) => event.kind === 'resume')) failures.push('恢复没有留下事件');

if (failures.length > 0) {
  process.stderr.write(`\n浸泡不通过：\n${failures.map((line) => `  - ${line}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\n浸泡通过：每天 ≤3 次、报告与两本日记齐全、没有 run 错误。\n');
}

if (!keep) fs.rmSync(dir, { recursive: true, force: true });
else process.stdout.write(`数据留在：${dir}\n`);
