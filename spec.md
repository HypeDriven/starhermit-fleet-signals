# Fleet Signals — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today (present tense).
**Version markers:** rules v3 (`RULES_VERSION`), content v1 (`CONTENT_VERSION`), save v2 (`SAVE_VERSION`), replay schema 1.

## 1. Overview

**Pitch.** Hide a fleet on a holographic chart, then read the water: call coordinates, watch the splash or the spear, and deduce where the enemy hulls lie before yours are found.

| | |
|---|---|
| Genre | Hidden-information turn-based naval strategy (secret placement + coordinate fire + deduction) |
| Players | 1 vs deterministic AI (Learn, Journey, Daily, Practice, Challenge); 2–4 humans pass-and-play at one device (Hosted Table) |
| Session | 4 min (6×6 patrol fleet) · 8 min (8×8 standard) · 12 min (10×10 vanguard); Journey stages 1–5 are the short tier |
| Platforms | Desktop and mobile browsers with WebGL; keyboard, mouse, touch and gamepad |
| Rendering | Three.js (`vendor/three.module.js`, ES module import map) draws the chart table, sea and pieces; every menu, HUD, form and overlay is semantic HTML layered over the canvas |

**File map (real files).**

| Path | Responsibility |
|---|---|
| `index.html` | Entry: `<canvas id="scene">`, `#label-layer` (projected A–J / 1–10 labels), `#ui`, live regions, caption line, import map (`three`, `three/addons/`), `<noscript>` |
| `src/main.js` | Boot: WebGL check, save load/migrate, StarHermit init (account nickname, cloud-save mirror + sync status, settings KV, key bindings), audio unlock, visibility pause, `?demo` capture mode, `window.__fleet` test handle |
| `src/rules/engine.js` | Pure rules: fleets, grids, mechanics, `createMatch`, `validatePlacement`, `autoPlaceFleet`, `listLegalActions`, `applyCommand`, scoring, tie-breaks, stars, hashing, serialization/migration, replay envelope |
| `src/rules/ai.js` | Deterministic AI (`chooseCommand`) at easy/medium/hard and the human `suggestTarget` hint |
| `src/rules/rng.js` | FNV-1a `hashString`, Mulberry32 `makeRng` with `fork`, `resumeRng` |
| `src/session/session.js` | `GameSession`: command ids, undo snapshots, AI streams, replay recording, elapsed time, results, serialize/restore |
| `src/content/stages.js` | 5 themes, 40 Journey stages, 8 Challenges, `dailyStage(date)`, `validateStage` |
| `src/content/tutorial.js` | 5 Learn lessons (engine configs + wait-for steps) |
| `src/platform/save.js` | Checksummed localStorage document, v1→v2 migration, `mergeSaves`, local leaderboard, 5 achievements |
| `src/platform/starhermit.js`, `starhermit-sdk.js` | Hosted-platform facade over the shared StarHermit SDK: hosted flag, nickname, cloud-save mirror, settings sync, `DEFAULT_KEYS` bindings, sign-in and invite link |
| `src/render/scene.js` | `FleetScene`: graphics settings (`setGraphics`, `graphicsInfo`), post chain, adaptive resolution, camera poses, procedural hulls (plain and detailed), water shader, particle pool, boards, ambient motion, pointer raycast, cosmetic jobs |
| `src/render/gfx.js` | Pure graphics quality model: presets, categories, `detectPreset`, `resolve`, `choosePreset`, `presetTier`, `describe` |
| `src/audio/audio.js` | WebAudio buses, 22 sampled events with synth fallbacks, procedural music/ambience, caption sink |
| `src/ui/app.js` | `App`: screens, HUD, tray, placement editor, battle input, keyboard/gamepad, results, pause, hotseat handover, resume |
| `src/ui/gfx-i18n.js` | Settings → Graphics strings in 9 locales, `pickGfxLocale` |
| `src/ui/platform-i18n.js` | StarHermit account strings (sign-in, invite, toasts, sign-out notice) in 9 locales |
| `src/ui/styles.css` | Layout, responsive rules, accessibility modes, palette tokens |
| `server.js` | StarHermit authoritative game script (`createSession`, `handleMessage`, `checkDeadline`, `getSnapshot`, `sessionSummary`); doubles as a dev static host when run directly |
| `assets/` | `key-art.webp`, `results-win.webp`, `results-lose.webp` (FLUX.2 klein) |
| `sfx/` | 22 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` (generated) |
| `vendor/addons/` | Three.js r160 (0.160.1) addons: EffectComposer, RenderPass, ShaderPass, OutputPass, GTAOPass, UnrealBloomPass, SMAAPass, FXAAShader, RoomEnvironment and their shader/math dependencies |
| `tests/run.js` | unit/property/fuzz/golden tests (`npm test`, followed by `tests/platform.test.mjs`) · `tests/e2e.mjs` Playwright playthrough · `tests/ai-restart.mjs` AI-pump regression · `tests/smoke.html` legacy in-browser suite |
| `starhermit.txt` | `name=Fleet Signals`, `launch=index.html`, `server=server.js`, `cover=coverart.png` |

## 2. Vision and design pillars

1. **The chart is the truth.** Every fact a player needs — hits, misses, mines struck, wrecks, private notes — lives as a marker on the holographic grid. Rules in: markers are shape-coded (spear, ring, octahedron) and persist until the match ends. Rules out: information hidden in logs only, or anything shown to a player that the engine has not confirmed (`getSnapshot` redacts unsunk enemy cells).
2. **Deduction, not dice.** The only randomness is the seeded mine layout and the AI's cell choice among equally good candidates. Rules in: seed shown on setup and results, hint = the hard AI's own pick, replay envelopes with per-step hashes. Rules out: hidden modifiers, luck-based damage, cosmetic RNG touching rules (`rng.js` forks separate streams).
3. **One ship at a time.** Each mechanic (shot limit, mines, salvo, spacing, fog) is introduced alone in Journey, combined with one known mechanic, then tested at a mastery stage. Rules in: `STAGES` follow the 5-stage cadence with a `mastery: true` capstone every fifth stage. Rules out: stages that stack a new mechanic on top of an untaught one; easy AI on a mastery board (`validateStage` rejects it).
4. **Table-top calm, arcade punctuation.** The scene is a quiet bridge at night; shots are the only loud moments. Rules in: camera moves only between phases via critically damped springs, shake only on hits/sunk/mines, particles capped per tier. Rules out: idle screen shake, continuous VFX, music louder than the sea.
5. **Nothing the bot can't reach.** Every action has a visible button or key and the e2e test plays a full match through them. Rules in: the tray exposes Fire/Note/Hint/Undo/Skip; the Hosted Table works without a network. Rules out: gestures with no button equivalent, hover-only information.

## 3. Player experience

**Target player.** Someone who liked pencil-and-paper coordinate games and wants a modern, short, solo-friendly version with a real progression; secondary: two to four people sharing one phone or laptop.

**First 60 seconds.** Title → Play (one tap) → setup screen listing chart size, fleet, rules, opponent, seed and expected duration → Launch. Deployment opens with the announcement "Deployment phase. Place every ship, then confirm." The tray shows the ship chips with pip lengths, Rotate, Auto-deploy and a disabled Confirm; the first tap on the chart places the first ship, or Auto-deploy fills a legal draft that can be edited by tapping a ship to pick it up. Illegal positions show a red preview and an explanatory toast. After Confirm a 3-2-1 countdown (skipped under reduced motion) leads into "Your turn. Select a coordinate on the target chart." Tapping a cell arms Fire; tapping it again or pressing Fire shoots. Learn mode offers five lessons that require the action to be performed (`tutorial.js`). Hints (H) on the practice board are the hard AI's suggestion, so a stuck player always has a next move.

**Session shape.** Deploy (30–60 s) → alternate shots with animated arcs and splashes (3–10 min) → results overlay with the score breakdown, stars (Journey), challenge verdict, seed and time → Retry / Next stage / Change mode. Daily Signal is one seeded board per UTC day; Journey is 40 stages unlocked in order.

**Emotional beat.** The second hit on the same line: the moment a guess becomes a certainty, marked by the orange spear, the hull clang, the shake, and the fleet rail ticking toward "5/5 sunk".

## 4. Core loop and rules contract (as implemented in `src/rules/engine.js`)

**Entities.** `state = { version, contentId, rulesetId ('duel' | 'skirmish' for >2 players), seed, tick, phase, gridSize, fleet, mechanics, players[], turnOrder, currentPlayerIndex, pendingShots, winner, terminalReason, rngCursor, seenCommandIds, log }`. Each player: `{ id, name, isAI, difficulty, placed, alive, ships[], mines[], shotsFired{targetId:{cell:'hit'|'miss'|'mine'}}, shotsUsed, hitsLanded, invalidActions, notes{targetId:{cell:'flag'|'unknown'}} }`. Cells are `y * gridSize + x`; `cellName` renders `A1`.

**Fleets (`FLEETS`).** standard 5/4/3/3/2 (Sentinel Carrier, Warden Cruiser, Lancer Frigate, Skiff Runner, Dart Scout); compact 4/3/3/2; vanguard 5/4/4/3/2; patrol 3/2/2. Grids 4–12 (`GRID_SIZES` small 6, standard 8, large 10). `createMatch` rejects fleet cells + mines ≥ total cells, <2 or >4 players, duplicate ids, non-string seeds.

**Mechanics (`DEFAULT_MECHANICS`).** `salvo` (one shot per surviving ship per turn, `shotsForTurn`), `moveLimit` (total shots per player), `mineCount` (hidden hazard cells per board, drawn from `rulesStream(seed + ':rules:mines:' + playerId)`), `noTouch` (no orthogonal adjacency at placement), `fog` (sunk events omit `shipId`/`shipName`), `allowUndo` (content flag; see §16).

**Legal actions (`listLegalActions`).** Placement: `place`, `auto-place`, `resign` until placed. Battle, on turn: one `fire` descriptor per living enemy with its untargeted cells, `pass` only when no fire cell exists, plus `annotate` and `resign`. Off turn: `annotate` only. Finished: nothing.

**Resolution order (`applyCommand`).** Validate shape and player → duplicate `cmd.id` returns `{duplicate:true}` without change → dispatch → record id (cap 512) → `tick += 1` (annotate subtracts one, so notes never advance the clock). `cmdPlace` validates via `validatePlacement` (reasons `placement-shape`, `-out-of-bounds`, `-overlap`, `-mine`, `-adjacency`) and `beginBattleIfReady` opens battle once every alive player is placed, advancing past a resigned opening seat. `cmdFire` checks phase, turn, alive, target, bounds, repeat cell (`cell-already-targeted`); then hit/sunk bookkeeping, mine (`shotsUsed += 2` total), elimination when all target ships are sunk, victory when one player remains (`fleet-destroyed`), move-limit exhaustion when every living player is at the cap (`move-limit`, ranked by fully-hit sunk ships → hits → fewer shots), then `pendingShots -= 1` and `advanceTurn` (skips dead and shot-capped players). `cmdResign` removes the seat and finishes with reason `resign` when one remains. Rejected commands increment `invalidActions` on the actor (except unknown target / malformed annotate).

**Scoring (`SCORE_TABLE`, `scoreMatch`).** win 500 · hit 25 each · sunk 100 each (only ships whose every cell the scorer hit) · accuracy `round(300 × hits/shots)` · shots spared 10 each (move-limit charts, winner only) · invalid −15 each. Worked example (desktop e2e run): victory, 17 hits in 41 shots, 5 ships sunk → 500 + 425 + 500 + round(300 × 0.4146 = 124.4) = **1549**. Stars (`starRating`): 0 on loss; 1 for the win, +1 at or under stage `par` shots, +1 at ≥ 60 % accuracy.

**Tie-breaks (`compareResults`).** Higher score → winner over loser → fewer invalid actions → lower elapsed ms → session id string order.

**RNG and seeding.** Practice seeds are `practice-<base36 time>`, hosted `hosted-<time>`, stages and challenges carry fixed seeds, daily is `daily-YYYY-MM-DD`. AI streams derive from `hashState({a: seed, b: playerId})`; the draft Auto-deploy button uses a throwaway stream (`draft-<time>`), the `auto-place` command uses the rules stream so hosted seats and AI placements replay exactly.

**Undo and hints (`GameSession`).** Undo (practice only, when enabled) restores the serialized snapshot taken before the last human command, so one Undo reverts the player's shot and the AI reply. Hint calls `suggestTarget`, the hard AI's `pickCell` with a zero stream (no randomness consumed).

**Replay.** `createReplayEnvelope` / `recordReplayStep` store schema, rules version, seed, initial hash, ordered commands, per-step `{tick, hash}` and the terminal result; `verifyReplay` re-runs and reports the first mismatch index.

## 5. Modes and progression

| Mode | Entry | Opponent / seats | Assists | Ranked | Progress recorded |
|---|---|---|---|---|---|
| Practice (Play) | setup with difficulty select, hint and undo checkboxes | AI easy Rookie Beacon / medium Signal Officer / hard Admiral Cipher | as chosen | no | stats, local board |
| Learn | list of 5 lessons | Instructor (easy) on 6×6 patrol; lessons 2–5 auto-place the player | hints on, no undo | no | `tutorial.step`, `tutorial.done` after lesson 5 |
| Journey | 40-stage grid; stage N+1 unlocks when N is won | per stage `aiDifficulty`, grid, fleet, mechanics, theme, par | none | yes | stars/score/bestShots per stage; `journey-mastery` achievement at 8 three-star mastery stages |
| Daily Signal | one board per UTC day (`dailyStage`) | difficulty from weekday + seed; 8×8 compact/standard or 10×10 standard/vanguard; 0–2 mechanics from salvo/moveLimit/mineCount/fog (never noTouch) | none | yes | `dailies[date]`, streak, `daily-streak-3` |
| Challenge | 8 authored constraints | as authored | none | yes | `challenges.completed[id].score` when the constraint passes (shot cap, accuracy ≥ 55 %, or ≤ 240 s) |
| Hosted Table | lobby: 2–4 named seats, ready toggles | humans only, pass-and-play with privacy handover | none | no | none |

**Difficulty curve.** AI easy = uniform random; medium = orthogonal hunt around unsunk hits, otherwise checkerboard parity; hard = line extension along ≥2 collinear hits, then a placement-density map weighted ×10 through known hits. Journey moves 6×6 patrol (easy) → 8×8 standard with shot limits (55→42) → mines (1–3) → salvo → spacing and fog → 10×10 vanguard, ending with hard AI and three or four stacked mechanics (j36–j40 are all mastery). Par values sit between fleet cells + 8 and 65 % of the grid (`validateStage` warns otherwise).

## 6. Controls and interaction

| Input | Placement | Battle | Everywhere |
|---|---|---|---|
| Tap / click a cell | place selected ship's bow (or pick up a placed ship) | first tap arms the cell (target-lock sound, ring cursor), second tap or Fire commits; in Note mode cycles flag → unknown → clear | — |
| Drag on canvas (>10 px) or press >600 ms | orbit camera (clamped ±0.35 rad yaw, −0.2..0.25 pitch); never a pick | same | reduced motion disables orbit |
| Arrow keys | move cursor and preview | move cursor | — |
| Enter / Space | place at cursor | arm / fire at cursor | activate focused button |
| R | rotate draft ship | — | — |
| A | Auto-deploy draft | — | — |
| N | — | toggle Note mode | — |
| H | — | hint (when assists allow) | — |
| U | — | undo (practice) | — |
| C | reset camera orbit | reset camera orbit | — |
| Esc | open/close pause menu | same | closes pause; other overlays keep their own buttons |
| Gamepad | stick/D-pad moves cursor (180 ms repeat), A picks, B clears selection, Start pauses | same | connection toast |

**Locking.** `inputLocked` is set while the AI thinks (`_pumpAI`), while a fire resolves (`_afterCommand` until the cosmetic job settles or Skip), during handover overlays and after finish; `paused` blocks scene callbacks and keys. Duplicate commits are prevented by command ids, not debounce timers.

**Feedback per input.** Every button: `ui-press`/`ui-back` sample. Cell arm: `select` + green ring; illegal placement: red preview, `invalid` thud and a toast naming the constraint; rejected fire: toast from `_explainInvalid`; hint: sonar ping, cursor jump and toast; haptics (`navigator.vibrate` 10/40 ms) when the viewer's own board is hit and haptics are on.

## 7. Screens and UI flow

`boot → title ⇄ {setup, journey, challenges, learn, lobby, profile, settings, help} → match(placement → countdown → battle ⇄ paused/handover → resolving) → results → {retry, next stage, title}`. Title also offers **Resume Match** when `fleet-signals-resume` holds a snapshot. Settings and Help opened from the pause menu are overlays over the still-mounted match (`_presentScreen`), never re-mounts.

**Desktop (≥1024 px).** `hud-top` (pause, objective title/sub, turn badge), left rail (own fleet with hit pips, enemy summary), right rail (Signals log, last 12 lines), centred chart, bottom tray. Panels max 640 px (880 px wide variant), body text ≤ 70 ch.
**Compact (<1024 px).** Rails become slide-in drawers toggled by ☰ / ≡ buttons in the HUD, capped at 45 vh.
**Portrait mobile.** Tray scrolls horizontally in the thumb zone, objective subtitle hidden; title art strip ≤ 26 vh and results art ≤ 22 vh (hidden entirely under 560 px height).
**Landscape mobile (≤500 px tall).** Rails 190 px, tighter HUD and tray padding.
**Large screens (>1600×1000).** `ui-scale.js` sets `--ui-scale` (min(width/1600, height/1000), capped at 2.5; 2560×1440 → 1.44, 3840×2160 → 2.16); the `#ui` layer, caption line and FPS meter are CSS-`zoom`ed by it with their vw/vh lengths divided by it, so HUD, rails, tray, panels and toasts grow proportionally and the chart is re-fitted inside the larger HUD's safe rectangle; the full-screen canvas and the projected coordinate-label layer are not zoomed — the labels multiply their font size and offsets by the scale instead.
**Safe areas.** `env(safe-area-inset-*)` offsets HUD, rails, tray, caption line and screens. Must never be cut off: the tray (Fire/Confirm), the pause button, the turn badge, the results total and buttons, and the A–J/1–10 labels the label layer projects each frame.

