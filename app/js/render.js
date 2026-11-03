// Renders a piece spec as a live HTML artboard and reflows it like a vertical auto-layout stack.

export const SAFE_ZONE = { x0: 115, x1: 895, y0: 350, y1: 1540 };
export const NEON = 'rgba(204,255,0,1)';
const FLOW_KINDS = new Set(['text', 'cta', 'box', 'logo']);
const DEFAULT_GAP = 48;

const h = (tag, cls, style) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) Object.assign(e.style, style);
  return e;
};
const px = (v) => `${Math.round(v * 100) / 100}px`;
const clone = (o) => JSON.parse(JSON.stringify(o));

export function runsToText(runs) {
  return (runs || []).map((r) => r.t).join('');
}

export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out[out.length - 1];
    if (last && last.fill === r.fill && last.family === r.family && last.weight === r.weight && last.style === r.style) last.t += r.t;
    else out.push({ ...r });
  }
  return out;
}

function fontCss(st) {
  return {
    fontFamily: `'${st.family}', system-ui, sans-serif`,
    fontWeight: String(st.weight || 400),
    fontStyle: st.style || 'normal',
    fontSize: px(st.size),
    lineHeight: st.lineHeight ? px(st.lineHeight) : 'normal',
    letterSpacing: px(st.letterSpacing || 0),
    textAlign: st.align === 'justified' ? 'left' : st.align,
  };
}

export function paintRuns(el, runs, base) {
  el.textContent = '';
  for (const r of runs) {
    const s = document.createElement('span');
    s.textContent = r.t;
    if (r.fill && r.fill !== base) {
      s.style.color = r.fill;
      s.dataset.fill = r.fill;
    }
    if (r.family) {
      s.style.fontFamily = `'${r.family}'`;
      s.style.fontWeight = String(r.weight);
      s.style.fontStyle = r.style;
      s.dataset.font = JSON.stringify({ family: r.family, weight: r.weight, style: r.style });
    }
    el.appendChild(s);
  }
  if (!runs.length || runsToText(runs).endsWith('\n')) el.appendChild(document.createElement('br'));
}

export function readRuns(el, base) {
  const runs = [];
  const walk = (node, fill, font) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) runs.push({ t: c.nodeValue.replace(/ /g, ' '), fill, ...(font || {}) });
      else if (c.nodeName === 'BR') {
        if (c !== el.lastChild) runs.push({ t: '\n', fill, ...(font || {}) });
      } else if (c.nodeType === 1) {
        const isBlock = c.nodeName === 'DIV' || c.nodeName === 'P';
        if (isBlock && runs.length && !runsToText(runs).endsWith('\n')) runs.push({ t: '\n', fill });
        const f = c.dataset?.fill || fill;
        const ft = c.dataset?.font ? JSON.parse(c.dataset.font) : font;
        walk(c, f, ft);
      }
    }
  };
  walk(el, base, null);
  return mergeRuns(runs);
}

// Text offsets of the current selection inside `el`, in characters of runsToText.
export function selectionOffsets(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const offsetOf = (container, offset) => {
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(container, offset);
    const frag = pre.cloneContents();
    const tmp = document.createElement('div');
    tmp.appendChild(frag);
    return readRuns(tmp, '').map((r) => r.t).join('').length;
  };
  return { start: offsetOf(range.startContainer, range.startOffset), end: offsetOf(range.endContainer, range.endOffset) };
}

export function setSelectionOffsets(el, start, end) {
  const pos = (target) => {
    let n = 0;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = tw.nextNode())) {
      const len = node.nodeValue.length;
      if (n + len >= target) return [node, target - n];
      n += len;
    }
    return [el, el.childNodes.length];
  };
  const r = document.createRange();
  const [a, ao] = pos(start);
  const [b, bo] = pos(end);
  r.setStart(a, ao);
  r.setEnd(b, bo);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

