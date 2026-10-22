# B 站只读接口 · 可实现规格（摘自两个开源项目）

来源与版本：
- `Alterssss/dsh-bili-whale` **v0.3.0**（main，eecafbc）：`tools/bili.mjs`、`tools/commands/{feed,debrief,subtitles,search,comment-digest}.mjs`、`tools/commands/{video-content,bili-watch}.mjs`、`tools/lib/{config,msgfeed}.mjs`、`tools/verify/{session,thread}.mjs`、`tools/commands/comment.mjs`（仅取错误码）
- `c1overzz/dsh-bili-scroll` **0.1.x**（main，eab82bb）：`lib/{login,state,verify}.mjs`、`vendor/bilibili-mcp/mcp_server.py`、`CHANGELOG.md`
- ⚠️ whale 的 `tools/lib/` **只有** `config.mjs / ffmpeg.mjs / msgfeed.mjs / quota-gate.mjs`，**没有** http/wbi/cookie 模块；WBI 在 `feed/subtitles/search/debrief/video-content/comment` 六个脚本里**各内联一份完全相同的实现**。scroll 侧登录走 `lib/login.mjs`，接口层全部委托 `bilibili_api`（Python），其 URL 由 whale 侧同款端点交叉印证。

## 通用 header / cookie 实际取值

whale（v0.3.0，各脚本一致）：
```
user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
cookie: SESSDATA=<sessdata>; bili_jct=<bili_jct>; buvid3=<buvid3>
referer: https://search.bilibili.com/   ← 搜索
         https://www.bilibili.com/video/<BV>/  ← view / player / reply / 字幕下载
         https://www.bilibili.com/       ← nav / msgfeed / playurl / 封面
```
scroll（0.1.x）：
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36
Referer: https://www.bilibili.com/          （复核接口用这个，不带视频页 referer 也能过）
Cookie: SESSDATA=<sessdata>; bili_jct=<bili_jct>; buvid3=<buvid3>
Origin: https://www.bilibili.com            ← 只在 POST 回复/评论时
Content-Type: application/x-www-form-urlencoded  ← POST
```
- **两个项目都只发三个 cookie：SESSDATA / bili_jct / buvid3**。`DedeUserID` 登录时从 Set-Cookie 取回并存盘，但**从不作为 cookie 发送**（只在 `bili_check_credential` 里当 uid 去查用户信息）。
- **buvid4 两个项目都没用到**（无任何引用）；`buvid3` 缺失时才去补。
- 凭据文件形状不同：whale `~/.bili-ai/credentials.json` = `{sessdata,bili_jct,buvid3}`；scroll `<stateDir>/bili_credential.json` = `{sessdata,bili_jct,buvid3,dedeuserid}`（Python 侧 `Path(__file__).parent`，原子写：`.tmp` + `os.replace`）。
- `Origin` 只在写评论时加；只读请求全部不带 Origin。

# 认证

## GET passport 扫码生成
`https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header`
- method GET；无 cookie；header 仅 `User-Agent`。
- 响应：`data.url`（二维码内容字符串）、`data.qrcode_key`。缺任一 → 抛「生成二维码失败」。源码：`lib/login.mjs` `loginStart()`。

## GET 扫码轮询
`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=<key>&source=main-fe-header`
- method GET；`redirect: 'manual'`（必须，否则拿不到 Set-Cookie）；无 cookie。
- 响应：`data.code` → `86101`=未扫(waiting) / `86090`=已扫待确认(scanned) / `0`=成功 / `86038`=过期(expired)；其它 → `unknown`。
- ⭐ **凭证在响应头 `Set-Cookie` 里，不在 body、也不在 `data.url`**（`data.url` 里的是别的域的游戏票）。取法：
```js
const res = await fetch(pollUrl(key), { headers: { 'User-Agent': UA }, redirect: 'manual' })
const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
// 逐条取 "name=value;" 的第一段，want 映射：SESSDATA→sessdata, bili_jct→bili_jct,
//                                        DedeUserID→dedeuserid, buvid3→buvid3
```
- `code===0` 但没取到 `sessdata` → 返回 `state:'unknown'`（不静默成功）。

## GET buvid3 补全（指纹）
`https://api.bilibili.com/x/frontend/finger/spi`
- method GET；header 仅 `User-Agent`；**data 里读 `data.b_3`** 当 buvid3（`data.b_4` 是 buvid4，**两项目都未使用**）。失败非致命，留空。

