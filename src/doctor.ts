/**
 * 体检（doctor）。
 *
 * 职责：把「这台机器上现在能不能正常跑」查清楚，返回结构化结果：
 *   Node/目录/配置/凭据/登录态/ffmpeg/磁盘/单实例锁/控制接口/心跳/自启/托盘/模型列表。
 *   CLI（`doctor`）与面板（`/api/doctor`）共用这一份，避免两边口径不一致。
 * 不做什么：不修任何东西、不写配置、不发写请求。
 */

import fs from 'node:fs';
import path from 'node:path';
import { InstanceLock, isProcessAlive } from './lifecycle/lock.ts';
import { heartbeatFresh, readHeartbeat, readRuntime } from './lifecycle/runtime.ts';
import { AutostartService } from './lifecycle/autostart.ts';
import type { AutostartStatus } from './lifecycle/autostart.ts';
import type { AppContext } from './bootstrap.ts';

export type DoctorLevel = 'ok' | 'warn' | 'bad';

export interface DoctorRow {
  name: string;
  level: DoctorLevel;
  detail: string;
  /** 给面板用的修复建议（可空）。 */
  hint?: string;
}

export interface DoctorReport {
  generatedAt: string;
  version: string;
  dataDir: string;
  rows: DoctorRow[];
  /** 有 bad 行时为 false。 */
  healthy: boolean;
}

export interface DoctorOptions {
  version: string;
  /** 夹具/模拟模式：凭据不强制。 */
  fixtures?: boolean;
  mockModel?: boolean;
  /** 跳过需要网络的检查（模型列表、nav）。 */
  offline?: boolean;
  /** 自启命令（默认托盘 exe）。 */
  autostartCommand?: string;
  trayExe?: string;
  ffmpegPath?: string;
}

