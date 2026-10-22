import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CURRENT_CONFIG_VERSION, migrateConfig, needsMigration } from '../src/config/migrate.ts';
import { ConfigService } from '../src/config/service.ts';
import { checkUpdate, compareVersions, parseVersion } from '../src/update.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';
import type { Config } from '../src/config/spec.ts';

/* ---------------- 配置迁移 ---------------- */

test('迁移：v1 没有 ownerMid/updateUrl → 补上，并提醒填主人 UID', () => {
  const v1 = {
    version: 1,
    account: { mid: 4242, name: '鲸鲸' },
    app: { logLevel: 'info' },
  };
  const result = migrateConfig(v1);
  assert.equal(result.from, 1);
  assert.equal(result.to, CURRENT_CONFIG_VERSION);
  assert.ok(result.applied.length > 0, '应该记录了迁移步骤');
  const account = result.config.account as Record<string, unknown>;
  assert.equal(account.ownerMid, 0);
  assert.equal(account.ownerName, '');
  assert.equal((result.config.app as Record<string, unknown>).updateUrl, '');
  assert.equal(result.config.version, CURRENT_CONFIG_VERSION);
  assert.ok(result.notes.some((note) => note.includes('主人 UID')), '要提醒去填主人 UID');
  // 原有字段不能丢
  assert.equal(account.mid, 4242);
  assert.equal(account.name, '鲸鲸');
});

test('迁移：幂等（跑两次结果一样）', () => {
  const v1 = { version: 1, account: { mid: 1 } };
  const once = migrateConfig(v1);
  const twice = migrateConfig(once.config);
  assert.deepEqual(twice.config, once.config);
  assert.equal(twice.applied.length, 0, '已经是最新版本就不该再迁移');
  assert.equal(needsMigration(once.config), false);
});

test('迁移：更新版本的配置原样保留 + 给出提示（可能是装回了旧程序）', () => {
  const future = { version: 99, account: { ownerMid: 7 } };
  const result = migrateConfig(future);
  assert.deepEqual(result.config, future);
  assert.equal(result.to, 99);
  assert.ok(result.notes.some((note) => note.includes('比程序认识的')));
});

test('迁移：坏结构不崩（不是对象就放弃迁移）', () => {
  const result = migrateConfig('nonsense');
  assert.deepEqual(result.config, {});
  assert.ok(result.notes.length > 0);
});

test('ConfigService：启动时自动迁移并写回（保留 .bak）', () => {
  const dir = tmpDir('migrate');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, account: { mid: 4242, name: '鲸鲸' }, schedule: { windows: [{ start: '07:00', end: '08:00', wakes: 1 }] } }, null, 2),
    'utf8',
  );
  const logger = new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
  const service = new ConfigService(dir, logger);
  service.load();

  assert.equal(service.get().version, CURRENT_CONFIG_VERSION);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as { version: number; account: { ownerMid: number } };
  assert.equal(written.version, CURRENT_CONFIG_VERSION, '迁移后要写回磁盘');
  assert.equal(written.account.ownerMid, 0);
  assert.ok(service.getMigrations().length > 0);
  assert.ok(service.getMigrationNotes().some((note) => note.includes('主人 UID')));
});

/* ---------------- 检查更新 ---------------- */

test('版本比较：语义化，prerelease 算旧', () => {
  assert.equal(compareVersions('0.7.0', '0.6.1'), 1);
  assert.equal(compareVersions('0.6.1', '0.7.0'), -1);
  assert.equal(compareVersions('0.7.0', '0.7.0'), 0);
  assert.equal(compareVersions('v0.7.1', '0.7.0'), 1);
  assert.equal(compareVersions('0.7.0-M5', '0.7.0'), -1, '带 prerelease 的算旧');
  assert.equal(compareVersions('0.7.0-M5', '0.7.0-M4'), 1);
  assert.deepEqual(parseVersion('v1.2.3-M5'), { major: 1, minor: 2, patch: 3, pre: 'M5' });
});

/** 造一个只有 app.updateUrl 的配置对象。 */
function configWithUpdateUrl(url: string): Config {
  return { app: { updateUrl: url }, account: {}, persona: {}, preferences: {}, content: {}, score: {}, share: {}, fav: {}, dynamic: {}, like: {}, listen: {}, diary: {}, report: {}, notify: { channels: [] }, media: {}, safety: {}, ui: {}, logging: {}, llm: {} } as unknown as Config;
}

const fetchReturning = (body: unknown, status = 200): ((input: string, init?: RequestInit) => Promise<Response>) => {
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

test('检查更新：没配地址 → 明确说「没配置」（不发请求）', async () => {
  let called = 0;
  const result = await checkUpdate({
    config: configWithUpdateUrl(''),
    currentVersion: '0.7.0-M5',
    fetchImpl: async () => {
      called += 1;
      return new Response('{}');
    },
  });
  assert.equal(result.configured, false);
  assert.match(result.error ?? '', /配置/);
  assert.equal(called, 0, '没配地址就不该发请求');
});

test('检查更新：有新版本 / 已是最新 / 远端出错', async () => {
  const newer = await checkUpdate({
    config: configWithUpdateUrl('https://example.com/update.json'),
    currentVersion: '0.7.0-M5',
    fetchImpl: fetchReturning({ version: '0.8.0', url: 'https://example.com/setup.exe', notes: '修了很多' }),
  });
  assert.equal(newer.configured, true);
  assert.equal(newer.latest, '0.8.0');
  assert.equal(newer.hasUpdate, true);
  assert.equal(newer.url, 'https://example.com/setup.exe');
  assert.equal(newer.notes, '修了很多');

  const same = await checkUpdate({
    config: configWithUpdateUrl('https://example.com/update.json'),
    currentVersion: '0.7.0-M5',
    fetchImpl: fetchReturning({ version: '0.7.0' }),
  });
  assert.equal(same.hasUpdate, false, '同一个主.次.修 不算更新（0.7.0-M5 vs 0.7.0）');

  const patch = await checkUpdate({
    config: configWithUpdateUrl('https://example.com/update.json'),
    currentVersion: '0.7.0-M5',
    fetchImpl: fetchReturning({ version: '0.7.1' }),
  });
  assert.equal(patch.hasUpdate, true, '修版本号变大就该提示');

  const broken = await checkUpdate({
    config: configWithUpdateUrl('https://example.com/update.json'),
    currentVersion: '0.7.0-M5',
    fetchImpl: fetchReturning({ nope: true }),
  });
  assert.match(broken.error ?? '', /version/);

  const httpError = await checkUpdate({
    config: configWithUpdateUrl('https://example.com/update.json'),
    currentVersion: '0.7.0-M5',
    fetchImpl: fetchReturning({}, 500),
  });
  assert.match(httpError.error ?? '', /HTTP 500/);

  const badUrl = await checkUpdate({ config: configWithUpdateUrl('ftp://x'), currentVersion: '0.7.0-M5' });
  assert.match(badUrl.error ?? '', /http/);
});
