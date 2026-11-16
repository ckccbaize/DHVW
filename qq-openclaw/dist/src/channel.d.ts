/**
 * The `ChannelPlugin<ResolvedSnowLumaAccount>` surface the OpenClaw host binds
 * against — config resolution, setup wizard wiring, outbound sending, the
 * shared `message` tool's `react` action, agent tools, gateway lifecycle, and
 * status snapshots. Modelled closely on the OneBot reference plugin, but every
 * adapter shape here was checked against this repo's installed
 * `openclaw/plugin-sdk` `.d.ts` files rather than copied blind.
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedSnowLumaAccount } from "./types.js";
export declare const snowLumaPlugin: ChannelPlugin<ResolvedSnowLumaAccount>;
//# sourceMappingURL=channel.d.ts.map