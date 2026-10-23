import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyMechanicalFixes, rewriteInstruction, selfCheck } from '../src/agent/selfCheck.ts';

const BASE = {
  diary: { public: '今天看了一条剪得很紧的鬼畜，四分半，一点空档都没有。', private: '偏好校准：这种拼贴我确实爱看。' },
  comments: [] as Array<{ bvid: string; kind: 'plain' | 'share'; text: string }>,
  maxCommentChars: 150,
  maxShareChars: 150,
};

test('自检：干净的东西不报问题', () => {
  assert.deepEqual(selfCheck(BASE), []);
});

test('自检：日记里出现数据话就报「重写」（评分 / 我选了 / 候选 / 阈值）', () => {
  for (const text of ['这一轮我选了 3 条，评分 14/20。', '候选里只有它够阈值。', 'token 花了 20k，分享 1 条。']) {
    const issues = selfCheck({ ...BASE, diary: { ...BASE.diary, public: text } });
    assert.ok(
      issues.some((issue) => issue.key === 'diary-public-data'),
      `应当抓到数据话：${text}`,
    );
    assert.equal(issues.find((issue) => issue.key === 'diary-public-data')?.action, 'rewrite');
  }
});

test('自检：日记汇报腔、表情码、太长都报重写', () => {
  const report = selfCheck({ ...BASE, diary: { ...BASE.diary, private: '本轮共处理 3 条，已为您筛选。' } });
  assert.ok(report.some((issue) => issue.key === 'diary-private-report'));

  const emoji = selfCheck({ ...BASE, diary: { ...BASE.diary, public: '这条真好看[doge]' } });
  assert.ok(emoji.some((issue) => issue.key === 'diary-public-emoji'));

  const long = selfCheck({ ...BASE, diary: { ...BASE.diary, public: '啊'.repeat(1001) } });
  assert.ok(long.some((issue) => issue.key === 'diary-public-long'));
});

test('自检：评论末尾句号是机械修，不用重写', () => {
  const issues = selfCheck({
    ...BASE,
    comments: [{ bvid: 'BV1x', kind: 'plain', text: '这刀接得真狠。' }],
  });
  const period = issues.find((issue) => issue.key === 'comment-BV1x-period');
  assert.ok(period);
  assert.equal(period?.action, 'mechanical');

  const fixed = applyMechanicalFixes({ ...BASE, comments: [{ bvid: 'BV1x', kind: 'plain', text: '这刀接得真狠。' }] });
  assert.equal(fixed.comments[0]?.text, '这刀接得真狠');
});

test('自检：评论表情超过 2 个、出现内部词都要重写', () => {
  const many = selfCheck({ ...BASE, comments: [{ bvid: 'BV1x', kind: 'plain', text: '[doge][笑哭][妙啊]好' }] });
  assert.ok(many.some((issue) => issue.key === 'comment-BV1x-emoji'));

  const ledger = selfCheck({ ...BASE, comments: [{ bvid: 'BV1x', kind: 'share', text: '这条在额度内发的' }] });
  assert.ok(ledger.some((issue) => issue.key === 'comment-BV1x-ledger'));
});

test('自检：重写指令只列 rewrite 项，并附上口径', () => {
  const text = rewriteInstruction([
    { key: 'a', target: '日记（公开）', message: '出现了数据话', action: 'rewrite' },
    { key: 'b', target: '评论（不 @，BV1x）', message: '末尾有句号', action: 'mechanical' },
  ]);
  assert.match(text, /日记（公开）：出现了数据话/);
  assert.equal(text.includes('末尾有句号'), false, '机械修的不该进重写指令');
  assert.match(text, /末尾不加句号/);
  assert.match(text, /只输出 JSON/);
});
