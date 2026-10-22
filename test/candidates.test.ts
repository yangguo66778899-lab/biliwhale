import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { collectCandidates } from '../src/orchestrator/candidates.ts';
import { SeenLedger } from '../src/state/ledgers.ts';
import { ConfigService } from '../src/config/service.ts';
import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { tmpDir } from './helpers.ts';
import type { BiliApi } from '../src/bili/api.ts';
import type { BiliVideo } from '../src/shared/types.ts';

/** 造一批假视频（热门源用）。 */
function videos(count: number, prefix = 'BVhot'): BiliVideo[] {
  return Array.from({ length: count }, (_item, index) => ({
    bvid: `${prefix}${String(index).padStart(3, '0')}`,
    aid: 1000 + index,
    cid: 0,
    title: `视频 ${index}`,
    desc: '',
    durationSec: 300,
    pubdateIso: new Date(Date.now() - index * 3600_000).toISOString(),
    owner: { mid: 1, name: 'UP主' },
    stats: { view: 1000 - index, like: 10, reply: 5, favorite: 1, coin: 0, danmaku: 0, share: 0 },
    coverUrl: '',
  }));
}

function harness(options: { seenDedupeDays?: number; ranking?: boolean } = {}): {
  seen: SeenLedger;
  api: BiliApi;
  config: ConfigService;
  dir: string;
  logger: Logger;
} {
  const dir = tmpDir('candidates');
  const paths = resolvePaths({ dataDir: dir });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1 }, null, 2), 'utf8');
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const config = new ConfigService(dir, logger);
  config.load();
  config.patch({
    content: {
      sources: { search: false, hot: true, ranking: options.ranking ?? false, following: false, favorites: false },
      ...(options.seenDedupeDays !== undefined ? { seenDedupeDays: options.seenDedupeDays } : {}),
    },
  });
  const seen = SeenLedger.open(paths.seen, logger);
  const api = {
    popular: async () => ({ ok: true, data: videos(15) }),
    ranking: async () => ({ ok: true, data: videos(5, 'BVrank') }),
    searchVideos: async () => ({ ok: true, data: [] }),
    following: async () => ({ ok: true, data: [] }),
  } as unknown as BiliApi;
  return { seen, api, config, dir, logger };
}

test('候选：没给模型看过的（排在 screenLimit 之后的）不会被冷藏，下一轮还在', async () => {
  const h = harness();
  // 模拟第一轮：只有前 10 条进了初筛，所以只该记这 10 条
  const first = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });
  assert.equal(first.candidates.length, 15);
  for (const candidate of first.candidates.slice(0, 10)) {
    h.seen.record({ bvid: candidate.video.bvid, title: candidate.video.title, decision: 'skipped', reason: '初筛未进深读' });
  }

  const second = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });
  assert.equal(second.candidates.length, 5, '后 5 条没被初筛过，应该还能再进候选');
  assert.ok(second.notes.some((line) => line.includes('去重掉 10 条')), second.notes.join('\n'));
});

test('候选：判重冷藏天数可配；0 = 不去重', async () => {
  const h = harness({ seenDedupeDays: 0 });
  const first = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });
  for (const candidate of first.candidates) {
    h.seen.record({ bvid: candidate.video.bvid, title: candidate.video.title, decision: 'skipped', reason: 'x' });
  }

  const again = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });
  assert.equal(again.candidates.length, 15, '冷藏天数 0 时不该按看过去重');
  assert.equal(again.notes.some((line) => line.includes('去重掉')), false);
});

test('候选：判重冷藏天数默认 7 天，配置里读得到', () => {
  const h = harness();
  assert.equal(h.config.get().content.seenDedupeDays, 7);
});

test('候选：排行源可以打开（默认开），打开后池子更大', async () => {
  const withRanking = harness({ ranking: true });
  const result = await collectCandidates({ api: withRanking.api, config: withRanking.config.get(), seen: withRanking.seen, logger: withRanking.logger });
  assert.equal(result.perSource.ranking, 5);
  assert.equal(result.candidates.length, 20, '热门 15 + 排行 5');

  const fresh = new ConfigService(tmpDir('candidates-default'), new Logger({ logDir: tmpDir('candidates-default-logs'), eventsFile: path.join(tmpDir('candidates-default-logs'), 'e.jsonl'), level: 'error' }));
  fresh.load();
  assert.equal(fresh.get().content.sources.ranking, true, '排行默认应该开着');
});

/* ---------------- 翻页与补足（真机「候选 27 → 17 → 8」的回归） ---------------- */

interface PageHarness {
  seen: SeenLedger;
  config: ConfigService;
  logger: Logger;
  /** 每个源每一页返回多少条（页号 1 开始）；空数组 = 这一页没东西。 */
  calls: Array<{ source: string; page: number }>;
  api: BiliApi;
}

