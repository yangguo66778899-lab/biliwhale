/**
 * 二维码编码器（纯 TypeScript，零依赖，离线可用）。
 *
 * 职责：把一段文本编成二维码模块矩阵。只实现产品需要的那一档：
 *   - 字节模式（UTF-8）、纠错等级 M（默认）/ L / Q / H；
 *   - 版本 1–10（M 级最大 213 字节，够画 B 站登录 URL）；
 *   - 掩码按标准罚分自动挑（也可以强制指定，测试用）。
 * 不做什么：不画图片（由 UI 把矩阵画成 SVG/CSS）、不解析二维码、不支持汉字模式/Kanji。
 *
 * 正确性靠 `test/qr.test.ts` 与**外部参照**逐模块对拍（fixtures/qr-reference.json）。
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  version: number;
  size: number;
  /** 纠错等级。 */
  ecLevel: EcLevel;
  /** 用的掩码（0–7）。 */
  mask: number;
  /** modules[y][x] = true 表示深色。 */
  modules: boolean[][];
}

interface BlockSpec {
  /** 每块数据码字数。 */
  dataCodewords: number;
  /** 该组块数。 */
  count: number;
}

interface VersionSpec {
  /** 总码字数（数据 + 纠错）。 */
  totalCodewords: number;
  /** 每块纠错码字数。 */
  ecCodewordsPerBlock: number;
  /** 分组：同组内数据码字数相同。 */
  blocks: BlockSpec[];
  /** 对齐图案中心坐标。 */
  alignment: number[];
}

