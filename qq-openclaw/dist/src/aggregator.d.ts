/**
 * Receive-mode B & C: realtime coalescing and digest summarisation.
 *
 * Two fully independent windowing engines share one `accept()` entry point.
 * Every message that reaches `accept` may feed both — a burst of triggered
 * messages opens a realtime window while the same messages also accumulate
 * in that peer's digest window. Timers are injected so tests can drive this
 * deterministically instead of racing real wall-clock delays.
 */
import type { NormalizedMessage, PeerKind, ResolvedSnowLumaAccount, TriggerDecision } from "./types.js";
/**
 * `"summary"` batches never come out of this module — they are built on demand
 * by `summary.ts` when a user types `/summary` — but they travel the same
 * `AggregatedBatch` → `dispatch.ts` path, so the kind lives here with the others.
 */
export type FlushKind = "realtime" | "digest" | "summary";
export interface AggregatedBatch {
    kind: FlushKind;
    peerId: string;
    peerKind: PeerKind;
    groupId?: number;
    messages: NormalizedMessage[];
    /**
     * Prior messages from this peer's rolling reply-history buffer, oldest first,
     * excluding the batch's own `messages`. Only ever populated for realtime
     * batches — it is the accumulated chat context handed to the reply turn.
     * Empty/undefined when history is disabled or nothing preceded the batch.
     */
    history?: NormalizedMessage[];
    /**
     * The message that explicitly asked for this batch (`"summary"` only). It is
     * deliberately NOT part of `messages` — it is the command, not transcript
     * content — but dispatch attributes the turn to it and quote-replies to it.
     */
    commandMessage?: NormalizedMessage;
    trigger?: TriggerDecision;
    /** Why this batch flushed: "quiet" | "max-window" | "max-messages" | "max-chars" | "interval" | "immediate" | "shutdown" (or a caller-supplied reason passed to `flushAll`). */
    reason: string;
}
export interface AggregatorOptions {
    account: ResolvedSnowLumaAccount;
    onFlush: (batch: AggregatedBatch) => void | Promise<void>;
    log?: {
        debug?(m: string): void;
        error?(m: string): void;
    };
    now?: () => number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
}
export interface Aggregator {
    /** Feed one authorized inbound message plus its trigger decision. Never throws. */
    accept(msg: NormalizedMessage, trigger: TriggerDecision): void;
    /** Flush every open window (used on shutdown). Resolves once every `onFlush` call has settled. */
    flushAll(reason?: string): Promise<void>;
    /** Clear all pending timers without flushing — buffered messages are discarded. */
    dispose(): void;
    /** Introspection for tests: open realtime window keys (`${peerId}::${senderId}`). */
    pendingRealtimeKeys(): string[];
    /** Introspection for tests: open digest window keys (`peerId`). */
    pendingDigestKeys(): string[];
    /** Introspection for tests: peers with a non-empty reply-history buffer (`peerId`). */
    pendingHistoryKeys(): string[];
}
export declare function createAggregator(options: AggregatorOptions): Aggregator;
//# sourceMappingURL=aggregator.d.ts.map