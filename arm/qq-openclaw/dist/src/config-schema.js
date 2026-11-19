const stringArray = { type: "array", items: { type: "string" } };
const numberOrString = { anyOf: [{ type: "number" }, { type: "string" }] };
const reconnectSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "启用自动重连" },
        retries: { type: "number", description: "重试次数上限；留空表示无限重试" },
        minDelayMs: { type: "number", default: 1000, description: "重连最小延迟（毫秒）" },
        maxDelayMs: { type: "number", default: 30000, description: "重连最大延迟（毫秒）" },
    },
};
const mentionSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "启用 提及/关键词 触发" },
        requireMentionInGroup: { type: "boolean", default: true, description: "群聊中需要 @机器人 才触发" },
        keywords: { ...stringArray, description: "无需 @ 也能触发的关键词列表" },
        keywordMatch: {
            type: "string",
            enum: ["contains", "prefix", "exact", "regex"],
            default: "contains",
            description: "关键词匹配方式",
        },
        caseSensitive: { type: "boolean", default: false, description: "关键词匹配是否区分大小写" },
        triggerOnReplyToSelf: { type: "boolean", default: true, description: "回复机器人自己的消息也触发" },
        alwaysReplyInDirect: { type: "boolean", default: true, description: "私聊无条件触发（无论是否命中关键词）" },
    },
};
const digestSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: false, description: "启用摘要模式" },
        intervalMs: { type: "number", default: 300000, description: "距窗口打开达到该时长（毫秒）后刷新" },
        maxMessages: { type: "number", default: 50, description: "窗口累积消息数达到该值后刷新" },
        minMessages: { type: "number", default: 3, description: "窗口消息数达到该值前不会刷新" },
        prompt: { type: "string", description: "下发摘要时附加的提示词" },
        scope: {
            type: "string",
            enum: ["group", "direct", "all"],
            default: "group",
            description: "监听的会话范围",
        },
        peers: { ...stringArray, description: '仅监听这些会话（如 "group:123"），留空表示范围内全部监听' },
        maxTranscriptChars: { type: "number", default: 20000, description: "下发给 agent 的转录文本字符上限" },
    },
};
const summarySchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "启用 /summary 主动总结命令" },
        commands: { ...stringArray, description: '触发命令词，默认 ["/summary", "/总结"]；留空则使用默认值' },
        count: { type: "number", default: 100, description: "命令未带数字时总结最近多少条消息" },
        maxCount: { type: "number", default: 200, description: "用户通过 /summary <n> 可请求的条数上限" },
        prompt: { type: "string", description: "下发总结时附加的提示词" },
        scope: {
            type: "string",
            enum: ["group", "direct", "all"],
            default: "all",
            description: "允许使用该命令的会话范围",
        },
        peers: { ...stringArray, description: '仅这些会话可用（如 "group:123"），留空表示范围内全部可用' },
        maxTranscriptChars: { type: "number", default: 20000, description: "下发给 agent 的转录文本字符上限" },
    },
};
const realtimeSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "启用突发消息实时合并" },
        windowMs: { type: "number", default: 800, description: "静默多久（毫秒）后刷新，需小于 1000 才算「实时」" },
        maxWindowMs: { type: "number", default: 3000, description: "一次合并窗口最长可持续多久（毫秒）" },
        maxMessages: { type: "number", default: 10, description: "窗口消息数达到该值立即刷新" },
        maxChars: { type: "number", default: 8000, description: "窗口文本字符数达到该值立即刷新" },
    },
};
const historySchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "累积每个会话的近期消息，触发回复时作为历史聊天上下文一并带入（与摘要队列分开存储）" },
        maxMessages: { type: "number", default: 20, description: "每个会话保留的历史消息条数上限" },
        maxChars: { type: "number", default: 4000, description: "每个会话保留/带入的历史文本字符上限" },
        maxAgeMs: { type: "number", default: 0, description: "带入时丢弃早于该时长（毫秒）的历史消息；0 表示不按时间丢弃" },
    },
};
const receiveSchema = {
    type: "object",
    properties: {
        mention: mentionSchema,
        digest: digestSchema,
        summary: summarySchema,
        realtime: realtimeSchema,
        history: historySchema,
    },
};
const quoteSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "主动解析引用消息" },
        resolveForward: { type: "boolean", default: true, description: "展开合并转发消息" },
        maxDepth: { type: "number", default: 2, description: "合并转发的最大展开深度" },
        maxNodes: { type: "number", default: 20, description: "单次展开的转发节点数上限" },
        maxChars: { type: "number", default: 4000, description: "注入正文的引用文本字符上限" },
        timeoutMs: { type: "number", default: 10000, description: "单次解析请求的超时时间（毫秒）" },
    },
};
const imageSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "下载 QQ 图片并作为附件交给模型识别" },
        maxPerMessage: { type: "number", default: 4, description: "单轮对话最多附带的图片数量" },
        maxBytes: {
            type: "number",
            default: 8388608,
            description: "单张图片的下载大小上限（字节）；留空则依次回落到 mediaMaxMb、agents.defaults.mediaMaxMb、8 MiB",
        },
        maxDimensionPx: { type: "number", default: 1600, description: "超过该长边则压缩；0 表示不压缩" },
        timeoutMs: { type: "number", default: 20000, description: "单张图片的下载超时时间（毫秒）" },
        totalTimeoutMs: {
            type: "number",
            default: 30000,
            description: "整条消息全部图片的下载总预算（毫秒），硬上限；不小于 timeoutMs",
        },
        allowPrivateNetwork: {
            type: "boolean",
            default: false,
            description: "允许从内网地址下载图片；SnowLuma 自身的地址无需开启此项即被信任",
        },
        tool: { type: "boolean", default: true, description: "注册 snowluma_view_image 工具" },
        allowedHosts: {
            ...stringArray,
            description: 'snowluma_view_image 允许下载的域名后缀；["*"] 表示不限制',
        },
    },
};
const toolsSchema = {
    type: "object",
    properties: {
        enabled: { type: "boolean", default: true, description: "注册本插件的 agent 工具（聊天记录 / 群成员 / 查看图片）" },
    },
};
/** Fields shared by the default account (top level) and every named `accounts.<id>` entry. */
function accountFieldProperties() {
    return {
        enabled: { type: "boolean", default: true, description: "启用该账号" },
        name: { type: "string", description: "账号显示名称" },
        wsUrl: { type: "string", description: "SnowLuma OneBot WebSocket 地址，例如 ws://127.0.0.1:3001/" },
        httpUrl: { type: "string", description: "可选的 HTTP API 地址；配置后动作走 HTTP 而非 WebSocket" },
        accessToken: { type: "string", description: "SnowLuma access token" },
        selfId: { ...numberOrString, description: "机器人自己的 QQ 号；留空则通过 get_login_info 自动获取" },
        allowFrom: { ...stringArray, description: '允许的会话，如 ["private:123","group:456","*"]' },
        denyFrom: { ...stringArray, description: "拒绝的会话；在 allowFrom 之后生效" },
        groupAutoReact: { type: "boolean", default: false, description: "对触发 agent 的群消息自动回应表情" },
        groupAutoReactEmojiId: { ...numberOrString, default: 1, description: "groupAutoReact 使用的 QQ 表情 id" },
        replyToTrigger: { type: "boolean", default: true, description: "以引用回复的形式发送回复" },
        textChunkLimit: { type: "number", default: 4500, description: "出站文本按该字符数分段发送" },
        requestTimeoutMs: { type: "number", default: 30000, description: "SnowLuma 动作请求超时时间（毫秒）" },
        debug: { type: "boolean", default: false, description: "调试模式：在日志中打印每条出站消息的原始内容" },
        mediaMaxMb: {
            type: "number",
            description: "媒体大小上限（MiB），与其他 OpenClaw 通道通用；image.maxBytes 优先级更高",
        },
        dangerouslyAllowPrivateNetwork: {
            type: "boolean",
            default: false,
            description: "允许访问内网地址（通道通用开关，图片下载同样遵守）",
        },
        allowPrivateNetwork: {
            type: "boolean",
            default: false,
            description: "dangerouslyAllowPrivateNetwork 的等价写法",
        },
        reconnect: reconnectSchema,
        receive: receiveSchema,
        quote: quoteSchema,
        image: imageSchema,
        tools: toolsSchema,
    };
}
const namedAccountSchema = {
    type: "object",
    properties: accountFieldProperties(),
};
const channelConfigJsonSchema = {
    type: "object",
    properties: {
        ...accountFieldProperties(),
        accounts: {
            type: "object",
            properties: {},
            additionalProperties: namedAccountSchema,
            description: "具名多账号：键为账号 id，值为该账号的独立配置（结构同默认账号）",
        },
    },
};
const uiHints = {
    accessToken: { sensitive: true },
};
export const snowLumaConfigSchema = {
    schema: channelConfigJsonSchema,
    uiHints,
};
//# sourceMappingURL=config-schema.js.map