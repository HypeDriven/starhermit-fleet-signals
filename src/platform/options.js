// Fleet Signals — the save's and options' pure parts, shared by the engine
// client (native/platform.ts) and the node tests: the browser build's cloud
// save read back as its save document, and the game options kept in the
// account's settings with the browser build's settings keys they are
// migrated from.
import { SAVE_VERSION, checksumDoc, combineSaves, mergeSaves } from './save.js';
import { THEMES } from '../content/stages.js';

/** A v2 save document whose checksum holds. */
export function validDoc(doc) {
  return !!doc && typeof doc === 'object' && doc.version === SAVE_VERSION
    && typeof doc.checksum === 'string' && doc.checksum === checksumDoc(doc);
}

/**
 * Two copies of the save merged as the browser build merged its cloud slot
 * with the device's (main.js boot / saveconflict): a strict descendant wins,
 * else combineSaves field by field (`local` keeps its profile and settings).
 * An invalid copy loses to a valid one.
 */
export function mergeDocs(local, remote) {
  if (!validDoc(remote)) return local;
  if (!validDoc(local)) return remote;
  const m = mergeSaves(local, remote);
  return m.conflict ? combineSaves(local, remote) : m.resolved;
}

/**
 * The browser build's cloud save (the JS SDK's saveJSON text of the save
 * document), or null. A v1 document is migrated as save.js loadSave does.
 */
export function readForeign(text) {
  if (!text) return null;
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (doc && typeof doc === 'object' && doc.version === 1 && doc.checksum === checksumDoc(doc)) {
    if (!doc.boards) doc.boards = { entries: [] };
    if (!doc.tutorial) doc.tutorial = { done: false, step: 0 };
    doc.version = SAVE_VERSION;
    doc.checksum = checksumDoc(doc);
  }
  return validDoc(doc) ? doc : null;
}

export const PALETTE_IDS = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];
/** The game's options (save.js settings less what the runtime's Options now own). */
export const OPTION_DEFAULTS = { theme: 'abyss-chart', palette: 'default', leftHanded: false, haptics: true, captions: false };

/** A stored option value, or undefined when it is not one. */
export function checkOption(key, v) {
  if (key === 'theme') return typeof v === 'string' && THEMES.some((t) => t.id === v) ? v : undefined;
  if (key === 'palette') return typeof v === 'string' && PALETTE_IDS.includes(v) ? v : undefined;
  if (key in OPTION_DEFAULTS) return typeof v === 'boolean' ? v : undefined;
  return undefined;
}

// The browser build's account settings: SYNCED_SETTINGS patched key by key
// (src/platform/starhermit.js), the language helper's ui.language and the
// options panel's audio.options / graphics.gpu.<profile> slots.
export const BROWSER_KEYS = [
  'music', 'effects', 'ambience', 'voice', 'muted', 'graphics', 'reducedMotion', 'highContrast',
  'palette', 'largerText', 'leftHanded', 'haptics', 'holdToConfirm', 'captions', 'cameraView', 'theme',
  'ui.language', 'audio.options',
];
/** Whether a legacy settings key is the browser build's (removed once migrated). */
export function isBrowserKey(k) { return BROWSER_KEYS.includes(k) || String(k).startsWith('graphics.gpu.'); }
