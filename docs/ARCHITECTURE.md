# 架构说明（M0 + M1 + M2 现状）

这一页写给「接手改代码的人」：模块边界、一次醒来的数据流、以及几条不能破坏的不变式。
需求与验收标准在 [`../独立程序-需求文档.md`](../独立程序-需求文档.md)，这里不重复。

## 分层

```
浏览器面板（src/ui/：index.html + app.js + style.css，原生 JS，无构建、无 CDN）
        │ 只调 127.0.0.1 的 /api/*，Bearer + CSRF
        ▼
壳 shell（可选）shell/BiliWhaleTray.cs  ── 只通过 127.0.0.1 HTTP + runtime.json 与内核说话
        │
        ▼
CLI (src/cli.ts) ── serve（守护进程）/ run（手动一轮）/ doctor / config
  └─ bootstrap（src/bootstrap.ts）：路径 / 日志 / 配置 / 凭据 / 账本 / 模型 / B 站客户端
        │
        ▼
daemon（src/daemon/）── 单实例 · 调度循环 · 心跳 · 优雅退出
   ├─ daemon/api.ts         面板接口实现（状态/配置/账号/报告/日记/体检/诊断）
   ├─ daemon/scheduler.ts   把 scheduler 的判定落到状态与执行器（含「重算后立刻再判一次」）
   ├─ daemon/runner.ts      同一时刻只跑一轮；定时与手动撞车时后来者被拒
   ├─ scheduler/plan.ts     今日计划生成（纯函数）：窗口/跳过/硬上限/跨零点
   ├─ scheduler/tick.ts     到没到点（纯函数）：fire / missed / replanned / 暂停 / 分钟去重
   ├─ lifecycle/lock.ts     单实例锁（pid + 启动时间，陈旧锁自动清理）
   ├─ lifecycle/runtime.ts  runtime.json（端口+token）与 heartbeat.json
   ├─ lifecycle/autostart.ts 开机自启（HKCU Run，失败回落 Startup 文件夹）
   ├─ http/server.ts        本地控制接口 + 静态资源（白名单、防穿越、CSP）
   ├─ doctor.ts             体检（CLI 与面板共用）
   ├─ diagnostics.ts        脱敏诊断包
   ├─ account/login.ts      扫码登录 / cookie 粘贴 / nav 复核
   ├─ account/owner.ts      主人是谁（唯一入口；双账号模型，不回退到登录账号）
   ├─ qr/encoder.ts         二维码编码器（自己写，零依赖）
   ├─ bili/write.ts         写能力（评论/楼中楼/删/收藏/点赞/私信/动态；csrf + 签名 + 写间隔 + dry-run plan）
   ├─ orchestrator/share.ts 分享执行器：闸门 → 幂等 → 发送 → 复核 → 记账
   ├─ orchestrator/pending.ts 审批队列：扫描陌生人回复 → 草稿 → 批准/拒绝 → 复核
   ├─ orchestrator/fav.ts    收藏判据与执行（理由/同类/额度/冷却 + 收藏夹复核）
   ├─ orchestrator/like.ts   点赞与动态（默认关；动态必须二次确认，一轮里不自动发）
   ├─ orchestrator/dm.ts     私信分享（合并一条）与私聊通知（摘要/日记/视频信息，三子开关）
   ├─ orchestrator/chat.ts   只认主人的双向聊天：上下文最小化 + 附件白名单 + 频率限制
   ├─ orchestrator/watch.ts  评论/@ 监听：游标 + 首次建基线 + 陌生人进待审
   ├─ daemon/listen.ts       监听循环（评论/@ 与私信各自的间隔、抖动、退避）
   ├─ orchestrator/manual.ts  手动写（删自己的评论、面板发私信）：开关检查 + 只认自己的东西
   ├─ state/chatStore.ts      chat/owner.jsonl：追加/读最近 N/30 天清理/清空
   ├─ state/pending.ts        pending/replies.json：待审草稿与 7 天过期
   ├─ state/replied.ts        replied.json：谁回过我们、回过几次
   ├─ media/frames.ts        看画面：取低清 mp4 → ffmpeg 抽帧拼 3×3 + 字幕条（默认关；只降级不失败）
   └─ config/describe.ts    配置元数据（面板表单由它渲染）
        │
        ▼
orchestrator/round.ts  ── 一轮的相位机（唯一写文件、唯一记账）
   ├─ orchestrator/candidates.ts   多源取候选 → 归一化 → 去重 → 过滤 → 粗排
   ├─ orchestrator/prompts.ts      两个相位的 user prompt 构造
   ├─ orchestrator/gate.ts         分享闸门（纯函数，只判不发）
   ├─ orchestrator/skip.ts         跳过分支：只写两本日记 + 通知
   ├─ orchestrator/writers.ts      日报 / 两本日记 / 归档 / 通知文件
   │
   ├─ agent/prompts.ts             system（system.md + charter.md）与人设注入
   ├─ agent/loop.ts                工具循环：预算、熔断、重复调用缓存
   ├─ agent/tools.ts               按相位装配的只读工具
   ├─ agent/output.ts              模型输出解析与校验（不信任模型自报）
   │
   ├─ llm/client.ts                DeepSeek 适配（唯一知道 API 形状的文件）
   ├─ llm/discovery.ts             模型发现优先级
   │
   ├─ bili/http.ts                 串行限速、header、错误分类、重试、raw（读 Set-Cookie）
   ├─ bili/wbi.ts                  WBI 签名（纯函数）
   ├─ bili/api.ts                  接口 → 领域类型（容错映射）
   │
   ├─ state/*                      配置外的所有持久事实（原子写）
   └─ shared/*                     日志脱敏、原子写、时间、错误分类、领域类型
```

