import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { canFavorite, executeFavorites } from '../src/orchestrator/fav.ts';
import { likeVideo, publishDynamic } from '../src/orchestrator/like.ts';
import { composeShareDm, composeSummaryDm, composeVideoInfoDm, sendDmNotify, sendShareDm, splitDiary } from '../src/orchestrator/dm.ts';
import { BiliWriter } from '../src/bili/write.ts';
import { QuotaLedger } from '../src/state/ledgers.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { ConfigService } from '../src/config/service.ts';
import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { localIso } from '../src/shared/time.ts';
import { tmpDir } from './helpers.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';

class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  envelope: { code: number; message: string; data: unknown } = { code: 0, message: '0', data: {} };
  async json<T>(): Promise<Result<T>> {
    return { ok: true, data: this.envelope as unknown as T };
  }
  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<{ code: number; message: string; data: T }>> {
    this.calls.push(req);
    return { ok: true, data: this.envelope as { code: number; message: string; data: T } };
  }
}

interface Harness {
  dir: string;
  transport: FakeTransport;
  quota: QuotaLedger;
  state: AppStateStore;
  secrets: SecretsService;
  config: ConfigService;
  writer: BiliWriter;
  favHas: { value: boolean };
  deps: Parameters<typeof executeFavorites>[0];
}

function harness(patch: Record<string, unknown> = {}): Harness {
  const dir = tmpDir('m4');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1 }, null, 2), 'utf8');
  const paths = resolvePaths({ dataDir: dir });
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const config = new ConfigService(dir, logger);
  config.load();
  config.patch({
    account: { mid: 42, name: '鲸鲸', ownerMid: 777, ownerName: '老王' },
    notify: { channels: [{ type: 'dm', enabled: true, sendSummary: true, sendDiary: true, sendVideoInfo: true }] },
    ...patch,
  });
  const state = new AppStateStore(paths.state, logger);
  const quota = QuotaLedger.open(paths.quota, logger);
  const secrets = new SecretsService(dir, logger);
  secrets.setCookie(`SESSDATA=abc; bili_jct=${'f'.repeat(32)}; DedeUserID=42`, { mid: 42, uname: '鲸鲸' });
  const transport = new FakeTransport();
  const writer = new BiliWriter({ http: transport, csrf: () => secrets.biliJct(), logger, skipThrottle: true });
  const favHas = { value: true };
  const deps = {
    logger,
    config: config.get(),
    quota,
    state,
    writer,
    api: { favContains: async () => ({ ok: true, data: favHas.value ? [1] : [] }) } as unknown as Parameters<typeof executeFavorites>[0]['api'],
  };
  return { dir, transport, quota, state, secrets, config, writer, favHas, deps };
}

const ITEM = { bvid: 'BV1fav00001', aid: 7001, reason: '三个月后还想再看一遍那个实验', sameKindCount: 0, inDeepRead: true };

/* ---------------- 收藏 ---------------- */

test('收藏判据（纯函数）：理由、同类说明、额度、冷却、开关', () => {
  const base = {
    enabled: true,
    writeEnabled: true,
    killSwitch: false,
    riskCooldown: false,
    reason: '这个实验设计很巧，值得留着',
    minReasonChars: 6,
    sameKindCount: 0,
    todayCount: 0,
    dailyCap: 3,
    lastFavAt: null,
    perVideoDays: 30,
    inDeepRead: true,
  };
  assert.equal(canFavorite(base).allow, true);

  assert.ok(canFavorite({ ...base, reason: '好看' }).deny.some((line) => line.includes('理由太短')));
  assert.ok(canFavorite({ ...base, sameKindCount: 2 }).deny.some((line) => line.includes('好在哪')));
  assert.equal(canFavorite({ ...base, sameKindCount: 2, reason: '比上次那条更完整，实验条件写清楚了' }).allow, true);
  assert.ok(canFavorite({ ...base, todayCount: 3 }).deny.some((line) => line.includes('额度')));
  assert.ok(canFavorite({ ...base, lastFavAt: new Date().toISOString() }).deny.some((line) => line.includes('冷却')));
  assert.ok(canFavorite({ ...base, enabled: false }).deny.some((line) => line.includes('开关')));
  assert.ok(canFavorite({ ...base, riskCooldown: true }).deny.some((line) => line.includes('风控')));
  assert.ok(canFavorite({ ...base, inDeepRead: false }).deny.some((line) => line.includes('深读')));
});

test('收藏执行：开关关着 → 一条请求都不发', async () => {
  const h = harness({ fav: { enabled: false } });
  const report = await executeFavorites(h.deps, { items: [ITEM], dryRun: false });
  assert.equal(report.sent, 0);
  assert.equal(h.transport.calls.length, 0);
  assert.ok(report.attempts[0]?.deny.some((line) => line.includes('开关')));
});

