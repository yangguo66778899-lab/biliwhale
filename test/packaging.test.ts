import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildPackPlan, EXCLUDED_DIRS, listFiles } from '../src/pack/plan.ts';

const ROOT = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('打包清单：包含程序本体、托盘、文档，不含 test/node_modules/dist', () => {
  const plan = buildPackPlan({ version: '0.7.0-M5' });
  const froms = plan.appFiles.map((entry) => entry.from);
  for (const must of ['src', 'fixtures', 'shell', 'package.json', 'README.md', 'LICENSE', 'NOTICE']) {
    assert.ok(froms.includes(must), `清单里应该有 ${must}`);
  }
  for (const excluded of ['test', 'node_modules', 'dist', 'data', '.run', '.git']) {
    assert.ok(plan.excluded.includes(excluded), `不该打包 ${excluded}`);
    assert.equal(froms.includes(excluded), false);
  }
  assert.ok(plan.rootFiles.some((entry) => entry.to === 'install.cmd'));
  assert.ok(plan.rootFiles.some((entry) => entry.to === 'uninstall.ps1'));
  assert.ok(plan.rootFiles.some((entry) => entry.to === 'BiliWhale.cmd'));
  assert.deepEqual(plan.runtimeFiles, [{ from: 'node.exe', to: 'runtime/node.exe' }]);
});

test('打包清单：版本号不合法要报错（防止打出 BiliWhale-latest）', () => {
  assert.throws(() => buildPackPlan({ version: 'latest' }), /版本号/);
});

test('打包清单：列文件时跳过排除目录', () => {
  const files = listFiles(ROOT, 'src', EXCLUDED_DIRS).slice(0, 50);
  assert.ok(files.length > 5);
  assert.equal(files.some((file) => file.startsWith('test/')), false);
  assert.ok(files.every((file) => !file.startsWith('/')), '相对路径不能以 / 开头');
});

test('安装脚本：当前用户、不要求管理员、会设内核命令与快捷方式', () => {
  const install = read('packaging/install.ps1');
  assert.match(install, /LOCALAPPDATA/, '默认装到 %LOCALAPPDATA%\\Programs');
  assert.match(install, /BILIWHALE_KERNEL_CMD/, '要设内核启动命令（托盘靠它拉内核）');
  assert.match(install, /CreateShortcut/, '要建快捷方式');
  assert.match(install, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/, '自启写 HKCU Run');
  assert.equal(/RunAs|Verb\s+runas|requireAdministrator|#requires\s+-RunAsAdministrator/i.test(install), false, '不许要求提权');
  assert.equal(/HKLM:/i.test(install), false, '不许写机器级注册表');
  // 「不用虚拟机也能试装」靠它：只复制文件，不碰系统
  assert.match(install, /\[switch\]\$NoRegister/, '要有 -NoRegister');
  assert.match(install, /if \(\$NoRegister\)/, 'NoRegister 分支要真的跳过环境变量/快捷方式');
});

test('卸载脚本也支持 -NoRegister（只删目录，不动注册表）', () => {
  const uninstall = read('packaging/uninstall.ps1');
  assert.match(uninstall, /\[switch\]\$NoRegister/);
  assert.match(uninstall, /if \(-not \$NoRegister\)/);
});

test('卸载脚本：默认保留数据，删自启与快捷方式，-RemoveData 才删数据', () => {
  const uninstall = read('packaging/uninstall.ps1');
  assert.match(uninstall, /Remove-ItemProperty/, '要删自启项');
  assert.match(uninstall, /RemoveData/, '要支持 --remove-data');
  assert.match(uninstall, /保留/, '默认要说明数据保留');
  assert.match(uninstall, /Remove-Item -Recurse -Force \$Target/, '要删程序目录');
  assert.match(uninstall, /默认保留|数据保留/, '默认保留数据');
});

test('便携启动器：用包内 node，不经 PATH；找不到就报错而不是静默', () => {
  const launcher = read('packaging/BiliWhale.cmd');
  assert.match(launcher, /runtime\\node\.exe/);
  assert.match(launcher, /BILIWHALE_KERNEL_CMD/);
  assert.match(launcher, /app\\src\\cli\.ts/);
  assert.match(launcher, /exit \/b 1/, '缺文件要报错退出');
});

test('README.txt 覆盖安装/升级/卸载/排障四件事', () => {
  const readme = read('packaging/README.txt');
  for (const keyword of ['install.cmd', 'uninstall.cmd', '升级', '备份', '诊断包']) {
    assert.ok(readme.includes(keyword), `README 里应该提到 ${keyword}`);
  }
});
