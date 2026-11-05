#!/usr/bin/env python3
"""Re-runnable Figma importer for the creative review room.

Reads every direction frame of the brief's Figma file through the `ultron` CLI,
converts each frame into a piece spec (JSON) and exports the image layers,
logos and flat thumbnails into build_src/ (plaintext, git-ignored).

Usage:
    python3 tools/import_figma.py                # full import
    python3 tools/import_figma.py --skip-images  # specs only, reuse exported files

Brief-specific settings (Figma file key, pages, brief name, fonts) live in
build_src/import-config.json, which is git-ignored like everything else in
build_src/. tools/build.py encrypts build_src/ into docs/data/.
"""
import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build_src"
CONFIG_PATH = SRC / "import-config.json"
FORMATS = {  # frame size -> format key
    (1080, 1920): "9x16",
    (1080, 1080): "1x1",
    (1200, 1500): "4x5",
    (1200, 628): "1.91x1",
}
CURL = "/usr/bin/curl"

# Layer-name keywords for helper layers (fades, covers, grades) that are never the hero.
HELPER_WORDS = re.compile(
    r"fade|cover|grade|dim\b|patch|seam|fix|shadow|halo|mask|glow|sparkle|contrast|"
    r"gradient|band|sky|feather|trust row|end dot|baseline|highlight|chart line|ray ",
    re.I,
)
HERO_WORDS = re.compile(r"^hero|phone|photo|screen|numeral|illustration|3d objects|sunburst|^pill$|pill ·", re.I)
PROPER = ("UK", "UI")
FILE_KEY = ""
FONT_MAP = {}
TAG_RULES = [  # visual tags read from layer names; used by the performance heuristic
    ("human", re.compile(r"\bhand\b|photo · man|\bman\b|pov|person|talent|human", re.I)),
    ("ui", re.compile(r"\bui\b|phone|screen|investing|balance", re.I)),
    ("type", re.compile(r"numeral|type only", re.I)),
    ("object3d", re.compile(r"\b3d\b|coin|pebble|toggle", re.I)),
    ("illustration", re.compile(r"line-art|illustration|sunburst|chart lines", re.I)),
    ("lock", re.compile(r"padlock|\block\b", re.I)),
]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def ultron(tool, params, retries=3):
    """Call `ultron mcp figma <tool>` and return parsed JSON (output is JSON after the first '{')."""
    cmd = ["ultron", "mcp", "figma", tool, "--params", json.dumps(params)]
    last = None
    for i in range(retries):
        p = subprocess.run(cmd, capture_output=True, text=True)
        out = p.stdout
        if p.returncode == 0 and "{" in out:
            try:
                return json.loads(out[out.index("{"):])
            except json.JSONDecodeError as e:
                last = e
        else:
            last = (p.returncode, p.stderr[-400:], out[:200])
        time.sleep(2 + i * 3)
    raise RuntimeError(f"ultron {tool} failed: {last}")


# ---------- helpers ----------

def rgba(paint):
    c = paint.get("color", {})
    a = c.get("a", 1) * paint.get("opacity", 1)
    return "rgba(%d,%d,%d,%s)" % (round(c.get("r", 0) * 255), round(c.get("g", 0) * 255),
                                  round(c.get("b", 0) * 255), "%g" % round(a, 4))


def visible_paints(node, key="fills"):
    return [p for p in node.get(key, []) or [] if p.get("visible", True)]


def gradient_css(paint, w, h):
    """Convert a Figma GRADIENT_LINEAR paint on a w x h box to a CSS linear-gradient."""
    hp = paint["gradientHandlePositions"]
    p0 = (hp[0]["x"] * w, hp[0]["y"] * h)
    p1 = (hp[1]["x"] * w, hp[1]["y"] * h)
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    ln = math.hypot(dx, dy) or 1
    ang = math.degrees(math.atan2(dx, -dy)) % 360
    rad = math.radians(ang)
    u = (math.sin(rad), -math.cos(rad))
    L = abs(w * math.sin(rad)) + abs(h * math.cos(rad))
    start = (w / 2 - u[0] * L / 2, h / 2 - u[1] * L / 2)
    stops = []
    for s in paint["gradientStops"]:
        px = (p0[0] + dx * s["position"], p0[1] + dy * s["position"])
        t = ((px[0] - start[0]) * u[0] + (px[1] - start[1]) * u[1]) / L
        col = dict(paint)
        col = {"color": s["color"], "opacity": paint.get("opacity", 1)}
        stops.append(f"{rgba(col)} {t * 100:.2f}%")
    return f"linear-gradient({ang:.2f}deg, {', '.join(stops)})"


