import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { LoginService, parseSetCookies } from '../src/account/login.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';
import type { RawResponse, Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';

interface Canned {
  status?: number;
  body: string;
  setCookies?: string[];
}

/** 假传输层：按 URL 给预置响应，并记下每次请求。 */
class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  readonly byPath = new Map<string, Canned>();
  verifyResult: { isLogin: boolean; mid: number; uname: string } = { isLogin: false, mid: 0, uname: '' };
  verifyThrows = false;

  put(match: string, canned: Canned): this {
    this.byPath.set(match, canned);
    return this;
  }

  private find(url: string): Canned {
    for (const [match, canned] of this.byPath) {
      if (url.includes(match)) return canned;
    }
    return { status: 404, body: '{"code":-404,"message":"no canned response"}' };
  }

  async raw(req: TransportRequest): Promise<Result<RawResponse>> {
    this.calls.push(req);
    const canned = this.find(req.url);
    const status = canned.status ?? 200;
    if (status >= 400) {
      return { ok: false, error: { kind: 'network', code: status, message: `HTTP ${status}` } };
    }
    return {
      ok: true,
      data: { status, headers: {}, setCookies: canned.setCookies ?? [], body: canned.body },
    };
  }

  async json<T>(req: TransportRequest): Promise<Result<T>> {
    const raw = await this.raw(req);
    if (!raw.ok) return raw;
    return { ok: true, data: JSON.parse(raw.data.body) as T };
  }

  async jsonEnvelope<T>(req: TransportRequest) {
    return this.json<{ code: number; message: string; data: T }>(req);
  }
}

function makeService(): { login: LoginService; secrets: SecretsService; transport: FakeTransport; dir: string } {
  const dir = tmpDir('login');
  const logger = new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
  const secrets = new SecretsService(dir, logger);
  const transport = new FakeTransport();
  const login = new LoginService({
    http: transport,
    secrets,
    logger,
    verify: async () => {
      if (transport.verifyThrows) return { ok: false, error: { kind: 'network', code: 'network', message: '网络断了' } };
      return { ok: true, data: transport.verifyResult };
    },
  });
  return { login, secrets, transport, dir };
}

const GENERATE_OK = '{"code":0,"data":{"url":"https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=KEY123","qrcode_key":"KEY123"}}';

test('扫码第 1 步：生成二维码内容（不跟随重定向、不带 cookie）', async () => {
  const { login, transport } = makeService();
  transport.put('/x/passport-login/web/qrcode/generate', { body: GENERATE_OK });

  const started = await login.startQr();
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.data.key, 'KEY123');
  assert.match(started.data.url, /qrcode_key=KEY123/);
  assert.ok(started.data.expiresInSec > 60);

  const call = transport.calls[0];
  assert.ok(call, '应该发了一次请求');
  assert.equal(call.redirect, 'manual');
  assert.equal(call.withoutCookie, true);
  assert.equal(call.noRetry, true);
});

test('扫码状态机：没扫 / 扫了没确认 / 过期 / 异常', async () => {
  const cases: Array<[number, string]> = [
    [86101, 'waiting'],
    [86090, 'scanned'],
    [86038, 'expired'],
    [12345, 'error'],
  ];
  for (const [code, expected] of cases) {
    const { login, transport } = makeService();
    transport.put('/qrcode/poll', { body: JSON.stringify({ code: 0, data: { code, message: 'x' } }) });
    const polled = await login.pollQr('KEY123');
    assert.equal(polled.ok, true);
    if (!polled.ok) continue;
    assert.equal(polled.data.state, expected, `code ${code} 应该映射成 ${expected}`);
  }
});

test('扫码成功：从 Set-Cookie 取凭据 → 落盘 → nav 复核 → confirmed', async () => {
  const { login, secrets, transport } = makeService();
  transport.put('/qrcode/poll', {
    status: 302,
    body: '',
    setCookies: [
      'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
      'bili_jct=0123456789abcdef0123456789abcdef; Path=/; Domain=.bilibili.com',
      'DedeUserID=42; Path=/',
      'buvid3=XYZ; Path=/',
    ],
  });
  transport.verifyResult = { isLogin: true, mid: 42, uname: '鲸鲸' };

  const polled = await login.pollQr('KEY123');
  assert.equal(polled.ok, true);
  if (!polled.ok) return;
  assert.equal(polled.data.state, 'confirmed');
  assert.deepEqual(polled.data.account, { mid: 42, uname: '鲸鲸' });

  const saved = secrets.cookie();
  assert.match(saved, /SESSDATA=abc%2C123/);
  assert.match(saved, /bili_jct=0123456789abcdef0123456789abcdef/);
  assert.match(saved, /buvid3=XYZ/);
  assert.equal(secrets.hasCookie(), true);
});

test('扫码成功但 nav 说不算登录 → 报错态，不假装成功', async () => {
  const { login, transport } = makeService();
  transport.put('/qrcode/poll', { status: 302, body: '', setCookies: ['SESSDATA=abc; Path=/'] });
  transport.verifyResult = { isLogin: false, mid: 0, uname: '' };

  const polled = await login.pollQr('KEY123');
  assert.equal(polled.ok, true);
  if (!polled.ok) return;
  assert.equal(polled.data.state, 'error');
  assert.match(polled.data.message, /仍未登录/);
});

test('cookie 粘贴：SESSDATA 必填、bili_jct 必须 32 位；合法则保存并复核', async () => {
  const { login, secrets, transport } = makeService();

  const empty = await login.saveCookie('');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error.message, /SESSDATA/);

  const noJct = await login.saveCookie('SESSDATA=abc');
  assert.equal(noJct.ok, true);
  if (noJct.ok) assert.ok(noJct.data.warnings.some((w) => w.includes('bili_jct')), '应该提醒缺 bili_jct');
  assert.match(secrets.cookie(), /SESSDATA=abc/);

  transport.verifyResult = { isLogin: true, mid: 7, uname: '七号' };
  const ok = await login.saveCookie('SESSDATA=good; bili_jct=0123456789abcdef0123456789abcdef; buvid3=X');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.data.account, { mid: 7, uname: '七号' });
});

test('cookie 粘贴：验证失败仍然保存，但如实说「没验过」', async () => {
  const { login, transport } = makeService();
  transport.verifyThrows = true;
  const saved = await login.saveCookie('SESSDATA=abc; bili_jct=0123456789abcdef0123456789abcdef');
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.data.account, null);
  assert.ok(saved.data.warnings.some((w) => w.includes('验证失败')));
});

test('退出只清本地：cookie 清空，不改配置', async () => {
  const { login, secrets } = makeService();
  const saved = await login.saveCookie('SESSDATA=abc; bili_jct=0123456789abcdef0123456789abcdef');
  assert.equal(saved.ok, true);
  const out = login.logout();
  assert.equal(out.ok, true);
  assert.equal(secrets.hasCookie(), false);
  assert.match(out.message, /只清了本机/);
});

test('Set-Cookie 解析：多值、带属性、忽略不相干的名字', () => {
  const parsed = parseSetCookies([
    'SESSDATA=abc; Path=/; HttpOnly',
    'bili_jct=def; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    'DedeUserID=42; Path=/',
    'NID=ignore; Path=/',
  ]);
  assert.equal(parsed.SESSDATA, 'abc');
  assert.equal(parsed.bili_jct, 'def');
  assert.equal(parsed.DedeUserID, '42');
  assert.equal(parsed.NID, undefined);
});
