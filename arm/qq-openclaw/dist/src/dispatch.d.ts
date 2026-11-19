/**
 * Wave 2 module E — inbound → agent dispatch.
 *
 * Turns one `AggregatedBatch` (a coalesced realtime burst, or a periodic
 * digest window) into a single agent turn via the host's `pluginRuntime.channel.*`
 * helpers, then delivers whatever the agent replies with back to QQ. Every
 * dependency a test needs to fake — the runtime, quote resolution, and the
 * outbound senders — is injectable through `DispatchDeps`, so exercising this
 * module never requires a running OpenClaw host.
 *
 * `formatInboundEnvelope` (now `src/envelope.ts`, since openclaw dropped it from
 * `runtime.channel.reply`) takes a closed set of fields with no `imageUrls`
 * param. Image information therefore travels two other ways: `renderSegments`
 * puts a `[图片]` placeholder inline in the rendered text, and
 * `finalizeInboundContext` accepts a generic `Record<string, unknown>`, so the
 * inbound media fields are threaded through the finalized context — all
 * already-declared `MsgContext` fields the agent runner reads for attachments.
 * `image.ts` fills those in: it downloads each QQ image into the host's media
 * store first, because a LOCAL PATH (not a url) is what makes OpenClaw actually
 * attach a picture to the model turn.
 */
import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { AggregatedBatch } from "./aggregator.js";
import { resolveInboundImages as defaultResolveInboundImages } from "./image.js";
import { sendMedia as defaultSendMedia, sendText as defaultSendText } from "./outbound.js";
import type { QuoteDeps } from "./quote.js";
import type { NormalizedMessage, ResolvedQuote, ResolvedSnowLumaAccount } from "./types.js";
export interface DispatchLogger {
    info?(m: string): void;
    error?(m: string): void;
    debug?(m: string): void;
}
export interface DispatchDeps {
    account: ResolvedSnowLumaAccount;
    cfg: OpenClawConfig;
    client: SnowLumaApiClient;
    log?: DispatchLogger;
    /** Defaults to `getSnowLumaRuntime()`; injectable so tests need no host. */
    runtime?: PluginRuntime;
    /** Defaults to `resolveQuoteContext` from ./quote.js. */
    resolveQuote?: (msg: NormalizedMessage, deps: QuoteDeps) => Promise<ResolvedQuote | null>;
    /** Defaults to `resolveInboundImages` from ./image.js. */
    resolveImages?: typeof defaultResolveInboundImages;
    /** Defaults to `sendText`/`sendMedia` from ./outbound.js. */
    send?: {
        sendText: typeof defaultSendText;
        sendMedia: typeof defaultSendMedia;
    };
}
/**
 * Whether the sender of this batch may run privileged text commands (`/reset`,
 * etc). Delegates to the host's access-group gate when available, falling
 * back to a plain `allowFrom` allowlist check for a runtime that doesn't
 * expose the gate (e.g. a minimal test double).
 */
export declare function resolveInboundCommandAuthorization(params: {
    runtime: PluginRuntime;
    cfg: OpenClawConfig;
    allowFrom?: string[];
    peerId: string;
}): boolean;
/** What `buildBatchBody` hands back to the dispatcher. */
export interface ComposedBody {
    body: string;
    rawBody: string;
    commandBody: string;
    imageUrls: string[];
    /**
     * True when `body` already carries the current sender's "name (id): " label
     * itself, so the caller must NOT also pass `sender` to the host envelope
     * formatter (which would prefix the whole body a second time).
     */
    senderLabelInBody: boolean;
}
/** Compose the agent-visible text for a batch (quote context, transcript, media placeholders). */
export declare function buildBatchBody(batch: AggregatedBatch, account: ResolvedSnowLumaAccount, quoteText: string): ComposedBody;
/**
 * A trailing line naming the messages whose images were tried and FAILED, so
 * the agent can still reach them with `snowluma_view_image`.
 *
 * Attachment is the normal path and needs no handle — the picture is simply
 * there. But a download can fail (an expired QQ `rkey`, an SSRF-blocked LAN
 * URL, the phase budget running out), and then the body says `[图片]` with
 * nothing behind it and no id to ask about. The quoted and history paths both
 * carry handles for exactly this reason; this closes the same gap for the
 * current message.
 *
 * `failedUrls` must be exactly "attempted minus attached", never "everything
 * the message carried". An image the operator excluded on purpose is not a
 * failure, and inviting the agent to fetch it anyway would quietly undo the
 * setting: a url dropped by `image.maxPerMessage` would hand the agent a way
 * around that ceiling, and with `image.enabled: false` every single picture
 * would be advertised. The caller also gates on `image.tool`, since naming a
 * tool that was never registered is worse than saying nothing.
 *
 * Ids go through `safeMessageIdHandle` for the usual reason — this is a
 * structural slot in an agent-visible body.
 */
export declare function renderUnattachedImageHint(messages: NormalizedMessage[], failedUrls: Set<string>): string;
/**
 * Hand one aggregated batch to the agent and stream its reply back to QQ.
 * Never rejects: every failure mode (quote resolution, the dispatch call
 * itself, a send) is caught and logged rather than thrown, so a bad batch
 * can never take the gateway's event loop down with it.
 */
export declare function dispatchBatch(batch: AggregatedBatch, deps: DispatchDeps): Promise<void>;
//# sourceMappingURL=dispatch.d.ts.map