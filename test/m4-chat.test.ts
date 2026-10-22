import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { handleOwnerMessage, ownerMid, pollOwnerDm, readTodayContext, buildChatPrompt, splitForDm, looksLikeActionRequest } from '../src/orchestrator/chat.ts';
import type { ChatDeps } from '../src/orchestrator/chat.ts';
import { nextDmDelay, nextWatchDelay, watchComments } from '../src/orchestrator/watch.ts';
import type { WatchDeps } from '../src/orchestrator/watch.ts';
import { ChatStore } from '../src/state/chatStore.ts';
import { autoApproveOwnerDrafts } from '../src/orchestrator/pending.ts';
import type { PendingDeps } from '../src/orchestrator/pending.ts';
import { RepliedLedger } from '../src/state/replied.ts';
import { PendingStore } from '../src/state/pending.ts';
import { QuotaLedger } from '../src/state/ledgers.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { BiliWriter } from '../src/bili/write.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { ConfigService } from '../src/config/service.ts';
import { LlmClient } from '../src/llm/client.ts';
import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { tmpDir } from './helpers.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';
import type { DmMessage, MsgfeedItem } from '../src/bili/api.ts';

class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  envelope: { code: number; message: string; data: unknown } = { code: 0, message: '0', data: {} };
  async json<T>(): Promise<Result<T>> {
    return { ok: true, data: this.envelope as unknown as T };
  }
  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<{ code: number; message: string; data: T }>> {
    this.calls.push(req);
    return { ok: true, data: this.envelope as { code: number; message: string; data: T } };
  }
}

interface Harness {
  dir: string;
  paths: ReturnType<typeof resolvePaths>;
  transport: FakeTransport;
  chat: ChatStore;
  state: AppStateStore;
  pending: PendingStore;
  quota: QuotaLedger;
  secrets: SecretsService;
  config: ConfigService;
  writer: BiliWriter;
  deps: ChatDeps;
  watch: WatchDeps;
  llmCalls: Array<{ body: Record<string, unknown> }>;
  setLlmReply: (content: string) => void;
}