依赖方向是单向的：`ui → http → daemon → orchestrator → agent → llm/bili → state/shared`。
反向依赖（比如 bili 层 import orchestrator）属破坏性改动，不要做。

## 打包、备份、升级（M5）

```
scripts/pack.mts ──> src/pack/plan.ts（清单，纯函数，可测）──> dist/BiliWhale-<版本>/
                     ├── app/（src + fixtures + shell/BiliWhaleTray.exe + 文档）
                     ├── runtime/node.exe（随包带 Node）
                     ├── BiliWhale.cmd / install.cmd / install.ps1 / uninstall.* / README.txt / VERSION
                     └── → dist/BiliWhale-<版本>-portable.zip（deflate）

src/backup.ts ──> src/shared/zip.ts（store/deflate + CRC32 + zip-slip 校验）
                  ├── backup：固定文件 + reports/diaries/archive/runs/chat，带 manifest.json
                  └── restore：白名单校验 → JSON parse → 原子写（保留 .bak）

src/config/migrate.ts ──> ConfigService.load()（启动时跑一次，迁移后写回）
src/update.ts         ──> /api/update/check、CLI update（只比较主.次.修，只提示不下载）
src/daemon/configWatch.ts ──> fs.watch + mtime 轮询（5s 兜底）+ 单层 debounce（500ms）
```

**升级流程**（写进用户手册 §6）：备份 → 退出内核 → 覆盖 pp/ 与 untime/ → 启动（自动迁移配置）→ 需要回滚就装回旧 pp/ + estore 备份。
**为什么不打安装器 exe**：Inno Setup 要引入构建期工具链；「便携包 + 脚本安装」同样免管理员、可卸载、能自启，
packaging/ 里加一份 .iss 随时能补上，不影响内核。

## 本地接口（M2 全量）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/session` | 拿 CSRF token（写操作要用）+ 版本 |
| GET | `/api/health` `/api/status` `/api/logs` | 存活 / 状态摘要 / 事件流（limit 夹 1..500） |
| POST | `/api/run` `/api/pause` `/api/resume` `/api/shutdown` | 动作 |
| GET/POST | `/api/autostart` | 查 / 开 / 关开机自启 |
| GET/PUT | `/api/config` | 读配置（带分组元数据）/ 保存（校验→原子写→必要时重算计划） |
| POST | `/api/config/validate` `/api/config/import` `/api/config/reset` | 只校验 / 导入 / 恢复默认 |
| GET | `/api/config/export` | 下载配置（不含凭据） |
| GET | `/api/models` `/api/doctor` `/api/diag` | 模型与预算 / 体检 / 脱敏诊断包 |
| GET | `/api/account` | 登录态、UID、凭据指纹（不回显原值） |
| POST | `/api/account/qr` `/api/account/cookie` `/api/account/verify` `/api/account/logout` | 扫码 / 粘贴 / 复核 / 退出 |
| GET | `/api/account/qr/poll?key=` | 扫码状态轮询 |
| GET | `/api/reports` `/api/reports/:date` `/api/diaries` `/api/diaries/:kind/:date` | 报告与两本日记 |
| GET | `/api/pending` | 待审草稿（含历史） |
| POST | `/api/pending/scan` | 手动扫一次「我们评论下的新回复」 |
| POST | `/api/pending/:id/approve` `/api/pending/:id/reject` | 批准（可带 `dryRun`）/ 拒绝（带理由） |
| DELETE | `/api/comments/:bvid/:rpid` | 删自己发过的评论（只认账本里的 rpid） |
| GET | `/` `/app.js` `/style.css` | 面板静态资源 |

