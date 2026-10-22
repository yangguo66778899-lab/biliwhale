import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { InstanceLock, isProcessAlive } from '../src/lifecycle/lock.ts';
import { AutostartService } from '../src/lifecycle/autostart.ts';
import type { RegistryCommand } from '../src/lifecycle/autostart.ts';
import {
  heartbeatFresh,
  clearRuntime,
  newToken,
  readHeartbeat,
  readRuntime,
  writeHeartbeat,
  writeRuntime,
} from '../src/lifecycle/runtime.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { tmpDir } from './helpers.ts';

/* ---------------- 单实例锁 ---------------- */

test('锁：拿到 → 读得到 → 放掉之后别人能拿', () => {
  const dir = tmpDir('lock');
  const file = path.join(dir, 'instance.lock');
  const lock = new InstanceLock(file);
  const acquired = lock.acquire({ port: 8787, version: 'test' });
  assert.equal(acquired.acquired, true);

  const info = lock.read();
  assert.equal(info?.pid, process.pid);
  assert.equal(info?.port, 8787);
  assert.equal(info?.version, 'test');

  lock.updatePort(9999);
  assert.equal(lock.read()?.port, 9999);

  lock.release();
  assert.equal(lock.read(), null, '放掉之后锁文件应消失');

  const again = new InstanceLock(file);
  assert.equal(again.acquire().acquired, true);
  again.release();
});

test('锁：活着的进程占着就不让第二个启动，并告诉我们是谁', () => {
  const dir = tmpDir('lock-busy');
  const file = path.join(dir, 'instance.lock');
  // 先写一个「别人」的锁：用当前进程 pid 冒充（它确实活着）
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: 8788 }), 'utf8');

  const second = new InstanceLock(file, { pid: process.pid + 1 });
  const result = second.acquire();
  assert.equal(result.acquired, false);
  if (!result.acquired) {
    assert.equal(result.holder?.pid, process.pid);
    assert.equal(result.holder?.port, 8788);
    assert.match(result.reason, /已有实例在跑/);
  }
});

test('锁：陈旧的锁（进程已死 / 文件太老 / 内容坏了）会被清掉重来', () => {
  const dir = tmpDir('lock-stale');
  const file = path.join(dir, 'instance.lock');

  // 1) 进程不存在
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }), 'utf8');
  const first = new InstanceLock(file);
  assert.equal(first.acquire().acquired, true);
  first.release();

  // 2) 太老（超过 24 小时）
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: old }), 'utf8');
  const second = new InstanceLock(file);
  assert.equal(second.acquire().acquired, true, '超过 24 小时的锁应视为陈旧');
  second.release();

  // 3) 内容坏了
  fs.writeFileSync(file, '{ 半截', 'utf8');
  const third = new InstanceLock(file);
  assert.equal(third.acquire().acquired, true);
  third.release();
});

test('isProcessAlive 认得自己与明显的死 pid', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999_999), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
});

/* ---------------- runtime / heartbeat ---------------- */

test('runtime.json：写读清理，token 是 64 位十六进制', () => {
  const dir = tmpDir('runtime');
  const paths = resolvePaths({ dataDir: dir });
  assert.equal(readRuntime(paths), null);

  const token = newToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  writeRuntime(paths, {
    pid: process.pid,
    port: 8787,
    token,
    version: 'test',
    startedAt: new Date().toISOString(),
    dataDir: dir,
    url: 'http://127.0.0.1:8787/?token=' + token,
  });

  const read = readRuntime(paths);
  assert.equal(read?.port, 8787);
  assert.equal(read?.token, token);

  clearRuntime(paths);
  assert.equal(readRuntime(paths), null);
  assert.equal(fs.existsSync(paths.runtime), false);
});

test('heartbeat：新鲜度判定按时间算', () => {
  const dir = tmpDir('heartbeat');
  const paths = resolvePaths({ dataDir: dir });
  assert.equal(heartbeatFresh(null), false);

  const at = new Date('2026-10-21T20:00:00+08:00');
  writeHeartbeat(paths, {
    pid: process.pid,
    at: '2026-10-21T20:00:00+08:00',
    uptimeSec: 10,
    version: 'test',
    running: false,
    paused: false,
    nextWakeAt: null,
    lastRunStatus: null,
  });

  const beat = readHeartbeat(paths);
  assert.equal(beat?.uptimeSec, 10);
  assert.equal(heartbeatFresh(beat, 90_000, new Date(at.getTime() + 30_000)), true);
  assert.equal(heartbeatFresh(beat, 90_000, new Date(at.getTime() + 120_000)), false);
});

