/**
 * 工具调用循环。
 *
 * 职责：一轮相位内的「调模型 → 执行工具 → 回填结果 → 再调模型」直到收敛。
 *   预算与熔断都在代码里做（不靠 prompt 里写「失败两次就跳过」）：
 *   - 步数上限、工具调用上限、token 预算；
 *   - 单工具连续失败 2 次 → 熔断该工具；
 *   - 相同工具 + 相同参数第二次直接返回上一次结果，不再真发请求。
 * 不做什么：不组装 prompt、不解析业务 JSON（output 层）、不写文件。
 */

import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import type { ChatMessage, ToolDefinition, Usage } from '../llm/client.ts';
import { LlmClient } from '../llm/client.ts';
import type { Phase } from './tools.ts';
import { executeTool, toolDefinitions } from './tools.ts';
import type { ToolRuntime } from './tools.ts';
import { wrapMaterial } from './prompts.ts';

export interface LoopLimits {
  maxSteps: number;
  maxToolCalls: number;
  /** 本轮剩余可用的 token（含输入+输出）。 */
  remainingTokens: number;
}

export type LoopStop = 'final' | 'max_steps' | 'max_tool_calls' | 'budget' | 'llm_error';

export interface LoopOutcome {
  finalText: string;
  steps: number;
  toolCalls: number;
  usage: Usage;
  stop: LoopStop;
  errorMessage?: string;
  /** 给 run 记录用：工具名 + 成功与否。 */
  toolLog: Array<{ name: string; ok: boolean; ms: number }>;
}

export interface LoopInput {
  client: LlmClient;
  phase: Phase;
  system: string;
  user: string;
  runtime: ToolRuntime;
  limits: LoopLimits;
  logger: Logger;
  /** 强制 JSON 输出（初筛相位用）。 */
  jsonMode?: boolean;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const TOOL_FAILURE_BREAKER = 2;

export async function runAgentLoop(input: LoopInput): Promise<Result<LoopOutcome>> {
  const tools: ToolDefinition[] = toolDefinitions(input.phase);
  const messages: ChatMessage[] = [
    { role: 'system', content: input.system },
    { role: 'user', content: input.user },
  ];

  const usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  const toolLog: Array<{ name: string; ok: boolean; ms: number }> = [];
  const failureStreak = new Map<string, number>();
  const memo = new Map<string, string>();
  let toolCallsUsed = 0;
  let steps = 0;

  for (let step = 0; step < input.limits.maxSteps; step += 1) {
    steps = step + 1;
    const res = await input.client.chat({
      messages,
      tools,
      ...(input.jsonMode ? { jsonMode: true } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    });

    if (!res.ok) {
      return {
        ok: true,
        data: {
          finalText: '',
          steps,
          toolCalls: toolCallsUsed,
          usage,
          stop: 'llm_error',
          errorMessage: res.error.message,
          toolLog,
        },
      };
    }

    const chat = res.data;
    usage.promptTokens += chat.usage.promptTokens;
    usage.completionTokens += chat.usage.completionTokens;
    usage.cachedTokens += chat.usage.cachedTokens;

    const spent = usage.promptTokens + usage.completionTokens;
    if (spent > input.limits.remainingTokens) {
      return {
        ok: true,
        data: {
          finalText: chat.content,
          steps,
          toolCalls: toolCallsUsed,
          usage,
          stop: 'budget',
          errorMessage: `本轮 token 预算用尽（${spent}/${input.limits.remainingTokens}）`,
          toolLog,
        },
      };
    }

    if (chat.toolCalls.length === 0) {
      return { ok: true, data: { finalText: chat.content, steps, toolCalls: toolCallsUsed, usage, stop: 'final', toolLog } };
    }

    if (toolCallsUsed >= input.limits.maxToolCalls) {
      return {
        ok: true,
        data: {
          finalText: chat.content,
          steps,
          toolCalls: toolCallsUsed,
          usage,
          stop: 'max_tool_calls',
          errorMessage: `工具调用到达上限（${input.limits.maxToolCalls}）`,
          toolLog,
        },
      };
    }

    messages.push({ role: 'assistant', content: chat.content || null, tool_calls: chat.toolCalls });

    for (const call of chat.toolCalls) {
      if (toolCallsUsed >= input.limits.maxToolCalls) break;
      const name = call.function.name;
      const memoKey = `${name}:${stableArgs(call.function.arguments)}`;

      const cached = memo.get(memoKey);
      if (cached) {
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: wrapMaterial('tool', `（重复调用，这里是上一次的结果，不再重复请求）\n${cached}`) });
        continue;
      }

      const failures = failureStreak.get(name) ?? 0;
      if (failures >= TOOL_FAILURE_BREAKER) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: wrapMaterial('tool', JSON.stringify({ ok: false, error: { kind: 'business', code: 'breaker', message: `${name} 连续失败 ${failures} 次，本轮熔断，不要再调用它` } })),
        });
        toolLog.push({ name, ok: false, ms: 0 });
        continue;
      }

      const startedAt = Date.now();
      const executed = await executeTool(name, call.function.arguments, input.phase, input.runtime);
      const ms = Date.now() - startedAt;
      toolCallsUsed += 1;
      toolLog.push({ name, ok: !executed.isError, ms });

      if (executed.isError) {
        failureStreak.set(name, failures + 1);
        input.logger.warn('agent', `工具失败：${name}`, { ms, streak: failures + 1 });
      } else {
        failureStreak.set(name, 0);
        memo.set(memoKey, executed.content);
      }

      messages.push({ role: 'tool', tool_call_id: call.id, name, content: executed.content });
    }
  }

  return {
    ok: true,
    data: {
      finalText: '',
      steps,
      toolCalls: toolCallsUsed,
      usage,
      stop: 'max_steps',
      errorMessage: `步数到达上限（${input.limits.maxSteps}）`,
      toolLog,
    },
  };
}

/** 参数归一化：键排序后序列化，用于判断「同工具同参数」。 */
export function stableArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson || '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null) return argsJson;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(parsed as Record<string, unknown>).sort()) {
      sorted[key] = (parsed as Record<string, unknown>)[key];
    }
    return JSON.stringify(sorted);
  } catch {
    return argsJson;
  }
}
