// Every screen, dialog and the in-match HUD on starhermit:ui, drawn each
// frame from the app's state (the browser build's HTML templates in
// src/ui/app.js and the layout rules of src/ui/styles.css). Layout follows
// the old style sheet's breakpoints: rails beside the chart on wide windows
// (1024 logical px and up); drawers over it, toggled from the top bar, on
// compact ones; on phones held upright a two-row top bar and a tray with
// Confirm / Fire on a row of its own; short landscape windows a tighter HUD.
// The chart's A–J / 1–10 labels (the old projected label layer) and the
// private notes are drawn over the scene at the cells' window positions.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import * as E from "../src/rules/engine.js";
import { CHALLENGES, challengeById } from "../src/content/stages.js";
import { platformStrings } from "../src/ui/platform-i18n.js";
import { PALETTE_IDS } from "../src/platform/options.js";
import { N, T, pname } from "./i18n.ts";
import * as render from "./render.ts";
import * as platform from "./platform.ts";
import * as A from "./app.ts";
import { app, AI_NAMES, ACHIEVEMENTS, LESSONS, STAGES, THEMES } from "./app.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const PT = (): Record<string, string> => platformStrings() as Record<string, string>;

// ------------------------------------------------------------------ viewport and helpers
let VW = 1280, VH = 720, SCALE = 1;
function measureViewport(): void {
  const f = frame();
  SCALE = ui.preferences().scale || 1;
  const sa = f.safeArea;
  VW = Math.max(1, (f.width - sa.left - sa.right) / SCALE);
  VH = Math.max(1, (f.height - sa.top - sa.bottom) / SCALE);
}
const wide = (): boolean => VW >= 1024 && VH > 500;
const phone = (): boolean => VW <= 700 && VH > VW;
const shortLandscape = (): boolean => VH <= 500 && VW > VH;
let hudBlur = false;
export function setHudBlur(v: boolean): void { hudBlur = v; }

function lbl(text: string, cls = "text"): void { ui.style(cls).label(text); }
function para(text: string, width: number, cls = "text"): void { ui.style(cls).paragraph(text, Math.max(40, width)); }
function heading(text: string, cls = "h2"): void { ui.style(cls).heading(text); }
function textWidth(text: string, style: string[], kind: "button" | "label" = "button"): number {
  return ui.measureText(text, { kind, style }).width / SCALE;
}
type Item = { label: string; cls?: string; opts?: ui.ButtonOptions; run: () => void; id?: string; full?: boolean; cue?: "ui-press" | "ui-back" | null };
/** Wraps buttons into rows that fit `width` (rows do not flex-wrap); `grow` stretches each row's buttons (flex: 1 1 140px). */
function buttonRows(id: string, items: Item[], width: number, { justify = "center" as ui.Align, grow = false, gap = 10 } = {}): void {
  const rows: Item[][] = [];
  let cur: Item[] = [], used = 0;
  for (const it of items) {
    const w = Math.max(grow ? 140 : 0, textWidth(it.label, [it.cls || "btn"]));
    if (cur.length && (it.full || used + gap + w > width)) { rows.push(cur); cur = []; used = 0; }
    used += (cur.length ? gap : 0) + w;
    cur.push(it);
    if (it.full) { rows.push(cur); cur = []; used = 0; }
  }
  if (cur.length) rows.push(cur);
  ui.column(`${id}-rows`, () => {
    rows.forEach((row, ri) => ui.row(`${id}-r${ri}`, () => {
      const each = grow || row.some((r) => r.full) ? (width - gap * (row.length - 1)) / row.length : 0;
      for (const it of row) {
        const style = each ? ui.style(it.cls || "btn", { width: each }) : ui.style(it.cls || "btn");
        const pressed = (it.id ? style.id(it.id) : style).button(it.label, it.opts ?? {});
        if (pressed) { if (it.cue !== null) A.play(it.cue ?? "ui-press"); it.run(); }
      }
    }, { spacing: gap, justify, width }));
  }, { spacing: gap, width });
}

// Content heights from last frame (vertical centring of short screens).
const heights = new Map<string, number>();
/** A dimmed, scrolling screen with a centred panel (`maxW` logical px wide at most). */
function screen(id: string, maxW: number, build: (w: number) => void, { dim = true, panelCls = "panel", label = "" } = {}): void {
  const w = Math.min(maxW, VW - 32);
  const contentH = heights.get(id) ?? 0;
  const top = Math.max(16, (VH - contentH) / 2);
  const scrollTo = app.openedAt === A.clock.frame || A.clock.frame - app.openedAt < 3 ? { top: 0 } : undefined;
  const cls = hudBlur && panelCls === "panel" ? "panel-blur" : panelCls;
  ui.scrollArea(`${id}-scroll`, { width: VW, height: VH }, () => {
    ui.column(`${id}-outer`, () => {
      const r = ui.id(`${id}-panel`).column(label || `${id}-panel`, () => build(w - 48), { width: w, spacing: 10, style: cls });
      heights.set(id, r.height / SCALE);
    }, { width: VW, align: "center", padding: { top, bottom: 16 }, style: dim ? "screen-dim" : undefined, height: Math.max(VH, contentH + top + 16) });
  }, scrollTo ? { scrollTo } : {});
}
/** A pill badge (the old <span class="badge">). */
function badge(text: string, ranked = false): void {
  ui.row("badge", () => lbl(text, ranked ? "badge-ranked-text" : "badge-text"), { style: ranked ? "badge-ranked" : "badge", align: "center" });
}
/** A two-column rules table (the old <table class="score-rows">). */
function factTable(id: string, rows: [string, string][], width: number, label = ""): void {
  const dt = Math.min(200, width * 0.38);
  ui.id(`${id}-facts`).grid(label || `${id}-facts`, () => {
    for (const [k, v] of rows) { lbl(k, "dim"); para(v, width - dt - 24, "text"); }
  }, { columns: [{ width: dt }, { fr: 1 }], gap: { row: 0, column: 16 }, width, rowStyle: "score-row" });
}

