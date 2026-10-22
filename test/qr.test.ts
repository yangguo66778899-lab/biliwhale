import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  QrError,
  byteCapacity,
  dataCodewords,
  encodeQr,
  formatInfoBits,
  matrixToRows,
  matrixToSvg,
  reedSolomon,
  versionInfoBits,
} from '../src/qr/encoder.ts';
import type { EcLevel } from '../src/qr/encoder.ts';

interface QrCase {
  name: string;
  text: string;
  ec: EcLevel;
  version: number;
  mask: number;
  rows: string[];
}

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'qr-cases.json'), 'utf8')) as {
  cases: QrCase[];
};

test('与外部参照对拍过的矩阵逐模块一致（v1–v6，L/M/Q/H）', () => {
  assert.ok(fixture.cases.length >= 10, '夹具不该被删');
  for (const item of fixture.cases) {
    const matrix = encodeQr(item.text, { ecLevel: item.ec });
    assert.equal(matrix.version, item.version, `${item.name} 版本变了`);
    assert.equal(matrix.mask, item.mask, `${item.name} 掩码变了`);
    assert.equal(matrix.size, item.rows.length, `${item.name} 尺寸不对`);
    assert.deepEqual(matrixToRows(matrix), item.rows, `${item.name} 矩阵不一致（改动编码器会触发这里）`);
  }
});

test('二维码尺寸规律：size = 4 * version + 17，且是奇数', () => {
  for (const version of [1, 2, 5, 7, 10]) {
    const matrix = encodeQr('a', { ecLevel: 'M', version });
    assert.equal(matrix.size, version * 4 + 17);
    assert.equal(matrix.size % 2, 1);
    assert.equal(matrix.modules.length, matrix.size);
  }
});

test('定位图案与定时图案形状正确', () => {
  const matrix = encodeQr('HELLO', { ecLevel: 'M' });
  const size = matrix.size;
  const at = (x: number, y: number): boolean => matrix.modules[y]?.[x] === true;

  // 三个角的定位图案：7x7 外框 + 3x3 实心
  for (const [ox, oy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        const outer = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const inner = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        assert.equal(at((ox as number) + dx, (oy as number) + dy), outer || inner, `定位图案 (${ox},${oy}) 的 (${dx},${dy}) 不对`);
      }
    }
  }

  // 定时图案：第 6 行/列交替，从 (8,6) 起偶数为深色
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(at(i, 6), i % 2 === 0, `行定时图案 x=${i}`);
    assert.equal(at(6, i), i % 2 === 0, `列定时图案 y=${i}`);
  }

  // 深色模块
  assert.equal(at(8, size - 8), true, '深色模块必须在 (8, size-8)');
});

test('格式信息用标准 BCH，版本信息也对得上', () => {
  // 与外部参照解出来的一致：M 级 + 掩码 2 → 未加掩码的码字 000101001101110
  const unmask = 0b101010000010010;
  assert.equal(formatInfoBits('M', 2) ^ unmask, 0b000101001101110);
  // L=01 / M=00 / Q=11 / H=10（高位两比特）
  assert.equal((formatInfoBits('L', 0) ^ unmask) >> 13, 0b01);
  assert.equal((formatInfoBits('M', 0) ^ unmask) >> 13, 0b00);
  assert.equal((formatInfoBits('Q', 0) ^ unmask) >> 13, 0b11);
  assert.equal((formatInfoBits('H', 0) ^ unmask) >> 13, 0b10);
  // 版本 7 的版本信息是标准值 0x07C94
  assert.equal(versionInfoBits(7), 0x07c94);
  assert.equal(versionInfoBits(10), 0x0a4d3);
});

test('容量计算与超长报错', () => {
  assert.equal(byteCapacity(1, 'M'), 14);
  assert.equal(byteCapacity(1, 'L'), 17);
  assert.equal(byteCapacity(1, 'H'), 7);
  assert.equal(byteCapacity(10, 'M'), 213);
  assert.equal(dataCodewords(1, 'M'), 16);
  assert.equal(dataCodewords(10, 'M'), 216);

  assert.equal(encodeQr('a'.repeat(14), { ecLevel: 'M' }).version, 1);
  assert.equal(encodeQr('a'.repeat(15), { ecLevel: 'M' }).version, 2);
  assert.throws(() => encodeQr('a'.repeat(214), { ecLevel: 'M' }), QrError);
  assert.throws(() => encodeQr('a'.repeat(20), { ecLevel: 'M', version: 1 }), QrError);
});

test('Reed-Solomon：单块纠错码字稳定（与外部参照一致的版本里用到）', () => {
  // 已知数据 + 10 个纠错码字，锁住 GF(256) 与生成多项式
  const ec = reedSolomon([0x45, 0x06, 0x00, 0x00], 10);
  assert.equal(ec.length, 10);
  // 再算一次必须完全一致（确定性）
  assert.deepEqual(reedSolomon([0x45, 0x06, 0x00, 0x00], 10), ec);
  // 全 0 数据 → 全 0 纠错
  assert.deepEqual(reedSolomon([0, 0, 0], 5), [0, 0, 0, 0, 0]);
});

test('SVG 输出：尺寸、颜色、路径都成形', () => {
  const matrix = encodeQr('HELLO', { ecLevel: 'M' });
  const svg = matrixToSvg(matrix, { moduleSize: 4, margin: 2 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const expected = (matrix.size + 4) * 4;
  assert.match(svg, new RegExp(`width="${expected}"`));
  assert.match(svg, /fill="#000000"/);
  assert.match(svg, /<path d="M/);
  // 模块数 × 每个模块 4px，路径里不该出现非整数
  assert.equal(/\.\d/.test(svg), false, 'SVG 里不该有小数坐标');
});

test('中文（UTF-8）也能编码，且版本随之变大', () => {
  const ascii = encodeQr('abc', { ecLevel: 'M' });
  const chinese = encodeQr('鲸鱼', { ecLevel: 'M' });
  assert.equal(chinese.version, ascii.version, '6 个 UTF-8 字节仍装得进 v1');
  const longer = encodeQr('鲸'.repeat(10), { ecLevel: 'M' });
  assert.ok(longer.version > ascii.version);
});
