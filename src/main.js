/**
 * Bootstrap: capability detection, asset/lifecycle wiring, platform adapter
 * (server time, launch-token auth + refresh, account nickname, cloud-save
 * mirror with sync status; telemetry/presence are local-dev-only), save
 * loading, and the top-level app controller.
 */
import { FleetScene } from './render/scene.js';
import { createAudio } from './audio/audio.js';
import { loadSave, storeSave, defaultSave, checksumDoc, mergeSaves, SAVE_VERSION } from './platform/save.js';
import {
  readLaunchToken, createApi, resolveNickname, scheduleTokenRefresh, createCloudSave,
} from './platform/starhermit.js';
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

function createPlatform(auth, api) {
  let offsetMs = 0;
  let serverSynced = false;
  // Hosted mode activates iff a launch token was read from the URL.
  const hosted = !!(auth && auth.token && auth.slug);

  // Synchronize daily boundaries with host time when hosted; round-trip adjusted.
  (async () => {
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', {
        cache: 'no-store',
        headers: hosted ? { Authorization: `Bearer ${auth.token}` } : {},
      });
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

  if (hosted) {
    // Refresh the 60-minute token on a 45-minute schedule (60 s retry).
    scheduleTokenRefresh(auth, api);
  }

  return {
    hosted,
    /** Account nickname (profile lookup); null until resolved or offline. */
    accountName: null,
    /** Cloud-save mirror state: loading|saving|synced|offline|error. */
    syncStatus: hosted ? 'loading' : 'offline',
    /** App hook: re-render the profile screen when identity/sync changes. */
    onChange: null,
    get serverSynced() { return serverSynced; },
    now() { return Date.now() + offsetMs; },
    utcToday() { return new Date(this.now()).toISOString().slice(0, 10); },
    /**
     * Anonymous funnel events only; never message content or pointer trails.
     * The platform has no per-game telemetry route — local dev server only.
     */
    track(name, props) {
      if (hosted) return;
      const allowed = ['round-start', 'round-end', 'tutorial-step', 'settings-change', 'error', 'first-action', 'input-modality', 'retry'];
      if (!allowed.includes(name)) return;
      const payload = { event: name, at: new Date().toISOString(), ...(props || {}) };
      if (navigator.sendBeacon) {
        try { navigator.sendBeacon('/api/v1/telemetry', JSON.stringify(payload)); } catch { /* offline */ }
      }
    },
    presence(active) {
      // Local dev server shim only; no presence endpoint exists on-platform.
      if (hosted || !active) return;
      fetch('/api/v1/presence', { method: 'POST', body: '{}' }).catch(() => {});
    },
  };
}

/* ---------------- boot ---------------- */

async function boot() {
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

  // Launch token: fragment #game_token read once and stripped. Absent → the
  // game is identical to local/offline play; localStorage is the save.
  const auth = readLaunchToken();
  const api = createApi(auth || { token: null });

  let { doc, migrated, corrupted } = loadSave();
  const platform = createPlatform(auth, api);

  // Cloud save: remote slot is a mirror; on conflict the remote doc wins.
  // localStorage stays the offline cache regardless of outcome.
  let cloud = null;
  if (platform.hosted) {
    cloud = createCloudSave({
      api, auth, slug: auth.slug,
      onStatus: (s) => { platform.syncStatus = s; platform.onChange?.(); },
    });
    try {
      const remote = await cloud.load();
      const valid = remote && remote.version === SAVE_VERSION && remote.checksum === checksumDoc(remote);
      if (valid) {
        const m = mergeSaves(doc, remote);
        const winner = m.conflict ? remote : m.resolved;
        if (checksumDoc(winner) !== checksumDoc(doc)) {
          Object.keys(doc).forEach((k) => delete doc[k]);
          Object.assign(doc, winner);
          storeSave(doc);
          cloud.push(doc); // bring the mirror up to the merged doc
        } else {
          platform.syncStatus = 'synced';
        }
      } else {
        platform.syncStatus = 'synced'; // no slot yet, identical, or unreadable
      }
    } catch { /* network down: local cache is authoritative */ }
  }

  const saveHooks = {
    persist(d) { storeSave(d); cloud?.push(d); },
    reset() {
      const fresh = defaultSave();
      Object.keys(doc).forEach((k) => delete doc[k]);
      Object.assign(doc, fresh);
      storeSave(doc);
      cloud?.push(doc);
    },
  };

  if (platform.hosted) {
    resolveNickname(api, auth.sub).then((name) => {
      platform.accountName = name;
      // Fresh guest docs take the account nickname as their local display name.
      if (name && doc.profile.guest && doc.profile.name === 'Guest Captain') {
        doc.profile.name = name.slice(0, 18);
        saveHooks.persist(doc);
      }
      platform.onChange?.();
    });
  }

  const audio = createAudio();
  const scene = new FleetScene(canvas, {
    theme: null, // applied via App.applySettings
    qualityTier: doc.settings.qualityTier,
    reducedMotion: doc.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches,
    visualSeed: 'fleet-signals-v1',
  });
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
      cloud?.flush();
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

  window.addEventListener('pagehide', () => cloud?.flush());

  // throttled presence heartbeat while actively playing (local dev only)
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