// ------------------------------------------------------------------ title
function titleScreen(): void {
  const P = PT();
  screen("title", 560, (w) => {
    // Key art strip above the title (≤ 26 vh, ≤ 220 px; hidden under 560 px tall).
    if (VH >= 560) ui.column("title-art", () => { /* the art is the box's background */ }, { width: w, height: Math.min(220, VH * 0.26, w * 9 / 16), style: "title-art-img" });
    ui.column("title-block", () => {
      ui.style("game-title", { text: { size: Math.max(30, Math.min(41.6, VW * 0.09)) } }).heading("FLEET SIGNALS");
      ui.style("game-subtitle", { text: { align: "center" } }).paragraph(T("A captain's holographic chart table. Hide your fleet. Read the water."), w);
    }, { align: "center", spacing: 4, width: w, padding: { bottom: 14 } });
    ui.id("title-menu").column(T("Fleet Signals title"), () => {
      if (A.resumeAvailable()) { if (ui.id("resume").style("btn-primary", "btn-play").button(T("Resume Match"))) { A.play("ui-press"); A.resumeMatch(); } }
      if (ui.id("play").style("btn-primary", "btn-play").button(T("Play"))) { A.play("ui-press"); A.showSetup("practice"); }
      const daily = A.dailyDone() ? `${T("Daily Signal")} ✓` : T("Daily Signal");
      buttonRows("menu-1", [
        { id: "daily", label: daily, run: () => A.showSetup("daily") },
        { id: "journey", label: `${T("Journey")}  ${A.journeyDone()}/40`, run: () => A.showJourney() },
      ], w, { grow: true });
      buttonRows("menu-2", [
        { id: "practice", label: T("Practice"), run: () => A.showSetup("practice") },
        { id: "challenge", label: T("Challenge"), run: () => A.go("challenges") },
      ], w, { grow: true });
      buttonRows("menu-3", [
        { id: "learn", label: T("Learn"), run: () => A.go("learn") },
        { id: "hosted", label: T("Hosted Table"), run: () => A.showLobby() },
      ], w, { grow: true });
      if (!platform.signedIn()) buttonRows("menu-account", [{ label: P.signIn!, cls: "btn-ghost", run: () => A.signIn() }], w);
      else if (platform.inviteLink()) buttonRows("menu-account", [{ label: P.invite!, cls: "btn-ghost", run: () => A.copyInvite() }], w);
      buttonRows("menu-4", [
        { id: "profile", label: T("Profile"), cls: "btn-ghost", run: () => A.go("profile") },
        { id: "settings", label: T("Settings"), cls: "btn-ghost", run: () => A.openModal({ kind: "settings" }) },
        { id: "help", label: T("Help"), cls: "btn-ghost", run: () => A.openModal({ kind: "help" }) },
      ], w, { grow: true });
    }, { spacing: 10, width: w, align: "stretch" });
  }, { dim: false });
}

// ------------------------------------------------------------------ setup
function setupScreen(): void {
  const { mode, content: c } = app.screenData || {};
  if (!mode) { A.showTitle(); return; }
  const s = A.formState("setup", () => ({ difficulty: 1, hints: true, undo: true }));
  const gridSize = c?.gridSize || 8;
  const fleet = (E.FLEETS as Record<string, Any[]>)[c?.fleetId || "standard"]!;
  const mech = { ...E.DEFAULT_MECHANICS, ...(c?.mechanics || {}) };
  const fleetCells = fleet.reduce((a: number, sh: Any) => a + sh.size, 0);
  const duration = gridSize <= 6 ? T("Short (about 4 min)") : gridSize <= 8 ? T("Medium (about 8 min)") : T("Long (about 12 min)");
  const ranked = mode === "daily" || mode === "journey" || mode === "challenge";
  const mechList: string[] = [];
  if (mech.salvo) mechList.push(T("Salvo — one shot per surviving ship each turn"));
  if (mech.moveLimit) mechList.push(T("Shot limit — {n} shots for the whole match", { n: mech.moveLimit }));
  if (mech.mineCount) mechList.push(T("Mines — {n} hidden hazards per chart (striking one costs an extra shot)", { n: mech.mineCount }));
  if (mech.noTouch) mechList.push(T("Discipline — ships may not touch when placed"));
  if (mech.fog) mechList.push(T("Fog — sunken ships are not identified"));
  if (!mechList.length) mechList.push(T("Classic duel — alternate single shots"));
  const diffs = ["easy", "medium", "hard"];
  screen("setup", 640, (w) => {
    ui.row("setup-head", () => {
      heading(mode === "daily" ? T("Daily Signal — {date}", { date: platform.todayUTC() }) : c ? T(c.name) : T("Practice Skirmish"));
      badge(ranked ? T("Ranked") : T("Unranked"), ranked);
    }, { spacing: 8, align: "center" });
    para(c?.briefing ? T(c.briefing) : T("A straight duel against the practice intelligence. Undo and hints are available; nothing here affects ratings."), w);
    const rows: [string, string][] = [
      [T("Chart"), `${gridSize}×${gridSize}`],
      [T("Fleet"), T("{n} ships, {cells} cells", { n: fleet.length, cells: fleetCells })],
      [T("Rules"), mechList.join("; ")],
      [T("Players"), T("2 — you vs {name}", { name: pname(AI_NAMES[mode === "practice" ? diffs[s.difficulty]! : c?.aiDifficulty || "medium"]) })],
    ];
    if (c?.par) rows.push([T("Par"), T("{n} shots for a star", { n: c.par })]);
    if (c?.goalText) rows.push([T("Challenge goal"), T(c.goalText)]);
    rows.push([T("Expected duration"), duration]);
    rows.push([T("Seed"), c?.seed ? c.seed : T("random per match")]);
    factTable("setup", rows, w, T("Rules summary"));
    if (mode === "practice") {
      lbl(T("Opponent difficulty"), "field-label");
      s.difficulty = ui.id("setup-diff").select(T("Opponent difficulty"), s.difficulty, [T("Easy — Rookie Beacon"), T("Medium — Signal Officer"), T("Hard — Admiral Cipher")]);
      const h = ui.checkbox(T("Hints available (H)"), s.hints);
      if (h !== s.hints) { s.hints = h; A.play("ui-press"); }
      const u = ui.checkbox(T("Undo allowed (U)"), s.undo);
      if (u !== s.undo) { s.undo = u; A.play("ui-press"); }
    }
    buttonRows("setup-actions", [
      { id: "launch", label: T("Launch"), cls: "btn-primary", run: () => {
        const opts = mode === "practice"
          ? { difficulty: diffs[s.difficulty], assists: { hints: s.hints, undo: s.undo } }
          : { difficulty: c?.aiDifficulty || "medium", assists: { hints: true, undo: false } };
        A.startMatch(mode, c, opts);
      } },
      { id: "back", label: T("Back"), cue: "ui-back", run: () => A.showTitle() },
    ], w, { grow: true });
  }, { label: T("Match setup") });
}

