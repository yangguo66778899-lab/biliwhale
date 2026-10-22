import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runRound } from '../src/orchestrator/round.ts';
import type { RoundDeps } from '../src/orchestrator/round.ts';
import { BiliWriter } from '../src/bili/write.ts';
import { QuotaLedger } from '../src/state/ledgers.ts';
import { SeenLedger } from '../src/state/ledgers.ts';
import { FeedbackLedger } from '../src/state/ledgers.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { RunStore } from '../src/state/runs.ts';
import { PendingStore } from '../src/state/pending.ts';
import { RepliedLedger } from '../src/state/replied.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { ConfigService } from '../src/config/service.ts';
import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { ensureLayout } from '../src/state/paths.ts';
import { createOfflineStack } from '../src/dev/offline.ts';
import { makeMockModelFetch } from '../src/dev/mockModel.ts';
import { LlmClient } from '../src/llm/client.ts';
import { tmpDir } from './helpers.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';

/**
 * 「这一轮到底是不是预演」的回归测试。
 *
 * 背景（真机反馈）：用户打开了分享开关、关掉了「一律预演」，报告里却仍然写
 * 「（预演，未真的发）」，而且模型总在文案里说「这一轮是只读预演」。
 * 根因是 round.ts 里三处写死的 `dryRun: true`（M0 遗留）+ 定时触发恒传 true。
 * 这里把它钉住：真跑就必须真写、报告不许说预演；预演就必须一个写请求都不发。
 */

class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  /** 模拟「发到一半进程挂了 / 网络层直接抛」：用来验证判重账本已经写过。 */
  throwOnWrite = false;
  envelope: { code: number; message: string; data: unknown } = { code: 0, message: '0', data: { rpid: 999, rpid_str: '999' } };
  async json<T>(): Promise<Result<T>> {
    return { ok: true, data: this.envelope as unknown as T };
  }
  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<{ code: number; message: string; data: T }>> {
    this.calls.push(req);
    if (this.throwOnWrite) throw new Error('模拟：发送过程中断');
    return { ok: true, data: this.envelope as { code: number; message: string; data: T } };
  }
}

interface Harness {
  deps: RoundDeps;
  dir: string;
  transport: FakeTransport;
  quota: QuotaLedger;
  prompts: string[];
}

