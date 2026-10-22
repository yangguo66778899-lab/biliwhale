// 用 Node 发 PUT（避免 PowerShell 把 JSON 弄坏），验证「打开监听 → listen/now 真的去读」。
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/m4-dry';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };
const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
const headers = { ...auth, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };

const patch = await fetch(`${base}/api/config`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ listen: { comment: { enabled: true }, dm: { enabled: true } } }),
});
console.log('PUT config  ', patch.status, JSON.stringify(await patch.json()).slice(0, 160));

await new Promise((resolve) => setTimeout(resolve, 1200)); // 等 hot reload（500ms debounce）

const dm = (await (await fetch(`${base}/api/dm`, { headers: auth })).json()) as { enabled: boolean };
console.log('dm.enabled  ', dm.enabled);

const listen = await fetch(`${base}/api/listen/now`, { method: 'POST', headers });
const body = (await listen.json()) as { result?: unknown };
console.log('listen/now  ', listen.status, JSON.stringify(body.result).slice(0, 300));

const cfg = JSON.parse(fs.readFileSync(`${dir}/config.json`, 'utf8')) as { listen?: { dm?: { enabled?: boolean } } };
console.log('config 落盘  ', JSON.stringify(cfg.listen?.dm ?? null));
