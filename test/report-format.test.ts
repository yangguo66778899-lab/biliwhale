import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReportSection } from '../src/orchestrator/writers.ts';
import type { ReportInput } from '../src/orchestrator/writers.ts';
import type { RoundResult } from '../src/shared/types.ts';
import { gateShare } from '../src/orchestrator/gate.ts';

function baseResult(over: Partial<RoundResult> = {}): RoundResult {
  return {
    selected: [
      {
        bvid: 'BV1a0000001',
        score: 16,
        why: '字幕里给了具体实验和具体数字，结论是他自己总结的，不是转述。',
        oneliner: '拿一个实验讲清楚黑话为什么会跨圈失效。',
      },
    ],
    skipped: [{ bvid: 'BV1a0000002', reason: 'low_score', note: '带货，3 分，' }],
    favorite: null,
    dynamic: null,
    diary: { public: '公开', private: '私人' },
    report_md: '这一轮翻了 5 条，只挑出一条。\n\n第二条整条在讲自己怎么搭流水线。',
    notify: '挑中一条',
    notes: '',
    ...over,
  };
}

function baseInput(over: Partial<ReportInput> = {}): ReportInput {
  return {
    date: '2026-10-21',
    roundLabel: '20:30 · 跑了一轮',
    level: 'full',
    result: baseResult(),
    counts: { candidates: 5, screened: 5, deepRead: 3, selected: 1, shared: 0, skippedNoSubtitle: 1 },
    videos: new Map([
      ['BV1a0000001', { title: '标题一', up: 'UP 一', durationText: '7 分钟', ageText: '今天', url: 'https://www.bilibili.com/video/BV1a0000001' }],
      ['BV1a0000002', { title: '标题二', up: 'UP 二', durationText: '3 分钟', ageText: '昨天', url: 'https://www.bilibili.com/video/BV1a0000002' }],
    ]),
    shareDecisions: new Map([
      [
        'BV1a0000001',
        gateShare({
          writeEnabled: true,
          killSwitch: false,
          dryRun: true,
          shareEnabled: false,
          channel: 'comment',
          allowedChannels: [],
          score: 16,
          minScore: 13,
          scoreEnabled: true,
          deepRead: true,
          todayShares: 0,
          shareCap: 3,
          dailyCap: 3,
          lastShareAt: null,
          perVideoDays: 7,
          silenceCap: 3,
          riskCooldown: false,
        }),
      ],
    ]),
    usage: { promptTokens: 1200, completionTokens: 300, costCny: 0 },
    dryRun: true,
    notes: ['M0 不抽帧：视频画面这一路还没接', 'M0 只读：所有分享只到闸门'],
    ...over,
  };
}

test('full 档：模型正文进「这一轮」，排障信息单独成段', () => {
  const section = buildReportSection(baseInput());

  assert.match(section, /^## 20:30 · 跑了一轮/m);
  assert.match(section, /### 这一轮/);
  assert.match(section, /这一轮翻了 5 条，只挑出一条。/, 'report_md 正文要原样写入');
  assert.match(section, /第二条整条在讲自己怎么搭流水线。/);

  // 顺序：这一轮 → 挑中的 → 看过的 → 账 → 备注
  const order = ['### 这一轮', '### 挑中的', '### 看过的（跳过）', '### 今天的账', '### 运行备注（排障用）'].map((h) => section.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order, '小节顺序不对');

  // 排障信息不能混进给人看的账目：账目段里不该出现「M0 不抽帧」
  const accountStart = section.indexOf('### 今天的账');
  const noteStart = section.indexOf('### 运行备注');
  assert.ok(!section.slice(accountStart, noteStart).includes('M0 不抽帧'), '账目里不该有排障备注');
  assert.ok(section.slice(noteStart).includes('M0 不抽帧'));

  assert.match(section, /没发：分享总开关关着/);
});

test('full 档：备注句末的逗号顿号被清掉，不留下「，）」', () => {
  const section = buildReportSection(baseInput());
  assert.match(section, /分数不够（带货，3 分）/, '句末逗号应被去掉');
  assert.ok(!section.includes('，）'));
});

test('report_md 为空时不留空小节', () => {
  const section = buildReportSection(baseInput({ result: baseResult({ report_md: '' }) }));
  assert.ok(!section.includes('### 这一轮'));
  assert.match(section, /### 挑中的/);
});

test('被闸门拒绝时也写出「本来会发：…」——用户有权知道她打算说什么', () => {  const section = buildReportSection(
    baseInput({
      shareDecisions: new Map(),
      shareAttempts: new Map([
        [
          'BV1a0000001',
          {
            status: 'denied',
            content: '@小明 这条剪得真紧，音效踩得准',
            deny: ['风控冷却中'],
            notes: [],
          },
        ],
      ]),
    }),
  );
  assert.match(section, /没发：风控冷却中/);
  assert.match(section, /本来会发：@小明 这条剪得真紧，音效踩得准/);
});

test('brief 档：一段正文 + 每条一行 + 备注压成一行', () => {
  const section = buildReportSection(baseInput({ level: 'brief' }));
  assert.match(section, /这一轮翻了 5 条/);
  assert.match(section, /- 拿一个实验讲清楚黑话为什么会跨圈失效。/);
  assert.match(section, /- 跳过 1 条（分数不够 1）/);
  assert.match(section, /- 备注：M0 不抽帧.*；.*M0 只读/);
  assert.ok(!section.includes('### 挑中的'), 'brief 不该有完整档的小节');
  assert.ok(section.length < buildReportSection(baseInput()).length);
});

test('off 档：不产出任何报告内容', () => {
  assert.equal(buildReportSection(baseInput({ level: 'off' })), '');
});

test('挑中的为空时给一句人话，而不是空列表', () => {
  const section = buildReportSection(baseInput({ result: baseResult({ selected: [] }) }));
  assert.match(section, /今天没有值得占你注意力的/);
});

test('跳过原因不许出现「其它」：模型给 other 也要说清是「没选它」', () => {
  // 2026-10-22 真机报告里两条 10/11 分的条目显示「· 其它」，用户以为是 bug。
  const section = buildReportSection(
    baseInput({ result: baseResult({ skipped: [{ bvid: 'BV1a0000002', reason: 'other', note: '够阈值但让位给最高分那条' }] }) }),
  );
  assert.equal(section.includes('· 其它'), false, '「其它」不是理由');
  assert.match(section, /没选它（这轮挑了别的）/);
});
