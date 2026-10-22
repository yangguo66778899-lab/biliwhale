// 面板冒烟：账号页/概览/私聊在「主人未配置」时的表现（夹具 + dryRun，零真实写操作）。
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/panel-owner';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };
const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
const headers = { ...auth, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };

const account = (await (await fetch(`${base}/api/account`, { headers: auth })).json()) as Record<string, unknown>;
console.log('account.login :', JSON.stringify({ loggedIn: account.loggedIn, name: account.name, mid: account.mid }));
console.log('account.owner :', JSON.stringify(account.owner));

const status = (await (await fetch(`${base}/api/status`, { headers: auth })).json()) as { setup?: { ready: boolean; missing: Array<{ label: string }> } };
console.log('setup.ready   :', status.setup?.ready, '缺:', (status.setup?.missing ?? []).map((m) => m.label).join('、'));

const dm = (await (await fetch(`${base}/api/dm`, { headers: auth })).json()) as Record<string, unknown>;
console.log('dm.owner      :', JSON.stringify({ ownerMid: dm.ownerMid, ownerOk: dm.ownerOk, ownerProblem: dm.ownerProblem }));

const selfLookup = await fetch(`${base}/api/account/owner`, { method: 'POST', headers, body: JSON.stringify({ mid: 4242 }) });
console.log('按 UID 取昵称（填成登录账号）:', selfLookup.status, JSON.stringify(await selfLookup.json()));

const send = await fetch(`${base}/api/dm/send`, { method: 'POST', headers, body: JSON.stringify({ text: '面板测试' }) });
console.log('发私信（主人未配）:', send.status, JSON.stringify(await send.json()));
