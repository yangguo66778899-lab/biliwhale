import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { BiliApi } from '../src/bili/api.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';

/**
 * 播放直链（看画面用，§7.10）。
 *
 * 这条请求最容易在真机上出错，而且离线拿不到真响应，所以只钉「形状」：
 * 端点、签名、关键参数、durl 解析、没有地址时给人话原因。
 */

class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  payload: unknown = { quality: 16, durl: [{ url: 'https://example.com/v.mp4' }] };

  async json<T>(req: TransportRequest): Promise<Result<T>> {
    this.calls.push(req);
    return { ok: true, data: this.payload as T };
  }

  async jsonEnvelope<T>(): Promise<Result<{ code: number; message: string; data: T }>> {
    return { ok: true, data: { code: 0, message: '0', data: this.payload as T } };
  }
}

function makeApi(): { api: BiliApi; transport: FakeTransport } {
  const dir = tmpDir('playurl');
  const logger = new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
  const transport = new FakeTransport();
  return { api: new BiliApi(transport, logger), transport };
}

test('播放直链：走 wbi 端点、要签名、参数是低清 mp4，并解析出 durl', async () => {
  const { api, transport } = makeApi();
  const res = await api.playUrl('BV1a0000001', 1001);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.url, 'https://example.com/v.mp4');
    assert.equal(res.data.quality, 16);
  }

  const call = transport.calls[0];
  assert.ok(call);
  assert.match(String(call.url), /\/x\/player\/wbi\/playurl$/);
  assert.equal(call.sign, true, '播放地址要 WBI 签名');
  assert.match(String(call.referer ?? ''), /video\/BV1a0000001/, 'referer 要是这条视频的页面');
  assert.deepEqual(
    { bvid: call.query?.bvid, cid: call.query?.cid, qn: call.query?.qn, fnval: call.query?.fnval, platform: call.query?.platform },
    { bvid: 'BV1a0000001', cid: 1001, qn: 16, fnval: 1, platform: 'pc' },
    '低清 mp4 的关键参数不能变（改了就可能拿到 DASH 或高清，白费流量）',
  );
});

test('播放直链：没有 cid 直接说清楚；接口不给 durl 也要说清楚（不返回空 url）', async () => {
  const { api, transport } = makeApi();
  const noCid = await api.playUrl('BV1a0000001', 0);
  assert.equal(noCid.ok, false);
  assert.match(noCid.ok === false ? noCid.error.message : '', /cid/);
  assert.equal(transport.calls.length, 0, '没有 cid 就不发请求');

  transport.payload = { quality: 16, durl: [] };
  const empty = await api.playUrl('BV1a0000001', 1001);
  assert.equal(empty.ok, false);
  assert.match(empty.ok === false ? empty.error.message : '', /播放地址/);
});
