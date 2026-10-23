/**
 * 一轮的编排（Phase 0–10）。
 *
 * 职责：决定每个相位做什么、预算多少、失败怎么降级；所有落盘与记账由这里做。
 *   边界：**模型只读**。模型没有写通道，是否真写由 orchestrator 的闸门与执行器决定；
 *   也只会走闸门并在报告里写「本该发什么」。真正的执行是 M3。
 * 不做什么：不实现 B 站接口细节（bili 层）、不组装 prompt（prompts/prompts.ts）、不打分（模型）。
 */

import fs from 'node:fs';
import type { Logger } from '../shared/logger.ts';
import type { Config } from '../config/spec.ts';
import type { ConfigService } from '../config/service.ts';
import type { SecretsService } from '../config/secrets.ts';
import type { BiliApi } from '../bili/api.ts';
import type { LlmClient } from '../llm/client.ts';
import type { AppStateStore } from '../state/appState.ts';
import type { FeedbackLedger, QuotaLedger, SeenLedger } from '../state/ledgers.ts';
import type { PendingStore } from '../state/pending.ts';
import type { RepliedLedger } from '../state/replied.ts';
import type { BiliWriter } from '../bili/write.ts';
import { decideSilence } from '../state/ledgers.ts';
import type { RunStore } from '../state/runs.ts';
import type { Paths } from '../state/paths.ts';
import type {
  BiliVideo,
  Candidate,
  DeepRead,
  LightRead,
  PhaseRecord,
  PhaseStatus,
  RoundResult,
  RunCounts,
  RunRecord,
  RunTrigger,
  ScreenItem,
  ScreenResult,
  SkippedItem,
} from '../shared/types.ts';
import { localDate, localIso, formatHhmm } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';
import { collectCandidates } from './candidates.ts';
import { gateShare } from './gate.ts';
import type { GateDecision } from './gate.ts';
import { executePlainComments, executeShares, summarizeShares } from './share.ts';
import { resolveOwner } from '../account/owner.ts';
import type { ShareAttempt } from './share.ts';
import { autoApproveOwnerDrafts, scanStrangerReplies } from './pending.ts';
import { sendDmNotify } from './dm.ts';
import { executeFavorites } from './fav.ts';
import { likeVideo } from './like.ts';
import { buildDeepPrompt, buildScreenPrompt, clip, pickDeepReads } from './prompts.ts';
import { appendNotifyLog, writeArchive, writeDiary, writeReport, videoUrl, skipReasonText } from './writers.ts';
import { dispatchNotifications } from '../notify/index.ts';
import { buildWhyNot } from './whynot.ts';
import type { WhyNotOutcome } from './whynot.ts';
import { polishResult } from './polish.ts';
import { composeComments, composeDiary } from './compose.ts';
import { prepareVisuals } from '../media/frames.ts';
import type { VisualOverrides, VisualResult } from '../media/frames.ts';
import { buildSystemMessage, buildUserPreamble, loadPromptAssets } from '../agent/prompts.ts';
import type { PromptStatus } from '../agent/prompts.ts';
import { extractJson as extractJsonFromModule, fallbackRoundResult, validateRoundResult, validateScreenResult } from '../agent/output.ts';
import { runAgentLoop } from '../agent/loop.ts';
import { ToolRuntime } from '../agent/tools.ts';
import type { Usage } from '../llm/client.ts';

export interface RoundDeps {
  paths: Paths;
  config: ConfigService;
  secrets: SecretsService;
  logger: Logger;
  api: BiliApi;
  llm: LlmClient;
  state: AppStateStore;
  seen: SeenLedger;
  quota: QuotaLedger;
  feedback: FeedbackLedger;
  runs: RunStore;
  /** 写能力（M3）。 */
  writer: BiliWriter;
  /** 待审队列与「谁回过我们」。 */
  pending: PendingStore;
  replied: RepliedLedger;
  /** 测试注入：复核间隔（毫秒），默认 0/2s/6s。 */
  shareVerifyDelaysMs?: number[];
  /** 测试注入：写间隔与复核等待都跳过。 */
  skipWriteWait?: boolean;
  /** 测试注入：拟回复生成器。 */
  pendingDraft?: (input: { source: string; uname: string; videoTitle: string; maxChars: number }) => Promise<string | null>;
  /** 配置里写的模型名（用于 run 记录里的「配置 vs 实际」对照）。 */
  configuredModel?: string;
  /** 真实凭据不参与（夹具 / 模拟模型）：预检不强制 API key。 */
  noCredentialsNeeded?: boolean;
  /** 预检里追加一句模式说明（夹具 / 模拟模型 / 真实）。 */
  modeNote?: string;
  /** 测试注入：看画面的下载 / ffmpeg / 本地样片（不传就走真实实现）。 */
  media?: VisualOverrides;
  now?: () => Date;
}

export interface RoundOptions {
  trigger: RunTrigger;
  dryRun: boolean;
}

const DISK_MIN_BYTES = 50 * 1024 * 1024;

