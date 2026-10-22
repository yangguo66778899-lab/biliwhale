// 模拟浏览器的真实加载顺序，验证面板能真的跑起来（不需要真的浏览器）。
// 用法：node scripts/check-panel.mts [dataDir]
import fs from 'node:fs';

const dir = process.argv[2] ?? 'test/.tmp/panel-fix';
const rt = JSON.parse(fs.readFileSync(`${dir}/local/runtime.json`, 'utf8')) as { port: number; token: string; url: string };
const base = `http://127.0.0.1:${rt.port}`;

function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] ?? '';
}

// 1) 打开面板（地址里带 token，就像托盘/命令行给的那条）
const page = await fetch(`${base}/?token=${rt.token}`);
const html = await page.text();
const cookie = cookieOf(page);
console.log(`1) GET /?token=…        ${page.status}  cookie=${cookie ? cookie.slice(0, 18) + '…' : '（无）'}  html=${html.length}B`);
console.log(`   html 里有反引号字面量？ ${html.includes('`') ? '有（BUG）' : '没有'}`);
console.log(`   标签栏：${(html.match(/data-tab="([a-z]+)"/g) ?? []).map((m) => m.slice(10, -1)).join(' / ')}`);

// 2) 浏览器随后请求子资源（只带 cookie，不带 token）
for (const file of ['/app.js', '/style.css']) {
  const res = await fetch(`${base}${file}`, { headers: { cookie } });
  const body = await res.text();
  console.log(`2) GET ${file.padEnd(11)} ${res.status}  ${res.headers.get('content-type')}  ${body.length}B`);
}

// 3) 刷新页面：地址栏已没有 token，只有 cookie
const refreshed = await fetch(`${base}/`, { headers: { cookie } });
console.log(`3) 刷新 GET /（仅 cookie） ${refreshed.status}`);

// 4) 首屏数据接口（页面 boot 时第一个调用）
const session = await fetch(`${base}/api/session`, { headers: { cookie } });
const sessionBody = (await session.json()) as { csrfToken?: string; version?: string };
console.log(`4) GET /api/session      ${session.status}  version=${sessionBody.version}  csrf=${sessionBody.csrfToken ? '有' : '无'}`);

const status = await fetch(`${base}/api/status`, { headers: { cookie } });
const statusBody = (await status.json()) as { ok?: boolean; scheduler?: { plan?: string } };
console.log(`5) GET /api/status       ${status.status}  ok=${statusBody.ok}  plan=${statusBody.scheduler?.plan ?? ''}`);

// 6) 无凭据：页面给说明、接口给 401
const naked = await fetch(`${base}/`);
console.log(`6) GET /（无凭据）        ${naked.status}  ${naked.headers.get('content-type')}`);
const nakedApi = await fetch(`${base}/api/status`);
console.log(`   GET /api/status（无凭据） ${nakedApi.status}`);
