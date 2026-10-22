/**
 * 本地控制 API + 静态面板（M2）。
 *
 * 职责：在 127.0.0.1 上给托盘与浏览器面板提供状态、配置、账号、报告、日记、日志、诊断：
 *   GET  /api/health · /api/status · /api/logs · /api/session
 *   GET  /api/config · PUT /api/config · POST /api/config/validate|import|reset · GET /api/config/export
 *   GET  /api/models · /api/doctor · /api/diag
 *   GET  /api/account · POST /api/account/qr|account/cookie|account/logout · GET /api/account/qr/poll
 *   GET  /api/reports · /api/reports/:date · /api/diaries · /api/diaries/:kind/:date
 *   POST /api/run|pause|resume|autostart|shutdown
 *   GET  / 以及 /app.js /style.css（静态资源，随程序打包，不引 CDN）
 *
 * 安全：
 *   - 只绑 127.0.0.1；所有接口要 token（Bearer / ?token= / x-biliwhale-token）；
 *   - 写操作（POST/PUT）额外要 CSRF token（`x-csrf-token`，从 /api/session 拿）；
 *   - 校验 Host 必须是本机；不返回 CORS 头；页面带 CSP；
 *   - 静态资源走白名单 + 路径穿越校验。
 * 不做什么：不承载业务逻辑（动作由 daemon 注入的 handlers 执行）。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../shared/logger.ts';

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
  scheduler: { plan: string; paused: boolean; nextWakeAt: string | null; planSource: string | null };
  lastRun: { id: string; status: string; endedAt: string | null; tokens: number } | null;
  today: { wakes: number; targetWakes: number; shares: number; shareCap: number; tokens: number; costCny: number };
  account: { loggedIn: boolean; name?: string; mid?: number };
  /** 首次配置清单：缺什么、去哪补（概览页顶部会显示）。 */
  setup?: {
    ready: boolean;
    items: Array<{ key: string; label: string; ok: boolean; tab: string; hint: string }>;
    missing: Array<{ label: string; tab: string; hint: string }>;
  };
  model: { configured: string; actual: string; discoveredAt: string | null };
  /** 写开关与预演状态：面板要说清「这一下是真发还是只打印」。 */
  safety?: { writeEnabled: boolean; dryRun: boolean; killSwitch: boolean };
  /** M3：待审回复条数（托盘与概览都要显示）。 */
  pending: { count: number };
  warnings: string[];
}

export interface AutostartPayload {
  enabled: boolean;
  mechanism: string | null;
  command: string | null;
  warning?: string;
}

export interface ListEntry {
  date: string;
  size: number;
  /** 搜索命中的次数（只有带 q 的日记搜索才有）。 */
  hits?: number;
}

export interface DocFile {
  date: string;
  markdown: string;
}

export interface QrPayload {
  ok: boolean;
  key?: string;
  url?: string;
  /** 模块矩阵的字符串行（UI 直接画）。 */
  rows?: string[];
  size?: number;
  expiresInSec?: number;
  message?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  issues?: unknown[];
}

/** 基础动作（M1）。 */
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