export async function runRound(deps: RoundDeps, options: RoundOptions): Promise<RunRecord> {
  const { logger } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const date = localDate(startedAt);
  const cfg = deps.config.get();
  // 「这一轮到底是不是预演」只算一次：手动预演（--dry / 面板「预演一轮」）或配置里的「一律预演」，
  // 两者任一为真就不真发。**提示词、报告、run 记录都必须用这同一个值**——
  // 以前这里写死过 true，结果真跑时报告也标「预演，未真的发」，模型还被提示按预演写文案。
  const effectiveDryRun = options.dryRun || cfg.safety.dryRun;
  const phases: PhaseRecord[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  const usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  /** 本轮还剩多少 token（§12.3 / 审计 §3.25）：四处循环共用这一个数。 */
  const remainingBudget = (): number => {
    const spent = usage.promptTokens + usage.completionTokens;
    return Math.max(1_000, cfg.llm.runBudgetTokens - spent);
  };

  let record = deps.runs.start({
    trigger: options.trigger,
    dryRun: effectiveDryRun,
    configuredModel: deps.configuredModel ?? deps.llm.model,
    now: now(),
  });
  const counts: RunCounts = { candidates: 0, screened: 0, deepRead: 0, selected: 0, shared: 0, skippedNoSubtitle: 0 };
  /** 真正发生的模型调用次数（一次 loop step = 一次 chat 调用），修复重试也算。 */
  let llmCalls = 0;
  /** 看画面的结果（§7.10）：写进 run 记录，只记状态与文件名，不存图片。 */
  let mediaRecord: RunRecord['media'] | undefined;
  /**
   * 写操作的**真实结果**：「今天为什么没做」只许写结果，不许写「会做」。
   * （2026-10-22 真机报告里同一页既写「点赞：会点第一条」又写「没点赞：风控冷却中」。）
   */
  let shareOutcome: WhyNotOutcome | null = null;
  let favOutcome: WhyNotOutcome | null = null;
  let likeOutcome: WhyNotOutcome | null = null;

  const markPhase = (name: string, ms: number, status: PhaseStatus, note?: string): void => {
    phases.push({ name, ms, status, ...(note ? { note } : {}) });
  };

  /** 记录一次 agent loop 的结果：累计调用次数与 token。 */
  const absorbLoop = (outcome: { data: { steps: number; usage: { promptTokens: number; completionTokens: number; cachedTokens: number } } }): void => {
    llmCalls += outcome.data.steps;
    usage.promptTokens += outcome.data.usage.promptTokens;
    usage.completionTokens += outcome.data.usage.completionTokens;
    usage.cachedTokens += outcome.data.usage.cachedTokens;
  };

  const finish = (status: RunRecord['status']): RunRecord => {
    const totalTokens = usage.promptTokens + usage.completionTokens;
    const costCny = Math.round((totalTokens / 1_000_000) * cfg.llm.pricePerMTokens * 1e6) / 1e6;
    record = {
      ...record,
      phases,
      errors,
      notes,
      counts,
      model: {
        configured: deps.configuredModel ?? deps.llm.model,
        actual: deps.llm.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        calls: llmCalls,
        costCny,
      },
      ...(mediaRecord ? { media: mediaRecord } : {}),
    };
    const done = deps.runs.finish(record, status);
    deps.state.noteRun(status, localIso(now()));
    deps.state.addUsage({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costCny,
      calls: llmCalls,
    });
    logger.event('round', `一轮结束：${status}`, {
      target: 'orchestrator',
      level: status === 'ok' ? 'info' : status === 'degraded' ? 'warn' : 'error',
      data: { runId: done.id, tokens: totalTokens, status },
    });
    return done;
  };

  // ---------------------------------------------------------------- Phase 0 预检
  const phase0 = Date.now();
  try {
    const problems: string[] = [];
    if (deps.modeNote) notes.push(deps.modeNote);
    if (!deps.noCredentialsNeeded && !deps.secrets.hasApiKey()) {
      problems.push('没有 DeepSeek API key（设 BILIWHALE_API_KEY 或写 secrets.json）');
    }
    if (!deps.secrets.hasCookie()) {
      notes.push('没有 B 站 cookie：字幕拿不到（匿名请求返回 0 条），关注动态也读不了；评论可以读');
    } else {
      // 有 cookie 就确认它还有效：失效时字幕会全空，用户只会看到「无字幕」，白烧 token
      const nav = await deps.api.nav();
      if (!nav.ok) notes.push(`登录态检查失败：${nav.error.message}（本轮继续按只读跑）`);
      else if (!nav.data.isLogin) notes.push('cookie 已失效（nav 显示未登录）：字幕会拿不到，建议重新登录后再跑');
      else if (nav.data.uname) notes.push(`登录态正常：${nav.data.uname}`);
    }

    // 每日预算（§7.13）：到 100% 不再开新轮；到 80% 提醒
    const budget = deps.state.get().budget;
    if (cfg.llm.dailyBudgetTokens > 0) {
      const pct = Math.round((budget.tokens / cfg.llm.dailyBudgetTokens) * 100);
      if (budget.tokens >= cfg.llm.dailyBudgetTokens) {
        problems.push(`今天 token 预算已用完（${budget.tokens}/${cfg.llm.dailyBudgetTokens}，${pct}%），今天不再开新轮`);
      } else if (pct >= 80) {
        notes.push(`今天 token 已用 ${pct}%，接近每日预算`);
      }
    }
    if (cfg.llm.dailyBudgetCny > 0 && budget.costCny >= cfg.llm.dailyBudgetCny) {
      problems.push(`今天花费预算已用完（¥${budget.costCny} / ¥${cfg.llm.dailyBudgetCny}），今天不再开新轮`);
    }
    try {
      const stat = fs.statfsSync(deps.paths.dataDir);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (free < DISK_MIN_BYTES) problems.push(`磁盘空间不足（剩 ${Math.round(free / 1024 / 1024)}MB）`);
    } catch {
      notes.push('磁盘空间没查成（不影响运行）');
    }
    if (cfg.safety.killSwitch) problems.push('急停开着（safety.killSwitch=true）');
    // 看画面开着时不写这句：真抽到（或没抽成）会在 Phase 5.5 给出准确的一句
    if (!cfg.media.frames) notes.push('不看画面：模型只读标题/简介/字幕/评论（设置 → 看画面 可以打开）');

    if (problems.length > 0) {
      for (const problem of problems) errors.push(`预检失败：${problem}`);
      markPhase('preflight', Date.now() - phase0, 'failed', problems.join('；'));
      writeFailureOutputs(deps, { date, label: roundLabel(startedAt), reason: problems.join('；'), trigger: options.trigger });
      appendNotifyLog(deps.paths, `今天没跑成：${problems.join('；')}`);
      logger.error('orchestrator', '预检失败，本轮直接结束', { problems });
      return finish('failed');
    }
    markPhase('preflight', Date.now() - phase0, 'ok');
  } catch (err) {
    markPhase('preflight', Date.now() - phase0, 'failed', humanError(err));
    errors.push(`预检异常：${humanError(err)}`);
    return finish('failed');
  }

  const assets = loadPromptAssets(deps.paths, cfg);

  // ---------------------------------------------------------------- Phase 1 上下文
  const phase1 = Date.now();
  const silence = decideSilence(deps.feedback.silenceDays(now()), cfg.share);
  const todayShares = deps.quota.sharesOn(date);
  const status: PromptStatus = {
    date,
    weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][startedAt.getDay()] ?? '',
    trigger: options.trigger,
    wakeReason: options.trigger === 'manual' ? '手动跑的一轮' : '作息到点',
    wakesToday: `${deps.state.get().today?.wakes ?? 0} 次`,
    sharesToday: `${todayShares}/${Math.min(silence.shareCap, cfg.share.dailyCap)} 条`,
    silence: silence.text,
    channels: cfg.share.enabled ? cfg.share.via : '都没开（只写报告与日记）',
    budget: `本轮 ${cfg.llm.runBudgetTokens} token`,
    dryRun: effectiveDryRun,
  };
  // 沉默太久时问一句「在忙吗」——只问一次（§10.3），问过就记账
  if (silence.askOnce && !deps.feedback.get().askedOnce) {
    notes.push('想问你一句：最近还在看这些吗？要是忙就先不看，我照常记日记（只问这一次）');
    deps.feedback.markAsked();
    deps.logger.event('silence', '沉默衰减：已问一次「在忙吗」', { target: 'round' });
  }

  const memoryLines = buildMemoryLines(deps, silence.text);
  const systemMessage = buildSystemMessage(assets);
  const preamble = buildUserPreamble({ status, config: cfg, assets, memoryLines });
  markPhase('context', Date.now() - phase1, 'ok');

  // ---------------------------------------------------------------- Phase 2 取候选
  const phase2 = Date.now();
  const collected = await collectCandidates({
    api: deps.api,
    config: cfg,
    seen: deps.seen,
    logger,
    hasCookie: deps.secrets.hasCookie(),
    now: now(),
  });
  counts.candidates = collected.candidates.length;
  errors.push(...collected.errors);
  notes.push(...collected.notes);
  const sourcesText = Object.entries(collected.perSource)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  const pagesText = collected.pages > 1 ? `翻了 ${collected.pages} 页 · ` : '';
  markPhase('candidates', Date.now() - phase2, collected.candidates.length > 0 ? 'ok' : 'degraded', `${pagesText}${sourcesText}`);
  logger.event('candidates', `取回 ${collected.candidates.length} 条候选`, {
    data: { sources: sourcesText, errors: collected.errors.length, pages: collected.pages },
  });

  if (collected.candidates.length === 0) {
    const reason = collected.errors.length > 0 ? `候选一个都没取到：${collected.errors.join('；')}` : '今天没有合适的候选';
    notes.push(reason);
    writeEmptyRoundOutputs(deps, { date, label: roundLabel(startedAt), reason, trigger: options.trigger, cfg, dryRun: effectiveDryRun });
    appendNotifyLog(deps.paths, `今天没挑出什么。${reason}`);
    return finish(collected.errors.length > 0 ? 'degraded' : 'ok');
  }

  // ---------------------------------------------------------------- Phase 3 轻读
  const phase3 = Date.now();
  const runtime = new ToolRuntime(deps.api, logger);
  const lightReads: LightRead[] = [];
  let lightDegraded = false;
  for (const candidate of collected.candidates.slice(0, cfg.content.screenLimit)) {
    const light = await lightRead(candidate, runtime);
    if (light === null) continue;
    if (light.degraded) lightDegraded = true;
    if (!light.subtitleAvailable) counts.skippedNoSubtitle += 1;
    lightReads.push(light);
  }
  markPhase('lightread', Date.now() - phase3, lightDegraded ? 'degraded' : 'ok', `${lightReads.length} 条`);

  if (lightReads.length === 0) {
    errors.push('轻读阶段没有留下任何条目（视频可能都被删了/私密了）');
    writeEmptyRoundOutputs(deps, {
      date,
      label: roundLabel(startedAt),
      reason: '轻读阶段所有候选都读不到内容',
      trigger: options.trigger,
      cfg,
      dryRun: effectiveDryRun,
    });
    return finish('degraded');
  }

  // ---------------------------------------------------------------- Phase 4 初筛
  const phase4 = Date.now();
  let screen: ScreenResult = deterministicScreen(lightReads, cfg);
  let screenDegraded = false;
  if (!cfg.score.enabled) {
    screen = {
      items: lightReads.map((item, index) => ({
        bvid: item.candidate.video.bvid,
        score: Math.max(20 - index, 1),
        reason: '判分关闭：按偏好命中与评论热度排序',
        deep: index < cfg.content.deepReadLimit,
      })),
      notes: '判分关闭（score.enabled=false）',
    };
    notes.push('判分关闭：按排序取前 N 条深读');
  } else {
    const screenUser = `${preamble}\n\n${buildScreenPrompt({ lightReads, config: cfg, notes: [] })}`;
    const first = await runAgentLoop({
      client: deps.llm,
      phase: 'screen',
      system: systemMessage,
      user: screenUser,
      runtime,
      limits: { maxSteps: Math.min(cfg.llm.maxSteps, 8), maxToolCalls: Math.min(cfg.llm.maxToolCalls, 10), remainingTokens: remainingBudget() },
      logger,
      jsonMode: true,
    });
    if (!first.ok) {
      errors.push(`初筛调用失败：${first.error.message}`);
      screen = deterministicScreen(lightReads, cfg);
      screenDegraded = true;
    } else {
      absorbLoop(first);
      const allowed = new Set(lightReads.map((i) => i.candidate.video.bvid));
      let parsed = validateScreenResult(extractJsonSafe(first.data.finalText), allowed);
      if (!parsed.ok) {
        logger.warn('orchestrator', `初筛输出不合规，修一次：${parsed.error.message}`);
        const repaired = await runAgentLoop({
          client: deps.llm,
          phase: 'screen',
          system: systemMessage,
          user: `${screenUser}\n\n# 上一次输出不合规\n程序拒绝了你上一次的输出：${parsed.error.message}\n请严格按格式重新输出 JSON，不要任何多余文字。`,
          runtime,
          limits: { maxSteps: 4, maxToolCalls: 4, remainingTokens: remainingBudget() },
          logger,
          jsonMode: true,
        });
        if (repaired.ok) {
          absorbLoop(repaired);
          parsed = validateScreenResult(extractJsonSafe(repaired.data.finalText), allowed);
        }
        if (!parsed.ok) {
          errors.push(`初筛输出不可用：${parsed.error.message}`);
          screen = deterministicScreen(lightReads, cfg);
          screenDegraded = true;
        } else {
          screen = parsed.data;
        }
      } else {
        screen = parsed.data;
      }
    }
    counts.screened = screen.items.length;
    markPhase('screen', Date.now() - phase4, screenDegraded ? 'degraded' : 'ok', `${screen.items.length} 条`);
    const topScore = screen.items.reduce((max, item) => Math.max(max, item.score), 0);
    logger.event('screen', `初筛 ${screen.items.length} 条，最高 ${topScore} 分`, {
      level: screenDegraded ? 'warn' : 'info',
      data: { items: screen.items.length, topScore, degraded: screenDegraded },
    });
  }

  if (!cfg.score.enabled) counts.screened = screen.items.length;

  // ---------------------------------------------------------------- Phase 5 深读
  const phase5 = Date.now();
  const deepTargets = pickDeepReads(screen.items, cfg.content.deepReadLimit);
  const deepReads: DeepRead[] = [];
  for (const target of deepTargets) {
    const video = await runtime.video(target.bvid);
    if (!video.ok) {
      errors.push(`深读取不到 ${target.bvid}：${video.error.message}`);
      continue;
    }
    const subs = await runtime.subtitleText(target.bvid);
    const comments = await runtime.topComments(target.bvid, 12);
    deepReads.push({
      bvid: target.bvid,
      subtitle: subs.ok ? subs.data.text : '',
      subtitleChars: subs.ok ? subs.data.chars : 0,
      comments: comments.ok ? comments.data.items : [],
      video: video.data,
    });
    if (!subs.ok) notes.push(`${target.bvid} 字幕读取失败：${subs.error.message}`);
    if (!comments.ok) notes.push(`${target.bvid} 评论读取失败：${comments.error.message}`);
  }
  counts.deepRead = deepReads.length;
  markPhase('deepread', Date.now() - phase5, deepReads.length > 0 ? 'ok' : 'degraded', `${deepReads.length} 条`);
  logger.event('deepread', `深读 ${deepReads.length} 条`, {
    level: deepReads.length > 0 ? 'info' : 'warn',
    data: { bvids: deepReads.map((d) => d.bvid) },
  });

  if (deepReads.length === 0) {
    errors.push('深读阶段一条也没读到');
    writeEmptyRoundOutputs(deps, { date, label: roundLabel(startedAt), reason: '深读阶段一条也没读到', trigger: options.trigger, cfg, dryRun: effectiveDryRun });
    return finish('degraded');
  }

  // ---------------------------------------------------------------- Phase 5.5 看画面（默认关）
  // 只对「深读里分最高的那条」抽帧：一次最多 2 张图（九宫格 + 字幕条），塞进深读请求。
  // 任何一步失败都只降级成纯文本（§7.10 硬性约束），**不让整轮失败**。
  const firstDeep = deepTargets[0];
  const firstRead = firstDeep ? (deepReads.find((item) => item.bvid === firstDeep.bvid) ?? null) : null;
  let visual: VisualResult | null = null;
  let mediaNote: string | null = null;
  if (cfg.media.frames) {
    const phaseVisual = Date.now();
    if (!firstRead) {
      mediaNote = '没看画面：这一轮没有深读的视频';
    } else if (deps.state.inReadCooldown(now())) {
      // 读刚被限流过：别再去撞，写操作不受影响（读/写冷却已分开）
      const until = clockOf(deps.state.readCooldownUntil());
      mediaNote = `没看画面：B 站刚限流过${until ? `（读冷却到 ${until}）` : ''}，这轮按纯文本跑`;
    } else {
      try {
        visual = await prepareVisuals(
          {
            config: cfg,
            paths: deps.paths,
            logger,
            playUrl: (bvid, cid) => deps.api.playUrl(bvid, cid),
            ...(deps.media ? { overrides: deps.media } : {}),
          },
          {
            bvid: firstRead.bvid,
            cid: firstRead.video.cid,
            title: firstRead.video.title,
            durationSec: firstRead.video.durationSec,
            hasSubtitles: firstRead.subtitleChars > 0,
          },
        );
        mediaNote = visual.note;
        mediaRecord = visual.record;
      } catch (err) {
        // prepareVisuals 约定自己不抛；万一抛了，也只降级，不让这一轮失败
        mediaNote = `没看画面：抽帧出错（${humanError(err)}）`;
      }
    }
    markPhase('frames', Date.now() - phaseVisual, visual?.status === 'ok' ? 'ok' : 'degraded', mediaNote ?? undefined);
    logger.event('media', mediaNote ?? '没看画面', {
      level: visual?.status === 'ok' ? 'info' : 'warn',
      data: { bvid: firstRead?.bvid ?? '', frames: visual?.record.frames ?? 0 },
    });
  }

  // ---------------------------------------------------------------- Phase 6+7 决策与写作
  const phase6 = Date.now();
  const visualInfo =
    visual && visual.status === 'ok' && firstRead
      ? {
          bvid: firstRead.bvid,
          title: firstRead.video.title,
          frames: visual.record.frames ?? cfg.media.frameCount,
          hasStrip: Boolean(visual.record.strip),
          hasSubtitles: firstRead.subtitleChars > 0,
        }
      : undefined;
  const deepUser = `${preamble}\n\n${buildDeepPrompt({
    deepReads,
    screen: screen.items,
    lightReads,
    config: cfg,
    dryRun: status.dryRun,
    ...(visualInfo ? { visual: visualInfo } : {}),
  })}`;
  const ctxForResult = {
    deepReadBvids: new Set(deepReads.map((d) => d.bvid)),
    maxVideos: cfg.content.maxVideos,
    shareChannels: cfg.share.enabled ? [cfg.share.via] : [],
    shareMaxChars: cfg.share.via === 'dm' ? cfg.share.dm.maxChars : cfg.share.comment.maxChars,
    scoreMin: cfg.share.minScore,
    commentPlain: cfg.share.enabled && cfg.share.comment.plain,
    commentMaxChars: cfg.share.comment.maxChars,
  };

  let result: RoundResult;
  let resultDegraded = false;
  const visualReserve = visual && visual.status === 'ok' ? visual.tokenReserve : 0;
  const deepRun = await runAgentLoop({
    client: deps.llm,
    phase: 'deep',
    system: systemMessage,
    user: deepUser,
    // 图片只随第一条深读请求发一次；「输出不合规重来一次」时不再重复附图（模型已经看过了）
    ...(visual && visual.status === 'ok' ? { userImages: visual.images } : {}),
    runtime,
    limits: {
      maxSteps: cfg.llm.maxSteps,
      maxToolCalls: cfg.llm.maxToolCalls,
      remainingTokens: Math.max(1_000, remainingBudget() - visualReserve),
    },
    logger,
  });

  if (!deepRun.ok) {
    errors.push(`决策与写作调用失败：${deepRun.error.message}`);
    result = fallbackRoundResult({ reason: deepRun.error.message, skipped: skippedFromScreen(screen, deepReads) });
    resultDegraded = true;
  } else {
    absorbLoop(deepRun);
    let parsed = validateRoundResult(extractJsonSafe(deepRun.data.finalText), ctxForResult);
    if (!parsed.ok) {
      logger.warn('orchestrator', `最终输出不合规，修一次：${parsed.error.message}`);
      const repaired = await runAgentLoop({
        client: deps.llm,
        phase: 'deep',
        system: systemMessage,
        user: `${deepUser}\n\n# 上一次输出不合规\n程序拒绝了你上一次的输出：${parsed.error.message}\n请严格按格式重新输出 JSON。`,
        runtime,
        limits: { maxSteps: Math.min(cfg.llm.maxSteps, 6), maxToolCalls: 4, remainingTokens: remainingBudget() },
        logger,
      });
      if (repaired.ok) {
        absorbLoop(repaired);
        parsed = validateRoundResult(extractJsonSafe(repaired.data.finalText), ctxForResult);
      }
      if (!parsed.ok) {
        errors.push(`最终输出不可用：${parsed.error.message}`);
        result = fallbackRoundResult({ reason: parsed.error.message, skipped: skippedFromScreen(screen, deepReads) });
        resultDegraded = true;
      } else {
        result = fillSkipped(parsed.data, screen, lightReads);
      }
    } else {
      result = fillSkipped(parsed.data, screen, lightReads);
    }
  }

  counts.selected = result.selected.length;
  markPhase('decide', Date.now() - phase6, resultDegraded ? 'degraded' : 'ok');
  logger.event('decision', `挑中 ${result.selected.length} 条`, {
    level: resultDegraded ? 'warn' : 'info',
    data: { selected: result.selected.map((s) => s.bvid), score: result.selected.map((s) => s.score) },
  });

  // ---------------------------------------------------------------- Phase 6.4 说话（P3）
  // 评论与日记各自单开一轮：深读那一次手上全是评价，写出来的话会变成评语。
  // 降级轮（模型已两次不可用）不再加两次调用，直接跳过。
  if (!resultDegraded) {
    try {
      const assets = loadPromptAssets(deps.paths, cfg);
      const persona = assets.persona;
      const owner = resolveOwner(cfg, deps.secrets.selfMid());
      const picked = result.selected[0];
      const pickedDeep = picked ? deepReads.find((deep) => deep.bvid === picked.bvid) : undefined;
      const wantsShare = Boolean(picked && picked.share && picked.share.channel === cfg.share.via);
      const wantsPlain = Boolean(cfg.share.enabled && cfg.share.comment.plain && picked?.comment?.want === true);

      if (picked && pickedDeep && (wantsShare || wantsPlain)) {
        const composed = await composeComments(
          { llm: deps.llm, logger, persona },
          { item: picked, deep: pickedDeep, config: cfg, ownerName: owner.name },
        );
        llmCalls += composed.usage.calls;
        usage.promptTokens += composed.usage.promptTokens;
        usage.completionTokens += composed.usage.completionTokens;
        usage.cachedTokens += composed.usage.cachedTokens;
        for (const line of composed.notes) notes.push(line);
        if (composed.shareText) picked.share = { ...(picked.share ?? { channel: cfg.share.via, text: '', reason: '' }), text: composed.shareText };
        if (composed.plainText && picked.comment) picked.comment = { ...picked.comment, text: composed.plainText };
      }

      const diary = await composeDiary({ llm: deps.llm, logger, persona }, { date, result, deepReads });
      llmCalls += diary.usage.calls;
      usage.promptTokens += diary.usage.promptTokens;
      usage.completionTokens += diary.usage.completionTokens;
      usage.cachedTokens += diary.usage.cachedTokens;
      for (const line of diary.notes) notes.push(line);
      if (diary.diary.public.length > 0 || diary.diary.private.length > 0) {
        result = { ...result, diary: { ...result.diary, ...diary.diary } };
      }
    } catch (err) {
      notes.push(`写评论/日记出错（不影响本轮）：${humanError(err)}`);
    }
  }

  // ---------------------------------------------------------------- Phase 6.5 抛光（机械修）
  // 只做「位置确定」的修（去句号、去日记里的表情码）；重写功能等这两版定稿后再开。
  try {
    const polished = await polishResult({ llm: deps.llm, logger }, result, cfg, { allowRewrite: false });
    result = polished.result;
    llmCalls += polished.usage.calls;
    usage.promptTokens += polished.usage.promptTokens;
    usage.completionTokens += polished.usage.completionTokens;
    usage.cachedTokens += polished.usage.cachedTokens;
    for (const line of polished.notes) notes.push(line);
  } catch (err) {
    notes.push(`日记/评论抛光出错（不影响本轮）：${humanError(err)}`);
  }

  // ---------------------------------------------------------------- 判重账本（写操作之前！）
  // 只记「真的送进初筛」的（含挑中的）：候选里排在 screenLimit 之后、从没给模型看过的那些不记，
  // 否则一轮就把当天库存冷藏 7 天，后面几轮只剩个位数候选。
  //
  // **必须在执行分享之前写**：分享包含「发评论 + 复核（0/2/6 秒）」，中间若被杀/磁盘满导致后面的
  // 落盘抛异常，账本就丢了这条——下一轮会把同一个视频再选出来，而评论其实已经发出去了。
  // 宁可少推一次（极端情况下一轮里挑中但没发成的视频会被冷藏），也不要重复发。
  const screenedBvids = new Set(screen.items.map((item) => item.bvid));
  for (const candidate of collected.candidates) {
    if (!screenedBvids.has(candidate.video.bvid)) continue;
    const selected = result.selected.find((s) => s.bvid === candidate.video.bvid);
    const skipped = result.skipped.find((s) => s.bvid === candidate.video.bvid);
    deps.seen.record({
      bvid: candidate.video.bvid,
      title: candidate.video.title,
      decision: selected ? 'selected' : 'skipped',
      reason: selected ? `挑中 ${selected.score}/20` : skipped ? skipReasonText(skipped.reason) : '初筛未进深读',
      now: now(),
    });
  }

  // 视频元信息（标题/UP/时长/链接）：私信分享与视频通知都要用，必须在使用前构建
  const videos = buildVideoMeta(collected.candidates, deepReads);

  // ---------------------------------------------------------------- 闸门 + 执行分享（M3）
  // 判定与执行是同一段：闸门说「不发」就一条都不发；说「发」才走写层。
  const shareReport = await executeShares(
    {
      logger,
      quota: deps.quota,
      state: deps.state,
      writer: deps.writer,
      api: deps.api,
      config: cfg,
      feedback: deps.feedback,
      selfMid: () => deps.secrets.selfMid(),
      now,
      ...(deps.shareVerifyDelaysMs ? { verifyDelaysMs: deps.shareVerifyDelaysMs } : {}),
      ...(deps.skipWriteWait ? { skipWait: true } : {}),
    },
    {
      items: result.selected.map((item) => ({
        bvid: item.bvid,
        aid: videosAid(deepReads, item.bvid),
        score: item.score,
        share: item.share,
        inDeepRead: ctxForResult.deepReadBvids.has(item.bvid),
        title: videos.get(item.bvid)?.title ?? item.bvid,
        oneliner: item.oneliner,
      })),
      todayShares,
      silenceCap: silence.shareCap,
      dryRun: effectiveDryRun,
      dmReceiver: resolveOwner(cfg, deps.secrets.selfMid()).mid,
      dmSender: deps.secrets.selfMid(),
    },
  );
  counts.shared = shareReport.sent;

  const shareDecisions = new Map<string, ReturnType<typeof gateShare>>();
  const primaryShare = shareReport.attempts[0];
  if (primaryShare) {
    shareOutcome = {
      status: primaryShare.status,
      deny: primaryShare.deny,
      note: primaryShare.notes.join('；'),
      bvid: primaryShare.bvid,
    };
  }
  for (const attempt of shareReport.attempts) {
    shareDecisions.set(attempt.bvid, {
      allow: attempt.status === 'sent' || attempt.status === 'dry_run' || attempt.status === 'unverified',
      deny: attempt.deny,
      notes: attempt.notes,
    });
  }
  if (shareReport.attempts.length > 0) notes.push(`分享：${summarizeShares(shareReport)}`);
  for (const attempt of shareReport.attempts) {
    for (const line of attempt.deny) notes.push(`没发 ${attempt.bvid}：${line}`);
    for (const line of attempt.notes) {
      if (line.startsWith('已发') || line.startsWith('已发出') || line.startsWith('预演')) notes.push(line);
    }
  }
  if (shareReport.stopped === 'risk') errors.push('撞风控：本轮已停写，冷却期内不再发');

  // ---------------------------------------------------------------- 不 @ 的评论（P3，默认关）
  // 与分享是两件事：分享 @ 主人；这条是给评论区所有人看的。独立额度、一轮最多一条。
  const plainComments = new Map<string, ShareAttempt>();
  if (cfg.share.enabled && cfg.share.comment.plain && !shareReport.stopped) {
    const plainItems = result.selected
      .filter((item) => item.comment?.want === true && (item.comment?.text ?? '').trim().length > 0)
      .map((item) => ({ bvid: item.bvid, aid: videosAid(deepReads, item.bvid), text: String(item.comment?.text ?? '') }));
    if (plainItems.length > 0) {
      try {
        const plain = await executePlainComments(
          { logger, config: cfg, quota: deps.quota, state: deps.state, writer: deps.writer, api: deps.api, now },
          { items: plainItems, dryRun: effectiveDryRun, todayPlain: deps.quota.countPlainCommentsOn(date) },
        );
        for (const note of plain.notes) notes.push(note);
        for (const attempt of plain.attempts) plainComments.set(attempt.bvid, attempt);
      } catch (err) {
        notes.push(`不@评论出错（不影响本轮）：${humanError(err)}`);
      }
    }
  }

  // ---------------------------------------------------------------- 收藏（M4，默认开）
  if (cfg.fav.enabled && result.favorite) {
    try {
      const favAid = videosAid(deepReads, result.favorite.bvid);
      const sameKindCount = deps.quota.countOn(date, 'fav');
      const fav = await executeFavorites(
        { logger, config: cfg, quota: deps.quota, state: deps.state, writer: deps.writer, api: deps.api, now },
        {
          items: [
            {
              bvid: result.favorite.bvid,
              aid: favAid,
              reason: result.favorite.reason,
              sameKindCount,
              inDeepRead: ctxForResult.deepReadBvids.has(result.favorite.bvid),
            },
          ],
          dryRun: effectiveDryRun,
        },
      );
      for (const line of fav.notes) notes.push(line);
      const favAttempt = fav.attempts[0];
      if (favAttempt) {
        favOutcome = {
          status: favAttempt.status,
          deny: favAttempt.deny,
          note: favAttempt.notes.join('；'),
          bvid: favAttempt.bvid,
        };
      }
    } catch (err) {
      notes.push(`收藏出错（不影响本轮）：${humanError(err)}`);
    }
  }

  // ---------------------------------------------------------------- 点赞（M4，默认关）
  if (cfg.like.enabled && result.selected.length > 0) {
    try {
      const first = result.selected[0];
      if (first) {
        const like = await likeVideo(
          { logger, config: cfg, quota: deps.quota, state: deps.state, writer: deps.writer, now },
          { bvid: first.bvid, aid: videosAid(deepReads, first.bvid), inDeepRead: ctxForResult.deepReadBvids.has(first.bvid), dryRun: effectiveDryRun },
        );
        notes.push(like.ok ? `点赞：${like.note}` : `没点赞：${like.note}`);
        likeOutcome = { status: like.status, deny: like.deny, note: like.note, bvid: first.bvid };
      }
    } catch (err) {
      notes.push(`点赞出错（不影响本轮）：${humanError(err)}`);
    }
  }

  // 陌生人回复：把我们评论下的新回复落成待审草稿（M3 只建队列，不自动回）
  if (cfg.listen.reply.strangerApproval && shareReport.sent > 0 && !effectiveDryRun) {
    try {
      const pendingDeps = {
        logger,
        config: cfg,
        quota: deps.quota,
        state: deps.state,
        pending: deps.pending,
        replied: deps.replied,
        api: deps.api,
        writer: deps.writer,
        secrets: deps.secrets,
        now,
        ...(deps.pendingDraft ? { draft: deps.pendingDraft } : {}),
      };
      const scan = await scanStrangerReplies(pendingDeps);
      if (scan.created.length > 0) {
        notes.push(`${scan.created.length} 条陌生人回复进了待审队列（面板「待审」页处理）`);
        markPhase('pending', 0, 'ok', `${scan.created.length} 条待审`);
      }
      // 主人直发：主人自己回的评论不排队，直接回（仍受同一套写开关 / 风控 / 预演约束）
      if (cfg.listen.reply.ownerDirect) {
        const auto = await autoApproveOwnerDrafts(pendingDeps, scan.created);
        if (auto.approved.length > 0) notes.push(`主人直发：回了 ${auto.approved.length} 条`);
      }
    } catch (err) {
      notes.push(`待审扫描失败（不影响本轮）：${humanError(err)}`);
    }
  }

  // ---------------------------------------------------------------- Phase 8 落盘
  const phase8 = Date.now();
  const whyNot = buildWhyNot({
    config: cfg,
    result,
    dmChannelOn: (cfg.notify.channels ?? []).some((channel) => channel.type === 'dm' && channel.enabled),
    dryRun: effectiveDryRun,
    ...(shareOutcome ? { share: shareOutcome } : {}),
    ...(favOutcome ? { fav: favOutcome } : {}),
    ...(likeOutcome ? { like: likeOutcome } : {}),
    riskCooldownUntil: deps.state.riskCooldownUntil(),
    now: now(),
  });
  const reportPath = writeReport(deps.paths, {
    date,
    roundLabel: roundLabel(startedAt),
    whyNot,
    level: cfg.report.level,
    result,
    counts,
    videos,
    shareDecisions,
    shareAttempts: new Map(shareReport.attempts.map((attempt) => [attempt.bvid, attempt])),
    ...(plainComments.size > 0 ? { plainComments } : {}),
    usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costCny: 0 },
    dryRun: effectiveDryRun,
    notes,
    ...(mediaNote ? { media: { text: mediaNote } } : {}),
  });
  if (reportPath) logger.info('orchestrator', `报告已写入 ${reportPath}`);

  try {
    // P3：日记由单独一轮生成，可能真的没写出来（模型失败/它觉得没东西可写）——那就别落空文件
    if (result.diary.public.trim().length > 0) {
      writeDiary(deps.paths, { date, label: roundLabel(startedAt), kind: 'public', title: cfg.diary.publicTitle, body: result.diary.public });
    } else {
      notes.push('公开日记这篇没写成（模型没回内容，没落空文件）');
    }
    if (result.diary.private.trim().length > 0) {
      writeDiary(deps.paths, { date, label: roundLabel(startedAt), kind: 'private', title: cfg.diary.privateTitle, body: result.diary.private });
    }
  } catch (err) {
    errors.push(`日记写入失败：${humanError(err)}`);
  }

  if (cfg.report.archive) {
    writeArchive(deps.paths, {
      date,
      label: roundLabel(startedAt),
      rows: collected.candidates.map((candidate) => {
        const selected = result.selected.find((s) => s.bvid === candidate.video.bvid);
        const skipped = result.skipped.find((s) => s.bvid === candidate.video.bvid);
        return {
          bvid: candidate.video.bvid,
          title: candidate.video.title,
          up: candidate.video.owner.name,
          conclusion: selected
            ? `挑中 ${selected.score}/20`
            : skipped
              ? skipReasonText(skipped.reason)
              : screenMap(screen).get(candidate.video.bvid) !== undefined
                ? '初筛未进深读'
                : '未进入初筛',
        };
      }),
    });
  }

  markPhase('persist', Date.now() - phase8, 'ok');

  // ---------------------------------------------------------------- 私信通知（M4）
  // 只用本轮已有的数据：摘要、今天的公开日记、挑中的视频（标题/链接/一句话）。
  // **不为这段再跑模型、不再请求 B 站**；视频信息只允许本轮出现过的 BV。
  const dmChannelOn = (cfg.notify.channels ?? []).some((channel) => channel.type === 'dm' && channel.enabled);
  if (dmChannelOn) {
    try {
      const allowBvids = new Set<string>([
        ...result.selected.map((item) => item.bvid),
        ...result.skipped.map((item) => item.bvid),
        ...collected.candidates.map((candidate) => candidate.video.bvid),
      ]);
      const dmVideos = result.selected.slice(0, 3).map((item) => {
        const meta = videos.get(item.bvid);
        return {
          bvid: item.bvid,
          title: meta?.title ?? item.bvid,
          desc: deepReads.find((read) => read.bvid === item.bvid)?.video.desc ?? '',
          understanding: item.oneliner || item.why,
        };
      });
      const dm = await sendDmNotify(
        { logger, config: cfg, writer: deps.writer, state: deps.state, secrets: deps.secrets, now },
        {
          summary: result.notify,
          publicDiary: result.diary.public,
          videos: dmVideos,
          allowBvids,
          dryRun: effectiveDryRun,
        },
      );
      if (dm.sent > 0) notes.push(`私信通知已发 ${dm.sent} 条`);
      for (const line of dm.skipped) notes.push(`私信通知：${line}`);
      if (dm.error) notes.push(`私信通知失败：${dm.error}`);
    } catch (err) {
      notes.push(`私信通知出错（不影响本轮）：${humanError(err)}`);
    }
  }

  // ---------------------------------------------------------------- Phase 9 通知
  const phase9 = Date.now();
  try {
    const notified = await dispatchNotifications(
      {
        config: cfg,
        logger,
        writeFile: (text) => {
          appendNotifyLog(deps.paths, text);
        },
      },
      { text: result.notify, at: now() },
    );
    for (const item of notified.failed) notes.push(`通知渠道 ${item.channel} 失败：${item.error}`);
    for (const item of notified.skipped) notes.push(`通知：${item}`);
    if (notified.quiet) notes.push('静默时段：只写了文件');
    markPhase('notify', Date.now() - phase9, notified.failed.length > 0 ? 'degraded' : 'ok', notified.delivered.join('/') || 'none');
  } catch (err) {
    errors.push(`通知写入失败：${humanError(err)}`);
    markPhase('notify', Date.now() - phase9, 'failed');
  }

  // ---------------------------------------------------------------- Phase 10 收尾
  const status2: RunRecord['status'] = errors.length === 0 && !resultDegraded ? 'ok' : 'degraded';
  return finish(status2);
}