## 8. Art direction

**Hero.** The holographic chart table: a dark steel pedestal (`0x2a3340`) with a glowing rim (theme `holoGrid` body, `holoShip` emissive 0.8) and translucent grid slabs, over a procedural sea (vertex-displaced waves plus up to 8 impact ripples) under 400 seeded stars and 10 red channel buoys (`0xb03a4a`). Camera poses (`CAMERA_POSES`): title (0, 7.5, 10.5), placement (0, 8.8, 5.2), battle (0.6, 9, 7.2), results (0, 10.5, 9).

**Shape language.** Hulls are extruded low-poly plans (tapered bow, deck strip, tower and mast from size 3) sized `0.86 × cells`; with Model detail on, hulls are bevelled with curved bows, vertex-coloured decks, superstructure, bridge glass, funnel, mast and one or two twin-barrel turrets (the size-5 carrier gets a flight deck and an offset island) in a clearcoated physical material; own ships steel grey `0x8a97a8`, drafts and holo ships in the theme's `holoShip`, wrecks charred `0x3a2f2f` with ember emissive `0xff3300`. Markers: hit = four-sided orange spear `0xff7a3c` (emissive 2.0, so it blooms); miss = white ring `0xcfe8ff`; mine = violet octahedron `0xc26bff`; cursor/valid = teal `0x6ff2c8`; invalid = red `0xff5468`.

