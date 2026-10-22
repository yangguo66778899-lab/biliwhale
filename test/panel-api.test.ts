import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startDaemon } from '../src/daemon/index.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { tmpDir } from './helpers.ts';

interface Ctx {
  base: string;
  auth: Record<string, string>;
  csrf: string;
  dir: string;
}

async function withDaemon(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = tmpDir('panel-api');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, report: { level: 'brief' }, logging: { level: 'error' }, ui: { port: 0 } }, null, 2),
    'utf8',
  );
  const started = await startDaemon({ dataDir: dir, port: 0, fixtures: true, version: 'test', tickMs: 3600_000, heartbeatMs: 3600_000 });
  assert.equal(started.kind, 'started');
  if (started.kind !== 'started') return;

  const base = `http://127.0.0.1:${started.port}`;
  const auth = { authorization: `Bearer ${started.token}` };
  try {
    const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
    await fn({ base, auth, csrf: session.csrfToken, dir });
  } finally {
    await started.stop();
  }
}

function write(csrf: string, auth: Record<string, string>): Record<string, string> {
  return { ...auth, 'content-type': 'application/json', 'x-csrf-token': csrf };
}

test('配置接口：读得到、分组元数据齐全、非法值被拒、改完立刻生效', async () => {
  await withDaemon(async ({ base, auth, csrf, dir }) => {
    const got = (await (await fetch(`${base}/api/config`, { headers: auth })).json()) as {
      ok: boolean;
      config: Record<string, unknown>;
      groups: Array<{ key: string; label: string; fields: Array<{ path: string; widget: string; default: unknown }> }>;
      issues: unknown[];
    };
    assert.equal(got.ok, true);
    assert.ok(got.groups.length >= 6, '至少 6 个配置分组');
    const keys = got.groups.map((group) => group.key);
    for (const expected of ['schedule', 'report', 'share', 'account', 'media', 'ui']) {
      assert.ok(keys.includes(expected), `缺少分组 ${expected}`);
    }

    const llm = got.groups.find((group) => group.key === 'llm');
    assert.ok(llm, '要有 llm 分组');
    const temp = llm?.fields.find((field) => field.path === 'temperature');
    assert.ok(temp, 'temperature 字段要在描述里');
    assert.equal(temp?.widget, 'number');
    assert.equal(typeof temp?.default, 'number', '默认值要带上，面板「恢复默认」用');

    // 非法值：超范围必须 422，且给出可读的 path
    const bad = await fetch(`${base}/api/config`, { method: 'PUT', headers: write(csrf, auth), body: JSON.stringify({ llm: { temperature: 99 } }) });
    assert.equal(bad.status, 422);
    const badBody = (await bad.json()) as { ok: boolean; issues: Array<{ path: string; message: string }> };
    assert.equal(badBody.ok, false);
    assert.ok(badBody.issues.some((issue) => issue.path.includes('llm.temperature')), '要说清哪个字段坏了');

    // 合法修改：落盘 + 立即生效
    const good = await fetch(`${base}/api/config`, { method: 'PUT', headers: write(csrf, auth), body: JSON.stringify({ llm: { temperature: 0.7 } }) });
    assert.equal(good.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as { llm?: { temperature?: number } };
    assert.equal(saved.llm?.temperature, 0.7, '要写进 config.json');

    const after = (await (await fetch(`${base}/api/config`, { headers: auth })).json()) as { config: { llm: { temperature: number } } };
    assert.equal(after.config.llm.temperature, 0.7);
  });
});

test('配置导出导入与恢复默认：都不碰凭据', async () => {
  await withDaemon(async ({ base, auth, csrf, dir }) => {
    fs.writeFileSync(
      path.join(dir, 'secrets.json'),
      JSON.stringify({ version: 1, bili: { cookie: 'SESSDATA=keepme', mid: 42, uname: '鲸鲸' }, deepseek: { apiKey: 'sk-keepme' } }, null, 2),
      'utf8',
    );

    const exported = await fetch(`${base}/api/config/export`, { headers: auth });
    assert.equal(exported.status, 200);
    const text = await exported.text();
    assert.equal(text.includes('keepme'), false, '导出的配置里不能有凭据');

    const imported = await fetch(`${base}/api/config/import`, {
      method: 'POST',
      headers: write(csrf, auth),
      body: JSON.stringify({ config: { version: 1, report: { level: 'full' } } }),
    });
    assert.equal(imported.status, 200);

    const reset = await fetch(`${base}/api/config/reset`, { method: 'POST', headers: write(csrf, auth) });
    assert.equal(reset.status, 200);

    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')) as {
      bili?: { cookie?: string };
      deepseek?: { apiKey?: string };
    };
    assert.equal(secrets.bili?.cookie, 'SESSDATA=keepme', '恢复默认不能清 cookie');
    assert.equal(secrets.deepseek?.apiKey, 'sk-keepme', '恢复默认不能清 key');
  });
});

