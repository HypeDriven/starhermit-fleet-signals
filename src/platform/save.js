/**
 * Fleet Signals — versioned, checksummed local persistence.
 *
 * Uses localStorage in the browser; any object with getItem/setItem
 * may be injected for tests or non-browser hosts. Never store
 * credentials or private chat here.
 */

export const SAVE_VERSION = 2;
export const SAVE_KEY = 'fleet-signals-save';
export const DEFAULT_THEME = 'abyss-chart';
export const BOARD_ENTRY_CAP = 100;

/** Deep-fresh default document; every call returns new objects. */
export function defaultSave() {
  return {
    version: SAVE_VERSION,
    checksum: '',
    profile: { name: 'Guest Captain', guest: true, avatar: 'signal-flag' },
    settings: {
      music: 0.7, effects: 0.9, ambience: 0.6, voice: 0.8,
      muted: false, graphics: { preset: 'auto' }, reducedMotion: false,
      highContrast: false, palette: 'default', largerText: false,
      leftHanded: false, haptics: true, holdToConfirm: false,
      captions: false, cameraView: 'auto', theme: DEFAULT_THEME,
    },
    journey: { completed: {} },     // stageId -> {stars, score, bestShots}
    challenges: { completed: {} },
    dailies: {},                    // 'YYYY-MM-DD' -> {score, won, stars}
    achievements: {},               // key -> ISO timestamp
    stats: {
      sessions: 0, wins: 0, losses: 0, shots: 0, hits: 0, sunk: 0,
      bestAccuracy: 0, dailyStreak: 0, lastDailyDate: null,
    },
    boards: { entries: [] },        // local leaderboard, score desc, cap 100
    tutorial: { done: false, step: 0 },
  };
}

/** FNV-1a 32-bit hash of a string, as 8-char hex. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Hex checksum of the doc with its checksum field blanked. */
export function checksumDoc(doc) {
  return fnv1a(JSON.stringify({ ...doc, checksum: '' }));
}

function defaultStorage() {
  return globalThis.localStorage;
}

/**
 * Load and validate the save document.
 * @returns {{doc: object, migrated: boolean, corrupted: boolean}}
 */
export function loadSave(storage = defaultStorage()) {
  const fresh = () => ({ doc: defaultSave(), migrated: false, corrupted: false });
  let raw = null;
  try {
    raw = storage.getItem(SAVE_KEY);
  } catch {
    return fresh();
  }
  if (raw === null || raw === undefined) return fresh();

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { doc: defaultSave(), migrated: false, corrupted: true };
  }
  if (!doc || typeof doc !== 'object' || typeof doc.checksum !== 'string'
      || doc.checksum !== checksumDoc(doc)) {
    return { doc: defaultSave(), migrated: false, corrupted: true };
  }

  if (doc.version === 1) {
    // v1 -> v2: local leaderboard and tutorial tracking added.
    if (!doc.boards) doc.boards = { entries: [] };
    if (!doc.tutorial) doc.tutorial = { done: false, step: 0 };
    doc.version = 2;
    doc.checksum = checksumDoc(doc);
    return { doc, migrated: true, corrupted: false };
  }
  if (doc.version !== SAVE_VERSION) {
    return { doc: defaultSave(), migrated: false, corrupted: true };
  }
  return { doc, migrated: false, corrupted: false };
}

