/**
 * Fleet Signals — StarHermit hosted-platform adapter over window.StarHermit
 * (starhermit-sdk.js, loaded by index.html before the game modules).
 *
 * The SDK reads the launch token (#game_token=… library launch or
 * #access_token=… sign-in return), strips it from the URL, renews it, and owns
 * the cloud-save slot game:<slug>, the per-player settings KV and the controls
 * endpoint. Hosted mode activates iff it holds a token; without one every call
 * here is a no-op and no request is made — local play on the local save
 * document is unchanged.
 */

/** Keyboard actions (KeyboardEvent.code lists) — mirrored as control.* in starhermit.txt. */
export const DEFAULT_KEYS = {
  cursorLeft: ['ArrowLeft'], cursorRight: ['ArrowRight'], cursorUp: ['ArrowUp'], cursorDown: ['ArrowDown'],
  confirm: ['Enter', 'Space', 'NumpadEnter'], rotate: ['KeyR'], autoDeploy: ['KeyA'], notes: ['KeyN'],
  hint: ['KeyH'], undo: ['KeyU'], camera: ['KeyC'], pause: ['Escape'],
};

/** Preferences mirrored to the platform settings KV (same key names as save.settings). */
export const SYNCED_SETTINGS = [
  'music', 'effects', 'ambience', 'voice', 'muted', 'graphics', 'reducedMotion', 'highContrast',
  'palette', 'largerText', 'leftHanded', 'haptics', 'holdToConfirm', 'captions', 'cameraView', 'theme',
];

/** Pick the synced subset of a settings object. */
export function settingsSubset(settings) {
  const out = {};
  for (const k of SYNCED_SETTINGS) if (settings[k] !== undefined) out[k] = settings[k];
  return out;
}

/** Apply platform values over local settings (type-checked against the local value). */
export function applyRemoteSettings(settings, remote) {
  if (!remote || typeof remote !== 'object') return false;
  let changed = false;
  for (const k of SYNCED_SETTINGS) {
    const v = remote[k];
    if (v === undefined || v === null) continue;
    const local = settings[k];
    const ok = k === 'graphics' ? (typeof v === 'object' && !Array.isArray(v)) : (local === undefined || typeof v === typeof local);
    if (ok && JSON.stringify(v) !== JSON.stringify(local)) { settings[k] = v; changed = true; }
  }
  return changed;
}

/**
 * Platform facade used by main.js and the App. `sh` is the SDK instance
 * (window.StarHermit in the browser; a test instance in node).
 */
export function createPlatform(sh) {
  const hosted = () => !!(sh && sh.signedIn);
  let lastSettings = null;
  const platform = {
    get hosted() { return hosted(); },
    /** Account nickname (profile lookup); null until resolved or offline. */
    accountName: null,
    /** Cloud-save mirror state: loading|saving|synced|offline|error. */
    syncStatus: hosted() ? 'loading' : 'offline',
    /** App hooks: identity/sync changed; platform signed the player out. */
    onChange: null,
    onSignedOut: null,
    /** Effective keyboard bindings ({ action: [codes] }). */
    keys: { ...DEFAULT_KEYS },
    serverSynced: false,
    now() { return Date.now(); },
    utcToday() { return new Date(this.now()).toISOString().slice(0, 10); },
    canSignIn() { return !!sh?.canSignIn(); },
    signIn() { return !!sh?.signIn(); },
    inviteLink() { return hosted() ? sh.inviteLink() : null; },
    /** Nickname for a user id ("Player <id>" fallback); never /api/v1/me. */
    async nickname(userId = sh?.userId) {
      if (!hosted() || !userId) return null;
      const p = await sh.profile(userId).catch(() => null);
      return p?.displayName || 'Player ' + String(userId).slice(0, 6);
    },
    /** Remote settings ({} offline). */
    async getSettings() { return hosted() ? sh.getSettings().catch(() => ({})) : {}; },
    /** Patch the synced preferences when they changed since the last call. */
    syncSettings(settings) {
      if (!hosted()) return;
      const subset = settingsSubset(settings);
      const json = JSON.stringify(subset);
      if (lastSettings === null) { lastSettings = json; return; } // baseline after boot
      if (json === lastSettings) return;
      lastSettings = json;
      sh.patchSettings(subset);
    },
    markSettingsBaseline(settings) { lastSettings = JSON.stringify(settingsSubset(settings)); },
    async loadKeys() {
      if (!hosted()) return this.keys;
      this.keys = { ...DEFAULT_KEYS, ...(await sh.loadBindings(DEFAULT_KEYS).catch(() => DEFAULT_KEYS)) };
      return this.keys;
    },
    /** Cloud-save mirror of the local save doc (slot game:<slug>). */
    cloud: {
      push(doc) {
        if (!hosted()) return;
        setStatus('saving');
        sh.saveJSON(doc);
      },
      flush() { return hosted() ? sh.flushSave(true) : Promise.resolve(false); },
      async load() {
        if (!hosted()) return null;
        setStatus('loading');
        const info = await sh.saveInfo();
        if (info && info.exists === false) return null;
        return sh.loadJSON();
      },
    },
  };
  function setStatus(s) { platform.syncStatus = s; platform.onChange?.(); }
  if (sh) {
    sh.on('saved', (ok) => setStatus(ok ? 'synced' : 'error'));
    sh.on('auth', (a) => {
      if (a.signedIn) return;
      platform.accountName = null;
      platform.syncStatus = 'offline';
      platform.onSignedOut?.();
      platform.onChange?.();
    });
  }
  return platform;
}