export function toggleNeonRange(runs, start, end, base) {
  if (end <= start) return runs;
  const chars = [];
  for (const r of runs) for (const ch of r.t) chars.push({ ...r, t: ch });
  const slice = chars.slice(start, end).filter((c) => c.t !== '\n');
  const allNeon = slice.length && slice.every((c) => /^rgba\(204,\s*255,\s*0,\s*1(\.0+)?\)$/.test(c.fill || ''));
  for (let i = start; i < end && i < chars.length; i++) chars[i].fill = allNeon ? base : NEON;
  return mergeRuns(chars);
}

function overlapX(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 4;
}

export class PieceView {
  constructor(spec, { resolve, edits, assetInfo }) {
    this.spec = spec;
    this.resolve = resolve; // async (path) -> blob url
    this.assetInfo = assetInfo || (() => null);
    this.edits = edits ? clone(edits) : { texts: {}, images: {}, background: null };
    this.el = h('div', 'artboard', { width: px(spec.width), height: px(spec.height), background: spec.background.css });
    this.el.dataset.piece = spec.id;
    this.nodes = new Map();
    this.baseline = new Map();
    this.editable = false;
  }

  layerById(id) {
    return this.spec.layers.find((l) => l.id === id);
  }

  currentRuns(layer) {
    return this.edits.texts[layer.id] || layer.runs;
  }

  async mount() {
    const s = this.spec;
    this.bgEl = h('div', 'L L-bg', { left: 0, top: 0, width: '100%', height: '100%' });
    this.el.appendChild(this.bgEl);
    const jobs = [];
    for (const layer of s.layers) {
      let node;
      if (layer.kind === 'text') node = this.makeText(layer, layer);
      else if (layer.kind === 'cta' || layer.kind === 'box') node = this.makeContainer(layer);
      else if (layer.kind === 'shape') {
        node = h('div', 'L L-shape', {
          left: px(layer.box.x), top: px(layer.box.y), width: px(layer.box.w), height: px(layer.box.h),
          background: layer.fill, borderRadius: typeof layer.radius === 'number' ? px(layer.radius) : layer.radius,
          mixBlendMode: layer.blend, opacity: layer.opacity,
        });
      } else if (layer.kind === 'image' || layer.kind === 'logo') {
        node = h('div', `L L-img role-${layer.role}`, {
          left: px(layer.box.x), top: px(layer.box.y), width: px(layer.box.w), height: px(layer.box.h),
          mixBlendMode: layer.blend || 'normal', opacity: layer.opacity ?? 1,
        });
        const frame = h('div', 'L-frame');
        const img = h('img');
        img.alt = '';
        img.draggable = false;
        frame.appendChild(img);
        node.appendChild(frame);
        node._img = img;
        node._frame = frame;
        jobs.push(this.resolve(layer.src).then((u) => { if (u) img.src = u; else node.classList.add('missing'); }));
      }
      if (!node) continue;
      node.dataset.layer = layer.id;
      node.dataset.role = layer.role;
      this.nodes.set(layer.id, node);
      this.el.appendChild(node);
    }
    await Promise.all(jobs);
    const settle = (i) => (i.complete ? null : Promise.race([i.decode().catch(() => null), new Promise((r) => setTimeout(r, 400))]));
    await Promise.all([...this.el.querySelectorAll('img')].map(settle));
    this.measureBaseline();
    await this.applyAllEdits();
    return this;
  }

  makeText(layer, textLayer) {
    const st = textLayer.style;
    const node = h('div', `L L-text role-${textLayer.role}`, { ...fontCss(st), color: textLayer.color, opacity: textLayer.opacity ?? 1 });
    const pre = st.autoResize === 'WIDTH_AND_HEIGHT';
    node.style.whiteSpace = 'pre-wrap';
    if (layer === textLayer) {
      node.style.left = px(textLayer.box.x);
      node.style.top = px(textLayer.box.y);
      node.style.width = pre ? 'max-content' : px(textLayer.box.w);
      if (pre) node.style.maxWidth = px(this.maxTextWidth(textLayer.box));
    }
    node.dataset.text = textLayer.id;
    node.spellcheck = false;
    paintRuns(node, this.currentRuns(textLayer), textLayer.color);
    return node;
  }

