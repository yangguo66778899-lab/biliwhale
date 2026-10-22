#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 命令：
 *   run --now [--dry] [--fixtures]   跑一轮（默认按配置决定真发/预演；--dry 强制预演）
 *   serve                            守护进程：作息 + 本地控制接口（托盘靠它）
 *   doctor                           体检：目录/配置/凭据/网络/模型/自启/托盘
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
import { createBackup, listBackup, restoreBackup } from './backup.ts';
import { checkUpdate } from './update.ts';
import { makeReplyDraft } from './orchestrator/replyDraft.ts';
import { readRuntime, readHeartbeat, heartbeatFresh } from './lifecycle/runtime.ts';
import { InstanceLock, isProcessAlive } from './lifecycle/lock.ts';
import { AutostartService } from './lifecycle/autostart.ts';
import type { Config } from './config/spec.ts';
import type { RunTrigger } from './shared/types.ts';

interface ParsedArgs {
  command: 'run' | 'doctor' | 'config' | 'serve' | 'backup' | 'restore' | 'update' | 'version' | 'help';
  sub?: string;
  now: boolean;
  dry: boolean;
  fixtures: boolean;
  mockModel: boolean;
  autostart: boolean;
  dataDir?: string;
  port?: number;
  trigger: RunTrigger;
  /** backup：带凭据 / 只备数据 / 指定输出文件 / 查看备份内容。 */
  withSecrets: boolean;
  dataOnly: boolean;
  outFile?: string;
  list: boolean;
  /** restore：从哪个 zip 恢复。 */
  from?: string;
  yes: boolean;
  /** 认不出的参数/命令（有就报错退出，别猜）。 */
  unknown: string[];
}