// ------------------------------------------------------------------ Journey, Challenges, Learn
function journeyScreen(): void {
  const done = A.doc().journey.completed;
  const unlockedUpTo = STAGES.findIndex((s: Any) => !done[s.id]);
  const limit = unlockedUpTo === -1 ? STAGES.length : unlockedUpTo + 1;
  screen("journey", 880, (w) => {
    ui.row("journey-head", () => { heading(T("Journey")); badge(`${Object.keys(done).length}/40`); }, { spacing: 8, align: "center" });
    para(T("Forty authored engagements. Win a stage to unlock the next; ◆ marks mastery trials. Earn up to three stars: victory, at or under par shots, and 60%+ accuracy."), w);
    const gap = 8;
    const cols = Math.max(4, Math.floor((w + gap) / (64 + gap)));
    const cell = (w - gap * (cols - 1)) / cols;
    ui.grid(T("Journey stages"), () => {
      STAGES.forEach((s: Any, i: number) => {
        const rec = done[s.id];
        const locked = i >= limit;
        const name = locked ? T("Stage {n}: {name} (locked)", { n: s.index, name: T(s.name) })
          : rec ? T("Stage {n}: {name}, {stars} stars", { n: s.index, name: T(s.name), stars: rec.stars }) : T("Stage {n}: {name}", { n: s.index, name: T(s.name) });
        const hit = ui.id(`stage-${s.id}`).style("stage-cell", s.mastery && "stage-mastery", { width: cell, height: Math.max(64, cell) }).button(name, {
          disabled: locked,
          content: () => {
            ui.style("text", { text: { align: "center", size: 13.6 } }).label(`${s.index}${s.mastery ? " ◆" : ""}`);
            if (rec) ui.style("stars", { text: { size: 11 } }).label("★".repeat(rec.stars) + "☆".repeat(3 - rec.stars));
          },
        });
        if (hit && !locked) { A.play("ui-press"); A.showSetup("journey", s); }
      });
    }, { columns: cols, gap, width: w });
    buttonRows("journey-back", [{ id: "back", label: T("Back"), cue: "ui-back", run: () => A.showTitle() }], w, { justify: "start" });
  });
}
/** A list row: title, small text, a button at its end (the old .lobby-player rows). */
function listRow(id: string, w: number, title: string, small: string, extra: string | null, action: string, run: () => void): void {
  const bw = textWidth(action, ["btn"]) + 4;
  ui.row(id, () => {
    ui.column(`${id}-text`, () => {
      ui.row(`${id}-title`, () => { lbl(title, "strong"); if (extra) badge(extra); }, { spacing: 6, align: "center" });
      para(small, w - bw - 12, "small");
    }, { spacing: 2, width: w - bw - 12 });
    if (ui.id(`${id}-go`).style("btn").button(action)) { A.play("ui-press"); run(); }
  }, { width: w, spacing: 12, align: "center", style: "list-row" });
}
function challengesScreen(): void {
  const completed = A.doc().challenges.completed;
  screen("challenges", 640, (w) => {
    ui.row("ch-head", () => { heading(T("Challenges")); badge(T("Ranked"), true); }, { spacing: 8, align: "center" });
    para(T("Constrained engagements: shot limits, minefields, fog and speed targets."), w);
    for (const c of CHALLENGES) {
      const rec = completed[c.id];
      listRow(`ch-${c.id}`, w, T(c.name), T("{description} Goal: {goal}", { description: T(c.description), goal: T(c.goalText) }),
        rec ? T("cleared {score}", { score: rec.score }) : null, T("Run"), () => A.showSetup("challenge", challengeById(c.id)));
    }
    buttonRows("ch-back", [{ id: "back", label: T("Back"), cue: "ui-back", run: () => A.showTitle() }], w, { justify: "start" });
  });
}
function learnScreen(): void {
  screen("learn", 640, (w) => {
    ui.row("learn-head", () => { heading(T("Learn")); if (A.doc().tutorial.done) badge(T("complete")); }, { spacing: 8, align: "center" });
    para(T("Five short lessons. Each one asks you to perform the action yourself — the same rules the fleet plays by."), w);
    for (const l of LESSONS) listRow(`lesson-${l.id}`, w, T(l.title), T(l.intro), null, T("Start"), () => A.startLesson(l));
    buttonRows("learn-back", [{ id: "back", label: T("Back"), cue: "ui-back", run: () => A.showTitle() }], w, { justify: "start" });
  });
}

