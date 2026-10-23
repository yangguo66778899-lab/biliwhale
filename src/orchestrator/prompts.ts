/**
 * 两个相位的 user prompt 构造。
 *
 * 职责：把已预取的材料排成模型好读的样子，并写清本相位的输出契约。
 * 不做什么：不调模型、不做校验（校验在 agent/output.ts）。
 */

import type { Config } from '../config/spec.ts';
import type { Candidate, DeepRead, LightRead, ScreenItem } from '../shared/types.ts';

/** 深读阶段塞进 prompt 的字幕上限（工具里还能要更长的）。 */
const DEEP_SUBTITLE_PROMPT_CHARS = 6000;

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
    '# 本轮任务',
    '',
    '1. 对上面每条写 `why`（两三句，具体：哪句话/哪个点让你觉得值得）和 `oneliner`（一句话，给分享用）。',
    `2. 决定分享哪一条：最多一条，只从上面这些里挑，分数要 ≥ ${input.config.share.minScore}/20；决定发就写 \`"channel":"${input.config.share.via}"\`，不发就写 \`"channel":"none"\`。`,
    `   ${shareNote}`,
    `3. 收藏：${favNote}`,
    `4. ${dynamicNote}`,
    '5. 写两本日记：',
    `   - \`diary.public\`（给用户看的）：散文体，可以对「你」说话，必须有具体细节（哪句话、第几分钟、评论区谁说了什么）。**不要写成汇报**。`,
    '   - `diary.private`（给自己看的）：不加滤镜，必须含「偏好校准」：哪条视频、用户什么反应、下次往哪偏。',
    '6. `notify` 写一句给用户的通知（一句人话，不是摘要列表）。',
    '7. `report_md`：这一轮的日报正文（**2–4 段 Markdown**，写给用户看）。讲清「翻了几条、为什么只挑这条 / 为什么一条都没挑」，可以有具体细节；不要写成日记那种第一人称抒情，也不要照抄 `why` 的原句。**不要写发没发、额度、冷却**——那些代码会写。',
    '8. `notes` 写本轮的异常/降级（没有就写空字符串）。',
    '9. **不要写「发没发」「为什么没发」「收藏/点赞成没成」**：这些由代码判定、报告里会另外写；你只负责写文案。',
    '',
    input.dryRun ? '本轮是**只读预演**：即使决定了分享也不会真的发出去，你照常写文案就行（用户要看「本来会发什么」）。' : '',
    '',
    '输出格式（只输出这个 JSON）：',
    '```json',
    JSON.stringify(
      {
        selected: [{ bvid: 'BV...', score: 15, why: '两三句', oneliner: '一句话', share: { channel: 'none', text: '', reason: '' } }],
        skipped: [{ bvid: 'BV...', reason: 'low_score', note: '' }],
        favorite: input.config.fav.enabled ? { bvid: 'BV...', reason: '为什么留（至少 6 个字）' } : null,
        dynamic: null,
        diary: { public: '...', private: '...' },
        report_md: '这一轮翻了几条…（2–4 段，写给用户看）',
        notify: '一句话',
        notes: '',
      },
      null,
      2,
    ),
    '```',
    '- `favorite` 要么是 `null`，要么是 `{ bvid, reason }`，且 bvid 必须是本轮深读过的；代码还会二次判断（理由长度、同类说明、每日额度、同视频冷却）。',
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
