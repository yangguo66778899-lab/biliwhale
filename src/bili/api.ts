/**
 * B 站只读能力（api 层）。
 *
 * 职责：把 HTTP 响应映射成领域类型（`BiliVideo` / `SubtitleTrack` / `CommentItem`），
 *   并把「字段可能缺失/类型可能变化」的地方都做容错与截断。
 * 不做什么：不做限速与重试（http 层）、不做打分与判断（模型层）、不写任何东西。
 *
 * 接口依据见 `docs/bili-readonly-api-spec.md`（从两个参考项目整理，含 WBI 算法与字段路径）。
 */

import type { Logger } from '../shared/logger.ts';
import type { Result } from '../shared/errors.ts';
import { classifyBiliCode } from '../shared/errors.ts';
import type { BiliOwner, BiliStats, BiliVideo, CandidateSource, CommentItem, SubtitleCue, SubtitleTrack } from '../shared/types.ts';
import { BiliHttp } from './http.ts';
import type { Transport, WbiProvider } from './http.ts';
import { mixinFromUrls } from './wbi.ts';

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const REFERER_SEARCH = 'https://search.bilibili.com/';
const REFERER_VIDEO = 'https://www.bilibili.com/video/';
const REFERER_HOME = 'https://www.bilibili.com/';

export interface NavInfo {
  isLogin: boolean;
  mid: number;
  uname: string;
  imgUrl: string;
  subUrl: string;
  level: number;
  /** 发评论/动态前 B 站要求手机号已验证（写操作才会用到）。 */
  mobileVerified: boolean;
}

export interface SearchOptions {
  page?: number;
  order?: 'totalrank' | 'click' | 'pubdate';
}

const MIXIN_TTL_MS = 6 * 60 * 60 * 1000;

export class BiliApi implements WbiProvider {
  private readonly http: Transport;
  private readonly logger: Logger;
  private readonly now: () => number;
  private mixinCache: { value: string; at: number } | null = null;

  constructor(http: Transport, logger: Logger, now: () => number = () => Date.now()) {
    this.http = http;
    this.logger = logger;
    this.now = now;
  }

  /* ---------- 认证 ---------- */