**Palette (CSS tokens in `styles.css`).** `--accent #59e6ff`, `--bg #0a1626`, `--panel rgba(10,24,40,.88)`, `--panel-solid #0d1c30`, `--text #e8f2fa`, `--text-dim #9db4c6`, `--danger #ff5468`, `--ok #6ff2c8`, `--warn #ffc857`, `--hit #ff7a3c`, `--miss #cfe8ff`. High contrast: accent `#00e5ff` on `#000`, white text, 2 px borders. Colour-vision palettes re-hue hit/miss (deuteranopia `#ffd23c/#7cc7ff`, protanopia `#ffd23c/#9ad5ff`, tritanopia `#ff5ea8/#d8f4ff`) while shapes stay distinct.

**Themes (`THEMES`, per-stage and user-selectable).**

| id | accent / bg / panel / text | waterDeep · waterShallow · sky · fog · holoGrid · holoShip · sun |
|---|---|---|
| abyss-chart (default) | #4fd8e8 / #060d16 / #0c1a26 / #d7e8f0 | #04121e · #0a2e42 · #0a1a2a · #10303f · #1e5f73 · #63e2f2 · #b8e6f0 |
| ember-drift | #f0a24a / #140b06 / #241408 / #f2e2cc | #1a0e06 · #3a2210 · #241206 · #2e1a0c · #7a4a1e · #ffb45e · #ffd9a0 |
| verdant-sonar | #5ee08a / #071008 / #0f2012 / #dcf2e0 | #06170c · #0e3520 · #0a2012 · #12301e · #2e7a4a · #7bf2a6 · #d8f2b0 |
| umbral-violet | #b58af0 / #0d0816 / #1a1030 / #e6dcf5 | #120a24 · #2a1a4a · #170e2e · #241640 · #5a3a9a · #c9a2ff · #e8d8ff |
| glacier-front | #7ec8f0 / #0b141c / #14242e / #e2eef4 | #0e2230 · #2a4a5e · #33505f · #9fb8c4 · #4a8aa8 · #a8e0f8 · #f0f8ff |

