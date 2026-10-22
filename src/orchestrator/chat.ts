/**
 * 和主人私聊（M4）。
 *
 * 硬约束（§7.9 / §7.11）：
 *   - **只认主人**：senderId 必须等于主人 mid，陌生人/系统消息一律忽略（不回、不记账、不建会话）。
 *   - **每条来信最多回一条**：按 msgKey 去重；≤20 条/小时；撞风控停 30 分钟。
 *   - **不调工具、不改配置、不触发一轮、不发评论/给别人发私信**：
 *     这里没有 ToolRuntime、没有 ConfigService 写入、没有 share 调用；能做的只有「回一条」和两个内置附件。
 *   - **附件白名单**：只有 `diary`（今天的公开日记）与 `video_info`（今天上下文里出现过的 BV），
 *     其它一律忽略；bvid 不在白名单就当没有。
 *   - **上下文很小**：人设 + 最近 N 条聊天 + 今天的公开日记 + 今天的报告摘要 + 今天挑中的 BV。
 *     不注入完整字幕/评论（省钱，也避免把大段内容喂给模型）。
 * 不做什么：不做「聊天里让它干活」（那是面板的事）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { LlmClient } from '../llm/client.ts';
import type { BiliApi } from '../bili/api.ts';
import type { DmMessage } from '../bili/api.ts';
import type { BiliWriter } from '../bili/write.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { ChatStore } from '../state/chatStore.ts';
import type { SecretsService } from '../config/secrets.ts';
import type { Paths } from '../state/paths.ts';
import { localDate, localIso } from '../shared/time.ts';
import { extractJson } from '../agent/output.ts';

export interface ChatDeps {
  logger: Logger;
  paths: Paths;
  config: Config;
  llm: LlmClient;
  api: BiliApi;
  writer: BiliWriter;
  state: AppStateStore;
  chat: ChatStore;
  secrets: SecretsService;
  now?: () => Date;
}

export interface ChatAttachment {
  kind: 'diary' | 'video_info';
  bvid?: string;
}

export interface ChatOutcome {
  replied: boolean;
  skipped?: string;
  text?: string;
  attachments?: ChatAttachment[];
  /** 回复里是否包含被拒绝的请求（用于日志）。 */
  refused?: boolean;
}

/** 主人 mid：配置里的账号 mid 优先，否则取登录态里的自己。 */
export function ownerMid(deps: ChatDeps): number {
  const fromConfig = deps.config.account?.mid ?? 0;
  if (fromConfig > 0) return fromConfig;
  return deps.secrets.selfMid();
}

/** 今天的上下文：公开日记 + 报告摘要 + 挑中的 BV（标题也尽量带上）。 */
export interface TodayContext {
  publicDiary: string;
  reportSummary: string;
  videos: Array<{ bvid: string; title: string; desc: string; understanding: string }>;
}

export function readTodayContext(deps: ChatDeps, now: Date): TodayContext {
  const date = localDate(now);
  const diaryFile = path.join(deps.paths.diariesPublicDir, `${date}.md`);
  const reportFile = path.join(deps.paths.reportsDir, `${date}.md`);

  let publicDiary = '';
  try {
    publicDiary = fs.readFileSync(diaryFile, 'utf8').trim();
  } catch {
    publicDiary = '';
  }

  let report = '';
  try {
    report = fs.readFileSync(reportFile, 'utf8');
  } catch {
    report = '';
  }

  // 从报告里抽「# BV · 标题」与「为什么值得 / 一句话」，只给模型看一小段
  const videos: TodayContext['videos'] = [];
  const lines = report.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^####\s+(BV[0-9A-Za-z]{10})\s*·\s*(.+)$/.exec(lines[i] ?? '');
    if (!match) continue;
    const bvid = match[1] ?? '';
    const title = (match[2] ?? '').trim();
    let understanding = '';
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const line = lines[j] ?? '';
      const one = /^-\s*一句话[:：]\s*(.+)$/.exec(line);
      const why = /^-\s*为什么值得[:：]\s*(.+)$/.exec(line);
      if (one) understanding = one[1] ?? '';
      else if (!understanding && why) understanding = why[1] ?? '';
      if (understanding) break;
    }
    videos.push({ bvid, title, desc: '', understanding });
  }

  return {
    publicDiary,
    reportSummary: report.replace(/^#.*$/gm, '').trim().slice(0, 400),
    videos,
  };
}

