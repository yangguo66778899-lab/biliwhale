/**
 * 真实 B 站接口冒烟（只读，不写任何东西）。
 *
 * 用途：验证 http 层（header / 限速 / 错误分类）、WBI 签名、字段映射在**真实响应**上是否成立。
 *   匿名也能跑，但字幕需要登录 cookie —— 没有 cookie 时字幕那一项会诚实地显示「0 条」。
 *
 * 用法：
 *   node scripts/smoke-bili.ts                 # 只用匿名
 *   BILIWHALE_COOKIE="SESSDATA=...; bili_jct=...; buvid3=..." node scripts/smoke-bili.ts
 *
 * 注意：这是诊断脚本，不是产品功能。它请求 6 次左右，全部串行、带间隔。
 */

import { Logger } from '../src/shared/logger.ts';
import { resolvePaths } from '../src/state/paths.ts';
import { BiliHttp } from '../src/bili/http.ts';
import { BiliApi, cuesToText, pickTrack } from '../src/bili/api.ts';

const COOKIE = process.env.BILIWHALE_COOKIE?.trim() ?? '';
/** 一个长期存在的公开视频，用作只读探针。 */
const PROBE_BVID = process.env.BILIWHALE_PROBE_BVID?.trim() || 'BV1GJ411x7h7';

const paths = resolvePaths();
const logger = new Logger({ logDir: paths.logsDir, eventsFile: paths.events, level: 'debug', mirrorToConsole: false });
const http = new BiliHttp({ cookie: COOKIE, logger, readIntervalMs: 1500, retries: 1, timeoutMs: 15_000 });
const api = new BiliApi(http, logger);
http.useSigner(api);

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  ✓ ${name.padEnd(18)} ${detail} (${Date.now() - started}ms)\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail: message });
    process.stdout.write(`  ✗ ${name.padEnd(18)} ${message} (${Date.now() - started}ms)\n`);
  }
}

function must<T>(result: { ok: true; data: T } | { ok: false; error: { kind: string; code: string | number; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.kind}/${String(result.error.code)}：${result.error.message}`);
  return result.data;
}

process.stdout.write(`\n真实 B 站只读冒烟（cookie：${COOKIE ? '已提供' : '匿名'}，探针 ${PROBE_BVID}）\n\n`);

let navMid = 0;
await step('nav', async () => {
  const nav = must(await api.nav());
  navMid = nav.mid;
  return nav.isLogin ? `已登录：${nav.uname}（${nav.mid}），wbi ${nav.imgUrl ? '有' : '缺'}` : '未登录（wbi 材料仍然拿到了）';
});

await step('wbi 签名', async () => {
  const mixin = must(await api.mixin());
  return `mixin 长度 ${mixin.length}`;
});

await step('搜索（需 WBI）', async () => {
  const list = must(await api.searchVideos('猫', { order: 'pubdate', page: 1 }));
  if (list.length === 0) throw new Error('返回 0 条（可能被限流或需要 cookie）');
  const first = list[0]!;
  return `${list.length} 条，第一条 ${first.bvid}「${first.title.slice(0, 24)}」时长 ${first.durationSec}s`;
});

await step('热门', async () => {
  const list = must(await api.popular(5));
  if (list.length === 0) throw new Error('返回 0 条');
  return `${list.length} 条，第一条 ${list[0]!.bvid}（评论 ${list[0]!.stats.reply}）`;
});

await step('视频详情', async () => {
  const video = must(await api.video(PROBE_BVID));
  if (!video.cid) throw new Error('没拿到 cid');
  return `${video.bvid} aid=${video.aid} cid=${video.cid} 时长 ${video.durationSec}s UP=${video.owner.name}`;
});

await step('评论（热评）', async () => {
  const video = must(await api.video(PROBE_BVID));
  const comments = must(await api.topComments(video.aid, 3));
  if (comments.length === 0) throw new Error('返回 0 条（评论区可能关闭）');
  const first = comments[0]!;
  return `${comments.length} 条，热评 ${first.like} 赞：「${first.message.slice(0, 30)}」`;
});

await step('字幕轨', async () => {
  const video = must(await api.video(PROBE_BVID));
  const tracks = must(await api.subtitleTracks(video.bvid, video.cid));
  if (tracks.length === 0) {
    return COOKIE ? '0 条（这条视频没有字幕轨）' : '0 条（匿名请求拿不到字幕，属预期）';
  }
  const picked = pickTrack(tracks);
  const cues = picked ? must(await api.subtitleCues(picked.url, video.bvid)) : [];
  const text = cuesToText(cues);
  return `${tracks.length} 条轨，选 ${picked?.lan ?? '-'}，正文 ${text.length} 字`;
});

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n结果：${results.length - failed.length}/${results.length} 项通过${navMid ? `（nav mid=${navMid}）` : ''}\n` +
    (failed.length > 0 ? `失败项：${failed.map((f) => `${f.name}→${f.detail}`).join('；')}\n` : '') +
    `\n日志：${paths.logsDir}\n`,
);

process.exitCode = failed.length > 0 ? 1 : 0;
