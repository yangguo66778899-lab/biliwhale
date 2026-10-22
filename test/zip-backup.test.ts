import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { crc32, normalizeEntryName, readZipStore, zipArchive, zipStore, writeZipFile } from '../src/shared/zip.ts';
import { backupFileName, createBackup, listBackup, restoreBackup } from '../src/backup.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { tmpDir } from './helpers.ts';

/* ---------------- zip ---------------- */

test('zip：store 与 deflate 都能原样读回，CRC 对得上', () => {
  const big = '这是一段会被压缩的文本'.repeat(200);
  const buffer = zipStore([
    { name: 'a.json', data: '{"x":1}' },
    { name: 'nested/b.md', data: big },
  ]);
  const entries = readZipStore(buffer);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.name, 'a.json');
  assert.equal(entries[0]?.data.toString(), '{"x":1}');
  assert.equal(entries[0]?.method, 0, 'store 模式下 method 必须是 0');
  assert.equal(entries[1]?.data.toString(), big);
  assert.equal(entries[1]?.crc32, crc32(Buffer.from(big, 'utf8')));

  const compressed = zipArchive([{ name: 'nested/b.md', data: big }], { compress: true });
  assert.ok(compressed.length < buffer.length, '压缩后应该更小');
  const readBack = readZipStore(compressed)[0];
  assert.equal(readBack?.method, 8);
  assert.equal(readBack?.data.toString(), big);
});

test('zip：小文件压缩反而更大时自动退回 store', () => {
  const buffer = zipArchive([{ name: 'tiny.txt', data: 'hi' }], { compress: true });
  const entry = readZipStore(buffer)[0];
  assert.equal(entry?.method, 0);
  assert.equal(entry?.data.toString(), 'hi');
});

test('zip：坏数据/坏文件要直接报错，不猜', () => {
  assert.throws(() => readZipStore(Buffer.from('not a zip at all')), /EOCD/);

  const good = zipStore([{ name: 'a.txt', data: 'hello' }]);
  const broken = Buffer.from(good);
  broken[30 + 'a.txt'.length] = 0x00; // 改掉数据第一个字节 → CRC 应该对不上
  assert.throws(() => readZipStore(broken), /CRC/);
});

test('zip：条目名不许越界（zip-slip）', () => {
  assert.throws(() => normalizeEntryName('../etc/passwd'), /不允许/);
  assert.throws(() => normalizeEntryName('/abs/path'), /绝对路径/);
  assert.throws(() => normalizeEntryName('C:\\Windows\\x'), /绝对路径/);
  assert.throws(() => normalizeEntryName('a//b'), /不允许/);
  assert.equal(normalizeEntryName('a\\b\\c.txt'), 'a/b/c.txt');
});

/* ---------------- 备份 ---------------- */

