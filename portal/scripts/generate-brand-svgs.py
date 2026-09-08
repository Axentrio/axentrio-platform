#!/usr/bin/env python3
"""Generate compact path-based Axentrio brand SVGs from the official logo source."""
from __future__ import annotations
import re
from pathlib import Path

SOURCE = Path("/Users/ianneo/Downloads/Axentrio-logo.svg")
OUT = Path(__file__).resolve().parents[1] / "public"
RIBBON_IDS = ("shape-upper-ribbon", "shape-lower-left-ribbon", "shape-right-ribbon")
LETTER_IDS = ("shape-letter-A", "shape-letter-X", "shape-letter-E", "shape-letter-N", "shape-letter-T", "shape-letter-R", "shape-letter-I", "shape-letter-O")
ON_LIGHT_FILLS = {"shape-upper-ribbon": "#063437", "shape-lower-left-ribbon": "#084749", "shape-right-ribbon": "#207576", "shape-letter-A": "#021c22", "shape-letter-X": "#021c22", "shape-letter-E": "#021c22", "shape-letter-N": "#021d22", "shape-letter-T": "#021c22", "shape-letter-R": "#021e24", "shape-letter-I": "#021f25", "shape-letter-O": "#021d23"}
ON_DARK_FILLS = {"shape-upper-ribbon": "#063437", "shape-lower-left-ribbon": "#084749", "shape-right-ribbon": "#2dd4bf", **{k: "#F9F0E7" for k in LETTER_IDS}}
IVORY = "#F9F0E7"

def round_path(d: str, places: int = 1) -> str:
    return re.sub(r"-?\d+\.\d+", lambda m: str(round(float(m.group(0)), places)), d)

def path_bounds(d: str):
    nums = [float(x) for x in re.findall(r"-?\d+\.?\d*", d)]
    xs, ys = nums[0::2], nums[1::2]
    return min(xs), min(ys), max(xs), max(ys)

def union_bounds(ids, paths):
    boxes = [path_bounds(paths[i]) for i in ids]
    return min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)

def padded_box(ids, paths, pad_x, pad_y):
    x0, y0, x1, y1 = union_bounds(ids, paths)
    return x0 - pad_x, y0 - pad_y, (x1 - x0) + 2 * pad_x, (y1 - y0) + 2 * pad_y

def svg_doc(view_box, path_ids, paths, fills, label):
    x, y, w, h = view_box
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x:.1f} {y:.1f} {w:.1f} {h:.1f}" fill="none" role="img" aria-label="{label}">']
    for pid in path_ids:
        lines.append(f'  <path fill="{fills[pid]}" d="{round_path(paths[pid])}"/>')
    lines.extend(["</svg>", ""])
    return "\n".join(lines)

def favicon_svg(paths, fills):
    x0, y0, x1, y1 = union_bounds(RIBBON_IDS, paths)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    scale = (64 - 12) / max(x1 - x0, y1 - y0)
    tx, ty = 32 - cx * scale, 32 - cy * scale
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="Axentrio">', f'  <rect width="64" height="64" rx="14" fill="{IVORY}"/>', f'  <g transform="translate({tx:.3f} {ty:.3f}) scale({scale:.6f})">']
    for pid in RIBBON_IDS:
        lines.append(f'    <path fill="{fills[pid]}" d="{round_path(paths[pid])}"/>')
    lines.extend(["  </g>", "</svg>", ""])
    return "\n".join(lines)

def logo_with_bg(paths):
    x0, y0, x1, y1 = union_bounds(RIBBON_IDS + LETTER_IDS, paths)
    gw, gh = x1 - x0, y1 - y0
    target, margin = 1254.0, 120.0
    scale = (target - 2 * margin) / max(gw, gh)
    tx = (target - gw * scale) / 2 - x0 * scale
    ty = (target - gh * scale) / 2 - y0 * scale + 40
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254" fill="none" role="img" aria-label="Axentrio">', f'  <rect width="1254" height="1254" fill="{IVORY}"/>', f'  <g transform="translate({tx:.2f} {ty:.2f}) scale({scale:.5f})">']
    for pid in RIBBON_IDS + LETTER_IDS:
        lines.append(f'    <path fill="{ON_LIGHT_FILLS[pid]}" d="{round_path(paths[pid])}"/>')
    lines.extend(["  </g>", "</svg>", ""])
    return "\n".join(lines)

def main():
    text = SOURCE.read_text(encoding="utf-8")
    paths = {m.group(1): m.group(2) for m in re.finditer(r'<path id="([^"]+)"[^>]*d="([^"]+)"', text)}
    mark_box = padded_box(RIBBON_IDS, paths, 20, 20)
    word_box = padded_box(RIBBON_IDS + LETTER_IDS, paths, 24, 16)
    outputs = {
        "axentrio-mark.svg": svg_doc(mark_box, RIBBON_IDS, paths, ON_LIGHT_FILLS, "Axentrio mark"),
        "axentrio-mark-on-dark.svg": svg_doc(mark_box, RIBBON_IDS, paths, ON_DARK_FILLS, "Axentrio mark"),
        "axentrio-wordmark.svg": svg_doc(word_box, RIBBON_IDS + LETTER_IDS, paths, ON_LIGHT_FILLS, "Axentrio"),
        "axentrio-wordmark-on-dark.svg": svg_doc(word_box, RIBBON_IDS + LETTER_IDS, paths, ON_DARK_FILLS, "Axentrio"),
        "favicon.svg": favicon_svg(paths, ON_LIGHT_FILLS),
        "axentrio-logo-transparent.svg": svg_doc(word_box, RIBBON_IDS + LETTER_IDS, paths, ON_LIGHT_FILLS, "Axentrio"),
        "axentrio-logo-with-bg.svg": logo_with_bg(paths),
    }
    outputs["axentrio-logo.svg"] = outputs["axentrio-logo-with-bg.svg"]
    for name, content in outputs.items():
        (OUT / name).write_text(content, encoding="utf-8")
        print(f"wrote {name}: {(OUT / name).stat().st_size:,} bytes")

if __name__ == "__main__":
    main()
