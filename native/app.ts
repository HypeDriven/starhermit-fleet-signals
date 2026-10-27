// The controller: the browser build's src/ui/app.js App without its DOM —
// the screen state machine (title, setup, Journey, Challenges, Learn,
// Hosted Table lobby, profile), the match lifecycle (placement editor,
// countdown, battle, AI pump, hot-seat handover, lesson runner, results,
// progression, achievements, the local board, the leaderboard post, resume)
// and the HUD state (toasts, captions, announcements). native/screens.ts
// draws it every frame with starhermit:ui; native/main.ts routes input to
// it. Rules state only ever changes through GameSession commands.
//
// Timers (the AI's thinking pause, the countdown, a shot's animation
// settling, the results' delay) run on the game clock (`clock`, advanced in
// fixed steps by main.ts), not setTimeout: they pause while the window is
// suspended and are deterministic in checks.
import { clipboard } from "starhermit:engine";
import { requestSignIn } from "starhermit:platform";
import { vibrate as padVibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import * as E from "../src/rules/engine.js";
import { makeRng } from "../src/rules/rng.js";
import { GameSession } from "../src/session/session.js";
import { STAGES, THEMES, dailyStage, stageById, challengeById, CONTENT_VERSION } from "../src/content/stages.js";
import { LESSONS, lessonById } from "../src/content/tutorial.js";
import { ACHIEVEMENTS, unlockAchievement, recordBoardEntry } from "../src/platform/save.js";
import { platformStrings } from "../src/ui/platform-i18n.js";
import { N, T, pname } from "./i18n.ts";
import * as render from "./render.ts";
import * as audio from "./audio.ts";
import * as platform from "./platform.ts";
import { PALETTES, applyUiTheme } from "./style.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const { cellName, cellToXY } = E;

export const AI_NAMES: Record<string, string> = { easy: "Rookie Beacon", medium: "Signal Officer", hard: "Admiral Cipher" };

/** Localized label of a match end reason (engine terminalReason). */
export function reasonText(reason: string | null): string {
  return T(({ "fleet-destroyed": N("fleet destroyed"), "move-limit": N("shot limit reached"), resign: N("resignation") } as Record<string, string>)[reason || ""] || reason || "—");
}
/** The engine writes its battle log in English (part of the hashed, replayable state): its fixed patterns translated for display. */
export function logText(text: string): string {
  const t = String(text);
  let m: RegExpExecArray | null;
  if (t === "All fleets deployed. Battle stations.") return T("All fleets deployed. Battle stations.");
  if ((m = /^(.*) fires on ([A-Z]\d+) — (open water\.|a mine! Extra charge spent\.|hit!|(.*) sunk!)$/.exec(t))) {
    const name = pname(m[1]);
    if (m[3] === "open water.") return T("{name} fires on {cell} — open water.", { name, cell: m[2]! });
    if (m[3] === "hit!") return T("{name} fires on {cell} — hit!", { name, cell: m[2]! });
    if (m[4] === undefined) return T("{name} fires on {cell} — a mine! Extra charge spent.", { name, cell: m[2]! });
    return T("{name} fires on {cell} — {ship} sunk!", { name, cell: m[2]!, ship: pname(m[4]) });
  }
  if ((m = /^(.*)'s fleet has been destroyed\.$/.exec(t))) return T("{name}'s fleet has been destroyed.", { name: pname(m[1]) });
  if ((m = /^(.*) strikes their colours\.$/.exec(t))) return T("{name} strikes their colours.", { name: pname(m[1]) });
  if ((m = /^Match drawn — (.*)\.$/.exec(t))) return T("Match drawn — {reason}.", { reason: reasonText(m[1]!) });
  if ((m = /^(.*) wins — (.*)\.$/.exec(t))) return T("{name} wins — {reason}.", { name: pname(m[1]), reason: reasonText(m[2]!) });
  return t;
}
/** Localized score-breakdown row label (engine component key + its count). */
export function componentLabel(c: Any): string {
  const n = (/\((\d+)%?\)/.exec(c.label) || [])[1] ?? "";
  const label = ({ win: N("Victory"), hits: N("Hits landed ({n})"), sunk: N("Ships sunk ({n})"), accuracy: N("Accuracy ({n}%)"), efficiency: N("Shots spared ({n})"), invalid: N("Invalid actions ({n})") } as Record<string, string>)[c.key];
  return label ? T(label, { n }) : c.label;
}

export type Screen = "title" | "setup" | "journey" | "challenges" | "learn" | "lobby" | "profile" | "game";
export type Modal =
  | { kind: "pause" }
  | { kind: "settings" }
  | { kind: "help" }
  | { kind: "reset" }
  | { kind: "handover"; name: string; ready: () => void }
  | { kind: "results" };
export type Toast = { text: string; error: boolean; until: number };
export interface Placement { placements: Map<string, Any>; selectedShipId: string | null; dir: "h" | "v" }
export interface Seat { id: string; name: string; ready: boolean }

export const app = {
  screen: "title" as Screen,
  screenData: null as Any,
  /** The frame (fixed-step count) a screen or modal opened: its opening key must not act on it. */
  openedAt: 0,
  modals: [] as Modal[],
  toasts: [] as Toast[],
  caption: null as null | { text: string; until: number },
  forms: {} as Record<string, Any>,
  // the match
  session: null as Any,
  mode: null as string | null,
  content: null as Any,
  phase: "menu" as "menu" | "placement" | "countdown" | "battle" | "resolving" | "results",
  placement: null as Placement | null,
  cursorCell: null as number | null,
  selectedCell: null as number | null,
  annotateMode: false,
  inputLocked: false,
  paused: false,
  hotseat: null as null | { playerIds: string[]; currentViewer: string | null },
  hotTarget: null as string | null,
  lesson: null as null | { def: Any; stepIdx: number },
  lessonConfig: null as Any,
  lobbySeats: null as Seat[] | null,
  countdown: null as null | { n: number },
  lastResult: null as Any,
  lbLine: null as string | null,
  drawer: null as null | "left" | "right",
  aiPending: false,
};

/** The game clock (ms): advanced by main.ts in fixed steps. */
export const clock = { ms: 0, frame: 0 };
export const nowMs = (): number => clock.ms;
type Timer = { at: number; fn: () => void; tag: string };
let timers: Timer[] = [];
export function after(ms: number, fn: () => void, tag = "match"): void { timers.push({ at: clock.ms + ms, fn, tag }); }
function clearTimers(tag: string): void { timers = timers.filter((t) => t.tag !== tag); }
/** Per fixed step: due timers, expired toasts and captions. */
export function tick(stepMs: number): void {
  clock.ms += stepMs;
  clock.frame += 1;
  const due = timers.filter((t) => t.at <= clock.ms);
  if (due.length) {
    timers = timers.filter((t) => t.at > clock.ms);
    for (const t of due) t.fn();
  }
  app.toasts = app.toasts.filter((t) => t.until > clock.ms);
  if (app.caption && app.caption.until <= clock.ms) app.caption = null;
}
// The AI's thinking pause (650–1050 ms in the browser build) from a seeded stream.
const aiDelayRng = makeRng("fleet-signals:ai-delay");

// ------------------------------------------------------------------ infrastructure
export function options(): platform.Options { return platform.options; }
export function doc(): Any { return platform.doc(); }
export function persist(): void { platform.saveDoc(); }
export function play(cue: audio.Cue): void { audio.play(cue); }
export function announce(msg: string, assertive = false): void {
  if (!msg) return;
  try { ui.announce(String(msg).slice(0, 500), { politeness: assertive ? "assertive" : "polite" }); } catch { /* empty */ }
}
export function toast(msg: string, isError = false, ms = 2600): void {
  app.toasts.push({ text: msg, error: isError, until: clock.ms + ms });
  if (app.toasts.length > 4) app.toasts.shift();
  if (isError) announce(msg, true);
}
audio.onCaption((text) => { if (platform.options.captions) app.caption = { text, until: clock.ms + 1800 }; });

/** The visual theme, palette and reduced motion on the UI and the scene (App.applySettings). */
export function applySettings(): void {
  const o = platform.options;
  const theme = THEMES.find((t: Any) => t.id === o.theme) || THEMES[0];
  applyUiTheme(theme.ui, o.palette);
  const p = PALETTES[o.palette] ?? PALETTES.default!;
  render.setMarkerColors(p.hit, p.miss);
  render.setTheme(app.session ? matchTheme().scene : theme.scene);
}
function matchTheme(): Any {
  return THEMES.find((t: Any) => t.id === (app.content?.theme || platform.options.theme)) || THEMES[0];
}

export function go(screen: Screen, data: Any = null): void {
  app.screen = screen;
  app.screenData = data;
  app.forms = {};
  app.openedAt = clock.frame;
  ui.setFocus(null);
}
export function formState<V>(key: string, init: () => V): V {
  if (!app.forms[key]) app.forms[key] = init();
  return app.forms[key] as V;
}
export function openModal(m: Modal): void { app.modals.push(m); app.openedAt = clock.frame; ui.setFocus(null); }
export function topModal(): Modal | null { return app.modals[app.modals.length - 1] ?? null; }
export function closeModal(): void {
  const m = app.modals.pop();
  if (!m) return;
  if (m.kind === "pause") resumeFromPause();
}

// ------------------------------------------------------------------ title and menus
export function showTitle(): void {
  sessionTeardown();
  app.phase = "menu";
  app.modals = [];
  render.setView("title");
  render.setInteractive(null);
  applySettings();
  go("title");
  announce(T("Fleet Signals title screen. Press Play to start a practice match."));
}
export function resumeAvailable(): boolean { return !!platform.loadResume(); }
export function dailyDone(): boolean { return !!doc().dailies[platform.todayUTC()]; }
export function journeyDone(): number { return Object.keys(doc().journey.completed).length; }

export function showSetup(mode: string, content: Any = null): void {
  if (mode === "daily") content = dailyStage(platform.todayUTC());
  go("setup", { mode, content });
  const ranked = mode === "daily" || mode === "journey" || mode === "challenge";
  announce(T(ranked ? "Setup for {name}. Ranked. Press Launch to begin." : "Setup for {name}. Unranked. Press Launch to begin.", { name: content ? T(content.name) : T("practice") }));
}
export function showJourney(): void {
  go("journey");
  announce(T("Journey map. {n} of 40 stages complete.", { n: journeyDone() }));
}
export function showLobby(): void {
  if (!app.lobbySeats) app.lobbySeats = [
    { id: "p1", name: T("Captain {n}", { n: 1 }), ready: false },
    { id: "p2", name: T("Captain {n}", { n: 2 }), ready: false },
  ];
  go("lobby");
  announce(T("Hosted table lobby. Set names, signal ready, and start."));
}
export function lobbyAdd(): void {
  const seats = app.lobbySeats!;
  if (seats.length >= 4) return;
  // Seat ids must stay unique after removals, or createMatch rejects the roster with 'duplicate player id'.
  let n = 1;
  while (seats.some((s) => s.id === "p" + n)) n += 1;
  seats.push({ id: "p" + n, name: T("Captain {n}", { n }), ready: false });
}
export function lobbyStart(): void {
  const seats = app.lobbySeats!;
  if (!seats.every((s) => s.ready)) { toast(T("Every captain must signal ready."), true); play("invalid"); return; }
  play("ui-press");
  startMatch("hosted", null, { seats });
}

export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  const ps = platformStrings() as Record<string, string>;
  try { clipboard.writeText(link); toast(ps.inviteCopied!); } catch { toast(ps.inviteFailed!, true); }
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function saveProfileName(name: string): void {
  doc().profile.name = name.trim().slice(0, 18) || "Guest Captain";
  persist();
  toast(T("Name saved."));
  play("ui-press");
}
export function resetProgress(): void {
  platform.resetDoc();
  showTitle();
}

// ------------------------------------------------------------------ match lifecycle
export function sessionTeardown(): void {
  clearTimers("match");
  app.aiPending = false;
  app.session = null;
  app.lesson = null;
  app.hotseat = null;
  app.placement = null;
  app.cursorCell = null;
  app.selectedCell = null;
  app.annotateMode = false;
  app.inputLocked = false;
  app.paused = false;
  app.countdown = null;
  app.drawer = null;
  render.skip();
  render.clearShips();
}

/** Start a match: mode learn|journey|daily|practice|challenge|hosted. */
export function startMatch(mode: string, content: Any, opts: Any = {}): void {
  sessionTeardown();
  app.mode = mode;
  app.content = content;
  app.modals = [];
  let config: Any;
  if (mode === "hosted") {
    // Retry/restart re-enters without a roster; fall back to the lobby's.
    const seats = opts.seats || app.lobbySeats;
    if (!seats || seats.length < 2) { showLobby(); return; }
    config = {
      seed: "hosted-" + Math.floor(platform.nowMs()).toString(36),
      gridSize: 8, fleetId: "standard", mechanics: {}, rulesetId: seats.length > 2 ? "skirmish" : "duel",
      players: seats.map((s: Seat) => ({ id: s.id, name: s.name })),
    };
    app.hotseat = { playerIds: seats.map((s: Seat) => s.id), currentViewer: null };
  } else {
    config = {
      seed: content?.seed || ("practice-" + Math.floor(platform.nowMs()).toString(36)),
      gridSize: content?.gridSize || 8,
      fleetId: content?.fleetId || "standard",
      mechanics: content?.mechanics || {},
      contentId: content?.id || null,
      players: [
        { id: "you", name: doc().profile.name || "You" },
        { id: "ai", name: AI_NAMES[opts.difficulty || "medium"], isAI: true, difficulty: opts.difficulty || "medium" },
      ],
    };
  }
  if (mode === "learn") {
    if (!app.lessonConfig) { go("learn"); return; }
    config = { ...app.lessonConfig, contentId: app.lessonConfig.id };
  }
  app.session = new GameSession({
    config, mode,
    assists: mode === "practice"
      ? { undo: opts.assists?.undo !== false, hints: opts.assists?.hints !== false }
      : { undo: false, hints: mode === "learn" },
    localPlayerId: app.hotseat ? undefined : "you",
  });
  enterMatchScreen(config.gridSize);
  beginPlacement();
}
function enterMatchScreen(size: number): void {
  render.buildBoards(size);
  applySettings();
  go("game");
}

/** Re-launch options that keep the opponent and assists the player chose. */
function retryOpts(): Any {
  if (!app.session) return {};
  return { difficulty: app.session.config.players.find((p: Any) => p.isAI)?.difficulty, assists: { ...app.session.assists } };
}

export function startLesson(lesson: Any): void {
  app.lessonConfig = { ...lesson.config, id: lesson.id };
  startMatch("learn", null, {});
  app.lesson = { def: lesson, stepIdx: 0 };
  if (lesson.skipPlacement) {
    app.session.command({ type: "auto-place", playerId: "you" });
    afterPlacementComplete();
  }
  announceLessonStep();
}
function announceLessonStep(): void {
  if (!app.lesson) return;
  const step = app.lesson.def.steps[app.lesson.stepIdx];
  if (!step) return;
  toast(T(step.text), false, 6500);
  announce(T(app.lesson.def.title) + ". " + T(step.text));
}
function lessonCheck(events: Any[]): void {
  if (!app.lesson) return;
  const step = app.lesson.def.steps[app.lesson.stepIdx];
  if (!step) return;
  const hit = events.some((ev) =>
    (step.waitFor === "fire" && ev.type === "shot" && ev.by === "you") ||
    (step.waitFor === "hit" && ev.type === "shot" && ev.by === "you" && (ev.result === "hit" || ev.result === "sunk")) ||
    (step.waitFor === "annotate" && ev.type === "annotated") ||
    (step.waitFor === "finish" && ev.type === "finish"));
  if (!hit) return;
  const lessonId = app.lesson.def.id;
  play("lesson-done");
  toast(T("Lesson objective complete!"), false, 3000);
  app.lesson = null;
  const d = doc();
  const idx = LESSONS.findIndex((l: Any) => l.id === lessonId);
  d.tutorial.step = Math.max(d.tutorial.step, (idx >= 0 ? idx : 0) + 1);
  if (lessonId === LESSONS[LESSONS.length - 1].id) d.tutorial.done = true;
  persist();
}

export function objectiveSub(): string {
  const m = app.session?.state.mechanics || {};
  const bits: string[] = [];
  if (app.mode === "daily") bits.push(T("Daily {date}", { date: platform.todayUTC() }));
  if (app.content?.name) bits.push(T(app.content.name));
  if (m.salvo) bits.push(T("salvo"));
  if (m.moveLimit) bits.push(T("{n} shots", { n: m.moveLimit }));
  if (m.mineCount) bits.push(T("mines"));
  if (m.fog) bits.push(T("fog"));
  return bits.join(" · ") || T("Sink the opposing fleet");
}
/** The HUD's objective line and turn badge (App._updateHud). */
export function hudLines(): { objective: string; turn: string; tone: "yours" | "theirs" | "none" } {
  const st = app.session?.state;
  if (!st) return { objective: "", turn: "", tone: "none" };
  // The badge keeps "Placement" through the countdown (the browser build updated it as the first turn began).
  if (st.phase === "placement" || app.phase === "countdown") return { objective: T("Deploy your fleet"), turn: T("Placement"), tone: "none" };
  if (st.phase === "finished") return { objective: T("Engagement concluded"), turn: "", tone: "none" };
  const v = viewer();
  const me = st.players.find((p: Any) => p.id === v);
  const foes = st.players.filter((p: Any) => p.id !== v);
  const sunk = foes.reduce((a: number, f: Any) => a + f.ships.filter((s: Any) => s.sunk).length, 0);
  const total = foes.reduce((a: number, f: Any) => a + f.ships.length, 0);
  const cur = st.players[st.currentPlayerIndex];
  const mine = cur.id === v;
  let turn = mine ? T("Your turn") : T("{name}'s turn", { name: pname(cur.name) });
  if (st.mechanics.moveLimit > 0 && me) turn += " · " + T("{n} shots", { n: Math.max(0, st.mechanics.moveLimit - me.shotsUsed) });
  return { objective: T("Enemy fleet: {sunk}/{total} sunk", { sunk, total }), turn, tone: mine ? "yours" : "theirs" };
}

export function viewer(): string {
  if (app.hotseat) return app.hotseat.currentViewer || app.session.state.players[app.session.state.currentPlayerIndex]?.id;
  return app.session?.config.players[0].id || "you";
}

// ------------------------------------------------------------------ placement
function beginPlacement(): void {
  const st = app.session.state;
  app.phase = "placement";
  const v = app.hotseat ? nextPlacementSeat() : app.session.config.players[0].id;
  if (app.hotseat) app.hotseat.currentViewer = v;
  const me = st.players.find((p: Any) => p.id === v);
  if (me?.isAI) { pumpAI(); return; }
  app.placement = { placements: new Map(), selectedShipId: null, dir: "h" };
  render.syncFromState(st, v, "placement");
  render.setView("placement");
  render.setInteractive("main");
  announce(T("Deployment phase. Place every ship, then confirm."));
}
function nextPlacementSeat(): string | undefined {
  return app.session.state.players.find((p: Any) => !p.placed && p.alive)?.id;
}
function shipCellsFor(x: number, y: number, dir: "h" | "v", size: number): number[] | null {
  const g = app.session.state.gridSize;
  const cells: number[] = [];
  for (let i = 0; i < size; i++) {
    const cx = dir === "h" ? x + i : x;
    const cy = dir === "h" ? y : y + i;
    if (cx < 0 || cy < 0 || cx >= g || cy >= g) return null;
    cells.push(cy * g + cx);
  }
  return cells;
}
function placementCandidateValid(shipId: string, cells: number[] | null): boolean {
  if (!cells) return false;
  const st = app.session.state;
  const me = st.players.find((p: Any) => p.id === viewer());
  const occupied = new Set<number>();
  for (const [otherId, pl] of app.placement!.placements) {
    if (otherId === shipId) continue;
    for (const c of shipCellsFor(pl.x, pl.y, pl.dir, st.fleet.find((f: Any) => f.id === otherId).size) || []) occupied.add(c);
  }
  for (const c of cells) {
    if (occupied.has(c)) return false;
    if (me.mines.includes(c)) return false;
  }
  if (st.mechanics.noTouch) {
    const g = st.gridSize;
    for (const c of cells) {
      const { x, y } = cellToXY(c, g);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g || ny >= g) continue;
        const n = ny * g + nx;
        if (occupied.has(n) && !cells.includes(n)) return false;
      }
    }
  }
  return true;
}
function placementPick(cell: number): void {
  const st = app.session.state;
  const pl = app.placement;
  if (!pl) return;
  // picking up an already-placed ship?
  for (const [shipId, p] of pl.placements) {
    const size = st.fleet.find((f: Any) => f.id === shipId).size;
    const cells = shipCellsFor(p.x, p.y, p.dir, size);
    if (cells && cells.includes(cell)) {
      pl.placements.delete(shipId);
      pl.selectedShipId = shipId;
      play("rotate");
      render.showDraftPlacements(st.fleet, pl.placements, st.gridSize);
      previewPlacement(cell);
      return;
    }
  }
  if (!pl.selectedShipId) {
    const first = st.fleet.find((f: Any) => !pl.placements.has(f.id));
    if (first) pl.selectedShipId = first.id; else return;
  }
  const def = st.fleet.find((f: Any) => f.id === pl.selectedShipId);
  const { x, y } = cellToXY(cell, st.gridSize);
  const cells = shipCellsFor(x, y, pl.dir, def.size);
  if (!placementCandidateValid(def.id, cells)) {
    play("invalid");
    toast(st.mechanics.noTouch ? T("Illegal position — ships must stay on the chart, clear of mines, other ships, and may not touch.") : T("Illegal position — ships must stay on the chart, clear of mines, other ships."), true);
    return;
  }
  pl.placements.set(def.id, { shipId: def.id, x, y, dir: pl.dir });
  play("place");
  const next = st.fleet.find((f: Any) => !pl.placements.has(f.id));
  pl.selectedShipId = next ? next.id : null;
  render.clearPreview();
  render.showDraftPlacements(st.fleet, pl.placements, st.gridSize);
}
function previewPlacement(cell: number | null): void {
  const pl = app.placement;
  if (!pl || cell === null) { render.clearPreview(); return; }
  const st = app.session.state;
  const shipId = pl.selectedShipId;
  if (!shipId) { render.clearPreview(); return; }
  const def = st.fleet.find((f: Any) => f.id === shipId);
  const { x, y } = cellToXY(cell, st.gridSize);
  const cells = shipCellsFor(x, y, pl.dir, def.size);
  render.previewShip(cells || [cell], placementCandidateValid(shipId, cells));
}
export function selectShip(id: string): void {
  const pl = app.placement;
  if (!pl) return;
  if (pl.placements.has(id)) {
    // pick it back up
    pl.placements.delete(id);
    render.showDraftPlacements(app.session.state.fleet, pl.placements, app.session.state.gridSize);
  }
  pl.selectedShipId = id;
  play("ui-press");
  if (app.cursorCell !== null) previewPlacement(app.cursorCell);
}
export function rotateShip(): void {
  if (!app.placement) return;
  app.placement.dir = app.placement.dir === "h" ? "v" : "h";
  play("rotate");
  if (app.cursorCell !== null) previewPlacement(app.cursorCell);
}
export function confirmPlacement(): void {
  const st = app.session?.state;
  const pl = app.placement;
  if (!st || !pl) return;
  if (pl.placements.size !== st.fleet.length) {
    toast(T("Deploy all {n} ships first.", { n: st.fleet.length }), true);
    play("invalid");
    return;
  }
  try {
    const { events } = app.session.command({ type: "place", playerId: viewer(), placements: [...pl.placements.values()] });
    saveResume();
    if (app.lesson && app.lesson.def.steps[app.lesson.stepIdx]?.waitFor === "place-all") {
      play("lesson-done");
      toast(T("Fleet deployed. Objective complete!"), false, 3000);
      app.lesson = null;
    }
    afterPlacementCommand(events);
  } catch (err: Any) {
    play("invalid");
    toast(T("Placement rejected: {reason}", { reason: err.message }), true);
  }
}
function afterPlacementCommand(_events: Any[]): void {
  if (app.session.state.phase === "placement" && app.hotseat) {
    const next = nextPlacementSeat();
    if (next) { handover(next, () => beginPlacement()); return; }
  }
  afterPlacementComplete();
}
function afterPlacementComplete(): void {
  app.placement = null;
  render.clearPreview();
  render.setInteractive(null);
  // AI seats place instantly (no ceremony needed for hidden placements).
  let guard = 0;
  while (app.session.state.phase === "placement" && app.session.needsAI() && guard++ < 8) app.session.stepAI();
  if (app.session.state.phase !== "battle") return;
  runCountdown(() => beginBattle());
}
export function autoPlace(): void {
  // Draft only: fills the tray with a legal layout; the player confirms.
  const st = app.session?.state;
  if (!st || !app.placement) return;
  const me = st.players.find((p: Any) => p.id === viewer());
  const placements = E.autoPlaceFleet(st.gridSize, st.fleet, st.mechanics, me.mines, makeRng("draft-" + clock.ms + "-" + Math.random()));
  if (!placements) { play("invalid"); toast(T("No legal layout found — try manual placement."), true); return; }
  app.placement.placements = new Map(placements.map((p: Any) => [p.shipId, p]));
  app.placement.selectedShipId = null;
  render.showDraftPlacements(st.fleet, app.placement.placements, st.gridSize);
  play("place");
  // Keyboard path (A, then Enter): Confirm deployment takes the focus.
  ui.setFocus("confirm");
  announce(T("Draft layout ready. Confirm deployment, or tap a ship to pick it up and adjust."));
}

function runCountdown(done: () => void): void {
  if (render.isReduced()) { done(); return; }
  app.phase = "countdown";
  const session = app.session;
  let n = 3;
  const step = (): void => {
    if (app.session !== session) { app.countdown = null; return; }
    if (n === 0) { app.countdown = null; done(); return; }
    app.countdown = { n };
    play("countdown");
    n -= 1;
    after(750, step);
  };
  step();
}

// ------------------------------------------------------------------ battle
function beginBattle(): void {
  app.phase = "battle";
  play("battle-start");
  render.setView("battle");
  startTurnForCurrent();
}
function startTurnForCurrent(): void {
  const st = app.session?.state;
  if (!st || st.phase === "finished") { finishIfNeeded(); return; }
  if (app.session.needsAI()) { pumpAI(); return; }
  const cur = st.players[st.currentPlayerIndex];
  if (app.hotseat && app.hotseat.currentViewer !== cur.id) { handover(cur.id, () => enterTurn()); return; }
  enterTurn();
}
function enterTurn(): void {
  const st = app.session.state;
  const v = viewer();
  app.phase = "battle";
  app.inputLocked = false;
  app.selectedCell = null;
  app.cursorCell = null;
  app.annotateMode = false;
  render.syncFromState(st, v, "battle");
  render.setInteractive("main");
  if (st.players.length > 2) {
    const fires = E.listLegalActions(st, v).filter((a: Any) => a.type === "fire");
    app.hotTarget = fires[0]?.targetId || null;
  } else {
    app.hotTarget = st.players.find((p: Any) => p.id !== v)?.id;
  }
  if (st.players[st.currentPlayerIndex].id === v) {
    play("turn");
    announce(T("Your turn. Select a coordinate on the target chart."));
  }
}
function pumpAI(): void {
  // One pump at a time: resuming from pause must not start a second driver.
  if (app.aiPending) return;
  if (!app.session || app.session.state.phase === "finished") { finishIfNeeded(); return; }
  if (!app.session.needsAI()) { if (app.session.state.phase === "battle") startTurnForCurrent(); return; }
  app.phase = "resolving";
  app.inputLocked = true;
  app.aiPending = true;
  const sess = app.session;
  after(650 + aiDelayRng.next() * 400, () => {
    app.aiPending = false;
    if (!app.session || app.session !== sess) return;
    if (app.paused) { pumpAI(); return; } // solo sim frozen while paused
    const r = app.session.stepAI();
    if (!r) { startTurnForCurrent(); return; }
    afterCommand(r.events);
  });
}
export function myTurn(): boolean {
  const st = app.session?.state;
  if (!st || st.phase !== "battle" || app.phase !== "battle") return false;
  return st.players[st.currentPlayerIndex].id === viewer() && !app.inputLocked && !app.paused;
}
export function fire(cell: number): void {
  const st = app.session?.state;
  const v = viewer();
  if (!st || app.inputLocked || st.phase !== "battle") return;
  if (st.players[st.currentPlayerIndex].id !== v) return;
  const { x, y } = cellToXY(cell, st.gridSize);
  try {
    const { events } = app.session.command({ type: "fire", playerId: v, targetId: app.hotTarget, x, y });
    saveResume();
    play("fire");
    app.inputLocked = true;
    app.phase = "resolving";
    afterCommand(events);
  } catch (err: Any) {
    play("invalid");
    toast(explainInvalid(err), true);
  }
}
function explainInvalid(err: Any): string {
  const map: Record<string, string> = {
    "not-your-turn": N("Hold fire — it is not your turn."),
    "cell-already-targeted": N("Already fired there. Pick a fresh coordinate."),
    "cell-out-of-bounds": N("That coordinate is off the chart."),
    "target-not-alive": N("That fleet is already destroyed."),
    phase: N("Not possible in the current phase."),
  };
  return map[err.code] ? T(map[err.code]!) : T("Illegal action: {reason}", { reason: err.message });
}
function annotate(cell: number): void {
  const st = app.session.state;
  const v = viewer();
  const me = st.players.find((p: Any) => p.id === v);
  if (!app.hotTarget) return;
  const notes = me.notes[app.hotTarget] || {};
  const cur = notes[cell];
  const next = cur === "flag" ? "unknown" : cur === "unknown" ? null : "flag";
  const { x, y } = cellToXY(cell, st.gridSize);
  try {
    const { events } = app.session.command({ type: "annotate", playerId: v, targetId: app.hotTarget, x, y, mark: next });
    play("ui-press");
    lessonCheck(events);
    const name = cellName(cell, st.gridSize);
    announce(next === "flag" ? T("Cell {cell} flagged.", { cell: name }) : next ? T("Cell {cell} marked unknown.", { cell: name }) : T("Cell {cell} note cleared.", { cell: name }));
  } catch { play("invalid"); }
}
/** The private note on a target cell ("flag" | "unknown"), drawn over the chart. */
export function notesFor(): Record<string, string> {
  const st = app.session?.state;
  if (!st || st.phase !== "battle" || !app.hotTarget) return {};
  return st.players.find((p: Any) => p.id === viewer())?.notes[app.hotTarget] || {};
}

/** Shared post-command pipeline: effects, announcements, AI follow-up, finish. */
function afterCommand(events: Any[]): void {
  const st = app.session.state;
  const v = viewer();
  const dur = render.playEvents(events, "battle");
  soundEvents(events, v);
  announceEvents(events, v);
  lessonCheck(events);
  const sess = app.session;
  const settle = (): void => {
    if (!app.session || app.session !== sess) return;
    render.syncFromState(st, viewer(), "battle");
    if (finishIfNeeded()) return;
    app.inputLocked = false;
    if (app.session.needsAI()) pumpAI();
    else startTurnForCurrent();
  };
  if (dur > 0 && render.jobsPending()) after(dur + 60, settle);
  else settle();
}
function soundEvents(events: Any[], v: string): void {
  for (const ev of events) {
    if (ev.type === "shot") {
      play(ev.result === "miss" ? "splash" : ev.result === "mine" ? "mine" : ev.result === "sunk" ? "sunk" : "hit");
      if (ev.targetId === v && platform.options.haptics) { try { padVibrate(ev.result === "miss" ? 10 : 40); } catch { /* no pad */ } }
    } else if (ev.type === "placed") play("place");
    else if (ev.type === "eliminated") play("eliminated");
    else if (ev.type === "resigned") play("defeat");
  }
}
function announceEvents(events: Any[], v: string): void {
  const st = app.session.state;
  for (const ev of events) {
    if (ev.type === "shot") {
      const cell = cellName(ev.cell, st.gridSize);
      const what = ev.result === "miss" ? T("open water")
        : ev.result === "mine" ? T("a mine! An extra shot is spent")
          : ev.result === "sunk" ? T("{ship} is sunk", { ship: ev.shipName ? pname(ev.shipName) : T("an enemy ship") })
            : T("a hit");
      announce(T(ev.by === v ? "You fire at {cell} — {what}." : "Incoming fire at {cell} — {what}.", { cell, what }), ev.result === "sunk");
    } else if (ev.type === "eliminated") announce(T("A fleet has been destroyed."), true);
  }
}
function finishIfNeeded(): boolean {
  const st = app.session?.state;
  if (!st || st.phase !== "finished") return false;
  if (app.phase === "results") return true;
  app.phase = "results";
  app.inputLocked = true;
  render.setInteractive(null);
  render.setView("results");
  platform.clearResume();
  recordOutcome();
  after(render.isReduced() ? 150 : 900, () => showResults());
  return true;
}

// ------------------------------------------------------------------ results and progression
function recordOutcome(): void {
  const st = app.session.state;
  const d = doc();
  const v = app.session.config.players[0].id;
  const me = st.players.find((p: Any) => p.id === v);
  const res = E.scoreMatch(st, v);
  const stats = d.stats;
  stats.sessions += 1;
  stats.shots += me.shotsUsed;
  stats.hits += me.hitsLanded;
  if (res.won) stats.wins += 1; else stats.losses += 1;
  stats.sunk += res.sunk;
  if (res.accuracy > stats.bestAccuracy) stats.bestAccuracy = res.accuracy;
  const unlocked: string[] = [];
  const unlock = (key: string): void => { if (unlockAchievement(d, key)) unlocked.push(key); };
  if (res.won) unlock("first-victory");
  if (res.won && res.accuracy >= 0.6) unlock("sharpshooter");
  if (stats.sessions >= 25) unlock("long-voyage");
  const par = app.content?.par;
  const stars = E.starRating({ won: res.won, shotsUsed: res.shotsUsed, accuracy: res.accuracy, par });
  app.lastResult = { res, stars, viewer: v, post: ["daily", "journey", "challenge"].includes(app.mode!) && !app.hotseat };
  if (app.mode === "journey" && app.content) {
    const prev = d.journey.completed[app.content.id];
    if (res.won && (!prev || stars > prev.stars || res.total > prev.score)) {
      d.journey.completed[app.content.id] = {
        stars: Math.max(stars, prev?.stars || 0),
        score: Math.max(res.total, prev?.score || 0),
        bestShots: Math.min(res.shotsUsed, prev?.bestShots ?? Infinity),
      };
    }
    const mastery3 = STAGES.filter((s: Any) => s.mastery && d.journey.completed[s.id]?.stars >= 3).length;
    if (mastery3 >= 8) unlock("journey-mastery");
  }
  if (app.mode === "daily") {
    const date = platform.todayUTC();
    const prev = d.dailies[date];
    if (!prev || res.total > prev.score) d.dailies[date] = { score: res.total, won: res.won, stars };
    if (res.won) {
      // consecutive UTC days with a won daily, ending today
      let streak = 0;
      let day = date;
      while (d.dailies[day]?.won) {
        streak += 1;
        day = new Date(Date.parse(day + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
      }
      stats.dailyStreak = streak;
      stats.lastDailyDate = date;
      if (streak >= 3) unlock("daily-streak-3");
    }
  }
  if (app.mode === "challenge" && app.content) {
    const passed = challengePassed(res);
    const prev = d.challenges.completed[app.content.id];
    if (passed && (!prev || res.total > prev.score)) d.challenges.completed[app.content.id] = { score: res.total };
  }
  const ranked = ["daily", "journey", "challenge"].includes(app.mode!);
  if (ranked || app.mode === "practice") {
    recordBoardEntry(d, {
      board: app.mode, score: res.total, ruleset: st.rulesetId,
      contentVersion: CONTENT_VERSION, seed: st.seed,
      assists: app.session.assists, durationMs: app.session.elapsedMs(),
      date: new Date(platform.nowMs()).toISOString(),
    });
  }
  if (unlocked.length) {
    for (const key of unlocked) {
      const meta = ACHIEVEMENTS.find((a: Any) => a.key === key);
      toast(T("Achievement unlocked: {name}", { name: meta ? T(meta.name) : key }), false, 4200);
    }
    play("achievement");
  }
  persist();
}
export function challengePassed(res: Any): boolean {
  const c = app.content?.constraint;
  if (!c) return res.won;
  if (!res.won) return false;
  if (c.type === "move-limit") return res.shotsUsed <= c.value;
  if (c.type === "accuracy") return res.accuracy * 100 >= c.value;
  if (c.type === "speed") return app.session.elapsedMs() / 1000 <= c.value;
  return false;
}
function showResults(): void {
  if (!app.session) return;
  const { res } = app.lastResult;
  const st = app.session.state;
  const isHot = !!app.hotseat;
  const winnerName = st.winner ? st.players.find((p: Any) => p.id === st.winner)?.name : null;
  const headline = st.winner === null ? T("Draw") : isHot ? T("{name} wins", { name: pname(winnerName) }) : res.won ? T("Victory") : T("Defeat");
  play(res.won || (isHot && st.winner) ? "victory" : "defeat");
  announce(T("{headline}. Final score {n}.", { headline, n: res.total }), true);
  app.modals = [];
  openModal({ kind: "results" });
  // Signed in only: post a ranked match (not practice, learn or hot-seat) and show the board rank.
  app.lbLine = null;
  if (app.lastResult.post && platform.signedIn()) {
    const ps = platformStrings() as Record<string, string>;
    app.lbLine = ps.lbPosting!;
    const sess = app.session;
    void platform.postLeaderboard(res.total).then((r) => {
      if (app.session !== sess) return;
      app.lbLine = !r.posted ? ps.lbNotPosted! : r.rank ? ps.lbRank!.replace("{rank}", String(r.rank)) : ps.lbPosted!;
    });
  }
}
/** What the results card shows (headline, tone, art, rows, footer facts). */
export function resultsView(): Any {
  const st = app.session?.state;
  if (!st || !app.lastResult) return null;
  const { res, stars } = app.lastResult;
  const isHot = !!app.hotseat;
  const winnerName = st.winner ? st.players.find((p: Any) => p.id === st.winner)?.name : null;
  const headline = st.winner === null ? T("Draw") : isHot ? T("{name} wins", { name: pname(winnerName) }) : res.won ? T("Victory") : T("Defeat");
  const tone = st.winner === null ? "draw" : (isHot || res.won) ? "win" : "loss";
  const nextStage = app.mode === "journey" && app.content ? STAGES[STAGES.findIndex((s: Any) => s.id === app.content.id) + 1] : null;
  const challenge = app.mode === "challenge"
    ? (challengePassed(res) ? T("✓ Challenge goal met.") : T("✗ Challenge goal missed: {goal}", { goal: T(app.content.goalText) })) : null;
  return {
    headline, tone, stars: app.mode === "journey" ? stars : null, challenge, nextStage,
    rows: res.components.map((c: Any) => ({ label: componentLabel(c), points: c.points })), total: res.total,
    facts: `${T("Reason: {reason}", { reason: reasonText(st.terminalReason) })} · ${T("Seed:")} ${st.seed} · ${T("Rules v{v} · Time {s}s", { v: E.RULES_VERSION, s: Math.round(app.session.elapsedMs() / 1000) })}`,
  };
}
export function resultsAction(act: "retry" | "next" | "modes" | "title"): void {
  play("ui-press");
  const view = resultsView();
  app.modals = [];
  if (act === "retry") {
    // Learn mode has to restart the lesson runner, not just the match.
    const lesson = app.mode === "learn" ? lessonById(app.session.config.contentId) : null;
    if (lesson) startLesson(lesson);
    else startMatch(app.mode!, app.content, retryOpts());
  } else if (act === "next" && view?.nextStage) { showTitle(); showSetup("journey", view.nextStage); }
  else showTitle();
}

// ------------------------------------------------------------------ pause
export function showPause(): void {
  if (!app.session || app.phase === "results" || app.modals.some((m) => m.kind === "pause")) return;
  app.paused = true;
  play("ui-back");
  openModal({ kind: "pause" });
}
function resumeFromPause(): void {
  app.paused = false;
  if (app.session?.needsAI()) pumpAI();
}
export function pauseAction(act: "resume" | "settings" | "help" | "restart" | "leave"): void {
  play("ui-press");
  if (act === "resume") { closeModal(); return; }
  if (act === "settings") { openModal({ kind: "settings" }); return; }
  if (act === "help") { openModal({ kind: "help" }); return; }
  app.modals = [];
  app.paused = false;
  if (act === "restart") startMatch(app.mode!, app.content, retryOpts());
  else showTitle();
}

// ------------------------------------------------------------------ hot-seat handover
function handover(forPlayerId: string, ready: () => void): void {
  const name = pname(app.session.state.players.find((p: Any) => p.id === forPlayerId)?.name || T("next captain"));
  render.setInteractive(null);
  render.clearShips();
  if (app.hotseat) app.hotseat.currentViewer = forPlayerId;
  app.inputLocked = true;
  play("handover");
  openModal({ kind: "handover", name, ready });
}
export function handoverReady(): void {
  const m = topModal();
  if (!m || m.kind !== "handover") return;
  play("ui-press");
  app.modals.pop();
  app.inputLocked = false;
  m.ready();
}

// ------------------------------------------------------------------ tray actions
export function toggleNotes(): void { if (app.phase !== "battle") return; app.annotateMode = !app.annotateMode; play("ui-press"); }
export function showHint(): void {
  if (!app.session || app.phase !== "battle" || !app.session.assists.hints || !myTurn()) return;
  const hint = app.session.hint(viewer());
  if (!hint) { toast(T("No hint available right now."), true); return; }
  app.selectedCell = hint.cell;
  app.cursorCell = hint.cell;
  render.setCursor("main", hint.cell, true);
  const cell = cellName(hint.cell, app.session.state.gridSize);
  toast(T("Signal analysis suggests {cell}.", { cell }), false, 3000);
  announce(T("Hint: try {cell}.", { cell }));
  play("hint");
}
export function undo(): void {
  if (!app.session || app.phase !== "battle") return;
  if (!app.session.canUndo()) { toast(T("Nothing to undo."), true); play("invalid"); return; }
  // Snapshots are taken before each human command, so one pop reverts the last human shot and any AI reply.
  app.session.undo();
  clearTimers("match");
  app.aiPending = false;
  render.skip();
  render.syncFromState(app.session.state, viewer(), "battle");
  app.selectedCell = null;
  app.inputLocked = false;
  app.phase = "battle";
  play("ui-back");
  announce(T("Last exchange undone."));
  saveResume();
  startTurnForCurrent();
}
export function skipAnimation(): void { render.skip(); }
export function resetView(): void { render.resetCamera(); play("ui-press"); }
export function toggleTopDown(): void { render.toggleTopDown(); play("ui-press"); }
export function chooseTarget(id: string): void { app.hotTarget = id; play("ui-press"); }

// ------------------------------------------------------------------ the chart: hover, picks, cursor
export function cellHover(cell: number | null): void {
  if (app.inputLocked || app.paused || !app.session) return;
  app.cursorCell = cell;
  if (app.phase === "placement") previewPlacement(cell);
  else if (app.phase === "battle") {
    if (cell === null) { render.setCursor("main", null); return; }
    const fired = app.session.state.players.find((p: Any) => p.id === viewer())?.shotsFired[app.hotTarget!] || {};
    render.setCursor("main", cell, !(cell in fired));
  }
}
export function cellPick(cell: number): void {
  if (app.inputLocked || app.paused || !app.session) return;
  if (app.phase === "placement") { placementPick(cell); return; }
  if (app.phase !== "battle") return;
  const st = app.session.state;
  const v = viewer();
  if (st.players[st.currentPlayerIndex].id !== v) return;
  if (app.annotateMode) { annotate(cell); return; }
  if (app.selectedCell === cell) { fire(cell); return; }
  app.selectedCell = cell;
  play("select");
  const fired = st.players.find((p: Any) => p.id === v)?.shotsFired[app.hotTarget!] || {};
  render.setCursor("main", cell, !(cell in fired));
}
export function moveCursor(dx: number, dy: number): void {
  if (!app.session || app.inputLocked || app.paused) return;
  if (app.phase !== "battle" && app.phase !== "placement") return;
  const g = app.session.state.gridSize;
  const { x, y } = cellToXY(app.cursorCell ?? 0, g);
  const cell = clampI(y + dy, g) * g + clampI(x + dx, g);
  cellHover(cell);
}
const clampI = (v: number, g: number): number => Math.min(g - 1, Math.max(0, v));
export function confirmCursor(): void {
  if (app.cursorCell !== null) cellPick(app.cursorCell);
}
export function clearSelection(): void { app.selectedCell = null; }

// ------------------------------------------------------------------ resume
export function saveResume(): void {
  if (!app.session || app.session.state.phase === "finished" || app.mode === "learn") return;
  platform.saveResume(app.session.serialize());
}
export function resumeMatch(): void {
  try {
    const raw = platform.loadResume();
    if (!raw) throw new Error("no snapshot");
    sessionTeardown();
    app.session = GameSession.restore(raw);
    app.mode = app.session.mode;
    app.content = app.session.config.contentId
      ? stageById(app.session.config.contentId) || challengeById(app.session.config.contentId) || null : null;
    if (app.session.mode === "daily") app.content = dailyStage(platform.todayUTC());
    if (app.session.config.players.every((p: Any) => !p.isAI)) {
      app.hotseat = { playerIds: app.session.config.players.map((p: Any) => p.id), currentViewer: null };
    }
    app.modals = [];
    enterMatchScreen(app.session.state.gridSize);
    if (app.session.state.phase === "placement") beginPlacement();
    else if (app.session.state.phase === "battle") beginBattle();
    else { showTitle(); return; }
    announce(T("Match restored from the last safe snapshot."));
  } catch {
    platform.clearResume();
    showTitle();
  }
}

/** The window was hidden: a solo match pauses (App's visibilitychange). */
export function onSuspend(): void {
  if (app.session && !app.hotseat && app.phase !== "results" && app.screen === "game" && !app.modals.length) showPause();
  platform.flush();
}

export { ACHIEVEMENTS, LESSONS, STAGES, THEMES };
