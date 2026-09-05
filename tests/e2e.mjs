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
 * a static file server, so it is not used.) /api/* calls get a 204 so the
 * offline-tolerant platform adapter stays quiet.
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
  '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'text/typescript',
};
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const server = http.createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.startsWith('/api/')) { res.writeHead(204); return res.end(); } // offline host shim
    const file = normalize(join(ROOT, path === '/' ? '/index.html' : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
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
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
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
}

try {
  await runPass({ name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false });
  await runPass({ name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true });
  console.log('\nE2E PASS — full Fleet Signals playthrough clean on desktop + mobile, no page errors');
} finally {
  await browser.close();
  server.close();
}