def bg_css(node):
    w, h = node["absoluteBoundingBox"]["width"], node["absoluteBoundingBox"]["height"]
    layers = []
    for p in visible_paints(node):
        if p["type"] == "SOLID":
            layers.append(f"linear-gradient({rgba(p)}, {rgba(p)})")
        elif p["type"] == "GRADIENT_LINEAR":
            layers.append(gradient_css(p, w, h))
    if not layers:
        return "#000000"
    return ", ".join(reversed(layers))  # Figma paints bottom->top, CSS top->bottom


def rel_box(node, frame_bb, key="absoluteBoundingBox"):
    b = node.get(key) or node["absoluteBoundingBox"]
    return {"x": round(b["x"] - frame_bb["x"], 2), "y": round(b["y"] - frame_bb["y"], 2),
            "w": round(b["width"], 2), "h": round(b["height"], 2)}


def walk(node):
    yield node
    for c in node.get("children", []) or []:
        yield from walk(c)


def content_box(node, frame_bb):
    """Union of visible leaf render bounds, clipped to the frame (what the eye sees)."""
    xs, ys, xe, ye = [], [], [], []
    for n in walk(node):
        if n.get("visible", True) is False or n.get("children"):
            continue
        b = n.get("absoluteRenderBounds")
        if not b:
            continue
        xs.append(b["x"]); ys.append(b["y"]); xe.append(b["x"] + b["width"]); ye.append(b["y"] + b["height"])
    if not xs:
        return rel_box(node, frame_bb)
    fx, fy = frame_bb["x"], frame_bb["y"]
    x0 = max(min(xs) - fx, 0); y0 = max(min(ys) - fy, 0)
    x1 = min(max(xe) - fx, frame_bb["width"]); y1 = min(max(ye) - fy, frame_bb["height"])
    return {"x": round(x0, 2), "y": round(y0, 2), "w": round(max(x1 - x0, 0), 2), "h": round(max(y1 - y0, 0), 2)}


def union_box(node, frame_bb):
    """Unclipped union of visible descendants' bounding boxes: what a node PNG export covers."""
    xs, ys, xe, ye = [], [], [], []
    stack = [node]
    while stack:
        n = stack.pop()
        if n.get("visible", True) is False:
            continue
        b = n.get("absoluteBoundingBox")
        if b:
            xs.append(b["x"]); ys.append(b["y"]); xe.append(b["x"] + b["width"]); ye.append(b["y"] + b["height"])
        if n is node or not n.get("clipsContent"):
            stack.extend(n.get("children", []) or [])
    fx, fy = frame_bb["x"], frame_bb["y"]
    return {"x": round(min(xs) - fx, 2), "y": round(min(ys) - fy, 2), "w": round(max(xe) - min(xs), 2), "h": round(max(ye) - min(ys), 2)}


CONTEXT_BLENDS = {"MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN", "COLOR_DODGE", "COLOR_BURN", "HARD_LIGHT",
                  "SOFT_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY", "LINEAR_BURN", "LINEAR_DODGE"}


def needs_backdrop(node):
    """A nested blend mode only renders right over the frame behind it, so an isolated export is wrong."""
    stack = list(node.get("children", []) or [])
    while stack:
        n = stack.pop()
        if n.get("visible", True) is False:
            continue
        if n.get("blendMode") in CONTEXT_BLENDS:
            return True
        stack.extend(n.get("children", []) or [])
    return False


def text_style(style):
    ps = style.get("fontPostScriptName") or ""
    fam, wt, it = FONT_MAP.get(ps, (style.get("fontFamily", "sans-serif"), style.get("fontWeight", 400), "normal"))
    lh = style.get("lineHeightPx")
    if style.get("lineHeightUnit") == "INTRINSIC_%":
        lh = None
    return {
        "family": fam, "weight": wt, "style": it, "size": style.get("fontSize", 30),
        "lineHeight": round(lh, 3) if lh else None,
        "letterSpacing": round(style.get("letterSpacing", 0), 3),
        "align": (style.get("textAlignHorizontal") or "LEFT").lower(),
        "autoResize": style.get("textAutoResize", "NONE"),
        "postscript": ps,
    }


