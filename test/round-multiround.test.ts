import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { runRound } from '../src/orchestrator/round.ts';
import { diaryFile, reportFile } from '../src/orchestrator/writers.ts';
import { localDate } from '../src/shared/time.ts';
import { createTestRound, tmpDir, withEnv } from './helpers.ts';

const ROUND_HEADER = /^## \d{2}:\d{2} · 跑了一轮$/;

function roundHeaders(text: string): number {
  return text.split('\n').filter((line) => ROUND_HEADER.test(line.trim())).length;
}

/** 一级标题（`# ` 开头）的条数：用来确认「一天的文件只有一个标题」。 */
function h1Count(text: string): number {
  return text.split('\n').filter((line) => line.startsWith('# ')).length;
}

/**
 * 清空判重账本。
 * 注意：必须连 `.bak` 一起删 —— `readJson` 在主文件缺失时会从备份恢复（这是文档要的
 * 「读取失败 → 回退 .bak」语义），只删主文件等于什么都没删。
 */
function resetSeenLedger(paths: { seen: string }): void {
  fs.rmSync(paths.seen, { force: true });
  fs.rmSync(`${paths.seen}.bak`, { force: true });
}

test('同一天跑两轮：报告与日记追加、不覆盖；归档累计', async () => {
  const dir = tmpDir('multi-round');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'offline-key', BILIWHALE_COOKIE: 'SESSDATA=x; bili_jct=0123456789abcdef0123456789abcdef; buvid3=b3' });
  try {
    const first = await createTestRound(dir);
    const record1 = await runRound(first.deps, { trigger: 'manual', dryRun: true });
    assert.equal(record1.status, 'ok', `第一轮应成功：${record1.errors.join('；')}`);

    const today = localDate();
    const report = reportFile(first.paths, today);
    const publicDiary = diaryFile(first.paths, 'public', today);
    assert.equal(roundHeaders(fs.readFileSync(report, 'utf8')), 1);
    assert.equal(roundHeaders(fs.readFileSync(publicDiary, 'utf8')), 1);
    const firstReportLength = fs.readFileSync(report, 'utf8').length;

    // 第二轮：清掉判重账本（模拟「第二天又看到同一批」），并换一套全新的夹具剧本
    resetSeenLedger(first.paths);
    const second = await createTestRound(dir);
    const record2 = await runRound(second.deps, { trigger: 'manual', dryRun: true });
    assert.equal(record2.status, 'ok', `第二轮应成功：${record2.errors.join('；')}`);
    assert.equal(record2.counts.candidates, 5, '清掉判重后应重新取到 5 条');

    const reportText = fs.readFileSync(report, 'utf8');
    assert.equal(roundHeaders(reportText), 2, '报告应有两轮的小节');
    assert.ok(reportText.length > firstReportLength, '第二轮是追加，不能覆盖第一轮');
    assert.match(reportText, /# \d{4}-\d{2}-\d{2} · 今日刷到的/, '标题只出现一次');
    assert.equal(h1Count(reportText), 1, '一天的标题不能重复写');

    const publicText = fs.readFileSync(publicDiary, 'utf8');
    assert.equal(roundHeaders(publicText), 2, '日记应有两轮的小节');
    assert.equal(h1Count(publicText), 1, '日记标题只写一次');

    const archive = fs.readFileSync(`${first.paths.archiveDir}/${today.slice(0, 7)}.md`, 'utf8');
    assert.equal(archive.split('\n').filter((line) => line.startsWith(today)).length, 10, '两轮各 5 条都要归档');

    // 两轮的 run 记录都在
    const runs = fs.readdirSync(first.paths.runsDir).filter((f) => f.endsWith('.json'));
    assert.equal(runs.length, 2);
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同日第二轮沿用当天日记文件，但不会把「# 标题」重复写进去', async () => {
  const dir = tmpDir('multi-header');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'offline-key', BILIWHALE_COOKIE: 'SESSDATA=x' });
  try {
    const ctx = await createTestRound(dir);
    await runRound(ctx.deps, { trigger: 'manual', dryRun: true });
    resetSeenLedger(ctx.paths);
    const again = await createTestRound(dir);
    const record = await runRound(again.deps, { trigger: 'manual', dryRun: true });
    assert.equal(record.status, 'ok', `第二轮应成功：${record.errors.join('；')}`);

    const today = localDate();
    for (const kind of ['public', 'private'] as const) {
      const text = fs.readFileSync(diaryFile(ctx.paths, kind, today), 'utf8');
      assert.equal(h1Count(text), 1, `${kind} 日记标题不应重复`);
      assert.equal(roundHeaders(text), 2);
    }
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
