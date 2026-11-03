import { Vault, WrongPassword } from './vault.js';
import { PieceView, SAFE_ZONE, runsToText } from './render.js';
import { buildMock, mockKindFor } from './mockups.js';
import { createCommentStore, EditsStore } from './store.js';
import { facts, score, expectation } from './perf.js';
import { initComments } from './comments.js';
import { initEdit } from './edit.js';

const $ = (s, r = document) => r.querySelector(s);
const FORMATS = [
  { key: '9x16', label: '9:16' },
  { key: '1x1', label: '1:1' },
  { key: '4x5', label: '4:5' },
  { key: '1.91x1', label: '1.91:1' },
];
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || new URLSearchParams(location.search).has('dev');

const app = {
  vault: new Vault('data/'),
  manifest: null,
  ci: 0,
  di: 0,
  format: '1x1',
  mode: 'view',
  insitu: true,
  safe: false,
  figma: false,
  tab: 'perf',
  view: null,
  spec: null,
  pieceId: null,
  fallback: false,
  scale: 1,
  comments: null,
  edits: new EditsStore(),
  listeners: new Set(),
};
window.__rr = app;

/* ---------------- utils ---------------- */
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('is-on'), 2200);
}
app.toast = toast;

app.resolve = (path) => {
  const pack = app.manifest.assets[path];
  return pack ? app.vault.url(pack, path) : Promise.resolve(null);
};
app.assetInfo = (src) => {
  for (const list of Object.values(app.manifest.library || {})) {
    const a = list.find((x) => x.src === src);
    if (a) return a;
  }
  return null;
};
app.emit = (what) => app.listeners.forEach((fn) => fn(what));
app.on = (fn) => app.listeners.add(fn);

function concepts() { return app.manifest.brief.concepts; }
function concept() { return concepts()[app.ci]; }
function direction() { return concept().directions[app.di]; }

/* ---------------- gate ---------------- */
async function unlock(pw, silent) {
  const gate = $('#gate');
  gate.classList.add('is-busy');
  $('#gate-msg').textContent = silent ? '' : 'Unlocking…';
  try {
    app.manifest = await app.vault.open(pw);
  } catch (e) {
    gate.classList.remove('is-busy');
    if (silent) { sessionStorage.removeItem('rr.pw'); $('#gate-msg').textContent = ''; return; }
    const field = $('#gate-field');
    $('#gate-msg').textContent = e instanceof WrongPassword ? 'That password didn’t work.' : e.message;
    field.classList.remove('shake');
    void field.offsetWidth;
    field.classList.add('shake');
    $('#gate-input').select();
    return;
  }
  try { sessionStorage.setItem('rr.pw', pw); } catch {}
  await loadFonts();
  gate.classList.add('is-out');
  setTimeout(() => gate.remove(), reduceMotion() ? 0 : 360);
  $('#app').hidden = false;
  $('#app').classList.add('is-in');
  start();
}

async function loadFonts() {
  const { pack, files } = app.manifest.fonts;
  const uf = app.manifest.brief.uiFonts || {};
  const root = document.documentElement.style;
  if (uf.ui) root.setProperty('--ui', `'${uf.ui}', ui-sans-serif, system-ui, sans-serif`);
  if (uf.display) root.setProperty('--display', `'${uf.display}', ui-serif, Georgia, serif`);
  await Promise.all(files.map(async (f) => {
    const def = (app.manifest.brief.fontFaces || {})[f.split('/').pop()];
    if (!def) return;
    const bytes = await app.vault.bytes(pack, f);
    const face = new FontFace(def[0], bytes, { weight: String(def[1]), style: def[2] });
    await face.load();
    document.fonts.add(face);
  }));
}

$('#gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#gate-input').value;
  if (v) unlock(v);
});
(() => {
  let saved = null;
  try { saved = sessionStorage.getItem('rr.pw'); } catch {}
  if (saved) unlock(saved, true);
})();

