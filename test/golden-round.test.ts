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
import { reportFile, diaryFile } from '../src/orchestrator/writers.ts';
import { repoRoot, tmpDir, withEnv } from './helpers.ts';

test('golden：离线夹具跑完整一轮（取候选 → 初筛 → 深读 → 报告/日记落盘，零远端写）', async () => {
  const dir = tmpDir('golden');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'offline-key', BILIWHALE_COOKIE: 'SESSDATA=x; bili_jct=0123456789abcdef0123456789abcdef; buvid3=b3' });

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

    const offline = createOfflineStack({ paths, logger, config: cfg, fixturesDir: path.join(repoRoot(), 'fixtures') });

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
      configuredModel: cfg.llm.model,
    };

    const record = await runRound(deps, { trigger: 'manual', dryRun: true });

    assert.equal(record.status, 'ok', `一轮应该成功，实际 ${record.status}：${record.errors.join('；')}`);
    assert.equal(record.counts.candidates, 5, '五条候选（搜索 4 条 + 热门 1 条去重后）');
    assert.equal(record.counts.screened, 5);
    assert.equal(record.counts.deepRead, 3, '深读按分数取前 3 条');
    assert.equal(record.counts.selected, 2);
    assert.equal(record.counts.shared, 0, 'M0 不发任何东西');
    assert.equal(offline.llmCalls(), 2, '初筛 + 深读各一次模型调用');
    assert.equal(record.model.calls, 2, 'run 记录里的模型调用次数要准确（初筛 + 深读）');
    assert.ok(record.model.promptTokens > 0);
    assert.ok(record.phases.some((p) => p.name === 'persist' && p.status === 'ok'));

    const today = record.startedAt.slice(0, 10);
    const report = reportFile(paths, today);
    assert.ok(fs.existsSync(report), '当天报告应该存在');
    const reportText = fs.readFileSync(report, 'utf8');
    assert.match(reportText, /# \d{4}-\d{2}-\d{2} · 今日刷到的/);
    assert.match(reportText, /### 这一轮/, '模型写的 report_md 要进日报');
    assert.match(reportText, /翻了 5 条，深读 3 条/, 'report_md 的正文要原样保留');
    assert.match(reportText, /### 挑中的/);
    assert.match(reportText, /BV1a0000001/);
    assert.match(reportText, /为什么值得/);
    assert.match(reportText, /### 看过的（跳过）/);
    assert.match(reportText, /无字幕\/无语音/);
    assert.match(reportText, /### 今天的账/);
    assert.match(reportText, /### 运行备注（排障用）/, '排障备注要单独成段，不混进给人看的账目');
    assert.match(reportText, /预演/);

    const publicDiary = diaryFile(paths, 'public', today);
    const privateDiary = diaryFile(paths, 'private', today);
    assert.ok(fs.existsSync(publicDiary) && fs.existsSync(privateDiary));
    assert.match(fs.readFileSync(publicDiary, 'utf8'), /周报|猫/);
    assert.match(fs.readFileSync(privateDiary, 'utf8'), /偏好校准/, '私人日记必须有偏好校准');

    // 判重账本记下了 5 条
    const seenFile = JSON.parse(fs.readFileSync(paths.seen, 'utf8')) as { videos: Record<string, unknown> };
    assert.equal(Object.keys(seenFile.videos).length, 5, `判重账本应有 5 条，实际：${Object.keys(seenFile.videos).join(',')}`);

    // 归档一行一条
    const archive = path.join(paths.archiveDir, `${today.slice(0, 7)}.md`);
    assert.ok(fs.existsSync(archive));
    assert.equal(fs.readFileSync(archive, 'utf8').trim().split('\n').filter((l) => l.startsWith(today)).length, 5);

    // 事件流非空，且不含凭据
    const events = fs.readFileSync(paths.events, 'utf8');
    assert.ok(events.includes('round'));
    assert.ok(!events.includes('0123456789abcdef0123456789abcdef'), '事件流不得出现 bili_jct');
    assert.ok(!events.includes('offline-key'), '事件流不得出现 API key');

    // 运行记录落盘
    const runFile = path.join(paths.runsDir, `${record.id}.json`);
    assert.ok(fs.existsSync(runFile));
    const runJson = JSON.parse(fs.readFileSync(runFile, 'utf8')) as { status: string; endedAt: string | null };
    assert.equal(runJson.status, 'ok');
    assert.ok(runJson.endedAt);

    // 通知兜底文件
    assert.match(fs.readFileSync(paths.notifyLog, 'utf8'), /挑中|发/);
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('第二轮不会再推同一批视频（判重生效）', async () => {
  const dir = tmpDir('golden-2');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'offline-key', BILIWHALE_COOKIE: 'SESSDATA=x' });
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
    const offline = createOfflineStack({ paths, logger, config: cfg, fixturesDir: path.join(repoRoot(), 'fixtures') });

    const deps: RoundDeps = { paths, config, secrets, logger, api: offline.api, llm: offline.llm, state, seen, quota, feedback, runs, configuredModel: cfg.llm.model };

    const first = await runRound(deps, { trigger: 'manual', dryRun: true });
    assert.equal(first.counts.candidates, 5);

    const second = await runRound(deps, { trigger: 'manual', dryRun: true });
    assert.equal(second.counts.candidates, 0, '看过的视频不该再来一遍');
    assert.ok(second.notes.some((n) => n.includes('今天没有合适的候选')));
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