/** 把 ISO 时间里的 HH:mm 抠出来（报告里写「冷却到 23:46」用）。 */
function clockOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? (match[1] ?? '') : '';
}

/** 从深读结果里拿 aid（写接口要 oid=aid）；取不到就 0，上层会拒绝而不是瞎猜。 */
function videosAid(deepReads: DeepRead[], bvid: string): number {
  return deepReads.find((read) => read.bvid === bvid)?.video.aid ?? 0;
}

/* ---------- 相位辅助 ---------- */

async function lightRead(candidate: Candidate, runtime: ToolRuntime): Promise<LightRead | null> {
  const bvid = candidate.video.bvid;
  const video = await runtime.video(bvid);
  if (!video.ok) {
    // 视频没了/私密：不算错误，记一条降级条目
    return {
      candidate,
      subtitleAvailable: false,
      subtitleChars: 0,
      subtitleExcerpt: '',
      topComments: [],
      commentCount: 0,
      degraded: `视频详情取不到：${video.error.message}`,
    };
  }
  const enriched: Candidate = { ...candidate, video: { ...video.data, source: candidate.source } };
  const subs = await runtime.subtitleText(bvid);
  const comments = await runtime.topComments(bvid, 3);
  const subtitleText = subs.ok ? subs.data.text : '';
  const degradedParts: string[] = [];
  if (!subs.ok) degradedParts.push(`字幕读取失败（${subs.error.message}）`);
  if (!comments.ok) degradedParts.push(`评论读取失败（${comments.error.message}）`);

  return {
    candidate: enriched,
    subtitleAvailable: subtitleText.length > 0,
    subtitleChars: subtitleText.length,
    subtitleExcerpt: subtitleText.slice(0, 900),
    topComments: comments.ok ? comments.data.items.map((c) => `${c.uname}：${clip(c.message, 100)}`) : [],
    commentCount: comments.ok ? comments.data.count : 0,
    ...(degradedParts.length > 0 ? { degraded: degradedParts.join('；') } : {}),
  };
}

