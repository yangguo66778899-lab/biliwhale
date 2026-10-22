/**
 * 打包清单（纯函数，能被测试）。
 *
 * 便携包的布局（用户解压后看到的样子）：
 *
 *   BiliWhale-<version>/
 *   ├── app/                程序本体（源码 + 夹具 + 托盘 exe + 文档）
 *   ├── runtime/node.exe    随包带的 Node（用户不用装 Node）
 *   ├── BiliWhale.cmd       便携启动器
 *   ├── install.cmd/.ps1    装到开始菜单（当前用户，不需要管理员）
 *   ├── uninstall.cmd/.ps1  卸载（默认保留数据）
 *   ├── README.txt          给人看的第一份说明
 *   └── VERSION             版本号
 *
 * 刻意**不**打包：test/、node_modules、dist、data、.run、.git、日志。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PackFile {
  /** 仓库里的相对路径（用 / 分隔）。 */
  from: string;
  /** 包里的相对路径（用 / 分隔）。 */
  to: string;
}

export interface PackPlan {
  /** 会复制进 app/ 的文件（相对仓库根）。 */
  appFiles: PackFile[];
  /** 包根目录下的固定文件。 */
  rootFiles: PackFile[];
  /** 运行时（单独复制，体积大）。 */
  runtimeFiles: PackFile[];
  /** 明确不打包的目录（给人看，也用于测试）。 */
  excluded: string[];
}

/** app/ 里要带的仓库路径（目录会递归）。 */
const APP_TREES = ['src', 'fixtures', 'shell'];
const APP_FILES = ['package.json', 'tsconfig.json', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md'];
const DOC_FILE = 'independent-docs'; // 占位，避免误加

/** 包根目录的模板文件（来自 packaging/）。 */
const ROOT_TEMPLATES = [
  // .cmd 只做 ASCII 转发，逻辑与中文都在 launch.ps1（UTF-8 BOM）里
  'BiliWhale.cmd',
  'launch.ps1',
  'install.cmd',
  'install.ps1',
  'uninstall.cmd',
  'uninstall.ps1',
  'README.txt',
];

export const EXCLUDED_DIRS = ['test', 'node_modules', 'dist', 'data', '.run', '.git', '.npm-cache', 'packaging'];

/** 生成打包清单。`version` 只用于校验（清单本身与版本无关）。 */
export function buildPackPlan(options: { version: string }): PackPlan {
  if (!/^\d+\.\d+\.\d+/.test(options.version)) {
    throw new Error(`版本号不合法：${options.version}`);
  }
  const appFiles: PackFile[] = [];
  for (const tree of APP_TREES) {
    appFiles.push({ from: tree, to: `app/${tree}` });
  }
  for (const file of APP_FILES) {
    appFiles.push({ from: file, to: `app/${file}` });
  }
  void DOC_FILE;

  const rootFiles: PackFile[] = ROOT_TEMPLATES.map((name) => ({ from: `packaging/${name}`, to: name }));

  return {
    appFiles,
    rootFiles,
    runtimeFiles: [{ from: 'node.exe', to: 'runtime/node.exe' }],
    excluded: EXCLUDED_DIRS,
  };
}

/** 递归列一个目录下的所有文件（用来算「包里有多少文件」与复制）。 */
export function listFiles(root: string, relative: string, skip: string[] = EXCLUDED_DIRS): string[] {
  const full = path.join(root, relative);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const child = path.join(dir, entry.name);
      const childRel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  if (!fs.existsSync(full)) return out;
  if (fs.statSync(full).isDirectory()) walk(full, relative);
  else out.push(relative);
  return out;
}
