/**
 * 产出落盘：日报 / 两本日记 / 月度归档 / 通知文件。
 *
 * 职责：把结构化结果写成给人看的 Markdown。
 *   - 报告骨架由代码生成（格式稳定；配额绝不从报告里数）
 *   - 日记正文由模型写，代码只加日期与轮次标记
 *   - 归档一行一条，供以后回头翻
 * 不做什么：不判断该不该发、不算额度、不拼模型 prompt。
 */

import path from 'node:path';
import fs from 'node:fs';
import { appendText, ensureDir, writeTextAtomic } from '../shared/atomic.ts';
import type { GateDecision } from './gate.ts';
import type { Paths } from '../state/paths.ts';
import type { RoundResult, RunCounts } from '../shared/types.ts';
import { formatHhmm } from '../shared/time.ts';

export interface VideoMeta {
  title: string;
  up: string;
  durationText: string;
  ageText: string;
  url: string;
}

/** 报告里只需要这几项（避免把执行器类型泄漏进 writers）。 */
export interface ShareAttemptView {
  status: 'sent' | 'held' | 'unverified' | 'failed' | 'denied' | 'dry_run';
  content: string;
  rpid?: string;
  verified?: boolean;
  deny: string[];
  error?: string;
}

export interface ReportInput {
  date: string;
  roundLabel: string;
  level: 'full' | 'brief' | 'off';
  result: RoundResult;
  counts: RunCounts;
  videos: Map<string, VideoMeta>;
  shareDecisions: Map<string, GateDecision>;
  /** 真正执行后的结果（有就按它渲染，比闸门结论更准）。 */
  shareAttempts?: Map<string, ShareAttemptView>;
  usage: { promptTokens: number; completionTokens: number; costCny: number };
  dryRun: boolean;
  notes: string[];
  /** 「今天为什么没做」（由 orchestrator/whynot.ts 生成，一行一条）。 */
  whyNot?: Array<{ label: string; text: string }>;
  /** 看画面的结论（§7.10）：一行，「看了画面：…」或「没看画面：<原因>」。 */
  media?: { text: string };
}

export function videoUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

/** 当天的报告文件（一天一份，多轮追加）。 */
export function reportFile(paths: Paths, date: string): string {
  return path.join(paths.reportsDir, `${date}.md`);
}

export function diaryFile(paths: Paths, kind: 'public' | 'private', date: string): string {
  return path.join(kind === 'public' ? paths.diariesPublicDir : paths.diariesPrivateDir, `${date}.md`);
}

export function archiveFile(paths: Paths, date: string): string {
  return path.join(paths.archiveDir, `${date.slice(0, 7)}.md`);
}

/** 文件不存在时先写标题；已存在就原样返回（多轮追加不能重复写标题）。 */
function ensureHeader(file: string, header: string, intro?: string): void {
  if (fs.existsSync(file)) return;
  ensureDir(path.dirname(file));
  writeTextAtomic(file, intro ? `${header}\n\n${intro}\n` : `${header}\n`, { backup: false });
}

