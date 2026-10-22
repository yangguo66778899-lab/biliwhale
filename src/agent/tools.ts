/**
 * 工具面（M0 只有只读工具）。
 *
 * 职责：按相位装配白名单工具、执行并把结果包成「素材」交给模型。
 *   - 初筛相位只给搜索/视频信息/字幕摘要/评论摘要；
 *   - 深读相位给完整字幕/评论线程/视频信息；
 *   - **没有写工具**：M0 的代码里不存在发评论、发私信、点赞的能力。
 * 不做什么：不做产品判断、不记额度、不重试（重试在 http 层）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import type { BiliVideo, CommentItem } from '../shared/types.ts';
import type { JsonSchema, ToolDefinition } from '../llm/client.ts';
import type { BiliApi } from '../bili/api.ts';
import { cuesToText } from '../bili/api.ts';
import { wrapMaterial } from './prompts.ts';

export type Phase = 'screen' | 'deep';

export type ToolName =
  | 'search_videos'
  | 'video_info'
  | 'subtitles_excerpt'
  | 'comments_summary'
  | 'subtitles_full'
  | 'comments_thread';

export interface ToolContext {
  api: BiliApi;
  logger: Logger;
}

const EXCERPT_CHARS = 700;
const FULL_SUBTITLE_CHARS = 12_000;
const SUMMARY_COMMENTS = 3;
const THREAD_COMMENTS = 12;

const BVID_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { bvid: { type: 'string', description: '视频 BV 号，必须来自本轮候选清单' } },
  required: ['bvid'],
};

const BVID_LIMIT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    bvid: { type: 'string', description: '视频 BV 号' },
    limit: { type: 'number', description: '最多返回多少条' },
  },
  required: ['bvid'],
};

/** 工具运行时：缓存同一轮里的重复取数（视频信息、字幕），省请求也省 token。 */
export class ToolRuntime {
  readonly api: BiliApi;
  readonly logger: Logger;
  private readonly videoCache = new Map<string, BiliVideo>();
  private readonly subtitleCache = new Map<string, { text: string; chars: number; available: boolean }>();

  constructor(api: BiliApi, logger: Logger) {
    this.api = api;
    this.logger = logger;
  }

  async video(bvid: string): Promise<Result<BiliVideo>> {
    const cached = this.videoCache.get(bvid);
    if (cached) return { ok: true, data: cached };
    const res = await this.api.video(bvid);
    if (res.ok) this.videoCache.set(bvid, res.data);
    return res;
  }

  /** 字幕全文（没有字幕 → available=false，不是错误）。 */
  async subtitleText(bvid: string): Promise<Result<{ text: string; chars: number; available: boolean }>> {
    const cached = this.subtitleCache.get(bvid);
    if (cached) return { ok: true, data: cached };
    const video = await this.video(bvid);
    if (!video.ok) return video;
    const subs = await this.api.bestSubtitle(bvid, video.data.cid);
    if (!subs.ok) return subs;
    const text = cuesToText(subs.data.cues);
    const value = { text, chars: text.length, available: text.length > 0 };
    this.subtitleCache.set(bvid, value);
    return { ok: true, data: value };
  }

  /** 评论（热评前 N 条，带楼中楼首屏）。 */
  async topComments(bvid: string, limit: number): Promise<Result<{ count: number; items: CommentItem[] }>> {
    const video = await this.video(bvid);
    if (!video.ok) return video;
    const res = await this.api.topComments(video.data.aid, limit);
    if (!res.ok) return res;
    const count = video.data.stats.reply || res.data.length;
    return { ok: true, data: { count, items: res.data } };
  }
}

export interface ToolSpec {
  name: ToolName;
  phases: Phase[];
  description: string;
  parameters: JsonSchema;
  run(args: Record<string, unknown>, rt: ToolRuntime): Promise<Result<unknown>>;
}

