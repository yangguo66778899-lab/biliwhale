/**
 * 脱敏。
 *
 * 职责：把 cookie / api key / Authorization 头从任何将要落盘或展示的字符串里抠掉。
 * 不做什么：不做加密、不做访问控制；它只是最后一道「别把秘密写进日志」的保险。
 */

const RULES: Array<{ name: string; re: RegExp; replace: string }> = [
  // B 站 cookie 的敏感项
  { name: 'sessdata', re: /(SESSDATA\s*=\s*)[^;\s"']+/gi, replace: '$1***' },
  { name: 'bili_jct', re: /(bili_jct\s*=\s*)[^;\s"']+/gi, replace: '$1***' },
  { name: 'dedeuserid__ckmd5', re: /(DedeUserID__ckMd5\s*=\s*)[^;\s"']+/gi, replace: '$1***' },
  { name: 'ac_time_value', re: /(ac_time_value\s*=\s*)[^;\s"']+/gi, replace: '$1***' },
  // Authorization 头 / Bearer token
  { name: 'bearer', re: /(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, replace: '$1***' },
  // DeepSeek / 通用 API key（sk- 前缀）
  { name: 'skkey', re: /\bsk-[A-Za-z0-9._-]{8,}/g, replace: 'sk-***' },
  // JSON 里的 key 字段
  { name: 'json_apikey', re: /("(?:apiKey|api_key|token|cookie|SESSDATA|bili_jct)"\s*:\s*")[^"]*(")/gi, replace: '$1***$2' },
  // URL 查询串里的敏感参数
  { name: 'url_token', re: /([?&](?:access_token|token|key|api_key|sign)=)[^&\s"']+/gi, replace: '$1***' },
];

/** 脱敏一个字符串；对非字符串原样返回。 */
export function redact(input: unknown): string {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const rule of RULES) text = text.replace(rule.re, rule.replace);
  return text;
}

/** 深度脱敏：对象里所有字符串字段都过一遍 redact（保留结构）。 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}

/** cookie 字符串 → 掩码摘要，便于日志里标识「哪个账号」。 */
export function cookieFingerprint(cookie: string): string {
  const mid = /DedeUserID\s*=\s*(\d+)/.exec(cookie)?.[1];
  return mid ? `mid:${mid}` : 'mid:未知';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