不在这张表里的路径一律 404；缺 handler 的面板接口回 501（方便分阶段上线）。

## 常驻形态（M1）

```
tick（30s） ──> scheduler.tick ──> fire ──> runner.runScheduled ──> runRound / runSkipRound
                    │                                              │
                    ├─ replanned → state.applyPlan（写今天的槽位）    ├─ 落盘报告+两本日记
                    ├─ missed    → 标错过 + 事件（不补发）           ├─ 记账（runs / quota / seen）
                    └─ 休眠恢复：两次 tick 间隔 >5 分钟 → resume 事件  └─ 通知

控制接口：GET /api/health|status|logs|autostart · POST /api/run|pause|resume|autostart|shutdown
握手文件：<local>/runtime.json（端口+token） · <local>/heartbeat.json · <local>/instance.lock
```


## 一次醒来的数据流

```
Phase 0 预检      key / cookie / 磁盘 / 急停     → 失败就写失败日记并结束
Phase 1 上下文    日期、额度、沉默档位、判重摘要   → 组装 system / preamble（每轮重建，无会话）
Phase 2 取候选    搜索 + 热门 (+ 排行/关注)       → 合并去重 → 过滤时长/UP/已看过 → candidateLimit
Phase 3 轻读      视频详情 + 字幕摘要 + 3 条热评   → 串行，出错只标 degraded
Phase 4 初筛      模型打 0–20 分                 → 不合格修一次；再不合格走确定性排序
Phase 5 深读      完整字幕 + 12 条评论            → 只对 top K
Phase 6 决策写作  模型输出 RoundResult           → selected/why/oneliner/日记/notify
Phase 7 闸门      gateShare 逐条判              → M0 只判不发（代码里没有写接口）
Phase 8 落盘      报告 / 两本日记 / 归档 / seen   → 账本只由编排器写
Phase 9 通知      文件出口                       → 其它渠道在 M4/M5
Phase 10 收尾     token 记账 / run 记录 / 事件    → state.noteRun + addUsage
```

## 不变式（改代码前先读）