function harness(options: { dryRunInConfig: boolean }): Harness {
  const dir = tmpDir('share-mode');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1 }, null, 2), 'utf8');
  const paths = resolvePaths({ dataDir: dir });
  ensureLayout(paths);
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });

  const config = new ConfigService(dir, logger);
  config.load();
  config.patch({
    share: { enabled: true, via: 'comment', minScore: 0, dailyCap: 3, perVideoDays: 7, comment: { maxChars: 150, atOwner: false } },
    safety: { writeEnabled: true, dryRun: options.dryRunInConfig, killSwitch: false },
    score: { enabled: false },
    account: { name: '鲸鲸', mid: 4242 },
  });
  const cfg = config.get();
  const secrets = new SecretsService(dir, logger);
  secrets.setCookie(`SESSDATA=abc; bili_jct=${'a'.repeat(32)}; DedeUserID=4242`, { mid: 4242, uname: '鲸鲸' });

  const offline = createOfflineStack({ paths, logger, config: cfg, fixturesDir: path.join(process.cwd(), 'fixtures') });
  // 用例要看到 prompt 原文：用「夹具驱动的假模型」，顺便记录每次请求体。
  // 用夹具而不是 mock 模型，是因为 mock 模型的分享提案是 channel=none（它不提案分享），这里需要一条真的分享提案。
  const screenJson = fs.readFileSync(path.join(process.cwd(), 'fixtures', 'llm', 'screen.json'), 'utf8');
  const deepJson = fs.readFileSync(path.join(process.cwd(), 'fixtures', 'llm', 'deep.json'), 'utf8');
  const prompts: string[] = [];
  const llm = new LlmClient({
    apiKey: 'fake',
    baseUrl: 'https://fake.local',
    model: 'fake',
    temperature: 0,
    maxTokens: 2000,
    timeoutMs: 10_000,
    maxRetries: 0,
    logger,
    fetchImpl: async (_input: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body) prompts.push(body);
      const content = body.includes('初筛打分') ? screenJson : deepJson;
      return new Response(JSON.stringify({ model: 'fake', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const transport = new FakeTransport();
  const writer = new BiliWriter({ http: transport, csrf: () => secrets.biliJct(), logger, skipThrottle: true });

  // 让「复核」通过（否则会变成 unverified，测试想验证的是「真发了」）
  const api = offline.api as unknown as { findComment: unknown };
  const patchApi = api as unknown as { findOwnComment: unknown };
  patchApi.findOwnComment = async () => ({ ok: true, data: { found: true, visible: true, state: 0 } });

  const deps: RoundDeps = {
    paths,
    config,
    secrets,
    logger,
    api: offline.api,
    llm,
    state: new AppStateStore(paths.state, logger),
    seen: SeenLedger.open(paths.seen, logger),
    quota: QuotaLedger.open(paths.quota, logger),
    feedback: FeedbackLedger.open(paths.feedback, logger),
    runs: new RunStore(paths.runsDir, logger),
    writer,
    pending: PendingStore.open(paths.pendingReplies, logger),
    replied: RepliedLedger.open(paths.replied, logger),
    configuredModel: cfg.llm.model,
    noCredentialsNeeded: true,
    now: () => new Date('2026-10-22T10:00:00+08:00'),
    shareVerifyDelaysMs: [0],
    skipWriteWait: true,
  };

  return { deps, dir, transport, quota: deps.quota, prompts };
}

function reportText(dir: string): string {
  const file = path.join(dir, 'reports', '2026-10-22.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('真跑（配置里没开预演）：真的会发评论，报告不许说「预演」', async () => {
  const h = harness({ dryRunInConfig: false });
  const record = await runRound(h.deps, { trigger: 'manual', dryRun: false });

  assert.equal(record.dryRun, false, 'run 记录要如实写 dryRun=false');
  assert.ok(h.transport.calls.some((call) => String(call.url).includes('/x/v2/reply/add')), '应该真的发出了一条评论');
  assert.equal(record.counts.shared, 1, '分享数应该是 1');

  const entry = h.quota.entries().find((item) => item.type === 'comment');
  assert.equal(entry?.status, 'sent');
  assert.ok(entry?.rpid);

  const report = reportText(h.dir);
  assert.equal(report.includes('预演'), false, `真跑的报告中不该出现「预演」：\n${report.slice(0, 600)}`);
  assert.ok(report.includes('评论已发出'), '报告要写「评论已发出」');
});

test('真跑：提示词里告诉模型的是「正常」，不是「只读预演」', async () => {
  const h = harness({ dryRunInConfig: false });
  await runRound(h.deps, { trigger: 'manual', dryRun: false });

  assert.ok(h.prompts.length > 0, '应该有模型调用');
  const joined = h.prompts.join('\n');
  assert.equal(joined.includes('只读预演'), false, '真跑时不该提示模型这是只读预演');
});

test('预演（safety.dryRun 打开）：一个写请求都不发，报告与提示词都要说是预演', async () => {
  const h = harness({ dryRunInConfig: true });
  const record = await runRound(h.deps, { trigger: 'manual', dryRun: false });

  assert.equal(record.dryRun, true, '配置里开了「一律预演」，run 记录要写 true');
  assert.equal(h.transport.calls.length, 0, '预演不许发任何写请求');

  const report = reportText(h.dir);
  assert.ok(report.includes('预演'), '预演的报告要写明');
  assert.equal(report.includes('评论已发出'), false);

  const joined = h.prompts.join('\n');
  assert.ok(joined.includes('只读预演'), '预演时要提示模型这是只读预演');
});

test('发送阶段抛异常：判重账本里已经有这条视频（下一轮不会再把它推出来重发）', async () => {
  const h = harness({ dryRunInConfig: false });
  h.transport.throwOnWrite = true;

  // 模拟「发评论时进程被杀 / 网络层抛错」：整轮会向上抛，后面的落盘都不会发生
  await assert.rejects(runRound(h.deps, { trigger: 'manual', dryRun: false }));

  const firstSelected = 'BV1a0000001'; // fixtures/llm/deep.json 里挑中的第一条
  const entry = h.deps.seen.get(firstSelected);
  assert.ok(entry, '发送过程中途失败也必须先把「已看过」写进账本，否则下一轮会重选、重发');
  assert.equal(entry?.lastDecision, 'selected');
});