/** 版本 1–10 的结构表（Q 级除外，产品只用 M/L/Q/H 的这几个版本）。 */
const VERSIONS: Record<number, Record<EcLevel, VersionSpec>> = {
  1: {
    L: { totalCodewords: 26, ecCodewordsPerBlock: 7, blocks: [{ dataCodewords: 19, count: 1 }], alignment: [] },
    M: { totalCodewords: 26, ecCodewordsPerBlock: 10, blocks: [{ dataCodewords: 16, count: 1 }], alignment: [] },
    Q: { totalCodewords: 26, ecCodewordsPerBlock: 13, blocks: [{ dataCodewords: 13, count: 1 }], alignment: [] },
    H: { totalCodewords: 26, ecCodewordsPerBlock: 17, blocks: [{ dataCodewords: 9, count: 1 }], alignment: [] },
  },
  2: {
    L: { totalCodewords: 44, ecCodewordsPerBlock: 10, blocks: [{ dataCodewords: 34, count: 1 }], alignment: [6, 18] },
    M: { totalCodewords: 44, ecCodewordsPerBlock: 16, blocks: [{ dataCodewords: 28, count: 1 }], alignment: [6, 18] },
    Q: { totalCodewords: 44, ecCodewordsPerBlock: 22, blocks: [{ dataCodewords: 22, count: 1 }], alignment: [6, 18] },
    H: { totalCodewords: 44, ecCodewordsPerBlock: 28, blocks: [{ dataCodewords: 16, count: 1 }], alignment: [6, 18] },
  },
  3: {
    L: { totalCodewords: 70, ecCodewordsPerBlock: 15, blocks: [{ dataCodewords: 55, count: 1 }], alignment: [6, 22] },
    M: { totalCodewords: 70, ecCodewordsPerBlock: 26, blocks: [{ dataCodewords: 44, count: 1 }], alignment: [6, 22] },
    Q: { totalCodewords: 70, ecCodewordsPerBlock: 18, blocks: [{ dataCodewords: 17, count: 2 }], alignment: [6, 22] },
    H: { totalCodewords: 70, ecCodewordsPerBlock: 22, blocks: [{ dataCodewords: 13, count: 2 }], alignment: [6, 22] },
  },
  4: {
    L: { totalCodewords: 100, ecCodewordsPerBlock: 20, blocks: [{ dataCodewords: 80, count: 1 }], alignment: [6, 26] },
    M: { totalCodewords: 100, ecCodewordsPerBlock: 18, blocks: [{ dataCodewords: 32, count: 2 }], alignment: [6, 26] },
    Q: { totalCodewords: 100, ecCodewordsPerBlock: 26, blocks: [{ dataCodewords: 24, count: 2 }], alignment: [6, 26] },
    H: { totalCodewords: 100, ecCodewordsPerBlock: 16, blocks: [{ dataCodewords: 9, count: 4 }], alignment: [6, 26] },
  },
  5: {
    L: { totalCodewords: 134, ecCodewordsPerBlock: 26, blocks: [{ dataCodewords: 108, count: 1 }], alignment: [6, 30] },
    M: { totalCodewords: 134, ecCodewordsPerBlock: 24, blocks: [{ dataCodewords: 43, count: 2 }], alignment: [6, 30] },
    Q: { totalCodewords: 134, ecCodewordsPerBlock: 18, blocks: [{ dataCodewords: 15, count: 2 }, { dataCodewords: 16, count: 2 }], alignment: [6, 30] },
    H: { totalCodewords: 134, ecCodewordsPerBlock: 22, blocks: [{ dataCodewords: 11, count: 2 }, { dataCodewords: 12, count: 2 }], alignment: [6, 30] },
  },
  6: {
    L: { totalCodewords: 172, ecCodewordsPerBlock: 18, blocks: [{ dataCodewords: 68, count: 2 }], alignment: [6, 34] },
    M: { totalCodewords: 172, ecCodewordsPerBlock: 16, blocks: [{ dataCodewords: 27, count: 4 }], alignment: [6, 34] },
    Q: { totalCodewords: 172, ecCodewordsPerBlock: 24, blocks: [{ dataCodewords: 19, count: 4 }], alignment: [6, 34] },
    H: { totalCodewords: 172, ecCodewordsPerBlock: 28, blocks: [{ dataCodewords: 15, count: 4 }], alignment: [6, 34] },
  },
  7: {
    L: { totalCodewords: 196, ecCodewordsPerBlock: 20, blocks: [{ dataCodewords: 78, count: 2 }], alignment: [6, 22, 38] },
    M: { totalCodewords: 196, ecCodewordsPerBlock: 18, blocks: [{ dataCodewords: 31, count: 4 }], alignment: [6, 22, 38] },
    Q: { totalCodewords: 196, ecCodewordsPerBlock: 18, blocks: [{ dataCodewords: 14, count: 2 }, { dataCodewords: 15, count: 4 }], alignment: [6, 22, 38] },
    H: { totalCodewords: 196, ecCodewordsPerBlock: 26, blocks: [{ dataCodewords: 13, count: 4 }, { dataCodewords: 14, count: 1 }], alignment: [6, 22, 38] },
  },
  8: {
    L: { totalCodewords: 242, ecCodewordsPerBlock: 24, blocks: [{ dataCodewords: 97, count: 2 }], alignment: [6, 24, 42] },
    M: {
      totalCodewords: 242,
      ecCodewordsPerBlock: 22,
      blocks: [
        { dataCodewords: 38, count: 2 },
        { dataCodewords: 39, count: 2 },
      ],
      alignment: [6, 24, 42],
    },
    Q: { totalCodewords: 242, ecCodewordsPerBlock: 22, blocks: [{ dataCodewords: 18, count: 4 }, { dataCodewords: 19, count: 2 }], alignment: [6, 24, 42] },
    H: { totalCodewords: 242, ecCodewordsPerBlock: 26, blocks: [{ dataCodewords: 14, count: 4 }, { dataCodewords: 15, count: 2 }], alignment: [6, 24, 42] },
  },
  9: {
    L: { totalCodewords: 292, ecCodewordsPerBlock: 30, blocks: [{ dataCodewords: 116, count: 2 }], alignment: [6, 26, 46] },
    M: {
      totalCodewords: 292,
      ecCodewordsPerBlock: 22,
      blocks: [
        { dataCodewords: 36, count: 3 },
        { dataCodewords: 37, count: 2 },
      ],
      alignment: [6, 26, 46],
    },
    Q: { totalCodewords: 292, ecCodewordsPerBlock: 20, blocks: [{ dataCodewords: 16, count: 4 }, { dataCodewords: 17, count: 4 }], alignment: [6, 26, 46] },
    H: { totalCodewords: 292, ecCodewordsPerBlock: 24, blocks: [{ dataCodewords: 12, count: 4 }, { dataCodewords: 13, count: 4 }], alignment: [6, 26, 46] },
  },
  10: {
    L: { totalCodewords: 346, ecCodewordsPerBlock: 18, blocks: [{ dataCodewords: 68, count: 2 }, { dataCodewords: 69, count: 2 }], alignment: [6, 28, 50] },
    M: {
      totalCodewords: 346,
      ecCodewordsPerBlock: 26,
      blocks: [
        { dataCodewords: 43, count: 4 },
        { dataCodewords: 44, count: 1 },
      ],
      alignment: [6, 28, 50],
    },
    Q: { totalCodewords: 346, ecCodewordsPerBlock: 24, blocks: [{ dataCodewords: 19, count: 6 }, { dataCodewords: 20, count: 2 }], alignment: [6, 28, 50] },
    H: { totalCodewords: 346, ecCodewordsPerBlock: 28, blocks: [{ dataCodewords: 15, count: 6 }, { dataCodewords: 16, count: 2 }], alignment: [6, 28, 50] },
  },
};

