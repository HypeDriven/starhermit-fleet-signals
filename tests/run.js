/**
 * Fleet Signals test suite — plain Node, no dependencies.
 * Covers: legal actions, invalid-action reasons, scoring components,
 * terminal states, serialization migration, replay determinism
 * (property), fuzzed malformed commands, content validators, AI
 * termination, session undo/restore, and the authoritative server script.
 */
import * as E from '../src/rules/engine.js';
import { makeRng, hashString } from '../src/rules/rng.js';
import { chooseCommand } from '../src/rules/ai.js';
import { GameSession } from '../src/session/session.js';
import {
  STAGES, CHALLENGES, THEMES, dailyStage, validateStage, stageById, challengeById,
} from '../src/content/stages.js';
import {
  createSession, handleMessage, getSnapshot, checkDeadline, sessionSummary,
} from '../server.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write('F');
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function throwsCode(fn, code) {
  try { fn(); } catch (err) {
    if (err instanceof E.RuleError && err.code === code) return;
    throw new Error(`expected RuleError ${code}, got ${err.code || err.message}`);
  }
  throw new Error(`expected RuleError ${code}, no throw`);
}

/** Two-player duel, both fleets pre-placed (scripted rows, or auto-place when mines are in play). */
function mkDuel(seed = 'test', mechanics = {}, gridSize = 8, fleetId = 'standard') {
  const state = E.createMatch({
    seed, gridSize, fleetId, mechanics,
    players: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
  });
  if (mechanics.mineCount) {
    E.applyCommand(state, { type: 'auto-place', playerId: 'p1' });
    E.applyCommand(state, { type: 'auto-place', playerId: 'p2' });
    return state;
  }
  const rows = {};
  const fleet = state.fleet;
  fleet.forEach((s, i) => { rows[s.id] = { shipId: s.id, x: 0, y: i, dir: 'h' }; });
  E.applyCommand(state, { type: 'place', playerId: 'p1', placements: fleet.map((s) => rows[s.id]) });
  E.applyCommand(state, { type: 'place', playerId: 'p2', placements: fleet.map((s) => rows[s.id]) });
  return state;
}

/* ==================== rng ==================== */

test('rng: same seed, same sequence', () => {
  const a = makeRng('hello'), b = makeRng('hello');
  for (let i = 0; i < 100; i++) eq(a.next(), b.next());
});
test('rng: forked streams independent and deterministic', () => {
  const a = makeRng('x').fork('rules'), b = makeRng('x').fork('decor');
  const a2 = makeRng('x').fork('rules');
  eq(a.next(), a2.next());
  assert(a.next() !== undefined && b.next() !== undefined);
});

/* ==================== placement ==================== */

