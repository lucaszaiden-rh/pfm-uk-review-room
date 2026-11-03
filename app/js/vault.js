// Decrypts `openssl enc -aes-256-cbc -pbkdf2 -md sha256` packs: PBKDF2 gives 48 bytes = 32 key + 16 IV.
const ITER = 200000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class WrongPassword extends Error {}

async function decryptBuffer(buf, password) {
  const bytes = new Uint8Array(buf);
  const magic = dec.decode(bytes.slice(0, 8));
  if (magic !== 'Salted__') throw new Error('Not an encrypted pack');
  const salt = bytes.slice(8, 16);
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, 384));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-CBC', false, ['decrypt']);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: bits.slice(32, 48) }, key, bytes.slice(16)));
  } catch {
    throw new WrongPassword('Wrong password');
  }
}

// Pack container: "RRPK" + uint32 header length + JSON header + payload.
function unpack(bytes) {
  if (dec.decode(bytes.slice(0, 4)) !== 'RRPK') throw new WrongPassword('Wrong password');
  const len = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0);
  const header = JSON.parse(dec.decode(bytes.slice(8, 8 + len)));
  const body = 8 + len;
  const files = {};
  for (const [name, f] of Object.entries(header.files)) {
    files[name] = { type: f.t, bytes: bytes.subarray(body + f.o, body + f.o + f.l) };
  }
  return files;
}

export class Vault {
  constructor(base = 'data/') {
    this.base = base;
    this.password = null;
    this.packs = new Map();
    this.urls = new Map();
  }

  async open(password, manifestName = 'm.enc') {
    const res = await fetch(this.base + manifestName, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Content not found. Run tools/build.py first.');
    const plain = await decryptBuffer(await res.arrayBuffer(), password);
    const files = unpack(plain);
    this.password = password;
    this.packs.set(manifestName, Promise.resolve(files));
    return JSON.parse(dec.decode(files['manifest.json'].bytes));
  }

  pack(name) {
    if (!this.packs.has(name)) {
      const p = fetch(this.base + name)
        .then((r) => { if (!r.ok) throw new Error(`Missing pack ${name}`); return r.arrayBuffer(); })
        .then((b) => decryptBuffer(b, this.password))
        .then(unpack);
      p.catch(() => this.packs.delete(name));
      this.packs.set(name, p);
    }
    return this.packs.get(name);
  }

  async url(pack, path) {
    const k = pack + '|' + path;
    if (this.urls.has(k)) return this.urls.get(k);
    const files = await this.pack(pack);
    const f = files[path];
    if (!f) return null;
    const u = URL.createObjectURL(new Blob([f.bytes], { type: f.type }));
    this.urls.set(k, u);
    return u;
  }

  async bytes(pack, path) {
    const files = await this.pack(pack);
    return files[path]?.bytes || null;
  }
}