  maxTextWidth(box) {
    const W = this.spec.width;
    const nine = this.spec.format === '9x16';
    const left = nine ? SAFE_ZONE.x0 : Math.min(box.x, W - box.x - box.w);
    const right = nine ? SAFE_ZONE.x1 : W - left;
    const centered = Math.abs(box.x + box.w / 2 - W / 2) < 6;
    const avail = centered ? right - left : right - box.x;
    return Math.max(box.w, avail);
  }

  makeContainer(layer) {
    const node = h('div', `L L-${layer.kind}`, {
      left: px(layer.box.x), top: px(layer.box.y), background: layer.fill,
      borderRadius: px(layer.radius || 0),
      border: layer.stroke ? `${px(layer.strokeWeight)} solid ${layer.stroke}` : 'none',
    });
    const p = layer.padding || { l: 0, t: 0, r: 0, b: 0 };
    node.style.padding = `${px(p.t)} ${px(p.r)} ${px(p.b)} ${px(p.l)}`;
    if (layer.kind === 'box' || layer.sizing?.h === 'FIXED') node.style.width = px(layer.box.w);
    if (layer.text) {
      const t = this.makeText(layer, layer.text);
      t.style.position = 'relative';
      t.style.width = layer.kind === 'box' ? '100%' : 'max-content';
      t.style.whiteSpace = layer.kind === 'box' ? 'pre-wrap' : 'pre';
      node.appendChild(t);
      this.nodes.set(layer.text.id, t);
    }
    return node;
  }

  measureBaseline() {
    for (const layer of this.spec.layers) {
      const n = this.nodes.get(layer.id);
      if (!n || !FLOW_KINDS.has(layer.kind)) continue;
      const saved = layer.kind === 'text' ? n.innerHTML : null;
      if (layer.kind === 'text' && this.edits.texts[layer.id]) paintRuns(n, layer.runs, layer.color);
      this.baseline.set(layer.id, { h: layer.kind === 'logo' ? layer.box.h : n.offsetHeight, w: n.offsetWidth });
      if (saved !== null) n.innerHTML = saved;
    }
    for (const layer of this.spec.layers) {
      if ((layer.kind === 'cta' || layer.kind === 'box') && layer.text && this.edits.texts[layer.text.id]) {
        const t = this.nodes.get(layer.text.id);
        const saved = t.innerHTML;
        paintRuns(t, layer.text.runs, layer.text.color);
        const n = this.nodes.get(layer.id);
        this.baseline.set(layer.id, { h: n.offsetHeight, w: n.offsetWidth });
        t.innerHTML = saved;
      }
    }
  }

  async applyAllEdits() {
    for (const layer of this.spec.layers) {
      const tl = layer.kind === 'text' ? layer : layer.text;
      if (tl) {
        const n = this.nodes.get(tl.id);
        if (n) paintRuns(n, this.currentRuns(tl), tl.color);
      }
    }
    await this.renderBackgroundSwap();
    for (const layer of this.spec.layers) {
      if (layer.kind === 'image' || layer.kind === 'logo') await this.renderImage(layer);
    }
    return this.layout();
  }

  async renderBackgroundSwap() {
    const b = this.edits.background;
    this.bgEl.textContent = '';
    if (!b) return;
    const img = h('img', 'L-bgimg');
    img.alt = '';
    img.src = (await this.resolve(b.src)) || '';
    const c = b.content || b.box;
    const s = Math.max(this.spec.width / c.w, this.spec.height / c.h);
    Object.assign(img.style, {
      position: 'absolute', width: px(b.box.w * s), height: px(b.box.h * s),
      left: px((this.spec.width - c.w * s) / 2 - (c.x - b.box.x) * s), top: px((this.spec.height - c.h * s) / 2 - (c.y - b.box.y) * s),
    });
    this.bgEl.appendChild(img);
  }

