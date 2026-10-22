// 面板端到端冒烟：把 UI 会走的接口按顺序打一遍，确认都能用。
//
// 用法：
//   node src/cli.ts serve --fixtures --data-dir test/.tmp/panel-live --port 8920 &
//   node scripts/smoke-panel.mts test/.tmp/panel-live
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/panel-live';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

const session = await call('/api/session');
const csrf = (session.body as { csrfToken: string }).csrfToken;
const w = { 'content-type': 'application/json', 'x-csrf-token': csrf };
console.log('session      ', session.status, 'csrf', csrf.length, 'bytes');

const page = await call('/');
console.log('GET /        ', page.status, page.text.length, 'bytes, 含 BiliWhale:', page.text.includes('BiliWhale'));
const js = await call('/app.js');
console.log('GET /app.js  ', js.status, js.text.length, 'bytes');
const css = await call('/style.css');
console.log('GET /style   ', css.status, css.text.length, 'bytes');

const config = await call('/api/config');
const groups = (config.body as { groups: Array<{ key: string; fields: unknown[] }> }).groups;
console.log('GET /config  ', config.status, '分组', groups.length, '字段', groups.reduce((n, g) => n + g.fields.length, 0));

const invalid = await call('/api/config', { method: 'PUT', headers: w, body: JSON.stringify({ llm: { temperature: 42 } }) });
console.log('PUT 非法     ', invalid.status, (invalid.body as { issues: unknown[] }).issues.length, '条问题');

const valid = await call('/api/config', { method: 'PUT', headers: w, body: JSON.stringify({ report: { level: 'brief' } }) });
console.log('PUT 合法     ', valid.status, (valid.body as { message: string }).message);

const exported = await call('/api/config/export');
console.log('导出         ', exported.status, '含密钥:', exported.text.includes('apiKey'));

const doctor = await call('/api/doctor');
const rows = (doctor.body as { report: { rows: Array<{ name: string; level: string; detail: string }> } }).report.rows;
console.log('体检         ', doctor.status, `健康=${(doctor.body as { report: { healthy: boolean } }).report.healthy}`, '行', rows.length);
for (const row of rows) console.log('   ', row.level === 'ok' ? '✓' : row.level === 'warn' ? '!' : '✗', row.name, '-', row.detail);

const diag = await call('/api/diag');
const bundle = JSON.parse(diag.text) as { version: string; files: unknown; notes: string[] };
console.log('诊断包       ', diag.status, diag.text.length, 'bytes, version', bundle.version);

const verify = await call('/api/account/verify', { method: 'POST', headers: w });
console.log('账号复核     ', verify.status, (verify.body as { message: string }).message);

const account = await call('/api/account');
console.log('GET /account ', account.status, 'loggedIn=', (account.body as { loggedIn: boolean }).loggedIn);

const qr = await call('/api/account/qr', { method: 'POST', headers: w });
console.log('扫码（夹具）  ', qr.status, (qr.body as { message?: string }).message ?? '(成功)');

const reports = await call('/api/reports');
console.log('报告列表     ', reports.status, '条数', (reports.body as { items: unknown[] }).items.length);
const diaries = await call('/api/diaries?kind=private');
console.log('日记列表     ', diaries.status, '条数', (diaries.body as { items: unknown[] }).items.length);

const status = await call('/api/status');
const s = status.body as { scheduler: { plan: string }; today: { wakes: number } };
console.log('GET /status  ', status.status, '|', s.scheduler.plan);
