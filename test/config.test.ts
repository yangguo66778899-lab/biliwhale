import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { appendLine, readJson, readTailLines, writeJsonAtomic, writeTextAtomic } from '../src/shared/atomic.ts';
import { buildDefaults, validateConfig, getSpec } from '../src/config/validate.ts';
import { deepMerge } from '../src/config/service.ts';
import { normalizeCookie } from '../src/config/secrets.ts';
import { tmpDir } from './helpers.ts';

test('writeJsonAtomic 写出完整文件并保留 .bak', () => {
  const dir = tmpDir('atomic');
  const file = path.join(dir, 'x.json');

  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(readJson<{ a: number }>(file).ok, true);

  writeJsonAtomic(file, { a: 2 });
  const main = readJson<{ a: number }>(file);
  const backup = readJson<{ a: number }>(`${file}.bak`);
  assert.ok(main.ok && main.value.a === 2);
  assert.ok(backup.ok && backup.value.a === 1);

  // 没有残留 tmp 文件
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('readJson 在主文件损坏时回退 .bak，两者都坏则报 corrupt', () => {
  const dir = tmpDir('atomic-bak');
  const file = path.join(dir, 'y.json');
  writeJsonAtomic(file, { ok: 1 });
  writeJsonAtomic(file, { ok: 2 }); // 现在 .bak 是 {ok:1}

  fs.writeFileSync(file, '{ broken json');
  const recovered = readJson<{ ok: number }>(file);
  assert.ok(recovered.ok);
  assert.equal(recovered.from, 'backup');
  assert.equal(recovered.value.ok, 1);

  fs.writeFileSync(`${file}.bak`, 'also broken');
  const corrupted = readJson(file);
  assert.equal(corrupted.ok, false);
  assert.equal(corrupted.ok === false ? corrupted.corrupt : null, true);
});

test('writeTextAtomic / appendLine / readTailLines', () => {
  const dir = tmpDir('atomic-text');
  const file = path.join(dir, 'note.md');
  writeTextAtomic(file, '# 标题\n');
  writeTextAtomic(file, '# 标题\n第二行\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 标题\n第二行\n');

  const jsonl = path.join(dir, 'events.jsonl');
  for (let i = 0; i < 5; i += 1) appendLine(jsonl, JSON.stringify({ i }));
  const tail = readTailLines(jsonl, 2);
  assert.equal(tail.length, 2);
  assert.deepEqual(JSON.parse(tail[1] ?? '{}'), { i: 4 });
  assert.deepEqual(readTailLines(path.join(dir, 'missing.jsonl'), 3), []);
});

test('默认配置能通过校验，且关键默认值符合需求文档', () => {
  const result = validateConfig(buildDefaults());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const cfg = result.value;
  assert.equal(cfg.version, 1);
  assert.equal(cfg.llm.model, 'deepseek-flash');
  assert.equal(cfg.llm.modelAuto, true);
  assert.equal(cfg.schedule.skipChance, 0.2);
  assert.equal(cfg.schedule.maxWakesPerDay, 1);
  assert.equal(cfg.share.enabled, false, '分享默认必须关');
  assert.equal(cfg.listen.comment.enabled, false);
  assert.equal(cfg.listen.dm.enabled, false);
  assert.equal(cfg.dynamic.enabled, false);
  assert.equal(cfg.like.enabled, false);
  assert.equal(cfg.fav.enabled, true);
  assert.equal(cfg.diary.enabled, true);
  assert.equal(cfg.score.minScore, 13);
  assert.equal(cfg.logging.eventsRetentionDays, 30);
  assert.equal(cfg.logging.runsRetentionDays, 90);
  assert.equal(cfg.logging.docsRetentionDays, 365);
  // v0.5：峰谷概念已删除
  const schedule = cfg.schedule as unknown as Record<string, unknown>;
  assert.equal('preferCheapWindow' in schedule, false);
  assert.equal('cheapWindows' in schedule, false);
});

test('缺字段补默认值，非法值报错并给出字段路径', () => {
  const missing = validateConfig({ llm: { model: 'x' } });
  assert.equal(missing.ok, true);
  if (missing.ok) {
    assert.equal(missing.value.llm.model, 'x');
    assert.equal(missing.value.llm.maxSteps, 20);
    // 整组缺失 → 在组这一级报 warn（不会把每个子字段都报一遍）
    assert.ok(missing.issues.some((i) => i.path === 'app' && i.severity === 'warn'));
    assert.ok(missing.issues.some((i) => i.path === 'llm.maxTokens' && i.severity === 'warn'));
  }

  const bad = validateConfig({ schedule: { skipChance: 5 } });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    const issue = bad.issues.find((i) => i.path === 'schedule.skipChance');
    assert.ok(issue);
    assert.equal(issue?.severity, 'error');
  }

  const badType = validateConfig({ llm: { maxSteps: 'abc' } });
  assert.equal(badType.ok, false);

  const badEnum = validateConfig({ report: { level: '详细' } });
  assert.equal(badEnum.ok, false);
});

test('跨字段规则：觉醒次数上限 3、时长倒挂、急停提示', () => {
  const tooMany = validateConfig({
    schedule: { windows: [{ start: '08:00', end: '10:00', wakes: 2, label: 'a' }, { start: '20:00', end: '22:00', wakes: 2, label: 'b' }] },
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.ok(tooMany.issues.some((i) => i.path === 'schedule.windows'));

  const inverted = validateConfig({ content: { minDuration: 600, maxDuration: 100 } });
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.ok(inverted.issues.some((i) => i.path === 'content.maxDuration'));

  const kill = validateConfig({ safety: { killSwitch: true } });
  assert.equal(kill.ok, true);
  if (kill.ok) assert.ok(kill.issues.some((i) => i.path === 'safety.killSwitch' && i.severity === 'info'));

  const badProxy = validateConfig({ app: { proxy: 'socks5://x' } });
  assert.equal(badProxy.ok, false);
  const goodProxy = validateConfig({ app: { proxy: 'http://127.0.0.1:7890' } });
  assert.equal(goodProxy.ok, true);
  const direct = validateConfig({ app: { proxy: 'direct' } });
  assert.equal(direct.ok, true);
});

test('未知字段被保留到 _unknown，不静默丢弃', () => {
  const result = validateConfig({ foo: 1, llm: { model: 'm', mystery: true } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.unknown.foo, 1);
  assert.equal(result.unknown['llm.mystery'], true);
  assert.ok(result.issues.some((i) => i.path === 'foo' && i.severity === 'warn'));
});

test('deepMerge 递归合并且数组整体替换', () => {
  const merged = deepMerge(
    { a: { b: 1, c: 2 }, list: [1, 2, 3] },
    { a: { c: 9 }, list: [7] },
  );
  assert.deepEqual(merged, { a: { b: 1, c: 9 }, list: [7] });
});

test('getSpec 能取到字段说明（设置页将来要用）', () => {
  const spec = getSpec('share.dailyCap');
  assert.ok(spec);
  assert.equal(spec?.kind, 'number');
  assert.equal(spec?.label, '每日分享上限');
  assert.equal(getSpec('nope.nothing'), undefined);
});

test('normalizeCookie 校验 SESSDATA / bili_jct / buvid3', () => {
  const ok = normalizeCookie('SESSDATA=abc; bili_jct=0123456789abcdef0123456789abcdef; buvid3=b3');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.match(ok.cookie, /^SESSDATA=abc/);
    assert.match(ok.cookie, /bili_jct=0123456789abcdef0123456789abcdef/);
    assert.match(ok.cookie, /buvid3=b3/);
    assert.deepEqual(ok.warnings, []);
  }

  const missing = normalizeCookie('bili_jct=abc');
  assert.equal(missing.ok, false);

  const dirty = normalizeCookie('SESSDATA=abc; bili_jct=1234567; buvid3=b3');
  assert.equal(dirty.ok, true);
  if (dirty.ok) {
    assert.ok(dirty.warnings.some((w) => w.includes('32 位十六进制')));
    assert.ok(!dirty.cookie.includes('bili_jct'));
  }

  const noBuvid = normalizeCookie('SESSDATA=abc');
  assert.equal(noBuvid.ok, true);
  if (noBuvid.ok) assert.ok(noBuvid.warnings.some((w) => w.includes('buvid3')));
});
