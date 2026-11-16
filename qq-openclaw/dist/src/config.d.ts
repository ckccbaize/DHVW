import type { ResolvedImageConfig, ResolvedQuoteConfig, ResolvedReceiveConfig, ResolvedSnowLumaAccount, SnowLumaHostConfig } from "./types.js";
export declare const DEFAULT_ACCOUNT_ID = "default";
export declare const DEFAULT_DIGEST_PROMPT: string;
/**
 * Unlike {@link DEFAULT_DIGEST_PROMPT} this one must never offer a SKIP escape
 * hatch: a summary is something a user explicitly asked for, so an empty reply
 * would read as the bot ignoring the command.
 */
export declare const DEFAULT_SUMMARY_PROMPT: string;
export declare const DEFAULT_SUMMARY_COMMANDS: string[];
export declare const RECEIVE_DEFAULTS: ResolvedReceiveConfig;
export declare const IMAGE_DEFAULTS: ResolvedImageConfig;
export declare const QUOTE_DEFAULTS: ResolvedQuoteConfig;
/** List every configured SnowLuma account id. */
export declare function listSnowLumaAccountIds(cfg: SnowLumaHostConfig): string[];
/**
 * Resolve one account: explicit config always wins, then environment fallbacks
 * (default account only), then built-in defaults.
 */
export declare function resolveSnowLumaAccount(cfg: SnowLumaHostConfig, accountId?: string | null): ResolvedSnowLumaAccount;
/** Write setup-wizard input back into the host config (immutably). */
export declare function applySnowLumaAccountConfig(cfg: SnowLumaHostConfig, accountId: string, input: {
    wsUrl?: string;
    httpUrl?: string;
    accessToken?: string;
    selfId?: number | string;
    name?: string;
}): SnowLumaHostConfig;
/**
 * Peer authorization. `allowFrom` is an allowlist (unset ⇒ allow everyone);
 * `denyFrom` always wins.
 */
export declare function isPeerAllowed(account: Pick<ResolvedSnowLumaAccount, "allowFrom" | "denyFrom">, peerId: string): boolean;
//# sourceMappingURL=config.d.ts.map