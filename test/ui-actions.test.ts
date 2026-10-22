import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describeConfig } from '../src/config/describe.ts';
import { buildDefaults } from '../src/config/validate.ts';

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
  disabled: boolean;
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
    disabled: false,
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
  body: Node;
}

async function loadPanel(hash = '#/account', extra: Record<string, unknown> = {}): Promise<Harness> {
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
  Object.assign(responses, extra);

  const fetchStub = async (input: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const key = String(input).split('?')[0] ?? '';
    calls.push({ url: key, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const body = responses[key] ?? { ok: true, message: 'ok' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const bodyNode = makeNode('body');
  const sandbox: Record<string, unknown> = {
    console: { log: () => undefined, warn: () => undefined, error: (...args: unknown[]) => errors.push(args.join(' ')) },
    document: {
      createElement: (tag: string) => makeNode(tag),
      createTextNode: (text: string) => ({ textContent: text }),
      querySelector: (selector: string) => get(selector),
      querySelectorAll: (selector: string) => (selector === '.panel' ? [get('#panel-account'), get('#panel-overview')] : []),
      body: bodyNode,
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
  return { bySelector, calls, errors, body: bodyNode };
}

/** 真实的 /api/config：分组元数据来自 spec（不手写一份，避免和实现走偏）。 */
function realConfigResponse(): Record<string, unknown> {
  return {
    ok: true,
    config: buildDefaults(),
    groups: describeConfig(),
    defaults: {},
    issues: [],
    examples: {
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/example',
      command: 'C:\\Tools\\notify.exe',
      commandArgs: '--title BiliWhale',
    },
  };
}

async function flush(steps = 10): Promise<void> {
  for (let i = 0; i < steps; i += 1) await new Promise((resolve) => setImmediate(resolve));
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

  // 账号页现在有两组「保存」：主人卡片(保存主人) 与 cookie 卡片(保存并验证)；这里要的是后者
  const save = buttons(panel).find((button) => textOf(button).includes('保存并验证'));
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

/* ---------------- P0-2：通知渠道 ---------------- */

test('通知：主界面只露「B 站私信 / 本机日志」，看不到 webhook/command/format/template', async () => {
  const h = await loadPanel('#/settings', { '/api/config': realConfigResponse() });
  assert.deepEqual(h.errors, [], h.errors.join(' | '));
  const panel = h.bySelector.get('#panel-settings');
  assert.ok(panel);
  const text = textOf(panel);

  assert.match(text, /B 站私信/, '要有「B 站私信」这个中文渠道名');
  assert.match(text, /本机日志/, '要有「本机日志」这个中文渠道名');
  assert.match(text, /夜里别吵我/, '静默时段要说人话');
  for (const word of ['webhook', 'command', 'format', 'template', 'sendSummary', 'sendDiary', 'sendVideoInfo']) {
    assert.equal(text.includes(word), false, `面板正文里不该出现「${word}」（用户看不懂，也因此没去测）`);
  }
});

test('通知：点「发条测试」会 POST /api/notify/test，并且带上点的是哪个渠道', async () => {
  const h = await loadPanel('#/settings', { '/api/config': realConfigResponse() });
  const panel = h.bySelector.get('#panel-settings');
  assert.ok(panel);

  const isFile = (node: Node) => (node as unknown as Record<string, unknown>)['data-channel'] === 'file';
  const fileCard = findAll(panel, isFile)[0];
  assert.ok(fileCard, '找不到「本机日志」那张卡');

  const testButton = buttons(fileCard).find((button) => textOf(button).includes('发条测试'));
  assert.ok(testButton, `本机日志卡里应该有「发条测试」：${buttons(fileCard).map(textOf).join(' / ')}`);
  testButton.click();
  await flush();

  const call = h.calls.find((item) => item.url === '/api/notify/test');
  assert.ok(call, `应该请求 /api/notify/test，实际：${h.calls.map((item) => item.url).join(' / ')}`);
  assert.equal(call?.method, 'POST', '发测试是写操作（要 CSRF）');
  assert.deepEqual(call?.body, { channel: 'file' }, '要说清测的是哪个渠道');
});

test('通知：高级默认折叠不渲染；展开后是中文说明 + 可复制的例子', async () => {
  const h = await loadPanel('#/settings', { '/api/config': realConfigResponse() });
  const panel = h.bySelector.get('#panel-settings');
  assert.ok(panel);

  const details = findAll(panel, (node) => node.tagName === 'DETAILS')[0];
  assert.ok(details, '应该有「高级（一般不用改）」折叠区');
  assert.match(textOf(details), /高级/, '折叠区的标题要是人话');
  assert.equal(textOf(details).includes('自定义地址推送'), false, '没展开时不该把高级字段渲染出来');

  for (const handler of details.listeners.toggle ?? []) handler({});
  await flush(1);
  const opened = textOf(details);
  assert.match(opened, /自定义地址推送/, '展开后要有自定义地址渠道');
  assert.match(opened, /本地命令/, '展开后要有本地命令渠道');
  assert.match(opened, /飞书群机器人/, '取值要显示中文名，不是 feishu');
  assert.match(opened, /C:\\Tools\\notify\.exe/, '命令字段要给一个可复制的例子');
  for (const raw of ['generic', 'dingtalk', 'wecom', 'markdown']) {
    assert.equal(opened.includes(raw), false, `展开后也不该露出英文枚举「${raw}」`);
  }
  // 下拉框的选项文字必须是中文（例子 URL 里出现 feishu 字样不算）
  const selects = findAll(details, (node) => node.tagName === 'SELECT');
  assert.ok(selects.length > 0, '高级区应该有下拉框');
  for (const select of selects) {
    for (const option of select.children) {
      const label = textOf(option as Node);
      assert.equal(/^(generic|feishu|dingtalk|wecom|telegram|text|markdown)$/.test(label), false, `下拉选项还是英文枚举：${label}`);
    }
  }
  const copyButtons = buttons(details).filter((button) => textOf(button) === '复制');
  assert.ok(copyButtons.length > 0, '例子旁边要有「复制」按钮');
});

/* ---------------- P0-3：发动态 / 删自己的评论 ---------------- */

test('概览「本轮挑中」：点「发动态…」弹确认框，确认后 POST /api/dynamic（confirm=true）', async () => {
  const h = await loadPanel('#/overview', {
    '/api/picked': {
      ok: true,
      date: '2026-10-22',
      items: [
        {
          bvid: 'BV1pick00001',
          title: '一条视频',
          oneliner: '这条值得看',
          why: '有信息量',
          url: 'https://www.bilibili.com/video/BV1pick00001',
        },
      ],
    },
  });
  assert.deepEqual(h.errors, [], h.errors.join(' | '));
  const panel = h.bySelector.get('#panel-overview');
  assert.ok(panel);

  const dyn = buttons(panel).find((button) => textOf(button).includes('发动态'));
  assert.ok(dyn, `「本轮挑中」里应该有「发动态…」：${buttons(panel).map(textOf).join(' / ')}`);
  dyn.click();
  await flush();

  const mask = h.body.children.find((child) => String(child.className || '').includes('modal-mask'));
  assert.ok(mask, '点「发动态…」应该弹出确认框');

  const send = buttons(mask).find((button) => textOf(button).includes('确认发出去'));
  assert.ok(send, `确认框里要有「确认发出去」：${buttons(mask).map(textOf).join(' / ')}`);
  send.click();
  await flush();

  const call = h.calls.find((item) => item.url === '/api/dynamic');
  assert.ok(call, `应该 POST /api/dynamic，实际：${h.calls.map((item) => `${item.method} ${item.url}`).join(' / ')}`);
  assert.equal(call?.method, 'POST');
  const body = call?.body as { text?: string; confirm?: boolean };
  assert.equal(body.confirm, true, '必须带二次确认');
  assert.match(String(body.text), /BV1pick00001/, '文案里要带上这条视频');
});

test('待审页删评论：必须输入「删除」两个字才可点，点了才 DELETE', async () => {
  const h = await loadPanel('#/pending', {
    '/api/pending': {
      ok: true,
      count: 0,
      items: [],
      history: [],
      recent: [{ bvid: 'BV1lead00001', rpid: '778899', at: new Date().toISOString(), status: 'sent', share: true, aid: 9001 }],
    },
  });
  assert.deepEqual(h.errors, [], h.errors.join(' | '));
  const panel = h.bySelector.get('#panel-pending');
  assert.ok(panel);

  const del = buttons(panel).find((button) => textOf(button).includes('删除…'));
  assert.ok(del, `账本行旁边应该有「删除…」：${buttons(panel).map(textOf).join(' / ')}`);
  del.click();
  await flush();

  const input = findAll(panel, (node) => node.tagName === 'INPUT')[0];
  const confirm = buttons(panel).find((button) => textOf(button) === '确认删除');
  assert.ok(input, '应该有输入框');
  assert.ok(confirm, '应该有「确认删除」');
  assert.equal(confirm.disabled, true, '还没输入时不能点');

  input.value = '删';
  for (const handler of input.listeners.input ?? []) handler({});
  assert.equal(confirm.disabled, true, '只输入一个字也不能点');

  input.value = '删除';
  for (const handler of input.listeners.input ?? []) handler({});
  assert.equal(confirm.disabled, false, '输入「删除」两个字后才能点');

  confirm.click();
  await flush();
  const call = h.calls.find((item) => item.method === 'DELETE');
  assert.ok(call, `应该发 DELETE，实际：${h.calls.map((item) => `${item.method} ${item.url}`).join(' / ')}`);
  assert.match(call.url, /\/api\/comments\/BV1lead00001\/778899/);
});
