// MapForge DSL：模型只出 6 个枚举字段，几何由本地文法生成。
// scene := arch "/" size "/" palette "/" light "/" features "/" focus

export const ARCHES = Object.freeze([
  "bedroom", "study", "kitchen", "living", "entry", "balcony", "shop", "park",
]);
export const SIZES = Object.freeze({ s: [24, 18], m: [28, 21], l: [32, 24] });
export const PALETTES = Object.freeze(["warm_wood", "cool_plaster", "green_outdoor"]);
export const LIGHTS = Object.freeze(["dawn", "day", "dusk", "night", "rain", "snow", "rain_dusk"]);
export const FEATURES = Object.freeze([
  "old_books", "window_seat", "dust_motes", "fresh_flowers", "laundry",
  "rain_sound", "warm_lamp", "clutter", "open_window", "street_noise",
  "morning_light", "cat_corner",
]);

const FOCUS_BY_ARCH = {
  bedroom: ["bed", "wardrobe", "lamp", "shelf", "chair"],
  study: ["desk", "bookshelf", "chair", "lamp", "shelf"],
  kitchen: ["counter", "stove", "fridge", "table", "chair"],
  living: ["sofa", "tv", "table", "lamp", "shelf"],
  entry: ["shelf", "plant", "lamp", "chair"],
  balcony: ["chair", "plant", "table", "bench", "lamp"],
  shop: ["counter", "shelf", "plant", "lamp"],
  park: ["bench", "plant_big", "plant", "lamp"],
};

export function parseDsl(input) {
  const raw = String(input || "").trim();
  const parts = raw.split("/");
  if (parts.length !== 6) return { ok: false, reason: "dsl_fields" };
  const [arch, size, palette, light, featureText, focus] = parts;
  if (!ARCHES.includes(arch)) return { ok: false, reason: "dsl_arch" };
  if (!SIZES[size]) return { ok: false, reason: "dsl_size" };
  if (!PALETTES.includes(palette)) return { ok: false, reason: "dsl_palette" };
  if (!LIGHTS.includes(light)) return { ok: false, reason: "dsl_light" };
  const features = featureText
    ? featureText.split("+").map((s) => s.trim()).filter(Boolean)
    : [];
  if (features.length > 3 || features.some((f) => !FEATURES.includes(f))) {
    return { ok: false, reason: "dsl_features" };
  }
  if (focus && !FOCUS_BY_ARCH[arch]?.includes(focus)) {
    return { ok: false, reason: "dsl_focus" };
  }
  return {
    ok: true,
    dsl: raw,
    arch,
    size,
    palette,
    light,
    features,
    focus: focus || FOCUS_BY_ARCH[arch]?.[0] || null,
  };
}

export function isDsl(input) {
  return typeof input === "string" && input.split("/").length === 6;
}
