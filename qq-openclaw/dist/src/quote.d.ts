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
import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { NormalizedMessage, ResolvedForwardNode, ResolvedQuote, ResolvedQuoteConfig } from "./types.js";
export interface QuoteDeps {
    client: Pick<SnowLumaApiClient, "getMessage" | "getForwardMessage">;
    quote: ResolvedQuoteConfig;
    log?: {
        debug?(m: string): void;
        error?(m: string): void;
    };
}
/** Expand one merged-forward id into flattened nodes, recursing to `quote.maxDepth`. */
export declare function resolveForwardNodes(forwardId: string, deps: QuoteDeps, depth?: number): Promise<ResolvedForwardNode[]>;
/** Actively fetch the quoted message (get_msg) and any merged forwards (get_forward_msg). */
export declare function resolveQuoteContext(msg: NormalizedMessage, deps: QuoteDeps): Promise<ResolvedQuote | null>;
/** Options for {@link formatQuoteContext}. */
export interface FormatQuoteOptions {
    /**
     * Whether `snowluma_view_image` is actually registered for this account
     * (`image.tool` AND `tools.enabled`). Required, and deliberately not
     * defaulted: naming a tool `createSnowLumaAgentTools` never returned costs
     * the agent a turn to discover it does not exist, and a default of `true`
     * here is exactly how that shipped — every other hint site in the plugin
     * checks, so this one has to make the caller answer too.
     */
    imageHint: boolean;
}
/** Render a resolved quote for injection into the agent-visible body. */
export declare function formatQuoteContext(quote: ResolvedQuote | null, options: FormatQuoteOptions): string;
//# sourceMappingURL=quote.d.ts.map