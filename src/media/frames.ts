/**
 * 看画面（抽帧）—— §7.10。
 *
 * 职责：把一条视频变成「模型能看的图」：取低清 mp4（要 cookie）→ ffmpeg 等距抽 9 帧拼 3×3 九宫格，
 *   无字幕轨时再裁画面下方做「字幕条」（每 7 秒一帧竖拼，等于把硬字幕读出来）→ 转成 data URL 交给 LLM。
 *   脚本只备素材、不作判断；看什么、写什么由模型决定。
 *
 * 硬性约束（§7.10，全部在这里兜住）：
 *   - **默认关**：`media.frames=false` 时一步都不做；
 *   - ffmpeg 缺失 / 下载失败 / 超时 → 只降级成纯文本，返回「没看画面：<原因>」，**绝不**让整轮失败；
 *   - 超时按视频时长算：`120s + 时长 × 1.5`（参考项目踩过：25 分钟片子用默认 120s 必超时）；
 *   - 缓存限量（条数 + 总 MB），视频抽完帧立刻删；**不把视频/图片写进报告、日志、诊断包**；
 *   - 一次最多 2 张（九宫格 + 字幕条），每张按 ≤1024 token 预留。
 *
 * 不做什么：不判断内容好坏、不改 prompt、不写报告（由 round.ts / prompts.ts 决定）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Config } from '../config/spec.ts';
import type { Paths } from '../state/paths.ts';
import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import { DEFAULT_UA } from '../bili/http.ts';
import { ensureDir } from '../shared/atomic.ts';
import { localStamp } from '../shared/time.ts';

/** 每张图的 token 上限（DeepSeek Vision 文档：单图 ≤1024 token）。 */
const TOKENS_PER_IMAGE = 1024;
/** 字幕条最多拼几帧（越少越省 token；12 帧约覆盖 84 秒起）。 */
const STRIP_ROWS = 12;
/** 缓存：最多留多少个文件、多少 MB。 */
const CACHE_MAX_FILES = 24;
const CACHE_MAX_MB = 300;

export interface VisualTarget {
  bvid: string;
  cid: number;
  title: string;
  durationSec: number;
  /** 有没有真的拿到字幕轨（决定要不要做字幕条）。 */
  hasSubtitles: boolean;
}

export type VisualStatus = 'off' | 'ok' | 'skipped' | 'failed';

/** 写进 run 记录的部分：只记状态与路径，**不存图片本身**。 */
export interface VisualRecord {
  status: VisualStatus;
  bvid?: string;
  reason?: string;
  frames?: number;
  sheet?: string;
  strip?: string;
  bytes?: number;
}

export interface VisualResult {
  status: VisualStatus;
  /** 写进报告的一句人话：「看了画面：…」或「没看画面：<原因>」。 */
  note: string;
  /** `data:image/jpeg;base64,...`（最多 2 张）。 */
  images: string[];
  /** 在 runBudgetTokens 里预留的额度。 */
  tokenReserve: number;
  record: VisualRecord;
}

/** 测试/夹具注入点：不注入就走真实实现。 */
export interface VisualOverrides {
  download?: (url: string, dest: string, timeoutMs: number) => Promise<void>;
  runFfmpeg?: (args: string[], timeoutMs: number) => Promise<void>;
  /** undefined = 自动探测；null = 当作没装；字符串 = 当作这个路径可用。 */
  ffmpegPath?: string | null;
  /** 夹具/测试：跳过下载，直接用这段本地 mp4。 */
  videoFile?: string;
}

export interface VisualDeps {
  config: Config;
  paths: Paths;
  logger: Logger;
  /** 取播放地址（bili 层，要 cookie + 签名）。 */
  playUrl: (bvid: string, cid: number) => Promise<Result<{ url: string }>>;
  overrides?: VisualOverrides;
}

/** 超时：按视频时长算（§7.10 明写，别用固定 120s）。上限 1 小时只是防止离谱时长把信号拖太久。 */
export function mediaTimeoutMs(durationSec: number): number {
  const base = 120_000;
  const scaled = Math.round(Math.max(0, durationSec) * 1500);
  return Math.min(base + scaled, 60 * 60_000);
}

/** 九宫格参数：抽 n 帧，按列优先拼成一张图。 */
export function sheetFilter(frames: number, durationSec: number): string {
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);
  const fps = durationSec > 0 ? frames / durationSec : 0.1;
  return `fps=${fps.toFixed(6)},scale=426:-2,tile=${cols}x${rows}:padding=4:color=black`;
}

