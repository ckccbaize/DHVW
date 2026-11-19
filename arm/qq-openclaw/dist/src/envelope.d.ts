/**
 * Local, `openclaw`-free port of the host's inbound-envelope sender attribution.
 *
 * WHY LOCAL — openclaw removed `runtime.channel.reply.formatInboundEnvelope`
 * (present through 2026.5.x, gone by 2026.8.1; the surviving SDK export lives at
 * `openclaw/plugin-sdk/channel-inbound`, which this plugin may not import at
 * runtime — see the "no `openclaw/*` runtime import" hard constraint in
 * CLAUDE.md). A gateway on the new host answered every inbound message with
 * `TypeError: runtime.channel.reply.formatInboundEnvelope is not a function`.
 *
 * WHAT IS PORTED AND WHAT IS NOT — `formatInboundEnvelope` is a thin wrapper: it
 * decides the body's `sender: ` prefix from chat type + identity fields, then
 * delegates the bracketed `[Channel from … timestamp]` header to
 * `formatAgentEnvelope`. Only the first half is ported here. The header — with
 * its timezone resolution, relative-elapsed formatting and locale handling —
 * stays the host's job through `runtime.channel.reply.formatAgentEnvelope`,
 * which is still a supported runtime surface.
 *
 * Ported verbatim from openclaw 2026.8.1 (`dist/envelope-*.js`:
 * `formatInboundEnvelope`, `resolveDirectEnvelopeBodyLabel`,
 * `sanitizeEnvelopeHeaderPart`, `resolveSenderLabel`, `normalizeChatType`,
 * `normalizeOptionalString`). `test/envelope.test.ts` pins the port against the
 * real SDK function so a future host revision that changes the shape fails the
 * suite rather than the gateway.
 */
/**
 * `sanitizeEnvelopeHeaderPart` — flattens newlines, neutralizes the brackets
 * that delimit the envelope header, and collapses runs of whitespace.
 */
export declare function sanitizeEnvelopeHeaderPart(value: string): string;
/** `resolveSenderLabel` — best one-line label from the available identity fields. */
export declare function resolveSenderLabel(params: {
    name?: string;
    username?: string;
    tag?: string;
    e164?: string;
    id?: string;
}): string | null;
export interface InboundEnvelopeParams {
    channel?: string;
    from?: string;
    sender?: {
        id?: string;
        name?: string;
        username?: string;
        tag?: string;
        e164?: string;
    };
    senderLabel?: string;
    fromMe?: boolean;
    chatType?: string;
    timestamp?: number | Date;
    previousTimestamp?: number | Date;
    body: string;
    envelope?: unknown;
}
/** Signature of the host's still-supported `runtime.channel.reply.formatAgentEnvelope`. */
export type FormatAgentEnvelopeFn = (params: {
    channel?: string;
    from?: string;
    host?: string;
    ip?: string;
    timestamp?: number | Date;
    previousTimestamp?: number | Date;
    envelope?: unknown;
    body: string;
}) => string;
/**
 * Attach the sender attribution the host used to add, then hand the result to
 * the host's own header formatter.
 *
 * Attribution rules, unchanged from the SDK: a direct chat labels the body with
 * `(self)` when the message is ours, otherwise with the display half of `from`;
 * a group/channel labels it with the resolved sender label. Anything else (no
 * usable label) leaves the body alone.
 */
export declare function formatInboundEnvelope(params: InboundEnvelopeParams, formatAgentEnvelope: FormatAgentEnvelopeFn): string;
//# sourceMappingURL=envelope.d.ts.map