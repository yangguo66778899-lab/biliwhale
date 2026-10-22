# 架构说明（M0 现状）

这一页写给「接手改代码的人」：模块边界、一次醒来的数据流、以及几条不能破坏的不变式。
需求与验收标准在 [`../独立程序-需求文档.md`](../独立程序-需求文档.md)，这里不重复。

## 分层

```
CLI (src/cli.ts)
  └─ bootstrap：路径 / 日志 / 配置 / 凭据 / 账本 / 模型 / B 站客户端
        │
        ▼
orchestrator/round.ts  ── 一轮的相位机（唯一写文件、唯一记账）
   ├─ orchestrator/candidates.ts   多源取候选 → 归一化 → 去重 → 过滤 → 粗排
   ├─ orchestrator/prompts.ts      两个相位的 user prompt 构造
   ├─ orchestrator/gate.ts         分享闸门（纯函数，只判不发）
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

依赖方向是单向的：`orchestrator → agent → llm/bili → state/shared`。
反向依赖（比如 bili 层 import orchestrator）属破坏性改动，不要做。

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

## 想加东西时改哪里

| 要加的东西 | 改哪里 |
|---|---|
| 新的只读工具 | `agent/tools.ts` 的 `TOOLS`（写清 phases 与「什么时候别用」），再把关键材料加进 `orchestrator/prompts.ts` |
| 新的写操作（M3） | 先写 `gate.ts` 的闸门与 dry-run，再写 `bili/api.ts` 的写函数；**没有闸门不许合并** |
| 新的配置项 | `config/spec.ts` 一处即可（默认值、校验、说明、未来的设置页都从这里生长） |
| 新的产出文件 | `orchestrator/writers.ts`，并保证「多轮追加、不覆盖」 |
| 新的通知渠道 | `notify/`（M4），失败要回退到 `logs/notify.log` |
| 换模型供应商 | 别做。C2：只锁 DeepSeek。 |

## 已知的技术选择（以及为什么）

- **签名必须在队列外做**：WBI 材料来自 `nav`，而 `nav` 自己也要走串行队列。如果签名发生在队列内部，`nav` 会在队列里等自己 → 死锁（真接口冒烟时踩到过）。现在 `exchange()` 的顺序是「先 `buildUrl`（可能触发 `nav`）→ 再把真正的 fetch 放进队列」。
- **`nav` 走不解包通道**：匿名请求时 B 站返回 `code=-101` 却仍然给 `wbi_img`，所以 `BiliApi.nav()` 用 `jsonEnvelope()` 自己判 code：`-101` = 未登录（材料可用），其它非 0 才当错误。
- **原生 TS，无构建步骤**：Node 24 直接跑 `.ts`。代价是不能用「参数属性」「enum」这类不可擦除语法（`constructor(private x)` 会直接报错）。
- **零运行时依赖**：配置校验、日志、原子写都自己写；`zod` 换成了带中文 label 的声明式 schema（同一份数据将来直接渲染设置页）。
- **JSON 而不是 SQLite**：可读、可备份、可手改；单进程 + 单写入者足够。
- **测试用 `--test-isolation=none`**：本机沙箱下 Node 测试运行器 spawn 子进程会 EPERM；顺带也让测试共享一个进程、更快。
- **三种验证模式**：`--fixtures`（全离线）/ `--mock-model`（真 B 站 + 占位模型，验真实数据链路）/ 真实（真 B 站 + 真模型，验质量）。前两种可进 CI，第三种要人跑。
- **夹具/JSON 一律无 BOM**：Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，`JSON.parse` 直接崩。改夹具请用 `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`。
