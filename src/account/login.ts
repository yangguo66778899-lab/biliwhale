/**
 * 登录（扫码 + cookie 粘贴）。
 *
 * 职责：
 *   - 扫码：要二维码内容（generate）→ 轮询（poll）→ 成功时**从 Set-Cookie 响应头**取凭据；
 *   - cookie 粘贴：校验 SESSDATA 必填、bili_jct 32 位、buvid3 可空；
 *   - 两条路都走同一步验证：调 `nav` 确认真的登录了，并回填昵称/UID；
 *   - 退出只清本地，不调远端登出（避免把浏览器里的会话一起吊销）。
 * 不做什么：不画二维码（在 UI 层）、不碰写接口、不改配置。
 *
 * 依据：`docs/bili-readonly-api-spec.md`（扫码 code 86101/86090/0/86038；凭据在响应头里，
 * 必须 `redirect: 'manual'` 才拿得到）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import type { RawResponse, Transport } from '../bili/http.ts';
import type { SecretsService } from '../config/secrets.ts';
import { normalizeCookie } from '../config/secrets.ts';
import { humanError } from '../shared/errors.ts';

const PASSPORT = 'https://passport.bilibili.com';
const QR_GENERATE = `${PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`;
const QR_POLL = `${PASSPORT}/x/passport-login/web/qrcode/poll`;
const REFERER = 'https://www.bilibili.com/';

export type QrState = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

export interface AccountInfo {
  mid: number;
  uname: string;
}

export interface QrStart {
  key: string;
  /** 二维码里要画的字符串（B 站登录页 URL）。 */
  url: string;
  expiresInSec: number;
}

export interface QrPoll {
  state: QrState;
  message: string;
  account?: AccountInfo;
}

export interface LoginDeps {
  http: Transport;
  secrets: SecretsService;
  logger: Logger;
  /** 用真实登录态验证（nav）。返回 isLogin / mid / uname。 */
  verify: () => Promise<Result<AccountInfo & { isLogin: boolean }>>;
}

/** 扫码登录会话寿命（B 站是 180 秒，这里保守一点）。 */
const QR_TTL_SEC = 170;

export class LoginService {
  private readonly deps: LoginDeps;
  private current: { key: string; startedAt: number } | null = null;

  constructor(deps: LoginDeps) {
    this.deps = deps;
  }

  /** 生成二维码内容 + 会话 key。 */
  async startQr(): Promise<Result<QrStart>> {
    if (!this.deps.http.raw) {
      return { ok: false, error: { kind: 'internal', code: 'internal', message: '当前传输层不支持读响应头' } };
    }
    const res = await this.deps.http.raw({
      url: QR_GENERATE,
      referer: REFERER,
      noRetry: true,
      withoutCookie: true,
      redirect: 'manual',
      timeoutMs: 15_000,
    });
    if (!res.ok) return res;

    const parsed = parseJson(res.data.body);
    const data = asRecord(parsed && parsed.data);
    const url = typeof data?.url === 'string' ? data.url : '';
    const key = typeof data?.qrcode_key === 'string' ? data.qrcode_key : '';
    if (!url || !key) {
      return { ok: false, error: { kind: 'parse', code: 'parse', message: '二维码接口没给 url / qrcode_key' } };
    }

    this.current = { key, startedAt: Date.now() };
    this.deps.logger.info('login', '已生成登录二维码');
    return { ok: true, data: { key, url, expiresInSec: QR_TTL_SEC } };
  }

  /**
   * 轮询扫码状态。扫码成功时把响应头里的凭据落盘，并用 nav 复核。
   * 注意：`code===0` 的凭据**不在 body 里**，只在 `Set-Cookie` 里。
   */
  async pollQr(key: string): Promise<Result<QrPoll>> {
    if (!this.deps.http.raw) {
      return { ok: false, error: { kind: 'internal', code: 'internal', message: '当前传输层不支持读响应头' } };
    }
    const res = await this.deps.http.raw({
      url: QR_POLL,
      query: { qrcode_key: key, source: 'main-fe-header' },
      referer: REFERER,
      noRetry: true,
      withoutCookie: true,
      redirect: 'manual',
      timeoutMs: 15_000,
    });
    if (!res.ok) return res;

    const cookies = parseSetCookies(res.data.setCookies);
    const parsed = parseJson(res.data.body);
    const biz = asRecord(parsed && parsed.data);
    const code = typeof biz?.code === 'number' ? biz.code : Number(biz?.code);

    // 有的实现会在 302 上直接给 cookie：只要有 SESSDATA 就当成功
    if (cookies.SESSDATA) {
      return this.finishLogin(cookies);
    }

    if (code === 86101) return { ok: true, data: { state: 'waiting', message: '还没扫码' } };
    if (code === 86090) return { ok: true, data: { state: 'scanned', message: '已扫码，等你在手机上确认' } };
    if (code === 86038) return { ok: true, data: { state: 'expired', message: '二维码过期了，刷新一下' } };
    if (code === 0) {
      return {
        ok: true,
        data: { state: 'error', message: '扫码返回成功但没拿到 cookie（可能被风控），请重试或改用 cookie 粘贴' },
      };
    }
    return { ok: true, data: { state: 'error', message: `扫码状态异常（code=${String(biz?.code ?? '未知')}）` } };
  }