/** 面板需要的扩展能力（M2）。缺哪个接口就回 501，方便分阶段上线。 */
export interface PanelHandlers {
  config(): { config: unknown; groups: unknown; issues: unknown[] };
  saveConfig(patch: unknown): Promise<ActionResult>;
  validateConfig(raw: unknown): { ok: boolean; issues: unknown[] };
  exportConfig(): { filename: string; json: string };
  importConfig(raw: unknown): Promise<ActionResult>;
  resetConfig(): Promise<ActionResult>;
  models(): unknown;
  account(): unknown;
  /** 按 UID 取主人昵称并写回配置（主人必须是另一个号）。 */
  ownerLookup(body: { mid?: number }): Promise<ActionResult & { ownerMid?: number; ownerName?: string }>;
  qrStart(): Promise<QrPayload>;
  qrPoll(key: string): Promise<unknown>;
  saveCookie(cookie: string): Promise<unknown>;
  /** 用当前已存的 cookie 重新验证（面板「重新验证」）。 */
  verifyAccount(): Promise<unknown>;
  logout(): { ok: boolean; message: string };
  reports(): ListEntry[];
  report(date: string): DocFile | null;
  diaries(kind: 'public' | 'private', query?: string): ListEntry[];
  diary(kind: 'public' | 'private', date: string): DocFile | null;
  doctor(): Promise<unknown>;
  diag(): Promise<{ filename: string; json: string }>;
  /** M3：待审的回复草稿。 */
  pending(): unknown;
  approvePending(id: string, dryRun?: boolean): Promise<ActionResult & { rpid?: string; verified?: boolean }>;
  rejectPending(id: string, reason: string): ActionResult;
  scanPending(): Promise<unknown>;
  /** M3：删自己发过的评论（面板手动、二次确认）。 */
  deleteComment(bvid: string, rpid: string, dryRun?: boolean): Promise<ActionResult>;
  /** P0-2：给某个通知渠道发一条测试消息（预演时只写日志；写开关关着/急停/冷却时拒绝）。 */
  notifyTest(body?: { channel?: string }): Promise<{
    ok: boolean;
    message: string;
    results?: Array<{ channel: string; ok: boolean; detail: string }>;
    dryRun?: boolean;
  }>;
  /** P0-3：面板手动发一条动态（二次确认；服务端再判一次开关/额度）。 */
  publishDynamic(body: { text: string; confirm: boolean; dryRun?: boolean }): Promise<ActionResult & { status?: string; deny?: string[] }>;
  /** P0-3：某天报告里「挑中的」视频（「发动态…」入口按它列）。 */
  picked(date?: string): { date: string; items: Array<{ bvid: string; title: string; oneliner: string; why: string; url: string }> };
  /** M4：私聊状态、聊天记录、手动发送（测试/日记/视频信息）、清空记录。 */
  dm(): unknown;
  dmChat(limit: number): unknown;
  dmSend(body: { text?: string; kind?: 'diary' | 'video_info'; bvid?: string }): Promise<ActionResult>;
  dmClear(): { ok: boolean; message: string };
  /** M4：立刻跑一次监听（测试与手动触发）。 */
  listenNow(): Promise<unknown>;
  /** M5：手动检查更新 / 立刻备份一次数据。 */
  checkUpdate(): Promise<unknown>;
  backup(): Promise<{ ok: boolean; message: string; file?: string; bytes?: number; entries?: number }>;
  /** DeepSeek key 的状态（只给指纹，绝不回显原值）。 */
  secretsStatus(): { hasApiKey: boolean; fingerprint: string; source: 'env' | 'file' | 'none' };
  /** 在面板里填/换 DeepSeek key，保存后立刻验证并生效。 */
  saveApiKey(apiKey: string): Promise<ActionResult & { models?: string[]; model?: string }>;
}

export interface ControlServerOptions {
  handlers: ControlHandlers & Partial<PanelHandlers>;
  token: string;
  version: string;
  /** 首选端口；被占用时向后 +1 重试。0 = 让系统分配。 */
  port: number;
  logger: Logger;
  host?: string;
  /** 静态资源目录（默认 src/ui）。 */
  uiDir?: string;
}