## GET nav（登录态 + WBI 材料，唯一同时干两件事的接口）
`https://api.bilibili.com/x/web-interface/nav`
- method GET；cookie 三件套；referer `https://www.bilibili.com/`。
- `code !== 0` → 凭据无效/过期（whale 退出码 4，scroll 由 MCP 抛异常）。
- 字段：`data.isLogin`（布尔）、`data.mid`、`data.uname`、`data.mobile_verified`（发评论/动态前必须为 true）、`data.money`、`data.level_info.current_level`、`data.wbi_img.img_url`、`data.wbi_img.sub_url`。

# WBI

## 算法（逐字抄自 `tools/commands/subtitles.mjs` 与 `search.mjs`，`feed.mjs`/`debrief.mjs`/`video-content.mjs`/`comment.mjs` 为同一份，仅写法微差）
```js
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await jget('https://api.bilibili.com/x/web-interface/nav')   // 取 img_key / sub_key
const raw = keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? '')
const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)         // 64 位 → 取 32 位
const clean = (v) => String(v).replace(/[!'()*]/g, '')                   // 去 5 个特殊字符
function wbi(params) {
  const wts = Math.round(Date.now() / 1000)                              // 秒级整数，不是毫秒
  const q = Object.keys({ ...params, wts }).sort()                       // wts 并入后按 ASCII 升序
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(k === 'wts' ? wts : params[k]))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`  // md5(q+mixin)，小写 hex
}
```
逐条要点（源码即规）：
1. `img_key` / `sub_key` = `nav.data.wbi_img.img_url` / `.sub_url` 的**文件名主干**（去掉目录与 `.png` 后缀），拼成 64 字符串。
2. 按 `MIXIN_TAB` 的 64 个下标**重排**该 64 字符串，拼接后 **`slice(0,32)`** 得 `mixin`。
3. `wts` 只在**签名用**的参数集里（`{...params, wts}`），不修改原 `params`。
4. 排序 = `Array.sort()` 默认（UTF-16 码元升序），**不是** B 站网页端常见的 `localeCompare`。
5. 先 `clean()`（删 `! ' ( ) *`）**再** `encodeURIComponent`；key 也 encode。
6. `w_rid` = `md5(query + mixin)`，**hex 小写**；最终 query 为 `...&w_rid=...`，即 `w_rid` **最后**。
7. 签名**只覆盖 query**，与 path / host / body 无关；`wts`/`w_rid` 放 query 字符串末尾（`comment.mjs` 写评论时也把 `w_rid`/`wts` 放 query，body 不带）。
8. 无缓存：每个脚本启动时取一次 nav，得一次 `mixin`；nav 同时用于登录态判断（`nav.code !== 0` → 不发请求）。取不到 `img_url`/`sub_url` → `wbiSign()` 返回 `null`，调用方**退化为无签名 URL**（`comment.mjs` 是唯一这样处理的）。

## 哪些接口要 WBI
| 要 WBI | 不要 WBI（普通 cookie 即可） |
|---|---|
| `/x/web-interface/wbi/search/type` | `/x/v2/reply`、`/x/v2/reply/main`、`/x/v2/reply/reply` |
| `/x/player/wbi/v2`（字幕后端拿到 `auth_key` 的唯一途径） | `/x/web-interface/view`、`/x/web-interface/nav` |
| （写）`/x/v2/reply/add` | `/x/web-interface/popular`、`/x/web-interface/ranking/v2` |
| | `/x/polymer/web-dynamic/v1/feed/all`、`/x/msgfeed/*`、`/x/player/playurl` |

# 搜索

## GET 视频搜索（多源选题主入口）
`https://api.bilibili.com/x/web-interface/wbi/search/type`
- query：`search_type=video`、`keyword=<词>`、`page=<1..>`、可选 `order`、`wts`、`w_rid`。
- `order` 取值（源码实际用过）：`click`（播放）、`pubdate`（最新）；`bili_search` 还映射 `totalrank`（综合，默认）、`dm`（弹幕）。
- header：referer `https://search.bilibili.com/` + cookie 三件套。
- 响应字段（精确路径）：
  - `data.result[]`（**兜底 `data.results[]`**，`search.mjs` 两者都读）
  - `data.result[].bvid`、`.aid`、`.title`（**含 `<em class="keyword">` 高亮标签，必须 `replace(/<[^>]+>/g,'')`**）
  - `.description`（同样含 HTML）、`.tag`（逗号串，含 HTML）
  - `.author`、`.play`（播放，数字或短横串）、`.video_review`（**弹幕数**）、`.review`（评论数）、`.duration`（**字符串 `"mm:ss"`**，需 `secs()` 解析）、`.pubdate`（秒级时间戳）
  - 无结果时 `code!==0` 或 `data.result` 空 → `search.mjs` 打印 `Object.keys(d.data)` 便于排查
