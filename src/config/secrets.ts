/**
 * 凭据存储。
 *
 * 职责：DeepSeek API key 与 B 站 cookie 的唯一落点（`<data>/secrets.json`，仅当前用户可读）。
 *   环境变量可覆盖（开发/高级用户）：`BILIWHALE_API_KEY`、`BILIWHALE_COOKIE`。
 * 不做什么：不回显（对外只给 `hasKey` / 账号摘要）、不写日志、不导出。
 *
 * 首版说明：本机明文存储，文件权限为仅当前用户可读（POSIX 权限位在 Windows 上不生效，
 * 真正的 ACL 收紧与 DPAPI 加密在 M5 打包阶段做；面板会明示这一点）。
 */

import path from 'node:path';
import { readJson, writeJsonAtomic } from '../shared/atomic.ts';
import { cookieFingerprint } from '../shared/redact.ts';
import type { Logger } from '../shared/logger.ts';

export interface Secrets {
  version: number;
  llm?: { apiKey?: string };
  bili?: {
    cookie?: string;
    /** 登录后回填，仅用于显示「已登录：昵称（mid）」，不参与请求。 */
    mid?: number;
    uname?: string;
    savedAt?: string;
  };
}

export class SecretsService {
  readonly file: string;
  private readonly logger: Logger;
  private secrets: Secrets = { version: 1 };

  constructor(dataDir: string, logger: Logger) {
    this.logger = logger;
    this.file = path.join(dataDir, 'secrets.json');
    const read = readJson<Secrets>(this.file);
    if (read.ok && read.value && typeof read.value === 'object') {
      this.secrets = { ...read.value, version: 1 };
    } else if (!read.ok && read.corrupt) {
      this.logger.warn('secrets', '凭据文件损坏，已忽略（需要重新填写）');
    }
  }

  /** DeepSeek key：环境变量优先。 */
  apiKey(): string {
    const env = process.env.BILIWHALE_API_KEY?.trim();
    if (env) return env;
    return this.secrets.llm?.apiKey?.trim() ?? '';
  }

  hasApiKey(): boolean {
    return this.apiKey().length > 0;
  }

  /** B 站 cookie：环境变量优先。 */
  cookie(): string {
    const env = process.env.BILIWHALE_COOKIE?.trim();
    if (env) return env;
    return this.secrets.bili?.cookie?.trim() ?? '';
  }

  hasCookie(): boolean {
    return this.cookie().length > 0;
  }

  /**
   * 写操作要的 csrf（bili_jct）。
   * 从 cookie 里解析；没有就返回空串——上层据此报「重新登录」，绝不猜。
   */
  biliJct(): string {
    const cookie = this.cookie();
    if (!cookie) return '';
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.split('=');
      if (name?.trim() === 'bili_jct') return rest.join('=').trim();
    }
    return '';
  }

  /** 当前登录账号（鲸鲸）自己的 mid：发送方身份、跳过「自己回自己」。主人是另一回事（account.ownerMid）。 */
  selfMid(): number {
    const fromSecrets = Number(this.secrets.bili?.mid ?? 0);
    if (Number.isFinite(fromSecrets) && fromSecrets > 0) return fromSecrets;
    const cookie = this.cookie();
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.split('=');
      if (name?.trim() === 'DedeUserID') {
        const value = Number(rest.join('=').trim());
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
    return 0;
  }

  /** 只给摘要，不给原值。 */
  accountHint(): { hasCookie: boolean; fingerprint: string; uname?: string; mid?: number } {
    const cookie = this.cookie();
    return {
      hasCookie: cookie.length > 0,
      fingerprint: cookie ? cookieFingerprint(cookie) : '未登录',
      ...(this.secrets.bili?.uname ? { uname: this.secrets.bili.uname } : {}),
      ...(this.secrets.bili?.mid ? { mid: this.secrets.bili.mid } : {}),
    };
  }

  setApiKey(apiKey: string): void {
    this.secrets.llm = { apiKey: apiKey.trim() };
    this.save();
  }

  setCookie(cookie: string, account?: { mid?: number; uname?: string }): void {
    this.secrets.bili = {
      cookie: cookie.trim(),
      savedAt: new Date().toISOString(),
      ...(account?.mid ? { mid: account.mid } : {}),
      ...(account?.uname ? { uname: account.uname } : {}),
    };
    this.save();
  }

  /** 登录后回填账号信息（不碰 cookie 本身）。 */
  setAccount(account: { mid?: number; uname?: string }): void {
    const cookie = this.secrets.bili?.cookie ?? '';
    this.secrets.bili = {
      ...(this.secrets.bili ?? {}),
      cookie,
      ...(account.mid ? { mid: account.mid } : {}),
      ...(account.uname ? { uname: account.uname } : {}),
    };
    if (cookie) this.save();
  }

  /** 只清本地，不调远端登出（避免把浏览器里的会话一起吊销）。 */
  clearCookie(): void {
    delete this.secrets.bili;
    this.save();
  }

  private save(): void {
    writeJsonAtomic(this.file, this.secrets);
  }
}

/**
 * 从粘贴的 cookie 字符串里挑出要用的项，并做基本校验。
 * 只发 SESSDATA / bili_jct / buvid3（参考实现的共识：DedeUserID 不需要发）。
 */
export function normalizeCookie(raw: string): { ok: true; cookie: string; warnings: string[] } | { ok: false; error: string } {
  const warnings: string[] = [];
  const pairs = new Map<string, string>();
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) pairs.set(key, value);
  }

  const sessdata = pairs.get('SESSDATA');
  if (!sessdata) return { ok: false, error: '缺少 SESSDATA（HttpOnly，需要从 F12 → Network 里复制）' };

  let biliJct = pairs.get('bili_jct') ?? '';
  if (biliJct && !/^[0-9a-f]{32}$/i.test(biliJct)) {
    // 常见坑：把 DedeUserID 粘到 bili_jct 上了
    const dede = pairs.get('DedeUserID');
    if (dede && /^[0-9a-f]{32}$/i.test(dede)) {
      biliJct = dede;
      warnings.push('bili_jct 看起来填成了别的值，已用 DedeUserID 位置的值尝试');
    } else {
      warnings.push('bili_jct 不是 32 位十六进制：写操作会失败（读操作仍可用）');
      biliJct = '';
    }
  }
  if (!biliJct) warnings.push('没有可用 bili_jct：只能读，不能写');

  const buvid3 = pairs.get('buvid3') ?? '';
  if (!buvid3) warnings.push('没有 buvid3：会尝试用指纹接口补（可能影响搜索接口）');

  const parts = [`SESSDATA=${sessdata}`];
  if (biliJct) parts.push(`bili_jct=${biliJct}`);
  if (buvid3) parts.push(`buvid3=${buvid3}`);
  return { ok: true, cookie: parts.join('; '), warnings };
}
