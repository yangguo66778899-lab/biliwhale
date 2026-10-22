/**
 * 待审回复的「拟回复」生成器（生产版：一次 DeepSeek 调用）。
 *
 * 职责：给一条陌生人回复写一句能直接发出去的话：短、不承诺、不争论、不像客服。
 *   失败就返回 null —— 宁可没有草稿，也不发一句没有内容的话。
 * 不做什么：不调工具、不看字幕、不读配置（输入全给齐）、不发请求。
 */

import type { LlmClient } from '../llm/client.ts';
import type { Logger } from '../shared/logger.ts';

export interface DraftInput {
  source: string;
  uname: string;
  videoTitle: string;
  maxChars: number;
}

export function makeReplyDraft(client: LlmClient, logger: Logger): (input: DraftInput) => Promise<string | null> {
  return async (input: DraftInput): Promise<string | null> => {
    const system = [
      '你在用第一人称和一个在你评论下留言的人说话。',
      '要求：',
      '- 一句到两句，不超过给定字数；中文；不要换行。',
      '- 具体一点：回应他说的那件事，不要空话（别写「谢谢支持」这种）。',
      '- 不承诺（不写「下次一定」「以后常来」）、不争论、不解释自己是谁、不透露隐私。',
      '- 不用表情，不用「亲」「宝子」这类客服腔。',
      '- 只输出回复正文，不要引号、不要前缀、不要解释。',
    ].join('\n');

    const user = [
      `对方昵称：${input.uname}`,
      `对方在我们评论下的原话：${input.source}`,
      `（视频：${input.videoTitle}）`,
      `字数上限：${input.maxChars}`,
    ].join('\n');

    try {
      const res = await client.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens: 200,
        temperature: 0.6,
      });
      if (!res.ok) {
        logger.warn('pending', `拟回复生成失败：${res.error.message}`);
        return null;
      }
      const text = cleanDraft(res.data.content);
      return text.length > 0 ? text : null;
    } catch (err) {
      logger.warn('pending', `拟回复生成异常：${String(err)}`);
      return null;
    }
  };
}

/** 去掉模型爱加的东西：引号、前缀、多段。 */
export function cleanDraft(raw: string): string {
  let text = (raw ?? '').trim();
  text = text.replace(/^(回复|答|拟回复)[:：]\s*/, '');
  text = text.replace(/^["'“”「『]+|["'“”」』]+$/g, '');
  text = text.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return text.trim();
}
