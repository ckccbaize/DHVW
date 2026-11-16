/** The SDK's default entry config schema: plugin-level config (`plugins.entries.<id>`) must be empty. */
function emptyChannelConfigSchema() {
    return {
        schema: { type: "object", additionalProperties: false, properties: {} },
        runtime: {
            safeParse(value) {
                if (value === undefined)
                    return { success: true, data: undefined };
                if (!value || typeof value !== "object" || Array.isArray(value)) {
                    return { success: false, issues: [{ path: [], message: "expected config object" }] };
                }
                if (Object.keys(value).length > 0) {
                    return { success: false, issues: [{ path: [], message: "config must be empty" }] };
                }
                return { success: true, data: value };
            },
        },
    };
}
/** `createCachedLazyValueGetter` — resolve once on first read, then memoize. */
function createCachedLazyValueGetter(value) {
    let resolved = false;
    let cached;
    return () => {
        if (!resolved) {
            cached = typeof value === "function" ? value() : value;
            resolved = true;
        }
        return cached;
    };
}
/** Verbatim port of `openclaw/plugin-sdk/core`'s `defineChannelPluginEntry`. */
export function defineChannelPluginEntry(options) {
    const { id, name, description, plugin, configSchema, setRuntime, registerCliMetadata, registerFull, registerCapabilities, } = options;
    // Lazy + cached, exactly like the SDK: a plugin may hand in a factory whose
    // cost should not be paid at load time, and the host reads `configSchema`
    // through a getter.
    const getConfigSchema = createCachedLazyValueGetter(configSchema ?? emptyChannelConfigSchema);
    return {
        id,
        name,
        description,
        get configSchema() {
            return getConfigSchema();
        },
        register(api) {
            if (api.registrationMode === "cli-metadata") {
                registerCliMetadata?.(api);
                return;
            }
            if (api.registrationMode === "tool-discovery") {
                registerFull?.(api);
                registerCapabilities?.(api);
                return;
            }
            api.registerChannel({ plugin: plugin });
            setRuntime?.(api.runtime);
            if (api.registrationMode === "discovery") {
                registerCliMetadata?.(api);
                registerCapabilities?.(api);
                return;
            }
            if (api.registrationMode !== "full")
                return;
            registerCliMetadata?.(api);
            registerFull?.(api);
            registerCapabilities?.(api);
        },
        channelPlugin: plugin,
        ...(setRuntime ? { setChannelRuntime: setRuntime } : {}),
    };
}
//# sourceMappingURL=plugin-entry.js.map