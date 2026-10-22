/**
 * 提示词装配。
 *
 * 职责：
 *   - 首次启动把内置的 system.md / charter.md 复制到 `<data>/prompts/`（用户可改）；
 *   - 每轮读一次，和 `persona.md`（用户自己写）一起装配：
 *     system = 内置 system.md + charter.md（稳定前缀，利于上下文缓存）
 *     user   = 状态 / 设置 / 人设 / 记忆 / 候选 / 任务（动态内容）
 * 不做什么：不写业务判断、不拼工具定义（那是 tools 层）、不调模型。
 *
 * 人设**逐轮注入 user prompt**，不能只放 system 里等模型自己去读文件（参考项目踩过的坑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { Paths } from '../state/paths.ts';
import { ensureDir, writeTextAtomic } from '../shared/atomic.ts';

const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export interface PromptAssets {
  system: string;
  charter: string;
  persona: string;
  personaSource: 'file' | 'default';
  personaFile: string;
}

/** 首次启动：把内置 system/charter 放进数据目录（不覆盖用户已改的版本）。 */
export function ensurePromptFiles(paths: Paths, logger: Logger): void {
  ensureDir(paths.promptsDir);
  for (const name of ['system.md', 'charter.md'] as const) {
    const target = path.join(paths.promptsDir, name);
    if (fs.existsSync(target)) continue;
    const source = path.join(BUNDLED_DIR, name);
    try {
      const text = fs.readFileSync(source, 'utf8');
      writeTextAtomic(target, text, { backup: false });
      logger.info('prompts', `已写入默认提示词 ${name}`);
    } catch (err) {
      logger.warn('prompts', `默认提示词 ${name} 写入失败：${String(err)}`);
    }
  }
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function bundled(name: string): string {
  return readIfExists(path.join(BUNDLED_DIR, name)) ?? '';
}

/** 读取本轮的提示词资产（缺文件全部走内置默认，不报错）。 */
export function loadPromptAssets(paths: Paths, config: Config): PromptAssets {
  const systemFile = path.join(paths.promptsDir, 'system.md');
  const charterFile = path.join(paths.promptsDir, 'charter.md');
  const personaFile = path.join(paths.dataDir, config.persona.file);

  const system = readIfExists(systemFile) ?? bundled('system.md');
  const charter = readIfExists(charterFile) ?? bundled('charter.md');
  const personaText = readIfExists(personaFile);

  return {
    system,
    charter,
    persona: (personaText ?? bundled('persona.default.md')).trim(),
    personaSource: personaText ? 'file' : 'default',
    personaFile,
  };
}

/** system 消息 = 内置规则 + 本轮口径（两者都稳定，放最前面吃上下文缓存）。 */
export function buildSystemMessage(assets: PromptAssets): string {
  return `${assets.system.trim()}\n\n---\n\n${assets.charter.trim()}\n`;
}

export interface PromptStatus {
  date: string;
  weekday: string;
  trigger: string;
  wakeReason: string;
  wakesToday: string;
  sharesToday: string;
  silence: string;
  channels: string;
  budget: string;
  dryRun: boolean;
}

/** user 消息：本轮状态 + 设置摘要 + 人设 + 记忆摘要。候选与任务由各阶段自己追加。 */
export function buildUserPreamble(input: {
  status: PromptStatus;
  config: Config;
  assets: PromptAssets;
  memoryLines: string[];
}): string {
  const { status, config, assets, memoryLines } = input;
  const likes = config.preferences.like.join('、') || '（没填，按关键词猜）';
  const dislikes = config.preferences.dislike.join('、') || '（没填）';
  const keywords = config.preferences.keywords.join('、') || '（空，用喜欢的方向当关键词）';

  return [
    '# 本轮状态',
    `- 日期：${status.date}（${status.weekday}）`,
    `- 唤醒原因：${status.wakeReason}`,
    `- 今天已醒：${status.wakesToday}`,
    `- 今日已分享：${status.sharesToday}`,
    `- 沉默档位：${status.silence}`,
    `- 可用渠道：${status.channels}`,
    `- 预算：${status.budget}`,
    `- 模式：${status.dryRun ? '只读预演（不会真的发任何东西）' : '正常'}`,
    '',
    '# 用户设置摘要',
    `- 喜欢：${likes}`,
    `- 不喜欢：${dislikes}`,
    `- 关键词：${keywords}`,
    `- 判分：${config.score.enabled ? `开，阈值 ${config.score.minScore}/20` : '关（按偏好命中+评论热度排序）'}`,
    `- 分享：${config.share.enabled ? `开，每天最多 ${config.share.dailyCap} 条，同视频 ${config.share.perVideoDays} 天一次` : '关（只写报告与日记）'}`,
    `- 收藏：${config.fav.enabled ? '开' : '关'}；动态：${config.dynamic.enabled ? '开' : '关'}；点赞：${config.like.enabled ? '开' : '关'}`,
    `- 报告：${config.report.level}；日记：两本都写`,
    '',
    `# 人设${assets.personaSource === 'default' ? '（还没写 persona.md，这是内置默认）' : ''}`,
    assets.persona,
    '',
    '# 记忆摘要',
    ...(memoryLines.length > 0 ? memoryLines.map((line) => `- ${line}`) : ['- （还没有历史记录，这是第一次）']),
  ].join('\n');
}

/** 素材包裹：所有工具返回与网页抓来的内容都放进去，system 里已声明它不可信。 */
export function wrapMaterial(source: string, content: string): string {
  return `<素材 source="${source}">\n${content}\n</素材>`;
}
