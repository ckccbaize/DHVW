/**
 * `channels.snowluma` config schema for the OpenClaw control-UI config editor.
 *
 * Without this, `snowLumaPlugin.configSchema` is `undefined` and the host falls
 * back to a raw/unsupported node for every section (Accounts, Quote, Receive,
 * Reconnect, Tools) instead of rendering real form fields. The shapes below are
 * plain JSON Schema literals — only `type`/`properties`/`items`/`enum`/
 * `additionalProperties`/`anyOf`-of-scalars, which is what the control-UI's
 * schema-to-form renderer understands (see
 * node_modules/openclaw/dist/control-ui/assets/index-*.js, the `cfg-field`
 * renderer). No `$ref`/`allOf`/`oneOf`-of-objects/`patternProperties` — the
 * renderer falls back to "Unsupported schema node" for those.
 *
 * Kept in sync with the shape of `SnowLumaAccountConfig`/`SnowLumaChannelConfig`
 * in `types.ts` and the defaults `config.ts` actually applies
 * (`RECEIVE_DEFAULTS`, `QUOTE_DEFAULTS`, `resolveSnowLumaAccount`).
 *
 * Type-only on purpose: `ChannelConfigSchema`/`ChannelConfigUiHint` are erased
 * at compile time, same as every other `openclaw` import in this plugin — see
 * the "no openclaw/* runtime import" hard constraint in CLAUDE.md and
 * src/plugin-entry.ts / src/tools.ts for the established pattern.
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
/**
 * `ChannelConfigSchema` lost its public plugin-SDK export when the root
 * `openclaw/plugin-sdk` barrel was removed (openclaw 2026.8.1); derive it from
 * the one place it is still reachable — the channel plugin contract itself.
 */
type ChannelConfigSchema = NonNullable<ChannelPlugin["configSchema"]>;
export declare const snowLumaConfigSchema: ChannelConfigSchema;
export {};
//# sourceMappingURL=config-schema.d.ts.map