const MAX_BODY_BYTES = 512 * 1024;
/** 浏览器会话 cookie 名（HttpOnly，只在本进程内有效）。 */
const SESSION_COOKIE = 'bw_session';
const MAX_PORT_ATTEMPTS = 11;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export class ControlServer {
  private server: http.Server | null = null;
  private actualPort = 0;
  private readonly handlers: ControlServerOptions['handlers'];
  private readonly token: string;
  private readonly csrfToken: string;
  private readonly version: string;
  private readonly preferredPort: number;
  private readonly logger: Logger;
  private readonly host: string;
  private readonly uiDir: string;
  private readonly startedAt = Date.now();
  /** 会话 cookie 的值：随机、只在内存里，重启即换（不是 token 本身）。 */
  private readonly sessionId = crypto.randomBytes(24).toString('hex');

  constructor(opts: ControlServerOptions) {
    this.handlers = opts.handlers;
    this.token = opts.token;
    this.csrfToken = crypto.randomBytes(24).toString('hex');
    this.version = opts.version;
    this.preferredPort = opts.port;
    this.logger = opts.logger;
    this.host = opts.host ?? '127.0.0.1';
    this.uiDir = opts.uiDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
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
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;

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
      server.closeAllConnections?.();
    });
  }

  /* ---------- 路由 ---------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? this.host}`);

    const hostHeader = (req.headers.host ?? '').toLowerCase();
    const hostname = hostHeader.replace(/:\d+$/, '');
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      this.sendJson(res, 403, { ok: false, error: '只接受本机访问' });
      return;
    }

    // 凭据：URL/header 里的 token，或者「同一个浏览器」的会话 cookie。
    // 为什么需要 cookie：页面的 <script src="/app.js"> 与 <link href="/style.css"> 是浏览器自己发的，
    // 带不上 ?token=，只靠 token 会把子资源全挡成 401（面板只剩空壳，M3 真机踩到过）。
    const provided = extractToken(req, url);
    const tokenOk = provided !== null && safeEqual(provided, this.token);
    const cookieOk = this.sessionOk(req);
    if (!tokenOk && !cookieOk) {
      if (method === 'GET' && !url.pathname.startsWith('/api/')) {
        this.serveUnauthorizedPage(res);
        return;
      }
      this.sendJson(res, 401, { ok: false, error: '缺少或错误的 token（从 runtime.json 读取）' });
      return;
    }
    // 用 token 进来、还没有会话 cookie → 种一个（HttpOnly，7 天，SameSite=Strict）
    if (tokenOk && !cookieOk) res.setHeader('set-cookie', this.sessionCookieHeader());

    // 静态资源（只有 GET）
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      this.serveStatic(url.pathname, res);
      return;
    }

    // 写操作要 CSRF
    if (method !== 'GET' && url.pathname !== '/api/session') {
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, this.csrfToken)) {
        this.sendJson(res, 403, { ok: false, error: '缺少或错误的 CSRF token（先 GET /api/session）' });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/session') {
      this.sendJson(res, 200, { ok: true, csrfToken: this.csrfToken, version: this.version });
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

    if (method === 'GET' && url.pathname === '/api/doctor') {
      const handler = this.handlers.doctor;
      if (!handler) return this.notImplemented(res, 'doctor');
      this.sendJson(res, 200, { ok: true, report: await handler() });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/diag') {
      const handler = this.handlers.diag;
      if (!handler) return this.notImplemented(res, 'diag');
      const bundle = await handler();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${sanitizeFilename(bundle.filename)}"`,
        'cache-control': 'no-store',
      });
      res.end(bundle.json);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/models') {
      const handler = this.handlers.models;
      if (!handler) return this.notImplemented(res, 'models');
      this.sendJson(res, 200, { ok: true, ...(handler() as object) });
      return;
    }

    /* ---- 凭据（DeepSeek key） ---- */

    if (method === 'GET' && url.pathname === '/api/secrets') {
      const handler = this.handlers.secretsStatus;
      if (!handler) return this.notImplemented(res, 'secrets');
      this.sendJson(res, 200, { ok: true, ...handler() });
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/secrets/llm') {
      const handler = this.handlers.saveApiKey;
      if (!handler) return this.notImplemented(res, 'secrets/llm');
      const body = await readJsonBody(req);
      const apiKey = isRecord(body) && typeof body.apiKey === 'string' ? body.apiKey : '';
      if (!apiKey.trim()) return this.sendJson(res, 400, { ok: false, message: 'key 是空的' });
      const result = await handler(apiKey);
      this.sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    /* ---- 配置 ---- */

    if (method === 'GET' && url.pathname === '/api/config') {
      const handler = this.handlers.config;
      if (!handler) return this.notImplemented(res, 'config');
      this.sendJson(res, 200, { ok: true, ...handler() });
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/config') {
      const handler = this.handlers.saveConfig;
      if (!handler) return this.notImplemented(res, 'config');
      const body = await readJsonBody(req);
      if (body === null) return this.sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      const result = await handler(body);
      this.sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/config/validate') {
      const handler = this.handlers.validateConfig;
      if (!handler) return this.notImplemented(res, 'config/validate');
      const body = await readJsonBody(req);
      if (body === null) return this.sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      this.sendJson(res, 200, handler(body));
      return;
    }

    if (method === 'GET' && url.pathname === '/api/config/export') {
      const handler = this.handlers.exportConfig;
      if (!handler) return this.notImplemented(res, 'config/export');
      const exported = handler();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${sanitizeFilename(exported.filename)}"`,
        'cache-control': 'no-store',
      });
      res.end(exported.json);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/config/import') {
      const handler = this.handlers.importConfig;
      if (!handler) return this.notImplemented(res, 'config/import');
      const body = await readJsonBody(req);
      if (body === null) return this.sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      const result = await handler(body);
      this.sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/config/reset') {
      const handler = this.handlers.resetConfig;
      if (!handler) return this.notImplemented(res, 'config/reset');
      const result = await handler();
      this.sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    /* ---- 账号 ---- */

    if (method === 'GET' && url.pathname === '/api/account') {
      const handler = this.handlers.account;
      if (!handler) return this.notImplemented(res, 'account');
      this.sendJson(res, 200, { ok: true, ...(handler() as object) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/account/qr') {
      const handler = this.handlers.qrStart;
      if (!handler) return this.notImplemented(res, 'account/qr');
      const result = await handler();
      this.sendJson(res, result.ok ? 200 : 502, result);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/account/qr/poll') {
      const handler = this.handlers.qrPoll;
      if (!handler) return this.notImplemented(res, 'account/qr/poll');
      const key = url.searchParams.get('key') ?? '';
      if (!key) return this.sendJson(res, 400, { ok: false, error: '缺少 key' });
      this.sendJson(res, 200, await handler(key));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/account/cookie') {
      const handler = this.handlers.saveCookie;
      if (!handler) return this.notImplemented(res, 'account/cookie');
      const body = await readJsonBody(req);
      const cookie = isRecord(body) && typeof body.cookie === 'string' ? body.cookie : '';
      if (!cookie) return this.sendJson(res, 400, { ok: false, error: '缺少 cookie' });
      this.sendJson(res, 200, await handler(cookie));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/account/verify') {
      const handler = this.handlers.verifyAccount;
      if (!handler) return this.notImplemented(res, 'account/verify');
      this.sendJson(res, 200, await handler());
      return;
    }

    if (method === 'POST' && url.pathname === '/api/account/owner') {
      const handler = this.handlers.ownerLookup;
      if (!handler) return this.notImplemented(res, 'account/owner');
      const body = await readJsonBody(req);
      const mid = isRecord(body) && typeof body.mid === 'number' ? body.mid : undefined;
      this.sendJson(res, 200, await handler({ mid }));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/account/logout') {
      const handler = this.handlers.logout;
      if (!handler) return this.notImplemented(res, 'account/logout');
      this.sendJson(res, 200, handler());
      return;
    }

    /* ---- 报告 / 日记 ---- */

    if (method === 'GET' && url.pathname === '/api/reports') {
      const handler = this.handlers.reports;
      if (!handler) return this.notImplemented(res, 'reports');
      this.sendJson(res, 200, { ok: true, items: handler() });
      return;
    }

    const reportMatch = /^\/api\/reports\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && reportMatch) {
      const handler = this.handlers.report;
      if (!handler) return this.notImplemented(res, 'reports/:date');
      const date = decodeURIComponent(reportMatch[1] ?? '');
      if (!DATE_RE.test(date)) return this.sendJson(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' });
      const doc = handler(date);
      if (!doc) return this.sendJson(res, 404, { ok: false, error: '那一份报告不存在' });
      this.sendJson(res, 200, { ok: true, ...doc });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/diaries') {
      const handler = this.handlers.diaries;
      if (!handler) return this.notImplemented(res, 'diaries');
      const kind = url.searchParams.get('kind') === 'private' ? 'private' : 'public';
      const query = (url.searchParams.get('q') ?? '').trim();
      this.sendJson(res, 200, { ok: true, kind, query, items: handler(kind, query) });
      return;
    }

    const diaryMatch = /^\/api\/diaries\/(public|private)\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && diaryMatch) {
      const handler = this.handlers.diary;
      if (!handler) return this.notImplemented(res, 'diaries/:kind/:date');
      const kind = diaryMatch[1] === 'private' ? 'private' : 'public';
      const date = decodeURIComponent(diaryMatch[2] ?? '');
      if (!DATE_RE.test(date)) return this.sendJson(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' });
      const doc = handler(kind, date);
      if (!doc) return this.sendJson(res, 404, { ok: false, error: '那一份日记不存在' });
      this.sendJson(res, 200, { ok: true, kind, ...doc });
      return;
    }

    /* ---- 待审（M3） ---- */

    if (method === 'GET' && url.pathname === '/api/pending') {
      const handler = this.handlers.pending;
      if (!handler) return this.notImplemented(res, 'pending');
      this.sendJson(res, 200, { ok: true, ...(handler() as object) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/pending/scan') {
      const handler = this.handlers.scanPending;
      if (!handler) return this.notImplemented(res, 'pending/scan');
      this.sendJson(res, 200, { ok: true, ...(await handler() as object) });
      return;
    }

    const approveMatch = /^\/api\/pending\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === 'POST' && approveMatch) {
      const handler = this.handlers.approvePending;
      if (!handler) return this.notImplemented(res, 'pending/approve');
      const body = await readJsonBody(req);
      const dryRun = isRecord(body) && 'dryRun' in body ? Boolean(body.dryRun) : false;
      const result = await handler(decodeURIComponent(approveMatch[1] ?? ''), dryRun);
      this.sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    const rejectMatch = /^\/api\/pending\/([^/]+)\/reject$/.exec(url.pathname);
    if (method === 'POST' && rejectMatch) {
      const handler = this.handlers.rejectPending;
      if (!handler) return this.notImplemented(res, 'pending/reject');
      const body = await readJsonBody(req);
      const reason = isRecord(body) && typeof body.reason === 'string' ? body.reason : '';
      const result = handler(decodeURIComponent(rejectMatch[1] ?? ''), reason);
      this.sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    const deleteMatch = /^\/api\/comments\/([A-Za-z0-9]+)\/([^/]+)$/.exec(url.pathname);
    if (method === 'DELETE' && deleteMatch) {
      const handler = this.handlers.deleteComment;
      if (!handler) return this.notImplemented(res, 'comments/delete');
      const result = await handler(deleteMatch[1] ?? '', decodeURIComponent(deleteMatch[2] ?? ''), false);
      this.sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    /* ---- 通知测试 / 发动态（P0-2 / P0-3） ---- */

    if (method === 'POST' && url.pathname === '/api/notify/test') {
      const handler = this.handlers.notifyTest;
      if (!handler) return this.notImplemented(res, 'notify/test');
      const body = await readJsonBody(req);
      const channel = isRecord(body) && typeof body.channel === 'string' ? body.channel : undefined;
      const result = await handler(channel ? { channel } : {});
      this.sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/picked') {
      const handler = this.handlers.picked;
      if (!handler) return this.notImplemented(res, 'picked');
      const date = (url.searchParams.get('date') ?? '').trim();
      if (date && !DATE_RE.test(date)) return this.sendJson(res, 400, { ok: false, error: '日期格式应为 YYYY-MM-DD' });
      this.sendJson(res, 200, { ok: true, ...handler(date || undefined) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/dynamic') {
      const handler = this.handlers.publishDynamic;
      if (!handler) return this.notImplemented(res, 'dynamic');
      const body = await readJsonBody(req);
      if (!isRecord(body)) return this.sendJson(res, 400, { ok: false, message: '请求体要是对象' });
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return this.sendJson(res, 400, { ok: false, message: '内容是空的' });
      const result = await handler({ text, confirm: body.confirm === true, dryRun: body.dryRun === true });
      this.sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    /* ---- 私聊（M4） ---- */

    if (method === 'GET' && url.pathname === '/api/dm') {
      const handler = this.handlers.dm;
      if (!handler) return this.notImplemented(res, 'dm');
      this.sendJson(res, 200, { ok: true, ...(handler() as object) });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/dm/chat') {
      const handler = this.handlers.dmChat;
      if (!handler) return this.notImplemented(res, 'dm/chat');
      const limit = clamp(Number(url.searchParams.get('limit') ?? 50), 1, 500);
      this.sendJson(res, 200, { ok: true, ...(handler(limit) as object) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/dm/send') {
      const handler = this.handlers.dmSend;
      if (!handler) return this.notImplemented(res, 'dm/send');
      const body = await readJsonBody(req);
      if (!isRecord(body)) return this.sendJson(res, 400, { ok: false, message: '请求体要是对象' });
      const kind = body.kind === 'diary' || body.kind === 'video_info' ? body.kind : undefined;
      const result = await handler({
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(kind ? { kind } : {}),
        ...(typeof body.bvid === 'string' ? { bvid: body.bvid } : {}),
      });
      this.sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/dm/chat/clear') {
      const handler = this.handlers.dmClear;
      if (!handler) return this.notImplemented(res, 'dm/chat/clear');
      this.sendJson(res, 200, handler());
      return;
    }

    if (method === 'POST' && url.pathname === '/api/listen/now') {
      const handler = this.handlers.listenNow;
      if (!handler) return this.notImplemented(res, 'listen/now');
      this.sendJson(res, 200, { ok: true, result: await handler() });
      return;
    }

    /* ---- 更新与备份（M5） ---- */

    if (method === 'GET' && url.pathname === '/api/update/check') {
      const handler = this.handlers.checkUpdate;
      if (!handler) return this.notImplemented(res, 'update/check');
      this.sendJson(res, 200, { ok: true, result: await handler() });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/backup') {
      const handler = this.handlers.backup;
      if (!handler) return this.notImplemented(res, 'backup');
      const result = await handler();
      this.sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    /* ---- 动作 ---- */

    if (method === 'POST' && url.pathname === '/api/run') {
      const body = await readJsonBody(req);
      const dryRun = isRecord(body) && 'dryRun' in body ? Boolean(body.dryRun) : false;
      const result = await this.handlers.run({ dryRun });
      this.sendJson(res, result.ok ? 202 : 409, { ok: result.ok, message: result.message });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/pause') {
      this.sendJson(res, 200, this.handlers.pause());
      return;
    }

    if (method === 'POST' && url.pathname === '/api/resume') {
      this.sendJson(res, 200, this.handlers.resume());
      return;
    }

    if (url.pathname === '/api/autostart') {
      if (method === 'GET') {
        this.sendJson(res, 200, { ok: true, ...(await this.handlers.autostart(undefined)) });
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const enabled = isRecord(body) && 'enabled' in body ? Boolean(body.enabled) : true;
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

  /** 浏览器会话 cookie：HttpOnly（JS 读不到）、SameSite=Strict（跨站请求不会带）、7 天。 */
  private sessionCookieHeader(): string {
    return `${SESSION_COOKIE}=${this.sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86_400}`;
  }

  /** 请求里的会话 cookie 是否就是本次进程签发的那个。 */
  private sessionOk(req: http.IncomingMessage): boolean {
    const raw = req.headers.cookie;
    if (typeof raw !== 'string' || raw.length === 0) return false;
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
      const value = part.slice(eq + 1).trim();
      if (value.length === this.sessionId.length && safeEqual(value, this.sessionId)) return true;
    }
    return false;
  }

  /** 没凭据时的说明页（比一行 JSON 友好，也不泄漏任何数据）。 */
  private serveUnauthorizedPage(res: http.ServerResponse): void {
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>BiliWhale · 需要授权</title>
<style>body{font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#1d1d1f;background:#fbfbfa}
h1{font-size:19px}code{background:rgba(127,127,127,.14);padding:1px 6px;border-radius:5px;font-size:13px}
li{margin:6px 0}</style></head>
<body><h1>这个面板需要地址里的 token</h1>
<p>面板只认启动时打印的那个地址，或者托盘里的「打开面板」。可以这样进来：</p>
<ul>
<li>托盘右键 → <b>打开面板</b>（最省事）</li>
<li>用 <code>npm run serve</code> 打印出来的完整地址（带 <code>?token=…</code>）打开</li>
<li>从 <code>runtime.json</code> 里取 <code>url</code> 字段，整条粘到浏览器</li>
</ul>
<p>token 每次启动都会变；内核没在跑时这个页面也打不开。</p>
</body></html>`;
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(html);
  }

  private healthPayload(): HealthPayload {    const base = this.handlers.health();
    return { ...base, ok: !base.lastError, version: this.version, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  /** 静态资源：白名单 + 路径穿越校验。 */
  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative.includes('..') || relative.includes('\0')) {
      this.sendJson(res, 400, { ok: false, error: '非法路径' });
      return;
    }
    const ext = path.extname(relative).toLowerCase();
    if (!MIME[ext]) {
      this.sendJson(res, 404, { ok: false, error: '没有这个文件' });
      return;
    }
    const root = path.resolve(this.uiDir);
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep)) {
      this.sendJson(res, 403, { ok: false, error: '越界了' });
      return;
    }

    let body: Buffer;
    try {
      body = fs.readFileSync(full);
    } catch {
      this.sendJson(res, 404, { ok: false, error: '没有这个文件' });
      return;
    }

    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(body);
  }

  private notImplemented(res: http.ServerResponse, name: string): void {
    this.sendJson(res, 501, { ok: false, error: `这个版本还没有 ${name} 接口` });
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
}

function extractToken(req: http.IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-]+/g, '-');
}
