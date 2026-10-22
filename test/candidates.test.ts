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