  async nav(): Promise<Result<NavInfo>> {
    // 用「未解包」的调用：匿名时 B 站返回 code=-101（未登录），但 data 里照样带 wbi_img，
    // 而签名材料正是从那里来的 —— 当错误丢掉就没法匿名读搜索。
    const env = await this.http.jsonEnvelope<NavRaw>({ url: `${API}/x/web-interface/nav`, referer: REFERER_HOME });
    if (!env.ok) return env;

    const { code, message, data } = env.data;
    if (code !== 0 && code !== -101) {
      return { ok: false, error: { kind: classifyBiliCode(code), code, message: message || `nav 返回 ${code}` } };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: { kind: 'parse', code: 'parse', message: 'nav 响应里没有 data' } };
    }
    return {
      ok: true,
      data: {
        isLogin: Boolean(data.isLogin),
        mid: numOr(data.mid, 0),
        uname: str(data.uname),
        imgUrl: str(data.wbi_img?.img_url),
        subUrl: str(data.wbi_img?.sub_url),
        level: numOr(data.level_info?.current_level, 0),
        mobileVerified: Boolean(data.mobile_verified),
      },
    };
  }

  /** WBI mixin：从 nav 取一次，缓存 6 小时；取不到就报错（调用方降级）。 */
  async mixin(): Promise<Result<string>> {
    if (this.mixinCache && this.now() - this.mixinCache.at < MIXIN_TTL_MS && this.mixinCache.value) {
      return { ok: true, data: this.mixinCache.value };
    }
    const nav = await this.nav();
    if (!nav.ok) return nav;
    const mixin = mixinFromUrls(nav.data.imgUrl, nav.data.subUrl);
    if (!mixin) {
      return { ok: false, error: { kind: 'parse', code: 'parse', message: 'nav 里没有 wbi_img，无法签名' } };
    }
    this.mixinCache = { value: mixin, at: this.now() };
    return { ok: true, data: mixin };
  }

  /** buvid3 缺失时用指纹接口补（登录态接口都不需要它，但搜索更稳）。 */
  async fingerprint(): Promise<Result<{ b3: string }>> {
    const res = await this.http.json<{ b_3?: string }>({ url: `${API}/x/frontend/finger/spi`, referer: REFERER_HOME });
    if (!res.ok) return res;
    return { ok: true, data: { b3: str(res.data?.b_3) } };
  }

  /* ---------- 多源选题 ---------- */

  async searchVideos(keyword: string, opts: SearchOptions = {}): Promise<Result<BiliVideo[]>> {
    const res = await this.http.json<SearchRaw>({
      url: `${API}/x/web-interface/wbi/search/type`,
      query: {
        search_type: 'video',
        keyword,
        page: opts.page ?? 1,
        ...(opts.order ? { order: opts.order } : {}),
      },
      referer: REFERER_SEARCH,
      sign: true,
    });
    if (!res.ok) return res;
    const list = Array.isArray(res.data?.result) ? res.data.result : Array.isArray(res.data?.results) ? res.data.results : [];
    return { ok: true, data: list.map((item) => fromSearchItem(item, 'search')).filter((v): v is BiliVideo => v !== null) };
  }

  async popular(limit = 20, page = 1): Promise<Result<BiliVideo[]>> {
    const res = await this.http.json<{ list?: unknown[] }>({
      url: `${API}/x/web-interface/popular`,
      query: { pn: Math.max(1, Math.floor(page)), ps: Math.min(Math.max(limit, 1), 50) },
      referer: REFERER_HOME,
    });
    if (!res.ok) return res;
    const list = Array.isArray(res.data?.list) ? res.data.list : [];
    return { ok: true, data: list.map((item) => fromFeedItem(item, 'hot')).filter((v): v is BiliVideo => v !== null) };
  }

  async ranking(limit = 20): Promise<Result<BiliVideo[]>> {
    const res = await this.http.json<{ list?: unknown[] }>({
      url: `${API}/x/web-interface/ranking/v2`,
      query: { rid: 0, type: 'all' },
      referer: REFERER_HOME,
    });
    if (!res.ok) return res;
    const list = Array.isArray(res.data?.list) ? res.data.list.slice(0, limit) : [];
    return { ok: true, data: list.map((item) => fromFeedItem(item, 'ranking')).filter((v): v is BiliVideo => v !== null) };
  }

  /** 关注动态：只取视频投稿；没有 bvid 的条目直接跳过。关注流可能为空，由上层兜底。 */
  async following(limit = 20, page = 1): Promise<Result<BiliVideo[]>> {
    const res = await this.http.json<{ items?: unknown[] }>({
      url: `${API}/x/polymer/web-dynamic/v1/feed/all`,
      query: { type: 'video', page: Math.max(1, Math.floor(page)) },
      referer: REFERER_HOME,
    });
    if (!res.ok) return res;
    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    const out: BiliVideo[] = [];
    for (const raw of items) {
      const video = fromDynamicItem(raw);
      if (video) out.push(video);
      if (out.length >= limit) break;
    }
    return { ok: true, data: out };
  }

  /* ---------- 视频与字幕 ---------- */

  async video(bvid: string): Promise<Result<BiliVideo>> {
    const res = await this.http.json<ViewRaw>({
      url: `${API}/x/web-interface/view`,
      query: { bvid },
      referer: `${REFERER_VIDEO}${bvid}/`,
    });
    if (!res.ok) return res;
    const video = fromView(res.data, bvid);
    if (!video) return { ok: false, error: { kind: 'parse', code: 'parse', message: '视频详情字段缺失' } };
    return { ok: true, data: video };
  }

  /** 字幕轨列表：必须 WBI + 登录 cookie；匿名请求会返回 0 条。 */
  async subtitleTracks(bvid: string, cid: number): Promise<Result<SubtitleTrack[]>> {
    if (!cid) return { ok: true, data: [] };
    const res = await this.http.json<PlayerRaw>({
      url: `${API}/x/player/wbi/v2`,
      query: { bvid, cid },
      referer: `${REFERER_VIDEO}${bvid}/`,
      sign: true,
    });
    if (!res.ok) return res;
    const tracks = res.data?.subtitle?.subtitles;
    if (!Array.isArray(tracks)) return { ok: true, data: [] };
    return {
      ok: true,
      data: tracks
        .map((t) => ({
          lan: str(t.lan),
          lanDoc: str(t.lan_doc),
          url: normalizeSubtitleUrl(str(t.subtitle_url)),
          isAi: str(t.lan).startsWith('ai'),
        }))
        .filter((t) => t.url.length > 0),
    };
  }

  /** 字幕正文：CDN，不需要 cookie；URL 不能截断（auth_key 分钟级有效）。 */
  async subtitleCues(subtitleUrl: string, bvid: string): Promise<Result<SubtitleCue[]>> {
    if (!this.http.text) {
      return { ok: false, error: { kind: 'internal', code: 'internal', message: 'transport 不支持取文本' } };
    }
    // 字幕在 CDN 上，不需要 cookie；以前把 SESSDATA/bili_jct 一起发了出去（审计 §3.26）
    const res = await this.http.text({ url: subtitleUrl, referer: `${REFERER_VIDEO}${bvid}/`, withoutCookie: true });
    if (!res.ok) return res;
    try {
      const parsed = JSON.parse(res.data) as { body?: Array<{ from?: unknown; to?: unknown; content?: unknown }> };
      const body = Array.isArray(parsed.body) ? parsed.body : [];
      return {
        ok: true,
        data: body.map((cue) => ({
          fromSec: numOr(cue.from, 0),
          toSec: numOr(cue.to, 0),
          content: str(cue.content),
        })),
      };
    } catch {
      return { ok: false, error: { kind: 'parse', code: 'parse', message: '字幕 JSON 解析失败（URL 可能已过期）' } };
    }
  }

  /**
   * 一步拿字幕正文：挑一条最合适的轨（ai-zh → zh-CN → zh* → 第一条）。
   * 返回空数组 = 没有字幕（硬字幕或无字幕），这是合法结果，不是错误。
   */
  async bestSubtitle(bvid: string, cid: number): Promise<Result<{ cues: SubtitleCue[]; track: SubtitleTrack | null }>> {
    const tracks = await this.subtitleTracks(bvid, cid);
    if (!tracks.ok) return tracks;
    const track = pickTrack(tracks.data);
    if (!track) return { ok: true, data: { cues: [], track: null } };
    const cues = await this.subtitleCues(track.url, bvid);
    if (!cues.ok) return cues;
    return { ok: true, data: { cues: cues.data, track } };
  }

  /* ---------- 评论 ---------- */

  /** 主楼热评（sort=2）。oid 必须是 aid，不是 bvid。 */
  async topComments(aid: number, limit = 8): Promise<Result<CommentItem[]>> {
    const res = await this.http.json<ReplyRaw>({
      url: `${API}/x/v2/reply`,
      query: { type: 1, oid: aid, sort: 2, ps: Math.min(Math.max(limit, 1), 30), pn: 1 },
      referer: REFERER_HOME,
    });
    if (!res.ok) return res;
    const replies = Array.isArray(res.data?.replies) ? res.data.replies : [];
    return { ok: true, data: replies.slice(0, limit).map((r) => toComment(r, '')) };
  }

  /**
   * 楼中楼：一页固定 20 条；这里翻到 `pages` 页并合并（默认 2 页）。
   * 必须签名：B 站对 `/x/v2/reply/reply` 会查 wbi，不签名容易吃 -412（真机上就是扫不到回复）。
   */
  async threadReplies(aid: number, root: string, pages = 2): Promise<Result<{ root: CommentItem | null; replies: CommentItem[]; pages: number }>> {
    const all: CommentItem[] = [];
    let rootComment: CommentItem | null = null;
    let fetched = 0;
    for (let page = 1; page <= Math.max(1, pages); page += 1) {
      const res = await this.http.json<ReplyThreadRaw>({
        url: `${API}/x/v2/reply/reply`,
        query: { type: 1, oid: aid, root, pn: page, ps: 20 },
        referer: REFERER_HOME,
        sign: true,
      });
      if (!res.ok) return res;
      fetched = page;
      if (!rootComment && res.data?.root) rootComment = toComment(res.data.root, '');
      const pageReplies = Array.isArray(res.data?.replies) ? res.data.replies : [];
      all.push(...pageReplies.map((r) => toComment(r, root)));
      if (pageReplies.length < 20) break; // 拿不满就是到底了
    }
    return { ok: true, data: { root: rootComment, replies: all, pages: fetched } };
  }

  /**
   * 复核用：在**最新一页**评论里找这条 rpid（sort=0 按时间倒序，刚发的就在第一页）。
   * 返回 false 表示「这一页没看到」——上层据此判 unverified，不自动重发。
   */
  async findComment(aid: number, rpid: string, page = 1): Promise<Result<boolean>> {
    const res = await this.http.json<ReplyRaw>({
      url: `${API}/x/v2/reply`,
      query: { type: 1, oid: aid, sort: 0, ps: 20, pn: page },
      referer: REFERER_HOME,
    });
    if (!res.ok) return res;
    const replies = (Array.isArray(res.data?.replies) ? res.data.replies : []) as ReplyItemRaw[];
    const found = replies.some((reply) => String(reply?.rpid ?? '') === String(rpid));
    return { ok: true, data: found };
  }

  /**
   * 复核（更准）：区分「没发出去」和「发出去了但被 B 站挂起」。
   *
   * 真机教训：评论发送成功、rpid 真实存在，但公开列表（sort=0）里看不到——B 站给的 `state=17`
   * 表示审核中/仅自己可见，不带 cookie 的人完全看不到。旧逻辑只查 sort=0 第一页，
   * 于是连续三条都报「复核未通过」，看起来像程序坏了。
   *
   * 按代价从低到高查三步：
   *   1. `sort=0` 第一页（正常显示：state=0）
   *   2. `sort=1` 第一页（面对作者自己时，审核中的评论会出现在这里）
   *   3. 楼中楼端点 `/x/v2/reply/reply?root=<rpid>`：只要评论存在就返回 root（带 state）
   * 只要存在就算「发出去了」；只有 `visible` 才代表公开评论区能看到。
   */
  async findOwnComment(
    aid: number,
    rpid: string,
  ): Promise<Result<{ found: boolean; visible: boolean; state?: number; note?: string }>> {
    for (const sort of [0, 1]) {
      const res = await this.http.json<ReplyRaw>({
        url: `${API}/x/v2/reply`,
        query: { type: 1, oid: aid, sort, ps: 20, pn: 1 },
        referer: REFERER_HOME,
      });
      if (!res.ok) {
        if (res.error.kind === 'risk' || res.error.kind === 'auth') return res;
        continue;
      }
      const replies = (Array.isArray(res.data?.replies) ? res.data.replies : []) as ReplyItemRaw[];
      const hit = replies.find((reply) => String(reply?.rpid ?? '') === String(rpid));
      if (hit) {
        const state = typeof hit.state === 'number' ? hit.state : undefined;
        return {
          ok: true,
          data: { found: true, visible: state === undefined || state === 0, ...(state !== undefined ? { state } : {}) },
        };
      }
    }

    const thread = await this.http.json<{ root?: ReplyItemRaw | null }>({
      url: `${API}/x/v2/reply/reply`,
      query: { type: 1, oid: aid, root: rpid, ps: 20, pn: 1 },
      referer: REFERER_HOME,
    });
    if (!thread.ok) {
      if (thread.error.kind === 'risk' || thread.error.kind === 'auth') return thread;
      return { ok: true, data: { found: false, visible: false, note: `列表里没有，楼中楼也查不到：${thread.error.message}` } };
    }
    const root = thread.data?.root;
    if (root && String(root.rpid ?? '') === String(rpid)) {
      const state = typeof root.state === 'number' ? root.state : undefined;
      return {
        ok: true,
        data: {
          found: true,
          visible: false,
          ...(state !== undefined ? { state } : {}),
          note: state === undefined ? '存在但不在公开列表里' : `存在但不在公开列表里（B站 state=${state}）`,
        },
      };
    }
    return { ok: true, data: { found: false, visible: false, note: '列表与楼中楼都没有这条 rpid' } };
  }

  /** 复核楼中楼回复：在 root 的回复里找 parent 那条（内容也要对得上）。 */
  async findReply(aid: number, root: string, parent: string, expected?: string): Promise<Result<boolean>> {
    const thread = await this.threadReplies(aid, root);
    if (!thread.ok) return thread;
    const matched = thread.data.replies.find((reply) => String(reply.rpid) === String(parent));
    if (!matched) return { ok: true, data: false };
    if (!expected) return { ok: true, data: true };
    return { ok: true, data: matched.message.includes(expected.slice(0, 20)) };
  }

  /**
   * 按 UID 取用户名片（只为了拿到主人昵称，用于评论 @）。
   * 取不到就返回错误，调用方让用户手填——不猜、不拿登录账号顶替。
   */
  async userCard(mid: number): Promise<Result<{ mid: number; name: string }>> {
    if (!Number.isFinite(mid) || mid <= 0) {
      return { ok: false, error: { kind: 'business', code: 'bad_mid', message: 'UID 不合法' } };
    }
    const res = await this.http.json<{ card?: { mid?: unknown; name?: unknown } }>({
      url: `${API}/x/web-interface/card`,
      query: { mid },
      referer: REFERER_HOME,
    });
    if (!res.ok) return res;
    const card = res.data?.card;
    const name = typeof card?.name === 'string' ? card.name.trim() : '';
    const gotMid = numOr(card?.mid, mid);
    if (!name) {
      return { ok: false, error: { kind: 'parse', code: 'no_name', message: '名片里没有昵称（可能被隐藏或该 UID 不存在）' } };
    }
    return { ok: true, data: { mid: gotMid, name } };
  }

  /* ---------------- M4 读能力 ---------------- */

  /** 这个视频在我的哪些收藏夹里（收藏复核就靠它；空数组 = 没收藏）。 */
  async favContains(aid: number): Promise<Result<number[]>> {
    const res = await this.http.json<Array<{ id?: number; fid?: number }>>({
      url: `${API}/x/v3/fav/resource/ids`,
      query: { resource_id: aid, resource_type: 2, platform: 'web' },
      referer: REFERER_HOME,
      sign: true,
    });
    if (!res.ok) return res;
    const list = Array.isArray(res.data) ? res.data : [];
    return { ok: true, data: list.map((item) => numOr(item.fid, numOr(item.id, 0))).filter((id) => id > 0) };
  }

  /** 消息中心「回复我的」（只取最近一页；游标是每条自己的 id）。 */
  async msgfeedReplies(): Promise<Result<MsgfeedItem[]>> {
    const res = await this.http.json<{ items?: unknown[] }>({
      url: `${API}/x/msgfeed/reply`,
      query: { platform: 'web', build: 0, mobi_app: 'web' },
      referer: REFERER_HOME,
      sign: true,
    });
    if (!res.ok) return res;
    return { ok: true, data: mapMsgfeed(res.data?.items, 'reply') };
  }

  /** 消息中心「@我的」。 */
  async msgfeedAts(): Promise<Result<MsgfeedItem[]>> {
    const res = await this.http.json<{ items?: unknown[] }>({
      url: `${API}/x/msgfeed/at`,
      query: { platform: 'web', build: 0, mobi_app: 'web' },
      referer: REFERER_HOME,
      sign: true,
    });
    if (!res.ok) return res;
    return { ok: true, data: mapMsgfeed(res.data?.items, 'at') };
  }

  /** 私信会话列表（只取会话不拉消息：没新消息时不产生额外请求）。 */
  async dmSessions(): Promise<Result<DmSession[]>> {
    const res = await this.http.json<{ session_list?: unknown[] }>({
      url: 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions',
      query: { session_type: 1, group_id: 0, count: 20, platform: 'web' },
      referer: REFERER_HOME,
      sign: false,
    });
    if (!res.ok) return res;
    const list = Array.isArray(res.data?.session_list) ? res.data.session_list : [];
    return {
      ok: true,
      data: list
        .map((raw) => toSession(raw))
        .filter((session): session is DmSession => session !== null)
        .sort((a, b) => b.lastMsgAtMs - a.lastMsgAtMs),
    };
  }

  /** 跟某个人的最近消息（只给主人用）。 */
  async dmMessages(talkerId: number, size = 20): Promise<Result<DmMessage[]>> {
    const res = await this.http.json<{ messages?: unknown[] }>({
      url: 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs',
      query: { talker_id: talkerId, session_type: 1, size: Math.min(Math.max(size, 1), 50), platform: 'web' },
      referer: REFERER_HOME,
      sign: false,
    });
    if (!res.ok) return res;
    const list = Array.isArray(res.data?.messages) ? res.data.messages : [];
    return {
      ok: true,
      data: list
        .map((raw) => toDmMessage(raw))
        .filter((message): message is DmMessage => message !== null)
        .sort((a, b) => a.atMs - b.atMs),
    };
  }
}