  async renderImage(layer) {
    const n = this.nodes.get(layer.id);
    if (!n || !n._img) return;
    const e = this.edits.images[layer.id];
    const img = n._img;
    const frame = n._frame;
    const box = layer.box;
    const target = layer.kind === 'logo' ? box : (layer.role === 'plate' ? { x: 0, y: 0, w: this.spec.width, h: this.spec.height } : (layer.content || box));
    if (!e) {
      Object.assign(frame.style, { left: 0, top: 0, width: '100%', height: '100%', overflow: 'visible' });
      Object.assign(img.style, { left: 0, top: 0, width: '100%', height: '100%' });
      const u = await this.resolve(layer.src);
      if (u && img.src !== u) img.src = u;
      return;
    }
    const asset = e.src ? e : { src: layer.src, box, content: layer.content || box };
    const u = await this.resolve(asset.src);
    if (u && img.src !== u) img.src = u;
    const c = asset.content || asset.box;
    const fitScale = (e.fit === 'fit' ? Math.min : Math.max)(target.w / c.w, target.h / c.h);
    const swapped = !!e.src && e.src !== layer.src;
    const s = (swapped || e.fit ? fitScale : 1) * (e.scale || 1);
    Object.assign(frame.style, {
      left: px(target.x - box.x), top: px(target.y - box.y), width: px(target.w), height: px(target.h),
      overflow: swapped || e.fit === 'fill' ? 'hidden' : 'visible',
    });
    Object.assign(img.style, {
      width: px(asset.box.w * s), height: px(asset.box.h * s),
      left: px((target.w - c.w * s) / 2 - (c.x - asset.box.x) * s + (e.dx || 0)),
      top: px((target.h - c.h * s) / 2 - (c.y - asset.box.y) * s + (e.dy || 0)),
    });
  }

  flowItems() {
    const items = [];
    for (const layer of this.spec.layers) {
      if (!FLOW_KINDS.has(layer.kind)) continue;
      if (layer.kind === 'text' && layer.role === 'other') continue;
      const n = this.nodes.get(layer.id);
      const b = this.baseline.get(layer.id) || { h: layer.box.h, w: layer.box.w };
      items.push({ layer, n, o: layer.box, h0: b.h, w0: b.w, h1: layer.kind === 'logo' ? layer.box.h : n.offsetHeight, w1: layer.kind === 'logo' ? layer.box.w : n.offsetWidth });
    }
    return items.sort((a, b) => a.o.y - b.o.y);
  }

  hero() {
    return this.spec.layers.find((l) => l.role === 'hero');
  }