function seedData(dir: string): void {
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'diaries', 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 2, app: { updateUrl: '' } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, paused: false }), 'utf8');
  fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify({ version: 1, videos: { BV1: { times: 3 } } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'quota.json'), JSON.stringify({ version: 1, log: [] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'reports', '2026-10-21.md'), '# 报告\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'diaries', 'public', '2026-10-21.md'), '# 日记\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'pending', 'replies.json'), JSON.stringify({ version: 1, items: [] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ version: 1, deepseek: { apiKey: 'sk-secret' } }), 'utf8');
}

test('备份：默认含数据与报告日记、不含凭据；文件名带时间', () => {
  const dir = tmpDir('backup');
  seedData(dir);
  const paths = resolvePaths({ dataDir: dir });
  const result = createBackup({ paths, appVersion: '0.7.0-M5', now: new Date('2026-10-22T12:00:00+08:00') });

  assert.ok(fs.existsSync(result.file));
  assert.match(path.basename(result.file), /^BiliWhale-backup-2026-10-22-12-00-00\.zip$/);
  assert.equal(backupFileName(new Date('2026-10-22T12:00:00+08:00')), 'BiliWhale-backup-2026-10-22-12-00-00.zip');

  const names = result.entries;
  for (const must of ['config.json', 'state.json', 'seen.json', 'quota.json', 'pending/replies.json', 'reports/2026-10-21.md']) {
    assert.ok(names.includes(must), `备份里应该有 ${must}（实际 ${names.join(', ')}）`);
  }
  assert.equal(names.includes('secrets.json'), false, '默认不备份凭据');
  assert.equal(result.manifest.includesSecrets, false);
  assert.equal(result.manifest.configVersion, 2);
});

test('备份：--with-secrets 时才带凭据；--data-only 时不含报告日记', () => {
  const dir = tmpDir('backup2');
  seedData(dir);
  const paths = resolvePaths({ dataDir: dir });

  const withSecrets = createBackup({ paths, appVersion: '0.7.0-M5', includeSecrets: true });
  const names = withSecrets.entries;
  assert.ok(names.includes('secrets.json'));
  assert.equal(withSecrets.manifest.includesSecrets, true);

  const dataOnly = createBackup({ paths, appVersion: '0.7.0-M5', includeDocs: false });
  assert.equal(dataOnly.entries.some((name) => name.startsWith('reports/')), false);
  assert.ok(dataOnly.entries.includes('config.json'));
});

test('备份：坏 JSON 不进备份（免得把坏数据带回去）', () => {
  const dir = tmpDir('backup3');
  seedData(dir);
  fs.writeFileSync(path.join(dir, 'feedback.json'), '{坏了', 'utf8');
  const paths = resolvePaths({ dataDir: dir });
  const result = createBackup({ paths, appVersion: '0.7.0-M5' });
  assert.equal(result.entries.includes('feedback.json'), false);
});

test('备份：同秒连做两次不覆盖', () => {
  const dir = tmpDir('backup4');
  seedData(dir);
  const paths = resolvePaths({ dataDir: dir });
  const now = new Date('2026-10-22T12:00:00+08:00');
  const first = createBackup({ paths, appVersion: '0.7.0-M5', now });
  const second = createBackup({ paths, appVersion: '0.7.0-M5', now });
  assert.notEqual(first.file, second.file);
  assert.ok(fs.existsSync(first.file) && fs.existsSync(second.file));
});

test('恢复：需要显式确认；只恢复白名单内容；坏 JSON 跳过', () => {
  const source = tmpDir('backup-src');
  seedData(source);
  const sourcePaths = resolvePaths({ dataDir: source });
  const backupFile = createBackup({ paths: sourcePaths, appVersion: '0.7.0-M5' }).file;

  // 目标目录：先塞一份不一样的数据
  const target = tmpDir('backup-dst');
  seedData(target);
  fs.writeFileSync(path.join(target, 'seen.json'), JSON.stringify({ version: 1, videos: {} }), 'utf8');
  const targetPaths = resolvePaths({ dataDir: target });

  assert.throws(() => restoreBackup({ paths: targetPaths, file: backupFile, confirm: false }), /确认/);

  const restored = restoreBackup({ paths: targetPaths, file: backupFile, confirm: true });
  assert.ok(restored.restored.includes('seen.json'));
  const seen = JSON.parse(fs.readFileSync(path.join(target, 'seen.json'), 'utf8')) as { videos: Record<string, unknown> };
  assert.ok(seen.videos.BV1, '恢复后应该拿到备份里的数据');

  // 白名单外的东西不许进来
  const evil = path.join(target, 'evil.zip');
  writeZipFile(evil, [
    { name: 'manifest.json', data: JSON.stringify({ app: 'BiliWhale', kind: 'backup', appVersion: 'x', createdAt: '', configVersion: 2, entries: [], includesSecrets: false }) },
    { name: 'src/cli.ts', data: '// 恶意' },
    { name: 'config.json', data: '{"version":2}' },
  ]);
  const evilResult = restoreBackup({ paths: targetPaths, file: evil, confirm: true });
  assert.equal(evilResult.restored.includes('src/cli.ts'), false);
  assert.ok(evilResult.skipped.some((name) => name.includes('src/cli.ts')));
});

test('恢复：能列出备份内容（CLI backup list 用）', () => {
  const dir = tmpDir('backup-list');
  seedData(dir);
  const paths = resolvePaths({ dataDir: dir });
  const file = createBackup({ paths, appVersion: '0.7.0-M5' }).file;
  const info = listBackup(file);
  assert.equal(info.manifest?.appVersion, '0.7.0-M5');
  assert.ok(info.entries.includes('config.json'));
  assert.equal(info.entries.includes('manifest.json'), false, 'manifest 单独返回');
});
