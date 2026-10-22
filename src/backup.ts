/**
 * 备份与恢复（M5）。
 *
 * 为什么要有：升级前要先备份（§7.14），出问题要能回滚；用户也可能想把数据拷到另一台机器。
 *
 * 备份内容（白名单，别的一律不进）：
 *   - 必须：config.json、state.json、quota.json、seen.json、feedback.json、replied.json、pending/replies.json
 *   - 可选：secrets.json（默认**不**备份——凭据跟着备份到处跑不安全，需要时用 `--with-secrets`）
 *   - 可选（默认开）：reports/、diaries/、archive/、runs/、chat/owner.jsonl
 *
 * 恢复：只认白名单里的路径（杜绝 zip-slip 与「顺手改程序」），JSON 必须先 parse 通过，
 * 逐个原子写；`confirm` 必须为 true（CLI 要 `--yes`，面板要二次确认）。
 * 不做什么：不恢复程序文件（那是升级的事）、不自动回滚（回滚靠「旧安装包 + 这份备份」）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Paths } from './state/paths.ts';
import { readZipFile, writeZipFile } from './shared/zip.ts';
import { writeJsonAtomic } from './shared/atomic.ts';
import { localIso } from './shared/time.ts';

export interface BackupManifest {
  app: 'BiliWhale';
  kind: 'backup';
  appVersion: string;
  createdAt: string;
  configVersion: number | null;
  entries: string[];
  /** 备份里有没有凭据（恢复后是否需要重新登录，看这个）。 */
  includesSecrets: boolean;
}

export interface BackupOptions {
  paths: Paths;
  appVersion: string;
  /** 默认 true：带上报告/日记/归档/运行记录/聊天。 */
  includeDocs?: boolean;
  /** 默认 false：凭据不进备份。 */
  includeSecrets?: boolean;
  /** 默认 <data>/backup/BiliWhale-backup-<时间>.zip。 */
  outFile?: string;
  now?: Date;
}

export interface BackupResult {
  file: string;
  bytes: number;
  entries: string[];
  manifest: BackupManifest;
}

/** 必须备份的数据文件（相对 dataDir）。 */
const CORE_FILES = [
  'config.json',
  'state.json',
  'quota.json',
  'seen.json',
  'feedback.json',
  'replied.json',
  path.join('pending', 'replies.json'),
];

/** 可选目录（相对 dataDir）：备份/恢复都按前缀白名单。 */
const DOC_DIRS = ['reports', 'diaries', 'archive', 'runs'];
const DOC_FILES = [path.join('chat', 'owner.jsonl')];

const SECRETS_FILE = 'secrets.json';

export function backupFileName(now: Date = new Date()): string {
  const stamp = localIso(now).slice(0, 19).replace(/[:T]/g, '-');
  return `BiliWhale-backup-${stamp}.zip`;
}

/** 生成一个备份 zip。 */
export function createBackup(opts: BackupOptions): BackupResult {
  const now = opts.now ?? new Date();
  const includeDocs = opts.includeDocs !== false;
  const includeSecrets = opts.includeSecrets === true;
  const dataDir = opts.paths.dataDir;

  const entries: Array<{ name: string; data: Buffer; mtime?: Date }> = [];
  const listed: string[] = [];

  const addFile = (relative: string): void => {
    const full = path.join(dataDir, relative);
    let data: Buffer;
    try {
      data = fs.readFileSync(full);
    } catch {
      return;
    }
    // JSON 先 parse 一次：坏文件不进备份（否则恢复时把坏数据带回去）
    if (relative.endsWith('.json')) {
      try {
        JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
    }
    const name = relative.split(path.sep).join('/');
    entries.push({ name, data, mtime: fs.statSync(full).mtime });
    listed.push(name);
  };

  for (const file of CORE_FILES) addFile(file);
  if (includeSecrets) addFile(SECRETS_FILE);
  if (includeDocs) {
    for (const dir of DOC_DIRS) {
      const full = path.join(dataDir, dir);
      if (!fs.existsSync(full)) continue;
      for (const name of walkFiles(full)) {
        const relative = path.relative(dataDir, name);
        addFile(relative);
      }
    }
    for (const file of DOC_FILES) addFile(file);
  }

  const configVersion = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as { version?: unknown };
      return typeof parsed.version === 'number' ? parsed.version : null;
    } catch {
      return null;
    }
  })();

  const manifest: BackupManifest = {
    app: 'BiliWhale',
    kind: 'backup',
    appVersion: opts.appVersion,
    createdAt: localIso(now),
    configVersion,
    entries: listed,
    includesSecrets: includeSecrets && listed.includes(SECRETS_FILE),
  };

  entries.unshift({
    name: 'manifest.json',
    data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    mtime: now,
  });

  const outFile = opts.outFile ?? uniquePath(path.join(opts.paths.backupDir, backupFileName(now)));
  const written = writeZipFile(outFile, entries);
  return { file: written.file, bytes: written.bytes, entries: listed, manifest };
}

