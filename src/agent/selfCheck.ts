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

/**
 * 黑名单（§7.5 精简版，2026-10-24 按用户实测调整）。
 *
 * **只留总结/公文/报告三类**。原来还收了「温柔/治愈/时光/岁月/仪式感/烟火气」这组文艺腔词，
 * 实测会把用户自己写的正例判成不合格（「感觉是个很温柔的人呢」），所以整组删掉。
 */
const BLACKLIST = [
  '综上所述', '总而言之', '总的来说', '由此可见', '值得一提的是', '值得注意的是', '不可否认', '毫无疑问',
  '赋能', '深耕', '助力', '打造', '引领', '全方位', '多维度', '一站式', '闭环', '抓手', '底层逻辑', '顶层设计',
  '具有深远意义', '里程碑', '新篇章', '开创性', '令人振奋', '欣欣向荣', '未来可期', '拭目以待', '前景广阔',
  '希望以上', '如有疑问', '仅供参考', '不当之处',
];

/**
 * 工具做不到的动作（写了就是编的）。
 * 只收「做完了一件事」的动词；「想截屏存下来」这种打算不拦——用户的 9 篇正例里就有一篇这么写，
 * 那是她的小愿望，不是假事实。
 */
const FAKE_ACTIONS = /(点进主页|搜了他的|去搜了|关注了|买了|下单了|看了第二遍)/u;
/** 来源标注（报告腔，一篇里超过 2 处才算问题）。 */
const SOURCE_LABEL = /(字幕里说|简介里写着|标题提到|简介里说)/gu;
/** 结尾总结/鸡汤（最后一句命中就算）。 */
const SUMMARY_TAIL = /(总的来说|总之|或许这就是|也许这就是|生活不就是这样|值得被记住)/u;

/** 单句上限（§7.4 第 3 条，2026-10-24 从 45 放宽到 70：用户正例里有 64 字的长句，那不是病句）。 */
const MAX_SENTENCE_CHARS = 70;

function maxSentenceChars(text: string): number {
  const sentences = text
    .split(/[。！？；\n]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return Math.max(0, ...sentences.map((s) => Array.from(s).length));
}

function lastSentence(text: string): string {
  const sentences = text
    .split(/[。！？；\n]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences[sentences.length - 1] ?? '';
}

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
    const hitBlack = BLACKLIST.filter((word) => text.includes(word));
    if (hitBlack.length > 0) {
      add(`diary-${entry.which}-blacklist`, label, `用了套话（${hitBlack.join('、')}）`, 'rewrite');
    }
    const longest = maxSentenceChars(text);
    if (longest > MAX_SENTENCE_CHARS) {
      add(`diary-${entry.which}-sentence`, label, `有一句太长（${longest} 字，上限 ${MAX_SENTENCE_CHARS}）`, 'rewrite');
    }
    if (FAKE_ACTIONS.test(text)) {
      add(`diary-${entry.which}-fake-action`, label, '写了工具做不到的动作（搜/关注/买/截屏/下载）', 'rewrite');
    }
    const sources = text.match(SOURCE_LABEL)?.length ?? 0;
    if (sources > 2) {
      add(`diary-${entry.which}-source`, label, `来源标注太多（${sources} 处，超过 2 处就是报告腔）`, 'rewrite');
    }
    if (SUMMARY_TAIL.test(lastSentence(text))) {
      add(`diary-${entry.which}-tail`, label, '结尾是总结/鸡汤', 'rewrite');
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
