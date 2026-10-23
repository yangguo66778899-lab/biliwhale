/**
 * 可数的自检（§7.4 / §7.5 的落地）。
 *
 * 为什么是「可数」：提示词里写「要像人」没有用，模型没法自证。这里只查**能数出来**的东西——
 * 出现了数据词没有、末尾有没有句号、表情几个、超没超上限。查不过就重写一次，重写还不行就机械修。
 *
 * 为什么分 rewrite / mechanical：
 *   - 句号、表情这种是**位置确定的**，机械处理即可，不必再花一次模型调用；
 *   - 数据词、汇报腔、超长这种要**重新组织语言**，只能让模型重写。
 */

import { countEmoji } from '../shared/biliEmoji.ts';
import { stripTrailingPeriod } from './output.ts';

export interface SelfCheckText {
  bvid: string;
  /** plain = 不 @ 的评论；share = @ 主人的分享文案。 */
  kind: 'plain' | 'share';
  text: string;
}

export interface SelfCheckInput {
  diary: { public: string; private: string };
  comments: SelfCheckText[];
  maxCommentChars: number;
  maxShareChars: number;
}

export interface SelfCheckIssue {
  /** 机器用（测试/日志）。 */
  key: string;
  /** 给人看：哪一处、什么问题。 */
  target: string;
  message: string;
  action: 'rewrite' | 'mechanical';
}

/** 日记里不该出现的「账」：数字、评分、候选、额度。 */
const DIARY_DATA = /(我选了|挑中|评分|\/20|阈值|候选|token|本轮共|共看了\s*\d|分享\s*[了过]\s*\d|收藏\s*\d)/iu;
/** 汇报腔。 */
const REPORT_SPEAK = /(本轮|已为您|综上|首先|其次|以上是|总结一下|汇报如下)/u;
/** 评论里不该有的内部词。 */
const LEDGER_WORDS = /(本轮|额度|闸门|token|提示词|复核|冷却)/iu;

export function selfCheck(input: SelfCheckInput): SelfCheckIssue[] {
  const issues: SelfCheckIssue[] = [];
  const add = (key: string, target: string, message: string, action: SelfCheckIssue['action'] = 'rewrite'): void => {
    issues.push({ key, target, message, action });
  };

  const diaryEntries: Array<{ which: 'public' | 'private'; text: string; limit: number }> = [
    { which: 'public', text: input.diary.public, limit: 1000 },
    { which: 'private', text: input.diary.private, limit: 800 },
  ];
  for (const entry of diaryEntries) {
    const label = `日记（${entry.which === 'public' ? '公开' : '私人'}）`;
    const text = entry.text.trim();
    if (text.length === 0) {
      add(`diary-${entry.which}-empty`, label, '是空的', 'rewrite');
      continue;
    }
    if (text.length > entry.limit) {
      add(`diary-${entry.which}-long`, label, `太长了（${text.length} 字，上限 ${entry.limit}）`, 'rewrite');
    }
    if (DIARY_DATA.test(text)) {
      add(`diary-${entry.which}-data`, label, '出现了数据话（选了几条 / 评分 / 阈值 / 候选 / token）', 'rewrite');
    }
    if (REPORT_SPEAK.test(text)) {
      add(`diary-${entry.which}-report`, label, '是汇报腔（本轮 / 已为您 / 综上）', 'rewrite');
    }
    if (countEmoji(text) > 0) {
      add(`diary-${entry.which}-emoji`, label, '用了 B 站表情码（日记里不该用）', 'rewrite');
    }
  }

  for (const comment of input.comments) {
    const label = comment.kind === 'plain' ? `评论（不 @，${comment.bvid}）` : `分享文案（@ 主人，${comment.bvid}）`;
    const max = comment.kind === 'plain' ? input.maxCommentChars : input.maxShareChars;
    const text = comment.text.trim();
    if (text.length === 0) {
      add(`comment-${comment.bvid}-empty`, label, '是空的', 'rewrite');
      continue;
    }
    if (text.length > max) {
      add(`comment-${comment.bvid}-long`, label, `太长了（${text.length} 字，上限 ${max}）`, 'rewrite');
    }
    if (countEmoji(text) > 2) {
      add(`comment-${comment.bvid}-emoji`, label, `表情太多（${countEmoji(text)} 个）`, 'rewrite');
    }
    if (LEDGER_WORDS.test(text)) {
      add(`comment-${comment.bvid}-ledger`, label, '出现了内部词（本轮 / 额度 / 冷却 / 复核）', 'rewrite');
    }
    if (/[。．]\s*$/u.test(text)) {
      add(`comment-${comment.bvid}-period`, label, '末尾有句号', 'mechanical');
    }
  }

  return issues;
}

/** 机械修：评论去掉末尾句号；日记去掉表情码。不需要再问模型。 */
export function applyMechanicalFixes(input: SelfCheckInput): SelfCheckInput {
  return {
    ...input,
    comments: input.comments.map((comment) => ({ ...comment, text: stripTrailingPeriod(comment.text) })),
    diary: {
      public: input.diary.public.replace(/\[[^\[\]\s]{1,8}\]/gu, '').trim(),
      private: input.diary.private.replace(/\[[^\[\]\s]{1,8}\]/gu, '').trim(),
    },
  };
}

/** 给模型的重写指令（只说哪几处、要改成什么样，不重写整段提示词）。 */
export function rewriteInstruction(issues: SelfCheckIssue[]): string {
  const lines = issues.filter((issue) => issue.action === 'rewrite').map((issue) => `- ${issue.target}：${issue.message}`);
  return [
    '你上一次写的东西有几处不合格，只改这几处，别改其它字段：',
    ...lines,
    '',
    '改的时候记住：',
    '- 日记是「我记一下」，不是账本；不要出现选了几条、评分、阈值、候选、token。',
    '- 评论末尾不加句号；表情最多 2 个；不要用「本轮/额度/冷却/复核」这种内部词。',
    '- 上限不是目标：能一句话说完就一句话。',
    '只输出 JSON：{"diary":{"public":"…","private":"…"},"comments":[{"bvid":"BV…","kind":"plain|share","text":"…"}]}',
  ].join('\n');
}
