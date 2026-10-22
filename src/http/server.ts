/**
 * 本地控制 API（M1 最小集，托盘与「打开面板」都用它）。
 *
 * 职责：在 127.0.0.1 上暴露状态与动作，供托盘握手：
 *   GET  /api/health        活着吗、在不在跑、下一次什么时候
 *   GET  /api/status        计划、最近一轮、今日额度、预算
 *   GET  /api/logs?limit=   最近事件（排障）
 *   POST /api/run           现在跑一轮 {dryRun?}
 *   POST /api/pause|resume  暂停/恢复自动唤醒
 *   GET  /api/autostart     自启状态
 *   POST /api/autostart     开/关自启 {enabled}
 *   POST /api/shutdown      退出内核
 *   GET  /                  极简状态页（M2 会被正式面板替换）
 *
 * 安全：只绑 127.0.0.1；所有 /api 与首页都要求 token（Bearer 或 ?token=）；
 *   校验 Host 必须是本机；不返回 CORS 头；请求体上限与超时。
 * 不做什么：不承载业务逻辑（动作由 daemon 注入的 handlers 执行）。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { Logger } from '../shared/logger.ts';
import { STATUS_PAGE_HTML } from './page.ts';

export interface HealthPayload {
  ok: boolean;
  version: string;
  pid: number;
  uptimeSec: number;
  running: boolean;
  paused: boolean;
  nextWakeAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
}

export interface StatusPayload {
  scheduler: {
    plan: string;
    paused: boolean;
    nextWakeAt: string | null;
    planSource: string | null;
  };
  lastRun: { id: string; status: string; endedAt: string | null; tokens: number } | null;
  today: { wakes: number; targetWakes: number; shares: number; shareCap: number; tokens: number; costCny: number };
  account: { loggedIn: boolean; name?: string; mid?: number };
  model: { configured: string; actual: string; discoveredAt: string | null };
  warnings: string[];
}

export interface AutostartPayload {
  enabled: boolean;
  mechanism: string | null;
  command: string | null;
  warning?: string;
}

export interface ControlHandlers {
  health(): HealthPayload;
  status(): StatusPayload;
  logs(limit: number): unknown[];
  run(options: { dryRun: boolean }): Promise<{ ok: boolean; message: string }>;
  pause(): { ok: boolean; message: string };
  resume(): { ok: boolean; message: string };
  autostart(enabled?: boolean): Promise<AutostartPayload>;
  shutdown(): { ok: boolean; message: string };
}

export interface ControlServerOptions {
  handlers: ControlHandlers;
  token: string;
  version: string;
  /** 首选端口；被占用时向后 +1 重试。0 = 让系统分配。 */
  port: number;
  logger: Logger;
  host?: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PORT_ATTEMPTS = 11;

export class ControlServer {
  private server: http.Server | null = null;
  private actualPort = 0;
  private readonly handlers: ControlHandlers;
  private readonly token: string;
  private readonly version: string;
  private readonly preferredPort: number;
  private readonly logger: Logger;
  private readonly host: string;
  private readonly startedAt = Date.now();

  constructor(opts: ControlServerOptions) {
    this.handlers = opts.handlers;
    this.token = opts.token;
    this.version = opts.version;
    this.preferredPort = opts.port;
    this.logger = opts.logger;
    this.host = opts.host ?? '127.0.0.1';
  }

  get port(): number {
    return this.actualPort;
  }

  get url(): string {
    return `http://${this.host}:${this.actualPort}`;
  }

  /** 监听；端口冲突时自动 +1，最多试 11 个。 */
  async start(): Promise<{ port: number; url: string }> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.logger.error('http', `处理请求失败：${String(err)}`);
        if (!res.headersSent) this.sendJson(res, 500, { ok: false, error: '内部错误' });
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 20_000;

    const ports = this.preferredPort === 0 ? [0] : Array.from({ length: MAX_PORT_ATTEMPTS }, (_, i) => this.preferredPort + i);
    let lastError: unknown = null;
    for (const port of ports) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => {
            server.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, this.host);
        });
        const address = server.address();
        this.actualPort = typeof address === 'object' && address ? address.port : port;
        this.server = server;
        this.logger.info('http', `控制接口已启动：${this.url}`);
        return { port: this.actualPort, url: this.url };
      } catch (err) {
        lastError = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') break;
      }
    }
    throw new Error(`控制接口起不来：${String(lastError)}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 不等待 keep-alive 连接自然结束
      server.closeAllConnections?.();
    });
  }

  /* ---------- 路由 ---------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? this.host}`);

    // Host 必须是本机（防 DNS rebinding）
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    const hostname = hostHeader.replace(/:\d+$/, '');
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      this.sendJson(res, 403, { ok: false, error: '只接受本机访问' });
      return;
    }

    const provided = extractToken(req, url);
    if (!provided || !safeEqual(provided, this.token)) {
      this.sendJson(res, 401, { ok: false, error: '缺少或错误的 token（从 runtime.json 读取）' });
      return;
    }

    if (method === 'GET' && url.pathname === '/') {
      this.sendHtml(res, STATUS_PAGE_HTML.replaceAll('__TOKEN__', escapeHtml(provided)).replaceAll('__VERSION__', escapeHtml(this.version)));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      this.sendJson(res, 200, this.healthPayload());
      return;
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      this.sendJson(res, 200, { ok: true, ...this.handlers.status() });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/logs') {
      const limit = clamp(Number(url.searchParams.get('limit') ?? 50), 1, 500);
      this.sendJson(res, 200, { ok: true, events: this.handlers.logs(limit) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/run') {
      const body = await readJsonBody(req);
      const dryRun = body && typeof body === 'object' && 'dryRun' in body ? Boolean((body as { dryRun?: unknown }).dryRun) : false;
      const result = await this.handlers.run({ dryRun });
      this.sendJson(res, result.ok ? 202 : 409, { ok: result.ok, message: result.message });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/pause') {
      const result = this.handlers.pause();
      this.sendJson(res, 200, result);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/resume') {
      const result = this.handlers.resume();
      this.sendJson(res, 200, result);
      return;
    }

    if (url.pathname === '/api/autostart') {
      if (method === 'GET') {
        this.sendJson(res, 200, { ok: true, ...(await this.handlers.autostart(undefined)) });
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const enabled = body && typeof body === 'object' && 'enabled' in body ? Boolean((body as { enabled?: unknown }).enabled) : true;
        this.sendJson(res, 200, { ok: true, ...(await this.handlers.autostart(enabled)) });
        return;
      }
    }

    if (method === 'POST' && url.pathname === '/api/shutdown') {
      this.sendJson(res, 200, this.handlers.shutdown());
      return;
    }

    this.sendJson(res, 404, { ok: false, error: `没有这个接口：${method} ${url.pathname}` });
  }

  private healthPayload(): HealthPayload {
    const base = this.handlers.health();
    return { ...base, ok: !base.lastError, version: this.version, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(text);
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // 页面只加载自身内联脚本，不需要外部资源
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(html);
  }
}

function extractToken(req: http.IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const query = url.searchParams.get('token');
  if (query) return query;
  const header = req.headers['x-biliwhale-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}
