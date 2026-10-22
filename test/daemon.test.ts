import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startDaemon } from '../src/daemon/index.ts';
import { scriptedRandom } from '../src/scheduler/random.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { localDate } from '../src/shared/time.ts';
import { tmpDir } from './helpers.ts';

/** 写一份「马上就该醒」的配置：窗口在 00:00–00:02，宽限期给满一天。 */
function immediateConfig(dir: string, opts: { skipChance?: number } = {}): void {
  const config = {
    version: 1,
    schedule: {
      windows: [{ start: '00:00', end: '00:02', wakes: 1, label: '测试窗口' }],
      skipChance: opts.skipChance ?? 0,
      maxWakesPerDay: 1,
      graceMinutes: 1440,
    },
    report: { level: 'full' },
    logging: { level: 'error' },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function readState(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
}

test('到点自己醒：初始 tick 真的跑完一轮，并把报告/日记落盘', async () => {
  const dir = tmpDir('daemon-wake');
  immediateConfig(dir);
  const paths = resolvePaths({ dataDir: dir });

  const started = await startDaemon({ dataDir: dir, port: 0, fixtures: true, version: 'test', tickMs: 3600_000, heartbeatMs: 3600_000 });
  assert.equal(started.kind, 'started');
  if (started.kind !== 'started') return;

  try {
    const state = readState(dir);
    assert.equal(state.lastRunStatus, 'ok', '到点应该真的跑了一轮');
    assert.equal(state.paused, false);
    const today = state.today as { wakes: number; slots: Array<{ fired: boolean }> };
    assert.equal(today.wakes, 1, '应该记一次唤醒');
    assert.equal(today.slots[0]?.fired, true, '槽位要被标记已触发');

    const runsDir = path.join(dir, 'runs');
    const runs = fs.readdirSync(runsDir).filter((file) => file.endsWith('.json'));
    assert.equal(runs.length, 1);
    const record = JSON.parse(fs.readFileSync(path.join(runsDir, runs[0] as string), 'utf8')) as { trigger: string; status: string };
    assert.equal(record.trigger, 'schedule', '这一轮是作息触发的');
    assert.equal(record.status, 'ok');

    const day = localDate();
    assert.ok(fs.existsSync(path.join(dir, 'reports', `${day}.md`)), '日报要落盘');
    assert.ok(fs.existsSync(path.join(dir, 'diaries', 'public', `${day}.md`)), '公开日记要落盘');
    assert.ok(fs.existsSync(path.join(dir, 'diaries', 'private', `${day}.md`)), '私人日记要落盘');

    // 控制接口能读到状态
    const health = (await (await fetch(`http://127.0.0.1:${started.port}/api/health`, { headers: { authorization: `Bearer ${started.token}` } })).json()) as {
      ok: boolean;
      running: boolean;
      lastRunStatus: string;
    };
    assert.equal(health.ok, true);
    assert.equal(health.running, false);
    assert.equal(health.lastRunStatus, 'ok');

    const status = (await (await fetch(`http://127.0.0.1:${started.port}/api/status`, { headers: { authorization: `Bearer ${started.token}` } })).json()) as {
      today: { wakes: number };
      lastRun: { status: string } | null;
    };
    assert.equal(status.today.wakes, 1);
    assert.equal(status.lastRun?.status, 'ok');

    // runtime.json 与心跳都在
    assert.ok(fs.existsSync(paths.runtime));
    assert.ok(fs.existsSync(paths.heartbeat));
  } finally {
    await started.stop();
  }

  // 退出要清干净：runtime / 心跳 / 锁
  assert.equal(fs.existsSync(paths.runtime), false, '退出后 runtime.json 应删除');
  assert.equal(fs.existsSync(paths.heartbeat), false, '退出后心跳应删除');
  assert.equal(fs.existsSync(path.join(paths.localDir, 'instance.lock')), false, '退出后锁要放掉');
});

test('跳过分支：今天不想看时只写日记，不取候选、不分享', async () => {
  const dir = tmpDir('daemon-skip');
  immediateConfig(dir, { skipChance: 0.95 });
  const paths = resolvePaths({ dataDir: dir });

  const started = await startDaemon({
    dataDir: dir,
    port: 0,
    fixtures: true,
    version: 'test',
    tickMs: 3600_000,
    heartbeatMs: 3600_000,
    rand: scriptedRandom([], [0]), // 固定掷骰：命中「今天不想看」
  });
  assert.equal(started.kind, 'started');
  if (started.kind !== 'started') return;

  try {
    const state = readState(dir);
    const today = state.today as { action: string; wakes: number };
    assert.equal(today.action, 'skip', '掷骰命中应生成跳过计划');
    assert.equal(today.wakes, 1);

    const day = localDate();
    const publicDiary = fs.readFileSync(path.join(dir, 'diaries', 'public', `${day}.md`), 'utf8');
    const privateDiary = fs.readFileSync(path.join(dir, 'diaries', 'private', `${day}.md`), 'utf8');
    assert.match(publicDiary, /不想看|没看/, '公开日记要说清今天为什么不想看');
    assert.match(privateDiary, /偏好校准/, '私人日记必须含偏好校准');

    const runsDir = path.join(dir, 'runs');
    const runFile = fs.readdirSync(runsDir).filter((file) => file.endsWith('.json'))[0] as string;
    const record = JSON.parse(fs.readFileSync(path.join(runsDir, runFile), 'utf8')) as {
      counts: { candidates: number; selected: number; shared: number };
    };
    assert.equal(record.counts.candidates, 0, '跳过分支不取候选');
    assert.equal(record.counts.selected, 0);
    assert.equal(record.counts.shared, 0);

    // 报告里也要有一行，不能让这一天在报告里凭空消失
    const report = fs.readFileSync(path.join(dir, 'reports', `${day}.md`), 'utf8');
    assert.match(report, /醒来但不想看/);
  } finally {
    await started.stop();
  }
});

test('单实例：已经有实例在跑时，第二个直接退出并带上端口', async () => {
  const dir = tmpDir('daemon-busy');
  immediateConfig(dir);
  const paths = resolvePaths({ dataDir: dir });
  fs.mkdirSync(paths.localDir, { recursive: true });
  // 用一个「确定活着」的 pid 冒充已有实例：父进程
  fs.writeFileSync(
    path.join(paths.localDir, 'instance.lock'),
    JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), port: 9999 }),
    'utf8',
  );

  const started = await startDaemon({ dataDir: dir, port: 0, fixtures: true, version: 'test', tickMs: 3600_000, heartbeatMs: 3600_000 });
  assert.equal(started.kind, 'already-running');
  if (started.kind === 'already-running') {
    assert.equal(started.holder?.port, 9999);
    assert.match(started.message, /已有实例在跑/);
  }
  assert.equal(fs.existsSync(paths.runtime), false, '第二个实例不该写 runtime.json');
});