/* ---------------- start ---------------- */
function start() {
  const brief = app.manifest.brief;
  $('#brief-name').textContent = brief.name;
  document.title = `${brief.id} · Review room`;
  app.comments = createCommentStore(app.manifest.commentsSeed || []);
  buildFormatSeg();
  buildRail();
  bindTop();
  bindKeys();
  initComments(app);
  initEdit(app);
  readHash();
  new ResizeObserver(debounce(() => app.view && layoutStage(false), 80)).observe($('#viewport'));
  window.addEventListener('hashchange', () => readHash());
  app.comments.subscribe(() => { renderRail(); app.emit('comments'); });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function readHash() {
  const [c, d, f] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const ci = Math.max(0, concepts().findIndex((x) => x.name.toLowerCase() === (c || '').toLowerCase()));
  const di = Math.max(0, concepts()[ci].directions.findIndex((x) => x.id.toLowerCase() === (d || '').toLowerCase()));
  const fmt = FORMATS.some((x) => x.key === f) ? f : app.format;
  if (app.view && ci === app.ci && di === app.di && fmt === app.format) return;
  go(ci, di, fmt, { push: false });
}

/* ---------------- navigation ---------------- */
let navToken = 0;
export async function go(ci, di, format = app.format, { push = true, dir = 1 } = {}) {
  const token = ++navToken;
  app.ci = ci; app.di = di; app.format = format;
  setInsitu(true);
  const d = direction();
  const pid = d.formats[format] || d.formats['9x16'];
  app.fallback = !d.formats[format];
  if (push) history.replaceState(null, '', `#/${encodeURIComponent(concept().name)}/${d.id}/${format}`);
  renderRail();
  syncFormatSeg();
  const spec = app.manifest.pieces[pid];
  const view = new PieceView(spec, { resolve: app.resolve, edits: app.edits.get(pid), assetInfo: app.assetInfo });
  const stagingArea = $('#staging') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'staging' }));
  Object.assign(stagingArea.style, { position: 'absolute', left: '-99999px', top: 0, visibility: 'hidden', pointerEvents: 'none' });
  stagingArea.appendChild(view.el);
  try {
    await view.mount();
  } catch (e) {
    console.error(e);
    toast('Could not load this piece');
  }
  if (token !== navToken) { view.el.remove(); return; }
  const swap = () => {
    if (token !== navToken) { view.el.remove(); return; }
    app.view = view;
    app.spec = spec;
    app.pieceId = pid;
    layoutStage(true);
    app.emit('piece');
  };
  document.documentElement.style.setProperty('--vt-dir', String(dir));
  if (document.startViewTransition && app.view && !document.hidden) {
    const vt = document.startViewTransition(swap);
    vt.ready.catch(() => {});
    vt.finished.catch(() => {});
  } else if (app.view && !reduceMotion()) {
    swap();
    $('#mock').animate([{ opacity: 0, transform: `translateY(${dir * 16}px)`, filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 320, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  } else swap();
  prefetchNeighbours();
}

function prefetchNeighbours() {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 400));
  idle(() => {
    const dirs = concept().directions;
    for (const k of [app.di + 1, app.di - 1]) {
      const d = dirs[k];
      const pid = d && (d.formats[app.format] || d.formats['9x16']);
      const spec = pid && app.manifest.pieces[pid];
      const src = spec?.layers.find((l) => l.src)?.src;
      if (src && app.manifest.assets[src]) app.vault.pack(app.manifest.assets[src]).catch(() => {});
    }
  });
}

function step(delta) {
  const dirs = concept().directions;
  let di = app.di + delta;
  let ci = app.ci;
  if (di < 0) { ci = (ci - 1 + concepts().length) % concepts().length; di = concepts()[ci].directions.length - 1; }
  if (di >= dirs.length) { ci = (ci + 1) % concepts().length; di = 0; }
  go(ci, di, app.format, { dir: delta > 0 ? 1 : -1 });
}

function stepConcept(delta) {
  const ci = (app.ci + delta + concepts().length) % concepts().length;
  go(ci, Math.min(app.di, concepts()[ci].directions.length - 1), app.format, { dir: delta > 0 ? 1 : -1 });
}

