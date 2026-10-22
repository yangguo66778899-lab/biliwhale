import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { approvePending, rejectPending, scanStrangerReplies } from '../src/orchestrator/pending.ts';
import type { PendingDeps } from '../src/orchestrator/pending.ts';
import { PendingStore, newPendingId, expiresAt } from '../src/state/pending.ts';
import { RepliedLedger } from '../src/state/replied.ts';
import { QuotaLedger } from '../src/state/ledgers.ts';
import { AppStateStore } from '../src/state/appState.ts';
import { BiliWriter } from '../src/bili/write.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { ConfigService } from '../src/config/service.ts';
import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { localIso } from '../src/shared/time.ts';
import { tmpDir } from './helpers.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';
import type { CommentItem } from '../src/shared/types.ts';

class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  envelope: { code: number; message: string; data: unknown } = { code: 0, message: '0', data: { rpid: 555, rpid_str: '555' } };
  async json<T>(): Promise<Result<T>> {
    return { ok: true, data: this.envelope as unknown as T };
  }
  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<{ code: number; message: string; data: T }>> {
    this.calls.push(req);
    return { ok: true, data: this.envelope as { code: number; message: string; data: T } };
  }
}

function comment(overrides: Partial<CommentItem> = {}): CommentItem {
  return {
    rpid: '200',
    parent: '100',
    root: '100',
    mid: 888,
    uname: '路人甲',
    message: '这条我也喜欢',
    like: 1,
    ctimeIso: new Date().toISOString(),
    replies: [],
    ...overrides,
  };
}

interface Harness {
  deps: PendingDeps;
  transport: FakeTransport;
  pending: PendingStore;
  replied: RepliedLedger;
  quota: QuotaLedger;
  state: AppStateStore;
  secrets: SecretsService;
  replies: CommentItem[];
  found: { value: boolean };
  dir: string;
}

function harness(opts: { strangerApproval?: boolean; ownerDirect?: boolean; writeEnabled?: boolean; dryRun?: boolean; selfMid?: number } = {}): Harness {
  const dir = tmpDir('pending');
  const paths = resolvePaths({ dataDir: dir });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1 }, null, 2), 'utf8');
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const configService = new ConfigService(dir, logger);
  configService.load();
  configService.patch({
    safety: { writeEnabled: opts.writeEnabled ?? true, dryRun: opts.dryRun ?? false, killSwitch: false },
    listen: { reply: { strangerApproval: opts.strangerApproval ?? true, ownerDirect: opts.ownerDirect ?? false, maxPerRound: 1, maxChars: 100 } },
  });
  const cfg = configService.get();

  const secrets = new SecretsService(dir, logger);
  const selfMid = opts.selfMid ?? 999;
  secrets.setCookie(`SESSDATA=abc123; bili_jct=${'e'.repeat(32)}; DedeUserID=${selfMid}`, { mid: selfMid, uname: '鲸鲸' });

  const state = new AppStateStore(paths.state, logger);
  const quota = QuotaLedger.open(paths.quota, logger);
  const pending = PendingStore.open(paths.pendingReplies, logger);
  const replied = RepliedLedger.open(paths.replied, logger);
  const transport = new FakeTransport();
  const writer = new BiliWriter({ http: transport, csrf: () => secrets.biliJct(), logger, skipThrottle: true });
  const replies: CommentItem[] = [];
  const found = { value: true };

  const deps: PendingDeps = {
    logger,
    config: cfg,
    quota,
    state,
    pending,
    replied,
    secrets,
    writer,
    api: {
      threadReplies: async () => ({ ok: true, data: { root: null, replies, pages: 1 } }),
      findReply: async () => ({ ok: true, data: found.value }),
      findComment: async () => ({ ok: true, data: found.value }),
      video: async (bvid: string) => ({
        ok: true,
        data: { bvid, aid: 9001, cid: 1, title: 't', desc: '', durationSec: 60, pubdateIso: '', owner: { mid: 1, name: 'u' }, stats: {}, coverUrl: '' },
      }),
    } as unknown as PendingDeps['api'],
    draft: async (input) => `回 ${input.uname}：我也这么觉得`,
  };
  return { deps, transport, pending, replied, quota, state, secrets, replies, found, dir };
}

/** 先记账：我们发过一条评论。 */
function seedOurComment(h: Harness, bvid = 'BV1pend1', rpid = '100', aid = 9001): void {
  h.quota.add({
    at: localIso(),
    type: 'comment',
    bvid,
    aid,
    target: '@鲸鲸',
    share: true,
    status: 'sent',
    rpid,
    note: 'seed',
    content: '这条值得看',
    contentHash: 'x',
  });
}