export async function runDoctor(ctx: AppContext, opts: DoctorOptions): Promise<DoctorReport> {
  const cfg = ctx.config.get();
  const rows: DoctorRow[] = [];
  const push = (name: string, level: DoctorLevel, detail: string, hint?: string): void => {
    rows.push({ name, level, detail, ...(hint ? { hint } : {}) });
  };

  push('Node 版本', Number(process.versions.node.split('.')[0] ?? 0) >= 22 ? 'ok' : 'warn', process.version, '需要 Node 22.6+');
  push('数据目录', fs.existsSync(ctx.paths.dataDir) ? 'ok' : 'bad', ctx.paths.dataDir);
  push('日志目录', fs.existsSync(ctx.paths.logsDir) ? 'ok' : 'warn', ctx.paths.logsDir);
  push('配置文件', fs.existsSync(ctx.paths.config) ? 'ok' : 'warn', ctx.paths.config, '没有就用默认值启动');

  const keyOptional = ctx.fixtures || ctx.mockModel;
  if (ctx.secrets.hasApiKey()) push('DeepSeek key', 'ok', '已配置');
  else if (keyOptional) push('DeepSeek key', 'warn', '缺失（当前是夹具/模拟模式，不强制）', '设 BILIWHALE_API_KEY');
  else push('DeepSeek key', 'bad', '缺失', '设 BILIWHALE_API_KEY 或写 secrets.json');

  const hint = ctx.secrets.accountHint();
  push(
    'B 站登录',
    hint.hasCookie ? 'ok' : 'warn',
    hint.uname ? `${hint.uname}（${hint.mid}）` : hint.hasCookie ? hint.fingerprint : '未登录（只能读评论，字幕会拿不到）',
    hint.hasCookie ? undefined : '面板「账号」页可以扫码',
  );

  const ffmpeg = findFfmpeg(opts.ffmpegPath ?? cfg.media.ffmpegPath);
  push('ffmpeg', ffmpeg ? 'ok' : 'warn', ffmpeg ?? '没找到（不抽帧，可忽略）', '可选：装 ffmpeg 后用于抽帧');

  try {
    const stat = fs.statfsSync(ctx.paths.dataDir);
    const freeGb = (Number(stat.bavail) * Number(stat.bsize)) / 1024 / 1024 / 1024;
    push('磁盘剩余', freeGb > 1 ? 'ok' : 'warn', `${freeGb.toFixed(1)} GB`);
  } catch {
    push('磁盘剩余', 'warn', '查询失败');
  }

  // ---- 常驻相关 ----
  const lockFile = path.join(ctx.paths.localDir, 'instance.lock');
  const holder = fs.existsSync(lockFile) ? new InstanceLock(lockFile).read() : null;
  if (holder) {
    const alive = isProcessAlive(holder.pid);
    push(
      '单实例锁',
      'warn',
      alive ? `已有实例在跑（pid ${holder.pid}，端口 ${holder.port ?? '?'}）` : `陈旧锁（pid ${holder.pid} 已不在，下次启动会自动清）`,
    );
  } else {
    push('单实例锁', 'ok', '没有实例在跑');
  }

  const runtime = readRuntime(ctx.paths);
  push(
    '控制接口',
    runtime ? 'ok' : 'warn',
    runtime ? `${runtime.url}（pid ${runtime.pid}，token 在 runtime.json）` : '未运行（serve 起来后才能被托盘接管）',
    runtime ? undefined : '运行 npm run serve',
  );

  const beat = readHeartbeat(ctx.paths);
  push('心跳', heartbeatFresh(beat) ? 'ok' : 'warn', heartbeatFresh(beat) ? `正常（${beat?.at ?? ''}）` : beat ? `过期（${beat.at}）` : '还没有心跳（没跑过 serve）');

  let autostart: AutostartStatus = { enabled: false, mechanism: null, command: null };
  try {
    autostart = await new AutostartService({ ...(opts.autostartCommand ? { command: opts.autostartCommand } : { command: 'BiliWhaleTray.exe' }) }).status();
  } catch {
    /* 读不到就当没开 */
  }
  push(
    '开机自启',
    autostart.enabled ? 'ok' : 'warn',
    autostart.enabled ? `${autostart.mechanism === 'registry' ? '注册表 Run' : '启动文件夹'} · ${autostart.command ?? ''}` : autostart.warning ?? '未开启',
    autostart.enabled ? undefined : '托盘右键可以开',
  );

  if (opts.trayExe) {
    const exists = fs.existsSync(opts.trayExe);
    push('托盘程序', exists ? 'ok' : 'warn', exists ? opts.trayExe : `还没编译（npm run tray:build）：${opts.trayExe}`);
  }

  if (!opts.offline && !ctx.fixtures && hint.hasCookie) {
    const nav = await ctx.api.nav();
    push(
      'nav 登录态',
      nav.ok && nav.data.isLogin ? 'ok' : 'warn',
      nav.ok ? (nav.data.isLogin ? `已登录：${nav.data.uname}` : 'cookie 无效或已过期') : nav.error.message,
      nav.ok && nav.data.isLogin ? undefined : '面板「账号」页重新扫码',
    );
  }

  if (!opts.offline && !ctx.fixtures && ctx.secrets.hasApiKey()) {
    const models = await ctx.llm.listModels();
    push('模型列表', models.ok ? 'ok' : 'warn', models.ok ? `${models.data.length} 个：${models.data.slice(0, 6).join(', ')}` : models.error.message);
  }

  return {
    generatedAt: new Date().toISOString(),
    version: opts.version,
    dataDir: ctx.paths.dataDir,
    rows,
    healthy: rows.every((row) => row.level !== 'bad'),
  };
}

export function findFfmpeg(configured: string): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  const exts = (process.env.PATHEXT ?? '.EXE').split(';');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const lower = path.join(dir, `ffmpeg${ext.toLowerCase()}`);
      if (fs.existsSync(lower)) return lower;
      const upper = path.join(dir, `ffmpeg${ext.toUpperCase()}`);
      if (fs.existsSync(upper)) return upper;
    }
  }
  return null;
}
