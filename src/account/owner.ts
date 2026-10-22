/**
 * 「主人」是谁 —— 全程序唯一入口。
 *
 * 背景（真机反馈）：一开始我把「登录账号」当成了「主人」，因为文档 §8.2 的配置表只写了登录账号的 mid/name，
 * 而 §7.9 又要求「只认 owner.mid」。这在单账号自用时勉强能跑，但只要「鲸鲸」和「你」是两个号，
 * 就会全线错位：@ 变成 @ 自己、私信发给自己、聊天永远不回你。
 *
 * 现在的规矩（用户拍板：**必须是两个号，不做回退**）：
 *   - `account.mid/name` = 登录账号（鲸鲸自己），由登录自动回填，只用于「发送方身份」与「跳过自己回自己」；
 *   - `account.ownerMid/ownerName` = 主人（你），**必填**；@、私信收件人、聊天鉴权、主人直发都用它；
 *   - 缺主人 UID、或主人 UID 等于登录账号 → 所有「要主人」的功能明确拒绝（不猜、不回退）。
 *
 * 不做什么：不发请求、不写配置（自动取昵称是另一个函数 + 调用方决定）。
 */

import type { Config } from '../config/spec.ts';

export interface OwnerRef {
  /** 主人 UID；0 = 没配。 */
  mid: number;
  /** 主人昵称（用于评论 @）；可能为空（需要自动取或手填）。 */
  name: string;
  /** 能不能用：mid > 0 且不等于登录账号。 */
  ok: boolean;
  /** 不能用时的原因（直接写进报告/面板，告诉用户去改哪）。 */
  problem?: string;
}

/** 解析主人；`selfMid` 是登录账号的 UID（用来挡「主人 = 自己」）。 */
export function resolveOwner(config: Config, selfMid: number): OwnerRef {
  const mid = Number(config.account?.ownerMid ?? 0);
  const name = String(config.account?.ownerName ?? '').trim();

  if (!Number.isFinite(mid) || mid <= 0) {
    return { mid: 0, name, ok: false, problem: '还没填主人 UID（设置 → 账号 → 主人 UID；必须是另一个 B 站账号）' };
  }
  if (selfMid > 0 && mid === selfMid) {
    return { mid, name, ok: false, problem: `主人 UID 不能等于登录账号（${selfMid}）：请填你自己的号，不要填「鲸鲸」的号` };
  }
  if (name.length === 0) {
    return { mid, name, ok: true, problem: '主人昵称还没填：评论里不会 @ 到人；可在「账号」页按 UID 自动取' };
  }
  return { mid, name, ok: true };
}

/** 评论 @ 用：只有确认可用且昵称非空才返回；否则 null（调用方据此拒绝或跳过 @）。 */
export function ownerMention(owner: OwnerRef): string | null {
  return owner.ok && owner.name.length > 0 ? owner.name : null;
}

/** 给日志/面板的一句话。 */
export function describeOwner(owner: OwnerRef): string {
  if (!owner.ok) return `主人未配置：${owner.problem ?? '未知原因'}`;
  return owner.name ? `${owner.name}（${owner.mid}）` : `UID ${owner.mid}（昵称待填）`;
}