// ------------------------------------------------------------------ Hosted Table lobby (local pass-and-play)
function lobbyScreen(): void {
  const seats = app.lobbySeats!;
  screen("lobby", 640, (w) => {
    ui.row("lobby-head", () => { heading(T("Hosted Table")); badge(T("Local pass-and-play")); }, { spacing: 8, align: "center" });
    para(T("Two to four captains share this table. The chart is hidden between turns — hand the device over when prompted. Placement and shots are validated by the same authoritative script that runs online sessions (server.js); reconnecting mid-match restores the last snapshot from the title screen."), w);
    ui.column(T("Roster"), () => {
      seats.forEach((s, i) => {
        const readyLabel = s.ready ? T("Ready") : T("Not ready");
        const rw = textWidth(readyLabel, ["btn"]) + 4;
        const dw = seats.length > 2 ? 48 : 0;
        ui.row(`seat-${s.id}`, () => {
          ui.widget(`dot-${s.id}`, { role: "none", size: { width: 12, height: 12 }, draw: (r) => draw.circle(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, s.ready ? "#6ff2c8" : "#ff5468") });
          ui.id(`seat-field-${s.id}`).column(T("Player {n} name", { n: i + 1 }), () => {
            const name = ui.textField(`seat-name-${s.id}`, s.name, { maxChars: 18, width: Math.max(80, w - rw - dw - 12 - 36) });
            if (name !== s.name) s.name = name.slice(0, 18);
          });
          if (ui.id(`seat-ready-${s.id}`).style("btn", s.ready && "btn-primary").button(readyLabel, { selected: s.ready })) { s.ready = !s.ready; A.play("ui-press"); }
          if (seats.length > 2 && ui.id(`seat-drop-${s.id}`).style("btn-ghost").button(T("Remove player {n}", { n: i + 1 }), { content: () => ui.label("✕") })) { seats.splice(i, 1); A.play("ui-back"); }
        }, { width: w, spacing: 12, align: "center", style: s.ready ? "list-row" : "list-row" });
      });
    }, { width: w, spacing: 0 });
    const items: Item[] = [];
    if (seats.length < 4) items.push({ id: "add", label: T("Add player"), run: () => A.lobbyAdd() });
    items.push({ id: "start", label: T("Start match"), cls: "btn-primary", cue: null, run: () => A.lobbyStart() });
    items.push({ id: "back", label: T("Back"), cue: "ui-back", run: () => A.showTitle() });
    buttonRows("lobby-actions", items, w, { grow: true });
  }, { label: T("Hosted table lobby") });
}

// ------------------------------------------------------------------ profile
const ACH_ICONS: Record<string, string> = { "first-victory": "★", sharpshooter: "◎", "daily-streak-3": "▲", "journey-mastery": "◆", "long-voyage": "∞" };
function profileScreen(): void {
  const d = A.doc();
  const st = d.stats;
  const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : 0;
  const form = A.formState("profile", () => ({ name: pname(d.profile.name) }));
  const syncLabels: Record<string, string> = { saving: N("saving…"), synced: N("synced"), error: N("sync error — retries with your next save"), offline: N("offline") };
  screen("profile", 880, (w) => {
    ui.row("profile-head", () => { heading(T("Profile")); if (d.profile.guest) badge(T("Guest")); }, { spacing: 8, align: "center" });
    if (platform.signedIn()) {
      ui.row("account", () => {
        lbl(T("Signed in as"), "dim");
        lbl(platform.displayName() || "…", "strong");
        badge(T(syncLabels[platform.syncState()]!));
      }, { spacing: 6, align: "center" });
      para(T("Progress mirrors to your StarHermit cloud save; this device keeps an offline copy."), w, "small");
    } else {
      ui.row("account", () => { badge(T("Offline")); lbl(T("Progress is stored on this device only."), "small"); }, { spacing: 6, align: "center" });
    }
    lbl(T("Display name"), "field-label");
    form.name = ui.textField("profile-name", form.name, { maxChars: 18, width: Math.min(w, 360) });
    const stats: [string, string][] = [
      [String(st.sessions), T("Sessions")], [String(st.wins), T("Victories")], [`${acc}%`, T("Accuracy")],
      [String(st.sunk), T("Ships sunk")], [String(st.dailyStreak), T("Daily streak")],
    ];
    const gap = 10;
    const cols = Math.max(1, Math.min(5, Math.floor((w + gap) / (110 + gap))));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.grid(T("Career statistics"), () => {
      for (const [num, label] of stats) ui.id(`stat-${label}`).column(label, () => {
        ui.style("stat-num", { text: { align: "center" } }).label(num);
        ui.style("stat-label", { text: { align: "center" } }).label(label);
      }, { style: "stat-box", align: "center", spacing: 2, width: cw });
    }, { columns: cols, gap, width: w, align: "stretch" });
    heading(T("Achievements"), "h3");
    for (const a of ACHIEVEMENTS) {
      const unlocked = d.achievements[a.key];
      ui.row(`ach-${a.key}`, () => {
        ui.style("text", { width: 34, text: { size: 22, align: "center" } }).label(ACH_ICONS[a.key] || "★");
        ui.column(`ach-${a.key}-t`, () => { lbl(T(a.name), "strong"); para(T(a.description), w - 34 - 140, "small"); }, { spacing: 2, width: w - 34 - 140 });
        lbl(unlocked ? "✓ " + String(unlocked).slice(0, 10) : T("Locked"), "dim");
      }, { width: w, spacing: 10, align: "center", style: unlocked ? "list-row" : "list-row-locked" });
    }
    heading(T("Local leaderboard"), "h3");
    const entries = (d.boards?.entries || []).slice(0, 10);
    if (!entries.length) para(T("No recorded results yet."), w, "dim");
    else ui.grid("board", () => {
      for (const h of [T("Board"), T("Score"), T("Seed"), T("Date")]) lbl(h, "strong");
      for (const b of entries) {
        lbl(T(({ daily: N("Daily"), journey: N("Journey"), challenge: N("Challenge"), practice: N("Practice") } as Record<string, string>)[b.board] || b.board), "text");
        lbl(String(b.score), "text");
        lbl(String(b.seed), "small");
        lbl(String(b.date).slice(0, 10), "small");
      }
    }, { columns: [{ fr: 1 }, "auto", { fr: 1.4 }, "auto"], gap: { row: 0, column: 12 }, width: w, rowStyle: "score-row" });
    buttonRows("profile-actions", [
      { id: "save-name", label: T("Save name"), cls: "btn-primary", cue: null, run: () => A.saveProfileName(form.name) },
      { id: "back", label: T("Back"), cue: "ui-back", run: () => A.showTitle() },
      { id: "reset", label: T("Reset all progress"), cls: "btn-danger", run: () => A.openModal({ kind: "reset" }) },
    ], w, { grow: true });
  });
}

