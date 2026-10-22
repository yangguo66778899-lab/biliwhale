import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startDaemon } from '../src/daemon/index.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { localDate } from '../src/shared/time.ts';
import { tmpDir } from './helpers.ts';

interface Ctx {
  base: string;
  auth: Record<string, string>;
  csrf: string;
  dir: string;
}

async function withDaemon(fn: (ctx: Ctx) => Promise<void>, extraConfig: Record<string, unknown> = {}): Promise<void> {
  const dir = tmpDir('panel-api');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        report: { level: 'brief' },
        logging: { level: 'error' },
        // ui.port 要合法，这份配置才会被采纳（0 不在 1024–65535 里，整份会被判非法而回落默认值）
        ui: { port: 8787 },
        // 没有时间窗口 → 内核起来时的首个 tick 不会真的跑一轮（否则测试会在后台写报告，断言随时刻漂移）
        schedule: { windows: [] },
        ...extraConfig,
      },
      null,
      2,
    ),
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
      groups: Array<{
        key: string;
        label: string;
        fields: Array<{ path: string; relPath: string; widget: string; default: unknown; fields?: Array<{ path: string; relPath: string }> }>;
      }>;
      issues: unknown[];
    };
    assert.equal(got.ok, true);
    assert.ok(got.groups.length >= 6, '至少 6 个配置分组');
    const keys = got.groups.map((group) => group.key);
    for (const expected of ['schedule', 'report', 'share', 'account', 'notify', 'ui', 'media']) {
      assert.ok(keys.includes(expected), `缺少分组 ${expected}`);
    }

    // 「看画面」的开关必须默认关（P0-1 的教训：默认开但永远不生效 = 假信号；§7.10 要求默认关）
    const mediaGroup = got.groups.find((group) => group.key === 'media');
    assert.equal(mediaGroup?.label, '看画面');
    const frames = mediaGroup?.fields.find((field) => field.path === 'media.frames');
    assert.equal(frames?.default, false, 'media.frames 默认必须是 false');

    // 关键回归：组内字段的 path 必须是「组.字段」的绝对路径。
    // （曾经只给字段名，面板把值写到顶层垃圾字段上，开关永远打不开。）
    for (const group of got.groups) {
      for (const field of group.fields) {
        assert.ok(field.path.startsWith(`${group.key}.`), `${group.key} 组字段 ${field.path} 不是绝对路径`);
        assert.equal(field.relPath, field.path.slice(group.key.length + 1));
      }
    }

    const llm = got.groups.find((group) => group.key === 'llm');
    assert.ok(llm, '要有 llm 分组');
    const temp = llm?.fields.find((field) => field.path === 'llm.temperature');
    assert.ok(temp, 'temperature 字段要在描述里（绝对路径 llm.temperature）');
    assert.equal(temp?.widget, 'number');
    assert.equal(typeof temp?.default, 'number', '默认值要带上，面板「恢复默认」用');

    // 嵌套对象里的字段：绝对路径带全前缀，relPath 相对父对象
    const shareGroup = got.groups.find((group) => group.key === 'share');
    const comment = shareGroup?.fields.find((field) => field.path === 'share.comment');
    assert.ok(comment, 'share.comment 应该在描述里');
    assert.equal(comment?.fields?.find((field) => field.relPath === 'maxChars')?.path, 'share.comment.maxChars');

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

    // 回归：只有未知顶层键（就是面板路径写错时的产物）必须被拒绝，不能静默接受
    const junk = await fetch(`${base}/api/config`, { method: 'PUT', headers: write(csrf, auth), body: JSON.stringify({ enabled: true }) });
    assert.equal(junk.status, 422, '只含未知顶层字段的补丁要拒绝');
    const junkBody = (await junk.json()) as { message: string };
    assert.match(junkBody.message, /不在配置里|未知/);

    // 未知键与已知键混在一起时：已知的生效，未知的被丢掉并说明
    const mixed = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: write(csrf, auth),
      body: JSON.stringify({ share: { enabled: true }, enabled: true, _exportedAt: 'x' }),
    });
    assert.equal(mixed.status, 200);
    const mixedBody = (await mixed.json()) as { message: string };
    assert.match(mixedBody.message, /忽略了 1 个未知字段/);
    const savedAfter = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      share?: { enabled?: boolean };
      enabled?: unknown;
    };
    assert.equal(savedAfter.share?.enabled, true, '开关必须真的写进 share.enabled');
    assert.equal(savedAfter.enabled, undefined, '不能把值写到顶层垃圾字段');
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