def text_runs(node):
    chars = node.get("characters", "")
    ov = node.get("characterStyleOverrides") or []
    table = node.get("styleOverrideTable") or {}
    base_fill = visible_paints(node)
    base_col = rgba(base_fill[0]) if base_fill else "rgba(255,255,255,1)"
    runs = []
    for i, ch in enumerate(chars):
        key = ov[i] if i < len(ov) else 0
        st = table.get(str(key), {}) if key else {}
        col = base_col
        if st.get("fills"):
            vp = [p for p in st["fills"] if p.get("visible", True)]
            if vp:
                col = rgba(vp[0])
        run = {"fill": col}
        if st.get("fontPostScriptName") and st["fontPostScriptName"] in FONT_MAP:
            fam, wt, it = FONT_MAP[st["fontPostScriptName"]]
            run.update({"family": fam, "weight": wt, "style": it})
        if runs and {k: v for k, v in runs[-1].items() if k != "t"} == run:
            runs[-1]["t"] += ch
        else:
            runs.append(dict(run, t=ch))
    return runs, base_col


def is_neon(col):
    m = re.match(r"rgba\((\d+),(\d+),(\d+)", col)
    if not m:
        return False
    r, g, b = map(int, m.groups())
    return abs(r - 204) < 12 and g > 240 and b < 30


def make_text_layer(node, frame_bb, role):
    runs, base = text_runs(node)
    st = text_style(node.get("style", {}))
    return {
        "id": node["id"], "kind": "text", "role": role, "name": node["name"],
        "box": rel_box(node, frame_bb), "style": st, "color": base,
        "opacity": node.get("opacity", 1), "runs": runs,
        "neonRanges": [r["t"] for r in runs if is_neon(r["fill"])],
    }


def find_text(node):
    for n in walk(node):
        if n["type"] == "TEXT":
            return n
    return None


def container_layer(node, frame_bb, role):
    """CTA pill or risk-warning box: a filled frame holding one text."""
    t = find_text(node)
    box = rel_box(node, frame_bb)
    fills = visible_paints(node)
    fill = rgba(fills[0]) if fills and fills[0]["type"] == "SOLID" else "transparent"
    strokes = visible_paints(node, "strokes")
    layer = {
        "id": node["id"], "kind": role, "role": role, "name": node["name"], "box": box,
        "fill": fill, "radius": node.get("cornerRadius", 0),
        "stroke": rgba(strokes[0]) if strokes else None,
        "strokeWeight": node.get("strokeWeight", 0) if strokes else 0,
        "layoutMode": node.get("layoutMode", "NONE"),
        "sizing": {"h": node.get("layoutSizingHorizontal"), "v": node.get("layoutSizingVertical")},
    }
    if t:
        tl = make_text_layer(t, frame_bb, "cta-label" if role == "cta" else "box-text")
        tb = tl["box"]
        layer["padding"] = {
            "l": round(tb["x"] - box["x"], 2), "t": round(tb["y"] - box["y"], 2),
            "r": round(box["x"] + box["w"] - tb["x"] - tb["w"], 2),
            "b": round(box["y"] + box["h"] - tb["y"] - tb["h"], 2),
        }
        layer["text"] = tl
    return layer


def simple_shape(node):
    if node["type"] not in ("RECTANGLE", "ELLIPSE"):
        return None
    fills = visible_paints(node)
    if len(fills) != 1 or fills[0]["type"] != "SOLID":
        return None
    if [e for e in node.get("effects", []) if e.get("visible", True)]:
        return None
    if visible_paints(node, "strokes"):
        return None
    radius = "50%" if node["type"] == "ELLIPSE" else node.get("cornerRadius", 0)
    return {"fill": rgba(fills[0]), "radius": radius}


def tags_for(name):
    return [t for t, rx in TAG_RULES if rx.search(name)]


def label_from_name(concept, name):
    """'Concept · D1 · Sunburst (clone ref 03) · V1' -> ('D1', 'Clone of brief ref 03 (sunburst)', 'V1')."""
    parts = [p.strip() for p in name.split("·")]
    d = next((p for p in parts if re.fullmatch(r"D\d+", p)), None)
    ver = next((p for p in parts if re.fullmatch(r"V\d+", p)), None)
    i = parts.index(d) if d in parts else 1
    title = " · ".join(p for p in parts[i + 1:] if p != ver)
    if "new art direction" in title.lower():
        return d, "New art direction", ver
    m = re.match(r"(?i)clone of (.+?)\s*\((.+)\)$", title)
    if m:
        src, what = m.group(1), m.group(2)
    else:
        m = re.match(r"(?i)(.+?)\s*\(clone (?:of )?(.+)\)$", title)
        if not m:
            return d, title[:1].upper() + title[1:], ver
        what, src = m.group(1), m.group(2)
    if re.match(r"(?i)ref \d+", src):
        src = "brief " + src
    what_l = what if what.startswith(PROPER) else what[:1].lower() + what[1:]
    if what_l.lower() in src.lower():
        return d, f"Clone of {src}", ver
    return d, f"Clone of {src} ({what_l})", ver


