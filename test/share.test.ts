import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { composeCommentText, executeShares, idempotencyKey, contentHashOf, summarizeShares } from '../src/orchestrator/share.ts';
import type { ShareDeps } from '../src/orchestrator/share.ts';
import { BiliWriter } from '../src/bili/write.ts';
import { QuotaLedger } from '../src/state/ledgers.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { ConfigService } from '../src/config/service.ts';
import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { tmpDir } from './helpers.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';

class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  envelope: { code: number; message: string; data: unknown } = { code: 0, message: '0', data: { rpid: 777, rpid_str: '777' } };
  async json<T>(): Promise<Result<T>> {
    return { ok: true, data: this.envelope as unknown as T };
  }
  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<{ code: number; message: string; data: T }>> {
    this.calls.push(req);
    return { ok: true, data: this.envelope as { code: number; message: string; data: T } };
  }
}

interface Harness {
  deps: ShareDeps;
  transport: FakeTransport;
  quota: QuotaLedger;
  state: AppStateStore;
  dir: string;
  /** value = 评论存在；visible = 公开列表能看到（false 表示被 B 站挂起）。 */
  found: { value: boolean; visible: boolean };
  config: ConfigService;
}

function harness(overrides: Record<string, unknown> = {}, opts: { shareEnabled?: boolean; dryRun?: boolean; accountName?: string; maxWrites?: number; via?: "comment" | "dm" } = {}): Harness {
  const dir = tmpDir('share');
  const paths = resolvePaths({ dataDir: dir });
  const config = { version: 1, ...(overrides as object) };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const configService = new ConfigService(dir, logger);
  configService.load();
  configService.patch({
    share: {
      enabled: opts.shareEnabled ?? true,
      via: opts.via ?? 'comment',
      minScore: 13,
      dailyCap: 3,
      perVideoDays: 7,
      comment: { maxChars: 150, atOwner: true },
    },
    safety: { writeEnabled: true, dryRun: opts.dryRun ?? false, maxWritesPerDay: opts.maxWrites ?? 10, killSwitch: false },
    account: { mid: 4242, name: opts.accountName ?? '鲸鲸', ownerMid: 777, ownerName: '老王' },
  });
  const cfg = configService.get();

  const state = new AppStateStore(paths.state, logger);
  const quota = QuotaLedger.open(paths.quota, logger);
  const transport = new FakeTransport();
  const writer = new BiliWriter({ http: transport, csrf: () => 'd'.repeat(32), logger, skipThrottle: true });
  const found = { value: true, visible: true };

  const deps: ShareDeps = {
    logger,
    quota,
    state,
    writer,
    config: cfg,
    api: {
      findComment: async () => ({ ok: true, data: found.value }),
      findOwnComment: async () => ({
        ok: true,
        data: { found: found.value, visible: found.value && found.visible, state: found.value && found.visible ? 0 : 17 },
      }),
      threadReplies: async () => ({ ok: true, data: { root: null, replies: [] } }),
      findReply: async () => ({ ok: true, data: found.value }),
    } as unknown as ShareDeps['api'],
    verifyDelaysMs: [0, 0, 0],
    skipWait: true,
  };
  return { deps, transport, quota, state, dir, found, config: configService };
}

const ITEM = { bvid: 'BV1share1', aid: 4321, score: 16, share: { channel: 'comment' as const, text: '这条值得看' }, inDeepRead: true };

