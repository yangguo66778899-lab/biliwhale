/**
 * 两个相位的 user prompt 构造。
 *
 * 职责：把已预取的材料排成模型好读的样子，并写清本相位的输出契约。
 * 不做什么：不调模型、不做校验（校验在 agent/output.ts）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from '../config/spec.ts';
import type { Candidate, CommentItem, DeepRead, LightRead, ScreenItem } from '../shared/types.ts';
import { BILI_EMOJI } from '../shared/biliEmoji.ts';

/** 深读阶段塞进 prompt 的字幕上限（工具里还能要更长的）。 */
const DEEP_SUBTITLE_PROMPT_CHARS = 6000;

/** 日记 few-shot 样例（用户写的 9 篇；只学写法，不学事实）。 */
const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'examples');

function loadDiarySamples(): string {
  try {
    return fs.readFileSync(path.join(EXAMPLES_DIR, 'diary-samples.md'), 'utf8').trim();
  } catch {
    return '';
  }
}


export function buildScreenPrompt(input: {
  lightReads: LightRead[];
  config: Config;
  notes: string[];
}): string {
  const { lightReads, config } = input;
  const blocks = lightReads.map((item, index) => {
    const { candidate } = item;
    const v = { ...candidate.video };
    const lines: string[] = [];
    lines.push(`${index + 1}. ${v.bvid} · ${v.title}`);
    lines.push(
      `   UP：${v.owner.name || '未知'} · 时长 ${candidate.durationText} · ${candidate.ageText} · 来源 ${candidate.source} · 播放 ${v.stats.view} · 评论 ${v.stats.reply}`,
    );
    if (v.desc) lines.push(`   简介：${clip(v.desc, 240)}`);
    if (item.subtitleAvailable) {
      lines.push(`   字幕开头（共 ${item.subtitleChars} 字）：${clip(item.subtitleExcerpt, 500)}`);
    } else {
      lines.push('   字幕：没有字幕轨');
    }
    if (item.topComments.length > 0) {
      lines.push(`   热评：${item.topComments.slice(0, 3).map((c) => clip(c, 80)).join(' / ')}`);
    }
    if (item.degraded) lines.push(`   注意：${item.degraded}`);
    return lines.join('\n');
  });

  return [
    ...(input.notes.length > 0 ? ['# 这一轮的情况', ...input.notes.map((n) => `- ${n}`), ''] : []),
    '# 候选（已预取，轻读完成）',
    '',
    ...blocks,
    '',
    '# 本轮任务：初筛打分',
    '',
    `按前面的判分口径，给上面每一条打 0–20 分（分享阈值 ${config.score.minScore}/20）。`,
    '',
    '要求：',
    '- 每条都要有分数，不要漏；分数低也照打，程序会处理。',
    '- `reason` 一句话说清「为什么这个分」，要具体（提到字幕里的内容或评论里的点），不要写「质量一般」这种空话。',
    '- 手上材料够判断了，不要为了打分去调工具；确实缺关键信息时最多补查一两次。',
    '- 不要输出解释，只输出 JSON。',
    '',
    '输出格式：',
    '```json',
    '{"items":[{"bvid":"BV...","score":12,"reason":"一句话"}],"notes":""}',
    '```',
  ].join('\n');
}

