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

test('子进程只允许出现在三处白名单里，且必须带 windowsHide 与超时', () => {
  // 注意用 (?<!\.) 排除 RegExp#exec —— 那是正则方法，不是进程
  const pattern = /child_process|spawnSync\s*\(|(?<!\.)\bspawn\s*\(|execFile\s*\(|execSync\s*\(|(?<!\.)\bexec\s*\(/;
  const hits = grep(SOURCE_FILES, pattern);
  // 允许三处：autostart.ts（reg.exe）、notify/index.ts（command 渠道，§7.11 要求）、
  // media/frames.ts（ffmpeg 抽帧，§7.10 要求；文件名与参数都由代码拼，不接受外部输入）
  const allowedFiles = [
    path.join('lifecycle', 'autostart.ts'),
    path.join('notify', 'index.ts'),
    path.join('media', 'frames.ts'),
  ];
  const disallowed = hits.filter((hit) => !allowedFiles.some((allowedFile) => hit.file.endsWith(allowedFile)));
  assert.deepEqual(disallowed, [], `只有白名单里的三个文件可以起子进程：${JSON.stringify(disallowed)}`);

  const text = fs.readFileSync(path.join(SRC, 'lifecycle', 'autostart.ts'), 'utf8');
  assert.match(text, /windowsHide:\s*true/, '子进程必须隐藏窗口');
  assert.match(text, /timeout:\s*\d+/, '子进程必须带超时');

  // ffmpeg 同样要隐藏窗口 + 超时（超时按视频时长算，所以是变量而不是字面量）
  const framesText = fs.readFileSync(path.join(SRC, 'media', 'frames.ts'), 'utf8');
  assert.match(framesText, /windowsHide:\s*true/, 'ffmpeg 也必须隐藏窗口（不许弹黑框）');
  assert.match(framesText, /timeout:\s*timeoutMs/, 'ffmpeg 必须带超时（120s + 时长 × 1.5）');
});

test('C3：源码与夹具里没有直播 / 弹幕相关字段或能力', () => {
  const hits = grep([...ALL_TEXT, ...walk(FIXTURES, ['.json', '.ts'])], /danmaku|直播间|liveRoom|live_info|\/xlive\//i);
  assert.deepEqual(hits, [], `C3 要求直播与弹幕为零：${JSON.stringify(hits)}`);
});

test('写能力白名单：只有评论/收藏/点赞/私信/动态，且只许出现在 bili/write.ts', () => {
  // M4 之后允许的写接口（收藏、点赞、私信、动态）
  const allowed = [
    '/x/v2/reply/add',
    '/x/v2/reply/del',
    '/x/v3/fav/resource/deal',
    '/x/web-interface/archive/like',
    'web_im/send_msg',
    '/x/dynamic/feed/create/dyn',
  ];
  const forbidden = [
    '/x/v2/reply/action', // 点赞评论
    '/x/relation/modify', // 关注
    '/msg/send/msg', // 旧版私信群发接口（不用它）
    '/x/click-interface/web/heartbeat', // 投币
    '/x/web-interface/coin/add', // 投币
    '/x/v3/fav/folder/create', // 建收藏夹（不需要）
    '/xlive/', // 直播：整体不做
  ];
  const escape = (value: string): string => value.replace(/[/.]/g, '\\$&');

  const forbiddenHits = grep(SOURCE_FILES, new RegExp(forbidden.map(escape).join('|')));
  assert.deepEqual(forbiddenHits, [], `不该有这些写接口（投币/关注/直播/建收藏夹）：${JSON.stringify(forbiddenHits)}`);

  const allowedHits = grep(SOURCE_FILES, new RegExp(allowed.map(escape).join('|')));
  assert.ok(allowedHits.length > 0, '应该已经有写接口');
  const wrongFile = allowedHits.filter((hit) => !hit.file.endsWith(`bili${path.sep}write.ts`));
  assert.deepEqual(wrongFile, [], `写接口只许出现在 bili/write.ts（闸门与幂等都在编排器里）：${JSON.stringify(wrongFile)}`);

  // 写请求必须是 POST，且必须带 csrf（否则 B 站会 403 / 被风控）
  const writerText = fs.readFileSync(path.join(SRC, 'bili', 'write.ts'), 'utf8');
  assert.match(writerText, /method:\s*'POST'/);
  assert.match(writerText, /csrf/);
  assert.match(writerText, /sign:\s*[^,\n]*true/, '写请求默认要签名（私信/动态那两个接口除外，单独传 sign:false）');

  // 写层必须能被 dry-run：plan 与实际发送分开
  assert.match(writerText, /dryRun/);
});

test('写调用分散到各自的执行器：评论/收藏/点赞/私信/动态各归各家', () => {
  const commentWrites = grep(SOURCE_FILES, /\.postComment\(/);
  const wrongComment = commentWrites.filter((hit) => !['share.ts', 'pending.ts'].includes(path.basename(hit.file)));
  assert.deepEqual(wrongComment, [], `发评论只许在分享与审批里：${JSON.stringify(wrongComment)}`);

  const deleteWrites = grep(SOURCE_FILES, /\.deleteComment\(/);
  assert.deepEqual(
    deleteWrites.filter((hit) => path.basename(hit.file) !== 'manual.ts'),
    [],
    '删评论只许在手动执行器里',
  );

  const favWrites = grep(SOURCE_FILES, /\.favVideo\(/);
  assert.deepEqual(favWrites.filter((hit) => path.basename(hit.file) !== 'fav.ts'), [], '收藏只许在 fav.ts');

  const likeWrites = grep(SOURCE_FILES, /\.likeVideo\(/);
  assert.deepEqual(likeWrites.filter((hit) => path.basename(hit.file) !== 'like.ts'), [], '点赞只许在 like.ts');

  const dmWrites = grep(SOURCE_FILES, /\.sendDm\(/);
  assert.deepEqual(
    dmWrites.filter((hit) => !['dm.ts', 'chat.ts', 'manual.ts', 'share.ts'].includes(path.basename(hit.file))),
    [],
    '发私信只许在 dm.ts（发送/通知）、chat.ts（聊天回复）、manual.ts（面板手动）、share.ts（私信分享，且必须先过闸门）',
  );

  const dynamicWrites = grep(SOURCE_FILES, /\.postDynamic\(/);
  assert.deepEqual(dynamicWrites.filter((hit) => path.basename(hit.file) !== 'like.ts'), [], '发动态只许在 like.ts（手动 + 二次确认）');

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
  // dist/ 是打包产物、test/.tmp 是演练产物，都不属于源码约定
  const relOf = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
  const generated = (file: string): boolean => {
    const rel = relOf(file);
    return rel.startsWith('dist/') || rel.startsWith('node_modules/') || rel.startsWith('test/.tmp/') || rel.startsWith('.npm-cache/');
  };
  const ps1 = walk(ROOT, ['.ps1']).filter((file) => !generated(file));
  for (const file of ps1) {
    const head = fs.readFileSync(file).subarray(0, 3);
    assert.deepEqual([...head], [0xef, 0xbb, 0xbf], `${path.relative(ROOT, file)} 缺 UTF-8 BOM，PowerShell 5.1 会把中文读成乱码`);
  }

  const json = walk(ROOT, ['.json']).filter((file) => !generated(file));
  for (const file of json) {
    const head = fs.readFileSync(file).subarray(0, 3);
    assert.notDeepEqual([...head], [0xef, 0xbb, 0xbf], `${path.relative(ROOT, file)} 带 BOM，JSON.parse 会失败`);
  }
});

test('.cmd 必须纯 ASCII：cmd.exe 按系统 ANSI 代码页解析，UTF-8 中文会把命令拆断', () => {
  // 真实事故（2026-10-22）：packaging/BiliWhale.cmd 用 UTF-8 存了中文注释/提示，
  // 双击时 cmd.exe 把 `start` 解析成 `rt`，窗口闪一下就没了，托盘也没起来。
  // 修法：.cmd 只做 ASCII 转发，中文与逻辑放进 .ps1（UTF-8 BOM）。
  const relOf = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
  const cmdFiles = walk(ROOT, ['.cmd']).filter((file) => {
    const rel = relOf(file);
    return !rel.startsWith('dist/') && !rel.startsWith('node_modules/') && !rel.startsWith('test/.tmp/');
  });
  assert.ok(cmdFiles.length >= 3, `应该有至少 3 个 .cmd（启动/安装/卸载），实际 ${cmdFiles.length}`);
  for (const file of cmdFiles) {
    const bytes = fs.readFileSync(file);
    const nonAscii = [...bytes].filter((byte) => byte > 127).length;
    assert.equal(nonAscii, 0, `${relOf(file)} 里有 ${nonAscii} 个非 ASCII 字节：cmd.exe 会按 ANSI 解析它，中文会把命令拆断（见 P2 事故）`);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${relOf(file)} 带 BOM：cmd.exe 会把 BOM 当成命令的一部分`);
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

test('预演模式只有一个来源：round 与定时触发里不许写死 dryRun: true', () => {
  // 真机反馈：打开了分享开关、关掉了「一律预演」，报告却仍写「（预演，未真的发）」，
  // 模型也被提示成「只读预演」。根因是 round.ts 里三处写死的 dryRun: true（M0 遗留），
  // 以及 runner.ts 定时触发恒传 true。这里按文件禁掉这种写法。
  const forbidden = [
    path.join(SRC, 'orchestrator', 'round.ts'),
    path.join(SRC, 'daemon', 'runner.ts'),
  ];
  for (const file of forbidden) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const hits = lines
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter((item) => /dryRun:\s*true\b/.test(item.text) && !item.text.startsWith('//') && !item.text.startsWith('*'));
    assert.deepEqual(hits, [], `${path.relative(ROOT, file)} 里不许写死 dryRun: true（用 effectiveDryRun / 配置值）：${JSON.stringify(hits)}`);
  }

  // 真跑/预演两条路径都要有测试钉住（share-mode.test.ts）
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'share-mode.test.ts')), '缺「真跑 vs 预演」的回归测试');
});
test('QR 编码器不引入任何第三方依赖（自己实现，外部参照对拍过）', () => {
  const text = fs.readFileSync(path.join(SRC, 'qr', 'encoder.ts'), 'utf8');
  assert.equal(/from '[^.]/.test(text), false, 'src/qr 只允许相对导入');
  assert.equal(text.includes('node_modules'), false);
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'fixtures', 'qr-cases.json')), '缺 QR 参照夹具');
});