/* ---------------- stage ---------------- */
function layoutStage(fresh) {
  const view = app.view;
  const spec = app.spec;
  const vp = $('#viewport');
  const cs = getComputedStyle(vp);
  const availW = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const mobile = matchMedia('(max-width: 900px)').matches;
  const availH = mobile ? Math.min(window.innerHeight * 0.78, 760) : vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const kind = mockKindFor(app.fallback ? '9x16' : spec.format, app.insitu);
  const caption = runsToText(view.spec.layers.find((l) => l.role === 'headline')?.runs || []);
  const mk = buildMock({ kind, W: spec.width, H: spec.height, availW, availH, caption, advertiser: app.manifest.brief.advertiser, mark: app.manifest.brief.advertiserMark || '' });
  app.scale = mk.scale;

  let wrap = app.wrap;
  if (fresh || !wrap) {
    wrap = document.createElement('div');
    wrap.className = 'art-wrap';
    wrap.appendChild(view.el);
    const flat = document.createElement('img');
    flat.className = 'figma-flat';
    flat.alt = 'Figma render';
    app.resolve(spec.thumb).then((u) => { if (u) flat.src = u; });
    wrap.appendChild(flat);
    const safe = document.createElement('div');
    safe.className = 'safe';
    if (spec.format === '9x16') {
      const z = SAFE_ZONE;
      safe.innerHTML = `<div class="safe-box" style="left:${(z.x0 / spec.width) * 100}%;top:${(z.y0 / spec.height) * 100}%;width:${((z.x1 - z.x0) / spec.width) * 100}%;height:${((z.y1 - z.y0) / spec.height) * 100}%"><span class="safe-tag">Safe zone · x115–895 · y350–1540</span></div>`;
    }
    wrap.appendChild(safe);
    const pins = document.createElement('div');
    pins.className = 'pins';
    wrap.appendChild(pins);
    app.wrap = wrap;
    app.pinsEl = pins;
  }
  wrap.style.width = `${spec.width * mk.scale}px`;
  wrap.style.height = `${spec.height * mk.scale}px`;
  wrap.style.position = mk.place ? 'absolute' : '';
  wrap.style.left = mk.place ? `${mk.place.left}px` : '';
  wrap.style.top = mk.place ? `${mk.place.top}px` : '';
  view.el.style.transform = `scale(${mk.scale})`;
  view.el.style.setProperty('--inv', String(1 / mk.scale));
  wrap.className = `art-wrap mode-${app.mode}${app.figma ? ' show-figma' : ''}`;
  wrap.querySelector('.safe').classList.toggle('is-on', app.safe || (app.mode === 'edit' && spec.format === '9x16' && view.lastLayout?.issues.length > 0));
  wrap.classList.toggle('safe-on', app.safe);

  const mock = $('#mock');
  mock.textContent = '';
  mk.slot.prepend(wrap);
  mock.appendChild(mk.root);
  if (DEV) requestAnimationFrame(() => assertGeometry(mk, spec, view, wrap));
  view.setEditable(app.mode === 'edit');

  $('#stage-concept').textContent = `${concept().name} · ${direction().copyVersion || ''} copy`;
  $('#stage-label').textContent = direction().label;
  $('#safe-btn').disabled = spec.format !== '9x16';
  refreshChips();
  app.emit('layout');
}
app.layoutStage = layoutStage;

// Dev check: the piece and its mockup screen keep their native aspect, and the safe zone follows the crop.
function assertGeometry(mk, spec, view, wrap) {
  if (!wrap.isConnected || !mk.root.isConnected) return;
  const native = spec.width / spec.height;
  const off = (shown, want) => Math.abs(shown / want - 1);
  for (const [name, node] of [['artboard', view.el], ['art-wrap', wrap], ['figma render', wrap.querySelector('.figma-flat')]]) {
    const r = node?.getBoundingClientRect();
    if (r?.height && off(r.width / r.height, native) > 0.005) console.warn(`[showroom] ${spec.id} ${name} aspect ${(r.width / r.height).toFixed(4)} ≠ native ${native.toFixed(4)}`);
  }
  if (mk.expect?.screen) {
    const r = mk.expect.screen.getBoundingClientRect();
    if (off(r.width / r.height, mk.expect.screenAspect) > 0.005) console.warn(`[showroom] mockup screen aspect ${(r.width / r.height).toFixed(4)} ≠ ${mk.expect.screenAspect.toFixed(4)}`);
  }
  const box = wrap.querySelector('.safe-box');
  if (box && mk.expect?.place) {
    const z = SAFE_ZONE;
    const s = mk.expect.screen.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const want = { left: s.left + mk.expect.place.left + z.x0 * mk.scale, top: s.top + mk.expect.place.top + z.y0 * mk.scale, width: (z.x1 - z.x0) * mk.scale, height: (z.y1 - z.y0) * mk.scale };
    if (Object.keys(want).some((k) => Math.abs(b[k] - want[k]) > 1)) console.warn('[showroom] safe-zone overlay does not match the cover transform', { shown: b, want });
  }
}

function setInsitu(on) {
  app.insitu = on;
  $('#insitu-btn')?.setAttribute('aria-pressed', String(on));
}
app.go = (...a) => go(...a);