function harness(patch: Record<string, unknown> = {}): Harness {
  const dir = tmpDir('m4-chat');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1 }, null, 2), 'utf8');
  const paths = resolvePaths({ dataDir: dir });
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const config = new ConfigService(dir, logger);
  config.load();
  config.patch({
    account: { mid: 4242, name: '鲸鲸', ownerMid: 777, ownerName: '老王' },
    listen: {
      dm: { enabled: true, intervalSec: 30, ownerOnly: true, chat: true, maxHistory: 5, maxPerHour: 20, maxChars: 500 },
      comment: { enabled: true, intervalSec: 300, scope: 'both', allDay: false, oncePerPerson: false },
      reply: { ownerDirect: false, strangerApproval: true, maxPerRound: 1, maxChars: 100 },
    },
    ...patch,
  });
  const state = new AppStateStore(paths.state, logger);
  const quota = QuotaLedger.open(paths.quota, logger);
  const secrets = new SecretsService(dir, logger);
  secrets.setCookie(`SESSDATA=abc; bili_jct=${'a'.repeat(32)}; DedeUserID=4242`, { mid: 4242, uname: '鲸鲸' });
  const transport = new FakeTransport();
  const writer = new BiliWriter({ http: transport, csrf: () => secrets.biliJct(), logger, skipThrottle: true });
  const chat = new ChatStore(paths.chatOwner, logger);
  const pending = PendingStore.open(paths.pendingReplies, logger);

  // 假模型：记录请求体，回一条固定 JSON
  const llmCalls: Array<{ body: Record<string, unknown> }> = [];
  let replyContent = JSON.stringify({ reply: '在的，今天看了一条挺有意思的。', attach: { kind: 'none' } });
  const llm = new LlmClient({
    apiKey: 'test',
    baseUrl: 'https://fake.local',
    model: 'fake',
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 1000,
    maxRetries: 0,
    logger,
    fetchImpl: async (_url: string, init?: RequestInit) => {
      llmCalls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(JSON.stringify({ model: 'fake', choices: [{ message: { content: replyContent } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const deps: ChatDeps = {
    logger,
    paths,
    config: config.get(),
    llm,
    api: { dmSessions: async () => ({ ok: true, data: [] }), dmMessages: async () => ({ ok: true, data: [] }) } as unknown as ChatDeps['api'],
    writer,
    state,
    chat,
    secrets,
    now: () => new Date('2026-10-21T21:00:00+08:00'),
  };

  const watch = {
    logger,
    config: config.get(),
    api: {} as unknown as WatchDeps['api'],
    state,
    pending,
    secrets,
    now: deps.now,
    draft: async () => '谢谢回复，那个实验确实是我看漏了条件。',
  } satisfies WatchDeps;

  return {
    dir,
    paths,
    transport,
    chat,
    state,
    pending,
    quota,
    secrets,
    config,
    writer,
    deps,
    watch,
    llmCalls,
    setLlmReply: (content: string) => {
      replyContent = content;
    },
  };
}

function ownerMessage(over: Partial<DmMessage> = {}): DmMessage {
  return { senderId: 777, receiverId: 4242, text: '在吗', atMs: Date.now(), msgKey: 'k1', ...over };
}

/* ---------------- 聊天 ---------------- */

test('聊天只认主人：陌生人来信不回、不记账、不发请求', async () => {
  const h = harness();
  const out = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage({ senderId: 999 }));
  assert.equal(out.replied, false);
  assert.match(out.skipped ?? '', /不是主人/);
  assert.equal(h.transport.calls.length, 0);
  assert.equal(h.chat.all().length, 0);
});

test('聊天只认主人：登录账号（鲸鲸）自己的来信不算主人，不回', async () => {
  const h = harness();
  const out = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage({ senderId: 4242 }));
  assert.equal(out.replied, false);
  assert.match(out.skipped ?? '', /登录账号自己/);
  assert.equal(h.transport.calls.length, 0);
});

test('聊天只认主人：没填主人 UID 时明确拒绝，并说清去哪填', async () => {
  const h = harness({ account: { mid: 4242, name: '鲸鲸', ownerMid: 0, ownerName: '' } });
  const out = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage({ senderId: 777 }));
  assert.equal(out.replied, false);
  assert.match(out.skipped ?? '', /还没填主人 UID/);
  assert.equal(h.transport.calls.length, 0);
});

test('聊天：开关关着就不处理', async () => {
  const h = harness({ listen: { dm: { enabled: false, intervalSec: 30, ownerOnly: true, chat: true, maxHistory: 5, maxPerHour: 20, maxChars: 500 } } });
  const out = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage());
  assert.equal(out.replied, false);
  assert.match(out.skipped ?? '', /监听关着/);
  assert.equal(h.transport.calls.length, 0);
});

test('聊天：主人来信 → 回一条 + 记账（两条：主人说的、我回的）', async () => {
  const h = harness();
  const out = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage());
  assert.equal(out.replied, true);
  assert.equal(h.transport.calls.length, 1, '只发一条私信');
  const lines = h.chat.all();
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.from, 'owner');
  assert.equal(lines[1]?.from, 'self');
  assert.equal(lines[1]?.msgKey, 'k1', '要记 msgKey 以便去重');
});

test('聊天不调工具、不改配置：请求体里没有 tools，config.json 一个字节没变', async () => {
  const h = harness();
  const before = fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8');
  await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage());

  assert.equal(h.llmCalls.length, 1);
  const body = h.llmCalls[0]?.body ?? {};
  assert.equal('tools' in body, false, '聊天不许带工具');
  assert.equal('tool_choice' in body, false);
  const after = fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8');
  assert.equal(after, before, '聊天不许改配置');
});

test('聊天：同一条来信只回一次（msgKey 去重）', async () => {
  const h = harness();
  await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage());
  const again = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage());
  assert.equal(again.replied, false);
  assert.match(again.skipped ?? '', /已经回过/);
  assert.equal(h.transport.calls.length, 1);
});

test('聊天：一小时内超过上限就不再回', async () => {
  const h = harness();
  const now = new Date('2026-10-21T21:00:00+08:00');
  for (let i = 0; i < 20; i += 1) {
    h.chat.append({ at: new Date(now.getTime() - i * 1000).toISOString(), from: 'self', text: `第 ${i} 条` });
  }
  const out = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage({ msgKey: 'k-new' }));
  assert.equal(out.replied, false);
  assert.match(out.skipped ?? '', /一小时内/);
  assert.equal(h.transport.calls.length, 0);
});