**Typography.** System stack ("Segoe UI", system-ui, -apple-system); title 2.6 rem tracked 0.08 em with an accent glow; `--font-scale` 1.25 under Larger text.

**Lighting.** ACES filmic tone mapping, exposure 1.18, sRGB output (the water, particle and sonar shaders include the tone-mapping and colour-space chunks, and the water takes scene fog); one warm directional key (`0xfff2dd`, 2.6) whose PCF soft shadow box is fitted to the table and both boards, plus a hemisphere fill (`0x8fb7d9` / `0x1a2433`); fog and `scene.background` take the theme's `fog`.

**Graphics.** Optional effects: key-light shadows from ships and markers onto the table and grid slabs; GTAO ambient occlusion for contact darkening; bloom limited to emissive highlights (threshold 0.86: the table rim, hit spears, mines, shell tracer, shot sparks and buoy lamps); a colour grade (gentle S-curve, +10 % saturation, cool shadows / warm highlights) with a vignette; FXAA, SMAA or a 4× multisampled target; image-based reflections from a PMREM-filtered `RoomEnvironment` (`envMapIntensity` 0.32 scaled per material); detailed sea (144 segments, two-layer chop on the normal for glitter, a broad sheen and the table's cyan glow on the swell) or simple sea (48 segments); particles low (600-point pool) or high (3200, plus sparks and slow embers on hits and fine spray on misses); ambient motion (a sonar sweep across the chart, bobbing buoys with blinking lamps, breathing grid lines, smouldering wrecks — stopped under reduced motion); model detail (detailed hulls, an engraved chart overlay with range rings, bearing ticks and N/E/S/W, brushed-metal pedestal). Settings → **Graphics** offers Quality (Auto (detected: <tier>), Low, Balanced, High, Ultra; Auto comes from the WebGL unmasked renderer: software renderers such as SwiftShader/llvmpipe get Low, discrete GPUs and Apple M-series get High, others Balanced, and touch/mobile devices are capped at Balanced), a render scale slider (50–200 % of the preset's scale), one select per effect — Shadows (off/low/medium/high = 0/1024/2048/4096 map), Ambient occlusion (off/on/high), Bloom, Color grade, Anti-aliasing (off/FXAA/SMAA/MSAA), Reflections, Sea detail, Particles, Ambient motion, Model detail — each defaulting to "From preset (<tier>)", Adaptive resolution (on by default: over 90-frame windows, average > 26 ms steps the scale down 0.1 to a floor of 0.6, < 14 ms steps back up 0.05 to 1) and Show frame rate (a `#fps-meter` readout, pointer-events none, mid-left on compact layouts and above the tray on desktop), plus a summary line "GPU · cost summary · W×H px" and a note when post-processing is unavailable. Presets: Low = scale 0.85, DPR cap 1, everything off, simple sea, low particles, still background, plain models (the composer is skipped, so Low costs what the old low tier did); Balanced = DPR 1.5, 1024² shadows, bloom, grade, FXAA, reflections, detailed sea/particles/motion/models; High = DPR 2, 2048² shadows, GTAO, SMAA; Ultra = scale 1.25, 4096² shadows, high-quality GTAO, MSAA. Choosing a preset clears the per-effect overrides (render scale and toggles stay). Changes apply live (shadow map, materials recompiled, water and particle pools rebuilt, ships re-synced for the hull set, post chain rebuilt on the next frame) and persist in the save document as `settings.graphics`; a save from before the panel maps its old `qualityTier` onto a preset once. The canvas and `<body>` carry `data-gfx-preset`. Pixel ratio = min(devicePixelRatio, preset cap) × preset scale × render scale × adaptive scale. If the post chain throws, the game renders directly and the panel shows the note; the renderer never logs to the console.

