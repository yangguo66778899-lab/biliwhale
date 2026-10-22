/**
 * 配置校验与默认值。
 *
 * 职责：把一份「可能缺字段 / 可能是旧版本 / 可能被人手改错」的 JSON，变成合法的 Config。
 *   - 缺字段 → 补默认值（记一条 warn，不打扰用户）
 *   - 值非法 → 记 error，字段级中文报错；**不允许带着无效配置开跑**
 *   - 未知字段 → 收进 `_unknown`，warn 但不丢弃（方便降级/回滚）
 * 不做什么：不做 IO、不做迁移写盘（在 service.ts）。
 */

import type { Config, FieldSpec, ObjectSpec } from './spec.ts';
import { SPEC } from './spec.ts';

export type Severity = 'error' | 'warn' | 'info';

export interface ConfigIssue {
  path: string;
  message: string;
  severity: Severity;
}

export interface ValidatedConfig {
  ok: true;
  value: Config;
  issues: ConfigIssue[];
  unknown: Record<string, unknown>;
}

export interface InvalidConfig {
  ok: false;
  issues: ConfigIssue[];
}

export type ValidateResult = ValidatedConfig | InvalidConfig;

/** 从规格生成一份全新的默认配置（深拷贝，避免共享引用）。 */
export function buildDefaults(spec: FieldSpec = SPEC): unknown {
  if (spec.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(spec.fields)) out[key] = buildDefaults(child);
    return out;
  }
  if (spec.kind === 'array') return structuredClone(spec.default);
  return spec.default;
}

/** 校验 + 补默认 + 收未知字段。 */
export function validateConfig(raw: unknown): ValidateResult {
  const issues: ConfigIssue[] = [];
  const unknown: Record<string, unknown> = {};
  const input = isPlainObject(raw) ? raw : {};

  if (!isPlainObject(raw)) {
    issues.push({ path: '', message: '配置不是一个 JSON 对象，已改用默认值', severity: 'error' });
  }

  const value = walk(SPEC, input, '', issues, unknown) as Config;
  const crossIssues = crossFieldCheck(value);
  issues.push(...crossIssues);

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) return { ok: false, issues };
  return { ok: true, value, issues, unknown };
}

function walk(
  spec: FieldSpec,
  value: unknown,
  path: string,
  issues: ConfigIssue[],
  unknown: Record<string, unknown>,
): unknown {
  switch (spec.kind) {
    case 'object': {
      const src = isPlainObject(value) ? value : {};
      if (value !== undefined && !isPlainObject(value)) {
        issues.push({ path, message: '应为对象', severity: 'error' });
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries((spec as ObjectSpec).fields)) {
        const childPath = path ? `${path}.${key}` : key;
        const childValue = (src as Record<string, unknown>)[key];
        if (childValue === undefined) {
          const hadObject = isPlainObject(value);
          if (hadObject) {
            issues.push({ path: childPath, message: '缺少字段，已用默认值补上', severity: 'warn' });
          }
          out[key] = buildDefaults(child);
          continue;
        }
        out[key] = walk(child, childValue, childPath, issues, unknown);
      }
      for (const [key, extra] of Object.entries(src as Record<string, unknown>)) {
        if (!(key in (spec as ObjectSpec).fields) && key !== '_unknown') {
          const childPath = path ? `${path}.${key}` : key;
          unknown[childPath] = extra;
          issues.push({ path: childPath, message: '未知字段，已保留但不生效', severity: 'warn' });
        }
      }
      return out;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: '应为数组', severity: 'error' });
        return structuredClone(spec.default);
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        issues.push({ path, message: `最多 ${spec.maxItems} 项，超出部分已忽略`, severity: 'warn' });
      }
      const items = value.slice(0, spec.maxItems ?? value.length);
      return items.map((item, idx) => walk(spec.item, item, `${path}[${idx}]`, issues, unknown));
    }

    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: '应为字符串', severity: 'error' });
        return spec.default;
      }
      const text = value.trim();
      if (spec.maxLen !== undefined && text.length > spec.maxLen) {
        issues.push({ path, message: `最长 ${spec.maxLen} 个字符`, severity: 'error' });
        return spec.default;
      }
      if (spec.pattern && text.length > 0 && !spec.pattern.test(text)) {
        issues.push({ path, message: spec.patternMessage ?? '格式不正确', severity: 'error' });
        return spec.default;
      }
      return text;
    }

    case 'number': {
      const n = typeof value === 'number' ? value : Number.NaN;
      if (!Number.isFinite(n)) {
        issues.push({ path, message: '应为数字', severity: 'error' });
        return spec.default;
      }
      if (spec.int && !Number.isInteger(n)) {
        issues.push({ path, message: '应为整数', severity: 'error' });
        return spec.default;
      }
      if (spec.min !== undefined && n < spec.min) {
        issues.push({ path, message: `不能小于 ${spec.min}`, severity: 'error' });
        return spec.default;
      }
      if (spec.max !== undefined && n > spec.max) {
        issues.push({ path, message: `不能大于 ${spec.max}`, severity: 'error' });
        return spec.default;
      }
      return n;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        issues.push({ path, message: '应为 true / false', severity: 'error' });
        return spec.default;
      }
      return value;
    }

    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        issues.push({ path, message: `只能是：${spec.values.join(' / ')}`, severity: 'error' });
        return spec.default;
      }
      return value;
    }
  }
}