export function buildReportSection(input: ReportInput): string {
  const { result, counts, videos, shareDecisions, shareAttempts } = input;
  if (input.level === 'off') return '';

  const lines: string[] = [];
  lines.push(`## ${input.roundLabel}`);
  lines.push('');
  const head = `> 看了 ${counts.screened} 条，深读 ${counts.deepRead} 条，挑中 ${counts.selected} 条，分享 ${counts.shared} 条${input.dryRun ? '（预演，未真的发）' : ''}；本轮 ${formatTokens(input.usage.promptTokens + input.usage.completionTokens)} token。`;
  lines.push(head);
  lines.push('');

  // 看画面到底看没看：用户不用翻日志就知道这次模型有没有图可看（§7.10）
  if (input.media) {
    lines.push(input.media.text);
    lines.push('');
  }

  // 用户最常问的「收藏不是开着吗，怎么没收藏」：两种档位都要写，不用去翻执行日志
  if (input.whyNot && input.whyNot.length > 0) {
    lines.push('### 今天为什么没做');
    for (const line of input.whyNot) lines.push(`- ${line.label}：${line.text}`);
    lines.push('');
  }

  if (input.level === 'brief') {
    const lede = cleanProse(result.report_md, 400);
    if (lede) {
      lines.push(lede);
      lines.push('');
    }
    for (const item of result.selected) {
      const meta = videos.get(item.bvid);
      lines.push(`- ${item.oneliner}${meta ? ` —— [${meta.title}](${meta.url})` : ''}`);
    }
    if (result.skipped.length > 0) lines.push(`- 跳过 ${result.skipped.length} 条（${summarizeSkip(result)}）`);
    // brief 也要留下降级/失效这类关键信息，否则用户看不出「今天为什么这么少」
    const briefNotes = input.notes.map(cleanNote).filter((note) => note.length > 0);
    if (briefNotes.length > 0) lines.push(`- 备注：${briefNotes.join('；')}`);
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  // 她自己写的这一轮记录（report_md）。有就放在最前面，不再和「为什么值得」重复。
  const lede = cleanProse(result.report_md, 4000);
  if (lede) {
    lines.push('### 这一轮');
    lines.push('');
    lines.push(lede);
    lines.push('');
  }

  lines.push('### 挑中的');
  lines.push('');
  if (result.selected.length === 0) {
    lines.push('今天没有值得占你注意力的。');
    lines.push('');
  } else {
    for (const item of result.selected) {
      const meta = videos.get(item.bvid);
      lines.push(`#### ${item.bvid} · ${meta?.title ?? '（标题没取到）'}`);
      if (meta) {
        lines.push(`- ${meta.up} · ${meta.durationText} · ${meta.ageText} · [打开](${meta.url})`);
      }
      lines.push(`- 分数：${item.score}/20`);
      lines.push(`- 为什么值得：${item.why}`);
      lines.push(`- 一句话：${item.oneliner}`);
      const attempt = shareAttempts?.get(item.bvid);
      const decision = shareDecisions.get(item.bvid);
      if (attempt) {
        renderShareAttempt(lines, attempt);
      } else if (decision) {
        if (decision.allow) {
          lines.push(`- 分享：${item.share?.channel ?? '未指定'}（${input.dryRun ? '预演，未执行' : '已通过闸门'}）`);
        } else {
          lines.push(`- 没发：${decision.deny.join('；')}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('### 看过的（跳过）');
  lines.push('');
  if (result.skipped.length === 0) {
    lines.push('（没有跳过的条目）');
  } else {
    for (const item of result.skipped) {
      const meta = videos.get(item.bvid);
      const note = item.note ? `（${cleanNote(item.note)}）` : '';
      lines.push(`- ${item.bvid} · ${meta?.title ?? '（标题没取到）'} · ${skipReasonText(item.reason)}${note}`);
    }
  }
  lines.push('');

  lines.push('### 今天的账');
  lines.push('');
  lines.push(`- 候选 ${counts.candidates} → 初筛 ${counts.screened} → 深读 ${counts.deepRead} → 挑中 ${counts.selected} → 分享 ${counts.shared}`);
  if (counts.skippedNoSubtitle > 0) lines.push(`- 因无字幕跳过 ${counts.skippedNoSubtitle} 条`);
  // 收藏与动态各自受开关控制：没开就不写进报告，否则等于替模型谎报「已经做了」。
  // （模型有时会在正文里写「我把它收藏了」——只负责报告不跟着撒谎，正文那句靠提示词约束。）
  lines.push('');

  // 排障用的备注单独放，别混进给人看的那几段
  const notes = input.notes.map(cleanNote).filter((note) => note.length > 0);
  if (notes.length > 0) {
    lines.push('### 运行备注（排障用）');
    lines.push('');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/** 备注收尾：去掉句末的逗号/顿号/分号（模型有时句子没写完），并压成一行。 */
function cleanNote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[，,、；;：:]+$/u, '');
}

/** 模型写的正文：保留段落，只做长度与首尾清理。 */
function cleanProse(text: string, max: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** 把一次分享尝试写成两三行（人话，不掺内部术语）。 */
function renderShareAttempt(lines: string[], attempt: ShareAttemptView): void {
  const rpidText = attempt.rpid ? `（rpid ${attempt.rpid}）` : '';
  switch (attempt.status) {
    case 'sent':
      lines.push(`- 分享：评论已发出${rpidText}${attempt.verified ? '，复核通过' : ''}`);
      break;
    case 'unverified':
      lines.push(`- 分享：已发出${rpidText}，但复核没通过（不自动重发）`);
      break;
    case 'held':
      // 评论确实发出去了，只是 B 站把它挂起了（仅自己可见/审核中）——报告必须这么说，
      // 否则用户过一会儿在 B 站看到评论，会以为程序在骗他（审计 §3.1）
      lines.push(`- 分享：评论已发出${rpidText}，但被 B 站挂起了（公开区看不到，主人可能收不到 @ 通知；不自动重发）`);
      break;
    case 'dry_run':
      lines.push('- 分享：预演（没真的发）');
      break;
    case 'failed':
      lines.push(`- 分享失败：${attempt.error ?? '未知原因'}（不自动重发）`);
      break;
    case 'denied':
    default:
      lines.push(`- 没发：${attempt.deny.join('；') || '闸门没过'}`);
      break;
  }
  if (attempt.status === 'sent' || attempt.status === 'held' || attempt.status === 'unverified' || attempt.status === 'dry_run') {
    lines.push(`- 文案：${attempt.content}`);
  }
}

/** 写报告：off 不写；其余追加到当天文件。 */
export function writeReport(paths: Paths, input: ReportInput): string | null {
  if (input.level === 'off') return null;
  const file = reportFile(paths, input.date);
  ensureHeader(file, `# ${input.date} · 今日刷到的`, '> 这一天她醒了几次、看了几条、挑中几条、花了多少 token。多轮会往下追加。');
  const section = buildReportSection(input);
  if (!section) return file;
  appendText(file, `\n${section}`);
  return file;
}

/** 写日记：两本都写；代码只加日期/轮次标记。 */
export function writeDiary(
  paths: Paths,
  input: { date: string; label: string; kind: 'public' | 'private'; title: string; body: string },
): string {
  const file = diaryFile(paths, input.kind, input.date);
  ensureHeader(file, `# ${input.date} · ${input.title}`);
  appendText(file, `\n## ${input.label}\n\n${input.body.trim()}\n`);
  return file;
}

/** 月度归档：一行一条，供以后回头翻。 */
export function writeArchive(
  paths: Paths,
  input: {
    date: string;
    label: string;
    rows: Array<{ bvid: string; title: string; up: string; conclusion: string }>;
  },
): string | null {
  if (input.rows.length === 0) return null;
  const file = archiveFile(paths, input.date);
  ensureHeader(file, `# ${input.date.slice(0, 7)} 归档`, '> 每条看过的都记一行：日期 · BV · 标题 · UP · 结论 · 链接。');
  const lines = input.rows
    .map((row) => `${input.date} · ${row.bvid} · ${row.title.replace(/\n/g, ' ')} · ${row.up} · ${row.conclusion} · ${videoUrl(row.bvid)}`)
    .join('\n');
  appendText(file, `${lines}\n`);
  return file;
}

/** 通知文件出口（默认渠道；其它渠道见 notify/index.ts）。 */
export function appendNotifyLog(paths: Paths, text: string, at: Date = new Date()): string {
  ensureDir(path.dirname(paths.notifyLog));
  appendText(paths.notifyLog, `[${formatHhmm(at.getHours() * 60 + at.getMinutes())}] ${text.trim()}\n`);
  return paths.notifyLog;
}

export function skipReasonText(reason: string): string {
  switch (reason) {
    case 'no_subtitle':
      return '无字幕/无语音';
    case 'low_score':
      return '分数不够';
    case 'duplicate':
      return '重复';
    case 'irrelevant':
      return '不相关';
    case 'tool_error':
      return '工具失败';
    case 'too_old':
      return '太旧';
    default:
      return '其它';
  }
}

function summarizeSkip(result: RoundResult): string {
  const counts = new Map<string, number>();
  for (const item of result.skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${skipReasonText(reason)} ${n}`).join('、');
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