  /** cookie 粘贴：校验格式 → 落盘 → 用 nav 复核。 */
  async saveCookie(raw: string): Promise<Result<{ warnings: string[]; account: AccountInfo | null }>> {
    const normalized = normalizeCookie(raw);
    if (!normalized.ok) {
      return { ok: false, error: { kind: 'business', code: 'bad_cookie', message: normalized.error } };
    }
    this.deps.secrets.setCookie(normalized.cookie);
    const verified = await this.recheck();
    if (!verified.ok) {
      return { ok: true, data: { warnings: [...normalized.warnings, `已保存，但验证失败：${verified.error.message}`], account: null } };
    }
    return { ok: true, data: { warnings: normalized.warnings, account: verified.data.loggedIn ? verified.data.account : null } };
  }

  /** 复核登录态（nav），成功时回填昵称/UID。 */
  async recheck(): Promise<Result<{ loggedIn: boolean; account: AccountInfo | null }>> {
    try {
      const nav = await this.deps.verify();
      if (!nav.ok) return { ok: false, error: nav.error };
      if (nav.data.isLogin && nav.data.mid > 0) {
        const account: AccountInfo = { mid: nav.data.mid, uname: nav.data.uname };
        this.deps.secrets.setAccount(account);
        return { ok: true, data: { loggedIn: true, account } };
      }
      return { ok: true, data: { loggedIn: false, account: null } };
    } catch (err) {
      return { ok: false, error: { kind: 'internal', code: 'internal', message: humanError(err) } };
    }
  }

  /** 只清本地，不调远端登出。 */
  logout(): { ok: boolean; message: string } {
    this.deps.secrets.clearCookie();
    this.current = null;
    this.deps.logger.info('login', '已清掉本地 cookie');
    return { ok: true, message: '已退出（只清了本机凭据，浏览器里的登录还在）' };
  }

  /** 当前会话还在有效期吗（前端用来决定要不要重新生成）。 */
  sessionAge(key: string): number | null {
    if (!this.current || this.current.key !== key) return null;
    return Math.round((Date.now() - this.current.startedAt) / 1000);
  }

  private async finishLogin(cookies: Record<string, string>): Promise<Result<QrPoll>> {
    const parts = [`SESSDATA=${cookies.SESSDATA}`];
    if (cookies.bili_jct) parts.push(`bili_jct=${cookies.bili_jct}`);
    if (cookies.buvid3) parts.push(`buvid3=${cookies.buvid3}`);
    const cookie = parts.join('; ');
    this.deps.secrets.setCookie(cookie);

    const verified = await this.recheck();
    if (!verified.ok) {
      return { ok: true, data: { state: 'error', message: `扫码成功但验证失败：${verified.error.message}` } };
    }
    if (!verified.data.loggedIn || !verified.data.account) {
      return {
        ok: true,
        data: { state: 'error', message: '扫码成功，但 nav 说仍未登录（可能 cookie 不完整），请重试' },
      };
    }
    this.deps.logger.info('login', `扫码登录成功：${verified.data.account.uname}（${verified.data.account.mid}）`);
    return { ok: true, data: { state: 'confirmed', message: `登录成功：${verified.data.account.uname}`, account: verified.data.account } };
  }
}

/** 从 Set-Cookie 行里抠出 name=value（只认我们需要的几个）。 */
export function parseSetCookies(lines: string[]): Record<string, string> {
  const wanted = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4']);
  const out: Record<string, string> = {};
  for (const line of lines ?? []) {
    for (const piece of String(line).split(/,(?=\s*[A-Za-z0-9_]+=)/)) {
      const first = piece.split(';')[0]?.trim() ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!wanted.has(name) || !value) continue;
      out[name] = value;
    }
  }
  return out;
}

function parseJson(text: string): { code?: number; data?: unknown } | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as { code?: number; data?: unknown };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 给测试/诊断用：把 RawResponse 里的 cookie 头拼成可读字符串。 */
export function describeRawCookies(res: RawResponse): string {
  return res.setCookies.join(' | ');
}