1. **无会话**：跨轮不保留对话历史。记忆只来自 `state.json`、`seen.json`、`diary`、`quota.json`。
2. **模型不写文件**：所有落盘与记账都在编排器；工具只返回数据。
3. **工具白名单**：模型只能看到当前相位注册的工具；写工具在 M0 完全不存在。
4. **不信任模型自报**：分数、额度、判重、渠道由代码重算；bvid 必须在「本轮深读集合」里。
5. **配额只从账本算**：绝不从报告文本里数行数。
6. **失败可见**：每个相位都有状态（ok/degraded/failed），错误进 `run.errors`，事件进 `events.jsonl`。
7. **凭据永不落盘到日志**：`shared/redact.ts` 是最后一道保险，任何新日志都走 `Logger`。
8. **原子写**：状态文件一律 `writeJsonAtomic`；文本用 `writeTextAtomic`。
9. **串行取数**：B 站请求并发永远为 1（`BiliHttp` 的 `SerialQueue`）。
10. **能停**：任何相位抛异常都不允许让进程崩；`runRound` 的边界是最后的兜底。
11. **单实例**：`InstanceLock` 抢不到就说明「谁在跑、端口多少」并退出，不许起第二个内核。
12. **调度是纯函数**：`scheduler/plan.ts` 与 `scheduler/tick.ts` 不碰文件、不调网、不读时间——时间/随机/计划全部注入，所以能测。
13. **同一时刻只跑一轮**：`RoundRunner` 里已有一轮在跑时，定时触发会被跳过（记事件），手动触发返回 409。
14. **控制接口只在本机**：只绑 `127.0.0.1`，必须带 token，校验 Host，不返回 CORS 头。
15. **壳不碰业务数据**：托盘只调 HTTP、只读 `runtime.json`；它不知道 candidates/quota/diary 是什么。
16. **写操作要 CSRF**：POST/PUT 除 Bearer 外还要 `x-csrf-token`；`/api/session` 是唯一的例外。
17. **面板离线自洽**：`src/ui/` 不引任何外部地址（只允许 SVG 命名空间）、不含内联脚本（CSP 会拦）、不直接访问 B 站。
18. **配置只有一个来源**：面板渲染字段、校验、默认值全部来自 `config/spec.ts`；面板里不写死任何字段名或默认值。
19. **凭据不进导出物**：`/api/config/export` 与 `/api/diag` 都不含 cookie / apiKey（诊断包最后统一过 `redactDeep`）。
20. **登录态可验证**：扫码或粘贴之后必须调一次 `nav` 才算数；验不过就如实说「没验过」，不许假装已登录。
21. **写只在一个文件里**：B 站写接口只许出现在 `bili/write.ts`；发评论只许被 `orchestrator/share.ts` 与 `pending.ts` 调，
   删评论只许被 `orchestrator/manual.ts` 调（有不变式测试扫源码）。
22. **发之前先过闸门**：`share.ts` 里必须先 `gateShare()` 再 `postComment()`，且必须查幂等账本（`hasSentContent`）。
    所有拒绝理由都要收集起来写进报告（「为什么没发」可解释），不能第一个不过就 return。
23. **发完必须复核，失败不重发；复核要能区分「没发出去」与「被挂起」**：3 次递增，走 `findOwnComment()`
    （`sort=0` 第一页 → `sort=1` 第一页 → 楼中楼端点，后者只要评论存在就返回 root 带 `state`）。三态：
    公开可见 → `sent`；存在但不可见（`state=17` 审核/仅自己可见）→ `held`（占额度、不重发，报告写清「主人可能收不到 @」）；
    完全查不到 → `unverified`。rpid 取不到就写「没取到」，绝不编。真机上三条评论都被挂起，却一律报「复核未通过」——就是这么来的。
24. **风控即停手**：`risk` 类的错误（412/12015/12051…）要立刻停掉本轮所有写、设冷却、写事件；
    冷却期内分享与审批都拒绝。
25. **陌生人回复一律走审批**：草稿进 `pending/replies.json`；批准才发、拒绝留理由、7 天过期作废；
    审批发送同样受总写开关/急停/风控约束。
26. **手动写也受同一套开关**：面板删评论 / 发私信走 `manual.ts`，只认自己账本里的 rpid 与今天出现过的 BV。
27. **每个写能力都有自己的执行器**：收藏只能 `fav.ts` 发、点赞只能 `like.ts` 发、私信只能 `dm.ts` / `chat.ts` / `manual.ts` 发、
    动态只能 `like.ts` 发（且必须 `confirm`）；有不变式测试按文件名扫。
28. **「关了就是零」**：每个开关关闭后不许有任何请求、任何记账、任何聊天记录；测试里把 API 换成「一调就抛」来证明。
29. **聊天只认主人**：`senderId !== ownerMid` 直接返回，不发请求、不记账；`ownerMid` = 配置里的 `account.mid`，没有就用登录态。
30. **聊天不干活**：聊天路径不建 `ToolRuntime`、不写 `ConfigService`、不调 share/fav/like/dm-notify；
    只允许回一条 + 两个附件（公开日记 / 白名单 BV），并有代码兜底拒绝「帮你改设置/贴 cookie/本机路径」。
31. **监听不倒历史**：游标为空时只记下当前位置（`baseline`），不创建任何草稿；间隔 ≥60s（评论）/ 20–60s（私信），
    空闲退避到 15 分钟；重活（读消息、调模型）只在真有新消息时发生。
