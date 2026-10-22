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

/* ---------- 规格本体 ---------- */

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$|^24:00$/;

export const SPEC = {
  kind: 'object',
  label: '配置',
  fields: {
    version: { kind: 'number', label: '配置版本', default: 1, min: 1, max: 999, int: true },

    app: {
      kind: 'object',
      label: '程序行为',
      fields: {
        dataDir: { kind: 'string', label: '数据目录', desc: '留空 = %APPDATA%\\BiliWhale', default: '', maxLen: 260 },
        locale: { kind: 'enum', label: '界面语言', values: ['zh-CN'] as const, default: 'zh-CN' },
        logLevel: {
          kind: 'enum',
          label: '日志级别',
          values: ['debug', 'info', 'warn', 'error'] as const,
          default: 'info',
        },
        autostart: { kind: 'boolean', label: '开机自启', desc: '写 HKCU Run 键，不需要管理员', default: true },
        tray: { kind: 'boolean', label: '显示托盘图标', desc: '关掉后只能用命令行/浏览器书签', default: true },
        singleInstance: { kind: 'boolean', label: '单实例', default: true },
        proxy: {
          kind: 'string',
          label: '代理',
          desc: '留空 = 跟随系统代理；填 direct = 强制直连；也可填 http://host:port',
          default: '',
          maxLen: 200,
        },
      },
    },

    llm: {
      kind: 'object',
      label: 'DeepSeek',
      fields: {
        baseUrl: { kind: 'string', label: 'API 地址', default: 'https://api.deepseek.com', maxLen: 200 },
        model: { kind: 'string', label: '模型', desc: '自动发现开启时，这个值只是首选', default: 'deepseek-flash', maxLen: 80 },
        modelAuto: {
          kind: 'boolean',
          label: '自动发现模型',
          desc: '启动/换 key 时用 /models 找可用模型，失败则回退上面的值',
          default: true,
        },
        temperature: { kind: 'number', label: '温度', default: 0.7, min: 0, max: 2 },
        maxTokens: { kind: 'number', label: '单次最大输出 token', default: 4096, min: 256, max: 32768, int: true },
        timeoutMs: { kind: 'number', label: '请求超时（毫秒）', default: 120000, min: 5000, max: 600000, int: true },
        maxRetries: { kind: 'number', label: '重试次数', default: 3, min: 0, max: 5, int: true },
        maxSteps: { kind: 'number', label: '单轮最大步数', default: 20, min: 1, max: 30, int: true },
        maxToolCalls: { kind: 'number', label: '单轮最大工具调用', default: 20, min: 1, max: 60, int: true },
        runBudgetTokens: { kind: 'number', label: '单轮 token 预算', default: 60000, min: 1000, max: 1000000, int: true },
        dailyBudgetTokens: { kind: 'number', label: '每日 token 预算', default: 300000, min: 1000, max: 10000000, int: true },
        dailyBudgetCny: { kind: 'number', label: '每日金额预算（元）', default: 5, min: 0, max: 10000 },
        pricePerMTokens: {
          kind: 'number',
          label: '单价（元/百万 token）',
          desc: '填 0 = 只记 token 不算钱',
          default: 0,
          min: 0,
          max: 1000,
        },
      },
    },

    account: {
      kind: 'object',
      label: '账号',
      fields: {
        mid: { kind: 'number', label: 'UID', desc: '登录后自动回填', default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, int: true },
        name: { kind: 'string', label: '昵称', default: '', maxLen: 80 },
        cookieRef: { kind: 'string', label: '凭据引用', desc: '内部字段，指向 secrets.json', default: 'bili', maxLen: 40 },
      },
    },

    persona: {
      kind: 'object',
      label: '人设',
      fields: {
        name: { kind: 'string', label: '她的名字', desc: '留空则用中性默认', default: '', maxLen: 40 },
        ownerTitle: { kind: 'string', label: '怎么称呼你', default: '你', maxLen: 20 },
        selfClaim: { kind: 'string', label: '怎么自称', default: '我', maxLen: 20 },
        file: { kind: 'string', label: '人设文件', default: 'prompts/persona.md', maxLen: 200 },
      },
    },

    preferences: {
      kind: 'object',
      label: '偏好',
      fields: {
        like: {
          kind: 'array',
          label: '喜欢的方向',
          item: { kind: 'string', label: '方向', default: '', maxLen: 40 },
          default: ['AI 工具与插件', '猫咪', '鬼畜与怀旧向剪辑', '动画/模型'],
          maxItems: 30,
        },
        dislike: {
          kind: 'array',
          label: '不喜欢的',
          item: { kind: 'string', label: '方向', default: '', maxLen: 40 },
          default: ['带货', '擦边', '标题党', '纯搬运'],
          maxItems: 30,
        },
        keywords: { kind: 'array', label: '搜索关键词', desc: '留空则用喜欢的方向当关键词', item: { kind: 'string', label: '关键词', default: '', maxLen: 40 }, default: [], maxItems: 30 },
      },
    },

    schedule: {
      kind: 'object',
      label: '作息',
      fields: {
        windows: {
          kind: 'array',
          label: '醒来的时间窗口',
          desc: '唤醒时刻全部由你配置，没有峰谷概念',
          maxItems: 6,
          default: [{ start: '20:00', end: '24:00', wakes: 1, label: '晚上' }],
          item: {
            kind: 'object',
            label: '窗口',
            fields: {
              start: { kind: 'string', label: '开始', default: '20:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
              end: { kind: 'string', label: '结束', default: '24:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
              wakes: { kind: 'number', label: '醒来次数', default: 1, min: 1, max: 3, int: true },
              label: { kind: 'string', label: '窗口名', default: '', maxLen: 20 },
            },
          },
        },
        skipChance: {
          kind: 'number',
          label: '今天不想看的概率',
          desc: '0 = 每天都会看；0.2 = 五分之一的日子只想写日记',
          default: 0.2,
          min: 0,
          max: 0.95,
        },
        maxWakesPerDay: { kind: 'number', label: '每天最多醒几次', desc: '硬上限 3，代码强制', default: 1, min: 0, max: 3, int: true },
        graceMinutes: { kind: 'number', label: '错过后的补跑宽限（分钟）', default: 90, min: 0, max: 1440, int: true },
      },
    },

    content: {
      kind: 'object',
      label: '选题',
      fields: {
        maxVideos: { kind: 'number', label: '一轮最多挑中几条', default: 5, min: 1, max: 20, int: true },
        candidateLimit: { kind: 'number', label: '候选上限', desc: '多源合并后截断到这里', default: 30, min: 1, max: 200, int: true },
        screenLimit: { kind: 'number', label: '送初筛条数', default: 10, min: 1, max: 50, int: true },
        deepReadLimit: { kind: 'number', label: '深读条数', default: 3, min: 1, max: 10, int: true },
        searchDays: { kind: 'number', label: '只搜最近几天', default: 7, min: 1, max: 30, int: true },
        seenDedupeDays: {
          kind: 'number',
          label: '判重冷藏天数',
          desc: '同一条视频这么多天内不再进候选；0 = 不按看过去重（每轮可能重复推荐同一批）',
          default: 7,
          min: 0,
          max: 90,
          int: true,
        },
        minDuration: { kind: 'number', label: '最短时长（秒）', default: 0, min: 0, max: 7200, int: true },
        maxDuration: { kind: 'number', label: '最长时长（秒）', default: 7200, min: 0, max: 36000, int: true },
        sources: {
          kind: 'object',
          label: '选题来源',
          fields: {
            search: { kind: 'boolean', label: '关键词搜索', default: true },
            hot: { kind: 'boolean', label: '热门', default: true },
            ranking: { kind: 'boolean', label: '排行', default: true },
            following: { kind: 'boolean', label: '关注动态', default: true },
            favorites: { kind: 'boolean', label: '收藏夹', default: false },
          },
        },
        excludeUp: { kind: 'array', label: '屏蔽的 UP', item: { kind: 'string', label: 'UP', default: '', maxLen: 40 }, default: [], maxItems: 100 },
        includeUp: { kind: 'array', label: '优先的 UP', item: { kind: 'string', label: 'UP', default: '', maxLen: 40 }, default: [], maxItems: 100 },
      },
    },

    score: {
      kind: 'object',
      label: '判分',
      fields: {
        enabled: { kind: 'boolean', label: '启用判分', desc: '关掉就按偏好命中 + 评论热度排序取第一名', default: true },
        minScore: { kind: 'number', label: '分享阈值', default: 13, min: 0, max: 20, int: true },
        dimensions: {
          kind: 'array',
          label: '评分维度',
          desc: '留空则用内置五个维度',
          item: { kind: 'string', label: '维度', default: '', maxLen: 40 },
          default: [],
          maxItems: 10,
        },
      },
    },

    share: {
      kind: 'object',
      label: '分享',
      fields: {
        enabled: { kind: 'boolean', label: '允许对外分享', desc: '默认关：拿你的号说话，得你亲手打开', default: false },
        via: { kind: 'enum', label: '分享渠道', values: ['comment', 'dm'] as const, default: 'comment' },
        minScore: { kind: 'number', label: '分享分数门槛', default: 13, min: 0, max: 20, int: true },
        dailyCap: { kind: 'number', label: '每日分享上限', desc: '超过 3 会警告（自己定的上限自己负责）', default: 3, min: 0, max: 10, int: true },
        perVideoDays: { kind: 'number', label: '同一视频冷却（天）', default: 7, min: 1, max: 365, int: true },
        silentAfterDays: { kind: 'number', label: '几天没回应开始收声', default: 3, min: 1, max: 60, int: true },
        silentStopDays: { kind: 'number', label: '几天没回应完全停发', default: 7, min: 1, max: 120, int: true },
        decayPerDay: { kind: 'number', label: '沉默期每天扣多少额度', default: 1, min: 0, max: 3, int: true },
        comment: {
          kind: 'object',
          label: '评论 @',
          fields: {
            maxChars: { kind: 'number', label: '字数上限', default: 150, min: 20, max: 500, int: true },
            atOwner: { kind: 'boolean', label: '带上 @', default: true },
          },
        },
        dm: {
          kind: 'object',
          label: '私信分享',
          fields: {
            maxChars: { kind: 'number', label: '单条字数上限', desc: '实测私信上限 500', default: 500, min: 100, max: 500, int: true },
            merge: { kind: 'boolean', label: '一轮合并成一条', default: true },
          },
        },
      },
    },

    fav: {
      kind: 'object',
      label: '收藏',
      fields: {
        enabled: { kind: 'boolean', label: '允许收藏', desc: '账号内低风险动作，默认开', default: true },
        dailyCap: { kind: 'number', label: '每日上限', default: 3, min: 0, max: 20, int: true },
        perVideoDays: { kind: 'number', label: '同一视频冷却（天）', default: 30, min: 1, max: 365, int: true },
        minReasonChars: { kind: 'number', label: '理由最少字数', default: 6, min: 1, max: 100, int: true },
      },
    },

    dynamic: {
      kind: 'object',
      label: '动态',
      fields: {
        enabled: { kind: 'boolean', label: '允许发动态', default: false },
        requireConfirm: { kind: 'boolean', label: '发送前必须确认', default: true },
        dailyCap: { kind: 'number', label: '每日上限', default: 1, min: 0, max: 5, int: true },
      },
    },

    like: {
      kind: 'object',
      label: '点赞',
      fields: {
        enabled: { kind: 'boolean', label: '允许点赞', default: false },
        dailyCap: { kind: 'number', label: '每日上限', default: 5, min: 0, max: 50, int: true },
      },
    },

    listen: {
      kind: 'object',
      label: '监听与回复',
      fields: {
        comment: {
          kind: 'object',
          label: '评论 / @',
          fields: {
            enabled: { kind: 'boolean', label: '开启监听', default: false },
            intervalSec: { kind: 'number', label: '轮询间隔（秒）', desc: '最小 60', default: 300, min: 60, max: 3600, int: true },
            scope: { kind: 'enum', label: '范围', values: ['reply', 'at', 'both'] as const, default: 'both' },
            allDay: { kind: 'boolean', label: '全天监听', desc: '关 = 只在作息窗口内听', default: false },
            oncePerPerson: { kind: 'boolean', label: '每人每轮只回一次', default: false },
          },
        },
        dm: {
          kind: 'object',
          label: '私信',
          fields: {
            enabled: { kind: 'boolean', label: '开启私信监听', default: false },
            chat: { kind: 'boolean', label: '允许双向聊天', desc: '聊天不调用工具、不改配置', default: true },
            intervalSec: { kind: 'number', label: '轮询间隔（秒）', default: 30, min: 20, max: 3600, int: true },
            ownerOnly: { kind: 'boolean', label: '只认主人', default: true },
            maxHistory: { kind: 'number', label: '聊天上下文条数', default: 10, min: 0, max: 50, int: true },
            maxPerHour: { kind: 'number', label: '每小时最多回几条', default: 20, min: 1, max: 60, int: true },
            maxChars: { kind: 'number', label: '单条字数上限', default: 500, min: 100, max: 500, int: true },
          },
        },
        reply: {
          kind: 'object',
          label: '回复',
          fields: {
            ownerDirect: { kind: 'boolean', label: '主人的回复直接发', desc: '关 = 主人也要走审批', default: false },
            strangerApproval: { kind: 'boolean', label: '陌生人的回复要审批', default: true },
            maxPerRound: { kind: 'number', label: '一轮最多回几条', default: 1, min: 0, max: 5, int: true },
            maxChars: { kind: 'number', label: '回复字数上限', default: 100, min: 20, max: 300, int: true },
          },
        },
      },
    },

    diary: {
      kind: 'object',
      label: '日记',
      fields: {
        enabled: { kind: 'boolean', label: '写日记', desc: '日记不可关，这里只是标记位', default: true },
        push: { kind: 'boolean', label: '推送摘要', desc: '关掉只影响推送，日记照写', default: true },
        publicTitle: { kind: 'string', label: '公开那本的名字', default: '给你看的', maxLen: 40 },
        privateTitle: { kind: 'string', label: '私人那本的名字', default: '给自己看的', maxLen: 40 },
      },
    },

    report: {
      kind: 'object',
      label: '日报',
      fields: {
        level: { kind: 'enum', label: '详细程度', values: ['full', 'brief', 'off'] as const, default: 'full' },
        dir: { kind: 'string', label: '目录', desc: '相对数据目录', default: 'reports', maxLen: 200 },
        archive: { kind: 'boolean', label: '写月度归档', default: true },
      },
    },

    notify: {
      kind: 'object',
      label: '通知',
      fields: {
        channels: {
          kind: 'array',
          label: '通知渠道',
          desc: '可同时开多个；全部失败时仍会兜底写一份到 logs/notify.log',
          maxItems: 8,
          default: [
            { type: 'desktop', enabled: true, path: '', url: '', format: 'generic', template: 'text', cmd: '', args: '', sendSummary: true, sendDiary: true, sendVideoInfo: true },
            { type: 'file', enabled: true, path: '', url: '', format: 'generic', template: 'text', cmd: '', args: '', sendSummary: true, sendDiary: false, sendVideoInfo: false },
          ],
          item: {
            kind: 'object',
            label: '渠道',
            fields: {
              type: {
                kind: 'enum',
                label: '类型',
                values: ['desktop', 'file', 'webhook', 'command', 'dm'] as const,
                default: 'file',
              },
              enabled: { kind: 'boolean', label: '启用', default: false },
              path: { kind: 'string', label: '文件路径（file）', default: '', maxLen: 260 },
              url: { kind: 'string', label: 'Webhook 地址', default: '', maxLen: 500 },
              format: {
                kind: 'enum',
                label: 'Webhook 格式',
                values: ['generic', 'feishu', 'dingtalk', 'wecom', 'telegram'] as const,
                default: 'generic',
              },
              template: { kind: 'enum', label: '消息格式', values: ['text', 'markdown'] as const, default: 'text' },
              cmd: { kind: 'string', label: '命令（command）', desc: '不走 shell；消息作为最后一个参数', default: '', maxLen: 260 },
              args: { kind: 'string', label: '参数', desc: '空格分隔，写在消息前面', default: '', maxLen: 500 },
              sendSummary: { kind: 'boolean', label: '发本轮摘要（dm）', default: true },
              sendDiary: { kind: 'boolean', label: '发公开日记（dm）', default: false },
              sendVideoInfo: { kind: 'boolean', label: '发视频信息块（dm）', default: false },
            },
          },
        },
        quietHours: {
          kind: 'array',
          label: '静默时段',
          desc: '静默时只写文件，不弹窗',
          maxItems: 4,
          default: [],
          item: {
            kind: 'object',
            label: '时段',
            fields: {
              start: { kind: 'string', label: '开始', default: '23:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
              end: { kind: 'string', label: '结束', default: '08:00', pattern: HHMM, patternMessage: '格式 HH:mm' },
            },
          },
        },
      },
    },

    media: {
      kind: 'object',
      label: '抽帧',
      fields: {
        frames: { kind: 'boolean', label: '允许抽帧看画面', desc: '找不到 ffmpeg 会自动跳过', default: true },
        ffmpegPath: { kind: 'string', label: 'ffmpeg 路径', desc: '留空 = 从 PATH 找', default: '', maxLen: 260 },
        frameCount: { kind: 'number', label: '抽几帧', default: 6, min: 0, max: 12, int: true },
      },
    },

    safety: {
      kind: 'object',
      label: '安全',
      fields: {
        writeEnabled: { kind: 'boolean', label: '总写开关', desc: '关掉后整程序只读', default: true },
        dryRun: { kind: 'boolean', label: '一律预演', desc: '开 = 所有写操作只打印不执行', default: false },
        requireConfirm: { kind: 'boolean', label: '写操作都要确认', default: false },
        riskCooldownMin: { kind: 'number', label: '撞风控后冷却（分钟）', default: 45, min: 5, max: 1440, int: true },
        maxWritesPerDay: { kind: 'number', label: '每日写操作总上限', default: 10, min: 0, max: 200, int: true },
        killSwitch: { kind: 'boolean', label: '急停', desc: '开 = 立即停止一切写操作', default: false },
      },
    },

    ui: {
      kind: 'object',
      label: '面板',
      fields: {
        port: { kind: 'number', label: '端口', default: 8787, min: 1024, max: 65535, int: true },
        openBrowserOnStart: { kind: 'boolean', label: '启动时打开浏览器', default: true },
        theme: { kind: 'enum', label: '主题', values: ['auto', 'light', 'dark'] as const, default: 'auto' },
      },
    },

    logging: {
      kind: 'object',
      label: '日志与保留期',
      fields: {
        level: { kind: 'enum', label: '级别', values: ['debug', 'info', 'warn', 'error'] as const, default: 'info' },
        retentionDays: { kind: 'number', label: '日志保留（天）', default: 30, min: 1, max: 3650, int: true },
        eventsRetentionDays: { kind: 'number', label: '事件保留（天）', default: 30, min: 1, max: 3650, int: true },
        runsRetentionDays: { kind: 'number', label: '运行记录保留（天）', default: 90, min: 1, max: 3650, int: true },
        docsRetentionDays: { kind: 'number', label: '报告/日记保留（天）', desc: '0 = 永久保留', default: 365, min: 0, max: 36500, int: true },
        redact: { kind: 'boolean', label: '日志脱敏', desc: '永远建议开着', default: true },
      },
    },
  },
} as const satisfies ObjectSpec;