/** 字幕条参数：裁画面下方 32%，每 interval 秒一帧竖拼。 */
export function stripFilter(durationSec: number): { filter: string; intervalSec: number } {
  const intervalSec = Math.max(7, durationSec / STRIP_ROWS);
  const fps = 1 / intervalSec;
  return {
    intervalSec,
    filter: `fps=${fps.toFixed(6)},crop=iw:ih*0.32:0:ih*0.68,scale=iw:-2,tile=1x${STRIP_ROWS}:padding=2:color=black`,
  };
}

export function buildSheetArgs(input: { video: string; out: string; frames: number; durationSec: number }): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input.video,
    '-vf',
    sheetFilter(input.frames, input.durationSec),
    '-frames:v',
    '1',
    '-q:v',
    '4',
    input.out,
  ];
}

export function buildStripArgs(input: { video: string; out: string; durationSec: number }): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input.video,
    '-vf',
    stripFilter(input.durationSec).filter,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    input.out,
  ];
}

/**
 * 看一条视频的画面。**任何一步失败都返回 skipped/failed + 人话原因，不抛异常。**
 * 调用方只需要 `images`（喂给 LLM）和 `note`（写进报告）。
 */
export async function prepareVisuals(deps: VisualDeps, target: VisualTarget): Promise<VisualResult> {
  const cfg = deps.config.media;
  const overrides = deps.overrides ?? {};
  if (!cfg.frames) {
    return offResult('不看画面：模型只读标题/简介/字幕/评论（设置 → 看画面 可以打开）');
  }

  const ffmpeg = overrides.ffmpegPath !== undefined ? overrides.ffmpegPath : await probeFfmpeg(cfg.ffmpegPath);
  if (!ffmpeg) {
    return skipped(`没看画面：没装 ffmpeg（装了，或在「设置 → 看画面」里填 ffmpeg 完整路径）`);
  }

  const timeoutMs = mediaTimeoutMs(target.durationSec);
  const dir = mediaDir(deps.paths);
  ensureDir(dir);
  pruneMediaCache(dir);

  const stamp = `${localStamp()}-${sanitize(target.bvid)}`;
  const videoFile = overrides.videoFile ? overrides.videoFile : path.join(dir, `${stamp}.mp4`);
  const ownsVideo = !overrides.videoFile;
  const sheetFile = path.join(dir, `${stamp}-sheet.jpg`);
  const stripFile = path.join(dir, `${stamp}-strip.jpg`);
  const runFfmpeg = overrides.runFfmpeg ?? defaultRunFfmpeg;

  try {
    if (ownsVideo) {
      const info = await deps.playUrl(target.bvid, target.cid);
      if (!info.ok) {
        const raw = info.error.message;
        // 412 是「账号被限流」，不是「这条视频没地址」——措辞要让人看懂该怎么办
        const reason = /412|限流/.test(raw) ? 'B 站限流了（HTTP 412），这轮按纯文本跑' : `取不到视频地址（${raw}）`;
        return skipped(`没看画面：${reason}`);
      }
      const url = String(info.data?.url ?? '').trim();
      if (!url) return skipped('没看画面：取不到视频地址（接口没给播放链接）');
      try {
        const download = overrides.download ?? defaultDownload;
        await download(url, videoFile, timeoutMs);
      } catch (err) {
        return skipped(`没看画面：视频没下载成功（${humanError(err)}）`);
      }
    }

    // 九宫格
    try {
      await runFfmpeg(buildSheetArgs({ video: videoFile, out: sheetFile, frames: cfg.frameCount, durationSec: target.durationSec }), timeoutMs);
    } catch (err) {
      return skipped(`没看画面：抽帧失败（${humanError(err)}）`);
    }
    if (!fileHasBytes(sheetFile)) return skipped('没看画面：抽帧没有产出图片');

    // 字幕条：只在没有字幕轨时才做（有字幕就不必从画面里读字）
    let strip: string | null = null;
    let stripReason = '';
    if (!target.hasSubtitles && cfg.subtitleStrip) {
      try {
        await runFfmpeg(buildStripArgs({ video: videoFile, out: stripFile, durationSec: target.durationSec }), timeoutMs);
        strip = fileHasBytes(stripFile) ? stripFile : null;
        if (!strip) stripReason = '字幕条没有产出图片';
      } catch (err) {
        stripReason = `字幕条没做成（${humanError(err)}）`;
      }
    }

    const images: string[] = [toDataUrl(sheetFile)];
    if (strip) images.push(toDataUrl(strip));

    const stripNote = strip ? ' + 字幕条' : '';
    const note = `看了画面：${target.bvid}（九宫格 ${cfg.frameCount} 帧${stripNote}${stripReason ? `；${stripReason}` : ''}）`;
    const bytes = fileSize(sheetFile) + (strip ? fileSize(strip) : 0);
    return {
      status: 'ok',
      note,
      images,
      tokenReserve: images.length * TOKENS_PER_IMAGE,
      record: {
        status: 'ok',
        bvid: target.bvid,
        frames: cfg.frameCount,
        sheet: path.basename(sheetFile),
        ...(strip ? { strip: path.basename(stripFile) } : {}),
        bytes,
      },
    };
  } finally {
    // 视频用完即删：抽完帧就没用了，留着只占磁盘
    if (ownsVideo) {
      try {
        fs.rmSync(videoFile, { force: true });
      } catch {
        /* 删不掉不影响这一轮 */
      }
    }
  }
}

