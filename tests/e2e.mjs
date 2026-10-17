/**
 * Fleet Signals — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the REAL visible UI in headless Chrome (playwright-core + system
 * Chrome): title → settings (reduced motion + palette) → practice setup →
 * deploy fleet (Auto-deploy + Confirm) → battle played with the on-screen
 * Hint key/button + Fire button → undo, note-mode, pause/resume → results
 * screen with score breakdown → back to title, with save persistence checks.
 * Two passes: desktop 1280x800 and a fresh mobile context 390x844 + touch.
 *
 * The only page-state pokes are: reading window.__fleet for synchronization
 * (whose turn, phase, shot counts) and setting app.aiDelay — the same pacing
 * knob the game's own ?demo capture mode uses — so the AI doesn't add
 * theatrical pauses. Every game action goes through real clicks/keys.
 *
 * Self-contained: starts its own static server on an ephemeral port.
 * (server.js in this repo is the StarHermit authoritative game script, NOT
 * a static file server, so it is not used.) /api/* serves StarHermit platform
 * mocks for the signed-in pass; the standalone passes must make no /api call.
 *
 * Note (resolved 2026-09-04, see knownissues.md #5): Pause → Settings → Done → Resume
 * used to unmount the game HUD/tray (showSettings() called mount() which wiped #ui).
 * That is now fixed: settings-from-pause overlays the still-mounted game. This test
 * still exercises settings from the title screen and pause/resume separately, and
 * deliberately does not click "Settings" inside the pause menu.
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'text/typescript',
};
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const apiLog = [];
// Platform state the Language pass reads back (server-side mocks).
const mock = { language: 'en', settings: {}, reports: [] };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
const server = http.createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.startsWith('/api/')) { // StarHermit platform mocks (hosted pass only)
      apiLog.push(`${req.method} ${path}`);
      const json = (b, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (path.endsWith('/profile')) return json({ username: 'raw_name', nickname: 'Salty Admiral' });
      if (path === '/api/v1/me/language') return json({ preferredLanguage: mock.language });
      if (path.endsWith('/settings') && req.method === 'GET') return json({ settings: { music: 0.3, ...mock.settings } });
      if (path.endsWith('/settings')) return json({ settings: {} });
      if (/\/settings\/[^/]+$/.test(path) && req.method === 'PUT') { mock.settings[path.split('/').pop()] = JSON.parse(await body(req)).value; return json({}); }
      if (/\/reports$/.test(path) && req.method === 'POST') { mock.reports.push(JSON.parse(await body(req))); return json({ id: 'r1', kind: 'bug', status: 'open', createdAt: new Date().toISOString() }, 201); }
      if (path.endsWith('/controls')) return json({ actions: [{ action: 'rotate', codes: ['KeyQ'] }] });
      if (path.endsWith('/cloud-saves/game:fleet-test/info')) return json({ exists: false });
      if (path.endsWith('/cloud-saves/game:fleet-test')) return json(req.method === 'PUT' ? { etag: '"v' + apiLog.length + '"' } : {});
      return json({ error: 'not found' }, 404);
    }
    const file = normalize(join(ROOT, path === '/' ? '/index.html' : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(Number(process.env.PORT) || 0, r)); // PORT pins the port; else ephemeral
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

async function runPass({ name, viewport, hasTouch }) {
  const SHOT = (s) => `/tmp/fleet-signals-e2e-${s}-${name}.png`;
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console ${m.type()}: ${m.text()}`);
  });

  const step = async (n, fn) => { await fn(); console.log(`ok - [${name}] ${n}`); };
  const appPhase = () => page.evaluate(() => ({
    app: window.__fleet?.app?.phase,
    state: window.__fleet?.app?.session?.state.phase,
    finished: window.__fleet?.app?.session?.state.phase === 'finished',
  }));
  const waitMyTurnOrEnd = () => page.waitForFunction(() => {
    const app = window.__fleet?.app;
    if (!app?.session) return false;
    const st = app.session.state;
    if (st.phase === 'finished') return true;
    if (st.phase !== 'battle' || app.phase !== 'battle' || app.inputLocked || app.paused) return false;
    return st.players[st.currentPlayerIndex].id === app._viewer();
  }, null, { timeout: 25000 });
  /** Fire one shot purely through the UI: H (hint selects a cell) → Fire button. */
  const fireViaHint = async () => {
    await page.keyboard.press('h');
    await page.waitForTimeout(120);
    const fire = page.locator('[data-tact="fire"]');
    if (!(await fire.isEnabled().catch(() => false))) throw new Error('hint did not arm the Fire button');
    await fire.click();
  };

  try {
    await step('load + title visible', async () => {
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForSelector('.game-title', { timeout: 15000 });
      await page.waitForFunction(() => window.__fleet?.app?.phase === 'menu');
      await page.screenshot({ path: SHOT('title') });
    });

    await step('settings open/apply/close', async () => {
      await page.click('button[data-act="settings"]');
      await page.waitForSelector('#set-reducedMotion');
      await page.check('#set-reducedMotion'); // also skips the countdown theatre
      await page.selectOption('#set-palette', 'deuteranopia');
      const applied = await page.evaluate(() => ({
        motion: document.documentElement.classList.contains('reduced-motion'),
        palette: document.documentElement.classList.contains('palette-deuteranopia'),
      }));
      if (!applied.motion || !applied.palette) throw new Error('settings not applied: ' + JSON.stringify(applied));
      await page.screenshot({ path: SHOT('settings') });
      await page.click('[data-act="done"]');
      await page.waitForSelector('.game-title');
    });

    await step('graphics settings: presets, override, fps, persistence', async () => {
      const preset = () => page.evaluate(() => document.body.dataset.gfxPreset);
      const summary = () => page.textContent('#gfx-summary');
      await page.click('button[data-act="settings"]');
      await page.waitForSelector('#gfx-section #gfx-preset');
      await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
      if ((await preset()) !== 'low') throw new Error('headless software GPU should resolve Auto to Low, got ' + (await preset()));
      if (!/detected/i.test(await page.textContent('#gfx-preset option[value="auto"]'))) throw new Error('Auto option lacks the detected tier');
      // The summary names the StarHermit hardware level (software GPU = level 0).
      if (!/Level 0/.test(await summary())) throw new Error('summary lacks the hardware level: ' + (await summary()));
      await page.selectOption('#gfx-preset', 'low');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'low');
      if (!/no shadows/.test(await summary())) throw new Error('Low summary: ' + (await summary()));
      await page.selectOption('#gfx-preset', 'high');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'high' && !!window.__fleet.scene.composer);
      await page.waitForFunction(() => /SMAA/.test(document.querySelector('#gfx-summary').textContent));
      if (!/From preset/.test(await page.textContent('#gfx-cat-shadows option[value="preset"]'))) throw new Error('category default label');
      await page.selectOption('#gfx-cat-shadows', 'off');
      await page.waitForFunction(() => /no shadows/.test(document.querySelector('#gfx-summary').textContent)
        && window.__fleet.scene.renderer.shadowMap.enabled === false);
      await page.check('#gfx-fps');
      await page.waitForSelector('#fps-meter:not([hidden])', { state: 'attached' });
      // the whole section fits the viewport width (no horizontal cut-off)
      const overflow = await page.evaluate(() => [...document.querySelectorAll('#gfx-section select, #gfx-section input')]
        .some((n) => { const r = n.getBoundingClientRect(); return r.left < 0 || r.right > window.innerWidth + 1; }));
      if (overflow) throw new Error('graphics controls overflow the viewport');
      await page.locator('#gfx-section').screenshot({ path: SHOT('graphics') });
      await page.waitForTimeout(400); // let the render loop run a few frames on High
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.game-title', { timeout: 15000 });
      if ((await preset()) !== 'high') throw new Error('preset did not survive reload: ' + (await preset()));
      await page.click('button[data-act="settings"]');
      await page.waitForSelector('#gfx-preset');
      const kept = await page.evaluate(() => [document.querySelector('#gfx-preset').value, document.querySelector('#gfx-cat-shadows').value, document.querySelector('#gfx-fps').checked]);
      if (kept.join() !== 'high,off,true') throw new Error('graphics settings not persisted: ' + kept.join());
      // Ultra builds the heaviest chain (GTAO + MSAA target) without console noise
      await page.selectOption('#gfx-preset', 'ultra');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'ultra' && !!window.__fleet.scene.composer);
      await page.waitForTimeout(400);
      // back to Auto (Low on this software GPU) for a fast playthrough; choosing a preset clears overrides
      await page.selectOption('#gfx-preset', 'auto');
      await page.uncheck('#gfx-fps');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'low' && !window.__fleet.scene.composer
        && document.querySelector('#gfx-cat-shadows').value === 'preset');
      await page.click('[data-act="done"]');
      await page.waitForSelector('.game-title');
    });

    await step('practice setup screen', async () => {
      await page.click('button[data-act="play"]');
      await page.waitForSelector('[data-act="launch"]');
      await page.selectOption('#setup-diff', 'easy'); // Rookie Beacon — quick, predictable opponent
      await page.screenshot({ path: SHOT('setup') });
      await page.click('[data-act="launch"]');
    });

    await step('deployment: auto-deploy + confirm', async () => {
      await page.waitForSelector('[data-tact="auto"]', { timeout: 10000 });
      await page.click('[data-tact="auto"]');
      await page.waitForSelector('[data-tact="confirm"]:not([disabled])');
      await page.screenshot({ path: SHOT('placement') });
      await page.click('[data-tact="confirm"]');
      await page.waitForFunction(() => window.__fleet.app.phase === 'battle', null, { timeout: 15000 });
      // pacing only (same knob as the game's ?demo mode); rules untouched
      await page.evaluate(() => { window.__fleet.app.aiDelay = () => 30; });
    });

    await step('first shot via Hint + Fire button', async () => {
      await waitMyTurnOrEnd();
      await fireViaHint();
      await page.waitForFunction(() => window.__fleet.app.session.state.players[0].shotsUsed === 1);
      await page.waitForTimeout(400); // let the reply animation start
      await page.screenshot({ path: SHOT('battle') });
      await waitMyTurnOrEnd(); // AI answers
    });

    await step('undo reverts the exchange', async () => {
      await page.waitForSelector('[data-tact="undo"]', { timeout: 5000 });
      await page.click('[data-tact="undo"]');
      const used = await page.evaluate(() => window.__fleet.app.session.state.players[0].shotsUsed);
      if (used !== 0) throw new Error(`undo did not restore (shotsUsed=${used})`);
    });

    await step('note mode annotates a cell via keyboard', async () => {
      await waitMyTurnOrEnd();
      await page.keyboard.press('n');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      const notes = await page.evaluate(() => {
        const app = window.__fleet.app;
        const me = app.session.state.players.find((p) => p.id === app._viewer());
        return Object.keys(me.notes[app.hotTarget] || {}).length;
      });
      if (notes < 1) throw new Error('annotate produced no note');
      await page.keyboard.press('n'); // leave note mode
    });

    await step('pause → resume keeps HUD intact', async () => {
      await page.click('[data-hud="pause"]');
      await page.waitForSelector('.overlay [data-act="resume"]');
      await page.screenshot({ path: SHOT('pause') });
      await page.click('.overlay [data-act="resume"]');
      await page.waitForSelector('.overlay', { state: 'detached' });
      if (!(await page.locator('#tray').count())) throw new Error('HUD tray missing after resume');
    });

    await step('pause → help → done → resume keeps HUD intact', async () => {
      await page.click('[data-hud="pause"]');
      await page.waitForSelector('.overlay [data-act="help"]');
      await page.click('.overlay [data-act="help"]');
      await page.waitForSelector('.kbd-table');
      await page.click('[data-act="done"]');
      await page.waitForSelector('.overlay [data-act="resume"]');
      await page.click('.overlay [data-act="resume"]');
      await page.waitForSelector('.overlay', { state: 'detached' });
      if (!(await page.locator('#tray').count())) throw new Error('HUD tray missing after help');
      if (!(await page.locator('#hud-objective').count())) throw new Error('HUD objective missing after help');
    });

    await step('Escape opens and closes the pause menu', async () => {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.overlay [data-act="resume"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.overlay', { state: 'detached' });
      if (await page.evaluate(() => window.__fleet.app.paused)) throw new Error('still paused after Escape');
    });

    await step('play the battle out to a terminal result', async () => {
      let guard = 0;
      for (;;) {
        await waitMyTurnOrEnd();
        if ((await appPhase()).finished) break;
        if (++guard > 250) throw new Error('battle did not terminate within 250 player turns');
        await fireViaHint();
        await page.waitForTimeout(140);
      }
      await page.waitForSelector('.result-headline', { timeout: 10000 });
    });

    await step('results screen with score breakdown', async () => {
      const headline = await page.textContent('.result-headline');
      const rows = await page.locator('.overlay .score-rows tr').count();
      if (rows < 3) throw new Error(`expected breakdown rows, got ${rows}`);
      console.log(`  [${name}] headline: ${headline.trim()}`);
      await page.screenshot({ path: SHOT('results') });
      const save = await page.evaluate(() => JSON.parse(localStorage.getItem('fleet-signals-save') || 'null'));
      if (!save || save.stats.sessions < 1) throw new Error('outcome not persisted to save doc');
      console.log(`  [${name}] saved stats: sessions=${save.stats.sessions} wins=${save.stats.wins} shots=${save.stats.shots}`);
    });

    await step('back to title', async () => {
      await page.click('.overlay [data-act="title"]');
      await page.waitForSelector('.game-title');
      await page.waitForFunction(() => window.__fleet.app.phase === 'menu');
    });
  } finally {
    await context.close();
  }
  if (errors.length) throw new Error(`[${name}] page errors:\n` + errors.join('\n'));
  if (apiLog.length) throw new Error(`[${name}] standalone play made platform calls: ${apiLog.join(', ')}`);
}