export function refreshChips() {
  const chips = $('#chips');
  chips.textContent = '';
  const view = app.view;
  if (!view) return;
  if (app.fallback) {
    const f = FORMATS.find((x) => x.key === app.format).label;
    chips.appendChild(chip(`${f} not designed yet · 9:16 master`, true));
  }
  for (const i of view.lastLayout?.issues || []) {
    chips.appendChild(chip(`${i.name} outside safe zone`, false, true));
  }
  if (view.lastLayout?.cropTop > 1 || view.lastLayout?.cropBottom > 1) chips.appendChild(chip('Hero cropped to keep the gap', true));
  const p = app.perfNow;
  if (p) {
    const c = chip(`Perf ${p.score} · ${p.exp.label.replace(' set average', '')}`, true);
    c.style.cursor = 'pointer';
    c.addEventListener('click', () => setTab('perf'));
    chips.appendChild(c);
  }
}
function chip(text, quiet, warn) {
  const c = document.createElement('span');
  c.className = `chip${quiet ? ' is-quiet' : ''}`;
  c.innerHTML = warn ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2l6.5 11.5h-13z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 6.5v3.2M8 11.4v.1" stroke="currentColor" stroke-width="1.4"/></svg>' : '';
  c.append(text);
  return c;
}

/* ---------------- top bar & rail ---------------- */
function buildFormatSeg() {
  const seg = $('#format-seg');
  seg.innerHTML = '<span class="seg-thumb"></span>' + FORMATS.map((f, i) => `<button role="radio" data-format="${f.key}" aria-checked="false">${f.label} <kbd>${i + 1}</kbd></button>`).join('');
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-format]');
    if (b) go(app.ci, app.di, b.dataset.format);
  });
}

function syncFormatSeg() {
  const d = direction();
  for (const b of $('#format-seg').querySelectorAll('[data-format]')) {
    b.setAttribute('aria-checked', String(b.dataset.format === app.format));
    b.classList.toggle('is-fallback', !d.formats[b.dataset.format]);
    b.title = d.formats[b.dataset.format] ? '' : 'Not designed yet: shows the 9:16 master';
  }
  moveThumb($('#format-seg'));
}

export function moveThumb(seg) {
  const thumb = seg.querySelector('.seg-thumb');
  const on = seg.querySelector('[aria-checked="true"]');
  if (!thumb || !on) return;
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft - 4}px)`;
  thumb.style.left = '4px';
}

function buildRail() {
  renderRail();
  $('#rail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ci]');
    if (!b) return;
    const ci = +b.dataset.ci;
    const di = b.dataset.di !== undefined ? +b.dataset.di : 0;
    go(ci, di, app.format, { dir: ci * 10 + di >= app.ci * 10 + app.di ? 1 : -1 });
    $('#rail').classList.remove('is-open');
  });
}

function renderRail() {
  if (!app.manifest) return;
  const all = app.comments ? app.comments.all() : [];
  const open = (pid) => all.filter((c) => c.scope === pid && c.status !== 'resolved').length;
  const rail = $('#rail');
  const scrollTop = rail.scrollTop;
  rail.innerHTML = concepts().map((c, ci) => `
    <div class="rail-group">
      <button class="rail-concept" data-ci="${ci}"><span>${c.name}</span><span>${c.directions.length} directions</span></button>
      <ul class="rail-dirs">${c.directions.map((d, di) => {
        const n = Object.values(d.formats).filter(Boolean).reduce((s, pid) => s + open(pid), 0);
        const label = d.label.replace(/^D\d+ · /, '');
        return `<li><button class="rail-dir" data-ci="${ci}" data-di="${di}" aria-current="${ci === app.ci && di === app.di}">
          <b>${d.id}</b><small>${label}</small>
          <span class="rail-meta"><span>${d.copyVersion || ''} copy</span>${n ? `<span>${n} open</span>` : ''}</span>
        </button></li>`;
      }).join('')}</ul>
    </div>`).join('') + `
    <div class="rail-foot">
      <div><span>Direction</span><span>↑ ↓</span></div>
      <div><span>Concept</span><span>← →</span></div>
      <div><span>Format</span><span>1–4</span></div>
      <div><span>Jump to</span><span>⌘K</span></div>
    </div>`;
  rail.scrollTop = scrollTop;
  rail.querySelector('.rail-dir[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

function bindTop() {
  const modeSeg = $('#mode-seg');
  modeSeg.insertAdjacentHTML('afterbegin', '<span class="seg-thumb"></span>');
  modeSeg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  requestAnimationFrame(() => moveThumb(modeSeg));
  setInsitu(app.insitu);
  $('#insitu-btn').addEventListener('click', () => toggle('insitu'));
  $('#safe-btn').addEventListener('click', () => toggle('safe'));
  $('#figma-btn').addEventListener('click', () => toggle('figma'));
  $('#quick-btn').addEventListener('click', openQuick);
  $('#rail-toggle').addEventListener('click', () => $('#rail').classList.toggle('is-open'));
  document.addEventListener('pointerdown', (e) => {
    const rail = $('#rail');
    if (rail.classList.contains('is-open') && !rail.contains(e.target) && !e.target.closest('#rail-toggle')) rail.classList.remove('is-open');
  });
  for (const t of document.querySelectorAll('[role="tab"]')) t.addEventListener('click', () => setTab(t.dataset.tab));
  window.addEventListener('resize', debounce(() => { moveThumb($('#format-seg')); moveThumb(modeSeg); }, 60));
}

function toggle(key) {
  app[key] = !app[key];
  $(`#${key === 'insitu' ? 'insitu' : key}-btn`).setAttribute('aria-pressed', String(app[key]));
  if (key === 'insitu') {
    if (document.startViewTransition && !reduceMotion()) {
      const vt = document.startViewTransition(() => layoutStage(false));
      vt.ready.catch(() => {});
      vt.finished.catch(() => {});
    }
    else layoutStage(false);
  } else if (key === 'safe') {
    app.wrap?.querySelector('.safe').classList.toggle('is-on', app.safe);
    app.wrap?.classList.toggle('safe-on', app.safe);
  } else if (key === 'figma') {
    app.wrap?.classList.toggle('show-figma', app.figma);
  }
}

