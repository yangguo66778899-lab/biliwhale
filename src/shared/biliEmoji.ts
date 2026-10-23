/**
 * B 站评论可以用的「文本表情」（`[doge]` 这种，客户端会渲染成图）。
 *
 * 为什么只用一小撮：表情是语气，不是装饰。给模型一长串它会忍不住挑最花的那个，
 * 一条评论塞三四个，反而假。这里挑的是日常评论区真正常见的 16 个。
 * 想加/删就改这个数组——prompt 和自检都从这里取，不会两边不一致。
 */
export const BILI_EMOJI = [
  '[doge]',
  '[笑哭]',
  '[妙啊]',
  '[捂脸]',
  '[吃瓜]',
  '[星星眼]',
  '[给心心]',
  '[大笑]',
  '[思考]',
  '[辣眼睛]',
  '[藏狐]',
  '[支持]',
  '[打call]',
  '[嗑瓜子]',
  '[喜极而泣]',
  '[调皮]',
] as const;

const EMOJI_PATTERN = /\[[^\[\]\s]{1,8}\]/gu;

/** 文本里出现了几个表情码（不在白名单里的也算——宁可多算，提示它少用）。 */
export function countEmoji(text: string): number {
  return (text.match(EMOJI_PATTERN) ?? []).length;
}

/** 去掉所有表情码（日记里不该有；也用于机械兜底）。 */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_PATTERN, '').replace(/ {2,}/gu, ' ').trim();
}
