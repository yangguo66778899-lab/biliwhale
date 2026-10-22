import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { Logger } from '../src/shared/logger.ts';
import { LlmClient, parseChatResponse } from '../src/llm/client.ts';
import { chooseModel, keyFingerprint } from '../src/llm/discovery.ts';
import { tmpDir } from './helpers.ts';

function quietLogger(dir: string): Logger {
  return new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startServer(
  handler: (req: Recorded, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      const recorded: Recorded = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function completionsBody(content: string, toolCalls?: unknown[]): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_cache_hit_tokens: 64 },
  });
}

test('真实 HTTP：请求体与头部符合 DeepSeek 契约，响应解析干净', async () => {
  const dir = tmpDir('llm-http');
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(completionsBody('你好'));
  });

  try {
    const client = new LlmClient({
      apiKey: 'sk-test-123',
      baseUrl: server.baseUrl,
      model: 'deepseek-flash',
      temperature: 0.7,
      maxTokens: 512,
      timeoutMs: 5000,
      maxRetries: 0,
      logger: quietLogger(dir),
    });

    const res = await client.chat({ messages: [{ role: 'user', content: '在吗' }], jsonMode: true });
    assert.equal(res.ok, true, res.ok ? '' : res.error.message);

    const sent = server.requests[0];
    assert.ok(sent);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer sk-test-123');
    assert.match(String(sent.headers['content-type']), /application\/json/);

    const body = JSON.parse(sent.body) as Record<string, unknown>;
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.temperature, 0.7);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: 'json_object' }, 'jsonMode 要下发 response_format');
    assert.deepEqual(body.messages, [{ role: 'user', content: '在吗' }]);

    if (res.ok) {
      assert.equal(res.data.content, '你好');
      assert.deepEqual(res.data.usage, { promptTokens: 120, completionTokens: 30, cachedTokens: 64 });
      assert.equal(res.data.model, 'deepseek-chat', '用响应里的真实模型名');
      assert.equal(res.data.finishReason, 'stop');
    }
  } finally {
    await server.close();
  }
});

test('真实 HTTP：工具调用（tool_calls）能被解析成结构化调用', async () => {
  const dir = tmpDir('llm-tools');
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      completionsBody('', [
        { id: 'call_1', type: 'function', function: { name: 'subtitles_full', arguments: '{"bvid":"BV1a0000001"}' } },
        { id: 'call_2', type: 'function', function: { name: 'comments_thread', arguments: '{"bvid":"BV1a0000001"}' } },
      ]),
    );
  });

  try {
    const client = new LlmClient({
      apiKey: 'k',
      baseUrl: server.baseUrl,
      model: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 512,
      timeoutMs: 5000,
      maxRetries: 0,
      logger: quietLogger(dir),
    });

    const res = await client.chat({
      messages: [{ role: 'user', content: '读这条' }],
      tools: [
        {
          type: 'function',
          function: { name: 'subtitles_full', description: '读完整字幕', parameters: { type: 'object', properties: { bvid: { type: 'string' } }, required: ['bvid'] } },
        },
      ],
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    assert.equal(res.data.toolCalls.length, 2);
    assert.equal(res.data.toolCalls[0]?.id, 'call_1');
    assert.equal(res.data.toolCalls[0]?.function.name, 'subtitles_full');
    assert.deepEqual(JSON.parse(res.data.toolCalls[0]?.function.arguments ?? '{}'), { bvid: 'BV1a0000001' });
    assert.equal(res.data.finishReason, 'tool_calls');

    const sent = JSON.parse(server.requests[0]?.body ?? '{}') as Record<string, unknown>;
    assert.equal(sent.tool_choice, 'auto');
    assert.ok(Array.isArray(sent.tools) && (sent.tools as unknown[]).length === 1);
  } finally {
    await server.close();
  }
});

test('401 / 402 不重试，并给出人话原因', async () => {
  const dir = tmpDir('llm-401');
  for (const status of [401, 402]) {
    const server = await startServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: status === 401 ? 'Authentication Fails' : 'Insufficient Balance' } }));
    });
    try {
      const client = new LlmClient({
        apiKey: 'bad',
        baseUrl: server.baseUrl,
        model: 'deepseek-flash',
        temperature: 0.7,
        maxTokens: 256,
        timeoutMs: 5000,
        maxRetries: 3,
        logger: quietLogger(dir),
      });
      const res = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.kind, 'auth');
        assert.match(res.error.message, status === 401 ? /key 无效|401/ : /余额不足|402/);
      }
      assert.equal(server.requests.length, 1, `${status} 不该重试`);
    } finally {
      await server.close();
    }
  }
});

