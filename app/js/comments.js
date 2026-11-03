import { prefs } from './store.js';

const DISC = [
  { key: 'design', label: 'Design' },
  { key: 'copy', label: 'Copy' },
  { key: 'lc', label: 'L&C' },
];
const discLabel = (k) => DISC.find((d) => d.key === k)?.label || k;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (iso) => {
  const d = new Date(iso);
  const diff = (Date.now() - d) / 60000;
  if (diff < 1) return 'just now';
  if (diff < 60) return `${Math.round(diff)} min ago`;
  if (diff < 1440) return `${Math.round(diff / 60)} h ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export function initComments(app) {
  const layer = document.getElementById('pop-layer');
  const filter = { disc: 'all', status: 'open' };
  let active = null;
  let newestId = null;

  const list = () => app.comments.all().filter((c) => c.scope === app.pieceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const numbered = () => list().map((c, i) => ({ ...c, n: i + 1 }));

  function closePop() {
    const p = layer.querySelector('.pop');
    if (!p) return false;
    p.classList.add('is-out');
    setTimeout(() => p.remove(), 140);
    if (p._pending) p._pending.remove();
    active = null;
    renderPins();
    return true;
  }
  const prevClose = app.closePop;
  app.closePop = () => closePop() || (prevClose ? prevClose() : false);

  function place(pop, x, y) {
    layer.appendChild(pop);
    const r = pop.getBoundingClientRect();
    let left = x + 40;
    let top = y - 36;
    if (left + r.width > innerWidth - 16) left = x - r.width - 16;
    if (left < 16) left = 16;
    if (top + r.height > innerHeight - 16) top = innerHeight - r.height - 16;
    if (top < 16) top = 16;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.setProperty('--ox', `${x - left}px`);
    pop.style.setProperty('--oy', `${y - top}px`);
  }

  function pinPoint(c) {
    const r = app.wrap.getBoundingClientRect();
    return { x: r.left + c.x * r.width, y: r.top + c.y * r.height };
  }

  function renderPins() {
    const el = app.pinsEl;
    if (!el) return;
    el.textContent = '';
    for (const c of numbered()) {
      if (filter.disc !== 'all' && c.discipline !== filter.disc) continue;
      if (filter.status === 'open' && c.status === 'resolved') continue;
      if (filter.status === 'resolved' && c.status !== 'resolved') continue;
      const b = document.createElement('button');
      b.className = `pin${c.status === 'resolved' ? ' is-resolved' : ''}${active === c.id ? ' is-active' : ''}${newestId === c.id ? ' is-new' : ''}`;
      b.dataset.d = c.discipline;
      b.style.left = `${c.x * 100}%`;
      b.style.top = `${c.y * 100}%`;
      b.textContent = c.n;
      b.setAttribute('aria-label', `Comment ${c.n}, ${discLabel(c.discipline)}`);
      b.addEventListener('click', (e) => { e.stopPropagation(); openThread(c.id); });
      el.appendChild(b);
    }
    newestId = null;
  }

  function renderTab() {
    const all = numbered();
    const open = all.filter((c) => c.status !== 'resolved').length;
    document.getElementById('c-count').textContent = open ? String(open) : '';
    const shown = all.filter((c) => (filter.disc === 'all' || c.discipline === filter.disc) && (filter.status === 'all' || (filter.status === 'open' ? c.status !== 'resolved' : c.status === 'resolved')));
    const tab = document.getElementById('tab-comments');
    tab.innerHTML = `
      <div class="sec">
        <div class="filters" data-group="disc">
          ${[{ key: 'all', label: 'All' }, ...DISC].map((d) => `<button class="fchip" data-v="${d.key}" aria-pressed="${filter.disc === d.key}">${d.key !== 'all' ? `<span class="dot" data-d="${d.key}"></span>` : ''}${d.label}</button>`).join('')}
        </div>
        <div class="filters" data-group="status" style="margin-top:8px">
          ${['open', 'resolved', 'all'].map((s) => `<button class="fchip" data-v="${s}" aria-pressed="${filter.status === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="sec">
        ${shown.length ? `<ul class="clist">${shown.map((c) => `
          <li><button class="citem${c.status === 'resolved' ? ' is-resolved' : ''}${active === c.id ? ' is-active' : ''}" data-id="${c.id}">
            <span class="num" data-d="${c.discipline}">${c.n}</span>
            <span><span class="meta"><span>${esc(c.author)}</span><span>${discLabel(c.discipline)}</span><span>${when(c.createdAt)}</span>${c.replies?.length ? `<span>${c.replies.length} ${c.replies.length > 1 ? 'replies' : 'reply'}</span>` : ''}</span>
            <p>${esc(c.text)}</p></span>
          </button></li>`).join('')}</ul>`
        : `<p class="empty">${all.length ? 'Nothing matches these filters.' : 'No comments on this piece yet. Press C, then click anywhere on the piece to drop a pin.'}</p>`}
      </div>
      <div class="sec">
        <h3 class="sec-title">Storage</h3>
        <p class="hint">Comments are saved in this browser only. Export them as JSON to share, and import a teammate’s file to merge.</p>
        <div class="row" style="margin-top:12px">
          <button class="btn small" id="c-export">Export JSON</button>
          <button class="btn small" id="c-import">Import JSON</button>
          <input type="file" id="c-file" accept="application/json,.json" hidden>
        </div>
      </div>`;
    tab.querySelectorAll('.filters').forEach((g) => g.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      filter[g.dataset.group] = b.dataset.v;
      renderTab();
      renderPins();
    }));
    tab.querySelectorAll('.citem').forEach((b) => b.addEventListener('click', () => openThread(b.dataset.id)));
    tab.querySelector('#c-export').addEventListener('click', () => {
      const blob = new Blob([app.comments.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `review-room-comments-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const file = tab.querySelector('#c-file');
    tab.querySelector('#c-import').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        const n = app.comments.importJSON(await f.text());
        app.toast(`Merged ${n} comments`);
      } catch {
        app.toast('That file is not a comments export');
      }
    });
  }

  function composer(x, y) {
    closePop();
    const author = prefs.get('author', '');
    const pending = document.createElement('div');
    pending.className = 'pin is-new';
    pending.dataset.d = 'design';
    pending.style.left = `${x * 100}%`;
    pending.style.top = `${y * 100}%`;
    pending.textContent = '+';
    app.pinsEl.appendChild(pending);
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'New comment');
    pop._pending = pending;
    let disc = null;
    pop.innerHTML = `
      <h4>Which discipline?</h4>
      <div class="disc">${DISC.map((d) => `<button data-d="${d.key}" aria-pressed="false"><span class="dot" data-d="${d.key}"></span>${d.label}</button>`).join('')}</div>
      <div class="rest" hidden>
        <div class="field"><label for="c-author">Your name</label><input id="c-author" value="${esc(author)}" placeholder="Name" autocomplete="name"></div>
        <div class="field"><label for="c-text">Comment</label><textarea id="c-text" placeholder="What should change?"></textarea></div>
        <div class="pop-actions"><span class="hint">⌘↵ to post</span><div class="row"><button class="btn small" data-act="cancel">Cancel</button><button class="btn small primary" data-act="post" disabled>Post</button></div></div>
      </div>`;
    const p = pinPoint({ x, y });
    place(pop, p.x, p.y);
    const rest = pop.querySelector('.rest');
    const post = pop.querySelector('[data-act="post"]');
    const text = pop.querySelector('#c-text');
    const name = pop.querySelector('#c-author');
    const valid = () => { post.disabled = !(disc && text.value.trim() && name.value.trim()); };
    pop.querySelector('.disc').addEventListener('click', (e) => {
      const b = e.target.closest('[data-d]');
      if (!b) return;
      disc = b.dataset.d;
      pending.dataset.d = disc;
      pop.querySelectorAll('.disc button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const wasHidden = rest.hidden;
      rest.hidden = false;
      if (wasHidden) place(pop, p.x, p.y);
      (name.value ? text : name).focus();
      valid();
    });
    pop.addEventListener('keydown', (e) => {
      if (!disc && /^[1-3]$/.test(e.key)) pop.querySelectorAll('.disc button')[+e.key - 1].click();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !post.disabled) post.click();
    });
    text.addEventListener('input', valid);
    name.addEventListener('input', valid);
    pop.querySelector('[data-act="cancel"]').addEventListener('click', closePop);
    post.addEventListener('click', async () => {
      prefs.set('author', name.value.trim());
      const c = await app.comments.add({ scope: app.pieceId, x, y, discipline: disc, author: name.value.trim(), text: text.value.trim(), status: 'open', replies: [] });
      newestId = c.id;
      pending.remove();
      pop._pending = null;
      closePop();
      if (filter.status === 'resolved') filter.status = 'open';
      renderTab();
      renderPins();
      app.toast(`Comment posted · ${discLabel(disc)}`);
    });
    pop.querySelector('.disc button').focus();
  }

  function openThread(id) {
    const c = numbered().find((x) => x.id === id);
    if (!c) return;
    closePop();
    active = id;
    renderPins();
    renderTab();
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Comment ${c.n}`);
    const author = prefs.get('author', '');
    pop.innerHTML = `
      <h4><span class="dot" data-d="${c.discipline}" style="display:inline-block;margin-right:8px"></span>#${c.n} · ${discLabel(c.discipline)}${c.status === 'resolved' ? ' · Resolved' : ''}</h4>
      <div class="thread">
        <div class="msg"><div class="meta">${esc(c.author)} · ${when(c.createdAt)}</div><p>${esc(c.text)}</p></div>
        ${(c.replies || []).map((r) => `<div class="msg"><div class="meta">${esc(r.author)} · ${when(r.createdAt)}</div><p>${esc(r.text)}</p></div>`).join('')}
      </div>
      ${author ? '' : '<div class="field"><label for="r-author">Your name</label><input id="r-author" placeholder="Name" autocomplete="name"></div>'}
      <div class="field"><label for="r-text">Reply</label><textarea id="r-text" placeholder="Reply"></textarea></div>
      <div class="pop-actions">
        <button class="btn small" data-act="resolve">${c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
        <button class="btn small primary" data-act="reply" disabled>Reply</button>
      </div>`;
    const p = pinPoint(c);
    place(pop, p.x, p.y);
    const text = pop.querySelector('#r-text');
    const name = pop.querySelector('#r-author');
    const reply = pop.querySelector('[data-act="reply"]');
    const valid = () => { reply.disabled = !(text.value.trim() && (author || name?.value.trim())); };
    text.addEventListener('input', valid);
    name?.addEventListener('input', valid);
    pop.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !reply.disabled) reply.click(); });
    reply.addEventListener('click', async () => {
      const who = author || name.value.trim();
      prefs.set('author', who);
      await app.comments.update(c.id, (cur) => ({ replies: [...(cur.replies || []), { id: Math.random().toString(36).slice(2, 9), author: who, text: text.value.trim(), createdAt: new Date().toISOString() }] }));
      openThread(c.id);
    });
    pop.querySelector('[data-act="resolve"]').addEventListener('click', async () => {
      const resolved = c.status !== 'resolved';
      await app.comments.update(c.id, { status: resolved ? 'resolved' : 'open' });
      closePop();
      app.toast(resolved ? `#${c.n} resolved` : `#${c.n} reopened`);
    });
  }

  function onStageClick(e) {
    if (app.mode !== 'comment' || !app.wrap?.contains(e.target) || e.target.closest('.pin')) return;
    const r = app.wrap.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    composer(x, y);
  }
  document.getElementById('viewport').addEventListener('click', onStageClick);
  document.addEventListener('pointerdown', (e) => {
    const pop = layer.querySelector('.pop');
    if (pop && !pop.contains(e.target) && !e.target.closest('.pin') && !app.wrap?.contains(e.target)) closePop();
  });

  app.on((what) => {
    if (what === 'piece') { active = null; closePop(); }
    if (['piece', 'layout', 'comments'].includes(what)) { renderPins(); renderTab(); }
  });
}