- 分页：只有 `page`，无 `ps`（每页条数固定，源码按 `pool/N` 截取）。

## GET 热门
`https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20`（GET，cookie 可选，referer `https://www.bilibili.com/`）
- 响应：`data.list[].bvid`、`.title`、`.duration`（**秒，数字**）、`.desc`、`.tname`、`.owner.name`、`.stat.view`、`.stat.like`、`.stat.danmaku`、`.stat.reply`
- `ps` 上限：MCP 侧 `min(ps,50)`；whale 写死 20。

## GET 排行榜
`https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all`
- 响应：`data.list[]`，字段同上（`.bvid/.title/.duration/.owner.name/.stat.view/.stat.danmaku`），另有 `.score`（MCP 读取）。
- `rid=0` 全站；`bili_rank` 另有分区枚举（`RankType`）与 `day=3|7`。

## GET 关注动态（“刷关注”源）
`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video&page=1`
- `code!==0` 直接抛错（whale 捕获后跳过该源）。
- 响应：`data.items[].modules.module_author.name`、`.modules.module_dynamic.major.archive.bvid`、`.title`、`.duration_text`（**字符串 `"05:23"`**）、`.stat.play`；**`bvid` 不存在则跳过该条**。

# 视频

## GET 视频详情（一切的第一步，给 aid + cid）
`https://api.bilibili.com/x/web-interface/view?bvid=<BV>`
- method GET；cookie 三件套（scroll 的复核也用同一条，可只带 User-Agent+Referer）；referer 视频页。
- `code !== 0` → 失败（whale 退出码 3；scroll 记为“视频可能已删/不可见”）。
- 字段：`data.bvid`、`data.aid`、`data.cid`（**默认 P1**）、`data.title`、`data.desc`、`data.duration`（秒）、`data.pubdate`（秒）、`data.tname`、`data.pic`（封面 URL）、`data.owner.mid`、`data.owner.name`、`data.pages[].cid`（**分 P**，`video-content.mjs` 用 `data.pages?.[0]?.cid`，MCP 用 `pages[0]["cid"]`）、`data.stat.view / .like / .favorite / .coin / .danmaku / .reply / .share`。
- 标签走另一个端点：`https://api.bilibili.com/x/tag/archive/tags?bvid=<BV>` → `data[].tag_name`。

## GET 播放直链（debrief 的“抽帧”必需）
`https://api.bilibili.com/x/player/playurl?bvid=<BV>&cid=<cid>&qn=80&fnval=1&platform=pc&high_quality=1`
- 注释明确：`platform=pc` + `qn=80` 返 720P（`quality=64`）；`html5` + `qn=32` 会被压到 360P（`quality=16`）。
- 响应：`data.durl[0].url`（普通 mp4 直链）、`data.quality`（`16/32/64/80` → 360P/480P/720P/1080P）。
- 下载该直链时带 `user-agent` + `referer: https://www.bilibili.com/` + `range: bytes=0-`。
- **没有 `graph_version`**（两仓库均未出现该参数）。

# 字幕

## GET 字幕轨列表（WBI，必须有登录 cookie）
`https://api.bilibili.com/x/player/wbi/v2?<wbi({bvid,cid})>`
- 参数：`bvid`、`cid`（**只有这两个进签名**）、`wts`、`w_rid`。
- 响应：`data.subtitle.subtitles[]`（每条含 `.lan`、`.lan_doc`、`.subtitle_url`）、`data.subtitle.ai_status`（**0=无 AI 字幕 / 1=有 / 2=生成中**）。
- ⚠️ 源码注释写明：用旧的 `/x/player/v2` 也能拿到 `subtitle_url`，但**缺 `auth_key` → CDN 403**；匿名请求返回 **0 条**（`ai-zh` 拿不到）。track 判定：`String(s.subtitle_url).includes('auth_key')`。
- 选择顺序：`lan === 'ai-zh'` → `'zh-CN'` → 以 `zh` 开头 → `[0]`。

