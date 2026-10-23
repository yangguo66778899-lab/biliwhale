/**
 * 领域类型。
 *
 * 职责：一轮里流动的所有数据形状（候选 / 轻读 / 初筛 / 深读 / 决策 / 运行记录）。
 * 不做什么：不做校验（校验在 agent/output.ts 与 config 层），不碰 IO。
 *
 * 注意：本项目只处理视频、字幕、评论三路数据；视频形状里不含任何房间或互动条数类字段（硬约束 C3）。
 */

import type { LogLevel } from './logger.ts';

/* ---------- B 站只读数据 ---------- */

export interface BiliOwner {
  mid: number;
  name: string;
}

export interface BiliStats {
  view: number;
  like: number;
  reply: number;
  favorite: number;
  coin: number;
  share: number;
}

export interface BiliVideo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  desc: string;
  durationSec: number;
  pubdateIso: string;
  owner: BiliOwner;
  stats: BiliStats;
  coverUrl: string;
  /** 来源（多源选题时标记它从哪来）。 */
  source?: CandidateSource;
}

export type CandidateSource = 'search' | 'hot' | 'ranking' | 'following' | 'favorites' | 'manual';

export interface SubtitleTrack {
  lan: string;
  lanDoc: string;
  url: string;
  isAi: boolean;
}

export interface SubtitleCue {
  fromSec: number;
  toSec: number;
  content: string;
}

export interface CommentItem {
  rpid: string;
  parent: string;
  root: string;
  mid: number;
  uname: string;
  message: string;
  like: number;
  ctimeIso: string;
  replies: CommentItem[];
}

/* ---------- 一轮里的中间产物 ---------- */

/** Phase 2 产出：多源归一化 + 去重 + 过滤后的候选。 */
export interface Candidate {
  video: BiliVideo;
  source: CandidateSource;
  /** 为了让模型一眼看懂：`12:34` 这种。 */
  durationText: string;
  /** `3 天前`。 */
  ageText: string;
}

/** Phase 3 产出：轻读（便宜的那一层）。 */
export interface LightRead {
  candidate: Candidate;
  subtitleAvailable: boolean;
  subtitleChars: number;
  /** 前 N 字，够模型判断「讲什么」。 */
  subtitleExcerpt: string;
  /** 热评前几条（截断）。 */
  topComments: string[];
  commentCount: number;
  /** 轻读阶段是否出错（出错也保留条目，标记降级）。 */
  degraded?: string;
}

/** Phase 4 产出：初筛分数。 */
export interface ScreenItem {
  bvid: string;
  score: number;
  /** 一句话理由，给报告里的「跳过原因」用。 */
  reason: string;
  /** 是否值得深读。 */
  deep: boolean;
}

export interface ScreenResult {
  items: ScreenItem[];
  notes?: string;
}

/** Phase 5 产出：深读材料。 */
export interface DeepRead {
  bvid: string;
  subtitle: string;
  subtitleChars: number;
  comments: CommentItem[];
  video: BiliVideo;
}

/* ---------- 最终输出（模型契约） ---------- */

export interface ShareProposal {
  channel: 'comment' | 'dm' | 'none';
  text: string;
  reason?: string;
}

export interface SelectedItem {
  bvid: string;
  score: number;
  why: string;
  oneliner: string;
  share?: ShareProposal;
  /**
   * 「不 @ 的评论」（share.comment.plain）：像普通观众那样在评论区说一句。
   * 与 share 是两件事：share 是 @ 主人（通知），comment 是给所有观众看的。
   */
  comment?: { want: boolean; text: string };
}

export type SkipReason =
  | 'no_subtitle'
  | 'low_score'
  | 'duplicate'
  | 'irrelevant'
  | 'tool_error'
  | 'too_old'
  | 'other';

export interface SkippedItem {
  bvid: string;
  reason: SkipReason;
  note?: string;
}

