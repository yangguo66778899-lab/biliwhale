import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Logger } from '../src/shared/logger.ts';
import { runAgentLoop, stableArgs } from '../src/agent/loop.ts';
import type { LoopInput } from '../src/agent/loop.ts';
import type { ToolRuntime } from '../src/agent/tools.ts';
import type { ChatMessage, ChatResult, ChatRequest, LlmClient, ToolCall } from '../src/llm/client.ts';
import { tmpDir } from './helpers.ts';

function quietLogger(dir: string): Logger {
  return new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

/** 按剧本回放的假模型：记录每次收到的 messages，返回预设响应。 */
function scriptedClient(script: Array<{ content?: string; toolCalls?: ToolCall[]; usage?: Partial<ChatResult['usage']> }>): {
  client: LlmClient;
  seen: ChatMessage[][];
  requests: ChatRequest[];
} {
  const seen: ChatMessage[][] = [];
  const requests: ChatRequest[] = [];
  let index = 0;
  const client = {
    model: 'test-model',
    get model_() {
      return 'test-model';
    },
    async chat(req: ChatRequest) {
      requests.push(req);
      seen.push([...req.messages]);
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      const result: ChatResult = {
        content: step?.content ?? '',
        toolCalls: step?.toolCalls ?? [],
        usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 0, ...(step?.usage ?? {}) },
        model: 'test-model',
        finishReason: step?.toolCalls?.length ? 'tool_calls' : 'stop',
      };
      return { ok: true as const, data: result };
    },
    async listModels() {
      return { ok: true as const, data: ['test-model'] };
    },
  } as unknown as LlmClient;
  return { client, seen, requests };
}

function toolCall(name: string, args: Record<string, unknown>, id = `c${Math.random().toString(36).slice(2, 8)}`): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** 假运行时：记录调用次数，字幕/评论返回固定内容。 */
function fakeRuntime(opts: { subtitleText?: string; failTimes?: number } = {}): {
  runtime: ToolRuntime;
  calls: Array<{ method: string; bvid?: string }>;
} {
  const calls: Array<{ method: string; bvid?: string }> = [];
  let remainingFailures = opts.failTimes ?? 0;
  const runtime = {
    api: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    async video(bvid: string) {
      calls.push({ method: 'video', bvid });
      return { ok: true as const, data: { bvid, aid: 1, cid: 2, title: '标题', desc: '简介', durationSec: 60, pubdateIso: '', owner: { mid: 1, name: 'UP' }, stats: { view: 1, like: 0, reply: 0, favorite: 0, coin: 0, share: 0 }, coverUrl: '' } };
    },
    async subtitleText(bvid: string) {
      calls.push({ method: 'subtitleText', bvid });
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return { ok: false as const, error: { kind: 'network' as const, code: 'network', message: '字幕接口偶发失败' } };
      }
      const text = opts.subtitleText ?? '这是字幕正文，用来验证工具结果能回填进对话。';
      return { ok: true as const, data: { text, chars: text.length, available: text.length > 0 } };
    },
    async topComments(bvid: string) {
      calls.push({ method: 'topComments', bvid });
      return { ok: true as const, data: { count: 1, items: [] } };
    },
  } as unknown as ToolRuntime;
  return { runtime, calls };
}

function baseInput(over: Partial<LoopInput> & { client: LlmClient; runtime: ToolRuntime }): LoopInput {
  const dir = tmpDir('loop');
  return {
    phase: 'deep',
    system: '你是测试用的她。',
    user: '本轮任务：读一条视频。',
    limits: { maxSteps: 6, maxToolCalls: 8, remainingTokens: 100_000 },
    logger: quietLogger(dir),
    ...over,
  };
}

test('工具循环：模型调工具 → 结果回填 → 收敛成最终文本', async () => {
  const { client, seen } = scriptedClient([
    { content: '', toolCalls: [toolCall('subtitles_full', { bvid: 'BV1a0000001' })] },
    { content: '{"done":true}' },
  ]);
  const { runtime, calls } = fakeRuntime();

  const out = await runAgentLoop(baseInput({ client, runtime }));
  assert.equal(out.ok, true);
  if (!out.ok) return;

  assert.equal(out.data.stop, 'final');
  assert.equal(out.data.steps, 2);
  assert.equal(out.data.toolCalls, 1);
  assert.equal(out.data.finalText, '{"done":true}');
  assert.equal(calls.length, 1, '工具应该被执行一次');
  assert.equal(calls[0]?.method, 'subtitleText');

  // 第二次调用模型时，消息里应该带上 assistant.tool_calls 与 role=tool 的结果
  const secondRound = seen[1] ?? [];
  const assistant = secondRound.find((m) => m.role === 'assistant');
  assert.ok(assistant, '要有 assistant 消息');
  assert.equal(assistant && 'tool_calls' in assistant ? assistant.tool_calls?.length : 0, 1);
  const toolMessage = secondRound.find((m) => m.role === 'tool');
  assert.ok(toolMessage, '要有工具结果消息');
  const content = toolMessage && 'content' in toolMessage ? String(toolMessage.content) : '';
  assert.match(content, /<素材 source="subtitles_full">/, '工具结果必须包在素材标签里');
  assert.match(content, /"ok":true/);
  assert.ok(out.data.usage.promptTokens >= 200, '两次调用的 usage 要累加');
});

