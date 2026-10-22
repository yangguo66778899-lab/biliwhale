import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIXIN_TAB, keyFromUrl, mixinFromKeys, mixinFromUrls, signedQuery, wbiTimestamp } from '../src/bili/wbi.ts';

const CHARSET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
/** 用 charset 当「64 字符原始串」时，按 MIXIN_TAB 重排 + 取前 32 位应得的结果（锁死常量，防止有人手抖改表）。 */
const EXPECTED_MIXIN = 'KLi2R8nwfOavW3JzrH5Nx9GjtseDcCFd';

test('MIXIN_TAB 是 64 个 0–63 的下标且无重复', () => {
  assert.equal(MIXIN_TAB.length, 64);
  const sorted = [...MIXIN_TAB].sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: 64 }, (_, i) => i));
});

test('keyFromUrl 取文件名主干', () => {
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), '7cd084941338484aae1ad9425b84077c');
  assert.equal(keyFromUrl('4932caff0ff746eab6f01bf08b70ac45'), '4932caff0ff746eab6f01bf08b70ac45');
  assert.equal(keyFromUrl(''), '');
});

test('mixinFromKeys 按 MIXIN_TAB 重排并取 32 位', () => {
  assert.equal(mixinFromKeys(CHARSET.slice(0, 32), CHARSET.slice(32)), EXPECTED_MIXIN);
  assert.equal(mixinFromKeys(CHARSET.slice(0, 32), CHARSET.slice(32)).length, 32);
  // 材料不全 → 空串（调用方据此不签名）
  assert.equal(mixinFromKeys('', ''), '');
  assert.equal(mixinFromKeys('short', CHARSET.slice(32)), '');
});

test('mixinFromUrls 与 mixinFromKeys 走同一条路径', () => {
  // 用 URL 安全字符，避免 '/' 干扰文件名主干提取
  const safe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_abcdefghijklmnopqrstuvwxyz';
  const imgKey = safe.slice(0, 32);
  const subKey = safe.slice(32);
  const imgUrl = `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`;
  const subUrl = `https://i0.hdslb.com/bfs/wbi/${subKey}.png`;
  assert.equal(mixinFromUrls(imgUrl, subUrl), mixinFromKeys(imgKey, subKey));
  assert.equal(mixinFromUrls(imgUrl, subUrl).length, 32);
  assert.equal(mixinFromUrls('', ''), '');
});

test('signedQuery 与参考实现逐字一致（排序 / 去特殊字符 / md5 小写）', () => {
  const query = signedQuery({ keyword: 'AI 工具', page: 1, search_type: 'video' }, EXPECTED_MIXIN, 1750000000);
  assert.equal(
    query,
    'keyword=AI%20%E5%B7%A5%E5%85%B7&page=1&search_type=video&wts=1750000000&w_rid=a00ed62400f22f5e718987b6883635f2',
  );
  // w_rid 永远在最后
  assert.ok(query.endsWith(`&w_rid=${query.split('w_rid=')[1]}`));
});

test('signedQuery 先删 !\'()* 再 encode', () => {
  const query = signedQuery({ a: "x!'()*y" }, EXPECTED_MIXIN, 1750000000);
  // 五个特殊字符被删掉，剩下 x y
  assert.ok(query.startsWith('a=xy&'));
});

test('signedQuery 忽略 undefined，且缺省参数不影响其它参数', () => {
  const withUndef = signedQuery({ a: '1', b: undefined }, EXPECTED_MIXIN, 1750000000);
  const without = signedQuery({ a: '1' }, EXPECTED_MIXIN, 1750000000);
  assert.equal(withUndef, without);
});

test('wbiTimestamp 是秒级', () => {
  assert.equal(wbiTimestamp(1750000000123), 1750000000);
});