/** Signed-in launch: nickname, synced settings, rebinding in Help, invite link, cloud seed. */
async function runSignedInPass() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console ${m.type()}: ${m.text()}`);
  });
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } });
  });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = 'h.' + b64u({ sub: 'cap-1234567', game_scope: 'fleet-test', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
  try {
    await page.goto(`${BASE}/#game_token=${token}`, { waitUntil: 'load' });
    await page.waitForSelector('.game-title', { timeout: 15000 });
    if (new URL(page.url()).hash) throw new Error('launch token left in the URL');
    const music = await page.evaluate(() => window.__fleet.app.doc.settings.music);
    if (music !== 0.3) throw new Error('platform settings not applied: ' + music);
    if (await page.locator('[data-act="signin"]').count()) throw new Error('sign-in shown while signed in');
    await page.click('[data-act="invite"]');
    await page.waitForFunction(() => window.__copied.length === 1);
    const link = await page.evaluate(() => window.__copied[0]);
    if (!/\/game-invite\/cap-1234567\/fleet-test$/.test(link)) throw new Error('bad invite link ' + link);
    await page.screenshot({ path: '/tmp/fleet-signals-e2e-title-signedin.png' });
    await page.click('[data-act="help"]');
    const help = await page.textContent('.kbd-table');
    if (!/Q\s*Rotate ship/.test(help)) throw new Error('help does not show the platform binding: ' + help);
    await page.click('[data-act="done"]');
    await page.click('[data-act="profile"]');
    await page.waitForFunction(() => /Salty Admiral/.test(document.querySelector('.account-row')?.textContent || ''));
    for (let i = 0; i < 50 && !apiLog.includes('PUT /api/v1/me/cloud-saves/game:fleet-test'); i++) await page.waitForTimeout(100); // debounced ~2 s
    if (!apiLog.includes('PUT /api/v1/me/cloud-saves/game:fleet-test')) throw new Error('empty slot not seeded: ' + apiLog.join(', '));
    console.log('ok - [signed-in] nickname, synced settings, effective bindings, invite link, cloud seed');
  } finally {
    await context.close();
  }
  if (errors.length) throw new Error('[signed-in] page errors:\n' + errors.join('\n'));
}

