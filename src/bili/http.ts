/**
 * B 站 HTTP 客户端。
 *
 * 职责：
 *   - 串行队列（全局并发 1）：B 站 412 的教训，绝不并发多路取数；
 *   - 读请求最小间隔 + 抖动、写请求更慢（本层只管读，写接口 M3 才出现）；
 *   - 统一 header（UA / Referer / Cookie）、超时、错误分类、有限次退避重试；
 *   - 需要 WBI 的请求自动签名（密钥缓存由 api 层注入）。
 * 不做什么：不做业务解析（api.ts）、不记额度（账本层）、不决定「该不该发」。
 */

import type { Logger } from '../shared/logger.ts';
import { AppError, classifyBiliCode, classifyHttpStatus } from '../shared/errors.ts';
import type { Result } from '../shared/errors.ts';
import { redact } from '../shared/redact.ts';
import { signedQuery, wbiTimestamp } from './wbi.ts';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface TransportRequest {
  /** 完整 URL（不含 query；query 用 query 字段传）。 */
  url: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  form?: Record<string, string>;
  referer?: string;
  /** 需要 WBI 签名。 */
  sign?: boolean;
  /** 写操作：不重试。 */
  noRetry?: boolean;
  timeoutMs?: number;
  /** 是否跟随重定向；扫码轮询必须 manual，否则拿不到 Set-Cookie。 */
  redirect?: 'follow' | 'manual';
  /** 这个请求不带 cookie（登录流程用）。 */
  withoutCookie?: boolean;
}

/** 原始响应：需要读响应头（Set-Cookie）或状态码时用。 */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  /** 逐条 Set-Cookie（已按需合并）。 */
  setCookies: string[];
  body: string;
}

export interface Transport {
  json<T>(req: TransportRequest): Promise<Result<T>>;
  /** 返回**未解包**的信封 `{code,message,data}`：有些接口（nav）在 code!=0 时 data 仍然有用。 */
  jsonEnvelope<T>(req: TransportRequest): Promise<Result<BiliEnvelope<T>>>;
  /** 取原始文本（字幕 CDN 用）。 */
  text?(req: TransportRequest): Promise<Result<string>>;
  /** 取完整响应（扫码轮询要读 Set-Cookie）。 */
  raw?(req: TransportRequest): Promise<Result<RawResponse>>;
}

export interface BiliEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface WbiProvider {
  /** 返回当前 mixin key；拿不到就返回错误（调用方退化为不签名）。 */
  mixin(): Promise<Result<string>>;
}

