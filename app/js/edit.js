import { selectionOffsets, setSelectionOffsets, toggleNeonRange, paintRuns, runsToText, labelFor } from './render.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));

export function initEdit(app) {
  const layer = document.getElementById('pop-layer');
  const stacks = new Map();
  let burst = null;
  let burstT = null;
  let committed = null;
  let selLayer = null;
  let bar = null;
  let saveT = null;

  const stack = () => {
    if (!stacks.has(app.pieceId)) stacks.set(app.pieceId, { undo: [], redo: [] });
    return stacks.get(app.pieceId);
  };
  const snapshot = () => clone(app.view.edits);
  const changeCount = (e = app.view?.edits) => e ? Object.keys(e.texts || {}).length + Object.keys(e.images || {}).length + (e.background ? 1 : 0) : 0;

  function pushUndo(before = snapshot()) {
    const s = stack();
    s.undo.push(before);
    if (s.undo.length > 100) s.undo.shift();
    s.redo.length = 0;
  }

  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const e = app.view.edits;
      if (changeCount(e)) app.edits.set(app.pieceId, e);
      else app.edits.clear(app.pieceId);
      renderTab();
    }, 250);
  }

  function changed() {
    if (!burst) committed = snapshot();
    app.view.layout();
    app.wrap?.querySelector('.safe')?.classList.toggle('is-on', app.safe || (app.view.lastLayout?.issues.length > 0 && app.spec.format === '9x16'));
    app.emit('edit');
    save();
  }

  async function restore(edits) {
    app.view.edits = clone(edits);
    committed = clone(edits);
    await app.view.applyAllEdits();
    changed();
    if (selLayer) openMenu(selLayer, true);
  }

  function flushBurst() {
    if (!burst) return;
    clearTimeout(burstT);
    pushUndo(burst);
    burst = null;
  }

  app.undo = async () => {
    flushBurst();
    const s = stack();
    if (!s.undo.length) { app.toast('Nothing to undo'); return; }
    s.redo.push(snapshot());
    await restore(s.undo.pop());
    app.toast('Undone');
  };
  app.redo = async () => {
    const s = stack();
    if (!s.redo.length) { app.toast('Nothing to redo'); return; }
    s.undo.push(snapshot());
    await restore(s.redo.pop());
    app.toast('Redone');
  };

  function onBeforeInput(e) {
    if (app.mode !== 'edit') return;
    const tl = app.view.textLayerOf(e.target);
    if (!tl) return;
    if (!burst) burst = committed || snapshot();
    clearTimeout(burstT);
    const t = e.inputType;
    if (t === 'insertParagraph' || t === 'insertLineBreak' || t === 'insertFromPaste' || t === 'insertFromDrop') {
      e.preventDefault();
      const node = app.view.nodes.get(tl.id);
      const off = selectionOffsets(node);
      if (!off) return;
      let ins = '\n';
      if (t === 'insertFromPaste' || t === 'insertFromDrop') ins = (e.dataTransfer?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
      const runs = app.view.readText(tl);
      const chars = [];
      for (const r of runs) for (const ch of r.t) chars.push({ ...r, t: ch });
      const style = chars[Math.max(0, off.start - 1)] || { fill: tl.color };
      const next = [...chars.slice(0, off.start), ...[...ins].map((ch) => ({ ...style, t: ch })), ...chars.slice(off.end)];
      paintRuns(node, next.length ? mergeChars(next) : [], tl.color);
      setSelectionOffsets(node, off.start + ins.length, off.start + ins.length);
      onInput({ target: node });
    }
  }

  function mergeChars(chars) {
    const out = [];
    for (const c of chars) {
      const l = out[out.length - 1];
      if (l && l.fill === c.fill && l.family === c.family) l.t += c.t;
      else out.push({ ...c });
    }
    return out;
  }

  function onInput(e) {
    if (app.mode !== 'edit') return;
    const tl = app.view.textLayerOf(e.target);
    if (!tl) return;
    if (!burst) burst = committed || snapshot();
    app.view.readText(tl);
    const before = burst;
    clearTimeout(burstT);
    burstT = setTimeout(() => { pushUndo(before); burst = null; committed = snapshot(); renderTab(); }, 600);
    changed();
  }

  function onSelection() {
    if (app.mode !== 'edit' || !app.view) return hideBar();
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return hideBar();
    const tl = app.view.textLayerOf(sel.anchorNode?.parentElement);
    if (!tl || tl.role !== 'headline') return hideBar();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'inline-bar';
      bar.innerHTML = '<button data-act="neon">Neon</button>';
      bar.addEventListener('mousedown', (e) => e.preventDefault());
      bar.addEventListener('click', () => neonSelection());
      layer.appendChild(bar);
    }
    bar.style.left = `${Math.max(16, r.left + r.width / 2 - 36)}px`;
    bar.style.top = `${Math.max(16, r.top - 48)}px`;
  }
  function hideBar() { bar?.remove(); bar = null; }

  function neonSelection() {
    const head = app.spec.layers.find((l) => l.role === 'headline');
    if (!head) return;
    const node = app.view.nodes.get(head.id);
    const off = selectionOffsets(node);
    if (!off || off.start === off.end) { app.toast('Select a word in the headline first'); return; }
    pushUndo();
    const runs = toggleNeonRange(app.view.currentRuns(head), off.start, off.end, head.color);
    app.view.edits.texts[head.id] = runs;
    paintRuns(node, runs, head.color);
    setSelectionOffsets(node, off.start, off.end);
    changed();
    renderTab();
  }
  app.neonSelection = neonSelection;

  function onArtClick(e) {
    if (app.mode !== 'edit' || !app.wrap?.contains(e.target)) return;
    if (e.target.closest('[data-text]')) { closeMenu(); return; }
    const r = app.view.el.getBoundingClientRect();
    const x = (e.clientX - r.left) / app.scale;
    const y = (e.clientY - r.top) / app.scale;
    const target = app.view.hitImage(x, y);
    openMenu(target);
  }

  function select(id) {
    app.view.el.querySelectorAll('.is-selected').forEach((n) => n.classList.remove('is-selected'));
    if (id && app.view.nodes.get(id)) app.view.nodes.get(id).classList.add('is-selected');
  }

  function closeMenu() {
    const p = layer.querySelector('.pop.img-menu');
    if (!p) return false;
    p.classList.add('is-out');
    setTimeout(() => p.remove(), 140);
    selLayer = null;
    select(null);
    return true;
  }
  const prevClose = app.closePop;
  app.closePop = () => closeMenu() || (prevClose ? prevClose() : false);

  function libraryFor(target) {
    const lib = app.manifest.library[app.spec.concept] || [];
    if (target.kind === 'logo') return [];
    if (target.role === 'plate' || target.kind === 'background' || (target.role === 'hero' && target.fullBleed)) return lib;
    return lib;
  }

  function currentEdit(target) {
    if (target.kind === 'background') return app.view.edits.background;
    return app.view.edits.images[target.id];
  }

  async function setEdit(target, patch, { undo = true } = {}) {
    if (undo) pushUndo();
    if (target.kind === 'background') {
      app.view.edits.background = patch === null ? null : { ...(app.view.edits.background || {}), ...patch };
      await app.view.renderBackgroundSwap();
    } else {
      if (patch === null) delete app.view.edits.images[target.id];
      else app.view.edits.images[target.id] = { fit: target.role === 'hero' ? 'fit' : 'fill', scale: 1, dx: 0, dy: 0, ...(app.view.edits.images[target.id] || {}), ...patch };
      const l = app.view.layerById(target.id);
      await app.view.renderImage(l);
    }
    changed();
    renderTab();
  }

  function openMenu(target, keepPos) {
    const old = layer.querySelector('.pop.img-menu');
    const oldPos = old && { left: old.style.left, top: old.style.top };
    old?.remove();
    selLayer = target;
    select(target.id);
    const e = currentEdit(target) || {};
    const lib = libraryFor(target);
    const roleName = target.kind === 'background' ? 'Background' : target.kind === 'logo' ? 'Logo' : target.role === 'hero' ? 'Hero' : target.role === 'plate' ? 'Background plate' : 'Image';
    const pop = document.createElement('div');
    pop.className = 'pop img-menu';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `${roleName} options`);
    const curSrc = e.src || target.src;
    pop.innerHTML = `
      <h4>${roleName}<br><small class="hint">${esc(target.name.split('(')[0])}</small></h4>
      ${lib.length ? `<div class="sec" style="padding-top:0"><h3 class="sec-title">Swap from ${esc(app.spec.concept)} library</h3>
        <div class="lib">${lib.map((a, i) => `<button data-i="${i}" aria-pressed="${a.src === curSrc}" title="${esc(a.direction + ' · ' + a.name)}"><img alt=""><small>${a.direction}${a.role === 'plate' ? ' · bg' : ''}</small></button>`).join('')}</div></div>` : ''}
      ${target.kind !== 'logo' ? `<div class="sec"><h3 class="sec-title">Crop</h3>
        <div class="seg" data-fit style="width:100%"><button role="radio" data-v="fit" aria-checked="${(e.fit || (target.role === 'hero' ? 'fit' : 'fill')) === 'fit'}" style="flex:1;justify-content:center">Fit</button><button role="radio" data-v="fill" aria-checked="${(e.fit || (target.role === 'hero' ? 'fit' : 'fill')) === 'fill'}" style="flex:1;justify-content:center">Fill</button></div></div>` : ''}
      <div class="sec"><h3 class="sec-title">Scale · <span data-scale-v>${Math.round((e.scale || 1) * 100)}%</span></h3>
        <input class="range" type="range" min="50" max="200" step="1" value="${Math.round((e.scale || 1) * 100)}" aria-label="Scale">
      </div>
      <div class="sec row" style="justify-content:space-between;align-items:flex-start">
        <div><h3 class="sec-title">Position</h3>
        <div class="nudge" aria-label="Nudge">
          <span></span><button data-n="0,-1" aria-label="Up">↑</button><span></span>
          <button data-n="-1,0" aria-label="Left">←</button><button data-n="0,0" aria-label="Centre">·</button><button data-n="1,0" aria-label="Right">→</button>
          <span></span><button data-n="0,1" aria-label="Down">↓</button><span></span>
        </div></div>
        <div style="display:grid;gap:8px;justify-items:end"><p class="hint" style="margin:0;text-align:right">Arrow keys nudge 8px<br>Shift + arrows 40px</p><button class="btn small" data-act="reset">Reset layer</button></div>
      </div>`;
    layer.appendChild(pop);
    if (keepPos && oldPos) Object.assign(pop.style, oldPos);
    else {
      const r = app.wrap.getBoundingClientRect();
      const w = Math.min(320, innerWidth - 32);
      let left = r.right + 16;
      if (left + w > innerWidth - 16) left = Math.max(16, r.left - w - 16);
      if (left < 16 || innerWidth < 900) left = Math.max(16, (innerWidth - w) / 2);
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.max(16, Math.min(r.top, innerHeight - pop.offsetHeight - 16))}px`;
      pop.style.setProperty('--ox', '0px');
      pop.style.setProperty('--oy', '0px');
    }
    pop.querySelectorAll('.lib button').forEach((b) => {
      const a = lib[+b.dataset.i];
      app.resolve(a.src).then((u) => { if (u) b.querySelector('img').src = u; });
      b.addEventListener('click', () => {
        const asset = { src: a.src, box: a.box, content: a.content };
        setEdit(target, a.src === target.src ? { src: undefined, box: undefined, content: undefined } : { ...asset, ...(target.kind === 'background' ? {} : {}) }).then(() => openMenu(target, true));
      });
    });
    pop.querySelector('[data-fit]')?.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-v]');
      if (b) setEdit(target, { fit: b.dataset.v }).then(() => openMenu(target, true));
    });
    const range = pop.querySelector('.range');
    let rangeBurst = false;
    range.addEventListener('input', () => {
      pop.querySelector('[data-scale-v]').textContent = `${range.value}%`;
      setEdit(target, { scale: +range.value / 100 }, { undo: !rangeBurst });
      rangeBurst = true;
    });
    range.addEventListener('change', () => { rangeBurst = false; });
    pop.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => {
      const [dx, dy] = b.dataset.n.split(',').map(Number);
      nudge(dx, dy, 8);
    }));
    pop.querySelector('[data-act="reset"]').addEventListener('click', () => setEdit(target, null).then(() => openMenu(target, true)));
  }

  function nudge(dx, dy, stepPx) {
    if (!selLayer) return;
    const e = currentEdit(selLayer) || {};
    if (dx === 0 && dy === 0) return setEdit(selLayer, { dx: 0, dy: 0 });
    return setEdit(selLayer, { dx: (e.dx || 0) + dx * stepPx, dy: (e.dy || 0) + dy * stepPx });
  }
  app.nudgeKey = (dx, dy, ev) => {
    if (app.mode !== 'edit' || !selLayer || !layer.querySelector('.pop.img-menu')) return false;
    ev.preventDefault();
    nudge(dx, dy, ev.shiftKey ? 40 : 8);
    return true;
  };
  document.addEventListener('keydown', (ev) => {
    if (app.mode !== 'edit' || !selLayer || ev.target.isContentEditable || /INPUT|TEXTAREA/.test(ev.target.tagName)) return;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      nudge(0, ev.key === 'ArrowUp' ? -1 : 1, ev.shiftKey ? 40 : 8);
    }
  }, true);

  function renderTab() {
    if (!app.view) return;
    const s = stack();
    const n = changeCount();
    const layers = app.spec.layers.flatMap((l) => (l.kind === 'text' ? [l] : l.text ? [{ ...l.text, _parent: l }] : []));
    const edited = (id) => !!app.view.edits.texts[id];
    document.getElementById('tab-edit').innerHTML = `
      <div class="sec">
        <div class="kv"><span>Status</span><span>${n ? `${n} change${n > 1 ? 's' : ''} saved locally` : 'Matches Figma'}</span>
        <span>Undo stack</span><span>${s.undo.length}</span></div>
        <div class="row" style="margin-top:16px">
          <button class="btn small" data-act="undo" ${s.undo.length ? '' : 'disabled'}>Undo <kbd>⌘Z</kbd></button>
          <button class="btn small" data-act="redo" ${s.redo.length ? '' : 'disabled'}>Redo</button>
          <button class="btn small" data-act="reset" ${n ? '' : 'disabled'}>Reset to Figma</button>
        </div>
      </div>
      <div class="sec">
        <h3 class="sec-title">Headline neon</h3>
        <p class="hint">Select a word in the headline, then tap Neon (or use this button). Tap again to remove it.</p>
        <div class="row" style="margin-top:12px"><button class="btn small" data-act="neon" ${app.mode === 'edit' ? '' : 'disabled'}>Neon on selection</button></div>
      </div>
      <div class="sec">
        <h3 class="sec-title">Text layers</h3>
        <div class="kv">${layers.map((l) => `<span>${esc(labelFor(l._parent || l))}</span><span>${edited(l.id) ? 'Edited' : 'Figma'}</span>`).join('')}</div>
      </div>
      <div class="sec"><p class="hint">${app.mode === 'edit' ? 'Click any text to type in place; the stack reflows and the hero crops instead of overlapping. Click an image, logo or the background for swap, crop and nudge.' : 'Press E to start editing this piece.'} Edits are saved per piece in this browser.</p></div>`;
    const tab = document.getElementById('tab-edit');
    tab.querySelector('[data-act="undo"]').addEventListener('click', app.undo);
    tab.querySelector('[data-act="redo"]').addEventListener('click', app.redo);
    tab.querySelector('[data-act="neon"]').addEventListener('mousedown', (e) => e.preventDefault());
    tab.querySelector('[data-act="neon"]').addEventListener('click', neonSelection);
    tab.querySelector('[data-act="reset"]').addEventListener('click', async () => {
      pushUndo();
      await restore({ texts: {}, images: {}, background: null });
      app.toast('Reset to Figma · undo with ⌘Z');
    });
  }

  const vp = document.getElementById('viewport');
  vp.addEventListener('beforeinput', onBeforeInput);
  vp.addEventListener('input', onInput);
  vp.addEventListener('click', onArtClick);
  document.addEventListener('selectionchange', onSelection);
  document.addEventListener('pointerdown', (e) => {
    const p = layer.querySelector('.pop.img-menu');
    if (p && !p.contains(e.target) && !app.wrap?.contains(e.target)) closeMenu();
  });
  app.on((what) => {
    if (what === 'piece' || what === 'mode') { closeMenu(); hideBar(); burst = null; committed = app.view ? snapshot() : null; }
    if (['piece', 'mode', 'edit'].includes(what)) renderTab();
  });
}