/** 跨字段规则：单字段合法但组合起来不讲道理的，在这里拦。 */
function crossFieldCheck(cfg: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const targetWakes = cfg.schedule.windows.reduce((sum, w) => sum + w.wakes, 0);
  if (targetWakes > 3) {
    issues.push({ path: 'schedule.windows', message: '所有窗口的醒来次数加起来不能超过 3', severity: 'error' });
  }
  if (cfg.schedule.windows.length === 0) {
    issues.push({ path: 'schedule.windows', message: '没有时间窗口：不会自动醒，只能手动跑', severity: 'warn' });
  }
  if (cfg.schedule.maxWakesPerDay > targetWakes) {
    issues.push({
      path: 'schedule.maxWakesPerDay',
      message: '比窗口里排的次数还多，实际按窗口次数走',
      severity: 'info',
    });
  }
  if (cfg.share.dailyCap > 3) {
    issues.push({ path: 'share.dailyCap', message: '超过 3 条/天，确认这是你想要的', severity: 'warn' });
  }
  if (cfg.content.minDuration > cfg.content.maxDuration) {
    issues.push({ path: 'content.maxDuration', message: '最长时间比最短时间还小', severity: 'error' });
  }
  if (cfg.diary.enabled === false) {
    issues.push({ path: 'diary.enabled', message: '日记不可关闭，已按开启处理', severity: 'warn' });
  }
  if (!cfg.score.enabled && cfg.share.enabled) {
    issues.push({
      path: 'score.enabled',
      message: '判分关着但分享开着：会按偏好命中 + 评论热度取第一名',
      severity: 'warn',
    });
  }
  if (cfg.share.silentStopDays < cfg.share.silentAfterDays) {
    issues.push({ path: 'share.silentStopDays', message: '完全停发的天数比开始收声还早', severity: 'warn' });
  }
  if (cfg.safety.killSwitch) {
    issues.push({ path: 'safety.killSwitch', message: '急停开着：本轮不会执行任何写操作', severity: 'info' });
  }
  if (cfg.app.proxy && cfg.app.proxy !== 'direct' && !/^https?:\/\/[^\s]+$/i.test(cfg.app.proxy)) {
    issues.push({ path: 'app.proxy', message: '代理应写成 http://host:port、direct 或留空', severity: 'error' });
  }
  const enabledChannels = cfg.notify.channels.filter((c) => c.enabled).map((c) => c.type);
  const dupes = enabledChannels.filter((t, i) => enabledChannels.indexOf(t) !== i);
  if (dupes.length > 0) {
    issues.push({ path: 'notify.channels', message: `同类通知渠道开了多个：${[...new Set(dupes)].join('、')}`, severity: 'warn' });
  }
  return issues;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取某个字段的规格（给面板渲染 / 测试用）。 */
export function getSpec(path: string): FieldSpec | undefined {
  const parts = path.split('.').filter(Boolean);
  let current: FieldSpec = SPEC;
  for (const part of parts) {
    if (current.kind !== 'object') return undefined;
    const next: FieldSpec | undefined = current.fields[part];
    if (!next) return undefined;
    current = next;
  }
  return current;
}