32. **候选不够就翻页，翻完要明说**：`candidates.ts` 每取完一页就重新过一遍「合并/去重/过滤」，
    `filtered < candidateLimit` 时继续翻（`content.candidatePages`，默认 3，上限 5）；某页没带来任何新 bvid 就停；
    候选少于 `screenLimit` 时必须在 notes 里写清楚，**不许静默变少**（真机「27 → 17 → 8」就是第 1 页被挖穿 + 没人吭声）。
33. **预演只有一个来源**：`runRound` 开头的 `effectiveDryRun = options.dryRun || cfg.safety.dryRun` 是唯一判据；
    提示词状态、报告措辞、run 记录、分享/收藏/点赞/私信都必须用它。`round.ts` 与 `daemon/runner.ts` 里**不许**写死 `dryRun: true`
    （有不变式测试扫源码；真机上「报告总说预演、模型总说只读预演、定时那一轮从不真发」就是这么来的）。

34. **主人 ≠ 登录账号**：`account.mid/name` 是登录账号（鲸鲸自己，发送方身份），`account.ownerMid/ownerName` 是主人（另一个号，必填）。
    所有「@ 谁 / 私信发给谁 / 聊天只认谁 / 主人直发」都走 `src/account/owner.ts` 的 `resolveOwner()`，**不许回退到登录账号**；
    缺主人或填成登录账号 → 明确拒绝并给出可读原因（真机上「@ 是空的、私信发给自己、聊天不回主人」就是这么来的）。
35. **迁移只补形状、不动数据**：`config/migrate.ts` 的每一步都是纯函数、幂等、只往前走；迁移失败保留原配置并报错，
    **不许回落默认值**（会把用户的窗口/开关全冲掉）。比程序新的配置原样保留并提示（可能是装回了旧版）。
36. **备份只认白名单**：`backup.ts` 写备份时挑固定文件与目录，恢复时逐条校验路径（拒绝 `..`、绝对路径、程序文件），
    JSON 先 parse 再原子写；凭据默认**不进备份**（要带就显式 `--with-secrets`）。
37. **打包产物是「能跑的一整套」**：`scripts/pack.mts` 只复制清单里的东西（`src/pack/plan.ts`），随包带 `runtime/node.exe`；
    包里不出现 `test/`、`node_modules/`、`dist/`、`.git/`；安装脚本只写 HKCU 与 `%LOCALAPPDATA%`，不需要管理员。
38. **配置热更新不能只靠 fs.watch**：`daemon/configWatch.ts` 用 watch（立刻）+ mtime 轮询（最多 5 秒兜底）双保险，
    debounce 只有这一层（别再套 `setTimeout`，否则改完要等 1 秒才生效——浸泡测试踩过）。

## 想加东西时改哪里

| 要加的东西 | 改哪里 |
|---|---|
| 新的只读工具 | `agent/tools.ts` 的 `TOOLS`（写清 phases 与「什么时候别用」），再把关键材料加进 `orchestrator/prompts.ts` |
| 新的写操作（M5+） | 先写闸门/判据（纯函数）与 dry-run，再写 `bili/write.ts` 的函数（加进不变式白名单），最后给它一个专属执行器；**没有闸门不许合并** |
| 新的配置项 | `config/spec.ts` 一处即可（默认值、校验、说明、未来的设置页都从这里生长） |
| 新的产出文件 | `orchestrator/writers.ts`，并保证「多轮追加、不覆盖」 |
| 新的通知渠道 | `notify/`（M4），失败要回退到 `logs/notify.log` |
| 新的控制接口 | `http/server.ts` 加路由 + `daemon/index.ts` 的 handlers 实现；别忘了鉴权与 Host 校验是统一入口 |
| 托盘加菜单项 | `shell/BiliWhaleTray.cs`（C# 5 语法）+ 对应 HTTP 接口；托盘不许直接读写数据文件 |
| 换模型供应商 | 别做。C2：只锁 DeepSeek。 |

## 已知的技术选择（以及为什么）

