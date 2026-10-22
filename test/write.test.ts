import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  BiliWriter,
  classifyBusiness,
  countChars,
  describePlan,
  pickRpid,
} from '../src/bili/write.ts';
import type { Transport, TransportRequest } from '../src/bili/http.ts';
import type { Result } from '../src/shared/errors.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';

/** 记录请求的假传输层：返回预置信封。 */
class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  envelope: { code: number; message: string; data: unknown } = { code: 0, message: '0', data: { rpid: 12345, rpid_str: '12345' } };
  failWith: { kind: 'network' } | null = null;

  async json<T>(): Promise<Result<T>> {
    return { ok: true, data: this.envelope as unknown as T };
  }

  async jsonEnvelope<T>(req: TransportRequest): Promise<Result<{ code: number; message: string; data: T }>> {
    this.calls.push(req);
    if (this.failWith) {
      return { ok: false, error: { kind: this.failWith.kind, code: 'network', message: '网络断了' } };
    }
    return { ok: true, data: this.envelope as { code: number; message: string; data: T } };
  }
}

function makeWriter(csrf = 'a'.repeat(32)): { writer: BiliWriter; transport: FakeTransport; logs: string[] } {
  const dir = tmpDir('write');
  const logs: string[] = [];
  const logger = new Logger({ logDir: path.join(dir, 'logs'), eventsFile: path.join(dir, 'events.jsonl'), level: 'debug', mirrorToConsole: false });
  const transport = new FakeTransport();
  const writer = new BiliWriter({ http: transport, csrf: () => csrf, logger, skipThrottle: true });
  void logs;
  return { writer, transport, logs };
}

test('计划（dry-run）：发评论与楼中楼分别长什么样，csrf 必须打码', () => {
  const { writer } = makeWriter('0123456789abcdef0123456789abcdef');

  const comment = writer.planComment({ bvid: 'BV1xx', aid: 111, message: '这条真好' });
  assert.equal(comment.action, 'comment');
  assert.equal(comment.method, 'POST');
  assert.equal(comment.form.oid, '111');
  assert.equal(comment.form.type, '1');
  assert.equal(comment.form.plat, '1');
  assert.equal(comment.form.message, '这条真好');
  assert.equal(comment.form.csrf, '0123…cdef', 'csrf 只能露头尾');
  assert.equal(comment.form.root, undefined);
  assert.match(comment.summary, /BV1xx/);

  const reply = writer.planComment({ bvid: 'BV1xx', aid: 111, message: '你说得对', root: '900', parent: '901' });
  assert.equal(reply.action, 'reply');
  assert.equal(reply.form.root, '900');
  assert.equal(reply.form.parent, '901');
  assert.match(reply.summary, /#901/);
});

test('dry-run 不发请求：只回 plan', async () => {
  const { writer, transport } = makeWriter();
  const outcome = await writer.postComment({ bvid: 'BV1xx', aid: 1, message: 'hi' }, { dryRun: true });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.rpid, undefined);
  assert.equal(transport.calls.length, 0, '预演绝不能发请求');
});

test('真发评论：POST + 带签名 + 带 csrf + 不重试，并从响应取 rpid', async () => {
  const { writer, transport } = makeWriter('b'.repeat(32));
  const outcome = await writer.postComment({ bvid: 'BV1xx', aid: 42, message: '看看这个' }, { dryRun: false });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.rpid, '12345');
  const call = transport.calls[0];
  assert.ok(call);
  assert.equal(call.method, 'POST');
  assert.equal(call.sign, true, '写接口必须签名');
  assert.equal(call.noRetry, true, '写接口不许自动重试');
  assert.equal(call.form?.csrf, 'b'.repeat(32));
  assert.equal(call.form?.oid, '42');
});

test('没有 csrf（bili_jct）时直接拒绝，不发请求', async () => {
  const { writer, transport } = makeWriter('');
  const outcome = await writer.postComment({ bvid: 'BV1xx', aid: 1, message: 'hi' }, { dryRun: false });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.kind, 'auth');
  assert.match(outcome.error?.message ?? '', /bili_jct/);
  assert.equal(transport.calls.length, 0);
});

