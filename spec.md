# Fleet Signals — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today (present tense), a StarHermit engine script game pinned to engine 1.19.1 (host API 1.21, `engine.minor=19`).
**Version markers:** rules v3 (`RULES_VERSION`), content v1 (`CONTENT_VERSION`), save v2 (`SAVE_VERSION`), replay schema 1.

## 1. Overview

**Pitch.** Hide a fleet on a holographic chart, then read the water: call coordinates, watch the splash or the spear, and deduce where the enemy hulls lie before yours are found.

| | |
|---|---|
| Genre | Hidden-information turn-based naval strategy (secret placement + coordinate fire + deduction) |
| Players | 1 vs deterministic AI (Learn, Journey, Daily, Practice, Challenge); 2–4 humans pass-and-play at one device (Hosted Table) |
| Session | 4 min (6×6 patrol fleet) · 8 min (8×8 standard) · 12 min (10×10 vanguard); Journey stages 1–5 are the short tier |
| Platforms | The StarHermit client (native) and browsers through the engine's web runtime (`index.html` loader); keyboard, mouse, touch and gamepad |
| Rendering | `starhermit:scene` (three.js-like) draws the chart table, sea and pieces; every menu, HUD, form and overlay is `starhermit:ui` (immediate mode) over the scene, styled from `assets/ui-style.json` |

**File map (real files).**

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, `server=score-script.js`, `cover=cover.jpg`, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.19.1`, `engine.minor=19`, `engine.capabilities=platform,storage,clipboard`, `control.*` + `engine.gamepad.*` for every action, `engine.group.*` headings |
| `index.html`, `starhermit-files.json` | The engine's web loader (pins engine 1.19.1 on wiki.starhermit.com by hash) and the package file index, both written by `npm run package` (`starhermit package --web .`); never edited by hand |
| `native/main.ts` | Entry: start-up (language, styles, platform, look, sounds), the fixed 60 Hz game clock, key/pad actions, pointer and touch on the chart (tap = pick, drag = orbit), the frame loop |
| `native/app.ts` | Controller (the browser build's `App` without its DOM): screens, match lifecycle (placement editor, countdown, battle, AI pump, hot-seat handover, lessons, results, progression, achievements, local board, leaderboard post, resume), toasts/captions/announcements; timers on the game clock |
| `native/screens.ts` | Every screen, dialog and the match HUD on `starhermit:ui` (title, setup, Journey, Challenges, Learn, Hosted Table lobby, profile, pause, settings, help, reset, handover, results; top bar, rails/drawers, tray, countdown, toasts, captions, the chart's A–J / 1–10 labels and note marks) |
| `native/render.ts` | The 3D scene: table, sea (WGSL water), sonar sweep (WGSL), stars, buoys, holo grids, procedural hulls, markers, draft/preview hulls, particle pools, shot arcs, ripples, camera poses/springs/orbit/top-down/shake, picking, post effects per graphics level |
| `native/quality.ts` | The runtime's quality tier (`frame().quality`) and level → the old presets' effect table and per-preset budgets |
| `native/audio.ts` | The 21 one-shot clips and the looped sea bed (`starhermit:audio`), captions per cue |
| `native/platform.ts` | Save document in `saves` (account-synced, merged on conflicts, the browser build's foreign cloud save migrated), match snapshot in device `storage`, game options in `settings` (legacy account keys migrated), player/invite link, server clock, high-score posting through `score-script.js` |
| `native/i18n.ts`, `native/style.ts` | Language from the runtime's interface language; the converted style sheet, theme tokens and colour-vision palettes |
| `src/rules/engine.js` | Pure rules: fleets, grids, mechanics, `createMatch`, `validatePlacement`, `autoPlaceFleet`, `listLegalActions`, `applyCommand`, scoring, tie-breaks, stars, hashing, serialization/migration, replay envelope |
| `src/rules/ai.js` | Deterministic AI (`chooseCommand`) at easy/medium/hard and the human `suggestTarget` hint |
| `src/rules/rng.js` | FNV-1a `hashString`, Mulberry32 `makeRng` with `fork`, `resumeRng` |
| `src/session/session.js` | `GameSession`: command ids, undo snapshots, AI streams, replay recording, elapsed time (on an injected clock, `setSessionClock`), results, serialize/restore |
| `src/content/stages.js`, `src/content/tutorial.js` | 5 themes, 40 Journey stages, 8 Challenges, `dailyStage(date)`, `validateStage`; 5 Learn lessons |
| `src/platform/save.js`, `src/platform/options.js` | Checksummed v2 save document, v1→v2 migration, `mergeSaves` / `combineSaves`, local board, 5 achievements; the foreign-save reader, `mergeDocs`, the game options and the browser build's settings keys |
| `src/i18n/strings.js`, `strings-content.js`, `core.js`, `src/ui/platform-i18n.js` | Translation tables (9 locales), the lookup (`createI18n`, `matchLocale`), the account strings |
| `tools/ui-style.css` → `assets/ui-style.json` | The old `styles.css` rewritten class-based, converted with `npm run css` (`starhermit css`) |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished ranked match's total and posts it to the `high-score` leaderboard (canonical copy in the games repo's `tools/score-script.js`) |
| `server.js` | Authoritative session module (`createSession`, `handleMessage`, `checkDeadline`, `getSnapshot`, `sessionSummary`) used by the unit tests; a dev static host when run directly (not packaged) |
| `assets/` | `key-art.webp`, `results-win.webp`, `results-lose.webp` (FLUX.2 klein), `ui-style.json` |
| `sfx/` | 22 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` (generated) |
| `tests/` | `run.js` (rules/content/session/server), `save.test.mjs`, `i18n.test.mjs`, `native.mjs` + `native/*.play` (engine checks) |
| `tools/` | `package-web.mjs`, `css.mjs`, `gen-plays.mjs` (play scripts from the rules), `browser-play.mjs` (GPU browser check) |