const MAX_VERSION = 10;

export class QrError extends Error {}

/** 数据码字总数（用于算容量）。 */
export function dataCodewords(version: number, ec: EcLevel): number {
  const spec = specOf(version, ec);
  return spec.blocks.reduce((sum, block) => sum + block.dataCodewords * block.count, 0);
}

/** 字节模式下能装多少字节。 */
export function byteCapacity(version: number, ec: EcLevel): number {
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataCodewords(version, ec) * 8 - 4 - countBits) / 8);
}

export function encodeQr(text: string, options: { ecLevel?: EcLevel; version?: number; mask?: number } = {}): QrMatrix {
  const ecLevel = options.ecLevel ?? 'M';
  const bytes = Array.from(new TextEncoder().encode(text));

  let version = options.version ?? 0;
  if (version === 0) {
    for (let candidate = 1; candidate <= MAX_VERSION; candidate += 1) {
      if (byteCapacity(candidate, ecLevel) >= bytes.length) {
        version = candidate;
        break;
      }
    }
    if (version === 0) throw new QrError(`内容太长（${bytes.length} 字节），版本 10 的 ${ecLevel} 级最多 ${byteCapacity(MAX_VERSION, ecLevel)} 字节`);
  }
  const capacity = byteCapacity(version, ecLevel);
  if (bytes.length > capacity) throw new QrError(`内容 ${bytes.length} 字节超过版本 ${version} 的容量 ${capacity} 字节`);

  const spec = specOf(version, ecLevel);
  const bits: number[] = [];
  const pushBits = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  // 字节模式：0100 + 长度 + 数据
  pushBits(0b0100, 4);
  pushBits(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) pushBits(byte, 8);

  const totalDataBits = dataCodewords(version, ecLevel) * 8;
  // 终止符：最多 4 个 0
  for (let i = 0; i < 4 && bits.length < totalDataBits; i += 1) bits.push(0);
  // 补齐到整字节
  while (bits.length % 8 !== 0) bits.push(0);
  // 补 0xEC / 0x11
  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | (bits[i + b] ?? 0);
    dataBytes.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (dataBytes.length < dataCodewords(version, ecLevel)) {
    dataBytes.push(padBytes[padIndex % 2] as number);
    padIndex += 1;
  }

  // 分块 + 纠错
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const blockSpec of spec.blocks) {
    for (let i = 0; i < blockSpec.count; i += 1) {
      const block = dataBytes.slice(offset, offset + blockSpec.dataCodewords);
      offset += blockSpec.dataCodewords;
      dataBlocks.push(block);
      ecBlocks.push(reedSolomon(block, spec.ecCodewordsPerBlock));
    }
  }

  // 交错：数据先、纠错后
  const finalBytes: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of dataBlocks) {
      const value = block[i];
      if (value !== undefined) finalBytes.push(value);
    }
  }
  const maxEc = Math.max(...ecBlocks.map((block) => block.length));
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecBlocks) {
      const value = block[i];
      if (value !== undefined) finalBytes.push(value);
    }
  }
  if (finalBytes.length !== spec.totalCodewords) {
    throw new QrError(`码字数不对：拼出 ${finalBytes.length}，表里是 ${spec.totalCodewords}`);
  }

  const size = version * 4 + 17;
  const best = options.mask !== undefined ? options.mask : bestMask(finalBytes, version, ecLevel, size);
  return buildMatrix(finalBytes, version, ecLevel, size, best);
}