test('账号接口：状态如实；夹具模式不支持扫码（要给出原因，不是假装成功）', async () => {
  await withDaemon(async ({ base, auth, csrf }) => {
    const account = (await (await fetch(`${base}/api/account`, { headers: auth })).json()) as { ok: boolean; loggedIn: boolean };
    assert.equal(account.ok, true);
    assert.equal(account.loggedIn, false);

    const qr = await fetch(`${base}/api/account/qr`, { method: 'POST', headers: write(csrf, auth) });
    assert.equal(qr.status, 502);
    const qrBody = (await qr.json()) as { ok: boolean; message?: string };
    assert.equal(qrBody.ok, false);
    assert.match(String(qrBody.message), /响应头|不支持|网络/);

    const logout = (await (await fetch(`${base}/api/account/logout`, { method: 'POST', headers: write(csrf, auth) })).json()) as { ok: boolean };
    assert.equal(logout.ok, true);
  });
});

test('报告与日记：列目录、读单篇、非法日期 400、不存在 404', async () => {
  await withDaemon(async ({ base, auth, dir }) => {
    const paths = resolvePaths({ dataDir: dir });
    fs.mkdirSync(paths.reportsDir, { recursive: true });
    fs.mkdirSync(paths.diariesPublicDir, { recursive: true });
    fs.mkdirSync(paths.diariesPrivateDir, { recursive: true });
    fs.writeFileSync(path.join(paths.reportsDir, '2026-10-19.md'), '# 报告 A\n', 'utf8');
    fs.writeFileSync(path.join(paths.reportsDir, '2026-10-21.md'), '# 报告 B\n', 'utf8');
    fs.writeFileSync(path.join(paths.diariesPublicDir, '2026-10-21.md'), '# 公开\n', 'utf8');
    fs.writeFileSync(path.join(paths.diariesPrivateDir, '2026-10-21.md'), '# 私人\n', 'utf8');

    const list = (await (await fetch(`${base}/api/reports`, { headers: auth })).json()) as { items: Array<{ date: string }> };
    assert.deepEqual(
      list.items.map((item) => item.date),
      ['2026-10-21', '2026-10-19'],
      '按日期倒序',
    );

    const doc = (await (await fetch(`${base}/api/reports/2026-10-21`, { headers: auth })).json()) as { markdown: string };
    assert.match(doc.markdown, /报告 B/);
    assert.equal((await fetch(`${base}/api/reports/2026-10-20`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/api/reports/..%2f..%2fpackage`, { headers: auth })).status, 400);

    const pub = (await (await fetch(`${base}/api/diaries?kind=public`, { headers: auth })).json()) as { items: Array<{ date: string }> };
    assert.equal(pub.items.length, 1);
    const priv = (await (await fetch(`${base}/api/diaries/private/2026-10-21`, { headers: auth })).json()) as { markdown: string };
    assert.match(priv.markdown, /私人/);

    // 搜索：命中数、没命中就是空列表
    const found = (await (await fetch(`${base}/api/diaries?kind=private&q=私人`, { headers: auth })).json()) as {
      items: Array<{ date: string; hits: number }>;
    };
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0]?.hits, 1);
    const miss = (await (await fetch(`${base}/api/diaries?kind=private&q=不存在的词`, { headers: auth })).json()) as {
      items: unknown[];
    };
    assert.deepEqual(miss.items, []);
  });
});

test('体检与诊断包：都能出，且诊断包里不含凭据', async () => {
  await withDaemon(async ({ base, auth, dir, csrf }) => {
    fs.writeFileSync(
      path.join(dir, 'secrets.json'),
      JSON.stringify({ version: 1, bili: { cookie: 'SESSDATA=must-not-leak' }, deepseek: { apiKey: 'sk-must-not-leak' } }, null, 2),
      'utf8',
    );

    const doctor = (await (await fetch(`${base}/api/doctor`, { headers: auth })).json()) as {
      ok: boolean;
      report: { healthy: boolean; rows: Array<{ name: string; level: string }> };
    };
    assert.equal(doctor.ok, true);
    const names = doctor.report.rows.map((row) => row.name);
    for (const expected of ['单实例锁', '控制接口', '心跳', '开机自启', '托盘程序']) {
      assert.ok(names.includes(expected), `体检缺少「${expected}」`);
    }
    assert.equal(doctor.report.rows.find((row) => row.name === '单实例锁')?.level, 'warn', '自己在跑，锁那一行应该是 warn');

    // DeepSeek key：状态只给指纹；格式不对的 key 要拒；合法的 key 能存进 secrets.json
    const secretsStatus = (await (await fetch(`${base}/api/secrets`, { headers: auth })).json()) as {
      ok: boolean;
      hasApiKey: boolean;
      fingerprint: string;
    };
    assert.equal(secretsStatus.ok, true);
    assert.equal(secretsStatus.hasApiKey, false);

    const badKey = await fetch(`${base}/api/secrets/llm`, { method: 'PUT', headers: write(csrf, auth), body: JSON.stringify({ apiKey: 'nope' }) });
    assert.equal(badKey.status, 422);

    const goodKey = await fetch(`${base}/api/secrets/llm`, {
      method: 'PUT',
      headers: write(csrf, auth),
      body: JSON.stringify({ apiKey: 'sk-test-0123456789abcdef' }),
    });
    assert.equal(goodKey.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')) as { llm?: { apiKey?: string } };
    assert.equal(saved.llm?.apiKey, 'sk-test-0123456789abcdef');

    const after = (await (await fetch(`${base}/api/secrets`, { headers: auth })).json()) as { hasApiKey: boolean; fingerprint: string };
    assert.equal(after.hasApiKey, true);
    assert.ok(after.fingerprint.length > 0, '要给出指纹（不是原值）');
    assert.equal(after.fingerprint.includes('0123456789abcdef'), false, '指纹不能是原值');

    // M3：待审队列（空队列也要能读；批准/拒绝不存在的东西回 409）
    const pendingList = (await (await fetch(`${base}/api/pending`, { headers: auth })).json()) as { ok: boolean; count: number; items: unknown[] };
    assert.equal(pendingList.ok, true);
    assert.equal(pendingList.count, 0);
    assert.deepEqual(pendingList.items, []);
    const approveMissing = await fetch(`${base}/api/pending/nope/approve`, { method: 'POST', headers: write(csrf, auth), body: '{}' });
    assert.equal(approveMissing.status, 409);
    const rejectMissing = await fetch(`${base}/api/pending/nope/reject`, {
      method: 'POST',
      headers: write(csrf, auth),
      body: JSON.stringify({ reason: 'x' }),
    });
    assert.equal(rejectMissing.status, 409);

    const diag = await fetch(`${base}/api/diag`, { headers: auth });
    assert.equal(diag.status, 200);
    assert.match(diag.headers.get('content-disposition') ?? '', /attachment; filename="biliwhale-diag-/);
    const text = await diag.text();
    assert.equal(text.includes('must-not-leak'), false, '诊断包不能带 cookie / key');
    const bundle = JSON.parse(text) as { version: string; doctor: unknown; system: { node: string }; notes: string[] };
    assert.equal(bundle.version, 'test');
    assert.ok(bundle.doctor);
    assert.match(bundle.system.node, /^v\d+\./);
    assert.ok(bundle.notes.length > 0);
  });
});

test('面板静态资源与状态页都能从内核取到（离线、无外链）', async () => {
  await withDaemon(async ({ base, auth }) => {
    const token = (auth.authorization ?? '').replace(/^Bearer /, '');
    for (const [file, type] of [
      ['/', /text\/html/],
      ['/style.css', /text\/css/],
      ['/app.js', /javascript/],
    ] as const) {
      const res = await fetch(`${base}${file}?token=${encodeURIComponent(token)}`);
      assert.equal(res.status, 200, `${file} 应该 200`);
      assert.match(res.headers.get('content-type') ?? '', type);
      const body = await res.text();
      assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(body), false, `${file} 不该引用外部地址`);
    }
  });
});
