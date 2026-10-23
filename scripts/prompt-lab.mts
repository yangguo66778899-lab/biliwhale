/**
 * P3 的「尺子」：固定几条视频材料，反复只走「写评论 + 写日记」，不跑完整流程、不发任何东西。
 *
 * 为什么不用「跑一轮」来测提示词：一轮里有取数、初筛、判分、闸门、风控……变量太多，
 * 改一句提示词根本看不出是哪句起了作用。这里只保留「深读材料 → 模型写东西」这一段，
 * 一次跑 N 轮，把结果摆在一起看。
 *
 * 用法：
 *   npm run prompt:lab -- --times 3                  # 用真实 key（BILIWHALE_API_KEY）
 *   npm run prompt:lab -- --times 2 --fixtures       # 离线：假模型，只验证工具本身
 *   npm run prompt:lab -- --times 3 --videos 2       # 只跑前 2 条材料
 *
 * 产物：.run/prompt-lab/<时间戳>/{<bvid>/run-<n>/*.md, index.md}
 * 不做什么：不发评论、不写正式报告、不写日记到数据目录、不改 state。
 */

import fs from 'node:fs';
import path from 'node:path';

import { validateConfig } from '../src/config/validate.ts';
import { SecretsService } from '../src/config/secrets.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { buildDeepPrompt } from '../src/orchestrator/prompts.ts';
import { LlmClient } from '../src/llm/client.ts';
import { selfCheck } from '../src/agent/selfCheck.ts';
import { countEmoji } from '../src/shared/biliEmoji.ts';
import { Logger } from '../src/shared/logger.ts';
import type { BiliVideo, CommentItem, DeepRead, RoundResult } from '../src/shared/types.ts';

interface LabFixture {
  bvid: string;
  title: string;
  up: string;
  durationSec: number;
  pubdateIso: string;
  desc?: string;
  subtitle?: string;
  comments?: Array<{ uname?: string; message: string; like?: number }>;
}

interface LabArgs {
  times: number;
  videos: number;
  fixtures: boolean;
  out: string;
  model?: string;
}

