import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeConfig } from '../src/config/describe.ts';
import { SPEC } from '../src/config/spec.ts';
import type { FieldDescribe, GroupDescribe } from '../src/config/describe.ts';

/**
 * P1 文案规范（清单 §5.1）的回归测试。
 *
 * 目标读者是「能自己下载、愿意配置，但不懂这个项目、不懂技术」的人。所以：
 *   - 每个出现在面板上的字段都必须有中文标签 + 一句说明（说明改了会发生什么）；
 *   - 面板上的标签/选项不许直接摆英文枚举（full / auto / dm …）；
 *   - 还没接线的字段不许摆出来（那就是「点了没用」的假开关）。
 */

const CJK = /[\u4e00-\u9fa5]/;

function walkFields(group: GroupDescribe, visit: (field: FieldDescribe) => void): void {
  const recurse = (field: FieldDescribe): void => {
    visit(field);
    for (const child of field.fields ?? []) recurse(child);
    if (field.item) recurse(field.item);
  };
  for (const field of group.fields) recurse(field);
}

test('面板上每个字段都有中文标签和一句说明', () => {
  const groups = describeConfig();
  assert.ok(groups.length >= 10, `分组太少：${groups.length}`);
  const problems: string[] = [];
  // 「要说明」的范围：分组下的叶子字段（含数组整体），以及子分组里的叶子字段。
  // 数组里的每一项（[].xxx）会跟着整体说明走，不再单独要求——否则会写出「填 20:00」这种废话。
  const check = (field: FieldDescribe, inArray: boolean): void => {
    if (!inArray && field.kind !== 'object') {
      if (!field.desc || field.desc.trim().length === 0) problems.push(`${field.path} 没有说明（用户会不知道填什么）`);
    }
    if (!CJK.test(field.label)) problems.push(`${field.path} 的标题不是中文：「${field.label}」`);
    if (field.label.trim().length === 0 || field.label === field.path) problems.push(`${field.path} 的标题是空的/等于路径`);
    for (const child of field.fields ?? []) check(child, inArray);
    if (field.item) check(field.item, true);
  };
  for (const group of groups) {
    assert.match(group.label, CJK, `分组 ${group.key} 的标题要是中文`);
    for (const field of group.fields) check(field, false);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('面板上不出现英文枚举值：枚举字段必须有中文显示名', () => {
  const problems: string[] = [];
  for (const group of describeConfig()) {
    walkFields(group, (field) => {
      if (field.widget !== 'enum') return;
      const values = field.values ?? [];
      assert.ok(values.length > 0, `${field.path} 是枚举但没有取值`);
      for (const value of values) {
        const label = field.valueLabels?.[value];
        if (!label) problems.push(`${field.path} 的取值「${value}」没有中文显示名`);
        else if (!CJK.test(label)) problems.push(`${field.path} 的取值「${value}」显示名不是中文：「${label}」`);
      }
    });
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('没接线的字段不出现在面板上（不许给用户一个点了没用的开关）', () => {
  const groups = describeConfig();
  const visible = new Set<string>();
  for (const group of groups) walkFields(group, (field) => visible.add(field.path));

  const shouldHide = [
    'app.locale',
    'app.logLevel',
    'app.tray',
    'app.singleInstance',
    'app.proxy',
    'app.dataDir',
    'account.cookieRef',
    'content.searchDays',
    'content.sources.favorites',
    'score.dimensions',
    'share.decayPerDay',
    'share.dm.merge',
    'listen.comment.allDay',
    'listen.comment.oncePerPerson',
    'listen.dm.ownerOnly',
    'diary.enabled',
    'report.dir',
    'safety.requireConfirm',
    'ui.openBrowserOnStart',
    'logging.redact',
  ];
  const leaked = shouldHide.filter((path) => visible.has(path));
  assert.deepEqual(leaked, [], `这些字段还没接线，不该出现在面板上：${leaked.join('、')}`);

  // 字段本身还在 spec 里（老配置照常能读），只是 hidden
  for (const path of shouldHide) {
    const parts = path.split('.');
    let cursor: unknown = SPEC;
    for (const part of parts) {
      const fields = (cursor as { fields?: Record<string, unknown> }).fields;
      assert.ok(fields, `${path} 的路径不对`);
      cursor = fields[part];
      assert.ok(cursor, `spec 里丢了字段 ${path}`);
    }
    assert.equal((cursor as { hidden?: boolean }).hidden, true, `${path} 应该标成 hidden`);
  }
});

test('危险操作与数字字段的文案带单位/范围（§5.1）', () => {
  const byPath = new Map<string, FieldDescribe>();
  for (const group of describeConfig()) walkFields(group, (field) => byPath.set(field.path, field));

  const dailyCap = byPath.get('share.dailyCap');
  assert.ok(dailyCap, '缺 share.dailyCap');
  assert.match(dailyCap?.label ?? '', /条|几次|多少/, '要说清在数什么');
  assert.match(dailyCap?.label ?? '', /0–10|0-10/, '要把范围写出来');

  const kill = byPath.get('safety.killSwitch');
  assert.ok(kill, '缺 safety.killSwitch');
  assert.match(kill?.desc ?? '', /停|不写|立刻/, '急停要写清后果');

  const dryRun = byPath.get('safety.dryRun');
  assert.ok(dryRun, '缺 safety.dryRun');
  assert.match(dryRun?.label ?? '', /演练|不真发/, '「一律预演」要翻译成人话');
});