/**
 * 补齐「初筛阶段就跳过」的条目。
 * 模型常常只列自己深读过的，剩下的不写；报告需要完整的「看过（跳过）」，
 * 所以由代码按初筛分数与字幕情况补上 —— 这也是「确定性的事交给代码」。
 */
function fillSkipped(result: RoundResult, screen: ScreenResult, lightReads: LightRead[]): RoundResult {
  const known = new Set<string>([...result.selected.map((s) => s.bvid), ...result.skipped.map((s) => s.bvid)]);
  const lightMap = new Map(lightReads.map((l) => [l.candidate.video.bvid, l]));
  const extra: SkippedItem[] = [];
  for (const item of screen.items) {
    if (known.has(item.bvid)) continue;
    const light = lightMap.get(item.bvid);
    const noSubtitle = light !== undefined && !light.subtitleAvailable;
    extra.push({
      bvid: item.bvid,
      reason: noSubtitle ? 'no_subtitle' : 'low_score',
      ...(item.reason ? { note: item.reason.slice(0, 80) } : {}),
    });
  }
  if (extra.length === 0) return result;
  return { ...result, skipped: [...result.skipped, ...extra] };
}

function deterministicScreen(lightReads: LightRead[], cfg: Config): ScreenResult {  const items: ScreenItem[] = lightReads.map((item, index) => ({
    bvid: item.candidate.video.bvid,
    score: Math.max(20 - index, 1),
    reason: '模型不可用，按预取顺序兜底',
    deep: index < cfg.content.deepReadLimit,
  }));
  return { items, notes: '降级：按顺序兜底' };
}

