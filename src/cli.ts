#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 命令：
 *   run --now [--dry] [--fixtures]   跑一轮（M0 永远只读）
 *   doctor                           体检：目录/配置/凭据/网络/模型/ffmpeg
 *   config show                      打印当前配置（不含密钥）
 *
 * 不做什么：不实现业务逻辑（都在 orchestrator/agent/bili 里），不做托盘与面板（M1/M2）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from './shared/logger.ts';
import { humanError } from './shared/errors.ts';
import { localIso } from './shared/time.ts';
import { ConfigService } from './config/service.ts';
import { SecretsService, normalizeCookie } from './config/secrets.ts';
import { ensureLayout, resolvePaths } from './state/paths.ts';
import type { Paths } from './state/paths.ts';
import { AppStateStore } from './state/appState.ts';
import { FeedbackLedger, QuotaLedger, SeenLedger } from './state/ledgers.ts';
import { RunStore } from './state/runs.ts';
import { createBili } from './bili/api.ts';
import type { BiliApi } from './bili/api.ts';
import { LlmClient } from './llm/client.ts';
import { discoverModel, keyFingerprint } from './llm/discovery.ts';
import { ensurePromptFiles, loadPromptAssets } from './agent/prompts.ts';
import { runRound } from './orchestrator/round.ts';
import type { RoundDeps } from './orchestrator/round.ts';
import type { Config } from './config/spec.ts';
import type { RunTrigger } from './shared/types.ts';

interface ParsedArgs {
  command: 'run' | 'doctor' | 'config' | 'help';
  sub?: string;
  now: boolean;
  dry: boolean;
  fixtures: boolean;
  mockModel: boolean;
  dataDir?: string;
  trigger: RunTrigger;
}

const VERSION = '0.1.0-M0';

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { command: 'help', now: false, dry: false, fixtures: false, mockModel: false, trigger: 'manual' };
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
      case '--data-dir':
        args.dataDir = argv[i + 1];
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
  else if (cmd === 'config') {
    args.command = 'config';
    args.sub = sub;
  } else if (cmd) args.command = 'run';
  if (sub && args.command === 'config') args.sub = sub;
  return args;
}

interface Context {
  paths: Paths;
  logger: Logger;
  config: ConfigService;
  secrets: SecretsService;
  state: AppStateStore;
  seen: SeenLedger;
  quota: QuotaLedger;
  feedback: FeedbackLedger;
  runs: RunStore;
  api: BiliApi;
  llm: LlmClient;
  configuredModel: string;
  cleanup: () => void;
}

async function bootstrap(args: ParsedArgs): Promise<Context> {
  const paths = resolvePaths(args.dataDir ? { dataDir: args.dataDir } : {});
  ensureLayout(paths);

  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, mirrorToConsole: true, level: 'info' });
  const config = new ConfigService(paths.dataDir, logger);
  const loaded = config.load();
  if (loaded.origin !== 'file') {
    logger.info('cli', `配置来源：${loaded.origin}`);
  }
  const current: Config = config.get();
  logger.setLevel(current.logging.level);

  const secrets = new SecretsService(paths.dataDir, logger);
  ensurePromptFiles(paths, logger);

  const state = new AppStateStore(paths.state, logger);
  const seen = SeenLedger.open(paths.seen, logger);
  const quota = QuotaLedger.open(paths.quota, logger);
  const feedback = FeedbackLedger.open(paths.feedback, logger);
  const runs = new RunStore(paths.runsDir, logger);
  const recovered = runs.recoverInterrupted();
  if (recovered.length > 0) logger.warn('cli', `恢复了 ${recovered.length} 条上次未完成的运行记录`);

  // 撞风控 → 写冷却时间（编排器据此拒绝写操作）
  const onRisk = (message: string): void => {
    const until = new Date(Date.now() + current.safety.riskCooldownMin * 60_000);
    state.setRiskCooldown(localIso(until));
    logger.error('bili', `撞风控：${message}，已冷却到 ${localIso(until)}`);
    logger.event('risk', `撞风控，冷却 ${current.safety.riskCooldownMin} 分钟`, { level: 'error' });
  };

  let api: BiliApi;
  let llm: LlmClient;
  let cleanup: () => void = () => {};

  if (args.fixtures) {
    const offline = await import('./dev/offline.ts');
    const built = offline.createOfflineStack({ paths, logger, config: current });
    api = built.api;
    llm = built.llm;
  } else {
    const bili = createBili({ cookie: secrets.cookie(), logger, onRisk });
    api = bili.api;
    llm = new LlmClient({
      apiKey: secrets.apiKey(),
      baseUrl: current.llm.baseUrl,
      model: current.llm.model,
      temperature: current.llm.temperature,
      maxTokens: current.llm.maxTokens,
      timeoutMs: current.llm.timeoutMs,
      maxRetries: current.llm.maxRetries,
      logger,
    });
    if (args.mockModel) {
      // 真实 B 站 + 占位模型：验证「真实数据能不能走完整轮」，不代表模型质量
      const mock = await import('./dev/mockModel.ts');
      const handle = mock.makeMockModelFetch({ logger });
      llm = new LlmClient({
        apiKey: 'mock',
        baseUrl: 'https://mock.local',
        model: 'mock-model',
        temperature: 0,
        maxTokens: current.llm.maxTokens,
        timeoutMs: 10_000,
        maxRetries: 0,
        logger,
        fetchImpl: handle.fetchImpl,
      });
    }
  }

  return {
    paths,
    logger,
    config,
    secrets,
    state,
    seen,
    quota,
    feedback,
    runs,
    api,
    llm,
    configuredModel: current.llm.model,
    cleanup,
  };
}

