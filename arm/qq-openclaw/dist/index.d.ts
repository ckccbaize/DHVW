declare const entry: import("./src/plugin-entry.js").DefinedChannelPluginEntry<import("openclaw/plugin-sdk/channel-core").ChannelPlugin<import("./src/types.js").ResolvedSnowLumaAccount>>;
export default entry;
export { snowLumaPlugin } from "./src/channel.js";
export { clearSnowLumaRuntime, getSnowLumaRuntime, setSnowLumaRuntime, tryGetSnowLumaRuntime } from "./src/runtime.js";
export * from "./src/types.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
//# sourceMappingURL=index.d.ts.map