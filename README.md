BiliWhale
=========

一个常驻 Windows 的 B 站「养鱼」程序内核：它按自己的作息醒来，去 B 站读视频、判断值不值得，
写一份日报和两本日记，把真正值得的分享给你。

只调用 DeepSeek；不依赖 Python、不依赖任何 agent 宿主、不依赖数据库。

本仓库当前状态：**M0（内核单轮）已完成，并已用真实 key 跑通一轮**——真模型 `deepseek-flash`、真 B 站数据，
候选 30 → 初筛 10 → 深读 3 → 挑中 1，日报与两本日记落盘，24.5k token。且**没有任何写 B 站的能力**
（代码里不存在发评论/私信/收藏/动态/点赞的函数）。

- 离线验证（不联网、不花钱、不需要凭据）：`npm run m0:offline`
- 真接口验证：`npm run smoke:bili`（只读）与 `npm run m0:live-read`（真 B 站数据 + 占位模型）
- 真实跑一轮：设 `BILIWHALE_API_KEY`（可选 `BILIWHALE_COOKIE`）后 `node src/cli.ts run --now --dry`

完整需求与验收标准见 [`独立程序-需求文档.md`](./独立程序-需求文档.md)（v0.5），
逐条验收对照见 [`docs/M0-验收记录.md`](./docs/M0-验收记录.md)，
实施状态与已知限制见 [`CHANGELOG.md`](./CHANGELOG.md)，模块与不变式见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

---

参考项目（设计与经验来源）
--------------------------

本项目的产品形态与工程取舍来自下面两个开源项目，在此致谢：