export interface BiliHttpOptions {
  /** 固定 cookie，或「每次请求时读一次」的取值函数（登录后换 cookie 不用重建客户端）。 */
  cookie: string | (() => string);
  logger: Logger;
  userAgent?: string;
  readIntervalMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  retries?: number;
  baseBackoffMs?: number;
  /** 注入点：测试用假 fetch / 假时钟 / 假 sleep。 */
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 撞风控时回调（编排器据此写冷却时间）。 */
  onRisk?: (message: string) => void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<ResponseLike>;

interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** 串行队列：保证同一时刻只有一个 B 站请求在飞。 */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // 吞掉错误，避免一次失败让后续任务永远拿 rejected 链
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class BiliHttp implements Transport {
  private readonly queue = new SerialQueue();
  private readonly cookieSource: string | (() => string);
  private readonly logger: Logger;
  private readonly userAgent: string;
  private readonly readIntervalMs: number;
  private readonly jitterMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseBackoffMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRisk?: (message: string) => void;
  private signer: WbiProvider | null = null;
  private lastRequestAt = 0;
  private requestCount = 0;

  constructor(opts: BiliHttpOptions) {
    this.cookieSource = opts.cookie;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? DEFAULT_UA;
    this.readIntervalMs = opts.readIntervalMs ?? 1500;
    this.jitterMs = opts.jitterMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 800;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (opts.onRisk) this.onRisk = opts.onRisk;
  }

  /** 当前 cookie（登录后可能变）。 */
  cookie(): string {
    return typeof this.cookieSource === 'string' ? this.cookieSource : this.cookieSource();
  }

  useSigner(provider: WbiProvider): void {
    this.signer = provider;
  }

  stats(): { requests: number; lastRequestAt: number } {
    return { requests: this.requestCount, lastRequestAt: this.lastRequestAt };
  }

  async json<T>(req: TransportRequest): Promise<Result<T>> {
    const text = await this.exchange(req);
    if (!text.ok) return { ok: false, error: text.error };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.data);
    } catch {
      return {
        ok: false,
        error: { kind: 'parse', code: 'parse', message: '响应不是 JSON（可能被风控页拦截）', rawSnippet: text.data.slice(0, 200) },
      };
    }
    return unwrapBiliEnvelope<T>(parsed);
  }

  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<BiliEnvelope<T>>> {
    const text = await this.exchange(req);
    if (!text.ok) return { ok: false, error: text.error };
    return parseEnvelope<T>(text.data);
  }

  async text(req: TransportRequest): Promise<Result<string>> {
    return this.exchange(req);
  }

  /** 完整响应（状态码 + 响应头 + body），扫码登录要用它读 Set-Cookie。 */
  async raw(req: TransportRequest): Promise<Result<RawResponse>> {
    return this.exchangeRaw(req);
  }

  /**
   * 真正的网络交互：**先签名，再排队限速发请求**。
   *
   * 签名必须在队列之外做：WBI 材料来自 nav，而 nav 自己也要走队列。
   * 如果签名发生在队列内部，nav 会在队列里等自己 → 直接死锁（真接口冒烟时踩到过）。
   */
  private async exchange(req: TransportRequest): Promise<Result<string>> {
    const outcome = await this.exchangeRaw(req);
    return outcome.ok ? { ok: true, data: outcome.data.body } : outcome;
  }

  private async exchangeRaw(req: TransportRequest): Promise<Result<RawResponse>> {
    const attempts = req.noRetry ? 1 : this.retries + 1;
    let lastError: Result<RawResponse> | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const url = await this.buildUrl(req);
      if (!url.ok) return { ok: false, error: url.error };

      const outcome = await this.queue.run(() => this.fetchOnce(url.data, req));
      if (outcome.ok) return outcome;
      lastError = outcome;

      const kind = outcome.error.kind;
      if (kind === 'risk') {
        this.onRisk?.(outcome.error.message);
        return outcome;
      }
      if (kind === 'network' || kind === 'rate') {
        if (attempt < attempts - 1) {
          this.logger.warn('bili.http', `请求失败，准备重试（第 ${attempt + 1} 次）：${outcome.error.message}`, {
            url: safeUrl(req.url),
          });
          await this.backoff(attempt);
          continue;
        }
        return outcome;
      }
      return outcome;
    }

    return lastError ?? { ok: false, error: { kind: 'network', code: 'network', message: '请求失败（未知原因）' } };
  }

  /** 单次请求（已持有队列）：限速 → fetch → 错误分类。 */
  private async fetchOnce(url: string, req: TransportRequest): Promise<Result<RawResponse>> {
    await this.throttle();
    try {
      const res = await this.fetchImpl(url, {
        method: req.method ?? 'GET',
        headers: this.headers(req),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs),
        ...(req.redirect ? { redirect: req.redirect } : {}),
        ...(req.form ? { body: new URLSearchParams(req.form).toString() } : {}),
      });
      this.requestCount += 1;
      this.lastRequestAt = this.now();

      const body = await res.text();
      const redirect = res.status >= 300 && res.status < 400;
      if (!res.ok && !redirect) {
        return {
          ok: false,
          error: {
            kind: classifyHttpStatus(res.status),
            code: res.status,
            message: `HTTP ${res.status}（${describeStatus(res.status)}）`,
            rawSnippet: redact(body).slice(0, 200),
          },
        };
      }
      return { ok: true, data: toRawResponse(res, body) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { kind: 'network', code: 'network', message: `请求失败：${message}` } };
    }
  }

  private async buildUrl(req: TransportRequest): Promise<Result<string>> {
    const query: Record<string, string | number | undefined> = { ...(req.query ?? {}) };

    if (req.sign) {
      if (!this.signer) {
        return { ok: false, error: { kind: 'internal', code: 'internal', message: '需要签名的请求没有装配 signer' } };
      }
      const mixin = await this.signer.mixin();
      if (!mixin.ok) return { ok: false, error: mixin.error };
      return { ok: true, data: `${req.url}?${signedQuery(query, mixin.data, wbiTimestamp(this.now()))}` };
    }

    const parts = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    return { ok: true, data: parts.length > 0 ? `${req.url}?${parts.join('&')}` : req.url };
  }

  private headers(req: TransportRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: req.referer ?? 'https://www.bilibili.com/',
    };
    const cookie = this.cookie();
    if (cookie && !req.withoutCookie) headers.cookie = cookie;
    if (req.method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = 'https://www.bilibili.com';
    }
    return headers;
  }

  /** 读间隔 + 0..jitter 抖动（随机源用 Math.random 就够：只影响时序，不影响安全）。 */
  private async throttle(): Promise<void> {
    if (this.lastRequestAt === 0) return;
    const wait = this.lastRequestAt + this.readIntervalMs + Math.random() * this.jitterMs - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private async backoff(attempt: number): Promise<void> {
    const base = Math.min(this.baseBackoffMs * 2 ** attempt, 8000);
    const jitter = Math.random() * 400;
    await this.sleep(base + jitter);
  }
}

