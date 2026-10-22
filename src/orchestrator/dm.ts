/**
 * 私信（M4）：两条完全独立的路，别混。
 *
 *   1. **分享私信**（`share.via='dm'`）：占分享额度，一轮合并成一条，≤500 字，最多 5 条视频。
 *   2. **通知私信**（`notify.channels[dm]`）：不占分享额度，只受私信限速/风控约束；
 *      分「摘要」「公开日记」「视频信息」三个子开关，各自独立。
 *
 * 关键约束（§7.11）：
 *   - 视频信息**只用本轮已经抓到的数据**：标题、链接、简介（≤200）、已有的理解/一句话；
 *     不发卡片、不调额外接口、不为了这段话再跑一次模型；只允许「今天上下文里出现过」的 BV。
 *   - 单条 ≤500 字符；连续发送间隔 ≥1s（写层）；撞风控立即停。
 * 不做什么：不做聊天（在 chat.ts）、不记账（调用方负责）、不读字幕。
 */

import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { BiliWriter } from '../bili/write.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { SecretsService } from '../config/secrets.ts';
import { countChars } from '../bili/write.ts';
import { resolveOwner } from '../account/owner.ts';

export interface DmVideoBrief {
  bvid: string;
  title: string;
  /** 简介（本轮抓到的；空就不写）。 */
  desc: string;
  /** 已有的理解（一轮的 why / oneliner；空就不写）。 */
  understanding: string;
  score?: number;
}

export interface DmDeps {
  logger: Logger;
  config: Config;
  writer: BiliWriter;
  state: AppStateStore;
  secrets: SecretsService;
  now?: () => Date;
}

export interface DmSendResult {
  ok: boolean;
  dryRun: boolean;
  sent: number;
  texts: string[];
  skipped: string[];
  error?: string;
}

const MAX_CHARS = 500;
const MAX_SHARE_VIDEOS = 5;
const MAX_DIARY_PARTS = 5;

/** 收信人：主人（`account.ownerMid`）。没配/配成登录账号本身 → 0，调用方会拒绝并说明原因。 */
export function dmReceiver(deps: DmDeps): number {
  const owner = resolveOwner(deps.config, deps.secrets.selfMid());
  return owner.ok ? owner.mid : 0;
}

/** 私信渠道是否可用（enabled + 主人可用）。 */
export function dmChannel(deps: DmDeps): { enabled: boolean; receiver: number; reason?: string } {
  const channel = (deps.config.notify.channels ?? []).find((item) => item.type === 'dm');
  const owner = resolveOwner(deps.config, deps.secrets.selfMid());
  if (!channel?.enabled) return { enabled: false, receiver: 0, reason: '通知里的私信渠道关着' };
  if (!owner.ok) return { enabled: false, receiver: 0, reason: owner.problem ?? '主人还没配置' };
  return { enabled: true, receiver: owner.mid };
}

/* ---------------- 文案组装（纯函数，好测） ---------------- */

/** 分享私信：一轮合并成一条，≤500 字，最多 5 条视频。 */
export function composeShareDm(items: DmVideoBrief[], maxChars = MAX_CHARS): string {
  const picked = items.slice(0, MAX_SHARE_VIDEOS);
  const lines: string[] = ['今天看了这几条，值得你看一眼：'];
  for (const item of picked) {
    const one = item.understanding ? `：${item.understanding}` : '';
    lines.push(`· ${item.title}${one}`);
    lines.push(`  https://www.bilibili.com/video/${item.bvid}`);
  }
  let text = lines.join('\n');
  if (countChars(text) > maxChars) {
    text = `${Array.from(text).slice(0, maxChars - 1).join('')}…`;
  }
  return text;
}

/** 摘要私信：≤500，超长截断并注明去面板看全文。 */
export function composeSummaryDm(summary: string, maxChars = MAX_CHARS): string {
  const clean = summary.trim();
  if (countChars(clean) <= maxChars) return clean;
  const head = Array.from(clean).slice(0, maxChars - 18).join('').trimEnd();
  return `${head}…（完整内容在面板）`;
}

/** 视频信息私信：标题 + 链接 + 简介（≤200）+ 已有理解；总长 ≤500。没有的就不写。 */
export function composeVideoInfoDm(item: DmVideoBrief, maxChars = MAX_CHARS): string {
  const parts: string[] = [`${item.title}`, `https://www.bilibili.com/video/${item.bvid}`];
  const desc = truncate(item.desc.trim(), 200);
  if (desc) parts.push(desc);
  const understanding = item.understanding.trim();
  if (understanding) parts.push(`我觉得：${understanding}`);

  let text = parts.join('\n');
  if (countChars(text) > maxChars) {
    // 按文档要求：超长先截简介，保标题/链接/理解
    const withoutDesc = [`${item.title}`, `https://www.bilibili.com/video/${item.bvid}`];
    if (understanding) withoutDesc.push(`我觉得：${understanding}`);
    text = withoutDesc.join('\n');
    if (countChars(text) > maxChars) text = Array.from(text).slice(0, maxChars - 1).join('') + '…';
  }
  return text;
}

