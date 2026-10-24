/**
 * 日更动态（P3 之后）：每天固定时间，自己写一条。
 *
 * 和「看视频那一轮」分开：那一轮只负责看和判断，动态是另一次的「说话」——
 * 素材是今天看到的（报告与日记），加上最近几条动态（免得天天一个腔调）。
 *
 * 用户定的规矩：不跳过。没什么可说时，用自己的语气说说为什么没什么可说，短一点也行；
 * 有想说的就多说（上限 maxChars）。
 *
 * 不做：不 @ 人、不带链接、不写「本轮/候选/评分」这类账。
 */

import type { AppContext } from '../bootstrap.ts';
import type { Config } from '../config/spec.ts';
import type { LlmClient } from '../llm/client.ts';
import { loadPromptAssets } from '../agent/prompts.ts';
import { fewShotSection, voiceRules } from './prompts.ts';
import { appendDynamicNote, diaryFile, reportFile } from './writers.ts';
import { DynamicLog } from '../state/dynamicLog.ts';
import { idempotencyKey, contentHashOf } from './share.ts';
import { localIso } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';
import fs from 'node:fs';

/** 纯函数：到了今天该发的时间没有？`dailyTime` 是 "HH:MM"。 */
export function isDynamicDue(now: Date, dailyTime: string, lastDate: string | null): boolean {
  const today = localIso(now).slice(0, 10);
  if (lastDate === today) return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dailyTime.trim());
  if (!match) return false;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return now.getHours() * 60 + now.getMinutes() >= minutes;
}

export interface DynamicPromptInput {
  date: string;
  persona: string;
  /** 今天的报告正文（可能为空：今天还没跑过一轮）。 */
  reportText: string;
  diaryPublic: string;
  diaryPrivate: string;
  /** 最近发过的动态（旧 → 新）。 */
  recent: string[];
  minChars: number;
  maxChars: number;
}