## 2. Vision and design pillars

1. **The chart is the truth.** Every fact a player needs — hits, misses, mines struck, wrecks, private notes — lives as a marker on the holographic grid. Rules in: markers are shape-coded (spear, ring, octahedron) and persist until the match ends. Rules out: information hidden in logs only, or anything shown to a player that the engine has not confirmed (`getSnapshot` redacts unsunk enemy cells).
2. **Deduction, not dice.** The only randomness is the seeded mine layout and the AI's cell choice among equally good candidates. Rules in: seed shown on setup and results, hint = the hard AI's own pick, replay envelopes with per-step hashes. Rules out: hidden modifiers, luck-based damage, cosmetic RNG touching rules (`rng.js` forks separate streams).
3. **One ship at a time.** Each mechanic (shot limit, mines, salvo, spacing, fog) is introduced alone in Journey, combined with one known mechanic, then tested at a mastery stage. Rules in: `STAGES` follow the 5-stage cadence with a `mastery: true` capstone every fifth stage. Rules out: stages that stack a new mechanic on top of an untaught one; easy AI on a mastery board (`validateStage` rejects it).
4. **Table-top calm, arcade punctuation.** The scene is a quiet bridge at night; shots are the only loud moments. Rules in: camera moves only between phases via critically damped springs, shake only on hits/sunk/mines, particles capped per tier. Rules out: idle screen shake, continuous VFX, music louder than the sea.
5. **Nothing the bot can't reach.** Every action has a visible button or key and the play scripts (tests/native) play a full match through them. Rules in: the tray exposes Fire/Note/Hint/Undo/Skip; the Hosted Table works without a network. Rules out: gestures with no button equivalent, hover-only information.

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

**Scoring (`SCORE_TABLE`, `scoreMatch`).** win 500 · hit 25 each · sunk 100 each (only ships whose every cell the scorer hit) · accuracy `round(300 × hits/shots)` · shots spared 10 each (move-limit charts, winner only) · invalid −15 each. Worked example (a desktop run): victory, 17 hits in 41 shots, 5 ships sunk → 500 + 425 + 500 + round(300 × 0.4146 = 124.4) = **1549**. Stars (`starRating`): 0 on loss; 1 for the win, +1 at or under stage `par` shots, +1 at ≥ 60 % accuracy.

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

