# Known Issues — Fleet Signals

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and a headless-Chrome run of the shipped browser smoke suite.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node tests/run.js`) | 42/42 pass, 0 failures (verified 2026-09-04) |
| `node --check` on all modules (`src/**/*.js`, `server.js`, `tests/run.js`) | clean |
| `npm run test:e2e` / `node tests/e2e.mjs` (Playwright, Chrome) | **E2E PASS** — full playthrough on desktop 1280x800 + mobile 390x844, no page errors (verified 2026-09-04) |
| `tests/smoke.html` in headless Chrome (served on :39401) | PASS — reaches `[smoke] ALL OK`; no uncaught page errors |
| Title-screen + interactive load in headless Chrome | Boots to the title screen and into a Practice skirmish; no JS console errors |
| Corrupt-`localStorage` sweep (8 corruptions x 2 keys, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

`tests/e2e.mjs` now exists (added 2026-09-03, exercised again 2026-09-04): a Playwright playthrough of
the real UI (title → settings → practice match → results) on desktop and mobile viewports; both passes
are clean. At the time of the audit above it did not exist; `tests/smoke.html` was the
equivalent browser suite and was run through headless Chrome instead.

## Resolved

The five defects previously listed under **Confirmed defects** were each reproduced/confirmed against
the source and are all now fixed in the current tree (verified 2026-09-04).

### 1. Placement-phase deadline never fires — RESOLVED

- **Fix:** `server.js` (`checkDeadline`). Removed the `if (state.phase !== 'battle') return null;`
  early-out. The function now guards only on `finished`, and for `placement` it scans every alive,
  unplaced player and resigns the first whose stored deadline has elapsed. Battle still targets the
  current alive player. Lines now appear at `server.js:148-176` (selection at 153-163, command
  construction at 169). The `battle`/`placement` branches use the same `now > d` deadline test.
- **Verify:** unit suite (`node tests/run.js`) 42/42 pass. A `checkDeadline` call in `placement`
  with an elapsed deadline now resigns the unplaced player and advances.

### 2. `server.js` declared as host but started no server — RESOLVED

- **Fix:** `server.js:214-265` — added a runnable host (`startHost()`) that is invoked only when the
  module is executed directly (`isMain` guard at 262-264). It serves static files plus the
  `/api/v1/time` endpoint (200 JSON); all other `/api/*` routes return 204, matching the
  offline-tolerant platform adapter. `starhermit.txt` remains `server=server.js`, which is now correct.
- **Verify:** `PORT=39777 node server.js` then `curl /api/v1/time` → `{"time":...}`; `/` returns
  `index.html`; a missing file returns 404.

### 3. Payload cap counted UTF-16 code units, not bytes — RESOLVED

- **Fix:** `server.js:21-25` added a `utf8Bytes()` helper using `TextEncoder`; `handleMessage` now
  checks `utf8Bytes(payload) > MAX_PAYLOAD_BYTES` at `server.js:105` instead of `payload.length`.
- **Verify:** multi-byte payloads are now measured in UTF-8 bytes and rejected at the true 4096-byte
  ceiling.

### 4. Ships-sunk bonus credited to every player who merely hit the ship — RESOLVED

- **Fix:** `src/rules/engine.js:486` and `:593` — changed `s.cells.some((c) => c in f)` to
  `s.cells.every((c) => c in f)` in both the move-limit winner selection and `scoreMatch`, so the
  `sunk` bonus is credited only to the player who hit **every** cell of the sunk ship.
- **Verify:** in the scripted 3-player case the grazer (A, 1 of 5 cells) now scores **no** sunk
  bonus; the finisher (C, all cells) scores it once.

### 5. Pause → Settings → Done → Resume destroyed the in-match HUD — RESOLVED

- **Fix:** `src/ui/app.js`. `overlay()` (`:135-140`) now accepts a DOM node as well as an HTML string.
  `showSettings` (`:587-603`) detects an in-progress match via `this.ui.querySelector('.game-root')`
  and, when in-match, renders the settings screen as an overlay on top of the still-mounted game
  instead of calling `mount()` (which wiped `#ui`); only on the title screen does it mount like any
  other screen. `Done` removes the overlay and returns; Pause→Resume keeps the HUD/tray/rails intact.
- **Verify:** e2e still pauses/resumes with `#tray` present (see table), and the settings-from-pause
  path now keeps `#hud-objective` and `#tray` mounted.

## Suspected — not confirmed

### 1. `seenCommandIds` on the session grows without bound

- **File:** `server.js:46` (`seenCommandIds: new Set()`), added at `server.js:125`
- **Concern:** the engine caps its own copy (`src/rules/engine.js:376` trims to 512 entries) but the
  server-side `Set` is never pruned. A very long-lived session accumulates one entry per accepted
  command forever.
- **Why unconfirmed:** matches are bounded by fleet size and the engine's own terminal conditions, so
  it is not clear the growth is ever material in practice; needs a product decision on session lifetime.

### 2. `recordBoardEntry` assumes `doc.boards.entries` exists

- **File:** `src/platform/save.js:136`
- **Concern:** `const entries = doc.boards.entries; entries.push(entry);` has no guard. `loadSave`
  guarantees the field for default and v1-migrated docs, but a checksum-valid v2 doc that lacks
  `boards` (the checksum is an unkeyed corruption check, so a user can hand-edit `localStorage` and
  recompute it) throws a `TypeError` on the next completed match. The comparator
  `(a, b) => b.score - a.score` is likewise unguarded against a malformed `entry`.
- **Why unconfirmed:** no in-app path produces such a doc; only a hand-crafted save reaches it.

### 3. `command.playerId = playerId` mutates the caller's message object

- **File:** `server.js:114`
- **Concern:** the server overwrites the actor field on the object the transport handed it. Correct for
  anti-spoofing, but a caller that reuses or logs the message afterwards sees a mutated object.
- **Why unconfirmed:** no in-repo caller depends on the original value, so no observable failure could
  be produced.

## Checked, no defects found

- **Snapshot redaction** (`server.js:162`, `getSnapshot`): `structuredClone` plus blanking `ship.cells`
  for unsunk enemy ships, `p.mines` and `p.notes` for every non-self player. The model claimed
  `view.seenCommandIds = []` was dead code; that is a **false positive** — `seenCommandIds` is a real
  field of engine state (`src/rules/engine.js:135`) and the line is genuine redaction.
- **Rate limiter** (`server.js:56`, `checkRateLimit`): sliding window is correct at the boundary;
  `stamps[0] <= cutoff` evicts exactly the expired entries and the cap is checked before pushing.
- **Duplicate-command handling** (`server.js:110` and `src/rules/engine.js:359`): ids are recorded only
  after a command applies successfully, so a rejected command may legitimately be retried with the same id.
- **Identity spoofing:** `command.playerId` is overwritten from the transport-supplied `playerId` before
  `applyCommand`, and `isMember` rejects non-players; a stranger's `ping` is rejected with `not-a-member`.
- **Engine turn/annotation clock** (`src/rules/engine.js:559`): `state.tick -= 1` inside `cmdAnnotate`
  cancels the unconditional `state.tick += 1` in `applyCommand`, so the tick stays non-decreasing as
  the spec requires. Not a monotonicity bug.
- **Resignation paths** (`src/rules/engine.js:528`, `cmdResign`): placement-phase and battle-phase
  resignation both reach `finish()` correctly for the 2-player and 3+-player cases.
- **Save layer** (`src/platform/save.js`): `loadSave` guards `getItem` throwing, `null`, unparseable
  JSON, a missing or mismatched checksum and an unknown version, returning `defaultSave()` with
  `corrupted: true` in each case. A browser sweep that set `fleet-signals-save` and
  `fleet-signals-resume` to `''`, `'{'`, `'null'`, `'[]'`, `'"x"'`, `'{"v":999999}'`, `' garbage'` and
  `'{"version":-1,"data":null}'` and reloaded after each produced no page errors.
- **Model false positive worth recording:** the review reported that the v1→v2 migration in `loadSave`
  is never persisted and so re-runs forever. The library indeed does not write back, but the single
  caller does — `src/main.js:105`, `if (migrated || corrupted) saveHooks.persist(doc);` — so the
  migration is stored on first load.

## Not tested

- **Hosted multiplayer over a real transport.** `server.js` has no transport of its own (defect 2), so
  reconnect, lobby, invitation and "while you were away" behaviour could only be exercised through the
  in-page hosted-lobby simulation in `tests/smoke.html`, which passed.
- **Score submission / leaderboard validation.** The game exposes no score-submission endpoint, so the
  "can a client submit an impossible score" check does not apply here.
- **Three.js rendering fidelity** (`src/render/scene.js`). Only checked for absence of runtime errors
  under SwiftShader; visual correctness was not assessed.
- **Audio** (`src/audio/audio.js`). Headless Chrome blocks the AudioContext before a user gesture.
