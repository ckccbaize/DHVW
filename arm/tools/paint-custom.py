#!/usr/bin/env python3
"""Python 参考：只画 spec.furnitureDefs 中的自定义家具。"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT.parent / "scripts"))
from paint_custom import paint_custom  # noqa: E402

T = 16


def main():
    spec_path = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "tests/fixtures/custom-furniture.json")
    out_path = Path(sys.argv[2] if len(sys.argv) > 2 else ROOT / ".tmp/custom-py.png")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    w, h = spec["grid"]["w"], spec["grid"]["h"]
    img = Image.new("RGBA", (w * T, h * T), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    defs = spec.get("furnitureDefs", {})
    for p in spec.get("props", []):
        if p["id"] in defs:
            paint_custom(d, defs[p["id"]], p["x"] * T, p["y"] * T)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    print(f"custom-py: {img.width}x{img.height} → {out_path}")


if __name__ == "__main__":
    main()
