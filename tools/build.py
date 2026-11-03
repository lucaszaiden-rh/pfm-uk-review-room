#!/usr/bin/env python3
"""Build the password-protected static site into docs/ (what GitHub Pages serves).

The password comes from the RR_PASSWORD env var or an interactive prompt, never
from a file. All content (piece specs, images, fonts, weights, comment seed) is
packed and encrypted with `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt`;
docs/ only ever holds the app shell plus ciphertext.

Usage:
    RR_PASSWORD=... python3 tools/build.py
    python3 tools/build.py            # prompts for the password
"""
import getpass
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build_src"
APP = ROOT / "app"
OUT = ROOT / "docs"
ITER = 200000
MIME = {".png": "image/png", ".svg": "image/svg+xml", ".otf": "font/otf", ".ttf": "font/ttf",
        ".json": "application/json", ".jpg": "image/jpeg"}


def password():
    pw = os.environ.get("RR_PASSWORD")
    if pw:
        return pw
    if not sys.stdin.isatty():
        sys.exit("Set RR_PASSWORD or run in a terminal to be prompted.")
    pw = getpass.getpass("Review room password: ")
    if pw != getpass.getpass("Repeat password: "):
        sys.exit("Passwords do not match.")
    return pw


def make_pack(files):
    """files: {name: Path|bytes} -> container bytes ("RRPK" + header len + JSON header + payload)."""
    header, chunks, off = {"files": {}}, [], 0
    for name, src in files.items():
        data = src if isinstance(src, bytes) else Path(src).read_bytes()
        t = MIME.get(Path(name).suffix, mimetypes.guess_type(name)[0] or "application/octet-stream")
        header["files"][name] = {"o": off, "l": len(data), "t": t}
        chunks.append(data)
        off += len(data)
    h = json.dumps(header, separators=(",", ":")).encode()
    return b"RRPK" + struct.pack(">I", len(h)) + h + b"".join(chunks)


def encrypt(data, out, env):
    with tempfile.NamedTemporaryFile(dir=SRC, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        subprocess.run(["openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", str(ITER), "-md", "sha256",
                        "-salt", "-in", tmp_path, "-out", str(out), "-pass", "env:RR_PASSWORD"],
                       check=True, env=env)
    finally:
        os.unlink(tmp_path)


def self_test(path, env):
    """Decrypt one pack the way the browser does (PBKDF2 -> key+IV, then AES-CBC) to prove compatibility."""
    raw = Path(path).read_bytes()
    assert raw[:8] == b"Salted__"
    dk = hashlib.pbkdf2_hmac("sha256", env["RR_PASSWORD"].encode(), raw[8:16], ITER, 48)
    with tempfile.NamedTemporaryFile(dir=SRC, delete=False) as tmp:
        tmp.write(raw[16:])
        tmp_path = tmp.name
    try:
        p = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-nosalt", "-K", dk[:32].hex(),
                            "-iv", dk[32:].hex(), "-in", tmp_path], capture_output=True, check=True)
    finally:
        os.unlink(tmp_path)
    assert p.stdout[:4] == b"RRPK", "self-test failed"


def main():
    if not (SRC / "brief.json").exists():
        sys.exit("build_src/ is empty. Run tools/import_figma.py first.")
    env = dict(os.environ, RR_PASSWORD=password())

    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(APP, OUT)
    (OUT / ".nojekyll").write_text("")
    data = OUT / "data"
    data.mkdir()

    brief = json.loads((SRC / "brief.json").read_text())
    pieces = {}
    for f in sorted((SRC / "pieces").glob("*.json")):
        spec = json.loads(f.read_text())
        pieces[spec["id"]] = spec

    names = {}

    def pack_name(key):
        if key not in names:
            names[key] = secrets.token_hex(6) + ".enc"
        return names[key]

    assets = {}  # asset path -> pack
    library = {}  # concept -> [asset refs] for the edit-mode swap menu
    for pid, spec in pieces.items():
        files = {}
        for layer in spec["layers"]:
            src = layer.get("src")
            if src and (SRC / src).exists():
                files[src] = SRC / src
                assets[src] = pack_name(pid)
                if layer.get("role") in ("hero", "plate"):
                    library.setdefault(spec["concept"], []).append({
                        "src": src, "piece": pid, "direction": spec["direction"], "role": layer["role"],
                        "name": layer["name"], "box": layer["box"], "content": layer.get("content", layer["box"]),
                        "tags": layer.get("tags", []),
                    })
        encrypt(make_pack(files), data / pack_name(pid), env)

    thumbs = {}
    for spec in pieces.values():
        t = spec.get("thumb")
        if t and (SRC / t).exists():
            thumbs[t] = SRC / t
            assets[t] = pack_name("thumbs")
    encrypt(make_pack(thumbs), data / pack_name("thumbs"), env)

    fonts = {f"fonts/{p.name}": p for p in sorted((SRC / "fonts").glob("*")) if p.suffix in (".otf", ".ttf")}
    fonts_pack = pack_name("fonts")
    encrypt(make_pack(fonts), data / fonts_pack, env)

    weights = json.loads((SRC / "performance-weights.json").read_text()) if (SRC / "performance-weights.json").exists() else {"factors": []}
    seed = json.loads((SRC / "comments-seed.json").read_text()) if (SRC / "comments-seed.json").exists() else []
    manifest = {
        "brief": brief, "pieces": pieces, "assets": assets, "library": library,
        "fonts": {"pack": fonts_pack, "files": list(fonts)}, "weights": weights, "commentsSeed": seed,
        "builtAt": __import__("datetime").datetime.now().isoformat(timespec="minutes"),
    }
    encrypt(make_pack({"manifest.json": json.dumps(manifest, ensure_ascii=False).encode()}), data / "m.enc", env)
    self_test(data / "m.enc", env)

    total = sum(p.stat().st_size for p in data.iterdir())
    print(f"Built docs/ · {len(pieces)} pieces · {len(list(data.iterdir()))} encrypted packs · {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