test('收藏执行：预演不发请求、不占额度；真发后复核通过并记账', async () => {
  const h = harness();
  const dry = await executeFavorites(h.deps, { items: [ITEM], dryRun: true });
  assert.equal(dry.dryRun, 1);
  assert.equal(h.transport.calls.length, 0);
  assert.equal(h.quota.entries().at(-1)?.status, 'dry_run');

  const real = await executeFavorites(h.deps, { items: [{ ...ITEM, bvid: 'BV1fav00002', aid: 7002 }], dryRun: false });
  assert.equal(real.sent, 1);
  assert.equal(h.transport.calls.length, 1);
  const entry = h.quota.entries().at(-1);
  assert.equal(entry?.type, 'fav');
  assert.equal(entry?.status, 'sent');
  assert.ok(entry?.verifiedAt);
  assert.equal(entry?.share, false, '收藏不占分享额度');
});

test('收藏执行：复核没在收藏夹里看到 → unverified，不重试', async () => {
  const h = harness();
  h.favHas.value = false;
  const report = await executeFavorites(h.deps, { items: [ITEM], dryRun: false });
  assert.equal(report.unverified, 1);
  assert.equal(h.transport.calls.length, 1, '复核失败不重发');
  assert.equal(h.quota.entries().at(-1)?.status, 'unverified');
});

test('收藏额度：今天已经 3 条就再收不了', async () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) {
    h.quota.add({
      at: localIso(),
      type: 'fav',
      bvid: `BV1old0000${i}`,
      aid: 100 + i,
      target: 'fav',
      share: false,
      status: 'sent',
    });
  }
  const report = await executeFavorites(h.deps, { items: [ITEM], dryRun: false });
  assert.equal(report.denied, 1);
  assert.equal(h.transport.calls.length, 0);
});

/* ---------------- 点赞 / 动态 ---------------- */

test('点赞：默认关 → 不发；打开且深读过 → 发一条并记账', async () => {
  const h = harness();
  const off = await likeVideo(
    { logger: h.deps.logger, config: h.config.get(), quota: h.quota, state: h.state, writer: h.writer },
    { bvid: 'BV1like0001', aid: 8001, inDeepRead: true, dryRun: false },
  );
  assert.equal(off.status, 'denied');
  assert.equal(h.transport.calls.length, 0);

  h.config.patch({ like: { enabled: true, dailyCap: 5 } });
  const on = await likeVideo(
    { logger: h.deps.logger, config: h.config.get(), quota: h.quota, state: h.state, writer: h.writer },
    { bvid: 'BV1like0001', aid: 8001, inDeepRead: true, dryRun: false },
  );
  assert.equal(on.ok, true);
  assert.equal(h.transport.calls.length, 1);
  assert.equal(h.quota.entries().at(-1)?.type, 'like');
});

test('动态：默认关；开了也必须二次确认才发', async () => {
  const h = harness();
  const deps = { logger: h.deps.logger, config: h.config.get(), quota: h.quota, state: h.state, writer: h.writer };

  const off = await publishDynamic(deps, { text: '今天看了个好东西', confirm: true, dryRun: false });
  assert.equal(off.status, 'denied');
  assert.equal(h.transport.calls.length, 0);

  h.config.patch({ dynamic: { enabled: true, requireConfirm: true, dailyCap: 1 } });
  const deps2 = { ...deps, config: h.config.get() };
  const noConfirm = await publishDynamic(deps2, { text: '今天看了个好东西', confirm: false, dryRun: false });
  assert.equal(noConfirm.status, 'denied');
  assert.ok(noConfirm.deny.some((line) => line.includes('二次确认')));
  assert.equal(h.transport.calls.length, 0);

  const confirmed = await publishDynamic(deps2, { text: '今天看了个好东西', confirm: true, dryRun: false });
  assert.equal(confirmed.ok, true);
  assert.equal(h.transport.calls.length, 1);
});

/* ---------------- 私信文案 ---------------- */

test('私信分享：合并一条、最多 5 条视频、≤500 字', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    bvid: `BV1dm00000${i}`,
    title: `第 ${i} 个视频`.repeat(6),
    desc: '',
    understanding: '值得看',
  }));
  const text = composeShareDm(items);
  assert.ok(text.includes('BV1dm000000'));
  assert.equal(text.includes('BV1dm000007'), false, '最多 5 条');
  assert.ok(Array.from(text).length <= 500);
});