test('5xx 会重试，成功后返回结果', async () => {
  const dir = tmpDir('llm-500');
  let attempt = 0;
  const server = await startServer((_req, res) => {
    attempt += 1;
    if (attempt === 1) {
      res.writeHead(503);
      res.end('upstream busy');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(completionsBody('第二次成功'));
  });

  try {
    const client = new LlmClient({
      apiKey: 'k',
      baseUrl: server.baseUrl,
      model: 'deepseek-flash',
      temperature: 0.7,
      maxTokens: 256,
      timeoutMs: 5000,
      maxRetries: 2,
      logger: quietLogger(dir),
      sleep: async () => undefined,
    });
    const res = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.data.content, '第二次成功');
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test('超时会以 network 类错误结束，不会挂死', async () => {
  const dir = tmpDir('llm-timeout');
  const server = await startServer((_req, res) => {
    // 故意不回，等客户端超时
    void res;
  });
  try {
    const client = new LlmClient({
      apiKey: 'k',
      baseUrl: server.baseUrl,
      model: 'deepseek-flash',
      temperature: 0.7,
      maxTokens: 256,
      timeoutMs: 250,
      maxRetries: 0,
      logger: quietLogger(dir),
    });
    const started = Date.now();
    const res = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.kind, 'network');
    assert.ok(Date.now() - started < 5000, '应该在超时后很快返回');
  } finally {
    await server.close();
  }
});

test('模型列表：解析 data[].id，坏响应不崩', async () => {
  const dir = tmpDir('llm-models');
  const server = await startServer((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-chat' }, { nope: 1 }] }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  try {
    const client = new LlmClient({
      apiKey: 'k',
      baseUrl: server.baseUrl,
      model: 'deepseek-flash',
      temperature: 0.7,
      maxTokens: 256,
      timeoutMs: 5000,
      maxRetries: 0,
      logger: quietLogger(dir),
    });
    const models = await client.listModels();
    assert.equal(models.ok, true);
    if (models.ok) assert.deepEqual(models.data, ['deepseek-flash', 'deepseek-chat']);
    assert.equal(server.requests[0]?.headers.authorization, 'Bearer k');
  } finally {
    await server.close();
  }
});

test('chooseModel 优先级：配置值 → flash → chat → 任意 deepseek', () => {
  assert.equal(chooseModel(['deepseek-chat', 'deepseek-flash'], 'deepseek-chat').model, 'deepseek-chat');
  assert.equal(chooseModel(['deepseek-chat', 'deepseek-flash'], 'gpt-4').source, 'flash');
  assert.equal(chooseModel(['deepseek-chat'], 'gpt-4').model, 'deepseek-chat');
  assert.equal(chooseModel(['deepseek-v3-0324'], 'gpt-4').source, 'any');
  assert.equal(chooseModel([], 'deepseek-flash').source, 'fallback');
  assert.equal(chooseModel(['some-other'], 'deepseek-flash').model, 'deepseek-flash');
});

test('keyFingerprint 只留 12 位，且同 key 稳定', () => {
  const a = keyFingerprint('sk-abcdefghijklmnopqrstuvwxyz');
  assert.equal(a.length, 12);
  assert.equal(a, keyFingerprint('sk-abcdefghijklmnopqrstuvwxyz'));
  assert.notEqual(a, keyFingerprint('sk-other'));
});

test('parseChatResponse 对缺字段/坏 JSON 有兜底', () => {
  assert.equal(parseChatResponse('not json', 'm').ok, false);
  const noChoices = parseChatResponse(JSON.stringify({ model: 'm' }), 'm');
  assert.equal(noChoices.ok, false);
  const empty = parseChatResponse(JSON.stringify({ choices: [{ message: {} }] }), 'fallback');
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.data.content, '');
    assert.deepEqual(empty.data.toolCalls, []);
    assert.equal(empty.data.model, 'fallback');
  }
});
