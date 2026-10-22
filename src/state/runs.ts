/**
 * 运行记录（runs/<id>.json）。
 *
 * 职责：每轮一份可排障的记录（相位耗时、token、错误、计数）；启动时把上次没跑完的标成 interrupted。
 * 不做什么：不重放写操作（宁可留空，也不重复发）、不算配额（配额在 quota.json）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../shared/atomic.ts';
import type { Logger } from '../shared/logger.ts';
import type { RunCounts, RunRecord, RunStatus, RunTrigger } from '../shared/types.ts';
import { localIso, localStamp } from '../shared/time.ts';

export function emptyCounts(): RunCounts {
  return { candidates: 0, screened: 0, deepRead: 0, selected: 0, shared: 0, skippedNoSubtitle: 0 };
}

export class RunStore {
  private readonly dir: string;
  private readonly logger: Logger;

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger;
  }

  /** 开始一轮：先落盘（事务日志），跑挂了也知道这一轮存在过。 */
  start(input: { trigger: RunTrigger; dryRun: boolean; configuredModel: string }): RunRecord {
    const now = new Date();
    const record: RunRecord = {
      id: this.uniqueId(now),
      trigger: input.trigger,
      dryRun: input.dryRun,
      startedAt: localIso(now),
      endedAt: null,
      status: 'running',
      phases: [],
      model: {
        configured: input.configuredModel,
        actual: input.configuredModel,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        calls: 0,
        costCny: 0,
      },
      counts: emptyCounts(),
      errors: [],
      notes: [],
    };
    this.write(record);
    return record;
  }

  /** 运行记录 id：秒级时间戳 + 冲突后缀（同一秒跑两轮也不能互相覆盖）。 */
  private uniqueId(now: Date): string {
    const base = localStamp(now);
    let candidate = base;
    let attempt = 1;
    while (fs.existsSync(path.join(this.dir, `${candidate}.json`))) {
      attempt += 1;
      candidate = `${base}-${attempt}`;
      if (attempt > 50) break; // 兜底：真的有 50 轮挤在同一秒，就不要死循环
    }
    return candidate;
  }

  write(record: RunRecord): void {
    writeJsonAtomic(path.join(this.dir, `${record.id}.json`), record);
  }

  finish(record: RunRecord, status: RunStatus): RunRecord {
    const done: RunRecord = { ...record, status, endedAt: localIso() };
    this.write(done);
    return done;
  }

  /** 读最近 N 轮（按 id 倒序）。 */
  list(limit = 20): RunRecord[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && !f.endsWith('.bak'));
    } catch {
      return [];
    }
    const out: RunRecord[] = [];
    for (const file of files.sort().reverse().slice(0, limit)) {
      const read = readJson<RunRecord>(path.join(this.dir, file));
      if (read.ok && read.value && typeof read.value === 'object') out.push(read.value);
    }
    return out;
  }

  last(): RunRecord | null {
    return this.list(1)[0] ?? null;
  }

  /** 启动恢复：上次崩在半路（status=running）→ 标 interrupted，写事件，绝不重放。 */
  recoverInterrupted(): string[] {
    const recovered: string[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return recovered;
    }
    for (const file of files) {
      const full = path.join(this.dir, file);
      const read = readJson<RunRecord>(full);
      if (!read.ok || !read.value) continue;
      if (read.value.status === 'running') {
        const fixed: RunRecord = { ...read.value, status: 'interrupted', endedAt: localIso() };
        writeJsonAtomic(full, fixed);
        recovered.push(read.value.id);
        this.logger.warn('runs', `上次未跑完的记录已标记为 interrupted：${read.value.id}`);
      }
    }
    return recovered;
  }

  prune(keepDays: number, now: Date = new Date()): number {
    let removed = 0;
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') || f.endsWith('.json.bak'));
    } catch {
      return 0;
    }
    const cutoff = now.getTime() - keepDays * 86_400_000;
    for (const file of files) {
      const full = path.join(this.dir, file);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        /* 单个文件删不掉不影响其它 */
      }
    }
    return removed;
  }
}
