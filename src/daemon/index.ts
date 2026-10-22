/**
 * 守护进程（`serve`）：作息 + 本地面板 + 心跳 + 单实例。
 *
 * 职责：
 *   - 抢单实例锁，抢不到就告诉调用方「已有实例，端口是多少」，不硬起第二个；
 *   - 起本地 HTTP（127.0.0.1 + token），把端口与 token 写进 runtime.json 给托盘/面板握手；
 *   - 每 30 秒 tick 一次作息，到点就跑一轮（跳过槽位只写日记）；
 *   - 每 30 秒写心跳，壳与诊断据此判断存活；
 *   - 监听 config.json 变化：schedule 变了就让调度器重算，其它配置下一次调用生效；
 *   - 收到 SIGINT/SIGTERM/面板「退出」时优雅收尾：等当前一轮跑到安全点、落盘、放锁。
 * 不做什么：不弹窗、不弹托盘（壳的事）、不实现业务逻辑（在 daemon/api.ts 与各服务里）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../bootstrap.ts';
import { bootstrap, fillOwnerName } from '../bootstrap.ts';
import { InstanceLock } from '../lifecycle/lock.ts';
import type { LockInfo } from '../lifecycle/lock.ts';
import { clearRuntime, newToken, writeHeartbeat, writeRuntime } from '../lifecycle/runtime.ts';
import { AutostartService } from '../lifecycle/autostart.ts';
import { ControlServer } from '../http/server.ts';
import { RoundRunner } from './runner.ts';
import { Scheduler, toDayPlan } from './scheduler.ts';
import { createHandlers } from './api.ts';
import { ListenLoop } from './listen.ts';
import { ConfigWatcher } from './configWatch.ts';
import { LoginService } from '../account/login.ts';
import { summarizePlan, pendingSlots } from '../scheduler/tick.ts';
import { localIso } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';
import type { RandomSource } from '../scheduler/random.ts';

export interface DaemonOptions {
  dataDir?: string;
  port?: number;
  fixtures?: boolean;
  mockModel?: boolean;
  version: string;
  tickMs?: number;
  heartbeatMs?: number;
  /** config 轮询间隔（测试用；默认 5000ms）。 */
  configPollMs?: number;
  /** 测试注入：随机源与时钟（生产用 crypto / 系统时间）。 */
  rand?: RandomSource;
  now?: () => Date;
}

export type DaemonStart =
  | {
      kind: 'started';
      port: number;
      url: string;
      token: string;
      stop: () => Promise<void>;
      /** 立刻跑一次 tick（测试与调试用）。 */
      tickNow: () => Promise<void>;
      /** 立刻跑一次监听（测试与调试用）。 */
      listenNow: () => Promise<unknown>;
    }
  | { kind: 'already-running'; holder: LockInfo | null; message: string };

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