/* ---------------- P0-2：通知测试 ---------------- */

test('通知测试：预演只写日志不真发；关写/关急停/没 CSRF 都拒绝（P0-2）', async () => {
  await withDaemon(
    async ({ base, auth, csrf, dir }) => {
      const paths = resolvePaths({ dataDir: dir });
      const notifyLog = (): string => {
        try {
          return fs.readFileSync(paths.notifyLog, 'utf8');
        } catch {
          return '';
        }
      };
      const chatFile = path.join(paths.chatDir, 'owner.jsonl');
      const testNotify = (body: unknown, headers = write(csrf, auth)) =>
        fetch(`${base}/api/notify/test`, { method: 'POST', headers, body: JSON.stringify(body) });

      assert.equal(notifyLog().includes('测试'), false, '一开始日志里不该有测试消息');

      // 1) 预演 + 私信渠道：只写日志，不真发（也不往聊天记录里塞一条假消息）
      const dry = await testNotify({ channel: 'dm' });
      assert.equal(dry.status, 200);
      const dryBody = (await dry.json()) as { ok: boolean; message: string; dryRun: boolean };
      assert.equal(dryBody.ok, true);
      assert.equal(dryBody.dryRun, true);
      assert.match(dryBody.message, /预演/);
      assert.match(dryBody.message, /没发私信/);
      assert.match(notifyLog(), /测试/, '预演也要留下证据（只写日志）');
      assert.equal(fs.existsSync(chatFile) ? fs.readFileSync(chatFile, 'utf8').includes('测试') : false, false, '预演不该写聊天记录');

      // 2) 本机日志渠道：写进去就算成功
      const file = await testNotify({ channel: 'file' });
      assert.equal(file.status, 200);
      assert.match(((await file.json()) as { message: string }).message, /本机日志/);

      // 3) 写操作要 CSRF
      const noCsrf = await fetch(`${base}/api/notify/test`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'dm' }),
      });
      assert.equal(noCsrf.status, 403);

      // 4) 关掉总写开关 → 人话原因，且不再偷偷写日志/发东西
      const before = notifyLog();
      const saved = await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: write(csrf, auth),
        body: JSON.stringify({ safety: { writeEnabled: false } }),
      });
      assert.equal(saved.status, 200);
      const denied = await testNotify({ channel: 'dm' });
      assert.equal(denied.status, 409);
      const deniedBody = (await denied.json()) as { ok: boolean; message: string };
      assert.equal(deniedBody.ok, false);
      assert.match(deniedBody.message, /写操作关着/);
      assert.equal(notifyLog(), before, '被拒绝时不许偷偷发/写');

      // 5) 急停 → 也不发
      await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: write(csrf, auth),
        body: JSON.stringify({ safety: { writeEnabled: true, killSwitch: true } }),
      });
      const killed = await testNotify({ channel: 'dm' });
      assert.equal(killed.status, 409);
      assert.match(((await killed.json()) as { message: string }).message, /急停/);
    },
    {
      safety: { dryRun: true },
      account: { ownerMid: 42 },
      notify: { channels: [{ type: 'dm', enabled: true }, { type: 'file', enabled: true }] },
    },
  );
});

/* ---------------- P0-3：发动态 / 删自己的评论 ---------------- */

test('发动态：开关关着拒绝、预演只出计划、没二次确认也拒绝（服务端再判一次）（P0-3）', async () => {
  await withDaemon(async ({ base, auth, csrf }) => {
    const post = (body: unknown) =>
      fetch(`${base}/api/dynamic`, { method: 'POST', headers: write(csrf, auth), body: JSON.stringify(body) });

    const off = await post({ text: '今天看了个好东西', confirm: true });
    assert.equal(off.status, 409);
    assert.match(((await off.json()) as { message: string }).message, /动态开关关着/);

    // 打开动态 + 一律预演：返回计划，不真的发
    const saved = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: write(csrf, auth),
      body: JSON.stringify({ dynamic: { enabled: true, requireConfirm: true, dailyCap: 1 }, safety: { dryRun: true } }),
    });
    assert.equal(saved.status, 200);

    const dry = await post({ text: '今天看了个好东西', confirm: true });
    assert.equal(dry.status, 200);
    const dryBody = (await dry.json()) as { ok: boolean; message: string; status: string };
    assert.equal(dryBody.ok, true);
    assert.equal(dryBody.status, 'dry_run', '预演下只能是 dry_run');
    assert.match(dryBody.message, /预演/);

    // 前端不传 confirm 时服务端也要拒（不能只靠前端）
    const noConfirm = await post({ text: '今天看了个好东西', confirm: false });
    assert.equal(noConfirm.status, 409);
    assert.match(((await noConfirm.json()) as { message: string }).message, /二次确认/);

    // 空文案：连计划都不给
    const empty = await post({ text: '   ', confirm: true });
    assert.equal(empty.status, 400);
  });
});

