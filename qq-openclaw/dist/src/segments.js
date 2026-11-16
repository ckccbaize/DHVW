/**
 * Inbound message segment parsing.
 *
 * `event.message` from `@snowluma/sdk` is typed only as `JsonValue` at the SDK
 * level (OneBot servers may run in "array" or "string" message format, and some
 * proxies hand back a bare plain string in place of either). Everything
 * downstream (`triggers.ts`, `aggregator.ts`, `quote.ts`) wants one normalized
 * `SnowLumaMessageSegment[]` shape, so all three inbound shapes funnel through
 * `toSegments` here rather than each caller re-deriving it.
 */
// `parseSegments` comes from the lazy registry: a static SDK value import here
// would pull the (possibly still unpatched) SDK into the entry graphs before
// the self-patch in `./sdk.js` can run. See src/sdk.ts.
import { getSnowLumaSdk } from "./sdk.js";
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
/** First candidate that stringifies to something non-empty, else undefined. */
function firstNonEmpty(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0)
            return candidate.trim();
        if (typeof candidate === "number" && Number.isFinite(candidate))
            return String(candidate);
    }
    return undefined;
}
/**
 * Normalize any of the three inbound `message` shapes (a real segment array,
 * a CQ-code string, or a plain string) into plain segment objects. Never
 * throws: unparseable input degrades to a single `text` segment (preferring
 * `rawMessage` when it was supplied) or, failing that, `[]`.
 */
export function toSegments(message, rawMessage) {
    try {
        if (Array.isArray(message)) {
            const segs = message
                .filter(isRecord)
                .filter((item) => typeof item.type === "string")
                .map((item) => ({
                type: item.type,
                data: isRecord(item.data) ? item.data : {},
            }));
            if (segs.length > 0)
                return segs;
            // Array present but nothing usable in it — fall through to the plain
            // text fallback below rather than reporting no content at all.
        }
        else if (typeof message === "string" && message.length > 0) {
            // The SDK's CQ parser handles both shapes here: a string with no
            // `[CQ:...]` codes comes back as a single `text` segment, same as a
            // plain string would need to. In production the gateway loads the SDK
            // before any event reaches this point; if the registry is somehow not
            // loaded yet, `getSnowLumaSdk` throws and the catch below degrades to
            // the plain-text fallback instead of dropping the message.
            return getSnowLumaSdk()
                .parseSegments(message)
                .map((seg) => ({
                type: seg.type,
                data: isRecord(seg.data) ? seg.data : {},
            }));
        }
    }
    catch {
        // Malformed input of some kind — degrade below instead of throwing.
    }
    const fallbackText = firstNonEmpty(rawMessage, typeof message === "string" ? message : undefined);
    return fallbackText ? [{ type: "text", data: { text: fallbackText } }] : [];
}
/** Concatenated `text` segment content, trimmed. */
export function extractText(segments) {
    return segments
        .filter((seg) => seg.type === "text")
        .map((seg) => (typeof seg.data.text === "string" ? seg.data.text : ""))
        .join("")
        .trim();
}
/** QQ ids mentioned via `at`; `@全体成员` (`qq === "all"`) sets `atAll` instead. */
export function extractMentions(segments) {
    const mentions = [];
    let atAll = false;
    for (const seg of segments) {
        if (seg.type !== "at")
            continue;
        const qq = seg.data.qq;
        if (qq === "all") {
            atAll = true;
        }
        else if (typeof qq === "string" && qq.length > 0) {
            mentions.push(qq);
        }
        else if (typeof qq === "number") {
            mentions.push(String(qq));
        }
    }
    return { mentions, atAll };
}
export function extractImageUrls(segments) {
    const urls = [];
    for (const seg of segments) {
        if (seg.type !== "image")
            continue;
        const url = firstNonEmpty(seg.data.url, seg.data.file);
        if (url)
            urls.push(url);
    }
    return urls;
}
/**
 * How many `[图片]` placeholders {@link renderSegments} will print for these
 * segments — which is NOT `extractImageUrls(segments).length`.
 *
 * The two differ for an image segment carrying neither `url` nor `file`, and
 * every caller that counts pictures FOR THE AGENT wants this one. A url is what
 * `image.ts` needs to download bytes; a placeholder is what the agent sees, and
 * `snowluma_view_image` reaches a picture by re-fetching the message through
 * `get_msg` — not through any url we captured — so a segment we could not
 * resolve locally is still perfectly viewable. Counting urls would drop the
 * hint for exactly those, print a count that disagrees with the placeholders
 * in front of the agent, and skew the `index` it passes to the tool.
 */
