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

  // 撞风控 → 写冷却时间（编排器据此拒绝写操作）
  const onRisk = (message: string): void => {
    const until = new Date(Date.now() + current.safety.riskCooldownMin * 60_000);
    state.setRiskCooldown(localIso(until));
    logger.error('bili', `撞风控：${message}，已冷却到 ${localIso(until)}`);
    logger.event('risk', `撞风控，冷却 ${current.safety.riskCooldownMin} 分钟`, { level: 'error' });
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

  const configuredModel = current.llm.model;
  if ((opts.discover ?? true) && !opts.fixtures && !opts.mockModel && secrets.hasApiKey() && current.llm.modelAuto) {
    const decision = await discoverModel({ client: llm, configured: configuredModel, modelAuto: current.llm.modelAuto, logger });
    if (decision.model !== llm.model) llm.setModel(decision.model);
    state.setModelCache({ name: decision.model, discoveredAt: localIso(), keyFingerprint: keyFingerprint(secrets.apiKey()) });
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
    transport,
    llm,
    configuredModel,
    fixtures: opts.fixtures ?? false,
    mockModel: opts.mockModel ?? false,
  };
}
