/**
 * 「假机器」安装演练（不需要虚拟机）。
 *
 * 做什么：把 dist 里的便携 zip 当成用户拿到的东西，在一个临时目录里走一遍
 *   解压 → 安装（-NoRegister，只复制文件）→ 用装好的那份跑一轮（夹具）→ 卸载 → 检查数据还在。
 * 全程只碰临时目录，不写注册表、不建快捷方式、不改环境变量、不发任何远端内容。
 *
 * 用法：node scripts/rehearse.mts [--keep]
 * 前提：npm run pack（没有 dist 时会提示）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readZipFile } from '../src/shared/zip.ts';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const keep = args.includes('--keep');
// 包名用 src/cli.ts 的 VERSION（和 pack.mts 一致，带 -M5 这类后缀）
const version = (/const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8'))?.[1] ?? '').trim();
if (!version) {
  process.stderr.write('读不到 src/cli.ts 里的 VERSION\\n');
  process.exit(1);
}
const zipFile = path.join(ROOT, 'dist', `BiliWhale-${version}-portable.zip`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const tmp = path.join(ROOT, 'test', '.tmp', `rehearse-${stamp}`);
// §6.3 的验收条件之一：「把整包解压到含空格和中文的路径」也要能装能跑。
// 所以这里**故意**用这种目录名；如果哪里少加了引号，这一步就会挂。
const workDir = path.join(tmp, '含空格 的 目录');
const portable = path.join(workDir, 'portable');
const installed = path.join(workDir, 'installed');
const dataDir = path.join(workDir, 'data');

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail });
};

function run(file: string, argv: string[], label: string): { ok: boolean; ms: number } {
  const started = Date.now();
  try {
    execFileSync(file, argv, { stdio: 'inherit', windowsHide: true });
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    process.stderr.write(`  [${label}] 失败：${String(err)}\n`);
    return { ok: false, ms: Date.now() - started };
  }
}

if (!fs.existsSync(zipFile)) {
  process.stderr.write(`没找到 ${zipFile}\n先跑：npm run pack\n`);
  process.exit(1);
}

fs.mkdirSync(portable, { recursive: true });

// 1) 解压（用我们自己的 zip 读取器，顺便验证用户拿到的包是好的）
const entries = readZipFile(zipFile);
const prefix = `BiliWhale-${version}/`;
let extracted = 0;
for (const entry of entries) {
  if (!entry.name.startsWith(prefix)) continue;
  const relative = entry.name.slice(prefix.length);
  const target = path.join(portable, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, entry.data);
  extracted += 1;
}
check('解压便携包', extracted > 100, `${extracted} 个文件，从 ${(fs.statSync(zipFile).size / 1024 / 1024).toFixed(1)} MB 的 zip`);
check('包里有 node.exe', fs.existsSync(path.join(portable, 'runtime', 'node.exe')));
check('包里有托盘 exe', fs.existsSync(path.join(portable, 'app', 'shell', 'BiliWhaleTray.exe')));
check('路径含空格与中文（§6.3）', workDir.includes(' ') && /[\u4e00-\u9fa5]/.test(workDir), workDir);

// 2) 安装（-NoRegister：只复制文件）
const installStarted = Date.now();
const install = run('powershell', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  path.join(portable, 'install.ps1'),
  '-NoRegister',
  '-Target',
  installed,
], 'install');
const installMs = Date.now() - installStarted;
check('安装（-NoRegister，不碰系统）', install.ok, `${installMs} ms`);
check('装好的目录里有启动器', fs.existsSync(path.join(installed, 'BiliWhale.cmd')));
check('装好的目录里有内核入口', fs.existsSync(path.join(installed, 'app', 'src', 'cli.ts')));
check('装好的目录里有 runtime', fs.existsSync(path.join(installed, 'runtime', 'node.exe')));

// 3) 用装好的那份跑一轮（夹具，独立数据目录）
const kernel = path.join(installed, 'runtime', 'node.exe');
const cli = path.join(installed, 'app', 'src', 'cli.ts');
const round = run(kernel, [cli, 'run', '--now', '--dry', '--fixtures', '--data-dir', dataDir], 'run');
check('装好的内核能跑一轮', round.ok, `${round.ms} ms`);

const reportsDir = path.join(dataDir, 'reports');
const reports = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).filter((name) => name.endsWith('.md')) : [];
check('跑完有报告', reports.length > 0, reports[0] ?? '');
check('数据目录结构完整', fs.existsSync(path.join(dataDir, 'config.json')) && fs.existsSync(path.join(dataDir, 'state.json')));

// 4) 卸载（-NoRegister：只删程序目录）
const uninstall = run('powershell', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  path.join(portable, 'uninstall.ps1'),
  '-NoRegister',
  '-Target',
  installed,
], 'uninstall');
check('卸载', uninstall.ok);
check('程序目录已删', !fs.existsSync(installed));
check('数据还在（卸载默认保留）', fs.existsSync(path.join(dataDir, 'config.json')) && reports.length > 0);

// 5) 总结
process.stdout.write('\n演练结果：\n');
let failed = 0;
for (const item of checks) {
  if (!item.ok) failed += 1;
  process.stdout.write(`  ${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `（${item.detail}）` : ''}\n`);
}
process.stdout.write(`\n安装+启动+卸载全流程：${((installMs + round.ms) / 1000).toFixed(1)} 秒（不含你手动解压/扫码）\n`);

if (keep) process.stdout.write(`演练目录留着：${tmp}\n`);
else fs.rmSync(tmp, { recursive: true, force: true });

if (failed > 0) {
  process.stderr.write(`\n有 ${failed} 项没通过\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\n全部通过：这台机器上下载的包能装、能跑、能卸，且数据不会被卸载删掉。\n');
}
