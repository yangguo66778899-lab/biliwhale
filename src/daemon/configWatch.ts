/**
 * config.json 热更新（fs.watch + mtime 轮询兜底）。
 *
 * 为什么还要轮询：`fs.watch` 在 Windows 上大多数时候好使，但它会漏事件（文件被整体替换、
 * 编辑器先写临时文件再 rename、某些同步盘/杀软）。配置改坏了却不生效，用户只会觉得「面板骗人」。
 * 所以：watch 负责「立刻」，轮询负责「最多 N 秒一定发现」。轮询只 stat 一次 mtime，代价可以忽略。
 *
 * 不做什么：不解析配置（校验与写回在 ConfigService / 调用方）、不自己改文件。
 */

import fs from 'node:fs';
import type { Logger } from '../shared/logger.ts';

export interface ConfigWatchOptions {
  file: string;
  logger: Logger;
  /** 文件变化后多久真正处理（合并连续写盘）。 */
  debounceMs?: number;
  /** 轮询间隔；0 = 只靠 fs.watch。 */
  pollMs?: number;
  /** 发现变化时调用（内部已做 debounce 与去重）。 */
  onChange: () => void;
}

export class ConfigWatcher {
  private readonly opts: ConfigWatchOptions;
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastMtimeMs: number | null = null;

  constructor(opts: ConfigWatchOptions) {
    this.opts = opts;
    this.lastMtimeMs = this.statMtime();
  }

  start(): void {
    if (this.watcher || this.poll) return;
    const debounceMs = this.opts.debounceMs ?? 500;

    const trigger = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.opts.onChange();
      }, debounceMs);
      this.timer.unref?.();
    };

    try {
      this.watcher = fs.watch(this.opts.file, { persistent: false }, (event) => {
        if (event === 'rename' || event === 'change') trigger();
      });
      this.watcher.on('error', (err: unknown) => {
        this.opts.logger.warn('daemon', `配置文件监听出错（改成轮询兜底）：${String(err)}`);
        this.watcher?.close();
        this.watcher = null;
      });
      this.watcher.unref?.();
    } catch (err) {
      this.opts.logger.warn('daemon', `配置文件监听装不上（改成轮询兜底）：${String(err)}`);
    }

    const pollMs = this.opts.pollMs ?? 5_000;
    if (pollMs > 0) {
      this.poll = setInterval(() => {
        const mtime = this.statMtime();
        if (mtime === null) return;
        if (this.lastMtimeMs === null) {
          this.lastMtimeMs = mtime;
          return;
        }
        if (mtime !== this.lastMtimeMs) {
          this.lastMtimeMs = mtime;
          trigger();
        }
      }, pollMs);
      this.poll.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = null;
    this.poll = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** 手动标记「已经重新读过」：避免自己写盘又触发一轮。 */
  markRead(): void {
    this.lastMtimeMs = this.statMtime();
  }

  private statMtime(): number | null {
    try {
      return fs.statSync(this.opts.file).mtimeMs;
    } catch {
      return null;
    }
  }
}