// ------------------------------------------------------------------ the in-match HUD
const hudRects = { top: 0, tray: 0, left: 0, right: 0 };
function hudTop(): void {
  const lines = A.hudLines();
  const isPhone = phone();
  const pad = shortLandscape() ? { top: 4, bottom: 4, start: 8, end: 8 } : { top: 8, bottom: 8, start: 12, end: 12 };
  const r = ui.place("hud-top", "top-start", () => {
    const pauseBtn = (): void => { if (ui.id("pause").style("btn-ghost").button(T("Pause"), { content: () => ui.style("strong", { text: { size: 18 } }).label("❚❚") })) { A.showPause(); } };
    const objective = (width: number): void => {
      ui.column("hud-objective", () => {
        ui.style("obj-title").label(lines.objective);
        if (!isPhone) ui.style("obj-sub").label(A.objectiveSub());
      }, { style: "hud-objective", width, spacing: 0 });
    };
    const turn = (): void => {
      if (!lines.turn) return;
      ui.row("hud-turn", () => ui.style(lines.tone === "yours" ? "turn-yours-text" : lines.tone === "theirs" ? "turn-theirs-text" : "turn-text").label(lines.turn),
        { style: lines.tone === "yours" ? "hud-turn-yours" : lines.tone === "theirs" ? "hud-turn-theirs" : "hud-turn", align: "center" });
    };
    const toggles = (): void => {
      if (wide()) return;
      if (ui.id("drawer-left").style("btn-ghost").button(T("Toggle fleet panel"), { selected: app.drawer === "left", content: () => ui.label("☰") })) { A.play("ui-press"); app.drawer = app.drawer === "left" ? null : "left"; }
      if (ui.id("drawer-right").style("btn-ghost").button(T("Toggle log panel"), { selected: app.drawer === "right", content: () => ui.label("≡") })) { A.play("ui-press"); app.drawer = app.drawer === "right" ? null : "right"; }
    };
    const inner = VW - pad.start - pad.end;
    if (isPhone) {
      ui.column("hud-phone", () => {
        const pauseW = Math.max(72, textWidth("❚❚", ["btn-ghost"]) + 16);
        ui.row("hud-row1", () => { pauseBtn(); objective(inner - pauseW - 10); }, { spacing: 10, align: "center", width: inner });
        ui.row("hud-row2", () => { turn(); ui.spacer(); toggles(); }, { spacing: 6, align: "center", width: inner });
      }, { spacing: 6, width: inner });
    } else {
      const turnW = lines.turn ? textWidth(lines.turn, ["turn-text"], "label") + 30 + 10 : 0;
      const pauseW = Math.max(72, textWidth("❚❚", ["btn-ghost"]) + 16);
      const togglesW = wide() ? 0 : 2 * (Math.max(44, textWidth("☰", ["btn-ghost"])) + 10);
      ui.row("hud-row", () => { pauseBtn(); objective(Math.max(120, inner - pauseW - 10 - turnW - togglesW)); turn(); toggles(); }, { spacing: 10, align: "center", width: inner });
    }
  }, { padding: pad, width: VW });
  hudRects.top = r.y + r.height;
}
function fleetRail(w: number): void {
  const st = app.session.state;
  const v = A.viewer();
  const me = st.players.find((p: Any) => p.id === v);
  for (const p of st.players) {
    const isMe = p.id === v;
    const label = isMe ? T("Your fleet") : pname(p.name);
    heading(p.alive ? label : T("{name} — eliminated", { name: label }), "rail-h");
    const row = (id: string, a: string, b: string, sunk = false): void => {
      ui.row(id, () => { ui.style(sunk ? "fleet-sunk" : "fleet-text").label(a); ui.spacer(); ui.style(sunk ? "fleet-sunk" : "fleet-text").label(b); }, { width: w, style: "fleet-row", align: "center" });
    };
    if (isMe) for (const s of p.ships) row(`ship-${p.id}-${s.id}`, pname(s.name), "●".repeat(s.hits) + "○".repeat(s.size - s.hits), s.sunk);
    else {
      row(`sunk-${p.id}`, T("Ships sunk"), `${p.ships.filter((s: Any) => s.sunk).length}/${p.ships.length}`);
      row(`shots-${p.id}`, T("Your shots"), String(me?.shotsUsed ?? 0));
      row(`acc-${p.id}`, T("Accuracy"), `${me && me.shotsUsed ? Math.round((me.hitsLanded / me.shotsUsed) * 100) : 0}%`);
    }
  }
}
function logRail(w: number): void {
  heading(T("Signals log"), "rail-h");
  const log = app.session.state.log.slice(-12);
  log.forEach((l: Any, i: number) => {
    ui.column(`log-${i}`, () => para(A.logText(l.text), w, i === log.length - 1 ? "log-latest" : "log-line"), { style: "log-row", width: w });
  });
}
function rails(): void {
  const left = A.options().leftHanded;
  const top = hudRects.top / SCALE + 4;
  const trayH = hudRects.tray / SCALE;
  if (wide()) {
    const h = Math.max(120, VH - top - trayH - 12);
    const w = shortLandscape() ? 190 : 240;
    const railBox = (id: string, name: string, anchor: "top-start" | "top-end", build: (iw: number) => void): ui.Rect => ui.place(id, { anchor, x: 10, y: top }, () => {
      ui.scrollArea(`${id}-scroll`, { width: w - 24, height: h - 24 }, () => ui.id(`${id}-c`).column(name, () => build(w - 36), { spacing: 6, width: w - 36 }));
    }, { style: "rail", width: w, height: h, padding: 12 });
    const l = railBox("rail-left", T("Fleet status"), left ? "top-end" : "top-start", fleetRail);
    const r = railBox("rail-right", T("Event log"), left ? "top-start" : "top-end", logRail);
    hudRects.left = (left ? r : l).x + (left ? r : l).width;
    hudRects.right = frame().width - (left ? l : r).x;
    return;
  }
  hudRects.left = 0;
  hudRects.right = 0;
  if (!app.drawer) return;
  const w = Math.min(shortLandscape() ? 190 : 320, VW * 0.84);
  const h = Math.min(VH * 0.45, VH - top - trayH - 12);
  const side = (app.drawer === "left") !== left ? "bottom-start" : "bottom-end";
  ui.place(`drawer-${app.drawer}`, { anchor: side, x: 10, y: trayH + 4 }, () => {
    ui.scrollArea("drawer-scroll", { width: w - 24, height: h - 24 }, () => ui.id("drawer-c").column(app.drawer === "left" ? T("Fleet status") : T("Event log"), () => (app.drawer === "left" ? fleetRail : logRail)(w - 36), { spacing: 6, width: w - 36 }));
  }, { style: "rail-drawer", width: w, height: h, padding: 12 });
}
function trayItems(): Item[] {
  const st = app.session.state;
  const items: Item[] = [];
  const isPhone = phone();
  if (st.phase === "placement" && app.placement) {
    const pl = app.placement;
    for (const f of st.fleet) {
      const placed = pl.placements.has(f.id);
      const sel = pl.selectedShipId === f.id;
      items.push({
        id: `ship-${f.id}`, label: `${pname(f.name)} ${"▮".repeat(f.size)}`, cls: placed ? "ship-chip-placed" : "ship-chip",
        opts: { selected: sel }, cue: null, run: () => A.selectShip(f.id),
      });
    }
    items.push({ id: "rotate", label: T("⟳ Rotate"), cue: null, opts: { tooltip: T("Rotate ship (R)") }, run: () => A.rotateShip() });
    items.push({ id: "auto", label: T("Auto-deploy"), cue: null, opts: { tooltip: T("Auto-deploy (A)") }, run: () => A.autoPlace() });
    items.push({ id: "confirm", label: T("Confirm deployment"), cls: "btn-primary", cue: null, full: isPhone, opts: { disabled: pl.placements.size !== st.fleet.length }, run: () => A.confirmPlacement() });
    return items;
  }
  if (st.phase === "battle" && app.phase !== "countdown") {
    const v = A.viewer();
    const mine = A.myTurn();
    const sel = app.selectedCell !== null ? E.cellName(app.selectedCell, st.gridSize) : null;
    if (st.players.length > 2 && mine) {
      for (const f of E.listLegalActions(st, v).filter((a: Any) => a.type === "fire")) {
        const p = st.players.find((q: Any) => q.id === f.targetId);
        items.push({ id: `target-${f.targetId}`, label: pname(p.name), opts: { selected: app.hotTarget === f.targetId }, cue: null, run: () => A.chooseTarget(f.targetId) });
      }
    }
    const fireItem: Item = { id: "fire", label: sel ? `${T("Fire")} ${sel}` : T("Fire"), cls: "btn-primary", cue: null, full: isPhone, opts: { disabled: !mine || !sel }, run: () => { if (app.selectedCell !== null) A.fire(app.selectedCell); } };
    if (!isPhone) items.push(fireItem);
    items.push({ id: "note", label: T("✎ Note (N)"), cue: null, opts: { selected: app.annotateMode, disabled: !mine }, run: () => A.toggleNotes() });
    if (app.session.assists.hints) items.push({ id: "hint", label: T("Hint (H)"), cue: null, opts: { disabled: !mine }, run: () => A.showHint() });
    if (app.session.canUndo()) items.push({ id: "undo", label: T("Undo (U)"), cue: null, run: () => A.undo() });
    if (render.jobsPending()) items.push({ id: "skip", label: T("Skip ▸▸"), run: () => A.skipAnimation() });
    items.push({ id: "view", label: T("⌖ View").replace("⌖", "🎯") /* ⌖ is tofu on the web runtime: the target emoji instead */, cue: null, opts: { tooltip: T("Reset view (C)") }, run: () => A.resetView() });
    items.push({ id: "topdown", label: T("▦ Top"), cue: null, opts: { selected: render.isTopDown(), tooltip: T("Top-down chart") }, run: () => A.toggleTopDown() });
    if (isPhone) items.push(fireItem);
    return items;
  }
  return [];
}
function tray(): void {
  let items = trayItems();
  const left = A.options().leftHanded;
  if (left) items = items.slice().reverse();
  const w = VW - 20;
  const r = ui.place("tray", { anchor: "bottom", y: 0 }, () => {
    if (!items.length) { ui.style("resolving").label(T("Resolving…")); return; }
    ui.id("tray-bar").column(T("Actions"), () => {
      buttonRows("tray-buttons", items, w - 22, { gap: phone() ? 6 : 8, justify: left ? "end" : "center" });
    }, { width: w - 22 });
  }, { style: "tray", width: w, padding: phone() || shortLandscape() ? 6 : 10, align: "center" });
  hudRects.tray = frame().height - r.y;
}
/** The chart's coordinate labels and private notes over the scene (the old #label-layer). */
function chartOverlay(): void {
  if (!render.hasBoards() || !app.session) return;
  const f = frame();
  const g = app.session.state.gridSize;
  const notes = A.notesFor();
  ui.place("labels", "top-start", () => {
    ui.widget("chart-labels", {
      role: "none", size: { width: 0, height: 0 },
      draw: () => {
        const s = SCALE;
        const opts = { size: 11 * s, color: "#9db4c6", align: "center" as const, shadow: { color: "#0a1626", x: 0, y: 0 } };
        for (let i = 0; i < g; i++) {
          const col = render.projectCell("main", i, f.width, f.height);
          const row = render.projectCell("main", i * g, f.width, f.height);
          if (col.visible) draw.text(String.fromCharCode(65 + i), col.x, col.y - 22 * s - 6 * s, opts);
          if (row.visible) draw.text(String(i + 1), row.x - 26 * s, row.y - 6 * s, opts);
        }
        for (const [cellStr, mark] of Object.entries(notes)) {
          const p = render.projectCell("main", Number(cellStr), f.width, f.height);
          if (!p.visible) continue;
          draw.text(mark === "flag" ? "⚑" : "?", p.x, p.y - 22 * s, { size: 18 * s, color: mark === "flag" ? "#ffc857" : "#cfe8ff", align: "center", weight: "bold", shadow: { color: "#000000", x: 0, y: 1 * s } });
        }
      },
    });
  });
}
function gameHud(): void {
  if (!app.session) { A.showTitle(); return; }
  chartOverlay();
  hudTop();
  tray();
  rails();
  if (app.countdown) ui.place("countdown", "center", () => ui.style("countdown").label(String(app.countdown!.n)));
  // The chart is fitted inside what the HUD leaves (scene.js _safeInsets).
  const f = frame();
  if (f.width > 0 && f.height > 0) {
    render.setSafeInsets({ l: hudRects.left / f.width, r: hudRects.right / f.width, t: hudRects.top / f.height, b: hudRects.tray / f.height });
  }
}

