/**
 * 发过的动态（本地 jsonl）。
 *
 * 为什么要单独存：日更动态要说「这几天我都在想什么」——内容得能回头读；
 * 配额账本只记「发了一条」，不记文字。这里只追加、只读最近 N 条，不参与任何判断。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../shared/atomic.ts';

export interface DynamicEntry {
  at: string;
  text: string;
}

export class DynamicLog {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'dynamics.jsonl');
  }

  append(entry: DynamicEntry): void {
    ensureDir(path.dirname(this.file));
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 最近 N 条（按时间正序返回，方便 prompt 里按「旧 → 新」排）。 */
  recent(limit = 7): DynamicEntry[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const entries: DynamicEntry[] = [];
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as DynamicEntry;
        if (typeof parsed.text === 'string' && parsed.text.length > 0) entries.push(parsed);
      } catch {
        // 坏行跳过：这是日志，不该让程序起不来
      }
    }
    return entries.slice(-Math.max(0, limit));
  }
}
