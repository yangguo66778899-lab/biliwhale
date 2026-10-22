/**
 * 离线栈：用夹具代替真实 B 站，用脚本化响应代替真实模型。
 *
 * 职责：让「取候选 → 初筛 → 深读 → 落盘」整条链路可以在不联网、不花钱的情况下验证。
 *   也正因为如此，golden 测试与 CI 都不必碰真实接口。
 * 不做什么：不模拟限速/风控细节（那是 http 层的事，用单元测试单独覆盖）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { Paths } from '../state/paths.ts';
import type { Result } from '../shared/errors.ts';
import type { BiliEnvelope, Transport, TransportRequest } from '../bili/http.ts';
import { BiliApi } from '../bili/api.ts';
import { parseEnvelope, unwrapBiliEnvelope } from '../bili/http.ts';
import { LlmClient } from '../llm/client.ts';

interface FixtureRule {
  match: string[];
  file: string;
}

interface FixtureIndex {
  rules: FixtureRule[];
}

export interface OfflineOptions {
  paths: Paths;
  logger: Logger;
  config: Config;
  /** 默认用 <cwd>/fixtures。 */
  fixturesDir?: string;
  /** 覆盖模型剧本（默认 fixtures/llm/screen.json + deep.json，按调用顺序取）。 */
  llmFiles?: string[];
}

export interface OfflineStack {
  api: BiliApi;
  llm: LlmClient;
  /** 脚本化模型一共被调了几次（测试断言用）。 */
  llmCalls: () => number;
}

export function createOfflineStack(opts: OfflineOptions): OfflineStack {
  const fixturesDir = opts.fixturesDir ?? opts.paths.fixturesDir;
  const transport = new FixtureTransport(path.join(fixturesDir, 'bili'), opts.logger);
  const api = new BiliApi(transport, opts.logger);
  const scripted = makeScriptedFetch({
    files: opts.llmFiles ?? [path.join(fixturesDir, 'llm', 'screen.json'), path.join(fixturesDir, 'llm', 'deep.json')],
    logger: opts.logger,
  });
  const llm = new LlmClient({
    apiKey: 'offline-fixture-key',
    baseUrl: 'https://offline.local',
    model: opts.config.llm.model,
    temperature: 0,
    maxTokens: opts.config.llm.maxTokens,
    timeoutMs: 5000,
    maxRetries: 0,
    logger: opts.logger,
    fetchImpl: scripted.fetchImpl,
    sleep: async () => undefined,
  });
  return { api, llm, llmCalls: scripted.calls };
}

/** 夹具路由：URL 里包含 match 里所有子串即命中。 */
export class FixtureTransport implements Transport {
  private readonly rules: FixtureRule[];
  private readonly dir: string;
  private readonly logger: Logger;

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger;
    const indexFile = path.join(dir, 'index.json');
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as FixtureIndex;
    this.rules = parsed.rules;
  }

  async json<T>(req: TransportRequest): Promise<Result<T>> {
    const file = this.resolve(req);
    if (!file) return notFound(req.url);
    const text = fs.readFileSync(file, 'utf8');
    try {
      return unwrapBiliEnvelope<T>(JSON.parse(text));
    } catch (err) {
      return { ok: false, error: { kind: 'parse', code: 'parse', message: `夹具解析失败：${String(err)}` } };
    }
  }

  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<BiliEnvelope<T>>> {
    const file = this.resolve(req);
    if (!file) return notFound(req.url);
    return parseEnvelope<T>(fs.readFileSync(file, 'utf8'));
  }

  async text(req: TransportRequest): Promise<Result<string>> {
    const file = this.resolve(req);
    if (!file) return notFound(req.url);
    return { ok: true, data: fs.readFileSync(file, 'utf8') };
  }

  private resolve(req: TransportRequest): string | null {
    const full = buildFullUrl(req);
    for (const rule of this.rules) {
      if (rule.match.every((needle) => full.includes(needle))) {
        const file = path.join(this.dir, rule.file);
        if (fs.existsSync(file)) return file;
        this.logger.warn('fixtures', `规则命中了但夹具文件不存在：${rule.file}`);
      }
    }
    return null;
  }
}

function buildFullUrl(req: TransportRequest): string {
  const query = Object.entries(req.query ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');
  return query ? `${req.url}?${query}` : req.url;
}

function notFound<T = never>(url: string): Result<T> {
  return { ok: false, error: { kind: 'notfound', code: 'fixture_missing', message: `夹具里没有这条请求：${url}` } };
}

/* ---------- 脚本化模型 ---------- */

interface ScriptedOptions {
  files: string[];
  logger: Logger;
}

export function makeScriptedFetch(opts: ScriptedOptions): {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: () => number;
} {
  let index = 0;
  let calls = 0;

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith('/models')) {
      return jsonResponse({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-chat', object: 'model' }] });
    }
    if (!input.includes('/chat/completions')) {
      return new Response('not found', { status: 404 });
    }

    calls += 1;
    const file = opts.files[index];
    index = Math.min(index + 1, opts.files.length - 1);
    if (!file) return new Response(JSON.stringify({ error: { message: '没有更多脚本化响应了' } }), { status: 500 });

    const content = fs.readFileSync(file, 'utf8');
    const promptTokens = Math.max(200, estimateRequestTokens(init));
    const completionTokens = Math.max(50, Math.round(content.length / 2));
    opts.logger.debug('offline', `脚本化模型响应 ${calls}：${path.basename(file)}`, { promptTokens, completionTokens });

    return jsonResponse({
      id: `fixture-${calls}`,
      object: 'chat.completion',
      model: 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
  };

  return { fetchImpl, calls: () => calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function estimateRequestTokens(init?: RequestInit): number {
  const body = typeof init?.body === 'string' ? init.body : '';
  return Math.round(body.length / 3);
}
