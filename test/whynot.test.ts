import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWhyNot } from '../src/orchestrator/whynot.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { Config } from '../src/config/spec.ts';

function cfg(over: Record<string, unknown> = {}): Config {
  const r = validateConfig({ fav: { enabled: true }, like: { enabled: false }, share: { enabled: false }, listen: { comment: { enabled: false } }, ...over });
  assert.ok(r.ok, JSON.stringify(r.issues));
  return r.value;
}

const emptyResult = { selected: [], favorite: null } as never;

test('why-not：开关关着就说关着，不许含糊', () => {
  const lines = buildWhyNot({ config: cfg(), result: emptyResult, dmChannelOn: false, dryRun: true });
  const byLabel = new Map(lines.map((l) => [l.label, l.text]));
  assert.match(byLabel.get('收藏') ?? '', /模型这一轮没提/);
  assert.match(byLabel.get('点赞') ?? '', /开关关着/);
  assert.match(byLabel.get('私信分享') ?? '', /分享开关关着/);
  assert.match(byLabel.get('私信通知') ?? '', /渠道关着/);
  assert.match(byLabel.get('评论监听') ?? '', /开关关着/);
  assert.match(byLabel.get('动态') ?? '', /面板手动发/);
});

test('why-not：开了但模型没提 / 提了就写「会收藏哪个」', () => {
  const noFav = buildWhyNot({ config: cfg(), result: emptyResult, dmChannelOn: true, dryRun: false });
  assert.match(noFav.find((l) => l.label === '收藏')?.text ?? '', /模型这一轮没提/);

  const withFav = buildWhyNot({
    config: cfg(),
    result: { selected: [{ bvid: 'BV1x', score: 15 }], favorite: { bvid: 'BV1x', reason: '说清了怎么搭流水线，以后还想翻' } } as never,
    dmChannelOn: true,
    dryRun: false,
  });
  const fav = withFav.find((l) => l.label === '收藏')?.text ?? '';
  assert.match(fav, /会收藏 BV1x/);
  assert.match(withFav.find((l) => l.label === '点赞')?.text ?? '', /开关关着/, '点赞默认关');
});

test('why-not：私信渠道设的是评论时，说清「不是私信」', () => {
  const lines = buildWhyNot({
    config: cfg({ share: { enabled: true, via: 'comment' } }),
    result: emptyResult,
    dmChannelOn: true,
    dryRun: false,
  });
  assert.match(lines.find((l) => l.label === '私信分享')?.text ?? '', /不是私信/);
});

test('why-not：只写结果不写「会做」——被冷却拒绝时给出原因和截止时间', () => {
  // 2026-10-22 真机报告：同一页「点赞：会点第一条」+「没点赞：风控冷却中」自相矛盾。
  const lines = buildWhyNot({
    config: cfg({ like: { enabled: true }, share: { enabled: true, via: 'comment' } }),
    result: { selected: [{ bvid: 'BV1x', score: 14 }], favorite: null } as never,
    dmChannelOn: false,
    dryRun: false,
    riskCooldownUntil: '2026-10-22T23:46:05+08:00',
    now: new Date('2026-10-22T22:59:00+08:00'),
    share: { status: 'denied', deny: ['风控冷却中'], bvid: 'BV1x' },
    like: { status: 'denied', deny: ['风控冷却中'], bvid: 'BV1x' },
  });

  const share = lines.find((l) => l.label === '分享')?.text ?? '';
  const like = lines.find((l) => l.label === '点赞')?.text ?? '';
  assert.match(share, /没发：风控冷却中/, '这一节必须有「分享」，且写真实结果');
  assert.match(share, /冷却到 23:46/, '要写冷却到几点，否则用户不知道什么时候恢复');
  assert.match(like, /没点：风控冷却中/);
  assert.equal(like.includes('会点'), false, '不许把「会做」当结果写');
});

test('why-not：成功时写结果；冷却过期后不再补时间', () => {
  const lines = buildWhyNot({
    config: cfg({ like: { enabled: true }, share: { enabled: true, via: 'comment' } }),
    result: { selected: [{ bvid: 'BV1x', score: 14 }], favorite: null } as never,
    dmChannelOn: false,
    dryRun: false,
    riskCooldownUntil: '2026-10-22T23:00:00+08:00',
    now: new Date('2026-10-23T09:00:00+08:00'),
    share: { status: 'sent', bvid: 'BV1x' },
    like: { status: 'sent', bvid: 'BV1x' },
  });
  assert.match(lines.find((l) => l.label === '分享')?.text ?? '', /^发 BV1x/);
  assert.match(lines.find((l) => l.label === '点赞')?.text ?? '', /^点 BV1x/);
});