test('文案组装：@ 只加一次、换行压平、超字数截断', () => {
  const one = composeCommentText({ proposal: { channel: 'comment', text: '看看这个' }, atOwner: true, atName: '鲸鲸', maxChars: 150 });
  assert.equal(one.text, '@鲸鲸 看看这个');
  assert.deepEqual(one.notes, ['已带上 @鲸鲸']);

  const already = composeCommentText({ proposal: { channel: 'comment', text: '@鲸鲸 又来' }, atOwner: true, atName: '鲸鲸', maxChars: 150 });
  assert.equal(already.text, '@鲸鲸 又来');

  const flat = composeCommentText({ proposal: { channel: 'comment', text: '第一行\n\n第二行' }, atOwner: false, atName: '', maxChars: 150 });
  assert.equal(flat.text, '第一行 第二行');

  const long = composeCommentText({ proposal: { channel: 'comment', text: 'x'.repeat(200) }, atOwner: false, atName: '', maxChars: 150 });
  assert.equal(Array.from(long.text).length, 150);
  assert.ok(long.text.endsWith('…'));

  const empty = composeCommentText({ proposal: { channel: 'comment', text: '   ' }, atOwner: true, atName: '鲸鲸', maxChars: 150 });
  assert.equal(empty.ok, false);
});

test('幂等键稳定：同 bvid/action/target/内容 → 同 key', () => {
  const a = idempotencyKey({ bvid: 'BV1', action: 'comment', target: 'owner', contentHash: contentHashOf('hi') });
  const b = idempotencyKey({ bvid: 'BV1', action: 'comment', target: 'owner', contentHash: contentHashOf('hi') });
  assert.equal(a, b);
  const c = idempotencyKey({ bvid: 'BV1', action: 'comment', target: 'owner', contentHash: contentHashOf('hi2') });
  assert.notEqual(a, c);
});

test('分享总开关关着：一条都不发，理由可见', async () => {
  const h = harness({}, { shareEnabled: false });
  const report = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });
  assert.equal(report.sent, 0);
  assert.equal(report.denied, 1);
  assert.ok(report.attempts[0]?.deny.some((line) => line.includes('分享总开关')), JSON.stringify(report.attempts[0]));
  assert.equal(h.transport.calls.length, 0);
});

test('只从深读过里挑 + 分数不够：都不发', async () => {
  const h = harness();
  const shallow = await executeShares(h.deps, {
    items: [{ ...ITEM, inDeepRead: false }],
    todayShares: 0,
    silenceCap: 3,
    dryRun: false,
  });
  assert.ok(shallow.attempts[0]?.deny.some((line) => line.includes('只从深读过里挑')));

  const low = await executeShares(h.deps, {
    items: [{ ...ITEM, bvid: 'BV1low', score: 5 }],
    todayShares: 0,
    silenceCap: 3,
    dryRun: false,
  });
  assert.ok(low.attempts[0]?.deny.some((line) => line.includes('分数不够')), JSON.stringify(low.attempts[0]));
  assert.equal(h.transport.calls.length, 0);
});

test('额度用完 / 沉默归零 / 同视频冷却：都不发', async () => {
  const h = harness();

  const quotaFull = await executeShares(h.deps, { items: [ITEM], todayShares: 3, silenceCap: 3, dryRun: false });
  assert.ok(quotaFull.attempts[0]?.deny.some((line) => line.includes('额度')), JSON.stringify(quotaFull.attempts[0]));

  const silent = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 0, dryRun: false });
  assert.ok(silent.attempts[0]?.deny.some((line) => line.includes('沉默')), JSON.stringify(silent.attempts[0]));
  assert.equal(h.transport.calls.length, 0);

  // 同视频冷却：先成功发一条，再发同一条
  h.deps.now = () => new Date();
  const first = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });
  assert.equal(first.sent, 1);
  const again = await executeShares(h.deps, { items: [{ ...ITEM, share: { channel: 'comment', text: '换个说法' } }], todayShares: 1, silenceCap: 3, dryRun: false });
  assert.ok(again.attempts[0]?.deny.some((line) => line.includes('冷却') || line.includes('额度')), JSON.stringify(again.attempts[0]));
});

test('风控冷却中：不写', async () => {
  const h = harness();
  h.state.setRiskCooldown(new Date(Date.now() + 30 * 60_000).toISOString());
  const report = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });
  assert.equal(report.sent, 0);
  assert.ok(report.attempts[0]?.deny.some((line) => line.includes('风控')), JSON.stringify(report.attempts[0]));
  assert.equal(h.transport.calls.length, 0);
});

