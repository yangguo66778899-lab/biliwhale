// 真接口下检查「账号」页的数据与扫码流程（不涉及登录凭据，只调用公开的 passport 接口）。
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/login-live';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };
const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
const write = { ...auth, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };

const account = await fetch(`${base}/api/account`, { headers: auth });
console.log('GET /api/account   ', account.status, JSON.stringify(await account.json()));

const qr = await fetch(`${base}/api/account/qr`, { method: 'POST', headers: write });
const body = (await qr.json()) as { ok?: boolean; url?: string; rows?: string[]; size?: number; message?: string; key?: string };
console.log('POST /api/account/qr', qr.status, 'ok=', body.ok, 'size=', body.size, 'rows=', Array.isArray(body.rows) ? body.rows.length : 0);
console.log('  url =', body.url ? body.url.slice(0, 72) + '…' : '(无)');
console.log('  message =', body.message ?? '(无)');

if (body.key) {
  const poll = await fetch(`${base}/api/account/qr/poll?key=${encodeURIComponent(body.key)}`, { headers: auth });
  console.log('GET  qr/poll        ', poll.status, JSON.stringify(await poll.json()));
}