**Motion.** Camera: critically damped springs (k = 42), interruptible; shot: 0.55 s parabolic projectile then particles (26 miss / 55 hit / 70 mine / 90 sunk, additive points), a water ripple and tiered shake (0.55 hit, 1.0 sunk/mine). Skip ▸▸ settles every job. Reduced motion: no countdown, 0.12 s shots, no shake, no orbit gesture, instant camera cuts, CSS animations at 0.01 ms. Quality is governed by the Graphics presets (see **Graphics** above).

**Visual assets the design calls for.** Title key art of the chart table on the bridge (`assets/key-art.webp`, shown as a strip above the title), victory and defeat results illustrations (`assets/results-win.webp`, `assets/results-lose.webp`), a 16:9 cover (`coverart.png`, built from the key art). Hulls, table, sea and markers remain procedural by design so every fleet size and theme stays consistent; no 3D model import is used.

## 9. Audio direction

**Mix.** Four gain buses into a master mute: `music` (default 0.7, currently silent — see §16), `effects` 0.9, `ambience` 0.6, `voice` 0.8. Every event has a procedural WebAudio fallback; the Opus sample is preferred once decoded (`SAMPLE_EVENTS`, lazy fetch after the first gesture). Ambience starts on the first pointer/key event: a filtered brown-noise sea bed with 6–12 s swells, replaced by the looped `sea-ambience.opus` crossfaded in over 2.5 s once decoded. Captions (`[impact — hit]` etc.) go to `#caption-line` when enabled. Hidden tab suspends the context.