export function countImageSegments(segments) {
    let count = 0;
    for (const seg of segments)
        if (seg.type === "image")
            count += 1;
    return count;
}
export function extractRecordUrls(segments) {
    const urls = [];
    for (const seg of segments) {
        if (seg.type !== "record")
            continue;
        const url = firstNonEmpty(seg.data.url, seg.data.file);
        if (url)
            urls.push(url);
    }
    return urls;
}
export function extractReplyToId(segments) {
    for (const seg of segments) {
        // Reject empty-string ids the same way `extractForwardIds` does, so a
        // malformed `{type:"reply",data:{id:""}}` wire payload is treated as "no
        // reply" consistently across the two extractors (and their `quote.ts` gates).
        if (seg.type === "reply" && seg.data.id != null && String(seg.data.id).length > 0) {
            return String(seg.data.id);
        }
    }
    return undefined;
}
export function extractForwardIds(segments) {
    const ids = [];
    for (const seg of segments) {
        if (seg.type !== "forward")
            continue;
        const id = seg.data.id ?? seg.data.res_id ?? seg.data.forward_id;
        if (id != null && String(id).length > 0)
            ids.push(String(id));
    }
    return ids;
}
const PLACEHOLDERS = {
    image: "[图片]",
    record: "[语音]",
    face: "[表情]",
    video: "[视频]",
    file: "[文件]",
    forward: "[合并转发]",
};
/**
 * Flatten a display name to a single safe line, mirroring the host's
 * `sanitizeEnvelopeHeaderPart`.
 *
 * Every nickname/group card we put into an agent-visible body is free-form text
 * chosen by a remote user: `dispatch.ts` uses them for transcript lines and the
 * current-message label, `quote.ts` for the `[引用 …]` header and its forward
 * nodes. Left raw, a nickname containing a newline opens a brand-new line in
 * those blocks — one the agent reads as a separate message from someone else,
 * including after the "reply to this one" footer. Brackets fold to parentheses
 * so a name cannot imitate our own `[HH:mm:ss]`/`[图片]`/`[引用 …]` markers.
 */
