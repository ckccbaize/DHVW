/**
 * Receive-mode A: mention/keyword triggering.
 *
 * Pure decision logic — given one normalized message and a resolved account,
 * decide whether (and why) the agent should wake up. No I/O, no timers.
 */
import type { MentionModeConfig, NormalizedMessage, ResolvedSnowLumaAccount, TriggerDecision } from "./types.js";
/** Mirrors `MentionModeConfig["keywordMatch"]` — kept in sync via `NonNullable` rather than duplicated. */
export type MentionKeywordMatch = NonNullable<MentionModeConfig["keywordMatch"]>;
export interface EvaluateTriggerOptions {
    /** Lets the caller answer "did the bot send this message id?" without this module knowing about history storage. */
    isSelfMessageId?: (id: string) => boolean;
}
/**
 * Find the first keyword in `keywords` that matches `text` under `match` mode.
 * Returns the matched keyword (not the match position) so callers can surface
 * *why* a message triggered, or `undefined` when nothing matched.
 */
export declare function matchKeyword(text: string, keywords: string[], match: MentionKeywordMatch, caseSensitive: boolean): string | undefined;
/**
 * Strip a leading "@bot" token (rendered `@name` or a raw CQ `at` remnant)
 * plus surrounding whitespace, so the agent sees "帮我查天气" rather than
 * "@bot 帮我查天气". `selfId`, when given, restricts CQ-remnant stripping to
 * mentions of the bot itself (or `@全体成员`); a rendered `@name` token is
 * always stripped since we cannot compare a display name to a numeric id.
 */
export declare function stripLeadingMention(text: string, selfId?: number): string;
/**
 * Decide whether `msg` should wake the agent, and why. Rules are evaluated in
 * the order documented in the module contract; the first matching rule wins.
 * `mention.enabled === false` is an absolute override — nothing else in this
 * function can trigger regardless of message content.
 */
export declare function evaluateTrigger(msg: NormalizedMessage, account: ResolvedSnowLumaAccount, opts?: EvaluateTriggerOptions): TriggerDecision;
//# sourceMappingURL=triggers.d.ts.map