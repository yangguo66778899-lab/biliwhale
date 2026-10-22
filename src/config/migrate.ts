/**
 * 配置 schema 迁移（**不是**旧数据导入）。
 *
 * 为什么需要：升级时用户的老 `config.json` 可能缺新字段、或者字段语义变了（例如 M4 把「主人」从登录账号里拆出来）。
 *   我们要的是「老配置能继续用」，不是「把旧版本的数据目录搬过来」——后者明确不做。
 *
 * 规则：
 *   - 迁移函数是纯函数：`(raw) => { config, notes }`，只负责把该补的字段补上、该改形状的改掉；
 *   - 只往前走（1 → 2 → 3…），每一步都必须幂等；
 *   - 迁移后一定把 `version` 写成当前版本，落盘由 ConfigService 负责；
 *   - 缺字段一律补**新的默认值**，不猜用户意图；猜不出来就在 notes 里写清楚让用户去面板改。
 */

export const CURRENT_CONFIG_VERSION = 2;

export interface MigrationContext {
  /** 这份配置来自哪个旧版本（读不到就当 1）。 */
  from: number;
  /** 程序版本，写进 notes 方便排障。 */
  appVersion?: string;
}

export interface MigrationResult {
  config: Record<string, unknown>;
  /** 实际执行了哪些迁移（面板/日志会显示）。 */
  applied: string[];
  /** 需要用户注意的事（例如「主人 UID 还没填」）。 */
  notes: string[];
  from: number;
  to: number;
}

type Migrator = (config: Record<string, unknown>, notes: string[]) => void;

/** 每一步迁移：key 是「从哪个版本升上来」。 */
const MIGRATIONS: Record<number, { name: string; run: Migrator }> = {
  1: {
    name: 'v1→v2：补 ownerMid/ownerName 与 updateUrl，明确「主人 ≠ 登录账号」',
    run: (config, notes) => {
      const account = asObject(config.account);
      if (account) {
        if (typeof account.ownerMid !== 'number') {
          account.ownerMid = 0;
          notes.push('「主人 UID」还没填：@、私信、聊天都发给它，请到面板「账号」页填你自己的 B 站 UID（必须是另一个号）');
        }
        if (typeof account.ownerName !== 'string') account.ownerName = '';
        config.account = account;
      }

      const app = asObject(config.app);
      if (app && typeof app.updateUrl !== 'string') {
        app.updateUrl = '';
        config.app = app;
      }
    },
  },
};

/** 对一份原始配置跑迁移；不认识的结构原样返回。 */
export function migrateConfig(raw: unknown, context: MigrationContext = { from: 1 }): MigrationResult {
  const applied: string[] = [];
  const notes: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: {}, applied, notes: ['配置不是对象，已放弃迁移（会用默认值启动）'], from: context.from, to: CURRENT_CONFIG_VERSION };
  }

  const config = deepClone(raw as Record<string, unknown>);
  const declared = typeof config.version === 'number' && Number.isFinite(config.version) ? Math.floor(config.version) : 0;
  const from = context.from > 0 ? Math.max(context.from, declared) : declared || 1;

  if (from > CURRENT_CONFIG_VERSION) {
    return {
      config,
      applied,
      notes: [`配置版本 ${from} 比程序认识的 ${CURRENT_CONFIG_VERSION} 还新（可能装回了旧版），已原样使用，字段可能对不上`],
      from,
      to: from,
    };
  }

  let version = Math.max(1, from);
  while (version < CURRENT_CONFIG_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    try {
      step.run(config, notes);
      applied.push(step.name);
    } catch (err) {
      notes.push(`迁移「${step.name}」失败：${String(err)}（会继续用能读的字段）`);
      break;
    }
    version += 1;
  }

  config.version = CURRENT_CONFIG_VERSION;
  return { config, applied, notes, from, to: CURRENT_CONFIG_VERSION };
}

/** 跑一遍迁移但只在有变化时返回（避免每次启动都写盘）。 */
export function needsMigration(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const version = (raw as Record<string, unknown>).version;
  const declared = typeof version === 'number' && Number.isFinite(version) ? Math.floor(version) : 1;
  return declared < CURRENT_CONFIG_VERSION;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