function badArgs(message: string): Result<never> {
  return { ok: false, error: { kind: 'business', code: 'bad_args', message } };
}

function compactVideo(v: BiliVideo): Record<string, unknown> {
  return {
    bvid: v.bvid,
    title: v.title,
    up: v.owner.name,
    duration: v.durationSec,
    pubdate: v.pubdateIso,
    desc: v.desc.slice(0, 300),
    stat: v.stats,
  };
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'search_videos',
    phases: ['screen'],
    description:
      '按关键词搜最近的视频，返回标题/UP/时长/简介/播放。什么时候用：候选清单不够、想补搜偏好方向时。什么时候别用：手上已有候选，或只是想看某个已知 BV 的详情（用 video_info）。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，用用户偏好里的话' },
        order: { type: 'string', enum: ['totalrank', 'pubdate', 'click'], description: '排序：综合 / 最新 / 播放' },
      },
      required: ['keyword'],
    },
    async run(args, rt) {
      const keyword = String(args.keyword ?? '').trim();
      if (!keyword) return badArgs('keyword 不能为空');
      if (keyword.length > 40) return badArgs('keyword 太长（<40 字）');
      const order = args.order === 'pubdate' || args.order === 'click' ? args.order : 'totalrank';
      const res = await rt.api.searchVideos(keyword, { order, page: 1 });
      if (!res.ok) return res;
      return { ok: true, data: { keyword, count: res.data.length, videos: res.data.slice(0, 8).map(compactVideo) } };
    },
  },

  {
    name: 'video_info',
    phases: ['screen', 'deep'],
    description:
      '看一条视频的详情：标题、UP、时长、发布时间、播放/点赞/评论数、简介。什么时候用：候选里缺简介或缺数据时。什么时候别用：字幕和评论要看，用专用的那两个工具。',
    parameters: BVID_SCHEMA,
    async run(args, rt) {
      const bvid = String(args.bvid ?? '').trim();
      if (!bvid.startsWith('BV')) return badArgs('bvid 不合法');
      const res = await rt.video(bvid);
      if (!res.ok) return res;
      return { ok: true, data: compactVideo(res.data) };
    },
  },

  {
    name: 'subtitles_excerpt',
    phases: ['screen'],
    description:
      '看一条视频的字幕开头（约 700 字），用来判断「讲的是什么」。什么时候用：初筛时判断内容密度。什么时候别用：已经决定要深读这条了，用 subtitles_full。',
    parameters: BVID_SCHEMA,
    async run(args, rt) {
      const bvid = String(args.bvid ?? '').trim();
      if (!bvid.startsWith('BV')) return badArgs('bvid 不合法');
      const res = await rt.subtitleText(bvid);
      if (!res.ok) return res;
      const { text, available, chars } = res.data;
      return {
        ok: true,
        data: {
          bvid,
          available,
          chars,
          excerpt: available ? text.slice(0, EXCERPT_CHARS) : '',
          note: available ? undefined : '没有字幕轨（可能是硬字幕或无语音）',
        },
      };
    },
  },

  {
    name: 'comments_summary',
    phases: ['screen'],
    description:
      '看一条视频的热评前三条。什么时候用：初筛时判断「评论区有没有真的在讨论内容」。什么时候别用：要判断评论区氛围或回复别人，用 comments_thread。',
    parameters: { ...BVID_LIMIT_SCHEMA, properties: { ...BVID_LIMIT_SCHEMA.properties } },
    async run(args, rt) {
      const bvid = String(args.bvid ?? '').trim();
      if (!bvid.startsWith('BV')) return badArgs('bvid 不合法');
      const limit = Math.min(Math.max(Number(args.limit ?? SUMMARY_COMMENTS) || SUMMARY_COMMENTS, 1), 10);
      const res = await rt.topComments(bvid, limit);
      if (!res.ok) return res;
      return {
        ok: true,
        data: {
          bvid,
          count: res.data.count,
          top: res.data.items.slice(0, limit).map((c) => ({ uname: c.uname, like: c.like, message: c.message.slice(0, 200) })),
        },
      };
    },
  },

  {
    name: 'subtitles_full',
    phases: ['deep'],
    description:
      '读一条视频的完整字幕（最多 12000 字）。什么时候用：深读，需要引用具体哪句话。什么时候别用：只是初筛判断（用 subtitles_excerpt，省 token）。',
    parameters: BVID_SCHEMA,
    async run(args, rt) {
      const bvid = String(args.bvid ?? '').trim();
      if (!bvid.startsWith('BV')) return badArgs('bvid 不合法');
      const res = await rt.subtitleText(bvid);
      if (!res.ok) return res;
      const { text, available, chars } = res.data;
      return {
        ok: true,
        data: {
          bvid,
          available,
          chars,
          truncated: chars > FULL_SUBTITLE_CHARS,
          text: available ? text.slice(0, FULL_SUBTITLE_CHARS) : '',
          note: available ? undefined : '没有字幕轨（可能是硬字幕或无语音），不要反复重试',
        },
      };
    },
  },

  {
    name: 'comments_thread',
    phases: ['deep'],
    description:
      '看一条视频的热评与其楼中楼（最多 12 条主楼，含前几条回复）。什么时候用：深读时判断评论区是不是在吵架、有没有干货。什么时候别用：初筛（用 comments_summary）。',
    parameters: { ...BVID_LIMIT_SCHEMA, properties: { ...BVID_LIMIT_SCHEMA.properties } },
    async run(args, rt) {
      const bvid = String(args.bvid ?? '').trim();
      if (!bvid.startsWith('BV')) return badArgs('bvid 不合法');
      const limit = Math.min(Math.max(Number(args.limit ?? THREAD_COMMENTS) || THREAD_COMMENTS, 1), 20);
      const res = await rt.topComments(bvid, limit);
      if (!res.ok) return res;
      return {
        ok: true,
        data: {
          bvid,
          count: res.data.count,
          items: res.data.items.slice(0, limit).map((c) => ({
            uname: c.uname,
            like: c.like,
            message: c.message.slice(0, 400),
            replies: c.replies.slice(0, 3).map((r) => ({ uname: r.uname, message: r.message.slice(0, 200) })),
          })),
        },
      };
    },
  },
];

