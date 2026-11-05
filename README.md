# Review room

A password-protected, dependency-free static web app for reviewing a set of static ads with the team:
pick a concept, direction and format, see each piece flat or in a generic in-situ mockup, drop
Figma-style comments, edit copy and images live, and read an explainable performance heuristic.

Everything that identifies the work (piece specs, images, fonts, brief data, heuristic weights,
comment seed) is encrypted at build time. The public repo only holds the app shell and ciphertext.

## Layout

```
app/                 source app shell (HTML, CSS, vanilla ES modules). No content.
  js/vault.js        decrypts the packs with WebCrypto
  js/render.js       live artboard renderer + auto-layout-like reflow + safe-zone check
  js/comments.js     comment pins, threads, sidebar
  js/edit.js         in-place text editing, neon toggle, image swap/crop/nudge, undo
  js/perf.js         heuristic engine (rules come from the encrypted weights file)
  js/store.js        storage adapters (LocalAdapter, RemoteAdapter stub)
  js/mockups.js      generic in-situ mockups (no third-party marks)
tools/import_figma.py  re-runnable Figma importer -> build_src/
tools/build.py         encrypts build_src/ and writes docs/
docs/                what GitHub Pages serves: the shell + data/*.enc
build_src/           PLAINTEXT content. Git-ignored. Never commit it.
```

## Requirements

- macOS `python3` (stdlib only) and `openssl` (LibreSSL 3.x works).
- The `ultron` CLI, logged in once: `ultron login`. Check with `test -f ~/.ultron/credentials.json`.
- The brand fonts installed in `~/Library/Fonts`.

## Import config

`build_src/import-config.json` (git-ignored) holds the brief-specific settings:

```json
{
  "file_key": "<figma file key>",
  "brief": { "id": "<brief id>", "name": "<brief name>", "market": "<market>", "advertiser": "<name shown in mockups>" },
  "page": "<page node id>",
  "sections": [["<Concept>", "<section node id>"]],
  "font_dir": "~/Library/Fonts",
  "fonts": { "<PostScriptName>": ["<CSS family>", 400, "normal", "<file name>.otf"] },
  "ui_fonts": { "ui": "<UI family>", "display": "<display family>" },
  "proper_words": ["<words that keep their capital in direction labels>"]
}
```

All pieces live on one page with a Section per concept (the older `"pages": [["<Concept>", "<page id>"]]`
form, one page per concept, still works). In each Section the importer takes the FRAME nodes named
`<Concept> · Dn · …`:

- masters, 1080x1920 (9:16): `<Concept> · Dn · <title> · Vn`
- resizes, `<Concept> · Dn · <WxH> · <ref>` at 1080x1080 (1:1), 1200x1500 (4:5) or 1200x628 (1.91:1)

Everything else (anchor notes, `Asset · …` helper frames, REF rectangles, labels) is ignored; skipped
frames and duplicates are listed in the import report. The direction label and copy version come from the
master's name (`D1 · Clone of brief ref 03 (sunburst)`; "new art direction" becomes `New art direction`)
and resizes inherit them. Auto-layout wrappers (Top group, Bottom group, stacks, columns) are flattened so
headline, sub, disclosure, CTA, risk box and logo stay live; every other subtree is exported as one image.
A missing format falls back to the 9:16 master in the app.

`build_src/performance-weights.json` (git-ignored, encrypted into the build) holds every factor, weight,
label and suggestion of the heuristic. Tune it there and rebuild. Back it up: it is not in git.

## Import

```sh
python3 tools/import_figma.py                  # full import: specs, layer PNG/SVG exports, 0.5x thumbnails
python3 tools/import_figma.py --missing-only   # re-export only files not on disk yet
python3 tools/import_figma.py --skip-images    # specs only, reuse exported files
```