  layout() {
    const W = this.spec.width;
    const items = this.flowItems();
    const hero = this.hero();
    for (const it of items) {
      const l = it.layer;
      const st = l.style || l.text?.style;
      let left = l.box.x;
      const centered = Math.abs(l.box.x + l.box.w / 2 - W / 2) < 6;
      const pre = l.kind === 'cta' || (l.kind === 'text' && st?.autoResize === 'WIDTH_AND_HEIGHT');
      if (pre && (st?.align === 'center' || (l.kind === 'cta' && centered))) left = l.box.x + l.box.w / 2 - it.w1 / 2;
      else if (pre && st?.align === 'right') left = l.box.x + l.box.w - it.w1;
      it.left = left;
    }

    let split = items.length;
    const heroMid = hero && !hero.fullBleed ? hero.content.y + hero.content.h / 2 : null;
    if (heroMid !== null) split = items.findIndex((it) => it.o.y + it.o.h / 2 > heroMid);
    if (heroMid === null || split < 0) {
      let best = -Infinity;
      let maxB = -Infinity;
      split = items.length;
      items.forEach((it, i) => {
        if (i > 0) {
          const gap = it.o.y - maxB;
          if (gap > best) { best = gap; split = i; }
        }
        maxB = Math.max(maxB, it.o.y + it.o.h);
      });
      if (heroMid !== null && split < 0) split = items.length;
    }
    const top = items.slice(0, split);
    const bottom = items.slice(split);

    const gaps = [];
    for (const [i, it] of top.entries()) {
      const parents = top.slice(0, i).filter((p) => overlapX(p.o, it.o) && p.o.y + p.h0 <= it.o.y + 4);
      const parent = parents.sort((a, b) => (b.o.y + b.h0) - (a.o.y + a.h0))[0];
      it.shift = parent ? parent.shift + (parent.h1 - parent.h0) : 0;
      if (parent) gaps.push(it.o.y - (parent.o.y + parent.h0));
      it.top = it.o.y + it.shift;
    }
    for (let i = bottom.length - 1; i >= 0; i--) {
      const it = bottom[i];
      const kids = bottom.slice(i + 1).filter((c) => overlapX(c.o, it.o) && c.o.y >= it.o.y + it.h0 - 4);
      const child = kids.sort((a, b) => a.o.y - b.o.y)[0];
      it.up = child ? child.up + (child.h1 - child.h0) : 0;
      if (child) gaps.push(child.o.y - (it.o.y + it.h0));
      it.top = it.o.y + it.h0 - it.up - it.h1;
    }
    for (const it of items) {
      it.n.style.left = px(it.left);
      it.n.style.top = px(it.top);
      it.rect = { x: it.left, y: it.top, w: it.w1, h: it.h1 };
    }

    const G = gaps.filter((g) => g > 8).sort((a, b) => a - b)[Math.floor(gaps.filter((g) => g > 8).length / 2)] || DEFAULT_GAP;
    this.gap = G;
    let cropTop = 0;
    let cropBottom = 0;
    if (hero && !hero.fullBleed) {
      const hc = hero.content;
      for (const it of top) {
        if (!overlapX(it.o, hc)) continue;
        const ob = it.o.y + it.h0;
        const nb = it.top + it.h1;
        const clear = hc.y - ob;
        const need = clear >= 0 ? nb + Math.min(clear, G) - hc.y : nb - ob;
        cropTop = Math.max(cropTop, need);
      }
      for (const it of bottom) {
        if (!overlapX(it.o, hc)) continue;
        const ot = it.o.y;
        const clear = ot - (hc.y + hc.h);
        const need = clear >= 0 ? (hc.y + hc.h) - (it.top - Math.min(clear, G)) : ot - it.top;
        cropBottom = Math.max(cropBottom, need);
      }
      const n = this.nodes.get(hero.id);
      cropTop = Math.max(0, cropTop);
      cropBottom = Math.max(0, cropBottom);
      if (n) {
        const t = cropTop > 0.5 ? Math.max(0, hc.y + cropTop - hero.box.y) : 0;
        const b = cropBottom > 0.5 ? Math.max(0, hero.box.y + hero.box.h - (hc.y + hc.h - cropBottom)) : 0;
        n.style.clipPath = t || b ? `inset(${px(t)} -2000px ${px(b)} -2000px)` : '';
      }
    }

    const issues = [];
    if (this.spec.format === '9x16') {
      const z = SAFE_ZONE;
      const check = (name, r, layerId) => {
        if (r.x < z.x0 - 1 || r.x + r.w > z.x1 + 1 || r.y < z.y0 - 1 || r.y + r.h > z.y1 + 1) issues.push({ name, layerId });
      };
      for (const it of items) if (it.layer.kind !== 'logo') check(labelFor(it.layer), it.rect, it.layer.id);
      for (const l of this.spec.layers) {
        if (l.kind === 'text' && l.role === 'other') {
          const n = this.nodes.get(l.id);
          check(labelFor(l), { x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight }, l.id);
        }
      }
    }
    const head = this.spec.layers.find((l) => l.role === 'headline');
    const hn = head && this.nodes.get(head.id);
    const lines = hn && head.style.lineHeight ? Math.round(hn.offsetHeight / head.style.lineHeight) : null;
    this.lastLayout = { issues, cropTop, cropBottom, headlineLines: lines };
    for (const n of this.el.querySelectorAll('.is-outside')) n.classList.remove('is-outside');
    for (const i of issues) this.nodes.get(i.layerId)?.classList.add('is-outside');
    return this.lastLayout;
  }

