import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { ControlServer } from '../src/http/server.ts';
import type { AutostartPayload, ControlHandlers, HealthPayload, StatusPayload } from '../src/http/server.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';

const TOKEN = 'a'.repeat(64);

function quietLogger(dir: string): Logger {
  return new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

interface Calls {
  run: Array<{ dryRun: boolean }>;
  pause: number;
  resume: number;
  autostart: Array<boolean | undefined>;
  shutdown: number;
  logs: number[];
}

function fakeHandlers(calls: Calls, over: { runOk?: boolean; auto?: AutostartPayload } = {}): ControlHandlers {
  return {
    health(): HealthPayload {
      return {
        ok: true,
        version: 'test',
        pid: process.pid,
        uptimeSec: 1,
        running: false,
        paused: false,
        nextWakeAt: '2026-10-21T20:30:00+08:00',
        lastRunStatus: 'ok',
        lastError: null,
      };
    },
    status(): StatusPayload {
      return {
        scheduler: { plan: '今天醒 1 次，下一次 20:30', paused: false, nextWakeAt: '2026-10-21T20:30:00+08:00', planSource: null },
        lastRun: { id: 'r1', status: 'ok', endedAt: '2026-10-21T20:00:00+08:00', tokens: 1234 },
        today: { wakes: 1, targetWakes: 1, shares: 0, shareCap: 3, tokens: 1234, costCny: 0.01 },
        account: { loggedIn: true, name: '测试' },
        model: { configured: 'deepseek-flash', actual: 'deepseek-flash', discoveredAt: null },
        warnings: [],
      };
    },
    logs(limit) {
      calls.logs.push(limit);
      return [{ kind: 'round', note: 'ok' }];
    },
    async run(options) {
      calls.run.push(options);
      return over.runOk === false ? { ok: false, message: '上一轮还在跑' } : { ok: true, message: '已开始' };
    },
    pause() {
      calls.pause += 1;
      return { ok: true, message: '已暂停' };
    },
    resume() {
      calls.resume += 1;
      return { ok: true, message: '已恢复' };
    },
    async autostart(enabled) {
      calls.autostart.push(enabled);
      return over.auto ?? { enabled: enabled ?? false, mechanism: enabled ? 'startup-folder' : null, command: null };
    },
    shutdown() {
      calls.shutdown += 1;
      return { ok: true, message: '正在退出' };
    },
  };
}

function newCalls(): Calls {
  return { run: [], pause: 0, resume: 0, autostart: [], shutdown: 0, logs: [] };
}

async function startServer(over: { runOk?: boolean; auto?: AutostartPayload } = {}): Promise<{
  server: ControlServer;
  base: string;
  calls: Calls;
}> {
  const dir = tmpDir('control-http');
  const calls = newCalls();
  const server = new ControlServer({ handlers: fakeHandlers(calls, over), token: TOKEN, version: 'test', port: 0, logger: quietLogger(dir) });
  const started = await server.start();
  return { server, base: `http://127.0.0.1:${started.port}`, calls };
}

const auth = { authorization: `Bearer ${TOKEN}` };

test('鉴权：没有 token 一律 401，token 三种传法都认', async () => {
  const { server, base } = await startServer();
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/api/status`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/status?token=${TOKEN}`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`, { headers: { 'x-biliwhale-token': TOKEN } })).status, 200);

    const res = await fetch(`${base}/api/health`, { headers: auth });
    const body = (await res.json()) as { ok: boolean; version: string; pid: number };
    assert.equal(body.ok, true);
    assert.equal(body.version, 'test');
    assert.equal(body.pid, process.pid);
  } finally {
    await server.stop();
  }
});

test('Host 校验：非本机 Host 一律 403（防 DNS rebinding）', async () => {
  const { server, base } = await startServer();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/api/health`);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { host: 'evil.example.com', ...auth } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await server.stop();
  }
});

test('状态页：带 token 能打开，且不返回 CORS 头', async () => {
  const { server, base } = await startServer();
  try {
    const page = await fetch(`${base}/?token=${TOKEN}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    const html = await page.text();
    assert.match(html, /BiliWhale/);
    assert.match(html, /现在跑一轮/);
    assert.ok(!html.includes('__TOKEN__'), '占位符要被替换掉');
  } finally {
    await server.stop();
  }
});

test('动作：run/pause/resume/autostart/shutdown 都打到 handler 上', async () => {
  const { server, base, calls } = await startServer();
  try {
    const run = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(run.status, 202);
    assert.deepEqual(calls.run, [{ dryRun: true }]);

    // 不带 body 默认 dryRun=false
    await fetch(`${base}/api/run`, { method: 'POST', headers: auth });
    assert.deepEqual(calls.run[1], { dryRun: false });

    assert.equal((await fetch(`${base}/api/pause`, { method: 'POST', headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/resume`, { method: 'POST', headers: auth })).status, 200);
    assert.equal(calls.pause, 1);
    assert.equal(calls.resume, 1);

    const autoGet = (await (await fetch(`${base}/api/autostart`, { headers: auth })).json()) as { enabled: boolean };
    assert.equal(autoGet.enabled, false);
    const autoPost = (await (
      await fetch(`${base}/api/autostart`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    ).json()) as { enabled: boolean; mechanism: string };
    assert.equal(autoPost.enabled, true);
    assert.equal(autoPost.mechanism, 'startup-folder');
    assert.deepEqual(calls.autostart, [undefined, true]);

    const shutdown = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: auth });
    assert.equal(shutdown.status, 200);
    assert.equal(calls.shutdown, 1);
  } finally {
    await server.stop();
  }
});

test('日志接口会夹住 limit；未知路径 404；run 被拒时 409', async () => {
  const { server, base, calls } = await startServer({ runOk: false });
  try {
    await fetch(`${base}/api/logs?limit=9999`, { headers: auth });
    await fetch(`${base}/api/logs?limit=0`, { headers: auth });
    assert.deepEqual(calls.logs, [500, 1], 'limit 要夹在 1..500');

    assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404);
    const rejected = await fetch(`${base}/api/run`, { method: 'POST', headers: auth });
    assert.equal(rejected.status, 409);
  } finally {
    await server.stop();
  }
});

test('端口冲突时自动 +1，并且 stop 之后端口释放', async () => {
  const dir = tmpDir('control-http-ports');
  const logger = quietLogger(dir);

  const first = new ControlServer({ handlers: fakeHandlers(newCalls()), token: TOKEN, version: 'test', port: 0, logger });
  const started = await first.start();

  const second = new ControlServer({ handlers: fakeHandlers(newCalls()), token: TOKEN, version: 'test', port: started.port, logger });
  const secondStarted = await second.start();
  assert.notEqual(secondStarted.port, started.port, '第二个实例应该换一个端口');
  assert.ok(secondStarted.port > started.port);

  await second.stop();
  await first.stop();

  // 端口释放后可以再用
  const third = new ControlServer({ handlers: fakeHandlers(newCalls()), token: TOKEN, version: 'test', port: started.port, logger });
  const thirdStarted = await third.start();
  assert.equal(thirdStarted.port, started.port);
  await third.stop();
});
