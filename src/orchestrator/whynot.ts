/**
 * 「今天为什么没做」——把各开关/闸门/执行结果翻译成一句人话。
 *
 * 为什么单独一个纯函数：用户看不到执行器的日志，只会觉得「收藏一直是开的，怎么没收藏过」。
 * 这段只回答「为什么」，不重复执行细节；也**不许**写「会做」当作结果——
 * 2026-10-22 真机报告就出过这个错：这一节写「点赞：会点第一条」，运行备注却写「没点赞：风控冷却中」，
 * 同一个报告里自相矛盾。所以现在优先看执行结果，没有结果时才写「会…」。
 * 也不允许出现「未知」这种废话。
 */

import type { Config } from '../config/spec.ts';
import type { RoundResult } from '../shared/types.ts';

export interface WhyNotLine {
  label: string;
  text: string;
}

/** 执行器回来的结果（share/like/fav 形状不同，这里只取这几项）。 */
export interface WhyNotOutcome {
  status: 'sent' | 'held' | 'unverified' | 'failed' | 'denied' | 'dry_run';
  deny?: string[];
  note?: string;
  bvid?: string;
}

export interface WhyNotInput {
  config: Config;
  result: Pick<RoundResult, 'selected' | 'favorite'>;
  /** 私信通知渠道是否开着（由调用方算好，避免这里再依赖 channels 形状）。 */
  dmChannelOn: boolean;
  /** 本轮是否是预演（预演时「会做」要写成「预演：会…」）。 */
  dryRun: boolean;
  /** 真实执行结果：有就按结果写，没有才写「会…」。 */
  share?: WhyNotOutcome | null;
  fav?: WhyNotOutcome | null;
  like?: WhyNotOutcome | null;
  /** 写冷却截止时间（ISO）；被冷却拒绝的行会补「到 HH:mm」。 */
  riskCooldownUntil?: string | null;
  now?: Date;
}

function clockOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? (match[1] ?? '') : '';
}

export function buildWhyNot(input: WhyNotInput): WhyNotLine[] {
  const cfg = input.config;
  const lines: WhyNotLine[] = [];
  const dry = input.dryRun ? '预演：会' : '会';
  const now = input.now ?? new Date();
  const cooldownUntil = input.riskCooldownUntil ?? null;
  const cooldownClock = clockOf(cooldownUntil);
  const cooldownActive = cooldownUntil !== null && Date.parse(cooldownUntil) > now.getTime();

  /** 被风控冷却拒绝的行补上「到 HH:mm」，否则用户不知道什么时候恢复。 */
  const withCooldown = (text: string): string => {
    if (!cooldownActive || !cooldownClock) return text;
    if (!text.includes('风控冷却')) return text;
    return `${text}（冷却到 ${cooldownClock}）`;
  };

  /** 执行结果 → 一句人话；认不出来的结果返回 null。 */
  const describe = (outcome: WhyNotOutcome, what: string, bvid: string): string | null => {
    if (outcome.status === 'sent' || outcome.status === 'held' || outcome.status === 'unverified') {
      const suffix =
        outcome.status === 'held' ? '（被 B 站挂起：别人可能看不到）' : outcome.status === 'unverified' ? '（没复核上）' : '';
      return `${what}${bvid ? ` ${bvid}` : ''}${suffix}`;
    }
    if (outcome.status === 'dry_run') return `预演：${what}${bvid ? ` ${bvid}` : ''}（没真做）`;
    if (outcome.status === 'denied') return withCooldown(`没${what}：${(outcome.deny ?? []).join('；') || '被闸门拒绝'}`);
    if (outcome.status === 'failed') return `没${what}：${outcome.note || '执行失败'}`;
    return null;
  };

  // 分享（评论 / 私信）——本轮最该被解释的一件事，以前这一节里根本没有它
  const viaName = cfg.share.via === 'dm' ? '私信' : '评论';
  if (!cfg.share.enabled) {
    lines.push({ label: '分享', text: '分享开关关着' });
  } else if (input.share) {
    lines.push({ label: '分享', text: describe(input.share, '发', input.share.bvid ?? '') ?? '这轮没有发（见上面的分享结果）' });
  } else if (input.result.selected.length === 0) {
    lines.push({ label: '分享', text: '这轮没有挑中的视频' });
  } else {
    lines.push({ label: '分享', text: `这轮没有执行分享（渠道是${viaName}，见上面的报错）` });
  }

  // 收藏
  if (!cfg.fav.enabled) {
    lines.push({ label: '收藏', text: '开关关着' });
  } else if (input.fav) {
    lines.push({ label: '收藏', text: describe(input.fav, '收藏', input.fav.bvid ?? '') ?? '收藏结果不明（见上面的报错）' });
  } else if (!input.result.favorite) {
    lines.push({ label: '收藏', text: '模型这一轮没提（没写就是没提）' });
  } else {
    lines.push({
      label: '收藏',
      text: `${dry}收藏 ${input.result.favorite.bvid}（理由：${input.result.favorite.reason.slice(0, 20)}…）`,
    });
  }

  // 点赞
  if (!cfg.like.enabled) {
    lines.push({ label: '点赞', text: '开关关着（默认关）' });
  } else if (input.like) {
    lines.push({ label: '点赞', text: describe(input.like, '点', input.like.bvid ?? '') ?? '点赞结果不明（见上面的报错）' });
  } else if (input.result.selected.length === 0) {
    lines.push({ label: '点赞', text: '这一轮没有挑中的视频' });
  } else {
    lines.push({ label: '点赞', text: `${dry}点第一条：${input.result.selected[0]?.bvid ?? ''}` });
  }

  // 动态：不是「没做」，是根本不在自动范围里（写清楚，别让人以为漏了）
  lines.push({ label: '动态', text: '这轮不发（只能在面板手动发，一轮里永不自动）' });

  // 私信分享
  if (!cfg.share.enabled) {
    lines.push({ label: '私信分享', text: '分享开关关着' });
  } else if (cfg.share.via !== 'dm') {
    lines.push({ label: '私信分享', text: '这轮走评论渠道，不是私信（设置里的「发在哪儿」）' });
  } else {
    lines.push({ label: '私信分享', text: '见上面的分享结果（合并成一条，发送/拒绝原因都写在那里）' });
  }

  // 私信通知
  if (!input.dmChannelOn) {
    lines.push({ label: '私信通知', text: '渠道关着' });
  } else {
    lines.push({ label: '私信通知', text: '见上面的「私信通知」行（发了 N 条 / 为什么没发）' });
  }

  // 评论监听
  if (!cfg.listen.comment.enabled) {
    lines.push({ label: '评论监听', text: '开关关着' });
  } else {
    lines.push({ label: '评论监听', text: '监听是独立循环，本轮只做了「分享后的回复扫描」' });
  }

  return lines;
}
