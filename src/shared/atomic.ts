/**
 * 原子写与安全读。
 *
 * 职责：把 JSON 写到磁盘时要么是旧的完整内容、要么是新的完整内容，绝不出现半截文件。
 *   写法：`file.tmp` → fsync → 旧文件复制成 `file.bak` → rename 覆盖。
 * 不做什么：不做并发控制（调用方保证同一文件只有一个写者）、不做加密。
 */

import fs from 'node:fs';
import path from 'node:path';

export type ReadResult<T> =
  | { ok: true; value: T; from: 'main' | 'backup' }
  | { ok: false; error: string; corrupt: boolean };

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** 读 JSON；主文件坏了退回 `.bak`；两者都坏则报告 corrupt。 */
export function readJson<T>(file: string): ReadResult<T> {
  for (const candidate of [file, `${file}.bak`] as const) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      return { ok: false, error: `读取失败（${candidate}）：${String(err)}`, corrupt: false };
    }
    try {
      return { ok: true, value: JSON.parse(raw) as T, from: candidate === file ? 'main' : 'backup' };
    } catch (err) {
      // fall through to backup; if this was the backup too, we already tried both
      if (candidate === `${file}.bak`) {
        return { ok: false, error: `JSON 损坏（${candidate}）：${String(err)}`, corrupt: true };
      }
    }
  }
  return { ok: false, error: '文件不存在', corrupt: false };
}

/** 原子写 JSON：temp + fsync + 旧文件转 .bak + rename。 */
export function writeJsonAtomic(file: string, value: unknown, opts: { backup?: boolean; indent?: number } = {}): void {
  const { backup = true, indent = 2 } = opts;
  ensureDir(path.dirname(file));
  const body = `${JSON.stringify(value, null, indent)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;

  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (backup && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // 备份失败不阻塞主写入：宁可少一份 .bak，也要把新的写完
    }
  }
  fs.renameSync(tmp, file);
}

/** 原子追加一行（JSONL）：整体读改写代价高，这里只保证单次 append 不撕裂。 */
export function appendLine(file: string, line: string): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
}

/** 读最近 N 行 JSONL（从文件尾部往前截，避免大文件全量读）。 */
export function readTailLines(file: string, maxLines: number, maxBytes = 4 * 1024 * 1024): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/** 文本落盘（报告 / 日记用）：同样走 temp + rename，避免半截 Markdown。 */
export function writeTextAtomic(file: string, text: string, opts: { backup?: boolean } = {}): void {
  const { backup = true } = opts;
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (backup && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* 备份失败不阻塞 */
    }
  }
  fs.renameSync(tmp, file);
}

/** 追加文本（日记多轮追加、归档追加）。 */
export function appendText(file: string, text: string): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text, 'utf8');
}
