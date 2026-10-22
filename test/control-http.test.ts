import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

import { ControlServer } from '../src/http/server.ts';
import type { AutostartPayload, ControlHandlers, HealthPayload, PanelHandlers, StatusPayload } from '../src/http/server.ts';
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
  saveConfig: unknown[];
}

function fakeHandlers(calls: Calls, over: { runOk?: boolean; auto?: AutostartPayload } = {}): ControlHandlers & Partial<PanelHandlers> {
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
    // ---- 面板能力（M2）----
    config() {
      return { config: { ui: { port: 8787 } }, groups: [{ key: 'ui', label: '面板', fields: [] }], issues: [] };
    },
    async saveConfig(patch) {
      calls.saveConfig.push(patch);
      return { ok: true, message: '已保存', issues: [] };
    },
    validateConfig() {
      return { ok: true, issues: [] };
    },
    exportConfig() {
      return { filename: 'biliwhale-config.json', json: '{"ui":{}}' };
    },
    async importConfig() {
      return { ok: true, message: '已导入' };
    },
    async resetConfig() {
      return { ok: true, message: '已恢复默认' };
    },
    models() {
      return { configured: 'deepseek-flash', actual: 'deepseek-flash' };
    },
    account() {
      return { loggedIn: false, fingerprint: '未登录' };
    },
    async qrStart() {
      return { ok: true, key: 'k1', url: 'https://example.com/qr', rows: ['11', '01'], size: 2, expiresInSec: 170 };
    },
    async qrPoll(key: string) {
      return { ok: true, state: 'waiting', message: `等待 ${key}` };
    },
    async saveCookie() {
      return { ok: true, message: '已保存' };
    },
    logout() {
      return { ok: true, message: '已退出' };
    },
    reports() {
      return [{ date: '2026-10-21', size: 100 }];
    },
    report(date: string) {
      return date === '2026-10-21' ? { date, markdown: '# 今天\n\n看了两条。' } : null;
    },
    diaries() {
      return [{ date: '2026-10-21', size: 50 }];
    },
    diary(kind: 'public' | 'private', date: string) {
      return { date, markdown: `# ${kind}` };
    },
    async doctor() {
      return { healthy: true, rows: [{ name: 'Node', level: 'ok', detail: 'v24' }] };
    },
    async diag() {
      return { filename: 'diag.json', json: '{"ok":true}' };
    },
  };
}

function newCalls(): Calls {
  return { run: [], pause: 0, resume: 0, autostart: [], shutdown: 0, logs: [], saveConfig: [] };
}

const auth = { authorization: `Bearer ${TOKEN}` };

function writeHeaders(csrf: string): Record<string, string> {
  return { ...auth, 'content-type': 'application/json', 'x-csrf-token': csrf };
}

async function startServer(over: { runOk?: boolean; auto?: AutostartPayload } = {}): Promise<{
  server: ControlServer;
  base: string;
  calls: Calls;
  csrf: string;
}> {
  const dir = tmpDir('control-http');
  const calls = newCalls();
  const server = new ControlServer({ handlers: fakeHandlers(calls, over), token: TOKEN, version: 'test', port: 0, logger: quietLogger(dir) });
  const started = await server.start();
  const base = `http://127.0.0.1:${started.port}`;
  const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
  return { server, base, calls, csrf: session.csrfToken };
}

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

test('写操作必须带 CSRF token（从 /api/session 拿）', async () => {
  const { server, base, csrf, calls } = await startServer();
  try {
    assert.ok(csrf.length >= 32, 'CSRF token 要有足够长度');

    const noCsrf = await fetch(`${base}/api/run`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noCsrf.status, 403);
    assert.equal(calls.run.length, 0, '没有 CSRF 不该执行动作');

    const wrong = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'x-csrf-token': 'nope' },
      body: '{}',
    });
    assert.equal(wrong.status, 403);

    const ok = await fetch(`${base}/api/run`, { method: 'POST', headers: writeHeaders(csrf), body: JSON.stringify({ dryRun: true }) });
    assert.equal(ok.status, 202);
    assert.deepEqual(calls.run, [{ dryRun: true }]);
  } finally {
    await server.stop();
  }
});

test('静态面板：/ 返回 HTML，带 CSP；未知扩展名 404；路径穿越被拦', async () => {
  const { server, base } = await startServer();
  try {
    const page = await fetch(`${base}/?token=${TOKEN}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    const html = await page.text();
    assert.match(html, /BiliWhale/);
    assert.match(html, /app\.js/);

    const css = await fetch(`${base}/style.css?token=${TOKEN}`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);

    assert.equal((await fetch(`${base}/nope.exe?token=${TOKEN}`)).status, 404);
    // URL 规范化会把 `..` 折叠成根路径，所以这里断言的是「拿不到 ui 目录外的文件」
    assert.equal((await fetch(`${base}/%2e%2e/package.json?token=${TOKEN}`)).status, 404);
    assert.equal((await fetch(`${base}/../package.json?token=${TOKEN}`)).status, 404);
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json?token=${TOKEN}`)).status, 400);
  } finally {
    await server.stop();
  }
});