test('聊天附件：日记在白名单里才发；不认识的 BV 忽略', async () => {
  const h = harness();
  // 今天没有日记：附件 diary 会退化成一句提示
  h.setLlmReply(JSON.stringify({ reply: '日记给你。', attach: { kind: 'diary' } }));
  const out = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage({ msgKey: 'k-diary' }));
  assert.equal(out.replied, true);
  assert.deepEqual(out.attachments?.map((item) => item.kind), ['diary']);
  assert.equal(h.transport.calls.length, 1, '没有日记就不额外发（只回一句）');

  h.setLlmReply(JSON.stringify({ reply: '发你看看。', attach: { kind: 'video_info', bvid: 'BV1unknown1' } }));
  const second = await handleOwnerMessage({ ...h.deps, config: h.config.get() }, ownerMessage({ msgKey: 'k-video' }));
  assert.equal(second.replied, true);
  assert.equal(second.attachments, undefined, '不在白名单的 BV 要被忽略');
});

test('聊天：回复里出现「帮你改设置/贴 cookie」会被替换成固定拒绝', () => {
  assert.equal(looksLikeActionRequest('我已经帮你把设置改了'), true);
  assert.equal(looksLikeActionRequest('cookie 是 SESSDATA=abc'), true);
  assert.equal(looksLikeActionRequest('今天看的那条挺好'), false);
});

test('聊天上下文：只读今天的公开日记与报告，不含字幕全文', () => {
  const h = harness();
  fs.mkdirSync(h.paths.diariesPublicDir, { recursive: true });
  fs.mkdirSync(h.paths.reportsDir, { recursive: true });
  fs.writeFileSync(path.join(h.paths.diariesPublicDir, '2026-10-21.md'), '今天的日记正文', 'utf8');
  fs.writeFileSync(
    path.join(h.paths.reportsDir, '2026-10-21.md'),
    '# 2026-10-21\n\n#### BV1abc123456 · 一个视频\n- 一句话：挺有意思\n',
    'utf8',
  );
  const context = readTodayContext(h.deps, new Date('2026-10-21T21:00:00+08:00'));
  assert.equal(context.publicDiary, '今天的日记正文');
  assert.equal(context.videos[0]?.bvid, 'BV1abc123456');
  assert.equal(context.videos[0]?.title, '一个视频');

  const prompt = buildChatPrompt(h.deps, { message: '在吗', history: [], context });
  assert.ok(prompt.user.includes('BV1abc123456'));
  assert.equal(prompt.user.includes('字幕'), false, '不许把字幕塞进聊天上下文');
});

test('私信分段：≤500 且最多 5 段', () => {
  assert.deepEqual(splitForDm('短'), ['短']);
  const parts = splitForDm('字'.repeat(1600));
  assert.ok(parts && parts.length <= 5);
  assert.equal(splitForDm('字'.repeat(3000)), null);
});

/* ---------------- 监听 ---------------- */

function feedItem(over: Partial<MsgfeedItem> = {}): MsgfeedItem {
  return {
    id: 1,
    kind: 'reply',
    mid: 888,
    uname: '路人甲',
    content: '这个观点我不同意',
    atMs: Date.parse('2026-10-21T20:00:00+08:00'),
    oid: 9001,
    rootRpid: '100',
    sourceRpid: '200',
    ...over,
  };
}

test('评论监听：首次运行只建基线，不倒历史', async () => {
  const h = harness();
  const api = {
    msgfeedReplies: async () => ({ ok: true, data: [feedItem(), feedItem({ id: 2, sourceRpid: '201' })] }),
    msgfeedAts: async () => ({ ok: true, data: [] }),
  };
  const result = await watchComments({ ...h.watch, config: h.config.get(), api: api as unknown as WatchDeps['api'] });
  assert.equal(result.baseline, true);
  assert.equal(result.created, 0, '第一次不建草稿');
  assert.ok(h.state.lastCommentSeenAt(), '要写下游标');
  assert.equal(h.pending.all().length, 0);
});