function specOf(version: number, ec: EcLevel): VersionSpec {
  const spec = VERSIONS[version]?.[ec];
  if (!spec) throw new QrError(`不支持的版本/等级：v${version} ${ec}`);
  return spec;
}

/** 数据字节 → 矩阵。 */
function buildMatrix(data: number[], version: number, ecLevel: EcLevel, size: number, mask: number): QrMatrix {
  const modules: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false));

  const set = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y]![x] = dark;
    reserved[y]![x] = true;
  };
  const isReserved = (x: number, y: number): boolean => x < 0 || y < 0 || x >= size || y >= size || reserved[y]![x] === true;

  // 定位图案（含 1 像素分隔带）
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const x = fx + dx;
        const y = fy + dy;
        const outer = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) || (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6));
        const inner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        set(x, y, outer || inner);
      }
    }
  }
  // 定位图案外面那圈是「保留但浅色」，上面的 set 已经把它们标成保留

  // 定时图案
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    set(i, 6, dark);
    set(6, i, dark);
  }

  // 对齐图案
  const spec = specOf(version, ecLevel);
  const centers = spec.alignment;
  for (const cy of centers) {
    for (const cx of centers) {
      // 跳过与定位图案重叠的三个角
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          set(cx + dx, cy + dy, dark);
        }
      }
    }
  }

  // 格式信息区域先占位（稍后写入真值）：两份共 30 个模块，必须全部保留，
  // 否则数据位会错位（对外参照时踩到过：漏了左下 7 个，整个数据区全歪）。
  for (let i = 0; i <= 8; i += 1) {
    if (i === 6) continue; // 定时图案所在行列
    set(8, i, false); // 列：x=8, y=i
    set(i, 8, false); // 行：x=i, y=8
  }
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, false); // 右上那份（行 8）
  for (let i = 0; i < 7; i += 1) set(8, size - 1 - i, false); // 左下那份（列 8）
  // 深色模块
  set(8, size - 8, true);

  // 版本信息（v7+）
  if (version >= 7) {
    const versionBits = versionInfoBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((versionBits >>> i) & 1) === 1;
      const x = Math.floor(i / 3);
      const y = i % 3;
      set(size - 11 + y, x, bit);
      set(x, size - 11 + y, bit);
    }
  }

  // 数据区（右下角开始，两列一组，蛇形）
  let bitIndex = 0;
  const totalBits = data.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过定时列
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let col = 0; col < 2; col += 1) {
        const x = right - col;
        if (isReserved(x, y)) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          const byte = data[Math.floor(bitIndex / 8)] as number;
          dark = ((byte >>> (7 - (bitIndex % 8))) & 1) === 1;
          bitIndex += 1;
        }
        modules[y]![x] = dark;
      }
    }
    upward = !upward;
  }

  // 掩码
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (reserved[y]![x]) continue;
      if (maskBit(mask, x, y)) modules[y]![x] = !modules[y]![x];
    }
  }

  // 格式信息
  const formatBits = formatInfoBits(ecLevel, mask);
  const fmtPositions: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i += 1) fmtPositions.push([8, i]);
  fmtPositions.push([8, 7]);
  fmtPositions.push([8, 8]);
  fmtPositions.push([7, 8]);
  for (let i = 9; i <= 14; i += 1) fmtPositions.push([14 - i, 8]);
  for (let i = 0; i < 15; i += 1) {
    const bit = ((formatBits >>> i) & 1) === 1;
    const [x, y] = fmtPositions[i] as [number, number];
    modules[y]![x] = bit;
  }
  // 第二份（右上 + 左下）
  for (let i = 0; i < 15; i += 1) {
    const bit = ((formatBits >>> i) & 1) === 1;
    if (i < 8) {
      modules[8]![size - 1 - i] = bit;
    } else {
      modules[size - 15 + i]![8] = bit;
    }
  }

  return { version, size, ecLevel, mask, modules };
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

