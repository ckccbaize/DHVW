// Local, not `openclaw/plugin-sdk/core`, on purpose: keeping these out of this
// module keeps `setup-entry.js`'s runtime graph free of any `openclaw/*` import,
// which is what avoids the loader's `ERR_REQUIRE_ESM_RACE_CONDITION`. See params.ts.
import { readNumberParam, readParamRaw, readStringParam } from "./params.js";
import { acquireActionClient as defaultAcquireActionClient } from "./client.js";
import { resolveSnowLumaAccount } from "./config.js";
import { describeStoredImage, endpointHost, extractImageRefsFromRaw, loadImageForTool, resolveStoredImageEnvelope, resolveToolImageEnvelope, } from "./image.js";
import { formatTarget, parseTarget } from "./outbound.js";
import { countImageSegments, renderSegments, safeMessageIdHandle, sanitizeDisplayName, toSegments, } from "./segments.js";
import { tryGetSnowLumaRuntime } from "./runtime.js";
/** Standard failure shape: never thrown, always returned. */
function failResult(text) {
    return { content: [{ type: "text", text }], details: { status: "failed", error: text } };
}
function describeError(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
/**
 * Resolve the account, acquire a client, run `fn`, and always release —
 * folding every failure mode (unconfigured account, acquire failure, SDK
 * rejection) into one `{ ok: false, error }` result instead of a throw.
 */
async function withAccountClient(cfg, accountId, deps, fn) {
    const account = resolveSnowLumaAccount(cfg, accountId);
    if (!account.wsUrl && !account.httpUrl) {
        return {
            ok: false,
            error: `SnowLuma 账号「${account.accountId}」未配置 wsUrl/httpUrl，无法执行该操作。`,
        };
    }
    const acquire = deps.acquireActionClient ?? defaultAcquireActionClient;
    try {
        const { client, release } = await acquire(account);
        try {
            const value = await fn(client, account);
            return { ok: true, value };
        }
        finally {
            release();
        }
    }
    catch (err) {
        return { ok: false, error: describeError(err) };
    }
}
function formatHHMMSS(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function toTimeSeconds(entry) {
    const raw = entry.time;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
}
/** History entries are untyped `JsonObject`s straight off the wire — read every field defensively. */
function renderHistoryLine(entry) {
    const sender = entry.sender;
    const senderObj = sender && typeof sender === "object" ? sender : {};
    const qq = senderObj.user_id ?? entry.user_id ?? "?";
    // Flattened like every other agent-visible name: one line per entry, no
    // matter what the nickname contains (see `sanitizeDisplayName`).
    const rawNickname = typeof senderObj.nickname === "string" ? sanitizeDisplayName(senderObj.nickname) : "";
    const nickname = rawNickname || String(qq);
    const rawMessage = typeof entry.raw_message === "string"
        ? entry.raw_message
        : undefined;
    const segments = toSegments(entry.message, rawMessage);
    const text = renderSegments(segments);
    // A history line's `[图片]` placeholder is a dead end on its own. When the
    // entry actually carries a picture, print the message id next to it so the
    // agent has the handle `snowluma_view_image` needs — omitted otherwise, so
    // ordinary text history keeps its existing shape.
    //
    // `safeMessageIdHandle` for the same reason nicknames go through
    // `sanitizeDisplayName`: `message_id` is a free-form wire value, and this is a
    // structural slot in a transcript line. An id carrying a newline would forge a
    // whole extra line; a non-numeric one is useless to the tool regardless.
    const messageId = safeMessageIdHandle(entry.message_id);
    // `countImageSegments`, not a url count: the tool re-fetches through
    // `get_msg`, so a segment we could not resolve to a url locally is still
    // viewable and still deserves the handle.
    const imageHandle = countImageSegments(segments) > 0 && messageId ? ` [msgId:${messageId}]` : "";
    return `[${formatHHMMSS(toTimeSeconds(entry))}] ${nickname}(${qq}):${imageHandle} ${text}`;
}
function renderMemberLine(member) {
    const card = typeof member.card === "string" ? sanitizeDisplayName(member.card) : "";
    const nickname = typeof member.nickname === "string" ? sanitizeDisplayName(member.nickname) : "";
    const name = card || nickname || "?";
    const qq = member.user_id ?? "?";
    const role = typeof member.role === "string" && member.role ? member.role : "member";
    return `${name}(${qq}) — ${role}`;
}
const HistoryParams = {
    type: "object",
    required: ["target"],
    properties: {
        target: { type: "string", description: "会话目标：group:<群号> / private:<QQ号>，裸数字视为私聊。" },
        count: { type: "number", description: "返回的消息条数，默认 20，范围 1-100。" },
        messageSeq: {
            type: "number",
            description: "分页锚点（对应 SnowLuma 的 message_id），从该消息向更早翻页。",
        },
        accountId: { type: "string", description: "SnowLuma 账号 id，默认使用 default 账号。" },
    },
};
const GroupMembersParams = {
    type: "object",
    required: ["groupId"],
    properties: {
        groupId: {
            anyOf: [{ type: "number" }, { type: "string" }],
            description: "群号。",
        },
        noCache: { type: "boolean", description: "跳过缓存，强制向 SnowLuma 请求最新数据。" },
        limit: { type: "number", description: "返回的最大成员数，默认 100，范围 1-500。" },
        accountId: { type: "string", description: "SnowLuma 账号 id，默认使用 default 账号。" },
    },
};
const ViewImageParams = {
    type: "object",
    properties: {
        messageId: {
            anyOf: [{ type: "number" }, { type: "string" }],
            description: "要查看图片的 QQ 消息 id。引用块里的 messageId、历史记录行里的 [msgId:...] 都可以直接填。",
        },
        url: {
            type: "string",
            description: "直接给出图片地址（http/https 或 data: URL）。默认只允许 QQ 官方图床域名，可用 image.allowedHosts 放行其他域名。",
        },
        index: {
            type: "number",
            description: "该消息里的第几张图片，从 1 开始，默认 1。",
        },
        mode: {
            type: "string",
            enum: ["image", "describe"],
            description: "image：把图片本身交给当前模型（需要模型支持图片输入）。describe：改由 OpenClaw 的图像理解模型生成文字描述后返回。默认 image。",
        },
        prompt: {
            type: "string",
            description: "describe 模式下想让图像理解模型回答的问题，例如「图里的报错信息是什么」。",
        },
        accountId: { type: "string", description: "SnowLuma 账号 id，默认使用 default 账号。" },
    },
};
/**
 * Builds the SnowLuma agent tools. Matches `ChannelAgentToolFactory`'s
 * `(params: { cfg? }) => ChannelAgentTool[]` shape (the optional `deps` field
 * is additive, so this also works wherever a plain factory is expected).
 */
export function createSnowLumaAgentTools(params = {}) {
    const deps = params.deps ?? {};
    // `OpenClawConfig.channels` is a permissive index-signature bag at the host
    // level; `resolveSnowLumaAccount` only cares about the `channels.snowluma`
    // shape we control, so a structural cast is safe here.
    const hostCfg = (params.cfg ?? {});
    // Registration happens once, before any call has named an `accountId`, so the
    // default account's config is what decides which tools are offered at all.
    const defaultAccount = resolveSnowLumaAccount(hostCfg, undefined);
    const getHistory = {
        name: "snowluma_get_history",
        label: "SnowLuma 聊天记录",
        description: "获取指定 QQ 群聊或私聊的历史消息（通过 SnowLuma）。按时间从旧到新渲染。",
        parameters: HistoryParams,
        async execute(_toolCallId, rawParams) {
            try {
                const p = (rawParams ?? {});
                const targetRaw = readStringParam(p, "target", { required: true });
                const accountId = readStringParam(p, "accountId");
                const count = clampInt(readNumberParam(p, "count"), 1, 100, 20);
                const messageSeq = readNumberParam(p, "messageSeq");
                let target;
                try {
                    target = parseTarget(targetRaw);
                }
                catch (err) {
                    return failResult(`无法解析 target "${targetRaw}"：${describeError(err)}`);
                }
                const result = await withAccountClient(hostCfg, accountId, deps, async (client) => {
                    if (target.kind === "group") {
                        const { messages } = await client.getGroupMessageHistory({
                            group_id: target.id,
                            count,
                            message_id: messageSeq,
                        });
                        return messages ?? [];
                    }
                    const { messages } = await client.getFriendMessageHistory({
                        user_id: target.id,
                        count,
                        message_id: messageSeq,
                    });
                    return messages ?? [];
                });
                if (!result.ok) {
                    return failResult(`获取历史消息失败：${result.error}`);
                }
                const ordered = [...result.value].sort((a, b) => toTimeSeconds(a) - toTimeSeconds(b));
                const text = ordered.length > 0 ? ordered.map(renderHistoryLine).join("\n") : "（无历史消息）";
                return {
                    content: [{ type: "text", text }],
                    details: {
                        status: "ok",
                        target: formatTarget(target),
                        count: ordered.length,
                        messages: ordered,
                    },
                };
            }
            catch (err) {
                return failResult(`snowluma_get_history 执行失败：${describeError(err)}`);
            }
        },
    };
    const getGroupMembers = {
        name: "snowluma_get_group_members",
        label: "SnowLuma 群成员列表",
        description: "获取指定 QQ 群的成员列表（通过 SnowLuma）。",
        parameters: GroupMembersParams,
        async execute(_toolCallId, rawParams) {
            try {
                const p = (rawParams ?? {});
                const groupIdRaw = readParamRaw(p, "groupId");
                const groupId = typeof groupIdRaw === "number" ? groupIdRaw : Number(groupIdRaw);
                if (!Number.isFinite(groupId)) {
                    return failResult(`无效的 groupId："${String(groupIdRaw)}"`);
                }
                const accountId = readStringParam(p, "accountId");
                const limit = clampInt(readNumberParam(p, "limit"), 1, 500, 100);
                const noCacheRaw = readParamRaw(p, "noCache");
                const noCache = typeof noCacheRaw === "boolean" ? noCacheRaw : undefined;
                const result = await withAccountClient(hostCfg, accountId, deps, (client) => client.getGroupMemberList(groupId, { noCache }));
                if (!result.ok) {
                    return failResult(`获取群成员失败：${result.error}`);
                }
                const members = result.value ?? [];
                const total = members.length;
                const shown = members.slice(0, limit);
                let text = shown.length > 0 ? shown.map(renderMemberLine).join("\n") : "（该群暂无成员信息）";
                if (total > limit) {
                    text += `\n（仅显示前 ${limit} / 共 ${total} 名成员）`;
                }
                return {
                    content: [{ type: "text", text }],
                    details: { status: "ok", groupId, total, shown: shown.length, members: shown },
                };
            }
            catch (err) {
                return failResult(`snowluma_get_group_members 执行失败：${describeError(err)}`);
            }
        },
    };
    const viewImage = {
        name: "snowluma_view_image",
        label: "SnowLuma 查看图片",
        description: "读取某条 QQ 消息里的图片并交给模型识别。用于引用消息、历史记录、合并转发里出现的 [图片]——" +
            "当前这条消息自带的图片已经随对话一起送达，无需再调用本工具。",
        parameters: ViewImageParams,
        async execute(_toolCallId, rawParams) {
            try {
                const p = (rawParams ?? {});
                const accountId = readStringParam(p, "accountId");
                const account = resolveSnowLumaAccount(hostCfg, accountId);
                const modeRaw = readStringParam(p, "mode");
                const mode = modeRaw === "describe" ? "describe" : "image";
                const index = clampInt(readNumberParam(p, "index"), 1, 50, 1);
                const explicitUrl = readStringParam(p, "url");
                const imageDeps = {
                    runtime: tryGetSnowLumaRuntime(),
                    image: account.image,
                    trustedHost: endpointHost(account.httpUrl, account.wsUrl),
                };
                if (!imageDeps.runtime) {
                    return failResult("SnowLuma 运行时尚未初始化，暂时无法读取图片。");
                }
                // Resolve the candidate list: a message id is looked up through
                // SnowLuma (so the URL we fetch is one QQ gave us, not one the model
                // invented), an explicit url is taken as-is and gated by `allowedHosts`
                // inside `loadImageForTool`.
                let refs;
                let sourceLabel;
                const messageIdRaw = readParamRaw(p, "messageId");
                if (messageIdRaw != null && messageIdRaw !== "") {
                    const messageId = Number(messageIdRaw);
                    if (!Number.isFinite(messageId)) {
                        return failResult(`无效的 messageId："${String(messageIdRaw)}"`);
                    }
                    const fetched = await withAccountClient(hostCfg, accountId, deps, (client) => client.getMessage(messageId, { timeoutMs: account.quote.timeoutMs }));
                    if (!fetched.ok) {
                        return failResult(`获取消息 ${messageId} 失败：${fetched.error}`);
                    }
                    refs = extractImageRefsFromRaw(fetched.value);
                    sourceLabel = `消息 ${messageId}`;
                    if (refs.length === 0) {
                        return failResult(`消息 ${messageId} 里没有图片。`);
                    }
                }
                else if (explicitUrl) {
                    refs = [explicitUrl];
                    sourceLabel = "指定地址";
                }
                else {
                    return failResult("请提供 messageId 或 url 之一。");
                }
                if (index > refs.length) {
                    return failResult(`${sourceLabel} 只有 ${refs.length} 张图片，取不到第 ${index} 张。`);
                }
                const ref = refs[index - 1];
                // The envelope depends on where the bytes are going. In `image` mode
                // they become a content block the model reads directly, and a plugin
                // tool's blocks reach it verbatim — nothing downstream re-sanitizes them
                // the way the host re-sanitizes an inbound attachment — so the host's
                // own tool-image ceiling applies. In `describe` mode they only ever
                // become a file for the vision model to open, so squeezing them into a
                // context-window budget would refuse large images for no reason.
                const loaded = await loadImageForTool(ref, imageDeps, mode === "describe"
                    ? resolveStoredImageEnvelope(account.image)
                    : resolveToolImageEnvelope(hostCfg, account.image));
                if (!loaded.ok) {
                    return failResult(`读取图片失败：${loaded.error}`);
                }
                const { image } = loaded;
                if (mode === "describe") {
                    if (!image.path) {
                        return failResult("图片未能写入 OpenClaw 媒体目录，无法调用图像理解；可改用 mode=\"image\" 直接交给当前模型。");
                    }
                    const described = await describeStoredImage({
                        filePath: image.path,
                        mime: image.mime,
                        prompt: readStringParam(p, "prompt"),
                        cfg: (params.cfg ?? {}),
                        deps: imageDeps,
                    });
                    if (!described.ok) {
                        return failResult(`图像理解失败：${described.error}`);
                    }
                    return {
                        content: [
                            { type: "text", text: `${sourceLabel} 第 ${index} 张图片的描述：\n${described.text}` },
                        ],
                        details: {
                            status: "ok",
                            mode,
                            source: sourceLabel,
                            index,
                            mime: image.mime,
                            bytes: image.bytes,
                            provider: described.provider,
                            model: described.model,
                        },
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `${sourceLabel} 第 ${index} 张图片（${image.mime}，${image.bytes} 字节）：`,
                        },
                        { type: "image", data: image.base64, mimeType: image.mime },
                    ],
                    details: {
                        status: "ok",
                        mode,
                        source: sourceLabel,
                        index,
                        total: refs.length,
                        mime: image.mime,
                        bytes: image.bytes,
                        path: image.path,
                    },
                };
            }
            catch (err) {
                return failResult(`snowluma_view_image 执行失败：${describeError(err)}`);
            }
        },
    };
    // The image tool is separately switchable: an operator running a text-only
    // model gains nothing from it, and it is the only tool here that can pull
    // bytes off the network.
    return defaultAccount.image.tool
        ? [getHistory, getGroupMembers, viewImage]
        : [getHistory, getGroupMembers];
}
//# sourceMappingURL=tools.js.map