test('扫描明细：没人回 / 回复挂在别人下面 / 自己回自己，都要说清原因', async () => {
  const h = harness();
  seedOurComment(h);

  // 1) 完全没人回
  const empty = await scanStrangerReplies(h.deps);
  assert.equal(empty.considered, 1);
  assert.equal(empty.scanned, 1);
  assert.equal(empty.created.length, 0);
  assert.equal(empty.details[0]?.replies, 0);
  assert.match(empty.details[0]?.note ?? '', /还没有任何回复/);

  // 2) 回复挂在别人下面（parent 不是我们那条），不该生成草稿，要说明白
  h.replies.push(comment({ rpid: '210', parent: '999', root: '100', mid: 888 }));
  const nested = await scanStrangerReplies(h.deps);
  assert.equal(nested.created.length, 0);
  assert.match(nested.details[0]?.note ?? '', /挂在别人下面|parent=/);

  // 3) 只有自己回的
  h.replies.length = 0;
  h.replies.push(comment({ rpid: '211', parent: '100', root: '100', mid: 999, uname: '鲸鲸' }));
  const own = await scanStrangerReplies(h.deps);
  assert.equal(own.created.length, 0);
  assert.match(own.details[0]?.note ?? '', /都是我们自己发的/);
});

test('扫描：账本缺 aid 时用视频详情补上，不再静默跳过', async () => {
  const h = harness();
  // 手工塞一条没有 aid 的评论记录
  h.quota.add({
    at: localIso(),
    type: 'comment',
    bvid: 'BV1pend1',
    target: '@鲸鲸',
    share: true,
    status: 'sent',
    rpid: '100',
    note: 'no-aid',
    content: 'x',
    contentHash: 'y',
  });
  h.replies.push(comment({ rpid: '200', parent: '100', root: '100' }));

  const result = await scanStrangerReplies(h.deps);
  assert.equal(result.created.length, 1, '补到 aid 之后应该能生成草稿');
  assert.ok(result.skipped.some((line) => line.includes('缺 aid')), result.skipped.join('\n'));
  assert.equal(result.created[0]?.aid, 9001);
});

test('扫描：账本被别的进程改过时先重读磁盘（CLI 发的评论，守护进程也要看得见）', async () => {
  const h = harness();
  // 模拟「另一个进程」写账本：另开一个 QuotaLedger 指向同一文件
  const other = QuotaLedger.open(path.join(h.dir, 'quota.json'), h.deps.logger);
  other.add({
    at: localIso(),
    type: 'comment',
    bvid: 'BV1pend1',
    aid: 9001,
    target: '@鲸鲸',
    share: true,
    status: 'sent',
    rpid: '100',
    note: 'from-cli',
    content: 'x',
    contentHash: 'y',
  });
  h.replies.push(comment({ rpid: '200', parent: '100', root: '100' }));

  // 守护进程里的 quota 实例是扫描之前创建的，内存里还没有这条
  const result = await scanStrangerReplies(h.deps);
  assert.equal(result.considered, 1, 'scan 前应该重新读一次账本');
  assert.equal(result.created.length, 1);
});

test('待审存储：新增/查重/过期/更新', () => {
  const dir = tmpDir('pending-store');
  const logger = new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
  const store = PendingStore.open(path.join(dir, 'pending', 'replies.json'), logger);

  const draft = {
    id: newPendingId(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt(new Date(Date.now() + 1000)),
    status: 'pending' as const,
    bvid: 'BV1',
    aid: 1,
    root: '100',
    parent: '200',
    target: { mid: 5, uname: '路人' },
    sourceComment: '你好',
    draft: '谢谢',
  };
  store.add(draft);
  assert.equal(store.count(), 1);
  assert.equal(store.has({ root: '100', parent: '200' }), true);

  // 过期（把过期时间改到过去）
  store.update(draft.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(store.expire(), 1);
  assert.equal(store.byId(draft.id)?.status, 'expired');
  assert.equal(store.count(), 0);
});

test('扫描：陌生人回复 → 生成草稿；同一条不重复生成；自己的回复不算', async () => {
  const h = harness({ selfMid: 999 });
  seedOurComment(h);
  h.replies.push(comment({ rpid: '200', parent: '100', mid: 888, uname: '路人甲' }));
  h.replies.push(comment({ rpid: '201', parent: '100', mid: 999, uname: '鲸鲸' })); // 自己

  const first = await scanStrangerReplies(h.deps);
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0]?.target.uname, '路人甲');
  assert.match(first.created[0]?.draft ?? '', /我也这么觉得/);
  assert.equal(h.replied.times(888), 1);

  const second = await scanStrangerReplies(h.deps);
  assert.equal(second.created.length, 0, '同一条回复只生成一次草稿');
  assert.equal(h.pending.all().length, 1);
});