/* ---------------- M4 读能力的类型与映射 ---------------- */

export interface MsgfeedItem {
  /** 消息中心自己的 id（用作游标）。 */
  id: number;
  kind: 'reply' | 'at';
  mid: number;
  uname: string;
  content: string;
  atMs: number;
  /** 源对象（视频 aid）。 */
  oid: number;
  /** 我们被回复/被 @ 的那条评论。 */
  rootRpid: string;
  /** 对方那条消息的 rpid/id。 */
  sourceRpid: string;
}

export interface DmSession {
  talkerId: number;
  uname: string;
  lastMsgAtMs: number;
  unread: number;
}

export interface DmMessage {
  senderId: number;
  receiverId: number;
  text: string;
  atMs: number;
  msgKey: string;
}

function mapMsgfeed(items: unknown[] | undefined, kind: 'reply' | 'at'): MsgfeedItem[] {
  if (!Array.isArray(items)) return [];
  const out: MsgfeedItem[] = [];
  for (const raw of items) {
    if (!isObj(raw)) continue;
    const user = isObj(raw.user) ? raw.user : {};
    const item = isObj(raw.item) ? raw.item : {};
    const content = str(raw.reply_content) || str(raw.content) || str(item.source_content) || '';
    const seconds = numOr(raw.at_time, 0) > 0 ? numOr(raw.at_time, 0) : numOr(raw.timestamp, 0);
    out.push({
      id: numOr(raw.id, 0),
      kind,
      mid: numOr(user.mid, numOr(raw.mid, 0)),
      uname: str(user.uname) || str(raw.nickname) || '（不知道是谁）',
      content,
      atMs: seconds * 1000,
      oid: numOr(item.source_id, numOr(raw.oid, 0)),
      rootRpid: str(item.target_id) || str(raw.root_id) || str(raw.target_id),
      sourceRpid: str(item.source_id) || str(raw.source_id) || str(raw.id),
    });
  }
  return out;
}