function parseArgs(argv: string[]): LabArgs {
  const args: LabArgs = { times: 2, videos: 99, fixtures: false, out: path.join('.run', 'prompt-lab') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 后面要跟一个值`);
      i += 1;
      return value;
    };
    if (arg === '--times') args.times = Number(next());
    else if (arg === '--videos') args.videos = Number(next());
    else if (arg === '--fixtures') args.fixtures = true;
    else if (arg === '--out') args.out = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：npm run prompt:lab -- [--times 3] [--videos 2] [--fixtures] [--model deepseek-chat] [--out 目录]');
      process.exit(0);
    } else throw new Error(`不认识的参数：${arg}`);
  }
  if (!Number.isFinite(args.times) || args.times < 1 || args.times > 10) throw new Error('--times 要在 1–10 之间');
  return args;
}

function loadFixtures(dir: string): LabFixture[] {
  if (!fs.existsSync(dir)) throw new Error(`找不到材料目录：${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`${dir} 里没有 .json 材料`);
  return files.map((name) => {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as LabFixture;
    if (!raw.bvid || !raw.title) throw new Error(`${name} 缺 bvid 或 title`);
    return raw;
  });
}

function toVideo(f: LabFixture): BiliVideo {
  return {
    bvid: f.bvid,
    aid: Number(f.bvid.replace(/\D/gu, '').slice(0, 8) || 1),
    cid: 1,
    title: f.title,
    desc: f.desc ?? '',
    durationSec: f.durationSec,
    pubdateIso: f.pubdateIso,
    owner: { mid: 1, name: f.up },
    stats: { view: 0, like: 0, reply: 0, favorite: 0, coin: 0, share: 0 },
    coverUrl: 'about:blank',
  };
}

function toComments(f: LabFixture): CommentItem[] {
  return (f.comments ?? []).map((c, index) => ({
    rpid: String(index + 1),
    parent: '0',
    root: '0',
    mid: 100 + index,
    uname: c.uname ?? `观众${index + 1}`,
    message: c.message,
    like: c.like ?? 0,
    ctimeIso: f.pubdateIso,
    replies: [],
  }));
}

function toDeepRead(f: LabFixture): DeepRead {
  const subtitle = f.subtitle ?? '';
  return { bvid: f.bvid, subtitle, subtitleChars: subtitle.length, comments: toComments(f), video: toVideo(f) };
}

/** 离线假模型：返回一份形状正确的深读 JSON（只为验证工具本身，不代表任何写作质量）。 */
function fakeFetch(): (input: string) => Promise<Response> {
  return async () => {
    const content = JSON.stringify({
      selected: [
        {
          bvid: 'BV1lab000001',
          score: 14,
          why: '这段拼贴剪得紧，音效踩在点上',
          oneliner: '四分半不拖一秒',
          share: { channel: 'none', text: '', reason: '' },
          comment: { want: true, text: '这刀接得真狠[doge]' },
        },
      ],
      skipped: [],
      favorite: null,
      dynamic: null,
      diary: {
        public: '今天翻到一条鬼畜，四分半一点空档都没有。那个「所有人退后」接「俺是耕田」，听着就笑了。',
        private: '偏好校准：这种拼贴我确实爱看，下次多翻一点。',
      },
      report_md: '这一轮翻了 1 条，挑中 1 条。',
      notify: '挑中一条',
      notes: '',
    });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  };
}

function systemText(): string {
  const read = (name: string): string => fs.readFileSync(path.join('src', 'prompts', name), 'utf8');
  return `${read('system.md').trim()}\n\n---\n\n${read('charter.md').trim()}\n`;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function labLogger(): Logger {
  const dir = path.join('.run', 'prompt-lab', '_logs');
  fs.mkdirSync(dir, { recursive: true });
  return new Logger({ logDir: dir, eventsFile: path.join(dir, 'events.jsonl'), level: 'warn' });
}

/**
 * 取 key：和内核一模一样的顺序——环境变量优先，其次数据目录里的 secrets.json。
 * 这样在面板里填过 key 的人直接就能跑，不必再贴一遍（也免得 key 出现在命令行历史里）。
 * 只读，绝不打日志/回显。
 */
function resolveApiKey(logger: Logger, allowFixtures: boolean): string {
  if (allowFixtures) return process.env.BILIWHALE_API_KEY?.trim() || 'fixtures';
  const paths = resolvePaths(process.env.BILIWHALE_DATA_DIR ? { dataDir: process.env.BILIWHALE_DATA_DIR } : {});
  const fromStore = new SecretsService(paths.dataDir, logger).apiKey();
  if (fromStore) {
    console.log(`用面板里存的 key（${paths.dataDir}）`);
    return fromStore;
  }
  const fromEnv = process.env.BILIWHALE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    [
      '找不到 DeepSeek key。三种给法（任选一种）：',
      '  1) 面板「设置 → 模型与花费 → API key」填一次，然后直接跑这个命令（会读你机器上已存的）；',
      `  2) 临时环境变量：$env:BILIWHALE_API_KEY = "sk-…"（只对当前窗口有效）`,
      '  3) 永久：setx BILIWHALE_API_KEY "sk-…"（新开窗口才生效）',
      `  查过的地方：${paths.dataDir}\\secrets.json 与环境变量 BILIWHALE_API_KEY`,
      '  不想用 key：加 --fixtures（假模型，只验证工具本身）',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = loadFixtures(path.join('fixtures', 'prompt-lab')).slice(0, args.videos);
  const configResult = validateConfig({ share: { enabled: true, comment: { plain: true } } });
  if (!configResult.ok) throw new Error(`默认配置不合法：${JSON.stringify(configResult.issues)}`);
  const config = configResult.value;

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  const outDir = path.join(args.out, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const logger = labLogger();
  const apiKey = resolveApiKey(logger, args.fixtures);
  const llm = new LlmClient({
    apiKey,
    baseUrl: process.env.BILIWHALE_BASE_URL ?? 'https://api.deepseek.com',
    model: args.model ?? process.env.BILIWHALE_MODEL ?? 'deepseek-chat',
    temperature: 0.8,
    maxTokens: 3000,
    timeoutMs: 120_000,
    maxRetries: 1,
    logger,
    ...(args.fixtures ? { fetchImpl: fakeFetch() as never } : {}),
  });

  const system = systemText();
  const index: string[] = [`# prompt lab · ${stamp}`, '', `材料 ${fixtures.length} 条 × 每轮 ${args.times} 轮`, ''];

  for (const fixture of fixtures) {
    const deepReads = [toDeepRead(fixture)];
    const prompt = buildDeepPrompt({ deepReads, screen: [], lightReads: [], config, dryRun: false });
    fs.mkdirSync(path.join(outDir, fixture.bvid), { recursive: true });
    fs.writeFileSync(path.join(outDir, fixture.bvid, 'prompt.md'), prompt, 'utf8');

    for (let run = 1; run <= args.times; run += 1) {
      const completion = await llm.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        jsonMode: true,
        maxTokens: 3000,
      });
      const dir = path.join(outDir, fixture.bvid, `run-${run}`);
      fs.mkdirSync(dir, { recursive: true });
      if (!completion.ok) {
        fs.writeFileSync(path.join(dir, 'error.txt'), completion.error.message, 'utf8');
        index.push(`- ${fixture.bvid} run-${run}：失败（${completion.error.message}）`);
        continue;
      }
      fs.writeFileSync(path.join(dir, 'raw.txt'), completion.data.content, 'utf8');
      const json = extractJson(completion.data.content);
      if (!json) {
        index.push(`- ${fixture.bvid} run-${run}：模型没回 JSON`);
        continue;
      }
      const parsed = json as unknown as RoundResult;
      const diary = parsed.diary ?? { public: '', private: '' };
      fs.writeFileSync(path.join(dir, 'diary-public.md'), diary.public ?? '', 'utf8');
      fs.writeFileSync(path.join(dir, 'diary-private.md'), diary.private ?? '', 'utf8');
      const comment = parsed.selected?.[0]?.comment;
      const share = parsed.selected?.[0]?.share;
      fs.writeFileSync(path.join(dir, 'comment.md'), comment?.text ?? '（这轮没写评论）', 'utf8');
      fs.writeFileSync(path.join(dir, 'share.md'), share?.text ?? '（这轮没写 @ 文案）', 'utf8');

      const issues = selfCheck({
        diary: { public: diary.public ?? '', private: diary.private ?? '' },
        comments: [
          ...(comment?.text ? [{ bvid: fixture.bvid, kind: 'plain' as const, text: comment.text }] : []),
          ...(share?.text ? [{ bvid: fixture.bvid, kind: 'share' as const, text: share.text }] : []),
        ],
        maxCommentChars: config.share.comment.maxChars,
        maxShareChars: config.share.comment.maxChars,
      });
      const text = comment?.text ?? '';
      index.push(
        `- ${fixture.bvid} run-${run}：评论 ${Array.from(text).length} 字 · 句号 ${/[。．]\s*$/u.test(text) ? '有' : '无'} · 表情 ${countEmoji(text)} 个 · 自检 ${issues.length === 0 ? '通过' : `${issues.length} 处（${issues.map((i) => i.key).join('、')}）`}`,
      );
    }
    index.push('');
  }

  index.push('## 怎么看', '', '- 每个 `run-*/comment.md` 是她打算发的评论；`diary-public.md` / `diary-private.md` 是两本日记。', '- `prompt.md` 是这一条材料的完整输入（改提示词后可以 diff 它）。', '');
  fs.writeFileSync(path.join(outDir, 'index.md'), index.join('\n'), 'utf8');
  console.log(`跑完了：${outDir}`);
  console.log(`先看 ${path.join(outDir, 'index.md')}`);
}

main().catch((err: unknown) => {
  console.error(`prompt lab 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
