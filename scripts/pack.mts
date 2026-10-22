/**
 * 打包脚本：生成便携目录 + 便携 zip。
 *
 * 用法：node scripts/pack.mts [--out <dir>] [--no-zip] [--build-tray]
 *
 * 产物（默认 dist/）：
 *   dist/BiliWhale-<version>/            便携目录（可直接运行）
 *   dist/BiliWhale-<version>-portable.zip
 *
 * 说明：
 *   - 随包带 Node（runtime/node.exe），用户不需要自己装 Node（§7.14 允许这种做法）；
 *   - 托盘 exe 由 scripts/build-tray.ps1 生成，没生成就提示（--build-tray 会顺手编译）；
 *   - 不打 test/、node_modules/、dist/、data/、.run/、.git/。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPackPlan, listFiles } from '../src/pack/plan.ts';
import { writeZipFile } from '../src/shared/zip.ts';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const noZip = args.includes('--no-zip');
const buildTray = args.includes('--build-tray');
const outDir = argValue('--out') ?? path.join(ROOT, 'dist');

function argValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`打包失败：${message}\n`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
const cliVersion = (() => {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');
  const match = /const VERSION = '([^']+)'/.exec(text);
  return match?.[1] ?? '';
})();
if (!cliVersion) fail('读不到 src/cli.ts 里的 VERSION');
if (!cliVersion.startsWith(pkg.version)) {
  fail(`版本不一致：package.json=${pkg.version}，src/cli.ts=${cliVersion}（先统一再打包）`);
}

// 托盘 exe
const trayExe = path.join(ROOT, 'shell', 'BiliWhaleTray.exe');
if (!fs.existsSync(trayExe) && buildTray) {
  process.stdout.write('先编译托盘…\n');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'build-tray.ps1')], {
    stdio: 'inherit',
  });
}
if (!fs.existsSync(trayExe)) fail('没找到 shell/BiliWhaleTray.exe：先运行 npm run tray:build（或加 --build-tray）');

const plan = buildPackPlan({ version: cliVersion });
const targetDir = path.join(outDir, `BiliWhale-${cliVersion}`);

// 1) 清空旧目录（只在 dist 下）
if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

function copyRecursive(from: string, to: string): string[] {
  const source = path.join(ROOT, from);
  if (!fs.existsSync(source)) fail(`清单里的路径不存在：${from}`);
  const files = listFiles(ROOT, from);
  for (const relative of files) {
    const sourceFile = path.join(ROOT, relative);
    const suffix = relative.slice(from.length).replace(/^\/+/, '');
    const dest = path.join(to, suffix);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(sourceFile, dest);
  }
  return files;
}

let copied = 0;
for (const entry of plan.appFiles) {
  copied += copyRecursive(entry.from, path.join(targetDir, entry.to.replace(/^app\//, 'app/'))).length;
}
for (const entry of plan.rootFiles) {
  const source = path.join(ROOT, entry.from);
  if (!fs.existsSync(source)) fail(`缺少模板：${entry.from}`);
  fs.mkdirSync(path.dirname(path.join(targetDir, entry.to)), { recursive: true });
  fs.copyFileSync(source, path.join(targetDir, entry.to));
  copied += 1;
}

// runtime：复制当前 node.exe
const nodeExe = process.execPath;
fs.mkdirSync(path.join(targetDir, 'runtime'), { recursive: true });
fs.copyFileSync(nodeExe, path.join(targetDir, 'runtime', 'node.exe'));
copied += 1;

// VERSION
fs.writeFileSync(path.join(targetDir, 'VERSION'), `${cliVersion}\n`, 'utf8');
copied += 1;

// 2) zip
let zipInfo: { file: string; bytes: number } | null = null;
if (!noZip) {
  const files: Array<{ name: string; data: Buffer; mtime?: Date }> = [];
  for (const relative of listFiles(targetDir, '')) {
    const full = path.join(targetDir, relative);
    files.push({ name: `BiliWhale-${cliVersion}/${relative}`, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
  }
  const zipFile = path.join(outDir, `BiliWhale-${cliVersion}-portable.zip`);
  const written = writeZipFile(zipFile, files, { compress: true });
  zipInfo = { file: written.file, bytes: written.bytes };
}

const sizeOf = (dir: string): number => listFiles(dir, '').reduce((sum, relative) => sum + fs.statSync(path.join(dir, relative)).size, 0);
const dirBytes = sizeOf(targetDir);

process.stdout.write(
  [
    '',
    `打包完成：BiliWhale ${cliVersion}`,
    `  目录：${targetDir}（${(dirBytes / 1024 / 1024).toFixed(1)} MB，${copied} 个文件）`,
    zipInfo ? `  zip ：${zipInfo.file}（${(zipInfo.bytes / 1024 / 1024).toFixed(1)} MB）` : '  （跳过了 zip）',
    '',
    '下一步：解压 zip → 双击 install.cmd（装到开始菜单），或直接双击 BiliWhale.cmd（便携运行）。',
    '',
  ].join('\n'),
);