test('评论监听：第二次只处理游标之后的；陌生人进待审队列', async () => {
  const h = harness();
  h.state.setCommentSeenAt('2026-10-21T19:00:00+08:00');
  const api = {
    msgfeedReplies: async () => ({ ok: true, data: [feedItem()] }),
    msgfeedAts: async () => ({ ok: true, data: [] }),
  };
  const result = await watchComments({ ...h.watch, config: h.config.get(), api: api as unknown as WatchDeps['api'] });
  assert.equal(result.baseline, false);
  assert.equal(result.created, 1);
  assert.equal(h.pending.all().length, 1);
  assert.equal(h.pending.all()[0]?.target.uname, '路人甲');
});

test('评论监听：主人（ownerMid）的回复标成 fromOwner；登录账号自己的消息跳过', async () => {
  const h = harness();
  h.state.setCommentSeenAt('2026-10-21T19:00:00+08:00');
  const api = {
    msgfeedReplies: async () => ({
      ok: true,
      data: [
        feedItem({ id: 1, mid: 777, uname: '老王', sourceRpid: '301' }),
        feedItem({ id: 2, mid: 4242, uname: '鲸鲸', sourceRpid: '302' }),
      ],
    }),
    msgfeedAts: async () => ({ ok: true, data: [] }),
  };
  const result = await watchComments({ ...h.watch, config: h.config.get(), api: api as unknown as WatchDeps['api'] });
  assert.equal(result.created, 1, '只应给主人建一条草稿（自己的消息跳过）');
  const draft = h.pending.all()[0];
  assert.equal(draft?.fromOwner, true, '要标清楚这是主人回的，主人直发靠它判断');
  assert.ok(result.skipped.some((line) => line.includes('登录账号自己的消息')));
});

test('评论监听：主人直发关着时，主人的回复也进队列等审批（不自动发）', async () => {
  const h = harness();
  h.state.setCommentSeenAt('2026-10-21T19:00:00+08:00');
  const api = {
    msgfeedReplies: async () => ({ ok: true, data: [feedItem({ mid: 777, uname: '老王' })] }),
    msgfeedAts: async () => ({ ok: true, data: [] }),
  };
  await watchComments({ ...h.watch, config: h.config.get(), api: api as unknown as WatchDeps['api'] });
  assert.equal(h.transport.calls.length, 0, '没点批准之前不该有任何写请求');
  assert.equal(h.pending.pending().length, 1);
});

test('主人直发：ownerDirect 打开时，主人的回复直接发出，陌生人仍然排队', async () => {
  const h = harness({
    listen: {
      dm: { enabled: true, intervalSec: 30, ownerOnly: true, chat: true, maxHistory: 5, maxPerHour: 20, maxChars: 500 },
      comment: { enabled: true, intervalSec: 300, scope: 'both', allDay: false, oncePerPerson: false },
      reply: { ownerDirect: true, strangerApproval: true, maxPerRound: 1, maxChars: 100 },
    },
  });
  h.state.setCommentSeenAt('2026-10-21T19:00:00+08:00');
  const api = {
    msgfeedReplies: async () => ({
      ok: true,
      data: [
        feedItem({ id: 1, mid: 777, uname: '老王', sourceRpid: '401' }),
        feedItem({ id: 2, mid: 888, uname: '路人甲', sourceRpid: '402' }),
      ],
    }),
    msgfeedAts: async () => ({ ok: true, data: [] }),
  };
  const watch = await watchComments({ ...h.watch, config: h.config.get(), api: api as unknown as WatchDeps['api'] });
  assert.equal(watch.created, 2);

  const pendingDeps = {
    logger: h.deps.logger,
    config: h.config.get(),
    quota: h.quota,
    state: h.state,
    pending: h.pending,
    replied: RepliedLedger.open(h.paths.replied, h.deps.logger),
    api: api as unknown as WatchDeps['api'] as unknown as PendingDeps['api'],
    writer: h.writer,
    secrets: h.secrets,
  };
  const auto = await autoApproveOwnerDrafts(pendingDeps, h.pending.all());
  assert.equal(auto.approved.length, 1, '只直发主人那条');
  assert.ok(h.transport.calls.some((call) => String(call.url).includes('/x/v2/reply/add')), '主人那条应该真的发了');
  const strangers = h.pending.all().filter((item) => !item.fromOwner);
  assert.equal(strangers.every((item) => item.status === 'pending'), true, '陌生人的回复仍然要审批');
});