/** 同一秒连做两次备份时不覆盖前一份（加上 -2、-3…）。 */
function uniquePath(base: string): string {
  if (!fs.existsSync(base)) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

export interface RestoreOptions {
  paths: Paths;
  file: string;
  /** 必须显式给 true，防止误触。 */
  confirm: boolean;
  now?: Date;
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
  manifest: BackupManifest | null;
}

/** 从备份恢复数据文件（不碰程序、不碰 dataDir 之外）。 */
export function restoreBackup(opts: RestoreOptions): RestoreResult {
  if (opts.confirm !== true) throw new Error('恢复会覆盖当前数据，必须显式确认（CLI: --yes）');
  const entries = readZipFile(opts.file);
  const result: RestoreResult = { restored: [], skipped: [], manifest: null };

  for (const entry of entries) {
    if (entry.name === 'manifest.json') {
      try {
        result.manifest = JSON.parse(entry.data.toString('utf8')) as BackupManifest;
      } catch {
        result.skipped.push('manifest.json（解析失败）');
      }
      continue;
    }
    if (!isAllowedEntry(entry.name)) {
      result.skipped.push(`${entry.name}（不在白名单里）`);
      continue;
    }

    const target = path.join(opts.paths.dataDir, ...entry.name.split('/'));
    const resolved = path.resolve(target);
    const root = path.resolve(opts.paths.dataDir);
    if (!resolved.startsWith(root + path.sep)) {
      result.skipped.push(`${entry.name}（越界）`);
      continue;
    }

    if (entry.name.endsWith('.json')) {
      try {
        JSON.parse(entry.data.toString('utf8'));
      } catch {
        result.skipped.push(`${entry.name}（不是合法 JSON）`);
        continue;
      }
    }

    if (entry.name.endsWith('.json') && CORE_FILES.includes(entry.name.split('/').join(path.sep))) {
      // 账本/配置用原子写（保留 .bak，恢复坏了还能退回去）
      writeJsonAtomic(resolved, JSON.parse(entry.data.toString('utf8')));
    } else {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const tmp = `${resolved}.tmp`;
      fs.writeFileSync(tmp, entry.data);
      fs.renameSync(tmp, resolved);
    }
    result.restored.push(entry.name);
  }

  return result;
}

/** 列出备份里有什么（CLI `backup --list` 与测试用）。 */
export function listBackup(file: string): { manifest: BackupManifest | null; entries: string[] } {
  const entries = readZipFile(file);
  let manifest: BackupManifest | null = null;
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'manifest.json') {
      try {
        manifest = JSON.parse(entry.data.toString('utf8')) as BackupManifest;
      } catch {
        manifest = null;
      }
      continue;
    }
    names.push(entry.name);
  }
  return { manifest, entries: names };
}

function isAllowedEntry(name: string): boolean {
  const normalized = name.split('/').join(path.sep);
  if (CORE_FILES.includes(normalized)) return true;
  if (normalized === SECRETS_FILE) return true;
  if (DOC_FILES.includes(normalized)) return true;
  for (const dir of DOC_DIRS) {
    if (normalized.startsWith(`${dir}${path.sep}`) && normalized.endsWith('.md')) return true;
    if (normalized.startsWith(`${dir}${path.sep}`) && normalized.endsWith('.json')) return true;
  }
  return false;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) out.push(full);
  }
  return out;
}
