/**
 * 日志与事件流。
 *
 * 职责：
 *   - 人读日志：`<local>/logs/app-YYYY-MM-DD.log`，一行一条，按天切分 + 单文件上限。
 *   - 机读事件：`<data>/events.jsonl`，一行一个 JSON，用于时间线与排障。
 *   - 所有输出统一过 redact：cookie / API key 永不落盘。
 * 不做什么：不做日志聚合、不上报远端（本项目无遥测）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendLine, ensureDir, readTailLines } from './atomic.ts';
import { redact } from './redact.ts';
import { localDate, localIso } from './time.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEvent {
  at: string;
  kind: string;
  level: LogLevel;
  target: string;
  note: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** 日志目录（默认 `<local>/logs`）。 */
  logDir: string;
  /** 事件流文件（默认 `<data>/events.jsonl`）。 */
  eventsFile: string;
  level?: LogLevel;
  /** 单文件上限（字节），超过后切到 `.1`。 */
  maxFileBytes?: number;
  /** 同时打到 stdout（CLI 运行时开，常驻时关）。 */
  mirrorToConsole?: boolean;
}

export class Logger {
  private readonly logDir: string;
  private readonly eventsFile: string;
  private readonly maxFileBytes: number;
  private readonly mirror: boolean;
  private levelWeight: number;

  constructor(opts: LoggerOptions) {
    this.logDir = opts.logDir;
    this.eventsFile = opts.eventsFile;
    this.levelWeight = LEVEL_WEIGHT[opts.level ?? 'info'];
    this.maxFileBytes = opts.maxFileBytes ?? 20 * 1024 * 1024;
    this.mirror = opts.mirrorToConsole ?? false;
  }

  setLevel(level: LogLevel): void {
    this.levelWeight = LEVEL_WEIGHT[level];
  }

  debug(target: string, message: string, data?: Record<string, unknown>): void {
    this.write('debug', target, message, data);
  }

  info(target: string, message: string, data?: Record<string, unknown>): void {
    this.write('info', target, message, data);
  }

  warn(target: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', target, message, data);
  }

  error(target: string, message: string, data?: Record<string, unknown>): void {
    this.write('error', target, message, data);
  }

  /** 机读事件：写 events.jsonl（`note` 给「她今天做了什么」的时间线用）。 */
  event(kind: string, note: string, opts: { level?: LogLevel; target?: string; data?: Record<string, unknown> } = {}): void {
    const evt: LogEvent = {
      at: localIso(),
      kind,
      level: opts.level ?? 'info',
      target: opts.target ?? 'core',
      note: redact(note),
      ...(opts.data ? { data: sanitizeData(opts.data) } : {}),
    };
    try {
      appendLine(this.eventsFile, JSON.stringify(evt));
    } catch (err) {
      // 事件流写不进去不能拖垮主流程：退到人读日志
      this.write('warn', 'logger', `事件写入失败：${String(err)}`);
    }
  }

  /** 面板「日志」页/诊断包用：读最近 N 条事件。 */
  recentEvents(limit: number): LogEvent[] {
    const out: LogEvent[] = [];
    for (const line of readTailLines(this.eventsFile, limit)) {
      try {
        out.push(JSON.parse(line) as LogEvent);
      } catch {
        // 损坏行直接跳过，不要让日志页崩掉
      }
    }
    return out;
  }

  private write(level: LogLevel, target: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < this.levelWeight) return;
    const at = localIso();
    const suffix = data ? ` ${redact(JSON.stringify(data))}` : '';
    const line = `${at} ${level.toUpperCase().padEnd(5)} [${target}] ${redact(message)}${suffix}`;
    try {
      ensureDir(this.logDir);
      const file = path.join(this.logDir, `app-${localDate()}.log`);
      this.rotateIfNeeded(file);
      appendLine(file, line);
    } catch {
      // 磁盘满/无权限时不要因为日志而崩：镜像到控制台即可
    }
    if (this.mirror) process.stdout.write(`${line}\n`);
  }

  private rotateIfNeeded(file: string): void {
    try {
      const stat = fs.statSync(file);
      if (stat.size < this.maxFileBytes) return;
      fs.renameSync(file, `${file}.1`);
    } catch {
      // 文件不存在（首次写）或改名失败都无所谓
    }
  }
}

function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') out[k] = redact(v);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v) && v.every((item) => typeof item === 'string' || typeof item === 'number')) {
      // 简单数组保持数组形状，别被序列化成一串转义字符
      out[k] = v.map((item) => (typeof item === 'string' ? redact(item) : item));
    } else out[k] = redact(JSON.stringify(v));
  }
  return out;
}

/** 空实现（测试/纯函数里用，避免到处判空）。 */
export function nullLogger(): Logger {
  return new Logger({ logDir: path.join(process.cwd(), '.null-logs'), eventsFile: path.join(process.cwd(), '.null-events.jsonl') });
}
