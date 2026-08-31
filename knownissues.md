# Known Issues — Fleet Signals

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and a headless-Chrome run of the shipped browser smoke suite.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node tests/run.js`) | 42/42 pass, 0 failures |
| `node --check` on all modules (`src/**/*.js`, `server.js`, `tests/run.js`) | clean |
| `tests/smoke.html` in headless Chrome (served on :39401) | PASS — reaches `[smoke] ALL OK`; no uncaught page errors |
| Title-screen + interactive load in headless Chrome | Boots to the title screen and into a Practice skirmish; no JS console errors |
| Corrupt-`localStorage` sweep (8 corruptions x 2 keys, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

`tests/e2e.mjs` does not exist in this game; `tests/smoke.html` is the equivalent browser suite and was
run through headless Chrome instead.

## Confirmed defects

Defects below were each verified by reading the source and reproducing the behaviour.

### 1. Hosted match can stall forever in the `placement` phase — the per-turn deadline never fires

- **File:** `server.js:138` (`checkDeadline`)
- **Trigger:** Create a session, have one player place their fleet, and have the second player never
  send a `place` / `auto-place` command. Then call `checkDeadline(session, now)` with any `now`.
- **Behaviour:** `checkDeadline` begins with `if (state.phase !== 'battle') return null;`, so the
  authoritative timeout is only ever evaluated during battle. The session stays in `'placement'`
  indefinitely and neither player is resigned, even though `createSession` stored a deadline for
  every player (`for (const p of state.players) deadlines[p.id] = now + deadlineMs;`).
- **Expected:** `spec.md` §2 requires an authoritative turn/tick model with a terminal-state reason,
  and the file's own doc-comment describes "Authoritative per-turn timeout … resign them and advance
  the match". Placement is a turn-taking phase with a stored deadline, so it must be enforced.
- **Evidence:** reproduction against the real module —

  ```
  place a: {"ok":true,...}
  phase: placement
  checkDeadline after 1d   -> null phase= placement
  checkDeadline after 7d   -> null phase= placement
  checkDeadline after 365d -> null phase= placement
  summary: {"phase":"placement","players":[{"id":"a","placed":true},{"id":"b","placed":false}],"result":null}
  ```

  The session's own `deadlineMs` default is 24 h, so the deadline was 364 days in the past on the last call.

### 2. `server.js` is declared as the StarHermit host but starts no server

- **File:** `starhermit.txt` (`server=server.js`) vs `server.js:1-190`
- **Trigger:** `node server.js` (or `PORT=39401 node server.js`) as the packaging manifest implies.
- **Behaviour:** the process exits immediately with code 0 and nothing listens. `server.js` is a pure
  ESM library of `createSession` / `handleMessage` / `checkDeadline` / `getSnapshot` / `sessionSummary`
  exports with no `http.createServer`, no `listen`, and no top-level side effect.
- **Expected:** either the manifest should not name `server.js` as the host, or the file should expose
  a runnable host. Every other game in this batch (`glow-strikers`, `gravity-hollow`, `jewel-cascade`,
  `market-manager`, `metro-dash`, `number-mahjong`, `open-cells`) ships a `server.js` that actually listens.
- **Evidence:** `node server.js` → `exit=0`, no listener; `package.json` has no `start` script and its
  `serve` script is `python3 -m http.server 8080`, which cannot answer the `/api/v1/*` routes the
  client calls (`src/main.js:30` `GET /api/v1/time`, `src/main.js:57` `POST /api/v1/presence`). Under
  the documented serve command those return 404 / 501, observed in the headless run.

### 3. Payload size limit counts UTF-16 code units, not bytes

- **File:** `server.js:99` (`handleMessage`), constant `MAX_PAYLOAD_BYTES = 4096` at `server.js:16`
- **Trigger:** send a `command` message whose string fields contain multi-byte characters, e.g. 4096
  CJK characters.
- **Behaviour:** `const payload = JSON.stringify(msg); if (payload.length > MAX_PAYLOAD_BYTES) …`.
  `String.prototype.length` counts UTF-16 code units, so 4096 CJK characters (`.length === 4096`,
  12 288 bytes in UTF-8) pass a limit whose name and doc-comment both say "bytes"
  (`* type 'command' | 'ping' and a serialized length <= 4096 bytes.`). The effective byte ceiling is
  up to 3× the intended one.
- **Expected:** measure with `Buffer.byteLength(payload, 'utf8')` / `TextEncoder`.
- **Evidence:** source as quoted; independently flagged by the model review and confirmed by reading.

### 4. Ships-sunk bonus is credited to every player who merely hit the ship

- **File:** `src/rules/engine.js:593` (`scoreMatch`), same expression at `src/rules/engine.js:486`
  (move-limit winner selection)
- **Trigger:** a 3- or 4-player skirmish in which one player hits a single cell of an enemy ship and a
  different player finishes it.
- **Behaviour:**

  ```js
  for (const s of q.ships) if (s.sunk && s.cells.some((c) => c in f)) sunk += 1;
  ```

  `f` is *this* player's `shotsFired` map for that opponent, so `some` asks "did I hit **any** cell of
  a ship that is now sunk", not "did I sink it". Every player who grazed the ship receives the full
  `SCORE_TABLE.sunk` bonus, and the summed "Ships sunk" across players can exceed the number of ships
  on the board. The same expression decides the winner when the move limit expires.
- **Expected:** `every` — the bonus is labelled `Ships sunk (n)` in the results breakdown
  (`src/rules/engine.js:599`) and `spec.md` §2 requires results to "show a component breakdown rather
  than one unexplained total", i.e. components that mean what they say. The spec also states the game
  supports "2–4 players depending on ruleset", and `createSession` accepts 2-4, so multi-player is a
  shipped configuration.
- **Evidence:** scripted 3-player match against the real engine —

  ```
  B's ship "sentinel" occupies 5 cells: [ 9, 17, 25, 33, 41 ]
  A fires at exactly 1 of those 5 cells; C then fires at all 5.
  ship sunk? true
  A fired at 1 of 5 cells -> {"key":"sunk","label":"Ships sunk (1)","points":100}
  C fired at all cells    -> {"key":"sunk","label":"Ships sunk (1)","points":100}
  ```

  In a strict 2-player duel `some` and `every` coincide (only one player can be shooting at that
  fleet), which is why the 42-assertion suite does not catch it.

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