export function setMode(mode) {
  if (app.mode === mode) return;
  app.mode = mode;
  for (const b of $('#mode-seg').querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  moveThumb($('#mode-seg'));
  if (mode === 'comment') setTab('comments');
  if (mode === 'edit') setTab('edit');
  if (app.figma) toggle('figma');
  layoutStage(false);
  app.emit('mode');
  toast({ view: 'View mode', comment: 'Comment mode · click the piece to drop a pin', edit: 'Edit mode · click text to type, images to swap' }[mode]);
}
app.setMode = setMode;

export function setTab(tab) {
  app.tab = tab;
  for (const t of document.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  for (const k of ['comments', 'perf', 'edit']) $(`#tab-${k}`).hidden = k !== tab;
}
app.setTab = setTab;

/* ---------------- keyboard ---------------- */
function typing(e) {
  const t = e.target;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuick(); return; }
    if (mod && e.key.toLowerCase() === 'z' && app.mode === 'edit') { e.preventDefault(); e.shiftKey ? app.redo?.() : app.undo?.(); return; }
    if (e.key === 'Escape') {
      if (app.closePop?.()) return;
      if (typing(e)) { e.target.blur(); return; }
      if (app.mode !== 'view') setMode('view');
      return;
    }
    if (typing(e) || mod || e.altKey) return;
    if ($('#quick').open) return;
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { if (app.nudgeKey?.(1, 0, e)) return; e.preventDefault(); stepConcept(1); }
    else if (e.key === 'ArrowLeft') { if (app.nudgeKey?.(-1, 0, e)) return; e.preventDefault(); stepConcept(-1); }
    else if (k === 'v') setMode('view');
    else if (k === 'c') setMode('comment');
    else if (k === 'e') setMode('edit');
    else if (k === 'm') toggle('insitu');
    else if (k === 's' && app.spec?.format === '9x16') toggle('safe');
    else if (k === 'f' && !e.repeat) { if (!app.figma) toggle('figma'); app.figmaHold = Date.now(); }
    else if (/^[1-4]$/.test(k)) go(app.ci, app.di, FORMATS[+k - 1].key);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'f' && app.figmaHold && Date.now() - app.figmaHold > 250 && app.figma) toggle('figma');
    if (e.key.toLowerCase() === 'f') app.figmaHold = 0;
  });
}

/* ---------------- quick switcher ---------------- */
function quickItems() {
  const items = [];
  concepts().forEach((c, ci) => c.directions.forEach((d, di) => {
    for (const f of FORMATS) {
      const pid = d.formats[f.key];
      if (!pid && f.key !== '9x16') continue;
      items.push({ ci, di, f: f.key, title: `${c.name} · ${d.label}`, sub: `${f.label} · ${d.copyVersion || ''} copy`, thumb: app.manifest.pieces[pid]?.thumb });
    }
  }));
  return items;
}

