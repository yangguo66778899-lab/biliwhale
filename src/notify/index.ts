/**
 * 通知分发（§7.11）。
 *
 * 以前只有「写文件」与「发私信」两条路：配置里的 webhook / command / 静默时段全是摆设（审计 §2.3）。
 * 这里补上真正能用的三种：
 *   - file    ：写 notify.log（默认开；关掉且其它渠道全失败时兜底）
 *   - webhook ：POST JSON 到 url（飞书/钉钉/企微/Slack 的「text」字段都吃这一种）
 *   - command ：执行本地命令，消息以环境变量 BILIWHALE_NOTIFY_TEXT 传进去
 *   - dm      ：由 dm.ts 负责（这里不碰，避免两处发私信）
 * 桌面 Toast 需要托盘进程配合（内核没有 GUI），M6 再做；配置里已把 desktop 移除，避免假开关。
 *
 * 约束：每轮最多一条摘要（调用方只调一次）；静默时段只写文件；任何渠道失败都不影响主流程。
 */

import { execFile } from 'node:child_process';
import type { Config } from '../config/spec.ts';
import type { NotifyChannel } from '../config/spec.ts';
import type { Logger } from '../shared/logger.ts';

/** 面板「高级」区要展示的可复制例子（放在服务端：面板自己不许出现外部地址）。 */
export const NOTIFY_EXAMPLES = {
  /** 飞书群机器人的地址形状（示例，不是真地址）。 */
  webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/1a2b3c4d-5e6f-7890-abcd-ef1234567890',
  /** 一个「把自己弹出来」的小程序可以这么填（示例路径）。 */
  command: 'C:\\Tools\\notify.exe',
  commandArgs: '--title BiliWhale',
} as const;

export interface NotifyInput {
  text: string;
  /** 本地时间；用来判断静默时段。 */
  at: Date;
}

export interface NotifyResult {
  delivered: string[];
  failed: Array<{ channel: string; error: string }>;
  skipped: string[];
  /** 是否处于静默时段（只有 file 会发）。 */
  quiet: boolean;
}

/** 现在是否在静默时段内（支持跨零点，例如 23:00–08:00）。 */
export function inQuietHours(cfg: Config, at: Date): boolean {
  const range = cfg.notify?.quietHours;
  if (!range || !range.enabled) return false;
  const from = parseHhmm(range.start);
  const to = parseHhmm(range.end);
  if (from === null || to === null) return false;
  const minute = at.getHours() * 60 + at.getMinutes();
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

function parseHhmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface NotifyDeps {
  config: Config;
  logger: Logger;
  /** 测试注入。 */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** 测试注入：执行本地命令。 */
  runCommand?: (cmd: string, args: string[], env: Record<string, string>) => Promise<void>;
  /** 写文件渠道（由调用方传 appendNotifyLog，避免这里 import writers）。 */
  writeFile: (text: string) => void;
}

export async function dispatchNotifications(deps: NotifyDeps, input: NotifyInput): Promise<NotifyResult> {
  const channels = (deps.config.notify?.channels ?? []).filter((channel) => channel.enabled);
  const quiet = inQuietHours(deps.config, input.at);
  const result: NotifyResult = { delivered: [], failed: [], skipped: [], quiet };

  const fileOn = channels.some((channel) => channel.type === 'file');

  for (const channel of channels) {
    if (channel.type === 'dm') {
      result.skipped.push('dm 由私信模块发送（这里不重复发）');
      continue;
    }
    if (quiet && channel.type !== 'file') {
      result.skipped.push(`${channel.type}：静默时段只写文件`);
      continue;
    }
    try {
      const ok = await deliver(deps, channel, input.text);
      if (ok) result.delivered.push(channel.type);
      else result.skipped.push(`${channel.type}：没配置地址/命令`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ channel: channel.type, error: message });
      deps.logger.warn('notify', `${channel.type} 发送失败：${message}`);
    }
  }

  // file 默认开；关掉且其它渠道一个都没成时兜底（§7.11）
  if (!fileOn && result.delivered.length === 0) {
    try {
      deps.writeFile(input.text);
      result.delivered.push('file（兜底）');
      result.skipped.push('file 关着，但其它渠道都没成：兜底写文件');
    } catch (err) {
      result.failed.push({ channel: 'file', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

async function deliver(deps: NotifyDeps, channel: NotifyChannel, text: string): Promise<boolean> {
  if (channel.type === 'file') {
    deps.writeFile(text);
    return true;
  }
  if (channel.type === 'webhook') {
    const url = String(channel.url ?? '').trim();
    if (!url) return false;
    const fetchImpl = deps.fetchImpl ?? fetch;
    // 注意：channel.template 是 text/markdown 的枚举，不是模板字符串（以前这里把它当模板用了）
    const textOut = text;
    const payload = JSON.stringify(webhookPayload(channel.format, channel.template, textOut));
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  }
  if (channel.type === 'command') {
    const cmd = String(channel.cmd ?? '').trim();
    if (!cmd) return false;
    const args = String(channel.args ?? '').split(/\\s+/).map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    const env = { ...process.env, BILIWHALE_NOTIFY_TEXT: text } as Record<string, string>;
    if (deps.runCommand) {
      await deps.runCommand(cmd, args, env);
      return true;
    }
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { env, windowsHide: true, timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
    });
    return true;
  }
  return false;
}

/** 各家 webhook 的报文形状（飞书/钉钉/企微/通用）。 */
export function webhookPayload(format: string, template: string, text: string): Record<string, unknown> {
  const markdown = template === 'markdown';
  switch (format) {
    case 'feishu':
      return { msg_type: markdown ? 'interactive' : 'text', content: { text } };
    case 'dingtalk':
      return markdown ? { msgtype: 'markdown', markdown: { text } } : { msgtype: 'text', text: { content: text } };
    case 'wecom':
      return markdown ? { msgtype: 'markdown', markdown: { content: text } } : { msgtype: 'text', text: { content: text } };
    case 'telegram':
      return { text };
    case 'generic':
    default:
      return { text };
  }
}
