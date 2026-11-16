import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
export interface DefineChannelPluginEntryOptions<TPlugin> {
    id: string;
    name: string;
    description: string;
    plugin: TPlugin;
    configSchema?: unknown | (() => unknown);
    setRuntime?: (runtime: PluginRuntime) => void;
    registerCliMetadata?: (api: OpenClawPluginApi) => void;
    registerFull?: (api: OpenClawPluginApi) => void;
    /** Added in openclaw 2026.8.1; runs in tool-discovery, discovery and full modes. */
    registerCapabilities?: (api: OpenClawPluginApi) => void;
}
export interface DefinedChannelPluginEntry<TPlugin> {
    id: string;
    name: string;
    description: string;
    configSchema: unknown;
    register: (api: OpenClawPluginApi) => void;
    channelPlugin: TPlugin;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
}
/** Verbatim port of `openclaw/plugin-sdk/core`'s `defineChannelPluginEntry`. */
export declare function defineChannelPluginEntry<TPlugin>(options: DefineChannelPluginEntryOptions<TPlugin>): DefinedChannelPluginEntry<TPlugin>;
//# sourceMappingURL=plugin-entry.d.ts.map