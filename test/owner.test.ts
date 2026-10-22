import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeOwner, ownerMention, resolveOwner } from '../src/account/owner.ts';
import { BiliApi } from '../src/bili/api.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';
import type { Config } from '../src/config/spec.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';

/**
 * 主人的解析规则（双账号模型的地基）。
 *
 * 真机反馈：一开始把「登录账号」当成「主人」，导致 @ 自己、私信发给自己、聊天永远不回主人。
 * 用户拍板：**必须是两个号，不做回退**。这里把规则钉住。
 */

function cfgWith(account: Partial<Config['account']>): Config {
  return { account: { mid: 4242, name: '鲸鲸', cookieRef: 'bili', ownerMid: 0, ownerName: '', ...account } } as Config;
}

test('主人：没填 ownerMid → 不可用，并告诉用户去哪填', () => {
  const owner = resolveOwner(cfgWith({}), 4242);
  assert.equal(owner.ok, false);
  assert.equal(owner.mid, 0);
  assert.match(owner.problem ?? '', /还没填主人 UID/);
  assert.equal(ownerMention(owner), null, '不可用时不能拼 @');
});

test('主人：ownerMid 等于登录账号 → 不可用（必须是另一个号）', () => {
  const owner = resolveOwner(cfgWith({ ownerMid: 4242, ownerName: '鲸鲸' }), 4242);
  assert.equal(owner.ok, false);
  assert.match(owner.problem ?? '', /不能等于登录账号/);
});

test('主人：填了另一个 UID 和昵称 → 可用，@ 用这个昵称', () => {
  const owner = resolveOwner(cfgWith({ ownerMid: 777, ownerName: '老王' }), 4242);
  assert.equal(owner.ok, true);
  assert.equal(owner.mid, 777);
  assert.equal(ownerMention(owner), '老王');
  assert.match(describeOwner(owner), /老王（777）/);
});

test('主人：昵称空着也算可用（能发私信），但 @ 不到人 → 明确提示', () => {
  const owner = resolveOwner(cfgWith({ ownerMid: 777, ownerName: '  ' }), 4242);
  assert.equal(owner.ok, true);
  assert.equal(ownerMention(owner), null);
  assert.match(owner.problem ?? '', /昵称还没填/);
  assert.match(describeOwner(owner), /昵称待填/);
});

test('主人：登录账号未知时（还没登录）也能解析', () => {
  const owner = resolveOwner(cfgWith({ ownerMid: 777, ownerName: '老王' }), 0);
  assert.equal(owner.ok, true);
  assert.equal(owner.mid, 777);
});

/* ---------------- 按 UID 取昵称（用于自动补全，取不到就让用户手填） ---------------- */

class CardTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  private readonly payload: { code: number; message: string; data: unknown };
  constructor(payload: { code: number; message: string; data: unknown }) {
    this.payload = payload;
  }
  async json<T>(req: TransportRequest): Promise<Result<T>> {
    this.calls.push(req);
    return { ok: true, data: this.payload.data as T };
  }
  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<{ code: number; message: string; data: T }>> {
    this.calls.push(req);
    return { ok: true, data: this.payload as { code: number; message: string; data: T } };
  }
}

function biliWith(payload: { code: number; message: string; data: unknown }): { api: BiliApi; transport: CardTransport } {
  const logger = new Logger({ logDir: tmpDir('owner-log'), eventsFile: `${tmpDir('owner-log')}/e.jsonl`, level: 'error' });
  const transport = new CardTransport(payload);
  return { api: new BiliApi(transport, logger), transport };
}

test('按 UID 取昵称：名片里有名字就用，mid 用服务端返回的', async () => {
  const { api, transport } = biliWith({ code: 0, message: '0', data: { card: { mid: '777', name: '  老王  ' } } });
  const res = await api.userCard(777);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data, { mid: 777, name: '老王' });
  assert.match(String(transport.calls[0]?.url ?? ''), /\/x\/web-interface\/card/);
});

test('按 UID 取昵称：名片里没有名字 → 报错（让用户手填，不瞎猜）', async () => {
  const { api } = biliWith({ code: 0, message: '0', data: { card: { mid: 777 } } });
  const res = await api.userCard(777);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error.message, /没有昵称/);
});

test('按 UID 取昵称：UID 不合法 → 直接拒绝，不发请求', async () => {
  const { api, transport } = biliWith({ code: 0, message: '0', data: {} });
  const res = await api.userCard(0);
  assert.equal(res.ok, false);
  assert.equal(transport.calls.length, 0);
});
