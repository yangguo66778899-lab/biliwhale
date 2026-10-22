/**
 * 运行时握手文件。
 *
 * 职责：把「内核现在在哪个端口、用什么 token」写到 `<local>/runtime.json`，供托盘/第二个实例读取；
 *   把「还活着吗、下一轮什么时候」写到 `<local>/heartbeat.json`，供壳与诊断判断存活。
 * 不做什么：不保存凭据（token 只用于本地 HTTP，文件权限 600）、不做健康检查（http 层）。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from '../shared/atomic.ts';
import type { Paths } from '../state/paths.ts';

export interface RuntimeInfo {
  pid: number;
  port: number;
  /** 本地 HTTP 的一次性 token；托盘用它拼 URL，永不进日志。 */
  token: string;
  version: string;
  startedAt: string;
  dataDir: string;
  url: string;
}

export interface Heartbeat {
  pid: number;
  at: string;
  uptimeSec: number;
  version: string;
  running: boolean;
  paused: boolean;
  nextWakeAt: string | null;
  lastRunStatus: string | null;
}

/** 32 字节随机 token（16 进制 64 位）。 */
export function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function writeRuntime(paths: Paths, info: RuntimeInfo): void {
  writeJsonAtomic(paths.runtime, info);
  try {
    fs.chmodSync(paths.runtime, 0o600);
  } catch {
    /* Windows 上 chmod 基本没作用，真正的 ACL 收紧在 M5 处理 */
  }
}

export function readRuntime(paths: Paths): RuntimeInfo | null {
  const read = readJson<RuntimeInfo>(paths.runtime);
  if (!read.ok || !read.value) return null;
  const info = read.value;
  if (typeof info.port !== 'number' || typeof info.token !== 'string') return null;
  return info;
}

export function clearRuntime(paths: Paths): void {
  for (const file of [paths.runtime, `${paths.runtime}.bak`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 删不掉不影响下次启动覆盖 */
    }
  }
}

export function writeHeartbeat(paths: Paths, beat: Heartbeat): void {
  writeJsonAtomic(paths.heartbeat, beat);
}

export function readHeartbeat(paths: Paths): Heartbeat | null {
  const read = readJson<Heartbeat>(paths.heartbeat);
  return read.ok ? read.value : null;
}

/** 心跳还新鲜吗（默认 90 秒内算活）。 */
export function heartbeatFresh(beat: Heartbeat | null, maxAgeMs = 90_000, now: Date = new Date()): boolean {
  if (!beat) return false;
  const at = Date.parse(beat.at);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= maxAgeMs;
}
