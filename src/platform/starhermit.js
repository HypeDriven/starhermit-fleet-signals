/**
 * Fleet Signals — StarHermit hosted-platform adapter.
 *
 * The platform serves the game at <slug>.starhermit.com with same-origin
 * /api. The launch token arrives in the URL fragment as
 * `#game_token=<jwt>`; it is read once and stripped. JWT claims are
 * base64url-decoded, not verified — the backend is authoritative.
 *
 * Everything here is offline-tolerant: any failure leaves local play on
 * the local save document, exactly as before.
 */

/** Read the launch token once, strip it from the URL, decode its claims. */
export function readLaunchToken(loc = location) {
  let raw = null;
  const fromHash = new URLSearchParams(loc.hash.slice(1));
  if (fromHash.get('game_token')) raw = fromHash.get('game_token');
  // Query fallbacks are for local dev only; the platform uses the fragment.
  if (!raw) {
    const q = new URLSearchParams(loc.search);
    raw = q.get('game_token') || q.get('token') || q.get('launch');
  }
  if (raw && loc.hash) {
    try { history.replaceState(null, '', loc.pathname + loc.search); } catch { /* strip is best-effort */ }
  }
  const claims = raw && decodeJwt(raw);
  if (!claims) return null;
  return { token: raw, sub: claims.sub || null, slug: claims.game_scope || null };
}

/** Base64url-decode a JWT payload (no signature verification). */
export function decodeJwt(t) {
  try {
    const payload = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload));
  } catch { return null; }
}

/**
 * Authenticated REST helper. The token is read live from `auth.token` so a
 * 45-minute remint is picked up by every later call.
 */
export function createApi(auth) {
  return async function api(method, path, body, opts = {}) {
    const res = await fetch(path, {
      method,
      keepalive: !!opts.keepalive, // tiny payloads; lets pagehide flushes complete
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

/**
 * Account nickname for the launch-token subject. NEVER /api/v1/me (403 for
 * launch tokens), never usernames — profile nickname with a neutral
 * shortened-id fallback.
 */
export async function resolveNickname(api, sub) {
  if (!sub) return null;
  try {
    const p = await api('GET', `/api/v1/users/${sub}/profile`);
    if (p && typeof p.nickname === 'string' && p.nickname.trim()) return p.nickname.trim();
  } catch { /* profile unavailable: neutral fallback below */ }
  return 'Player ' + String(sub).slice(0, 8);
}

/**
 * Launch-token refresh. Scoped tokens may re-mint; swap the new token in
 * and keep the schedule. Failures retry in ~60 s — one swallowed failure
 * must not take the session permanently offline.
 */
export function scheduleTokenRefresh(auth, api, delay = 45 * 60 * 1000) {
  setTimeout(async () => {
    try {
      const d = await api('POST', `/api/v1/games/${auth.slug}/launch-token`);
      if (d && d.token) auth.token = d.token;
      scheduleTokenRefresh(auth, api, 45 * 60 * 1000);
    } catch {
      scheduleTokenRefresh(auth, api, 60 * 1000);
    }
  }, delay);
}

/* ------------------------------------------------------------------ */
/* Stored-zip helpers (no compression; saves are small JSON docs)      */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal single-entry ZIP writer (stored, CRC32 included). */
export function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

/** Stored single-entry reader: take the first local header's payload. */
export function unzipFirstEntry(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/* ------------------------------------------------------------------ */
/* Cloud save — one slot, zip+base64 mirror of the local save doc      */
/* ------------------------------------------------------------------ */

const CLOUD_DEBOUNCE_MS = 2000;
const CLOUD_MAX_BYTES = 10 * 1024 * 1024; // platform slot cap

/**
 * Cloud-save mirror. localStorage stays the offline cache and the
 * authoritative local source; the cloud slot is a remote mirror that
 * wins on conflict at load time. Saves debounce ~2 s and flush on
 * pagehide. `onStatus` receives 'loading' | 'saving' | 'synced' |
 * 'offline' | 'error'.
 */
export function createCloudSave({ api, auth, slug, onStatus }) {
  let timer = null;
  let latest = null;   // doc pending upload
  let inFlight = null; // latest upload promise (flush awaits it)

  async function upload(doc) {
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    if (bytes.length > CLOUD_MAX_BYTES) { onStatus('error'); return; }
    onStatus('saving');
    try {
      await api('PUT', `/api/v1/me/cloud-saves/${slug}`, { dataBase64: bytesToBase64(zipStore('save.json', bytes)) }, { keepalive: true });
      onStatus('synced');
    } catch {
      onStatus('error');
    }
  }

  function push(doc) {
    latest = doc;
    clearTimeout(timer);
    timer = setTimeout(() => { inFlight = upload(latest); latest = null; }, CLOUD_DEBOUNCE_MS);
  }

  function flush() {
    clearTimeout(timer);
    if (latest) {
      const doc = latest;
      latest = null;
      inFlight = (inFlight || Promise.resolve()).then(() => upload(doc));
    }
    return inFlight || Promise.resolve();
  }

  /** GET the cloud slot → parsed save doc or null (404/none/network). */
  async function load() {
    onStatus('loading');
    const res = await fetch(`/api/v1/me/cloud-saves/${slug}`, {
      headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
    }).catch(() => null);
    if (!res || !res.ok) return null; // 404 = no save yet; offline = local cache wins
    try {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
    } catch { return null; }
  }

  return { push, flush, load };
}