export function sanitizeDisplayName(value) {
    return value
        .replace(/\r\n|\r|\n/g, " ")
        .replaceAll("[", "(")
        .replaceAll("]", ")")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * A message id that is safe to print into an agent-visible body, or `undefined`.
 *
 * Companion to {@link sanitizeDisplayName}, and there for the same reason: ids
 * reach us as free-form wire values (`String(seg.data.id)` off a `[CQ:reply]` a
 * chat user typed, `entry.message_id` out of a history payload), and both
 * `quote.ts` and `tools.ts` now print one so the agent can pass it to
 * `snowluma_view_image`. Printed raw, an id containing a newline or a `]` would
 * close our own marker and forge a line — the exact trick the nickname rule
 * exists to stop.
 *
 * Rejecting rather than flattening is deliberate: a real QQ message id is an
 * integer, so anything else is either useless to the tool or an attempt at
 * something. Callers drop the handle entirely when this returns `undefined`.
 */
export function safeMessageIdHandle(value) {
    if (value == null)
        return undefined;
    const raw = String(value).trim();
    return /^[A-Za-z0-9_.-]{1,128}$/.test(raw) ? raw : undefined;
}
/**
 * `（含 N 张图片，可用 snowluma_view_image messageId=… 查看）`, or `""`.
 *
 * The one wording for "there is a picture here and this is how you look at it",
 * shared by the quote block (`quote.ts`) and the reply-history block
 * (`dispatch.ts`). Images render as a bare `[图片]`, which tells the agent
 * something is there but gives it no way to look; the message id is the handle
 * `snowluma_view_image` takes. Printed only when there is actually a picture AND
 * an addressable id, so ordinary text keeps its existing shape.
 *
 * Callers pass {@link countImageSegments}, not a url count — see that function
 * for why. `messageId` is `unknown` because it arrives as a `number` from a live
 * event and as a `string` off a `[CQ:reply,id=…]`; {@link safeMessageIdHandle}
 * is the single place that decides which of those is printable, and it rejects
 * rather than flattens, so a missing or malformed id degrades to no hint rather
 * than a broken one.
 *
 * Two reasons the id can be missing, and both must degrade quietly. (1) For a
 * quote header the id can still be the raw `[CQ:reply,id=…]` a chat user typed
 * (the fallback when `get_msg` returns no `message_id`), and that is a
 * structural slot where a newline or `]` would close the block and forge a line.
 * (2) Merged-forward nodes are frequently not real messages and carry no id at
 * all. Whether `get_msg` can resolve a forward node's id is up to the OneBot
 * implementation; when it cannot, the tool answers with a plain
 * "获取消息 N 失败" rather than the agent being left with no affordance at all.
 */
export function formatImageHint(imageCount, messageId) {
    const idHandle = safeMessageIdHandle(messageId);
    if (imageCount <= 0 || !idHandle)
        return "";
    return `（含 ${imageCount} 张图片，可用 snowluma_view_image messageId=${idHandle} 查看）`;
}
/**
 * Human-readable rendering for the agent: text flows inline, `at` becomes
 * `@<name or qq>`, everything else collapses to a `[placeholder]`. `reply` is
 * intentionally omitted here — `quote.ts` actively resolves and injects that
 * content elsewhere in the body, so rendering it here would duplicate it.
 */
export function renderSegments(segments) {
    const parts = [];
    for (const seg of segments) {
        if (seg.type === "text") {
            const text = typeof seg.data.text === "string" ? seg.data.text : "";
            if (text)
                parts.push(text);
        }
        else if (seg.type === "at") {
            // `seg.data.name` is the mentioned member's group card — remote free-form
            // text like every other display name, and it reaches the agent through
            // the transcript lines this renders. Flatten it for the same reason
            // `renderTranscriptLine` flattens the sender's own nickname: otherwise a
            // card containing a newline forges a whole extra line in the transcript,
            // and its owner never has to say a word to plant it — being @-mentioned
            // once by someone else is enough.
            const raw = seg.data.qq === "all" ? "全体成员" : (firstNonEmpty(seg.data.name, seg.data.qq) ?? "");
            parts.push(`@${sanitizeDisplayName(raw)}`);
        }
        else if (seg.type === "reply") {
            continue;
        }
        else if (Object.hasOwn(PLACEHOLDERS, seg.type)) {
            // `Object.hasOwn`, not `in`: a segment whose type collides with an
            // inherited `Object.prototype` key ("constructor", "toString", …) must
            // fall through to the generic `[type]` placeholder, not resolve to a
            // prototype member and render as "function Object() { [native code] }".
            parts.push(PLACEHOLDERS[seg.type]);
        }
        else {
            parts.push(`[${seg.type}]`);
        }
    }
    return parts.join("");
}
/**
 * Normalize one entry from `get_group_msg_history` / `get_friend_msg_history`
 * into the same shape a live event produces.
 *
 * History entries arrive as untyped `JsonObject`s (the SDK types them no more
 * precisely than the wire does) and, unlike an event, carry no reliable
 * `message_type`/`group_id`/`self_id` — the caller already knows which peer it
 * asked about, so that context is passed in via `peer`. Returns `null` when the
 * entry has no usable sender or message id, so a malformed row is skipped
 * rather than rendered as `?(?)`.
 */
export function normalizeHistoryEntry(entry, peer) {
    if (!isRecord(entry))
        return null;
    const sender = isRecord(entry.sender) ? entry.sender : {};
    const senderId = firstNonEmpty(sender.user_id, entry.user_id);
    const messageId = firstNonEmpty(entry.message_id);
    if (!senderId || !messageId)
        return null;
    const rawMessage = typeof entry.raw_message === "string" ? entry.raw_message : "";
    const segments = toSegments(entry.message, rawMessage);
    const { mentions, atAll } = extractMentions(segments);
    const time = Number(entry.time);
    const senderName = firstNonEmpty(sender.card, sender.nickname) ?? String(senderId);
    return {
        peerId: peer.peerId,
        peerKind: peer.peerKind,
        groupId: peer.groupId,
        senderId,
        senderName,
        selfId: peer.selfId,
        messageId,
        time: Number.isFinite(time) ? time : 0,
        text: extractText(segments),
        rawText: rawMessage,
        segments,
        mentions,
        atAll,
        imageUrls: extractImageUrls(segments),
        recordUrls: extractRecordUrls(segments),
        replyToId: extractReplyToId(segments),
        forwardIds: extractForwardIds(segments),
    };
}
/** Build the fully-normalized message the rest of the plugin operates on. */
export function normalizeMessageEvent(event) {
    const segments = toSegments(event.message, event.raw_message);
    const { mentions, atAll } = extractMentions(segments);
    const isGroup = event.message_type === "group";
    const groupId = isGroup ? event.group_id : undefined;
    const senderName = firstNonEmpty(event.sender?.card, event.sender?.nickname) ?? String(event.user_id);
    return {
        peerId: isGroup ? `group:${groupId}` : `private:${event.user_id}`,
        peerKind: isGroup ? "group" : "direct",
        groupId,
        senderId: event.user_id,
        senderName,
        selfId: event.self_id,
        messageId: event.message_id,
        time: event.time,
        text: extractText(segments),
        rawText: event.raw_message,
        segments,
        mentions,
        atAll,
        imageUrls: extractImageUrls(segments),
        recordUrls: extractRecordUrls(segments),
        replyToId: extractReplyToId(segments),
        forwardIds: extractForwardIds(segments),
    };
}
//# sourceMappingURL=segments.js.map