export function buildDynamicPrompt(input: DynamicPromptInput): string {
  const lines: string[] = [
    // 人设原文直接贴，不加标题（人称随用户，标题会把它绑死）
    ...(input.persona.trim() ? [input.persona.trim(), ''] : []),
    `# 今天（${input.date}）`,
    input.reportText.trim() ? input.reportText.trim() : '（今天还没跑过看视频那一轮，或者什么都没看到）',
    '',
  ];
  if (input.diaryPublic.trim() || input.diaryPrivate.trim()) {
    lines.push('# 今天日记里的');
    if (input.diaryPublic.trim()) lines.push(input.diaryPublic.trim());
    if (input.diaryPrivate.trim()) lines.push('', '（自己那本）', input.diaryPrivate.trim());
    lines.push('');
  }
  if (input.recent.length > 0) {
    lines.push('# 你最近发过的');
    lines.push(...input.recent.map((text) => `- ${text}`));
    lines.push('');
  }
  lines.push(
    '# 写一条动态',
    '今天有没有想说的？有就多说几句；如果有具体的事、具体的句子，就写进去。',
    '没什么可说也没关系——用自己的语气说说为什么没什么可说（几行就行）。**不要跳过**，也别硬凑。',
    `长度：一般 ${input.minChars}–${input.maxChars} 字；短一点可以，但别写成打卡。`,
    '- 不 @ 任何人；不带链接。',
    '- 别和最近发过的重复；同样的意思换个说法也不行。',
    ...voiceRules(),
    '',
    // 动态以前没有正例：和日记共用同一批样例（用户 2026-10-24 给的 9 篇），只交代语气，不规定句式
    ...fewShotSection('这些是平时记的，动态也照这个语气写；不必整段照搬它们的结构。'),
    '只输出这个 JSON：',
    '```json',
    JSON.stringify({ text: '动态正文' }, null, 2),
    '```',
  );
  return lines.join('\n');
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface DynamicDeps {
  llm: LlmClient;
  writer: AppContext['writer'];
  quota: AppContext['quota'];
  state: AppContext['state'];
  config: Config;
  logger: AppContext['logger'];
  now?: () => Date;
}

/** 写一条（不判断发不发）：模型只负责文字。 */
export async function composeDailyDynamic(
  deps: Pick<DynamicDeps, 'llm' | 'logger'> & { persona: string },
  input: Omit<DynamicPromptInput, 'persona'>,
): Promise<{ text: string; notes: string[] }> {
  const prompt = buildDynamicPrompt({ ...input, persona: deps.persona });
  const completion = await deps.llm.chat({
    messages: [
      { role: 'system', content: '用户消息开头是她的自我介绍，按那个说话。你在写一条 B 站动态，只输出 JSON，不要解释。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 1600,
    temperature: 0.9,
    jsonMode: true,
  });
  if (!completion.ok) return { text: '', notes: [`动态没写成（模型没响应：${completion.error.message}）`] };
  const json = extractJson(completion.data.content);
  if (!json) return { text: '', notes: ['动态没写成（模型没按要求回 JSON）'] };
  const text = String(json.text ?? '').trim();
  if (!text) return { text: '', notes: ['动态没写成（模型给了空文本）'] };
  return { text, notes: [] };
}

export interface DynamicOutcome {
  status: 'sent' | 'dry_run' | 'denied' | 'failed';
  text: string;
  deny: string[];
  notes: string[];
}

/** 过闸门 + 发出去（写开关 / 急停 / 风控 / 每日上限 / 幂等）。 */
export async function executeDailyDynamic(
  deps: DynamicDeps,
  input: { text: string; dryRun: boolean; date: string },
): Promise<DynamicOutcome> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const deny: string[] = [];
  const notes: string[] = [];

  if (!cfg.dynamic.enabled) deny.push('动态开关关着');
  if (!cfg.safety.writeEnabled) deny.push('总开关「允许写操作」是关着的');
  if (cfg.safety.killSwitch) deny.push('急停开着');
  if (deps.state.inRiskCooldown(now())) deny.push('风控冷却中');
  if (cfg.dynamic.dailyCap <= 0) deny.push('动态的每日上限是 0');
  if (deps.quota.countOn(input.date, 'dynamic') >= cfg.dynamic.dailyCap) deny.push(`今天已经发过 ${cfg.dynamic.dailyCap} 条了`);

  const chars = Array.from(input.text);
  if (input.text.trim().length === 0) deny.push('没有内容');
  if (chars.length > cfg.dynamic.maxChars) deny.push(`超过 ${cfg.dynamic.maxChars} 字`);

  const text = chars.length > cfg.dynamic.maxChars ? `${chars.slice(0, cfg.dynamic.maxChars - 1).join('')}…` : input.text;
  const contentHash = contentHashOf(text);
  const key = idempotencyKey({ bvid: '', action: 'dynamic', target: 'timeline', contentHash });
  if (deps.quota.hasSentContent(key)) deny.push('同样内容已经发过（幂等）');

  if (deny.length > 0) return { status: 'denied', text, deny, notes };

  const at = localIso(now());
  const outcome = await deps.writer.postDynamic({ text }, { dryRun: input.dryRun });
  if (!outcome.ok) {
    deps.quota.add({ at, type: 'dynamic', bvid: '', target: 'timeline', share: false, status: 'failed' });
    return { status: 'failed', text, deny, notes: [`动态发送失败：${outcome.error?.message ?? '未知原因'}`] };
  }
  deps.quota.add({ at, type: 'dynamic', bvid: '', target: 'timeline', share: false, status: input.dryRun ? 'dry_run' : 'sent' });
  notes.push(input.dryRun ? '预演：动态没真发' : `动态已发（${chars.length} 字）`);
  return { status: input.dryRun ? 'dry_run' : 'sent', text, deny, notes };
}

/**
 * 调度钩子：到了点、今天还没发过，就跑一次。
 * 一天只尝试一次（成功、预演、被拒都算），失败也记下来，免得每 30 秒重试把风控喂饱。
 */
export async function runDailyDynamicIfDue(
  ctx: AppContext,
  opts: { now?: () => Date; dryRun?: boolean } = {},
): Promise<{ ran: boolean; outcome?: DynamicOutcome }> {
  const cfg = ctx.config.get();
  if (!cfg.dynamic.enabled) return { ran: false };
  if (ctx.state.get().paused) return { ran: false };
  const now = opts.now ?? (() => new Date());
  const at = now();
  if (!isDynamicDue(at, cfg.dynamic.dailyTime, ctx.state.lastDynamicDate())) return { ran: false };

  const date = localIso(at).slice(0, 10);
  const dryRun = opts.dryRun ?? false;
  const notes: string[] = [];
  try {
    const assets = loadPromptAssets(ctx.paths, cfg);
    const report = readTail(reportFile(ctx.paths, date), 6000);
    const diaries = {
      public: readTail(diaryFile(ctx.paths, 'public', date), 2000),
      private: readTail(diaryFile(ctx.paths, 'private', date), 2000),
    };
    const recent = new DynamicLog(ctx.paths.dataDir).recent(7).map((entry) => entry.text);
    const composed = await composeDailyDynamic(
      { llm: ctx.llm, logger: ctx.logger, persona: assets.persona },
      {
        date,
        reportText: report,
        diaryPublic: diaries.public,
        diaryPrivate: diaries.private,
        recent,
        minChars: cfg.dynamic.minChars,
        maxChars: cfg.dynamic.maxChars,
      },
    );
    notes.push(...composed.notes);
    const outcome = await executeDailyDynamic(
      { llm: ctx.llm, writer: ctx.writer, quota: ctx.quota, state: ctx.state, config: cfg, logger: ctx.logger, now },
      { text: composed.text, dryRun, date },
    );
    notes.push(...outcome.notes);

    if (outcome.status === 'sent' || outcome.status === 'dry_run') {
      ctx.state.markDynamic(localIso(at));
      if (outcome.status === 'sent') new DynamicLog(ctx.paths.dataDir).append({ at: localIso(at), text: outcome.text });
    } else {
      ctx.state.markDynamic(localIso(at));
    }
    try {
      appendDynamicNote(ctx.paths, {
        date,
        at: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
        ...(outcome.status === 'sent' || outcome.status === 'dry_run' ? { text: outcome.text } : {}),
        ...(outcome.status === 'sent' || outcome.status === 'dry_run' ? {} : { reason: [...outcome.deny, ...outcome.notes].join('；') || '没写成' }),
        dryRun: dryRun || outcome.status === 'dry_run',
      });
    } catch (err) {
      notes.push(`动态写进报告失败：${humanError(err)}`);
    }
    ctx.logger.event('dynamic', `日更动态：${outcome.status}`, {
      level: outcome.status === 'failed' ? 'error' : 'info',
      data: { chars: Array.from(outcome.text).length, deny: outcome.deny },
    });
    return { ran: true, outcome };
  } catch (err) {
    ctx.logger.error('dynamic', `日更动态出错：${humanError(err)}`);
    return { ran: true };
  }
}

function readTail(file: string, maxChars: number): string {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length <= maxChars ? text : text.slice(text.length - maxChars);
  } catch {
    return '';
  }
}