# ---------- conversion ----------

def text_role(name):
    low = name.lower()
    for key in ("headline", "disclosure"):
        if low == key or low.startswith(key + " "):
            return key
    if low == "risk warning":
        return "box"
    if low.startswith("sub"):
        return "sub"
    return "other"


def has_text(node):
    return any(n["type"] == "TEXT" and n.get("visible", True) is not False for n in walk(node))


def is_cta(node):
    """A CTA pill: frame/group named 'CTA…' with its own paint, holding the label (not a 'CTA slot' wrapper)."""
    return (node["type"] in ("FRAME", "GROUP") and node["name"].lower().startswith("cta")
            and bool(visible_paints(node) or visible_paints(node, "strokes")) and has_text(node))


def is_box(node):
    return node["type"] == "FRAME" and node["name"].lower().startswith("risk warning") and has_text(node)


def is_logo(node):
    """Logo vectors. A 'Logo + headline' lockup holds text, so it is a layout container instead."""
    return node["name"].lower().startswith("logo") and not has_text(node)


def holds_copy(node):
    """True when a container has live copy (headline/sub/disclosure/risk text, CTA or logo) somewhere inside.
    Those containers are auto-layout wrappers (Top group, Bottom group, Stack…) and get flattened;
    any other subtree stays one exported image (hero, phone UI, trust row, chips…)."""
    for n in walk(node):
        if n is node or n.get("visible", True) is False:
            continue
        if n["type"] == "TEXT" and text_role(n["name"]) != "other":
            return True
        if is_cta(n) or is_box(n) or is_logo(n):
            return True
    return False


def flatten(frame, diag):
    """Yield the leaf-level layers of a frame in paint order, descending into auto-layout wrappers."""
    for c in frame.get("children", []) or []:
        if c.get("visible", True) is False or "safe zone" in c["name"].lower():
            continue
        if c["type"] in ("FRAME", "GROUP", "SECTION") and not (is_cta(c) or is_box(c) or is_logo(c)) and holds_copy(c):
            own = visible_paints(c) or visible_paints(c, "strokes") or [e for e in c.get("effects", []) if e.get("visible", True)]
            if own:
                shp = simple_shape(dict(c, type="RECTANGLE"))
                if shp:
                    yield ("wrapper-shape", c)
                else:
                    diag.append(f"wrapper paint not reproduced: {c['name'][:60]}")
            yield from flatten(c, diag)
            continue
        yield ("node", c)


