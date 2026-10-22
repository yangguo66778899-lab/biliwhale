/**
 * 数据保留期（§7.7 / 审计 §2.6）。
 *
 * 以前 `logging.*RetentionDays` 四个配置项零引用：账本、run 记录、事件、日志、报告日记无限增长，
 * 只按天切分。这里在「启动 + 每天第一次 tick」各跑一次，超期的删掉。
 *
 * 不做什么：不删用户没配置保留期的东西（聊天记录是固定 30 天，单独由 chat.prune 管）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/spec.ts';
import type { Paths } from './paths.ts';
import type { Logger } from '../shared/logger.ts';
import type { SeenLedger, QuotaLedger } from './ledgers.ts';
import type { RunStore } from './runs.ts';

export interface PruneDeps {
  paths: Paths;
  config: Config;
  logger: Logger;
  seen: SeenLedger;
  quota: QuotaLedger;
  runs: RunStore;
  now?: () => Date;
}

export interface PruneResult {
  seen: number;
  quota: number;
  runs: number;
  events: number;
  logs: number;
  docs: number;
  notes: string[];
}

/** 跑一次保留期清理（幂等、失败只记日志不影响主流程）。 */
export function pruneData(deps: PruneDeps): PruneResult {
  const now = deps.now?.() ?? new Date();
  const result: PruneResult = { seen: 0, quota: 0, runs: 0, events: 0, logs: 0, docs: 0, notes: [] };
  const cfg = deps.config.logging;

  try {
    // 判重账本：按「多久没再见到」清
    result.seen = deps.seen.prune(Math.max(1, cfg.retentionDays), now);
  } catch (err) {
    result.notes.push(`判重账本清理失败：${String(err)}`);
  }

  try {
    const cutoff = new Date(now.getTime() - Math.max(1, cfg.retentionDays) * 86_400_000).toISOString();
    result.quota = deps.quota.prune(cutoff);
  } catch (err) {
    result.notes.push(`账本清理失败：${String(err)}`);
  }

  try {
    result.runs = deps.runs.prune(Math.max(1, cfg.runsRetentionDays), now);
  } catch (err) {
    result.notes.push(`运行记录清理失败：${String(err)}`);
  }

  try {
    result.events = pruneEvents(deps.paths.events, Math.max(1, cfg.eventsRetentionDays), now);
  } catch (err) {
    result.notes.push(`事件清理失败：${String(err)}`);
  }

  try {
    result.logs = pruneLogs(deps.paths.logsDir, Math.max(1, cfg.retentionDays), now);
  } catch (err) {
    result.notes.push(`日志清理失败：${String(err)}`);
  }

  try {
    result.docs = pruneDocs(
      [deps.paths.reportsDir, deps.paths.diariesPublicDir, deps.paths.diariesPrivateDir, deps.paths.archiveDir],
      Math.max(1, cfg.docsRetentionDays),
      now,
    );
  } catch (err) {
    result.notes.push(`报告/日记清理失败：${String(err)}`);
  }

  const total = result.seen + result.quota + result.runs + result.events + result.logs + result.docs;
  if (total > 0) {
    deps.logger.info('prune', `保留期清理：删了 ${total} 项`, { ...result });
    deps.logger.event('prune', `保留期清理：删了 ${total} 项`, { target: 'prune', data: { ...result } });
  }
  for (const note of result.notes) deps.logger.warn('prune', note);
  return result;
}

/** events.jsonl：逐行判断时间，留下还没过期的。 */
export function pruneEvents(file: string, keepDays: number, now: Date): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - keepDays * 86_400_000;
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    let at = Number.NaN;
    try {
      at = Date.parse((JSON.parse(line) as { at?: string }).at ?? '');
    } catch {
      at = Number.NaN;
    }
    if (Number.isFinite(at) && at < cutoff) removed += 1;
    else kept.push(line);
  }
  if (removed > 0) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }
  return removed;
}

/** logs/app-YYYY-MM-DD.log：按文件名里的日期删（含 .1 滚动文件）。 */
export function pruneLogs(dir: string, keepDays: number, now: Date): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays).getTime();
  let removed = 0;
  for (const name of names) {
    const match = /^app-(\d{4})-(\d{2})-(\d{2})\.log/.exec(name);
    if (!match) continue;
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    if (day >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      /* 删不掉就留着，下次再说 */
    }
  }
  return removed;
}

/** reports/diaries/archive 下 YYYY-MM-DD.md（归档是 YYYY-MM.md，按月末算）。 */
export function pruneDocs(dirs: string[], keepDays: number, now: Date): number {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays).getTime();
  let removed = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const dayMatch = /^(\d{4})-(\d{2})-(\d{2})\.md$/.exec(name);
      const monthMatch = /^(\d{4})-(\d{2})\.md$/.exec(name);
      let stamp: number | null = null;
      if (dayMatch) stamp = new Date(Number(dayMatch[1]), Number(dayMatch[2]) - 1, Number(dayMatch[3])).getTime();
      else if (monthMatch) stamp = new Date(Number(monthMatch[1]), Number(monthMatch[2]), 0).getTime();
      if (stamp === null || stamp >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}
