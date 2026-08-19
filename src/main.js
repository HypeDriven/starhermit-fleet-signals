/**
 * Bootstrap: capability detection, asset/lifecycle wiring, platform adapter
 * (server time, telemetry consent-gated funnel events, presence heartbeat),
 * save loading, and the top-level app controller.
 */
import { FleetScene } from './render/scene.js';
import { createAudio } from './audio/audio.js';
import { loadSave, storeSave, defaultSave } from './platform/save.js';
import { App } from './ui/app.js';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/* ---------------- platform adapter (offline-tolerant) ---------------- */

function createPlatform() {
  let offsetMs = 0;
  let serverSynced = false;

  // Synchronize daily boundaries with host time when hosted; round-trip adjusted.
  (async () => {
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', { cache: 'no-store' });
      if (!res.ok) return;
      const t1 = Date.now();
      const body = await res.json();
      const serverMs = typeof body.time === 'number' ? body.time : Date.parse(body.time);
      if (Number.isFinite(serverMs)) {
        offsetMs = serverMs - Math.round((t0 + t1) / 2);
        serverSynced = true;
      }
    } catch { /* offline/local play: local UTC clock is authoritative */ }
  })();

  return {
    get serverSynced() { return serverSynced; },
    now() { return Date.now() + offsetMs; },
    utcToday() { return new Date(this.now()).toISOString().slice(0, 10); },
    /** Anonymous funnel events only; never message content or pointer trails. */
    track(name, props) {
      const allowed = ['round-start', 'round-end', 'tutorial-step', 'settings-change', 'error', 'first-action', 'input-modality', 'retry'];
      if (!allowed.includes(name)) return;
      const payload = { event: name, at: new Date().toISOString(), ...(props || {}) };
      if (navigator.sendBeacon) {
        try { navigator.sendBeacon('/api/v1/telemetry', JSON.stringify(payload)); } catch { /* offline */ }
      }
    },
    presence(active) {
      if (!active) return;
      fetch('/api/v1/presence', { method: 'POST', body: '{}' }).catch(() => {});
    },
  };
}

/* ---------------- boot ---------------- */

function boot() {
  const canvas = document.getElementById('scene');
  const ui = document.getElementById('ui');

  if (!webglAvailable()) {
    ui.innerHTML = `
      <div class="screen dim">
        <div class="panel">
          <h1>Fleet Signals</h1>
          <p><strong>This device or browser does not support WebGL</strong>, which the holographic chart table requires.</p>
          <p>Your profile and any saved progress on this device are preserved. Try a current version of Firefox, Chrome, Edge or Safari with hardware acceleration enabled.</p>
        </div>
      </div>`;
    return;
  }

  const { doc, migrated, corrupted } = loadSave();
  const saveHooks = {
    persist(d) { storeSave(d); },
    reset() {
      const fresh = defaultSave();
      Object.keys(doc).forEach((k) => delete doc[k]);
      Object.assign(doc, fresh);
      storeSave(doc);
    },
  };

  const audio = createAudio();
  const scene = new FleetScene(canvas, {
    theme: null, // applied via App.applySettings
    qualityTier: doc.settings.qualityTier,
    reducedMotion: doc.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches,
    visualSeed: 'fleet-signals-v1',
  });
  const platform = createPlatform();
  const app = new App({ scene, audio, saveDoc: doc, platform, saveHooks });

  if (matchMedia('(prefers-reduced-motion: reduce)').matches && !doc.settings.reducedMotion) {
    doc.settings.reducedMotion = true;
    app.applySettings();
  }
  if (migrated || corrupted) saveHooks.persist(doc);

  scene.start();
  scene.resize();
  app.showTitle();

  // resume audio on first gesture (autoplay policy)
  const unlock = () => { audio.resume(); audio.startAmbience?.(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // backgrounding pauses solo simulation and rendering
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      scene.pause();
      audio.suspend();
      if (app.session && !app.hotseat && app.phase !== 'results') app.paused = true;
    } else {
      scene.start();
      audio.resume();
      if (app.session && app.paused && !app.ui.querySelector('.overlay')) {
        app.paused = false;
        app._renderTray();
        if (app.session.needsAI()) app._pumpAI();
      }
    }
  });

  // throttled presence heartbeat while actively playing
  setInterval(() => {
    if (app.session && !document.hidden && app.phase === 'battle') platform.presence(true);
  }, 30000);

  window.addEventListener('resize', () => scene.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => scene.resize(), 120));

  window.addEventListener('error', (ev) => {
    platform.track('error', { category: ev.message ? 'runtime' : 'resource' });
  });

  // debug/testing handle (no rules shortcuts exposed)
  window.__fleet = { app, scene, platform, version: 1 };

  // Fixed-view capture mode for visual validation: ?demo[=practice] boots
  // straight into a mid-battle scene on a deterministic seed.
  if (new URLSearchParams(location.search).has('demo')) {
    doc.settings.reducedMotion = true;
    app.applySettings();
    app.aiDelay = () => 25; // capture mode: no theatrical pauses
    (async () => {
      const E = await import('./rules/engine.js');
      app.startMatch('practice', null, { difficulty: 'medium' });
      app._autoPlace();
      app._confirmPlacement();
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 260 && app.session?.state.phase !== 'finished'; i++) {
        await sleep(60);
        if (app.session.state.phase !== 'battle' || app.inputLocked || app.session.needsAI()) continue;
        if (app.session.state.players[app.session.state.currentPlayerIndex].id !== 'you') continue;
        const fire = E.listLegalActions(app.session.state, 'you').find((a) => a.type === 'fire');
        if (!fire) break;
        app.selectedCell = fire.cells[(i * 7) % fire.cells.length];
        app._fire(app.selectedCell);
      }
      if (app.session?.state.phase === 'finished') app.scene.skip();
    })();
  }
}

boot();
