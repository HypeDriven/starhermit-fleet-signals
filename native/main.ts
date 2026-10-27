// Fleet Signals on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, AI, content, sessions and saves are
// the browser build's (src/rules, src/content, src/session,
// src/platform/save.js), unchanged in behaviour; the screens and HUD are
// starhermit:ui (screens.ts), the chart table and sea starhermit:scene
// (render.ts), the controller app.ts, saves and the platform platform.ts.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { gamepads, onAction, onPointerButton, onPointerMove, onTouch } from "starhermit:input";
import { onSessionEnded } from "starhermit:platform";
import * as ui from "starhermit:ui";
import { setSessionClock } from "../src/session/session.js";
import { platformStrings } from "../src/ui/platform-i18n.js";
import { initLanguage, T } from "./i18n.ts";
import * as render from "./render.ts";
import * as audio from "./audio.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import { initStyles } from "./style.ts";
import { drawScreens, setHudBlur } from "./screens.ts";
import * as A from "./app.ts";
import { app } from "./app.ts";

const STEP_MS = 1000 / 60;
// Match time runs on the game clock (pauses while suspended, deterministic in checks).
setSessionClock(() => A.clock.ms);

onStart(() => {
  setFixedRate(60);
  initLanguage();
  initStyles();
  platform.initPlatform();
  platform.onOptionsChange(() => A.applySettings());
  platform.onAdopt(() => { /* screens read the document each frame */ });
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  audio.loadSfx();
  A.showTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => A.toast((platformStrings() as Record<string, string>).signedOut!, false, 4000));

let hidden = false;
onSuspend(() => {
  hidden = true;
  audio.setSuspended(true);
  A.onSuspend();
});
onResume(() => { hidden = false; audio.setSuspended(false); });
onQuit(() => { A.saveResume(); platform.flush(); });

// ------------------------------------------------------------------ keys and pads
function inMatch(): boolean {
  return app.screen === "game" && !!app.session && !app.modals.length && !ui.capturingKeys();
}
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const fresh = A.clock.frame !== app.openedAt;
  const top = A.topModal();
  if (top) {
    // Esc is "pause / cancel": it closes the pause menu again; other dialogs take their own keys.
    if (top.kind === "pause" && e.action === "pause" && fresh) { A.play("ui-press"); A.closeModal(); }
    return;
  }
  if (app.screen !== "game") {
    // Escape on a menu screen goes back, as its Back button.
    if (e.action === "pause" && fresh && app.screen !== "title" && !ui.focused()?.startsWith("seat-name") && ui.focused() !== "profile-name") { A.play("ui-back"); A.showTitle(); }
    return;
  }
  if (!inMatch()) return;
  switch (e.action) {
    case "pause": if (fresh) A.showPause(); return;
    case "camera": render.resetCamera(); return;
    case "left": ui.setFocus(null); A.moveCursor(-1, 0); return;
    case "right": ui.setFocus(null); A.moveCursor(1, 0); return;
    case "up": ui.setFocus(null); A.moveCursor(0, -1); return;
    case "down": ui.setFocus(null); A.moveCursor(0, 1); return;
    case "confirm":
      // Enter / Space / South on a focused widget is the widget's.
      if (ui.focused()) return;
      A.confirmCursor();
      return;
    case "cancel": A.clearSelection(); return;
    case "rotate": if (app.phase === "placement") A.rotateShip(); return;
    case "auto_deploy": if (app.phase === "placement") A.autoPlace(); return;
    case "notes": A.toggleNotes(); return;
    case "hint": A.showHint(); return;
    case "undo": A.undo(); return;
    default:
  }
});

// ------------------------------------------------------------------ pointer and touch on the chart
// A tap or click on a cell picks it; a drag past 10 px (or a press held past
// 600 ms) orbits the camera instead (scene.js _initPointer). Presses are
// decided after the frame's UI is built, so one over a widget (ui.pointerOver)
// is the widget's.
type Press = { x: number; y: number; t: number; moved: boolean; lx: number; ly: number };
let press: Press | null = null;
const pending: { kind: "down" | "up" | "move"; x: number; y: number }[] = [];
let lastTouch = -1e9;
let hoverAt: { x: number; y: number } | null = null;
onPointerButton((e) => {
  if (e.button !== 0 || A.nowMs() - lastTouch < 600) return;
  pending.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y });
});
onPointerMove((x, y) => {
  if (A.nowMs() - lastTouch < 600) return;
  if (press) pending.push({ kind: "move", x, y });
  else hoverAt = { x, y };
});
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = A.nowMs();
  if (e.phase === "start") pending.push({ kind: "down", x: e.x, y: e.y });
  else if (e.phase === "end") pending.push({ kind: "up", x: e.x, y: e.y });
  else if (e.phase === "move") pending.push({ kind: "move", x: e.x, y: e.y });
  else press = null;
});
function handlePointer(): void {
  const scale = frame().scale || 1;
  if (hoverAt && !press) {
    if (inMatch() && !ui.pointerOver()) A.cellHover(render.pickCell(hoverAt.x, hoverAt.y));
    hoverAt = null;
  }
  while (pending.length) {
    const p = pending.shift()!;
    if (p.kind === "down") {
      press = inMatch() && !ui.pointerOver() ? { x: p.x, y: p.y, t: A.nowMs(), moved: false, lx: p.x, ly: p.y } : null;
      continue;
    }
    if (p.kind === "move") {
      if (!press) continue;
      if (Math.hypot(p.x - press.x, p.y - press.y) > 10 * scale) press.moved = true;
      if (press.moved) { render.orbitBy((p.x - press.lx) / scale, (p.y - press.ly) / scale); press.lx = p.x; press.ly = p.y; }
      continue;
    }
    const d = press;
    press = null;
    if (!d || !inMatch()) continue;
    if (d.moved || A.nowMs() - d.t > 600) continue; // drag / long-press = camera gesture, not a pick
    const cell = render.pickCell(p.x, p.y);
    if (cell === null) continue;
    ui.setFocus(null);
    A.cellHover(cell);
    A.cellPick(cell);
  }
}

// ------------------------------------------------------------------ frame
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  const look = lookFor(f.quality, f.levelIndex);
  setHudBlur(look.budget.hudBlur);
  render.applyLook(look);
}
onFixedUpdate(() => {
  if (hidden) return;
  A.tick(STEP_MS);
});
let frameDt = 0;
let padSeen = false;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  // The first pad (App._wireGamepad's connection toast).
  if (!padSeen && gamepads().some((g) => g.connected)) { padSeen = true; A.toast(T("Gamepad connected — stick aims, A confirms, B cancels.")); }
});
onRender(() => {
  drawScreens();
  handlePointer();
  const f = frame();
  render.update(frameDt, f.width, f.height, hidden);
});