test('预演：出 plan、不真发、不占额度', async () => {
  const h = harness();
  const report = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: true });
  assert.equal(report.dryRun, 1);
  assert.equal(report.sent, 0);
  assert.equal(h.transport.calls.length, 0, '预演不能发请求');
  assert.equal(h.quota.sharesOn(new Date().toISOString().slice(0, 10)), 0, '预演不占额度');
  const entry = h.quota.entries().at(-1);
  assert.equal(entry?.status, 'dry_run');
  assert.ok(report.attempts[0]?.plan, '要给出将要发送的请求');
  assert.match(summarizeShares(report), /预演 1 条/);
});

test('成功：发出 + 复核通过 + 记账（rpid/内容/哈希/幂等键）', async () => {
  const h = harness();
  const report = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });

  assert.equal(report.sent, 1);
  assert.equal(report.stopped, null);
  assert.equal(h.transport.calls.length, 1);
  const attempt = report.attempts[0];
  assert.equal(attempt?.status, 'sent');
  assert.equal(attempt?.rpid, '777');
  assert.equal(attempt?.verified, true);
  assert.ok(attempt?.content.startsWith('@老王'), `应该 @ 主人（老王），实际：${attempt?.content ?? ''}`);

  const entry = h.quota.entries().at(-1);
  assert.equal(entry?.status, 'sent');
  assert.equal(entry?.type, 'comment');
  assert.equal(entry?.share, true);
  assert.equal(entry?.rpid, '777');
  assert.equal(entry?.aid, 4321);
  assert.ok(entry?.verifiedAt);
  assert.ok(entry?.contentHash);
  assert.ok(entry?.note);
});

test('幂等：同样内容成功发过 → 第二次拒绝，不再发请求', async () => {
  const h = harness();
  await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });
  const callsAfterFirst = h.transport.calls.length;

  const second = await executeShares(h.deps, { items: [ITEM], todayShares: 1, silenceCap: 3, dryRun: false });
  assert.equal(second.sent, 0);
  assert.equal(h.transport.calls.length, callsAfterFirst, '命中幂等或冷却时都不许再发请求');
  // 同视频同内容时闸门会先报「同视频冷却中」；两种拒绝都合规，但必须有一条说清原因
  assert.ok(
    second.attempts[0]?.deny.some((line) => line.includes('幂等') || line.includes('已经发过') || line.includes('冷却')),
    JSON.stringify(second.attempts[0]),
  );
});

test('幂等键里带了 bvid：换视频的相同文案允许发（不会因为文案一样就拦）', async () => {
  const h = harness();
  await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });
  const callsAfterFirst = h.transport.calls.length;

  const otherVideo = await executeShares(h.deps, {
    items: [{ ...ITEM, bvid: 'BV1other', share: { channel: 'comment', text: '这条值得看' } }],
    todayShares: 1,
    silenceCap: 3,
    dryRun: false,
  });
  assert.equal(otherVideo.sent, 1, '不同视频的相同文案应当允许（幂等键包含 bvid）');
  assert.equal(h.transport.calls.length, callsAfterFirst + 1);
});

test('复核失败：标 unverified、不自动重发、账本也记 unverified', async () => {
  const h = harness();
  h.found.value = false;
  const report = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });

  assert.equal(report.sent, 0);
  assert.equal(report.unverified, 1);
  assert.equal(h.transport.calls.length, 1, '复核失败绝不重发');
  assert.equal(report.attempts[0]?.status, 'unverified');
  const entry = h.quota.entries().at(-1);
  assert.equal(entry?.status, 'unverified');
  assert.equal(entry?.verifiedAt, undefined);
});