function skippedFromScreen(screen: ScreenResult, deepReads: DeepRead[]): SkippedItem[] {
  const deepSet = new Set(deepReads.map((d) => d.bvid));
  return screen.items
    .filter((item) => !deepSet.has(item.bvid))
    .map((item) => ({ bvid: item.bvid, reason: item.score > 0 ? ('low_score' as const) : ('other' as const), note: item.reason }));
}

function buildMemoryLines(deps: RoundDeps, silenceText: string): string[] {
  const lines: string[] = [];
  const recent = deps.seen.recentTitles(6);
  if (recent.length > 0) {
    const picked = recent.filter((r) => r.decision === 'selected').length;
    lines.push(`最近看过 ${recent.length} 条，挑中 ${picked} 条；最近一条是 ${recent[0]?.title ?? ''}（${recent[0]?.ageDays ?? 0} 天前）`);
    lines.push(`最近看过的 BV：${recent.slice(0, 5).map((r) => r.bvid).join('、')}`);
  }
  lines.push(`沉默档位：${silenceText}`);
  const feedback = deps.feedback.get();
  if (feedback.notes.length > 0) lines.push(`上次的校准记录：${feedback.notes.slice(-1)[0]}`);
  return lines;
}

function buildVideoMeta(candidates: Candidate[], deepReads: DeepRead[]): Map<string, { title: string; up: string; durationText: string; ageText: string; url: string }> {
  const map = new Map<string, { title: string; up: string; durationText: string; ageText: string; url: string }>();
  const put = (v: BiliVideo, durationText: string, ageText: string) => {
    map.set(v.bvid, {
      title: v.title,
      up: v.owner.name || '未知 UP',
      durationText,
      ageText,
      url: videoUrl(v.bvid),
    });
  };
  for (const candidate of candidates) put(candidate.video, candidate.durationText, candidate.ageText);
  for (const deep of deepReads) {
    put(deep.video, `${Math.round(deep.video.durationSec / 60)} 分钟`, map.get(deep.bvid)?.ageText ?? '');
  }
  return map;
}

