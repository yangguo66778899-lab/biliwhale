import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 把需求文档里的硬约束变成自动检查。
 * 这些断言故意写成「扫源码」，因为它们要防的正是「有人不小心把不该有的东西加回来」。
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const FIXTURES = path.join(ROOT, 'fixtures');

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function grep(files: string[], pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (pattern.test(text)) hits.push({ file: path.relative(ROOT, file), line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

const SOURCE_FILES = walk(SRC, ['.ts']);
const ALL_TEXT = walk(SRC, ['.ts', '.md']);

test('C1：不 import 任何 @deepseek-ai/*，也不引用 DSH 概念', () => {
  const hits = grep(SOURCE_FILES, /@deepseek-ai|from ['"]dsh|dshdesktop|sessionController/i);
  assert.deepEqual(hits, [], `源码里不该出现 DSH 依赖：${JSON.stringify(hits)}`);
});

test('零 Python：源码里不 spawn python / 不调用 pip / venv', () => {
  const hits = grep(ALL_TEXT, /\bpython(3)?\b|py -3|\bpip install\b|venv|whisper/i);
  assert.deepEqual(hits, [], `不该有任何 Python 依赖：${JSON.stringify(hits)}`);
});

test('子进程只允许出现在「开机自启」这一处，且必须带 windowsHide 与超时', () => {
  // 注意用 (?<!\.) 排除 RegExp#exec —— 那是正则方法，不是进程
  const pattern = /child_process|spawnSync\s*\(|(?<!\.)\bspawn\s*\(|execFile\s*\(|execSync\s*\(|(?<!\.)\bexec\s*\(/;
  const hits = grep(SOURCE_FILES, pattern);
  const allowedFile = path.join('lifecycle', 'autostart.ts');
  const disallowed = hits.filter((hit) => !hit.file.endsWith(allowedFile));
  assert.deepEqual(disallowed, [], `只有 autostart.ts 可以起子进程（reg.exe）：${JSON.stringify(disallowed)}`);

  const text = fs.readFileSync(path.join(SRC, 'lifecycle', 'autostart.ts'), 'utf8');
  assert.match(text, /windowsHide:\s*true/, '子进程必须隐藏窗口');
  assert.match(text, /timeout:\s*\d+/, '子进程必须带超时');
});

test('C3：源码与夹具里没有直播 / 弹幕相关字段或能力', () => {
  const hits = grep([...ALL_TEXT, ...walk(FIXTURES, ['.json', '.ts'])], /danmaku|直播间|liveRoom|live_info|\/xlive\//i);
  assert.deepEqual(hits, [], `C3 要求直播与弹幕为零：${JSON.stringify(hits)}`);
});

test('M3 写能力：只允许 comment/add 与 comment/del，且只许出现在 bili/write.ts', () => {
  // 允许的写接口（M3 只做评论；收藏/私信/动态/点赞在 M4，先一条都不许出现）
  const allowed = ['/x/v2/reply/add', '/x/v2/reply/del'];
  const forbidden = [
    '/x/v2/reply/action', // 点赞评论
    '/x/relation/modify', // 关注
    '/x/v3/fav/resource/deal', // 收藏
    '/x/dynamic/feed/create', // 动态
    '/x/web-interface/dynamic/publish',
    '/msg/send/msg', // 私信
    '/x/click-interface/web/heartbeat', // 投币
    '/x/web-interface/coin/add',
  ];
  const escape = (value: string): string => value.replace(/[/.]/g, '\\$&');

  const forbiddenHits = grep(SOURCE_FILES, new RegExp(forbidden.map(escape).join('|')));
  assert.deepEqual(forbiddenHits, [], `M3 不该有这些写接口（M4 再说）：${JSON.stringify(forbiddenHits)}`);

  const allowedHits = grep(SOURCE_FILES, new RegExp(allowed.map(escape).join('|')));
  assert.ok(allowedHits.length > 0, 'M3 应该已经有评论写接口');
  const wrongFile = allowedHits.filter((hit) => !hit.file.endsWith(`bili${path.sep}write.ts`));
  assert.deepEqual(wrongFile, [], `写接口只许出现在 bili/write.ts（闸门与幂等都在编排器里）：${JSON.stringify(wrongFile)}`);

  // 写请求必须是 POST，且必须带 csrf 与签名（否则 B 站会 403 / 被风控）
  const writerText = fs.readFileSync(path.join(SRC, 'bili', 'write.ts'), 'utf8');
  assert.match(writerText, /method:\s*'POST'/);
  assert.match(writerText, /csrf/);
  assert.match(writerText, /sign:\s*true/);

  // 写层必须能被 dry-run：plan 与实际发送分开
  assert.match(writerText, /dryRun/);
});

test('M3 写调用必须经过闸门：发评论只许在分享/审批，删评论只许在手动', () => {
  const hits = grep(SOURCE_FILES, /\.postComment\(|\.deleteComment\(/);
  const allowedFiles = ['share.ts', 'pending.ts', 'manual.ts'];
  const wrong = hits.filter((hit) => !allowedFiles.includes(path.basename(hit.file)));
  assert.deepEqual(wrong, [], `只有分享/审批/手动执行器能真的写：${JSON.stringify(wrong)}`);

  const commentWrites = grep(SOURCE_FILES, /\.postComment\(/);
  const wrongComment = commentWrites.filter((hit) => !['share.ts', 'pending.ts'].includes(path.basename(hit.file)));
  assert.deepEqual(wrongComment, [], `发评论只许在分享与审批里：${JSON.stringify(wrongComment)}`);

  // 分享执行器里必须同时出现闸门与幂等（防止有人绕过）
  const shareText = fs.readFileSync(path.join(SRC, 'orchestrator', 'share.ts'), 'utf8');
  assert.match(shareText, /gateShare\(/, '分享执行器必须先过闸门');
  assert.match(shareText, /hasSentContent\(/, '分享执行器必须查幂等账本');
  assert.match(shareText, /unverified/, '复核失败要标 unverified');

  // 审批执行器必须检查写入开关与风控冷却（不能绕安全开关）
  const pendingText = fs.readFileSync(path.join(SRC, 'orchestrator', 'pending.ts'), 'utf8');
  assert.match(pendingText, /writeEnabled/, '审批发送前要看总写开关');
  assert.match(pendingText, /inRiskCooldown/, '审批发送前要看风控冷却');
});

test('零运行时依赖：package.json 只有 typescript 与 @types/node', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'M0 不允许引入运行时依赖');
  const dev = Object.keys(pkg.devDependencies ?? {}).sort();
  assert.deepEqual(dev, ['@types/node', 'typescript'], `开发依赖应只有类型与编译器，实际：${dev.join(',')}`);
});

test('凭据与密钥不会出现在源码常量里', () => {
  const hits = grep(ALL_TEXT, /SESSDATA\s*=\s*[A-Za-z0-9%]{10,}|sk-[A-Za-z0-9]{20,}/);
  assert.deepEqual(hits, [], `源码里不该有真凭据：${JSON.stringify(hits)}`);
});

test('没有不可擦除的 TS 语法（参数属性会让 node 直接跑不起来）', () => {
  // Node 的 strip-only 模式不支持 constructor(private x)。tsc 不报错，运行才炸 —— 所以在这里拦。
  const paramProps = grep(SOURCE_FILES, /constructor\s*\([^)]*\b(?:private|public|protected)\s+(?:readonly\s+)?\w+\s*:/s);
  assert.deepEqual(paramProps, [], `不要在构造函数参数里写 private/public（改成显式字段）：${JSON.stringify(paramProps)}`);

  const enums = grep(SOURCE_FILES, /^\s*(?:export\s+)?(?:const\s+)?enum\s+\w+/m);
  assert.deepEqual(enums, [], `不要用 enum（用联合类型 + as const）：${JSON.stringify(enums)}`);
});

test('每个 src 模块都能被 Node 真的加载（入口除外）', async () => {
  // 入口（cli.ts）有副作用会真的跑起来，跳过；其它模块都必须是可加载的纯模块。
  const modules = SOURCE_FILES.filter((file) => !file.endsWith('cli.ts'));
  const failures: string[] = [];
  for (const file of modules) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      failures.push(`${path.relative(ROOT, file)}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  assert.deepEqual(failures, [], `有模块加载失败：\n${failures.join('\n')}`);
});

test('必需的文件都在（运行说明、许可证、归属、架构、接口规格、托盘）', () => {
  for (const file of [
    'README.md',
    'LICENSE',
    'NOTICE',
    'CHANGELOG.md',
    'docs/ARCHITECTURE.md',
    'docs/bili-readonly-api-spec.md',
    'shell/BiliWhaleTray.cs',
    'scripts/build-tray.ps1',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `缺少 ${file}`);
  }
});

test('编码约定：.ps1 必须有 BOM（PowerShell 5.1 靠它认 UTF-8），.json 必须没有 BOM', () => {
  const ps1 = walk(ROOT, ['.ps1']).filter((file) => !file.includes('node_modules'));
  for (const file of ps1) {
    const head = fs.readFileSync(file).subarray(0, 3);
    assert.deepEqual([...head], [0xef, 0xbb, 0xbf], `${path.relative(ROOT, file)} 缺 UTF-8 BOM，PowerShell 5.1 会把中文读成乱码`);
  }

  const json = walk(ROOT, ['.json']).filter((file) => !file.includes('node_modules') && !file.includes('.npm-cache'));
  for (const file of json) {
    const head = fs.readFileSync(file).subarray(0, 3);
    assert.notDeepEqual([...head], [0xef, 0xbb, 0xbf], `${path.relative(ROOT, file)} 带 BOM，JSON.parse 会失败`);
  }
});

test('托盘源码里没有 B 站写接口，也没有直播/弹幕', () => {
  const trayFile = path.join(ROOT, 'shell', 'BiliWhaleTray.cs');
  const text = fs.readFileSync(trayFile, 'utf8');
  for (const needle of ['bilibili.com', '/x/v2/reply/add', 'send_msg', 'danmaku', '直播间', '直播']) {
    assert.equal(text.includes(needle), false, `托盘不该出现「${needle}」：它只和本地内核说话`);
  }
  // 只允许访问本机控制接口
  assert.match(text, /127\.0\.0\.1/);
});

test('面板（M2）：静态资源在仓库里、离线可用、不引外链、不带内联脚本', () => {
  const uiDir = path.join(SRC, 'ui');
  for (const file of ['index.html', 'app.js', 'style.css']) {
    assert.ok(fs.existsSync(path.join(uiDir, file)), `缺少 src/ui/${file}`);
  }

  const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  // CSP 是 script-src 'self'：内联脚本会被浏览器直接拦掉，所以这里不许有
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'index.html 里不能有内联 <script>');
  assert.match(html, /<script src="\/app\.js">/);

  for (const file of ['index.html', 'app.js', 'style.css']) {
    const text = fs.readFileSync(path.join(uiDir, file), 'utf8');
    // 只允许 SVG 命名空间这一个「外部」URL；CDN / 字体 / 图片外链一律不许
    const external = (text.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).filter((url) => !url.startsWith('http://www.w3.org/'));
    assert.deepEqual(external, [], `${file} 里不该引用外部地址：${external.join(', ')}`);
  }

  // 面板不该自己拼 B 站地址：它只和本机内核说话
  for (const file of ['index.html', 'app.js']) {
    const text = fs.readFileSync(path.join(uiDir, file), 'utf8');
    assert.equal(text.includes('bilibili.com'), false, `${file} 不该直接访问 B 站`);
  }
});

test('QR 编码器不引入任何第三方依赖（自己实现，外部参照对拍过）', () => {
  const text = fs.readFileSync(path.join(SRC, 'qr', 'encoder.ts'), 'utf8');
  assert.equal(/from '[^.]/.test(text), false, 'src/qr 只允许相对导入');
  assert.equal(text.includes('node_modules'), false);
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'fixtures', 'qr-cases.json')), '缺 QR 参照夹具');
});
