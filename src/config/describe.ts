/**
 * 配置的「给人看」描述。
 *
 * 职责：把 config/spec 的声明式规格转成面板能直接渲染的元数据（分组、字段、类型、范围、默认值、说明）。
 *   设置页因此不需要手写任何字段——加字段只改 spec.ts 一处。
 * 不做什么：不校验（validate.ts）、不读写文件（service.ts）。
 */

import type { FieldSpec, ObjectSpec } from './spec.ts';
import { SPEC } from './spec.ts';
import { buildDefaults } from './validate.ts';

export type FieldWidget = 'text' | 'password' | 'number' | 'boolean' | 'enum' | 'string-list' | 'object' | 'object-list' | 'time';

export interface FieldDescribe {
  path: string;
  label: string;
  desc?: string;
  widget: FieldWidget;
  kind: FieldSpec['kind'];
  /** 枚举取值（widget=enum）。 */
  values?: readonly string[];
  min?: number;
  max?: number;
  int?: boolean;
  maxLen?: number;
  maxItems?: number;
  /** 默认值（对象/数组给完整结构，标量给标量）。 */
  default: unknown;
  /** 数组元素是标量还是对象。 */
  item?: FieldDescribe;
  /** 对象内部字段（widget=object）。 */
  fields?: FieldDescribe[];
}

export interface GroupDescribe {
  key: string;
  label: string;
  desc?: string;
  fields: FieldDescribe[];
}

/** 面板用的完整描述（顶层分组顺序与 spec 一致）。 */
export function describeConfig(): GroupDescribe[] {
  const root = SPEC as ObjectSpec;
  const groups: GroupDescribe[] = [];
  for (const [key, field] of Object.entries(root.fields)) {
    if (field.kind !== 'object') continue;
    if (key === 'version') continue;
    groups.push({
      key,
      label: field.label,
      ...(field.desc ? { desc: field.desc } : {}),
      fields: Object.entries(field.fields).map(([name, child]) => describeField(child, name)),
    });
  }
  return groups;
}

function describeField(spec: FieldSpec, path: string): FieldDescribe {
  const base: FieldDescribe = {
    path,
    label: spec.label,
    widget: widgetOf(spec),
    kind: spec.kind,
    default: defaultOf(spec),
  };
  if (spec.desc) base.desc = spec.desc;

  switch (spec.kind) {
    case 'string':
      if (spec.maxLen !== undefined) base.maxLen = spec.maxLen;
      if (spec.pattern && /\\d\{2\}.*\\d\{2\}|\^\d/.test(spec.pattern.source) && spec.patternMessage?.includes('HH')) {
        base.widget = 'time';
      }
      break;
    case 'number':
      if (spec.min !== undefined) base.min = spec.min;
      if (spec.max !== undefined) base.max = spec.max;
      if (spec.int) base.int = true;
      break;
    case 'enum':
      base.values = spec.values;
      break;
    case 'array':
      if (spec.maxItems !== undefined) base.maxItems = spec.maxItems;
      base.item = describeField(spec.item, `${path}[]`);
      break;
    case 'object': {
      const fields: FieldDescribe[] = [];
      for (const [name, child] of Object.entries(spec.fields)) fields.push(describeField(child, `${path}.${name}`));
      base.fields = fields;
      break;
    }
    default:
      break;
  }
  return base;
}

function widgetOf(spec: FieldSpec): FieldWidget {
  switch (spec.kind) {
    case 'string':
      return spec.secret ? 'password' : 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'enum';
    case 'array':
      return spec.item.kind === 'string' ? 'string-list' : 'object-list';
    case 'object':
      return 'object';
    default:
      return 'text';
  }
}

function defaultOf(spec: FieldSpec): unknown {
  return buildDefaults(spec);
}

/** 把默认配置也带上（面板「恢复默认」不必自己拼）。 */
export function describeConfigWithDefaults(): { groups: GroupDescribe[]; defaults: unknown } {
  return { groups: describeConfig(), defaults: buildDefaults() };
}
