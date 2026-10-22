import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runRound } from '../src/orchestrator/round.ts';
import { createTestRound, repoRoot, tmpDir, withEnv } from './helpers.ts';

/** 复制夹具，但把 nav 改成「cookie 已失效」。 */
function expiredCookieFixtures(): string {
  const root = tmpDir('expired-fixtures');
  fs.cpSync(path.join(repoRoot(), 'fixtures', 'bili'), path.join(root, 'bili'), { recursive: true });
  fs.cpSync(path.join(repoRoot(), 'fixtures', 'llm'), path.join(root, 'llm'), { recursive: true });
  const navFile = path.join(root, 'bili', 'nav.json');
  const nav = JSON.parse(fs.readFileSync(navFile, 'utf8')) as { code: number; data: Record<string, unknown> };
  nav.code = -101;
  nav.data.isLogin = false;
  nav.data.uname = '';
  fs.writeFileSync(navFile, JSON.stringify(nav, null, 2), 'utf8');
  return root;
}

test('每日 token 预算用完 → 不再开新轮，写失败日记并说清原因', async () => {
  const dir = tmpDir('budget-stop');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'k', BILIWHALE_COOKIE: 'SESSDATA=x' });
  try {
    const ctx = await createTestRound(dir);
    const limit = ctx.deps.config.get().llm.dailyBudgetTokens;
    ctx.deps.state.update((state) => ({ ...state, budget: { date: state.budget.date, tokens: limit, costCny: 0, calls: 9 } }));

    const record = await runRound(ctx.deps, { trigger: 'manual', dryRun: true });
    assert.equal(record.status, 'failed');
    assert.ok(record.errors.some((e) => e.includes('token 预算已用完')), record.errors.join('；'));
    assert.equal(record.counts.candidates, 0, '预算用完时不该再去取候选');
    assert.equal(ctx.offline.llmCalls(), 0, '也不该调用模型');

    const today = record.startedAt.slice(0, 10);
    const publicDiary = fs.readFileSync(path.join(ctx.paths.diariesPublicDir, `${today}.md`), 'utf8');
    assert.match(publicDiary, /今天没跑成/);
    assert.match(publicDiary, /token 预算/);
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('每日预算用到 80% → 只提醒，照常跑完', async () => {
  const dir = tmpDir('budget-warn');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'k', BILIWHALE_COOKIE: 'SESSDATA=x' });
  try {
    const ctx = await createTestRound(dir);
    const limit = ctx.deps.config.get().llm.dailyBudgetTokens;
    ctx.deps.state.update((state) => ({ ...state, budget: { date: state.budget.date, tokens: Math.ceil(limit * 0.8), costCny: 0, calls: 9 } }));

    const record = await runRound(ctx.deps, { trigger: 'manual', dryRun: true });
    assert.equal(record.status, 'ok', record.errors.join('；'));
    assert.ok(record.notes.some((n) => n.includes('接近每日预算')), `应提醒预算：${record.notes.join('；')}`);
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cookie 失效：报告里说清「字幕会拿不到」，而不是让用户以为视频都没字幕', async () => {
  const dir = tmpDir('expired-cookie');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'k', BILIWHALE_COOKIE: 'SESSDATA=stale; bili_jct=0123456789abcdef0123456789abcdef' });
  try {
    const ctx = await createTestRound(dir);
    // 换一套「nav 说未登录」的夹具
    const broken = expiredCookieFixtures();
    const { createOfflineStack } = await import('../src/dev/offline.ts');
    const stack = createOfflineStack({ paths: ctx.paths, logger: ctx.deps.logger, config: ctx.deps.config.get(), fixturesDir: broken });
    ctx.deps.api = stack.api;
    ctx.deps.llm = stack.llm;

    const record = await runRound(ctx.deps, { trigger: 'manual', dryRun: true });
    assert.equal(record.status, 'ok', record.errors.join('；'));
    assert.ok(record.notes.some((n) => n.includes('cookie 已失效')), `应提示 cookie 失效：${record.notes.join('；')}`);

    // 报告里要同时看到「cookie 失效」和「因无字幕跳过」，别让用户误以为视频真没字幕
    const today = record.startedAt.slice(0, 10);
    const report = fs.readFileSync(path.join(ctx.paths.reportsDir, `${today}.md`), 'utf8');
    assert.match(report, /cookie 已失效/);
    assert.match(report, /因无字幕跳过/);
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('登录态正常时报告里留一行「登录态正常：昵称」', async () => {
  const dir = tmpDir('login-ok');
  const restoreEnv = withEnv({ BILIWHALE_API_KEY: 'k', BILIWHALE_COOKIE: 'SESSDATA=x; bili_jct=0123456789abcdef0123456789abcdef' });
  try {
    const ctx = await createTestRound(dir);
    const record = await runRound(ctx.deps, { trigger: 'manual', dryRun: true });
    assert.ok(record.notes.some((n) => n.includes('登录态正常：测试账号')), record.notes.join('；'));
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