test('扫描：关掉「陌生人回复走审批」就一律不生成', async () => {
  const h = harness({ strangerApproval: false });
  seedOurComment(h);
  h.replies.push(comment());
  const result = await scanStrangerReplies(h.deps);
  assert.equal(result.created.length, 0);
  assert.ok(result.skipped.some((line) => line.includes('审批')), result.skipped.join('\n'));
});

test('审批：预演只出 plan；真发带 root+parent，成功后状态 sent 并记账', async () => {
  const h = harness();
  seedOurComment(h);
  h.replies.push(comment());
  const scan = await scanStrangerReplies(h.deps);
  const id = scan.created[0]?.id;
  assert.ok(id);

  const dry = await approvePending(h.deps, id, { dryRun: true });
  assert.equal(dry.ok, true);
  assert.match(dry.message, /预演/);
  assert.equal(h.transport.calls.length, 0, '预演不能发请求');
  assert.equal(h.pending.byId(id)?.status, 'pending', '预演不改状态');

  const real = await approvePending(h.deps, id);
  assert.equal(real.ok, true);
  assert.equal(real.rpid, '555');
  assert.equal(real.verified, true);
  assert.equal(h.transport.calls.length, 1);
  assert.equal(h.transport.calls[0]?.form?.root, '100');
  assert.equal(h.transport.calls[0]?.form?.parent, '200');
  assert.equal(h.pending.byId(id)?.status, 'sent');

  const entry = h.quota.entries().at(-1);
  assert.equal(entry?.status, 'sent');
  assert.equal(entry?.share, false, '审批回复不占分享额度');
  assert.equal(entry?.root, '100');
  assert.equal(entry?.parent, '200');
});

test('审批：复核失败标 unverified，不重发', async () => {
  const h = harness();
  seedOurComment(h);
  h.replies.push(comment());
  const scan = await scanStrangerReplies(h.deps);
  const id = scan.created[0]?.id ?? '';
  h.found.value = false;

  const result = await approvePending(h.deps, id);
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(h.transport.calls.length, 1);
  assert.equal(h.quota.entries().at(-1)?.status, 'unverified');
});

test('审批：风控冷却 / 总开关关着 时拒绝发送', async () => {
  const h = harness();
  seedOurComment(h);
  h.replies.push(comment());
  const scan = await scanStrangerReplies(h.deps);
  const id = scan.created[0]?.id ?? '';

  h.state.setRiskCooldown(new Date(Date.now() + 60_000).toISOString());
  const cooling = await approvePending(h.deps, id);
  assert.equal(cooling.ok, false);
  assert.match(cooling.message, /风控/);
  assert.equal(h.transport.calls.length, 0);
});

test('审批：拒绝后状态 rejected，并记下理由', () => {
  const h = harness();
  seedOurComment(h);
  const item = h.pending.add({
    id: newPendingId(),
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt(),
    status: 'pending',
    bvid: 'BV1pend1',
    aid: 9001,
    root: '100',
    parent: '200',
    target: { mid: 888, uname: '路人甲' },
    sourceComment: '在吗',
    draft: '在的',
  });

  const result = rejectPending(h.deps, item.id, '不想回');
  assert.equal(result.ok, true);
  assert.equal(h.pending.byId(item.id)?.status, 'rejected');
  assert.equal(h.pending.byId(item.id)?.note, '不想回');
});

test('审批：已经处理过的草稿不能再处理', async () => {
  const h = harness();
  seedOurComment(h);
  h.replies.push(comment());
  const scan = await scanStrangerReplies(h.deps);
  const id = scan.created[0]?.id ?? '';

  await approvePending(h.deps, id);
  const again = await approvePending(h.deps, id);
  assert.equal(again.ok, false);
  assert.match(again.message, /sent/);
  assert.equal(h.transport.calls.length, 1, '第二次不许再发');
});

test('扫描：自己回自己的那条不算「陌生人回复」', async () => {
  const h = harness({ selfMid: 999 });
  seedOurComment(h);
  h.replies.push(comment({ mid: 999, uname: '鲸鲸', rpid: '300' }));
  const result = await scanStrangerReplies(h.deps);
  assert.equal(result.created.length, 0);
});