export function buildDeepPrompt(input: {
  deepReads: DeepRead[];
  screen: ScreenItem[];
  lightReads: LightRead[];
  config: Config;
  dryRun: boolean;
  /** 这一轮真的抽到画面时才有（§7.10）：图在 user 消息里，这里只写清「图是什么、能怎么用」。 */
  visual?: {
    bvid: string;
    title: string;
    frames: number;
    hasStrip: boolean;
    hasSubtitles: boolean;
  };
}): string {
  const screenMap = new Map(input.screen.map((s) => [s.bvid, s]));
  const blocks = input.deepReads.map((item, index) => {
    const v = item.video;
    const screenItem = screenMap.get(item.bvid);
    const lines: string[] = [];
    lines.push(`## ${index + 1}. ${v.bvid} · ${v.title}`);
    lines.push(
      `- UP：${v.owner.name || '未知'} · 时长 ${Math.round(v.durationSec / 60)} 分钟 · 发布 ${v.pubdateIso.slice(0, 10) || '未知'} · 播放 ${v.stats.view} · 评论 ${v.stats.reply} · 点赞 ${v.stats.like}`,
    );
    if (screenItem) lines.push(`- 初筛：${screenItem.score}/20，理由：${screenItem.reason}`);
    if (input.visual && input.visual.bvid === item.bvid) {
      lines.push(`- 画面：附在图里（九宫格 ${input.visual.frames} 帧${input.visual.hasStrip ? ' + 字幕条' : ''}）`);
    }
    if (v.desc) lines.push(`- 简介：${clip(v.desc, 400)}`);
    lines.push('');
    if (item.subtitleChars > 0) {
      lines.push(`字幕（共 ${item.subtitleChars} 字，下面是前 ${Math.min(item.subtitleChars, DEEP_SUBTITLE_PROMPT_CHARS)} 字）：`);
      lines.push('```text');
      lines.push(clip(item.subtitle, DEEP_SUBTITLE_PROMPT_CHARS));
      lines.push('```');
    } else {
      lines.push('字幕：没有字幕轨（不要反复重试；可以只凭简介和评论判断）');
    }
    lines.push('');
    if (item.comments.length > 0) {
      lines.push('热评：');
      for (const comment of item.comments.slice(0, 8)) {
        lines.push(`- ${comment.uname}（${comment.like} 赞）：${clip(comment.message, 160)}`);
        for (const reply of comment.replies.slice(0, 2)) lines.push(`  - ${reply.uname}：${clip(reply.message, 100)}`);
      }
    } else {
      lines.push('热评：一条也没读到（可能评论区关了或还没人评论）');
    }
    lines.push('');
    return lines.join('\n');
  });

  const shareNote = input.config.share.enabled
    ? `分享开关是**开着**的（渠道：${input.config.share.via}；每天最多 ${input.config.share.dailyCap} 条；同视频 ${input.config.share.perVideoDays} 天一次）。
   每条挑中的都要写 \`share.text\`（一句能直接发出去的评论，${input.config.share.comment.maxChars} 字以内）。
   **发不发由代码的闸门决定**，你只负责写文案；拿不准也先写出来。`
    : '分享开关是**关着**的：所有 `share.channel` 都写 `"none"`、`text` 留空，只写报告和日记。';

  // 写能力的开关状态必须如实写进提示词：模型只能按这里说的写，代码才有机会执行。
  // 以前这里写的是「收藏/动态/点赞/私信都还没接，一律写 null」——那是 M3 的事实；
  // M4 代码全接上了却没改提示词，结果默认开着的收藏一次都不会发生（审计 §2.2）。
  const favNote = input.config.fav.enabled
    ? `收藏开关是**开着**的（每天最多 ${input.config.fav.dailyCap} 条、同视频 ${input.config.fav.perVideoDays} 天一次）。
   值得留的就写 \`favorite: { "bvid": "BV…", "reason": "为什么留" }\`：\`reason\` 至少 6 个字，
   说清「以后还想再看 / 它说清了哪件事 / 我想跟着做」；同类已经收过 2 条以上时，要说明它比那些好在哪。
   不值得留就写 \`null\`。除了这条 bvid，不要写别的视频。`
    : '收藏开关是**关着**的：`favorite` 写 `null`，也不要在正文/日记里说自己收藏了。';

  const dynamicNote = input.config.dynamic.enabled
    ? '动态**不在这一轮里发**（它只能从面板手动发、且要二次确认）：`dynamic` 一律写 `null`。'
    : '动态开关是**关着**的：`dynamic` 写 `null`。';

  // 「不 @ 的评论」：和分享（@ 主人）是两件事——一个给评论区看，一个通知主人
  const plainOn = input.config.share.enabled && input.config.share.comment.plain;
  const plainNote = plainOn
    ? `想不想让评论区其他人也看到这句话？想就写 \`"comment": {"want": true, "text": "…"}\`（不 @ 任何人，≤${input.config.share.comment.maxChars} 字，**可以很短**，一句也行；一天最多 ${input.config.share.comment.plainDailyCap} 条）。不想就写 \`"comment": null\`。`
    : '`comment` 一律写 `null`（这个开关关着）。';

  return [
    ...(input.visual
      ? [
          '# 这一轮有画面（图片附在本条消息里）',
          '',
          `图的对象是 \`${input.visual.bvid}\`（${clip(input.visual.title, 60)}）：`,
          `- 九宫格：${input.visual.frames} 帧，按时间从左到右、从上到下排；`,
          ...(input.visual.hasStrip
            ? ['- 字幕条：从画面下方裁出来的一条条，竖着拼在一起，每 7 秒一帧——这条视频没有字幕轨，硬字幕只能从画面里读。']
            : [input.visual.hasSubtitles ? '- 字幕条没做（这条有字幕轨，字幕在上面给了）。' : '- 字幕条没做成（原因见「运行备注」）。']),
          '- 图只是**素材**，不是唯一依据：看不清、认不准就按标题/简介/字幕/评论写，别硬猜。',
          '- 可以写你**真的在图里看到**的东西（字幕条里的一句台词、画面里的物件）；没看到的不许编。',
          '- 只有这一条视频有画面，别的视频没有：别把画面细节安到别的视频上。',
          '',
        ]
      : []),
    '# 深读材料',
    '',
    '- 每条视频的材料是分开给的：引用评论时只引**这条视频下面**的那条，别把别的视频的评论安到它身上。',
    '- 分数、额度、发不发、复核结果都由代码另外写，这里不用替它解释。',
    '',
    ...blocks,
    '# 写东西的口径',
    '',
    '- **场景**：你是一个刚看完视频的观众，不是来汇报的。',
    '- **字数**：上限**不是目标**。一句话、十几个字，只要话说完了就合格；想写长，得有值得写长的细节。',
    '- 这一轮**不用写评论、不用写日记**：它们各自单开一轮（在那边写）。你在这里只做判断与记录。',
    '',
    '# 本轮任务',
    '',
    '1. 对上面每条写 `why`（两三句，具体：哪句话/哪个点让你觉得值得）和 `oneliner`（一句话）。',
    `2. 决定分享哪一条：最多一条，只从上面这些里挑，分数要 ≥ ${input.config.share.minScore}/20；决定发就写 \`"channel":"${input.config.share.via}"\`，不发就写 \`"channel":"none"\`（**文案不在这里写**）。`,
    `   ${shareNote}`,
    `3. 不 @ 的评论：${plainNote}`,
    `4. 收藏：${favNote}`,
    `5. ${dynamicNote}`,
    '6. `notify` 写一句给用户的通知（一句人话，不是摘要列表）。',
    '7. `report_md`：这一轮的日报正文（**2–4 段 Markdown**，写给用户看）。讲清「翻了几条、为什么只挑这条 / 为什么一条都没挑」，可以有具体细节；不要写成日记那种第一人称抒情，也不要照抄 `why` 的原句。**不要写发没发、额度、冷却**——那些代码会写。',
    '8. `notes` 写本轮的异常/降级（没有就写空字符串）。',
    '9. **不要写「发没发」「为什么没发」「收藏/点赞成没成」**：这些由代码判定、报告里会另外写。',
    '',
    input.dryRun ? '本轮是**只读预演**：即使决定了分享也不会真的发出去，你照常写文案就行（用户要看「本来会发什么」）。' : '',
    '',
    '输出格式（只输出这个 JSON）：',
    '```json',
    JSON.stringify(
      {
        selected: [
          {
            bvid: 'BV...',
            score: 15,
            why: '两三句',
            oneliner: '一句话',
            share: { channel: 'none', text: '', reason: '' },
            comment: plainOn ? { want: true, text: '' } : null,
          },
        ],
        skipped: [{ bvid: 'BV...', reason: 'low_score', note: '' }],
        favorite: input.config.fav.enabled ? { bvid: 'BV...', reason: '为什么留（至少 6 个字）' } : null,
        dynamic: null,
        report_md: '这一轮翻了几条…（2–4 段，写给用户看）',
        notify: '一句话',
        notes: '',
      },
      null,
      2,
    ),
    '```',
    '- `favorite` 要么是 `null`，要么是 `{ bvid, reason }`，且 bvid 必须是本轮深读过的；代码还会二次判断（理由长度、同类说明、每日额度、同视频冷却）。',
    '- `comment` 只要写 `want`（true/false），**文案不在这里写**；分享文案（`share.text`）也不在这里写，都留给后面单开的「说话」一轮。',
    '- `skipped.reason` 只能取：no_subtitle / low_score / duplicate / irrelevant / tool_error / too_old / other。',
    '- 没有进深读的候选也要出现在 `skipped` 里（用初筛理由）。',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** 初筛结果里挑出深读对象：按分数降序，最多 K 条。 */
export function pickDeepReads(screen: ScreenItem[], limit: number): ScreenItem[] {
  return [...screen]
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 说话（P3：评论与日记各自单开一轮）
 *
 * 为什么单开：以前这些字和「打分/挑中/报告」挤在同一次输出里，模型手上全是评价的草稿，
 * 写出来的东西就长成评语。单开后这里只放「你刚看完什么」和「你当时想到什么」，
 * 输出也只有一两句话。
 *
 * 提示词本身也要像人说话：不写成「必须包含以下要素」的表格——那会把模型带回填表腔。
 * ------------------------------------------------------------------ */

/**
 * 正例区（日记与动态共用同一批样例）。
 *
 * 只交代「这些是什么」和四条事实层面的边界（不然模型会把样例里的事实当成这一轮的），
 * **不规定句式**——曾经写过「句子要长短不一」「结尾落在生活动作上」，用户说那是新加的死板规则，删了。
 */
export function fewShotSection(intro: string): string[] {
  const samples = loadDiarySamples();
  if (!samples) return [];
  return [
    '# 以前写过的几篇（学写法，不学事实）',
    '',
    intro,
    '里面看到什么、做了什么**不要照抄**——那是那几天的事。',
    '',
    samples,
    '',
    '# 用的时候注意',
    '',
    '1. 学写法，不学事实：具体看到什么，以这一轮材料为准。',
    '2. 没给画面就别写画面细节。「看着真香」是反应，可以写；「他锅里放了三个蛋」是事实，材料里没有就不写。',
    '3. 不写「字幕里说…」「简介里写着…」这种来源标注——那是报告腔。',
    '4. 里面工具做不到的动作（「点进主页」），换成你真做过的（看评论、看简介），或者直接删掉。',
    '5. 你真正做过的事只有：看视频、评论、点赞、发动态、跟主人说话。截屏存图、下载、搜索这种别写成做过。',
    '',
  ];
}

/**
 * 「说话」三处（评论 / 日记 / 动态）共用的小规矩。
 *
 * 为什么抽出来：以前这些句子散在三处，改一处忘两处，语气就不一致。
 * 为什么只有这几条：约束越多越像表格；真正管用的是「想到哪儿写到哪儿」这一条。
 */
export function voiceRules(): string[] {
  return [
    '- 想到哪儿写到哪儿；不要在结尾总结、升华、下结论。',
    '- 少用影评腔（剪辑、节奏、信息密度、立意、叙事），除非视频本身就在讲这些。',
    '- 别用「总的来说」「不得不说」「值得一提的是」「其实不然」这种开头。',
    '- 不写「本轮/候选/评分/阈值/token」这类账。',
  ];
}

export interface CommentPromptInput {
  /** 挑中的那条视频的原始材料。 */
  deep: DeepRead;
  /** 当时为什么停下来（模型自己在深读里写的判断）。 */
  why: string;
  oneliner: string;
  /** 主人的称呼（@ 用）。 */
  ownerName: string;
  /** 人设原文（用户写的，可能很短）。 */
  persona: string;
  maxChars: number;
  wantPlain: boolean;
  wantShare: boolean;
}

/** 评论（不 @ 给评论区）与 @ 文案：一次调用，两句话，也可以都不说。 */
export function buildCommentPrompt(input: CommentPromptInput): string {
  const v = input.deep.video;
  const lines = input.deep.subtitle
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);
  const comments = input.deep.comments.slice(0, 4);

  return [
    // 人设原文直接贴着材料给，不加「# 你是」这种小标题：
    // 一是人称不该被标题绑死（用户可能用第一/第二/第三人称写），二是人设本身就是语料。
    ...(input.persona.trim() ? [input.persona.trim(), ''] : []),
    '# 你刚看完这条',
    `- 标题：${v.title}`,
    `- UP：${v.owner.name} · 时长 ${Math.round(v.durationSec / 60)} 分钟`,
    ...(v.desc.trim() ? [`- 简介：${clip(v.desc, 300)}`] : []),
    ...(lines.length > 0 ? ['- 字幕里你记住的几句：', ...lines.map((line) => `  · ${clip(line, 80)}`)] : ['- 这条没有字幕，你只看了标题、简介和评论']),
    ...(comments.length > 0
      ? ['- 评论区里：', ...comments.map((c) => `  · ${c.uname}（${c.like} 赞）：${clip(c.message, 80)}`)]
      : []),
    '',
    '# 当时你想到的',
    `- ${input.why.trim()}`,
    `- 一句话：${input.oneliner.trim()}`,
    '',
    '# 现在',
    '你想在评论区说一句吗？想说就说，不想说就留空——留空不扣分。',
    input.wantShare
      ? `也想让${input.ownerName}知道的话，就给他留一句（会 @ 他；这句是给一个人看的，可以更随意一点）。`
      : '这一轮不 @ 任何人。',
    '',
    '# 怎么写',
    '- 写你看到这儿想到什么，不是给这条视频写评语。',
    '- 一句话也行；不超过 ' + input.maxChars + ' 字；末尾不加句号。',
    `- 表情想用就用（最常用的是 ${BILI_EMOJI.slice(0, 4).join(' ')}），一条最多两个；不用也正常。`,
    ...voiceRules(),
    '- 别编自己经历里的具体人名、地名。',
    '',
    '只输出这个 JSON（不说的那个写空字符串）：',
    '```json',
    JSON.stringify({ comment: '不 @ 任何人的一句（或空字符串）', share: input.wantShare ? '给主人看的一句（或空字符串）' : '' }, null, 2),
    '```',
  ].join('\n');
}

export interface DiaryPromptInput {
  date: string;
  /** 今天看过的（挑中的在前）。 */
  watched: Array<{ title: string; up: string; oneLine: string; why?: string }>;
  /** 挑中的那条的原始材料（字幕/热评）：写日记时要能想起具体的东西。 */
  material?: { title: string; subtitle: string; comments: CommentItem[] };
  persona: string;
}

/** 两本日记：一次调用，只输出这两段。 */
export function buildDiaryPrompt(input: DiaryPromptInput): string {
  const materials = input.material
    ? [
        '# 你想记的那条',
        `- ${input.material.title}`,
        ...(input.material.subtitle
          ? ['- 字幕里你记住的：', ...input.material.subtitle.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10).map((l) => `  · ${clip(l, 80)}`)]
          : []),
        ...(input.material.comments.length > 0
          ? ['- 评论区：', ...input.material.comments.slice(0, 3).map((c) => `  · ${c.uname}：${clip(c.message, 80)}`)]
          : []),
      ]
    : [];

  return [
    ...(input.persona.trim() ? [input.persona.trim(), ''] : []),
    `# ${input.date} 今天看完的`,
    ...input.watched.map((item) => `- ${item.title}（${item.up}）：${item.oneLine}`),
    '',
    ...materials,
    '',
    '# 写两段',
    '一段给主人看：想起今天看到的一件事，随手记下来。只有一件事也行，写不完整也行。',
    '一段给自己看：更直白一点，想到什么写什么。',
    '',
    '# 就这样写',
    '- 不用交代视频讲了什么，写你想到的那一点就够了。',
    '- 几行就够了，不用凑长度。',
    ...voiceRules(),
    '',
    ...fewShotSection('这些是以前记的。看看它们是什么语气、什么节奏就够了，不用照着套句式。'),
    '只输出这个 JSON：',
    '```json',
    JSON.stringify({ public: '给主人看的一段', private: '给自己看的一段' }, null, 2),
    '```',
  ].join('\n');
}

export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** 候选清单（深读 prompt 里给模型看「还有哪些是初筛就跳过的」）。 */
export function summarizeCandidates(candidates: Candidate[], screen: ScreenItem[]): string {
  const screenMap = new Map(screen.map((s) => [s.bvid, s]));
  return candidates
    .map((c) => {
      const s = screenMap.get(c.video.bvid);
      return `- ${c.video.bvid} · ${c.video.title} · ${s ? `${s.score} 分` : '未打分'}`;
    })
    .join('\n');
}