  setEditable(on) {
    this.editable = on;
    for (const n of this.el.querySelectorAll('.L-text')) {
      if (on) n.setAttribute('contenteditable', 'plaintext-only' in document.body.dataset ? 'true' : 'true');
      else n.removeAttribute('contenteditable');
    }
    this.el.classList.toggle('is-editing', on);
  }

  textLayerOf(node) {
    const id = node?.closest?.('[data-text]')?.dataset.text;
    if (!id) return null;
    for (const l of this.spec.layers) {
      if (l.id === id) return l;
      if (l.text?.id === id) return l.text;
    }
    return null;
  }

  readText(textLayer) {
    const n = this.nodes.get(textLayer.id);
    const runs = readRuns(n, textLayer.color);
    if (runsToText(runs) === runsToText(textLayer.runs) && JSON.stringify(runs) === JSON.stringify(mergeRuns(textLayer.runs))) delete this.edits.texts[textLayer.id];
    else this.edits.texts[textLayer.id] = runs;
    return runs;
  }

  textState() {
    const texts = {};
    const runs = {};
    for (const l of this.spec.layers) {
      if (l.kind === 'text' && (l.role === 'headline' || l.role === 'disclosure')) {
        runs[l.role] = this.currentRuns(l);
        texts[l.role] = runsToText(runs[l.role]);
      }
    }
    return { texts, runs };
  }

  visualTags() {
    const tags = new Set();
    let hasPlate = false;
    for (const l of this.spec.layers) {
      if (l.kind !== 'image') continue;
      const e = this.edits.images[l.id];
      if (l.role === 'plate') hasPlate = true;
      const own = e?.src ? (this.assetInfo(e.src)?.tags || []) : (l.tags || []);
      if (l.role === 'hero' || l.role === 'plate' || (!e && (this.spec.visualTags || []).some((t) => (l.tags || []).includes(t)))) own.forEach((t) => t !== 'plate' && tags.add(t));
    }
    if (this.edits.background) {
      hasPlate = true;
      (this.assetInfo(this.edits.background.src)?.tags || []).forEach((t) => t !== 'plate' && tags.add(t));
    }
    return { tags: [...tags], hasPlate };
  }

  hitImage(x, y) {
    const inside = (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    const layers = this.spec.layers;
    const logo = [...layers].reverse().find((l) => l.kind === 'logo' && inside(l.box));
    if (logo) return logo;
    const hero = layers.find((l) => l.role === 'hero' && !l.fullBleed && inside(l.content));
    if (hero) return hero;
    const other = [...layers].reverse().find((l) => l.kind === 'image' && l.role === 'decor' && !/fade|cover|grade|mask|feather|gradient|dim|patch|seam|fix|band|sky|contrast|shadow|glow|halo/i.test(l.name) && inside(l.content || l.box));
    if (other) return other;
    const fb = layers.find((l) => l.role === 'hero' && l.fullBleed);
    if (fb) return fb;
    const plate = [...layers].reverse().find((l) => l.role === 'plate');
    return plate || { id: '__bg', kind: 'background', role: 'background', name: 'Background', box: { x: 0, y: 0, w: this.spec.width, h: this.spec.height } };
  }
}

export function labelFor(layer) {
  if (layer.kind === 'cta') return 'CTA';
  if (layer.kind === 'box') return 'Risk box';
  if (layer.kind === 'logo') return 'Logo';
  return { headline: 'Headline', disclosure: 'Disclosure', sub: 'Sub', other: layer.name.split('(')[0].trim() }[layer.role] || 'Text';
}