const screenMapCache = new WeakMap<ScreenResult, Map<string, ScreenItem>>();
function screenMap(screen: ScreenResult): Map<string, ScreenItem> {
  const cached = screenMapCache.get(screen);
  if (cached) return cached;
  const map = new Map(screen.items.map((item) => [item.bvid, item]));
  screenMapCache.set(screen, map);
  return map;
}


function extractJsonSafe(text: string): unknown {
  return extractJsonFromModule(text);
}

function roundLabel(at: Date): string {
  return `${formatHhmm(at.getHours() * 60 + at.getMinutes())} · 跑了一轮`;
}

/** 失败也要留痕：报告写原因，两本日记各写一句实话。 */
function writeFailureOutputs(deps: RoundDeps, input: { date: string; label: string; reason: string; trigger: RunTrigger }): void {
  try {
    writeDiary(deps.paths, {
      date: input.date,
      label: input.label,
      kind: 'public',
      title: deps.config.get().diary.publicTitle,
      body: `今天没跑成。${input.reason}\n\n不是不想看，是机器这边先出问题了。等它修好我再去看。`,
    });
    writeDiary(deps.paths, {
      date: input.date,
      label: input.label,
      kind: 'private',
      title: deps.config.get().diary.privateTitle,
      body: `本轮失败：${input.reason}（trigger=${input.trigger}）。\n\n偏好校准：这次没有新信息。下次同一个原因再出现，先修它，不要硬跑。`,
    });
  } catch (err) {
    deps.logger.error('orchestrator', `失败日记写入失败：${humanError(err)}`);
  }
}