test('placement: valid fleet accepted, battle begins when all placed', () => {
  const s = mkDuel();
  eq(s.phase, 'battle');
  eq(s.players[0].ships.length, 5);
});
test('placement: overlap rejected', () => {
  const s = E.createMatch({ seed: 'x', gridSize: 8, players: [{ id: 'p1' }, { id: 'p2' }] });
  const pl = s.fleet.map((f) => ({ shipId: f.id, x: 0, y: 0, dir: 'h' }));
  throwsCode(() => E.applyCommand(s, { type: 'place', playerId: 'p1', placements: pl }), 'placement-overlap');
});
test('placement: out of bounds rejected', () => {
  const s = E.createMatch({ seed: 'x', gridSize: 8, players: [{ id: 'p1' }, { id: 'p2' }] });
  const pl = s.fleet.map((f, i) => ({ shipId: f.id, x: 7, y: i, dir: 'h' }));
  throwsCode(() => E.applyCommand(s, { type: 'place', playerId: 'p1', placements: pl }), 'placement-out-of-bounds');
});
test('placement: noTouch rejects adjacent ships', () => {
  const s = E.createMatch({
    seed: 'x', gridSize: 8, fleetId: 'patrol', mechanics: { noTouch: true },
    players: [{ id: 'p1' }, { id: 'p2' }],
  });
  const pl = [
    { shipId: 'lancer', x: 0, y: 0, dir: 'h' },
    { shipId: 'dart', x: 0, y: 1, dir: 'h' },   // directly beneath lancer
    { shipId: 'dart2', x: 4, y: 4, dir: 'h' },
  ];
  throwsCode(() => E.applyCommand(s, { type: 'place', playerId: 'p1', placements: pl }), 'placement-adjacency');
});
test('placement: mine cell rejected', () => {
  const s = E.createMatch({
    seed: 'mined', gridSize: 8, fleetId: 'patrol', mechanics: { mineCount: 2 },
    players: [{ id: 'p1' }, { id: 'p2' }],
  });
  const mines = s.players[0].mines;
  assert(mines.length === 2);
  const { x, y } = E.cellToXY(mines[0], 8);
  const pl = [
    { shipId: 'lancer', x, y, dir: 'h' },
    { shipId: 'dart', x: 0, y: 7, dir: 'h' },
    { shipId: 'dart2', x: 3, y: 7, dir: 'h' },
  ];
  // lancer may extend off-grid instead; either placement-mine or bounds is acceptable — force alignment
  const cells = [mines[0], ...Array.from({ length: 2 }, (_, i) => mines[0] + (i + 1))];
  if (E.cellToXY(mines[0], 8).x <= 5) {
    throwsCode(() => E.applyCommand(s, { type: 'place', playerId: 'p1', placements: pl }), 'placement-mine');
  }
});
test('placement: auto-place is legal on every stage config', () => {
  for (const st of STAGES) {
    const s = E.createMatch({
      seed: st.seed, gridSize: st.gridSize, fleetId: st.fleetId, mechanics: st.mechanics,
      players: [{ id: 'a' }, { id: 'b' }],
    });
    const r = E.applyCommand(s, { type: 'auto-place', playerId: 'a' });
    assert(s.players[0].placed, `auto-place failed on ${st.id}`);
  }
});
test('placement: double placement rejected', () => {
  const s = mkDuel('d', {}, 6, 'patrol');
  throwsCode(() => E.applyCommand(s, {
    type: 'place', playerId: 'p1',
    placements: [{ shipId: 'lancer', x: 0, y: 0, dir: 'h' }, { shipId: 'dart', x: 0, y: 1, dir: 'h' }, { shipId: 'dart2', x: 0, y: 2, dir: 'h' }],
  }), 'phase');
});

/* ==================== firing ==================== */

