/**
 * 时间工具。
 *
 * 职责：本地时区下的日期/时刻格式化与解析（计划时刻用「一天中的分钟」表示，跨零点窗口也安全）。
 * 不做什么：不做时区换算库、不假设中国没有夏令时（一律走系统本地时间）。
 */

/** 本地日期 `YYYY-MM-DD`。 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地时间 `YYYY-MM-DDTHH:mm:ss+08:00`（带真实偏移，便于人读与排障）。 */
export function localIso(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return (
    `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 文件名安全的本地时间戳 `YYYY-MM-DDTHH-mm-ss`（给 runs/*.json 用）。 */
export function localStamp(d: Date = new Date()): string {
  return localIso(d).slice(0, 19).replace(/:/g, '-');
}

/** 一天中的分钟数（0–1439），用本地时间。 */
export function minuteOfDay(d: Date = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** 解析 `HH:mm` / `HH:mm:ss` / `24:00` → 一天中的分钟；非法返回 null。 */
export function parseHhmm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (mi > 59 || h > 24) return null;
  if (h === 24 && mi !== 0) return null;
  return h * 60 + mi;
}

/** 分钟数 → `HH:mm`（1440 显示为 `24:00`）。 */
export function formatHhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 睡眠/卡顿检测：返回两次 tick 的间隔毫秒数。 */
export function gapMs(prev: number | null, now: number): number {
  return prev == null ? 0 : Math.max(0, now - prev);
}

/** 毫秒 → 人类可读耗时。 */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const min = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${min}m${rest}s`;
}

/** 相对日期文本：`3 天前`。 */
export function daysAgoText(fromIso: string, now: Date = new Date()): string {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return '时间未知';
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}
