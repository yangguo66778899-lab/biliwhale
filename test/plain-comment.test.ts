import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { executePlainComments } from '../src/orchestrator/share.ts';
import type { ShareDeps } from '../src/orchestrator/share.ts';
import { validateConfig } from '../src/config/validate.ts';
import { QuotaLedger } from '../src/state/ledgers.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';
import type { Config } from '../src/config/spec.ts';

interface Harness {
  deps: ShareDeps;
  quota: QuotaLedger;
  state: AppStateStore;
  dir: string;
  calls: Array<{ bvid: string; message: string; dryRun: boolean }>;
}

function makeDeps(over: Record<string, unknown> = {}): Harness {
  const dir = tmpDir('plain');
  const logger = new Logger({ logDir: dir, eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
  const quota = QuotaLedger.open(path.join(dir, 'quota.json'), logger);
  const state = new AppStateStore(path.join(dir, 'state.json'), logger);
  const parsed = validateConfig({
    share: { enabled: true, comment: { plain: true, atOwner: true, plainDailyCap: 1, maxChars: 150 } },
    ...over,
  });
  assert.ok(parsed.ok, JSON.stringify(parsed.issues));
  const config = parsed.value as Config;
  const calls: Harness['calls'] = [];

  const writer = {
    postComment: async (req: { bvid: string; message: string }, opts: { dryRun?: boolean }) => {
      calls.push({ bvid: req.bvid, message: req.message, dryRun: opts.dryRun === true });
      return { ok: true as const, plan: { method: 'POST' as const, url: 'https://example.invalid/x', form: {}, dryRun: opts.dryRun === true } };
    },
  };

  const deps: ShareDeps = {
    logger,
    quota,
    state,
    writer: writer as never,
    api: {} as never,
    config,
    now: () => new Date('2026-10-23T10:00:00+08:00'),
  };
  return { deps, quota, state, dir, calls };
}

test('不 @ 的评论：发出去了就记账（target=plain），并且不占 @ 分享的额度', async () => {
  const h = makeDeps();
  const report = await executePlainComments(h.deps, {
    items: [{ bvid: 'BV1x', aid: 1, text: '这刀接得真狠' }],
    dryRun: false,
    todayPlain: 0,
  });
  assert.equal(report.sent, 1);
  assert.equal(report.denied, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.quota.countPlainCommentsOn('2026-10-23'), 1);
  // @ 分享的额度（sharesOn）不该被它占掉
  assert.equal(h.quota.sharesOn('2026-10-23'), 0);
});

test('不 @ 的评论：单独的上限——今天发过 1 条就拒绝，理由是上限', async () => {
  const h = makeDeps();
  await executePlainComments(h.deps, { items: [{ bvid: 'BV1x', aid: 1, text: '第一条' }], dryRun: false, todayPlain: 0 });
  const second = await executePlainComments(h.deps, {
    items: [{ bvid: 'BV1y', aid: 2, text: '第二条' }],
    dryRun: false,
    todayPlain: h.quota.countPlainCommentsOn('2026-10-23'),
  });
  assert.equal(second.sent, 0);
  assert.equal(second.denied, 1);
  assert.match(second.attempts[0]?.deny.join('；') ?? '', /上限/);
  assert.equal(h.calls.length, 1, '被拒的那条不该发出去');
});

test('不 @ 的评论：预演只出计划，不占额度', async () => {
  const h = makeDeps();
  const report = await executePlainComments(h.deps, {
    items: [{ bvid: 'BV1x', aid: 1, text: '预演一下' }],
    dryRun: true,
    todayPlain: 0,
  });
  assert.equal(report.dryRun, 1);
  assert.equal(h.calls[0]?.dryRun, true);
  assert.equal(h.quota.countPlainCommentsOn('2026-10-23'), 0, '预演不该消耗当天额度');
});

test('不 @ 的评论：开关关着 / 风控冷却中 都拒绝，并说清原因', async () => {
  const off = makeDeps({ share: { enabled: true, comment: { plain: false } } });
  const a = await executePlainComments(off.deps, { items: [{ bvid: 'BV1x', aid: 1, text: 'x' }], dryRun: false, todayPlain: 0 });
  assert.equal(a.denied, 1);
  assert.match(a.attempts[0]?.deny.join('；') ?? '', /开关关着/);

  const cooled = makeDeps();
  cooled.state.setRiskCooldown('2026-10-23T10:30:00+08:00');
  const b = await executePlainComments(cooled.deps, { items: [{ bvid: 'BV1x', aid: 1, text: 'x' }], dryRun: false, todayPlain: 0 });
  assert.equal(b.denied, 1);
  assert.match(b.attempts[0]?.deny.join('；') ?? '', /风控冷却中/);
});