test('评论监听：关着就一次请求都不发', async () => {
  const h = harness({ listen: { comment: { enabled: false, intervalSec: 300, scope: 'both', allDay: false, oncePerPerson: false } } });
  const api = {
    msgfeedReplies: async () => {
      throw new Error('不该被调用');
    },
    msgfeedAts: async () => {
      throw new Error('不该被调用');
    },
  };
  const result = await watchComments({ ...h.watch, config: h.config.get(), api: api as unknown as WatchDeps['api'] });
  assert.equal(result.created, 0);
  assert.ok(result.skipped.some((line) => line.includes('关着')));
});

test('监听间隔：评论 ≥60s 且退避不超过 15 分钟；私信 20–60s', () => {
  const h = harness();
  const cfg = h.config.get();
  for (let i = 0; i < 5; i += 1) {
    const delay = nextWatchDelay(cfg, i);
    assert.ok(delay >= 60_000, `评论间隔至少 60s，实际 ${delay}`);
    assert.ok(delay <= 15 * 60_000 * 1.2, `评论退避上限 15 分钟（+20% 抖动），实际 ${delay}`);
  }
  for (let i = 0; i < 5; i += 1) {
    const delay = nextDmDelay(cfg);
    assert.ok(delay >= 20_000 && delay <= 60_000 * 1.2, `私信间隔应在 20–60s，实际 ${delay}`);
  }
});

test('私信轮询：没有新消息就不拉消息、不调模型（零 token）', async () => {
  const h = harness();
  h.state.setDmSeenAt('2026-10-21T21:10:00+08:00');
  let messageCalls = 0;
  const api = {
    dmSessions: async () => ({ ok: true, data: [{ talkerId: 4242, uname: '鲸鲸', lastMsgAtMs: Date.parse('2026-10-21T20:00:00+08:00'), unread: 0 }] }),
    dmMessages: async () => {
      messageCalls += 1;
      return { ok: true, data: [] };
    },
  };
  const result = await pollOwnerDm({ ...h.deps, config: h.config.get(), api: api as unknown as ChatDeps['api'] });
  assert.equal(result.handled, 0);
  assert.equal(messageCalls, 0, '没新消息不拉消息');
  assert.equal(h.llmCalls.length, 0, '没新消息不调模型');
});

test('私信轮询：只有主人的会话会被处理', async () => {
  const h = harness();
  h.state.setDmSeenAt(null);
  const api = {
    dmSessions: async () => ({
      ok: true,
      data: [
        { talkerId: 4242, uname: '鲸鲸', lastMsgAtMs: Date.parse('2026-10-21T20:30:00+08:00'), unread: 1 },
        { talkerId: 777, uname: '陌生人', lastMsgAtMs: Date.parse('2026-10-21T20:40:00+08:00'), unread: 3 },
      ],
    }),
    dmMessages: async (talkerId: number) => ({
      ok: true,
      data: [{ senderId: talkerId, receiverId: 4242, text: '在吗', atMs: Date.parse('2026-10-21T20:30:00+08:00'), msgKey: 'm1' }],
    }),
  };
  const result = await pollOwnerDm({ ...h.deps, config: h.config.get(), api: api as unknown as ChatDeps['api'] });
  assert.equal(result.handled, 1);
  const lines = h.chat.all();
  assert.equal(lines[0]?.from, 'owner');
  assert.equal(h.transport.calls.length, 1, '只回了一条');
});

test('ownerMid：只认 account.ownerMid；没填 / 填成登录账号本身都算 0（不回退）', () => {
  const h = harness();
  assert.equal(ownerMid({ ...h.deps, config: h.config.get() }), 777, '主人是配置里的 ownerMid，不是登录账号');

  // 没填主人 UID → 0（以前会悄悄回退到登录账号，这就是错的）
  const missing = harness({ account: { mid: 4242, name: '鲸鲸', ownerMid: 0, ownerName: '' } });
  assert.equal(ownerMid({ ...missing.deps, config: missing.config.get() }), 0);

  // 填成登录账号自己 → 也算没配好
  const same = harness({ account: { mid: 4242, name: '鲸鲸', ownerMid: 4242, ownerName: '鲸鲸' } });
  assert.equal(ownerMid({ ...same.deps, config: same.config.get() }), 0);
});
