/**
 * 面板 API 的实现（把 ctx / runner / scheduler / login 拼成 HTTP handlers）。
 *
 * 职责：M1 的动作（跑一轮/暂停/自启/退出）+ M2 的面板能力（配置、账号、报告、日记、体检、诊断）。
 *   所有读写都走既有的服务层：配置走 ConfigService、凭据走 SecretsService、产出只看文件、
 *   配额与状态读账本——这里不发明新的事实来源。
 * 不做什么：不做鉴权（http/server 统一做）、不直接改 B 站、不写业务规则。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../bootstrap.ts';
import type { RoundRunner } from './runner.ts';
import type { Scheduler } from './scheduler.ts';
import type { LoginService } from '../account/login.ts';
import type { AutostartPayload, ControlHandlers, DocFile, ListEntry, PanelHandlers, QrPayload, StatusPayload } from '../http/server.ts';
import { describeConfig } from '../config/describe.ts';
import { buildDefaults, validateConfig } from '../config/validate.ts';
import { decideSilence } from '../state/ledgers.ts';
import { toDayPlan } from './scheduler.ts';
import { summarizePlan } from '../scheduler/tick.ts';
import { localDate, localIso } from '../shared/time.ts';
import { humanError } from '../shared/errors.ts';
import { encodeQr, matrixToRows } from '../qr/encoder.ts';
import { buildDiagBundle, diagFileName } from '../diagnostics.ts';
import { approvePending, rejectPending, scanStrangerReplies } from '../orchestrator/pending.ts';
import { makeReplyDraft } from '../orchestrator/replyDraft.ts';
import { discoverModel, keyFingerprint } from '../llm/discovery.ts';
import { deleteOwnComment } from '../orchestrator/manual.ts';
import { runDoctor } from '../doctor.ts';
import type { AutostartService } from '../lifecycle/autostart.ts';

export interface PanelDeps {
  ctx: AppContext;
  runner: RoundRunner;
  scheduler: Scheduler;
  autostart: AutostartService;
  login: LoginService;
  version: string;
  startedAt: number;
  dataDir?: string;
  trayExe?: string;
  /** 只有托盘/面板请求才会触发；默认 false 表示按真实模式体检。 */
  fixtures: boolean;
  mockModel: boolean;
  /** 退出内核（由 daemon 注入）。 */
  shutdown: () => void;
}

export type AllHandlers = ControlHandlers & PanelHandlers;