const VERSION = '0.7.1';

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'help',
    now: false,
    dry: false,
    fixtures: false,
    mockModel: false,
    autostart: false,
    trigger: 'manual',
    withSecrets: false,
    dataOnly: false,
    list: false,
    yes: false,
    unknown: [],
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
      case '--with-secrets':
        args.withSecrets = true;
        break;
      case '--data-only':
        args.dataOnly = true;
        break;
      case '--list':
        args.list = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--out':
        args.outFile = argv[i + 1];
        i += 1;
        break;
      case '--from':
        args.from = argv[i + 1];
        i += 1;
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        break;
      default:
        // 认不出的参数要报错：以前静默忽略，用户以为参数生效了（需求 §13 / 审计 §3.18）
        if (arg.startsWith('--')) {
          args.unknown.push(arg);
          break;
        }
        positional.push(arg);
    }
  }

  const [cmd, sub] = positional;
  if (cmd === 'run') args.command = 'run';
  else if (cmd === 'doctor') args.command = 'doctor';
  else if (cmd === 'serve') args.command = 'serve';
  else if (cmd === 'backup') {
    args.command = 'backup';
    args.sub = sub;
  } else if (cmd === 'restore') args.command = 'restore';
  else if (cmd === 'update') args.command = 'update';
  else if (cmd === 'version') args.command = 'version';
  else if (cmd === 'config') {
    args.command = 'config';
    args.sub = sub;
  } else if (cmd) {
    // 打错的命令不许当成 run：以前 `node src/cli.ts rn` 会真跑一整轮（审计 §3.18）
    args.command = 'help';
    args.unknown.push(cmd);
  }
  if (sub === 'list') args.list = true;
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

  ctx.logger.info('cli', `开跑：trigger=${args.trigger}${args.fixtures ? ' fixtures' : ''}（命令行一律预演；真发在面板/定时）`);
  // §3.17：命令行也要能真发（与面板/定时同一套 pipeline），--dry 才是「只预演」；
  // 真正是否发仍由 safety.dryRun / 各开关决定（在 runRound 里统一算）。
  const record = await runRound(deps, { trigger: args.trigger, dryRun: args.dry });

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
  out.push('  首次配置/运行必备：');
  for (const item of report.required) {
    const mark = item.ok ? '✓' : '✗';
    out.push(`  ${mark} ${item.label.padEnd(20, ' ')} ${item.detail}`);
  }
  out.push('', '  全部检查项：');
  for (const row of report.rows) {
    const mark = row.level === 'ok' ? '✓' : row.level === 'warn' ? '!' : '✗';
    out.push(`  ${mark} ${row.name.padEnd(12, ' ')} ${row.detail}`);
  }
  if (!report.ready) {
    const missing = report.required.filter((item) => !item.ok).map((item) => item.label);
    out.push('', `还差：${missing.join('、')}（面板里对应的页签可以补）`);
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

/* ---------------------------------------------------------------- backup / restore / update */

async function commandBackup(args: ParsedArgs): Promise<number> {
  // 查看备份内容不需要数据目录，也不该为了看一个 zip 去创建配置
  if (args.list) {
    const file = args.from ?? '';
    if (!file) {
      process.stderr.write('要查看备份内容，请给 --from <备份.zip>\n');
      return 1;
    }
    const info = listBackup(file);
    const lines = ['', `备份：${file}`, `  文件数：${info.entries.length}`];
    if (info.manifest) {
      lines.push(`  程序版本：${info.manifest.appVersion}（配置 v${info.manifest.configVersion ?? '?'}）`);
      lines.push(`  创建时间：${info.manifest.createdAt}`);
      lines.push(`  含凭据：${info.manifest.includesSecrets ? '是（恢复后不用重新登录）' : '否（恢复后需要重新登录）'}`);
    }
    for (const entry of info.entries.slice(0, 40)) lines.push(`    ${entry}`);
    if (info.entries.length > 40) lines.push(`    …（还有 ${info.entries.length - 40} 个）`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  const ctx = await bootstrap(args);

  const result = createBackup({
    paths: ctx.paths,
    appVersion: VERSION,
    includeDocs: !args.dataOnly,
    includeSecrets: args.withSecrets,
    ...(args.outFile ? { outFile: args.outFile } : {}),
  });

  const lines = [
    '',
    `备份完成：${result.file}`,
    `  ${result.entries.length} 个文件 · ${(result.bytes / 1024).toFixed(1)} KB`,
    `  含报告/日记：${args.dataOnly ? '否' : '是'}`,
    `  含凭据：${result.manifest.includesSecrets ? '是' : '否（恢复后需要重新登录）'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function commandRestore(args: ParsedArgs): Promise<number> {
  if (!args.from) {
    process.stderr.write('要恢复请给 --from <备份.zip>（并加 --yes 确认覆盖当前数据）\n');
    return 1;
  }
  const ctx = await bootstrap(args);
  if (!args.yes) {
    process.stderr.write(`恢复会用备份覆盖 ${ctx.paths.dataDir} 里的数据文件。\n确认无误请再加 --yes。\n`);
    return 1;
  }
  const result = restoreBackup({ paths: ctx.paths, file: args.from, confirm: true });
  const lines = ['', `已恢复 ${result.restored.length} 个文件到 ${ctx.paths.dataDir}`];
  for (const name of result.restored.slice(0, 20)) lines.push(`  ✓ ${name}`);
  if (result.restored.length > 20) lines.push(`  …（还有 ${result.restored.length - 20} 个）`);
  for (const name of result.skipped) lines.push(`  - 跳过 ${name}`);
  if (result.manifest && !result.manifest.includesSecrets) lines.push('提示：这份备份不含凭据，恢复后需要重新登录 B 站 / 重新填 key。');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function commandUpdate(args: ParsedArgs): Promise<number> {
  const ctx = await bootstrap(args);
  const result = await checkUpdate({ config: ctx.config.get(), currentVersion: VERSION, logger: ctx.logger });
  const lines = ['', `当前版本：${result.current}`];
  if (result.error) {
    lines.push(`  ${result.error}`);
    if (!result.configured) lines.push('  配置好地址后，面板「关于」页也有同样的按钮。');
  } else {
    lines.push(`  最新版本：${result.latest ?? '（没读出来）'}`);
    lines.push(`  ${result.hasUpdate ? '有新版' : '已是最新'}`);
    if (result.hasUpdate && result.url) lines.push(`  下载：${result.url}`);
    if (result.notes) lines.push(`  说明：${result.notes.split('\n')[0]}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}


function help(): string {  return [
    `BiliWhale ${VERSION} — 常驻托盘、只调用 DeepSeek 的 B 站「养鱼」程序内核`,
    '',
    '用法：',
    '  node src/cli.ts serve [--autostart]               守护进程：作息 + 本地控制接口（托盘靠它）',
    '  node src/cli.ts run --now [--dry] [--fixtures]   手动跑一轮（只读，不写任何远端内容）',
    '  node src/cli.ts doctor [--fixtures]              体检：目录/配置/凭据/网络/模型/自启/托盘',
    '  node src/cli.ts config show                      打印当前配置（不含密钥）',
    '  node src/cli.ts config validate                  校验 config.json',
    '  node src/cli.ts backup [--with-secrets] [--data-only] [--out <zip>]   备份数据（默认含报告/日记，不含凭据）',
    '  node src/cli.ts backup list --from <zip>         看看某个备份里有什么',
    '  node src/cli.ts restore --from <zip> --yes       从备份恢复（会覆盖当前数据）',
    '  node src/cli.ts update                           检查更新（需要先在设置里填地址）',
    '  node src/cli.ts version                          打印版本',
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
  if (args.unknown.length > 0) {
    process.stderr.write(`认不出的参数或命令：${args.unknown.join(' ')}\n跑 "node src/cli.ts --help" 看用法。\n`);
    return 2;
  }
  switch (args.command) {
    case 'run':
      return commandRun(args);
    case 'serve':
      return commandServe(args);
    case 'doctor':
      return commandDoctor(args);
    case 'config':
      return commandConfig(args);
    case 'backup':
      return commandBackup(args);
    case 'restore':
      return commandRestore(args);
    case 'update':
      return commandUpdate(args);
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
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