// ------------------------------------------------------------------ toasts and captions
function toasts(): void {
  if (!app.toasts.length) return;
  const top = app.screen === "game" ? hudRects.top / SCALE + 6 : 70;
  ui.place("toasts", { anchor: "top", y: top }, () => {
    for (const t of app.toasts) {
      const max = Math.min(VW * 0.9, 560);
      const cls = t.error ? "toast-error-text" : "toast-text";
      const tw = textWidth(t.text, [cls], "label");
      ui.column(`toast-${t.until}`, () => {
        if (tw <= max - 32) ui.style(cls, { text: { align: "center" } }).label(t.text);
        else ui.style(cls, { text: { align: "center" } }).paragraph(t.text, max - 32);
      }, { style: t.error ? "toast-error" : "toast" });
    }
  }, { spacing: 6, align: "center" });
}
function captionLine(): void {
  const c = app.caption;
  if (!c || !A.options().captions) return;
  const bottom = app.screen === "game" ? hudRects.tray / SCALE + 12 : 24;
  ui.place("caption", { anchor: "bottom", y: bottom }, () => lbl(T(c.text), "caption-text"), { style: "caption" });
}

// ------------------------------------------------------------------ dialogs
/** A modal card: a heading, a scrolling body and a pinned footer. */
function card(id: string, title: string, width: number, body: (w: number) => void, footer?: (w: number) => void, closable = true, label = ""): void {
  const w = Math.min(width, VW - 24) - 48;
  const maxBody = VH * 0.86 - 150;
  const bodyH = heights.get(id) ?? 0;
  const open = ui.id(id).dialog(label || title || id, "", true, () => {
    ui.column(`${id}-col`, () => {
      if (title) heading(title);
      const inner = (): void => {
        const r = ui.column(`${id}-body`, () => body(w - 14), { width: w - 14, spacing: 8 });
        heights.set(id, r.height / SCALE);
      };
      if (bodyH > maxBody) ui.scrollArea(`${id}-scroll`, { width: w, height: maxBody }, inner, A.clock.frame - app.openedAt < 3 ? { scrollTo: { top: 0 } } : {});
      else inner();
      if (footer) footer(w);
    }, { width: w, spacing: 10 });
  });
  // A dialog closes on the Escape that opened it unless the close on its opening frame is ignored.
  if (!open && closable && A.clock.frame !== app.openedAt) { A.play("ui-back"); A.closeModal(); }
}
function pauseDialog(): void {
  card("pause", T("Paused"), 380, (w) => {
    ui.column("pause-actions", () => {
      if (ui.id("resume").style("btn-primary").button(T("Resume"))) A.pauseAction("resume");
      if (ui.id("p-settings").style("btn").button(T("Settings"))) A.pauseAction("settings");
      if (ui.id("p-help").style("btn").button(T("Help"))) A.pauseAction("help");
      if (app.mode === "practice" && ui.id("restart").style("btn").button(T("Restart match"))) A.pauseAction("restart");
      if (ui.id("leave").style("btn-danger").button(T("Leave match"))) A.pauseAction("leave");
    }, { spacing: 10, width: w, align: "stretch" });
  });
}
function settingsDialog(): void {
  const o = A.options();
  card("settings", T("Settings"), 880, (w) => {
    const cols = w >= 640 ? 2 : 1;
    const cw = (w - 24 * (cols - 1)) / cols;
    const toggle = (label: string, value: boolean, set: (v: boolean) => void): void => {
      const v = ui.checkbox(label, value);
      if (v !== value) { A.play("ui-press"); set(v); }
    };
    ui.grid("settings-grid", () => {
      ui.column("fs-audio", () => {
        lbl(T("Audio"), "legend");
        toggle(T("Captions for meaningful audio"), o.captions, (v) => platform.setOption("captions", v));
      }, { style: "fieldset", width: cw, spacing: 6 });
      ui.column("fs-display", () => {
        lbl(T("Display"), "legend");
        lbl(T("Visual theme"), "field-label");
        const ti = ui.id("set-theme").select(T("Visual theme"), Math.max(0, THEMES.findIndex((t: Any) => t.id === o.theme)), THEMES.map((t: Any) => T(t.name)));
        if (THEMES[ti] && THEMES[ti].id !== o.theme) { platform.setOption("theme", THEMES[ti].id); A.applySettings(); }
      }, { style: "fieldset", width: cw, spacing: 6 });
      ui.column("fs-access", () => {
        lbl(T("Accessibility"), "legend");
        lbl(T("Color-vision palette"), "field-label");
        const pi = ui.id("set-palette").select(T("Color-vision palette"), Math.max(0, PALETTE_IDS.indexOf(o.palette)), [T("Default"), T("Deuteranopia-safe"), T("Protanopia-safe"), T("Tritanopia-safe")]);
        if (PALETTE_IDS[pi] !== o.palette) { platform.setOption("palette", PALETTE_IDS[pi]!); A.applySettings(); }
        toggle(T("Left-handed controls"), o.leftHanded, (v) => platform.setOption("leftHanded", v));
        toggle(T("Haptics (vibration)"), o.haptics, (v) => platform.setOption("haptics", v));
      }, { style: "fieldset", width: cw, spacing: 6 });
      ui.column("fs-learn", () => {
        lbl(T("Learning"), "legend");
        para(T(A.doc().tutorial.done ? "Tutorial progress: complete." : "Tutorial progress: not finished."), cw - 26);
        if (ui.id("replay-tutorial").style("btn").button(T("Replay tutorial"))) { A.play("ui-press"); app.modals = []; A.startLesson(LESSONS[0]); }
      }, { style: "fieldset", width: cw, spacing: 6 });
    }, { columns: cols, gap: { row: 8, column: 24 }, width: w, align: "stretch" });
    para(T("Sound volumes, graphics quality, frame rate, controls, language, text size, high contrast and reduced motion are in the StarHermit Options (F1)."), w, "small");
  }, (w) => buttonRows("settings-foot", [
    { id: "sh-options", label: T("StarHermit Options"), run: () => openMenu() },
    { id: "done", label: T("Done"), cls: "btn-primary", cue: "ui-back", run: () => A.closeModal() },
  ], w, { justify: "end" }));
}
function keyLabel(action: string): string {
  try { return bindingLabel(action) || "—"; } catch { return "—"; }
}
function helpDialog(): void {
  card("help", T("Captain's Manual"), 880, (w) => {
    heading(T("The loop"), "h3");
    para(T("Secretly place your fleet on the chart, then alternate calling coordinates. A white ring is open water; an orange spear is a hit. Strike every cell of a ship to sink it. Sink the whole enemy fleet to win."), w);
    heading(T("Special rules on some charts"), "h3");
    factTable("rules", [
      [T("Salvo"), T("Fire one shot per surviving ship each turn — protect your numbers.")],
      [T("Shot limit"), T("A fixed allowance for the whole match. Efficiency decides ties.")],
      [T("Mines"), T("Hidden hazard cells. Striking one wastes an extra shot.")],
      [T("Discipline"), T("Ships may not be placed touching side-to-side.")],
      [T("Fog"), T("Sunken ships are not identified — track sizes yourself.")],
    ], w);
    heading(T("Scoring"), "h3");
    para(T("Victory 500 · each hit 25 · each ship sunk 100 · accuracy up to 300 · shots spared 10 each (limited charts) · invalid actions −15. Ties break on objective, fewer invalid actions, then faster time."), w);
    heading(T("Controls"), "h3");
    factTable("controls", [
      [["left", "up", "down", "right"].map(keyLabel).join(" "), T("Move the chart cursor")],
      [keyLabel("confirm"), T("Confirm / fire / place ship")],
      [keyLabel("rotate"), T("Rotate ship (deployment)")],
      [keyLabel("auto_deploy"), T("Auto-deploy fleet")],
      [keyLabel("notes"), T("Toggle note mode (private deductions)")],
      [keyLabel("hint"), T("Hint (where allowed)")],
      [keyLabel("undo"), T("Undo (practice only)")],
      [keyLabel("camera"), T("Reset camera")],
      [keyLabel("pause"), T("Pause / cancel")],
      [T("Gamepad"), T("Stick/D-pad aim · A confirm · B cancel · Start pause")],
      [T("Touch"), T("Tap to select, tap again (or Fire) to commit. Drag the table to shift the camera.")],
    ], w);
  }, (w) => buttonRows("help-foot", [{ id: "help-done", label: T("Done"), cls: "btn-primary", cue: "ui-back", run: () => A.closeModal() }], w, { justify: "end" }), true, T("Help and rules"));
}
function resetDialog(): void {
  card("reset", T("Reset everything?"), 460, (w) => para(T("Journey stars, achievements, dailies and settings will be wiped from this device."), w), (w) => buttonRows("reset-foot", [
    { id: "reset-yes", label: T("Yes, reset"), cls: "btn-danger", run: () => { app.modals = []; A.resetProgress(); } },
    { id: "reset-no", label: T("Cancel"), cue: "ui-back", run: () => A.closeModal() },
  ], w, { justify: "end" }));
}
function handoverDialog(m: Extract<A.Modal, { kind: "handover" }>): void {
  card("handover", T("Pass the chart"), 460, (w) => {
    ui.style("text", { text: { align: "center" } }).paragraph(T("Hand the device to {name}. The fleet positions are secret — no peeking.", { name: m.name }), w);
  }, (w) => buttonRows("handover-foot", [{ id: "ready", label: T("I am {name} — ready", { name: m.name }), cls: "btn-primary", cue: null, run: () => A.handoverReady() }], w), false);
}
function resultsDialog(): void {
  const v = A.resultsView();
  if (!v) return;
  card("results", "", 560, (w) => {
    if (VH >= 560) ui.column("results-art", () => { /* the illustration is the box's background */ }, { width: w, height: Math.min(200, VH * 0.22, w * 9 / 16), style: v.tone === "win" ? "results-win-img" : "results-lose-img" });
    ui.style(v.tone === "win" ? "result-win" : v.tone === "loss" ? "result-loss" : "result-draw").heading(v.headline);
    if (v.stars !== null) ui.id("stars").row(T("{n} of 3 stars", { n: v.stars }), () => ui.style("stars").label("★".repeat(v.stars) + "☆".repeat(3 - v.stars)));
    if (v.challenge) para(v.challenge, w);
    ui.grid(T("Score breakdown"), () => {
      for (const r of v.rows) { lbl(r.label, "text"); ui.style("text", { text: { align: "end" } }).label(`${r.points > 0 ? "+" : ""}${r.points}`); }
      ui.gridRow("score-total").style("score-total-text").label(T("Total"));
      ui.style("score-total-text", { text: { align: "end" } }).label(String(v.total));
    }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: { row: 0, column: 12 }, width: w, rowStyle: "score-row" });
    if (app.lbLine) para(app.lbLine, w, "dim");
    para(v.facts, w, "small");
  }, (w) => {
    const items: Item[] = [{ id: "retry", label: T("Retry"), cls: "btn-primary", cue: null, run: () => A.resultsAction("retry") }];
    if (v.nextStage) items.push({ id: "next", label: T("Next stage"), cue: null, run: () => A.resultsAction("next") });
    items.push({ id: "modes", label: T("Change mode"), cue: null, run: () => A.resultsAction("modes") });
    items.push({ id: "to-title", label: T("Title"), cls: "btn-ghost", cue: null, run: () => A.resultsAction("title") });
    buttonRows("results-foot", items, w, { grow: true });
  }, false, T("Results"));
}
function dialogs(): void {
  const m = A.topModal();
  if (!m) return;
  switch (m.kind) {
    case "pause": pauseDialog(); break;
    case "settings": settingsDialog(); break;
    case "help": helpDialog(); break;
    case "reset": resetDialog(); break;
    case "handover": handoverDialog(m); break;
    case "results": resultsDialog(); break;
  }
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  measureViewport();
  switch (app.screen) {
    case "title": titleScreen(); break;
    case "setup": setupScreen(); break;
    case "journey": journeyScreen(); break;
    case "challenges": challengesScreen(); break;
    case "learn": learnScreen(); break;
    case "lobby": lobbyScreen(); break;
    case "profile": profileScreen(); break;
    case "game": gameHud(); break;
  }
  toasts();
  captionLine();
  dialogs();
}
