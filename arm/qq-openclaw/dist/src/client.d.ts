/**
 * SnowLuma WebSocket/HTTP client construction and the action-client registry.
 *
 * The gateway (wave 2) owns one long-lived `SnowLumaWebSocketClient` per account and
 * publishes it here via `registerActionClient` so one-off callers (agent tools, digest
 * dispatch) can reuse the open socket instead of paying for a second connection per
 * call. When no live socket is registered — gateway not started yet, or a background
 * job running outside the gateway process — `acquireActionClient` falls back to a
 * short-lived client of its own that the caller must `release()`.
 */
import type { SnowLumaApiClient, SnowLumaHttpClient, SnowLumaHttpClientOptions, SnowLumaWebSocketClient, SnowLumaWebSocketClientOptions } from "@snowluma/sdk";
import type { ResolvedSnowLumaAccount } from "./types.js";
export interface ClientLogger {
    info?(message: string): void;
    error?(message: string): void;
    debug?(message: string): void;
}
export type ClientFactory = (account: ResolvedSnowLumaAccount) => SnowLumaWebSocketClient;
/**
 * Builds the long-lived WebSocket client the gateway owns for one account.
 * Synchronous by contract (`ClientFactory`); callers must have awaited
 * `ensureSnowLumaSdk()` first — `startGateway` does.
 */
export declare function createSnowLumaClient(account: ResolvedSnowLumaAccount): SnowLumaWebSocketClient;
/** Live clients published by the gateway so agent tools can reuse an open socket. */
export declare function registerActionClient(accountId: string, client: SnowLumaApiClient): void;
export declare function unregisterActionClient(accountId: string): void;
export declare function tryGetActionClient(accountId: string): SnowLumaApiClient | undefined;
/** Test-only: clears the registry so cases don't leak state into one another. */
export declare function __resetActionClients(): void;
/** Injectable client constructors so tests can avoid opening real sockets/fetching. */
export interface AcquireActionClientDeps {
    createWs?: (options: SnowLumaWebSocketClientOptions) => SnowLumaWebSocketClient;
    createHttp?: (options: SnowLumaHttpClientOptions) => SnowLumaHttpClient;
}
/**
 * Resolve a client for one-off actions: the live socket when the gateway is up,
 * otherwise a short-lived client the caller must `release()`.
 */
export declare function acquireActionClient(account: ResolvedSnowLumaAccount, deps?: AcquireActionClientDeps): Promise<{
    client: SnowLumaApiClient;
    release: () => void;
}>;
/** Best-effort `get_login_info` to learn the bot's own QQ id; returns undefined on failure. */
export declare function detectSelfId(client: SnowLumaApiClient, log?: ClientLogger): Promise<number | undefined>;
//# sourceMappingURL=client.d.ts.map