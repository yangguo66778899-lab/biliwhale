/**
 * 配置中心（单一事实源）。
 *
 * 职责：读写 `<data>/config.json`；校验、补默认、保留未知字段、原子写 + `.bak` 回退。
 *   UI / API / CLI / 内部模块都从这里拿配置，没有第二份。
 * 不做什么：不做热更新监听（M2）、不处理密钥（见 secrets.ts）。
 */

import path from 'node:path';
import { readJson, writeJsonAtomic } from '../shared/atomic.ts';
import type { Logger } from '../shared/logger.ts';
import { isPlainObject, validateConfig } from './validate.ts';
import { migrateConfig, needsMigration } from './migrate.ts';
import type { ConfigIssue, ValidateResult } from './validate.ts';
import type { Config } from './spec.ts';

export interface LoadResult {
  config: Config;
  issues: ConfigIssue[];
  /** 配置来源：正常读盘 / 从 .bak 恢复 / 用默认值新建 / 用默认值兜底。 */
  origin: 'file' | 'backup' | 'created' | 'fallback';
}

export class ConfigService {
  readonly file: string;
  private readonly logger: Logger;
  private config: Config;
  private issues: ConfigIssue[] = [];
  private unknown: Record<string, unknown> = {};
  /** 本次加载实际跑过的迁移（面板与诊断包会显示）。 */
  private migrations: string[] = [];
  /** 迁移里需要用户注意的事（例如「主人 UID 还没填」）。 */
  private migrationNotes: string[] = [];

  constructor(dataDir: string, logger: Logger) {
    this.logger = logger;
    this.file = path.join(dataDir, 'config.json');
    const initial = validateConfig({});
    if (!initial.ok) throw new Error('默认配置本身不合法，这是一个 bug');
    this.config = initial.value;
  }

  /** 启动时调用一次。任何失败都不抛：最差情况用默认值起来并提示用户。 */
  load(): LoadResult {
    const read = readJson<unknown>(this.file);

    if (read.ok) {
      // 先迁移 schema（只补字段/改形状，不导入旧数据），再校验
      let candidate: unknown = read.value;
      if (needsMigration(candidate)) {
        const migrated = migrateConfig(candidate);
        candidate = migrated.config;
        this.migrations.push(...migrated.applied);
        this.migrationNotes.push(...migrated.notes);
        this.logger.info('config', `配置已从 v${migrated.from} 迁移到 v${migrated.to}`, {
          applied: migrated.applied,
        });
        for (const note of migrated.notes) this.logger.warn('config', note);
      }

      const result = validateConfig(candidate);
      if (result.ok) {
        this.config = result.value;
        this.issues = result.issues;
        this.unknown = result.unknown;
        this.reportIssues(result.issues);
        const origin = read.from === 'backup' ? 'backup' : 'file';
        // 迁移过就立刻落盘（保留 .bak），这样下次启动不需要再迁
        if (this.migrations.length > 0) {
          try {
            this.save();
            this.logger.info('config', '迁移后的配置已写回');
          } catch (err) {
            this.logger.error('config', `迁移后的配置写回失败（本次仍可用）：${String(err)}`);
          }
        }
        return { config: this.config, issues: result.issues, origin };
      }
      this.logger.error('config', '配置文件不合法，已改用默认值启动', { issues: summarize(result.issues) });
      return this.useDefaults('fallback', result.issues);
    }

    if (read.corrupt) {
      this.logger.error('config', '配置文件损坏且备份也不可用，已改用默认值', { error: read.error });
      return this.useDefaults('fallback', [{ path: '', message: read.error, severity: 'error' }]);
    }

    // 文件不存在：首次启动，把默认配置写下去
    this.useDefaults('created', []);
    try {
      this.save();
      this.logger.info('config', '已创建默认配置', { file: this.file });
    } catch (err) {
      this.logger.error('config', '默认配置写入失败（将以内存默认值继续）', { error: String(err) });
    }
    return { config: this.config, issues: this.issues, origin: 'created' };
  }

  get(): Readonly<Config> {
    return this.config;
  }

  /** 面板/CLI 改配置：深合并 → 校验 → 原子写。校验不过不落盘。 */
  patch(patch: unknown): { ok: boolean; issues: ConfigIssue[] } {
    if (!isPlainObject(patch)) {
      return { ok: false, issues: [{ path: '', message: '补丁必须是对象', severity: 'error' }] };
    }
    const merged = deepMerge(this.config as unknown as Record<string, unknown>, patch);
    const result = validateConfig(merged);
    if (!result.ok) return { ok: false, issues: result.issues };

    this.config = result.value;
    this.issues = result.issues;
    // 补丁里没有 _unknown，但之前读到的未知字段要留着（§7.3：不静默丢弃，便于降级/回滚）
    this.unknown = { ...this.unknown, ...result.unknown };
    try {
      this.save();
    } catch (err) {
      return { ok: false, issues: [{ path: '', message: `写盘失败：${String(err)}`, severity: 'error' }] };
    }
    this.reportIssues(result.issues);
    return { ok: true, issues: result.issues };
  }

  /** 本次启动跑过的配置迁移（空 = 没迁移）。 */
  getMigrations(): string[] {
    return [...this.migrations];
  }

  /** 迁移里需要用户动手的事。 */
  getMigrationNotes(): string[] {
    return [...this.migrationNotes];
  }

  /** 最近一次加载/保存时的校验问题（面板与诊断包要展示）。 */
  getIssues(): ConfigIssue[] {
    return [...this.issues];
  }

  /** 只校验不落盘（面板的「校验」按钮 / 导入前检查）。 */
  validateOnly(raw: unknown): ValidateResult {
    return validateConfig(raw);
  }

  /** 导出给用户：不含密钥，附 schema 版本。 */
  exportForUser(): Record<string, unknown> {
    return { ...(structuredClone(this.config) as unknown as Record<string, unknown>), _exportedAt: new Date().toISOString() };
  }

  save(): void {
    const withUnknown = { ...(this.config as unknown as Record<string, unknown>) };
    if (Object.keys(this.unknown).length > 0) withUnknown._unknown = this.unknown;
    writeJsonAtomic(this.file, withUnknown);
  }

  private useDefaults(origin: LoadResult['origin'], issues: ConfigIssue[]): LoadResult {
    const fallback = validateConfig({});
    if (!fallback.ok) throw new Error('默认配置不合法');
    this.config = fallback.value;
    this.issues = issues;
    return { config: this.config, issues, origin };
  }

  private reportIssues(issues: ConfigIssue[]): void {
    for (const issue of issues) {
      const where = issue.path || '(根)';
      if (issue.severity === 'error') this.logger.error('config', `${where}：${issue.message}`);
      else if (issue.severity === 'warn') this.logger.warn('config', `${where}：${issue.message}`);
      else this.logger.info('config', `${where}：${issue.message}`);
    }
  }
}

/** 深合并：对象递归合并，数组与标量整体替换（改排序就该整体改）。 */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) out[key] = deepMerge(prev, value);
    else out[key] = value;
  }
  return out as T;
}

function summarize(issues: ConfigIssue[]): string {
  return issues
    .filter((i) => i.severity === 'error')
    .slice(0, 5)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
}