test('挑中的视频：从今天的报告里解析 bvid/标题/一句话/链接（P0-3 发动态入口的数据）', async () => {
  await withDaemon(async ({ base, auth, dir }) => {
    const paths = resolvePaths({ dataDir: dir });
    fs.mkdirSync(paths.reportsDir, { recursive: true });
    const date = localDate();
    fs.writeFileSync(
      path.join(paths.reportsDir, `${date}.md`),
      [
        '# 报告',
        '',
        '### 挑中的',
        '',
        '#### BV1pick00001 · 一条视频',
        '- 分数：15/20',
        '- 为什么值得：有信息量',
        '- 一句话：这条值得看',
        '',
        '#### BV1pick00002 · 另一条',
        '- 一句话：也挺好',
        '',
        '### 看过的（跳过）',
        '',
        '- BV1skip00001 · 跳过的那条 · 分数不够',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await fetch(`${base}/api/picked`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      date: string;
      items: Array<{ bvid: string; title: string; oneliner: string; url: string }>;
    };
    assert.equal(body.date, date);
    assert.equal(body.items.length, 2, '只算「挑中的」，跳过的不算');
    assert.equal(body.items[0]?.bvid, 'BV1pick00001');
    assert.equal(body.items[0]?.title, '一条视频');
    assert.equal(body.items[0]?.oneliner, '这条值得看');
    assert.match(body.items[0]?.url ?? '', /^https:\/\/www\.bilibili\.com\/video\/BV1pick00001$/);

    // 不存在的日期：空列表（面板显示「没有挑中的」，不是报错）
    const missing = await fetch(`${base}/api/picked?date=2000-01-01`, { headers: auth });
    assert.equal(missing.status, 200);
    assert.deepEqual(((await missing.json()) as { items: unknown[] }).items, []);

    // 日期格式不对：400
    assert.equal((await fetch(`${base}/api/picked?date=yesterday`, { headers: auth })).status, 400);
  });
});

test('删自己的评论：不在账本里就拒绝；在账本里且预演时只出计划（P0-3）', async () => {
  await withDaemon(async ({ base, auth, csrf, dir }) => {
    const del = (bvid: string, rpid: string) =>
      fetch(`${base}/api/comments/${bvid}/${rpid}`, { method: 'DELETE', headers: write(csrf, auth) });

    const missing = await del('BV1notours01', '123');
    assert.equal(missing.status, 409);
    assert.match(((await missing.json()) as { message: string }).message, /账本里没有这条评论/);

    // 账本里补一条我们发过的评论（type=comment 才算）
    const paths = resolvePaths({ dataDir: dir });
    fs.writeFileSync(
      paths.quota,
      JSON.stringify(
        {
          version: 1,
          shareDaily: 3,
          log: [
            {
              at: new Date().toISOString(),
              type: 'comment',
              bvid: 'BV1lead00001',
              aid: 9001,
              target: 'owner',
              rpid: '778899',
              share: true,
              status: 'sent',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    // /api/pending 会重读账本（面板上的「我们发过的评论」就是它），借它把磁盘上的新行读进内存
    await fetch(`${base}/api/pending`, { headers: auth });

    await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: write(csrf, auth),
      body: JSON.stringify({ safety: { dryRun: true } }),
    });

    const dry = await del('BV1lead00001', '778899');
    assert.equal(dry.status, 200);
    const dryBody = (await dry.json()) as { ok: boolean; message: string };
    assert.equal(dryBody.ok, true);
    assert.match(dryBody.message, /预演/, '预演下只出计划并在结果里标出来');
  });
});