/* ---------------- 缓存 ---------------- */

export function mediaDir(paths: Paths): string {
  return path.join(paths.cacheDir, 'media');
}

/** 按「条数 + 总 MB」清理缓存；新的留着，旧的删掉。返回删了几个。 */
export function pruneMediaCache(dir: string, limits: { maxFiles?: number; maxMb?: number } = {}): number {
  const maxFiles = limits.maxFiles ?? CACHE_MAX_FILES;
  const maxBytes = (limits.maxMb ?? CACHE_MAX_MB) * 1024 * 1024;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const entries: Array<{ file: string; size: number; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jpg') && !name.endsWith('.mp4')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      entries.push({ file, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      /* 单个文件读不到不影响清理其它 */
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let kept = 0;
  let bytes = 0;
  let removed = 0;
  for (const entry of entries) {
    const overCount = kept >= maxFiles;
    const overBytes = bytes + entry.size > maxBytes;
    if (overCount || overBytes) {
      try {
        fs.rmSync(entry.file, { force: true });
        removed += 1;
      } catch {
        /* 删不掉的留到下次 */
      }
      continue;
    }
    kept += 1;
    bytes += entry.size;
  }
  return removed;
}

/* ---------------- ffmpeg / 下载 ---------------- */

/** 探测 ffmpeg：配置了路径就用它，否则试一次 `ffmpeg -version`（不装就没有，返回 null）。 */
export async function probeFfmpeg(configured: string): Promise<string | null> {
  const custom = String(configured ?? '').trim();
  if (custom) return fs.existsSync(custom) ? custom : null;
  try {
    await defaultRunFfmpeg(['-version'], 8_000);
    return 'ffmpeg';
  } catch {
    return null;
  }
}

function defaultRunFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // 注意：某些环境里 execFile 会**同步抛**（例如创建管道被拒 → spawn EPERM），
    // 那种情况下不会走回调，所以要包 try/catch。
    try {
      execFile('ffmpeg', args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) {
          reject(friendlyFfmpegError(err, stderr));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(friendlyFfmpegError(err, ''));
    }
  });
}

/** spawn 层面的失败要给成人话：用户看到「spawn EPERM」只会以为程序坏了。 */
function friendlyFfmpegError(err: unknown, stderr: string): Error {
  const code = String((err as NodeJS.ErrnoException)?.code ?? '');
  const message = err instanceof Error ? err.message : String(err);
  const raw = `${code} ${message}`;
  const hint = /ENOENT/.test(raw)
    ? '找不到 ffmpeg，路径不对？'
    : /EPERM|EACCES|spawn/i.test(raw)
      ? '调不起 ffmpeg：没权限，可能被杀毒软件拦了'
      : '';
  const detail = String(stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
  return new Error([hint, detail].filter((part) => part.length > 0).join('：') || message);
}

async function defaultDownload(url: string, dest: string, timeoutMs: number): Promise<void> {
  ensureDir(path.dirname(dest));
  const res = await fetch(url, {
    // 直链按接口规格文档的写法带 UA + Referer + range（有些 CDN 不带 range 会给整段重定向）
    headers: { 'user-agent': DEFAULT_UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('下载到 0 字节');
  await fs.promises.writeFile(dest, buf);
}

/* ---------------- 小工具 ---------------- */

function offResult(note: string): VisualResult {
  return { status: 'off', note, images: [], tokenReserve: 0, record: { status: 'off' } };
}

function skipped(note: string): VisualResult {
  return { status: 'skipped', note, images: [], tokenReserve: 0, record: { status: 'skipped', reason: note.replace(/^没看画面：/, '') } };
}

function fileHasBytes(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function toDataUrl(file: string): string {
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
}

function sanitize(text: string): string {
  return String(text).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

function humanError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { TOKENS_PER_IMAGE };