test('fire: hit, sunk, elimination, victory, terminal reason', () => {
  const s = mkDuel('fire1', {}, 8, 'patrol');
  const p1Targets = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [0, 2], [1, 2]];
  const p2Targets = [[5, 5], [5, 6], [5, 7], [6, 7], [7, 7], [4, 4], [3, 5]];
  let i1 = 0, i2 = 0;
  const allEvents = [];
  let guard = 0;
  while (s.phase !== 'finished' && guard++ < 100) {
    const cur = E.currentPlayer(s).id;
    const [x, y] = cur === 'p1' ? p1Targets[i1++] : p2Targets[i2++];
    const r = E.applyCommand(s, { type: 'fire', playerId: cur, targetId: cur === 'p1' ? 'p2' : 'p1', x, y });
    allEvents.push(...r.events);
  }
  eq(allEvents[0].result, 'hit', 'first shot on the lancer is a hit');
  const sunkEv = allEvents.find((e) => e.type === 'shot' && e.result === 'sunk');
  assert(sunkEv, 'a ship was sunk');
  eq(sunkEv.shipName, 'Lancer Frigate');
  assert(allEvents.some((e) => e.type === 'eliminated' && e.playerId === 'p2'));
  eq(s.phase, 'finished');
  eq(s.winner, 'p1');
  eq(s.terminalReason, 'fleet-destroyed');
  assert(allEvents.some((e) => e.type === 'finish'));
});
test('fire: not your turn rejected and counted', () => {
  const s = mkDuel('turn1');
  throwsCode(() => E.applyCommand(s, { type: 'fire', playerId: 'p2', targetId: 'p1', x: 3, y: 3 }), 'not-your-turn');
  eq(s.players[1].invalidActions, 1);
});
test('fire: duplicate cell rejected', () => {
  const s = mkDuel('dup1');
  E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 3, y: 3 });
  E.applyCommand(s, { type: 'fire', playerId: 'p2', targetId: 'p1', x: 3, y: 3 });
  throwsCode(() => E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 3, y: 3 }), 'cell-already-targeted');
});
test('fire: out of bounds rejected', () => {
  const s = mkDuel('oob1');
  throwsCode(() => E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 9, y: 0 }), 'cell-out-of-bounds');
  throwsCode(() => E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 0, y: -1 }), 'cell-out-of-bounds');
});
test('fire: self target and dead target rejected', () => {
  const s = mkDuel('self1');
  throwsCode(() => E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p1', x: 0, y: 0 }), 'not-legal');
  throwsCode(() => E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'ghost', x: 0, y: 0 }), 'unknown-target');
});
test('fire: mines cost an extra shot', () => {
  const s = mkDuel('mine1', { mineCount: 2 }, 8, 'patrol');
  const mines = s.players[1].mines;
  // find a mine not covered by p2's ships (ships occupy rows 0-2, x 0-2)
  const covered = new Set(s.players[1].ships.flatMap((sh) => sh.cells));
  const free = mines.find((m) => !covered.has(m));
  if (free === undefined) return; // both mines under ships: skip (layout-dependent)
  const { x, y } = E.cellToXY(free, 8);
  const before = s.players[0].shotsUsed;
  const r = E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x, y });
  eq(r.events[0].result, 'mine');
  eq(s.players[0].shotsUsed, before + 2);
});
test('fire: move limit ends match with winner', () => {
  const s = mkDuel('limit1', { moveLimit: 4 }, 8, 'patrol');
  let guard = 0;
  while (s.phase !== 'finished' && guard++ < 40) {
    const cur = E.currentPlayer(s);
    const legal = E.listLegalActions(s, cur.id).find((a) => a.type === 'fire');
    if (!legal) { E.applyCommand(s, { type: 'pass', playerId: cur.id }); continue; }
    const cell = legal.cells[0];
    const { x, y } = E.cellToXY(cell, s.gridSize);
    E.applyCommand(s, { type: 'fire', playerId: cur.id, targetId: legal.targetId, x, y });
  }
  eq(s.phase, 'finished');
  eq(s.terminalReason, 'move-limit');
  assert(s.winner, 'a winner is decided on damage');
});
test('fire: salvo grants one shot per surviving ship', () => {
  const s = mkDuel('salvo1', { salvo: true }, 8, 'patrol');
  eq(s.pendingShots, 3); // patrol = 3 ships
  E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 4, y: 4 });
  eq(E.currentPlayer(s).id, 'p1', 'still p1 turn in salvo');
  E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 4, y: 5 });
  eq(E.currentPlayer(s).id, 'p1');
  E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 4, y: 6 });
  eq(E.currentPlayer(s).id, 'p2', 'turn passes after the salvo');
});
test('fire: fog hides sunk ship identity', () => {
  const s = mkDuel('fog1', { fog: true }, 8, 'patrol');
  E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 0, y: 0 });
  E.applyCommand(s, { type: 'fire', playerId: 'p2', targetId: 'p1', x: 7, y: 7 });
  E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 1, y: 0 });
  E.applyCommand(s, { type: 'fire', playerId: 'p2', targetId: 'p1', x: 7, y: 6 });
  const r = E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 2, y: 0 });
  eq(r.events[0].result, 'sunk');
  eq(r.events[0].shipName, undefined);
});
test('fire: resign ends a duel', () => {
  const s = mkDuel('resign1');
  const r = E.applyCommand(s, { type: 'resign', playerId: 'p2' });
  eq(s.phase, 'finished');
  eq(s.winner, 'p1');
  eq(s.terminalReason, 'resign');
});
test('annotate: notes stored, tick does not advance', () => {
  const s = mkDuel('note1');
  const tick = s.tick;
  const r = E.applyCommand(s, { type: 'annotate', playerId: 'p1', targetId: 'p2', x: 3, y: 3, mark: 'flag' });
  eq(s.tick, tick);
  eq(s.players[0].notes.p2[27], 'flag');
  E.applyCommand(s, { type: 'annotate', playerId: 'p1', targetId: 'p2', x: 3, y: 3, mark: null });
  eq(s.players[0].notes.p2[27], undefined);
});

