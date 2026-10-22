import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gateShare, remainingShareQuota } from '../src/orchestrator/gate.ts';
import type { GateInput } from '../src/orchestrator/gate.ts';
import { decideSilence } from '../src/state/ledgers.ts';

function base(overrides: Partial<GateInput> = {}): GateInput {
  return {
    writeEnabled: true,
    killSwitch: false,
    dryRun: false,
    shareEnabled: true,
    channel: 'comment',
    allowedChannels: ['comment'],
    score: 16,
    minScore: 13,
    scoreEnabled: true,
    deepRead: true,
    todayShares: 0,
    shareCap: 3,
    dailyCap: 3,
    lastShareAt: null,
    perVideoDays: 7,
    silenceCap: 3,
    riskCooldown: false,
    now: new Date('2026-10-21T20:30:00+08:00'),
    ...overrides,
  };
}

test('全部条件都过才允许发', () => {
  const decision = gateShare(base());
  assert.equal(decision.allow, true);
  assert.deepEqual(decision.deny, []);
});

test('每一个闸门都能单独拦住，并给出人话理由', () => {
  const cases: Array<[string, Partial<GateInput>, string]> = [
    ['总写开关', { writeEnabled: false }, '总写开关关着'],
    ['急停', { killSwitch: true }, '急停开着'],
    ['分享开关', { shareEnabled: false }, '分享总开关关着'],
    ['模型说不发', { channel: 'none' }, '模型自己说不发'],
    ['渠道未开', { channel: 'dm', allowedChannels: ['comment'] }, '渠道未开：dm'],
    ['未深读', { deepRead: false }, '只从深读过里挑'],
    ['分数不够', { score: 9 }, '分数不够（9 < 13）'],
    ['风控冷却', { riskCooldown: true }, '风控冷却中'],
    ['额度用完', { todayShares: 3 }, '今日额度用完（3/3）'],
    ['沉默归零', { silenceCap: 0 }, '沉默衰减归零'],
  ];
  for (const [name, overrides, expected] of cases) {
    const decision = gateShare(base(overrides));
    assert.equal(decision.allow, false, `${name} 应该被拦下`);
    assert.ok(
      decision.deny.some((reason) => reason.includes(expected)),
      `${name} 的理由应包含「${expected}」，实际：${decision.deny.join(' / ')}`,
    );
  }
});

test('同一视频冷却按天数算', () => {
  const now = new Date('2026-10-21T20:30:00+08:00');
  const recent = gateShare(base({ lastShareAt: '2026-10-18T20:30:00+08:00', now }));
  assert.equal(recent.allow, false);
  assert.ok(recent.deny.some((r) => r.includes('同视频冷却中（3/7 天）')));

  const old = gateShare(base({ lastShareAt: '2026-10-01T20:30:00+08:00', now }));
  assert.equal(old.allow, true);
});

test('判分关闭时不再检查分数（额度/判重照旧）', () => {
  const decision = gateShare(base({ scoreEnabled: false, score: 0 }));
  assert.equal(decision.allow, true);
});

test('额度取 dailyCap / shareCap / silenceCap 的最小值', () => {
  assert.equal(remainingShareQuota({ todayShares: 0, shareCap: 3, dailyCap: 2, silenceCap: 3 }), 2);
  assert.equal(remainingShareQuota({ todayShares: 1, shareCap: 3, dailyCap: 3, silenceCap: 1 }), 0);
  assert.equal(remainingShareQuota({ todayShares: 5, shareCap: 3, dailyCap: 3, silenceCap: 3 }), 0);
});

test('dry-run 只备注、不影响是否通过', () => {
  const decision = gateShare(base({ dryRun: true }));
  assert.equal(decision.allow, true);
  assert.ok(decision.notes.some((n) => n.includes('预演')));
});

test('沉默衰减三档', () => {
  const cfg = { dailyCap: 3, silentAfterDays: 3, silentStopDays: 7 };
  assert.equal(decideSilence(null, cfg).band, 'normal');
  assert.equal(decideSilence(0, cfg).shareCap, 3);
  assert.equal(decideSilence(2, cfg).band, 'normal');
  assert.equal(decideSilence(3, cfg).band, 'quiet');
  assert.equal(decideSilence(3, cfg).shareCap, 1);
  assert.equal(decideSilence(3, cfg).askOnce, true);
  assert.equal(decideSilence(6, cfg).band, 'quiet');
  assert.equal(decideSilence(7, cfg).band, 'silent');
  assert.equal(decideSilence(7, cfg).shareCap, 0);
});