function toSession(raw: unknown): DmSession | null {
  if (!isObj(raw)) return null;
  const talkerId = numOr(raw.talker_id, numOr(raw.talker_uid, 0));
  if (talkerId <= 0) return null;
  const last = isObj(raw.last_msg) ? raw.last_msg : {};
  return {
    talkerId,
    uname: str(raw.talker_name) || str(last.nickname) || '',
    lastMsgAtMs: numOr(raw.timestamp, 0) * 1000,
    unread: numOr(raw.unread_count, 0),
  };
}

function toDmMessage(raw: unknown): DmMessage | null {
  if (!isObj(raw)) return null;
  const senderId = numOr(raw.sender_uid, 0);
  if (senderId <= 0) return null;
  let text = '';
  const content = raw.content;
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as unknown;
      text = isObj(parsed) ? str(parsed.content) : '';
    } catch {
      text = content;
    }
  } else if (isObj(content)) {
    text = str(content.content);
  }
  return {
    senderId,
    receiverId: numOr(raw.receiver_id, 0),
    text,
    atMs: numOr(raw.timestamp, 0) * 1000,
    msgKey: str(raw.msg_key) || String(numOr(raw.msgid, 0)),
  };
}

/* ---------- 工厂：把 http 与 api 接起来（api 同时是 http 的签名器） ---------- */