/** 上下文拼成一段（给模型；也方便测试断言「不含完整字幕」）。 */
export function buildChatPrompt(
  deps: ChatDeps,
  input: { message: string; history: Array<{ from: string; text: string }>; context: TodayContext },
): { system: string; user: string } {
  const persona = deps.config.persona;
  const maxChars = deps.config.listen.dm.maxChars;
  const limitedVideos = input.context.videos.slice(0, 5);
  const system = [
    `你是「${persona.name}」。和主人私下聊天。`,
    `主人怎么称呼：${persona.ownerTitle}；你自称：${persona.selfClaim}。`,
    '',
    '规则（必须遵守）：',
    `- 回复 ≤${maxChars} 字，像聊天，不要写台账/术语/流程口径。`,
    '- 你只能聊天，不能改设置、不能跑一轮、不能发评论、不能给别人发私信、不能执行命令、不能读文件、不能贴 cookie 或路径。',
    '- 遇到这类要求，就回「这个得到面板里改/做」，并停下。',
    '- 允许的附件只有两种：今天的公开日记（kind=diary）、今天上下文里的视频（kind=video_info 且 bvid 必须在列表里）。其它一律不要提。',
    '- 不确定就说不确定，不要编。',
    '',
    '输出必须是 JSON（不要别的字）：',
    '{"reply":"……","attach":{"kind":"none|diary|video_info","bvid":"BV…"}}',
  ].join('\n');

  const historyText = input.history
    .slice(-Math.max(1, deps.config.listen.dm.maxHistory))
    .map((line) => `${line.from === 'owner' ? '主人' : '我'}：${line.text}`)
    .join('\n');

  const videoText = limitedVideos.length
    ? limitedVideos.map((video) => `- ${video.bvid} · ${video.title}${video.understanding ? `（${video.understanding.slice(0, 60)}）` : ''}`).join('\n')
    : '（今天没有挑中的）';

  const user = [
    historyText ? `最近的聊天：\n${historyText}` : '（还没有聊过）',
    input.context.publicDiary ? `今天的公开日记（节选）：\n${input.context.publicDiary.slice(0, 600)}` : '（今天没有公开日记）',
    input.context.reportSummary ? `今天的报告摘要：\n${input.context.reportSummary}` : '（今天没有报告）',
    `今天挑中的视频（只能引用这些）：\n${videoText}`,
    '',
    `刚才主人说：${input.message}`,
  ].join('\n');

  return { system, user };
}

