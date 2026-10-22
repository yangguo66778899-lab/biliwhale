/**
 * 「今天为什么没做」——把各开关/闸门/模型的结果翻译成一句人话。
 *
 * 为什么单独一个纯函数：用户看不到执行器的日志，只会觉得「收藏一直是开的，怎么没收藏过」。
 * 这段只回答「为什么」，不重复执行细节（执行细节在上面几行）；也不允许出现「未知」这种废话。
 */

import type { Config } from '../config/spec.ts';
import type { RoundResult } from '../shared/types.ts';

export interface WhyNotLine {
  label: string;
  text: string;
}

export interface WhyNotInput {
  config: Config;
  result: Pick<RoundResult, 'selected' | 'favorite'>;
  /** 私信通知渠道是否开着（由调用方算好，避免这里再依赖 channels 形状）。 */
  dmChannelOn: boolean;
  /** 本轮是否是预演（预演时「会做」要写成「预演：会…」）。 */
  dryRun: boolean;
}

export function buildWhyNot(input: WhyNotInput): WhyNotLine[] {
  const cfg = input.config;
  const lines: WhyNotLine[] = [];
  const dry = input.dryRun ? '预演：会' : '会';

  // 收藏
  if (!cfg.fav.enabled) {
    lines.push({ label: '收藏', text: '开关关着' });
  } else if (!input.result.favorite) {
    lines.push({ label: '收藏', text: '模型这一轮没提（它觉得都不值得留）' });
  } else {
    lines.push({
      label: '收藏',
      text: `${dry}收藏 ${input.result.favorite.bvid}（理由：${input.result.favorite.reason.slice(0, 20)}…）`,
    });
  }

  // 点赞
  if (!cfg.like.enabled) {
    lines.push({ label: '点赞', text: '开关关着（默认关）' });
  } else if (input.result.selected.length === 0) {
    lines.push({ label: '点赞', text: '这一轮没有挑中的视频' });
  } else {
    lines.push({ label: '点赞', text: `${dry}点第一条：${input.result.selected[0]?.bvid ?? ''}` });
  }

  // 动态
  lines.push({ label: '动态', text: '只能从面板手动发（一轮里永远不会自动发）' });

  // 私信分享
  if (!cfg.share.enabled) {
    lines.push({ label: '私信分享', text: '分享开关关着' });
  } else if (cfg.share.via !== 'dm') {
    lines.push({ label: '私信分享', text: '分享渠道设的是「评论」，不是私信' });
  } else {
    lines.push({ label: '私信分享', text: '见上面的分享执行结果（发送/拒绝原因都写在那里）' });
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
