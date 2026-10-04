// Fleet Signals — platform adapter (src/platform/starhermit.js) on the real
// StarHermit SDK with a stubbed fetch and launch URL. Run: node --test tests/platform.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlatform, applyRemoteSettings, DEFAULT_KEYS } from '../src/platform/starhermit.js';
import { defaultSave } from '../src/platform/save.js';

// The package is ESM, so the UMD SDK is evaluated with a CommonJS-style module object.
const SDK = (() => { const module = { exports: {} }; new Function('module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(module); return module.exports; })();
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = 'h.' + b64u({ sub: 'cap-1234567', game_scope: 'fleet-id', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

function harness(href, routes = {}) {
  const calls = []; const store = {}; const url = new URL(href);
  const win = { location: { hash: url.hash, search: url.search, pathname: url.pathname, origin: url.origin, hostname: url.hostname, href }, history: { replaceState: (a, b, u) => { win.replaced = u; } } };
  const fetch = async (path, init = {}) => {
    const method = init.method || 'GET'; calls.push({ path, method, body: init.body });
    if (path.includes('/cloud-saves/')) {
      const key = decodeURIComponent(path.split('/cloud-saves/')[1]);
      if (key.endsWith('/info')) return new Response(JSON.stringify({ exists: !!store[key.slice(0, -5)] }), { status: 200 });
      if (method === 'PUT') { store[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return new Response('{}', { status: 200 }); }
      return store[key] ? new Response(store[key], { status: 200 }) : new Response('', { status: 404 });
    }
    const hit = Object.entries(routes).find(([k]) => `${method} ${path}`.endsWith(k));
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response('', { status: 404 });
  };
  const sh = SDK.create({ window: win, fetch, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; } }).init();
  return { platform: createPlatform(sh), sh, calls, store, win };
}

test('hosted: token read, nickname, cloud save game:<slug> round-trip', async () => {
  const h = harness('https://fleet-id.starhermit.com/#game_token=' + TOKEN, {
    'GET /api/v1/users/cap-1234567/profile': { username: 'raw', nickname: 'Salty Admiral' },
  });
  assert.equal(h.platform.hosted, true);
  assert.equal(h.sh.slug, 'fleet-id');
  assert.equal(h.win.replaced, '/');
  assert.equal(await h.platform.nickname(), 'Salty Admiral');
  assert.equal(await h.platform.nickname('zz-99999999'), 'Player zz-999');
  assert.equal(await h.platform.cloud.load(), null, 'empty slot');
  const doc = defaultSave(); doc.stats.sessions = 3;
  h.platform.cloud.push(doc);
  assert.equal(h.platform.syncStatus, 'saving');
  assert.equal(await h.platform.cloud.flush(), true);
  assert.equal(h.platform.syncStatus, 'synced');
  assert.deepEqual(Object.keys(h.store), ['game:fleet-id']);
  assert.ok(h.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/me/cloud-saves/' + encodeURIComponent('game:fleet-id')));
  assert.equal((await h.platform.cloud.load()).stats.sessions, 3);
  assert.match(h.platform.inviteLink(), /\/game-invite\/cap-1234567\/fleet-id$/);
});

test('hosted: settings KV apply + patch on change, key bindings', async () => {
  const h = harness('https://x.example/#game_token=' + TOKEN, {
    'GET /api/v1/games/fleet-id/settings': { settings: { music: 0.2, palette: 'tritanopia', muted: 'nope', junk: 1 } },
    'PATCH /api/v1/games/fleet-id/settings': {},
    'GET /api/v1/games/fleet-id/controls': { actions: [{ action: 'rotate', codes: ['KeyQ'] }] },
  });
  const settings = defaultSave().settings;
  assert.equal(applyRemoteSettings(settings, await h.platform.getSettings()), true);
  assert.equal(settings.music, 0.2); assert.equal(settings.palette, 'tritanopia'); assert.equal(settings.muted, false);
  h.platform.markSettingsBaseline(settings);
  h.platform.syncSettings(settings);
  assert.equal(h.calls.filter((c) => c.method === 'PATCH').length, 0, 'unchanged settings are not patched');
  settings.effects = 0.4;
  h.platform.syncSettings(settings);
  const patch = h.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, '/api/v1/games/fleet-id/settings');
  assert.equal(JSON.parse(patch.body).settings.effects, 0.4);
  const keys = await h.platform.loadKeys();
  assert.deepEqual(keys.rotate, ['KeyQ']); assert.deepEqual(keys.hint, DEFAULT_KEYS.hint);
});

test('renewal refused: signed out, local play continues', async () => {
  const h = harness('https://x.example/#game_token=' + TOKEN);
  let out = 0; h.platform.onSignedOut = () => { out++; };
  h.sh.signOut('expired');
  assert.equal(h.platform.hosted, false); assert.equal(out, 1); assert.equal(h.platform.syncStatus, 'offline');
});

test('standalone: no network calls at all', async () => {
  const h = harness('http://127.0.0.1:8080/');
  assert.equal(h.platform.hosted, false);
  assert.equal(h.platform.canSignIn(), false);
  h.platform.cloud.push(defaultSave());
  await h.platform.cloud.flush();
  assert.equal(await h.platform.cloud.load(), null);
  assert.deepEqual(await h.platform.getSettings(), {});
  h.platform.syncSettings(defaultSave().settings);
  assert.deepEqual(await h.platform.loadKeys(), DEFAULT_KEYS);
  assert.equal(await h.platform.nickname(), null);
  assert.equal(h.platform.inviteLink(), null);
  assert.equal(h.calls.length, 0);
});

test('sign-in offered on the platform host without a token', () => {
  const h = harness('https://fleet-id.starhermit.com/');
  assert.equal(h.platform.canSignIn(), true);
  assert.equal(h.calls.length, 0);
});