/* ---------------------------------------------------------------- run */

async function commandRun(args: ParsedArgs): Promise<number> {
  const started = Date.now();
  const ctx = await bootstrap(args);
  const cfg = ctx.config.get();

  if (!args.fixtures && ctx.secrets.hasApiKey() && cfg.llm.modelAuto) {
    const decision = await discoverModel({
      client: ctx.llm,
      configured: ctx.configuredModel,
      modelAuto: cfg.llm.modelAuto,
      logger: ctx.logger,
    });
    if (decision.model !== ctx.llm.model) ctx.llm.setModel(decision.model);
    ctx.state.setModelCache({ name: decision.model, discoveredAt: localIso(), keyFingerprint: keyFingerprint(ctx.secrets.apiKey()) });
  }

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
  const rows: Array<[string, boolean | 'warn', string]> = [];

  rows.push(['Node 版本', Number(process.versions.node.split('.')[0]) >= 22 ? true : 'warn', process.version]);
  rows.push(['数据目录', fs.existsSync(ctx.paths.dataDir) ? true : false, ctx.paths.dataDir]);
  rows.push(['日志目录', fs.existsSync(ctx.paths.logsDir) ? true : false, ctx.paths.logsDir]);
  rows.push(['配置文件', fs.existsSync(ctx.paths.config) ? true : 'warn', ctx.paths.config]);
  rows.push(['DeepSeek key', ctx.secrets.hasApiKey() ? true : false, ctx.secrets.hasApiKey() ? '已配置' : '缺失（设 BILIWHALE_API_KEY）']);
  const hint = ctx.secrets.accountHint();
  rows.push(['B 站登录', hint.hasCookie ? true : 'warn', hint.uname ? `${hint.uname}（${hint.mid}）` : hint.hasCookie ? hint.fingerprint : '未登录（只能读评论，字幕会拿不到）']);

  const ffmpeg = findFfmpeg(cfg.media.ffmpegPath);
  rows.push(['ffmpeg', ffmpeg ? true : 'warn', ffmpeg ?? '没找到（M0 不抽帧，可忽略）']);

  try {
    const stat = fs.statfsSync(ctx.paths.dataDir);
    const freeGb = (Number(stat.bavail) * Number(stat.bsize)) / 1024 / 1024 / 1024;
    rows.push(['磁盘剩余', freeGb > 1 ? true : 'warn', `${freeGb.toFixed(1)} GB`]);
  } catch {
    rows.push(['磁盘剩余', 'warn', '查询失败']);
  }

  if (!args.fixtures && hint.hasCookie) {
    const nav = await ctx.api.nav();
    rows.push(['nav 登录态', nav.ok && nav.data.isLogin ? true : 'warn', nav.ok ? (nav.data.isLogin ? `已登录：${nav.data.uname}` : 'cookie 无效或已过期') : nav.error.message]);
  }

  if (!args.fixtures && ctx.secrets.hasApiKey()) {
    const models = await ctx.llm.listModels();
    rows.push(['模型列表', models.ok ? true : 'warn', models.ok ? `${models.data.length} 个：${models.data.slice(0, 6).join(', ')}` : models.error.message]);
  }

  const lines = ['', `BiliWhale ${VERSION} · 体检`, `配置模型：${cfg.llm.model}${cfg.llm.modelAuto ? '（自动发现开）' : ''}`, ''];
  for (const [name, state, detail] of rows) {
    const mark = state === true ? '✓' : state === 'warn' ? '!' : '✗';
    lines.push(`  ${mark} ${name.padEnd(12, ' ')} ${detail}`);
  }
  const bad = rows.some(([, state]) => state === false);
  lines.push('', bad ? '有硬性项没过（✗），先修它。' : '没有硬伤（! 是可降级项）。', '');
  process.stdout.write(lines.join('\n'));
  return bad ? 1 : 0;
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
    '  node src/cli.ts run --now [--dry] [--fixtures]   跑一轮（M0 永远只读，不写任何远端内容）',
    '  node src/cli.ts doctor [--fixtures]              体检：目录/配置/凭据/网络/模型/ffmpeg',
    '  node src/cli.ts config show                      打印当前配置（不含密钥）',
    '  node src/cli.ts config validate                  校验 config.json',
    '',
    '参数：',
    '  --data-dir <path>   覆盖数据目录（默认 %APPDATA%\\BiliWhale）',
    '  --trigger manual|schedule   记录本轮来源（默认 manual）',
    '  --fixtures          离线模式：用夹具跑通整轮，不碰真实 B 站/模型',
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