Actions are the manifest's (`control.<action>` with default keys, `engine.gamepad.<action>` with pad defaults); players rebind them in the runtime's Options › Controls. The browser build's action names (`cursorLeft`, `autoDeploy`, …) were not lower-case, so keys rebound in the old build start from these defaults.

| Action (key / pad) | Placement | Battle | Elsewhere |
|---|---|---|---|
| Tap / click a cell | place the selected ship's bow (or pick up a placed ship) | first tap arms the cell (target-lock sound, ring cursor), second tap or Fire commits; in Note mode cycles flag → unknown → clear | — |
| Drag on the chart (>10 px) or press >600 ms | orbit camera (clamped ±0.35 rad yaw, −0.2..0.25 pitch); never a pick | same | reduced motion disables orbit |
| `left/right/up/down` (arrows; D-pad / left stick) | move cursor and preview | move cursor | — |
| `confirm` (Enter, Space, Numpad Enter; South) | place at cursor | arm / fire at cursor | a focused widget takes it |
| `cancel` (Backspace; East) | — | clear the armed cell | — |
| `rotate` (R; North) | rotate draft ship | — | — |
| `auto_deploy` (A; Select) | Auto-deploy draft (focus then moves to Confirm deployment, so Enter confirms) | — | — |
| `notes` (N; RB) | — | toggle Note mode | — |
| `hint` (H; West) | — | hint (when assists allow) | — |
| `undo` (U; LB) | — | undo (practice) | — |
| `camera` (C; left stick press) | reset camera orbit | reset camera orbit | — |
| `pause` (Escape; Start) | open/close the pause card | same | on a menu screen: back to the title |

Menus and dialogs are `starhermit:ui`: Tab/arrows/Enter, pad focus and screen readers work everywhere; F1 opens the runtime's Options. The first gamepad shows the toast "Gamepad connected — stick aims, A confirms, B cancels."

**Locking.** `inputLocked` is set while the AI thinks (`pumpAI`), while a fire resolves (until the cosmetic job settles or Skip), during handover cards and after finish; `paused` blocks picks and keys. The AI's pause (650–1050 ms), the countdown, the settle and the results delay are timers on the game clock (fixed steps), so they pause while the window is suspended and are deterministic in checks. Duplicate commits are prevented by command ids.

**Feedback per input.** Every button: `ui-press`/`ui-back` sample. Cell arm: `select` + green ring; illegal placement: red preview, `invalid` thud and a toast naming the constraint; rejected fire: toast from `explainInvalid`; hint: sonar ping, cursor jump and toast; pad rumble (`vibrate` 10/40 ms) when the viewer's own board is hit and haptics are on.

## 7. Screens and UI flow

`boot → title ⇄ {setup, journey, challenges, learn, lobby, profile, settings, help} → match(placement → countdown → battle ⇄ paused/handover → resolving) → results → {retry, next stage, title}`. Title also offers **Resume Match** when `fleet-signals-resume` holds a snapshot. Settings and Help opened from the pause menu are overlays over the still-mounted match (`_presentScreen`), never re-mounts.

