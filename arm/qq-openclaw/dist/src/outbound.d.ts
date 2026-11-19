/**
 * Outbound sending: target parsing, text chunking, mention conversion, and the
 * SnowLuma message builders.
 *
 * Everything here goes through the injected `SnowLumaApiClient` action methods and the
 * SDK's `messages` builders (`chain`/`text`/`at`/`image`/`record`/`reply`) — no raw
 * OneBot payloads.
 */
import type { SnowLumaApiClient } from "@snowluma/sdk";
export interface SendTarget {
    kind: "group" | "private";
    id: number;
}
/**
 * Accepts `snowluma:group:1`, `group:1`, `private:2`, `snowluma:2` (bare id, after the
 * channel prefix is stripped ⇒ private), and a bare `12345` (⇒ private).
 */
export declare function parseTarget(to: string): SendTarget;
export declare function formatTarget(t: SendTarget): string;
/**
 * Splits `text` into chunks of at most `limit` characters, preferring to break right
 * after a newline when one falls within the limit, and never cutting inside a
 * `[CQ:...]` code even if that forces a chunk over `limit` (an unsplit code is the
 * only way to honor both constraints at once).
 */
export declare function chunkText(text: string, limit: number): string[];
/**
 * Rewrites `@<名字>` / `@<QQ号>` tokens whose target is a *known* participant into
 * explicit `[CQ:at,qq=N]` codes, which `sendText` then materializes as real mention
 * segments. Purely textual and conservative:
 *
 * - only keys present in `targets` are touched — any other `@...` stays literal text;
 * - the char before `@` must not be email-local (`foo@qq.com` stays), and the char
 *   after the matched name must not be wordish (`@张三丰` never half-matches a known
 *   `张三`, it either matches the full longer name or stays text);
 * - longer keys win over shorter ones when several could match at one position;
 * - an `@` inside an existing `[CQ:...]` code is never rewritten.
 *
 * `targets` keys must be exactly the tokens the reader of the prompt saw (sanitized
 * display names / bare id strings); values are the QQ id to ping.
 */
export declare function rewriteNameMentions(text: string, targets: ReadonlyMap<string, string | number>): string;
/**
 * Stable phrase from OpenClaw's runtime "empty inbound" notice
 * ("I didn't receive any text in your message. Please resend or add a caption.").
 * The runtime emits it (not the agent) for turns it deems empty. We never want it
 * posted to QQ, so `sendText` drops any outbound text containing it — this is the
 * universal chokepoint every outbound path (gateway reply dispatch AND the
 * host-initiated channel adapter) funnels through, so blocking it here catches it
 * no matter which layer produced it. Matched as a substring to survive a response
 * prefix or trailing wording tweaks. See also the higher-level guards in
 * dispatch.ts (skip / deliver-drop) and channel.ts.
 */
export declare const OPENCLAW_EMPTY_INPUT_NOTICE = "I didn't receive any text in your message";
/** True when `text` is (or contains) OpenClaw's canned empty-inbound notice. */
export declare function isOpenClawEmptyInputNotice(text: string | undefined | null): boolean;
export interface OutboundDebug {
    log: (line: string) => void;
}
/**
 * Chunks `text` and sends each piece in order. When `replyToId` is given, only the
 * first chunk carries the `reply(...)` segment — later chunks are plain continuations
 * of the same reply, not additional quotes of the original message.
 */
export declare function sendText(params: {
    client: SnowLumaApiClient;
    to: string;
    text: string;
    replyToId?: string | number;
    chunkLimit?: number;
    /**
     * Convert `[CQ:at,qq=<QQ号>]` codes in `text` into real mention segments.
     * Default true. Summarisation replies pass false: their text may quote a chat
     * transcript verbatim, and an echoed code must never ping anyone.
     */
    convertAtCodes?: boolean;
    debug?: OutboundDebug;
}): Promise<{
    messageIds: string[];
}>;
/**
 * Sends `mediaPath` as an image or voice message when its extension matches a known
 * media type; anything else falls back to a group/private file upload, since OneBot
 * has no generic "send arbitrary file inline" message segment. `caption`, if given, is
 * sent as a separate text message after the media.
 */
export declare function sendMedia(params: {
    client: SnowLumaApiClient;
    to: string;
    mediaPath: string;
    caption?: string;
    /** Quote-reply the media message to this id. Ignored on the file-upload path, which has no message segment. */
    replyToId?: string | number;
    debug?: OutboundDebug;
}): Promise<{
    messageIds: string[];
}>;
/** Wraps `setMsgEmojiLike`; never throws — failures come back as `{ ok: false, error }`. */
export declare function reactToMessage(client: SnowLumaApiClient, messageId: string | number, emojiId: string | number): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=outbound.d.ts.map