/** 处理一条主人私信：只回一条，最多带两个附件。 */
export async function handleOwnerMessage(deps: ChatDeps, message: DmMessage): Promise<ChatOutcome> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const owner = ownerMid(deps);

  if (!cfg.listen.dm.enabled) return { replied: false, skipped: '私信监听关着' };
  if (!cfg.listen.dm.chat) return { replied: false, skipped: '聊天关着（只保留发送侧）' };
  if (owner <= 0) return { replied: false, skipped: '不知道主人是谁（先登录）' };
  if (message.senderId !== owner) return { replied: false, skipped: '不是主人，不回' };
  if (!message.text.trim()) return { replied: false, skipped: '空消息' };
  if (message.msgKey && deps.chat.repliedKeys().has(message.msgKey)) return { replied: false, skipped: '这条已经回过了' };
  if (deps.chat.sentInLastHour(now()) >= cfg.listen.dm.maxPerHour) return { replied: false, skipped: `一小时内已经回了 ${cfg.listen.dm.maxPerHour} 条` };
  if (deps.state.inRiskCooldown(now())) return { replied: false, skipped: '风控冷却中' };
  if (!cfg.safety.writeEnabled || cfg.safety.killSwitch) return { replied: false, skipped: '写操作被关着' };

  const context = readTodayContext(deps, now());
  const history = deps.chat.recent(cfg.listen.dm.maxHistory).map((line) => ({ from: line.from, text: line.text }));
  const prompt = buildChatPrompt(deps, { message: message.text, history, context });

  // 记下主人这句（先记，模型挂了也不算丢消息）
  deps.chat.append({ at: localIso(now()), from: 'owner', text: message.text, ...(message.msgKey ? { msgKey: message.msgKey } : {}) });

  const completion = await deps.llm.chat({ messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], maxTokens: 700, temperature: 0.7 });
  if (!completion.ok) {
    deps.logger.warn('chat', `聊天回复生成失败：${completion.error.message}`);
    return { replied: false, skipped: `模型出错：${completion.error.message}` };
  }

  const parsed = extractJson(completion.data.content) as { reply?: unknown; attach?: unknown } | null;
  let reply = typeof parsed?.reply === 'string' ? parsed.reply.trim() : completion.data.content.trim();
  if (!reply) return { replied: false, skipped: '模型没给出可发的回复' };

  // 附件白名单：kind ∈ {diary, video_info}；video_info 的 bvid 必须在今天上下文里
  const allowBvids = new Set(context.videos.map((video) => video.bvid));
  const attachments: ChatAttachment[] = [];
  const attach = parsed?.attach;
  if (attach && typeof attach === 'object') {
    const kind = (attach as { kind?: unknown }).kind;
    const bvid = (attach as { bvid?: unknown }).bvid;
    if (kind === 'diary') attachments.push({ kind: 'diary' });
    else if (kind === 'video_info' && typeof bvid === 'string' && allowBvids.has(bvid)) attachments.push({ kind: 'video_info', bvid });
    else if (kind && kind !== 'none') deps.logger.info('chat', `忽略了不允许的附件：${String(kind)}`);
  }

  // 拒绝清单兜底：模型偶尔会照做，这里再拦一道
  if (looksLikeActionRequest(reply)) {
    reply = '这个得到面板里改/做，我在这儿只聊天。';
  }

  const chars = Array.from(reply);
  if (chars.length > cfg.listen.dm.maxChars) reply = `${chars.slice(0, cfg.listen.dm.maxChars - 1).join('')}…`;

  const dryRun = cfg.safety.dryRun;
  const sender = deps.secrets.selfMid();
  const sent = await deps.writer.sendDm({ receiverId: owner, text: reply, senderId: sender }, { dryRun });
  if (!sent.ok) {
    deps.logger.warn('chat', `聊天回复发送失败：${sent.error?.message ?? '未知'}`);
    if (sent.error?.kind === 'risk') {
      deps.state.setRiskCooldown(new Date(now().getTime() + cfg.safety.riskCooldownMin * 60_000).toISOString());
    }
    return { replied: false, skipped: sent.error?.message ?? '发送失败' };
  }

  deps.chat.append({
    at: localIso(now()),
    from: 'self',
    text: reply,
    ...(message.msgKey ? { msgKey: message.msgKey } : {}),
    ...(attachments[0] ? { attach: { kind: attachments[0].kind, ...(attachments[0].bvid ? { bvid: attachments[0].bvid } : {}) } } : {}),
  });

  // 附件：日记 / 视频信息（都用今天已有的内容，不再请求网络）
  for (const attachment of attachments) {
    if (attachment.kind === 'diary') {
      await sendDiaryAttachment(deps, context, { dryRun, sender, receiver: owner, now: now() });
    } else if (attachment.kind === 'video_info' && attachment.bvid) {
      const video = context.videos.find((item) => item.bvid === attachment.bvid);
      if (video) await sendVideoAttachment(deps, video, { dryRun, sender, receiver: owner });
    }
  }

  deps.logger.event('chat', `回了主人一条${attachments.length ? `（附 ${attachments.map((a) => a.kind).join('/')}）` : ''}`, {
    target: 'chat',
    data: { chars: chars.length, attachments: attachments.map((a) => a.kind) },
  });

  return { replied: true, text: reply, ...(attachments.length > 0 ? { attachments } : {}) };
}

