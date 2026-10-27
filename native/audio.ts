// Sound, as the browser build's src/audio/audio.js: the 21 authored
// one-shots (sfx/<name>.opus, sfx/manifest.txt) per game event and the
// looped night-sea bed (sfx/sea-ambience.opus) from the first press, with a
// caption for every cue (Settings › Captions) so no cue is audio-only.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes and the mute): effects and ambience → "effects", the button
// clicks → "interface"; music and voice carried nothing (the music bus was
// never started, spec Known limitations). The old default bus levels
// (effects 90 %, ambience 60 %) are folded into each sound's gain. The
// synthesized stand-ins the browser build played while a clip decoded are
// not ported (a live synthesis graph makes clip loads fail on the engine's
// web runtime; the arrow-exodus port's finding), so a clip still loading is
// silent. Clips load once the mixer runs (natively at once, in a browser
// after the first press), one at a time.
import { context, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";

export type Cue =
  | "ui-press" | "ui-back" | "invalid" | "place" | "rotate" | "fire" | "splash" | "hit" | "sunk" | "mine" | "turn"
  | "countdown" | "victory" | "defeat" | "lesson-done" | "achievement" | "battle-start" | "select" | "hint"
  | "eliminated" | "handover";
const SAMPLES: Record<Cue, string> = {
  "ui-press": "ui-press", "ui-back": "ui-back", invalid: "invalid-action", place: "ship-place", rotate: "rotate-tick",
  fire: "torpedo-fire", splash: "splash-miss", hit: "hull-hit", sunk: "ship-sunk", mine: "mine-detonation",
  turn: "turn-chime", countdown: "countdown-blip", victory: "victory-fanfare", defeat: "defeat-motif",
  "lesson-done": "lesson-complete", achievement: "achievement-sparkle", "battle-start": "battle-stations",
  select: "target-lock", hint: "sonar-hint", eliminated: "fleet-eliminated", handover: "chart-handover",
};
/** audio.js SAMPLE_EVENTS captions (translated where they are drawn). */
export const CAPTIONS: Record<Cue, string> = {
  "ui-press": "[ui press]", "ui-back": "[ui back]", invalid: "[invalid action]", place: "[ship placed]", rotate: "[rotate]",
  fire: "[shot fired]", splash: "[splash — miss]", hit: "[impact — hit]", sunk: "[ship sunk]", mine: "[mine detonated]",
  turn: "[your turn]", countdown: "[countdown]", victory: "[victory fanfare]", defeat: "[defeat]",
  "lesson-done": "[lesson complete]", achievement: "[achievement unlocked]", "battle-start": "[battle stations]",
  select: "[target selected]", hint: "[sonar hint]", eliminated: "[fleet destroyed]", handover: "[pass the chart]",
};
const AMBIENCE = "sea-ambience";
const GAIN = { effects: 0.9, ambience: 0.6 };
const INTERFACE = new Set<Cue>(["ui-press", "ui-back"]);

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
let ambience: Sound | null = null;
let captionHook: ((text: string) => void) | null = null;
/** fn(text) for each cue's caption. */
export function onCaption(fn: (text: string) => void): void { captionHook = fn; }

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** Plays a cue's sample (once loaded) and shows its caption. */
export function play(name: Cue): void {
  captionHook?.(CAPTIONS[name]);
  const file = SAMPLES[name];
  const clip = clips.get(file);
  if (!clip || suspended) return;
  const bus: Bus = INTERFACE.has(name) ? "interface" : "effects";
  try { playClip(clip, { bus, gain: GAIN.effects }); }
  catch { clips.delete(file); load(file); } // a clip the mixer lost: load it again
}

/** A hidden window: the sea bed holds (audio.js suspend). */
export function setSuspended(on: boolean): void {
  suspended = on;
  if (on) { try { ambience?.stop(); } catch { /* gone */ } ambience = null; }
}

/** Each frame: the clips once the mixer runs (one at a time, the sea bed first), then the bed's loop. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    load(AMBIENCE);
    for (const name of Object.values(SAMPLES)) load(name);
    return;
  }
  pump();
  if (suspended || ambience) return;
  const amb = clips.get(AMBIENCE);
  if (!amb) return;
  try {
    ambience = playClip(amb, { bus: "effects", gain: GAIN.ambience, loop: true });
    captionHook?.("[sea ambience]");
  } catch (e) { console.warn(`ambience: ${String(e)}`); }
}
