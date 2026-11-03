// Storage adapters. Every adapter implements: list(scope), add(item), update(id, patch), subscribe(fn) -> unsubscribe.

// Shared-comments backend. GitHub Pages has no server: set this to the backend you choose,
// then switch `createCommentStore` to return a RemoteAdapter.
export const REMOTE_CONFIG = {
  endpoint: null, // e.g. 'https://<your-backend>/api/review-room'
  headers: {},
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function safeGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export class LocalAdapter {
  constructor(key, seed = []) {
    this.key = key;
    this.subs = new Set();
    const items = safeGet(key, null);
    if (!items) safeSet(key, seed);
    else if (seed.length) {
      const ids = new Set(items.map((i) => i.id));
      const merged = items.concat(seed.filter((s) => !ids.has(s.id)));
      safeSet(key, merged);
    }
    window.addEventListener('storage', (e) => {
      if (e.key === this.key) this.emit();
    });
  }

  all() { return safeGet(this.key, []); }

  async list(scope) {
    const all = this.all();
    return scope ? all.filter((i) => i.scope === scope) : all;
  }

  async add(item) {
    const all = this.all();
    const full = { id: uid(), createdAt: new Date().toISOString(), ...item };
    all.push(full);
    safeSet(this.key, all);
    this.emit();
    return full;
  }

  async update(id, patch) {
    const all = this.all();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...(typeof patch === 'function' ? patch(all[i]) : patch), updatedAt: new Date().toISOString() };
    safeSet(this.key, all);
    this.emit();
    return all[i];
  }

  async remove(id) {
    safeSet(this.key, this.all().filter((x) => x.id !== id));
    this.emit();
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit() { this.subs.forEach((fn) => fn()); }

  exportJSON() {
    return JSON.stringify({ kind: this.key, exportedAt: new Date().toISOString(), items: this.all() }, null, 2);
  }

  importJSON(text) {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data.items || [];
    const byId = new Map(this.all().map((i) => [i.id, i]));
    for (const it of incoming) {
      const cur = byId.get(it.id);
      if (!cur || (it.updatedAt || it.createdAt) > (cur.updatedAt || cur.createdAt)) byId.set(it.id, it);
    }
    safeSet(this.key, [...byId.values()]);
    this.emit();
    return incoming.length;
  }
}

export class RemoteAdapter {
  constructor(config = REMOTE_CONFIG) {
    if (!config.endpoint) throw new Error('RemoteAdapter: set REMOTE_CONFIG.endpoint in js/store.js');
    this.config = config;
    this.subs = new Set();
  }

  async request(path, init = {}) {
    const r = await fetch(this.config.endpoint + path, { ...init, headers: { 'Content-Type': 'application/json', ...this.config.headers } });
    if (!r.ok) throw new Error(`Remote ${r.status}`);
    return r.json();
  }

  list(scope) { return this.request(`/items?scope=${encodeURIComponent(scope || '')}`); }
  add(item) { return this.request('/items', { method: 'POST', body: JSON.stringify(item) }).finally(() => this.emit()); }
  update(id, patch) { return this.request(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).finally(() => this.emit()); }
  subscribe(fn) {
    // Polling placeholder; a real backend would push (SSE / websocket).
    this.subs.add(fn);
    const t = setInterval(fn, 15000);
    return () => { this.subs.delete(fn); clearInterval(t); };
  }
  emit() { this.subs.forEach((fn) => fn()); }
}

export function createCommentStore(seed) {
  return new LocalAdapter('rr.comments.v1', seed);
}

// Per-piece edit state, same adapter idea: one record per piece id.
export class EditsStore {
  constructor() {
    this.inner = new LocalAdapter('rr.edits.v1');
  }
  get(pieceId) {
    return this.inner.all().find((r) => r.id === pieceId)?.edits || null;
  }
  async set(pieceId, edits) {
    const exists = this.inner.all().some((r) => r.id === pieceId);
    if (exists) return this.inner.update(pieceId, { edits });
    const all = this.inner.all();
    all.push({ id: pieceId, scope: 'edits', edits, createdAt: new Date().toISOString() });
    safeSet(this.inner.key, all);
    this.inner.emit();
  }
  async clear(pieceId) { return this.inner.remove(pieceId); }
  subscribe(fn) { return this.inner.subscribe(fn); }
}

export const prefs = {
  get: (k, d) => safeGet('rr.pref.' + k, d),
  set: (k, v) => safeSet('rr.pref.' + k, v),
};
