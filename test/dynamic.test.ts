import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildDynamicPrompt, executeDailyDynamic, isDynamicDue, runDailyDynamicIfDue } from '../src/orchestrator/dynamic.ts';
import { appendDynamicNote, reportFile } from '../src/orchestrator/writers.ts';
import { validateConfig } from '../src/config/validate.ts';
import { QuotaLedger } from '../src/state/ledgers.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';
import type { Config } from '../src/config/spec.ts';

function setup(over: Record<string, unknown> = {}, nowIso = '2026-10-24T09:00:00+08:00') {
  const dir = tmpDir('dynamic');
  const logger = new Logger({ logDir: dir, eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
  const quota = QuotaLedger.open(path.join(dir, 'quota.json'), logger);
  const state = new AppStateStore(path.join(dir, 'state.json'), logger);
  const parsed = validateConfig({
    safety: { writeEnabled: true, dryRun: false, killSwitch: false },
    dynamic: { enabled: true, dailyTime: '00:00', dailyCap: 1, minChars: 100, maxChars: 1000 },
    ...over,
  });
  assert.ok(parsed.ok, JSON.stringify(parsed.issues));
  const config = parsed.value as Config;
  const calls: string[] = [];
  const writer = {
    postDynamic: async (input: { text: string }) => {
      calls.push(input.text);
      return { ok: true as const, plan: { method: 'POST' as const, url: 'https://example.invalid/d', form: {} } };
    },
  };
  const deps = {
    llm: {} as never,
    writer: writer as never,
    quota,
    state,
    config,
    logger,
    now: () => new Date(nowIso),
  };
  return { dir, deps, quota, state, calls, config };
}

test('日更：到点才发，一天只发一次，时间格式坏就当没到', () => {
  const at = (hhmm: string): Date => new Date(`2026-10-24T${hhmm}:00+08:00`);
  assert.equal(isDynamicDue(at('00:00'), '00:00', null), true);
  assert.equal(isDynamicDue(at('00:00'), '00:30', null), false);
  assert.equal(isDynamicDue(at('00:31'), '00:30', null), true);
  assert.equal(isDynamicDue(at('09:00'), '00:00', '2026-10-24'), false, '今天发过了就不再发');
  assert.equal(isDynamicDue(at('09:00'), '25:00', null), false, '坏格式不当作到点');
});

test('日更：提示词里有今天的报告/日记/最近动态，并且明确「不要跳过」', () => {
  const prompt = buildDynamicPrompt({
    date: '2026-10-24',
    persona: '我叫鲸鲸',
    reportText: '今天挑中一条讲修操场的。',
    diaryPublic: '孩子说手是黑的。',
    diaryPrivate: '下次多看这种。',
    recent: ['昨天发的：今天没看到什么', '前天发的：修旧物那条真好'],
    minChars: 100,
    maxChars: 1000,
  });
  assert.match(prompt, /今日挑中一条|讲修操场的/);
  assert.match(prompt, /手是黑的/);
  assert.match(prompt, /昨天发的/);
  assert.match(prompt, /不要跳过/);
  assert.match(prompt, /不 @ 任何人/);
  assert.match(prompt, /100–1000 字/);
});

test('日更：预演不占额度、真发记账、同内容不重复发', async () => {
  const h = setup();
  const dry = await executeDailyDynamic(h.deps, { text: '今天没什么可说的，就两行', dryRun: true, date: '2026-10-24' });
  assert.equal(dry.status, 'dry_run');
  assert.equal(h.quota.countOn('2026-10-24', 'dynamic'), 1, '预演也记一笔尝试');
  assert.equal(h.quota.countPlainCommentsOn('2026-10-24'), 0);

  const h2 = setup();
  const sent = await executeDailyDynamic(h2.deps, { text: '今天看了一条修操场的，孩子那段记得住', dryRun: false, date: '2026-10-24' });
  assert.equal(sent.status, 'sent');
  assert.equal(h2.calls.length, 1);
  assert.equal(h2.quota.countOn('2026-10-24', 'dynamic'), 1);

  const again = await executeDailyDynamic(h2.deps, { text: '今天看了一条修操场的，孩子那段记得住', dryRun: false, date: '2026-10-24' });
  assert.equal(again.status, 'denied');
  assert.match(again.deny.join('；'), /今天已经发过|上限|幂等/);
});

test('日更：开关关着 / 上限 0 / 风控冷却 都拒绝并写清原因', async () => {
  const off = setup({ dynamic: { enabled: false } });
  const a = await executeDailyDynamic(off.deps, { text: 'x', dryRun: false, date: '2026-10-24' });
  assert.equal(a.status, 'denied');
  assert.match(a.deny.join('；'), /开关关着/);

  const zero = setup({ dynamic: { enabled: true, dailyCap: 0 } });
  const b = await executeDailyDynamic(zero.deps, { text: 'x', dryRun: false, date: '2026-10-24' });
  assert.match(b.deny.join('；'), /上限是 0/);

  const cooled = setup();
  cooled.state.setRiskCooldown('2026-10-24T09:30:00+08:00');
  const c = await executeDailyDynamic(cooled.deps, { text: 'x', dryRun: false, date: '2026-10-24' });
  assert.match(c.deny.join('；'), /风控冷却中/);
});

test('日更：写进当天报告，单独一节', () => {
  const dir = tmpDir('dynamic-report');
  const paths = resolvePaths({ dataDir: dir });
  fs.mkdirSync(paths.reportsDir, { recursive: true });
  appendDynamicNote(paths, { date: '2026-10-24', at: '00:05', text: '今天没什么可说，就两行', dryRun: false });
  appendDynamicNote(paths, { date: '2026-10-24', at: '00:05', reason: '风控冷却中', dryRun: false });
  const text = fs.readFileSync(reportFile(paths, '2026-10-24'), 'utf8');
  assert.match(text, /### 动态（00:05）/);
  assert.match(text, /今天没什么可说/);
  assert.match(text, /没发：风控冷却中/);
});

test('日更：到点自动跑一次——用当天的报告/日记，发完记进状态与报告，当天不再发', async () => {
  const dir = tmpDir('daily-run');
  const paths = resolvePaths({ dataDir: dir });
  fs.mkdirSync(paths.reportsDir, { recursive: true });
  fs.mkdirSync(paths.diariesPublicDir, { recursive: true });
  fs.mkdirSync(paths.diariesPrivateDir, { recursive: true });
  fs.writeFileSync(reportFile(paths, '2026-10-24'), '# 2026-10-24 · 今日刷到的\n\n### 这一轮\n\n今天挑中一条讲修操场的。\n', 'utf8');
  fs.writeFileSync(path.join(paths.diariesPublicDir, '2026-10-24.md'), '孩子说手是黑的。', 'utf8');

  const logger = new Logger({ logDir: dir, eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
  const quota = QuotaLedger.open(path.join(dir, 'quota.json'), logger);
  const state = new AppStateStore(path.join(dir, 'state.json'), logger);
  const parsed = validateConfig({ safety: { writeEnabled: true, dryRun: false }, dynamic: { enabled: true, dailyTime: '00:00' } });
  assert.ok(parsed.ok);
  const cfg = parsed.value;
  const sent: string[] = [];
  const prompts: string[] = [];
  const ctx = {
    paths,
    logger,
    config: { get: () => cfg },
    state,
    quota,
    writer: { postDynamic: async (input: { text: string }) => { sent.push(input.text); return { ok: true, plan: {} }; } },
    llm: {
      chat: async (req: { messages: Array<{ content: string }> }) => {
        prompts.push(req.messages[1]?.content ?? '');
        return { ok: true, data: { content: JSON.stringify({ text: '修操场那条，孩子说手是黑的，我一晚上想着这句' }), usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 } } };
      },
    },
  } as never;

  const first = await runDailyDynamicIfDue(ctx, { now: () => new Date('2026-10-24T00:05:00+08:00') });
  assert.equal(first.ran, true);
  assert.equal(first.outcome?.status, 'sent');
  assert.equal(sent.length, 1);
  assert.match(prompts[0] ?? '', /修操场|手是黑的/, '提示词里要有当天的材料');
  assert.equal(state.lastDynamicDate(), '2026-10-24');
  assert.match(fs.readFileSync(reportFile(paths, '2026-10-24'), 'utf8'), /### 动态（00:05）/);

  const second = await runDailyDynamicIfDue(ctx, { now: () => new Date('2026-10-24T09:00:00+08:00') });
  assert.equal(second.ran, false, '同一天不该再发一条');
  assert.equal(sent.length, 1);
});