/** 标准罚分，挑最小的掩码。 */
function bestMask(data: number[], version: number, ecLevel: EcLevel, size: number): number {
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = buildMatrix(data, version, ecLevel, size, mask);
    const score = penalty(matrix.modules);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }
  return best;
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  // 规则 1：同色连续 ≥5
  for (let y = 0; y < size; y += 1) {
    let run = 1;
    for (let x = 1; x < size; x += 1) {
      if (modules[y]![x] === modules[y]![x - 1]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x += 1) {
    let run = 1;
    for (let y = 1; y < size; y += 1) {
      if (modules[y]![x] === modules[y - 1]![x]) {
        run += 1;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const a = modules[y]![x];
      if (a === modules[y]![x + 1] && a === modules[y + 1]![x] && a === modules[y + 1]![x + 1]) score += 3;
    }
  }

  // 规则 3：1:1:3:1:1 且一侧有 4 白
  const pattern = [true, false, true, true, true, false, true];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x + 7 <= size; x += 1) {
      let matches = true;
      for (let i = 0; i < 7; i += 1) {
        if (modules[y]![x + i] !== pattern[i]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const before = x - 4 >= 0 ? x - 4 : -1;
      const after = x + 11 <= size ? x + 7 : -1;
      if (before >= 0) {
        let white = true;
        for (let i = before; i < x; i += 1) if (modules[y]![i]) white = false;
        if (white) score += 40;
      }
      if (after >= 0) {
        let white = true;
        for (let i = x + 7; i < after + 4; i += 1) if (modules[y]![i]) white = false;
        if (white) score += 40;
      }
    }
  }
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y + 7 <= size; y += 1) {
      let matches = true;
      for (let i = 0; i < 7; i += 1) {
        if (modules[y + i]![x] !== pattern[i]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const before = y - 4 >= 0 ? y - 4 : -1;
      const after = y + 11 <= size ? y + 7 : -1;
      if (before >= 0) {
        let white = true;
        for (let i = before; i < y; i += 1) if (modules[i]![x]) white = false;
        if (white) score += 40;
      }
      if (after >= 0) {
        let white = true;
        for (let i = y + 7; i < after + 4; i += 1) if (modules[i]![x]) white = false;
        if (white) score += 40;
      }
    }
  }

  // 规则 4：深色比例偏离 50%
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/* ---------------- 格式 / 版本信息（BCH） ---------------- */

const EC_BITS: Record<EcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

export function formatInfoBits(ecLevel: EcLevel, mask: number): number {
  const data = (EC_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return (((data << 10) | (rem & 0x3ff)) ^ 0b101010000010010) & 0x7fff;
}

export function versionInfoBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return ((version << 12) | (rem & 0xfff)) & 0x3ffff;
}

/* ---------------- Reed-Solomon ---------------- */

const GF_EXP: number[] = new Array(512);
const GF_LOG: number[] = new Array(256).fill(0);
(function initTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255] as number;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[((GF_LOG[a] as number) + (GF_LOG[b] as number)) % 255] as number;
}

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j] as number, GF_EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

/** 计算纠错码字（返回 degree 个字节）。 */
export function reedSolomon(data: number[], degree: number): number[] {
  const generator = rsGenerator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] as number) ^ gfMul(generator[i + 1] as number, factor);
    }
  }
  return remainder;
}

/* ---------------- 输出 ---------------- */

/** 矩阵 → SVG（margin 单位是模块数）。 */
export function matrixToSvg(matrix: QrMatrix, options: { moduleSize?: number; margin?: number; dark?: string; light?: string } = {}): string {
  const moduleSize = options.moduleSize ?? 4;
  const margin = options.margin ?? 2;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const size = (matrix.size + margin * 2) * moduleSize;
  let path = '';
  for (let y = 0; y < matrix.size; y += 1) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.modules[y]![x]) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < matrix.size && matrix.modules[y]![x + run]) run += 1;
      path += `M${(x + margin) * moduleSize} ${(y + margin) * moduleSize}h${run * moduleSize}v${moduleSize}h${-run * moduleSize}z`;
      x += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

/** 矩阵 → 字符串行（UI 可以直接用 CSS grid 画，测试也好比对）。 */
export function matrixToRows(matrix: QrMatrix): string[] {
  return matrix.modules.map((row) => row.map((cell) => (cell ? '1' : '0')).join(''));
}
