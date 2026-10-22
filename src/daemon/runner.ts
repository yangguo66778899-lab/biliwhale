/**
 * 一轮的执行器（守护进程里用）。
 *
 * 职责：把「到点了」变成「跑一轮」，并保证同一时刻只有一轮在跑。
 *   - 定时触发：skip 槽位走跳过分支，普通槽位走完整一轮；
 *   - 手动触发（托盘/面板）：立即跑，不受作息窗口限制；
 *   - 手动与定时撞车时，后来者被拒绝并说明原因（不排队、不叠加，避免 B 站风控与配额混乱）。
 * 不做什么：不判到没到点（scheduler 负责）、不碰 HTTP。
 */

import type { AppContext } from '../bootstrap.ts';
import type { RoundDeps } from '../orchestrator/round.ts';
import { runRound } from '../orchestrator/round.ts';
import { makeReplyDraft } from '../orchestrator/replyDraft.ts';
import { runSkipRound } from '../orchestrator/skip.ts';
import type { PlannedSlot } from '../scheduler/plan.ts';
import type { RunRecord } from '../shared/types.ts';
import { humanError } from '../shared/errors.ts';
import { localIso } from '../shared/time.ts';

export interface RunnerOptions {
  fixtures: boolean;
  mockModel: boolean;
}

export class RoundRunner {
  private readonly ctx: AppContext;
  private readonly opts: RunnerOptions;
  private current: Promise<RunRecord> | null = null;
  private lastRecord: RunRecord | null = null;

  constructor(ctx: AppContext, opts: RunnerOptions) {
    this.ctx = ctx;
    this.opts = opts;
  }

  isRunning(): boolean {
    return this.current !== null;
  }

  last(): RunRecord | null {
    return this.lastRecord;
  }

  /** 等当前这一轮结束（退出时用，最多等 timeoutMs）。 */
  async wait(timeoutMs = 30_000): Promise<void> {
    if (!this.current) return;
    await Promise.race([this.current.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  private deps(): RoundDeps {
    const modeNote = this.opts.fixtures
      ? '夹具模式：用离线夹具代替真实 B 站与模型，不检查凭据、不联网'
      : this.opts.mockModel
        ? '模拟模型模式：真实 B 站数据 + 占位模型输出（只验证链路，不代表模型质量）'
        : undefined;
    return {
      paths: this.ctx.paths,
      config: this.ctx.config,
      secrets: this.ctx.secrets,
      logger: this.ctx.logger,
      api: this.ctx.api,
      llm: this.ctx.llm,
      state: this.ctx.state,
      seen: this.ctx.seen,
      quota: this.ctx.quota,
      feedback: this.ctx.feedback,
      writer: this.ctx.writer,
      pending: this.ctx.pending,
      replied: this.ctx.replied,
      pendingDraft: makeReplyDraft(this.ctx.llm, this.ctx.logger),
      runs: this.ctx.runs,
      configuredModel: this.ctx.configuredModel,
      ...(this.opts.fixtures || this.opts.mockModel ? { noCredentialsNeeded: true } : {}),
      ...(modeNote ? { modeNote } : {}),
    };
  }

  /** 到点醒来：跳过槽位只写日记，普通槽位跑完整一轮。失败不外抛（写进事件流）。 */
  async runScheduled(slot: PlannedSlot): Promise<RunRecord | null> {
    if (this.isRunning()) {
      this.ctx.logger.warn('scheduler', '上一轮还在跑，这次的定时触发被跳过');
      this.ctx.logger.event('skip-trigger', '到点了但上一轮还在跑，跳过这次', { level: 'warn', target: 'scheduler' });
      return null;
    }
    const task =
      slot.kind === 'skip'
        ? runSkipRound(this.deps(), { trigger: 'schedule', reason: '今天不想看（作息计划里的跳过）' })
        : // 定时触发也要按配置决定真发/预演（`safety.dryRun` 在 runRound 里统一算）。
          // 曾经这里写死 true（M1 时代还没有写能力），导致「到点自己醒」的那一轮永远只预演。
          runRound(this.deps(), { trigger: 'schedule', dryRun: false });
    return this.track(task, `定时触发（${slot.atText}）`);
  }

  /** 手动跑一轮：立刻开始，不等待。 */
  runManual(options: { dryRun: boolean }): { ok: boolean; message: string } {
    if (this.isRunning()) return { ok: false, message: '上一轮还在跑，等它结束再点' };
    const task = runRound(this.deps(), { trigger: 'manual', dryRun: options.dryRun });
    void this.track(task, '手动触发');
    return { ok: true, message: '已开始跑一轮（跑完会写报告与日记）' };
  }

  private async track(task: Promise<RunRecord>, label: string): Promise<RunRecord | null> {
    this.current = task;
    try {
      const record = await task;
      this.lastRecord = record;
      this.ctx.logger.info('runner', `${label}结束：${record.status}`);
      return record;
    } catch (err) {
      this.ctx.logger.error('runner', `${label}异常结束：${humanError(err)}`);
      this.ctx.logger.event('run-failed', `${label}异常：${humanError(err)}`, { level: 'error', target: 'runner' });
      return null;
    } finally {
      this.current = null;
      this.ctx.state.noteRun(this.lastRecord?.status ?? 'failed', localIso());
    }
  }
}