Each frame becomes `build_src/pieces/<id>.json`: background (CSS from the frame fill), live text layers
(role, characters, font, size, line height, tracking, fills, neon runs, box, alignment), logo (SVG),
image/hero groups (PNG with transparency, scale 1), CTA pill and risk box (shape + label). The import
report (`build_src/import-report.json`) lists pieces per format, empty format slots, failed frames and
exports, skipped frames, and any piece without a live headline (`flat`: it would show as a picture only).

Re-run the importer whenever the Figma pieces change, then rebuild.

## Build

```sh
read -s RR_PASSWORD && export RR_PASSWORD && python3 tools/build.py   # keeps the password out of shell history
# or simply:
python3 tools/build.py                                                 # prompts twice
```

The password is read from `RR_PASSWORD` or a prompt, never from a file. Each pack is encrypted with
`openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt`; the build self-tests one pack with the
same PBKDF2-SHA256 (48 bytes = 32 key + 16 IV) + AES-CBC scheme the browser uses.

## Preview

```sh
python3 -m http.server 8765 --directory docs
```

Open http://localhost:8765. After unlock the password stays in `sessionStorage` for that tab.

## Deploy on GitHub Pages

1. Commit `app/`, `tools/`, `docs/`, `README.md`, `.gitignore` (never `build_src/`).
2. Push to GitHub, then Settings → Pages → Source: "Deploy from a branch" → Branch `main`, folder `/docs`.
3. Rebuild and push again after every import. Each build re-encrypts everything with new salts.

Security notes:
- This is a static site: anyone can download the ciphertext and try passwords offline. Use a long,
  random password and share it out of band.
- Changing the password does not protect old commits: their packs still open with the old password.
  To retire a password, rewrite history or start a fresh repo.
- Hosting on a personal GitHub Pages origin is outside the company's managed deployment paths. It was
  confirmed knowingly; for a sanctioned internal host ask in #ask-ai.

## Using it

| Key | Action |
| --- | --- |
| ↑ ↓ | previous / next direction |
| ← → | previous / next concept (nudges the selected image in Edit mode) |
| 1–4 | format: 9:16, 1:1, 4:5, 1.91:1 |
| V / C / E | View, Comment, Edit mode |
| M | in-situ mockup / flat view (every piece opens in situ) |
| S | 9:16 safe zone (x115–895, y350–1540) |
| F | Figma render: tap to toggle, hold to compare |
| ⌘K | quick switcher |
| ⌘Z / ⌘⇧Z | undo / redo (Edit mode) |
| Esc | close popover, leave the mode |

- Comment mode: click the piece to drop a pin, pick Design, Copy or L&C, add your name (remembered)
  and the note. Pins are stored in artboard percentages, so they survive zoom and mockups. Threads
  support replies and resolve/reopen; the sidebar filters by discipline and status.
- Edit mode: text is editable in place and the stack (logo → headline → sub → CTA → hero → disclosure →
  box) reflows with the gaps measured from Figma; the hero crops instead of overlapping; a chip warns
  when copy leaves the safe zone. Select a headline word and press Neon to toggle the accent. Click an
  image, the logo or the background to swap from the concept library, fit/fill, scale and nudge.
  "Reset to Figma" restores the piece. Edits are saved per piece in this browser.
- Performance tab: a heuristic estimate based only on the written learnings and QA rules, shown as a
  0–100 score relative to the set average, with drivers and one suggestion. It never forecasts CTR or NFA.

## Shared comments (not wired)

GitHub Pages has no backend, so comments and edits live in each reviewer's browser (`localStorage`).
Use Export JSON / Import JSON in the Comments tab to merge a teammate's notes.

For live shared comments, pick a backend and wire it in `app/js/store.js`:
set `REMOTE_CONFIG.endpoint` (and headers) and make `createCommentStore` return `new RemoteAdapter()`.
The adapter contract is `list(scope)`, `add(item)`, `update(id, patch)`, `subscribe(fn)`. No
third-party service has been signed up for or configured.