**Wide (≥1024 logical px, taller than 500).** Top bar (pause ❚❚, objective title/sub, turn badge), left rail (own fleet with hit pips, enemy summary), right rail (Signals log, last 12 lines), centred chart, bottom tray. Panels max 640 px (880 px wide variant).
**Compact (<1024 px).** Rails become drawers above the tray, toggled by ☰ / ≡ in the top bar, capped at 45 % of the height (scrolling inside).
**Portrait phone (≤700 px wide, upright).** Two-row top bar (pause + objective, then turn badge and drawer toggles; the objective's subtitle hidden); the tray wraps its buttons into rows with Confirm deployment / Fire on a full-width row of its own at the bottom (the browser build scrolled the ship chips horizontally); title and results art hidden under 560 px tall.
**Short landscape (≤500 px tall).** Rails/drawers 190 px, tighter top bar and tray padding.
**Scale and safe areas.** The runtime's interface size and text size scale the whole UI (the old `ui-scale.js`); layout runs inside `frame().safeArea`. The chart is fitted (camera distance along each pose) inside the rectangle the top bar, rails and tray leave.
**Coordinate labels and notes.** A–J above the target board's first row and 1–10 left of its first column are drawn each frame at the cells' projected window positions (the old projected label layer); private notes draw as ⚑ (flag) / ? (unknown) over their cells (the browser build stored notes but never drew them).
Settings, Help and the reset confirmation are dialogs over the current screen (the match stays mounted under Pause › Settings / Help).

## 8. Art direction

**Hero.** The holographic chart table: a dark steel pedestal (`0x2a3340`) with a glowing rim (theme `holoGrid` body, `holoShip` emissive 0.8) and translucent grid slabs, over a procedural sea (vertex-displaced waves plus up to 8 impact ripples) under 400 seeded stars and 10 red channel buoys (`0xb03a4a`). Camera poses (`CAMERA_POSES`): title (0, 7.5, 10.5), placement (0, 8.8, 5.2), battle (0.6, 9, 7.2), results (0, 10.5, 9).

**Shape language.** Hulls are extruded low-poly plans (tapered bow, deck strip, tower and mast from size 3) sized `0.86 × cells`; with Model detail on, hulls are bevelled with curved bows, vertex-coloured decks, superstructure, bridge glass, funnel, mast and one or two twin-barrel turrets (the size-5 carrier gets a flight deck and an offset island) in a clearcoated physical material; own ships steel grey `0x8a97a8`, drafts and holo ships in the theme's `holoShip`, wrecks charred `0x3a2f2f` with ember emissive `0xff3300`. Markers: hit = four-sided orange spear `0xff7a3c` (emissive 2.0, so it blooms); miss = white ring `0xcfe8ff`; mine = violet octahedron `0xc26bff`; cursor/valid = teal `0x6ff2c8`; invalid = red `0xff5468`.

**Palette (tokens in `tools/ui-style.css`).** `accent #59e6ff`, `bg #0a1626`, `panel #0a1828e0`, `panel-solid #0d1c30`, `text #e8f2fa`, `text-dim #9db4c6`, `danger #ff5468`, `ok #6ff2c8`, `warn #ffc857`, `hit #ff7a3c`, `miss #cfe8ff`; the visual theme replaces accent/bg/panel/text. High contrast is the runtime's (Options). Colour-vision palettes re-hue the hit and miss tokens and the chart's hit spears and miss rings (deuteranopia `#ffd23c/#7cc7ff`, protanopia `#ffd23c/#9ad5ff`, tritanopia `#ff5ea8/#d8f4ff`; the browser build only changed the CSS tokens) while shapes stay distinct.

**Themes (`THEMES`, per-stage and user-selectable).**

| id | accent / bg / panel / text | waterDeep · waterShallow · sky · fog · holoGrid · holoShip · sun |
|---|---|---|
| abyss-chart (default) | #4fd8e8 / #060d16 / #0c1a26 / #d7e8f0 | #04121e · #0a2e42 · #0a1a2a · #10303f · #1e5f73 · #63e2f2 · #b8e6f0 |
| ember-drift | #f0a24a / #140b06 / #241408 / #f2e2cc | #1a0e06 · #3a2210 · #241206 · #2e1a0c · #7a4a1e · #ffb45e · #ffd9a0 |
| verdant-sonar | #5ee08a / #071008 / #0f2012 / #dcf2e0 | #06170c · #0e3520 · #0a2012 · #12301e · #2e7a4a · #7bf2a6 · #d8f2b0 |
| umbral-violet | #b58af0 / #0d0816 / #1a1030 / #e6dcf5 | #120a24 · #2a1a4a · #170e2e · #241640 · #5a3a9a · #c9a2ff · #e8d8ff |
| glacier-front | #7ec8f0 / #0b141c / #14242e / #e2eef4 | #0e2230 · #2a4a5e · #33505f · #9fb8c4 · #4a8aa8 · #a8e0f8 · #f0f8ff |

**Typography.** The runtime's system-ui faces; title 41.6 px tracked with an accent glow (scaled down on narrow windows); larger text is the runtime's text size option.

**Lighting.** ACES filmic tone mapping, exposure 1.18, sRGB output (the water, particle and sonar shaders include the tone-mapping and colour-space chunks, and the water takes scene fog); one warm directional key (`0xfff2dd`, 2.6) whose PCF soft shadow box is fitted to the table and both boards, plus a hemisphere fill (`0x8fb7d9` / `0x1a2433`); fog and `scene.background` take the theme's `fog`.

**Graphics.** The runtime owns the graphics level (Options › Graphics: Auto or a level, quantum … infinite), render scale and pixel-ratio cap, adaptive resolution, the frame-rate limit and readout, and the largest shadow map; `native/quality.ts` maps the level's tier (`frame().quality`) onto the browser build's presets. Optional effects per tier: key-light shadows from ships and markers onto the table and grid slabs; ambient occlusion (`renderer.ao`, the old GTAO settings) for contact darkening; bloom limited to emissive highlights (`renderer.bloom`, threshold 0.86: the table rim, hit spears, mines, shell tracer, shot sparks and buoy lamps); a colour grade (`renderer.grade` in display space: gentle contrast, +10 % saturation, cool shadows / warm highlights, vignette); FXAA, SMAA or MSAA (`renderer.antialias`); image-based reflections from a PMREM-filtered `RoomEnvironment` (`envMapIntensity` 0.32 scaled per material); detailed sea (the budget's 96–192 segments, two-layer chop on the normal for glitter, a broad sheen and the table's cyan glow on the swell) or simple sea (48 segments); particles low (600-point pool) or high (3200, both × the budget's sparks factor, plus sparks and slow embers on hits and fine spray on misses); ambient motion (sonar sweep, bobbing buoys with blinking lamps, breathing grid lines, smouldering wrecks — stopped under reduced motion); model detail (detailed hulls, the engraved chart, brushed-metal pedestal). Low = everything off, simple sea, low particles, still background, plain models, Lambert materials; Balanced = 1024² shadows, bloom, grade, FXAA, reflections, detailed sea/particles/motion/models; High = 2048² shadows, AO, SMAA; Ultra = 4096² shadows, high AO, MSAA. Gameplay is identical at every level. The old per-effect overrides of Settings › Graphics are gone with the panel.

**Per-tier budgets** (`BUDGETS` in `native/quality.ts`, the browser build's 60 FPS budgets; sparks scale within the tier by the level index, ≤ 2×).

| Tier | Table, buoys, ships | Detailed own hulls | Chart texture | Brushed pedestal | Detailed sea segments | Round-geometry LOD | Sky dust | Sparks | Screen backdrop | Bloom / AO resolution |
|---|---|---|---|---|---|---|---|---|---|---|
| Low | Lambert | Lambert | 512 px | 256 px | 48 | ½ | 200 | 0.5× | opaque, no blur | ½ / ½ |
| Balanced | Standard | Standard | 512 px | 512 px | 96 | ¾ | 300 | 0.75× | opaque, no blur | ½ / ½ |
| High | Standard | clearcoated Physical | 1024 px | 512 px | 144 | 1 | 400 | 1× | frosted (blur) | ½ / ½ |
| Ultra | Standard | clearcoated Physical | 2048 px | 1024 px | 192 | 1.5 | 700 | 1.5× | frosted (blur) | full / full |

**Engine notes.** The water and sonar ShaderMaterials are WGSL with the old math (the water's vertex hook keeps the old shader's object-space wave field); particles are three `PointsMaterial` pools by size class with a soft round dot, fading by colour (additive) where the old point shader shrank them; light intensities are r160's ÷ π; the table's glass top draws before the holo grids (render order).

**Motion.** Camera: critically damped springs (k = 42), interruptible; shot: 0.55 s parabolic projectile then particles (26 miss / 55 hit / 70 mine / 90 sunk, additive points), a water ripple and tiered shake (0.55 hit, 1.0 sunk/mine). Skip ▸▸ settles every job. Reduced motion: no countdown, 0.12 s shots, no shake, no orbit gesture, instant camera cuts, CSS animations at 0.01 ms. Quality is governed by the Graphics presets (see **Graphics** above).

**Visual assets the design calls for.** Title key art of the chart table on the bridge (`assets/key-art.webp`, shown as a strip above the title), victory and defeat results illustrations (`assets/results-win.webp`, `assets/results-lose.webp`), a 16:9 cover (`coverart.png`, built from the key art). Hulls, table, sea and markers remain procedural by design so every fleet size and theme stays consistent; no 3D model import is used.

## 9. Audio direction

**Mix.** Clips play on the runtime's buses (Options › Audio owns the volumes and the mute): effects and the sea bed on `effects`, the button clicks on `interface`, with the old default levels folded in (effects 90 %, ambience 60 %). Every event plays its Opus sample once loaded (clips load one at a time once the mixer runs — natively at once, in a browser after the first press); the synthesized stand-ins the browser build played while a clip decoded are not ported, so a clip still loading is silent. The looped `sea-ambience.opus` starts once loaded. Captions (`[impact — hit]` etc., translated) show above the tray when Settings › Captions is on. A suspended window stops the bed. Music and voice buses carried nothing in the browser build and are not used.

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

Every player-facing string ships in nine locales: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

- **Tables.** English source strings are the keys. `src/i18n/strings.js` (UI, audio captions) and `src/i18n/strings-content.js` (40 stage names and briefings, daily briefings, 8 challenges with their goals, 5 themes, 5 lessons, 5 achievements, ship classes, the AI captains and default seat names) hold rows of [English, es-419, de-DE, fr-FR, pt-BR, it-IT]; en-GB, es-ES and fr-CA list only their differences. The StarHermit account strings are `src/ui/platform-i18n.js`. "Fleet Signals", "StarHermit", cell names (B4) and typed player names stay as they are.
- **How it is applied.** Code translates with `T()` / `N()` (`native/i18n.ts` over `src/i18n/core.js`); the immediate-mode UI redraws every frame, so a language change applies at once everywhere, a match keeping its state. The engine's battle log and score labels stay English inside the hashed, replayable state; `app.ts` translates their fixed patterns for the Signals log and the score breakdown.
- **Language choice** is the runtime's (Options › Language: the player's choice, else the device's), mapped to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `fr → fr-FR`, `pt-PT → pt-BR`). The browser build's own selector, `?lang=` and its `ui.language` account key are gone (the key is removed from the account once read).

## 11. Accessibility

- **Keyboard / pad path.** Title → Play → Launch (Tab/Enter), A to auto-deploy (focus moves to Confirm deployment), Enter, arrows + Enter to arm and fire, H for hints, Esc for pause; dialogs focus their controls.
- **Screen reader.** `ui.announce` (polite/assertive) speaks phase changes, turns, each shot ("You fire at C4 — a hit."), notes, hints, errors, sunk ships, eliminations and the result headline; containers carry labels (Match setup, Rules summary, Fleet status, Event log, Score breakdown, Results), stage cells and seats have explicit names, toggles are announced pressed.
- **Captions.** Settings › Captions for meaningful audio shows a caption above the tray for every cue and the sea bed.
- **Contrast, text size, reduced motion.** The runtime's options (high contrast, text size, reduced motion: no countdown, 0.12 s shots, no shake, no orbit gesture, instant camera cuts, no ambient motion). Three colour-vision palettes; hit/miss/mine also differ by shape and label.
- **Targets.** Buttons and chips are ≥ 44 px tall; Left-handed reverses the tray and swaps the rails/drawers.
- **Other.** Haptics (pad rumble) toggle, tutorial replay from Settings, no audio-only information.

## 12. StarHermit integration

Conventions follow https://wiki.starhermit.com/ (engine tutorial). Standalone (signed out) the game makes no platform request beyond the runtime's own.

| Feature | Status in this build |
|---|---|
| Manifest / launch | `starhermit.txt` (see §1); the web loader `index.html` pins engine 1.19.1 |
| Identity | `player()`: signed in, the profile shows "Signed in as <display name>" with the sync state; guests see Offline. The local display name (Profile, 18 chars) names your seat in matches |
| Sign-in / invite | Title: **Sign in with StarHermit** (`requestSignIn`) when signed out; **Invite a friend** (the invite link, copied with `clipboard.writeText`) when signed in |
| Cloud save | The v2 save document is the game's `saves` save (schema 2): on the device and in the account, uploads debounced by the runtime; a conflict merges both copies (`mergeDocs`: strict descendant, else `combineSaves`). The browser build's slot (`game:<slug>`, the JS SDK's `saveJSON` text) shows as foreign: it is read (v1 migrated), merged in and replaced once (`replaceForeign`). A match in progress is a device-only snapshot (`storage`, `fleet-signals-resume`). Old browser localStorage progress of guests does not migrate |
| Settings | The game's options (theme, palette, left-handed, haptics, captions) are `settings` keys, synced with the account; the browser build's account settings keys are read once (`legacyKeys`), the five options adopted, all old keys removed. Volumes, mute, graphics, language, reduced motion, high contrast and text size are the runtime's Options |
| Controls | Manifest actions; rebinding in the runtime's Options; Help lists the effective keys (`bindingLabel`) |
| Server time | `serverNow()` (the device clock until the platform answers) dates the Daily Signal and the local board entries |
| Leaderboards | Local board in the save doc (score-desc, cap 100). Signed in: every finished Daily, Journey or Challenge match against the AI posts its total through `score-script.js` (a practice session whose socket sends `{type:'result', scores:{'high-score': n}}`; the script range-checks 0–1,000,000) and the results card shows "Posting score…", then "Leaderboard rank: #N" / posted / not posted. Practice, Learn and Hosted Table post nothing; signed out shows nothing |
| Achievements | 5 keys unlocked idempotently in the save document |
| Hosted Table | Local pass-and-play on one device; nothing is recorded or posted (no server-refereed rooms) |
| Session end | `onSessionEnded` shows the signed-out toast; play continues on the device |

## 13. Technical architecture

- **Module contract.** Nothing mutates rules state except `applyCommand` via `GameSession.command`; `render.syncFromState` is the only path that sets board contents, and the controller re-syncs after every cosmetic job. UI state (`selectedCell`, `annotateMode`, drawers) is separate from match state.
- **Determinism.** Same seed + command list ⇒ identical `hashState`; visual decoration uses `visualSeed 'fleet-signals-v1'`; the game clock advances in 60 Hz fixed steps, so play scripts replay exactly.
- **Frame.** `onFixedUpdate`: timers, toasts; `onUpdate`: the look for the graphics level, audio; `onRender`: the UI, then pointer presses (decided after the UI is built so a press over a widget is the widget's), then the scene (camera aspect, jobs, particles, ambient motion, camera).
- **Performance.** Hull geometries cached per size and detail; instanced grid lines and buoys; pooled particles; canvas textures (chart, brushed metal) painted once per budget; the scene holds while the window is suspended.

## 14. Testing and acceptance criteria

**`npm test`** = `test:unit` + `test:native`.
- `tests/run.js`: rules (placement, fire, mines, salvo, fog, move limit, resign, annotate tick invariance, legal actions, 3-player skirmish), scoring/tie-breaks/stars, replay property and tamper detection, serialization/migration, 4000-command fuzz, all stages/challenges validate, daily determinism, AI termination and strength, session results/undo/restore/hint and the injected clock, server lifecycle/redaction/duplicates/deadline, golden hashes, locale matching.
- `tests/save.test.mjs`: the foreign cloud save read back (v2 and v1), merging, round-trips, option checks and the browser build's settings keys.
- `tests/i18n.test.mjs`: every key in `native/*.ts`, the captions and the content is translated in all nine locales with intact placeholders and no unused rows; the lookup switches locales.
- `tests/native.mjs`: translations, the web index matches the files, `tsc` (TypeScript 5.9, no skipLibCheck), `starhermit check .` with zero warnings, and every `tests/native/*.play` as a signed-out `--render-check`: `lesson-final` (Learn › Lesson 5 played to its Victory by the hint key; generated by `tools/gen-plays.mjs` from the rules), `deploy` (Lesson 1 placed by the cursor keys, first shot, pause, leave), `practice` (setup, Auto-deploy, hinted shot, Undo, a note flag, pause › Settings / Help, leave), `hosted` (two captains ready, deploy behind the handover card, first shot, handover), `menus` (Journey stage 1 launched, Daily and Challenge setups, Profile with the reset cancelled, Settings).
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader on loopback in Chrome on the AMD GPU (`~/games/tools/gpu-chrome.mjs`) at 1366×768, a phone 390×844 at DPR 3 and the phone sideways: Play, Launch, Auto-deploy, Confirm, a hinted shot, the fleet drawer (phone), pause; fails on console errors/warnings or the runtime's error screen. `~/games/tools/engine-web-smoke.mjs` checks start-up at desktop and phone.

**QA bar.** All modes reachable from the title; no console errors or warnings; Fire/Confirm/pause/turn badge visible without scrolling on phones and desktops; every setting changes observable state; a new player is told what to do on every phase transition.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `coverart.png` (1200×675) | StarHermit cover | FLUX.2 klein key art seed 7901 + ffmpeg title/tagline | generated in this pass (replaced placeholder) |
| `assets/key-art.webp` (1280×720, 48 KB) | title strip | FLUX.2 klein seed 7901, 28 steps | generated in this pass, wired |
| `assets/results-win.webp` (1024×576, 42 KB) | results art on victory | FLUX.2 klein seed 7902 | generated in this pass, wired |
| `assets/results-lose.webp` (1024×576, 21 KB) | results art on defeat/draw | FLUX.2 klein seed 7903 | generated in this pass, wired |
| `icon.png` | touch icon | authored | shipped |
| `cover.jpg` | StarHermit cover (manifest `cover=`) | built from the key art | shipped |
| `sfx/*.opus` (16 originals: ui-press, ui-back, invalid-action, ship-place, rotate-tick, torpedo-fire, splash-miss, hull-hit, ship-sunk, mine-detonation, turn-chime, countdown-blip, victory-fanfare, defeat-motif, lesson-complete, achievement-sparkle) | event samples | MOSS-SoundEffect v2, 100 steps | shipped, wired |
| `sfx/sea-ambience.opus`, `battle-stations.opus`, `target-lock.opus`, `sonar-hint.opus`, `fleet-eliminated.opus`, `chart-handover.opus` | new events (§9) | MOSS-SoundEffect v2, 100 steps | generated in this pass, wired |
| 3D models / character animation | — | — | none by design (procedural hulls, no humanoid) |

## 16. Known limitations

- **Hosted Table is local.** Pass-and-play on one device; there are no online rooms, so (per the platform's server-authoritative results policy) hosted matches are not recorded or posted. `server.js` keeps the authoritative session contract for a future server-refereed room.
- **Solo scores are client totals.** `score-script.js` range-checks the posted total (0–1,000,000); the match is not re-simulated server-side.
- **Stage `allowUndo` is not honoured.** Journey stage 4 ("Ink on the Chart") advertises undo, but undo is enabled only in Practice; hints only in Practice and Learn (pre-existing; kept for score compatibility).
- **Dropped with the browser build:** hold-to-confirm, the camera-view and avatar settings (stored but inert there); the music and voice buses (never played); the synthesized sound stand-ins while clips load; the old Settings › Graphics per-effect overrides and the in-game Language / Sound / Report sections (the runtime's Options now); guests' browser localStorage progress.
- `tutorialFlags` on stages are data only.
- Toasts stack at the top centre and can overlap the chart on phones when several fire in quick succession.
- The mergeSaves progress-count heuristic can prefer one copy outright when its counters all dominate (pre-existing behaviour).
