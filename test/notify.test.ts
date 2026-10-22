import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchNotifications, inQuietHours, webhookPayload } from '../src/notify/index.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { Config } from '../src/config/spec.ts';
import { Logger } from '../src/shared/logger.ts';
import { tmpDir } from './helpers.ts';
import path from 'node:path';

function configWith(notify: Record<string, unknown>): Config {
  const result = validateConfig({ notify });
  assert.ok(result.ok, JSON.stringify(result.issues));
  return result.value;
}

function logger(): Logger {
  const dir = tmpDir('notify');
  return new Logger({ logDir: dir, eventsFile: path.join(dir, 'events.jsonl'), level: 'error' });
}

test('静默时段：跨零点与同一天都能判对', () => {
  const cfg = configWith({ quietHours: { enabled: true, start: '23:00', end: '08:00' } });
  assert.equal(inQuietHours(cfg, new Date(2026, 9, 22, 23, 30)), true, '23:30 应该静默');
  assert.equal(inQuietHours(cfg, new Date(2026, 9, 22, 7, 59)), true, '07:59 应该静默');
  assert.equal(inQuietHours(cfg, new Date(2026, 9, 22, 8, 0)), false, '08:00 应该恢复');
  assert.equal(inQuietHours(cfg, new Date(2026, 9, 22, 12, 0)), false);

  const day = configWith({ quietHours: { enabled: true, start: '12:00', end: '13:00' } });
  assert.equal(inQuietHours(day, new Date(2026, 9, 22, 12, 30)), true);
  assert.equal(inQuietHours(day, new Date(2026, 9, 22, 13, 1)), false);

  const off = configWith({ quietHours: { enabled: false, start: '00:00', end: '23:59' } });
  assert.equal(inQuietHours(off, new Date(2026, 9, 22, 12, 0)), false, '关掉就不该静默');
});

test('分发：file 写、webhook 真发、command 收到环境变量', async () => {
  const cfg = configWith({
    channels: [
      { type: 'file', enabled: true },
      { type: 'webhook', enabled: true, url: 'https://example.com/hook', format: 'feishu' },
      { type: 'command', enabled: true, cmd: 'notify-tool', args: '--quiet' },
    ],
  });
  const written: string[] = [];
  const posted: Array<{ url: string; body: string }> = [];
  const spawned: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];

  const result = await dispatchNotifications(
    {
      config: cfg,
      logger: logger(),
      writeFile: (text) => written.push(text),
      fetchImpl: async (url, init) => {
        posted.push({ url, body: String(init?.body ?? '') });
        return new Response('{}', { status: 200 });
      },
      runCommand: async (cmd, args, env) => {
        spawned.push({ cmd, args, env });
      },
    },
    { text: '今天挑中一条', at: new Date(2026, 9, 22, 15, 0) },
  );

  assert.deepEqual(result.delivered.sort(), ['command', 'file', 'webhook'].sort());
  assert.equal(written.length, 1);
  assert.equal(posted[0]?.url, 'https://example.com/hook');
  assert.deepEqual(JSON.parse(posted[0]?.body ?? '{}'), { msg_type: 'text', content: { text: '今天挑中一条' } });
  assert.equal(spawned[0]?.cmd, 'notify-tool');
  assert.deepEqual(spawned[0]?.args, ['--quiet']);
  assert.equal(spawned[0]?.env.BILIWHALE_NOTIFY_TEXT, '今天挑中一条');
});

test('静默时段：只发 file，其它渠道跳过', async () => {
  const cfg = configWith({
    quietHours: { enabled: true, start: '23:00', end: '08:00' },
    channels: [
      { type: 'file', enabled: true },
      { type: 'webhook', enabled: true, url: 'https://example.com/hook' },
    ],
  });
  let posted = 0;
  const written: string[] = [];
  const result = await dispatchNotifications(
    {
      config: cfg,
      logger: logger(),
      writeFile: (text) => written.push(text),
      fetchImpl: async () => {
        posted += 1;
        return new Response('{}', { status: 200 });
      },
    },
    { text: 'x', at: new Date(2026, 9, 22, 23, 30) },
  );
  assert.equal(result.quiet, true);
  assert.equal(posted, 0, '静默时段不许发 webhook');
  assert.deepEqual(result.delivered, ['file']);
  assert.equal(written.length, 1);
});

test('file 关着且其它渠道都失败 → 兜底写文件', async () => {
  const cfg = configWith({
    channels: [
      { type: 'file', enabled: false },
      { type: 'webhook', enabled: true, url: 'https://example.com/hook' },
    ],
  });
  const written: string[] = [];
  const result = await dispatchNotifications(
    {
      config: cfg,
      logger: logger(),
      writeFile: (text) => written.push(text),
      fetchImpl: async () => {
        throw new Error('network down');
      },
    },
    { text: '兜底这条', at: new Date(2026, 9, 22, 15, 0) },
  );
  assert.deepEqual(result.failed.map((item) => item.channel), ['webhook']);
  assert.ok(result.delivered.includes('file（兜底）'));
  assert.deepEqual(written, ['兜底这条']);
});

test('webhook 报文形状：飞书/钉钉/企微/通用', () => {
  assert.deepEqual(webhookPayload('feishu', 'text', 'hi'), { msg_type: 'text', content: { text: 'hi' } });
  assert.deepEqual(webhookPayload('dingtalk', 'text', 'hi'), { msgtype: 'text', text: { content: 'hi' } });
  assert.deepEqual(webhookPayload('wecom', 'markdown', 'hi'), { msgtype: 'markdown', markdown: { content: 'hi' } });
  assert.deepEqual(webhookPayload('generic', 'text', 'hi'), { text: 'hi' });
});
