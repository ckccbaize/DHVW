// L1 零 token 路径：剧情文本 → MapForge DSL。
// 词表是数据文件；这里只做计数与一致性选择。

export function deriveScene(text, lexicon) {
  const source = String(text || "");
  if (!source || !lexicon) return { ok: false, reason: "empty" };
  const score = (table) => {
    const hits = [];
    for (const [key, words] of Object.entries(table || {})) {
      let n = 0;
      for (const w of words || []) if (source.includes(w)) n += 1;
      if (n) hits.push([key, n]);
    }
    hits.sort((a, b) => b[1] - a[1]);
    return hits;
  };
  const archHits = score(lexicon.arch);
  if (!archHits.length) return { ok: false, reason: "no_arch" };
  const [arch, archScore] = archHits[0];
  const lightHits = score(lexicon.light);
  const light = lightHits.find(([k]) => k === "rain" || k === "snow")?.[0] || lightHits[0]?.[0] || "day";
  const featureHits = score(lexicon.features).slice(0, 2).map(([k]) => k);
  const focus = lexicon.focus?.[arch]?.[0] || null;
  const size = /大|宽敞|开阔/.test(source) ? "l" : /小|窄|角落/.test(source) ? "s" : "m";
  const palette = arch === "park" ? "green_outdoor" : arch === "study" || arch === "bedroom" ? "warm_wood" : "cool_plaster";
  const dsl = `${arch}/${size}/${palette}/${light}/${featureHits.join("+")}/${focus || ""}`;
  const confidence = (archScore > 0 ? 1 : 0) + (lightHits.length ? 1 : 0) + (featureHits.length ? 1 : 0);
  return { ok: true, dsl, arch, light, features: featureHits, focus, confidence: confidence / 3 };
}
