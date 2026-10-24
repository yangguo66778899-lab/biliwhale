import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeComments, composeDiary } from '../src/orchestrator/compose.ts';
import { buildDiaryPrompt } from '../src/orchestrator/prompts.ts';
import { LlmClient } from '../src/llm/client.ts';
import { Logger } from '../src/shared/logger.ts';
import { validateConfig } from '../src/config/validate.ts';
import { tmpDir } from './helpers.ts';
import type { DeepRead, RoundResult } from '../src/shared/types.ts';

const VIDEO = {
  bvid: 'BV1x',
  aid: 1,
  cid: 1,
  title: '测试视频',
  desc: '简介',
  durationSec: 240,
  pubdateIso: '2026-10-23T10:00:00+08:00',
  owner: { mid: 1, name: 'UP' },
  stats: { view: 0, like: 0, reply: 0, favorite: 0, coin: 0, share: 0 },
  coverUrl: 'about:blank',
};

function deep(): DeepRead {
  return {
    bvid: 'BV1x',
    subtitle: '第一句\n第二句',
    subtitleChars: 8,
    comments: [{ rpid: '1', parent: '0', root: '0', mid: 2, uname: '观众', message: '好看', like: 3, ctimeIso: '', replies: [] }],
    video: VIDEO,
  };
}

function llmReturning(content: string): LlmClient {
  const dir = tmpDir('compose');
  return new LlmClient({
    apiKey: 'k',
    baseUrl: 'https://offline.local',
    model: 'm',
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 1000,
    maxRetries: 0,
    logger: new Logger({ logDir: dir, eventsFile: `${dir}/e.jsonl`, level: 'error' }),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as never,
  });
}

const config = (() => {
  const parsed = validateConfig({ share: { enabled: true, comment: { plain: true, maxChars: 150 } } });
  assert.ok(parsed.ok);
  return parsed.value;
})();

test('写评论：解析 comment/share，末尾句号去掉，字数截断', async () => {
  const deps = { llm: llmReturning(JSON.stringify({ comment: '这刀接得真狠。', share: '给你看看[doge]' })), logger: new Logger({ logDir: tmpDir('c2'), eventsFile: `${tmpDir('c2')}/e.jsonl`, level: 'error' }), persona: '' };
  const result = await composeComments(deps, {
    item: { bvid: 'BV1x', score: 14, why: '理由够长够长', oneliner: '一句话', comment: { want: true, text: '' }, share: { channel: 'comment', text: '', reason: '' } },
    deep: deep(),
    config,
    ownerName: '你',
  });
  assert.equal(result.plainText, '这刀接得真狠', '末尾句号要机械去掉');
  assert.equal(result.shareText, '给你看看[doge]');
  assert.equal(result.usage.calls, 1);
});

test('写评论：模型回坏 JSON 时如实说没写成，不编文案', async () => {
  const deps = { llm: llmReturning('随便说点什么'), logger: new Logger({ logDir: tmpDir('c3'), eventsFile: `${tmpDir('c3')}/e.jsonl`, level: 'error' }), persona: '' };
  const result = await composeComments(deps, {
    item: { bvid: 'BV1x', score: 14, why: '理由够长够长', oneliner: '一句话' },
    deep: deep(),
    config,
    ownerName: '你',
  });
  assert.equal(result.plainText, '');
  assert.equal(result.shareText, '');
  assert.match(result.notes.join('；'), /没按要求回 JSON/);
});

test('写日记：解析两段，并把表情码机械清掉', async () => {
  const deps = { llm: llmReturning(JSON.stringify({ public: '今天看到一句[doge]挺好的', private: '下次多看这种' })), logger: new Logger({ logDir: tmpDir('d2'), eventsFile: `${tmpDir('d2')}/e.jsonl`, level: 'error' }), persona: '' };
  const result = await composeDiary(deps, {
    date: '2026-10-23',
    result: { selected: [{ bvid: 'BV1x', score: 14, why: 'x', oneliner: '一句话' }], skipped: [] } as unknown as RoundResult,
    deepReads: [deep()],
  });
  assert.equal(/\[[^\]]+\]/u.test(result.diary.public), false, '日记里不该有表情码');
  assert.equal(result.diary.private, '下次多看这种');
});

test('日记提示词带 few-shot 样例和「学写法不学事实」的口径', () => {
  const prompt = buildDiaryPrompt({
    date: '2026-10-24',
    watched: [{ title: '测试视频', up: 'UP', oneLine: '一句话' }],
    persona: '我叫鲸鲸',
  });
  assert.match(prompt, /黏土捏小蛋糕/u, '样例要真的进来（用户给的 9 篇）');
  assert.match(prompt, /学写法，不学事实/u);
  assert.match(prompt, /不用交代视频讲了什么/u);
  assert.match(prompt, /截屏存图、下载、搜索这种别写成做过/u);
  // 正例里那两条老样例（油泼面 / 出租屋）已被用户换掉，不该再出现
  assert.equal(prompt.includes('油泼面'), false);
});
