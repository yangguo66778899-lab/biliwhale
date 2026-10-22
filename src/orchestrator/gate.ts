/**
 * 分享闸门（纯函数）。
 *
 * 职责：把 §10.1 的规则写成代码。模型说「发」不算数，这里说发才算。
 *   所有拒绝理由都会返回（不是遇到第一个就 return），这样报告里能解释「为什么没发」。
 * 不做什么：不执行发送、不读文件（输入全是标量）。
 */

export interface GateInput {
  /** 总写开关 / 急停 / 预演。 */
  writeEnabled: boolean;
  killSwitch: boolean;
  dryRun: boolean;
  /** 分享开关与渠道。 */
  shareEnabled: boolean;
  channel: 'comment' | 'dm' | 'none';
  allowedChannels: string[];
  /** 分数。 */
  score: number;
  minScore: number;
  scoreEnabled: boolean;
  /** 来源：只从深读里挑。 */
  deepRead: boolean;
  /** 额度。 */
  todayShares: number;
  shareCap: number;
  dailyCap: number;
  /** 同视频冷却。 */
  lastShareAt: string | null;
  perVideoDays: number;
  /** 沉默衰减（0 = 归零）。 */
  silenceCap: number;
  /** 风控冷却中。 */
  riskCooldown: boolean;
  now?: Date;
}

export interface GateDecision {
  allow: boolean;
  /** 拒绝理由（按检查顺序）。 */
  deny: string[];
  /** 通过但需要记录的说明（如预演）。 */
  notes: string[];
}

export function gateShare(input: GateInput): GateDecision {
  const deny: string[] = [];
  const notes: string[] = [];
  const now = input.now ?? new Date();

  if (!input.writeEnabled) deny.push('总写开关关着');
  if (input.killSwitch) deny.push('急停开着');
  if (!input.shareEnabled) deny.push('分享总开关关着');
  if (input.channel === 'none') deny.push('模型自己说不发');
  if (input.channel !== 'none' && !input.allowedChannels.includes(input.channel)) deny.push(`渠道未开：${input.channel}`);
  if (!input.deepRead) deny.push('只从深读过里挑');
  if (input.scoreEnabled && input.score < input.minScore) deny.push(`分数不够（${input.score} < ${input.minScore}）`);
  if (input.riskCooldown) deny.push('风控冷却中');

  const cap = Math.min(input.shareCap, input.dailyCap, input.silenceCap);
  if (cap <= 0) deny.push(input.silenceCap <= 0 ? '沉默衰减归零' : '今日额度为 0');
  else if (input.todayShares >= cap) deny.push(`今日额度用完（${input.todayShares}/${cap}）`);

  if (input.lastShareAt) {
    const last = Date.parse(input.lastShareAt);
    if (Number.isFinite(last)) {
      const elapsedDays = (now.getTime() - last) / 86_400_000;
      if (elapsedDays < input.perVideoDays) {
        deny.push(`同视频冷却中（${Math.floor(elapsedDays)}/${input.perVideoDays} 天）`);
      }
    }
  }

  if (input.dryRun) notes.push('预演模式：即使通过也不会真的发');

  return { allow: deny.length === 0, deny, notes };
}

/** 额度剩余条数（报告与面板都要显示「今天还能发几条」）。 */
export function remainingShareQuota(input: Pick<GateInput, 'todayShares' | 'shareCap' | 'dailyCap' | 'silenceCap'>): number {
  const cap = Math.min(input.shareCap, input.dailyCap, input.silenceCap);
  return Math.max(0, cap - input.todayShares);
}
