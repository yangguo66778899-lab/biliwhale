import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, fallbackRoundResult, validateRoundResult, validateScreenResult } from '../src/agent/output.ts';
import type { RoundContext } from '../src/agent/output.ts';
import {
  cuesToText,
  fromSearchItem,
  fromView,
  normalizeSubtitleUrl,
  parseDuration,
  pickTrack,
  stripHtml,
} from '../src/bili/api.ts';
import { stableArgs } from '../src/agent/loop.ts';

const ctx: RoundContext = {
  deepReadBvids: new Set(['BV1a0000001', 'BV1a0000005']),
  maxVideos: 5,
  shareChannels: ['comment'],
  shareMaxChars: 150,
  scoreMin: 13,
};

test('extractJson 能吃掉三种常见形态', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('好的，这是结果：\n{"a":3}\n希望有帮助'), { a: 3 });
  assert.deepEqual(extractJson('```JSON\n{"a":4}\n```'), { a: 4 });
  assert.equal(extractJson('完全不是 JSON'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('```json\n{bad json}\n```'), null);
});

test('初筛结果：只认本轮候选，分数夹到 0–20，重复条目去重', () => {
  const result = validateScreenResult(
    {
      items: [
        { bvid: 'BV1a0000001', score: 99, reason: '很好' },
        { bvid: 'BV1a0000001', score: 10, reason: '重复' },
        { bvid: 'BV1a0000005', score: -3, reason: '负数' },
      ],
    },
    new Set(['BV1a0000001', 'BV1a0000005']),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.items.length, 2);
  assert.equal(result.data.items[0]?.score, 20);
  assert.equal(result.data.items[1]?.score, 0);

  const outsider = validateScreenResult({ items: [{ bvid: 'BV999', score: 10, reason: 'x' }] }, new Set(['BV1a0000001']));
  assert.equal(outsider.ok, false);

  const empty = validateScreenResult({ items: [] }, new Set(['BV1a0000001']));
  assert.equal(empty.ok, false);
});

test('最终结果：selected 必须来自深读，理由不能太短', () => {
  const good = validateRoundResult(
    {
      selected: [
        {
          bvid: 'BV1a0000001',
          score: 16,
          why: '字幕里给了三个工具的实测对比，还有具体结论。',
          oneliner: '越像人的工具越难用',
          share: { channel: 'comment', text: '这个结论我认。', reason: '分数最高' },
        },
      ],
      skipped: [{ bvid: 'BV1a0000005', reason: 'low_score' }],
      favorite: null,
      dynamic: null,
      diary: { public: '今天看到一条说周报的。', private: '偏好校准：他好像更喜欢有具体数据的。' },
      report_md: '',
      notify: '挑中一条',
      notes: '',
    },
    ctx,
  );
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.data.selected.length, 1);
    assert.equal(good.data.selected[0]?.share?.channel, 'comment');
  }

  const notDeep = validateRoundResult(
    {
      selected: [{ bvid: 'BV1a0000002', score: 18, why: '理由够长了吧这里', oneliner: '一句话' }],
      skipped: [],
      diary: { public: 'x', private: 'y' },
    },
    ctx,
  );
  assert.equal(notDeep.ok, false);
  if (!notDeep.ok) assert.match(notDeep.error.message, /没有深读过/);

  const shortWhy = validateRoundResult(
    {
      selected: [{ bvid: 'BV1a0000001', score: 18, why: '好', oneliner: '一句话' }],
      skipped: [],
      diary: { public: 'x', private: 'y' },
    },
    ctx,
  );
  assert.equal(shortWhy.ok, false);

  const noDiary = validateRoundResult({ selected: [], skipped: [], diary: { public: '', private: 'y' } }, ctx);
  assert.equal(noDiary.ok, false);
  if (!noDiary.ok) assert.match(noDiary.error.message, /diary.public/);
});

test('最终结果：渠道未开时丢掉 share，未知跳过原因归 other，超长文案被截断', () => {
  const result = validateRoundResult(
    {
      selected: [
        {
          bvid: 'BV1a0000001',
          score: 15,
          why: '理由足够长，能通过校验。',
          oneliner: '一句话',
          share: { channel: 'dm', text: '想走私信', reason: 'x' },
        },
      ],
      skipped: [{ bvid: 'BV1a0000005', reason: '因为我不喜欢', note: '随手写的' }],
      diary: { public: '公开'.repeat(5000), private: '私人' },
      notify: '',
    },
    ctx,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.selected[0]?.share, undefined, 'channel 不在允许列表里应被丢掉');
  assert.equal(result.data.skipped[0]?.reason, 'other');
  assert.ok((result.data.diary.public.length ?? 0) <= 6000);
  assert.ok((result.data.notify.length ?? 0) > 0, '没有 notify 时应给出兜底一句');
});

