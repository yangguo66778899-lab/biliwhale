/**
 * 体检（doctor）。
 *
 * 职责：把「这台机器上现在能不能正常跑」查清楚，返回结构化结果：
 *   Node/目录/配置/凭据/登录态/磁盘/单实例锁/控制接口/心跳/自启/托盘/模型列表。
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
import { resolveOwner } from './account/owner.ts';

export type DoctorLevel = 'ok' | 'warn' | 'bad';

export interface DoctorRow {
  name: string;
  level: DoctorLevel;
  detail: string;
  /** 给面板用的修复建议（可空）。 */
  hint?: string;
}

export interface DoctorRequiredItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** 缺了去哪修（面板页签）。 */
  tab?: 'settings' | 'account' | 'about';
  hint?: string;
}

export interface DoctorReport {
  generatedAt: string;
  version: string;
  dataDir: string;
  rows: DoctorRow[];
  /** 首次配置/运行所需：一项一项列清楚「有 / 没有」。 */
  required: DoctorRequiredItem[];
  /** 必需项全有（≠ 一切正常，但至少能跑）。 */
  ready: boolean;
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
    'B 站登录（鲸鲸自己）',
    hint.hasCookie ? 'ok' : 'warn',
    hint.uname ? `${hint.uname}（${hint.mid}）` : hint.hasCookie ? hint.fingerprint : '未登录（只能读评论，字幕会拿不到）',
    hint.hasCookie ? undefined : '面板「账号」页可以扫码',
  );

  // 主人：@/私信/聊天都发给它，必须是**另一个**号。缺了就点明，不静默降级。
  const owner = resolveOwner(cfg, ctx.secrets.selfMid());
  if (owner.ok && owner.name) {
    push('主人（你）', 'ok', `${owner.name}（${owner.mid}）`);
  } else if (owner.ok) {
    push('主人（你）', 'warn', `UID ${owner.mid}（昵称没填：评论里 @ 不到人）`, '面板「账号」页可按 UID 自动取昵称');
  } else {
    push('主人（你）', 'bad', owner.problem ?? '主人没配好', '面板「账号」页 → 主人 UID（必须是另一个号，不能填鲸鲸的 UID）');
  }


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

  // 首次配置 / 运行所需的清单：一项一项列清楚「有 / 没有」，缺哪个、去哪儿补。
  const required: DoctorRequiredItem[] = [
    {
      key: 'node',
      label: 'Node 22.6+',
      ok: Number(process.versions.node.split('.')[0] ?? 0) >= 22,
      detail: process.version,
    },
    {
      key: 'datadir',
      label: '数据目录可写',
      ok: fs.existsSync(ctx.paths.dataDir),
      detail: ctx.paths.dataDir,
    },
    {
      key: 'apikey',
      label: 'DeepSeek key',
      ok: ctx.secrets.hasApiKey(),
      detail: ctx.secrets.hasApiKey() ? '已配置' : '没有它跑不了任何一轮（预演也要真调模型）',
      tab: 'settings',
    },
    {
      key: 'login',
      label: 'B 站登录（鲸鲸自己）',
      ok: hint.hasCookie,
      detail: hint.uname ? `${hint.uname}（${hint.mid}）` : '未登录：字幕拿不到、写不了',
      tab: 'account',
    },
    {
      key: 'owner',
      label: '主人 UID（另一个号）',
      ok: owner.ok && owner.mid > 0,
      detail: owner.ok ? `${owner.name || '昵称待填'}（${owner.mid}）` : owner.problem ?? '没填',
      tab: 'account',
    },
    {
      key: 'ownerName',
      label: '主人昵称（评论 @ 用）',
      ok: owner.ok && owner.name.length > 0,
      detail: owner.name || '没填：评论里 @ 不到人',
      tab: 'account',
    },
    {
      key: 'disk',
      label: '磁盘剩余 ≥1 GB',
      ok: rows.find((row) => row.name === '磁盘剩余')?.level !== 'warn',
      detail: rows.find((row) => row.name === '磁盘剩余')?.detail ?? '未知',
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    version: opts.version,
    dataDir: ctx.paths.dataDir,
    rows,
    required,
    ready: required.every((item) => item.ok),
    healthy: rows.every((row) => row.level !== 'bad'),
  };
}