/* ---------------- 开机自启 ---------------- */

function okRegistry(store: Map<string, string>): RegistryCommand {
  return {
    async run(args) {
      // reg add <key> /v <name> /t REG_SZ /d <data> /f
      const key = args[1] ?? '';
      const valueName = args[3] ?? '';
      const storeKey = `${key}\\${valueName}`;
      if (args[0] === 'add') {
        store.set(storeKey, args[7] ?? '');
        return { ok: true, stdout: '操作成功完成。', stderr: '' };
      }
      if (args[0] === 'delete') {
        const had = store.delete(storeKey);
        return had ? { ok: true, stdout: '操作成功完成。', stderr: '' } : { ok: false, stdout: '', stderr: '错误: 系统找不到指定的注册表项或值。' };
      }
      if (args[0] === 'query') {
        const value = store.get(storeKey);
        return value === undefined
          ? { ok: false, stdout: '', stderr: '错误: 系统找不到指定的注册表项或值。' }
          : { ok: true, stdout: `HKEY_CURRENT_USER\n    ${valueName}    REG_SZ    ${value}`, stderr: '' };
      }
      return { ok: false, stdout: '', stderr: 'unsupported' };
    },
  };
}

test('自启：注册表可用时走注册表，关掉能清干净', async () => {
  const dir = tmpDir('autostart-reg');
  const store = new Map<string, string>();
  const service = new AutostartService({
    command: '"C:\\Apps\\BiliWhale\\BiliWhaleTray.exe" --autostart',
    startupDir: dir,
    registry: okRegistry(store),
  });

  assert.equal((await service.status()).enabled, false);

  const enabled = await service.enable();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.mechanism, 'registry');
  assert.equal(fs.existsSync(path.join(dir, 'BiliWhale.cmd')), false, '注册表成功时不要同时写启动文件夹');

  const status = await service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.mechanism, 'registry');
  assert.match(status.command ?? '', /BiliWhaleTray\.exe/);

  const disabled = await service.disable();
  assert.equal(disabled.enabled, false);
  assert.equal((await service.status()).enabled, false);
});

test('自启：注册表不可用（reg.exe 起不来）时落到启动文件夹', async () => {
  const dir = tmpDir('autostart-folder');
  const brokenRegistry: RegistryCommand = {
    async run() {
      return { ok: false, stdout: '', stderr: 'spawn EPERM' };
    },
  };
  const service = new AutostartService({
    command: '"C:\\Apps\\BiliWhale\\BiliWhaleTray.exe" --autostart',
    startupDir: dir,
    registry: brokenRegistry,
  });

  const enabled = await service.enable();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.mechanism, 'startup-folder');
  assert.match(enabled.warning ?? '', /注册表写入失败/);

  const cmdFile = path.join(dir, 'BiliWhale.cmd');
  assert.ok(fs.existsSync(cmdFile), '应该在启动文件夹里写一个 .cmd');
  const body = fs.readFileSync(cmdFile, 'utf8');
  assert.match(body, /BiliWhaleTray\.exe/);
  assert.match(body, /--autostart/);

  const status = await service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.mechanism, 'startup-folder');

  await service.disable();
  assert.equal(fs.existsSync(cmdFile), false);
  assert.equal((await service.status()).enabled, false);
});

test('自启：读不到注册表时如实报 warning，不假装「没开」', async () => {
  const dir = tmpDir('autostart-warn');
  const brokenRegistry: RegistryCommand = {
    async run() {
      return { ok: false, stdout: '', stderr: 'Access is denied.' };
    },
  };
  const service = new AutostartService({ command: 'x --autostart', startupDir: dir, registry: brokenRegistry });
  const status = await service.status();
  assert.equal(status.enabled, false);
  assert.match(status.warning ?? '', /读不到注册表/);
});
