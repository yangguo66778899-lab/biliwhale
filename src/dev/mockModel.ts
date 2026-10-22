/**
 * 模拟模型（只用于验证链路，不代表任何质量）。
 *
 * 职责：顶替 DeepSeek，按 prompt 里出现的 BV 号生成**结构合法**的初筛/深读输出。
 *   这样可以把「真实 B 站数据 + 编排器 + 落盘」整条链路跑通，而不需要 API key、不花钱。
 * 不做什么：不判断内容好不好（分数是按顺序给的占位值）；不假装这是模型质量验证。
 *   产出的日记/通知里会明确写「mock 模型占位文本」。
 */

import type { Logger } from '../shared/logger.ts';

export interface MockModelOptions {
  logger: Logger;
}

export interface MockModelHandle {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  calls: () => number;
}

const BVID_RE = /BV[0-9A-Za-z]{10}/g;

export function makeMockModelFetch(opts: MockModelOptions): MockModelHandle {
  let calls = 0;

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith('/models')) {
      return jsonResponse({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
    }
    if (!input.includes('/chat/completions')) return new Response('not found', { status: 404 });

    calls += 1;
    const body = safeParse(init?.body) as { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
    const prompt = collectUserText(body);
    const isScreen = prompt.includes('初筛打分');
    const content = isScreen ? screenOutput(prompt) : deepOutput(prompt);
    opts.logger.warn('mock', `模拟模型第 ${calls} 次调用（${isScreen ? '初筛' : '深读'}）：只验证链路，不代表质量`);

    const promptTokens = Math.max(100, Math.round(prompt.length / 3));
    const completionTokens = Math.round(content.length / 3);
    return jsonResponse({
      id: `mock-${calls}`,
      object: 'chat.completion',
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
  };

  return { fetchImpl, calls: () => calls };
}

function screenOutput(prompt: string): string {
  const bvids = uniqueBvids(prompt);
  const items = bvids.map((bvid, index) => ({
    bvid,
    score: Math.max(20 - index * 3, 1),
    reason: `mock 占位理由：按候选顺序给的分（第 ${index + 1} 条）`,
    deep: index < 3,
  }));
  return JSON.stringify({ items, notes: 'mock 模型：分数是占位值，不代表内容质量' });
}

function deepOutput(prompt: string): string {
  const bvids = uniqueBvids(prompt);
  const selected = bvids.slice(0, Math.min(2, bvids.length)).map((bvid, index) => ({
    bvid,
    score: index === 0 ? 16 : 14,
    why: `mock 占位理由：这条是第 ${index + 1} 个深读对象，链路验证用；真实判断要等真模型。`,
    oneliner: `mock 一句话：第 ${index + 1} 条深读对象`,
    share: { channel: 'none', text: '', reason: 'mock 模型不提案分享' },
  }));
  const skipped = bvids.slice(2).map((bvid) => ({ bvid, reason: 'low_score', note: 'mock：只深读了前两条' }));

  return JSON.stringify({
    selected,
    skipped,
    favorite: null,
    dynamic: null,
    diary: {
      public: [
        '（mock 模型占位文本：这一轮只用真实 B 站数据验证了链路，内容判断不是真的。）',
        `这轮读了 ${bvids.length} 条候选，深读了 ${Math.min(3, bvids.length)} 条。真实日记要等接上真模型才会写。`,
      ].join('\n\n'),
      private: [
        `偏好校准：这一轮是 mock 模型跑的，没有真实判断，不改任何偏好。`,
        `链路验证结论：候选 ${bvids.length} 条，深读 ${Math.min(3, bvids.length)} 条，落盘正常。`,
      ].join('\n\n'),
    },
    report_md: '',
    notify: '（mock 模型）本轮只验证链路，没有真实判断。',
    notes: 'mock 模型输出：用于验证真实 B 站数据能否走完整轮',
  });
}

function uniqueBvids(prompt: string): string[] {
  const found = prompt.match(BVID_RE) ?? [];
  return [...new Set(found)];
}

function collectUserText(body: { messages?: Array<{ role?: string; content?: unknown }> } | undefined): string {
  if (!body?.messages) return '';
  return body.messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => String(m.content))
    .join('\n');
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
