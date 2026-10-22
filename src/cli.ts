#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 命令：
 *   run --now [--dry] [--fixtures]   跑一轮（M0/M1 只读，不写任何远端内容）
 *   serve                            守护进程：作息 + 本地控制接口（托盘靠它）
 *   doctor                           体检：目录/配置/凭据/网络/模型/自启/ffmpeg
 *   config show|validate             看配置 / 校验配置
 *
 * 不做什么：不实现业务逻辑（都在 orchestrator/agent/bili/scheduler 里）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from './shared/logger.ts';
import { humanError } from './shared/errors.ts';
import { normalizeCookie } from './config/secrets.ts';
import { resolvePaths } from './state/paths.ts';
import { bootstrap as buildContext } from './bootstrap.ts';
import type { AppContext } from './bootstrap.ts';
import { ensurePromptFiles } from './agent/prompts.ts';
import { runRound } from './orchestrator/round.ts';
import type { RoundDeps } from './orchestrator/round.ts';
import { startDaemon, resolveTrayCommand, resolveTrayExe } from './daemon/index.ts';
import { runDoctor } from './doctor.ts';
import { makeReplyDraft } from './orchestrator/replyDraft.ts';
import { readRuntime, readHeartbeat, heartbeatFresh } from './lifecycle/runtime.ts';
import { InstanceLock, isProcessAlive } from './lifecycle/lock.ts';
import { AutostartService } from './lifecycle/autostart.ts';
import type { Config } from './config/spec.ts';
import type { RunTrigger } from './shared/types.ts';

interface ParsedArgs {
  command: 'run' | 'doctor' | 'config' | 'serve' | 'help';
  sub?: string;
  now: boolean;
  dry: boolean;
  fixtures: boolean;
  mockModel: boolean;
  autostart: boolean;
  dataDir?: string;
  port?: number;
  trigger: RunTrigger;
}

const VERSION = '0.4.4-M3';

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'help',
    now: false,
    dry: false,
    fixtures: false,
    mockModel: false,
    autostart: false,
    trigger: 'manual',
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '--now':
        args.now = true;
        break;
      case '--dry':
      case '--dry-run':
        args.dry = true;
        break;
      case '--fixtures':
        args.fixtures = true;
        break;
      case '--mock-model':
        args.mockModel = true;
        break;
      case '--autostart':
        args.autostart = true;
        break;
      case '--data-dir':
        args.dataDir = argv[i + 1];
        i += 1;
        break;
      case '--port':
        args.port = Number(argv[i + 1]);
        i += 1;
        break;
      case '--trigger':
        args.trigger = argv[i + 1] === 'schedule' ? 'schedule' : 'manual';
        i += 1;
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        break;
      default:
        if (arg.startsWith('--')) break;
        positional.push(arg);
    }
  }

  const [cmd, sub] = positional;
  if (cmd === 'run') args.command = 'run';
  else if (cmd === 'doctor') args.command = 'doctor';
  else if (cmd === 'serve') args.command = 'serve';
  else if (cmd === 'config') {
    args.command = 'config';
    args.sub = sub;
  } else if (cmd) args.command = 'run';
  if (sub && args.command === 'config') args.sub = sub;
  return args;
}

type Context = AppContext;

async function bootstrap(args: ParsedArgs): Promise<Context> {
  return buildContext({
    ...(args.dataDir ? { dataDir: args.dataDir } : {}),
    fixtures: args.fixtures,
    mockModel: args.mockModel,
    mirrorToConsole: true,
  });
}

/* ---------------------------------------------------------------- run */