test('相同工具 + 相同参数：第二次直接吃缓存，不再真发请求', async () => {
  const args = { bvid: 'BV1a0000001' };
  const { client } = scriptedClient([
    { content: '', toolCalls: [toolCall('subtitles_full', args, 'c1')] },
    { content: '', toolCalls: [toolCall('subtitles_full', args, 'c2')] },
    { content: '收尾' },
  ]);
  const { runtime, calls } = fakeRuntime();

  const out = await runAgentLoop(baseInput({ client, runtime }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(calls.length, 1, '第二次同参数调用不应再执行工具');
  assert.equal(out.data.toolCalls, 1, '缓存命中不计入工具调用次数');
});

test('单工具连续失败两次后熔断，不再调用它', async () => {
  const { client } = scriptedClient([
    { content: '', toolCalls: [toolCall('subtitles_full', { bvid: 'BV1a0000002' }, 'c1')] },
    { content: '', toolCalls: [toolCall('subtitles_full', { bvid: 'BV1a0000003' }, 'c2')] },
    { content: '', toolCalls: [toolCall('subtitles_full', { bvid: 'BV1a0000004' }, 'c3')] },
    { content: '还是没读到字幕，收尾。' },
  ]);
  const { runtime, calls } = fakeRuntime({ failTimes: 10 });

  const out = await runAgentLoop(baseInput({ client, runtime }));
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(calls.length, 2, '第三次应被熔断拦住');
  assert.equal(out.data.stop, 'final');
  assert.equal(out.data.toolLog.filter((t) => !t.ok).length, 3, '熔断那次也记一笔失败');
});

test('工具调用次数到达上限就收手（不再执行，也不无限循环）', async () => {
  const { client } = scriptedClient([
    { content: '', toolCalls: [toolCall('comments_thread', { bvid: 'BV1a0000001' }, 'c1')] },
    { content: '', toolCalls: [toolCall('comments_thread', { bvid: 'BV1a0000002' }, 'c2')] },
    { content: '', toolCalls: [toolCall('comments_thread', { bvid: 'BV1a0000003' }, 'c3')] },
  ]);
  const { runtime, calls } = fakeRuntime();

  const out = await runAgentLoop(
    baseInput({ client, runtime, limits: { maxSteps: 6, maxToolCalls: 2, remainingTokens: 100_000 } }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.stop, 'max_tool_calls');
  assert.equal(calls.length, 2, '上限是 2，就不能执行第 3 个');
});

test('token 预算耗尽：停止工具调用并带上已有文本', async () => {
  const { client } = scriptedClient([
    { content: '', toolCalls: [toolCall('subtitles_full', { bvid: 'BV1a0000001' })], usage: { promptTokens: 900, completionTokens: 200 } },
    { content: '预算用完，用已有信息收尾。' },
  ]);
  const { runtime } = fakeRuntime();

  const out = await runAgentLoop(
    baseInput({ client, runtime, limits: { maxSteps: 6, maxToolCalls: 4, remainingTokens: 1000 } }),
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.data.stop, 'budget');
  assert.match(out.data.errorMessage ?? '', /预算/);
});

test('步数上限与模型失败都要有明确的停止原因', async () => {
  const looping = scriptedClient([{ content: '', toolCalls: [toolCall('video_info', { bvid: 'BV1a0000001' })] }]);
  const { runtime } = fakeRuntime();
  const out = await runAgentLoop(baseInput({ client: looping.client, runtime, limits: { maxSteps: 3, maxToolCalls: 99, remainingTokens: 1e6 } }));
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.data.stop, 'max_steps');
    assert.match(out.data.errorMessage ?? '', /步数/);
  }

  const failing = {
    model: 'x',
    async chat() {
      return { ok: false as const, error: { kind: 'auth' as const, code: 401, message: 'API key 无效' } };
    },
    async listModels() {
      return { ok: true as const, data: [] };
    },
  } as unknown as LlmClient;
  const failed = await runAgentLoop(baseInput({ client: failing, runtime }));
  assert.equal(failed.ok, true);
  if (failed.ok) {
    assert.equal(failed.data.stop, 'llm_error');
    assert.match(failed.data.errorMessage ?? '', /API key/);
  }
});

test('相位工具白名单：初筛相位拿不到深读工具', async () => {
  const { client, requests } = scriptedClient([{ content: '{}' }]);
  const { runtime } = fakeRuntime();
  await runAgentLoop(baseInput({ client, runtime, phase: 'screen' }));

  const toolNames = (requests[0]?.tools ?? []).map((t) => t.function.name);
  assert.ok(toolNames.includes('search_videos'));
  assert.ok(toolNames.includes('subtitles_excerpt'));
  assert.ok(!toolNames.includes('subtitles_full'), '初筛不该看到完整字幕工具');
  assert.ok(!toolNames.includes('comments_thread'));
});

test('越权工具调用会被拒绝（模型说要调不存在的工具）', async () => {
  const { client, seen } = scriptedClient([
    { content: '', toolCalls: [toolCall('post_comment', { bvid: 'BV1a0000001', text: '刷屏' })] },
    { content: '我没有这个工具，收尾。' },
  ]);
  const { runtime } = fakeRuntime();
  const out = await runAgentLoop(baseInput({ client, runtime }));
  assert.equal(out.ok, true);
  if (!out.ok) return;

  const toolMessage = (seen[1] ?? []).find((m) => m.role === 'tool');
  const content = toolMessage && 'content' in toolMessage ? String(toolMessage.content) : '';
  assert.match(content, /本轮没有这个工具：post_comment/);
  assert.equal(out.data.stop, 'final');
});

test('stableArgs 让参数顺序不影响去重', () => {
  assert.equal(stableArgs('{"b":1,"a":2}'), stableArgs('{"a":2,"b":1}'));
});