## GET 字幕轨兜底（播放器实际调用的端点，同样要 cookie）
`https://api.bilibili.com/x/v2/subtitle/web/view?oid=<aid>&pid=<aid>&context_ext=<enc>&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`
- `context_ext = encodeURIComponent(JSON.stringify({ video_type: 1 }))`；`oid` 与 `pid` **都是 aid**。
- 响应路径同上：`data.subtitle.subtitles[]`。

## GET 字幕正文（CDN，不需要 cookie，URL 不能截断）
- URL 直接取 `subtitle_url`；若不以 `http` 开头则前置 `https:`（原文是 `//`）。
- header：`user-agent` + `referer: https://www.bilibili.com/video/<BV>/`（`video-content.mjs` 特意把 cookie 置空）。
- 响应 JSON：**`body[].from`（秒，浮点）、`body[].to`（秒）、`body[].content`（文本）**；`body.length === 0` 视为空字幕。
- ⚠️ `auth_key` **分钟级有效**，且 URL 尾部 `-0-<32位hex>` 不能截断，截了同样 403；`!r.ok` → 重跑一次（whale 退出码 4）。
- `ai_status=0` / 两端点都空 → 判为「无官方字幕轨」（硬字幕，源码建议走抽帧）。

# 评论

约定：`oid` = **视频的 aid**（不是 bvid）；`type=1` 视频（`type=11` 动态/图文，动态的 oid 必须是 `polymer/web-dynamic/v1/detail` 的 **`basic.comment_id_str`**，用 dyn_id 一律 `-404`）。

## GET 主楼（按热度，debrief 的“热评”）
`https://api.bilibili.com/x/v2/reply?type=1&oid=<aid>&sort=2&ps=<N>&pn=1`
- 参数：`type`、`oid`、`sort`（**2=热度**）、`ps`（每页条数，whale 用 `--comments` 默认 8）、`pn`（从 1 起）。
- 响应：`data.replies[]`，每条：`.rpid`、`.like`、`.rcount`、`.member.uname`、`.member.mid`、`.content.message`、`.content.members[]`（`@到` 的人：`.uname`、`.mid`）、`.ctime`、`.mid`、`.parent`
- `data.replies` 缺失/空 → `code` 非 0（whale 打印 `code`）。
- **不需要 WBI**，普通 cookie；不登录也能读部分。

## GET 主楼（按时间最新一页，scroll 复核“刚发的评论”）
`https://api.bilibili.com/x/v2/reply/main?type=1&oid=<aid>&mode=2&next=0&ps=20`
- `mode=2` = 按时间；`next=0` = 第一页；`ps=20`。
- 响应：`data.replies[]`，用 `.rpid` 精确匹配、读 `.like`，并检查 `.invisible`（接口标了隐藏 = 审核中）。
- 语义：找到了 ⇒ 公开可见；没找到 ⇒ **“没查到”**，不能写成“没发出去”（翻页/排序都会漏，源码写死了这个措辞）。

## GET 楼中楼（含线程根）
`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=<aid>&root=<rootRpid>&pn=<1..>&ps=20`
- 响应：`data.root`（线程根：`.member.uname`、`.member.mid`、`.rpid`、`.rcount`、`.content.message`、`.content.members[]`）、`data.replies[]`（`.rpid`、`.parent`、`.mid`、`.member.uname`、`.member.mid`、`.content.message`、`.ctime`、`.content.members[]`）。
- **一页只给 20 条**（`ps=20`），`rs.length < 20` 即到底。翻页上限各处写死不同：`thread.mjs` `pn<=10`、`comment.mjs` `pn<=4`、`msgfeed.resolveLatestReply` `pn<=6`。
- 用 `parent` 才能确定“他回的是哪条”：同一楼同一人可能多条，按 `parent === parentRpid` 匹配，否则退到该人最后一条（并标记非精确）。
- 顶层评论无法用它复核（`root` 为空时走 `reply/main`）；`/x/v2/reply/detail` **走不通，返回 `-400 请求错误`**。

