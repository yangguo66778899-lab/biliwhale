import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

test('自检：套话黑名单只留总结/公文类，用户正例里的「温柔」不算问题', () => {
  const politeness = selfCheck({ ...BASE, diary: { ...BASE.diary, public: '感觉是个很温柔的人呢。' } });
  assert.deepEqual(politeness, [], '文艺腔词表已删掉，「温柔」不该判不合格');

  const cliche = selfCheck({ ...BASE, diary: { ...BASE.diary, public: '总的来说，这条值得一看。' } });
  assert.ok(cliche.some((issue) => issue.key === 'diary-public-blacklist'));
});

test('自检：单句超过 70 字才报，64 字的长句放行（用户正例就有一句）', () => {
  const ok65 = '看'.repeat(65);
  const ok = selfCheck({ ...BASE, diary: { ...BASE.diary, public: ok65 } });
  assert.equal(ok.some((issue) => issue.key === 'diary-public-sentence'), false, '70 字以内不报');

  const tooLong = '看'.repeat(71);
  const flagged = selfCheck({ ...BASE, diary: { ...BASE.diary, public: tooLong } });
  assert.ok(flagged.some((issue) => issue.key === 'diary-public-sentence'));
});

test('自检：用户 9 篇正例全部不判不合格（含 64 字长句那篇）', () => {
  const raw = fs.readFileSync(new URL('../src/prompts/examples/diary-samples.md', import.meta.url), 'utf8');
  const samples = raw
    .split(/^第 \d+ 篇$/mu)
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(samples.length, 9, '正例应该是 9 篇');
  for (const [index, text] of samples.entries()) {
    const issues = selfCheck({ ...BASE, diary: { ...BASE.diary, public: text } }).filter(
      (issue) => !issue.key.startsWith('diary-private'),
    );
    assert.deepEqual(
      issues,
      [],
      `第 ${index + 1} 篇被判不合格：${issues.map((issue) => issue.message).join('；')}`,
    );
  }
});

test('自检：写了工具做不到的动作 / 来源标注超过 2 处 / 结尾鸡汤 都要重写', () => {
  const fake = selfCheck({ ...BASE, diary: { ...BASE.diary, public: '我又点进主页看了他别的视频。' } });
  assert.ok(fake.some((issue) => issue.key === 'diary-public-fake-action'));

  const sources = selfCheck({
    ...BASE,
    diary: { ...BASE.diary, public: '字幕里说挺好，简介里写着流程，标题提到效率。' },
  });
  assert.ok(sources.some((issue) => issue.key === 'diary-public-source'));

  const tail = selfCheck({ ...BASE, diary: { ...BASE.diary, public: '看完挺开心的。也许这就是生活吧。' } });
  assert.ok(tail.some((issue) => issue.key === 'diary-public-tail'));
});