/* ==================== legal actions API ==================== */

test('legal actions: placement -> fire -> empty on finish', () => {
  const s = E.createMatch({ seed: 'la', gridSize: 6, fleetId: 'patrol', players: [{ id: 'a' }, { id: 'b' }] });
  let acts = E.listLegalActions(s, 'a');
  assert(acts.some((a) => a.type === 'place'));
  E.applyCommand(s, { type: 'auto-place', playerId: 'a' });
  E.applyCommand(s, { type: 'auto-place', playerId: 'b' });
  acts = E.listLegalActions(s, 'a');
  const fire = acts.find((a) => a.type === 'fire');
  eq(fire.targetId, 'b');
  eq(fire.cells.length, 36);
  acts = E.listLegalActions(s, 'b');
  assert(!acts.some((a) => a.type === 'fire'), 'waiting player cannot fire');
  E.applyCommand(s, { type: 'resign', playerId: 'b' });
  eq(E.listLegalActions(s, 'a').length, 0);
});
test('legal actions: 3-player skirmish lists every living target', () => {
  const s = E.createMatch({
    seed: 'sk1', gridSize: 8, fleetId: 'patrol',
    players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  });
  for (const p of ['a', 'b', 'c']) E.applyCommand(s, { type: 'auto-place', playerId: p });
  const fires = E.listLegalActions(s, 'a').filter((x) => x.type === 'fire');
  eq(fires.length, 2);
  E.applyCommand(s, { type: 'fire', playerId: 'a', targetId: 'b', x: 0, y: 0 });
  eq(E.currentPlayer(s).id, 'b');
  E.applyCommand(s, { type: 'resign', playerId: 'c' });
  // c is out; b's legal list should only contain a
  E.applyCommand(s, { type: 'fire', playerId: 'b', targetId: 'a', x: 0, y: 0 });
  eq(E.currentPlayer(s).id, 'a');
});

/* ==================== scoring ==================== */

test('scoring: component breakdown sums to total', () => {
  const s = mkDuel('score1', { moveLimit: 30 }, 8, 'patrol');
  E.applyCommand(s, { type: 'fire', playerId: 'p1', targetId: 'p2', x: 0, y: 0 }); // hit
  E.applyCommand(s, { type: 'fire', playerId: 'p2', targetId: 'p1', x: 7, y: 7 }); // miss
  E.applyCommand(s, { type: 'resign', playerId: 'p2' });
  const sc = E.scoreMatch(s, 'p1');
  const sum = sc.components.reduce((a, c) => a + c.points, 0);
  eq(sc.total, sum);
  assert(sc.components.some((c) => c.key === 'win'));
  assert(sc.components.some((c) => c.key === 'hits'));
  assert(sc.components.some((c) => c.key === 'efficiency'), 'move-limit efficiency component');
  assert(sc.won);
  const loser = E.scoreMatch(s, 'p2');
  assert(!loser.won);
  assert(!loser.components.some((c) => c.key === 'win'));
});
test('scoring: tie-break order', () => {
  const base = { score: 100, won: true, invalidActions: 0, elapsedMs: 1000, sessionId: 'a' };
  assert(E.compareResults({ ...base, score: 200 }, base) < 0, 'higher score first');
  assert(E.compareResults(base, { ...base, won: false }) < 0, 'objective beats non-objective');
  assert(E.compareResults(base, { ...base, invalidActions: 2 }) < 0, 'fewer invalid wins');
  assert(E.compareResults(base, { ...base, elapsedMs: 5000 }) < 0, 'faster wins');
  assert(E.compareResults(base, { ...base, sessionId: 'b' }) < 0, 'stable id last resort');
});
test('scoring: star rating', () => {
  eq(E.starRating({ won: false, shotsUsed: 5, accuracy: 1, par: 10 }), 0);
  eq(E.starRating({ won: true, shotsUsed: 20, accuracy: 0.3, par: 10 }), 1);
  eq(E.starRating({ won: true, shotsUsed: 9, accuracy: 0.3, par: 10 }), 2);
  eq(E.starRating({ won: true, shotsUsed: 9, accuracy: 0.7, par: 10 }), 3);
});

