/**
 * 错误分类。
 *
 * 职责：把「失败」变成上层能决策的东西（要不要重试、要不要降级、要不要停手）。
 * 不做什么：不做重试本身（重试在 http 层），不打印栈给用户。
 */

export type BiliErrorKind =
  | 'auth' // -101 未登录 / -111 csrf 失败 → 停写、通知重登
  | 'risk' // 412 / -412 / -352 / -509 / 12015 / 12051 → 立刻停手、冷却
  | 'rate' // 429 / 频率限制 → 退避重试
  | 'network' // 超时 / DNS / 5xx → 退避重试，仍失败则降级只读
  | 'notfound' // 视频删除 / 私密 → 跳过
  | 'parse' // 响应结构变了 → 跳过该条 + 告警
  | 'business' // 其它 code != 0 → 不重试
  | 'internal'; // 我们自己代码的问题

export interface AppErrorShape {
  kind: BiliErrorKind;
  code: string | number;
  message: string;
  /** 原始响应片段（已脱敏，用于排障，绝不整段 HTML）。 */
  rawSnippet?: string;
}

export class AppError extends Error {
  readonly kind: BiliErrorKind;
  readonly code: string | number;
  readonly rawSnippet?: string;

  constructor(kind: BiliErrorKind, code: string | number, message: string, rawSnippet?: string) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.code = code;
    if (rawSnippet !== undefined) this.rawSnippet = rawSnippet.slice(0, 500);
  }

  toShape(): AppErrorShape {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      ...(this.rawSnippet ? { rawSnippet: this.rawSnippet } : {}),
    };
  }

  /** 这类错误还值得重试吗？ */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'rate';
  }
}

/** 统一结果：工具/接口都返回它，上层不需要 try/catch 满天飞。 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function fail<T = never>(kind: BiliErrorKind, code: string | number, message: string): Result<T> {
  return { ok: false, error: { kind, code, message } };
}

export function fromError<T = never>(err: unknown): Result<T> {
  if (err instanceof AppError) return { ok: false, error: err.toShape() };
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { kind: 'internal', code: 'internal', message } };
}

/** 把任意异常收成一句人话（给报告/通知/日志用，不带栈）。 */
export function humanError(err: unknown): string {
  if (err instanceof AppError) return `${err.message}（${err.kind}/${String(err.code)}）`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** B 站业务码 → 错误分类。集中在一处，避免每个接口各判一套。 */
export function classifyBiliCode(code: number): BiliErrorKind {
  switch (code) {
    case -101:
    case -111:
    case -400:
      return code === -400 ? 'business' : 'auth';
    case 412:
    case -412:
    case -352:
    case -509:
    case 12015:
    case 12051:
      return 'risk';
    case -404:
    case 62002:
    case 62004:
      return 'notfound';
    case -799:
      return 'rate';
    default:
      return 'business';
  }
}

/** HTTP 状态码 → 错误分类。 */
export function classifyHttpStatus(status: number): BiliErrorKind {
  if (status === 412) return 'risk';
  if (status === 429) return 'rate';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status >= 500) return 'network';
  return 'business';
}
