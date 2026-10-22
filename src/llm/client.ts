/**
 * DeepSeek 适配层（唯一一个知道「API 长什么样」的文件）。
 *
 * 职责：把「消息 + 工具定义」发出去，拿回「文本 / 工具调用 / usage」；重试与超时在这里做。
 * 不做什么：不做多模型适配（只锁 DeepSeek）、不组装 prompt（agent 层）、不解析业务 JSON（output 层）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import { redact } from '../shared/redact.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string };

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** DeepSeek 上下文缓存命中的输入 token（有就记，没有就是 0）。 */
  cachedTokens: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  finishReason: string;
}

export interface LlmOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  logger: Logger;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 强制 JSON 输出（DeepSeek 的 response_format=json_object）。 */
  jsonMode?: boolean;
  model?: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class LlmClient {
  private readonly opts: LlmOptions;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: LlmOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get model(): string {
    return this.opts.model;
  }

  setModel(model: string): void {
    this.opts.model = model;
  }

  /** 一轮对话（可能带工具调用）。 */
  async chat(req: ChatRequest): Promise<Result<ChatResult>> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.model,
      messages: req.messages,
      temperature: req.temperature ?? this.opts.temperature,
      max_tokens: req.maxTokens ?? this.opts.maxTokens,
      stream: false,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    if (req.jsonMode) body.response_format = { type: 'json_object' };

    const attempts = this.opts.maxRetries + 1;
    let lastMessage = '';

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });

        const text = await res.text();

        if (!res.ok) {
          const detail = extractApiError(text);
          lastMessage = `HTTP ${res.status}：${detail}`;
          // 401/402 不重试：key 错了或余额没了，重试没有意义
          if (res.status === 401 || res.status === 402) {
            return {
              ok: false,
              error: {
                kind: 'auth',
                code: res.status,
                message:
                  res.status === 401
                    ? 'API key 无效或已失效（401）'
                    : '账户余额不足（402），请到 DeepSeek 控制台充值',
              },
            };
          }
          if (RETRYABLE_STATUS.has(res.status) && attempt < attempts - 1) {
            await this.backoff(attempt);
            continue;
          }
          return { ok: false, error: { kind: 'network', code: res.status, message: lastMessage } };
        }

        return parseChatResponse(text, body.model as string);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastMessage = `请求失败：${message}`;
        if (attempt < attempts - 1) {
          this.opts.logger.warn('llm', `请求失败，准备重试（第 ${attempt + 1} 次）：${message}`);
          await this.backoff(attempt);
          continue;
        }
      }
    }
    return { ok: false, error: { kind: 'network', code: 'network', message: lastMessage || '调用失败' } };
  }

  /** 模型列表（自动发现用）。接口不可用时返回错误，由上层回退到配置值。 */
  async listModels(): Promise<Result<string[]>> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs, 30_000)),
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: { kind: 'network', code: res.status, message: `模型列表不可用（HTTP ${res.status}）` } };
      }
      const parsed = JSON.parse(text) as { data?: Array<{ id?: unknown }> };
      const ids = Array.isArray(parsed.data)
        ? parsed.data.map((m) => (typeof m.id === 'string' ? m.id : '')).filter((id) => id.length > 0)
        : [];
      return { ok: true, data: ids };
    } catch (err) {
      return { ok: false, error: { kind: 'network', code: 'network', message: `模型列表获取失败：${String(err)}` } };
    }
  }

  private async backoff(attempt: number): Promise<void> {
    await this.sleep(Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 300);
  }
}

export function parseChatResponse(text: string, fallbackModel: string): Result<ChatResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: 'parse', code: 'parse', message: `模型响应不是 JSON：${redact(text).slice(0, 200)}` } };
  }
  const obj = parsed as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
    usage?: Record<string, unknown>;
  };
  const choice = obj.choices?.[0];
  if (!choice) {
    return { ok: false, error: { kind: 'parse', code: 'parse', message: '模型响应里没有 choices' } };
  }
  const message = choice.message ?? {};
  const content = typeof message.content === 'string' ? message.content : '';
  const toolCalls = normalizeToolCalls(message.tool_calls);
  const usage = obj.usage ?? {};

  return {
    ok: true,
    data: {
      content,
      toolCalls,
      usage: {
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        cachedTokens: num(usage.prompt_cache_hit_tokens ?? usage.cached_tokens),
      },
      model: typeof obj.model === 'string' ? obj.model : fallbackModel,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
    },
  };
}

function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const call = item as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call.function?.name === 'string' ? call.function.name : '';
    if (!name) continue;
    out.push({
      id: typeof call.id === 'string' ? call.id : `call_${out.length}`,
      type: 'function',
      function: { name, arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}' },
    });
  }
  return out;
}

function extractApiError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; type?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.length > 0) return redact(message).slice(0, 300);
  } catch {
    /* 非 JSON 错误体 */
  }
  return redact(text).slice(0, 300);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
