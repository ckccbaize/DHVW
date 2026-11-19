/**
 * Agent tools exposed by the SnowLuma channel plugin: read-only lookups the
 * agent can call mid-conversation (chat history, group roster, one image)
 * without going through the normal inbound message flow.
 *
 * `snowluma_view_image` is the odd one out and worth stating plainly: images on
 * the CURRENT message never need it — `dispatch.ts` already attaches those to
 * the turn. It exists for every picture that is merely *mentioned* in the
 * prompt: the one behind a `[引用 …]` block, the one in a `[图片]` placeholder a
 * transcript line left behind, the one in a merged forward. Those are reachable
 * only by message id, and only on demand.
 *
 * Both tools resolve an account, borrow an API client for the duration of the
 * call (reusing the gateway's live socket when available, otherwise a
 * short-lived one), and always release it — even when the SDK call rejects.
 * Nothing here ever throws: SDK/config failures come back as a normal
 * `{ details: { status: "failed" } }` result so the agent can react to them.
 */
import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedSnowLumaAccount } from "./types.js";
/** Lets tests swap in a fake client acquisition without touching `./client.js`. */
export interface ToolDeps {
    acquireActionClient?: (account: ResolvedSnowLumaAccount) => Promise<{
        client: SnowLumaApiClient;
        release: () => void;
    }>;
}
/**
 * Builds the SnowLuma agent tools. Matches `ChannelAgentToolFactory`'s
 * `(params: { cfg? }) => ChannelAgentTool[]` shape (the optional `deps` field
 * is additive, so this also works wherever a plain factory is expected).
 */
export declare function createSnowLumaAgentTools(params?: {
    cfg?: OpenClawConfig;
    deps?: ToolDeps;
}): ChannelAgentTool[];
//# sourceMappingURL=tools.d.ts.map