/**
 * Hosted table (local pass-and-play) roster handling: seats must keep unique
 * ids after a removal, or createMatch rejects the roster and the screen dies.
 */
async function runHostedPass() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console ${m.type()}: ${m.text()}`);
  });
  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.game-title', { timeout: 15000 });
    await page.click('button[data-act="hosted"]');
    await page.waitForSelector('[data-act="start"]');
    await page.click('[data-act="add"]');                 // 3 seats
    await page.click('[data-seat-drop="0"]');             // drop the first
    await page.click('[data-act="add"]');                 // re-add: ids must not collide
    const ids = await page.evaluate(() => window.__fleet.app.lobbySeats.map((s) => s.id));
    if (new Set(ids).size !== ids.length) throw new Error(`duplicate seat ids: ${ids}`);
    for (const i of [0, 1, 2]) await page.click(`[data-seat-ready="${i}"]`);
    await page.click('[data-act="start"]');
    await page.waitForSelector('[data-tact="auto"]', { timeout: 10000 });
    const n = await page.evaluate(() => window.__fleet.app.session.state.players.length);
    if (n !== 3) throw new Error(`expected a 3-seat hosted match, got ${n}`);
    console.log('ok - [hosted] roster edit → 3-seat match starts');
  } finally {
    await context.close();
  }
  if (errors.length) throw new Error('[hosted] page errors:\n' + errors.join('\n'));
}

/**
 * Language: with the StarHermit preferred language fr-CA, Automatic resolves
 * to fr-CA; choosing Italian in Settings re-renders in place and saves
 * ui.language; Report a problem posts a bug report; German fits the viewport;
 * a match keeps its state when the language changes from the pause menu.
 */
async function runLanguagePass({ name, viewport, hasTouch }) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console ${m.type()}: ${m.text()}`);
  });
  const SHOT = (s) => `${process.env.SHOT_DIR || '/tmp'}/fleet-signals-e2e-${s}-${name}.png`;
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = 'h.' + b64u({ sub: 'cap-1234567', game_scope: 'fleet-test', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
  const fits = () => page.evaluate(() => {
    if (document.documentElement.scrollWidth > window.innerWidth + 1) return 'page scrolls sideways';
    const bad = [...document.querySelectorAll('#ui button, #ui h2, #ui h3, #ui label, #ui legend, #ui p, #ui td')].find((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest('.game-options-controls')) return false;
      const rail = el.closest('.rail');
      if (rail && !rail.classList.contains('open') && getComputedStyle(rail).transform !== 'none') return false; // closed mobile drawer
      const scroller = el.closest('.panel, .screen, .overlay, .tray');
      const box = scroller ? scroller.getBoundingClientRect() : { left: 0, right: window.innerWidth };
      return r.right > Math.min(window.innerWidth, box.right) + 1 || r.left < Math.max(0, box.left) - 1;
    });
    return bad ? 'cut off: ' + bad.textContent.trim().slice(0, 80) : '';
  });
  mock.language = 'fr-CA'; mock.settings = {}; mock.reports = [];
  try {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#game_token=${token}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.lang === 'fr-CA', null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-act="play"]')?.textContent === 'Jouer');
    await page.click('[data-act="settings"]');
    const choice = page.locator('[data-game-language="choice"]');
    await choice.scrollIntoViewIfNeeded();
    const auto = await choice.locator('option').first().textContent();
    if (!/^Automatique — Français \(Canada\)$/.test(auto)) throw new Error('Automatic label not resolved: ' + auto);
    const select = await choice.elementHandle();
    await choice.selectOption('it-IT');
    await page.waitForFunction(() => document.documentElement.lang === 'it-IT');
    await page.waitForFunction(() => /Salvato/.test(document.querySelector('[data-game-language="status"]').textContent));
    if (mock.settings['ui.language']?.choice !== 'it-IT') throw new Error('ui.language not saved: ' + JSON.stringify(mock.settings));
    const legends = await page.evaluate(() => [...document.querySelectorAll('#ui legend, #ui h2')].map((n) => n.textContent).join('|'));
    if (!/Impostazioni/.test(legends) || !/Schermo/.test(legends) || !/Grafica/.test(legends)) throw new Error('settings not re-rendered: ' + legends);
    if (!await select.evaluate((n) => n.isConnected)) throw new Error('shared Language select was redrawn');
    await page.locator('[data-game-report="title"]').scrollIntoViewIfNeeded();
    await page.fill('[data-game-report="title"]', 'Test report');
    await page.click('[data-game-report="send"]');
    await page.waitForFunction(() => /Grazie/.test(document.querySelector('[data-game-report="status"]').textContent));
    if (mock.reports[0]?.kind !== 'bug') throw new Error('report not posted: ' + JSON.stringify(mock.reports));
    await page.screenshot({ path: SHOT('language') });
    await choice.selectOption('de-DE');
    await page.waitForFunction(() => document.documentElement.lang === 'de-DE');
    let fit = await fits();
    if (fit) throw new Error('German settings: ' + fit);
    await page.screenshot({ path: SHOT('language-de-settings'), fullPage: true });
    await page.click('[data-act="done"]');
    await page.waitForFunction(() => document.querySelector('[data-act="play"]')?.textContent === 'Spielen');
    fit = await fits();
    if (fit) throw new Error('German title: ' + fit);
    await page.screenshot({ path: SHOT('language-de-title') });
    // A match keeps its state across a language change made from the pause menu.
    await page.evaluate(() => { window.__fleet.app.aiDelay = () => 30; });
    await page.click('[data-act="play"]');
    await page.click('[data-act="launch"]');
    await page.click('[data-tact="auto"]');
    if (!/Aufstellung bestätigen/.test(await page.textContent('[data-tact="confirm"]'))) throw new Error('tray not in German');
    await page.click('[data-tact="confirm"]');
    await page.waitForFunction(() => window.__fleet.app.session?.state.phase === 'battle' && window.__fleet.app.phase === 'battle', null, { timeout: 20000 });
    fit = await fits();
    if (fit) throw new Error('German HUD: ' + fit);
    await page.screenshot({ path: SHOT('language-de-hud') });
    if (hasTouch) { // the fleet drawer, opened, must fit too
      await page.click('[data-hud="left"]');
      await page.waitForTimeout(400);
      fit = await fits();
      if (fit) throw new Error('German fleet drawer: ' + fit);
      await page.screenshot({ path: SHOT('language-de-drawer') });
      await page.click('[data-hud="left"]');
    }
    await page.evaluate(() => { window.__sameMatch = window.__fleet.app.session; });
    await page.click('[data-hud="pause"]');
    await page.click('[data-act="settings"]');
    await choice.scrollIntoViewIfNeeded();
    await choice.selectOption('fr-FR');
    await page.waitForFunction(() => document.documentElement.lang === 'fr-FR');
    await page.click('[data-act="done"]');
    await page.waitForFunction(() => document.querySelector('[data-act="resume"]')?.textContent === 'Reprendre');
    await page.click('[data-act="resume"]');
    await page.waitForFunction(() => /Flotte ennemie/.test(document.querySelector('#hud-objective')?.textContent || ''));
    if (!/Tirer/.test(await page.textContent('[data-tact="fire"]'))) throw new Error('tray not re-rendered');
    if (await page.getAttribute('[data-hud="pause"]', 'aria-label') !== 'Pause') throw new Error('static label');
    const same = await page.evaluate(() => window.__sameMatch === window.__fleet.app.session && window.__fleet.app.session.state.phase !== 'placement');
    if (!same) throw new Error('the match restarted on a language change');
    await page.click('[data-hud="pause"]');
    await page.click('[data-act="settings"]');
    await choice.scrollIntoViewIfNeeded();
    await choice.selectOption('auto');
    await page.waitForFunction(() => document.documentElement.lang === 'fr-CA');
    if (mock.settings['ui.language']?.choice !== 'auto') throw new Error('auto not saved');
    console.log(`ok - [${name}] Language: Automatic follows the StarHermit preferred language; live switch mid-match; ui.language; report a problem`);
  } finally {
    mock.language = 'en';
    await context.close();
  }
  if (errors.length) throw new Error(`[${name} language] page errors:\n` + errors.join('\n'));
}

try {
  await runPass({ name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false });
  await runPass({ name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true });
  await runHostedPass();
  await runSignedInPass();
  await runLanguagePass({ name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false });
  await runLanguagePass({ name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true });
  console.log('\nE2E PASS — full Fleet Signals playthrough clean on desktop + mobile + hosted roster, no page errors');
} finally {
  await browser.close();
  server.close();
}
