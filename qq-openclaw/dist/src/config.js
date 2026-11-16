import { getDefaultAccessToken, getDefaultHttpUrl, getDefaultSelfId, getDefaultWsUrl, } from "./env.js";
import { DEFAULT_IMAGE_HOSTS } from "./image.js";
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_DIGEST_PROMPT = "以下是这段时间的群聊记录。请用简洁的中文归纳讨论的主题、结论和待办事项；" +
    "如果没有值得汇报的内容，只回复 SKIP。";
/**
 * Unlike {@link DEFAULT_DIGEST_PROMPT} this one must never offer a SKIP escape
 * hatch: a summary is something a user explicitly asked for, so an empty reply
 * would read as the bot ignoring the command.
 */
export const DEFAULT_SUMMARY_PROMPT = "以下是这个会话最近的聊天记录。请用简洁的中文总结其中讨论的主题、结论和待办事项，" +
    "必要时按话题分点列出。这是用户主动请求的总结，请直接给出总结内容，不要回复 SKIP。";
export const DEFAULT_SUMMARY_COMMANDS = ["/summary", "/总结"];
export const RECEIVE_DEFAULTS = {
    mention: {
        enabled: true,
        requireMentionInGroup: true,
        keywords: [],
        keywordMatch: "contains",
        caseSensitive: false,
        triggerOnReplyToSelf: true,
        alwaysReplyInDirect: true,
    },
    digest: {
        enabled: false,
        intervalMs: 300_000,
        maxMessages: 50,
        minMessages: 3,
        prompt: DEFAULT_DIGEST_PROMPT,
        scope: "group",
        peers: [],
        maxTranscriptChars: 20_000,
    },
    summary: {
        enabled: true,
        commands: DEFAULT_SUMMARY_COMMANDS,
        count: 100,
        maxCount: 200,
        prompt: DEFAULT_SUMMARY_PROMPT,
        scope: "all",
        peers: [],
        maxTranscriptChars: 20_000,
    },
    realtime: {
        enabled: true,
        windowMs: 800,
        maxWindowMs: 3_000,
        maxMessages: 10,
        maxChars: 8_000,
    },
    history: {
        enabled: true,
        maxMessages: 20,
        maxChars: 4_000,
        maxAgeMs: 0,
    },
};
export const IMAGE_DEFAULTS = {
    enabled: true,
    maxPerMessage: 4,
    maxBytes: 8 * 1024 * 1024,
    // Mirrors OpenClaw's own tool-image ceiling (1200px) with headroom for QQ
    // screenshots, where text becomes unreadable if downscaled too aggressively.
    maxDimensionPx: 1600,
    timeoutMs: 20_000,
    totalTimeoutMs: 30_000,
    allowPrivateNetwork: false,
    tool: true,
    // Copied, not aliased: `IMAGE_DEFAULTS` is exported and its arrays would
    // otherwise be the same object as `DEFAULT_IMAGE_HOSTS`, so one caller
    // mutating either would silently change the other.
    allowedHosts: [...DEFAULT_IMAGE_HOSTS],
};
export const QUOTE_DEFAULTS = {
    enabled: true,
    resolveForward: true,
    maxDepth: 2,
    maxNodes: 20,
    maxChars: 4_000,
    timeoutMs: 10_000,
};
function positiveInt(value, fallback) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
/** Like {@link positiveInt} but reports "not configured" instead of a fallback. */
function positiveIntOrUndefined(value) {
    if (value == null || value === "")
        return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return undefined;
    return Math.floor(parsed);
}
function nonNegativeInt(value, fallback) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
        return fallback;
    return Math.floor(parsed);
}
function bool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
function stringList(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0);
}
function resolveReceive(raw) {
    const mention = raw?.mention ?? {};
    const digest = raw?.digest ?? {};
    const summary = raw?.summary ?? {};
    const realtime = raw?.realtime ?? {};
    const history = raw?.history ?? {};
    const keywordMatch = mention.keywordMatch;
    const scope = digest.scope;
    const summaryScope = summary.scope;
    const digestMaxMessages = positiveInt(digest.maxMessages, RECEIVE_DEFAULTS.digest.maxMessages);
    const summaryCommands = stringList(summary.commands);
    const summaryMaxCount = positiveInt(summary.maxCount, RECEIVE_DEFAULTS.summary.maxCount);
    return {
        mention: {
            enabled: bool(mention.enabled, RECEIVE_DEFAULTS.mention.enabled),
            requireMentionInGroup: bool(mention.requireMentionInGroup, RECEIVE_DEFAULTS.mention.requireMentionInGroup),
            keywords: stringList(mention.keywords),
            keywordMatch: keywordMatch === "prefix" || keywordMatch === "exact" || keywordMatch === "regex"
                ? keywordMatch
                : RECEIVE_DEFAULTS.mention.keywordMatch,
            caseSensitive: bool(mention.caseSensitive, RECEIVE_DEFAULTS.mention.caseSensitive),
            triggerOnReplyToSelf: bool(mention.triggerOnReplyToSelf, RECEIVE_DEFAULTS.mention.triggerOnReplyToSelf),
            alwaysReplyInDirect: bool(mention.alwaysReplyInDirect, RECEIVE_DEFAULTS.mention.alwaysReplyInDirect),
        },
        digest: {
            enabled: bool(digest.enabled, RECEIVE_DEFAULTS.digest.enabled),
            intervalMs: positiveInt(digest.intervalMs, RECEIVE_DEFAULTS.digest.intervalMs),
            maxMessages: digestMaxMessages,
            // A window that can never reach its minimum would never flush.
            minMessages: Math.min(positiveInt(digest.minMessages, RECEIVE_DEFAULTS.digest.minMessages), digestMaxMessages),
            prompt: typeof digest.prompt === "string" && digest.prompt.trim()
                ? digest.prompt.trim()
                : RECEIVE_DEFAULTS.digest.prompt,
            scope: scope === "direct" || scope === "all" ? scope : RECEIVE_DEFAULTS.digest.scope,
            peers: stringList(digest.peers),
            maxTranscriptChars: positiveInt(digest.maxTranscriptChars, RECEIVE_DEFAULTS.digest.maxTranscriptChars),
        },
        summary: {
            enabled: bool(summary.enabled, RECEIVE_DEFAULTS.summary.enabled),
            // An explicitly empty `commands: []` would leave nothing to type, so it
            // falls back to the built-ins the same way an omitted key does.
            commands: summaryCommands.length > 0 ? summaryCommands : [...RECEIVE_DEFAULTS.summary.commands],
            // The default count is itself a user-visible request, so it obeys maxCount too.
            count: Math.min(positiveInt(summary.count, RECEIVE_DEFAULTS.summary.count), summaryMaxCount),
            maxCount: summaryMaxCount,
            prompt: typeof summary.prompt === "string" && summary.prompt.trim()
                ? summary.prompt.trim()
                : RECEIVE_DEFAULTS.summary.prompt,
            scope: summaryScope === "group" || summaryScope === "direct"
                ? summaryScope
                : RECEIVE_DEFAULTS.summary.scope,
            peers: stringList(summary.peers),
            maxTranscriptChars: positiveInt(summary.maxTranscriptChars, RECEIVE_DEFAULTS.summary.maxTranscriptChars),
        },
        realtime: {
            enabled: bool(realtime.enabled, RECEIVE_DEFAULTS.realtime.enabled),
            windowMs: nonNegativeInt(realtime.windowMs, RECEIVE_DEFAULTS.realtime.windowMs),
            maxWindowMs: positiveInt(realtime.maxWindowMs, RECEIVE_DEFAULTS.realtime.maxWindowMs),
            maxMessages: positiveInt(realtime.maxMessages, RECEIVE_DEFAULTS.realtime.maxMessages),
            maxChars: positiveInt(realtime.maxChars, RECEIVE_DEFAULTS.realtime.maxChars),
        },
        history: {
            enabled: bool(history.enabled, RECEIVE_DEFAULTS.history.enabled),
            maxMessages: positiveInt(history.maxMessages, RECEIVE_DEFAULTS.history.maxMessages),
            maxChars: positiveInt(history.maxChars, RECEIVE_DEFAULTS.history.maxChars),
            maxAgeMs: nonNegativeInt(history.maxAgeMs, RECEIVE_DEFAULTS.history.maxAgeMs),
        },
    };
}
function resolveQuote(raw) {
    const quote = raw ?? {};
    return {
        enabled: bool(quote.enabled, QUOTE_DEFAULTS.enabled),
        resolveForward: bool(quote.resolveForward, QUOTE_DEFAULTS.resolveForward),
        maxDepth: nonNegativeInt(quote.maxDepth, QUOTE_DEFAULTS.maxDepth),
        maxNodes: positiveInt(quote.maxNodes, QUOTE_DEFAULTS.maxNodes),
        maxChars: positiveInt(quote.maxChars, QUOTE_DEFAULTS.maxChars),
        timeoutMs: positiveInt(quote.timeoutMs, QUOTE_DEFAULTS.timeoutMs),
    };
}
const MB = 1024 * 1024;
/**
 * The channel-standard media ceiling, ported from the host's
 * `resolveChannelMediaMaxBytes`: the account's own `mediaMaxMb`, else
 * `agents.defaults.mediaMaxMb`, else nothing. Every bundled OpenClaw channel
 * resolves its media limit this way, so an operator who already set the key for
 * Telegram or Slack gets the same behaviour here instead of being silently
 * ignored.
 */