test('降级结果自带诚实的日记与说明', () => {
  const fallback = fallbackRoundResult({ reason: '模型不可用', skipped: [] });
  assert.equal(fallback.selected.length, 0);
  assert.match(fallback.diary.public, /今天没看成/);
  assert.match(fallback.diary.private, /偏好校准/);
  assert.match(fallback.notes, /degraded/);
});

/* ---------- B 站字段映射 ---------- */

test('parseDuration 支持 mm:ss、hh:mm:ss、纯秒数', () => {
  assert.equal(parseDuration('12:34'), 754);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('754'), 754);
  assert.equal(parseDuration(754), 754);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration('abc'), 0);
  assert.equal(parseDuration(undefined), 0);
});

test('stripHtml 去掉高亮标签与实体', () => {
  assert.equal(stripHtml('<em class="keyword">AI</em> 工具 &amp; 键盘'), 'AI 工具 & 键盘');
  assert.equal(stripHtml('a &quot;b&quot; &#39;c&#39;'), 'a "b" \'c\'');
});

test('fromSearchItem 剥标签、解析字符串时长、缺 bvid 返回 null', () => {
  const video = fromSearchItem(
    {
      bvid: 'BV1xx',
      aid: 1,
      title: '<em class="keyword">猫</em>的一天',
      description: '记录 &amp; 观察',
      author: 'UP',
      play: '123',
      review: '9',
      duration: '05:23',
      pubdate: 1750000000,
    },
    'search',
  );
  assert.ok(video);
  assert.equal(video?.title, '猫的一天');
  assert.equal(video?.desc, '记录 & 观察');
  assert.equal(video?.durationSec, 323);
  assert.equal(video?.stats.view, 123);
  assert.equal(video?.stats.reply, 9);
  assert.equal(video?.cid, 0, '搜索结果没有 cid，必须留 0 等 view 补');
  assert.equal(fromSearchItem({ title: '没有 bvid' }, 'search'), null);
});

test('fromView 优先用 pages[0].cid，并映射统计', () => {
  const video = fromView(
    {
      bvid: 'BV1yy',
      aid: 42,
      cid: 999,
      title: '标题',
      desc: '简介',
      duration: 754,
      pubdate: 1750000000,
      pic: 'cover.jpg',
      owner: { mid: 7, name: 'UP 名' },
      stat: { view: 10, like: 2, reply: 3, favorite: 4, coin: 5, share: 6, danmaku: 7 },
      pages: [{ cid: 1234 }],
    },
    'BV1yy',
  );
  assert.ok(video);
  assert.equal(video?.cid, 1234);
  assert.equal(video?.aid, 42);
  assert.equal(video?.stats.reply, 3);
  assert.equal(video?.owner.name, 'UP 名');
});

test('pickTrack 优先级：ai-zh → zh-CN → zh* → 第一条', () => {
  const tracks = [
    { lan: 'en-US', lanDoc: 'English', url: 'u1', isAi: false },
    { lan: 'zh-TW', lanDoc: '繁中', url: 'u2', isAi: false },
    { lan: 'zh-CN', lanDoc: '简中', url: 'u3', isAi: false },
    { lan: 'ai-zh', lanDoc: '自动', url: 'u4', isAi: true },
  ];
  assert.equal(pickTrack(tracks)?.lan, 'ai-zh');
  assert.equal(pickTrack(tracks.slice(0, 3))?.lan, 'zh-CN');
  assert.equal(pickTrack(tracks.slice(0, 2))?.lan, 'zh-TW');
  assert.equal(pickTrack([tracks[0]!])?.lan, 'en-US');
  assert.equal(pickTrack([]), null);
});

test('normalizeSubtitleUrl 补 https:，空值返回空串', () => {
  assert.equal(normalizeSubtitleUrl('//aisubtitle.hdslb.com/x.json'), 'https://aisubtitle.hdslb.com/x.json');
  assert.equal(normalizeSubtitleUrl('https://a/b.json'), 'https://a/b.json');
  assert.equal(normalizeSubtitleUrl(''), '');
});

test('cuesToText 只拼正文', () => {
  const text = cuesToText([
    { fromSec: 0, toSec: 1, content: ' 第一句 ' },
    { fromSec: 1, toSec: 2, content: '第二句' },
    { fromSec: 2, toSec: 3, content: '   ' },
  ]);
  assert.equal(text, '第一句\n第二句');
});

test('stableArgs 对键排序，用于「同工具同参数」判重', () => {
  assert.equal(stableArgs('{"b":2,"a":1}'), stableArgs('{"a":1,"b":2}'));
  assert.notEqual(stableArgs('{"a":1}'), stableArgs('{"a":2}'));
  assert.equal(stableArgs('not json'), 'not json');
});