1. **[`Alterssss/dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale)**（v0.3.0，纯 Node）
   —— 「产品灵魂」的来源：生物钟随机唤醒、跳过权（今天不想看）、两本日记、0–20 打分的判分标尺、
   分享闸门（每日上限 / 同视频冷却 / 只从深读过里挑 / 发后复核）、收藏与分享并列、沉默衰减、
   反馈校准、多源选题。
2. **[`c1overzz/dsh-bili-scroll`](https://github.com/c1overzz/dsh-bili-scroll)**（0.1.x，Python + bilibili-mcp）
   —— 「工程克制」的来源：扫码登录、最小工具面（只注册当前需要的工具）、报告分档（完整 / 薄版 / 不写）、
   评论发出后复核、提示词文件的 sha256 账本、错误分类。

**说明（请务必读完）：**

- 本项目**自用为主**，没有针对通用场景做适配：默认单人单账号、Windows 优先、中文界面。
- 本项目**重写了模块边界与数据结构**，并且明确删掉了参考项目里的若干做法（见需求文档 §3 的
  「不要照抄」清单：宿主耦合、`spawn dsh`、Python/MCP、配置双写、用报告行数算配额等）。
- 本项目**没有直接复制上述两个项目的代码**。B 站接口（搜索、字幕、评论、WBI 签名等）是按公开的
  接口行为自行实现的；`NOTICE` 里记录了「如果将来引入它们的代码，该按什么许可证处理」。
- 许可证：MIT（见 `LICENSE`）。参考项目的版权归各自作者所有。

---

快速开始
--------

要求：Windows 10/11，Node.js ≥ 22.6（开发与运行都是原生 TS，无需构建步骤）。

```bash
# 1) 安装开发依赖（只有 typescript 和 @types/node，运行时零依赖）
npm install

# 2) 体检：数据目录、网络、凭据、ffmpeg
node src/cli.ts doctor

# 3) 跑一轮（M0 只读预演，不产生任何远端写操作）
node src/cli.ts run --now --dry

# 4) 验证方式
npm test              # 94 个用例：单元 + 工具循环 + 真 HTTP 适配层 + 离线整轮 golden
npm run m0:offline    # 夹具整轮：不联网、不需要凭据
npm run m0:live-read  # 真实 B 站数据 + 占位模型：验证真实数据能否走完整轮（不代表模型质量）
npm run smoke:bili    # 真 B 站只读冒烟：WBI / 搜索 / 视频 / 评论 / 字幕轨
```

> `--fixtures` 走的是 `fixtures/bili/*`（B 站响应）与 `fixtures/llm/*`（模型输出），
> 与 `npm test` 里的 golden 用例共用同一套夹具；CI 不需要网络与真实凭据。
> `--mock-model` 用真实 B 站、占位模型；它证明的是「链路通」，不是「判断好」。

凭据（不进仓库、不进日志）：

- DeepSeek：环境变量 `BILIWHALE_API_KEY`，或首次运行时写入 `<data>/secrets.json`
- B 站：环境变量 `BILIWHALE_COOKIE`（`SESSDATA=...; bili_jct=...; buvid3=...`），或写入 `secrets.json`

数据目录（Windows 标准位置，全新开始，不读任何旧数据）：

| 用途 | 路径 |
|---|---|
| 持久数据（配置 / 凭据 / 账本 / 报告 / 日记） | `%APPDATA%\BiliWhale` |
| 日志 / 缓存 / 心跳 | `%LOCALAPPDATA%\BiliWhale` |

调试时可用 `--data-dir <path>` 覆盖，或用 `--fixtures` 走离线夹具（不碰真实 B 站、不调用真模型）。

---

安全边界（第一阶段就成立，不靠后面补）
--------------------------------------

- 所有对外发言类写操作（评论 / 私信 / 动态 / 点赞）**默认关闭**；收藏默认开但可关。
- M0 只有只读能力：搜索、视频信息、字幕、评论。**代码里没有写接口**。
- 登录凭据只存 `secrets.json`，永不回显、永不进日志（统一 redact）。
- 不刷量、不批量、不绕过风控；B 站请求全部串行，带最小间隔与抖动。

---

目录结构
--------

```
src/
├── cli.ts              # 命令行入口（run / doctor / config）
├── config/             # 配置 schema、默认值、校验、原子读写；secrets 独立
├── state/              # state/seen/quota/feedback/runs 账本（原子写）
├── scheduler/          # 生物钟（M1）
├── orchestrator/       # 一轮的相位编排、闸门、落盘
├── agent/              # prompt 组装、工具装配、工具循环、输出校验
├── llm/                # DeepSeek 适配 + 模型发现
├── bili/               # B 站接口：http（串行限速）/ wbi（签名）/ api（映射）
├── dev/                # 离线夹具栈（--fixtures 与测试用）
├── notify/             # 通知出口（M4）
├── http/               # 本地面板 API（M2）
├── prompts/            # 内置 system.md / charter.md / 默认人设
└── shared/             # 类型、日志（脱敏）、原子写、时间、错误分类
test/                   # 单元 + 集成（52 个用例）
fixtures/               # 离线夹具（B 站响应、模型输出）
docs/                   # 架构说明、B 站只读接口规格
```

---

已知限制（M0 阶段）
--------------------

- **模型质量还没验证**：DeepSeek 真实调用路径只有单测 + 假 fetch；`--mock-model` 证明链路通，不证明判断好。真实质量要你的 key 跑一轮才算数。
- **字幕需要登录**：匿名请求拿不到字幕轨（实测 0 条），所以不带 cookie 时的「因无字幕跳过」是预期，不代表视频真没字幕。
- **代理还没接**：`app.proxy` 字段与校验已就位，实际链路待 M5 统一接（Node 24 的 env proxy 方案）。
- **不抽帧**：ffmpeg 只在体检里检查，`media.frames` 目前不生效。
- **日报由代码骨架 + 模型正文组成**：每轮的「### 这一轮」由模型写（`report_md`），「挑中的 / 看过的 / 今天的账」由代码生成；排障信息单独放在「### 运行备注（排障用）」。

后续里程碑（见需求文档 §15）：M1 作息 + 托盘，M2 面板 + 扫码登录，M3 分享与闸门，M4 次要写 + 监听/聊天，M5 打包，M6 硬化。

---

许可证
------

MIT，见 [`LICENSE`](./LICENSE)；第三方归属声明见 [`NOTICE`](./NOTICE)。
