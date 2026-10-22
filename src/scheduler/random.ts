/**
 * 随机源。
 *
 * 职责：生物钟的随机时刻与「今天不想看」的掷骰都从这里取数，生产用 crypto，测试可注入固定序列。
 * 不做什么：不做种子管理（生产不用固定种子，否则作息会被预测）。
 */

import crypto from 'node:crypto';

export interface RandomSource {
  /** 闭区间 [min, max] 的整数。 */
  int(min: number, max: number): number;
  /** [0, 1) 的浮点数。 */
  float(): number;
}

export const cryptoRandom: RandomSource = {
  int(min, max) {
    if (max <= min) return min;
    return crypto.randomInt(min, max + 1);
  },
  float() {
    return crypto.randomInt(0, 2 ** 30) / 2 ** 30;
  },
};

/** 测试用：按给定序列循环取值。int 走整数序列，float 走浮点序列。 */
export function scriptedRandom(ints: number[], floats: number[] = []): RandomSource {
  let intIndex = 0;
  let floatIndex = 0;
  return {
    int(min, max) {
      const raw = ints[intIndex % Math.max(ints.length, 1)] ?? min;
      intIndex += 1;
      return Math.min(max, Math.max(min, Math.round(raw)));
    },
    float() {
      const raw = floats[floatIndex % Math.max(floats.length, 1)] ?? 0.99;
      floatIndex += 1;
      return Math.min(0.999999, Math.max(0, raw));
    },
  };
}
