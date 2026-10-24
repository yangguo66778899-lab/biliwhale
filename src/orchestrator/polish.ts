/**
 * 收尾抛光（P3）：把模型写的日记/评论过一遍「可数的自检」，不合格就修。
 *
 * 顺序（便宜的先做）：
 *   1. 机械修：评论末尾句号、日记里的表情码——位置确定，不必再问模型；
 *   2. 还有「要重新组织语言」的问题（数据话、汇报腔、太长、表情太多）→ 只重写这几处，花一次模型调用；
 *   3. 重写完再机械过一遍；仍不合格就保留原文，并在报告备注里说清（不假装修好了）。
 */

import type { Config } from '../config/spec.ts';
import type { LlmClient } from '../llm/client.ts';
import type { Logger } from '../shared/logger.ts';
import type { RoundResult } from '../shared/types.ts';
import { applyMechanicalFixes, rewriteInstruction, selfCheck } from '../agent/selfCheck.ts';
import type { SelfCheckInput, SelfCheckText } from '../agent/selfCheck.ts';
import { stripTrailingPeriod } from '../agent/output.ts';

export interface PolishDeps {
  llm: LlmClient;
  logger: Logger;
}

export interface ComposeUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

const ZERO_USAGE: ComposeUsage = { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

/** 统一出口：机械修也可能没花模型调用，usage 就是 0。 */
function done(result: RoundResult, notes: string[], usage: ComposeUsage = ZERO_USAGE) {
  return { result, notes, usage };
}

function collect(result: RoundResult, cfg: Config): SelfCheckText[] {
  const out: SelfCheckText[] = [];
  for (const item of result.selected) {
    if (item.comment?.want && item.comment.text.trim().length > 0) {
      out.push({ bvid: item.bvid, kind: 'plain', text: item.comment.text });
    }
    const shareText = item.share?.text?.trim() ?? '';
    // 私信分享不走「评论」的标点/表情口径（那是私信，像聊天），只查 @ 评论
    if (shareText.length > 0 && item.share?.channel === 'comment') {
      out.push({ bvid: item.bvid, kind: 'share', text: shareText });
    }
  }
  return out;
}

function toInput(result: RoundResult, cfg: Config, comments: SelfCheckText[]): SelfCheckInput {
  return {
    diary: result.diary,
    comments,
    maxCommentChars: cfg.share.comment.maxChars,
    maxShareChars: cfg.share.comment.maxChars,
  };
}

export async function polishResult(
  deps: PolishDeps,
  result: RoundResult,
  cfg: Config,
  options: { allowRewrite?: boolean } = {},
): Promise<{ result: RoundResult; notes: string[]; usage: ComposeUsage }> {
  const notes: string[] = [];
  const original = collect(result, cfg);
  if (original.length === 0 && result.diary.public.trim().length === 0) return done(result, notes);

  const firstPass = selfCheck(toInput(result, cfg, original));
  if (firstPass.length === 0) return done(result, notes);

  // 1) 机械修
  const fixed = applyMechanicalFixes(toInput(result, cfg, original));
  const afterMechanical = selfCheck(fixed);
  const rewriteNeeded = afterMechanical.filter((issue) => issue.action === 'rewrite');
  let next: RoundResult = {
    ...result,
    diary: fixed.diary,
    selected: result.selected.map((item) => {
      const plain = fixed.comments.find((c) => c.bvid === item.bvid && c.kind === 'plain');
      const share = fixed.comments.find((c) => c.bvid === item.bvid && c.kind === 'share');
      return {
        ...item,
        ...(plain && item.comment ? { comment: { ...item.comment, text: plain.text } } : {}),
        ...(share && item.share ? { share: { ...item.share, text: share.text } } : {}),
      };
    }),
  };

  if (rewriteNeeded.length === 0) {
    deps.logger.info('polish', `机械修掉 ${firstPass.length} 处（句号/表情）`);
    return done(next, notes);
  }

  // 重写没开（或降级轮）：只做机械修。**不往报告里塞「还有 N 处不合口径」**——
  // 用户看不到重写这回事，写了只会让人以为出了错；真要查，看日志。
  if (options.allowRewrite === false) {
    deps.logger.debug('polish', `还有 ${rewriteNeeded.length} 处不合口径（重写未开启，只记录）`, {
      keys: rewriteNeeded.map((issue) => issue.key),
    });
    return done(next, notes);
  }

  // 2) 只重写不合格的那几处（一次调用；失败就保持现状并说明）
  const payload = {
    diary: next.diary,
    comments: fixed.comments,
  };
  const completion = await deps.llm.chat({
    messages: [
      { role: 'system', content: '你在做文字校对：只按指令改指定段落，不加新内容，只输出 JSON。' },
      { role: 'user', content: `${rewriteInstruction(rewriteNeeded)}\n\n要改的内容：\n${JSON.stringify(payload, null, 2)}` },
    ],
    maxTokens: 1600,
    temperature: 0.3,
  });

  const usage: ComposeUsage = completion.ok
    ? {
        calls: 1,
        promptTokens: completion.data.usage.promptTokens,
        completionTokens: completion.data.usage.completionTokens,
        cachedTokens: completion.data.usage.cachedTokens,
      }
    : { ...ZERO_USAGE, calls: 1 };

  if (!completion.ok) {
    notes.push(`日记/评论没修成（模型没响应：${completion.error.message}）`);
    deps.logger.warn('polish', `抛光失败：${completion.error.message}`);
    return done(next, notes, usage);
  }

  const merged = mergeRewrite(next, completion.data.content, fixed.comments.length);
  if (!merged) {
    notes.push('日记/评论没修成（模型没按要求回 JSON）');
    deps.logger.warn('polish', '抛光结果解析失败');
    return done(next, notes, usage);
  }

  const second = selfCheck(toInput(merged, cfg, collect(merged, cfg)));
  if (second.length > 0) {
    notes.push(`日记/评论修过一次仍有 ${second.length} 处不合口径（保留原文）`);
  } else {
    notes.push(`日记/评论按口径修过一次（${rewriteNeeded.length} 处）`);
  }
  return done(merged, notes, usage);
}

/** 把模型重写回来的 JSON 合并进结果；形状不对就返回 null（保持原文）。 */
function mergeRewrite(result: RoundResult, raw: string, expectedComments: number): RoundResult | null {
  const json = extractJson(raw);
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const diaryRaw = (obj.diary ?? {}) as Record<string, unknown>;
  const publicText = typeof diaryRaw.public === 'string' ? diaryRaw.public.trim() : '';
  const privateText = typeof diaryRaw.private === 'string' ? diaryRaw.private.trim() : '';
  if (publicText.length === 0 || privateText.length === 0) return null;

  const commentList = Array.isArray(obj.comments) ? obj.comments : [];
  if (expectedComments > 0 && commentList.length === 0) return null;

  const next: RoundResult = { ...result, diary: { public: publicText, private: privateText } };
  const used = new Set<string>();
  next.selected = result.selected.map((item) => {
    const match = commentList.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Record<string, unknown>;
      return String(e.bvid ?? '') === item.bvid;
    }) as Record<string, unknown> | undefined;
    if (!match) return item;
    const text = stripTrailingPeriod(String(match.text ?? ''));
    if (text.length === 0) return item;
    used.add(item.bvid);
    if (String(match.kind ?? 'plain') === 'share') {
      return item.share ? { ...item, share: { ...item.share, text } } : item;
    }
    return item.comment ? { ...item, comment: { ...item.comment, text } } : item;
  });
  return next;
}

function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
