// 验证「面板里填 DeepSeek key」的接口行为（用假 key，不会真的花钱）。
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/key-live';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };
const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
const write = { ...auth, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };

const before = await (await fetch(`${base}/api/secrets`, { headers: auth })).json();
console.log('1) 初始状态        ', JSON.stringify(before));

const bad = await fetch(`${base}/api/secrets/llm`, { method: 'PUT', headers: write, body: JSON.stringify({ apiKey: 'abc' }) });
console.log('2) 格式不对        ', bad.status, JSON.stringify(await bad.json()));

const fake = await fetch(`${base}/api/secrets/llm`, {
  method: 'PUT',
  headers: write,
  body: JSON.stringify({ apiKey: 'sk-fake0123456789abcdef' }),
});
const fakeBody = (await fake.json()) as { ok?: boolean; message?: string };
console.log('3) 格式对但无效    ', fake.status, fakeBody.message);

const after = await (await fetch(`${base}/api/secrets`, { headers: auth })).json();
console.log('4) 之后的状态      ', JSON.stringify(after), '（无效 key 不该被保存）');

const saved = fs.existsSync(`${dir}/secrets.json`) ? JSON.parse(fs.readFileSync(`${dir}/secrets.json`, 'utf8')) : null;
console.log('5) secrets.json    ', saved?.llm?.apiKey ? '存了 key（不该发生）' : '没存 key（正确）');
