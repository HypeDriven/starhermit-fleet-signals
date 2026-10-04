/**
 * Bootstrap: capability detection, asset/lifecycle wiring, platform adapter
 * (StarHermit SDK: launch token + renewal, account nickname, cloud-save
 * mirror with sync status, settings KV, key bindings), save loading, and the
 * top-level app controller.
 */
import { FleetScene } from './render/scene.js';
import { fromLegacyTier } from './render/gfx.js';
import { createAudio } from './audio/audio.js';
import { loadSave, storeSave, defaultSave, checksumDoc, mergeSaves, SAVE_VERSION } from './platform/save.js';
import { createPlatform, applyRemoteSettings } from './platform/starhermit.js';
import { App } from './ui/app.js';

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
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

  // Launch token: the SDK reads #game_token / #access_token once and strips
  // it. Absent → the game is identical to local/offline play (no requests).
  const sh = window.StarHermit || null;
  sh?.init();
  const platform = createPlatform(sh);
  const cloud = platform.cloud;

  let { doc, migrated, corrupted } = loadSave();

  // Cloud save: remote slot is a mirror; on conflict the remote doc wins.
  // localStorage stays the offline cache regardless of outcome.
  if (platform.hosted) {
    try {
      const [remote, remoteSettings] = await Promise.all([cloud.load(), platform.getSettings(), platform.loadKeys()]);
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
      } else if (!remote) {
        cloud.push(doc); // empty slot: seed it from the local doc
      } else {
        platform.syncStatus = 'synced'; // identical or unreadable
      }
      // Platform preferences win over local defaults when signed in.
      if (applyRemoteSettings(doc.settings, remoteSettings)) storeSave(doc);
      platform.markSettingsBaseline(doc.settings);
    } catch { /* network down: local cache is authoritative */ }
  }

  const saveHooks = {
    persist(d) { storeSave(d); cloud.push(d); platform.syncSettings(d.settings); },
    reset() {
      const fresh = defaultSave();
      Object.keys(doc).forEach((k) => delete doc[k]);
      Object.assign(doc, fresh);
      storeSave(doc);
      cloud.push(doc);
      platform.syncSettings(doc.settings);
    },
  };

  if (platform.hosted) {
    platform.nickname().then((name) => {
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
  // Graphics settings: carry the pre-panel quality tier over as a preset once.
  if (!doc.settings.graphics || typeof doc.settings.graphics !== 'object') {
    doc.settings.graphics = { preset: fromLegacyTier(doc.settings.qualityTier) };
  }
  delete doc.settings.qualityTier;
  const scene = new FleetScene(canvas, {
    theme: null, // applied via App.applySettings
    graphics: doc.settings.graphics,
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
      cloud.flush();
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

  window.addEventListener('pagehide', () => cloud.flush());

  window.addEventListener('resize', () => scene.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => scene.resize(), 120));

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