/** 公开日记：按 ≤500 分段，最多 5 段；超过 5 段就不分段发了（返回 null 让调用方改发摘要）。 */
export function splitDiary(text: string, maxChars = MAX_CHARS, maxParts = MAX_DIARY_PARTS): string[] | null {
  const clean = text.trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  if (countChars(clean) <= maxChars) return [clean];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars - 4) {
    parts.push(chars.slice(i, i + maxChars - 4).join(''));
    if (parts.length > maxParts) return null;
  }
  return parts.slice(0, maxParts);
}

/** 只允许发今天上下文里出现过的 BV（别发给不认识的）。 */
export function allowedVideo(item: DmVideoBrief | undefined, allow: Set<string>): boolean {
  if (!item) return false;
  return allow.has(item.bvid);
}

/* ---------------- 发送 ---------------- */

/** 分享走私信：一轮合并一条；占分享额度（由调用方记账）。 */
export async function sendShareDm(
  deps: DmDeps,
  input: { items: DmVideoBrief[]; dryRun: boolean },
): Promise<DmSendResult> {
  const result: DmSendResult = { ok: false, dryRun: input.dryRun, sent: 0, texts: [], skipped: [] };
  if (input.items.length === 0) {
    result.skipped.push('没有要分享的视频');
    return result;
  }
  const channel = dmChannel(deps);
  const receiver = dmReceiver(deps);
  if (receiver <= 0) {
    result.skipped.push(resolveOwner(deps.config, deps.secrets.selfMid()).problem ?? '主人还没配置');
    return result;
  }

  const text = composeShareDm(input.items);
  const sender = deps.secrets.selfMid();
  const outcome = await deps.writer.sendDm({ receiverId: receiver, text, senderId: sender }, { dryRun: input.dryRun });
  if (!outcome.ok) {
    result.error = outcome.error?.message ?? '私信发送失败';
    return result;
  }
  result.ok = true;
  result.sent = 1;
  result.texts.push(text);
  if (!channel.enabled) result.skipped.push('通知渠道没开，但分享渠道自己发了');
  return result;
}

/**
 * 通知走私信：摘要 / 公开日记 / 视频信息，三个子开关各自独立。
 * 视频信息只用传进来的 `videos`（本轮已有的数据），**不额外请求**。
 */
export async function sendDmNotify(
  deps: DmDeps,
  input: {
    summary?: string;
    publicDiary?: string;
    videos: DmVideoBrief[];
    /** 今天上下文里出现过的 BV（白名单）。 */
    allowBvids: Set<string>;
    dryRun: boolean;
  },
): Promise<DmSendResult> {
  const result: DmSendResult = { ok: false, dryRun: input.dryRun, sent: 0, texts: [], skipped: [] };
  const channel = (deps.config.notify.channels ?? []).find((item) => item.type === 'dm');
  if (!channel?.enabled) {
    result.skipped.push('私信通知渠道关着');
    return result;
  }
  const receiver = dmReceiver(deps);
  if (receiver <= 0) {
    result.skipped.push(resolveOwner(deps.config, deps.secrets.selfMid()).problem ?? '主人还没配置');
    return result;
  }
  const sender = deps.secrets.selfMid();

  const send = async (text: string): Promise<boolean> => {
    if (countChars(text) === 0) return false;
    const outcome = await deps.writer.sendDm({ receiverId: receiver, text, senderId: sender }, { dryRun: input.dryRun });
    if (!outcome.ok) {
      result.error = outcome.error?.message ?? '私信发送失败';
      return false;
    }
    result.sent += 1;
    result.texts.push(text);
    return true;
  };

  // 1) 摘要
  if (input.summary && input.summary.trim().length > 0) {
    if (channel.sendSummary) {
      await send(composeSummaryDm(input.summary));
    } else {
      result.skipped.push('摘要子开关关着');
    }
  }

  // 2) 公开日记（私人日记永不自动发）
  if (channel.sendDiary && input.publicDiary && input.publicDiary.trim().length > 0) {
    const parts = splitDiary(input.publicDiary);
    if (parts === null) {
      result.skipped.push('公开日记太长（>5 段），只发摘要，全文去面板看');
    } else {
      for (const part of parts) {
        const ok = await send(part);
        if (!ok) break;
      }
    }
  } else if (!channel.sendDiary) {
    result.skipped.push('日记子开关关着');
  }

  // 3) 视频信息（最多 3 条，且必须在白名单里）
  if (channel.sendVideoInfo && input.videos.length > 0) {
    let sentVideos = 0;
    for (const video of input.videos) {
      if (sentVideos >= 3) break;
      if (!allowedVideo(video, input.allowBvids)) {
        result.skipped.push(`${video.bvid} 不在今天的上下文里，不发`);
        continue;
      }
      if (await send(composeVideoInfoDm(video))) sentVideos += 1;
    }
  } else if (!channel.sendVideoInfo) {
    result.skipped.push('视频信息子开关关着');
  }

  result.ok = result.sent > 0;
  return result;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}