/** 没有候选 / 没有深读材料时也一样要写日记（日记不可关）。 */
function writeEmptyRoundOutputs(
  deps: RoundDeps,
  input: { date: string; label: string; reason: string; trigger: RunTrigger; cfg: Config; dryRun: boolean },
): void {
  try {
    writeReport(deps.paths, {
      date: input.date,
      roundLabel: input.label,
      level: input.cfg.report.level,
      result: {
        selected: [],
        skipped: [],
        favorite: null,
        dynamic: null,
        diary: { public: '', private: '' },
        report_md: '',
        notify: '',
        notes: input.reason,
      },
      counts: { candidates: 0, screened: 0, deepRead: 0, selected: 0, shared: 0, skippedNoSubtitle: 0 },
      videos: new Map(),
      shareDecisions: new Map(),
      usage: { promptTokens: 0, completionTokens: 0, costCny: 0 },
      dryRun: input.dryRun,
      notes: [input.reason],
    });
    writeDiary(deps.paths, {
      date: input.date,
      label: input.label,
      kind: 'public',
      title: input.cfg.diary.publicTitle,
      body: `今天没看到什么。${input.reason}\n\n不是坏事，有时候就是没有值得占你注意力的东西。`,
    });
    writeDiary(deps.paths, {
      date: input.date,
      label: input.label,
      kind: 'private',
      title: input.cfg.diary.privateTitle,
      body: `这一轮空的：${input.reason}（trigger=${input.trigger}）。\n\n偏好校准：没有新证据，不改判断。如果连续几天都空，可能是关键词太窄，得让用户调一下。`,
    });
  } catch (err) {
    deps.logger.error('orchestrator', `空轮次的日记写入失败：${humanError(err)}`);
  }
}