- **签名必须在队列外做**：WBI 材料来自 `nav`，而 `nav` 自己也要走串行队列。如果签名发生在队列内部，`nav` 会在队列里等自己 → 死锁（真接口冒烟时踩到过）。现在 `exchange()` 的顺序是「先 `buildUrl`（可能触发 `nav`）→ 再把真正的 fetch 放进队列」。
- **`nav` 走不解包通道**：匿名请求时 B 站返回 `code=-101` 却仍然给 `wbi_img`，所以 `BiliApi.nav()` 用 `jsonEnvelope()` 自己判 code：`-101` = 未登录（材料可用），其它非 0 才当错误。
- **原生 TS，无构建步骤**：Node 24 直接跑 `.ts`。代价是不能用「参数属性」「enum」这类不可擦除语法（`constructor(private x)` 会直接报错）。有测试扫源码 + 逐个 import 所有模块守着。
- **零运行时依赖**：配置校验、日志、原子写都自己写；`zod` 换成了带中文 label 的声明式 schema（同一份数据将来直接渲染设置页）。
- **JSON 而不是 SQLite**：可读、可备份、可手改；单进程 + 单写入者足够。
- **`state.json` 先补齐再用**：手改/旧版本可能只有半截字段，`AppStateStore.normalize()` 会补默认值，坏文件不能让守护进程起不来。
- **重算计划后立刻再判一次**：开机、恢复、改配置时，如果新计划里某个时刻已经到点，同一个 tick 里直接触发，不干等 30s。
- **测试用 `--test-isolation=none --test-force-exit`**：本机沙箱下 Node 测试运行器 spawn 子进程会 EPERM；`--test-force-exit` 是因为守护进程测试按设计会留下长连接/定时器。
- **三种验证模式**：`--fixtures`（全离线）/ `--mock-model`（真 B 站 + 占位模型，验真实数据链路）/ 真实（真 B 站 + 真模型，验质量）。前两种可进 CI，第三种要人跑。
- **夹具/JSON 一律无 BOM**：Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，`JSON.parse` 直接崩。改夹具请用 `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`。
- **`.ps1` 反过来必须有 BOM**：PowerShell 5.1 没有 BOM 就按 ANSI（GBK）读脚本，中文注释会把引号配对搞乱、直接语法错误。两条约定都有不变式测试守着。
- **托盘用 C# 5 写**：`csc.exe`（.NET Framework 4.8 自带）只支持 C# 5，所以不能用字符串插值、`?.`、`nameof`。好处是零工具链：`npm run tray:build` 就能出 exe。
- **自启双后端**：注册表是文档首选，但受限环境下 `reg.exe` 可能起不来（连 spawn 都会 EPERM）；回落写 Startup 文件夹的 `.cmd`，两个后端互相清理，状态里如实报告用了哪个。
- **面板不用框架、不打包**：`src/ui/` 三个文件（html/js/css）直接由内核静态服务，`script-src 'self'`，没有内联脚本、没有 CDN、没有构建步骤。代价是没有组件化；好处是「离线可用」这条硬要求白拿，且 M5 打包时把三个文件内联进去就行。
- **子资源靠会话 cookie 带凭据**：`<script src="/app.js">`、`<link href="/style.css">` 是浏览器自己发的请求，带不上 `?token=`。
  所以用 token 打开页面时，内核种一个 `HttpOnly; SameSite=Strict` 的会话 cookie（随机值，只在本次进程内有效，7 天），
  子资源与 API 都认它；写操作仍要 CSRF。**没有走这条路的测试，就是 0.4.0 漏掉的那个 bug**：
  现在 `test/panel-assets.test.ts` 按浏览器顺序（先开页面拿 cookie、再不带 token 取子资源）验证。
- **没凭据的导航给说明页**：直接访问 `/` 而没有 token/cookie 时回 401 的 **HTML**，告诉人「从托盘打开 / 用打印出来的地址」，
  而不是甩一行 JSON（浏览器里那行 JSON 只会让人以为程序坏了）。API 仍然回 401 JSON。