/** 解析 `{code,message,data}` 信封但**不判错**（nav 在 -101 时 data 仍然有用）。 */
export function parseEnvelope<T>(text: string): Result<BiliEnvelope<T>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: { kind: 'parse', code: 'parse', message: '响应不是 JSON（可能被风控页拦截）', rawSnippet: redact(text).slice(0, 200) },
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: { kind: 'parse', code: 'parse', message: '响应结构不是对象' } };
  }
  const env = parsed as { code?: unknown; message?: unknown; data?: unknown };
  const code = typeof env.code === 'number' ? env.code : Number(env.code);
  if (!Number.isFinite(code)) {
    return { ok: false, error: { kind: 'parse', code: 'parse', message: '响应里没有 code 字段' } };
  }
  return {
    ok: true,
    data: { code, message: typeof env.message === 'string' ? env.message : '', data: (env.data ?? null) as T },
  };
}

/** 解包 `{code,message,data}`：code!==0 → 分类错误。 */
export function unwrapBiliEnvelope<T>(parsed: unknown): Result<T> {
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: { kind: 'parse', code: 'parse', message: '响应结构不是对象' } };
  }
  const env = parsed as { code?: unknown; message?: unknown; data?: unknown };
  const code = typeof env.code === 'number' ? env.code : Number(env.code);
  if (!Number.isFinite(code)) {
    // 少数接口（如字幕 CDN）没有 code 字段：整体当数据用
    return { ok: true, data: parsed as T };
  }
  if (code !== 0) {
    const kind = classifyBiliCode(code);
    const message = typeof env.message === 'string' && env.message.length > 0 ? env.message : `B 站返回 ${code}`;
    return { ok: false, error: { kind, code, message } };
  }
  return { ok: true, data: (env.data ?? null) as T };
}

function describeStatus(status: number): string {
  if (status === 412) return '被限流，需要冷却';
  if (status === 429) return '请求过多';
  if (status === 403) return '被拒绝，可能凭据失效';
  if (status === 404) return '不存在';
  if (status >= 500) return '服务端错误';
  return '请求失败';
}

/** Response → 我们的 RawResponse（含逐条 Set-Cookie）。 */
function toRawResponse(res: ResponseLike, body: string): RawResponse {
  const headers: Record<string, string> = {};
  const rawHeaders = res.headers as unknown as { forEach?: (cb: (value: string, key: string) => void) => void };
  rawHeaders.forEach?.((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let setCookies: string[] = [];
  if (typeof res.headers.getSetCookie === 'function') {
    setCookies = res.headers.getSetCookie();
  } else {
    const single = res.headers.get('set-cookie');
    if (single) setCookies = [single];
  }
  return { status: res.status, headers, setCookies, body };
}

/** 日志里只留 host + path，别把带签名的 query 全打出来。 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return redact(url);
  }
}

/** 把错误统一转成 AppError（api 层内部用）。 */
export function asAppError(error: { kind: string; code: string | number; message: string }): AppError {
  return new AppError(error.kind as AppError['kind'], error.code, error.message);
}
