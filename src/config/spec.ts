/**
 * 配置 schema（单一事实源）。
 *
 * 职责：用一份声明式规格同时表达「类型 + 默认值 + 取值范围 + 中文说明」。
 *   校验、默认值填充、未来的设置页字段渲染都从这份规格生出来，避免三处各写一套。
 * 不做什么：不做 IO（读写由 service.ts 负责），不做业务逻辑。
 *
 * 规格里的 label / desc 是给面板用的中文文案：字段必须能解释「改了会发生什么」。
 */

/* ---------- 规格类型 ---------- */

export interface BaseField {
  /** 面板上的中文标签。 */
  label: string;
  /** 一句话说明：改了会发生什么。 */
  desc?: string;
  /**
   * 面板不显示（字段仍在：配置照常读、导出照常带）。
   * 用途：功能还没接线的字段不要摆到用户面前——摆出来就是「点了没用」的假开关（P0-1 的教训）。
   * 什么时候能拿掉：接上线那天把 hidden 去掉；永远不做的就删字段 + 迁移。
   */
  hidden?: boolean;
}

export interface StringField extends BaseField {
  kind: 'string';
  default: string;
  maxLen?: number;
  pattern?: RegExp;
  patternMessage?: string;
  /** 秘密字段：永不回显、导出时剔除。 */
  secret?: boolean;
}

export interface NumberField extends BaseField {
  kind: 'number';
  default: number;
  min?: number;
  max?: number;
  int?: boolean;
}

export interface BooleanField extends BaseField {
  kind: 'boolean';
  default: boolean;
}

export interface EnumField extends BaseField {
  kind: 'enum';
  values: readonly string[];
  default: string;
  /**
   * 面板上显示给人看的取值（中文）。值本身仍是 `values` 里的英文枚举（配置/代码只认它）。
   * 为什么要有：设置页直接把枚举值当选项文本渲染，用户会看到 `full / brief / webhook` 这种词。
   */
  valueLabels?: Readonly<Record<string, string>>;
}

export interface ArrayField extends BaseField {
  kind: 'array';
  item: FieldSpec;
  default: readonly unknown[];
  maxItems?: number;
}

export interface ObjectSpec extends BaseField {
  kind: 'object';
  fields: Record<string, FieldSpec>;
}

export type FieldSpec = StringField | NumberField | BooleanField | EnumField | ArrayField | ObjectSpec;

/** 规格 → 值的类型推导。 */
export type Infer<S> = S extends { kind: 'enum'; values: readonly (infer V)[] }
  ? V
  : S extends { kind: 'string' }
    ? string
    : S extends { kind: 'number' }
      ? number
      : S extends { kind: 'boolean' }
        ? boolean
        : S extends { kind: 'array'; item: infer I }
          ? Infer<I>[]
          : S extends { kind: 'object'; fields: infer F }
            ? { [K in keyof F]: Infer<F[K]> }
            : never;

export type Config = Infer<typeof SPEC>;
export type NotifyChannel = Config['notify']['channels'][number];

/* ---------- 规格本体 ---------- */

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$|^24:00$/;