function resolveChannelMediaMaxBytes(accountConfig, cfg) {
    const accountLimit = positiveIntOrUndefined(accountConfig.mediaMaxMb);
    if (accountLimit)
        return accountLimit * MB;
    const globalLimit = positiveIntOrUndefined(cfg?.agents?.defaults?.mediaMaxMb);
    return globalLimit ? globalLimit * MB : undefined;
}
/**
 * Ported from the host's `isPrivateNetworkOptInEnabled`, which accepts four
 * spellings at the account level. Kept byte-for-byte compatible so the flag an
 * operator already set for another channel means the same thing here; the
 * plugin's own `image.allowPrivateNetwork` is simply a fifth way to say it.
 */
function isPrivateNetworkOptInEnabled(accountConfig) {
    const network = accountConfig.network;
    return (accountConfig.allowPrivateNetwork === true ||
        accountConfig.dangerouslyAllowPrivateNetwork === true ||
        network?.allowPrivateNetwork === true ||
        network?.dangerouslyAllowPrivateNetwork === true);
}
function resolveImage(accountConfig, cfg) {
    const image = accountConfig.image ?? {};
    const allowedHosts = stringList(image.allowedHosts);
    const resolvedTimeoutMs = positiveInt(image.timeoutMs, IMAGE_DEFAULTS.timeoutMs);
    return {
        enabled: bool(image.enabled, IMAGE_DEFAULTS.enabled),
        maxPerMessage: positiveInt(image.maxPerMessage, IMAGE_DEFAULTS.maxPerMessage),
        // Most specific wins: an explicit `image.maxBytes`, then the channel-standard
        // `mediaMaxMb` chain, then our own default.
        maxBytes: positiveInt(image.maxBytes, resolveChannelMediaMaxBytes(accountConfig, cfg) ?? IMAGE_DEFAULTS.maxBytes),
        // 0 is meaningful here ("never resize"), so this is the non-negative parser.
        maxDimensionPx: nonNegativeInt(image.maxDimensionPx, IMAGE_DEFAULTS.maxDimensionPx),
        timeoutMs: resolvedTimeoutMs,
        // Clamped up: a budget below one image's own timeout would pre-empt even a
        // single download, which is never what an operator means by it.
        totalTimeoutMs: Math.max(resolvedTimeoutMs, positiveInt(image.totalTimeoutMs, IMAGE_DEFAULTS.totalTimeoutMs)),
        allowPrivateNetwork: bool(image.allowPrivateNetwork, isPrivateNetworkOptInEnabled(accountConfig) || IMAGE_DEFAULTS.allowPrivateNetwork),
        tool: bool(image.tool, IMAGE_DEFAULTS.tool),
        // An explicitly empty list would leave the tool unable to fetch anything at
        // all, which reads as a mistake rather than a policy — fall back to the
        // built-in QQ hosts the same way an omitted key does.
        allowedHosts: allowedHosts.length > 0 ? allowedHosts : [...IMAGE_DEFAULTS.allowedHosts],
    };
}
function resolveSelfId(value) {
    if (value == null || value === "")
        return undefined;
    return String(value).trim() || undefined;
}
/** List every configured SnowLuma/QQBot account id. */
export function listSnowLumaAccountIds(cfg) {
    const ids = new Set();
    const section = cfg?.channels?.snowluma;
    if (section?.appId || section?.wsUrl || section?.httpUrl) {
        ids.add(DEFAULT_ACCOUNT_ID);
    }
    for (const [accountId, account] of Object.entries(section?.accounts ?? {})) {
        if (account?.appId || account?.wsUrl || account?.httpUrl) {
            ids.add(accountId);
        }
    }
    return Array.from(ids);
}
/**
 * Resolve one account: explicit config always wins, then environment fallbacks
 * (default account only), then built-in defaults.
 */
