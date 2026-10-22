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
  /** **绝对路径**（从配置根开始，如 `share.enabled`）：面板读写配置只认这个。 */
  path: string;
  /** 相对路径（相对于它所在的对象/数组元素，如 `enabled`）：编辑嵌套对象时用这个。 */
  relPath: string;
  label: string;
  desc?: string;
  widget: FieldWidget;
  kind: FieldSpec['kind'];
  /** 枚举取值（widget=enum）。值本身是配置里真正用的英文枚举。 */
  values?: readonly string[];
  /** 枚举取值的中文显示名（面板只显示这个，不把英文枚举摆到用户面前）。 */
  valueLabels?: Readonly<Record<string, string>>;
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
    if (field.hidden) continue;
    groups.push({
      key,
      label: field.label,
      ...(field.desc ? { desc: field.desc } : {}),
      // 组内字段的绝对路径必须是 `组.字段`：面板保存时按它写回配置。
      // （曾经这里只给了字段名，结果面板把值写到了顶层垃圾字段上，开关永远打不开。）
      fields: Object.entries(field.fields)
        .filter(([, child]) => !child.hidden)
        .map(([name, child]) => describeField(child, `${key}.${name}`, name)),
    });
  }
  return groups;
}

function describeField(spec: FieldSpec, absPath: string, relPath: string): FieldDescribe {
  const base: FieldDescribe = {
    path: absPath,
    relPath,
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
      if (spec.valueLabels) base.valueLabels = spec.valueLabels;
      break;
    case 'array':
      if (spec.maxItems !== undefined) base.maxItems = spec.maxItems;
      // 数组元素：绝对路径带 `[]` 只是为了好看；面板编辑元素时用 relPath（从元素自己算起）
      base.item = describeField(spec.item, `${absPath}[]`, '');
      break;
    case 'object': {
      const fields: FieldDescribe[] = [];
      for (const [name, child] of Object.entries(spec.fields)) {
        // relPath 永远相对「它所在的那个对象」：面板编辑嵌套对象时按它取值/写值
        if (child.hidden) continue;
        fields.push(describeField(child, `${absPath}.${name}`, name));
      }
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