- **设置页不写死字段**：表单完全由 `config/describe.ts` 从 `config/spec.ts` 生成（20 组 96 字段）。加一个配置项只改 schema，面板自动出现；不变式测试守着「每个字段都有 label 与默认值」。
- **写操作要 CSRF**：token 放在 URL 里会被浏览历史/截图带走，而 `127.0.0.1` 上的服务对同机进程是不设防的。所以：GET 只读；POST/PUT 额外校验 `x-csrf-token`（`/api/session` 发放，内存里存，重启即换）；再加 Host 校验与「不返回 CORS 头」。
- **静态资源走白名单**：只允许 `.html/.js/.css/.svg/.png/.ico/.json`，并且解析后的绝对路径必须落在 `src/ui` 里；URL 规范化的 `..` 折叠 + 我们自己的 `..` 检查是双保险（有测试）。
- **二维码自己实现**：需求文档要求「纯 JS 生成，不依赖 Python qrcode」。写了个只做字节模式 + 版本 1–10 的编码器（约 600 行含表），**用外部参照逐模块对拍**（v1–v6、L/M/Q/H 全 diff=0），对拍结果冻结成夹具，防止以后改坏。
- **登录凭据只能从响应头拿**：扫码成功后 B 站把 `Set-Cookie` 挂在 302 上，`fetch` 默认跟随重定向就会丢掉；所以 `raw()` 走 `redirect: 'manual'`，并把 3xx 当成功（body 可能为空）。
- **cookie 是取值函数而不是常量**：`BiliHttp` 里 `cookie: string | (() => string)`，登录成功后 `secrets` 一变，下一次请求就带新 cookie，不需要重建客户端。
- **体检只有一份实现**：`src/doctor.ts` 同时给 CLI 与 `/api/doctor` 用，避免「命令行说没事、面板说有事」这种最烦人的不一致。
- **诊断包脱敏后才出网**：`buildDiagBundle` 最后统一过 `redactDeep`；测试里塞一个假 cookie 与假 key，断言包里一个字节都不出现。日记与报告只统计文件数，不打包正文。
- **写请求先算形状再发送**：`planComment()` 是纯函数（csrf 打码），dry-run、报告、面板预览都复用它；真发才走 `postComment()`。
  这样「预演」和「真发」不可能长得不一样，也保证了预演绝不会碰网络。
- **幂等键放在账本里**：`sha256(bvid|action|target|contentHash)` 写进 `quota.json` 的 `note`。
  为什么不用单独的账本文件：文档 §7.7 的文件清单里没有它，而额度账本本来就是「写操作台账」，多一份容易对不上。
- **复核只看最新一页**：发完按 `sort=0`（时间倒序）拉第一页找 rpid，命中就算复核通过；3 次递增（0/2s/6s）。
  不翻页是刻意的：翻页会把「刚发就被折叠」这种正常情况误判成失败，代价是漏判——漏判标 `unverified` 比误判「重发」安全。
- **写间隔与读间隔分开**：读 1.5s + 抖动，写 5s + 0–1s 抖动（写层自己计时，不复用读队列的节流）。
- **待审队列不自动清零**：草稿会一直留着直到你处理或 7 天过期；过期只是改状态，不删记录（历史还能看）。
- **「主人」在单账号下就是自己**：自己回自己的评论在扫描阶段直接跳过；`ownerDirect`（主人直发）要等双账号场景才有意义，
  所以 M4 里没有留那段走不到的代码。私信的收件人也按同一口径：`account.mid`（没有就用登录态 mid）。
- **私信/动态接口形状未验证**：`api.vc.bilibili.com/web_im/send_msg` 与 `x/dynamic/feed/create/dyn` 是照公开实现写的，
  `sign` 传 `false`（这两个域名不吃 wbi）。评论/收藏/点赞走 `api.bilibili.com` 且签名。
  这一条明确写在验收记录的 ⏳ 里——**在真账号上跑通之前，不要相信这条链路**。
- **聊天上下文故意很小**：人设 + 最近 N 条 + 今天公开日记（截 600 字）+ 报告摘要（截 400 字）+ 今天的 BV 列表。
  不注入字幕、不注入评论区，既省钱也少给提示注入留口子。
- **第 1 页不是全部**：热门/搜索的第 2 页和第 1 页零重叠（真接口探过），所以「候选不够就翻页」是真的能扩池；
  排行接口没有分页，所以它只取第 1 页。
- **监听是轮询**：评论/@ 用消息中心一次拿一页（≥60s），私信先只拉会话列表（20–60s），
  只有「最后一条时间 > 游标」时才去拉消息、才调模型——所以「没新消息零 token」是结构保证，不是运气。
