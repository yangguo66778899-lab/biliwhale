import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Logger } from '../src/shared/logger.ts';
import { FeedbackLedger, QuotaLedger, SeenLedger } from '../src/state/ledgers.ts';
import { AppStateStore, emptyState } from '../src/state/appState.ts';
import { RunStore } from '../src/state/runs.ts';
import { tmpDir } from './helpers.ts';

function quietLogger(dir: string): Logger {
  return new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

test('SeenLedger 记录次数、按天数判重、按保留期清理', () => {
  const dir = tmpDir('seen');
  const seen = SeenLedger.open(path.join(dir, 'seen.json'), quietLogger(dir));
  const now = new Date('2026-10-21T20:00:00+08:00');

  assert.equal(seen.seenWithin('BV1', 7, now), false);
  seen.record({ bvid: 'BV1', title: '标题', decision: 'skipped', reason: '低分', now });
  seen.record({ bvid: 'BV1', title: '标题', decision: 'selected', reason: '挑中 15/20', now });

  const entry = seen.get('BV1');
  assert.equal(entry?.times, 2);
  assert.equal(entry?.lastDecision, 'selected');
  assert.equal(seen.size(), 1);
  assert.equal(seen.seenWithin('BV1', 7, now), true);
  assert.equal(seen.seenWithin('BV1', 7, new Date('2026-11-21T20:00:00+08:00')), false);

  const recent = seen.recentTitles(3, now);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.bvid, 'BV1');

  // 30 天后清理
  const removed = seen.prune(30, new Date('2026-12-21T20:00:00+08:00'));
  assert.equal(removed, 1);
  assert.equal(seen.size(), 0);
});

test('QuotaLedger 只把真正发出的算进额度', () => {
  const dir = tmpDir('quota');
  const quota = QuotaLedger.open(path.join(dir, 'quota.json'), quietLogger(dir));
  const day = '2026-10-21';

  quota.add({ at: `${day}T20:00:00+08:00`, type: 'comment', bvid: 'BV1', target: 'owner', share: true, status: 'sent', note: 'k1' });
  quota.add({ at: `${day}T20:10:00+08:00`, type: 'dm', bvid: 'BV2', target: 'owner', share: true, status: 'dry_run' });
  quota.add({ at: `${day}T20:20:00+08:00`, type: 'fav', bvid: 'BV3', target: 'fav', share: false, status: 'sent' });
  quota.add({ at: '2026-10-20T20:00:00+08:00', type: 'comment', bvid: 'BV4', target: 'owner', share: true, status: 'sent' });

  assert.equal(quota.sharesOn(day), 1, 'dry_run 与收藏不算分享额度');
  assert.equal(quota.countOn(day, 'fav'), 1);
  assert.equal(quota.lastSentAt('BV1'), `${day}T20:00:00+08:00`);
  assert.equal(quota.lastSentAt('BV3'), null, '收藏不是分享');
  assert.equal(quota.hasSentContent('k1'), true);
  assert.equal(quota.hasSentContent('k2'), false);
});

test('FeedbackLedger 沉默天数：先看用户表态，再看上次分享', () => {
  const dir = tmpDir('feedback');
  const feedback = FeedbackLedger.open(path.join(dir, 'feedback.json'), quietLogger(dir));
  const logger = quietLogger(dir);
  void logger;

  assert.equal(feedback.silenceDays(new Date('2026-10-21T20:00:00+08:00')), null);

  feedback.markShare(new Date('2026-10-11T20:00:00+08:00'));
  assert.equal(feedback.silenceDays(new Date('2026-10-21T20:00:00+08:00')), 10);

  feedback.markUserSignal(new Date('2026-10-18T20:00:00+08:00'));
  assert.equal(feedback.silenceDays(new Date('2026-10-21T20:00:00+08:00')), 3);
});

test('RunStore：同一秒跑两轮不会覆盖运行记录', () => {
  const dir = tmpDir('runs');
  const runs = new RunStore(path.join(dir, 'runs'), quietLogger(dir));

  const first = runs.start({ trigger: 'manual', dryRun: true, configuredModel: 'm' });
  const second = runs.start({ trigger: 'manual', dryRun: true, configuredModel: 'm' });
  assert.notEqual(first.id, second.id, '同一秒的两个 run 必须有不同的 id');

  runs.finish(first, 'ok');
  runs.finish(second, 'degraded');
  const files = fs.readdirSync(path.join(dir, 'runs')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  assert.deepEqual(runs.list(5).map((r) => r.status).sort(), ['degraded', 'ok']);

  // 启动恢复：running → interrupted，只改状态、不重放
  const pending = runs.start({ trigger: 'schedule', dryRun: true, configuredModel: 'm' });
  assert.equal(pending.status, 'running');
  const recovered = runs.recoverInterrupted();
  assert.ok(recovered.includes(pending.id));
  assert.equal(runs.list(5).find((r) => r.id === pending.id)?.status, 'interrupted');
});

test('AppStateStore 跨天重置预算，累计 token 与失败计数', () => {  const dir = tmpDir('state');
  const store = new AppStateStore(path.join(dir, 'state.json'), quietLogger(dir));

  const initial = store.get();
  assert.deepEqual(Object.keys(initial).sort(), Object.keys(emptyState()).sort());

  store.addUsage({ promptTokens: 100, completionTokens: 50, costCny: 0.001 });
  const afterUsage = store.get();
  assert.equal(afterUsage.budget.tokens, 150);
  assert.equal(afterUsage.budget.calls, 1);

  store.noteRun('ok', '2026-10-21T20:00:00+08:00');
  assert.equal(store.get().counters.consecutiveFailures, 0);
  assert.equal(store.get().counters.totalRuns, 1);

  store.noteRun('failed', '2026-10-21T21:00:00+08:00');
  store.noteRun('failed', '2026-10-21T22:00:00+08:00');
  assert.equal(store.get().counters.consecutiveFailures, 2);
  store.noteRun('ok', '2026-10-21T23:00:00+08:00');
  assert.equal(store.get().counters.consecutiveFailures, 0);

  // 跨天：预算清零
  store.update((state) => ({ ...state, budget: { date: '2000-01-01', tokens: 999, costCny: 1, calls: 5 } }));
  const reset = store.get();
  assert.equal(reset.budget.tokens, 0);
  assert.notEqual(reset.budget.date, '2000-01-01');

  // 风控冷却
  store.setRiskCooldown('2026-10-21T23:30:00+08:00');
  assert.equal(store.inRiskCooldown(new Date('2026-10-21T23:00:00+08:00')), true);
  assert.equal(store.inRiskCooldown(new Date('2026-10-22T00:00:00+08:00')), false);
});
