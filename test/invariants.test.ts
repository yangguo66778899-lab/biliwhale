import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把需求文档里的硬约束变成自动检查。
 * 这些断言故意写成「扫源码」，因为它们要防的正是「有人不小心把不该有的东西加回来」。
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const FIXTURES = path.join(ROOT, 'fixtures');

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function grep(files: string[], pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (pattern.test(text)) hits.push({ file: path.relative(ROOT, file), line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

const SOURCE_FILES = walk(SRC, ['.ts']);
const ALL_TEXT = walk(SRC, ['.ts', '.md']);

test('C1：不 import 任何 @deepseek-ai/*，也不引用 DSH 概念', () => {
  const hits = grep(SOURCE_FILES, /@deepseek-ai|from ['"]dsh|dshdesktop|sessionController/i);
  assert.deepEqual(hits, [], `源码里不该出现 DSH 依赖：${JSON.stringify(hits)}`);
});

test('零 Python：源码里不 spawn python / 不调用 pip / venv', () => {
  const hits = grep(ALL_TEXT, /\bpython(3)?\b|py -3|\bpip install\b|venv|whisper/i);
  assert.deepEqual(hits, [], `不该有任何 Python 依赖：${JSON.stringify(hits)}`);
});

test('M0 不启动子进程：没有 child_process 的 spawn/exec/execFile', () => {
  // 注意用 (?<!\.) 排除 RegExp#exec —— 那是正则方法，不是进程
  const hits = grep(SOURCE_FILES, /child_process|spawnSync\s*\(|(?<!\.)\bspawn\s*\(|execFile\s*\(|execSync\s*\(|(?<!\.)\bexec\s*\(/);
  assert.deepEqual(hits, [], `M0 不该有子进程：${JSON.stringify(hits)}`);
});

test('C3：源码与夹具里没有直播 / 弹幕相关字段或能力', () => {
  const hits = grep([...ALL_TEXT, ...walk(FIXTURES, ['.json', '.ts'])], /danmaku|直播间|liveRoom|live_info|\/xlive\//i);
  assert.deepEqual(hits, [], `C3 要求直播与弹幕为零：${JSON.stringify(hits)}`);
});

test('M0 没有任何写 B 站的接口路径', () => {
  const writeEndpoints = [
    '/x/v2/reply/add',
    '/x/v2/reply/del',
    '/x/v2/reply/action',
    '/x/relation/modify',
    '/x/v3/fav/resource/deal',
    '/x/dynamic/feed/create',
    '/x/web-interface/dynamic/publish',
    '/msg/send/msg',
    '/x/click-interface/web/heartbeat',
  ];
  const hits = grep(SOURCE_FILES, new RegExp(writeEndpoints.map((e) => e.replace(/[/.]/g, '\\$&')).join('|')));
  assert.deepEqual(hits, [], `M0 代码里不该存在写接口：${JSON.stringify(hits)}`);

  // 也不允许「非 GET」的业务请求：http 层只给 api 层留了 GET 的用法
  const postHits = grep(SOURCE_FILES, /method:\s*['"]POST['"]/);
  const allowed = postHits.filter((hit) => hit.file.includes('llm') || hit.file.includes('shared'));
  assert.deepEqual(
    postHits.filter((h) => !allowed.includes(h)),
    [],
    `B 站请求不该用 POST：${JSON.stringify(postHits)}`,
  );
});

test('零运行时依赖：package.json 只有 typescript 与 @types/node', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'M0 不允许引入运行时依赖');
  const dev = Object.keys(pkg.devDependencies ?? {}).sort();
  assert.deepEqual(dev, ['@types/node', 'typescript'], `开发依赖应只有类型与编译器，实际：${dev.join(',')}`);
});

test('凭据与密钥不会出现在源码常量里', () => {
  const hits = grep(ALL_TEXT, /SESSDATA\s*=\s*[A-Za-z0-9%]{10,}|sk-[A-Za-z0-9]{20,}/);
  assert.deepEqual(hits, [], `源码里不该有真凭据：${JSON.stringify(hits)}`);
});

test('必需的文件都在（运行说明、许可证、归属、架构、接口规格）', () => {
  for (const file of ['README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'docs/ARCHITECTURE.md', 'docs/bili-readonly-api-spec.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `缺少 ${file}`);
  }
});
