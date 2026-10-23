/**
 * 装配：把配置、账本、B 站客户端、模型客户端拼成一个可直接用的上下文。
 *
 * 职责：CLI（run/doctor/config）与守护进程（serve）共用同一套装配，避免两边各写一份。
 * 不做什么：不解析命令行、不决定跑什么（那些在 cli.ts / daemon.ts）。
 */

import type { Config } from './config/spec.ts';
import { ConfigService } from './config/service.ts';
import { SecretsService } from './config/secrets.ts';
import { ensureLayout, resolvePaths } from './state/paths.ts';
import type { Paths } from './state/paths.ts';
import { AppStateStore } from './state/appState.ts';
import { FeedbackLedger, QuotaLedger, SeenLedger } from './state/ledgers.ts';
import { RunStore } from './state/runs.ts';
import { Logger } from './shared/logger.ts';
import { localIso } from './shared/time.ts';
import { createBili } from './bili/api.ts';
import type { BiliApi } from './bili/api.ts';
import type { Transport } from './bili/http.ts';
import { BiliWriter } from './bili/write.ts';
import { PendingStore } from './state/pending.ts';
import { RepliedLedger } from './state/replied.ts';
import { ChatStore } from './state/chatStore.ts';
import { LlmClient } from './llm/client.ts';
import { discoverModel, keyFingerprint } from './llm/discovery.ts';
import { ensurePromptFiles } from './agent/prompts.ts';

export interface BootstrapOptions {
  dataDir?: string;
  /** 夹具模式：真实 B 站与模型都用离线替身。 */
  fixtures?: boolean;
  /** 真实 B 站 + 占位模型（只验证链路）。 */
  mockModel?: boolean;
  /** CLI 要把日志打到控制台；守护进程不需要。 */
  mirrorToConsole?: boolean;
  /** 启动时按 key 自动发现模型（夹具模式自动跳过）。 */
  discover?: boolean;
}