## GET 两个收件箱（谁找过我；正文不可信）
`https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web[&cursor=<enc>]`
`https://api.bilibili.com/x/msgfeed/at?platform=web&build=0&mobi_app=web[&cursor=<enc>]`
- 响应：`data.items[]` → `.id`、`.reply_time`（at 用 `.at_time`）、`.user.nickname`、`.user.mid`、`.item.title`、`.item.source_content`、`.item.target_reply_content`、`.item.business_id`（1=视频/11=动态）、`.item.subject_id`（= oid）、`.item.root_id`、`.item.source_id`（= parent）、`.item.uri`（定位链接）；另有 `data.cursor`、`data.last_view_at`（未读分界，秒）。
- ⚠️ 源码明确：`item.title` **不可靠**（多条 item 是同一句，真正正文常在 `source_content`）；回读楼层用 `reply/reply` 核正文。`cursor` 翻页会**重叠**，按 `.id` 去重；`code!==0` 抛错。

# 其它

## 响应通用封装
`{code:0, message:'0', data:{...}}`；`code!==0` 即业务失败。滚动侧把网络/解析失败合成为本地码 `-998`（fetch 抛错）/ `-999`（非 JSON），便于区分“真没数据”和“没抓到”。

## 已知错误码与风控信号（出现位置 + 处理）

| 码 | 出现文件 | 处理 |
|---|---|---|
| HTTP 412 / `-352` | **未取到**（两仓库所有已取文件里均无出现，不做推断） | — |
| `-412` | `vendor/bilibili-mcp/mcp_server.py`（`bili_comments` 的 except）＋ scroll CHANGELOG 0.1.6 | **不许吞成“0 条评论”**：错误串进返回的 `error` 字段，与“真没评论”分开 |
| `-101` 未登录 / cookie 失效 | `tools/commands/comment.mjs` hints | 停手，重新取 cookie（nav 先校验） |
| `-102` 账号被封停 | 同上 | 停 |
| `-111` csrf 校验失败 | 同上 | `bili_jct` 与 `SESSDATA` 不是同一个号 |
| `-509` 请求过于频繁 | 同上 | 停（速率） |
| `12002` 评论区已关闭 | 同上 | 跳过该视频 |
| `12015` 需要评论验证码 | 同上 | 「被风控盯上了，停手」 |
| `12016` 内容含敏感信息 | 同上 | 改文案 |
| `12035` 被 UP 列入黑名单 | 同上 | 跳过 |
| `12051` 重复评论判刷屏 | 同上 | 换内容/停 |
| `21007` 私信正文超 500 字 | scroll `CHANGELOG.md`（0.1.7） | 正文截到 500 字内 |
| `-400` | `lib/verify.mjs` 注释 | `/x/v2/reply/detail` 不可用，别再换它 |
| `-404` | `tools/commands/comment.mjs` 注释 | 动态评论 oid 用 `comment_id_str`，不是 dyn_id |
| HTTP 403（字幕 CDN） | `subtitles.mjs` / `video-content.mjs` | `auth_key` 缺失或已过期 → 重取 `wbi/v2` 再下 |
| nav `code!==0` | `verify/session.mjs`、`comment.mjs` | 退出码 4，不做后续请求 |
| 写评论 `code!==0` | `comment.mjs` | **退出码 6**（绝不当成功，避免“撞风控还继续”）；成功时 `data.rpid_str ?? data.rpid` |

## 分页 / 上限 / 签名要求汇总
- 搜索：`page` 单参数，每页条数固定；`order ∈ {totalrank, click, pubdate, dm}`。
- 热门：`pn`、`ps`（whale 20，MCP `min(ps,50)`）。
- 排行：`rid`、`type`（+MCP `day=3|7`）。
- 主楼热评：`pn` 从 1、`ps` = 需要条数（8/20/30 都出现过）、`sort=2`。
- 主楼最新：`mode=2&next=0&ps=20`（`next` 为游标，源码只用 0）。
- 楼中楼：`ps=20` 固定，`pn` 上限 4/6/10（按脚本），**满页才继续翻**。
- 收件箱：`cursor` 翻页 + 按 `id` 去重。
- 评论三个读接口 **不需要 WBI**；搜索、字幕列表 **必须 WBI**；`playurl`、`view`、`popular`、`rank`、`dynamic/feed`、`msgfeed` 均未签名。
- 字幕额外参数：**只有 `bvid` + `cid`**（进 WBI）；兜底端点另需 `oid/pid/context_ext/type/cur_production_type/preferred_language/playlist_switch`；**`graph_version` 在两仓库中均未出现**（那是弹幕分段的参数，此处不涉及）。

## 写接口（M3/M4 新增；文件名是历史包袱，这里已不止只读）

