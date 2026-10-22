import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * 面板「点了有没有用」的测试。
 *
 * 为什么需要：`ui-smoke` 只渲染页面，`addEventListener` 是空实现——所以「按钮点了没反应」这类 bug
 * 它一个都抓不到（真机上就踩到了：账号页要求点「扫码登录」，点了没反应）。
 * 这里给 DOM stub 装上事件记录，然后**真的派发 click**，断言随后的请求与界面变化。
 */

interface Node {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  innerHTML: string;
  value: string;
  checked: boolean;
  children: Node[];
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  classList: { add: (name: string) => void; remove: (name: string) => void; toggle: (name: string, on: boolean) => void; contains: (name: string) => boolean };
  appendChild: (child: Node) => Node;
  removeChild: (child: Node) => void;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (name: string, handler: (...args: unknown[]) => void) => void;
  click: () => void;
  remove: () => void;
  querySelector: () => null;
  querySelectorAll: () => [];
}

function makeNode(tagName: string): Node {
  const classes = new Set<string>();
  const node: Node = {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    children: [],
    listeners: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter((item) => item !== child);
    },
    setAttribute(name, value) {
      if (name === 'id') node.id = value;
      if (name === 'class') node.className = value;
      (node as unknown as Record<string, unknown>)[name] = value;
    },
    addEventListener(name, handler) {
      (node.listeners[name] ??= []).push(handler);
    },
    click() {
      for (const handler of node.listeners.click ?? []) handler({});
    },
    remove() {
      /* noop */
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return node;
}

function textOf(node: Node): string {
  if (node.textContent) return node.textContent;
  return (node.children ?? []).map((child) => (typeof child === 'string' ? child : textOf(child as Node))).join('');
}

function findAll(root: Node, predicate: (node: Node) => boolean, out: Node[] = []): Node[] {
  if (!root || typeof root !== 'object' || !Array.isArray(root.children)) return out;
  if (predicate(root)) out.push(root);
  for (const child of root.children) {
    if (!child || typeof child !== 'object') continue;
    findAll(child as Node, predicate, out);
  }
  return out;
}

interface Harness {
  bySelector: Map<string, Node>;
  calls: Array<{ url: string; method: string; body?: unknown }>;
  errors: string[];
}

async function loadPanel(hash = '#/account'): Promise<Harness> {
  const script = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const bySelector = new Map<string, Node>();
  const calls: Harness['calls'] = [];
  const errors: string[] = [];

  const get = (selector: string): Node => {
    const existing = bySelector.get(selector);
    if (existing) return existing;
    const created = makeNode(selector.includes('panel') ? 'section' : 'div');
    bySelector.set(selector, created);
    return created;
  };

  const now = new Date().toISOString();
  const responses: Record<string, unknown> = {
    '/api/session': { ok: true, csrfToken: 'csrf', version: 'test' },
    '/api/account': { ok: true, loggedIn: false, fingerprint: '未登录', note: '只存本机' },
    '/api/account/qr': { ok: true, key: 'k1', url: 'https://example.com/qr', rows: ['111', '101', '111'], size: 3, expiresInSec: 170 },
    '/api/account/qr/poll': { ok: true, state: 'waiting', message: '还没扫码' },
    '/api/status': {
      ok: true,
      scheduler: { plan: '', paused: false, nextWakeAt: null, planSource: null },
      lastRun: null,
      today: { wakes: 0, targetWakes: 0, shares: 0, shareCap: 0, tokens: 0, costCny: 0 },
      account: { loggedIn: false },
      model: { configured: 'x', actual: 'x', discoveredAt: null },
      pending: { count: 0 },
      warnings: [],
    },
    '/api/doctor': { ok: true, report: { healthy: true, dataDir: 'D:/d', rows: [] } },
    '/api/config': {
      ok: true,
      config: { share: { enabled: false, minScore: 13 }, safety: { writeEnabled: true, dryRun: false } },
      groups: [
        {
          key: 'share',
          label: '分享',
          fields: [
            { path: 'share.enabled', relPath: 'enabled', label: '允许对外分享', widget: 'boolean', kind: 'boolean', default: false },
            { path: 'share.minScore', relPath: 'minScore', label: '分享分数门槛', widget: 'number', kind: 'number', default: 13, min: 0, max: 20, int: true },
          ],
        },
        {
          key: 'safety',
          label: '安全',
          fields: [{ path: 'safety.dryRun', relPath: 'dryRun', label: '一律预演', widget: 'boolean', kind: 'boolean', default: false }],
        },
      ],
      defaults: {},
      issues: [],
    },
    '/api/secrets': { ok: true, hasApiKey: false, fingerprint: '', source: 'none' },
    '/api/pending': {
      ok: true,
      count: 1,
      items: [
        {
          id: 'p1',
          createdAt: now,
          expiresAt: now,
          bvid: 'BV1pend1',
          root: '100',
          parent: '200',
          target: { mid: 888, uname: '路人甲' },
          sourceComment: '这条我也喜欢',
          draft: '我也这么觉得',
          timesReplied: 1,
        },
      ],
      history: [],
    },
    '/api/logs': { ok: true, events: [] },
  };

  const fetchStub = async (input: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const key = String(input).split('?')[0] ?? '';
    calls.push({ url: key, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const body = responses[key] ?? { ok: true, message: 'ok' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const sandbox: Record<string, unknown> = {
    console: { log: () => undefined, warn: () => undefined, error: (...args: unknown[]) => errors.push(args.join(' ')) },
    document: {
      createElement: (tag: string) => makeNode(tag),
      createTextNode: (text: string) => ({ textContent: text }),
      querySelector: (selector: string) => get(selector),
      querySelectorAll: (selector: string) => (selector === '.panel' ? [get('#panel-account'), get('#panel-overview')] : []),
      body: makeNode('body'),
    },
    window: { addEventListener: () => undefined },
    location: { hash, search: '', pathname: '/' },
    history: { replaceState: () => undefined },
    sessionStorage: {
      getItem: (key: string): string | null => (key === 'bw_token' ? null : null),
      setItem: () => undefined,
    },
    fetch: fetchStub,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    confirm: () => true,
    prompt: () => '',
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
    Error,
    isNaN,
    parseInt,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(script, sandbox, { filename: 'app.js' });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return { bySelector, calls, errors };
}

function buttons(root: Node): Node[] {
  return findAll(root, (node) => node.tagName === 'BUTTON');
}

test('账号页：没登录时自动生成二维码（不需要点任何按钮）', async () => {
  const h = await loadPanel();
  assert.deepEqual(h.errors, [], `面板报错：${h.errors.join(' | ')}`);

  const qrCalls = h.calls.filter((call) => call.url === '/api/account/qr');
  assert.equal(qrCalls.length, 1, '进入账号页就该自动请求一次二维码（真机 bug：以前必须点按钮，而按钮点了没反应）');
  assert.equal(qrCalls[0]?.method, 'POST', '生成二维码是写操作（要 CSRF）');

  const box = h.bySelector.get('#qr-box');
  assert.ok(box, '应该有二维码容器');
  assert.match(box.innerHTML, /<svg/, '二维码要真的画进容器里');
});

test('账号页：点「刷新二维码」会重新请求并重画', async () => {
  const h = await loadPanel();
  const panel = h.bySelector.get('#panel-account');
  assert.ok(panel);

  const refresh = buttons(panel).find((button) => textOf(button).includes('二维码'));
  assert.ok(refresh, `找不到二维码按钮，实际按钮：${buttons(panel).map(textOf).join(' / ')}`);

  const before = h.calls.filter((call) => call.url === '/api/account/qr').length;
  refresh.click();
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const after = h.calls.filter((call) => call.url === '/api/account/qr').length;
  assert.equal(after, before + 1, '点一次应该多一次请求');
});

test('账号页：粘贴 cookie 会打 /api/account/cookie', async () => {
  const h = await loadPanel();
  const panel = h.bySelector.get('#panel-account');
  assert.ok(panel);

  const save = buttons(panel).find((button) => textOf(button).includes('保存'));
  assert.ok(save, `找不到保存按钮：${buttons(panel).map(textOf).join(' / ')}`);
  save.click();
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    h.calls.some((call) => call.url === '/api/account/cookie' && call.method === 'POST'),
    '应该请求 /api/account/cookie',
  );
});

test('设置页：填 DeepSeek key 后点「保存并验证」会 PUT /api/secrets/llm', async () => {
  const h = await loadPanel('#/settings');
  assert.deepEqual(h.errors, [], h.errors.join(' | '));
  const panel = h.bySelector.get('#panel-settings');
  assert.ok(panel);

  const inputs = findAll(panel, (node) => node.tagName === 'INPUT');
  assert.ok(inputs.length > 0, '设置页应该有输入框');
  const keyInput = inputs[0] as Node & { value: string };
  keyInput.value = 'sk-test-0123456789abcdef';

  const save = buttons(panel).find((button) => textOf(button).includes('保存并验证'));
  assert.ok(save, `找不到「保存并验证」：${buttons(panel).map(textOf).join(' / ')}`);
  save.click();
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

  const call = h.calls.find((item) => item.url === '/api/secrets/llm');
  assert.ok(call, `应该 PUT /api/secrets/llm，实际：${h.calls.map((item) => `${item.method} ${item.url}`).join(' / ')}`);
  assert.equal(call?.method, 'PUT');
  assert.deepEqual(call?.body, { apiKey: 'sk-test-0123456789abcdef' }, '要把输入框里的 key 发出去');
});

test('设置页：勾上「允许对外分享」再保存，PUT 的配置里 share.enabled 必须是 true', async () => {
  const h = await loadPanel('#/settings');
  assert.deepEqual(h.errors, []);
  const panel = h.bySelector.get('#panel-settings');
  assert.ok(panel);

  // 找到那个开关（字段上带 data-field=绝对路径，正好也方便测试定位）
  const checkbox = findAll(panel, (node) => node.tagName === 'INPUT' && (node as unknown as Record<string, unknown>)['data-field'] === 'share.enabled')[0];
  assert.ok(checkbox, '找不到 share.enabled 的勾选框');

  checkbox.checked = true;
  for (const handler of checkbox.listeners.change ?? []) handler({});
  assert.equal(checkbox.checked, true);

  const save = buttons(panel).find((button) => textOf(button) === '保存');
  assert.ok(save, `找不到保存按钮：${buttons(panel).map(textOf).join(' / ')}`);
  save.click();
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

  const put = h.calls.find((call) => call.url === '/api/config' && call.method === 'PUT');
  assert.ok(put, `应该 PUT /api/config，实际请求：${JSON.stringify(h.calls)}`);
  // 面板是把整份配置直接 PUT 上去的（不带 {config} 包装）
  const body = put.body as Record<string, unknown> | undefined;
  const share = (body?.share ?? {}) as { enabled?: boolean };
  assert.equal(share.enabled, true, `开关必须写进 share.enabled，实际：${JSON.stringify(body)}`);
  // 别再写出顶层垃圾字段（这正是之前的 bug）
  assert.equal(body?.enabled, undefined);
});

test('概览页：预演一轮 → dryRun=true，现在跑一轮 → dryRun=false', async () => {
  const h = await loadPanel('#/overview');
  assert.deepEqual(h.errors, [], h.errors.join(' | '));
  const panel = h.bySelector.get('#panel-overview');
  assert.ok(panel);

  const labels = buttons(panel).map(textOf);
  const dry = buttons(panel).find((button) => textOf(button).includes('预演'));
  const real = buttons(panel).find((button) => textOf(button).includes('现在跑一轮'));
  assert.ok(dry, `找不到「预演一轮」，实际按钮：${labels.join(' / ')}`);
  assert.ok(real, `找不到「现在跑一轮」，实际按钮：${labels.join(' / ')}`);

  dry.click();
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  real.click();
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));

  const runs = h.calls.filter((call) => call.url === '/api/run');
  assert.equal(runs.length, 2, '两个按钮各发一次 /api/run');
  assert.deepEqual(runs[0]?.body, { dryRun: true }, '预演必须是 dryRun=true');
  assert.deepEqual(runs[1]?.body, { dryRun: false }, '真跑必须是 dryRun=false');
});

test('待审页：有草稿时「发」会打 approve，「不发」会打 reject', async () => {
  const h = await loadPanel('#/pending');
  assert.deepEqual(h.errors, []);
  const panel = h.bySelector.get('#panel-pending');
  assert.ok(panel);

  const approve = buttons(panel).find((button) => textOf(button) === '发');
  assert.ok(approve, `找不到「发」按钮：${buttons(panel).map(textOf).join(' / ')}`);
  approve.click();
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    h.calls.some((call) => call.url.includes('/api/pending/') && call.url.endsWith('/approve')),
    '应该请求 approve',
  );

  const reject = buttons(panel).find((button) => textOf(button) === '不发');
  assert.ok(reject, '找不到「不发」按钮');
  reject.click();
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    h.calls.some((call) => call.url.includes('/api/pending/') && call.url.endsWith('/reject')),
    '应该请求 reject',
  );
});
