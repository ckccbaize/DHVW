#!/usr/bin/env python3
"""逐像素对比两张 PNG；用于 JS painter 与 Python 黄金图。

用法：python tools/compare-terrain.py <js.png> <golden.png>
退出码：0 完全一致；1 有差异；2 用法/读取错误。
"""
import sys
from PIL import Image, ImageChops

def main():
    if len(sys.argv) != 3:
        print("用法: compare-terrain.py <js.png> <golden.png>")
        return 2
    a = Image.open(sys.argv[1]).convert("RGBA")
    b = Image.open(sys.argv[2]).convert("RGBA")
    if a.size != b.size:
        print(f"尺寸不同: {a.size} vs {b.size}")
        return 1
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    if bbox is None:
        print("✓ 逐像素一致")
        return 0
    # 统计差异像素与最大通道差
    pa, pb = a.load(), b.load()
    count = 0
    maxd = 0
    first = None
    w, h = a.size
    for y in range(h):
        for x in range(w):
            da = pa[x, y]
            db = pb[x, y]
            d = max(abs(da[i] - db[i]) for i in range(4))
            if d:
                count += 1
                maxd = max(maxd, d)
                if first is None:
                    first = (x, y, da, db)
    print(f"✗ 差异像素 {count}/{w*h}，最大通道差 {maxd}，首个 {first}")
    return 1

if __name__ == "__main__":
    sys.exit(main())