test('动作：run/pause/resume/autostart/shutdown 都打到 handler 上', async () => {
  const { server, base, calls, csrf } = await startServer();
  try {
    const run = await fetch(`${base}/api/run`, { method: 'POST', headers: writeHeaders(csrf), body: JSON.stringify({ dryRun: true }) });
    assert.equal(run.status, 202);
    assert.deepEqual(calls.run, [{ dryRun: true }]);

    await fetch(`${base}/api/run`, { method: 'POST', headers: writeHeaders(csrf), body: '{}' });
    assert.deepEqual(calls.run[1], { dryRun: false });

    assert.equal((await fetch(`${base}/api/pause`, { method: 'POST', headers: writeHeaders(csrf) })).status, 200);
    assert.equal((await fetch(`${base}/api/resume`, { method: 'POST', headers: writeHeaders(csrf) })).status, 200);
    assert.equal(calls.pause, 1);
    assert.equal(calls.resume, 1);

    const autoGet = (await (await fetch(`${base}/api/autostart`, { headers: auth })).json()) as { enabled: boolean };
    assert.equal(autoGet.enabled, false);
    const autoPost = (await (
      await fetch(`${base}/api/autostart`, { method: 'POST', headers: writeHeaders(csrf), body: JSON.stringify({ enabled: true }) })
    ).json()) as { enabled: boolean; mechanism: string };
    assert.equal(autoPost.enabled, true);
    assert.equal(autoPost.mechanism, 'startup-folder');
    assert.deepEqual(calls.autostart, [undefined, true]);

    assert.equal((await fetch(`${base}/api/shutdown`, { method: 'POST', headers: writeHeaders(csrf) })).status, 200);
    assert.equal(calls.shutdown, 1);
  } finally {
    await server.stop();
  }
});

test('面板接口：config / 账号 / 报告日记 / 体检 / 诊断 都在位', async () => {
  const { server, base, csrf } = await startServer();
  try {
    const config = (await (await fetch(`${base}/api/config`, { headers: auth })).json()) as { ok: boolean; config: unknown; groups: unknown[] };
    assert.equal(config.ok, true);
    assert.ok(Array.isArray(config.groups));

    const saved = await fetch(`${base}/api/config`, { method: 'PUT', headers: writeHeaders(csrf), body: JSON.stringify({ ui: { port: 9000 } }) });
    assert.equal(saved.status, 200);

    const validated = (await (await fetch(`${base}/api/config/validate`, { method: 'POST', headers: writeHeaders(csrf), body: '{"ui":{}}' })).json()) as { ok: boolean };
    assert.equal(validated.ok, true);

    const exported = await fetch(`${base}/api/config/export`, { headers: auth });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment/);

    assert.equal((await fetch(`${base}/api/config/import`, { method: 'POST', headers: writeHeaders(csrf), body: '{"config":{}}' })).status, 200);
    assert.equal((await fetch(`${base}/api/config/reset`, { method: 'POST', headers: writeHeaders(csrf) })).status, 200);

    const account = (await (await fetch(`${base}/api/account`, { headers: auth })).json()) as { ok: boolean };
    assert.equal(account.ok, true);
    const qr = (await (await fetch(`${base}/api/account/qr`, { method: 'POST', headers: writeHeaders(csrf) })).json()) as { ok: boolean };
    assert.equal(qr.ok, true);
    const poll = (await (await fetch(`${base}/api/account/qr/poll?key=k1`, { headers: auth })).json()) as { ok: boolean };
    assert.equal(poll.ok, true);
    assert.equal((await fetch(`${base}/api/account/cookie`, { method: 'POST', headers: writeHeaders(csrf), body: '{"cookie":"x"}' })).status, 200);
    assert.equal((await fetch(`${base}/api/account/logout`, { method: 'POST', headers: writeHeaders(csrf) })).status, 200);

    const reports = (await (await fetch(`${base}/api/reports`, { headers: auth })).json()) as { items: unknown[] };
    assert.equal(reports.items.length, 1);
    const report = (await (await fetch(`${base}/api/reports/2026-10-21`, { headers: auth })).json()) as { markdown: string };
    assert.match(report.markdown, /看了两条/);
    assert.equal((await fetch(`${base}/api/reports/2026-01-01`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/api/reports/not-a-date`, { headers: auth })).status, 400);

    const diaries = (await (await fetch(`${base}/api/diaries?kind=private`, { headers: auth })).json()) as { ok: boolean };
    assert.equal(diaries.ok, true);
    const diary = (await (await fetch(`${base}/api/diaries/private/2026-10-21`, { headers: auth })).json()) as { ok: boolean };
    assert.equal(diary.ok, true);

    const doctor = (await (await fetch(`${base}/api/doctor`, { headers: auth })).json()) as { ok: boolean };
    assert.equal(doctor.ok, true);
    const diag = await fetch(`${base}/api/diag`, { headers: auth });
    assert.equal(diag.status, 200);
    assert.match(diag.headers.get('content-disposition') ?? '', /attachment; filename="diag.json"/);
  } finally {
    await server.stop();
  }
});

test('日志接口会夹住 limit；未知路径 404；run 被拒时 409', async () => {
  const { server, base, calls, csrf } = await startServer({ runOk: false });
  try {
    await fetch(`${base}/api/logs?limit=9999`, { headers: auth });
    await fetch(`${base}/api/logs?limit=0`, { headers: auth });
    assert.deepEqual(calls.logs, [500, 1], 'limit 要夹在 1..500');

    assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404);
    const rejected = await fetch(`${base}/api/run`, { method: 'POST', headers: writeHeaders(csrf), body: '{}' });
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

  const third = new ControlServer({ handlers: fakeHandlers(newCalls()), token: TOKEN, version: 'test', port: started.port, logger });
  const thirdStarted = await third.start();
  assert.equal(thirdStarted.port, started.port);
  await third.stop();
});
