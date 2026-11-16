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
import type { OneBotMessageEvent } from "@snowluma/sdk";
import type { NormalizedMessage, SnowLumaMessageSegment } from "./types.js";
/**
 * Normalize any of the three inbound `message` shapes (a real segment array,
 * a CQ-code string, or a plain string) into plain segment objects. Never
 * throws: unparseable input degrades to a single `text` segment (preferring
 * `rawMessage` when it was supplied) or, failing that, `[]`.
 */
export declare function toSegments(message: unknown, rawMessage?: string): SnowLumaMessageSegment[];
/** Concatenated `text` segment content, trimmed. */
export declare function extractText(segments: SnowLumaMessageSegment[]): string;
/** QQ ids mentioned via `at`; `@全体成员` (`qq === "all"`) sets `atAll` instead. */
export declare function extractMentions(segments: SnowLumaMessageSegment[]): {
    mentions: string[];
    atAll: boolean;
};
export declare function extractImageUrls(segments: SnowLumaMessageSegment[]): string[];
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
export declare function countImageSegments(segments: SnowLumaMessageSegment[]): number;
export declare function extractRecordUrls(segments: SnowLumaMessageSegment[]): string[];
export declare function extractReplyToId(segments: SnowLumaMessageSegment[]): string | undefined;
export declare function extractForwardIds(segments: SnowLumaMessageSegment[]): string[];
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
export declare function sanitizeDisplayName(value: string): string;
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
export declare function safeMessageIdHandle(value: unknown): string | undefined;
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
export declare function formatImageHint(imageCount: number, messageId: unknown): string;
/**
 * Human-readable rendering for the agent: text flows inline, `at` becomes
 * `@<name or qq>`, everything else collapses to a `[placeholder]`. `reply` is
 * intentionally omitted here — `quote.ts` actively resolves and injects that
 * content elsewhere in the body, so rendering it here would duplicate it.
 */
export declare function renderSegments(segments: SnowLumaMessageSegment[]): string;
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
export declare function normalizeHistoryEntry(entry: unknown, peer: {
    peerId: string;
    peerKind: NormalizedMessage["peerKind"];
    groupId?: number;
    selfId: number;
}): NormalizedMessage | null;
/** Build the fully-normalized message the rest of the plugin operates on. */
export declare function normalizeMessageEvent(event: OneBotMessageEvent): NormalizedMessage;
//# sourceMappingURL=segments.d.ts.map