export async function startDaemon(opts: DaemonOptions): Promise<DaemonStart> {
  const ctx = await bootstrap({
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    fixtures: opts.fixtures ?? false,
    mockModel: opts.mockModel ?? false,
    mirrorToConsole: false,
  });
  const { logger, paths } = ctx;

  // ---- 单实例 ----
  const lock = new InstanceLock(path.join(paths.localDir, 'instance.lock'));
  const acquired = lock.acquire({ version: opts.version });
  if (!acquired.acquired) {
    logger.warn('daemon', acquired.reason);
    return { kind: 'already-running', holder: acquired.holder, message: acquired.reason };
  }

  const startedAt = Date.now();
  const runner = new RoundRunner(ctx, {
    fixtures: opts.fixtures ?? false,
    mockModel: opts.mockModel ?? false,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const scheduler = new Scheduler(ctx, runner, {
    ...(opts.rand ? { rand: opts.rand } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const token = newToken();
  const cfg = ctx.config.get();
  const autostart = new AutostartService({ command: resolveTrayCommand(), logger });
  const login = new LoginService({
    http: ctx.transport,
    secrets: ctx.secrets,
    logger,
    verify: async () => {
      const nav = await ctx.api.nav();
      if (!nav.ok) return nav;
      return { ok: true, data: { isLogin: nav.data.isLogin, mid: nav.data.mid, uname: nav.data.uname } };
    },
  });

  let stopImpl: (() => void) | null = null;
  /** 监听循环要晚一步创建（它依赖 ctx）：用晚绑定把 tick 交给面板接口。 */
  let listenRef: ListenLoop | null = null;
  const handlers = createHandlers({
    ctx,
    runner,
    scheduler,
    autostart,
    login,
    version: opts.version,
    startedAt,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    trayExe: resolveTrayExe(),
    fixtures: opts.fixtures ?? false,
    mockModel: opts.mockModel ?? false,
    shutdown: () => stopImpl?.(),
    listenTick: () => (listenRef ? listenRef.tickOnce() : Promise.resolve({ skipped: ['监听循环还没接上'] })),
  });

  const server = new ControlServer({
    handlers,
    token,
    version: opts.version,
    port: opts.port ?? cfg.ui.port,
    logger,
  });

  const started = await server.start();
  lock.updatePort(started.port);
  writeRuntime(paths, {
    pid: process.pid,
    port: started.port,
    token,
    version: opts.version,
    startedAt: localIso(new Date(startedAt)),
    dataDir: paths.dataDir,
    url: `${started.url}/?token=${token}`,
  });

  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const isoOfNextWake = (): string | null => {
    const ms = ctx.state.nextWakeAtMs();
    return ms === null ? null : localIso(new Date(ms));
  };

  const heartbeat = (): void => {
    const state = ctx.state.get();
    writeHeartbeat(paths, {
      pid: process.pid,
      at: localIso(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      version: opts.version,
      running: runner.isRunning(),
      paused: state.paused,
      nextWakeAt: isoOfNextWake(),
      lastRunStatus: state.lastRunStatus,
    });
  };

  // ---- 配置热更新：schedule 变了就重算，其它字段下一次调用生效 ----
  // 注意：debounce 由 ConfigWatcher 负责（500ms），这里不要再套一层 setTimeout，否则改完配置要等 1 秒才生效。
  const onConfigChanged = (): void => {
    try {
      // 先校验：改坏了就保留当前配置（回落默认值会把用户的窗口/开关全冲掉）
      const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8')) as unknown;
      const check = ctx.config.validateOnly(raw);
      if (!check.ok) {
        const first = check.issues.find((issue) => issue.severity === 'error');
        logger.error('daemon', `配置改坏了（${first?.path ?? '?'}：${first?.message ?? '未知'}），继续用当前配置`);
        return;
      }
      const before = JSON.stringify(ctx.config.get().schedule);
      ctx.config.load();
      const after = JSON.stringify(ctx.config.get().schedule);
      logger.setLevel(ctx.config.get().logging.level);
      if (before !== after) {
        scheduler.invalidate();
        logger.info('daemon', '检测到 schedule 变化，已让调度器重算');
      } else {
        logger.info('daemon', '配置已重新加载');
      }
    } catch (err) {
      logger.warn('daemon', `配置重载失败（继续用旧配置）：${humanError(err)}`);
    }
  };

  // watch 负责「立刻」，轮询负责「最多 5 秒一定发现」（watch 会漏事件）
  const configWatcher = new ConfigWatcher({
    file: paths.config,
    logger,
    onChange: onConfigChanged,
    ...(opts.configPollMs !== undefined ? { pollMs: opts.configPollMs } : {}),
  });
  configWatcher.start();

  ctx.chat.prune(); // 聊天记录保留 30 天
  // 主人昵称没填时按 UID 补一次（后台跑，失败就留着让用户手填；夹具模式跳过）
  void fillOwnerName(ctx).catch((err) => logger.warn('account', `主人昵称自动补全失败：${humanError(err)}`));
  const listen = new ListenLoop({ ctx, ...(opts.now ? { now: opts.now } : {}) });
  listenRef = listen;
  if (!opts.fixtures) listen.start();

  const tickTimer = setInterval(() => {
    void scheduler.tickOnce();
  }, tickMs);
  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);

  let stopping: Promise<void> | null = null;

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      logger.info('daemon', `开始退出（${reason}）`);
      listen.stop();
      clearInterval(tickTimer);
      clearInterval(heartbeatTimer);
      configWatcher.stop();
      await runner.wait(20_000);
      await server.stop();
      clearRuntime(paths);
      lock.release();
      clearHeartbeat();
      logger.info('daemon', '已退出');
    })();
    return stopping;
  }

  function clearHeartbeat(): void {
    try {
      fs.rmSync(paths.heartbeat, { force: true });
      fs.rmSync(`${paths.heartbeat}.bak`, { force: true });
    } catch {
      /* 删不掉无所谓，下次启动会覆盖 */
    }
  }

  stopImpl = () => {
    setTimeout(() => {
      void shutdown('api').catch((err: unknown) => logger.error('daemon', `退出失败：${humanError(err)}`));
    }, 50);
  };

  const onSignal = (signal: string): void => {
    void shutdown(signal).then(() => process.exit(0));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  // 起来先 tick 一次：让计划立刻生成、状态接口马上有下一步时间
  await scheduler.tickOnce();
  heartbeat();

  logger.info('daemon', `守护进程就绪：${started.url}（数据目录 ${paths.dataDir}）`);
  logger.event('daemon', '守护进程已启动', { target: 'daemon', data: { port: started.port, pid: process.pid } });

  return {
    kind: 'started',
    port: started.port,
    url: started.url,
    token,
    stop: () => shutdown('stop'),
    tickNow: () => scheduler.tickOnce(),
    listenNow: () => listen.tickOnce(),
  };
}

/** 托盘可执行文件位置：优先环境变量，其次仓库里的 shell/（打包后由安装目录决定）。 */
export function resolveTrayExe(): string {
  const fromEnv = process.env.BILIWHALE_TRAY_EXE?.trim();
  if (fromEnv) return fromEnv;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'shell', 'BiliWhaleTray.exe');
}

export function resolveTrayCommand(): string {
  return `"${resolveTrayExe()}" --autostart`;
}

/** 给 `serve` 用的状态摘要文本（命令行启动时打印给人看）。 */
export function describeNextRun(ctx: AppContext): string {
  const state = ctx.state.get();
  const plan = state.today ? toDayPlan(state.today) : null;
  const pending = pendingSlots(plan).length;
  return `${summarizePlan(plan)}（待触发 ${pending} 次）`;
}