> 这份文件的标题来自 M0 时代（当时只有只读）。M3 起项目有了写能力，写接口就记在这里；每条都标了**我们验到什么程度**。

| 动作 | 方法与端点 | 关键参数 | 签名 | 我们验到哪 |
|---|---|---|---|---|
| 发评论 / 楼中楼回复 | `POST https://api.bilibili.com/x/v2/reply/add` | `oid`(=aid)、`type=1`、`message`、`plat=1`、`csrf`；楼中楼另加 `root` + `parent` | 是（wbi） | 假传输层单测；**真账号待验** |
| 删自己的评论 | `POST https://api.bilibili.com/x/v2/reply/del` | `oid`、`type=1`、`rpid`、`csrf` | 是 | 单测；真账号待验 |
| 收藏 / 取消 | `POST https://api.bilibili.com/x/v3/fav/resource/deal` | `rid`(=aid)、`type=2`、`add_media_ids` / `del_media_ids`、`csrf` | 是 | 单测；复核走 `x/v3/fav/resource/ids` |
| 点赞 / 取消 | `POST https://api.bilibili.com/x/web-interface/archive/like` | `aid`、`like=1/0`、`csrf` | 是 | 单测；真账号待验 |
| 发私信 | `POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg` | `msg[sender_uid]`、`msg[receiver_id]`、`msg[receiver_type]=1`、`msg[msg_type]=1`、`msg[content]={"content":"…"}`、`msg[dev_id]`、`msg[timestamp]`、`csrf` | **否**（api.vc 不吃 wbi） | 单测；**真账号待验（M4 最可能出问题的一处）** |
| 发动态 | `POST https://api.bilibili.com/x/dynamic/feed/create/dyn` | `dyn_req`（`{"content":{"contents":[{"raw_text":"…"}]},"scene":1}`）、`csrf` | **否** | 单测；真账号待验；默认关 + 必须二次确认 |
| 读：收藏夹包含 | `GET https://api.bilibili.com/x/v3/fav/resource/ids` | `resource_id`(=aid)、`resource_type=2` | 是 | 单测（收藏复核） |
| 读：回复我的 / @我的 | `GET https://api.bilibili.com/x/msgfeed/reply` · `/at` | `platform=web`、`build=0`、`mobi_app=web` | 是 | 夹具缺；监听真机待验 |
| 读：私信会话列表 | `GET https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions` | `session_type=1`、`group_id=0`、`count=20` | 否 | 夹具缺；监听真机待验 |
| 读：私信消息 | `GET https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs` | `talker_id`、`session_type=1`、`size` | 否 | 夹具缺；监听真机待验 |

**共同约束**（代码里强制，不靠自觉）：

- 所有写请求带 `csrf=bili_jct`；缺它直接拒绝并提示重新登录。
- 写请求**不重试**（`noRetry`）；串行；写间隔 5s + 0–1s 抖动（私信 1s）。
- 业务错误按 kind 归类：`-101/-111` → auth 停写；`-412/-352/-509/12015/12051` → risk 立刻停手 + 冷却；
  `12002/12009` → rate；`21007` → 私信超长。
- 不变式测试守着「写接口只许出现在 `src/bili/write.ts`」以及「投币/关注/直播/建收藏夹的接口不许出现」。

## 未取到
- 未取到：`https://raw.githubusercontent.com/Alterssss/dsh-bili-whale/main/tools/lib/http.mjs`（不存在）
- 未取到：`https://raw.githubusercontent.com/Alterssss/dsh-bili-whale/main/tools/lib/wbi.mjs`（不存在）
- 未取到：`https://raw.githubusercontent.com/Alterssss/dsh-bili-whale/main/tools/lib/cookie.mjs`（不存在）
- 未取到：`vendor/bilibili-mcp` 内部真实 URL —— `mcp_server.py` 全部委托 `bilibili_api`（`search.search_by_type` / `video.Video.get_info` / `comment.get_comments` / `video.Video.get_subtitle` / `hot.get_hot_videos` / `rank.get_rank`），文件内**无字面 URL**；上文对应端点由 whale 侧同名功能交叉印证，未逐条核 Python 库源码。
- 未取到：`bili_user_info` / `bili_user_videos` / `bili_favorite_*` / `bili_hot_buzzwords` / `bili_weekly_hot` 的精确 host+path（同上，仅库调用）。