/* ==================== determinism / replay ==================== */

function playScriptedGame(seed, mechanics = {}, gridSize = 8, fleetId = 'standard') {
  const config = {
    seed, gridSize, fleetId, mechanics,
    players: [{ id: 'p1', isAI: true, difficulty: 'hard' }, { id: 'p2', isAI: true, difficulty: 'medium' }],
  };
  const state = E.createMatch(config);
  const envelope = E.createReplayEnvelope(config);
  envelope.initialHash = E.hashState(state);
  const rngA = makeRng(seed + ':A'), rngB = makeRng(seed + ':B');
  const hashes = [];
  let guard = 0;
  while (state.phase !== 'finished' && guard++ < 2000) {
    let cmd;
    if (state.phase === 'placement') {
      const p = state.players.find((q) => !q.placed);
      cmd = { type: 'auto-place', playerId: p.id, id: 'c' + guard };
    } else {
      const cur = E.currentPlayer(state);
      cmd = chooseCommand(state, cur.id, cur.id === 'p1' ? rngA : rngB);
      cmd.id = 'c' + guard;
      if (!cmd) break;
    }
    E.applyCommand(state, cmd);
    E.recordReplayStep(envelope, cmd, state);
    hashes.push(E.hashState(state));
  }
  return { state, envelope, hashes, config };
}

test('replay: same seed + commands -> identical state hashes (property, 20 games)', () => {
  for (let i = 0; i < 20; i++) {
    const seed = 'prop-' + i;
    const mech = [{}, { salvo: true }, { mineCount: 2 }, { moveLimit: 50 }][i % 4];
    const a = playScriptedGame(seed, mech);
    const b = playScriptedGame(seed, mech);
    eq(a.hashes.length, b.hashes.length, 'game length diverged on ' + seed);
    for (let j = 0; j < a.hashes.length; j++) eq(a.hashes[j], b.hashes[j], `hash mismatch ${seed}@${j}`);
    eq(a.state.phase, 'finished', 'game must terminate: ' + seed);
  }
});
test('replay: envelope verifies, tampering detected', () => {
  const { envelope, config } = playScriptedGame('replay1', { mineCount: 1 });
  const ok = E.verifyReplay(config, envelope);
  assert(ok.ok, 'clean replay verifies');
  const bad = JSON.parse(JSON.stringify(envelope));
  bad.commands[3].x = (bad.commands[3].x + 1) % 8;
  const res = E.verifyReplay(config, bad);
  // tampered command either illegal (throws) or divergent
  assert(!res.ok, 'tampered replay must not verify');
});

/* ==================== serialization / migration ==================== */

