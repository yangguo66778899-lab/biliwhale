import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Logger } from '../src/shared/logger.ts';
import { ConfigService } from '../src/config/service.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { ensureLayout, resolvePaths } from '../src/state/paths.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { FeedbackLedger, QuotaLedger, SeenLedger } from '../src/state/ledgers.ts';
import { RunStore } from '../src/state/runs.ts';
import { createOfflineStack } from '../src/dev/offline.ts';
import { runRound } from '../src/orchestrator/round.ts';
import type { RoundDeps } from '../src/orchestrator/round.ts';
import { reportFile } from '../src/orchestrator/writers.ts';
import {
  buildSheetArgs,
  buildStripArgs,
  mediaDir,
  mediaTimeoutMs,
  prepareVisuals,
  pruneMediaCache,
  sheetFilter,
  stripFilter,
} from '../src/media/frames.ts';
import type { VisualTarget } from '../src/media/frames.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { Config } from '../src/config/spec.ts';
import { repoRoot, tmpDir, withEnv, writeDeps } from './helpers.ts';

/**
 * 看画面（§7.10）的回归测试。
 *
 * 重点不是「ffmpeg 能不能用」（那要真机），而是：
 *   - 默认关；关了/没装 ffmpeg/下载失败**都不能让整轮失败**，报告要写清原因；
 *   - 抽成功时给出的是 `data:image/jpeg;base64,...`，最多 2 张（九宫格 + 字幕条）；
 *   - 视频用完即删、缓存按条数 + MB 清理、图片不进报告；
 *   - 真实一轮跑下来，run 记录里有 media，报告里有「看了画面：BV…」。
 */

/** 1×1 的 JPEG：测试里代替 ffmpeg 的真实产出。 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

function quietLogger(dir: string): Logger {
  return new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

function configWith(media: Record<string, unknown>): Config {
  const result = validateConfig({ media });
  assert.ok(result.ok, JSON.stringify(result.issues));
  return result.value;
}

const TARGET: VisualTarget = { bvid: 'BV1a0000001', cid: 1001, title: '测试视频', durationSec: 240, hasSubtitles: false };

/** 假 ffmpeg：把 TINY_JPEG 写到最后一个参数（输出文件）上。 */
async function fakeFfmpeg(args: string[]): Promise<void> {
  const out = args[args.length - 1];
  assert.ok(out, 'ffmpeg 参数里要有输出文件');
  fs.writeFileSync(out, TINY_JPEG);
}

interface Harness {
  deps: Parameters<typeof prepareVisuals>[0];
  dir: string;
  paths: ReturnType<typeof resolvePaths>;
  calls: string[][];
}

function harness(over: { media?: Record<string, unknown>; target?: Partial<VisualTarget>; videoFile?: boolean; downloadFails?: boolean; playUrlFails?: boolean } = {}): Harness {
  const dir = tmpDir('media');
  const paths = resolvePaths({ dataDir: dir });
  ensureLayout(paths);
  const calls: string[][] = [];
  const videoFile = path.join(dir, 'sample.mp4');
  fs.writeFileSync(videoFile, Buffer.from('not-a-real-mp4'));
  const deps = {
    config: configWith({ frames: true, ...(over.media ?? {}) }),
    paths,
    logger: quietLogger(dir),
    playUrl: async () =>
      over.playUrlFails
        ? { ok: false as const, error: { kind: 'network' as const, code: 500, message: '接口抽风' } }
        : { ok: true as const, data: { url: 'http://example.com/v.mp4' } },
    overrides: {
      ffmpegPath: 'ffmpeg' as string | null,
      runFfmpeg: async (args: string[]) => {
        calls.push(args);
        await fakeFfmpeg(args);
      },
      ...(over.videoFile === false
        ? {
            download: async (_url: string, dest: string) => {
              if (over.downloadFails) throw new Error('网络断了');
              fs.writeFileSync(dest, Buffer.from('downloaded'));
            },
          }
        : { videoFile }),
    },
  };
  return { deps, dir, paths, calls };
}

/* ---------------- 纯函数 ---------------- */

test('超时按视频时长算：120s + 时长 × 1.5（25 分钟的片子不该用默认 120s）', () => {
  assert.equal(mediaTimeoutMs(0), 120_000);
  assert.equal(mediaTimeoutMs(60), 120_000 + 90_000);
  assert.equal(mediaTimeoutMs(25 * 60), 120_000 + 25 * 60 * 1500, '25 分钟的片子要 39.5 分钟的超时，不是 120s');
  assert.equal(mediaTimeoutMs(10 * 60 * 60), 60 * 60_000, '离谱时长封顶 1 小时');
});

