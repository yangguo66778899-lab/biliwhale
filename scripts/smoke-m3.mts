// M3 端到端冒烟：面板待审接口 + 状态里的待审数（不产生任何真实写操作）。
//
// 用法：
//   node src/cli.ts serve --fixtures --data-dir test/.tmp/m3-dry --port 8940 &
//   node scripts/smoke-m3.mts test/.tmp/m3-dry
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/m3-dry';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };
const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
const write = { ...auth, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };

const status = (await (await fetch(`${base}/api/status`, { headers: auth })).json()) as {
  ok: boolean;
  pending: { count: number };
  today: { shares: number };
  warnings: string[];
};
console.log('status.pending =', JSON.stringify(status.pending), '| today.shares =', status.today.shares);
console.log('warnings      =', JSON.stringify(status.warnings));

const pending = (await (await fetch(`${base}/api/pending`, { headers: auth })).json()) as {
  ok: boolean;
  count: number;
  items: unknown[];
  history: unknown[];
};
console.log('pending       =', pending.ok, 'count', pending.count, 'history', pending.history.length);

const scan = (await (await fetch(`${base}/api/pending/scan`, { method: 'POST', headers: write })).json()) as {
  ok: boolean;
  scanned: number;
  created: unknown[];
  skipped: string[];
};
console.log('scan          =', scan.ok, 'scanned', scan.scanned, 'created', scan.created.length, 'skipped', JSON.stringify(scan.skipped));

const approveMissing = await fetch(`${base}/api/pending/nope/approve`, { method: 'POST', headers: write, body: '{}' });
console.log('approve(miss) =', approveMissing.status, (await approveMissing.json()) as unknown);