export interface CreateBiliOptions {
  /** 固定 cookie，或每次读一次的取值函数（登录后换 cookie 不必重建客户端）。 */
  cookie: string | (() => string);
  logger: Logger;
  readIntervalMs?: number;
  timeoutMs?: number;
  retries?: number;
  onRisk?: (message: string) => void;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function createBili(opts: CreateBiliOptions): { http: BiliHttp; api: BiliApi } {
  const http = new BiliHttp({
    cookie: opts.cookie,
    logger: opts.logger,
    ...(opts.readIntervalMs !== undefined ? { readIntervalMs: opts.readIntervalMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    ...(opts.onRisk ? { onRisk: opts.onRisk } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl as never } : {}),
  });
  const api = new BiliApi(http, opts.logger);
  http.useSigner(api);
  return { http, api };
}

/* ---------- 映射与容错 ---------- */

interface NavRaw {
  isLogin?: unknown;
  mid?: unknown;
  uname?: unknown;
  mobile_verified?: unknown;
  level_info?: { current_level?: unknown };
  wbi_img?: { img_url?: unknown; sub_url?: unknown };
}

interface SearchRaw {
  result?: unknown[];
  results?: unknown[];
}

interface ViewRaw {
  bvid?: unknown;
  aid?: unknown;
  cid?: unknown;
  title?: unknown;
  desc?: unknown;
  duration?: unknown;
  pubdate?: unknown;
  pic?: unknown;
  owner?: { mid?: unknown; name?: unknown };
  stat?: Record<string, unknown>;
  pages?: Array<{ cid?: unknown }>;
}

interface PlayerRaw {
  subtitle?: { subtitles?: Array<{ lan?: unknown; lan_doc?: unknown; subtitle_url?: unknown }>; ai_status?: unknown };
}

interface ReplyRaw {
  replies?: unknown[];
}

interface ReplyThreadRaw {
  root?: unknown;
  replies?: unknown[];
}

interface ReplyItemRaw {
  rpid?: unknown;
  /** 0 = 正常显示；17 = 审核中/仅自己可见（真机上验到的）。 */
  state?: number;
  parent?: unknown;
  root?: unknown;
  mid?: unknown;
  like?: unknown;
  ctime?: unknown;
  content?: { message?: unknown };
  member?: { uname?: unknown; mid?: unknown };
  replies?: unknown[];
}

export function fromSearchItem(raw: unknown, source: CandidateSource): BiliVideo | null {
  if (!isObj(raw)) return null;
  const bvid = str(raw.bvid);
  if (!bvid.startsWith('BV')) return null;
  return {
    bvid,
    aid: numOr(raw.aid, 0),
    cid: 0, // 搜索结果没有 cid，深读前要调一次 view 补
    title: stripHtml(str(raw.title)),
    desc: stripHtml(str(raw.description)),
    durationSec: parseDuration(raw.duration),
    pubdateIso: isoFromSeconds(numOr(raw.pubdate, 0)),
    owner: { mid: 0, name: str(raw.author) },
    stats: { view: numOr(raw.play, 0), like: 0, reply: numOr(raw.review, 0), favorite: 0, coin: 0, share: 0 },
    coverUrl: str(raw.pic),
    source,
  };
}

export function fromView(raw: unknown, fallbackBvid: string): BiliVideo | null {
  if (!isObj(raw)) return null;
  const bvid = str(raw.bvid) || fallbackBvid;
  const cid = numOr(raw.pages?.[0]?.cid, numOr(raw.cid, 0));
  if (!bvid) return null;
  return {
    bvid,
    aid: numOr(raw.aid, 0),
    cid,
    title: str(raw.title),
    desc: str(raw.desc),
    durationSec: numOr(raw.duration, 0),
    pubdateIso: isoFromSeconds(numOr(raw.pubdate, 0)),
    owner: { mid: numOr(raw.owner?.mid, 0), name: str(raw.owner?.name) },
    stats: toStats(raw.stat),
    coverUrl: str(raw.pic),
  };
}

function fromFeedItem(raw: unknown, source: CandidateSource): BiliVideo | null {
  if (!isObj(raw)) return null;
  const bvid = str(raw.bvid);
  if (!bvid.startsWith('BV')) return null;
  return {
    bvid,
    aid: numOr(raw.aid, 0),
    cid: 0,
    title: stripHtml(str(raw.title)),
    desc: stripHtml(str(raw.desc)),
    durationSec: parseDuration(raw.duration),
    pubdateIso: isoFromSeconds(numOr(raw.pubdate, 0)),
    owner: { mid: numOr(raw.owner?.mid, 0), name: str(raw.owner?.name) },
    stats: toStats(raw.stat),
    coverUrl: str(raw.pic),
    source,
  };
}

function fromDynamicItem(raw: unknown): BiliVideo | null {
  if (!isObj(raw)) return null;
  const modules = isObj(raw.modules) ? raw.modules : {};
  const author = isObj(modules.module_author) ? modules.module_author : {};
  const dynamic = isObj(modules.module_dynamic) ? modules.module_dynamic : {};
  const major = isObj(dynamic.major) ? dynamic.major : {};
  const archive = isObj(major.archive) ? major.archive : {};
  const bvid = str(archive.bvid);
  if (!bvid.startsWith('BV')) return null;
  const stat = isObj(archive.stat) ? archive.stat : {};
  return {
    bvid,
    aid: numOr(archive.aid, 0),
    cid: 0,
    title: str(archive.title),
    desc: str(archive.desc),
    durationSec: parseDuration(archive.duration_text),
    pubdateIso: isoFromSeconds(numOr(author.pub_ts, 0)),
    owner: { mid: numOr(author.mid, 0), name: str(author.name) },
    stats: { view: numOr(stat.play, 0), like: 0, reply: 0, favorite: 0, coin: 0, share: 0 },
    coverUrl: str(archive.cover),
    source: 'following',
  };
}

function toComment(raw: unknown, parentFallback: string): CommentItem {
  const item = isObj(raw) ? (raw as ReplyItemRaw) : {};
  return {
    rpid: String(numOr(item.rpid, 0)),
    parent: String(numOr(item.parent, 0)) || parentFallback,
    root: String(numOr(item.root, 0)),
    mid: numOr(item.member?.mid, numOr(item.mid, 0)),
    uname: str(item.member?.uname),
    message: stripHtml(str(item.content?.message)),
    like: numOr(item.like, 0),
    ctimeIso: isoFromSeconds(numOr(item.ctime, 0)),
    replies: Array.isArray(item.replies) ? item.replies.map((r) => toComment(r, String(numOr(item.rpid, 0)))) : [],
  };
}

function toStats(raw: unknown): BiliStats {
  const stat = isObj(raw) ? raw : {};
  return {
    view: numOr(stat.view, 0),
    like: numOr(stat.like, 0),
    reply: numOr(stat.reply, 0),
    favorite: numOr(stat.favorite, 0),
    coin: numOr(stat.coin, 0),
    share: numOr(stat.share, 0),
  };
}

/** 字幕轨优先级：ai-zh → zh-CN → zh* → 第一条。 */
export function pickTrack(tracks: SubtitleTrack[]): SubtitleTrack | null {
  if (tracks.length === 0) return null;
  const byLan = (lan: string) => tracks.find((t) => t.lan.toLowerCase() === lan.toLowerCase());
  return byLan('ai-zh') ?? byLan('zh-CN') ?? tracks.find((t) => t.lan.toLowerCase().startsWith('zh')) ?? tracks[0] ?? null;
}

/** 字幕 URL 可能是 `//` 开头；空 URL 直接丢。 */
export function normalizeSubtitleUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

/** `"12:34"` / `"1:02:03"` / 秒数 → 秒。 */
export function parseDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = str(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 字幕 cues → 纯文本（带时间戳会太长，这里只拼正文）。 */
export function cuesToText(cues: SubtitleCue[]): string {
  return cues
    .map((c) => c.content.trim())
    .filter((s) => s.length > 0)
    .join('\n');
}

function isoFromSeconds(seconds: number): string {
  if (!seconds) return '';
  return new Date(seconds * 1000).toISOString();
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function numOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 暴露给测试/诊断：当前 nav 里能取到的 wbi 材料。 */
export async function inspectWbi(api: BiliApi): Promise<{ mixin: string; http: unknown }> {
  const mixin = await api.mixin();
  return { mixin: mixin.ok ? mixin.data : '', http: null };
}

export { PASSPORT, API, REFERER_HOME, REFERER_VIDEO };
export type { BiliOwner };