test('九宫格与字幕条的滤镜形状：3×3 平铺 / 裁下方 32% 竖拼', () => {
  assert.match(sheetFilter(9, 90), /tile=3x3/, '9 帧应该是 3×3');
  assert.match(sheetFilter(9, 90), /fps=0\.100000/, '90 秒抽 9 帧 = 每 10 秒一帧');
  assert.match(sheetFilter(4, 100), /tile=2x2/, '4 帧拼 2×2');
  assert.match(sheetFilter(12, 100), /tile=4x3/, '12 帧拼 4×3');

  const strip = stripFilter(120);
  assert.match(strip.filter, /crop=iw:ih\*0\.32:0:ih\*0\.68/, '裁画面下方 32%');
  assert.match(strip.filter, /tile=1x12/, '竖着拼一列');
  assert.ok(strip.intervalSec >= 7, '每 7 秒一帧（别再密了）');

  const sheet = buildSheetArgs({ video: 'in.mp4', out: 'out.jpg', frames: 9, durationSec: 90 });
  assert.deepEqual(sheet.slice(0, 5), ['-y', '-hide_banner', '-loglevel', 'error', '-i']);
  assert.ok(sheet.includes('-frames:v') && sheet.includes('1'), '只产出一张图');
  assert.equal(sheet[sheet.length - 1], 'out.jpg');

  const stripArgs = buildStripArgs({ video: 'in.mp4', out: 'strip.jpg', durationSec: 120 });
  assert.equal(stripArgs[stripArgs.length - 1], 'strip.jpg');
});

/* ---------------- 降级：每一步失败都只降级 ---------------- */

test('默认关：一步都不做，只说一句人话（不改默认值）', async () => {
  const h = harness({ media: { frames: false } });
  const result = await prepareVisuals(h.deps, TARGET);
  assert.equal(result.status, 'off');
  assert.equal(result.images.length, 0);
  assert.match(result.note, /^不看画面：/);
  assert.match(result.note, /看画面/);
  assert.deepEqual(h.calls, [], '关着时不该调用 ffmpeg');
});

test('没装 ffmpeg：不报错、不抽帧，原因是人话', async () => {
  const h = harness();
  h.deps.overrides = { ...h.deps.overrides, ffmpegPath: null };
  const result = await prepareVisuals(h.deps, TARGET);
  assert.equal(result.status, 'skipped');
  assert.match(result.note, /没看画面：没装 ffmpeg/);
  assert.equal(result.images.length, 0);
  assert.match(result.record.reason ?? '', /ffmpeg/);
});

test('取不到播放地址 / 下载失败：都降级，不让整轮失败', async () => {
  const noUrl = harness({ playUrlFails: true, videoFile: false });
  const a = await prepareVisuals(noUrl.deps, TARGET);
  assert.equal(a.status, 'skipped');
  assert.match(a.note, /没看画面：取不到视频地址/);

  const broken = harness({ downloadFails: true, videoFile: false });
  const b = await prepareVisuals(broken.deps, TARGET);
  assert.equal(b.status, 'skipped');
  assert.match(b.note, /没看画面：视频没下载成功/);
});

/* ---------------- 成功：形状、限制、清理 ---------------- */

test('抽帧成功：九宫格是 data URL，视频用完即删，记录里有文件名', async () => {
  const h = harness({ target: { hasSubtitles: true } });
  const result = await prepareVisuals(h.deps, { ...TARGET, hasSubtitles: true });

  assert.equal(result.status, 'ok');
  assert.equal(result.images.length, 1, '有字幕轨时不做字幕条，只有九宫格');
  assert.match(result.images[0] ?? '', /^data:image\/jpeg;base64,/);
  assert.equal(result.tokenReserve, 1024, '一张图按 1024 token 预留');
  assert.match(result.note, /^看了画面：BV1a0000001（九宫格 9 帧/);

  assert.ok(result.record.sheet?.endsWith('-sheet.jpg'));
  assert.ok(fs.existsSync(path.join(mediaDir(h.paths), result.record.sheet ?? '')), 'sheet 要落在缓存目录里');
  assert.ok((result.record.bytes ?? 0) > 0);

  // 有字幕轨时不该跑第二遍 ffmpeg
  assert.equal(h.calls.length, 1);
});

test('没有字幕轨才做字幕条：两张图、预算 2048', async () => {
  const h = harness({ target: { hasSubtitles: false } });
  const result = await prepareVisuals(h.deps, { ...TARGET, hasSubtitles: false });
  assert.equal(result.status, 'ok');
  assert.equal(result.images.length, 2);
  assert.equal(result.tokenReserve, 2048);
  assert.match(result.note, /字幕条/);
  assert.ok(result.record.strip?.endsWith('-strip.jpg'));
  assert.equal(h.calls.length, 2, '九宫格 + 字幕条各跑一次 ffmpeg');
});

