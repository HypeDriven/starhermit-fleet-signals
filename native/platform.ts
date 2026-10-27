// The game's data and the StarHermit platform, on the runtime's modules:
// - progress is the browser build's save document (src/platform/save.js:
//   v2, FNV-1a checksum; profile, journey, challenges, dailies,
//   achievements, stats, the local board, tutorial), unchanged: it is the
//   game's save (starhermit:storage `saves`, schema 2) on the device and in
//   the player's cloud slot, two devices' copies merged on a conflict as the
//   browser build merged them (mergeSaves: a strict descendant wins, else
//   combineSaves field by field). The slot the browser build wrote (the JS
//   SDK's saveJSON of the same document, key game:<slug>) shows as foreign
//   and is merged in and replaced once;
// - the match in progress (GameSession.serialize, the old
//   localStorage['fleet-signals-resume']) stays on the device
//   (starhermit:storage `storage`);
// - the game's own options (visual theme, colour-vision palette,
//   left-handed tray, haptics, captions) are `settings` (game.<key>, synced
//   with the account); the browser build's account settings (its
//   SYNCED_SETTINGS mirrored key by key, the language helper's ui.language,
//   the options panel's audio.options and graphics.gpu.* slots) are
//   migrated, then the old keys removed. Volumes, mute, graphics, language,
//   reduced motion, high contrast and text size are the runtime's Options;
// - the player (signed in or a guest), the invite link, the platform's clock
//   (the Daily Signal's UTC date), and posting a finished ranked match's
//   total through score-script.js (a practice session whose socket carries
//   { type: 'result', scores }, as the JS SDK's submitScores did; the
//   script range-checks it) with the rank on the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { SAVE_VERSION, checksumDoc, defaultSave } from "../src/platform/save.js";
import { OPTION_DEFAULTS, checkOption, isBrowserKey, mergeDocs, readForeign, validDoc } from "../src/platform/options.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = any;
export const RESUME_KEY = "fleet-signals-resume";

// --- the save ------------------------------------------------------------------------
let current: Doc = defaultSave();
let lastSavedAt = 0;
let adoptHook: (() => void) | null = null;
/** fn() when the account's copy (another device, the browser build) was merged in. */
export function onAdopt(fn: () => void): void { adoptHook = fn; }
/** The live save document (the app updates it in place, then calls saveDoc). */
export function doc(): Doc { return current; }
export function saveDoc(): void {
  current.checksum = checksumDoc(current);
  try { saves.save(current as JsonValue, { schema: SAVE_VERSION }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
function replaceDoc(next: Doc): void {
  for (const k of Object.keys(current)) delete current[k];
  Object.assign(current, next);
}
/** The two copies merged as the browser build merged its cloud slot. */
const merged = (local: Doc, remote: Doc): Doc => mergeDocs(local, remote);
/** Merges another copy into the device's (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  if (!validDoc(other)) return false;
  const next = merged(current, other);
  if (checksumDoc(next) === checksumDoc(current)) return false;
  replaceDoc(JSON.parse(JSON.stringify(next)));
  adoptOptionsFrom(current.settings);
  saveDoc();
  adoptHook?.();
  return true;
}
saves.onConflict((local, remote) => ({ merged: merged(local?.data ?? null, remote.data) as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    adopt(cur.data);
  }
});
/** The browser build's cloud save (its save document as JSON text): merged in, saved over it once. */
export function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  adopt(readForeign(old.text ?? null));
  current.checksum = checksumDoc(current);
  try { saves.save(current as JsonValue, { schema: SAVE_VERSION, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
}
/** For the profile's account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }
/** Resets every bit of progress (Profile › Reset all progress). */
export function resetDoc(): void { replaceDoc(defaultSave()); saveDoc(); }

// --- the match in progress (device only) -------------------------------------------------
export function saveResume(json: string): void {
  try { storage.set(RESUME_KEY, json); } catch (e) { console.warn(`resume: ${String(e)}`); }
}
export function loadResume(): string | null {
  try { return storage.getText(RESUME_KEY); } catch { return null; }
}
export function clearResume(): void { try { storage.remove(RESUME_KEY); } catch { /* gone */ } }

// --- the game's options ------------------------------------------------------------------
export interface Options { theme: string; palette: string; leftHanded: boolean; haptics: boolean; captions: boolean }
export const options: Options = { ...OPTION_DEFAULTS };
type Key = keyof Options;
const KEYS = Object.keys(options) as Key[];
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: Key): boolean {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return false; }
  const ok = checkOption(key, v);
  if (ok === undefined) return false;
  (options as unknown as Record<string, unknown>)[key] = ok;
  return true;
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: Key, value: unknown): void {
  const v = checkOption(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    optionsChanged();
  } catch { /* keep the device's */ }
}
/** The browser build kept its options in the save document's settings too. */
function adoptOptionsFrom(settings: unknown): void {
  if (!settings || typeof settings !== "object") return;
  for (const key of KEYS) adoptOption(key, (settings as Record<string, unknown>)[key]);
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends Key>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) if ((KEYS as string[]).includes(key)) adoptOption(key as Key, store.legacy(key));
  for (const key of keys) if (isBrowserKey(key)) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const data = cur?.data ?? null;
  replaceDoc(validDoc(data) ? JSON.parse(JSON.stringify(data)) : defaultSave());
  for (const key of KEYS) readOption(key);
  store.onChange((key) => {
    if (!(KEYS as string[]).includes(key)) return;
    readOption(key as Key);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock -----------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
function refreshPlayer(): void {
  invite = null;
  board = null;
  for (const fn of playerListeners) fn();
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** Today's UTC date (YYYY-MM-DD) by nowMs(): the Daily Signal's seed. */
export function todayUTC(): string { return new Date(nowMs()).toISOString().slice(0, 10); }

// --- the StarHermit high-score board ------------------------------------------------------
let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }

/** Signed in only: post a finished ranked match's total through score-script.js; never rejects. */
export async function postLeaderboard(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (v: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(v);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