test('serialization: round-trip preserves hash', () => {
  const { state } = playScriptedGame('ser1');
  const json = E.serializeState(state);
  const back = E.deserializeState(json);
  eq(E.hashState(back), E.hashState(state));
});
test('migration: v1 and v2 snapshots upgrade to current', () => {
  const s = mkDuel('mig1');
  const v1 = JSON.parse(E.serializeState(s));
  v1.version = 1;
  for (const p of v1.players) { delete p.invalidActions; delete p.notes; }
  const m1 = E.deserializeState(JSON.stringify(v1));
  eq(m1.version, E.RULES_VERSION);
  eq(m1.players[0].invalidActions, 0);
  assert(m1.players[0].notes && typeof m1.players[0].notes === 'object');
  const v2 = JSON.parse(E.serializeState(s));
  v2.version = 2;
  for (const p of v2.players) delete p.notes;
  eq(E.deserializeState(JSON.stringify(v2)).version, E.RULES_VERSION);
  throwsCode(() => E.deserializeState(JSON.stringify({ version: 99 })), 'malformed');
});
test('commands: duplicate id rejected idempotently', () => {
  const s = mkDuel('dup-id');
  const cmd = { id: 'fixed-1', type: 'fire', playerId: 'p1', targetId: 'p2', x: 0, y: 0 };
  const r1 = E.applyCommand(s, cmd);
  const shots = s.players[0].shotsUsed;
  const r2 = E.applyCommand(s, cmd);
  assert(r2.duplicate, 'second application flagged duplicate');
  eq(s.players[0].shotsUsed, shots);
});

/* ==================== fuzz ==================== */

test('fuzz: 4000 malformed commands never crash, hang, or corrupt', () => {
  const rng = makeRng('fuzz');
  for (let game = 0; game < 10; game++) {
    const s = mkDuel('fuzz' + game, [{}, { salvo: true }, { mineCount: 2, moveLimit: 60 }][game % 3], 8, 'patrol');
    for (let i = 0; i < 400; i++) {
      const junk = [
        null, undefined, 42, 'fire', [], {},
        { type: 'fire' },
        { type: 'fire', playerId: 'p1', targetId: 'p2', x: 'a', y: null },
        { type: 'fire', playerId: 'p1', targetId: 'p2', x: 1e9, y: -1e9 },
        { type: 'fire', playerId: 'p1', targetId: 'p2', x: 0.5, y: 2.5 },
        { type: 'nonsense', playerId: 'p1' },
        { type: 'place', playerId: 'p1', placements: 'boom' },
        { type: 'annotate', playerId: 'p1', targetId: 'p2', x: 0, y: 0, mark: 'evil' },
        { type: 'resign', playerId: 'nobody' },
      ][rng.int(11)];
      try { E.applyCommand(s, junk); } catch (err) {
        assert(err instanceof E.RuleError, 'only RuleError may escape, got ' + err.constructor.name + ': ' + err.message);
      }
      // a real move sometimes, to keep states varied
      if (s.phase === 'battle' && rng.next() < 0.5) {
        const cur = E.currentPlayer(s);
        const fire = E.listLegalActions(s, cur.id).find((a) => a.type === 'fire');
        if (fire) {
          const cell = fire.cells[rng.int(fire.cells.length)];
          const { x, y } = E.cellToXY(cell, s.gridSize);
          E.applyCommand(s, { type: 'fire', playerId: cur.id, targetId: fire.targetId, x, y });
        }
      }
      assert(Number.isFinite(s.tick), 'tick stayed finite');
      assert(s.players.every((p) => Number.isFinite(p.shotsUsed)), 'shots finite');
    }
  }
});

/* ==================== content ==================== */

test('content: all 40 stages + 8 challenges validate clean', () => {
  eq(STAGES.length, 40);
  eq(CHALLENGES.length, 8);
  eq(THEMES.length, 5);
  for (const s of STAGES) {
    const v = validateStage(s);
    assert(v.ok && v.problems.length === 0, `${s.id}: ${v.problems.join(', ')}`);
  }
  for (const c of CHALLENGES) {
    const v = validateStage(c);
    assert(v.ok, `${c.id}: ${v.problems.join(', ')}`);
  }
  assert(stageById('j40') && challengeById('c08'));
});
test('content: validator rejects illegal stage', () => {
  const bad = { ...STAGES[0], id: 'bad', gridSize: 3 };
  assert(!validateStage(bad).ok);
});
test('content: daily is deterministic per UTC date', () => {
  const a = dailyStage('2026-08-19');
  const b = dailyStage('2026-08-19');
  eq(JSON.stringify(a), JSON.stringify(b));
  const c = dailyStage('2026-08-20');
  assert(JSON.stringify(a) !== JSON.stringify(c));
  for (let d = 1; d <= 28; d++) {
    const date = `2026-03-${String(d).padStart(2, '0')}`;
    const v = validateStage(dailyStage(date));
    assert(v.ok && v.problems.length === 0, `daily ${date}: ${v.problems.join(', ')}`);
  }
});