def convert_frame(concept, frame, fmt):
    bb = frame["absoluteBoundingBox"]
    W, H = round(bb["width"]), round(bb["height"])
    d, label, ver = label_from_name(concept, frame["name"])
    spec = {
        "id": f"{concept.lower().replace('-', '')}-{d.lower()}-{fmt.replace('.', '')}",
        "concept": concept, "direction": d, "label": label, "copyVersion": ver,
        "format": fmt, "width": W, "height": H, "figmaNode": frame["id"], "figmaName": frame["name"],
        "background": {"css": bg_css(frame)},
        "layers": [], "exports": [], "warnings": [],
    }
    for kind, c in flatten(frame, spec["warnings"]):
        nm = c["name"]
        low = nm.lower()
        if kind == "wrapper-shape":
            shp = simple_shape(dict(c, type="RECTANGLE"))
            spec["layers"].append({
                "id": c["id"], "kind": "shape", "role": "decor", "name": nm, "box": rel_box(c, bb),
                "fill": shp["fill"], "radius": c.get("cornerRadius", 0), "blend": "normal", "opacity": c.get("opacity", 1),
            })
            continue
        if c["type"] == "TEXT":
            spec["layers"].append(make_text_layer(c, bb, text_role(nm)))
            continue
        if is_cta(c):
            spec["layers"].append(container_layer(c, bb, "cta"))
            continue
        if is_box(c):
            spec["layers"].append(container_layer(c, bb, "box"))
            continue
        if is_logo(c):
            spec["layers"].append({
                "id": c["id"], "kind": "logo", "role": "logo", "name": nm,
                "box": rel_box(c, bb), "src": f"assets/{c['id'].replace(':', '-')}.svg",
            })
            spec["exports"].append({"id": c["id"], "format": "svg"})
            continue
        blend = (c.get("blendMode") or "PASS_THROUGH").lower().replace("_", "-")
        blend = "normal" if blend in ("pass-through", "normal") else blend
        shp = simple_shape(c)
        if shp:
            spec["layers"].append({
                "id": c["id"], "kind": "shape", "role": "decor", "name": nm,
                "box": rel_box(c, bb), "fill": shp["fill"], "radius": shp["radius"],
                "blend": blend, "opacity": c.get("opacity", 1),
            })
            continue
        rb = rel_box(c, bb)
        cb = content_box(c, bb)
        spec["layers"].append({
            "id": c["id"], "kind": "image", "role": "decor", "name": nm,
            "box": rb, "bbox": dict(rb), "rbox": rel_box(c, bb, "absoluteRenderBounds"), "ubox": union_box(c, bb), "content": cb, "blend": blend, "opacity": 1,
            "src": f"assets/{c['id'].replace(':', '-')}.png", "tags": tags_for(nm), "backdrop": needs_backdrop(c),
        })
        spec["exports"].append({"id": c["id"], "format": "png"})

    # roles for image layers: plate (full-bleed), hero (largest meaningful), decor
    area = W * H
    imgs = [l for l in spec["layers"] if l["kind"] == "image"]
    for l in imgs:
        cb = l["content"]
        if cb["w"] * cb["h"] >= 0.9 * area and not re.search(r"hero|photo|hand|numeral|illustration|sunburst|phone", l["name"], re.I):
            l["role"] = "plate"
    def head(l):
        return re.split(r" · |\(", l["name"])[0]

    named = [l for l in imgs if re.match(r"(?i)hero", l["name"])]
    cands = named or [l for l in imgs if HERO_WORDS.search(head(l))] or [
        l for l in imgs if l["role"] != "plate" and not HELPER_WORDS.search(l["name"])]
    if cands:
        def score(l):
            cb = l["content"]
            a = cb["w"] * cb["h"]
            return (a < 0.8 * area, a)
        hero = max(cands, key=score)
        hero["role"] = "hero"
        cb = hero["content"]
        hero["fullBleed"] = cb["w"] * cb["h"] >= 0.8 * area
    for l in imgs:
        if l["role"] == "plate" and not l["tags"]:
            l["tags"] = ["plate"]
    spec["visualTags"] = sorted({t for l in imgs if l["role"] in ("hero", "plate") or HERO_WORDS.search(re.split(r" · |\(", l["name"])[0]) or not HELPER_WORDS.search(l["name"]) for t in l["tags"] if t != "plate"})
    spec["texts"] = {l["role"]: "".join(r["t"] for r in l["runs"]) for l in spec["layers"] if l["kind"] == "text" and l["role"] in ("headline", "disclosure")}
    if "headline" not in spec["texts"]:
        spec["warnings"].append("no live headline: copy is baked into an image layer")
    return spec


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def place_exports(spec):
    """Exports include effects and rotation, so centre each PNG on its node's bounding box."""
    for l in spec["layers"]:
        if l["kind"] != "image" or not (SRC / l["src"]).exists():
            continue
        size = png_size(SRC / l["src"])
        if not size:
            continue
        r = l.get("rbox")
        if r and abs(r["w"] - size[0]) <= 2 and abs(r["h"] - size[1]) <= 2:
            l["box"] = {"x": r["x"], "y": r["y"], "w": size[0], "h": size[1]}
            continue
        u = l.get("ubox")
        if u and abs(u["w"] - size[0]) <= 3 and abs(u["h"] - size[1]) <= 3:
            l["box"] = {"x": u["x"], "y": u["y"], "w": size[0], "h": size[1]}
            continue
        b = l["bbox"]
        cx, cy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        l["box"] = {"x": round(cx - size[0] / 2, 2), "y": round(cy - size[1] / 2, 2), "w": size[0], "h": size[1]}


def overlaps(a, b):
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