export function resolveSnowLumaAccount(cfg, accountId) {
    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    const section = cfg?.channels?.snowluma ?? {};
    let accountConfig;
    if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        const { accounts: _accounts, ...rest } = section;
        accountConfig = rest;
    }
    else {
        accountConfig = section.accounts?.[resolvedAccountId] ?? {};
    }
    const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
    const wsUrl = accountConfig.wsUrl ?? (isDefaultAccount ? getDefaultWsUrl() : undefined) ?? "";
    const httpUrl = accountConfig.httpUrl ?? (isDefaultAccount ? getDefaultHttpUrl() : undefined);
    const accessToken = accountConfig.accessToken ?? (isDefaultAccount ? getDefaultAccessToken() : undefined);
    const selfId = resolveSelfId(accountConfig.selfId) ?? (isDefaultAccount ? getDefaultSelfId() : undefined);
    const reconnect = accountConfig.reconnect ?? {};
    return {
        accountId: resolvedAccountId,
        name: accountConfig.name,
        enabled: accountConfig.enabled !== false,
        appId: accountConfig.appId ?? "",
        clientSecret: accountConfig.clientSecret ?? "",
        sandbox: accountConfig.sandbox !== false,
        ownerOpenId: accountConfig.ownerOpenId ?? "",
        allowOpenIds: stringList(accountConfig.allowOpenIds),
        proactiveCooldownMin: positiveInt(accountConfig.proactiveCooldownMin, 90),
        proactiveDailyMax: positiveInt(accountConfig.proactiveDailyMax, 6),
        partDelayMs: nonNegativeInt(accountConfig.partDelayMs, 450),
        authUrl: accountConfig.authUrl,
        apiBaseUrl: accountConfig.apiBaseUrl,
        wsUrl,
        httpUrl,
        accessToken,
        selfId,
        allowFrom: accountConfig.allowFrom,
        denyFrom: accountConfig.denyFrom,
        groupAutoReact: accountConfig.groupAutoReact === true,
        groupAutoReactEmojiId: accountConfig.groupAutoReactEmojiId ?? 1,
        replyToTrigger: bool(accountConfig.replyToTrigger, true),
        textChunkLimit: positiveInt(accountConfig.textChunkLimit, 4500),
        requestTimeoutMs: positiveInt(accountConfig.requestTimeoutMs, 30_000),
        debug: bool(accountConfig.debug, false),
        reconnect: {
            enabled: bool(reconnect.enabled, true),
            // Unset means "retry forever"; an explicit number — including 0, meaning
            // "never retry" — is honoured as written.
            retries: reconnect.retries == null
                ? Number.POSITIVE_INFINITY
                : nonNegativeInt(reconnect.retries, Number.POSITIVE_INFINITY),
            minDelayMs: positiveInt(reconnect.minDelayMs, 1_000),
            maxDelayMs: positiveInt(reconnect.maxDelayMs, 30_000),
        },
        receive: resolveReceive(accountConfig.receive),
        quote: resolveQuote(accountConfig.quote),
        image: resolveImage(accountConfig, cfg),
        toolsEnabled: bool(accountConfig.tools?.enabled, true),
        config: accountConfig,
    };
}
/** Write setup-wizard input back into the host config (immutably). */
export function applySnowLumaAccountConfig(cfg, accountId, input) {
    const patch = {
        enabled: true,
        ...(input.wsUrl ? { wsUrl: input.wsUrl } : {}),
        ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        ...(input.selfId != null && input.selfId !== "" ? { selfId: input.selfId } : {}),
        ...(input.name ? { name: input.name } : {}),
    };
    const section = cfg?.channels?.snowluma ?? {};
    if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
            ...cfg,
            channels: {
                ...cfg?.channels,
                snowluma: { ...section, ...patch },
            },
        };
    }
    return {
        ...cfg,
        channels: {
            ...cfg?.channels,
            snowluma: {
                ...section,
                enabled: section.enabled !== false,
                accounts: {
                    ...section.accounts,
                    [accountId]: { ...section.accounts?.[accountId], ...patch },
                },
            },
        },
    };
}
/**
 * Peer authorization. `allowFrom` is an allowlist (unset ⇒ allow everyone);
 * `denyFrom` always wins.
 */
export function isPeerAllowed(account, peerId) {
    const matches = (patterns) => Array.isArray(patterns) &&
        patterns.some((pattern) => pattern === "*" || pattern === peerId);
    if (matches(account.denyFrom))
        return false;
    if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) {
        return matches(account.allowFrom);
    }
    return true;
}
//# sourceMappingURL=config.js.map