test('暂停： paused 状态下 tick 不跑，resume 之后恢复', async () => {
  const dir = tmpDir('daemon-pause');
  immediateConfig(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, paused: true, pausedAt: new Date().toISOString() }), 'utf8');
  const paths = resolvePaths({ dataDir: dir });

  const started = await startDaemon({ dataDir: dir, port: 0, fixtures: true, version: 'test', tickMs: 3600_000, heartbeatMs: 3600_000 });
  assert.equal(started.kind, 'started');
  if (started.kind !== 'started') return;

  try {
    const runsDir = path.join(dir, 'runs');
    const before = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).length : 0;
    assert.equal(before, 0, '暂停时到点也不跑');

    const headers = { authorization: `Bearer ${started.token}` };
    const resumed = (await (await fetch(`http://127.0.0.1:${started.port}/api/resume`, { method: 'POST', headers })).json()) as { ok: boolean };
    assert.equal(resumed.ok, true);

    await started.tickNow();
    const after = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).length;
    assert.equal(after, 1, '恢复之后下一次 tick 应该跑一轮');
    assert.equal(readState(dir).paused, false);
  } finally {
    await started.stop();
  }
  assert.equal(fs.existsSync(paths.runtime), false);
});

test('配置热更新：改 schedule 会让调度器重算计划', async () => {
  const dir = tmpDir('daemon-reload');
  immediateConfig(dir);
  const started = await startDaemon({ dataDir: dir, port: 0, fixtures: true, version: 'test', tickMs: 3600_000, heartbeatMs: 3600_000 });
  assert.equal(started.kind, 'started');
  if (started.kind !== 'started') return;

  try {
    const original = readState(dir).today as { slots: Array<{ atText: string }> };
    assert.equal(original.slots[0]?.atText, '00:00');

    // 改成晚上 20:00–24:00，并把 skipChance 设为 0（避免随机）
    const configFile = path.join(dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    config.schedule = {
      windows: [{ start: '20:00', end: '24:00', wakes: 1, label: '晚上' }],
      skipChance: 0,
      maxWakesPerDay: 1,
      graceMinutes: 1440,
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

    // 等文件监听触发（debounce 500ms），然后手动 tick
    await new Promise((resolve) => setTimeout(resolve, 900));
    await started.tickNow();

    const after = readState(dir).today as { slots: Array<{ atText: string; window: string }> };
    assert.match(after.slots[0]?.window ?? '', /20:00/, `计划应该按新窗口重算，实际 ${JSON.stringify(after.slots)}`);
  } finally {
    await started.stop();
  }
});

