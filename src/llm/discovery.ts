/**
 * 模型发现。
 *
 * 职责：按 key 可用模型挑一个能用的模型，优先级写死在这里：
 *   配置的 model（若在列表） → `deepseek-flash` → `deepseek-chat` → 任一含 `deepseek` 的 chat 档。
 *   接口不支持 / 网络失败 → 回退配置值，不猜、不崩。
 * 不做什么：不做多供应商、不做能力探测（除了按名字排除明显不是 chat 的档）。
 */

import crypto from 'node:crypto';
import type { Logger } from '../shared/logger.ts';
import type { LlmClient } from './client.ts';

export interface ModelDecision {
  model: string;
  source: 'config' | 'flash' | 'chat' | 'any' | 'fallback';
  available: string[];
  note: string;
}

/** 纯函数：给定可用列表与配置值，选出要用的模型。 */
export function chooseModel(available: string[], configured: string): ModelDecision {
  const list = [...new Set(available.map((m) => m.trim()).filter((m) => m.length > 0))];
  if (list.length === 0) {
    return { model: configured, source: 'fallback', available: [], note: '没有可用模型列表，用配置值' };
  }
  const exact = list.find((m) => m === configured);
  if (exact) return { model: exact, source: 'config', available: list, note: '配置的模型在列表里' };

  const flash = list.find((m) => /(^|[-_/])flash($|[-_/])/i.test(m) || m.toLowerCase() === 'deepseek-flash');
  if (flash) return { model: flash, source: 'flash', available: list, note: '按优先级选到 flash 档' };

  const chat = list.find((m) => m.toLowerCase() === 'deepseek-chat');
  if (chat) return { model: chat, source: 'chat', available: list, note: '没有 flash 档，用 deepseek-chat' };

  const anyDeepseek = list.find((m) => /deepseek/i.test(m) && /(chat|flash|instruct|v\d)/i.test(m));
  if (anyDeepseek) return { model: anyDeepseek, source: 'any', available: list, note: '用列表里第一个像是 chat 档的 deepseek 模型' };

  return { model: configured, source: 'fallback', available: list, note: '列表里没有可用 deepseek 模型，用配置值' };
}

/** key 指纹：只用来判断「换了 key 要重新发现」，永不落 key 本身。 */
export function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

export interface DiscoverInput {
  client: LlmClient;
  configured: string;
  modelAuto: boolean;
  logger: Logger;
}

/** 真正去问一次 `/models`。失败不抛：回退配置值。 */
export async function discoverModel(input: DiscoverInput): Promise<ModelDecision> {
  if (!input.modelAuto) {
    return { model: input.configured, source: 'config', available: [], note: '自动发现关闭' };
  }
  const listed = await input.client.listModels();
  if (!listed.ok) {
    input.logger.warn('llm', `模型列表不可用，回退配置值 ${input.configured}：${listed.error.message}`);
    return { model: input.configured, source: 'fallback', available: [], note: listed.error.message };
  }
  const decision = chooseModel(listed.data, input.configured);
  if (decision.model !== input.configured) {
    input.logger.info('llm', `模型发现：${input.configured} → ${decision.model}（${decision.note}）`);
  }
  return decision;
}
