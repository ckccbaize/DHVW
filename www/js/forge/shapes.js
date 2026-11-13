// 家具形状 DSL（W31+）：模型只写 JSON，不写代码。
// 坐标是 16px 格子内的局部像素；两端（Python/JS）解释同一份 shapes。

export const SHAPE_OPS = new Set(["rect", "line", "outline", "shadow", "pixel"]);

export function validateFurnitureDef(def) {
  if (!def || typeof def !== "object" || Array.isArray(def)) return "not_object";
  if (!Array.isArray(def.size) || def.size.length !== 2) return "bad_size";
  if (!def.size.every((n) => Number.isInteger(n) && n >= 1 && n <= 6)) return "bad_size";
  if (!Array.isArray(def.shapes) || !def.shapes.length) return "bad_shapes";
  for (const s of def.shapes) {
    if (!s || typeof s !== "object" || !SHAPE_OPS.has(s.op)) return `bad_op:${s?.op}`;
    if (!Array.isArray(s.color) || s.color.length < 3 || s.color.length > 4) return "bad_color";
    if (s.color.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) return "bad_color";
    if (s.op === "rect" || s.op === "outline" || s.op === "shadow") {
      if (![s.x, s.y, s.w, s.h].every(Number.isFinite) || s.w <= 0 || s.h <= 0) return "bad_rect";
    }
    if (s.op === "line") {
      if (![s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) return "bad_line";
    }
    if (s.op === "pixel" && ![s.x, s.y].every(Number.isFinite)) return "bad_pixel";
  }
  return null;
}

function put(cv, x, y, c) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  cv.data[i] = c[0];
  cv.data[i + 1] = c[1];
  cv.data[i + 2] = c[2];
  cv.data[i + 3] = c[3] ?? 255;
}

function rect(cv, x, y, w, h, c) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(cv, xx, yy, c);
}

function line(cv, x1, y1, x2, y2, c) {
  let dx = Math.abs(x2 - x1);
  let dy = -Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1;
  const sy = y1 < y2 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    put(cv, x1, y1, c);
    if (x1 === x2 && y1 === y2) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x1 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y1 += sy;
    }
  }
}

/** 在 (px,py) 处绘制一个自定义家具定义。 */
export function drawFurnitureDef(cv, def, px, py) {
  for (const s of def.shapes) {
    const c = s.color;
    if (s.op === "rect") rect(cv, px + s.x, py + s.y, s.w, s.h, c);
    else if (s.op === "line") line(cv, px + s.x1, py + s.y1, px + s.x2, py + s.y2, c);
    else if (s.op === "outline") {
      const x = px + s.x;
      const y = py + s.y;
      for (let xx = x; xx < x + s.w; xx++) {
        put(cv, xx, y, c);
        put(cv, xx, y + s.h - 1, c);
      }
      for (let yy = y; yy < y + s.h; yy++) {
        put(cv, x, yy, c);
        put(cv, x + s.w - 1, yy, c);
      }
    } else if (s.op === "shadow") rect(cv, px + s.x + 2, py + s.y + 2, s.w, s.h, c);
    else if (s.op === "pixel") put(cv, px + s.x, py + s.y, c);
  }
}
