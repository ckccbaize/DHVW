"""角色 4 向行走图本地程序化动作扩展器。

输入一张 4×4 角色行走图（支持白底/纯色底 JPG/PNG 或透明底 PNG），自动完成：
1. 智能 4×4 切帧、泛洪去背（可选清理闭合白底空隙）、亮边清理、居中与脚底锚点对齐；
2. AI 方向纠错机制（自动识别行序、单帧镜像纠偏、整行对调/镜像、跨向错帧修复）+ 手动单帧镜像兜底；
3. 本地程序化生成全套生活与办公动作（idle / walk / sit / sleep / read / play_cat /
   water_plants / cook / eat / drink / bathe / wash_up / work / watch_tv / rest / ...），
   并支持根据场景 interactions.json 里的自定义动作名自动映射扩展；
4. 输出标准 sheet.png + sheet.json + 22 动作一览预览图，并可自动写入场景包 dist/character/
   与刷新 manifest.json 校验和。
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

DIRS = ["N", "S", "E", "W"]

ANIM_ORDER = [
    "bathe", "cook", "dress", "drink", "eat", "hang_coat", "idle",
    "laundry", "meet", "play_cat", "print", "read", "rest", "sit",
    "sleep", "tidy", "use_toilet", "walk", "wash_up", "watch_tv",
    "water_plants", "work",
]

ROW_ORDER_PRESETS: dict[str, list[str]] = {
    "S,W,E,N": ["S", "W", "E", "N"],
    "N,S,E,W": ["N", "S", "E", "W"],
    "S,N,E,W": ["S", "N", "E", "W"],
    "S,E,W,N": ["S", "E", "W", "N"],
    "N,E,S,W": ["N", "E", "S", "W"],
}


def parse_row_order(order: str | None) -> list[str] | None:
    """解析任意 4 向行序（如 'S,W,E,N'、'N,W,E,S' 等 24 种排列）。"""
    if not order or order == "auto":
        return None
    if order in ROW_ORDER_PRESETS:
        return list(ROW_ORDER_PRESETS[order])
    parts = [p.strip().upper() for p in str(order).split(",") if p.strip()]
    if len(parts) == 4 and set(parts) == {"N", "S", "E", "W"}:
        return parts
    return None

PAL = {
    "#": (26, 26, 46, 255),
    "w": (250, 250, 245, 255),
    "g": (210, 218, 230, 255),
    "b": (88, 175, 245, 255),
    "c": (165, 225, 255, 255),
    "r": (245, 95, 130, 255),
    "p": (255, 170, 195, 255),
    "o": (235, 155, 75, 255),
    "y": (255, 220, 95, 255),
    "k": (135, 90, 55, 255),
}

HEART_5x5 = [
    ".#.#.",
    "#r#r#",
    "#rrr#",
    ".#r#.",
    "..#..",
]
NOTE_5x6 = [
    "..###",
    "..#y#",
    "..#..",
    ".##..",
    "#y#..",
    ".#...",
]
BOOK_9x6 = [
    ".###.###.",
    "#kww#wwk#",
    "#kwg#gwk#",
    "#kww#wwk#",
    ".###.###.",
    ".........",
]
MUG_6x6 = [
    ".####.",
    "#wwww#",
    "#wggw#",
    "#wwww#",
    ".####.",
    "......",
]
CAN_8x6 = [
    "...###..",
    "##.#b#..",
    ".###bb#.",
    "..#bbb#.",
    "..#####.",
    "........",
]
CAT_9x7 = [
    ".#...#...",
    "#o###o#..",
    "#owowo#..",
    ".#####...",
    ".#ooo##..",
    ".#oooo#..",
    "..####.#.",
]
Z_BIG = [
    "cccc",
    "..c.",
    ".c..",
    "cccc",
]
Z_SMALL = [
    "ccc",
    ".c.",
    "ccc",
]
BUBBLE_4x4 = [
    ".##.",
    "#cw#",
    "#bb#",
    ".##.",
]


def _draw_sprite(canvas: Image.Image, x: int, y: int, pattern: list[str], sx_scale: float = 1.0) -> None:
    arr = np.array(canvas)
    h, w, _ = arr.shape
    for dy, row in enumerate(pattern):
        py = int(round(y + dy * sx_scale))
        if not (0 <= py < h):
            continue
        for dx, ch in enumerate(row):
            px = int(round(x + dx * sx_scale))
            if ch != "." and 0 <= px < w and ch in PAL:
                arr[py, px] = PAL[ch]
    canvas.paste(Image.fromarray(arr, "RGBA"), (0, 0))


def _remove_bg_clean(patch: np.ndarray, has_alpha: bool, clean_inner_white: bool = True) -> np.ndarray:
    """将单格人物区域提取为干净透明背景 RGBA。支持透明底 PNG 或纯色/白底图。"""
    h, w, _ = patch.shape
    if has_alpha:
        alpha = patch[:, :, 3]
        border_alpha = np.concatenate([alpha[0, :], alpha[-1, :], alpha[:, 0], alpha[:, -1]])
        if (border_alpha < 32).mean() > 0.35:
            rgba = patch.copy()
            rgba[:, :, 3] = np.where(alpha >= 128, 255, 0)
            return rgba

    rgb = patch[:, :, :3]
    corners = np.array([rgb[0, 0], rgb[0, -1], rgb[-1, 0], rgb[-1, -1]], dtype=np.float32)
    bg_color = np.median(corners, axis=0)
    is_white_bg = float(bg_color.min()) >= 220.0

    padded = np.zeros((h + 2, w + 2, 3), dtype=np.float32)
    padded[1:-1, 1:-1] = rgb.astype(np.float32)
    padded[0, :] = bg_color
    padded[-1, :] = bg_color
    padded[:, 0] = bg_color
    padded[:, -1] = bg_color

    if is_white_bg:
        is_bg_cand = padded.min(axis=2) >= 232
    else:
        dist = np.linalg.norm(padded - bg_color, axis=2)
        is_bg_cand = dist <= 32.0

    labeled, _ = ndimage.label(is_bg_cand)
    bg_label = labeled[0, 0]
    bg_mask = (labeled == bg_label)[1:-1, 1:-1]

    # 清理双马尾/手臂与躯干围合形成的闭合纯白底空隙（高均匀度 + 大面积闭合白块）
    if is_white_bg and clean_inner_white:
        inner_cand = (~bg_mask) & (rgb.min(axis=2) >= 242)
        in_labeled, n_comp = ndimage.label(inner_cand)
        min_pocket_area = max(36, int(h * w * 0.005))
        for cid in range(1, n_comp + 1):
            comp = in_labeled == cid
            area = int(comp.sum())
            if area < min_pocket_area:
                continue
            vals = rgb[comp].astype(np.float32)
            # 闭合背景空隙通常非常平纯亮白（均值 >= 249 且标准差很低）
            if float(vals.mean()) >= 248.5 and float(vals.std()) <= 5.0:
                bg_mask |= comp

    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb
    rgba[:, :, 3] = np.where(bg_mask, 0, 255)

    if is_white_bg:
        for _ in range(2):
            a = rgba[:, :, 3] > 0
            eroded = ndimage.binary_erosion(a, structure=np.ones((3, 3)))
            border = a & (~eroded)
            lum = rgb.mean(axis=2)
            sat = rgb.max(axis=2).astype(int) - rgb.min(axis=2).astype(int)
            fringe = border & (lum > 145) & (sat < 45)
            if not fringe.any():
                break
            rgba[fringe, 3] = 0
    return rgba


def _foreground_mask(arr: np.ndarray, has_alpha: bool) -> np.ndarray:
    if has_alpha:
        alpha = arr[:, :, 3]
        border_alpha = np.concatenate([alpha[0, :], alpha[-1, :], alpha[:, 0], alpha[:, -1]])
        if (border_alpha < 32).mean() > 0.35:
            return alpha >= 64
    rgb = arr[:, :, :3]
    corners = np.array([rgb[0, 0], rgb[0, -1], rgb[-1, 0], rgb[-1, -1]], dtype=np.float32)
    bg_color = np.median(corners, axis=0)
    if float(bg_color.min()) >= 220.0:
        return rgb.min(axis=2) < 232
    return np.linalg.norm(rgb.astype(np.float32) - bg_color, axis=2) > 32.0


def extract_4x4_raw_rows(im: Image.Image, clean_inner_white: bool = True) -> list[list[Image.Image]]:
    """从 4×4 行走图中按行切出 4 行 × 4 帧透明背景图（保留原图行顺序 0..3）。"""
    has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
    rgba_im = im.convert("RGBA")
    arr = np.array(rgba_im)
    H, W, _ = arr.shape
    row_h = H // 4
    col_w = W // 4
    if row_h < 8 or col_w < 8:
        raise ValueError(f"输入图片尺寸过小：{W}×{H}")

    fg_all = _foreground_mask(arr, has_alpha)
    raw_rows: list[list[Image.Image]] = []

    for r in range(4):
        y0 = r * row_h
        y1 = (r + 1) * row_h if r < 3 else H
        sub_arr = arr[y0:y1]
        sub_fg = fg_all[y0:y1]

        col_has = sub_fg.any(axis=0)
        labeled, _ = ndimage.label(col_has)
        min_seg_w = max(4, W // 40)
        segs = [sl[0] for sl in ndimage.find_objects(labeled) if sl[0].stop - sl[0].start >= min_seg_w]

        if len(segs) != 4:
            segs = [slice(c * col_w, (c + 1) * col_w if c < 3 else W) for c in range(4)]

        row_frames: list[Image.Image] = []
        for s in segs:
            x0 = max(0, s.start - 4)
            x1 = min(W, s.stop + 4)
            patch = sub_arr[:, x0:x1]
            cleaned = _remove_bg_clean(patch, has_alpha, clean_inner_white=clean_inner_white)
            ys, xs = np.where(cleaned[:, :, 3] > 0)
            if len(ys) == 0:
                row_frames.append(Image.new("RGBA", (max(1, x1 - x0), max(1, y1 - y0)), (0, 0, 0, 0)))
            else:
                crop = cleaned[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
                row_frames.append(Image.fromarray(crop, "RGBA"))
        raw_rows.append(row_frames)
    return raw_rows


def extract_4x4_frames(
    im: Image.Image, row_order: str = "S,W,E,N", clean_inner_white: bool = True
) -> dict[str, list[Image.Image]]:
    raw_rows = extract_4x4_raw_rows(im, clean_inner_white=clean_inner_white)
    order_list = parse_row_order(row_order) or ROW_ORDER_PRESETS["S,W,E,N"]
    return {d: raw_rows[i] for i, d in enumerate(order_list)}


def _normalize_row(frames: list[Image.Image], scale: float, fw: int, fh: int, anchor_y: int) -> list[Image.Image]:
    out_row: list[Image.Image] = []
    for f in frames:
        if f.getbbox() is None:
            out_row.append(Image.new("RGBA", (fw, fh), (0, 0, 0, 0)))
            continue
        nw = max(1, int(round(f.width * scale)))
        nh = max(1, int(round(f.height * scale)))
        resized = f.resize((nw, nh), Image.Resampling.NEAREST)
        ra = np.array(resized)
        ra[:, :, 3] = np.where(ra[:, :, 3] >= 128, 255, 0)
        a = ra[:, :, 3] > 0
        neighbors = ndimage.convolve(a.astype(int), np.ones((3, 3), dtype=int), mode="constant") - a.astype(int)
        ra[a & (neighbors == 0), 3] = 0

        canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
        ox = (fw - nw) // 2
        oy = anchor_y - nh + 1
        tile = Image.fromarray(ra, "RGBA")
        canvas.paste(tile, (ox, oy), tile)
        out_row.append(canvas)
    return out_row


def _normalize_frames(
    frames_by_dir: dict[str, list[Image.Image]], fw: int, fh: int
) -> dict[str, list[Image.Image]]:
    non_empty = [f for d in DIRS for f in frames_by_dir[d] if f.getbbox() is not None]
    if not non_empty:
        raise ValueError("未能从输入图中提取到有效角色前景，请确认图片为 4×4 网格且背景干净")

    max_h = max(f.height for f in non_empty)
    max_w = max(f.width for f in non_empty)
    pad_x = 2 if fw >= 24 else 1
    pad_y = 4 if fh >= 36 else 2
    anchor_y = fh - 2 if fh >= 36 else fh - 1
    scale = min((fw - pad_x) / max_w, (fh - pad_y) / max_h)
    return {d: _normalize_row(frames_by_dir[d], scale, fw, fh, anchor_y) for d in DIRS}


def _frame_sim(a: np.ndarray, b: np.ndarray) -> float:
    a_fg = a[:, :, 3] > 0
    b_fg = b[:, :, 3] > 0
    inter = a_fg & b_fg
    union = int((a_fg | b_fg).sum())
    if union == 0 or not inter.any():
        return 0.0
    iou = float(inter.sum()) / float(union)
    col_diff = float(np.abs(a[inter, :3].astype(np.float32) - b[inter, :3].astype(np.float32)).mean()) / 255.0
    return iou * (1.0 - col_diff)


def _flip_h_arr(a: np.ndarray) -> np.ndarray:
    return a[:, ::-1, :]


def _frame_cues(arr: np.ndarray) -> dict[str, Any]:
    """提取单帧的左右对称度、正/背判别得分与面部相对躯干的水平偏移。"""
    a = arr[:, :, 3] > 0
    if not a.any():
        return {"sym": 1.0, "face_px": 0, "front_score": 0.0, "face_dx": None}
    sym = _frame_sim(arr, _flip_h_arr(arr))
    ys, xs = np.where(a)
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    h = max(1, y1 - y0 + 1)
    w = max(1, x1 - x0 + 1)
    cx = (x0 + x1) // 2

    hy0 = y0 + int(h * 0.18)
    hy1 = y0 + int(h * 0.48)
    head_rgb = arr[hy0:hy1, :, :3].astype(np.float32)
    head_a = a[hy0:hy1]
    lum = head_rgb.mean(axis=2)
    warm = (
        (head_rgb[:, :, 0] >= head_rgb[:, :, 1] - 2.0)
        & (head_rgb[:, :, 0] >= head_rgb[:, :, 2] + 8.0)
        & (lum > 165.0)
        & head_a
    )
    face_px = int(warm.sum())
    face_dx: float | None = None
    if face_px >= 3:
        wxs = np.where(warm)[1]
        ty0 = y0 + int(h * 0.48)
        ty1 = y0 + int(h * 0.85)
        txs = np.where(a[ty0:ty1])[1]
        torso_cx = float(txs.mean()) if len(txs) else (x0 + x1) / 2.0
        face_dx = float(wxs.mean()) - torso_cx

    # 正/背判别得分：面部中心区的双眼边缘梯度 + 与头顶发色差异 + 亮度对比度。
    # 浅色/暖色头发角色背面整片发色都会命中 warm，不能靠暖色像素数判正反。
    fw_r = max(3, int(w * 0.25))
    fx0 = max(0, cx - fw_r)
    fx1 = min(arr.shape[1], cx + fw_r + 1)
    fy0 = y0 + int(h * 0.20)
    fy1 = min(arr.shape[0], y0 + int(h * 0.48))
    front_score = 0.0
    if fy1 > fy0 and fx1 > fx0:
        pa = a[fy0:fy1, fx0:fx1]
        if pa.any():
            f_rgb = arr[fy0:fy1, fx0:fx1, :3].astype(np.float32)
            f_lum = f_rgb.mean(axis=2)
            gy = float(np.abs(f_lum[1:, :] - f_lum[:-1, :]).mean()) if f_lum.shape[0] > 1 else 0.0
            gx = float(np.abs(f_lum[:, 1:] - f_lum[:, :-1]).mean()) if f_lum.shape[1] > 1 else 0.0
            lstd = float(f_lum[pa].std())
            sy0 = y0 + int(h * 0.08)
            sy1 = min(arr.shape[0], y0 + int(h * 0.20))
            hair_diff = 0.0
            if sy1 > sy0:
                sa = a[sy0:sy1, fx0:fx1]
                if sa.any():
                    hair_col = np.median(arr[sy0:sy1, fx0:fx1, :3].astype(np.float32)[sa], axis=0)
                    hair_diff = float(np.linalg.norm(f_rgb[pa] - hair_col, axis=1).mean())
            front_score = (gx + gy) + hair_diff * 0.8 + lstd * 0.6

    return {"sym": sym, "face_px": face_px, "front_score": front_score, "face_dx": face_dx}


def _recenter_flipped(im: Image.Image) -> Image.Image:
    """对单帧图水平镜像后按脚底居中对齐，保持锚点严格一致。"""
    flipped = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    arr = np.array(flipped)
    ys, xs = np.where(arr[:, :, 3] > 0)
    if len(ys) == 0:
        return flipped
    fw, fh = im.size
    crop = flipped.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    anchor_y = fh - 2 if fh >= 36 else fh - 1
    canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    ox = (fw - crop.width) // 2
    oy = anchor_y - crop.height + 1
    canvas.paste(crop, (ox, oy), crop)
    return canvas


def _unify_side_row(arrs: list[np.ndarray], imgs: list[Image.Image], label: str) -> tuple[list[np.ndarray], list[Image.Image], list[str]]:
    """对侧向行（4 帧）做同行一致纠偏：若某帧水平镜像后与同行其他帧更匹配，则自动翻转。"""
    notes: list[str] = []
    out_arrs = list(arrs)
    out_imgs = list(imgs)
    for _ in range(2):
        changed = False
        for i in range(len(out_arrs)):
            same_s = float(np.mean([_frame_sim(out_arrs[i], out_arrs[j]) for j in range(len(out_arrs)) if j != i]))
            flip_s = float(np.mean([_frame_sim(_flip_h_arr(out_arrs[i]), out_arrs[j]) for j in range(len(out_arrs)) if j != i]))
            if flip_s > same_s + 0.06:
                out_imgs[i] = _recenter_flipped(out_imgs[i])
                out_arrs[i] = np.array(out_imgs[i])
                notes.append(f"{label} 第 {i + 1} 帧朝向与同行相反，已自动水平镜像纠偏")
                changed = True
        if not changed:
            break
    return out_arrs, out_imgs, notes


def detect_and_fix_directions(
    raw_rows: list[list[Image.Image]],
    *,
    row_order: str = "auto",
    auto_fix_dir: bool = True,
    manual_flips: dict[str, list[bool]] | None = None,
    fw: int = 32,
    fh: int = 48,
) -> tuple[dict[str, list[Image.Image]], str, list[str]]:
    """将 4 行原图映射并归一化到 N/S/E/W，自动检测并修正 AI 生成的方向错误。

    返回: (norm_by_dir, detected_row_order_str, corrections)
    """
    non_empty = [f for row in raw_rows for f in row if f.getbbox() is not None]
    if not non_empty:
        raise ValueError("未能从输入图中提取到有效角色前景，请确认图片为 4×4 网格且背景干净")

    max_h = max(f.height for f in non_empty)
    max_w = max(f.width for f in non_empty)
    pad_x = 2 if fw >= 24 else 1
    pad_y = 4 if fh >= 36 else 2
    anchor_y = fh - 2 if fh >= 36 else fh - 1
    scale = min((fw - pad_x) / max_w, (fh - pad_y) / max_h)

    norm_rows = [_normalize_row(row, scale, fw, fh, anchor_y) for row in raw_rows]
    arr_rows = [[np.array(f) for f in row] for row in norm_rows]
    corrections: list[str] = []

    explicit_order = parse_row_order(row_order)
    if explicit_order is None:
        # 1. 自动识别每行对应的朝向（先看对称度区分 {N, S} vs {E, W}，再按眼部/面部对比度区分 S 正面 vs N 背面）
        row_stats = []
        for idx, row_a in enumerate(arr_rows):
            cues = [_frame_cues(a) for a in row_a]
            med_sym = float(np.median([c["sym"] for c in cues]))
            med_front = float(np.median([c["front_score"] for c in cues]))
            row_stats.append((idx, med_sym, med_front))

        by_sym = sorted(row_stats, key=lambda x: x[1], reverse=True)
        fb_pair = sorted(by_sym[:2], key=lambda x: x[2], reverse=True)
        s_idx = fb_pair[0][0]
        n_idx = fb_pair[1][0]
        # 若两行面部对比得分非常接近（如剪影/非人型），按位置靠前者优先为 S
        if abs(fb_pair[0][2] - fb_pair[1][2]) < 3.0:
            s_idx, n_idx = min(fb_pair[0][0], fb_pair[1][0]), max(fb_pair[0][0], fb_pair[1][0])

        side_indices = [by_sym[2][0], by_sym[3][0]]
        # 先把两行侧视图各自内部统一方向，再看面部偏移方向区分 W 与 E
        if auto_fix_dir:
            for s_i in side_indices:
                arr_rows[s_i], norm_rows[s_i], n_list = _unify_side_row(arr_rows[s_i], norm_rows[s_i], f"第 {s_i + 1} 行")
                corrections.extend(n_list)

        side_dxs: list[tuple[int, float]] = []
        for s_i in side_indices:
            dxs = [c["face_dx"] for c in (_frame_cues(a) for a in arr_rows[s_i]) if c["face_dx"] is not None]
            med_dx = float(np.median(dxs)) if dxs else ( -1.0 if s_i == side_indices[0] else 1.0 )
            side_dxs.append((s_i, med_dx))
        side_dxs.sort(key=lambda x: x[1])
        w_idx = side_dxs[0][0]
        e_idx = side_dxs[1][0]

        idx_to_dir = {n_idx: "N", s_idx: "S", e_idx: "E", w_idx: "W"}
        detected_order = ",".join(idx_to_dir[i] for i in range(4))
        by_dir = {"N": norm_rows[n_idx], "S": norm_rows[s_idx], "E": norm_rows[e_idx], "W": norm_rows[w_idx]}
        arr_by_dir = {"N": arr_rows[n_idx], "S": arr_rows[s_idx], "E": arr_rows[e_idx], "W": arr_rows[w_idx]}
    else:
        detected_order = ",".join(explicit_order)
        by_dir = {d: norm_rows[i] for i, d in enumerate(explicit_order)}
        arr_by_dir = {d: arr_rows[i] for i, d in enumerate(explicit_order)}
        if auto_fix_dir:
            for d in ("W", "E"):
                arr_by_dir[d], by_dir[d], n_list = _unify_side_row(arr_by_dir[d], by_dir[d], f"{d} 行")
                corrections.extend(n_list)

    if auto_fix_dir:
        # 2. 处理侧向 2-vs-2 平局与整行朝向颠倒/同向问题
        for d in ("W", "E"):
            opp = "E" if d == "W" else "W"
            desired_sign = -1.0 if d == "W" else 1.0
            for i in range(4):
                cue = _frame_cues(arr_by_dir[d][i])
                dx = cue["face_dx"]
                if dx is not None and dx * desired_sign < -2.5:
                    opp_same = float(np.mean([_frame_sim(arr_by_dir[d][i], g) for g in arr_by_dir[opp]]))
                    opp_flip = float(np.mean([_frame_sim(_flip_h_arr(arr_by_dir[d][i]), g) for g in arr_by_dir[opp]]))
                    same_in = float(np.mean([_frame_sim(arr_by_dir[d][i], arr_by_dir[d][j]) for j in range(4) if j != i]))
                    flip_in = float(np.mean([_frame_sim(_flip_h_arr(arr_by_dir[d][i]), arr_by_dir[d][j]) for j in range(4) if j != i]))
                    # 若在同向行里处于平局或少数，且确实朝向对侧
                    if opp_same > opp_flip + 0.05 and flip_in >= same_in - 0.05:
                        by_dir[d][i] = _recenter_flipped(by_dir[d][i])
                        arr_by_dir[d][i] = np.array(by_dir[d][i])
                        corrections.append(f"{d} 行第 {i + 1} 帧朝向与对侧一致，已自动水平镜像纠偏")

        w_dxs = [c["face_dx"] for c in (_frame_cues(a) for a in arr_by_dir["W"]) if c["face_dx"] is not None]
        e_dxs = [c["face_dx"] for c in (_frame_cues(a) for a in arr_by_dir["E"]) if c["face_dx"] is not None]
        w_med = float(np.median(w_dxs)) if w_dxs else None
        e_med = float(np.median(e_dxs)) if e_dxs else None

        if w_med is not None and e_med is not None:
            if w_med > 2.0 and e_med < -2.0:
                # 整行 W 和 E 互换了
                by_dir["W"], by_dir["E"] = by_dir["E"], by_dir["W"]
                arr_by_dir["W"], arr_by_dir["E"] = arr_by_dir["E"], arr_by_dir["W"]
                corrections.append("检测到 W 行与 E 行整体朝向互反，已自动对调")
            elif w_med > 2.0 and e_med > 2.0:
                by_dir["W"] = [_recenter_flipped(f) for f in by_dir["W"]]
                arr_by_dir["W"] = [np.array(f) for f in by_dir["W"]]
                corrections.append("检测到 W 行与 E 行均朝右，已自动将 W 行整行水平镜像为朝左")
            elif w_med < -2.0 and e_med < -2.0:
                by_dir["E"] = [_recenter_flipped(f) for f in by_dir["E"]]
                arr_by_dir["E"] = [np.array(f) for f in by_dir["E"]]
                corrections.append("检测到 E 行与 W 行均朝左，已自动将 E 行整行水平镜像为朝右")

        # 3. 跨方向离群错帧检测（如背面 N 行混入正面帧，或侧向行混入正/背面帧）
        for d in DIRS:
            in_sims = [
                float(np.mean([_frame_sim(arr_by_dir[d][i], arr_by_dir[d][j]) for j in range(4) if j != i]))
                for i in range(4)
            ]
            cues = [_frame_cues(a) for a in arr_by_dir[d]]
            for i in range(4):
                others_med = float(np.median([in_sims[j] for j in range(4) if j != i]))
                if others_med < 0.62:
                    continue
                best_od = None
                best_osim = 0.0
                for od in DIRS:
                    if od == d:
                        continue
                    osim = float(np.mean([_frame_sim(arr_by_dir[d][i], g) for g in arr_by_dir[od]]))
                    if osim > best_osim:
                        best_osim = osim
                        best_od = od
                is_cross_outlier = False
                if d in ("E", "W") and in_sims[i] < 0.42 and cues[i]["sym"] > 0.56 and best_osim > in_sims[i] + 0.12:
                    is_cross_outlier = True
                elif d == "N" and best_od == "S" and best_osim > in_sims[i] + 0.12:
                    row_front_med = float(np.median([cues[j]["front_score"] for j in range(4) if j != i]))
                    if cues[i]["front_score"] > row_front_med + 20.0:
                        is_cross_outlier = True
                elif d == "S" and best_od == "N" and best_osim > in_sims[i] + 0.12:
                    row_front_med = float(np.median([cues[j]["front_score"] for j in range(4) if j != i]))
                    if cues[i]["front_score"] + 20.0 < row_front_med:
                        is_cross_outlier = True

                if is_cross_outlier:
                    if d in ("E", "W"):
                        opp = "E" if d == "W" else "W"
                        opp_sim = float(np.mean([_frame_sim(arr_by_dir[opp][i], arr_by_dir[opp][j]) for j in range(4) if j != i]))
                        if opp_sim > 0.55:
                            by_dir[d][i] = _recenter_flipped(by_dir[opp][i])
                            arr_by_dir[d][i] = np.array(by_dir[d][i])
                            corrections.append(f"{d} 行第 {i + 1} 帧疑似错画为 {best_od} 朝向，已用对向帧镜像修复")
                            continue
                    # 用同向最匹配有效帧替换
                    valid_idx = max((j for j in range(4) if j != i), key=lambda j: in_sims[j])
                    by_dir[d][i] = by_dir[d][valid_idx].copy()
                    arr_by_dir[d][i] = np.array(by_dir[d][i])
                    corrections.append(f"{d} 行第 {i + 1} 帧疑似错画为 {best_od} 朝向，已用同行有效帧修复")

    # 4. 手动单帧水平镜像覆盖（用户若在 UI 里点某帧手动翻转）
    if manual_flips:
        for d in DIRS:
            flags = manual_flips.get(d)
            if isinstance(flags, list):
                for i in range(min(4, len(flags))):
                    if flags[i]:
                        by_dir[d][i] = _recenter_flipped(by_dir[d][i])

    return by_dir, detected_order, corrections


def _shift_frame(frame: Image.Image, dx: int, dy: int, fw: int, fh: int) -> Image.Image:
    canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    canvas.paste(frame, (dx, dy), frame)
    return canvas


def _make_sit_frame(base: Image.Image, dir_name: str, bob_y: int, fw: int, fh: int) -> Image.Image:
    arr = np.array(base)
    ys = np.where(arr[:, :, 3] > 0)[0]
    if len(ys) == 0:
        return base.copy()
    y_top, y_bot = int(ys.min()), int(ys.max())
    split_y = y_top + int((y_bot - y_top) * 0.72)

    upper = base.crop((0, 0, fw, split_y))
    lower = base.crop((0, split_y, fw, y_bot + 1))
    new_lh = max(2, int(round(lower.height * 0.58)))
    lower_sq = lower.resize((fw, new_lh), Image.Resampling.NEAREST)

    dx_leg = 1 if dir_name == "E" else (-1 if dir_name == "W" else 0)
    shift_down = max(2, fh // 12)
    canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    canvas.paste(lower_sq, (dx_leg, split_y + max(1, shift_down - 1)), lower_sq)
    canvas.paste(upper, (0, shift_down + bob_y), upper)
    return canvas


def _make_sleep_frame(base: Image.Image, dir_name: str, frame_idx: int, fw: int, fh: int) -> Image.Image:
    arr = np.array(base)
    ys, xs = np.where(arr[:, :, 3] > 0)
    if len(ys) == 0:
        return base.copy()
    tight = base.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    rot = tight.rotate(-90 if dir_name == "E" else 90, expand=True, resample=Image.Resampling.NEAREST)
    scale = min((fw - 2) / rot.width, (fh * 0.55) / rot.height, 1.0)
    nw = max(1, int(round(rot.width * scale)))
    nh = max(1, int(round(rot.height * scale)))
    rot = rot.resize((nw, nh), Image.Resampling.NEAREST)
    bob = 1 if frame_idx in (2, 3) else 0
    anchor_y = fh - 2 if fh >= 36 else fh - 1

    canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    ox = (fw - nw) // 2
    oy = anchor_y - nh + bob
    canvas.paste(rot, (ox, oy), rot)

    sx = fw / 32.0
    if fw >= 24:
        if frame_idx == 0:
            _draw_sprite(canvas, int(22 * sx), int(16 * sx), Z_SMALL)
        elif frame_idx == 1:
            _draw_sprite(canvas, int(23 * sx), int(12 * sx), Z_BIG)
        elif frame_idx == 2:
            _draw_sprite(canvas, int(21 * sx), int(15 * sx), Z_SMALL)
            _draw_sprite(canvas, int(25 * sx), int(8 * sx), Z_BIG)
        else:
            _draw_sprite(canvas, int(23 * sx), int(10 * sx), Z_BIG)
    return canvas


def _make_upper_bob(base: Image.Image, dx: int, dy: int, fw: int, fh: int) -> Image.Image:
    arr = np.array(base)
    ys = np.where(arr[:, :, 3] > 0)[0]
    if len(ys) == 0:
        return base.copy()
    y_top, y_bot = int(ys.min()), int(ys.max())
    split_y = y_top + int((y_bot - y_top) * 0.76)

    upper = base.crop((0, 0, fw, split_y))
    lower = base.crop((0, split_y, fw, fh))
    canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    canvas.paste(lower, (0, split_y), lower)
    canvas.paste(upper, (dx, dy), upper)
    return canvas


def _map_custom_anim(anim: str) -> str:
    """将场景自定义动作名映射到最匹配的程序化动作模板。"""
    low = anim.lower()
    if low in ANIM_ORDER:
        return low
    if any(k in low for k in ("walk", "run", "move", "stroll")):
        return "walk"
    if any(k in low for k in ("sleep", "nap", "bed", "dream")):
        return "sleep"
    if any(k in low for k in ("read", "book", "study", "browse")):
        return "read"
    if any(k in low for k in ("drink", "coffee", "tea", "juice", "sip")):
        return "drink"
    if any(k in low for k in ("eat", "dine", "snack", "meal", "lunch", "dinner", "breakfast")):
        return "eat"
    if any(k in low for k in ("cook", "bake", "fry", "brew", "kitchen")):
        return "cook"
    if any(k in low for k in ("cat", "pet", "dog", "play")):
        return "play_cat"
    if any(k in low for k in ("plant", "flower", "water", "garden")):
        return "water_plants"
    if any(k in low for k in ("bath", "shower", "swim")):
        return "bathe"
    if any(k in low for k in ("wash", "clean", "brush")):
        return "wash_up"
    if any(k in low for k in ("work", "type", "code", "write", "desk", "pc", "computer")):
        return "work"
    if any(k in low for k in ("watch", "tv", "screen", "movie")):
        return "watch_tv"
    if any(k in low for k in ("sit", "chair", "sofa", "bench", "rest", "relax")):
        return "sit"
    if any(k in low for k in ("meet", "chat", "talk", "greet", "wave")):
        return "meet"
    return "tidy"


def _prop_offset(dir_name: str, fw: int) -> tuple[int, int]:
    sx = fw / 32.0
    if dir_name == "S":
        return (0, 0)
    if dir_name == "E":
        return (int(round(5 * sx)), -1)
    if dir_name == "W":
        return (-int(round(5 * sx)), -1)
    return (0, -999)


def build_anim_frames(
    anim_name: str, norm_by_dir: dict[str, list[Image.Image]], fw: int, fh: int
) -> list[list[Image.Image]]:
    anim = _map_custom_anim(anim_name)
    rows: list[list[Image.Image]] = []
    sx = fw / 32.0
    sy = fh / 48.0
    show_props = fw >= 24

    for d_name in DIRS:
        walk_row = norm_by_dir[d_name]
        stand = walk_row[0]
        ox, oy = _prop_offset(d_name, fw)

        if anim == "walk":
            rows.append(walk_row)
            continue

        out_frames: list[Image.Image] = []
        for f_idx in range(4):
            if anim == "idle":
                c = _shift_frame(stand, 0, 1 if f_idx >= 2 else 0, fw, fh)
            elif anim == "sleep":
                c = _make_sleep_frame(stand, d_name, f_idx, fw, fh)
            elif anim in ("sit", "rest", "watch_tv", "read", "eat", "work"):
                bob = 1 if f_idx in (2, 3) else 0
                c = _make_sit_frame(stand, d_name, bob, fw, fh)
                if show_props:
                    if anim == "read" and oy > -100:
                        _draw_sprite(c, int(11 * sx) + ox, int(32 * sy) + bob, BOOK_9x6)
                        if f_idx == 2:
                            _draw_sprite(c, int(14 * sx) + ox, int(30 * sy), ["y"])
                    elif anim == "eat" and oy > -100:
                        _draw_sprite(c, int(13 * sx) + ox, int(32 * sy) + bob, MUG_6x6)
                        _draw_sprite(c, int(15 * sx) + ox, int(29 * sy) - f_idx, ["w", ".w"])
                    elif anim == "work":
                        if f_idx in (1, 3):
                            c = _make_upper_bob(c, 0, -1, fw, fh)
                        if f_idx % 2 == 1:
                            _draw_sprite(c, int(22 * sx), int(10 * sy) - (f_idx // 2), NOTE_5x6)
                    elif anim == "watch_tv" and f_idx % 2 == 0 and oy > -100:
                        _draw_sprite(c, int(14 * sx) + ox, int(25 * sy), ["c.c"])
            elif anim == "drink":
                c = _shift_frame(stand, 0, 1 if f_idx == 2 else 0, fw, fh)
                if show_props and oy > -100:
                    _draw_sprite(c, int(13 * sx) + ox, int(28 * sy) + (1 if f_idx == 2 else 0), MUG_6x6)
                    _draw_sprite(c, int(15 * sx) + ox, int(25 * sy) - f_idx, ["w"])
            elif anim == "water_plants":
                dx = 1 if d_name == "E" else (-1 if d_name == "W" else 0)
                c = _make_upper_bob(stand, dx, 1 if f_idx % 2 else 0, fw, fh)
                if show_props and oy > -100:
                    _draw_sprite(c, int(12 * sx) + ox, int(28 * sy), CAN_8x6)
                    drop_y = int(33 * sy) + (f_idx * 3) % 8
                    _draw_sprite(c, int(11 * sx) + ox, drop_y, ["b", ".c", "b"])
            elif anim == "play_cat":
                c = _shift_frame(stand, 0, 1 if f_idx in (1, 2) else 0, fw, fh)
                if show_props:
                    cat_x = int(21 * sx) if d_name != "E" else 2
                    _draw_sprite(c, cat_x, int(40 * sy) - (1 if f_idx == 2 else 0), CAT_9x7)
                    _draw_sprite(c, int(22 * sx), int(12 * sy) - f_idx * 2, HEART_5x5)
            elif anim in ("bathe", "wash_up"):
                dx = 1 if f_idx == 1 else (-1 if f_idx == 3 else 0)
                c = _make_upper_bob(stand, dx, 0, fw, fh)
                if show_props:
                    _draw_sprite(c, int(4 * sx), int(24 * sy) - f_idx * 3, BUBBLE_4x4)
                    _draw_sprite(c, int(24 * sx), int(18 * sy) - ((f_idx + 2) % 4) * 3, BUBBLE_4x4)
            elif anim == "cook":
                dy = -1 if f_idx % 2 == 1 else 0
                c = _make_upper_bob(stand, 1 if f_idx == 1 else 0, dy, fw, fh)
                if show_props:
                    if f_idx >= 1:
                        _draw_sprite(c, int(22 * sx), int(12 * sy) - f_idx * 2, NOTE_5x6)
                    _draw_sprite(c, int(10 * sx), int(22 * sy) - f_idx * 2, ["w", ".w"])
            elif anim == "meet":
                c = _shift_frame(stand, 0, -1 if f_idx in (1, 3) else 0, fw, fh)
                if show_props and f_idx in (1, 2):
                    _draw_sprite(c, int(22 * sx), int(8 * sy) - f_idx, NOTE_5x6)
            else:
                dx = 1 if f_idx == 1 else (-1 if f_idx == 3 else 0)
                c = _make_upper_bob(stand, dx, 1 if f_idx == 2 else 0, fw, fh)
            out_frames.append(c)
        rows.append(out_frames)
    return rows


def compile_sheet(
    src_im: Image.Image,
    *,
    row_order: str = "auto",
    fw: int = 32,
    fh: int = 48,
    animations: list[str] | None = None,
    auto_fix_dir: bool = True,
    clean_inner_white: bool = True,
    manual_flips: dict[str, list[bool]] | None = None,
) -> tuple[Image.Image, dict[str, Any], dict[str, Any]]:
    anims = animations if animations else list(ANIM_ORDER)
    raw_rows = extract_4x4_raw_rows(src_im, clean_inner_white=clean_inner_white)
    norm_by_dir, detected_order, corrections = detect_and_fix_directions(
        raw_rows,
        row_order=row_order,
        auto_fix_dir=auto_fix_dir,
        manual_flips=manual_flips,
        fw=fw,
        fh=fh,
    )

    total_rows = len(anims) * len(DIRS)
    sheet = Image.new("RGBA", (fw * 4, fh * total_rows), (0, 0, 0, 0))
    anim_meta: dict[str, Any] = {}
    row_cursor = 0
    idx_cursor = 0

    for anim in anims:
        anim_rows = build_anim_frames(anim, norm_by_dir, fw, fh)
        frames_dict: dict[str, list[int]] = {}
        for d_name, d_row in zip(DIRS, anim_rows):
            for c_idx, frame in enumerate(d_row):
                sheet.paste(frame, (c_idx * fw, row_cursor * fh), frame)
            frames_dict[d_name] = [idx_cursor, idx_cursor + 1, idx_cursor + 2, idx_cursor + 3]
            row_cursor += 1
            idx_cursor += 4
        mapped = _map_custom_anim(anim)
        fps = 8 if mapped == "walk" else (4 if mapped in ("idle", "sleep", "rest") else 6)
        anim_meta[anim] = {
            "fps": fps,
            "loop": True,
            "frameCount": 4,
            "frames": frames_dict,
        }

    anchor_x = fw // 2
    anchor_y = fh - 2 if fh >= 36 else fh - 1
    meta = {
        "schema_version": 1,
        "image": "sheet.png",
        "frame": {"w": fw, "h": fh},
        "anchor": {"x": anchor_x, "y": anchor_y},
        "directions": list(DIRS),
        "animations": anim_meta,
    }
    diag = {
        "detectedRowOrder": detected_order,
        "corrections": corrections,
    }
    return sheet, meta, diag


def render_preview(sheet: Image.Image, meta: dict[str, Any]) -> Image.Image:
    """渲染带动作名称标注的正面(S向)全动作预览图。"""
    fw = int(meta["frame"]["w"])
    fh = int(meta["frame"]["h"])
    anims = list(meta["animations"].keys())
    cols = 2
    rows_per_col = (len(anims) + 1) // 2
    scale = 4 if fw >= 24 else 6
    cell_w = fw * 4 * scale + 130
    cell_h = fh * scale + 12
    canvas = Image.new("RGBA", (cols * cell_w + 20, rows_per_col * cell_h + 20), (34, 38, 48, 255))
    draw = ImageDraw.Draw(canvas)

    s_dir_idx = DIRS.index("S")
    for i, a in enumerate(anims):
        col = i // rows_per_col
        row = i % rows_per_col
        row_idx = i * len(DIRS) + s_dir_idx
        crop = sheet.crop((0, row_idx * fh, fw * 4, (row_idx + 1) * fh))
        scaled = crop.resize((fw * 4 * scale, fh * scale), Image.Resampling.NEAREST)
        x0 = 15 + col * cell_w
        y0 = 15 + row * cell_h
        draw.text((x0, y0 + fh * scale // 2 - 6), a, fill=(230, 235, 245, 255))
        canvas.paste(scaled, (x0 + 110, y0), scaled)
    return canvas


def _update_manifest(dist_dir: Path) -> None:
    mf_path = dist_dir / "manifest.json"
    if not mf_path.is_file():
        return
    mf = json.loads(mf_path.read_text(encoding="utf-8"))
    for entry in mf.get("files", []):
        rel = entry.get("path")
        if rel in {"character/sheet.png", "character/sheet.json"}:
            p = dist_dir / rel
            if p.is_file():
                data = p.read_bytes()
                entry["size"] = len(data)
                entry["sha256"] = hashlib.sha256(data).hexdigest()
    mf_path.write_text(json.dumps(mf, ensure_ascii=False, indent=1), encoding="utf-8")


def _collect_dist_animations(dist_dir: Path) -> list[str]:
    names: set[str] = set(ANIM_ORDER)
    inter_path = dist_dir / "interactions.json"
    if inter_path.is_file():
        try:
            inter = json.loads(inter_path.read_text(encoding="utf-8"))
            acts = inter.get("acts") if isinstance(inter, dict) else None
            if isinstance(acts, dict):
                for act in acts.values():
                    if isinstance(act, dict):
                        anim = (act.get("perform") or {}).get("animation")
                        if isinstance(anim, str) and anim.strip():
                            names.add(anim.strip())
        except Exception:
            pass
    sheet_path = dist_dir / "character" / "sheet.json"
    if sheet_path.is_file():
        try:
            sh = json.loads(sheet_path.read_text(encoding="utf-8"))
            anims = sh.get("animations")
            if isinstance(anims, dict):
                for k in anims:
                    if isinstance(k, str) and k.strip():
                        names.add(k.strip())
        except Exception:
            pass
    return sorted(names)


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", text.strip().lower()).strip("-")
    return (s[:24] or "char") + "-" + uuid.uuid4().hex[:6]


class CharacterSheetManager:
    """管理 PC 端角色 4 向图集扩展、方向纠错、存储、预览与下发到场景包。"""

    def __init__(self, store: Any, data_dir: Path) -> None:
        self.store = store
        self.root = Path(data_dir) / "characters"
        self.root.mkdir(parents=True, exist_ok=True)
        self.active_id: str | None = self.store.get_kv("active_character_id")

    def list_characters(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for sub in sorted(self.root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            meta_file = sub / "meta.json"
            if not sub.is_dir() or not meta_file.is_file():
                continue
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                if isinstance(meta, dict) and (sub / "sheet.png").is_file() and (sub / "sheet.json").is_file():
                    meta["active"] = meta.get("id") == self.active_id
                    items.append(meta)
            except Exception:
                continue
        return items

    def get_meta(self, char_id: str) -> dict[str, Any] | None:
        if char_id == "active":
            if not self.active_id:
                return None
            char_id = self.active_id
        if not re.fullmatch(r"[A-Za-z0-9_-]+", char_id):
            return None
        meta_file = self.root / char_id / "meta.json"
        if not meta_file.is_file():
            return None
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            meta["active"] = meta.get("id") == self.active_id
            return meta
        except Exception:
            return None

    def resolve_file(self, char_id: str, file_name: str) -> Path | None:
        if char_id == "active":
            if not self.active_id:
                return None
            char_id = self.active_id
        if not re.fullmatch(r"[A-Za-z0-9_-]+", char_id):
            return None
        allowed = {"sheet.png", "sheet.json", "preview.png", "source.png", "meta.json"}
        if file_name not in allowed:
            return None
        p = self.root / char_id / file_name
        return p if p.is_file() else None

    def generate(
        self,
        *,
        image_bytes: bytes,
        filename: str = "walk.png",
        name: str = "",
        row_order: str = "auto",
        frame_w: int = 32,
        frame_h: int = 48,
        auto_fix_dir: bool = True,
        clean_inner_white: bool = True,
        manual_flips: dict[str, list[bool]] | None = None,
    ) -> dict[str, Any]:
        parsed_order = parse_row_order(row_order)
        row_order = ",".join(parsed_order) if parsed_order else "auto"
        if (frame_w, frame_h) not in ((32, 48), (16, 24), (32, 32)):
            frame_w, frame_h = 32, 48

        src_im = Image.open(io.BytesIO(image_bytes))
        src_im.load()
        sheet, sheet_meta, diag = compile_sheet(
            src_im,
            row_order=row_order,
            fw=frame_w,
            fh=frame_h,
            auto_fix_dir=auto_fix_dir,
            clean_inner_white=clean_inner_white,
            manual_flips=manual_flips,
        )
        preview = render_preview(sheet, sheet_meta)

        clean_name = (name or Path(filename).stem or "新角色").strip()[:40]
        cid = _slug(clean_name)
        cdir = self.root / cid
        cdir.mkdir(parents=True, exist_ok=True)

        src_im.save(cdir / "source.png", format="PNG")
        sheet.save(cdir / "sheet.png", format="PNG")
        (cdir / "sheet.json").write_text(json.dumps(sheet_meta, ensure_ascii=False, indent=1), encoding="utf-8")
        preview.save(cdir / "preview.png", format="PNG")

        now = int(time.time() * 1000)
        meta = {
            "id": cid,
            "name": clean_name,
            "sourceFileName": Path(filename).name,
            "rowOrder": row_order,
            "detectedRowOrder": diag["detectedRowOrder"],
            "autoFixDir": auto_fix_dir,
            "cleanInnerWhite": clean_inner_white,
            "corrections": diag["corrections"],
            "manualFlips": manual_flips or {},
            "frame": {"w": frame_w, "h": frame_h},
            "animations": list(sheet_meta["animations"].keys()),
            "sheetSize": {"w": sheet.width, "h": sheet.height},
            "createdAt": now,
            "updatedAt": now,
        }
        (cdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        meta["active"] = meta["id"] == self.active_id
        return meta

    def regenerate(
        self,
        char_id: str,
        *,
        row_order: str | None = None,
        frame_w: int | None = None,
        frame_h: int | None = None,
        name: str | None = None,
        auto_fix_dir: bool | None = None,
        clean_inner_white: bool | None = None,
        manual_flips: dict[str, list[bool]] | None = None,
    ) -> dict[str, Any]:
        meta = self.get_meta(char_id)
        if not meta:
            raise FileNotFoundError(f"找不到角色：{char_id}")
        cdir = self.root / meta["id"]
        src_path = cdir / "source.png"
        if not src_path.is_file():
            raise FileNotFoundError("缺少原始 4×4 行走图 source.png")

        parsed_order = parse_row_order(row_order)
        if row_order == "auto" or parsed_order is not None:
            order = "auto" if row_order == "auto" else ",".join(parsed_order)
        else:
            order = str(meta.get("rowOrder") or "auto")
        fw = frame_w or int((meta.get("frame") or {}).get("w") or 32)
        fh = frame_h or int((meta.get("frame") or {}).get("h") or 48)
        if (fw, fh) not in ((32, 48), (16, 24), (32, 32)):
            fw, fh = 32, 48
        fix_dir = bool(meta.get("autoFixDir", True)) if auto_fix_dir is None else bool(auto_fix_dir)
        clean_white = bool(meta.get("cleanInnerWhite", True)) if clean_inner_white is None else bool(clean_inner_white)
        flips = meta.get("manualFlips") or {} if manual_flips is None else manual_flips

        src_im = Image.open(src_path)
        src_im.load()
        sheet, sheet_meta, diag = compile_sheet(
            src_im,
            row_order=order,
            fw=fw,
            fh=fh,
            auto_fix_dir=fix_dir,
            clean_inner_white=clean_white,
            manual_flips=flips,
        )
        preview = render_preview(sheet, sheet_meta)

        sheet.save(cdir / "sheet.png", format="PNG")
        (cdir / "sheet.json").write_text(json.dumps(sheet_meta, ensure_ascii=False, indent=1), encoding="utf-8")
        preview.save(cdir / "preview.png", format="PNG")

        meta["name"] = (name or meta["name"]).strip()[:40]
        meta["rowOrder"] = order
        meta["detectedRowOrder"] = diag["detectedRowOrder"]
        meta["autoFixDir"] = fix_dir
        meta["cleanInnerWhite"] = clean_white
        meta["corrections"] = diag["corrections"]
        meta["manualFlips"] = flips
        meta["frame"] = {"w": fw, "h": fh}
        meta["animations"] = list(sheet_meta["animations"].keys())
        meta["sheetSize"] = {"w": sheet.width, "h": sheet.height}
        meta["updatedAt"] = int(time.time() * 1000)
        (cdir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        meta["active"] = meta["id"] == self.active_id
        return meta

    def apply_to_dist(self, char_id: str, dist_dir: Path) -> bool:
        """将指定角色（含目标场景所需全部动作）写入场景 dist/character/ 并更新 manifest。"""
        meta = self.get_meta(char_id)
        if not meta or not dist_dir.is_dir():
            return False
        cdir = self.root / meta["id"]
        src_path = cdir / "source.png"
        if not src_path.is_file():
            return False

        needed_anims = _collect_dist_animations(dist_dir)
        char_out = dist_dir / "character"
        char_out.mkdir(parents=True, exist_ok=True)

        if needed_anims == sorted(meta.get("animations") or []):
            shutil.copy2(cdir / "sheet.png", char_out / "sheet.png")
            shutil.copy2(cdir / "sheet.json", char_out / "sheet.json")
        else:
            src_im = Image.open(src_path)
            src_im.load()
            fw = int((meta.get("frame") or {}).get("w") or 32)
            fh = int((meta.get("frame") or {}).get("h") or 48)
            order = str(meta.get("rowOrder") or "auto")
            fix_dir = bool(meta.get("autoFixDir", True))
            clean_white = bool(meta.get("cleanInnerWhite", True))
            flips = meta.get("manualFlips") or {}
            sheet, sheet_meta, _ = compile_sheet(
                src_im,
                row_order=order,
                fw=fw,
                fh=fh,
                animations=needed_anims,
                auto_fix_dir=fix_dir,
                clean_inner_white=clean_white,
                manual_flips=flips,
            )
            sheet.save(char_out / "sheet.png", format="PNG")
            (char_out / "sheet.json").write_text(json.dumps(sheet_meta, ensure_ascii=False, indent=1), encoding="utf-8")

        _update_manifest(dist_dir)
        return True

    def apply_active_to_dist(self, dist_dir: Path) -> bool:
        if not self.active_id:
            return False
        return self.apply_to_dist(self.active_id, dist_dir)

    def apply_character(
        self,
        char_id: str,
        *,
        scenes_root: Path | None = None,
        toolchain_root: Path | None = None,
        apply_to_scenes: bool = True,
        sync_toolchain: bool = True,
    ) -> dict[str, Any]:
        meta = self.get_meta(char_id)
        if not meta:
            raise FileNotFoundError(f"找不到角色：{char_id}")

        self.active_id = str(meta["id"])
        self.store.put_kv("active_character_id", self.active_id)

        updated_scenes: list[str] = []
        if apply_to_scenes and scenes_root and scenes_root.is_dir():
            for sub in sorted(scenes_root.iterdir()):
                dist_dir = sub / "dist"
                if sub.is_dir() and dist_dir.is_dir() and (dist_dir / "scene.json").is_file():
                    if self.apply_to_dist(self.active_id, dist_dir):
                        updated_scenes.append(sub.name)

        synced_dev_paths: list[str] = []
        if sync_toolchain and toolchain_root and toolchain_root.is_dir():
            cdir = self.root / self.active_id
            arm_char = toolchain_root / "arm" / "www" / "assets" / "char"
            if arm_char.is_dir():
                shutil.copy2(cdir / "sheet.png", arm_char / "ojj_sheet.png")
                shutil.copy2(cdir / "sheet.json", arm_char / "ojj_sheet.json")
                synced_dev_paths.append(str(arm_char))
            for scene_name in ("home", "office", "cafe"):
                for base in (
                    toolchain_root / "arm" / "www" / "assets" / "scenes" / scene_name,
                    toolchain_root / "assets" / "scenes" / scene_name / "dist",
                ):
                    if base.is_dir() and (base / "scene.json").is_file():
                        if self.apply_to_dist(self.active_id, base):
                            synced_dev_paths.append(str(base))

        return {
            "activeId": self.active_id,
            "updatedScenes": updated_scenes,
            "syncedDevPaths": synced_dev_paths,
        }

    def reset_default(
        self,
        *,
        scenes_root: Path | None = None,
        toolchain_root: Path | None = None,
        sync_toolchain: bool = True,
    ) -> dict[str, Any]:
        """重置为内置默认角色（先前生成的鲸鱼娘 ojj_sheet），同步恢复 ARM 与场景产物。"""
        self.active_id = None
        self.store.put_kv("active_character_id", None)
        ts = int(time.time() * 1000)
        self.store.put_kv("default_char_ts", ts)

        base_candidates: list[Path] = []
        if toolchain_root:
            base_candidates.append(toolchain_root / "assets" / "char")
        here = Path(__file__).resolve()
        for up in range(2, 6):
            try:
                base_candidates.append(here.parents[up] / "assets" / "char")
            except IndexError:
                break

        src_png: Path | None = None
        src_json: Path | None = None
        for d in base_candidates:
            p_png = d / "ojj_sheet.png"
            p_json = d / "ojj_sheet.json"
            if p_png.is_file() and p_json.is_file():
                src_png = p_png
                src_json = p_json
                break

        updated_scenes: list[str] = []
        synced_dev_paths: list[str] = []
        if src_png and src_json:
            if scenes_root and scenes_root.is_dir():
                for sub in sorted(scenes_root.iterdir()):
                    dist_dir = sub / "dist"
                    char_out = dist_dir / "character"
                    if sub.is_dir() and dist_dir.is_dir() and (dist_dir / "scene.json").is_file():
                        char_out.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(src_png, char_out / "sheet.png")
                        shutil.copy2(src_json, char_out / "sheet.json")
                        _update_manifest(dist_dir)
                        updated_scenes.append(sub.name)

            if sync_toolchain and toolchain_root and toolchain_root.is_dir():
                arm_char = toolchain_root / "arm" / "www" / "assets" / "char"
                if arm_char.is_dir():
                    shutil.copy2(src_png, arm_char / "ojj_sheet.png")
                    shutil.copy2(src_json, arm_char / "ojj_sheet.json")
                    synced_dev_paths.append(str(arm_char))
                for scene_name in ("home", "office", "cafe"):
                    for base in (
                        toolchain_root / "arm" / "www" / "assets" / "scenes" / scene_name,
                        toolchain_root / "assets" / "scenes" / scene_name / "dist",
                    ):
                        if base.is_dir() and (base / "scene.json").is_file():
                            c_out = base / "character"
                            c_out.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(src_png, c_out / "sheet.png")
                            shutil.copy2(src_json, c_out / "sheet.json")
                            _update_manifest(base)
                            synced_dev_paths.append(str(base))

        return {
            "activeId": None,
            "updatedAt": ts,
            "updatedScenes": updated_scenes,
            "syncedDevPaths": synced_dev_paths,
        }

    def rename_character(self, char_id: str, new_name: str) -> dict[str, Any]:
        meta = self.get_meta(char_id)
        if not meta:
            raise FileNotFoundError(f"找不到角色：{char_id}")
        clean = str(new_name or "").strip()[:40]
        if not clean:
            raise ValueError("角色名称不能为空")
        cid = str(meta["id"])
        meta["name"] = clean
        meta["updatedAt"] = int(time.time() * 1000)
        meta.pop("active", None)
        (self.root / cid / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        meta["active"] = cid == self.active_id
        return meta

    def delete_character(self, char_id: str) -> bool:
        meta = self.get_meta(char_id)
        if not meta:
            return False
        cid = str(meta["id"])
        target = (self.root / cid).resolve()
        try:
            target.relative_to(self.root.resolve())
        except ValueError:
            return False
        shutil.rmtree(target, ignore_errors=True)
        if self.active_id == cid:
            self.active_id = None
            self.store.put_kv("active_character_id", None)
        return True
