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
import { approvePending, autoApproveOwnerDrafts, rejectPending, scanStrangerReplies } from '../orchestrator/pending.ts';
import { describeOwner, resolveOwner } from '../account/owner.ts';
import { makeReplyDraft } from '../orchestrator/replyDraft.ts';
import { discoverModel, keyFingerprint } from '../llm/discovery.ts';
import { SPEC } from '../config/spec.ts';
import type { ObjectSpec } from '../config/spec.ts';
import { deleteOwnComment, sendManualDm } from '../orchestrator/manual.ts';
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
  /** 立刻跑一次监听（由 daemon 注入；夹具模式不接）。 */
  listenTick?: () => Promise<unknown>;
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

      // 首次配置清单（便宜的那几项；磁盘/模型等重检查在体检里）
      const owner = resolveOwner(cfg, ctx.secrets.selfMid());
      const setup: Array<{ key: string; label: string; ok: boolean; tab: string; hint: string }> = [
        {
          key: 'apikey',
          label: 'DeepSeek key',
          ok: ctx.secrets.hasApiKey(),
          tab: 'settings',
          hint: '没有它跑不了任何一轮（预演也要真调模型）',
        },
        {
          key: 'login',
          label: 'B 站登录（鲸鲸）',
          ok: ctx.secrets.hasCookie(),
          tab: 'account',
          hint: '不登录：字幕拿不到、写不了',
        },
        {
          key: 'owner',
          label: '主人 UID（另一个号）',
          ok: owner.ok && owner.mid > 0,
          tab: 'account',
          hint: owner.problem ?? '评论 @、私信、聊天都发给它',
        },
        {
          key: 'ownerName',
          label: '主人昵称（@ 用）',
          ok: owner.ok && owner.name.length > 0,
          tab: 'account',
          hint: '留空时评论里 @ 不到人；可按 UID 自动取',
        },
      ];
      const missing = setup.filter((item) => !item.ok);

      return {
        scheduler: {
          plan: summarizePlan(plan),
          paused: state.paused,
          nextWakeAt: nextWakeIso(),
          planSource: state.today?.reason ?? null,
        },
        setup: {
          ready: missing.length === 0,
          items: setup,
          missing: missing.map((item) => ({ label: item.label, tab: item.tab, hint: item.hint })),
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
      // 只接受 spec 里有的顶层分组：未知键说明面板/调用方写错了路径（曾经因此把开关写到顶层垃圾字段上），
      // 静默接受会让「保存成功但没生效」这种最难查的 bug 重现。
      const cleaned = sanitizeConfigPatch(patch);
      if (!cleaned.ok) {
        return { ok: false, message: cleaned.message, issues: [{ path: cleaned.path, message: cleaned.message, severity: 'error' }] };
      }
      const before = JSON.stringify(ctx.config.get().schedule);
      const result = ctx.config.patch(cleaned.value);
      if (!result.ok) {
        return { ok: false, message: '配置没通过校验，已保留原值', issues: result.issues };
      }
      const after = JSON.stringify(ctx.config.get().schedule);
      if (before !== after) scheduler.invalidate();
      ctx.logger.setLevel(ctx.config.get().logging.level);
      ctx.logger.event('config-save', '配置已保存（保存即生效）', { target: 'http', ...(cleaned.dropped.length > 0 ? { data: { dropped: cleaned.dropped } } : {}) });
      const droppedNote = cleaned.dropped.length > 0 ? `；忽略了 ${cleaned.dropped.length} 个未知字段（${cleaned.dropped.slice(0, 5).join('、')}）` : '';
      return {
        ok: true,
        message: `${before !== after ? '已保存；作息变了，下一次 tick 会重算计划' : '已保存，立即生效'}${droppedNote}`,
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
      const owner = resolveOwner(cfg, ctx.secrets.selfMid());
      return {
        // 「鲸鲸」自己的号（登录账号，发送方身份）
        loggedIn: hint.hasCookie,
        fingerprint: hint.fingerprint,
        name: hint.uname ?? (cfg.account.name || null),
        mid: hint.mid ?? (cfg.account.mid || null),
        configMid: cfg.account.mid,
        configName: cfg.account.name,
        // 主人（你）：@、私信、聊天都发给它；和登录账号必须是两个号
        owner: {
          mid: owner.mid || null,
          name: owner.name || null,
          ok: owner.ok,
          problem: owner.problem ?? null,
          text: describeOwner(owner),
          sameAsLogin: owner.mid > 0 && owner.mid === hint.mid,
        },
        note: '凭据只存在本机 secrets.json，面板不回显原值',
      };
    },

    /** 按 UID 取主人昵称并写回配置（面板「账号」页的按钮；取不到就让用户手填）。 */
    async ownerLookup(body: { mid?: number }) {
      const mid = Number(body.mid ?? ctx.config.get().account.ownerMid ?? 0);
      if (!Number.isFinite(mid) || mid <= 0) return { ok: false, message: '先填主人 UID' };
      const selfMid = ctx.secrets.selfMid();
      if (selfMid > 0 && mid === selfMid) {
        return { ok: false, message: `这个 UID 是登录账号（${selfMid}）自己：主人必须是另一个号` };
      }
      const card = await ctx.api.userCard(mid);
      if (!card.ok) return { ok: false, message: `没取到昵称：${card.error.message}（可以手填）` };
      ctx.config.patch({ account: { ownerMid: card.data.mid, ownerName: card.data.name } });
      ctx.logger.event('account', `主人昵称已按 UID 自动填好：${card.data.name}（${card.data.mid}）`, { target: 'account' });
      return { ok: true, message: `主人：${card.data.name}（${card.data.mid}）`, ownerMid: card.data.mid, ownerName: card.data.name };
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
      // 账本可能是 CLI 进程写的：重读一次，面板上的「我们发过的评论」才准
      ctx.quota.reload();
      const items = ctx.pending.pending();
      const cutoff = Date.now() - 7 * 86_400_000;
      const recent = ctx.quota
        .entries()
        .filter((entry) => entry.type === 'comment' && Boolean(entry.rpid) && Date.parse(entry.at) >= cutoff)
        .slice(-10)
        .map((entry) => ({
          bvid: entry.bvid,
          rpid: entry.rpid ?? '',
          at: entry.at,
          status: entry.status,
          share: entry.share,
          aid: entry.aid ?? 0,
        }));
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
        /** 账本里我们最近 7 天发过的评论（扫描只认这些）。 */
        recent,
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
      const pendingDeps = {
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
      };
      const result = await scanStrangerReplies(pendingDeps, { maxPerRound: Math.max(1, ctx.config.get().listen.reply.maxPerRound) });
      // 主人直发：扫到「主人回的」就不排队，直接回（仍受同一套写开关约束）
      const auto = await autoApproveOwnerDrafts(pendingDeps, result.created);
      return { ...result, ownerAuto: auto };
    },

    async deleteComment(bvid: string, rpid: string, dryRun = false) {
      return deleteOwnComment(
        { logger: ctx.logger, config: ctx.config.get(), quota: ctx.quota, state: ctx.state, writer: ctx.writer },
        { bvid, rpid },
        { dryRun },
      );
    },

    /* ---------------- 私聊（M4） ---------------- */

    dm() {
      const cfg = ctx.config.get();
      const channel = (cfg.notify.channels ?? []).find((item) => item.type === 'dm');
      const owner = resolveOwner(cfg, ctx.secrets.selfMid());
      const receiver = owner.ok ? owner.mid : 0;
      return {
        enabled: cfg.listen.dm.enabled,
        chat: cfg.listen.dm.chat,
        ownerMid: owner.mid || null,
        ownerOk: owner.ok,
        ownerProblem: owner.problem ?? null,
        receiver,
        notifyEnabled: Boolean(channel?.enabled),
        sendSummary: Boolean(channel?.sendSummary),
        sendDiary: Boolean(channel?.sendDiary),
        sendVideoInfo: Boolean(channel?.sendVideoInfo),
        maxHistory: cfg.listen.dm.maxHistory,
        maxPerHour: cfg.listen.dm.maxPerHour,
        sentLastHour: ctx.chat.sentInLastHour(),
        todayCount: ctx.chat.today().length,
        last: ctx.chat.last()?.at ?? null,
      };
    },

    dmChat(limit: number) {
      return { items: ctx.chat.recent(limit), total: ctx.chat.all().length };
    },

    async dmSend(body: { text?: string; kind?: 'diary' | 'video_info'; bvid?: string }) {
      let diary: string | undefined;
      let videoText: string | undefined;
      if (body.kind === 'diary') {
        try {
          diary = fs.readFileSync(path.join(ctx.paths.diariesPublicDir, `${localDate()}.md`), 'utf8');
        } catch {
          diary = undefined;
        }
        if (!diary) return { ok: false, message: '今天还没有公开日记' };
      } else if (body.kind === 'video_info') {
        if (!body.bvid) return { ok: false, message: '缺少 bvid' };
        videoText = findTodayVideo(ctx, body.bvid)?.text;
        if (!videoText) return { ok: false, message: `${body.bvid} 不在今天的上下文里（只发今天出现过的视频）` };
      }

      return sendManualDm(
        {
          logger: ctx.logger,
          config: ctx.config.get(),
          quota: ctx.quota,
          state: ctx.state,
          writer: ctx.writer,
          secrets: ctx.secrets,
          chat: ctx.chat,
        },
        {
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.bvid ? { bvid: body.bvid } : {}),
          ...(diary !== undefined ? { diary } : {}),
          ...(videoText !== undefined ? { videoText } : {}),
        },
      );
    },

    dmClear() {
      const removed = ctx.chat.clear();
      return { ok: true, message: `已清空聊天记录（${removed} 条）` };
    },

    async listenNow() {
      const runner = deps.listenTick;
      if (!runner) return { skipped: ['监听循环没接上（夹具模式）'] };
      return runner();
    },
  } as AllHandlers;
}

