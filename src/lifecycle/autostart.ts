/**
 * 开机自启。
 *
 * 职责：让程序开机后自己起来（`--autostart`，不弹窗、不抢焦点）。
 *   两个后端，按顺序尝试：
 *   1. **注册表**（文档默认方案）：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，
 *      值为 `"<exe>" --autostart`，不需要管理员权限；
 *   2. **启动文件夹**（兜底）：写一个 `.cmd` 到当前用户的 Startup 目录。
 *      只用文件写入，任何权限模型下都能成，且很容易被用户自己删掉。
 * 不做什么：不写系统目录、不注册服务、不要求提权。
 *
 * 说明：注册表读写要通过 `reg.exe`（系统命令，带 `windowsHide` 与超时）。
 *   某些环境（例如受限沙箱）不允许起子进程，此时自动落到启动文件夹后端，并在状态里说明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Logger } from '../shared/logger.ts';
import { ensureDir } from '../shared/atomic.ts';

export type AutostartMechanism = 'registry' | 'startup-folder';

export interface AutostartStatus {
  enabled: boolean;
  /** 实际生效（或上次写入）的机制；两个都没有时是 null。 */
  mechanism: AutostartMechanism | null;
  /** 写进去的命令（人读）。 */
  command: string | null;
  /** 读取失败时不为空（例如读注册表被拒），此时 enabled 可能不准。 */
  warning?: string;
}

export interface RegistryCommand {
  run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export interface AutostartOptions {
  /** 要执行的命令（默认是托盘 exe）；必须是完整命令行。 */
  command: string;
  /** 启动文件夹路径；默认取 %APPDATA%\...\Startup。 */
  startupDir?: string;
  /** 注册表后端；不给就用 reg.exe。测试可注入假实现。 */
  registry?: RegistryCommand;
  logger?: Logger;
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'BiliWhale';
const STARTUP_FILE = 'BiliWhale.cmd';

/** 用 reg.exe 读写 HKCU Run（系统命令，带 windowsHide 与超时）。 */
export const regExe: RegistryCommand = {
  run(args) {
    return new Promise((resolve) => {
      try {
        execFile('reg', args, { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      } catch (err) {
        // 起不来（受限环境 / 没有 reg.exe）也要 resolve，别让调用方等一个永远不来的回调
        resolve({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      }
    });
  },
};

export class AutostartService {
  private readonly command: string;
  private readonly startupDir: string;
  private readonly registry: RegistryCommand;
  private readonly logger?: Logger;

  constructor(opts: AutostartOptions) {
    this.command = opts.command;
    this.startupDir = opts.startupDir ?? defaultStartupDir();
    this.registry = opts.registry ?? regExe;
    if (opts.logger) this.logger = opts.logger;
  }

  /** 开启自启：先试注册表，失败落启动文件夹。 */
  async enable(): Promise<AutostartStatus> {
    const registry = await this.registry.run(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', this.command, '/f']);
    if (registry.ok) {
      // 注册表和启动文件夹只留一个，避免开机起两次
      this.removeStartupFile();
      this.logger?.info('autostart', '已写入注册表 Run 键');
      return { enabled: true, mechanism: 'registry', command: this.command };
    }

    this.logger?.warn('autostart', `注册表写入失败，改用启动文件夹：${registry.stderr.trim() || 'reg.exe 不可用'}`);
    const warning = `注册表写入失败（${firstLine(registry.stderr) || 'reg.exe 不可用'}），已改用启动文件夹`;
    try {
      ensureDir(this.startupDir);
      const body = [
        '@echo off',
        'rem BiliWhale 开机自启（由程序写入；删掉这个文件即可关闭）',
        `start "" ${this.command}`,
        '',
      ].join('\r\n');
      fs.writeFileSync(path.join(this.startupDir, STARTUP_FILE), body, 'utf8');
      return { enabled: true, mechanism: 'startup-folder', command: this.command, warning };
    } catch (err) {
      return { enabled: false, mechanism: null, command: null, warning: `两种自启方式都失败：${String(err)}` };
    }
  }

  /** 关闭自启：两个后端都清掉（可能之前用过另一种）。 */
  async disable(): Promise<AutostartStatus> {
    const registry = await this.registry.run(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    this.removeStartupFile();
    const missing = !registry.ok && /unable to find|找不到/i.test(registry.stderr);
    if (!registry.ok && !missing) {
      this.logger?.warn('autostart', `注册表删除返回失败：${firstLine(registry.stderr)}`);
    }
    return { enabled: false, mechanism: null, command: null };
  }

  /** 当前状态。读取失败时如实返回 warning，不要假装「没开」。 */
  async status(): Promise<AutostartStatus> {
    const registry = await this.registry.run(['query', RUN_KEY, '/v', RUN_VALUE]);
    if (registry.ok && registry.stdout.includes(RUN_VALUE)) {
      const match = /REG_SZ\s+(.+)/.exec(registry.stdout);
      return { enabled: true, mechanism: 'registry', command: match?.[1]?.trim() ?? this.command };
    }

    const startupFile = path.join(this.startupDir, STARTUP_FILE);
    if (fs.existsSync(startupFile)) {
      return { enabled: true, mechanism: 'startup-folder', command: this.command };
    }

    if (!registry.ok && !/unable to find|找不到/i.test(registry.stderr)) {
      return {
        enabled: false,
        mechanism: null,
        command: null,
        warning: `读不到注册表（${firstLine(registry.stderr) || 'reg.exe 不可用'}），状态可能不准`,
      };
    }
    return { enabled: false, mechanism: null, command: null };
  }

  private removeStartupFile(): void {
    try {
      fs.rmSync(path.join(this.startupDir, STARTUP_FILE), { force: true });
    } catch {
      /* 删不掉不影响其它 */
    }
  }
}

export function defaultStartupDir(): string {
  // 允许覆盖：测试、便携版、以及把自启放到别的盘的场景
  const override = process.env.BILIWHALE_STARTUP_DIR?.trim();
  if (override) return override;
  const appData = process.env.APPDATA?.trim();
  const base = appData && appData.length > 0 ? appData : path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming');
  return path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '').trim().slice(0, 160);
}