/* ==================== AI / full games ==================== */

test('ai: full games terminate at all difficulties, no loops', () => {
  for (const diff of ['easy', 'medium', 'hard']) {
    const { state } = playScriptedGame('ai-' + diff);
    eq(state.phase, 'finished');
    assert(state.winner === 'p1' || state.winner === 'p2');
  }
});
test('ai: hard beats easy across 6 seeded games', () => {
  let hardWins = 0;
  for (let i = 0; i < 6; i++) {
    const config = {
      seed: 'hve-' + i, gridSize: 8, fleetId: 'standard',
      players: [{ id: 'p1', isAI: true, difficulty: 'hard' }, { id: 'p2', isAI: true, difficulty: 'easy' }],
    };
    const s = E.createMatch(config);
    const streams = { p1: makeRng('h1' + i), p2: makeRng('h2' + i) };
    let guard = 0;
    while (s.phase !== 'finished' && guard++ < 2000) {
      if (s.phase === 'placement') {
        const p = s.players.find((q) => !q.placed);
        E.applyCommand(s, { type: 'auto-place', playerId: p.id });
      } else {
        const cur = E.currentPlayer(s);
        const cmd = chooseCommand(s, cur.id, streams[cur.id]);
        E.applyCommand(s, cmd);
      }
    }
    if (s.winner === 'p1') hardWins++;
  }
  assert(hardWins >= 4, `hard AI should dominate easy (won ${hardWins}/6)`);
});

/* ==================== session ==================== */

test('session: full AI game via GameSession reaches results', () => {
  const session = new GameSession({
    mode: 'practice',
    config: {
      seed: 'sess1', gridSize: 6, fleetId: 'patrol',
      players: [{ id: 'a', isAI: true, difficulty: 'medium' }, { id: 'b', isAI: true, difficulty: 'medium' }],
    },
  });
  let guard = 0;
  while (session.state.phase !== 'finished' && guard++ < 1000) {
    assert(session.needsAI());
    session.stepAI();
  }
  eq(session.state.phase, 'finished');
  const res = session.results(20);
  eq(res.length, 2);
  assert(res.some((r) => r.won));
});
test('session: undo restores pre-shot snapshot', () => {
  const session = new GameSession({
    mode: 'practice', assists: { undo: true, hints: true },
    config: {
      seed: 'undo1', gridSize: 6, fleetId: 'patrol',
      players: [{ id: 'you' }, { id: 'ai', isAI: true, difficulty: 'easy' }],
    },
  });
  session.command({ type: 'auto-place', playerId: 'you' });
  session.stepAI();
  eq(session.state.phase, 'battle');
  session.command({ type: 'fire', playerId: 'you', targetId: 'ai', x: 0, y: 0 });
  eq(session.state.players[0].shotsUsed, 1);
  assert(session.canUndo());
  session.undo();
  eq(session.state.players[0].shotsUsed, 0);
});
test('session: serialize/restore mid-game preserves state hash', () => {
  const session = new GameSession({
    mode: 'practice', assists: { undo: true },
    config: {
      seed: 'rest1', gridSize: 6, fleetId: 'patrol',
      players: [{ id: 'you' }, { id: 'ai', isAI: true, difficulty: 'medium' }],
    },
  });
  session.command({ type: 'auto-place', playerId: 'you' });
  session.stepAI();
  session.command({ type: 'fire', playerId: 'you', targetId: 'ai', x: 1, y: 1 });
  const hash = E.hashState(session.state);
  const back = GameSession.restore(session.serialize());
  eq(E.hashState(back.state), hash);
});
test('session: hint returns a legal cell', () => {
  const session = new GameSession({
    mode: 'practice', assists: { hints: true },
    config: {
      seed: 'hint1', gridSize: 6, fleetId: 'patrol',
      players: [{ id: 'you' }, { id: 'ai', isAI: true, difficulty: 'easy' }],
    },
  });
  session.command({ type: 'auto-place', playerId: 'you' });
  session.stepAI();
  const hint = session.hint('you');
  assert(hint && Number.isInteger(hint.cell));
  const fired = session.state.players[0].shotsFired.ai || {};
  assert(!(hint.cell in fired));
});

