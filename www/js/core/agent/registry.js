// Agent 注册表（W12）：加载构建期打包的 skills / prompts，提供模板渲染。
// 源文件在 agent/，产物 www/agent/registry.json（tools/build-agent.mjs）。

export function createRegistryFromData(data) {
  const skills = data?.skills || {};
  const prompts = data?.prompts || {};
  return {
    get loaded() {
      return true;
    },
    getSkill(name) {
      return skills[name] || null;
    },
    getPrompt(name) {
      return Object.prototype.hasOwnProperty.call(prompts, name) ? prompts[name] : null;
    },
    render(name, vars = {}) {
      const tpl = prompts[name];
      if (tpl === undefined) throw new Error(`未知 prompt: ${name}`);
      return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
        if (!(key in vars)) throw new Error(`prompt "${name}" 缺少变量 "${key}"`);
        return String(vars[key]);
      });
    },
    list() {
      return Object.keys(skills).map((name) => ({ name, ...skills[name] }));
    },
    stats() {
      return {
        loaded: true,
        version: data?.version || 0,
        skills: Object.keys(skills).length,
        prompts: Object.keys(prompts).length,
      };
    },
  };
}

export function createAgentRegistry({
  url = new URL("../../../agent/registry.json", import.meta.url),
  fetchImpl = globalThis.fetch,
} = {}) {
  let inner = null;

  function requireLoaded() {
    if (!inner) throw new Error("agent registry 未加载");
    return inner;
  }

  return {
    async load() {
      const res = await fetchImpl(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`agent registry 加载失败: ${res.status}`);
      inner = createRegistryFromData(await res.json());
      return inner.stats();
    },
    get loaded() {
      return !!inner;
    },
    getSkill: (name) => requireLoaded().getSkill(name),
    getPrompt: (name) => requireLoaded().getPrompt(name),
    render: (name, vars) => requireLoaded().render(name, vars),
    list: () => requireLoaded().list(),
    stats: () => (inner ? inner.stats() : { loaded: false, skills: 0, prompts: 0, version: 0 }),
  };
}
