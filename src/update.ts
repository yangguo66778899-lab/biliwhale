/**
 * 检查更新（M5，只做「手动检查」，不自动下载/安装）。
 *
 * 机制：配置里一个 `app.updateUrl`（留空 = 不检查），GET 回来一段 JSON：
 *   { "version": "0.7.0", "url": "https://…/BiliWhale-Setup-0.7.0.exe", "notes": "改了什么" }
 * 面板「关于」页点一下按钮就知道有没有新版；要不要下载、怎么装，由用户自己决定（§7.14 首版）。
 *
 * 不做什么：不静默下载、不自动安装、不联网做「心跳」；没有配置地址就明确说「没配置」。
 */

import type { Config } from './config/spec.ts';
import type { Logger } from './shared/logger.ts';

export interface UpdateManifest {
  version: string;
  url?: string;
  notes?: string;
}

export interface UpdateCheckResult {
  configured: boolean;
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string | null;
  notes: string | null;
  checkedAt: string;
  /** 出错时只给一句人话（不把堆栈丢给面板）。 */
  error?: string;
}

/** 语义化版本比较：返回 -1/0/1。支持 `0.7.0`、`0.7.0-M5`、`v0.7.0`。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  // 主版本一样：有 prerelease 的算旧（0.7.0-M5 < 0.7.0）
  if (pa.pre === '' && pb.pre !== '') return 1;
  if (pa.pre !== '' && pb.pre === '') return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

export function parseVersion(input: string): { major: number; minor: number; patch: number; pre: string } {
  const cleaned = String(input).trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]?(.*))?$/.exec(cleaned);
  if (!match) return { major: 0, minor: 0, patch: 0, pre: cleaned };
  return {
    major: Number(match[1] ?? 0),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: (match[4] ?? '').trim(),
  };
}

/** 只比较主.次.修（忽略 -M5 这类预发布后缀）。 */
export function compareNumeric(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  return 0;
}

export interface CheckUpdateOptions {
  config: Config;
  currentVersion: string;
  logger?: Logger;
  /** 测试注入。 */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
}

export async function checkUpdate(opts: CheckUpdateOptions): Promise<UpdateCheckResult> {
  const now = opts.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const base: UpdateCheckResult = {
    configured: false,
    current: opts.currentVersion,
    latest: null,
    hasUpdate: false,
    url: null,
    notes: null,
    checkedAt,
  };

  const updateUrl = String(opts.config.app?.updateUrl ?? '').trim();
  if (!updateUrl) {
    return { ...base, error: '还没配置检查更新的地址（设置 → 程序行为 → 检查更新的地址）' };
  }
  if (!/^https?:\/\//i.test(updateUrl)) {
    return { ...base, configured: true, error: '检查更新的地址必须是 http(s)' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(updateUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      return { ...base, configured: true, error: `检查失败：HTTP ${res.status}` };
    }
    const text = await res.text();
    const parsed = JSON.parse(text) as unknown;
    const manifest = normalizeManifest(parsed);
    if (!manifest) {
      return { ...base, configured: true, error: '返回的 JSON 里没有合法的 version 字段' };
    }
    // 只按「主.次.修」比较：0.7.0-M5 与 0.7.0 视为同一个版本（免得自己给自己弹更新）
    const hasUpdate = compareNumeric(manifest.version, opts.currentVersion) > 0;
    opts.logger?.info('update', `检查更新：当前 ${opts.currentVersion}，最新 ${manifest.version}`, { hasUpdate });
    return {
      configured: true,
      current: opts.currentVersion,
      latest: manifest.version,
      hasUpdate,
      url: manifest.url ?? null,
      notes: manifest.notes ?? null,
      checkedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, configured: true, error: `检查失败：${message}` };
  }
}

function normalizeManifest(raw: unknown): UpdateManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  if (!/^v?\d+\.\d+\.\d+/.test(version)) return null;
  return {
    version,
    ...(typeof record.url === 'string' && record.url.trim() ? { url: record.url.trim() } : {}),
    ...(typeof record.notes === 'string' ? { notes: record.notes } : {}),
  };
}
