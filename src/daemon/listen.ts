/**
 * 监听循环（M4）：评论/@ + 私信。
 *
 * 形态：一个 30 秒的 tick，按各自到期时间决定要不要真的去读：
 *   - 评论/@：`listen.comment.intervalSec`（≥60s）+ 0–20% 抖动；空闲时退避（×1.5，上限 15 分钟）；有新消息立刻恢复。
 *   - 私信：`listen.dm.intervalSec`（20–60s）+ 抖动；只拉会话列表，没新消息不拉消息、不唤醒模型（零 token）。
 * 关掉开关 → 立刻不再调度（不会有请求、不会有记账）。
 * 不做什么：不做业务判断（watch.ts / chat.ts 负责）、不写报告。
 */

import type { Logger } from '../shared/logger.ts';
import type { AppContext } from '../bootstrap.ts';
import type { ConfigService } from '../config/service.ts';
import { watchComments } from '../orchestrator/watch.ts';
import { pollOwnerDm } from '../orchestrator/chat.ts';
import type { WatchResult } from '../orchestrator/watch.ts';
import { nextDmDelay, nextWatchDelay } from '../orchestrator/watch.ts';
import { makeReplyDraft } from '../orchestrator/replyDraft.ts';
import { approvePending } from '../orchestrator/pending.ts';

export interface ListenDeps {
  ctx: AppContext;
  now?: () => Date;
  /** 测试注入：跳过定时器，只调 tickOnce。 */
  autoStart?: boolean;
}

export interface ListenTickResult {
  comment?: WatchResult;
  dm?: { handled: number; skipped: string[] };
  skipped?: string[];
}

const TICK_MS = 30_000;

export class ListenLoop {
  private readonly ctx: AppContext;
  private readonly logger: Logger;
  private config: ConfigService;
  private timer: NodeJS.Timeout | null = null;
  private nextCommentAt = 0;
  private nextDmAt = 0;
  private commentIdle = 0;

  constructor(deps: ListenDeps) {
    this.ctx = deps.ctx;
    this.logger = deps.ctx.logger;
    this.config = deps.ctx.config;
    this.now = deps.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tickOnce().catch((err: unknown) => this.logger.warn('listen', `监听 tick 出错：${String(err)}`));
    }, TICK_MS);
    // 别让定时器把进程顶住（daemon 自己会等待退出）
    this.timer.unref?.();
    this.logger.info('listen', '监听循环已启动（30s tick）');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 跑一次（测试直接调它，不用等定时器）。 */
  async tickOnce(): Promise<ListenTickResult> {
    const cfg = this.config.get();
    const result: ListenTickResult = {};
    const skipped: string[] = [];
    const nowMs = this.now().getTime();

    if (cfg.listen.comment.enabled) {
      if (nowMs >= this.nextCommentAt) {
        try {
          const watch = await watchComments({
            logger: this.logger,
            config: cfg,
            api: this.ctx.api,
            state: this.ctx.state,
            pending: this.ctx.pending,
            secrets: this.ctx.secrets,
            feedback: this.ctx.feedback,
            now: this.now,
            draft: makeReplyDraft(this.ctx.llm, this.logger),
          });
          result.comment = watch;
          // seen 只说明「消息中心里有历史消息」，不代表有新东西。
          // 以前用它判断，导致 commentIdle 永远是 0、空闲退避（300→600→900，上限 15 分钟）从不生效（审计 §3.30）
          this.commentIdle = watch.created > 0 || watch.baseline ? 0 : this.commentIdle + 1;
          if (watch.created > 0) {
            this.logger.event('listen', `评论监听：新增 ${watch.created} 条待审`, {
              target: 'listen',
              data: { created: watch.created },
            });
          }
          // 主人直发（listen.reply.ownerDirect）：主人回的评论不走审批，直接回。
          // 仍然受总写开关/急停/风控冷却/预演约束——approvePending 里统一检查。
          if (cfg.listen.reply.ownerDirect) {
            for (const id of watch.createdIds) {
              const item = this.ctx.pending.byId(id);
              if (!item?.fromOwner) continue;
              const approved = await approvePending(this.pendingDeps(), id, {});
              this.logger.event('listen', approved.ok ? `主人直发：已回（${id}）` : `主人直发没发出去（${id}）：${approved.message}`, {
                level: approved.ok ? 'info' : 'warn',
                target: 'listen',
              });
            }
          }
        } catch (err) {
          skipped.push(`评论监听出错：${String(err)}`);
          this.commentIdle += 1;
        }
        this.nextCommentAt = nowMs + nextWatchDelay(cfg, this.commentIdle);
      }
    } else {
      skipped.push('评论监听关着');
    }

    if (cfg.listen.dm.enabled) {
      if (nowMs >= this.nextDmAt) {
        try {
          const dm = await pollOwnerDm({
            logger: this.logger,
            paths: this.ctx.paths,
            config: cfg,
            llm: this.ctx.llm,
            api: this.ctx.api,
            writer: this.ctx.writer,
            state: this.ctx.state,
            chat: this.ctx.chat,
            secrets: this.ctx.secrets,
            feedback: this.ctx.feedback,
            now: this.now,
          });
          result.dm = dm;
        } catch (err) {
          skipped.push(`私信监听出错：${String(err)}`);
        }
        this.nextDmAt = nowMs + nextDmDelay(cfg);
      }
    } else {
      skipped.push('私信监听关着');
    }

    if (skipped.length > 0) result.skipped = skipped;
    return result;
  }

  /** 审批执行器需要的依赖（主人直发用；和面板「待审」页同一套）。 */
  private pendingDeps() {
    return {
      logger: this.logger,
      config: this.config.get(),
      quota: this.ctx.quota,
      state: this.ctx.state,
      pending: this.ctx.pending,
      replied: this.ctx.replied,
      api: this.ctx.api,
      writer: this.ctx.writer,
      secrets: this.ctx.secrets,
      now: this.now,
    };
  }

  /** 给面板/测试看当前调度状态。 */
  state(): { commentEnabled: boolean; dmEnabled: boolean; nextCommentInSec: number; nextDmInSec: number; commentIdle: number } {
    const cfg = this.config.get();
    const nowMs = this.now().getTime();
    return {
      commentEnabled: cfg.listen.comment.enabled,
      dmEnabled: cfg.listen.dm.enabled,
      nextCommentInSec: Math.max(0, Math.round((this.nextCommentAt - nowMs) / 1000)),
      nextDmInSec: Math.max(0, Math.round((this.nextDmAt - nowMs) / 1000)),
      commentIdle: this.commentIdle,
    };
  }
}