/* ---------------- 小工具 ---------------- */

/** 从今天的报告里找一条视频（只发今天上下文里出现过的）。 */
function findTodayVideo(ctx: AppContext, bvid: string): { bvid: string; title: string; text: string } | null {
  let report = '';
  try {
    report = fs.readFileSync(path.join(ctx.paths.reportsDir, `${localDate()}.md`), 'utf8');
  } catch {
    return null;
  }
  if (!report.includes(bvid)) return null;
  const lines = report.split('\n');
  const prefix = `#### ${bvid} · `;
  const head = lines.find((line) => line.startsWith(prefix));
  const title = head ? head.replace(prefix, '').trim() : bvid;
  let understanding = '';
  for (const line of lines) {
    const one = /^-\s*一句话[:：]\s*(.+)$/.exec(line);
    if (one) {
      understanding = one[1] ?? '';
      break;
    }
  }
  const text = [title, `https://www.bilibili.com/video/${bvid}`, understanding ? `我觉得：${understanding}` : '']
    .filter((line) => line.length > 0)
    .join('\n');
  return { bvid, title, text };
}

function sanitizeConfigPatch(
  patch: unknown,
): { ok: true; value: Record<string, unknown>; dropped: string[] } | { ok: false; path: string; message: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, path: '', message: '配置补丁必须是一个对象' };
  }
  const known = new Set(Object.keys((SPEC as ObjectSpec).fields));
  // 这些是导出产物/历史保留字段，不属于配置本体，直接丢掉（不报错）
  const ignorable = new Set(['_exportedAt', '_unknown']);
  const value: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, item] of Object.entries(patch as Record<string, unknown>)) {
    if (ignorable.has(key)) continue;
    if (!known.has(key)) {
      dropped.push(key);
      continue;
    }
    value[key] = item;
  }
  if (Object.keys(value).length === 0 && dropped.length > 0) {
    return {
      ok: false,
      path: dropped[0] ?? '',
      message: `这些字段不在配置里：${dropped.slice(0, 6).join('、')}（多半是面板把值写到了错误路径）`,
    };
  }
  return { ok: true, value, dropped };
}

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