export function createHandlers(deps: PanelDeps): AllHandlers {
  const { ctx, runner, scheduler, autostart, login, version } = deps;

  const nextWakeIso = (): string | null => {
    const ms = ctx.state.nextWakeAtMs();
    return ms === null ? null : localIso(new Date(ms));
  };

  return {
    /* ---------------- 状态 ---------------- */

    health() {
      const state = ctx.state.get();
      return {
        ok: true,
        version,
        pid: process.pid,
        uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
        running: runner.isRunning(),
        paused: state.paused,
        nextWakeAt: nextWakeIso(),
        lastRunStatus: state.lastRunStatus,
        lastError: scheduler.error,
      };
    },

    status(): StatusPayload {
      const state = ctx.state.get();
      const cfg = ctx.config.get();
      const plan = state.today ? toDayPlan(state.today) : null;
      const last = ctx.runs.last();
      const silence = decideSilence(ctx.feedback.silenceDays(), cfg.share);
      const today = localDate();
      const account = ctx.secrets.accountHint();
      const warnings: string[] = [];
      if (!ctx.secrets.hasCookie()) warnings.push('还没有登录 B 站：字幕读不到（面板「账号」页可以扫码）');
      if (state.paused) warnings.push('自动唤醒已暂停（手动「现在跑一轮」仍然可用）');
      if (scheduler.error) warnings.push(`调度最近一次出错：${scheduler.error}`);
      const pendingCount = ctx.pending.count();
      if (pendingCount > 0) warnings.push(`有 ${pendingCount} 条陌生人回复在等你决定（面板「待审」页）`);

      return {
        scheduler: {
          plan: summarizePlan(plan),
          paused: state.paused,
          nextWakeAt: nextWakeIso(),
          planSource: state.today?.reason ?? null,
        },
        lastRun: last ? { id: last.id, status: last.status, endedAt: last.endedAt, tokens: last.model.promptTokens + last.model.completionTokens } : null,
        today: {
          wakes: state.today?.wakes ?? 0,
          targetWakes: state.today?.targetWakes ?? 0,
          shares: ctx.quota.sharesOn(today),
          shareCap: Math.min(silence.shareCap, cfg.share.dailyCap),
          tokens: state.budget.tokens,
          costCny: state.budget.costCny,
        },
        account: { loggedIn: account.hasCookie, ...(account.uname ? { name: account.uname } : {}), ...(account.mid ? { mid: account.mid } : {}) },
        model: { configured: ctx.configuredModel, actual: ctx.llm.model, discoveredAt: state.modelCache?.discoveredAt ?? null },
        pending: { count: ctx.pending.count() },
        warnings,
      };
    },

    logs(limit: number): unknown[] {
      return ctx.logger.recentEvents(limit);
    },

    async run(options: { dryRun: boolean }) {
      const result = runner.runManual(options);
      ctx.logger.event('manual-run', result.message, { level: result.ok ? 'info' : 'warn', target: 'daemon' });
      return result;
    },

    pause() {
      ctx.state.setPaused(true, localIso());
      ctx.logger.event('pause', '已暂停自动唤醒（手动仍可跑）', { target: 'daemon' });
      return { ok: true, message: '已暂停自动唤醒；手动「现在跑一轮」仍然可用' };
    },

    resume() {
      ctx.state.setPaused(false, localIso());
      scheduler.invalidate();
      ctx.logger.event('resume', '已恢复自动唤醒', { target: 'daemon' });
      return { ok: true, message: '已恢复；下一次 tick 会重算计划' };
    },

    async autostart(enabled?: boolean): Promise<AutostartPayload> {
      try {
        if (enabled === undefined) return await autostart.status();
        return enabled ? await autostart.enable() : await autostart.disable();
      } catch (err) {
        const warning = humanError(err);
        ctx.logger.warn('autostart', warning);
        return { enabled: false, mechanism: null, command: null, warning };
      }
    },

    shutdown() {
      ctx.logger.info('daemon', '收到退出请求');
      deps.shutdown();
      return { ok: true, message: '正在退出' };
    },

    /* ---------------- 配置 ---------------- */

    config() {
      return { config: ctx.config.exportForUser(), groups: describeConfig(), issues: ctx.config.getIssues(), defaults: buildDefaults() };
    },

    async saveConfig(patch: unknown) {
      const before = JSON.stringify(ctx.config.get().schedule);
      const result = ctx.config.patch(patch);
      if (!result.ok) {
        return { ok: false, message: '配置没通过校验，已保留原值', issues: result.issues };
      }
      const after = JSON.stringify(ctx.config.get().schedule);
      if (before !== after) scheduler.invalidate();
      ctx.logger.setLevel(ctx.config.get().logging.level);
      ctx.logger.event('config-save', '配置已保存（保存即生效）', { target: 'http' });
      return {
        ok: true,
        message: before !== after ? '已保存；作息变了，下一次 tick 会重算计划' : '已保存，立即生效',
        issues: result.issues.filter((issue) => issue.severity !== 'info'),
      };
    },

    validateConfig(raw: unknown) {
      const result = validateConfig(raw);
      return { ok: result.ok, issues: result.issues };
    },

    exportConfig() {
      const json = JSON.stringify(ctx.config.exportForUser(), null, 2);
      return { filename: `biliwhale-config-${localDate()}.json`, json };
    },

    async importConfig(raw: unknown) {
      const candidate = isRecord(raw) && isRecord(raw.config) ? raw.config : raw;
      const check = validateConfig(candidate);
      if (!check.ok) return { ok: false, message: '导入的配置不合法', issues: check.issues };
      const result = ctx.config.patch(check.value);
      if (!result.ok) return { ok: false, message: '导入失败', issues: result.issues };
      scheduler.invalidate();
      ctx.logger.event('config-import', '配置已导入', { target: 'http' });
      return { ok: true, message: '已导入并生效（凭据没动）', issues: [] };
    },

    async resetConfig() {
      const result = ctx.config.patch(buildDefaults());
      if (!result.ok) return { ok: false, message: '恢复默认失败', issues: result.issues };
      scheduler.invalidate();
      ctx.logger.event('config-reset', '配置已恢复默认', { target: 'http' });
      return { ok: true, message: '已恢复默认配置（凭据没动）', issues: [] };
    },

    models() {
      const state = ctx.state.get();
      return {
        configured: ctx.configuredModel,
        actual: ctx.llm.model,
        auto: ctx.config.get().llm.modelAuto,
        cache: state.modelCache,
        budget: state.budget,
      };
    },

    /* ---------------- 账号 ---------------- */

    account() {
      const hint = ctx.secrets.accountHint();
      const cfg = ctx.config.get();
      return {
        loggedIn: hint.hasCookie,
        fingerprint: hint.fingerprint,
        name: hint.uname ?? cfg.account.name ?? null,
        mid: hint.mid ?? (cfg.account.mid || null),
        configMid: cfg.account.mid,
        configName: cfg.account.name,
        note: '凭据只存在本机 secrets.json，面板不回显原值',
      };
    },

    async qrStart(): Promise<QrPayload> {
      const started = await login.startQr();
      if (!started.ok) return { ok: false, message: started.error.message };
      try {
        const matrix = encodeQr(started.data.url, { ecLevel: 'M' });
        const rows = matrixToRows(matrix);
        return {
          ok: true,
          key: started.data.key,
          url: started.data.url,
          rows,
          size: matrix.size,
          expiresInSec: started.data.expiresInSec,
        };
      } catch (err) {
        // 理论上不会发生（URL 很短），真发生了就退回「只给链接」
        return { ok: true, key: started.data.key, url: started.data.url, expiresInSec: started.data.expiresInSec, message: `二维码画不出来：${humanError(err)}` };
      }
    },

    async qrPoll(key: string) {
      const polled = await login.pollQr(key);
      if (!polled.ok) return { ok: false, state: 'error', message: polled.error.message };
      return { ok: true, ...polled.data };
    },

    async saveCookie(cookie: string) {
      const saved = await login.saveCookie(cookie);
      if (!saved.ok) return { ok: false, message: saved.error.message };
      return { ok: true, warnings: saved.data.warnings, account: saved.data.account, message: saved.data.account ? `已登录：${saved.data.account.uname}` : '已保存，但还没验证通过' };
    },

    async verifyAccount() {
      const checked = await login.recheck();
      if (!checked.ok) return { ok: false, loggedIn: false, message: checked.error.message };
      return {
        ok: true,
        loggedIn: checked.data.loggedIn,
        account: checked.data.account,
        message: checked.data.loggedIn ? `登录有效：${checked.data.account?.uname ?? ''}` : '当前 cookie 无效或已过期，请重新扫码',
      };
    },

    logout() {
      return login.logout();
    },

    /* ---------------- 产出 ---------------- */

    reports(): ListEntry[] {
      return listMarkdown(ctx.paths.reportsDir);
    },

    report(date: string): DocFile | null {
      return readMarkdown(path.join(ctx.paths.reportsDir, `${date}.md`), date);
    },

    diaries(kind: 'public' | 'private', query?: string): ListEntry[] {
      const dir = kind === 'public' ? ctx.paths.diariesPublicDir : ctx.paths.diariesPrivateDir;
      return searchMarkdown(dir, query ?? '');
    },

    diary(kind: 'public' | 'private', date: string): DocFile | null {
      const dir = kind === 'public' ? ctx.paths.diariesPublicDir : ctx.paths.diariesPrivateDir;
      return readMarkdown(path.join(dir, `${date}.md`), date);
    },

    /* ---------------- 体检 / 诊断 ---------------- */

    async doctor() {
      return runDoctor(ctx, {
        version,
        fixtures: deps.fixtures,
        mockModel: deps.mockModel,
        ...(deps.trayExe ? { trayExe: deps.trayExe } : {}),
      });
    },

    async diag() {
      const doctor = await runDoctor(ctx, { version, fixtures: deps.fixtures, mockModel: deps.mockModel, offline: true });
      const bundle = await buildDiagBundle(ctx, { version, doctor });
      return { filename: diagFileName(), json: JSON.stringify(bundle, null, 2) };
    },

    /* ---------------- 凭据（DeepSeek key） ---------------- */

    secretsStatus() {
      const envSet = Boolean(process.env.BILIWHALE_API_KEY?.trim());
      const key = ctx.secrets.apiKey();
      return {
        hasApiKey: key.length > 0,
        fingerprint: key ? keyFingerprint(key) : '',
        source: envSet ? ('env' as const) : key ? ('file' as const) : ('none' as const),
      };
    },

    async saveApiKey(apiKey: string) {
      const clean = apiKey.trim();
      if (!clean) return { ok: false, message: 'key 是空的' };
      if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(clean)) {
        return { ok: false, message: '看起来不像 DeepSeek key：应该以 sk- 开头，后面一串字母数字' };
      }
      if (process.env.BILIWHALE_API_KEY?.trim()) {
        return {
          ok: false,
          message: '环境变量 BILIWHALE_API_KEY 正在生效，面板里存的会被它盖住；先去调整那个环境变量（否则保存了也不生效）',
        };
      }

      // 先拿新 key 试一次，验过了才落盘：填错不该把原来能用的 key 覆盖掉
      const previous = ctx.secrets.apiKey();
      ctx.llm.setApiKey(clean);

      // 夹具/模拟模式不联网验证，直接算保存成功
      if (deps.fixtures || deps.mockModel) {
        ctx.secrets.setApiKey(clean);
        return { ok: true, message: '已保存（当前是夹具/模拟模式，没有真的验证）' };
      }

      const models = await ctx.llm.listModels();
      if (!models.ok) {
        ctx.llm.setApiKey(previous);
        return { ok: false, message: `验证没通过：${models.error.message}（key 填错了？没有保存）` };
      }

      ctx.secrets.setApiKey(clean);
      ctx.logger.event('llm', '面板里更新了 DeepSeek key', { target: 'http', data: { fingerprint: keyFingerprint(clean) } });
      const decision = await discoverModel({
        client: ctx.llm,
        configured: ctx.config.get().llm.model,
        modelAuto: ctx.config.get().llm.modelAuto,
        logger: ctx.logger,
      });
      ctx.llm.setModel(decision.model);
      ctx.state.setModelCache({ name: decision.model, discoveredAt: localIso(), keyFingerprint: keyFingerprint(clean) });
      ctx.logger.event('llm', `换 key 后自动发现模型：${decision.model}`, { target: 'http' });
      return {
        ok: true,
        message: `验证通过：可用模型 ${models.data.length} 个，接下来用 ${decision.model}`,
        model: decision.model,
        models: models.data.slice(0, 8),
      };
    },

    /* ---------------- 待审（M3） ---------------- */

    pending() {
      const items = ctx.pending.pending();
      return {
        count: items.length,
        items: items.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          bvid: item.bvid,
          root: item.root,
          parent: item.parent,
          target: item.target,
          sourceComment: item.sourceComment,
          draft: item.draft,
          timesReplied: (() => {
            const record = ctx.replied.get(item.target.mid);
            return record ? record.times : 0;
          })(),
        })),
        history: ctx.pending
          .all()
          .filter((item) => item.status !== 'pending')
          .slice(-20)
          .map((item) => ({ id: item.id, status: item.status, uname: item.target.uname, decidedAt: item.decidedAt ?? null, note: item.note ?? null })),
      };
    },

    async approvePending(id: string, dryRun = false) {
      const result = await approvePending(
        {
          logger: ctx.logger,
          config: ctx.config.get(),
          quota: ctx.quota,
          state: ctx.state,
          pending: ctx.pending,
          replied: ctx.replied,
          api: ctx.api,
          writer: ctx.writer,
          secrets: ctx.secrets,
        },
        id,
        { dryRun },
      );
      return {
        ok: result.ok,
        message: result.message,
        ...(result.rpid ? { rpid: result.rpid } : {}),
        ...(result.verified !== undefined ? { verified: result.verified } : {}),
      };
    },

    rejectPending(id: string, reason: string) {
      const result = rejectPending(
        {
          logger: ctx.logger,
          config: ctx.config.get(),
          quota: ctx.quota,
          state: ctx.state,
          pending: ctx.pending,
          replied: ctx.replied,
          api: ctx.api,
          writer: ctx.writer,
          secrets: ctx.secrets,
        },
        id,
        reason,
      );
      return result;
    },

    async scanPending() {
      const result = await scanStrangerReplies(
        {
          logger: ctx.logger,
          config: ctx.config.get(),
          quota: ctx.quota,
          state: ctx.state,
          pending: ctx.pending,
          replied: ctx.replied,
          api: ctx.api,
          writer: ctx.writer,
          secrets: ctx.secrets,
          draft: makeReplyDraft(ctx.llm, ctx.logger),
        },
        { maxPerRound: Math.max(1, ctx.config.get().listen.reply.maxPerRound) },
      );
      return result;
    },

    async deleteComment(bvid: string, rpid: string, dryRun = false) {
      return deleteOwnComment(
        { logger: ctx.logger, config: ctx.config.get(), quota: ctx.quota, state: ctx.state, writer: ctx.writer },
        { bvid, rpid },
        { dryRun },
      );
    },
  } as AllHandlers;
}

/* ---------------- 小工具 ---------------- */

function listMarkdown(dir: string): ListEntry[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { date: name.replace(/\.md$/, ''), size: stat.size };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function searchMarkdown(dir: string, query: string): ListEntry[] {
  const entries = listMarkdown(dir);
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  const hits: ListEntry[] = [];
  for (const entry of entries) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, `${entry.date}.md`), 'utf8');
    } catch {
      continue;
    }
    const count = text.toLowerCase().split(needle).length - 1;
    if (count > 0) hits.push({ ...entry, hits: count });
  }
  return hits;
}

function readMarkdown(file: string, date: string): DocFile | null {
  try {
    const markdown = fs.readFileSync(file, 'utf8');
    return { date, markdown };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