test('业务错误分类：未登录 / csrf / 风控 / 限流 / 其它', () => {
  assert.equal(classifyBusiness(-101, '').kind, 'auth');
  assert.equal(classifyBusiness(-111, '').kind, 'auth');
  assert.equal(classifyBusiness(-412, '').kind, 'risk');
  assert.equal(classifyBusiness(412, '').kind, 'risk');
  assert.equal(classifyBusiness(-352, '').kind, 'risk');
  assert.equal(classifyBusiness(-509, '').kind, 'risk');
  assert.equal(classifyBusiness(12015, '').kind, 'risk');
  assert.match(classifyBusiness(12015, '').message, /验证码/);
  assert.equal(classifyBusiness(12051, '').kind, 'risk');
  assert.match(classifyBusiness(12051, '').message, /刷屏/);
  assert.equal(classifyBusiness(12002, '').kind, 'rate');
  assert.equal(classifyBusiness(-404, '').kind, 'business');
});

test('业务错误码非 0 时返回失败（不发就是不发）', async () => {
  const { writer, transport } = makeWriter();
  transport.envelope = { code: 12015, message: '需要验证', data: null };
  const outcome = await writer.postComment({ bvid: 'BV1xx', aid: 1, message: 'hi' }, { dryRun: false });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error?.kind, 'risk');
  assert.equal(outcome.rpid, undefined, '失败时绝不编 rpid');
});

test('rpid 解析：数字 / 字符串 / 0 / 缺失', () => {
  assert.equal(pickRpid({ rpid: 999 }), '999');
  assert.equal(pickRpid({ rpid_str: '888' }), '888');
  assert.equal(pickRpid({ rpid: 0 }), null);
  assert.equal(pickRpid({ rpid_str: '0' }), null);
  assert.equal(pickRpid({}), null);
  assert.equal(pickRpid(null), null);
});

test('删自己的评论：dry-run 只出 plan；真删会带 rpid', async () => {
  const { writer, transport } = makeWriter();
  const plan = writer.planDelete({ bvid: 'BV1xx', aid: 7, rpid: '555' });
  assert.equal(plan.action, 'deleteComment');
  assert.equal(plan.form.rpid, '555');

  const dry = await writer.deleteComment({ bvid: 'BV1xx', aid: 7, rpid: '555' }, { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(transport.calls.length, 0);

  const real = await writer.deleteComment({ bvid: 'BV1xx', aid: 7, rpid: '555' }, { dryRun: false });
  assert.equal(real.ok, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.form?.rpid, '555');
});

test('describePlan 不泄漏 cookie：只输出 method/url/表单，csrf 已打码', () => {
  const { writer } = makeWriter('c'.repeat(32));
  const line = describePlan(writer.planComment({ bvid: 'BV1xx', aid: 1, message: 'hi' }));
  assert.match(line, /^POST https:\/\/api\.bilibili\.com\/x\/v2\/reply\/add/);
  assert.equal(line.includes('c'.repeat(32)), false);
});

test('字数按码点算（emoji 算一个）', () => {
  assert.equal(countChars('鲸鱼'), 2);
  assert.equal(countChars('🐳ya'), 3);
});

test('发动态：dry-run 只出 plan；真发是 POST + csrf + dyn_req（面板入口靠它）', async () => {
  const csrf = '0123456789abcdef0123456789abcdef';
  const { writer, transport } = makeWriter(csrf);

  const dry = await writer.postDynamic({ text: '今天看了两条，都不长' }, { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(transport.calls.length, 0, '预演不许真的发');
  assert.match(dry.plan.summary, /2 条|一条动态/);

  const real = await writer.postDynamic({ text: '今天看了两条，都不长' }, { dryRun: false });
  assert.equal(real.ok, true);
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call?.method, 'POST');
  assert.match(String(call?.url), /\/x\/dynamic\/feed\/create\/dyn$/);
  assert.equal(call?.form?.csrf, csrf, '要带真 csrf');
  const dynReq = JSON.parse(String(call?.form?.dyn_req ?? '{}')) as {
    content?: { contents?: Array<{ raw_text?: string; type?: number }> };
    scene?: number;
  };
  assert.equal(dynReq.content?.contents?.[0]?.raw_text, '今天看了两条，都不长');
  assert.equal(dynReq.content?.contents?.[0]?.type, 1);
  assert.equal(dynReq.scene, 1);
});

test('发动态：没有 csrf 直接拒绝，不发请求', async () => {
  const { writer, transport } = makeWriter('');
  const outcome = await writer.postDynamic({ text: 'x' }, { dryRun: false });
  assert.equal(outcome.ok, false);
  assert.equal(transport.calls.length, 0);
  assert.match(outcome.error?.message ?? '', /csrf|bili_jct/i);
});
