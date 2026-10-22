/**
 * JSON 存储基类。
 *
 * 职责：给每个账本（state / seen / quota / feedback）一套统一的读、写、恢复语义。
 *   - 写：temp + fsync + rename + `.bak`
 *   - 读：主文件 → `.bak` → 空结构；**坏文件不能让程序起不来**
 *   - 单写入者：本进程内串行，不做跨进程锁（单实例由启动锁保证）
 * 不做什么：不做并发事务；需要跨文件一致性时由编排器先写 runs/<id>.json 当事务日志。
 */

import { readJson, writeJsonAtomic } from '../shared/atomic.ts';
import type { Logger } from '../shared/logger.ts';

export interface StoreReadResult<T> {
  value: T;
  /** 来源：正常 / 备份恢复 / 重建。 */
  from: 'main' | 'backup' | 'rebuilt';
  notes: string[];
}

export class JsonStore<T> {
  readonly file: string;
  private readonly defaults: () => T;
  private readonly logger: Logger;
  private readonly target: string;
  private cache: T | null = null;

  constructor(file: string, defaults: () => T, logger: Logger, target = 'state') {
    this.file = file;
    this.defaults = defaults;
    this.logger = logger;
    this.target = target;
  }

  read(): StoreReadResult<T> {
    const result = readJson<T>(this.file);
    if (result.ok) {
      this.cache = result.value;
      const notes: string[] = [];
      if (result.from === 'backup') {
        notes.push('主文件损坏，已从 .bak 恢复');
        this.logger.warn(this.target, '账本主文件损坏，已从备份恢复', { file: this.file });
      }
      return { value: result.value, from: result.from, notes };
    }

    const notes: string[] = [];
    if (result.corrupt) {
      notes.push('账本损坏，已重建为空结构');
      this.logger.error(this.target, '账本损坏且备份不可用，已重建为空结构', { file: this.file });
    }
    const value = this.defaults();
    this.cache = value;
    // 立刻落一份，避免下次启动又是「不存在」
    try {
      this.write(value);
    } catch (err) {
      this.logger.error(this.target, '重建账本写盘失败', { error: String(err) });
    }
    return { value, from: 'rebuilt', notes };
  }

  /** 读并保证有值（多数调用方只想要数据）。 */
  get(): T {
    if (this.cache) return this.cache;
    return this.read().value;
  }

  write(value: T): void {
    writeJsonAtomic(this.file, value);
    this.cache = value;
  }

  /** 读-改-写：回调必须返回完整的新值；返回 undefined 表示不写。 */
  update(fn: (current: T) => T | undefined): T {
    const current = this.get();
    const next = fn(current);
    if (next === undefined) return current;
    this.write(next);
    return next;
  }
}