/** 轮询：只拉会话列表；只处理主人的会话。 */
export async function pollOwnerDm(deps: ChatDeps): Promise<{ handled: number; skipped: string[] }> {
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config;
  const skipped: string[] = [];
  if (!cfg.listen.dm.enabled) return { handled: 0, skipped: ['私信监听关着'] };
  const owner = ownerMid(deps);
  if (owner <= 0) return { handled: 0, skipped: ['不知道主人是谁'] };

  const sessions = await deps.api.dmSessions();
  if (!sessions.ok) return { handled: 0, skipped: [`读会话列表失败：${sessions.error.message}`] };
  const mine = sessions.data.find((session) => session.talkerId === owner);
  if (!mine) {
    deps.state.setDmSeenAt(localIso(now()));
    return { handled: 0, skipped: ['主人的会话里没有新消息'] };
  }

  const cursor = deps.state.lastDmSeenAt();
  if (cursor && Date.parse(mine.lastMsgAtMs ? new Date(mine.lastMsgAtMs).toISOString() : '') <= Date.parse(cursor)) {
    return { handled: 0, skipped: ['没有新私信'] };
  }

  const messages = await deps.api.dmMessages(owner, cfg.listen.dm.maxHistory);
  if (!messages.ok) return { handled: 0, skipped: [`读私信失败：${messages.error.message}`] };
  const fresh = messages.data.filter((message) => message.senderId === owner);
  let handled = 0;
  for (const message of fresh.slice(-3)) {
    const outcome = await handleOwnerMessage(deps, message);
    if (outcome.replied) handled += 1;
    else if (outcome.skipped) skipped.push(outcome.skipped);
  }
  deps.state.setDmSeenAt(localIso(now()));
  return { handled, skipped };
}

/* ---------------- 附件 ---------------- */

async function sendDiaryAttachment(
  deps: ChatDeps,
  context: TodayContext,
  options: { dryRun: boolean; sender: number; receiver: number; now: Date },
): Promise<void> {
  if (!context.publicDiary) return;
  const parts = splitForDm(context.publicDiary, 500, 5);
  if (!parts) {
    await deps.writer.sendDm({ receiverId: options.receiver, text: '今天的日记有点长，去面板「日记」页看吧。', senderId: options.sender }, { dryRun: options.dryRun });
    return;
  }
  for (const part of parts) {
    const res = await deps.writer.sendDm({ receiverId: options.receiver, text: part, senderId: options.sender }, { dryRun: options.dryRun });
    if (!res.ok) break;
  }
}

async function sendVideoAttachment(
  deps: ChatDeps,
  video: TodayContext['videos'][number],
  options: { dryRun: boolean; sender: number; receiver: number },
): Promise<void> {
  const lines = [video.title, `https://www.bilibili.com/video/${video.bvid}`];
  if (video.understanding) lines.push(`我觉得：${video.understanding}`);
  let text = lines.join('\n');
  if (Array.from(text).length > 500) text = `${Array.from(text).slice(0, 499).join('')}…`;
  await deps.writer.sendDm({ receiverId: options.receiver, text, senderId: options.sender }, { dryRun: options.dryRun });
}

/** 分段（≤500，最多 5 段）；超过就返回 null（让调用方换一句提示）。 */
export function splitForDm(text: string, maxChars = 500, maxParts = 5): string[] | null {
  const clean = text.trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return [clean];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars - 4) {
    if (parts.length >= maxParts) return null;
    parts.push(chars.slice(i, i + maxChars - 4).join(''));
  }
  return parts;
}

/** 兜底：回复里出现「我来改设置/我去发/我执行」这种就换成固定拒绝。 */
export function looksLikeActionRequest(reply: string): boolean {
  const patterns = [
    /帮你.{0,8}(改|设置|发|删)/, // 帮你改设置 / 帮你发一条
    /已经?.{0,8}(改|设置)了/, // 我已经帮你把设置改了
    /我去(改|发|执行|删)/, // 我去发一条
    /(执行|运行)了(命令|脚本)/,
    /cookie|SESSDATA/i,
    /[A-Za-z]:\\/, // 贴本机路径
  ];
  return patterns.some((pattern) => pattern.test(reply));
}
