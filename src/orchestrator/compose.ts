/**
 * 「说话」的两个单独阶段（P3）：写评论（评论 + @ 文案）与写日记。
 *
 * 为什么不再塞进深读那一次调用：那一次同时要打分、挑中、写理由、写报告，
 * 手上全是评价的草稿，写出来的话就长成评语。单开后这里的上下文只有
 * 「你刚看完什么 + 你当时想到什么」，输出也只有一两句话。
 *
 * 不做：不发、不判断闸门（执行仍在 share.ts / 报告在 writers.ts）。
 */

import type { Config } from '../config/spec.ts';
import type { LlmClient } from '../llm/client.ts';
import type { Logger } from '../shared/logger.ts';
import type { DeepRead, RoundResult, SelectedItem } from '../shared/types.ts';
import { stripTrailingPeriod } from '../agent/output.ts';
import { stripEmoji } from '../shared/biliEmoji.ts';
import { buildCommentPrompt, buildDiaryPrompt } from './prompts.ts';

export interface ComposeDeps {
  llm: LlmClient;
  logger: Logger;
  /** 人设原文（用户写的；没有就给空）。 */
  persona: string;
}

export interface ComposeUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

const ZERO: ComposeUsage = { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

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

/** 评论（不 @）与 @ 文案：各一句，都可以是空。 */
export async function composeComments(
  deps: ComposeDeps,
  input: { item: SelectedItem; deep: DeepRead; config: Config; ownerName: string },
): Promise<{ shareText: string; plainText: string; usage: ComposeUsage; notes: string[] }> {
  const notes: string[] = [];
  const maxChars = input.config.share.comment.maxChars;
  const prompt = buildCommentPrompt({
    deep: input.deep,
    why: input.item.why,
    oneliner: input.item.oneliner,
    ownerName: input.ownerName,
    persona: deps.persona,
    maxChars,
    wantPlain: input.config.share.comment.plain && input.item.comment?.want === true,
    wantShare: input.item.share?.channel === input.config.share.via,
  });

  const completion = await deps.llm.chat({
    messages: [
      // 用户消息开头是她的自我介绍（人设）：明确告诉模型那是「她自己」，不是材料的一部分
      { role: 'system', content: '用户消息开头是她的自我介绍，按那个说话。你在替她写两句评论，只输出 JSON，不要解释。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 400,
    temperature: 0.9,
    jsonMode: true,
  });
  const usage: ComposeUsage = completion.ok
    ? {
        calls: 1,
        promptTokens: completion.data.usage.promptTokens,
        completionTokens: completion.data.usage.completionTokens,
        cachedTokens: completion.data.usage.cachedTokens,
      }
    : { ...ZERO, calls: 1 };
  if (!completion.ok) {
    notes.push(`评论没写成（模型没响应：${completion.error.message}）`);
    deps.logger.warn('compose', `评论生成失败：${completion.error.message}`);
    return { shareText: '', plainText: '', usage, notes };
  }

  const json = extractJson(completion.data.content);
  if (!json) {
    notes.push('评论没写成（模型没按要求回 JSON）');
    deps.logger.warn('compose', '评论生成结果解析失败');
    return { shareText: '', plainText: '', usage, notes };
  }

  const clean = (value: unknown): string => clipText(stripTrailingPeriod(String(value ?? '')), maxChars);
  const plainText = clean(json.comment);
  const shareText = clean(json.share);
  if (plainText.length > 0) notes.push(`不 @ 的评论写好了（${Array.from(plainText).length} 字）`);
  return { shareText, plainText, usage, notes };
}

/** 两本日记：只输出这两段；每段都允许为空（写不出来就不写）。 */
export async function composeDiary(
  deps: ComposeDeps,
  input: { date: string; result: RoundResult; deepReads: DeepRead[] },
): Promise<{ diary: { public: string; private: string }; usage: ComposeUsage; notes: string[] }> {
  const notes: string[] = [];
  const selectedBvids = new Set(input.result.selected.map((item) => item.bvid));
  const watched = input.deepReads.map((deep) => {
    const picked = input.result.selected.find((item) => item.bvid === deep.bvid);
    const skipped = input.result.skipped.find((item) => item.bvid === deep.bvid);
    return {
      title: deep.video.title,
      up: deep.video.owner.name,
      oneLine: picked?.oneliner ?? skipped?.note ?? '',
      ...(picked ? { why: picked.why } : {}),
    };
  });
  const main = input.deepReads.find((deep) => selectedBvids.has(deep.bvid)) ?? input.deepReads[0];

  const prompt = buildDiaryPrompt({
    date: input.date,
    watched,
    persona: deps.persona,
    ...(main ? { material: { title: main.video.title, subtitle: main.subtitle, comments: main.comments } } : {}),
  });

  const completion = await deps.llm.chat({
    messages: [
      { role: 'system', content: '用户消息开头是她的自我介绍，按那个说话。你在写两段日记，只输出 JSON，不要解释。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 1200,
    temperature: 0.95,
    jsonMode: true,
  });
  const usage: ComposeUsage = completion.ok
    ? {
        calls: 1,
        promptTokens: completion.data.usage.promptTokens,
        completionTokens: completion.data.usage.completionTokens,
        cachedTokens: completion.data.usage.cachedTokens,
      }
    : { ...ZERO, calls: 1 };
  if (!completion.ok) {
    notes.push(`日记没写成（模型没响应：${completion.error.message}）`);
    deps.logger.warn('compose', `日记生成失败：${completion.error.message}`);
    return { diary: { public: '', private: '' }, usage, notes };
  }

  const json = extractJson(completion.data.content);
  if (!json) {
    notes.push('日记没写成（模型没按要求回 JSON）');
    deps.logger.warn('compose', '日记生成结果解析失败');
    return { diary: { public: '', private: '' }, usage, notes };
  }

  // 日记里不该有 B 站表情码（那是评论区的语言）；这里机械清一下
  const diary = {
    public: clipText(stripEmoji(String(json.public ?? '')), 2000),
    private: clipText(stripEmoji(String(json.private ?? '')), 2000),
  };
  return { diary, usage, notes };
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return Array.from(trimmed).length <= max ? trimmed : `${Array.from(trimmed).slice(0, max - 1).join('')}…`;
}
