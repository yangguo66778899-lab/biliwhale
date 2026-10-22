/**
 * 单实例锁。
 *
 * 职责：保证同一台机器上只有一个内核在跑；第二个实例启动时能知道「是谁占着」并退出。
 *   锁文件里记 pid + 启动时间；判定存活用 `process.kill(pid, 0)`：
 *   - 活着 → 拒绝启动（调用方去唤起已有实例）
 *   - 死了 / 文件超过 24 小时 → 视为陈旧，清掉重来
 * 不做什么：不做跨用户协调（单人单账号）、不抢锁等待（拿不到就退出）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../shared/atomic.ts';

export interface LockInfo {
  pid: number;
  startedAt: string;
  /** 内核端口，供第二个实例/托盘直接打开面板。 */
  port?: number;
  version?: string;
}

export type AcquireResult =
  | { acquired: true; release: () => void }
  | { acquired: false; holder: LockInfo | null; reason: string };

/** 锁文件最长认多久；超过就当陈旧（防止 pid 被系统复用后永久锁死）。 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = 进程存在但没权限发信号；ESRCH = 不存在
    return code === 'EPERM';
  }
}

export class InstanceLock {
  readonly file: string;
  private readonly pid: number;
  private readonly startedAt: string;
  private acquired = false;

  constructor(file: string, options: { pid?: number; startedAt?: Date } = {}) {
    this.file = file;
    this.pid = options.pid ?? process.pid;
    this.startedAt = (options.startedAt ?? new Date()).toISOString();
  }

  /** 读当前锁（没有/坏掉都返回 null）。 */
  read(): LockInfo | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LockInfo>;
      if (typeof parsed.pid !== 'number') return null;
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        ...(typeof parsed.port === 'number' ? { port: parsed.port } : {}),
        ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      };
    } catch {
      return null;
    }
  }

  acquire(extra: { port?: number; version?: string } = {}): AcquireResult {
    ensureDir(path.dirname(this.file));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const body: LockInfo = {
          pid: this.pid,
          startedAt: this.startedAt,
          ...(extra.port !== undefined ? { port: extra.port } : {}),
          ...(extra.version !== undefined ? { version: extra.version } : {}),
        };
        const fd = fs.openSync(this.file, 'wx');
        try {
          fs.writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.acquired = true;
        return { acquired: true, release: () => this.release() };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          return { acquired: false, holder: null, reason: `锁文件写入失败：${String(err)}` };
        }
        const holder = this.read();
        if (holder && holder.pid !== this.pid && isProcessAlive(holder.pid) && !this.isStale(holder)) {
          return { acquired: false, holder, reason: `已有实例在跑（pid ${holder.pid}）` };
        }
        // 陈旧锁（进程已死、文件坏了、太老）：清掉重试一次
        try {
          fs.unlinkSync(this.file);
        } catch {
          return { acquired: false, holder, reason: '锁文件存在但删不掉' };
        }
      }
    }
    return { acquired: false, holder: this.read(), reason: '抢锁失败（重试后仍被占）' };
  }

  release(): void {
    if (!this.acquired) return;
    const holder = this.read();
    if (holder && holder.pid === this.pid) {
      try {
        fs.unlinkSync(this.file);
      } catch {
        /* 删不掉就算了，下次启动会按陈旧锁处理 */
      }
    }
    this.acquired = false;
  }

  /** 把端口补进锁文件（HTTP 起来之后才知道真实端口）。 */
  updatePort(port: number): void {
    if (!this.acquired) return;
    const holder = this.read();
    if (!holder || holder.pid !== this.pid) return;
    try {
      fs.writeFileSync(this.file, `${JSON.stringify({ ...holder, port }, null, 2)}\n`, 'utf8');
    } catch {
      /* 端口写不进去不影响运行，托盘还能从 runtime.json 读 */
    }
  }

  private isStale(holder: LockInfo): boolean {
    const started = Date.parse(holder.startedAt);
    if (!Number.isFinite(started)) return true;
    return Date.now() - started > STALE_AFTER_MS;
  }
}
