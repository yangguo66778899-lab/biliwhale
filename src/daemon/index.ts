/**
 * 守护进程（`serve`）：作息 + 本地控制接口 + 心跳 + 单实例。
 *
 * 职责：
 *   - 抢单实例锁，抢不到就告诉调用方「已有实例，端口是多少」，不硬起第二个；
 *   - 起本地 HTTP（127.0.0.1 + token），把端口与 token 写进 runtime.json 给托盘握手；
 *   - 每 30 秒 tick 一次作息，到点就跑一轮（跳过槽位只写日记）；
 *   - 每 30 秒写心跳，壳与诊断据此判断存活；
 *   - 监听 config.json 变化：schedule 变了就让调度器重算，其它配置下一次调用生效；
 *   - 收到 SIGINT/SIGTERM/面板「退出」时优雅收尾：等当前一轮跑到安全点、落盘、放锁。
 * 不做什么：不弹窗、不弹托盘（壳的事）、不实现业务逻辑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../bootstrap.ts';
import { bootstrap } from '../bootstrap.ts';
import { InstanceLock } from '../lifecycle/lock.ts';
import type { LockInfo } from '../lifecycle/lock.ts';
import { clearRuntime, newToken, writeHeartbeat, writeRuntime } from '../lifecycle/runtime.ts';
import { AutostartService } from '../lifecycle/autostart.ts';
import { ControlServer } from '../http/server.ts';
import type { AutostartPayload, ControlHandlers, HealthPayload, StatusPayload } from '../http/server.ts';
import type { RandomSource } from '../scheduler/random.ts';
import { RoundRunner } from './runner.ts';
import { Scheduler, scheduleConfig, toDayPlan } from './scheduler.ts';
import { summarizePlan, pendingSlots } from '../scheduler/tick.ts';
import { decideSilence } from '../state/ledgers.ts';
import { localDate, localIso } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';

export interface DaemonOptions {
  dataDir?: string;
  port?: number;
  fixtures?: boolean;
  mockModel?: boolean;
  version: string;
  tickMs?: number;
  heartbeatMs?: number;
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
  const runner = new RoundRunner(ctx, { fixtures: opts.fixtures ?? false, mockModel: opts.mockModel ?? false });
  const scheduler = new Scheduler(ctx, runner, {
    ...(opts.rand ? { rand: opts.rand } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const token = newToken();
  const cfg = ctx.config.get();

  const autostart = new AutostartService({ command: resolveTrayCommand(), logger });

  const handlers: ControlHandlers = {
    health(): HealthPayload {
      const state = ctx.state.get();
      return {
        ok: true,
        version: opts.version,
        pid: process.pid,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        running: runner.isRunning(),
        paused: state.paused,
        nextWakeAt: isoOfNextWake(),
        lastRunStatus: state.lastRunStatus,
        lastError: scheduler.error,
      };
    },
    status(): StatusPayload {
      const state = ctx.state.get();
      const current = ctx.config.get();
      const plan = state.today ? toDayPlan(state.today) : null;
      const last = ctx.runs.last();
      const silence = decideSilence(ctx.feedback.silenceDays(), current.share);
      const today = localDate();
      const account = ctx.secrets.accountHint();
      const warnings: string[] = [];
      if (!ctx.secrets.hasCookie()) warnings.push('没有 B 站 cookie：字幕读不到');
      if (state.paused) warnings.push('已暂停自动唤醒');
      if (scheduler.error) warnings.push(`调度最近一次出错：${scheduler.error}`);

      return {
        scheduler: {
          plan: summarizePlan(plan),
          paused: state.paused,
          nextWakeAt: isoOfNextWake(),
          planSource: state.today?.reason ?? null,
        },
        lastRun: last
          ? { id: last.id, status: last.status, endedAt: last.endedAt, tokens: last.model.promptTokens + last.model.completionTokens }
          : null,
        today: {
          wakes: state.today?.wakes ?? 0,
          targetWakes: state.today?.targetWakes ?? 0,
          shares: ctx.quota.sharesOn(today),
          shareCap: Math.min(silence.shareCap, current.share.dailyCap),
          tokens: state.budget.tokens,
          costCny: state.budget.costCny,
        },
        account: { loggedIn: account.hasCookie, ...(account.uname ? { name: account.uname } : {}), ...(account.mid ? { mid: account.mid } : {}) },
        model: {
          configured: ctx.configuredModel,
          actual: ctx.llm.model,
          discoveredAt: state.modelCache?.discoveredAt ?? null,
        },
        warnings,
      };
    },
    logs(limit: number): unknown[] {
      return logger.recentEvents(limit);
    },
    async run(options: { dryRun: boolean }): Promise<{ ok: boolean; message: string }> {
      const result = runner.runManual(options);
      logger.event('manual-run', result.message, { level: result.ok ? 'info' : 'warn', target: 'daemon' });
      return result;
    },
    pause(): { ok: boolean; message: string } {
      ctx.state.setPaused(true, localIso());
      logger.event('pause', '已暂停自动唤醒（手动仍可跑）', { target: 'daemon' });
      return { ok: true, message: '已暂停自动唤醒；手动「现在跑一轮」仍然可用' };
    },
    resume(): { ok: boolean; message: string } {
      ctx.state.setPaused(false, localIso());
      scheduler.invalidate();
      logger.event('resume', '已恢复自动唤醒', { target: 'daemon' });
      return { ok: true, message: '已恢复；下一次 tick 会重算计划' };
    },
    async autostart(enabled?: boolean): Promise<AutostartPayload> {
      try {
        if (enabled === undefined) return await autostart.status();
        return enabled ? await autostart.enable() : await autostart.disable();
      } catch (err) {
        const warning = humanError(err);
        logger.warn('autostart', warning);
        return { enabled: false, mechanism: null, command: null, warning };
      }
    },
    shutdown(): { ok: boolean; message: string } {
      logger.info('daemon', '收到退出请求');
      setTimeout(() => {
        void shutdown('api').catch((err: unknown) => logger.error('daemon', `退出失败：${humanError(err)}`));
      }, 50);
      return { ok: true, message: '正在退出' };
    },
  };

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

  function isoOfNextWake(): string | null {
    const ms = ctx.state.nextWakeAtMs();
    return ms === null ? null : localIso(new Date(ms));
  }

  // ---- 配置热更新：schedule 变了就重算，其它字段下一次调用生效 ----
  let watchTimer: NodeJS.Timeout | null = null;
  const configFile = paths.config;
  const onConfigChanged = (): void => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      try {
        const before = JSON.stringify(scheduleConfig(ctx.config.get()));
        ctx.config.load();
        const after = JSON.stringify(scheduleConfig(ctx.config.get()));
        const current = ctx.config.get();
        logger.setLevel(current.logging.level);
        if (before !== after) {
          scheduler.invalidate();
          logger.info('daemon', '检测到 schedule 变化，已让调度器重算');
        } else {
          logger.info('daemon', '配置已重新加载');
        }
      } catch (err) {
        logger.warn('daemon', `配置重载失败（继续用旧配置）：${humanError(err)}`);
      }
    }, 500);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(configFile, { persistent: false }, () => onConfigChanged());
  } catch (err) {
    logger.warn('daemon', `配置文件监听没装成（改配置需要重启）：${humanError(err)}`);
  }

  const tickTimer = setInterval(() => {
    void scheduler.tickOnce();
  }, tickMs);
  const heartbeatTimer = setInterval(heartbeat, heartbeatMs);

  let stopping: Promise<void> | null = null;

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      logger.info('daemon', `开始退出（${reason}）`);
      clearInterval(tickTimer);
      clearInterval(heartbeatTimer);
      if (watchTimer) clearTimeout(watchTimer);
      watcher?.close();
      await runner.wait(20_000);
      await server.stop();
      clearRuntime(paths);
      lock.release();
      heartbeatCleared();
      logger.info('daemon', '已退出');
    })();
    return stopping;
  }

  function heartbeatCleared(): void {
    try {
      fs.rmSync(paths.heartbeat, { force: true });
      fs.rmSync(`${paths.heartbeat}.bak`, { force: true });
    } catch {
      /* 删不掉无所谓，下次启动会覆盖 */
    }
  }

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