async function commandRun(args: ParsedArgs): Promise<number> {
  const started = Date.now();
  // bootstrap 里已经做过模型发现（换 key 会重新发现），这里不再重复
  const ctx = await bootstrap(args);

  const deps: RoundDeps = {
    paths: ctx.paths,
    config: ctx.config,
    secrets: ctx.secrets,
    logger: ctx.logger,
    api: ctx.api,
    llm: ctx.llm,
    state: ctx.state,
    seen: ctx.seen,
    quota: ctx.quota,
    feedback: ctx.feedback,
    runs: ctx.runs,
    writer: ctx.writer,
    pending: ctx.pending,
    replied: ctx.replied,
    pendingDraft: makeReplyDraft(ctx.llm, ctx.logger),
    configuredModel: ctx.configuredModel,
    ...(args.fixtures
      ? {
          noCredentialsNeeded: true,
          modeNote: '夹具模式：用离线夹具代替真实 B 站与模型，不检查凭据、不联网',
        }
      : {}),
    ...(args.mockModel && !args.fixtures
      ? {
          noCredentialsNeeded: true,
          modeNote: '模拟模型模式：真实 B 站数据 + 占位模型输出（只验证链路，不代表模型质量）',
        }
      : {}),
  };

  ctx.logger.info('cli', `开跑：trigger=${args.trigger}${args.fixtures ? ' fixtures' : ''}（M0 只读）`);
  const record = await runRound(deps, { trigger: args.trigger, dryRun: true });

  const seconds = Math.round((Date.now() - started) / 1000);
  const lines = [
    '',
    `一轮结束：${record.status}（${seconds}s，run ${record.id}）`,
    `  候选 ${record.counts.candidates} → 初筛 ${record.counts.screened} → 深读 ${record.counts.deepRead} → 挑中 ${record.counts.selected} → 分享 ${record.counts.shared}`,
    `  token：输入 ${record.model.promptTokens} / 输出 ${record.model.completionTokens}（缓存命中 ${record.model.cachedTokens}）`,
    `  数据目录：${ctx.paths.dataDir}`,
    `  报告：${path.join(ctx.paths.reportsDir)}`,
    `  日记：${path.join(ctx.paths.dataDir, 'diaries')}`,
  ];
  if (record.errors.length > 0) {
    lines.push('  问题：');
    for (const error of record.errors) lines.push(`    - ${error}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return record.status === 'failed' ? 1 : 0;
}

/* ---------------------------------------------------------------- doctor */

async function commandDoctor(args: ParsedArgs): Promise<number> {
  const ctx = await bootstrap(args);
  const cfg = ctx.config.get();
  const report = await runDoctor(ctx, {
    version: VERSION,
    fixtures: ctx.fixtures,
    mockModel: ctx.mockModel,
    offline: args.fixtures,
    autostartCommand: resolveTrayCommand(),
    trayExe: resolveTrayExe(),
  });

  const out = ['', `BiliWhale ${VERSION} · 体检`, `配置模型：${cfg.llm.model}${cfg.llm.modelAuto ? '（自动发现开）' : ''}`, ''];
  for (const row of report.rows) {
    const mark = row.level === 'ok' ? '✓' : row.level === 'warn' ? '!' : '✗';
    out.push(`  ${mark} ${row.name.padEnd(12, ' ')} ${row.detail}`);
  }
  out.push('', report.healthy ? '没有硬伤（! 是可降级项）。' : '有硬性项没过（✗），先修它。', '');
  process.stdout.write(out.join('\n'));
  return report.healthy ? 0 : 1;
}


async function commandServe(args: ParsedArgs): Promise<number> {
  const started = await startDaemon({
    ...(args.dataDir ? { dataDir: args.dataDir } : {}),
    ...(args.port !== undefined && Number.isFinite(args.port) ? { port: args.port } : {}),
    fixtures: args.fixtures,
    mockModel: args.mockModel,
    version: VERSION,
  });

  if (started.kind === 'already-running') {
    const paths = resolvePaths(args.dataDir ? { dataDir: args.dataDir } : {});
    const runtime = readRuntime(paths);
    process.stdout.write(
      [
        `已有实例在跑，不再启动第二个（${started.message}）。`,
        runtime ? `面板：${runtime.url}/?token=${runtime.token}` : '（没读到 runtime.json，可能正在启动）',
        args.autostart ? '（本次是开机自启调用，已忽略）' : '',
        '',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    );
    return 3;
  }

  process.stdout.write(
    [
      `BiliWhale ${VERSION} 守护进程已启动`,
      `  面板：${started.url}/?token=${started.token}`,
      `  控制接口：${started.url}`,
      args.autostart ? '  启动方式：开机自启（不弹窗）' : '',
      '  Ctrl+C 退出',
      '',
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );

  // 保持进程存活；信号由守护进程内部处理（优雅收尾后自行退出）
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  return 0;
}

async function commandConfig(args: ParsedArgs): Promise<number> {
  const ctx = await bootstrap(args);
  if (args.sub === 'show' || args.sub === undefined) {
    const exported = ctx.config.exportForUser();
    process.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
    return 0;
  }
  if (args.sub === 'validate') {
    const raw = JSON.parse(fs.readFileSync(ctx.paths.config, 'utf8')) as unknown;
    const result = ctx.config.validateOnly(raw);
    for (const issue of result.issues) process.stdout.write(`${issue.severity}: ${issue.path || '(根)'}：${issue.message}\n`);
    return result.ok ? 0 : 2;
  }
  process.stdout.write('用法：config show | config validate\n');
  return 2;
}

function findFfmpeg(configured: string): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  const exts = (process.env.PATHEXT ?? '.EXE').split(';');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `ffmpeg${ext.toLowerCase()}`);
      if (fs.existsSync(candidate)) return candidate;
      const upper = path.join(dir, `ffmpeg${ext.toUpperCase()}`);
      if (fs.existsSync(upper)) return upper;
    }
  }
  return null;
}

function help(): string {
  return [
    `BiliWhale ${VERSION} — 常驻托盘、只调用 DeepSeek 的 B 站「养鱼」程序内核`,
    '',
    '用法：',
    '  node src/cli.ts serve [--autostart]               守护进程：作息 + 本地控制接口（托盘靠它）',
    '  node src/cli.ts run --now [--dry] [--fixtures]   手动跑一轮（只读，不写任何远端内容）',
    '  node src/cli.ts doctor [--fixtures]              体检：目录/配置/凭据/网络/模型/自启/托盘/ffmpeg',
    '  node src/cli.ts config show                      打印当前配置（不含密钥）',
    '  node src/cli.ts config validate                  校验 config.json',
    '',
    '参数：',
    '  --data-dir <path>   覆盖数据目录（默认 %APPDATA%\\BiliWhale）',
    '  --port <n>          覆盖控制接口端口（默认 8787，占用则自动 +1）',
    '  --trigger manual|schedule   记录本轮来源（默认 manual）',
    '  --fixtures          离线模式：用夹具跑通整轮，不碰真实 B 站/模型',
    '  --mock-model        真实 B 站 + 占位模型（只验证链路）',
    '',
    '凭据：环境变量 BILIWHALE_API_KEY / BILIWHALE_COOKIE，或写入 <data>/secrets.json',
    `数据目录：${resolvePaths().dataDir}`,
    `系统：${os.type()} ${os.release()} · Node ${process.version}`,
  ].join('\n');
}

/* ---------------------------------------------------------------- main */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'run':
      return commandRun(args);
    case 'serve':
      return commandServe(args);
    case 'doctor':
      return commandDoctor(args);
    case 'config':
      return commandConfig(args);
    default:
      process.stdout.write(`${help()}\n`);
      return 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`出错了：${humanError(err)}\n`);
    if (process.env.BILIWHALE_DEBUG === '1' && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  });

/* 让「粘贴 cookie」的校验也能被 CLI 之外复用（面板 M2 会用同一份）。 */
export { normalizeCookie };
