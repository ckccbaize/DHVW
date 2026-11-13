#!/usr/bin/env python3
"""逐像素对比两张 PNG；用于 JS painter 与 Python 黄金图。

用法：python tools/compare-terrain.py <js.png> <golden.png>
退出码：0 完全一致；1 有差异；2 用法/读取错误。
"""
import sys
import numpy as np
from PIL import Image

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    max_diff = 0
    max_channel = 0
    ignore_channel = 0
    for a in sys.argv[1:]:
        if a.startswith("--max-diff="):
            max_diff = int(a.split("=", 1)[1])
        if a.startswith("--max-channel="):
            max_channel = int(a.split("=", 1)[1])
        if a.startswith("--ignore-channel="):
            ignore_channel = int(a.split("=", 1)[1])
    if len(args) != 2:
        print("用法: compare-terrain.py <js.png> <golden.png> [--max-diff=N]")
        return 2
    a = Image.open(args[0]).convert("RGBA")
    b = Image.open(args[1]).convert("RGBA")
    if a.size != b.size:
        print(f"尺寸不同: {a.size} vs {b.size}")
        return 1
    aa = np.asarray(a).astype(int)
    bb = np.asarray(b).astype(int)
    d = np.abs(aa - bb)
    mask = d.max(axis=2) > ignore_channel
    count = int(mask.sum())
    maxd = int(d.max()) if count else 0
    if count == 0:
        print("✓ 逐像素一致")
        return 0
    ys, xs = np.where(mask)
    first = (int(xs[0]), int(ys[0]), tuple(aa[ys[0], xs[0]]), tuple(bb[ys[0], xs[0]]))
    print(f"差异像素 {count}/{a.size[0]*a.size[1]}，最大通道差 {maxd}，首个 {first}")
    if count <= max_diff and maxd <= max_channel:
        print(f"✓ 在容忍范围内（≤{max_diff} 像素，通道差 ≤{max_channel}）")
        return 0
    return 1

if __name__ == "__main__":
    sys.exit(main())
