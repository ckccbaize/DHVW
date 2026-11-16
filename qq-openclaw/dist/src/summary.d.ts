/**
 * The on-demand `/summary` command — digest mode's manual counterpart.
 *
 * Digest mode summarises whatever happened to pass through the gateway's own
 * window. `/summary` instead asks SnowLuma for the peer's most recent messages
 * (100 by default) via `get_group_msg_history` / `get_friend_msg_history`, so it
 * works on the first day the bot joins a group, with digest mode switched off,
 * and over messages the gateway never observed.
 *
 * The command is matched here and dispatched as an ordinary `AggregatedBatch`
 * of `kind: "summary"` — it never touches the aggregator's windows, so an
 * in-flight realtime burst or digest window is left exactly as it was.
 */
import type { SnowLumaApiClient } from "@snowluma/sdk";
import type { AggregatedBatch } from "./aggregator.js";
import type { DispatchLogger } from "./dispatch.js";
import { sendText as defaultSendText } from "./outbound.js";
import type { NormalizedMessage, ResolvedSnowLumaAccount } from "./types.js";
/** A matched `/summary` invocation: which command word fired, and how many messages it asked for. */
export interface SummaryRequest {
    command: string;
    count: number;
}
export interface SummaryDeps {
    account: ResolvedSnowLumaAccount;
    client: SnowLumaApiClient;
    log?: DispatchLogger;
    /** Hands the composed batch to the normal dispatch path. */
    dispatch: (batch: AggregatedBatch) => Promise<void>;
    /** Defaults to `sendText` from ./outbound.js — used only for the "nothing to summarise" / failure notices. */
    send?: {
        sendText: typeof defaultSendText;
    };
    /** Defaults to the SDK's history actions; injectable so tests need no client. */
    fetchHistory?: (params: {
        count: number;
    }) => Promise<unknown[]>;
}
/**
 * Decide whether `msg` is a `/summary` command for this account, and for how
 * many messages. Pure — no I/O — so the gateway can call it on every inbound
 * message. Returns `null` when the command is disabled, out of scope, or absent.
 */
export declare function matchSummaryCommand(msg: NormalizedMessage, account: ResolvedSnowLumaAccount): SummaryRequest | null;
/**
 * Run a matched `/summary` command end to end: fetch the recent messages, build
 * the batch, dispatch it. Never rejects — every failure is reported to the chat
 * that asked (a silent no-op would read as the bot ignoring the command) and
 * logged.
 */
export declare function runSummaryCommand(msg: NormalizedMessage, request: SummaryRequest, deps: SummaryDeps): Promise<void>;
//# sourceMappingURL=summary.d.ts.map