/** 造一个「分页的热门源」：第 page 页返回 PREFIX-page-000.. 这样的 bvid。 */
function pagedHarness(pages: Record<number, number>, options: { candidateLimit?: number; screenLimit?: number; pagesConfig?: number } = {}): PageHarness {
  const dir = tmpDir('candidates-pages');
  const paths = resolvePaths({ dataDir: dir });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1 }, null, 2), 'utf8');
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const config = new ConfigService(dir, logger);
  config.load();
  config.patch({
    content: {
      sources: { search: false, hot: true, ranking: false, following: false, favorites: false },
      ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
      ...(options.screenLimit !== undefined ? { screenLimit: options.screenLimit } : {}),
      ...(options.pagesConfig !== undefined ? { candidatePages: options.pagesConfig } : {}),
    },
  });
  const seen = SeenLedger.open(paths.seen, logger);
  const calls: Array<{ source: string; page: number }> = [];
  const api = {
    popular: async (_limit: number, page = 1) => {
      calls.push({ source: 'hot', page });
      const count = pages[page] ?? 0;
      return { ok: true, data: videos(count, `BVp${page}q`) };
    },
    ranking: async () => ({ ok: true, data: [] }),
    searchVideos: async () => ({ ok: true, data: [] }),
    following: async () => ({ ok: true, data: [] }),
  } as unknown as BiliApi;
  return { seen, config, logger, calls, api };
}

test('翻页：第 1 页不够 candidateLimit 时会自动往后翻，够了就停', async () => {
  const h = pagedHarness({ 1: 12, 2: 12, 3: 12 }, { candidateLimit: 30 });
  const result = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });

  assert.equal(result.pages, 3, '12+12 = 24 < 30，得翻到第 3 页');
  assert.deepEqual(h.calls.map((c) => c.page), [1, 2, 3]);
  assert.equal(result.candidates.length, 30, '三页共 36 条，截断到 30');
  assert.ok(result.notes.some((line) => line.includes('往后翻了 3 页')), result.notes.join('\n'));
});

test('翻页：第 1 页就够时不翻第 2 页（不多打请求）', async () => {
  const h = pagedHarness({ 1: 25, 2: 25 }, { candidateLimit: 20 });
  const result = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });

  assert.equal(result.pages, 1);
  assert.deepEqual(h.calls.map((c) => c.page), [1]);
  assert.equal(result.candidates.length, 20);
});

test('翻页：源见底（下一页没有新 bvid）就停，不会无限翻', async () => {
  const h = pagedHarness({ 1: 8, 2: 0, 3: 0 }, { candidateLimit: 30 });
  const result = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });

  assert.equal(result.pages, 2, '第 2 页空 → 停');
  assert.equal(result.candidates.length, 8);
  assert.ok(result.notes.some((line) => line.includes('候选只有 8 条')), result.notes.join('\n'));
});

test('翻页：candidatePages 配 1 就等于不补页', async () => {
  const h = pagedHarness({ 1: 8, 2: 30 }, { candidateLimit: 30, pagesConfig: 1 });
  const result = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });
  assert.equal(result.pages, 1);
  assert.deepEqual(h.calls.map((c) => c.page), [1]);
});

test('回归：连续四轮（每轮只冷藏真的初筛过的 10 条）候选不会越刷越少', async () => {
  // 模拟真机：每页 20 条、共 3 页 = 60 条池子；candidateLimit 30、screenLimit 10
  const h = pagedHarness({ 1: 20, 2: 20, 3: 20 }, { candidateLimit: 30, screenLimit: 10 });
  const counts: number[] = [];

  for (let round = 0; round < 4; round += 1) {
    const result = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });
    counts.push(result.candidates.length);
    // 一轮只会把「真的送进初筛」的那 10 条记进判重账本
    for (const candidate of result.candidates.slice(0, 10)) {
      h.seen.record({ bvid: candidate.video.bvid, title: candidate.video.title, decision: 'skipped', reason: '初筛未进深读' });
    }
  }

  // 修之前：每个源只取第 1 页（20 条），第一轮就把整页冷藏，第二、三轮直接掉到个位数。
  for (const [index, count] of counts.entries()) {
    assert.ok(count >= 10, `第 ${index + 1} 轮候选掉下来了：${counts.join(',')}`);
  }
});

test('回归：池子真的翻完了会明说「候选不足」，而不是静默变少', async () => {
  // 池子只有 8 条，怎么翻都只有 8 条
  const h = pagedHarness({ 1: 8 }, { candidateLimit: 30, screenLimit: 10 });
  const result = await collectCandidates({ api: h.api, config: h.config.get(), seen: h.seen, logger: h.logger });
  assert.equal(result.candidates.length, 8);
  assert.ok(
    result.notes.some((line) => line.includes('候选只有 8 条') && line.includes('少于送初筛')),
    result.notes.join('\n'),
  );
});


