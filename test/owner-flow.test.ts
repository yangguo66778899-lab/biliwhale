import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrap } from '../src/bootstrap.ts';
import { runDoctor } from '../src/doctor.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { tmpDir } from './helpers.ts';

/**
 * 双账号的「开箱流程」：登录账号自动回填、主人缺了要在体检里一眼看到。
 * 真机反馈：设置里没有填主人的地方，程序把登录账号当主人；现在缺主人必须是**硬性**项。
 */

function seedLogin(dir: string): void {
  const paths = resolvePaths({ dataDir: dir });
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const secrets = new SecretsService(dir, logger);
  secrets.setCookie(`SESSDATA=abc; bili_jct=${'a'.repeat(32)}; DedeUserID=4242`, { mid: 4242, uname: '鲸鲸' });
}

test('启动时把登录账号的 UID/昵称回填到配置（那是「鲸鲸」，不是主人）', async () => {
  const dir = tmpDir('owner-flow-boot');
  seedLogin(dir);
  const ctx = await bootstrap({ dataDir: dir, fixtures: true, discover: false });

  const cfg = ctx.config.get();
  assert.equal(cfg.account.mid, 4242, '登录账号 UID 自动回填');
  assert.equal(cfg.account.name, '鲸鲸', '登录账号昵称自动回填');
  assert.equal(cfg.account.ownerMid, 0, '主人不会被自动填成登录账号（必须由用户填）');
});

test('体检：没填主人 UID → 必需清单里是硬性缺失（bad），并告诉去哪填', async () => {
  const dir = tmpDir('owner-flow-doctor');
  seedLogin(dir);
  const ctx = await bootstrap({ dataDir: dir, fixtures: true, discover: false });
  const report = await runDoctor(ctx, { version: 'test', fixtures: true, offline: true });

  const ownerItem = report.required.find((item) => item.key === 'owner');
  assert.ok(ownerItem, '必需清单里要有「主人 UID」这一项');
  assert.equal(ownerItem?.ok, false, '没填主人 UID 时必须是不通过');
  assert.match(ownerItem?.detail ?? '', /还没填主人 UID/);
  assert.equal(ownerItem?.tab, 'account', '要指到「账号」页去填');

  const row = report.rows.find((item) => item.name.startsWith('主人'));
  assert.equal(row?.level, 'bad', '体检表里主人这一项要是 bad，不是 warn');
  assert.equal(report.ready, false, '主人没配好 → 整体没准备好');
});

test('体检：填了主人（另一个号）→ 主人两项都通过', async () => {
  const dir = tmpDir('owner-flow-ok');
  seedLogin(dir);
  const ctx = await bootstrap({ dataDir: dir, fixtures: true, discover: false });
  ctx.config.patch({ account: { ownerMid: 777, ownerName: '老王' } });
  const report = await runDoctor(ctx, { version: 'test', fixtures: true, offline: true });

  const ownerItem = report.required.find((item) => item.key === 'owner');
  const nameItem = report.required.find((item) => item.key === 'ownerName');
  assert.equal(ownerItem?.ok, true);
  assert.match(ownerItem?.detail ?? '', /老王（777）/);
  assert.equal(nameItem?.ok, true);
});

test('体检：主人 UID 填成登录账号本身 → 不通过（必须是两个号）', async () => {
  const dir = tmpDir('owner-flow-same');
  seedLogin(dir);
  const ctx = await bootstrap({ dataDir: dir, fixtures: true, discover: false });
  ctx.config.patch({ account: { ownerMid: 4242, ownerName: '鲸鲸' } });
  const report = await runDoctor(ctx, { version: 'test', fixtures: true, offline: true });

  const ownerItem = report.required.find((item) => item.key === 'owner');
  assert.equal(ownerItem?.ok, false);
  assert.match(ownerItem?.detail ?? '', /不能等于登录账号/);
});