export const SPEC = {
  kind: 'object',
  label: '配置',
  fields: {
    version: { kind: 'number', label: '配置版本', default: 1, min: 1, max: 999, int: true },

    app: {
      kind: 'object',
      label: '程序本身',
      fields: {
        dataDir: { kind: 'string', label: '数据目录', desc: '留空 = %APPDATA%\\BiliWhale', default: '', maxLen: 260, hidden: true },
        locale: {
          kind: 'enum',
          label: '界面语言',
          values: ['zh-CN'] as const,
          valueLabels: { 'zh-CN': '简体中文' } as const,
          default: 'zh-CN',
          hidden: true,
        },
        logLevel: {
          kind: 'enum',
          label: '日志级别',
          values: ['debug', 'info', 'warn', 'error'] as const,
          valueLabels: { debug: '调试（很啰嗦）', info: '一般', warn: '警告与错误', error: '只记错误' } as const,
          default: 'info',
          hidden: true,
        },
        autostart: { kind: 'boolean', label: '开机自启', desc: '写 HKCU Run 键，不需要管理员', default: true, hidden: true },
        tray: { kind: 'boolean', label: '显示托盘图标', desc: '关掉后只能用命令行/浏览器书签', default: true, hidden: true },
        singleInstance: { kind: 'boolean', label: '单实例', default: true, hidden: true },
        updateUrl: {
          kind: 'string',
          label: '在哪儿查新版',
          desc: '留空就不查。填一个能返回版本号的地址（JSON，格式见文档）；只提示，不自动下载',
          default: '',
          maxLen: 300,
        },
        proxy: {
          kind: 'string',
          label: '代理',
          desc: '留空 = 跟随系统代理；填 direct = 强制直连；也可填 http://host:port',
          default: '',
          maxLen: 200,
          hidden: true,
        },
      },
    },

    llm: {
      kind: 'object',
      label: '模型与花费',
      fields: {
        baseUrl: { kind: 'string', label: '服务地址（一般不用改）', desc: '默认 DeepSeek 官方；换镜像/代理才动它', default: 'https://api.deepseek.com', maxLen: 200 },
        model: { kind: 'string', label: '用哪个模型', desc: '自动挑模型开着时，这个只是首选', default: 'deepseek-flash', maxLen: 80 },
        modelAuto: {
          kind: 'boolean',
          label: '自动挑一个能用的模型',
          desc: '启动或换 key 时问一次模型列表；问不到就用上面那个',
          default: true,
        },
        temperature: { kind: 'number', label: '想象力（0–2）', desc: '越大越发散；0.7 已经够用', default: 0.7, min: 0, max: 2 },
        maxTokens: { kind: 'number', label: '一次最多写多少（token）', desc: '太小可能把返回的 JSON 截断', default: 4096, min: 256, max: 32768, int: true },
        timeoutMs: { kind: 'number', label: '等多久算超时（毫秒）', desc: '网络慢就调大；默认 120000 = 2 分钟', default: 120000, min: 5000, max: 600000, int: true },
        maxRetries: { kind: 'number', label: '失败重试几次（0–5）', desc: '网络抖一下会自动再试；0 = 不重试', default: 3, min: 0, max: 5, int: true },
        maxSteps: { kind: 'number', label: '一轮最多来回几次（1–30）', desc: '模型反复要工具的次数上限，到数就收手', default: 20, min: 1, max: 30, int: true },
        maxToolCalls: { kind: 'number', label: '一轮最多查几次（1–60）', desc: '查资料的上限，到数就按现有材料写', default: 20, min: 1, max: 60, int: true },
        runBudgetTokens: { kind: 'number', label: '一轮最多花多少 token', desc: '到数就收手，别让一轮烧太多', default: 60000, min: 1000, max: 1000000, int: true },
        dailyBudgetTokens: { kind: 'number', label: '一天最多花多少 token', desc: '到数当天就不再开新轮', default: 300000, min: 1000, max: 10000000, int: true },
        dailyBudgetCny: { kind: 'number', label: '一天最多花多少钱（元）', desc: '填 0 = 不按钱限制，只记 token', default: 5, min: 0, max: 10000 },
        pricePerMTokens: {
          kind: 'number',
          label: '单价（元 / 百万 token）',
          desc: '填 0 = 只记 token、不算钱',
          default: 0,
          min: 0,
          max: 1000,
        },
      },
    },

    account: {
      kind: 'object',
      label: '两个号',
      fields: {
        mid: { kind: 'number', label: '「鲸鲸」的 UID', desc: '登录后自动填；发评论、发私信用的是这个号', default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
        name: { kind: 'string', label: '「鲸鲸」的昵称', desc: '登录后自动填', default: '', maxLen: 80 },
        ownerMid: {
          kind: 'number',
          label: '你的 UID（主人）',
          desc: '必填，而且必须是另一个号：评论 @ 谁、私信发给谁、聊天只回谁，都看它',
          default: 0,
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          int: true,
        },
        ownerName: {
          kind: 'string',
          label: '你在评论区的名字',
          desc: '评论里 @ 的就是这个名字；留空可以在「账号」页按 UID 自动取',
          default: '',
          maxLen: 80,
        },
        cookieRef: { kind: 'string', label: '凭据引用', desc: '内部字段，指向 secrets.json', default: 'bili', maxLen: 40, hidden: true },
      },
    },

    persona: {
      kind: 'object',
      label: '她怎么说话',
      fields: {
        name: { kind: 'string', label: '她叫什么', desc: '留空就用中性默认', default: '', maxLen: 40 },
        ownerTitle: { kind: 'string', label: '她怎么称呼你', desc: '聊天和日记里怎么叫你', default: '你', maxLen: 20 },
        selfClaim: { kind: 'string', label: '她怎么自称', desc: '她提到自己时用什么词', default: '我', maxLen: 20 },
        file: { kind: 'string', label: '人设文件', desc: '相对数据目录，默认 prompts/persona.md；改完下次启动生效', default: 'prompts/persona.md', maxLen: 200 },
      },
    },

    preferences: {
      kind: 'object',
      label: '她爱看什么',
      fields: {
        like: {
          kind: 'array',
          label: '想看的（一行一个）',
          desc: '她按这些方向找视频；留空就只看热门和排行',
          item: { kind: 'string', label: '方向', default: '', maxLen: 40 },
          default: ['AI 工具与插件', '猫咪', '鬼畜与怀旧向剪辑', '动画/模型'],
          maxItems: 30,
        },
        dislike: {
          kind: 'array',
          label: '不想看的（一行一个）',
          desc: '命中就降权，不是硬过滤',
          item: { kind: 'string', label: '方向', default: '', maxLen: 40 },
          default: ['带货', '擦边', '标题党', '纯搬运'],
          maxItems: 30,
        },
        keywords: { kind: 'array', label: '搜索词（一行一个）', desc: '留空就用「想看的」当搜索词', item: { kind: 'string', label: '关键词', default: '', maxLen: 40 }, default: [], maxItems: 30 },
      },
    },

    schedule: {
      kind: 'object',
      label: '什么时候醒',
      fields: {
        windows: {
          kind: 'array',
          label: '醒来的时段',
          desc: '每个时段里随机挑时间醒；所有时段加起来一天别超过 3 次',
          maxItems: 6,
          default: [{ start: '20:00', end: '24:00', wakes: 1, label: '晚上' }],
          item: {
            kind: 'object',
            label: '时段',
            fields: {
              start: { kind: 'string', label: '从几点开始', default: '20:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
              end: { kind: 'string', label: '到几点结束', default: '24:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
              wakes: { kind: 'number', label: '这个时段醒几次（1–3）', default: 1, min: 1, max: 3, int: true },
              label: { kind: 'string', label: '这段叫什么（可留空）', default: '', maxLen: 20 },
            },
          },
        },
        skipChance: {
          kind: 'number',
          label: '今天不想动的概率（0–0.95）',
          desc: '0 = 每天都看；0.2 = 五分之一的日子只想写日记',
          default: 0.2,
          min: 0,
          max: 0.95,
        },
        maxWakesPerDay: { kind: 'number', label: '一天最多醒几次（0–3）', desc: '硬上限 3；0 = 只能手动跑', default: 1, min: 0, max: 3, int: true },
        graceMinutes: { kind: 'number', label: '过点多久算错过（分钟）', desc: '过了这个宽限就不补跑（「过了就过了」是定过的口径）', default: 90, min: 0, max: 1440, int: true },
      },
    },

    content: {
      kind: 'object',
      label: '一轮看多少',
      fields: {
        maxVideos: { kind: 'number', label: '一轮最多挑几条', desc: '挑中的都进报告；越多越费 token', default: 5, min: 1, max: 20, int: true },
        candidateLimit: { kind: 'number', label: '最多看多少条候选', desc: '几个来源合起来截到这里', default: 30, min: 1, max: 200, int: true },
        candidatePages: {
          kind: 'number',
          label: '每个来源翻几页（1–5）',
          desc: '候选不够就往后翻；翻得越多一轮越慢',
          default: 3,
          min: 1,
          max: 5,
          int: true,
        },
        screenLimit: { kind: 'number', label: '送进去打分的条数', desc: '每条约 200 字摘要；太多会慢', default: 10, min: 1, max: 50, int: true },
        deepReadLimit: { kind: 'number', label: '真去读几条（深读）', desc: '深读才看字幕和评论，也最费 token', default: 3, min: 1, max: 10, int: true },
        searchDays: { kind: 'number', label: '只搜最近几天', default: 7, min: 1, max: 30, int: true, hidden: true },
        seenDedupeDays: {
          kind: 'number',
          label: '看过的几天内不再推（0–90）',
          desc: '同一条视频这么多天内不再进候选；0 = 不按看过去重（可能重复推同一批）',
          default: 7,
          min: 0,
          max: 90,
          int: true,
        },
        minDuration: { kind: 'number', label: '太短的不要（秒）', desc: '0 = 不限', default: 0, min: 0, max: 7200, int: true },
        maxDuration: { kind: 'number', label: '太长的不要（秒）', desc: '太长的片子深读和抽帧都慢', default: 7200, min: 0, max: 36000, int: true },
        sources: {
          kind: 'object',
          label: '从哪儿找',
          fields: {
            search: { kind: 'boolean', label: '关键词搜索', desc: '按「搜索词」找', default: true },
            hot: { kind: 'boolean', label: '热门', desc: '当前热门', default: true },
            ranking: { kind: 'boolean', label: '排行', desc: '排行榜', default: true },
            following: { kind: 'boolean', label: '关注的人更新了', desc: '你关注的人新发的（要登录）', default: true },
            favorites: { kind: 'boolean', label: '收藏夹', default: false, hidden: true },
          },
        },
        excludeUp: { kind: 'array', label: '这些 UP 不看（一行一个）', desc: '命中就直接不进候选', item: { kind: 'string', label: 'UP 名', default: '', maxLen: 40 }, default: [], maxItems: 100 },
        includeUp: { kind: 'array', label: '这些 UP 优先（一行一个）', desc: '同一批里优先看他们', item: { kind: 'string', label: 'UP 名', default: '', maxLen: 40 }, default: [], maxItems: 100 },
      },
    },

    media: {
      kind: 'object',
      label: '看画面',
      desc: '开一轮时顺便抽几帧让模型看画面；默认关（费流量，还要装 ffmpeg）',
      fields: {
        frames: {
          kind: 'boolean',
          label: '看画面（抽帧）',
          desc: '开 = 每轮下载一条低清视频，抽几帧拼成一张图给模型；关 = 只读标题/简介/字幕/评论',
          default: false,
        },
        ffmpegPath: {
          kind: 'string',
          label: 'ffmpeg 位置',
          desc: '留空 = 用系统 PATH 里的 ffmpeg；装了但没在 PATH 就填完整路径',
          default: '',
          maxLen: 260,
        },
        frameCount: {
          kind: 'number',
          label: '抽几帧',
          desc: '默认 9（拼成 3×3 九宫格）；多了更费 token',
          default: 9,
          min: 4,
          max: 12,
          int: true,
        },
        subtitleStrip: {
          kind: 'boolean',
          label: '没字幕时读画面里的字幕',
          desc: '裁画面下方约三分之一、每 7 秒一帧竖拼；只在视频本身没有字幕轨时做',
          default: true,
        },
      },
    },

    score: {
      kind: 'object',
      label: '打分',
      fields: {
        enabled: { kind: 'boolean', label: '给视频打分', desc: '关掉就按「想看的」命中 + 评论热度取第一名', default: true },
        minScore: { kind: 'number', label: '多少分算值得分享（0–20）', desc: '低于这个分数不会被挑中', default: 13, min: 0, max: 20, int: true },
        dimensions: {
          kind: 'array',
          label: '评分维度',
          desc: '留空则用内置五个维度',
          item: { kind: 'string', label: '维度', default: '', maxLen: 40 },
          default: [],
          maxItems: 10,
          hidden: true,
        },
      },
    },

    share: {
      kind: 'object',
      label: '对外发言（评论 / 私信）',
      fields: {
        enabled: { kind: 'boolean', label: '允许对外发言', desc: '默认关：用的是你的号，得你亲手打开', default: false },
        via: {
          kind: 'enum',
          label: '发在哪儿',
          values: ['comment', 'dm'] as const,
          valueLabels: { comment: '发评论（在她的评论区 @ 你）', dm: '发私信给你' } as const,
          desc: '两种都只用「鲸鲸」这个号发',
          default: 'comment',
        },
        minScore: { kind: 'number', label: '多少分才发（0–20）', desc: '低于它就只写报告，不对外发', default: 13, min: 0, max: 20, int: true },
        dailyCap: { kind: 'number', label: '一天最多发几条（0–10）', desc: '设到 3 以上会提醒一次', default: 3, min: 0, max: 10, int: true },
        perVideoDays: { kind: 'number', label: '同一个视频几天内不重复发（1–365）', desc: '防止同一条视频反复 @ 你', default: 7, min: 1, max: 365, int: true },
        silentAfterDays: { kind: 'number', label: '你几天没反应就少发（1–60）', desc: '开始收声：额度降到 1 条/天，并问一次「还在看吗」', default: 3, min: 1, max: 60, int: true },
        silentStopDays: { kind: 'number', label: '几天没反应就完全停发（1–120）', desc: '之后只写日记，不再对外发', default: 7, min: 1, max: 120, int: true },
        decayPerDay: { kind: 'number', label: '沉默期每天扣多少额度', default: 1, min: 0, max: 3, int: true, hidden: true },
        comment: {
          kind: 'object',
          label: '发评论时',
          fields: {
            maxChars: { kind: 'number', label: '最多几个字（20–500）', desc: '超过会被 B 站截断，不如自己写短点', default: 150, min: 20, max: 500, int: true },
            atOwner: { kind: 'boolean', label: '带上 @ 你', desc: '关掉就不 @ 你，你可能根本看不到这条', default: true },
            plain: {
              kind: 'boolean',
              label: '不 @ 的时候也发一条评论',
              desc: '像普通观众那样在评论区说一句（不 @ 任何人）；和「发评论 @ 你」是两件事，默认关',
              default: false,
            },
            plainDailyCap: { kind: 'number', label: '一天最多发几条这种评论（0–3）', desc: '单独计数，不占「@ 你」的额度', default: 1, min: 0, max: 3, int: true },
          },
        },
        dm: {
          kind: 'object',
          label: '发私信时',
          fields: {
            maxChars: { kind: 'number', label: '一条最多几个字（100–500）', desc: 'B 站私信上限就是 500', default: 500, min: 100, max: 500, int: true },
            merge: { kind: 'boolean', label: '一轮合并成一条', default: true, hidden: true },
          },
        },
      },
    },

    fav: {
      kind: 'object',
      label: '收藏',
      fields: {
        enabled: { kind: 'boolean', label: '允许收藏', desc: '账号内低风险动作，默认开', default: true },
        dailyCap: { kind: 'number', label: '一天最多收几条（0–20）', desc: '0 = 不收藏', default: 3, min: 0, max: 20, int: true },
        perVideoDays: { kind: 'number', label: '同一个视频几天内不重复收（1–365）', desc: '冷却期内不再收这条', default: 30, min: 1, max: 365, int: true },
        minReasonChars: { kind: 'number', label: '至少说出几个字的理由（1–100）', desc: '说不清为什么留就不收', default: 6, min: 1, max: 100, int: true },
      },
    },

    dynamic: {
      kind: 'object',
      label: '发动态',
      fields: {
        enabled: { kind: 'boolean', label: '允许发动态', desc: '一轮里永远不会自动发；只能在面板手动发，还要再确认一次', default: false },
        requireConfirm: { kind: 'boolean', label: '手动发时再确认一次', desc: '关掉会少一道确认（不建议）', default: true },
        dailyCap: { kind: 'number', label: '一天最多发几条（0–5）', desc: '0 = 不能发', default: 1, min: 0, max: 5, int: true },
      },
    },

    like: {
      kind: 'object',
      label: '点赞',
      fields: {
        enabled: { kind: 'boolean', label: '允许点赞', desc: '只点深读过、并且她说喜欢的', default: false },
        dailyCap: { kind: 'number', label: '一天最多点几个（0–50）', desc: '0 = 不点赞', default: 5, min: 0, max: 50, int: true },
      },
    },

    listen: {
      kind: 'object',
      label: '收消息与回复',
      fields: {
        comment: {
          kind: 'object',
          label: '评论和 @',
          fields: {
            enabled: { kind: 'boolean', label: '听评论和 @', desc: '默认关：打开后才会读消息中心', default: false },
            intervalSec: { kind: 'number', label: '多久看一次（秒，≥60）', desc: '太勤容易被 B 站限流', default: 300, min: 60, max: 3600, int: true },
            scope: {
              kind: 'enum',
              label: '听哪些',
              values: ['reply', 'at', 'both'] as const,
              valueLabels: { reply: '有人回我的评论', at: '有人 @ 我', both: '两者都听' } as const,
              desc: '只选一类时，另一类会被忽略',
              default: 'both',
            },
            allDay: { kind: 'boolean', label: '全天监听', desc: '关 = 只在作息窗口内听', default: false, hidden: true },
            oncePerPerson: { kind: 'boolean', label: '每人每轮只回一次', default: false, hidden: true },
          },
        },
        dm: {
          kind: 'object',
          label: '私信',
          fields: {
            enabled: { kind: 'boolean', label: '听私信', desc: '默认关：打开后才会读私信', default: false },
            chat: { kind: 'boolean', label: '允许聊天', desc: '聊天不调工具、不改设置', default: true },
            intervalSec: { kind: 'number', label: '多久看一次（秒，20–3600）', desc: '越勤越容易被限流', default: 30, min: 20, max: 3600, int: true },
            ownerOnly: { kind: 'boolean', label: '只认主人', default: true, hidden: true },
            maxHistory: { kind: 'number', label: '聊天时带多少条上下文（0–50）', desc: '给模型看的最近几条对话', default: 10, min: 0, max: 50, int: true },
            maxPerHour: { kind: 'number', label: '一小时最多回几条（1–60）', desc: '防止刷屏', default: 20, min: 1, max: 60, int: true },
            maxChars: { kind: 'number', label: '一条最多几个字（100–500）', desc: 'B 站私信上限 500', default: 500, min: 100, max: 500, int: true },
          },
        },
        reply: {
          kind: 'object',
          label: '怎么回',
          fields: {
            ownerDirect: { kind: 'boolean', label: '你回的，不用审批直接发', desc: '陌生人的回复仍然走审批', default: false },
            strangerApproval: { kind: 'boolean', label: '陌生人回的，要你点「发」才发', desc: '默认开：先给你看草稿', default: true },
            maxPerRound: { kind: 'number', label: '一轮最多回几条（0–5）', desc: '一轮里不会追着人回', default: 1, min: 0, max: 5, int: true },
            maxChars: { kind: 'number', label: '一条最多几个字（20–300）', desc: '太长像写作文，不像聊天', default: 100, min: 20, max: 300, int: true },
          },
        },
      },
    },

    diary: {
      kind: 'object',
      label: '日记',
      fields: {
        enabled: { kind: 'boolean', label: '写日记', desc: '日记不可关，这里只是标记位', default: true, hidden: true },
        push: { kind: 'boolean', label: '把当天的摘要推给我', desc: '只影响推送，日记照写', default: true },
        publicTitle: { kind: 'string', label: '给我看的那本叫什么', desc: '只影响文件标题', default: '给你看的', maxLen: 40 },
        privateTitle: { kind: 'string', label: '她自己那本叫什么', desc: '只影响文件标题', default: '给自己看的', maxLen: 40 },
      },
    },

    report: {
      kind: 'object',
      label: '日报',
      fields: {
        level: {
          kind: 'enum',
          label: '写多详细',
          values: ['full', 'brief', 'off'] as const,
          valueLabels: { full: '完整', brief: '只写要点', off: '不写' } as const,
          desc: '不写也照写日记',
          default: 'full',
        },
        dir: { kind: 'string', label: '目录', desc: '相对数据目录', default: 'reports', maxLen: 200, hidden: true },
        archive: { kind: 'boolean', label: '每月归档一份', desc: '按月汇总每条看过的视频，方便回头翻', default: true },
      },
    },

    notify: {
      kind: 'object',
      label: '通知',
      fields: {
        channels: {
          kind: 'array',
          label: '通知渠道',
          desc: '跑完一轮把结果发到哪里；可以同时开多个，全都没成时会兜底写一份到 logs/notify.log',
          maxItems: 8,
          default: [
            { type: 'file', enabled: true, path: '', url: '', format: 'generic', template: 'text', cmd: '', args: '', sendSummary: true, sendDiary: false, sendVideoInfo: false },
          ],
          item: {
            kind: 'object',
            label: '渠道',
            fields: {
              type: {
                kind: 'enum',
                label: '哪种渠道',
                values: ['file', 'webhook', 'command', 'dm'] as const,
                valueLabels: { file: '本机日志', dm: 'B 站私信', webhook: '自定义 Webhook', command: '本地命令' } as const,
                desc: '面板主界面只露「B 站私信」和「本机日志」两个；另外两个在「高级」里',
                default: 'file',
              },
              enabled: { kind: 'boolean', label: '打开这个渠道', default: false },
              path: {
                kind: 'string',
                label: '写到哪个文件',
                desc: '留空 = 默认的 logs/notify.log；填了就写到那个文件',
                default: '',
                maxLen: 260,
              },
              url: {
                kind: 'string',
                label: 'Webhook 地址',
                desc: '机器人给你的那条完整链接，直接粘进来',
                default: '',
                maxLen: 500,
              },
              format: {
                kind: 'enum',
                label: '对方是哪家服务',
                values: ['generic', 'feishu', 'dingtalk', 'wecom', 'telegram'] as const,
                valueLabels: {
                  generic: '通用（只认一个 text 字段）',
                  feishu: '飞书群机器人',
                  dingtalk: '钉钉群机器人',
                  wecom: '企业微信群机器人',
                  telegram: 'Telegram 机器人',
                } as const,
                desc: '不同服务的报文格式不一样；不确定就选「通用」',
                default: 'generic',
              },
              template: {
                kind: 'enum',
                label: '消息格式',
                values: ['text', 'markdown'] as const,
                valueLabels: { text: '纯文本（最稳）', markdown: '富文本（对方要支持）' } as const,
                default: 'text',
              },
              cmd: {
                kind: 'string',
                label: '要执行的命令',
                desc: '程序名或完整路径；不走 shell，消息内容放在环境变量 BILIWHALE_NOTIFY_TEXT 里',
                default: '',
                maxLen: 260,
              },
              args: {
                kind: 'string',
                label: '命令参数',
                desc: '空格分隔；消息内容不放在这里（见上一条）',
                default: '',
                maxLen: 500,
              },
              sendSummary: { kind: 'boolean', label: '发本轮摘要', desc: '一轮跑完的一句话总结', default: true },
              sendDiary: { kind: 'boolean', label: '发今天的公开日记', desc: '私信里再发一份公开日记', default: false },
              sendVideoInfo: { kind: 'boolean', label: '发视频信息块', desc: '标题、链接和一句话理解', default: false },
            },
          },
        },
        quietHours: {
          kind: 'object',
          label: '静默时段',
          desc: '这段时间只写本机日志，不发私信/地址/命令（可以跨零点，例如 23:00–08:00）',
          fields: {
            enabled: { kind: 'boolean', label: '只在日志里记', desc: '这段时间不发私信/地址/命令', default: false },
            start: { kind: 'string', label: '从几点开始', desc: '24 小时制；可以跨零点（23:00 到 08:00）', default: '23:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
            end: { kind: 'string', label: '到几点结束', desc: '24 小时制', default: '08:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
          },
        },
      },
    },

    safety: {
      kind: 'object',
      label: '安全开关',
      fields: {
        writeEnabled: { kind: 'boolean', label: '允许真实写操作', desc: '关掉 = 整程序只读（报告和日记照写）', default: true },
        dryRun: { kind: 'boolean', label: '只演练，不真发', desc: '开 = 所有写操作只打印（内部字段 safety.dryRun）', default: false },
        requireConfirm: { kind: 'boolean', label: '写操作都要确认', default: false, hidden: true },
        riskCooldownMin: { kind: 'number', label: '撞风控后停多久（分钟）', desc: '这段时间里什么都不写', default: 45, min: 5, max: 1440, int: true },
        maxWritesPerDay: { kind: 'number', label: '一天最多写几次（0–200）', desc: '评论/私信/收藏/点赞/动态加起来', default: 10, min: 0, max: 200, int: true },
        killSwitch: { kind: 'boolean', label: '急停', desc: '开 = 立刻停掉一切写操作，不用重启', default: false },
      },
    },

    ui: {
      kind: 'object',
      label: '面板',
      fields: {
        port: { kind: 'number', label: '端口（1024–65535）', desc: '被占用会自动往后找', default: 8787, min: 1024, max: 65535, int: true },
        openBrowserOnStart: { kind: 'boolean', label: '启动时打开浏览器', default: true, hidden: true },
        theme: {
          kind: 'enum',
          label: '配色',
          values: ['auto', 'light', 'dark'] as const,
          valueLabels: { auto: '跟着系统', light: '浅色', dark: '深色' } as const,
          desc: '跟着系统最省心；也可以固定深色或浅色',
          default: 'auto',
        },
      },
    },

    logging: {
      kind: 'object',
      label: '日志与清理',
      fields: {
        level: {
          kind: 'enum',
          label: '记多细',
          values: ['debug', 'info', 'warn', 'error'] as const,
          valueLabels: { debug: '调试（很啰嗦）', info: '一般', warn: '警告与错误', error: '只记错误' } as const,
          desc: '平时用「一般」就够',
          default: 'info',
        },
        retentionDays: { kind: 'number', label: '日志留几天（1–3650）', desc: '超过就删', default: 30, min: 1, max: 3650, int: true },
        eventsRetentionDays: { kind: 'number', label: '事件留几天（1–3650）', desc: '面板「日志」页看到的就是它', default: 30, min: 1, max: 3650, int: true },
        runsRetentionDays: { kind: 'number', label: '每轮记录留几天（1–3650）', desc: '每轮的技术记录，排障才看', default: 90, min: 1, max: 3650, int: true },
        docsRetentionDays: { kind: 'number', label: '报告和日记留几天', desc: '0 = 永久保留', default: 365, min: 0, max: 36500, int: true },
        redact: { kind: 'boolean', label: '日志脱敏', desc: '永远建议开着', default: true, hidden: true },
      },
    },
  },
} as const satisfies ObjectSpec;
