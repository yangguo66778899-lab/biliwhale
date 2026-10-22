/**
 * 数据目录解析。
 *
 * 职责：把「持久数据」与「可清理数据」落到 Windows 标准位置：
 *   `%APPDATA%\BiliWhale`（配置/凭据/账本/报告/日记）与 `%LOCALAPPDATA%\BiliWhale`（日志/缓存/心跳）。
 * 不做什么：不读写文件内容；不做旧数据迁移（全新开始，不读任何旧目录）。
 */

import os from 'node:os';
import path from 'node:path';
import { ensureDir } from '../shared/atomic.ts';

export const APP_DIR_NAME = 'BiliWhale';

export interface Paths {
  dataDir: string;
  localDir: string;
  config: string;
  secrets: string;
  state: string;
  quota: string;
  seen: string;
  feedback: string;
  events: string;
  runsDir: string;
  reportsDir: string;
  archiveDir: string;
  diariesPublicDir: string;
  diariesPrivateDir: string;
  promptsDir: string;
  logsDir: string;
  cacheDir: string;
  backupDir: string;
  chatDir: string;
  pendingDir: string;
  heartbeat: string;
  runtime: string;
  notifyLog: string;
  fixturesDir: string;
}

function appData(): string {
  return process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
}

function localAppData(): string {
  return process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
}

/** 解析全部路径；`dataDir` 显式给了就用它（`--data-dir`，开发/高级用户）。 */
export function resolvePaths(overrides: { dataDir?: string; localDir?: string } = {}): Paths {
  const dataDir = overrides.dataDir ? path.resolve(overrides.dataDir) : path.join(appData(), APP_DIR_NAME);
  const localDir = overrides.localDir
    ? path.resolve(overrides.localDir)
    : overrides.dataDir
      ? path.join(path.resolve(overrides.dataDir), 'local')
      : path.join(localAppData(), APP_DIR_NAME);

  const runsDir = path.join(dataDir, 'runs');
  const reportsDir = path.join(dataDir, 'reports');
  const archiveDir = path.join(dataDir, 'archive');
  const diariesPublicDir = path.join(dataDir, 'diaries', 'public');
  const diariesPrivateDir = path.join(dataDir, 'diaries', 'private');
  const promptsDir = path.join(dataDir, 'prompts');
  const logsDir = path.join(localDir, 'logs');
  const cacheDir = path.join(localDir, 'cache');

  return {
    dataDir,
    localDir,
    config: path.join(dataDir, 'config.json'),
    secrets: path.join(dataDir, 'secrets.json'),
    state: path.join(dataDir, 'state.json'),
    quota: path.join(dataDir, 'quota.json'),
    seen: path.join(dataDir, 'seen.json'),
    feedback: path.join(dataDir, 'feedback.json'),
    events: path.join(dataDir, 'events.jsonl'),
    runsDir,
    reportsDir,
    archiveDir,
    diariesPublicDir,
    diariesPrivateDir,
    promptsDir,
    logsDir,
    cacheDir,
    backupDir: path.join(localDir, 'backup'),
    chatDir: path.join(dataDir, 'chat'),
    pendingDir: path.join(dataDir, 'pending'),
    heartbeat: path.join(localDir, 'heartbeat.json'),
    runtime: path.join(localDir, 'runtime.json'),
    notifyLog: path.join(logsDir, 'notify.log'),
    fixturesDir: path.join(process.cwd(), 'fixtures'),
  };
}

/** 首次启动创建目录骨架；返回创建了哪些（给日志用）。 */
export function ensureLayout(paths: Paths): string[] {
  const dirs = [
    paths.dataDir,
    paths.localDir,
    paths.runsDir,
    paths.reportsDir,
    paths.archiveDir,
    paths.diariesPublicDir,
    paths.diariesPrivateDir,
    paths.promptsDir,
    paths.logsDir,
    paths.cacheDir,
    paths.backupDir,
    paths.chatDir,
    paths.pendingDir,
  ];
  const created: string[] = [];
  for (const dir of dirs) {
    ensureDir(dir);
    created.push(dir);
  }
  return created;
}
