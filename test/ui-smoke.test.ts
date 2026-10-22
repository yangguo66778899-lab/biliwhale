import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * 面板脚本的「真跑一遍」测试。
 *
 * 为什么需要：`node --check` 只能查语法，查不到「调了一个不存在的函数」这类错误；
 * 而面板是本项目唯一一块没有类型检查的代码（浏览器 JS）。
 * 做法：用最小 DOM stub 在 vm 里执行 app.js，逐页触发渲染，断言页面有东西、且没有未处理的异常。
 */

interface FakeElement {
  tagName: string;
  className: string;
  id: string;
  textContent: string;
  innerHTML: string;
  value: string;
  checked: boolean;
  hidden: boolean;
  disabled: boolean;
  children: FakeElement[];
  dataset: Record<string, string>;
  classList: { add: (name: string) => void; remove: (name: string) => void; toggle: (name: string, on: boolean) => void; contains: (name: string) => boolean };
  appendChild: (child: FakeElement) => FakeElement;
  removeChild: (child: FakeElement) => void;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (name: string, handler: (...args: unknown[]) => void) => void;
  remove: () => void;
  click: () => void;
  querySelector: (sel: string) => FakeElement | null;
  querySelectorAll: (sel: string) => FakeElement[];
}

function makeElement(tagName: string): FakeElement {
  const classes = new Set<string>();
  const element: FakeElement = {
    tagName: tagName.toUpperCase(),
    className: '',
    id: '',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    children: [],
    dataset: {},
    classList: {
      add: (name) => {
        classes.add(name);
      },
      remove: (name) => {
        classes.delete(name);
      },
      toggle: (name, on) => {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      element.children = element.children.filter((item) => item !== child);
    },
    setAttribute(name, value) {
      if (name === 'id') element.id = value;
      if (name === 'class') element.className = value;
      (element as unknown as Record<string, unknown>)[name] = value;
    },
    addEventListener() {
      /* 事件不触发，只要求不报错 */
    },
    remove() {
      /* noop */
    },
    click() {
      /* noop */
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return element;
}

interface RenderResult {
  panelChildren: number;
  panelHtml: string;
  errors: string[];
}

const ROUTES = ['overview', 'settings', 'account', 'reports', 'diaries', 'logs', 'about'] as const;

async function renderPage(route: string): Promise<RenderResult> {
  const script = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const bySelector = new Map<string, FakeElement>();
  const errors: string[] = [];

  const get = (selector: string): FakeElement => {
    const existing = bySelector.get(selector);
    if (existing) return existing;
    const created = makeElement(selector.includes('panel') ? 'section' : 'div');
    bySelector.set(selector, created);
    return created;
  };

  const now = new Date().toISOString();
  const responses: Record<string, unknown> = {
    '/api/session': { ok: true, csrfToken: 'csrf', version: 'test' },
    '/api/status': {
      ok: true,
      scheduler: { plan: '今天醒 2 次，下一次 20:30', paused: false, nextWakeAt: now, planSource: null },
      lastRun: { id: 'r1', status: 'ok', endedAt: now, tokens: 1200 },
      today: { wakes: 1, targetWakes: 2, shares: 0, shareCap: 3, tokens: 1200, costCny: 0.01 },
      account: { loggedIn: false },
      model: { configured: 'deepseek-flash', actual: 'deepseek-flash', discoveredAt: null },
      warnings: ['还没有登录 B 站'],
    },
    '/api/doctor': { ok: true, report: { healthy: true, dataDir: 'D:/data', rows: [{ name: 'Node 版本', level: 'ok', detail: 'v24' }] } },
    '/api/logs': { ok: true, events: [{ at: now, level: 'info', target: 'daemon', note: '启动' }] },
    '/api/config': {
      ok: true,
      config: { ui: { port: 8787, theme: 'auto' }, report: { level: 'full' } },
      groups: [
        {
          key: 'ui',
          label: '面板',
          fields: [
            { path: 'ui.port', label: '端口', widget: 'number', kind: 'number', default: 8787, min: 1, max: 65535, int: true },
            { path: 'ui.theme', label: '主题', widget: 'enum', kind: 'enum', default: 'auto', values: ['auto', 'light', 'dark'] },
          ],
        },
        {
          key: 'report',
          label: '日报',
          fields: [{ path: 'report.level', label: '档位', widget: 'enum', kind: 'enum', default: 'full', values: ['full', 'brief'] }],
        },
      ],
      defaults: {},
      issues: [],
    },
    '/api/account': { ok: true, loggedIn: false, fingerprint: '未登录', note: '只存本机' },
    '/api/account/qr': { ok: true, key: 'k', url: 'https://example.com/qr', rows: ['111', '101', '111'], size: 3, expiresInSec: 170 },
    '/api/reports': { ok: true, items: [{ date: '2026-10-21', size: 120 }] },
    '/api/reports/2026-10-21': { ok: true, date: '2026-10-21', markdown: '# 报告\n\n今天看了两条。' },
    '/api/diaries': { ok: true, items: [{ date: '2026-10-21', size: 80 }] },
    '/api/diaries/public/2026-10-21': { ok: true, date: '2026-10-21', markdown: '# 日记\n\n写点东西。' },
    '/api/diaries/private/2026-10-21': { ok: true, date: '2026-10-21', markdown: '# 私人\n\n心里话。' },
    '/api/models': { ok: true, configured: 'deepseek-flash', actual: 'deepseek-flash', budget: { tokens: 1200, calls: 2 } },
    '/api/run': { ok: true, message: '已开始' },
  };

  const fetchStub = async (input: string): Promise<unknown> => {
    const key = String(input).split('?')[0] ?? '';
    const body = responses[key] ?? { ok: true, message: 'ok' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const store = new Map<string, string>();
  const sessionStorageStub = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
  };

  const sandbox: Record<string, unknown> = {
    console: { log: () => undefined, warn: () => undefined, error: (...args: unknown[]) => errors.push(args.join(' ')) },
    document: {
      createElement: (tag: string) => makeElement(tag),
      createTextNode: (text: string) => ({ textContent: text }),
      querySelector: (selector: string) => get(selector),
      querySelectorAll: (selector: string) => (selector === '.panel' ? ROUTES.map((route) => get(`#panel-${route}`)) : []),
      body: makeElement('body'),
    },
    window: {
      addEventListener: () => undefined,
      location: { hash: `#/${route}`, search: '?token=abc', pathname: '/' },
    },
    location: { hash: `#/${route}`, search: '?token=abc', pathname: '/' },
    history: { replaceState: () => undefined },
    sessionStorage: sessionStorageStub,
    fetch: fetchStub,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: (fn: () => void) => {
      void fn;
      return 0;
    },
    clearTimeout: () => undefined,
    confirm: () => true,
    URLSearchParams,
    URL,
    encodeURIComponent,
    JSON,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    TextEncoder,
    Error,
    isNaN,
    parseInt,
  };
  sandbox.globalThis = sandbox;

  const rejections: string[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(String(reason));
  };
  process.on('unhandledRejection', onRejection);
  try {
    vm.runInNewContext(script, sandbox, { filename: 'app.js' });
    // 让 boot() 里的 await 链跑完（fetch stub 是同步 resolve）
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }

  const panel = bySelector.get(`#panel-${route}`);
  return {
    panelChildren: panel ? panel.children.length : 0,
    panelHtml: panel ? panel.innerHTML : '',
    errors: [...errors, ...rejections],
  };
}

test('七个页面都能渲染，且没有未处理异常（用 DOM stub 真跑 app.js）', async () => {
  for (const route of ROUTES) {
    const result = await renderPage(route);
    assert.deepEqual(result.errors, [], `${route} 页有异常：${result.errors.join(' | ')}`);
    assert.ok(
      result.panelChildren > 0 || result.panelHtml.length > 0,
      `${route} 页渲染后是空的（说明渲染函数没把内容放进去）`,
    );
  }
});

test('概览页把关键状态都画出来了（状态/下一次/今日/按钮）', async () => {
  const result = await renderPage('overview');
  assert.deepEqual(result.errors, []);
  // 概览的卡片是 appendChild 进去的：至少有「状态」卡 + 体检卡 + 事件卡
  assert.ok(result.panelChildren >= 3, `概览应该有多张卡片，实际 ${result.panelChildren}`);
});

test('设置页渲染出分组字段（来自 /api/config 的元数据）', async () => {
  const result = await renderPage('settings');
  assert.deepEqual(result.errors, []);
  assert.ok(result.panelChildren >= 3, '设置页应该有操作卡 + 至少两个分组卡');
});
