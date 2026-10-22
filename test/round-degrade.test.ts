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
import { diaryFile, reportFile } from '../src/orchestrator/writers.ts';
import { localDate } from '../src/shared/time.ts';
import { repoRoot, tmpDir, withEnv, writeDeps } from './helpers.ts';

/** 复制一份可用夹具，但把模型响应换成「彻底不可用」的内容。 */
function brokenModelFixtures(): string {
  const root = tmpDir('broken-fixtures');
  fs.cpSync(path.join(repoRoot(), 'fixtures', 'bili'), path.join(root, 'bili'), { recursive: true });
  fs.mkdirSync(path.join(root, 'llm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'llm', 'screen.json'), '这不是 JSON，只是一句解释。', 'utf8');
  fs.writeFileSync(path.join(root, 'llm', 'deep.json'), '```json\n{"selected": [ 半截\n```', 'utf8');
  return root;
}

test('模型输出两次都不可用：修一次后降级，仍写出报告与两本诚实的日记', async () => {
  const dir = tmpDir('degrade');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'offline-key', BILIWHALE_COOKIE: 'SESSDATA=x; bili_jct=0123456789abcdef0123456789abcdef' });
  try {
    const paths = resolvePaths({ dataDir: dir });
    ensureLayout(paths);
    const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
    const config = new ConfigService(paths.dataDir, logger);
    config.load();
    const cfg = config.get();
    const secrets = new SecretsService(paths.dataDir, logger);
    const state = new AppStateStore(paths.state, logger);
    const seen = SeenLedger.open(paths.seen, logger);
    const quota = QuotaLedger.open(paths.quota, logger);
    const feedback = FeedbackLedger.open(paths.feedback, logger);
    const runs = new RunStore(paths.runsDir, logger);

    const offline = createOfflineStack({ paths, logger, config: cfg, fixturesDir: brokenModelFixtures() });
    const deps: RoundDeps = {
      paths,
      config,
      secrets,
      logger,
      api: offline.api,
      llm: offline.llm,
      state,
      seen,
      quota,
      feedback,
      runs,
      ...writeDeps(paths, logger, offline.transport),
      configuredModel: cfg.llm.model,
    };

    const record = await runRound(deps, { trigger: 'manual', dryRun: true });

    assert.equal(record.status, 'degraded', '模型不可用时要标 degraded，而不是 failed');
    assert.equal(record.counts.candidates, 5, '取候选不依赖模型');
    assert.equal(record.counts.selected, 0, '降级时不挑中任何东西');
    assert.equal(record.counts.shared, 0);
    assert.ok(record.errors.some((e) => e.includes('初筛输出不可用')), `错误要可见：${record.errors.join('；')}`);
    assert.ok(record.errors.some((e) => e.includes('最终输出不可用')));
    assert.equal(offline.llmCalls(), 4, '初筛与深读各修一次，共 4 次调用');

    const today = localDate();
    const report = fs.readFileSync(reportFile(paths, today), 'utf8');
    assert.match(report, /今天没有值得占你注意力的/);

    const publicDiary = fs.readFileSync(diaryFile(paths, 'public', today), 'utf8');
    assert.match(publicDiary, /今天没看成/, '降级日记要诚实说没看成');
    const privateDiary = fs.readFileSync(diaryFile(paths, 'private', today), 'utf8');
    assert.match(privateDiary, /偏好校准/);
    assert.match(privateDiary, /本轮失败/);

    // 判重照记（模型坏了也要记住看过什么，否则下一轮还是同一批）
    const seenFile = JSON.parse(fs.readFileSync(paths.seen, 'utf8')) as { videos: Record<string, unknown> };
    assert.equal(Object.keys(seenFile.videos).length, 5);
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('深读第一次缺字段 → 修一次就成功（只多花一次调用，不降级）', async () => {
  const dir = tmpDir('repair-ok');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'offline-key', BILIWHALE_COOKIE: 'SESSDATA=x' });
  try {
    const root = tmpDir('repair-fixtures');
    fs.cpSync(path.join(repoRoot(), 'fixtures', 'bili'), path.join(root, 'bili'), { recursive: true });
    fs.mkdirSync(path.join(root, 'llm'), { recursive: true });

    const screenFile = path.join(root, 'llm', 'screen.json');
    fs.writeFileSync(
      screenFile,
      JSON.stringify({
        items: [
          { bvid: 'BV1a0000001', score: 16, reason: '具体结论' },
          { bvid: 'BV1a0000005', score: 15, reason: '三个真坑' },
          { bvid: 'BV1a0000004', score: 11, reason: '结论偏轻' },
          { bvid: 'BV1a0000002', score: 4, reason: '纯音乐' },
          { bvid: 'BV1a0000003', score: 3, reason: '带货' },
        ],
      }),
      'utf8',
    );
    // 第一次深读：缺 diary.private（会被校验拦下）
    const badDeep = path.join(root, 'llm', 'deep-bad.json');
    fs.writeFileSync(
      badDeep,
      JSON.stringify({
        selected: [{ bvid: 'BV1a0000001', score: 16, why: '理由足够长，能通过校验。', oneliner: '一句话', share: { channel: 'none', text: '' } }],
        skipped: [],
        diary: { public: '今天看了一条。' },
        notify: '挑中一条',
      }),
      'utf8',
    );
    // 修一次之后的正确输出
    const goodDeep = path.join(root, 'llm', 'deep-good.json');
    fs.writeFileSync(
      goodDeep,
      fs.readFileSync(path.join(repoRoot(), 'fixtures', 'llm', 'deep.json'), 'utf8'),
      'utf8',
    );

    const paths = resolvePaths({ dataDir: dir });
    ensureLayout(paths);
    const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
    const config = new ConfigService(paths.dataDir, logger);
    config.load();
    const cfg = config.get();
    const secrets = new SecretsService(paths.dataDir, logger);
    const state = new AppStateStore(paths.state, logger);
    const seen = SeenLedger.open(paths.seen, logger);
    const quota = QuotaLedger.open(paths.quota, logger);
    const feedback = FeedbackLedger.open(paths.feedback, logger);
    const runs = new RunStore(paths.runsDir, logger);
    const offline = createOfflineStack({ paths, logger, config: cfg, fixturesDir: root, llmFiles: [screenFile, badDeep, goodDeep] });
    const deps: RoundDeps = { paths, config, secrets, logger, api: offline.api, llm: offline.llm, state, seen, quota, feedback, runs, ...writeDeps(paths, logger, offline.transport), configuredModel: cfg.llm.model };

    const record = await runRound(deps, { trigger: 'manual', dryRun: true });

    assert.equal(record.status, 'ok', `修一次之后应成功：${record.errors.join('；')}`);
    assert.equal(offline.llmCalls(), 3, '初筛一次 + 深读一次 + 修复一次');
    assert.equal(record.counts.selected, 2);
    assert.deepEqual(record.errors, [], '修好了就不该留错误');
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