test('摘要与视频信息：超长截断，视频信息优先砍简介、保住链接与理解', () => {
  const summary = composeSummaryDm('摘'.repeat(900));
  assert.ok(Array.from(summary).length <= 500);
  assert.ok(summary.includes('完整内容在面板'));

  const long = composeVideoInfoDm({ bvid: 'BV1vid00001', title: '标题', desc: '描'.repeat(400), understanding: '我觉得这个实验有意思' });
  assert.ok(Array.from(long).length <= 500);
  assert.ok(long.includes('BV1vid00001'));
  assert.ok(long.includes('我觉得这个实验有意思'));
});

test('公开日记分段：≤5 段，超了返回 null（改发摘要）', () => {
  assert.deepEqual(splitDiary('短日记'), ['短日记']);
  const parts = splitDiary('字'.repeat(1200));
  assert.ok(parts && parts.length <= 5);
  assert.equal(splitDiary('字'.repeat(4000)), null);
});

/* ---------------- 私信通知（子开关独立 + 白名单 + 不额外请求） ---------------- */

test('私信通知：三个子开关独立生效', async () => {
  const h = harness({ notify: { channels: [{ type: 'dm', enabled: true, sendSummary: true, sendDiary: false, sendVideoInfo: false }] } });
  const deps = { logger: h.deps.logger, config: h.config.get(), writer: h.writer, state: h.state, secrets: h.secrets };
  const first = await sendDmNotify(deps, {
    summary: '今天挑中一条',
    publicDiary: '今天的日记正文',
    videos: [{ bvid: 'BV1vid00002', title: '标题', desc: '', understanding: '一句话' }],
    allowBvids: new Set(['BV1vid00002']),
    dryRun: false,
  });
  assert.equal(first.sent, 1, '只开摘要 → 只发一条');
  assert.equal(h.transport.calls.length, 1);
  assert.equal(String(h.transport.calls[0]?.form?.['msg[receiver_id]'] ?? ''), '777', '收件人必须是主人（account.ownerMid），不能是登录账号');
  assert.ok(first.skipped.some((line) => line.includes('日记')));
  assert.ok(first.skipped.some((line) => line.includes('视频')));

  h.config.patch({ notify: { channels: [{ type: 'dm', enabled: true, sendSummary: false, sendDiary: true, sendVideoInfo: true }] } });
  const second = await sendDmNotify({ ...deps, config: h.config.get() }, {
    summary: '摘要',
    publicDiary: '今天的日记正文',
    videos: [{ bvid: 'BV1vid00002', title: '标题', desc: '', understanding: '一句话' }],
    allowBvids: new Set(['BV1vid00002']),
    dryRun: false,
  });
  assert.equal(second.sent, 2, '日记 1 条 + 视频信息 1 条');
  assert.ok(second.skipped.some((line) => line.includes('摘要')));
});

test('私信通知：不在今天上下文里的 BV 不发（白名单）', async () => {
  const h = harness();
  const deps = { logger: h.deps.logger, config: h.config.get(), writer: h.writer, state: h.state, secrets: h.secrets };
  const result = await sendDmNotify(deps, {
    summary: '',
    publicDiary: '',
    videos: [{ bvid: 'BV1strange1', title: '没见过的视频', desc: '', understanding: '' }],
    allowBvids: new Set(['BV1known001']),
    dryRun: false,
  });
  assert.equal(result.sent, 0);
  assert.equal(h.transport.calls.length, 0);
  assert.ok(result.skipped.some((line) => line.includes('不在今天的上下文里')));
});

test('私信通知：渠道关着 → 一条都不发', async () => {
  const h = harness({ notify: { channels: [{ type: 'dm', enabled: false, sendSummary: true, sendDiary: true, sendVideoInfo: true }] } });
  const deps = { logger: h.deps.logger, config: h.config.get(), writer: h.writer, state: h.state, secrets: h.secrets };
  const result = await sendDmNotify(deps, { summary: 'x', publicDiary: 'y', videos: [], allowBvids: new Set(), dryRun: false });
  assert.equal(result.sent, 0);
  assert.equal(h.transport.calls.length, 0);
});

test('私信分享：预演不发请求；真发合并成一条', async () => {
  const h = harness();
  const deps = { logger: h.deps.logger, config: h.config.get(), writer: h.writer, state: h.state, secrets: h.secrets };
  const dry = await sendShareDm(deps, { items: [{ bvid: 'BV1dm00001', title: 'A', desc: '', understanding: '' }], dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(h.transport.calls.length, 0);

  const real = await sendShareDm(deps, {
    items: [
      { bvid: 'BV1dm00001', title: 'A', desc: '', understanding: '' },
      { bvid: 'BV1dm00002', title: 'B', desc: '', understanding: '' },
    ],
    dryRun: false,
  });
  assert.equal(real.ok, true);
  assert.equal(real.sent, 1, '一轮合并成一条');
  assert.equal(h.transport.calls.length, 1);
  assert.ok(real.texts[0]?.includes('BV1dm00002'));
});
