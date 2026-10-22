/**
 * 「今天不想看」的醒来。
 *
 * 职责：跳过分支醒来一次——不取候选、不分享，只写两本日记 + 一条通知 + 一轮运行记录。
 *   日记优先让模型写（一两句，像人话）；模型不可用时用确定性文本兜底，绝不留空。
 * 不做什么：不打分、不取候选、不发任何东西。
 */

import type { RoundDeps } from './round.ts';
import type { RunRecord, RoundResult, RunTrigger } from '../shared/types.ts';
import { extractJson } from '../agent/output.ts';
import { loadPromptAssets } from '../agent/prompts.ts';
import { appendNotifyLog, writeDiary, writeReport } from './writers.ts';
import { localDate, localIso, formatHhmm } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';

const MIN_DIARY_CHARS = 10;

export interface SkipRoundInput {
  trigger: RunTrigger;
  reason: string;
  now?: Date;
}

export async function runSkipRound(deps: RoundDeps, input: SkipRoundInput): Promise<RunRecord> {
  const now = input.now ?? new Date();
  const date = localDate(now);
  const label = `${formatHhmm(now.getHours() * 60 + now.getMinutes())} · 醒来但不想看`;
  const cfg = deps.config.get();
  // 跳过分支本来就不写任何远端内容；这里的 dryRun 只影响报告措辞，按真实配置报，别误导。
  const dryRun = cfg.safety.dryRun;
  const record = deps.runs.start({ trigger: input.trigger, dryRun, configuredModel: deps.llm.model });

  const written = await writeSkipDiaries(deps, { date, label, reason: input.reason, now });
  const usage = written.usage;

  const result: RoundResult = {
    selected: [],
    skipped: [],
    favorite: null,
    dynamic: null,
    diary: { public: written.public, private: written.private },
    report_md: '',
    notify: written.notify,
    notes: written.degraded ? `模型没写成，用了确定性文本：${written.error ?? ''}` : '',
  };

  try {
    writeReport(deps.paths, {
      date,
      roundLabel: label,
      level: cfg.report.level,
      result,
      counts: { candidates: 0, screened: 0, deepRead: 0, selected: 0, shared: 0, skippedNoSubtitle: 0 },
      videos: new Map(),
      shareDecisions: new Map(),
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costCny: 0 },
      dryRun,
      notes: [input.reason, '今天没取候选、没分享（跳过分支）'],
    });
    appendNotifyLog(deps.paths, written.notify);
  } catch (err) {
    deps.logger.error('skip', `跳过分支落盘失败：${humanError(err)}`);
  }

  deps.logger.event('skip', `今天不想看：${input.reason}`, { target: 'scheduler' });

  const finished = deps.runs.finish(
    {
      ...record,
      model: {
        configured: deps.configuredModel ?? deps.llm.model,
        actual: deps.llm.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        calls: written.calls,
        costCny: 0,
      },
      notes: [...record.notes, input.reason],
    },
    written.degraded ? 'degraded' : 'ok',
  );
  deps.state.noteRun(finished.status, localIso(now));
  deps.state.addUsage({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costCny: 0, calls: written.calls });
  return finished;
}

interface DiaryOutcome {
  public: string;
  private: string;
  notify: string;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
  calls: number;
  degraded: boolean;
  error?: string;
}

async function writeSkipDiaries(
  deps: RoundDeps,
  input: { date: string; label: string; reason: string; now: Date },
): Promise<DiaryOutcome> {
  const cfg = deps.config.get();
  const assets = loadPromptAssets(deps.paths, cfg);
  const empty = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

  const system = `${assets.system.trim()}\n\n---\n\n# 今天的状态\n\n今天是「不想看」的一天：不取候选、不分享，只醒来写两句。\n\n# 人设\n\n${assets.persona}`;
  const user = [
    `日期：${input.date}（${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][input.now.getDay()]}）`,
    `原因：${input.reason}`,
    '',
    '写两本短日记，只输出 JSON：',
    '```json',
    '{"public":"给用户看的，2–3 句，说清今天为什么不想看（具体，别套话）","private":"给自己看的，不加滤镜，必须有一行「偏好校准：…」","notify":"给用户的一条推送，一句人话"}',
    '```',
  ].join('\n');

  try {
    const res = await deps.llm.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      jsonMode: true,
      maxTokens: Math.min(cfg.llm.maxTokens, 900),
      temperature: 0.9,
    });
    if (res.ok) {
      const parsed = extractJson(res.data.content);
      const outcome = readDiary(parsed);
      if (outcome) {
        writeDiary(deps.paths, { date: input.date, label: input.label, kind: 'public', title: cfg.diary.publicTitle, body: outcome.public });
        writeDiary(deps.paths, { date: input.date, label: input.label, kind: 'private', title: cfg.diary.privateTitle, body: outcome.private });
        return {
          public: outcome.public,
          private: outcome.private,
          notify: outcome.notify,
          usage: res.data.usage,
          calls: 1,
          degraded: false,
        };
      }
      return fallbackDiaries(deps, input, '模型给的日记不合规', res.data.usage, 1);
    }
    return fallbackDiaries(deps, input, res.error.message, empty, 0);
  } catch (err) {
    return fallbackDiaries(deps, input, humanError(err), empty, 0);
  }
}

function readDiary(parsed: unknown): { public: string; private: string; notify: string } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const pub = typeof obj.public === 'string' ? obj.public.trim() : '';
  const priv = typeof obj.private === 'string' ? obj.private.trim() : '';
  if (pub.length < MIN_DIARY_CHARS || priv.length < MIN_DIARY_CHARS) return null;
  const notify = typeof obj.notify === 'string' && obj.notify.trim().length > 0 ? obj.notify.trim() : '今天不想看，日记照写了。';
  return { public: pub, private: priv, notify };
}

function fallbackDiaries(
  deps: RoundDeps,
  input: { date: string; label: string; reason: string; now: Date },
  error: string,
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
  calls: number,
): DiaryOutcome {
  const cfg = deps.config.get();
  const pub = `今天没看。${input.reason}\n\n不是没时间，是今天不想把注意力交出去。日记照写，明天再看。`;
  const priv = `今天跳过：${input.reason}（${input.date}）。\n\n偏好校准：今天没有新证据，不改判断。如果连续几天都不想看，说明该让用户调一下关键词或阈值了。\n\n（说明：模型这次没写成，这段是确定性兜底文本）`;
  try {
    writeDiary(deps.paths, { date: input.date, label: input.label, kind: 'public', title: cfg.diary.publicTitle, body: pub });
    writeDiary(deps.paths, { date: input.date, label: input.label, kind: 'private', title: cfg.diary.privateTitle, body: priv });
  } catch (err) {
    deps.logger.error('skip', `兜底日记写入失败：${humanError(err)}`);
  }
  return {
    public: pub,
    private: priv,
    notify: `今天不想看，日记写好了（${input.reason}）。`,
    usage,
    calls,
    degraded: true,
    error,
  };
}