/** 某相位可用工具的 JSON Schema 定义（只列白名单里的）。 */
export function toolDefinitions(phase: Phase): ToolDefinition[] {
  return TOOLS.filter((t) => t.phases.includes(phase)).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function findTool(name: string, phase: Phase): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name && t.phases.includes(phase));
}

/** 执行一个工具调用：解析参数 → 调 handler → 包成素材。 */
export async function executeTool(
  name: string,
  argsJson: string,
  phase: Phase,
  rt: ToolRuntime,
): Promise<{ content: string; isError: boolean }> {
  const spec = findTool(name, phase);
  if (!spec) {
    return {
      content: wrapMaterial('tool', JSON.stringify({ ok: false, error: { kind: 'business', code: 'not_available', message: `本轮没有这个工具：${name}` } })),
      isError: true,
    };
  }
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsJson || '{}') as unknown;
    args = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {
      content: wrapMaterial('tool', JSON.stringify({ ok: false, error: { kind: 'business', code: 'bad_json', message: '工具参数不是合法 JSON' } })),
      isError: true,
    };
  }

  try {
    const result = await spec.run(args, rt);
    return { content: wrapMaterial(spec.name, JSON.stringify(result)), isError: !result.ok };
  } catch (err) {
    rt.logger.error('tools', `工具 ${name} 抛异常：${String(err)}`);
    return {
      content: wrapMaterial(
        'tool',
        JSON.stringify({ ok: false, error: { kind: 'internal', code: 'internal', message: '工具内部错误，已记录' } }),
      ),
      isError: true,
    };
  }
}