**SFX event table (source of `sfx/manifest.txt`).**

| event id | file | sound | usage |
|---|---|---|---|
| ui-press | ui-press.opus | crisp plastic key click with a soft blip | every confirm button, target picker, note toggle |
| ui-back | ui-back.opus | muted lower tap | Back/Done, opening pause, undo |
| invalid | invalid-action.opus | two dull wooden knocks | illegal placement, rejected fire/annotate, lobby not ready |
| place | ship-place.opus | metal model ship clunk with latch | ship dropped, auto-deploy draft, `placed` event |
| rotate | rotate-tick.opus | single ratchet tick | Rotate, picking a ship back up |
| fire | torpedo-fire.opus | pressurised burst and rising whoosh | player's fire accepted |
| splash | splash-miss.opus | plunge and settling water | shot result miss |
| hit | hull-hit.opus | metallic clang over a boom | shot result hit |
| sunk | ship-sunk.opus | explosion, groaning metal, bubbles | shot result sunk |
| mine | mine-detonation.opus | harsh underwater detonation | shot result mine |
| turn | turn-chime.opus | two rising glass notes | local player's turn begins |
| countdown | countdown-blip.opus | single electronic ping (variant 3/2/1 pitch ladder in synth) | 3-2-1 overlay |
| victory | victory-fanfare.opus | five-note brass and bell flourish | results, viewer or hotseat winner |
| defeat | defeat-motif.opus | descending muted horns | results loss/draw, `resigned` event |
| lesson-done | lesson-complete.opus | two ascending mallet notes | Learn objective met |
| achievement | achievement-sparkle.opus | crystalline glissando | achievement unlock toast |
| ambience | sea-ambience.opus (12 s loop) | night swell, water on a steel hull, low wind | ambience bus bed |
| battle-start | battle-stations.opus | klaxon blast then ship's bell | `_beginBattle` after the countdown |
| select | target-lock.opus | sonar blip with a switch click | arming a target cell |
| hint | sonar-hint.opus | pure sonar ping with echo tail | Hint highlights a coordinate |
| eliminated | fleet-eliminated.opus | slow explosion into groaning collapse | `eliminated` event (a fleet's last ship) |
| handover | chart-handover.opus | paper chart slid and set down | Hosted Table "Pass the chart" overlay |

## 10. Localization

The Settings → **Graphics** section is localized in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT (`src/ui/gfx-i18n.js`, locale from `navigator.language`, exact tag then language fallback, default en-US); its technical cost summary stays in English. The StarHermit account entries (sign-in, invite, their toasts and the sign-out notice) are localized the same way in `src/ui/platform-i18n.js`. Everything else ships in **US English** only, authored inline in `src/ui/app.js` (screens, toasts, announcements), `src/content/stages.js` (stage names and briefings), `src/content/tutorial.js` (lessons), `src/rules/engine.js` (ship names, log lines) and `src/platform/save.js` (achievement copy). There is no locale table, no language selector, and `<html lang="en">` is fixed. Layout allowances that already exist for expansion: flex-wrapping menu rows and tray, 70 ch paragraph cap, `--font-scale` 1.25 mode, horizontally scrolling tray on portrait phones, 18-character name inputs. Shipping en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT is design intent, not implemented (§16).

## 11. Accessibility

- **Keyboard-only path.** Title → Play → Launch (Tab/Enter), A to auto-deploy, Tab to Confirm, arrows + Enter to fire, H for hints, Esc for pause; every overlay focuses its first control and `closeOverlay` restores the previous focus. `:focus-visible` is a 3 px amber outline.
- **Screen reader.** `#live-polite` announces phase changes, turn, each shot ("You fire at C4 — a hit."), notes and hints; `#live-assertive` announces errors, sunk ships, eliminations and the result headline. Screens carry `role="main"` labels, the tray is a toolbar, stage cells and seats have explicit `aria-label`s, toggles use `aria-pressed`.
- **Captions.** Settings → "Captions for meaningful audio" shows the caption line above the tray for every sound, music and ambience change.
- **Contrast and colour.** Text `#e8f2fa` on `#0a1626`; High contrast mode goes to pure black/white with 2 px borders; three colour-vision palettes; hit/miss/mine also differ by shape and label.
- **Motion.** Reduced motion honours `prefers-reduced-motion` on first boot and the toggle thereafter (see §8).
- **Targets.** Buttons, inputs and chips are ≥ 44 px tall; tray gap 8 px; Left-handed mirrors the tray and drawer sides.
- **Other.** Larger text (×1.25), haptics toggle, tutorial replay from Settings, no audio-only information.

## 12. StarHermit integration

Conventions follow https://wiki.starhermit.com/. `src/platform/starhermit.js` is a thin facade over the shared client `starhermit-sdk.js` (loaded by `index.html` before the game modules; `main.js` calls `StarHermit.init()` before anything else). Without a launch token the game makes no network request.

| Feature | Status in this build |
|---|---|
| Manifest / launch | `starhermit.txt` with `name`, `launch=index.html`, `owner`, `server=server.js`, `cover`, and one `control.<action>` line per keyboard action |
| Launch / auth | Hosted mode activates iff the SDK reads `#game_token=<jwt>[&session_id=]` (library launch) or `#access_token=<jwt>` (sign-in return); the fragment is stripped, `sub` / `game_scope` give the player and slug (never hard-coded), every call is same-origin with `Authorization: Bearer`, and the SDK renews the token before expiry. If renewal is refused the game toasts that progress keeps saving on this device, the profile shows Offline, and the title re-offers sign-in where available |
| Sign-in | On `<slug>.starhermit.com` without a token the title shows **Sign in with StarHermit** (SDK redirect); hidden when signed in and when running locally |
| Identity / profile | Hosted: profile nickname (`Player <id>` fallback; never `/api/v1/me`, never usernames) on the profile screen, adopted as the default local display name; offline: local guest profile only (`profile.name`, 18 chars) |
| Invite link | Hosted: the title shows **Invite a friend**, copying the SDK share link to the clipboard with a toast |
| Cloud save | Hosted: slot `game:<slug>` (`/api/v1/me/cloud-saves/game:<slug>`): slot info checked at boot, remote-preferred merge via `mergeSaves`, an empty slot is seeded from the local doc, ~2 s debounce + `pagehide`/hidden flush, sync status on the profile screen; localStorage stays the offline cache |
| Settings sync | Hosted: volumes, mute, graphics, reduced motion, high contrast, palette, larger text, left-handed, haptics, hold-to-confirm, captions, camera view and theme are patched into the settings KV (same keys as `save.settings`) whenever a persist changes them; at boot platform values are applied over local defaults |
| Controls | Keyboard input is routed by `KeyboardEvent.code` through `StarHermit.loadBindings(DEFAULT_KEYS)`: `cursorLeft/Right/Up/Down`, `confirm`, `rotate`, `autoDeploy`, `notes`, `hint`, `undo`, `camera`, `pause`; Help lists the effective keys |
| Leaderboards | local board in the save doc (score-desc, cap 100, with ruleset, content version, seed, assists, duration); clients never submit scores |
| Achievements | 5 static keys unlocked idempotently in the local save: `first-victory`, `sharpshooter`, `daily-streak-3`, `journey-mastery`, `long-voyage` |
| Game script | `server.js` exports an authoritative session API (membership check, 4096-byte payload cap, 20 msgs / 10 s rate limit, idempotent command ids, 24 h turn deadlines with auto-resign, redacted `getSnapshot`, `sessionSummary`, result `{winner, reason, scores, finishedAt}`) used by the unit tests and the dev host; it is an ES module importing the rules engine, not a Jint `globalThis.game` script, so no platform session runs it |
| Sessions / matchmaking / invites / chat / replays / voice | not used: there is no platform game script to run online matches; Hosted Table is local pass-and-play |
| Server time / telemetry / presence | not used: Daily Signal uses the local UTC clock and nothing is sent |

## 13. Technical architecture

- **Module contract.** Nothing mutates rules state except `applyCommand` via `GameSession.command`; `FleetScene.syncFromState` is the only path that sets board contents, and the UI re-syncs after every cosmetic job. UI state (`selectedCell`, `annotateMode`, drawers) is separate from match state.
- **Determinism.** Same seed + command list ⇒ identical `hashState` (property-tested over 20 games); `rngCursor` keeps rules-stream calls order-stable; visual decoration uses `visualSeed 'fleet-signals-v1'`.
- **Persistence.** `localStorage['fleet-signals-save']` (v2, FNV-1a checksum, migrated from v1, reset to defaults with `corrupted:true` on any mismatch) and `localStorage['fleet-signals-resume']` (serialized `GameSession` written after placement, every shot and undo; cleared on finish).
- **Performance.** DPR capped per Graphics preset (1 / 1.5 / 2 / 2), render scale 0.85 on Low and 1.25 on Ultra, adaptive resolution, composer only when an effect needs it, sea 48 or 144 segments, particles 600 or 3200, instanced grid lines and buoys, explicit disposal on `buildBoards`/`clearShips`, rendering and audio paused when the tab is hidden, WebGL context loss/restore handled.
- **Server hosting.** `PORT=<n> node server.js` serves the folder with MIME types for js/css/webp/png/svg/opus/glb (its legacy `/api/v1/time` and 204 `/api/*` answers are no longer called by the client).
- **Test hooks.** `window.__fleet = { app, scene, platform }` for synchronisation only; `app.aiDelay` pacing knob; `?demo` boots a deterministic mid-battle scene for captures.

## 14. Testing and acceptance criteria

**`npm test` (`tests/run.js`, then `tests/platform.test.mjs`).** Graphics model: `detectPreset` on sample GPU strings (SwiftShader/llvmpipe → Low, GeForce/Apple M → High, Intel/Adreno → Balanced, mobile cap), `resolve` with preset/override/invalid override/scale clamp, `choosePreset` clearing overrides, legacy tier mapping, Graphics strings present in all 9 locales. RNG determinism and forks; platform adapter on the real SDK with a stubbed fetch (token read and URL scrub, nickname and fallback, `game:<slug>` save round-trip and status, settings apply/patch-on-change, key bindings, sign-out, sign-in offer, zero requests standalone); placement acceptance, overlap, bounds, noTouch, mine, double placement, auto-place legality on every stage config; fire hit/sunk/elimination/victory, not-your-turn, duplicate cell, bounds, self/dead target, mine cost, move-limit winner, salvo shots, fog identity, resign; annotate tick invariance; legal actions per phase and 3-player skirmish; placement-phase resignation deadlocks; score breakdown sums, tie-break order, stars; replay property (20 games), envelope tamper detection, serialization round-trip, v1/v2 migration, duplicate id idempotence; 4000-command fuzz; all 40 stages + 8 challenges validate, validator rejects illegal stage, daily determinism; AI termination at all difficulties and hard beats easy over 6 seeds; session results/undo/restore/hint; server lifecycle, redaction, duplicates, deadline; golden hashes for easy/medium/hard scripted sessions.

**`tests/e2e.mjs` (Playwright + system Chrome, `PORT` optional).** Desktop 1280×800 and mobile 390×844 touch passes: title → settings (reduced motion, deuteranopia palette applied) → practice setup (easy) → Auto-deploy + Confirm → first shot via H + Fire → Undo restores shotsUsed 0 → Note mode via keyboard → pause/resume, pause → help → done → resume, Esc toggling → battle played to a terminal result via hint + Fire → results rows ≥ 3 and save doc persisted → title. Hosted pass: add/drop/add seats keeps unique ids and starts a 3-seat match. The standalone passes assert no `/api` request; a signed-in pass (390×844, `#game_token=` with mocked platform routes) checks the token left the URL, synced music volume, sign-in hidden, the invite link copied through the visible title button, Help showing a platform rebinding, the nickname on the profile screen and the empty cloud slot seeded with a `game:<slug>` PUT. A Graphics step (both viewports) checks that Auto resolves to Low on the software GPU, switches Low → High through the panel (summary shows SMAA, composer built), overrides Shadows to Off (shadow map disabled), turns on the frame-rate readout, checks no control overflows the viewport, reloads and confirms preset, override and toggle persisted, switches to Ultra, then back to Auto (overrides cleared). Any `pageerror`, console error or console warning fails the run.

**QA bar (checkable).** All modes reachable from the title; no console errors or warnings in either viewport; Fire/Confirm/pause/turn badge visible without scrolling at 390×844 and 1280×800; every implemented setting changes observable state; a new player is told what to do on every phase transition (announcements + tray labels + lesson toasts); every asset in §15 loads with HTTP 200 (`tools/audit_game_assets.py` PASS).

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675) | StarHermit cover | FLUX.2 klein key art seed 7901 + ffmpeg title/tagline | generated in this pass (replaced placeholder) |
| `assets/key-art.webp` (1280×720, 48 KB) | title strip | FLUX.2 klein seed 7901, 28 steps | generated in this pass, wired |
| `assets/results-win.webp` (1024×576, 42 KB) | results art on victory | FLUX.2 klein seed 7902 | generated in this pass, wired |
| `assets/results-lose.webp` (1024×576, 21 KB) | results art on defeat/draw | FLUX.2 klein seed 7903 | generated in this pass, wired |
| `icon.png`, `favicon.svg` | touch icon, tab icon | authored | shipped |
| `vendor/three.module.js` | renderer | Three.js r160 (0.160.1) | shipped |
| `vendor/addons/**` | post-processing passes, shaders, `RoomEnvironment` | Three.js 0.160.1 `examples/jsm` (same revision as the core) | shipped |
| `sfx/*.opus` (16 originals: ui-press, ui-back, invalid-action, ship-place, rotate-tick, torpedo-fire, splash-miss, hull-hit, ship-sunk, mine-detonation, turn-chime, countdown-blip, victory-fanfare, defeat-motif, lesson-complete, achievement-sparkle) | event samples | MOSS-SoundEffect v2, 100 steps | shipped, wired |
| `sfx/sea-ambience.opus`, `battle-stations.opus`, `target-lock.opus`, `sonar-hint.opus`, `fleet-eliminated.opus`, `chart-handover.opus` | new events (§9) | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| 3D models / character animation | — | — | none by design (procedural hulls, no humanoid) |

