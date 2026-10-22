/**
 * 与主人的聊天记录（`chat/owner.jsonl`）。
 *
 * 职责：追加一行一条 {at, from, text, attach?}；读最近 N 条；清理 30 天前；面板可清空。
 *   - 只记主人相关的会话（陌生人私信不进这里，也不回）；
 *   - 不存 cookie/路径/内部 id（调用方负责，这里再兜一层 strip）。
 * 不做什么：不调用模型、不发私信（在 orchestrator/chat.ts）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../shared/logger.ts';
import { appendText, ensureDir, writeTextAtomic } from '../shared/atomic.ts';
import { localIso } from '../shared/time.ts';

export type ChatRole = 'owner' | 'self';

export interface ChatLine {
  at: string;
  from: ChatRole;
  text: string;
  /** 我们回复时附带的东西（面板展示用）。 */
  attach?: { kind: 'diary' | 'video_info'; bvid?: string };
  /** 是不是从面板手动发的。 */
  manual?: boolean;
  /** 对应哪条私信（去重用：每条来信最多回一条）。 */
  msgKey?: string;
}

const KEEP_DAYS = 30;

export class ChatStore {
  readonly file: string;
  private readonly logger: Logger;

  constructor(file: string, logger: Logger) {
    this.file = file;
    this.logger = logger;
  }

  /** 追加一条（失败不抛：聊天不该因为写日志失败而中断）。 */
  append(line: ChatLine): void {
    try {
      ensureDir(path.dirname(this.file));
      appendText(this.file, `${JSON.stringify(sanitize(line))}\n`);
    } catch (err) {
      this.logger.warn('chat', `聊天记录写入失败：${String(err)}`);
    }
  }

  /** 读最近 limit 条（时间正序）。 */
  recent(limit = 10): ChatLine[] {
    return this.all().slice(-Math.max(1, limit));
  }

  all(): ChatLine[] {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: ChatLine[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed !== 'object' || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        if (typeof record.text !== 'string' || typeof record.at !== 'string') continue;
        out.push({
          at: record.at,
          from: record.from === 'owner' ? 'owner' : 'self',
          text: record.text,
          ...(record.attach && typeof record.attach === 'object' ? { attach: record.attach as ChatLine['attach'] } : {}),
          ...(record.manual === true ? { manual: true } : {}),
          ...(typeof record.msgKey === 'string' ? { msgKey: record.msgKey } : {}),
        });
      } catch {
        continue;
      }
    }
    return out;
  }

  /** 清空（面板动作，二次确认在 UI）。返回删了多少行。 */
  clear(): number {
    const count = this.all().length;
    try {
      ensureDir(path.dirname(this.file));
      writeTextAtomic(this.file, '');
    } catch (err) {
      this.logger.warn('chat', `清空聊天记录失败：${String(err)}`);
      return 0;
    }
    this.logger.info('chat', `聊天记录已清空（${count} 条）`);
    return count;
  }

  /** 清理 30 天前的行（daemon 起来时调一次就够）。 */
  prune(now: Date = new Date()): number {
    const lines = this.all();
    const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
    const kept = lines.filter((line) => {
      const at = Date.parse(line.at);
      return Number.isFinite(at) ? at >= cutoff : true;
    });
    const removed = lines.length - kept.length;
    if (removed > 0) {
      try {
        ensureDir(path.dirname(this.file));
        writeTextAtomic(this.file, kept.map((line) => JSON.stringify(sanitize(line))).join('\n') + (kept.length > 0 ? '\n' : ''));
        this.logger.info('chat', `清理了 ${removed} 条 30 天前的聊天记录`);
      } catch (err) {
        this.logger.warn('chat', `清理聊天记录失败：${String(err)}`);
      }
    }
    return removed;
  }

  /** 给自己用：最后一条是谁说的、什么时候。 */
  last(): ChatLine | null {
    return this.all().at(-1) ?? null;
  }

  /** 这些 msgKey 是不是已经回过了（每条来信最多回一条）。 */
  repliedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const line of this.all()) if (line.from === 'self' && line.msgKey) keys.add(line.msgKey);
    return keys;
  }

  /** 最近一小时我们发了几条（聊天频率 ≤20 条/小时）。 */
  sentInLastHour(now: Date = new Date()): number {
    const cutoff = now.getTime() - 3_600_000;
    return this.all().filter((line) => line.from === 'self' && Date.parse(line.at) >= cutoff).length;
  }

  /** 今天的记录（面板「今天聊了什么」用）。 */
  today(now: Date = new Date()): ChatLine[] {
    const date = localIso(now).slice(0, 10);
    return this.all().filter((line) => line.at.startsWith(date));
  }
}

/** 去掉可能的敏感片段（cookie/路径），并限制长度。 */
function sanitize(line: ChatLine): ChatLine {
  const text = String(line.text)
    .replace(/SESSDATA=[^;\s]+/gi, 'SESSDATA=***')
    .replace(/bili_jct=[^;\s]+/gi, 'bili_jct=***')
    .slice(0, 2000);
  return { ...line, text };
}