export interface RoundResult {
  selected: SelectedItem[];
  skipped: SkippedItem[];
  favorite: { bvid: string; reason: string } | null;
  dynamic: { text: string } | null;
  diary: { public: string; private: string };
  report_md: string;
  notify: string;
  notes: string;
}

/* ---------- 运行记录 / 事件 ---------- */

export type RunTrigger = 'schedule' | 'manual' | 'listen';
export type RunStatus = 'running' | 'ok' | 'degraded' | 'failed' | 'interrupted';
export type PhaseStatus = 'ok' | 'skipped' | 'degraded' | 'failed';

export interface PhaseRecord {
  name: string;
  ms: number;
  status: PhaseStatus;
  note?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  calls: number;
}

export interface RunCounts {
  candidates: number;
  screened: number;
  deepRead: number;
  selected: number;
  shared: number;
  skippedNoSubtitle: number;
}

export interface RunRecord {
  id: string;
  trigger: RunTrigger;
  dryRun: boolean;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  phases: PhaseRecord[];
  model: {
    configured: string;
    actual: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    calls: number;
    costCny: number;
  };
  counts: RunCounts;
  errors: string[];
  notes: string[];
  /** 看画面（§7.10）的结果：只记状态与缓存里的文件名，**不存图片本身**。 */
  media?: {
    status: 'off' | 'ok' | 'skipped' | 'failed';
    bvid?: string;
    reason?: string;
    frames?: number;
    sheet?: string;
    strip?: string;
    bytes?: number;
  };
}

/** 额度/操作账本的一行（同时是写操作的幂等账本：note 存幂等键）。 */
export interface QuotaEntry {
  at: string;
  type: 'comment' | 'dm' | 'fav' | 'dynamic' | 'like';
  bvid: string;
  /** 视频 aid（写接口要 oid=aid；bvid 换不到时就靠它）。 */
  aid?: number;
  /** 目标：分享评论是「@昵称」或 owner；审批回复是对方 mid。 */
  target: string;
  rpid?: string;
  share: boolean;
  /** held = 发出去了、rpid 真实存在，但 B 站把它挂起了（审核/仅自己可见，公开区看不到）。 */
  status: 'sent' | 'held' | 'failed' | 'unverified' | 'dry_run' | 'denied';
  /** 幂等键 sha256(bvid|action|target|contentHash)：M3 起用它判重。 */
  note?: string;
  /** 实际发送的内容（已按配置上限截断）。 */
  content?: string;
  contentHash?: string;
  /** 楼中楼要同时记 root 与 parent（§10.7）。 */
  root?: string;
  parent?: string;
  /** 复核成功时间；空 = 没复核成（unverified）。 */
  verifiedAt?: string;
  attempts?: number;
  error?: string;
}

/** 待审的回复草稿（陌生人回复走审批，§10.8）。 */
export interface PendingReply {
  id: string;
  createdAt: string;
  /** 过期时间（默认 7 天，过期自动作废）。 */
  expiresAt: string;
  status: 'pending' | 'sent' | 'rejected' | 'expired' | 'failed';
  /** 我们那条评论所在的视频。 */
  bvid: string;
  aid: number;
  /** 我们那条评论的 rpid（楼中楼的 root）。 */
  root: string;
  /** 对方回复的 rpid（楼中楼的 parent）。 */
  parent: string;
  target: { mid: number; uname: string };
  /** 这条是主人（account.ownerMid）回的，不是陌生人。 */
  fromOwner?: boolean;
  /** 对方原话（截断，仅供判断）。 */
  sourceComment: string;
  /** 拟回复。 */
  draft: string;
  decidedAt?: string;
  /** 批准后真正发出得到的 rpid。 */
  rpid?: string;
  note?: string;
}

/** 判重账本的一行。 */
export interface SeenEntry {
  firstSeen: string;
  lastSeen: string;
  times: number;
  lastDecision: 'skipped' | 'selected' | 'shared' | 'favorited';
  lastReason: string;
  title: string;
}

export interface EventLine {
  at: string;
  kind: string;
  level: LogLevel;
  target: string;
  note: string;
  data?: Record<string, unknown>;
}
