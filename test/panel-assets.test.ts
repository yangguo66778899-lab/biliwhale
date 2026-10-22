import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ControlServer } from '../src/http/server.ts';
import type { ControlHandlers } from '../src/http/server.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';

/**
 * 面板「真的能在浏览器里跑起来」的回归测试。
 *
 * 为什么单独一个文件：M3 上线后真机发现面板只剩空壳——
 * `<script src="/app.js">` 与 `<link href="/style.css">` 是浏览器自己发的请求，带不上 `?token=`，
 * 于是被 401 挡掉，页面永远停在「连接中…」。
 * 这个测试按浏览器的真实顺序走：先开页面（拿 cookie）→ 再**不带 token** 取子资源。
 */

const TOKEN = 'f'.repeat(64);

function logger(dir: string): Logger {
  return new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

function handlers(): ControlHandlers {
  return {
    health: () => ({
      ok: true,
      version: 'test',
      pid: process.pid,
      uptimeSec: 0,
      running: false,
      paused: false,
      nextWakeAt: null,
      lastRunStatus: null,
      lastError: null,
    }),
    status: () => ({
      scheduler: { plan: '', paused: false, nextWakeAt: null, planSource: null },
      lastRun: null,
      today: { wakes: 0, targetWakes: 0, shares: 0, shareCap: 0, tokens: 0, costCny: 0 },
      account: { loggedIn: false },
      model: { configured: 'x', actual: 'x', discoveredAt: null },
      pending: { count: 0 },
      warnings: [],
    }),
    logs: () => [],
    run: async () => ({ ok: true, message: 'ok' }),
    pause: () => ({ ok: true, message: 'ok' }),
    resume: () => ({ ok: true, message: 'ok' }),
    autostart: async () => ({ enabled: false, mechanism: null, command: null }),
    shutdown: () => ({ ok: true, message: 'ok' }),
  };
}

async function start(): Promise<{ server: ControlServer; base: string }> {
  const dir = tmpDir('panel-assets');
  const server = new ControlServer({
    // 这里只关心静态资源与鉴权，业务接口给最小实现
    handlers: handlers(),
    token: TOKEN,
    version: 'test',
    port: 0,
    logger: logger(dir),
  });
  const started = await server.start();
  return { server, base: `http://127.0.0.1:${started.port}` };
}

test('浏览器流程：打开页面拿会话 cookie，再不带 token 取 /app.js 与 /style.css 必须是 200', async () => {
  const { server, base } = await start();
  try {
    // 1) 打开页面（带 token）
    const page = await fetch(`${base}/?token=${TOKEN}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const setCookie = page.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /bw_session=/, '打开页面时要种会话 cookie');
    assert.match(setCookie, /HttpOnly/i, 'cookie 要 HttpOnly（JS 读不到）');
    assert.match(setCookie, /SameSite=Strict/i, 'cookie 要 SameSite=Strict');
    const cookie = setCookie.split(';')[0] ?? '';
    assert.ok(cookie.length > 20, `cookie 看起来不对：${cookie}`);

    // 2) 页面里的子资源：浏览器只会带 cookie，不会带 token
    for (const [file, type] of [
      ['/app.js', /javascript/],
      ['/style.css', /text\/css/],
    ] as const) {
      const res = await fetch(`${base}${file}`, { headers: { cookie } });
      assert.equal(res.status, 200, `${file} 必须能靠 cookie 取到（真机就是这里坏的）`);
      assert.match(res.headers.get('content-type') ?? '', type);
      const body = await res.text();
      assert.ok(body.length > 100, `${file} 内容太短：${body.length}`);
    }

    // 3) 什么都没带 → 401；但浏览器导航要拿到一个说人话的页面
    const bare = await fetch(`${base}/app.js`);
    assert.equal(bare.status, 401);
    const nav = await fetch(`${base}/`);
    assert.equal(nav.status, 401);
    assert.match(nav.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await nav.text(), /token/);
  } finally {
    await server.stop();
  }
});

test('会话 cookie 不能靠伪造拿到数据；API 也要凭据', async () => {
  const { server, base } = await start();
  try {
    const forged = await fetch(`${base}/app.js`, { headers: { cookie: 'bw_session=deadbeef' } });
    assert.equal(forged.status, 401);

    const api = await fetch(`${base}/api/status`, { headers: { cookie: 'bw_session=deadbeef' } });
    assert.equal(api.status, 401);

    // 带真 token 的 API 仍然要 CSRF 才能写
    const post = await fetch(`${base}/api/pause`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(post.status, 403);
  } finally {
    await server.stop();
  }
});

test('index.html 干净：没有反引号（踩过的坑）、八个页面都在、资源引用都在', () => {
  const file = path.join(process.cwd(), 'src', 'ui', 'index.html');
  const html = fs.readFileSync(file, 'utf8');

  assert.equal(html.includes('`'), false, 'index.html 里不许出现反引号（之前用脚本改文件把换行写成了字面量 `n）');
  assert.equal(/\bn\s*<\/a>/.test(html), false, '标签文字里不该混进 n');

  for (const panel of ['overview', 'settings', 'account', 'reports', 'diaries', 'pending', 'logs', 'about']) {
    assert.match(html, new RegExp(`id="panel-${panel}"`), `缺少 panel-${panel}`);
    assert.match(html, new RegExp(`data-tab="${panel}"`), `缺少标签 ${panel}`);
  }

  assert.match(html, /<script src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/style\.css" \/>/);
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, '不许有内联脚本（CSP 会拦）');
});