def apply_backdrops(pieces, fresh):
    """Swap layers that need their backdrop for a crop of the frame render, when nothing above them overlaps."""
    todo = []
    for spec in pieces:
        layers = spec["layers"]
        for i, l in enumerate(layers):
            if l.get("kind") != "image" or not l.get("backdrop"):
                continue
            W, H = spec["width"], spec["height"]
            x0, y0 = max(0, l["box"]["x"]), max(0, l["box"]["y"])
            x1, y1 = min(W, l["box"]["x"] + l["box"]["w"]), min(H, l["box"]["y"] + l["box"]["h"])
            region = {"x": round(x0), "y": round(y0), "w": round(x1 - x0), "h": round(y1 - y0)}
            above = [o for o in layers[i + 1:] if o.get("box") and overlaps(o["box"], region)]
            if above:
                spec["warnings"].append(f"{l['id']} needs its backdrop but {above[0]['name'][:40]} sits above it")
                continue
            todo.append((spec, l, region))
    frames = sorted({spec["figmaNode"] for spec, _, _ in todo})
    fdir = SRC / "frames"
    fdir.mkdir(parents=True, exist_ok=True)
    need = [f for f in frames if fresh or not (fdir / f"{f.replace(':', '-')}.png").exists()]
    for k in range(0, len(need), 8):
        res = ultron("get_images", {"file_key": FILE_KEY, "ids": need[k:k + 8], "format": "png", "scale": 1})
        for nid, url in (res.get("images") or {}).items():
            if url:
                subprocess.run([CURL, "-sSL", "--retry", "3", "-o", str(fdir / f"{nid.replace(':', '-')}.png"), url])
    for spec, l, r in todo:
        src = fdir / f"{spec['figmaNode'].replace(':', '-')}.png"
        if not src.exists():
            continue
        out = SRC / "assets" / f"{l['id'].replace(':', '-')}-ctx.png"
        shutil.copy(src, out)
        subprocess.run(["sips", "-c", str(r["h"]), str(r["w"]), "--cropOffset", str(r["y"]), str(r["x"]), str(out)], capture_output=True, check=True)
        l["src"] = f"assets/{out.name}"
        l["box"] = dict(r); l["rbox"] = dict(r); l["content"] = dict(r)
        l["blend"] = "normal"


def apply_bakes(pieces, bakes):
    """Config "bake": {"<piece id>": {"region": {x, y, w, h}, "replace": [layer ids]}} swaps those layers for one
    crop of the Figma frame render. For heroes whose backdrop blend sits under live text (keep the region clear of it)."""
    fdir = SRC / "frames"
    fdir.mkdir(parents=True, exist_ok=True)
    for spec in pieces:
        b = bakes.get(spec["id"])
        if not b:
            continue
        nid = spec["figmaNode"]
        src = fdir / f"{nid.replace(':', '-')}-bake.png"
        res = ultron("get_images", {"file_key": FILE_KEY, "ids": [nid], "format": "png", "scale": 1})
        url = (res.get("images") or {}).get(nid)
        if url:
            subprocess.run([CURL, "-sSL", "--retry", "3", "-o", str(src), url])
        if not src.exists():
            spec["warnings"].append(f"bake: no frame render for {nid}")
            continue
        r = b["region"]
        out = SRC / "assets" / f"{nid.replace(':', '-')}-bake.png"
        shutil.copy(src, out)
        subprocess.run(["sips", "-c", str(r["h"]), str(r["w"]), "--cropOffset", str(r["y"]), str(r["x"]), str(out)], capture_output=True, check=True)
        layers = spec["layers"]
        idx = [i for i, l in enumerate(layers) if l["id"] in b["replace"]]
        if not idx:
            spec["warnings"].append("bake: none of the listed layers found")
            continue
        new = dict(layers[idx[0]], src=f"assets/{out.name}", box=dict(r), rbox=dict(r), content=dict(r), bbox=dict(r),
                   ubox=dict(r), blend="normal", opacity=1, backdrop=False, name=layers[idx[0]]["name"] + " (baked from Figma render)")
        spec["layers"] = [l for l in layers if l["id"] not in b["replace"]]
        spec["layers"].insert(idx[0], new)
        spec["warnings"] = [w for w in spec["warnings"] if not any(w.startswith(f"{i} ") for i in b["replace"])]


