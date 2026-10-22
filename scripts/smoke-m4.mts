// M4 端到端冒烟：私聊状态/记录/手动发送 + 监听触发（夹具 + dryRun，零真实写操作）。
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/m4-dry';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string };
const base = `http://127.0.0.1:${rt.port}`;
const auth = { authorization: `Bearer ${rt.token}` };
const session = (await (await fetch(`${base}/api/session`, { headers: auth })).json()) as { csrfToken: string };
const write = { ...auth, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };

const dm = (await (await fetch(`${base}/api/dm`, { headers: auth })).json()) as Record<string, unknown>;
console.log('dm 状态    ', JSON.stringify({ enabled: dm.enabled, chat: dm.chat, receiver: dm.receiver, notifyEnabled: dm.notifyEnabled, maxPerHour: dm.maxPerHour }));

const chat = (await (await fetch(`${base}/api/dm/chat?limit=10`, { headers: auth })).json()) as { total: number };
console.log('聊天记录    ', chat.total, '条');

const send = await fetch(`${base}/api/dm/send`, { method: 'POST', headers: write, body: JSON.stringify({ text: '面板测试消息' }) });
console.log('手动发送    ', send.status, JSON.stringify(await send.json()));

const videoInfo = await fetch(`${base}/api/dm/send`, { method: 'POST', headers: write, body: JSON.stringify({ kind: 'video_info', bvid: 'BV1unknown1' }) });
console.log('陌生 BV     ', videoInfo.status, JSON.stringify(await videoInfo.json()));

const listen = await fetch(`${base}/api/listen/now`, { method: 'POST', headers: write });
const listenBody = (await listen.json()) as { result?: { comment?: { skipped?: string[] }; dm?: { handled: number }; skipped?: string[] } };
console.log('监听一次    ', listen.status, JSON.stringify(listenBody.result ?? listenBody).slice(0, 240));
