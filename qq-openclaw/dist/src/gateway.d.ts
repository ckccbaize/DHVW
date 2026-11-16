/**
 * The gateway loop — owns one long-lived SnowLuma connection per account and
 * wires it to the trigger/aggregator/dispatch pipeline.
 *
 * `@snowluma/sdk` owns the socket lifecycle entirely: connecting, heartbeats,
 * and reconnection (`SnowLumaWebSocketClientOptions.reconnect`, configured by
 * `createSnowLumaClient` from the account's `reconnect` settings). This module
 * never opens a socket itself and never schedules a reconnect — it only reacts
 * to the client's `onMessage`/`on("open"|"close"|"error")` events.
 */
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AggregatedBatch } from "./aggregator.js";
import type { DispatchDeps, DispatchLogger } from "./dispatch.js";
import type { ResolvedSnowLumaAccount } from "./types.js";
export interface SelfMessageTracker {
    add(id: string): void;
    has(id: string): boolean;
}
export declare function createSelfMessageTracker(maxSize?: number): SelfMessageTracker;
export interface GatewayContext {
    account: ResolvedSnowLumaAccount;
    cfg: OpenClawConfig;
    abortSignal: AbortSignal;
    log?: DispatchLogger;
    onReady?: (info: {
        selfId?: number;
    }) => void;
    onError?: (error: Error) => void;
    /** Defaults to `createSnowLumaClient`. */
    clientFactory?: (account: ResolvedSnowLumaAccount) => SnowLumaWebSocketClient;
    /** Defaults to `dispatchBatch`. */
    dispatch?: (batch: AggregatedBatch, deps: DispatchDeps) => Promise<void>;
}
/**
 * Runs the gateway loop for one account until `abortSignal` fires. Resolves
 * once shutdown (flush + unregister + close) has completed — mirrors the
 * reference plugin's trailing "wait for abort" promise, minus any hand-rolled
 * reconnect: that part is entirely the SDK's job.
 */
export declare function startGateway(ctx: GatewayContext): Promise<void>;
//# sourceMappingURL=gateway.d.ts.map