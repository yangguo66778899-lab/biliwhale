# 架构说明（M0 + M1 现状）

这一页写给「接手改代码的人」：模块边界、一次醒来的数据流、以及几条不能破坏的不变式。
需求与验收标准在 [`../独立程序-需求文档.md`](../独立程序-需求文档.md)，这里不重复。

## 分层

```
壳 shell（可选）shell/BiliWhaleTray.cs  ── 只通过 127.0.0.1 HTTP + runtime.json 与内核说话
        │
        ▼
CLI (src/cli.ts) ── serve（守护进程）/ run（手动一轮）/ doctor / config
  └─ bootstrap（src/bootstrap.ts）：路径 / 日志 / 配置 / 凭据 / 账本 / 模型 / B 站客户端
        │
        ▼
daemon（src/daemon/）── 单实例 · 调度循环 · 控制接口 · 心跳 · 优雅退出
   ├─ daemon/scheduler.ts   把 scheduler 的判定落到状态与执行器（含「重算后立刻再判一次」）
   ├─ daemon/runner.ts      同一时刻只跑一轮；定时与手动撞车时后来者被拒
   ├─ scheduler/plan.ts     今日计划生成（纯函数）：窗口/跳过/硬上限/跨零点
   ├─ scheduler/tick.ts     到没到点（纯函数）：fire / missed / replanned / 暂停 / 分钟去重
   ├─ lifecycle/lock.ts     单实例锁（pid + 启动时间，陈旧锁自动清理）
   ├─ lifecycle/runtime.ts  runtime.json（端口+token）与 heartbeat.json
   ├─ lifecycle/autostart.ts 开机自启（HKCU Run，失败回落 Startup 文件夹）
   └─ http/server.ts + page.ts  本地控制接口与极简状态页
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
   ├─ bili/http.ts                 串行限速、header、错误分类、重试
   ├─ bili/wbi.ts                  WBI 签名（纯函数）
   ├─ bili/api.ts                  接口 → 领域类型（容错映射）
   │
   ├─ state/*                      配置外的所有持久事实（原子写）
   └─ shared/*                     日志脱敏、原子写、时间、错误分类、领域类型
```

依赖方向是单向的：`shell → http → daemon → orchestrator → agent → llm/bili → state/shared`。
反向依赖（比如 bili 层 import orchestrator）属破坏性改动，不要做。

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

## 想加东西时改哪里

| 要加的东西 | 改哪里 |
|---|---|
| 新的只读工具 | `agent/tools.ts` 的 `TOOLS`（写清 phases 与「什么时候别用」），再把关键材料加进 `orchestrator/prompts.ts` |
| 新的写操作（M3） | 先写 `gate.ts` 的闸门与 dry-run，再写 `bili/api.ts` 的写函数；**没有闸门不许合并** |
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
