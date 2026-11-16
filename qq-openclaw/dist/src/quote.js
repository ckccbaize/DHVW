/**
 * Active quote/forward resolution.
 *
 * QQ only sends a bare `{type:"reply",data:{id}}` (or `{type:"forward",data:{id}}`)
 * in the inbound message — the referenced content has to be actively fetched via
 * `get_msg` / `get_forward_msg`. This module does that fetching, defensively,
 * because both actions return untyped `JsonObject` (the SDK does not model the
 * message-history/forward-node payload shape) and because a slow or dead
 * SnowLuma instance must never take the inbound pipeline down with it.
 */
import { countImageSegments, extractForwardIds, formatImageHint, renderSegments, sanitizeDisplayName, toSegments, } from "./segments.js";
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function numberOrUndefined(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}
function stringOrUndefined(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
/**
 * Both `get_msg` and `get_forward_msg` hand back untyped `JsonObject`s that in
 * practice look like a OneBot message record (`sender`, `time`, `message` or
 * `raw_message`, `message_id`). Read every field defensively — a shape mismatch
 * should degrade the rendered text, never throw.
 */
function parseMessageLike(raw) {
    const obj = isRecord(raw) ? raw : {};
    const sender = isRecord(obj.sender) ? obj.sender : undefined;
    const senderId = numberOrUndefined(sender?.user_id ?? obj.user_id);
    const senderName = stringOrUndefined(sender?.card) ?? stringOrUndefined(sender?.nickname);
    const time = numberOrUndefined(obj.time);
    const rawMessage = stringOrUndefined(obj.raw_message);
    const content = obj.message ?? obj.content ?? rawMessage;
    const segments = toSegments(content, rawMessage);
    const messageId = obj.message_id != null ? String(obj.message_id) : undefined;
    return { senderId, senderName, time, segments, messageId };
}
async function walkForward(forwardId, deps, depth, state) {
    if (state.remaining <= 0) {
        state.truncated = true;
        return [];
    }
    if (state.visited.has(forwardId))
        return [];
    state.visited.add(forwardId);
    let messages;
    try {
        const result = await deps.client.getForwardMessage({ id: forwardId }, { timeoutMs: deps.quote.timeoutMs });
        messages = Array.isArray(result?.messages) ? result.messages : [];
    }
    catch (err) {
        deps.log?.error?.(`[snowluma] getForwardMessage(${forwardId}) failed: ${String(err)}`);
        state.remaining -= 1;
        return [{ text: "[引用消息获取失败]", depth, imageCount: 0 }];
    }
    const nodes = [];
    for (const raw of messages) {
        if (state.remaining <= 0) {
            state.truncated = true;
            break;
        }
        const parsed = parseMessageLike(raw);
        state.remaining -= 1;
        nodes.push({
            senderId: parsed.senderId,
            senderName: parsed.senderName,
            time: parsed.time,
            text: renderSegments(parsed.segments),
            depth,
            // Carried so `formatQuoteContext` can offer a `snowluma_view_image`
            // handle for a picture inside a forward — the case the tool names as one
            // of its three reasons to exist, and the only one that was unreachable.
            ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
            imageCount: countImageSegments(parsed.segments),
        });
        if (depth < deps.quote.maxDepth) {
            for (const nestedId of extractForwardIds(parsed.segments)) {
                if (state.remaining <= 0) {
                    state.truncated = true;
                    break;
                }
                const nested = await walkForward(nestedId, deps, depth + 1, state);
                nodes.push(...nested);
            }
        }
    }
    return nodes;
}
/** Expand one merged-forward id into flattened nodes, recursing to `quote.maxDepth`. */
export async function resolveForwardNodes(forwardId, deps, depth = 0) {
    const state = { visited: new Set(), remaining: deps.quote.maxNodes, truncated: false };
    return walkForward(forwardId, deps, depth, state);
}
/**
 * Trim the quoted text and forward nodes to `maxChars`.
 *
 * The per-node `snowluma_view_image` hint is charged against the same budget,
 * because `formatQuoteContext` appends it AFTER this runs: counting only
 * `node.text` would let a forwarded photo album — every node carrying an image
 * and an id, up to `quote.maxNodes` — push the rendered block well past a limit
 * the config reference documents as hard.
 */
function applyCharBudget(text, headerHintLength, forwardNodes, maxChars) {
    let remaining = Math.max(0, maxChars - headerHintLength);
    let truncated = headerHintLength > 0 && maxChars < headerHintLength;
    let outText = text;
    if (outText.length > remaining) {
        outText = outText.slice(0, remaining);
        truncated = true;
    }
    remaining -= outText.length;
    const outNodes = [];
    for (const node of forwardNodes) {
        if (remaining <= 0) {
            truncated = true;
            break;
        }
        const hintCost = formatImageHint(node.imageCount, node.messageId).length;
        // The hint is not worth dropping the node's own text for; if the budget
        // cannot even cover it, stop here rather than emit a node that is all hint.
        if (hintCost >= remaining) {
            truncated = true;
            break;
        }
        const budgetForText = remaining - hintCost;
        if (node.text.length > budgetForText) {
            outNodes.push({ ...node, text: node.text.slice(0, budgetForText) });
            remaining = 0;
            truncated = true;
        }
        else {
            outNodes.push(node);
            remaining -= node.text.length + hintCost;
        }
    }
    if (outNodes.length < forwardNodes.length)
        truncated = true;
    return { text: outText, forwardNodes: outNodes, truncated };
}
/** Actively fetch the quoted message (get_msg) and any merged forwards (get_forward_msg). */
export async function resolveQuoteContext(msg, deps) {
    if (!deps.quote.enabled)
        return null;
    if (!msg.replyToId && msg.forwardIds.length === 0)
        return null;
    let messageId = msg.replyToId ?? String(msg.messageId);
    let senderId;
    let senderName;
    let time;
    let text = "";
    let imageCount = 0;
    let quoteForwardIds = [];
    if (msg.replyToId) {
        const numericReplyId = Number(msg.replyToId);
        try {
            // `get_msg` takes a numeric message id; a non-numeric reply id would send
            // `NaN` (serialised as `null`) and depend on the server rejecting it.
            // Fail fast locally to the placeholder instead of round-tripping garbage.
            if (!Number.isFinite(numericReplyId)) {
                throw new Error(`non-numeric reply id "${msg.replyToId}"`);
            }
            const raw = await deps.client.getMessage(numericReplyId, {
                timeoutMs: deps.quote.timeoutMs,
            });
            const parsed = parseMessageLike(raw);
            senderId = parsed.senderId;
            senderName = parsed.senderName;
            time = parsed.time;
            text = renderSegments(parsed.segments);
            imageCount = countImageSegments(parsed.segments);
            quoteForwardIds = extractForwardIds(parsed.segments);
            if (parsed.messageId)
                messageId = parsed.messageId;
        }
        catch (err) {
            deps.log?.error?.(`[snowluma] getMessage(${msg.replyToId}) failed: ${String(err)}`);
            text = "[引用消息获取失败]";
        }
    }
    const forwardNodes = [];
    let forwardTruncated = false;
    if (deps.quote.resolveForward) {
        const state = { visited: new Set(), remaining: deps.quote.maxNodes, truncated: false };
        const forwardIds = [...msg.forwardIds, ...quoteForwardIds];
        for (const forwardId of forwardIds) {
            if (state.remaining <= 0) {
                state.truncated = true;
                break;
            }
            const nodes = await walkForward(forwardId, deps, 0, state);
            forwardNodes.push(...nodes);
        }
        forwardTruncated = state.truncated;
    }
    // The header hint is decided by the same inputs the renderer will use, so its
    // cost can be charged up front rather than discovered after the fact.
    const headerHintLength = formatImageHint(imageCount, messageId).length;
    const budgeted = applyCharBudget(text, headerHintLength, forwardNodes, deps.quote.maxChars);
    return {
        messageId,
        senderId,
        senderName,
        time,
        text: budgeted.text,
        imageCount,
        forwardNodes: budgeted.forwardNodes,
        truncated: forwardTruncated || budgeted.truncated,
    };
}
function formatTime(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/**
 * `name(id)` for the quote header and each forward node. The name comes off the
 * wire (`get_msg` / `get_forward_msg`), so it is flattened first — an unescaped
 * newline in a nickname would otherwise start a line of its own inside the
 * `[引用 …]` block and read as a separate quoted message.
 */
function formatWho(senderName, senderId) {
    const name = senderName ? sanitizeDisplayName(senderName) : "";
    if (name)
        return senderId !== undefined ? `${name}(${senderId})` : name;
    return senderId !== undefined ? String(senderId) : "未知";
}
/** Render a resolved quote for injection into the agent-visible body. */
export function formatQuoteContext(quote, options) {
    if (!quote)
        return "";
    const hint = (imageCount, messageId) => options.imageHint ? formatImageHint(imageCount, messageId) : "";
    const hasSender = quote.senderName !== undefined || quote.senderId !== undefined || quote.time !== undefined;
    const timeSuffix = quote.time !== undefined ? ` 于 ${formatTime(quote.time)}` : "";
    const imageHint = hint(quote.imageCount, quote.messageId);
    const header = hasSender
        ? `[引用 ${formatWho(quote.senderName, quote.senderId)}${timeSuffix} 的消息${imageHint}：${quote.text}`
        : `[引用消息${imageHint}：${quote.text}`;
    const lines = [header];
    for (const node of quote.forwardNodes) {
        const indent = "  ".repeat(node.depth + 1);
        const nodeTimeSuffix = node.time !== undefined ? ` ${formatTime(node.time)}` : "";
        const nodeHint = hint(node.imageCount, node.messageId);
        lines.push(`${indent}- ${formatWho(node.senderName, node.senderId)}${nodeTimeSuffix}${nodeHint}：${node.text}`);
    }
    return lines.join("\n") + (quote.truncated ? "（已截断）]" : "]");
}
//# sourceMappingURL=quote.js.map