export interface AppContext {
  paths: Paths;
  logger: Logger;
  config: ConfigService;
  secrets: SecretsService;
  state: AppStateStore;
  seen: SeenLedger;
  quota: QuotaLedger;
  feedback: FeedbackLedger;
  runs: RunStore;
  api: BiliApi;
  /** 写能力（评论/楼中楼/删自己的评论/收藏/点赞/私信/动态）。 */
  writer: BiliWriter;
  /** 待审回复草稿。 */
  pending: PendingStore;
  /** 谁回过我们。 */
  replied: RepliedLedger;
  /** 和主人的聊天记录（chat/owner.jsonl）。 */
  chat: ChatStore;
  /** 原始传输层（登录要读 Set-Cookie）。 */
  transport: Transport;
  llm: LlmClient;
  /** 配置里写的模型名（和「实际用的」对照）。 */
  configuredModel: string;
  fixtures: boolean;
  mockModel: boolean;
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<AppContext> {
  const paths = resolvePaths(opts.dataDir ? { dataDir: opts.dataDir } : {});
  ensureLayout(paths);

  const logger = new Logger({
    logDir: paths.logsDir,
    eventsFile: paths.events,
    mirrorToConsole: opts.mirrorToConsole ?? false,
    level: 'info',
  });

  const config = new ConfigService(paths.dataDir, logger);
  const loaded = config.load();
  if (loaded.origin !== 'file') logger.info('core', `配置来源：${loaded.origin}`);
  const current: Config = config.get();
  logger.setLevel(current.logging.level);

  const secrets = new SecretsService(paths.dataDir, logger);
  ensurePromptFiles(paths, logger);

  const state = new AppStateStore(paths.state, logger);
  const seen = SeenLedger.open(paths.seen, logger);
  const quota = QuotaLedger.open(paths.quota, logger);
  const feedback = FeedbackLedger.open(paths.feedback, logger);
  const runs = new RunStore(paths.runsDir, logger);
  const recovered = runs.recoverInterrupted();
  if (recovered.length > 0) logger.warn('core', `恢复了 ${recovered.length} 条上次未完成的运行记录`);

  // 撞风控：
  //   - 写请求（POST）→ 45 分钟写冷却（这是真的该停手）；
  //   - 读请求（GET）→ 只写「读冷却」，**不动写冷却**。理由：看画面/字幕这种可选读吃一次 412，
  //     不该让整轮挑中了却发不出去（2026-10-22 真机事故）。写请求自己撞了 412 会再进写冷却。
  const READ_RISK_COOLDOWN_MIN = 10;
  const onRisk = (message: string, info: { method: string }): void => {
    const isWrite = String(info?.method ?? 'GET').toUpperCase() === 'POST';
    if (isWrite) {
      const until = new Date(Date.now() + current.safety.riskCooldownMin * 60_000);
      state.setRiskCooldown(localIso(until));
      logger.error('bili', `写请求撞风控：${message}，已冷却到 ${localIso(until)}`);
      logger.event('risk', `写请求撞风控，冷却 ${current.safety.riskCooldownMin} 分钟`, { level: 'error' });
      return;
    }
    const until = new Date(Date.now() + READ_RISK_COOLDOWN_MIN * 60_000);
    state.setReadCooldown(localIso(until));
    logger.warn('bili', `读请求被限流：${message}，读冷却到 ${localIso(until)}（写操作不受影响）`);
    logger.event('risk', `读请求被限流，读冷却 ${READ_RISK_COOLDOWN_MIN} 分钟（不影响写）`, { level: 'warn' });
  };

  let api: BiliApi;
  let transport: Transport;
  let llm: LlmClient;

  if (opts.fixtures) {
    const offline = await import('./dev/offline.ts');
    const built = offline.createOfflineStack({ paths, logger, config: current });
    api = built.api;
    transport = built.transport;
    llm = built.llm;
  } else {
    const bili = createBili({ cookie: () => secrets.cookie(), logger, onRisk });
    api = bili.api;
    transport = bili.http;
    llm = new LlmClient({
      apiKey: secrets.apiKey(),
      baseUrl: current.llm.baseUrl,
      model: current.llm.model,
      temperature: current.llm.temperature,
      maxTokens: current.llm.maxTokens,
      timeoutMs: current.llm.timeoutMs,
      maxRetries: current.llm.maxRetries,
      logger,
    });
    if (opts.mockModel) {
      // 真实 B 站 + 占位模型：验证「真实数据能不能走完整轮」，不代表模型质量
      const mock = await import('./dev/mockModel.ts');
      const handle = mock.makeMockModelFetch({ logger });
      llm = new LlmClient({
        apiKey: 'mock',
        baseUrl: 'https://mock.local',
        model: 'mock-model',
        temperature: 0,
        maxTokens: current.llm.maxTokens,
        timeoutMs: 10_000,
        maxRetries: 0,
        logger,
        fetchImpl: handle.fetchImpl,
      });
    }
  }

  const writer = new BiliWriter({ http: transport, csrf: () => secrets.biliJct(), logger });

  const configuredModel = current.llm.model;
  if ((opts.discover ?? true) && !opts.fixtures && !opts.mockModel && secrets.hasApiKey() && current.llm.modelAuto) {
    const decision = await discoverModel({ client: llm, configured: configuredModel, modelAuto: current.llm.modelAuto, logger });
    if (decision.model !== llm.model) llm.setModel(decision.model);
    state.setModelCache({ name: decision.model, discoveredAt: localIso(), keyFingerprint: keyFingerprint(secrets.apiKey()) });
  }

  // 登录账号的显示字段自动回填（settings 里那两个是「鲸鲸自己」，不是主人）。
  // 只补空白，不覆盖用户手改过的值；失败不外抛（只是显示）。
  try {
    const hint = secrets.accountHint();
    if (hint.mid && hint.mid > 0) {
      const cfg = config.get();
      const patch: { mid?: number; name?: string } = {};
      if (!cfg.account.mid) patch.mid = hint.mid;
      if (!cfg.account.name && hint.uname) patch.name = hint.uname;
      if (Object.keys(patch).length > 0) config.patch({ account: patch });
    }
  } catch (err) {
    logger.warn('core', `登录账号显示字段回填失败（不影响运行）：${String(err)}`);
  }

  return {
    paths,
    logger,
    config,
    secrets,
    state,
    seen,
    quota,
    feedback,
    runs,
    api,
    writer,
    pending: PendingStore.open(paths.pendingReplies, logger),
    replied: RepliedLedger.open(paths.replied, logger),
    chat: new ChatStore(paths.chatOwner, logger),
    transport,
    llm,
    configuredModel,
    fixtures: opts.fixtures ?? false,
    mockModel: opts.mockModel ?? false,
  };
}

/**
 * 主人昵称的自动补全（后台的一次性小动作，不阻塞启动）：
 * 主人 UID 已填、昵称空着、且不是夹具模式时，按 UID 取一次名片并写回配置。
 * 取不到就留着空，让用户在面板里手填——不猜、不拿登录账号顶替。
 */
export async function fillOwnerName(ctx: AppContext): Promise<void> {
  if (ctx.fixtures || ctx.mockModel) return;
  const cfg = ctx.config.get();
  if (!cfg.account.ownerMid || cfg.account.ownerMid <= 0) return;
  if (cfg.account.ownerName.trim().length > 0) return;
  if (cfg.account.ownerMid === ctx.secrets.selfMid()) {
    ctx.logger.warn('account', '主人 UID 填成了登录账号本身：主人必须是另一个号（去「账号」页改）');
    return;
  }
  const card = await ctx.api.userCard(cfg.account.ownerMid);
  if (!card.ok) {
    ctx.logger.warn('account', `没取到主人昵称（${card.error.message}），请在「账号」页手填`);
    return;
  }
  ctx.config.patch({ account: { ownerName: card.data.name } });
  ctx.logger.info('account', `主人昵称已自动填好：${card.data.name}（${card.data.mid}）`);
}
