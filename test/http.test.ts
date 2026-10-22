import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Logger } from '../src/shared/logger.ts';
import { BiliHttp, parseEnvelope, unwrapBiliEnvelope } from '../src/bili/http.ts';
import { BiliApi } from '../src/bili/api.ts';
import { tmpDir } from './helpers.ts';

function quietLogger(dir: string): Logger {
  return new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';

/** 一个能应答 nav / 搜索 / 视频 / 评论的假 B 站。 */
function fakeBili(
  opts: { navCode?: number } = {},
): { fetchImpl: (input: string, init?: RequestInit) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input);
    const url = input;
    if (url.includes('/x/web-interface/nav')) {
      return jsonResponse({
        code: opts.navCode ?? -101,
        message: opts.navCode === 0 ? '0' : '账号未登录',
        // 关键：未登录时 B 站仍然给 wbi_img，签名材料必须能从这里拿到
        data: {
          isLogin: opts.navCode === 0,
          mid: opts.navCode === 0 ? 123 : 0,
          uname: opts.navCode === 0 ? '测试' : '',
          wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png` },
        },
      });
    }
    if (url.includes('/wbi/search/type')) {
      return jsonResponse({ code: 0, message: '0', data: { result: [{ bvid: 'BV1a0000001', title: '<em>猫</em>', duration: '01:00', pubdate: 1750000000 }] } });
    }
    if (url.includes('/x/web-interface/view')) {
      return jsonResponse({ code: 0, message: '0', data: { bvid: 'BV1a0000001', aid: 1, cid: 2, title: 't', desc: 'd', duration: 60, pubdate: 1750000000, owner: { mid: 1, name: 'u' }, stat: {}, pages: [] } });
    }
    return jsonResponse({ code: -404, message: '啥', data: null });
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('parseEnvelope 保留 code 与 data（nav 的 -101 里有 wbi 材料）', () => {
  const env = parseEnvelope<{ isLogin: boolean; wbi_img: { img_url: string } }>(
    JSON.stringify({ code: -101, message: '账号未登录', data: { isLogin: false, wbi_img: { img_url: 'x' } } }),
  );
  assert.equal(env.ok, true);
  if (!env.ok) return;
  assert.equal(env.data.code, -101);
  assert.equal(env.data.data.isLogin, false);
  assert.equal(env.data.data.wbi_img.img_url, 'x');

  const notJson = parseEnvelope('<html>412</html>');
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.equal(notJson.error.kind, 'parse');
});

test('unwrapBiliEnvelope 仍然把 code!=0 当错误（普通接口用）', () => {
  const bad = unwrapBiliEnvelope({ code: -101, message: '账号未登录', data: null });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.kind, 'auth');
  const good = unwrapBiliEnvelope({ code: 0, message: '0', data: { a: 1 } });
  assert.equal(good.ok, true);
});

test('匿名 nav 也能拿到签名材料（nav 返回 -101 不算失败）', async () => {
  const dir = tmpDir('nav');
  const logger = quietLogger(dir);
  const fake = fakeBili({ navCode: -101 });
  const http = new BiliHttp({ cookie: '', logger, fetchImpl: fake.fetchImpl as never, sleep: async () => undefined, readIntervalMs: 0, retries: 0 });
  const api = new BiliApi(http, logger);

  const nav = await api.nav();
  assert.equal(nav.ok, true, '未登录的 nav 也要能读出 wbi_img');
  if (nav.ok) {
    assert.equal(nav.data.isLogin, false);
    assert.ok(nav.data.imgUrl.includes(IMG_KEY));
  }
  const mixin = await api.mixin();
  assert.equal(mixin.ok, true);
  if (mixin.ok) assert.equal(mixin.data.length, 32);
});

test('签名请求不会在队列里自锁：先取 nav，再发带 w_rid 的请求', async () => {
  const dir = tmpDir('queue');
  const logger = quietLogger(dir);
  const fake = fakeBili();
  const http = new BiliHttp({ cookie: '', logger, fetchImpl: fake.fetchImpl as never, sleep: async () => undefined, readIntervalMs: 0, retries: 0 });
  const api = new BiliApi(http, logger);
  http.useSigner(api);

  const search = await api.searchVideos('猫', { order: 'pubdate', page: 1 });
  assert.equal(search.ok, true, `搜索应成功：${search.ok ? '' : search.error.message}`);

  const navCalls = fake.calls.filter((c) => c.includes('/nav'));
  assert.equal(navCalls.length, 1, '签名材料只取一次（之后走缓存）');
  const searchCall = fake.calls.find((c) => c.includes('/wbi/search/type'));
  assert.ok(searchCall, '应该发出搜索请求');
  assert.match(searchCall ?? '', /[?&]wts=\d+/);
  assert.match(searchCall ?? '', /&w_rid=[0-9a-f]{32}/);
});

test('mixin 命中缓存后不再重复取 nav', async () => {
  const dir = tmpDir('cache');
  const logger = quietLogger(dir);
  const fake = fakeBili();
  const http = new BiliHttp({ cookie: '', logger, fetchImpl: fake.fetchImpl as never, sleep: async () => undefined, readIntervalMs: 0, retries: 0 });
  const api = new BiliApi(http, logger);
  http.useSigner(api);

  await api.searchVideos('猫');
  await api.searchVideos('猫');
  assert.equal(fake.calls.filter((c) => c.includes('/nav')).length, 1);
});

test('网络错误按可重试性分类，risk 会触发 onRisk', async () => {
  const dir = tmpDir('errors');
  const logger = quietLogger(dir);
  const riskReasons: string[] = [];
  let calls = 0;
  const http = new BiliHttp({
    cookie: '',
    logger,
    fetchImpl: (async () => {
      calls += 1;
      return new Response('blocked', { status: 412 });
    }) as never,
    sleep: async () => undefined,
    readIntervalMs: 0,
    retries: 3,
    onRisk: (message) => riskReasons.push(message),
  });

  const res = await http.json({ url: 'https://api.bilibili.com/x/web-interface/view' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.kind, 'risk');
  assert.equal(calls, 1, 'risk 不重试');
  assert.equal(riskReasons.length, 1);

  // 5xx 会重试，最终仍然失败
  let attempts = 0;
  const http2 = new BiliHttp({
    cookie: '',
    logger,
    fetchImpl: (async () => {
      attempts += 1;
      return new Response('boom', { status: 503 });
    }) as never,
    sleep: async () => undefined,
    readIntervalMs: 0,
    retries: 2,
  });
  const res2 = await http2.json({ url: 'https://api.bilibili.com/x/web-interface/view' });
  assert.equal(res2.ok, false);
  if (!res2.ok) assert.equal(res2.error.kind, 'network');
  assert.equal(attempts, 3, '1 次 + 2 次重试');
});

test('字幕 CDN 的原始文本请求走同一条队列', async () => {
  const dir = tmpDir('subtext');
  const logger = quietLogger(dir);
  const http = new BiliHttp({
    cookie: '',
    logger,
    fetchImpl: (async () => new Response(JSON.stringify({ body: [{ from: 0, to: 1, content: '一句话' }] }), { status: 200 })) as never,
    sleep: async () => undefined,
    readIntervalMs: 0,
    retries: 0,
  });
  const api = new BiliApi(http, logger);
  const cues = await api.subtitleCues('https://aisubtitle.hdslb.com/bfs/subtitle/x.json?auth_key=k', 'BV1a0000001');
  assert.equal(cues.ok, true);
  if (cues.ok) assert.equal(cues.data[0]?.content, '一句话');
});
