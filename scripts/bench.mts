/**
 * 性能基准（M5）：冷启动、控制接口延迟、空闲内存。
 *
 * 用法：node scripts/bench.mts [--json]
 * 判据（需求文档 §12.1）：冷启动 < 3s、空闲内存 < 150MB、本地面板 API P95 < 200ms。
 *
 * 全程 fixtures（不联网、不调真模型、不发任何远端内容）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../src/bootstrap.ts';
import { startDaemon } from '../src/daemon/index.ts';
import { tmpDir } from '../test/helpers.ts';

const jsonOnly = process.argv.includes('--json');
const dir = tmpDir('bench');

const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const round = (value: number): number => Math.round(value * 10) / 10;

interface Result {
  coldStartMs: number;
  daemonStartMs: number;
  apiP50Ms: number;
  apiP95Ms: number;
  apiMaxMs: number;
  idleRssMb: number;
  idleHeapMb: number;
  afterTicksRssMb: number;
  ticks: number;
}

// 1) 冷启动：装配（配置/账本/客户端）到可用
const t0 = now();
const ctx = await bootstrap({ dataDir: dir, fixtures: true, mirrorToConsole: false, discover: false });
const coldStartMs = now() - t0;
void ctx;

// 2) 守护进程启动 → 第一次能拿到 health
const t1 = now();
const started = await startDaemon({ dataDir: dir, port: 0, fixtures: true, version: 'bench', tickMs: 3_600_000, heartbeatMs: 3_600_000 });
if (started.kind !== 'started') throw new Error(started.message);
const daemonStartMs = now() - t1;

const auth = { authorization: `Bearer ${started.token}` };
const timed = async (pathname: string): Promise<number> => {
  const t = now();
  const res = await fetch(`${started.url}${pathname}`, { headers: auth });
  await res.text();
  return now() - t;
};

// 3) 热起来再测（第一次请求要建连接）
await timed('/api/health');
const samples: number[] = [];
for (let i = 0; i < 40; i += 1) samples.push(await timed(i % 2 === 0 ? '/api/health' : '/api/status'));
samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
const max = samples[samples.length - 1] ?? 0;

// 4) 空闲内存（跑几轮、再等两秒）
const mem0 = process.memoryUsage();
const ticks = 20;
for (let i = 0; i < ticks; i += 1) await started.tickNow();
await new Promise((resolve) => setTimeout(resolve, 1500));
const mem1 = process.memoryUsage();
await started.stop();

const result: Result = {
  coldStartMs: round(coldStartMs),
  daemonStartMs: round(daemonStartMs),
  apiP50Ms: round(p50),
  apiP95Ms: round(p95),
  apiMaxMs: round(max),
  idleRssMb: round(mem0.rss / 1024 / 1024),
  idleHeapMb: round(mem0.heapUsed / 1024 / 1024),
  afterTicksRssMb: round(mem1.rss / 1024 / 1024),
  ticks,
};

fs.rmSync(dir, { recursive: true, force: true });

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stdout.write(
    [
      '',
      'BiliWhale 性能基准（fixtures，单机）',
      `  冷启动          ${result.coldStartMs} ms   （判据 < 3000）`,
      `  守护进程启动     ${result.daemonStartMs} ms`,
      `  API 延迟        P50 ${result.apiP50Ms} ms · P95 ${result.apiP95Ms} ms · max ${result.apiMaxMs} ms   （判据 P95 < 200）`,
      `  空闲内存        RSS ${result.idleRssMb} MB · heap ${result.idleHeapMb} MB   （判据 < 150MB）`,
      `  ${result.ticks} 轮后内存   RSS ${result.afterTicksRssMb} MB（涨 ${round(result.afterTicksRssMb - result.idleRssMb)} MB）`,
      '',
    ].join('\n'),
  );
}

const failures: string[] = [];
if (result.coldStartMs > 3000) failures.push(`冷启动 ${result.coldStartMs}ms > 3000ms`);
if (result.apiP95Ms > 200) failures.push(`API P95 ${result.apiP95Ms}ms > 200ms`);
if (result.afterTicksRssMb > 150) failures.push(`内存 ${result.afterTicksRssMb}MB > 150MB`);
if (failures.length > 0) {
  process.stderr.write(`基准没达标：${failures.join('；')}\n`);
  process.exitCode = 1;
}