test('下载的视频完事就删：缓存里不留 mp4', async () => {
  const h = harness({ videoFile: false });
  const result = await prepareVisuals(h.deps, TARGET);
  assert.equal(result.status, 'ok');
  const leftovers = fs.readdirSync(mediaDir(h.paths)).filter((name) => name.endsWith('.mp4'));
  assert.deepEqual(leftovers, [], '视频抽完帧就该删掉');
});

test('ffmpeg 失败（比如参数不对）：降级并写清原因', async () => {
  const h = harness();
  h.deps.overrides = {
    ...h.deps.overrides,
    runFfmpeg: async () => {
      throw new Error('Invalid data found when processing input');
    },
  };
  const result = await prepareVisuals(h.deps, TARGET);
  assert.equal(result.status, 'skipped');
  assert.match(result.note, /没看画面：抽帧失败/);
  assert.match(result.note, /Invalid data/);
});

/* ---------------- 缓存 ---------------- */

test('缓存按「条数 + 总 MB」清理：新的留着、旧的删掉', () => {
  const dir = tmpDir('media-cache');
  const files: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(dir, `f${i}.jpg`);
    fs.writeFileSync(file, Buffer.alloc(1024, i));
    // 让 mtime 有先后：f0 最旧
    const at = new Date(Date.now() - (5 - i) * 60_000);
    fs.utimesSync(file, at, at);
    files.push(file);
  }

  const removed = pruneMediaCache(dir, { maxFiles: 3 });
  assert.equal(removed, 2);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['f2.jpg', 'f3.jpg', 'f4.jpg'], '新的留着');

  // 总 MB 超限：只剩最新的一个
  const before = left.length;
  const removedBySize = pruneMediaCache(dir, { maxFiles: 99, maxMb: 0.001 });
  assert.equal(removedBySize, before - 1, '总大小超过 1KB 就只留最新的');
});

/* ---------------- 一轮里真跑（run 记录 + 报告） ---------------- */

test('整轮：开了看画面就能抽出一张 sheet，写进 run 记录与报告，且报告里没有图片数据', async () => {
  const dir = tmpDir('media-round');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'offline-key', BILIWHALE_COOKIE: 'SESSDATA=x; bili_jct=0123456789abcdef0123456789abcdef; buvid3=b3' });
  try {
    const paths = resolvePaths({ dataDir: dir });
    ensureLayout(paths);
    const logger = quietLogger(dir);
    const config = new ConfigService(paths.dataDir, logger);
    config.load();
    config.patch({ media: { frames: true, frameCount: 9, subtitleStrip: true } });
    const cfg = config.get();
    assert.equal(cfg.media.frames, true);

    const secrets = new SecretsService(paths.dataDir, logger);
    const state = new AppStateStore(paths.state, logger);
    const seen = SeenLedger.open(paths.seen, logger);
    const quota = QuotaLedger.open(paths.quota, logger);
    const feedback = FeedbackLedger.open(paths.feedback, logger);
    const runs = new RunStore(paths.runsDir, logger);
    const offline = createOfflineStack({ paths, logger, config: cfg, fixturesDir: path.join(repoRoot(), 'fixtures') });

    const videoFile = path.join(dir, 'sample.mp4');
    fs.writeFileSync(videoFile, Buffer.from('not-a-real-mp4'));

    const deps: RoundDeps = {
      paths,
      config,
      secrets,
      logger,
      api: offline.api,
      llm: offline.llm,
      ...writeDeps(paths, logger, offline.transport),
      state,
      seen,
      quota,
      feedback,
      runs,
      configuredModel: cfg.llm.model,
      media: { ffmpegPath: 'ffmpeg', videoFile, runFfmpeg: fakeFfmpeg },
    };

    const record = await runRound(deps, { trigger: 'manual', dryRun: true });
    assert.equal(record.status, 'ok', `一轮应该成功：${record.errors.join('；')}`);

    assert.equal(record.media?.status, 'ok', `media 状态应该是 ok：${JSON.stringify(record.media)}`);
    assert.ok(record.media?.sheet, 'run 记录里要有 sheet 文件名');
    assert.ok(record.media?.bvid, 'run 记录里要说清看的是哪条视频');
    assert.ok(fs.existsSync(path.join(mediaDir(paths), record.media?.sheet ?? '')), 'sheet 文件应该真的存在');
    assert.ok(record.phases.some((phase) => phase.name === 'frames'), 'run 记录里要有 frames 相位');

    const report = fs.readFileSync(reportFile(paths, record.startedAt.slice(0, 10)), 'utf8');
    assert.match(report, /看了画面：BV/, '报告要写清「看了画面」');
    assert.equal(report.includes('data:image'), false, '图片数据不许进报告');
    assert.equal(report.includes('base64'), false, '图片数据不许进报告');
  } finally {
    restoreEnv();
  }
});