def export_images(ids_fmt, dest):
    """Export node ids via figma get_images (scale 1) and download them."""
    dest.mkdir(parents=True, exist_ok=True)
    failed = []
    by_fmt = {}
    for i, f in ids_fmt:
        by_fmt.setdefault(f, []).append(i)
    for fmt, ids in by_fmt.items():
        for k in range(0, len(ids), 8):
            batch = ids[k:k + 8]
            params = {"file_key": FILE_KEY, "ids": batch, "format": fmt, "scale": 1}
            try:
                res = ultron("get_images", params)
            except RuntimeError as e:
                log("  export failed", batch, e)
                failed += batch
                continue
            urls = res.get("images") or {}
            for nid in batch:
                url = urls.get(nid)
                out = dest / f"{nid.replace(':', '-')}.{fmt}"
                if not url:
                    failed.append(nid)
                    continue
                p = subprocess.run([CURL, "-sSL", "--retry", "3", "-o", str(out), url])
                if p.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                    failed.append(nid)
            log(f"  {fmt}: {min(k + 8, len(ids))}/{len(ids)}")
    return failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-images", action="store_true", help="reuse already exported PNG/SVG files")
    ap.add_argument("--missing-only", action="store_true", help="export only layers and thumbnails not on disk yet")
    args = ap.parse_args()
    global FILE_KEY, FONT_MAP, PROPER
    if not CONFIG_PATH.exists():
        sys.exit(f"Missing {CONFIG_PATH.relative_to(ROOT)}. See README: Import config.")
    cfg = json.loads(CONFIG_PATH.read_text())
    FILE_KEY = cfg["file_key"]
    FONT_MAP = {ps: tuple(v[:3]) for ps, v in cfg["fonts"].items()}
    PROPER = tuple(cfg.get("proper_words", [])) + PROPER
    PAGES = [tuple(p) for p in (cfg.get("sections") or cfg["pages"])]
    BRIEF = dict(cfg["brief"], figmaFile=FILE_KEY, uiFonts=cfg.get("ui_fonts", {}),
                 fontFaces={v[3]: v[:3] for v in cfg["fonts"].values()})
    font_dir = Path(os.path.expanduser(cfg.get("font_dir", "~/Library/Fonts")))
    if (SRC / "pieces").exists() and not args.skip_images:
        shutil.rmtree(SRC / "pieces")
    (SRC / "pieces").mkdir(parents=True, exist_ok=True)
    (SRC / "fonts").mkdir(parents=True, exist_ok=True)

    # 1. discover frames: masters "<Concept> · Dn · …" (9:16), resizes "<Concept> · Dn · <WxH> · <ref>"
    if cfg.get("sections"):
        page = ultron("get_file_nodes", {"file_key": FILE_KEY, "ids": [cfg["page"]], "depth": 2})["nodes"][cfg["page"]]["document"]
        containers = {c["id"]: c for c in page.get("children", [])}
    else:
        containers = {pid: n["document"] for pid, n in ultron(
            "get_file_nodes", {"file_key": FILE_KEY, "ids": [p for _, p in PAGES], "depth": 1})["nodes"].items()}
    found, skipped, seen = [], [], {}  # found: (concept, frame id, fmt)
    for concept, cid in PAGES:
        if cid not in containers:
            sys.exit(f"Section/page {cid} ({concept}) not found in the file. Update build_src/import-config.json.")
        rx = re.compile(rf"^{re.escape(concept)} · (D\d+) · (.+)$")
        for c in containers[cid].get("children", []):
            m = rx.match(c["name"]) if c["type"] == "FRAME" else None
            if not m:
                continue
            b = c["absoluteBoundingBox"]
            size = (round(b["width"]), round(b["height"]))
            fmt = FORMATS.get(size)
            if not fmt:
                skipped.append({"frame": c["id"], "name": c["name"], "reason": f"size {size[0]}x{size[1]} is not a deliverable format"})
                continue
            named = re.match(r"(\d+)x(\d+)\b", m.group(2))
            if fmt != "9x16" and not named:
                skipped.append({"frame": c["id"], "name": c["name"], "reason": "resize without '<WxH>' in its name"})
                continue
            if named and (int(named.group(1)), int(named.group(2))) != size:
                log(f"  note: {c['name']} is {size[0]}x{size[1]}; using the real size")
            key = (concept, m.group(1), fmt)
            if key in seen:
                skipped.append({"frame": c["id"], "name": c["name"], "reason": f"duplicate of {seen[key]}"})
                continue
            seen[key] = c["id"]
            found.append((concept, c["id"], fmt))
    log(f"found {len(found)} frames" + (f", skipped {len(skipped)}" if skipped else ""))

    # 2. full trees
    nodes = {}
    ids = [f for _, f, _ in found]
    for k in range(0, len(ids), 6):
        nodes.update(ultron("get_file_nodes", {"file_key": FILE_KEY, "ids": ids[k:k + 6]})["nodes"])

    pieces, exports, failed_pieces = [], [], []
    for concept, fid, fmt in found:
        try:
            spec = convert_frame(concept, nodes[fid]["document"], fmt)
        except Exception as e:  # keep going, report at the end
            failed_pieces.append({"frame": fid, "error": repr(e)})
            continue
        spec["thumb"] = f"thumbs/{fid.replace(':', '-')}.png"
        pieces.append(spec)
        exports += [(e["id"], e["format"]) for e in spec["exports"]]

    masters = {(p["concept"], p["direction"]): p for p in pieces if p["format"] == "9x16"}
    for p in pieces:
        m = masters.get((p["concept"], p["direction"]))
        if p["format"] != "9x16":
            if m:
                p["label"], p["copyVersion"] = m["label"], m["copyVersion"]
            else:
                p["warnings"].append("no 9:16 master for this direction")
    pieces.sort(key=lambda p: p["format"] != "9x16")

    # 3. exports
    failed = []
    if not args.skip_images:
        if args.missing_only:
            exports = [(i, f) for i, f in exports if not (SRC / "assets" / f"{i.replace(':', '-')}.{f}").exists()]
        log(f"exporting {len(exports)} layers")
        failed = export_images(exports, SRC / "assets")
        log("exporting thumbnails")
        tdest = SRC / "thumbs"
        tdest.mkdir(parents=True, exist_ok=True)
        tids = [i for i in ids if not (args.missing_only and (tdest / f"{i.replace(':', '-')}.png").exists())]
        for k in range(0, len(tids), 8):
            res = ultron("get_images", {"file_key": FILE_KEY, "ids": tids[k:k + 8], "format": "png", "scale": 0.5})
            for nid, url in (res.get("images") or {}).items():
                if url:
                    subprocess.run([CURL, "-sSL", "--retry", "3", "-o", str(tdest / f"{nid.replace(':', '-')}.png"), url])
    for spec in pieces:
        place_exports(spec)
    apply_backdrops(pieces, fresh=not args.skip_images)
    apply_bakes(pieces, cfg.get("bake", {}))
    for spec in pieces:
        spec["missingAssets"] = [l["id"] for l in spec["layers"] if l.get("src") and not (SRC / l["src"]).exists()]
        spec.pop("exports", None)
        (SRC / "pieces" / f"{spec['id']}.json").write_text(json.dumps(spec, indent=1, ensure_ascii=False))

    # 4. brief data: copy per concept/version (read from the frames)
    concepts = {}
    for spec in pieces:
        c = concepts.setdefault(spec["concept"], {"name": spec["concept"], "copy": {}, "directions": {}})
        if spec["copyVersion"] and "headline" in spec["texts"]:
            c["copy"].setdefault(spec["copyVersion"], {"headline": spec["texts"]["headline"], "disclosure": spec["texts"].get("disclosure", "")})
        d = c["directions"].setdefault(spec["direction"], {
            "id": spec["direction"], "label": f"{spec['direction']} · {spec['label']}",
            "copyVersion": spec["copyVersion"], "formats": {k: None for k in ["9x16", "1x1", "4x5", "1.91x1"]},
        })
        d["formats"][spec["format"]] = spec["id"]
    brief = dict(BRIEF, concepts=[
        {"name": c["name"], "copy": c["copy"],
         "directions": sorted(c["directions"].values(), key=lambda x: int(x["id"][1:]))}
        for c in (concepts[n] for n, _ in PAGES if n in concepts)
    ])
    # advertiser mark for the in-situ feed avatar: the symbol cropped from an exported official logo
    for svg_path in sorted((SRC / "assets").glob("*.svg")):
        m = re.search(r'<path d="([^"]+)"', svg_path.read_text())
        if m:
            brief["advertiserMark"] = ('<svg viewBox="-1 -1 49 56" xmlns="http://www.w3.org/2000/svg">'
                                       f'<path d="{m.group(1)}" fill="currentColor"/></svg>')
            break
    (SRC / "brief.json").write_text(json.dumps(brief, indent=1, ensure_ascii=False))

    # 5. fonts
    for f in BRIEF["fontFaces"]:
        src = font_dir / f
        if src.exists():
            shutil.copy2(src, SRC / "fonts" / f)
        else:
            log("missing font", f)
    if not (SRC / "comments-seed.json").exists():
        (SRC / "comments-seed.json").write_text("[]")

    slots = {(p["concept"], p["direction"], p["format"]) for p in pieces}
    empty = [f"{c['name']} {d['id']} {f}" for c in brief["concepts"] for d in c["directions"]
             for f, v in d["formats"].items() if not v]
    report = {"pieces": len(pieces), "byFormat": {f: sum(1 for s in slots if s[2] == f) for f in FORMATS.values()},
              "emptySlots": empty, "failedPieces": failed_pieces, "failedExports": failed,
              "skippedFrames": skipped,
              "missingAssets": {p["id"]: p["missingAssets"] for p in pieces if p["missingAssets"]},
              "warnings": {p["id"]: p["warnings"] for p in pieces if p.get("warnings")},
              "flat": [p["id"] for p in pieces if any(w.startswith("no live headline") for w in p.get("warnings", []))]}
    (SRC / "import-report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