/** Persist the doc with a fresh checksum. Returns false on quota errors. */
export function storeSave(doc, storage = defaultStorage()) {
  try {
    doc.checksum = checksumDoc(doc);
    storage.setItem(SAVE_KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

function progressCounts(doc) {
  return [
    Object.keys((doc.journey && doc.journey.completed) || {}).length,
    Object.keys(doc.achievements || {}).length,
    (doc.stats && doc.stats.sessions) || 0,
    Object.keys(doc.dailies || {}).length,
  ];
}

/**
 * Cloud-save conflict helper. A doc is a strict descendant of another
 * when every progress counter is >= and at least one is >.
 */
export function mergeSaves(local, remote) {
  if (checksumDoc(local) === checksumDoc(remote)) {
    return { resolved: local, conflict: false };
  }
  const a = progressCounts(local);
  const b = progressCounts(remote);
  const ge = (x, y) => x.every((v, i) => v >= y[i]);
  const gt = (x, y) => x.some((v, i) => v > y[i]);
  if (ge(a, b) && gt(a, b)) return { resolved: local, conflict: false };
  if (ge(b, a) && gt(b, a)) return { resolved: remote, conflict: false };
  return { conflict: true, local, remote };
}

/**
 * Merge two diverged save docs field by field so neither device loses
 * progress: union of cleared stages, challenges, dailies and achievements
 * (best stars/score, fewest shots, earliest unlock), the larger of each
 * career counter, the union of local leaderboard entries, and tutorial
 * progress. Profile and settings come from `local` (this device). Returns a
 * new doc with a fresh checksum.
 */
export function combineSaves(local, remote) {
  const a = local || defaultSave();
  const b = remote || defaultSave();
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const out = JSON.parse(JSON.stringify(a));
  const union = (x, y, merge) => {
    const res = {};
    for (const k of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
      res[k] = x?.[k] && y?.[k] ? merge(x[k], y[k]) : JSON.parse(JSON.stringify(x?.[k] ?? y?.[k]));
    }
    return res;
  };
  out.journey = { completed: union(a.journey?.completed, b.journey?.completed, (x, y) => ({
    stars: Math.max(num(x.stars), num(y.stars)),
    score: Math.max(num(x.score), num(y.score)),
    bestShots: Math.min(x.bestShots ?? Infinity, y.bestShots ?? Infinity),
  })) };
  out.challenges = { completed: union(a.challenges?.completed, b.challenges?.completed, (x, y) => ({ score: Math.max(num(x.score), num(y.score)) })) };
  out.dailies = union(a.dailies, b.dailies, (x, y) => ({ score: Math.max(num(x.score), num(y.score)), won: !!(x.won || y.won), stars: Math.max(num(x.stars), num(y.stars)) }));
  out.achievements = union(a.achievements, b.achievements, (x, y) => (String(x) < String(y) ? x : y));
  const sa = a.stats || {}, sb = b.stats || {};
  out.stats = { ...sa };
  for (const k of ['sessions', 'wins', 'losses', 'shots', 'hits', 'sunk', 'bestAccuracy', 'dailyStreak']) out.stats[k] = Math.max(num(sa[k]), num(sb[k]));
  out.stats.lastDailyDate = [sa.lastDailyDate, sb.lastDailyDate].filter(Boolean).sort().pop() || null;
  const seen = new Set();
  out.boards = { entries: [...(a.boards?.entries || []), ...(b.boards?.entries || [])].filter((e) => {
    const id = JSON.stringify([e?.board, e?.seed, e?.date, e?.score]);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((x, y) => (y?.score || 0) - (x?.score || 0)).slice(0, BOARD_ENTRY_CAP) };
  out.tutorial = { done: !!(a.tutorial?.done || b.tutorial?.done), step: Math.max(num(a.tutorial?.step), num(b.tutorial?.step)) };
  out.version = SAVE_VERSION;
  out.checksum = checksumDoc(out);
  return out;
}

/** Append a leaderboard entry, keep score-desc order, cap at 100. */
export function recordBoardEntry(doc, entry) {
  // A checksum-valid but hand-edited doc may be missing the board; the
  // checksum only detects corruption, it does not prove the shape.
  if (!doc.boards || !Array.isArray(doc.boards.entries)) doc.boards = { entries: [] };
  const entries = doc.boards.entries;
  entries.push(entry);
  entries.sort((a, b) => (b?.score || 0) - (a?.score || 0));
  if (entries.length > BOARD_ENTRY_CAP) entries.length = BOARD_ENTRY_CAP;
  return doc;
}

export const ACHIEVEMENTS = [
  { key: 'first-victory', name: 'First Victory', description: 'Win your first match.' },
  { key: 'sharpshooter', name: 'Sharpshooter', description: 'Win a match with at least 60% accuracy.' },
  { key: 'daily-streak-3', name: 'Steady Signal', description: 'Win the daily challenge 3 days running.' },
  { key: 'journey-mastery', name: 'Chart Master', description: 'Earn 3 stars on any 8 mastery stages.' },
  { key: 'long-voyage', name: 'Long Voyage', description: 'Complete 25 sessions.' },
];

const ACHIEVEMENT_KEYS = new Set(ACHIEVEMENTS.map((a) => a.key));

/** Idempotent unlock; true only on first unlock, false for unknown keys. */
export function unlockAchievement(doc, key) {
  if (!ACHIEVEMENT_KEYS.has(key)) return false;
  if (!doc.achievements || typeof doc.achievements !== 'object') doc.achievements = {};
  if (doc.achievements[key]) return false;
  doc.achievements[key] = new Date().toISOString();
  return true;
}