## 16. Known limitations

- **English only** apart from the Settings → Graphics section; full nine-locale localization is intent (§10).
- **Hosted Table is local.** `server.js` implements the authoritative script and a dev static host but no WebSocket/REST transport, invitations, reconnect over a network or remote result reconciliation; "reconnect" today means Resume from the title screen.
- **Stage `allowUndo` is not honoured.** Journey stage 4 ("Ink on the Chart") advertises undo, but `startMatch` enables undo only in Practice. Hints are likewise available only in Practice and Learn.
- **Settings stored but inert:** `holdToConfirm`, `cameraView`, `avatar`; the `music` bus never plays because `startMusic` is not called; the `voice` bus has no content.
- `tutorialFlags` on stages are data only; in-stage first-time hints come from the objective text and tray, not per-flag prompts.
- Toasts stack at the top centre and can overlap the results art on phones when several fire in quick succession (rapid hint use).
- Rendering fidelity and audio are not assessed by automation (SwiftShader, no gesture in headless Chrome); e2e verifies absence of errors only.
- Score submission and remote leaderboards do not exist, so impossible-score rejection is not applicable.

**Design intent not yet implemented.** Full localization; online Hosted Table through the StarHermit session API with the existing `server.js` contract; adaptive music stems on the music bus; honouring `allowUndo` from stage content; hold-to-confirm for Resign/Reset.

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.