test('被 B 站挂起：评论真实存在但公开区看不到 → 标 held（不是 unverified），不重发', async () => {
  const h = harness();
  h.found.visible = false; // 存在、但 visible=false（state=17 审核中）
  const report = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });

  assert.equal(report.held, 1, '要单独算「挂起」');
  assert.equal(report.unverified, 0, '不能混成「复核未通过」');
  assert.equal(report.sent, 0);
  assert.equal(h.transport.calls.length, 1, '绝不自动重发');
  assert.equal(report.attempts[0]?.status, 'held');

  const entry = h.quota.entries().at(-1);
  assert.equal(entry?.status, 'held');
  assert.match(entry?.error ?? '', /挂起|state=17/);
  assert.equal(h.quota.sharesOn(entry.at.slice(0, 10)), 1, 'held 也要占分享额度（评论真实存在）');
  assert.ok(report.notes.some((line) => line.includes('挂起') && line.includes('主人可能收不到')), report.notes.join('\\n'));
});

test('撞风控：立即停手、设冷却、后续条目不再发', async () => {
  const h = harness();
  h.transport.envelope = { code: 12015, message: '需要验证', data: null };
  const report = await executeShares(h.deps, {
    items: [ITEM, { ...ITEM, bvid: 'BV1share2' }],
    todayShares: 0,
    silenceCap: 3,
    dryRun: false,
  });

  assert.equal(report.sent, 0);
  assert.equal(report.stopped, 'risk');
  assert.equal(h.transport.calls.length, 1, '撞风控后不许再发第二条');
  assert.ok(h.state.get().riskCooldownUntil, '要设置冷却时间');
  assert.ok(report.notes.some((line) => line.includes('风控')), report.notes.join('\n'));
});

test('每日写操作总上限：超了就不再发', async () => {
  const h = harness({}, { maxWrites: 1 });
  const first = await executeShares(h.deps, { items: [ITEM], todayShares: 0, silenceCap: 3, dryRun: false });
  assert.equal(first.sent, 1);

  const second = await executeShares(h.deps, {
    items: [{ ...ITEM, bvid: 'BV1other', share: { channel: 'comment', text: '另一条' } }],
    todayShares: 1,
    silenceCap: 3,
    dryRun: false,
  });
  assert.equal(second.sent, 0);
  assert.ok(second.attempts[0]?.deny.some((line) => line.includes('上限')), JSON.stringify(second.attempts[0]));
});

test('私信渠道：过同一道闸门，合并成一条发出（不再被「M4 再做」拒绝）', async () => {
  const h = harness({}, { via: 'dm' });
  const report = await executeShares(h.deps, {
    items: [
      { ...ITEM, bvid: 'BV1a0000001', share: { channel: 'dm', text: '私信给你' }, title: '第一条', oneliner: '一句话一' },
      { ...ITEM, bvid: 'BV1a0000002', share: { channel: 'dm', text: '私信给你' }, title: '第二条', oneliner: '一句话二' },
    ],
    todayShares: 0,
    silenceCap: 3,
    dryRun: false,
    dmReceiver: 999,
    dmSender: 111,
  });
  // 一条合并私信 = 1 次发送，两条视频都记在账本里
  assert.equal(report.sent, 1, JSON.stringify(report.attempts));
  assert.equal(report.attempts.length, 2);
  assert.ok(report.attempts.every((attempt) => attempt.status === 'sent'));
  const dmCalls = h.transport.calls.filter((call) => call.url.includes('send_msg'));
  assert.equal(dmCalls.length, 1, '两条视频必须合并成一条私信');
  const entries = h.quota.entries().filter((entry) => entry.type === 'dm');
  assert.equal(entries.length, 2, '每条视频都要记账（同视频冷却才有依据）');
  assert.ok(entries.every((entry) => entry.status === 'sent'));
});

test('私信渠道：主人没配 → 明确拒绝，不发也不记账', async () => {
  const h = harness({}, { via: 'dm' });
  const report = await executeShares(h.deps, {
    items: [{ ...ITEM, share: { channel: 'dm', text: '私信给你' } }],
    todayShares: 0,
    silenceCap: 3,
    dryRun: false,
    dmReceiver: 0,
  });
  assert.equal(report.sent, 0);
  assert.ok(report.attempts[0]?.deny.some((line) => line.includes('主人')), JSON.stringify(report.attempts[0]));
  assert.equal(h.transport.calls.length, 0);
  assert.equal(h.quota.entries().filter((entry) => entry.type === 'dm').length, 0);
});
