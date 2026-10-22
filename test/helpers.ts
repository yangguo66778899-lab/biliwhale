import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RoundDeps } from '../src/orchestrator/round.ts';
import type { Paths } from '../src/state/paths.ts';

/** 测试用临时目录：放在仓库内（沙箱允许写），每次调用一个新目录。 */
export function tmpDir(prefix: string): string {
  const base = path.join(process.cwd(), 'test', '.tmp');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${prefix}-`));
  return dir;
}

/** 仓库根（fixtures 相对它定位）。 */
export function repoRoot(): string {
  return process.cwd();
}

/** 临时设置环境变量，返回恢复函数。 */
export function withEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function osTmp(): string {
  return os.tmpdir();
}

/**
 * 建一套「离线 + 真落盘」的整轮依赖（golden 与多轮测试共用）。
 * 每次调用都拿一套全新的账本与一套全新的夹具剧本（脚本化模型从第一条响应重新开始）。
 */
export async function createTestRound(dir: string): Promise<{
  deps: RoundDeps;
  offline: { llmCalls: () => number };
  paths: Paths;
}> {
  const { Logger } = await import('../src/shared/logger.ts');
  const { ConfigService } = await import('../src/config/service.ts');
  const { SecretsService } = await import('../src/config/secrets.ts');
  const { ensureLayout, resolvePaths } = await import('../src/state/paths.ts');
  const { AppStateStore } = await import('../src/state/appState.ts');
  const { FeedbackLedger, QuotaLedger, SeenLedger } = await import('../src/state/ledgers.ts');
  const { RunStore } = await import('../src/state/runs.ts');
  const { createOfflineStack } = await import('../src/dev/offline.ts');

  const paths = resolvePaths({ dataDir: dir });
  ensureLayout(paths);
  const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'error' });
  const config = new ConfigService(paths.dataDir, logger);
  config.load();
  const cfg = config.get();
  const secrets = new SecretsService(paths.dataDir, logger);
  const state = new AppStateStore(paths.state, logger);
  const seen = SeenLedger.open(paths.seen, logger);
  const quota = QuotaLedger.open(paths.quota, logger);
  const feedback = FeedbackLedger.open(paths.feedback, logger);
  const runs = new RunStore(paths.runsDir, logger);
  const offline = createOfflineStack({ paths, logger, config: cfg, fixturesDir: path.join(process.cwd(), 'fixtures') });

  const deps: RoundDeps = {
    paths,
    config,
    secrets,
    logger,
    api: offline.api,
    llm: offline.llm,
    state,
    seen,
    quota,
    feedback,
    runs,
    configuredModel: cfg.llm.model,
  };
  return { deps, offline, paths };
}