/* ==================== server (authoritative script) ==================== */

test('server: hosted session lifecycle, redaction, duplicates, deadline', () => {
  const s = createSession({
    seed: 'srv', gridSize: 8, fleetId: 'standard',
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  }, { sessionId: 'S1', now: 1000 });
  const place = (pid, id) => handleMessage(s, pid, { type: 'command', command: { id, type: 'auto-place', playerId: pid } }, 1000);
  assert(place('a', 'pa').ok);
  assert(place('b', 'pb').ok);
  // duplicate id
  const dup = handleMessage(s, 'a', { type: 'command', command: { id: 'pa', type: 'auto-place', playerId: 'a' } }, 1001);
  assert(dup.duplicate === true || dup.ok === false);
  // out of turn
  const oot = handleMessage(s, 'b', { type: 'command', command: { id: 'x1', type: 'fire', targetId: 'a', x: 0, y: 0 } }, 1002);
  eq(oot.ok, false);
  eq(oot.error, 'not-your-turn');
  // legal fire + redacted snapshot
  const r = handleMessage(s, 'a', { type: 'command', command: { id: 'f1', type: 'fire', targetId: 'b', x: 0, y: 0 } }, 1003);
  assert(r.ok);
  const snap = getSnapshot(s, 'a');
  const enemy = snap.players.find((p) => p.id === 'b');
  assert(enemy.ships.every((sh) => sh.sunk || sh.cells.length === 0), 'unsunk enemy ships hidden');
  eq(enemy.mines.length, 0);
  // rate limiting shape + membership
  const stranger = handleMessage(s, 'mallory', { type: 'ping' }, 1004);
  eq(stranger.ok, false);
  // deadline
  const to = checkDeadline(s, 1003 + 25 * 3600 * 1000);
  assert(to && to.timedOut, 'deadline forces a timeout resignation');
  assert(s.result || s.state.phase === 'finished', 'result contract set');
  const sum = sessionSummary(s);
  assert(sum.phase && sum.players.length === 2);
});

/* ==================== golden sessions ==================== */

test('golden: scripted easy/medium/hard sessions match pinned hashes', () => {
  const GOLDENS = {
    'gold-easy': 'cfd56fa4',
    'gold-medium': '15a8ec8f',
    'gold-hard': 'c4c2affa',
  };
  const configs = {
    'gold-easy': [{}, 6, 'patrol'],
    'gold-medium': [{ salvo: true }, 8, 'standard'],
    'gold-hard': [{ mineCount: 2, moveLimit: 60, fog: true }, 10, 'vanguard'],
  };
  for (const [seed, [mech, grid, fleet]] of Object.entries(configs)) {
    const { state } = playScriptedGame(seed, mech, grid, fleet);
    eq(state.phase, 'finished');
    const hash = E.hashState(state);
    if (GOLDENS[seed] === null) {
      console.log(`\n  [golden pin] ${seed} -> ${hash} (winner ${state.winner}, ticks ${state.tick})`);
    } else {
      eq(hash, GOLDENS[seed], `golden mismatch for ${seed}`);
    }
  }
});

/* ==================== summary ==================== */

console.log(`\n\n${passed} passed, ${failed} failed`);
if (failures.length) {
  for (const f of failures) {
    console.error(`\nFAIL: ${f.name}\n  ${f.err.stack?.split('\n').slice(0, 3).join('\n  ')}`);
  }
  process.exit(1);
}
