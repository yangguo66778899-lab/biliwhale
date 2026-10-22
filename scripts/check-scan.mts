// 检查「待审」扫描在真实接口下的行为与诊断信息（没有我们的评论时应该给出明确原因）。
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/scan-live';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };
const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
const write = { ...auth, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };

const pending = (await (await fetch(`${base}/api/pending`, { headers: auth })).json()) as {
  count: number;
  recent: Array<{ bvid: string; rpid: string; status: string }>;
};
console.log('1) 待审列表：count =', pending.count, '| 账本里的评论', pending.recent.length, '条');

const scan = (await (await fetch(`${base}/api/pending/scan`, { method: 'POST', headers: write })).json()) as {
  considered: number;
  scanned: number;
  created: unknown[];
  skipped: string[];
  details: unknown[];
};
console.log('2) 扫描：considered =', scan.considered, 'scanned =', scan.scanned, 'created =', scan.created.length);
console.log('   skipped:', scan.skipped);
console.log('   details:', scan.details);