function openQuick() {
  const dlg = $('#quick');
  const input = $('#quick-input');
  const list = $('#quick-list');
  const all = quickItems();
  let sel = 0;
  let shown = all;
  const render = () => {
    const q = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    shown = all.filter((it) => q.every((w) => `${it.title} ${it.sub}`.toLowerCase().includes(w)));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}"><img alt="" data-thumb="${it.thumb || ''}"><span class="t"><span>${it.title}</span><small>${it.sub}</small></span><span class="d">${it.ci === app.ci && it.di === app.di && it.f === app.format ? 'Current' : ''}</span></li>`).join('') || '<li class="empty">No match</li>';
    list.querySelectorAll('img[data-thumb]').forEach((img) => img.dataset.thumb && app.resolve(img.dataset.thumb).then((u) => { if (u) img.src = u; }));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const it = shown[i];
    if (!it) return;
    dlg.close();
    go(it.ci, it.di, it.f);
  };
  input.value = '';
  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  };
  list.onclick = (e) => { const li = e.target.closest('[data-i]'); if (li) pick(+li.dataset.i); };
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  render();
  dlg.showModal();
  input.focus();
}

/* ---------------- performance ---------------- */
function factsFor(spec, view) {
  if (view) {
    const ts = view.textState();
    const vt = view.visualTags();
    return facts(spec, { ...ts, tags: vt.tags, hasPlate: vt.hasPlate, headlineLines: view.lastLayout?.headlineLines, safeZoneIssues: view.lastLayout?.issues });
  }
  const saved = app.edits.get(spec.id);
  const runs = {};
  const texts = {};
  for (const l of spec.layers) {
    if (l.kind === 'text' && (l.role === 'headline' || l.role === 'disclosure')) {
      runs[l.role] = saved?.texts?.[l.id] || l.runs;
      texts[l.role] = runsToText(runs[l.role]);
    }
  }
  return facts(spec, { texts, runs, tags: spec.visualTags || [], hasPlate: spec.layers.some((l) => l.role === 'plate'), safeZoneIssues: [] });
}

function computePerf() {
  const w = app.manifest.weights;
  const cur = score(w, factsFor(app.spec, app.view));
  const masters = Object.values(app.manifest.pieces).filter((p) => p.format === '9x16');
  const vals = masters.map((p) => (p.id === app.spec.id ? cur.score : score(w, factsFor(p)).score));
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const exp = expectation(cur.score, mean, w.bands);
  return { ...cur, mean, exp, min: Math.min(...vals), max: Math.max(...vals) };
}

function renderPerf() {
  if (!app.view) return;
  const p = computePerf();
  const prev = app.perfNow?.score;
  app.perfNow = p;
  const caveat = app.manifest.weights.caveat || '';
  $('#tab-perf').innerHTML = `
    <div class="sec">
      <div class="perf-label">Predicted performance · heuristic estimate, internal</div>
      <div class="perf-score"><span class="n${prev !== undefined && prev !== p.score ? ' flash' : ''}">${p.score}</span><span class="of">/ 100</span></div>
      <div class="perf-exp" data-k="${p.exp.key}"><span class="dot"></span>${p.exp.label}</div>
      <div class="perf-conf">Confidence: ${p.confidence}</div>
      <div class="meter" aria-hidden="true"><i style="width:${p.score}%"></i><b style="left:${p.mean}%"></b></div>
      <div class="meter-legend"><span>Set range ${p.min}–${p.max}</span><span>Set average ${Math.round(p.mean)}</span></div>
    </div>
    <div class="sec">
      <h3 class="sec-title">Drivers</h3>
      <ul class="drivers">${p.drivers.map((d) => `<li class="driver ${d.weight < 0 ? 'neg' : ''}" title="${(d.rule || '').replace(/"/g, '&quot;')}"><span class="w">${d.weight > 0 ? '+' : '−'}${Math.abs(d.weight)}</span><span>${d.label}<small>Evidence: ${d.evidence}</small></span></li>`).join('')}</ul>
    </div>
    <div class="sec">
      <h3 class="sec-title">Suggestion</h3>
      <p class="suggest">${p.suggestion}</p>
    </div>
    <div class="sec"><p class="hint">Relative expectation against this set only, from written learnings and QA rules. No CTR or NFA forecast. ${caveat}</p></div>`;
  refreshChips();
}
app.renderPerf = renderPerf;
app.on((what) => { if (['piece', 'layout', 'edit'].includes(what)) renderPerf(); });
