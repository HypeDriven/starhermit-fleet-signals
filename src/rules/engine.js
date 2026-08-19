/**
 * Fleet Signals — rules engine.
 *
 * Pure, deterministic, DOM-free. Every state transition goes through
 * applyCommand(); rendering and UI only ever consume immutable snapshots.
 * The same module powers the browser client, the practice AI, the test
 * suite and the authoritative hosted-play script (server.js).
 */
import { makeRng, hashString } from './rng.js';

export const RULES_VERSION = 3;

/** Original fleet compositions. Sizes are rules data; names are fiction. */
export const FLEETS = {
  standard: [
    { id: 'sentinel', name: 'Sentinel Carrier', size: 5 },
    { id: 'warden', name: 'Warden Cruiser', size: 4 },
    { id: 'lancer', name: 'Lancer Frigate', size: 3 },
    { id: 'skiff', name: 'Skiff Runner', size: 3 },
    { id: 'dart', name: 'Dart Scout', size: 2 },
  ],
  compact: [
    { id: 'warden', name: 'Warden Cruiser', size: 4 },
    { id: 'lancer', name: 'Lancer Frigate', size: 3 },
    { id: 'skiff', name: 'Skiff Runner', size: 3 },
    { id: 'dart', name: 'Dart Scout', size: 2 },
  ],
  vanguard: [
    { id: 'sentinel', name: 'Sentinel Carrier', size: 5 },
    { id: 'warden', name: 'Warden Cruiser', size: 4 },
    { id: 'warden2', name: 'Warden Cruiser', size: 4 },
    { id: 'lancer', name: 'Lancer Frigate', size: 3 },
    { id: 'dart', name: 'Dart Scout', size: 2 },
  ],
  patrol: [
    { id: 'lancer', name: 'Lancer Frigate', size: 3 },
    { id: 'dart', name: 'Dart Scout', size: 2 },
    { id: 'dart2', name: 'Dart Scout', size: 2 },
  ],
};

export const GRID_SIZES = { small: 6, standard: 8, large: 10 };

export const DEFAULT_MECHANICS = {
  salvo: false,        // one shot per surviving ship each turn
  moveLimit: 0,        // 0 = unlimited shots per player
  mineCount: 0,        // hidden hazard cells per board
  noTouch: false,      // ships may not be orthogonally adjacent
  allowUndo: false,    // practice assists
  fog: false,          // sunk events do not identify the ship
};

export class RuleError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RuleError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* coordinates                                                         */
/* ------------------------------------------------------------------ */

export function xyToCell(x, y, size) { return y * size + x; }
export function cellToXY(cell, size) { return { x: cell % size, y: Math.floor(cell / size) }; }
export function cellName(cell, size) {
  const { x, y } = cellToXY(cell, size);
  return String.fromCharCode(65 + x) + (y + 1);
}

/* ------------------------------------------------------------------ */
/* match creation                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {object} config
 * @param {string} config.seed            deterministic seed (string)
 * @param {Array}  config.players         [{id, name, isAI?, difficulty?}] (2–4)
 * @param {number} [config.gridSize]
 * @param {string} [config.fleetId]
 * @param {object} [config.mechanics]     partial overrides of DEFAULT_MECHANICS
 * @param {string} [config.contentId]     stage/daily identifier for replays
 * @param {string} [config.rulesetId]     e.g. 'duel', 'skirmish'
 */
export function createMatch(config) {
  if (!config || typeof config.seed !== 'string') throw new RuleError('malformed', 'seed required');
  const players = (config.players || []).map((p, i) => ({
    id: p.id || 'p' + i,
    name: p.name || 'Player ' + (i + 1),
    isAI: !!p.isAI,
    difficulty: p.difficulty || 'medium',
    placed: false,
    alive: true,
    ships: [],
    mines: [],
    shotsFired: {},   // targetPlayerId -> { cellIdx: 'hit'|'miss'|'mine' }
    shotsUsed: 0,
    hitsLanded: 0,
    invalidActions: 0,
    notes: {},        // targetPlayerId -> { cellIdx: 'flag'|'unknown' } (private annotations)
  }));
  if (players.length < 2 || players.length > 4) throw new RuleError('malformed', 'need 2-4 players');
  const ids = new Set(players.map((p) => p.id));
  if (ids.size !== players.length) throw new RuleError('malformed', 'duplicate player id');

  const gridSize = config.gridSize || GRID_SIZES.standard;
  if (gridSize < 4 || gridSize > 12) throw new RuleError('malformed', 'grid size out of range');
  const fleet = (FLEETS[config.fleetId || 'standard'] || FLEETS.standard).map((s) => ({ ...s }));
  const mechanics = { ...DEFAULT_MECHANICS, ...(config.mechanics || {}) };

  const totalCells = gridSize * gridSize;
  const fleetCells = fleet.reduce((a, s) => a + s.size, 0);
  if (fleetCells + mechanics.mineCount >= totalCells) {
    throw new RuleError('malformed', 'fleet and mines exceed grid');
  }

  // Hidden hazard cells, one deterministic set per player board.
  const state = {
    version: RULES_VERSION,
    contentId: config.contentId || null,
    rulesetId: config.rulesetId || (players.length > 2 ? 'skirmish' : 'duel'),
    seed: config.seed,
    tick: 0,
    phase: 'placement', // placement -> battle -> finished
    gridSize,
    fleet,
    mechanics,
    players,
    turnOrder: players.map((p) => p.id),
    currentPlayerIndex: 0,
    pendingShots: 0,
    winner: null,
    terminalReason: null,
    rngCursor: 0,
    seenCommandIds: [],
    log: [],
  };

  if (mechanics.mineCount > 0) {
    for (const p of state.players) {
      const stream = rulesStream(state, 'mines:' + p.id);
      const chosen = new Set();
      while (chosen.size < mechanics.mineCount) chosen.add(stream.int(totalCells));
      p.mines = [...chosen].sort((a, b) => a - b);
    }
  }
  return state;
}

/** Deterministic per-use rules stream; cursor keeps calls order-stable. */
function rulesStream(state, label) {
  return makeRng(hashString(state.seed + ':rules:' + label + ':' + state.rngCursor));
}

/* ------------------------------------------------------------------ */
/* placement                                                           */
/* ------------------------------------------------------------------ */

function shipCells(x, y, dir, size, gridSize) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const cx = dir === 'h' ? x + i : x;
    const cy = dir === 'h' ? y : y + i;
    if (cx < 0 || cy < 0 || cx >= gridSize || cy >= gridSize) return null;
    cells.push(xyToCell(cx, cy, gridSize));
  }
  return cells;
}

/**
 * Validate a full fleet placement.
 * @param placements [{shipId, x, y, dir:'h'|'v'}]
 * @returns {{ok:true, ships:Array}|{ok:false, reason:string}}
 */
export function validatePlacement(fleet, placements, gridSize, mechanics, mines = []) {
  if (!Array.isArray(placements)) return { ok: false, reason: 'placement-shape' };
  const byId = new Map();
  for (const pl of placements) {
    if (!pl || typeof pl.shipId !== 'string' || (pl.dir !== 'h' && pl.dir !== 'v')) {
      return { ok: false, reason: 'placement-shape' };
    }
    byId.set(pl.shipId, pl);
  }
  if (byId.size !== fleet.length) return { ok: false, reason: 'placement-shape' };
  const occupied = new Map(); // cell -> shipId
  const mineSet = new Set(mines);
  const ships = [];
  for (const def of fleet) {
    const pl = byId.get(def.id);
    if (!pl) return { ok: false, reason: 'placement-shape' };
    const cells = shipCells(pl.x, pl.y, pl.dir, def.size, gridSize);
    if (!cells) return { ok: false, reason: 'placement-out-of-bounds' };
    for (const c of cells) {
      if (occupied.has(c)) return { ok: false, reason: 'placement-overlap' };
      if (mineSet.has(c)) return { ok: false, reason: 'placement-mine' };
    }
    if (mechanics.noTouch) {
      for (const c of cells) {
        const { x, y } = cellToXY(c, gridSize);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
          const n = xyToCell(nx, ny, gridSize);
          if (occupied.has(n) && !cells.includes(n)) return { ok: false, reason: 'placement-adjacency' };
        }
      }
    }
    for (const c of cells) occupied.set(c, def.id);
    ships.push({ id: def.id, name: def.name, size: def.size, cells, hits: 0, sunk: false });
  }
  return { ok: true, ships };
}

/** Random legal placement using a seeded stream (used by AI and auto-place).
 *  Ships are placed largest-first with per-ship rejection sampling and a
 *  deterministic scan fallback, so dense rule sets (noTouch + mines) succeed. */
export function autoPlaceFleet(gridSize, fleet, mechanics, mines, rng) {
  const mineSet = new Set(mines || []);
  const ordered = [...fleet].sort((a, b) => b.size - a.size);
  const placements = [];
  const occupied = new Set();

  const fits = (def, cand) => {
    const cells = shipCells(cand.x, cand.y, cand.dir, def.size, gridSize);
    if (!cells) return null;
    for (const c of cells) {
      if (occupied.has(c) || mineSet.has(c)) return null;
    }
    if (mechanics.noTouch) {
      for (const c of cells) {
        const { x, y } = cellToXY(c, gridSize);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
          const n = xyToCell(nx, ny, gridSize);
          if (occupied.has(n) && !cells.includes(n)) return null;
        }
      }
    }
    return cells;
  };

  for (const def of ordered) {
    let cells = null;
    for (let attempt = 0; attempt < 500 && !cells; attempt++) {
      cells = fits(def, {
        shipId: def.id, x: rng.int(gridSize), y: rng.int(gridSize),
        dir: rng.next() < 0.5 ? 'h' : 'v',
      });
    }
    if (!cells) {
      // deterministic fallback scan
      outer:
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          for (const dir of ['h', 'v']) {
            cells = fits(def, { shipId: def.id, x, y, dir });
            if (cells) break outer;
          }
        }
      }
    }
    if (!cells) return null; // grid genuinely cannot host the fleet
    placements.push({ shipId: def.id, x: cellToXY(cells[0], gridSize).x, y: cellToXY(cells[0], gridSize).y, dir: cells.length > 1 ? (cells[1] - cells[0] === 1 ? 'h' : 'v') : 'h' });
    for (const c of cells) occupied.add(c);
  }
  // restore original fleet order for stable command payloads
  const byId = new Map(placements.map((p) => [p.shipId, p]));
  return fleet.map((f) => byId.get(f.id));
}

/* ------------------------------------------------------------------ */
/* legal actions                                                       */
/* ------------------------------------------------------------------ */

export function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) || null;
}
export function currentPlayer(state) {
  return state.players[state.currentPlayerIndex] || null;
}
export function alivePlayers(state) {
  return state.players.filter((p) => p.alive);
}
export function shipsRemaining(player) {
  return player.ships.filter((s) => !s.sunk).length;
}

function legalFireCells(state, shooter, target) {
  const fired = shooter.shotsFired[target.id] || {};
  const cells = [];
  const total = state.gridSize * state.gridSize;
  for (let c = 0; c < total; c++) if (!(c in fired)) cells.push(c);
  return cells;
}

/**
 * The single legality API used by play, tutorials and hints.
 * Returns compact descriptors; fire actions group cells per target.
 */
export function listLegalActions(state, playerId) {
  const player = getPlayer(state, playerId);
  if (!player || state.phase === 'finished') return [];
  if (state.phase === 'placement') {
    if (player.placed) return [];
    return [{ type: 'place' }, { type: 'auto-place' }, { type: 'resign' }];
  }
  // battle
  if (currentPlayer(state).id !== playerId || !player.alive) {
    return player.alive ? [{ type: 'annotate' }] : [];
  }
  const actions = [];
  const targets = alivePlayers(state).filter((p) => p.id !== playerId);
  for (const t of targets) {
    const cells = legalFireCells(state, player, t);
    if (cells.length) actions.push({ type: 'fire', targetId: t.id, cells });
  }
  if (actions.length === 0) actions.push({ type: 'pass' });
  actions.push({ type: 'annotate' });
  actions.push({ type: 'resign' });
  return actions;
}

/* ------------------------------------------------------------------ */
/* command application                                                 */
/* ------------------------------------------------------------------ */

let cmdCounter = 0;
/** Stable unique-ish command id (client-side convenience). */
export function makeCommandId(prefix = 'cmd') {
  cmdCounter = (cmdCounter + 1) % 0xffff;
  return `${prefix}-${Date.now().toString(36)}-${cmdCounter.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

function noteInvalid(state, playerId, err) {
  const p = getPlayer(state, playerId);
  if (p) p.invalidActions += 1;
  return err;
}

/**
 * Apply a validated command. Returns { state, events, duplicate? }.
 * Throws RuleError (with .code) on illegal input; the thrown state is
 * untouched except invalidActions bookkeeping on the player copy.
 *
 * The function mutates the given state object and returns it; callers who
 * need history keep their own serialized snapshots (session does).
 */
export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
    throw new RuleError('malformed', 'command must have a type');
  }
  if (typeof cmd.playerId !== 'string') throw new RuleError('malformed', 'playerId required');
  const player = getPlayer(state, cmd.playerId);
  if (!player) throw new RuleError('unknown-player', 'no such player');

  // Idempotent duplicate rejection.
  if (cmd.id && state.seenCommandIds.includes(cmd.id)) {
    return { state, events: [], duplicate: true };
  }

  const events = [];
  switch (cmd.type) {
    case 'place': cmdPlace(state, player, cmd, events, false); break;
    case 'auto-place': cmdPlace(state, player, cmd, events, true); break;
    case 'fire': cmdFire(state, player, cmd, events); break;
    case 'pass': cmdPass(state, player, events); break;
    case 'resign': cmdResign(state, player, events); break;
    case 'annotate': cmdAnnotate(state, player, cmd, events); break;
    default: throw noteInvalid(state, cmd.playerId, new RuleError('malformed', 'unknown command type'));
  }

  if (cmd.id) {
    state.seenCommandIds.push(cmd.id);
    if (state.seenCommandIds.length > 512) state.seenCommandIds.splice(0, state.seenCommandIds.length - 512);
  }
  state.tick += 1;
  return { state, events };
}

function cmdPlace(state, player, cmd, events, auto) {
  if (state.phase !== 'placement') throw noteInvalid(state, player.id, new RuleError('phase', 'placement is closed'));
  if (player.placed) throw noteInvalid(state, player.id, new RuleError('not-legal', 'fleet already placed'));
  let placements = cmd.placements;
  if (auto) {
    const stream = rulesStream(state, 'auto:' + player.id);
    state.rngCursor += 1;
    placements = autoPlaceFleet(state.gridSize, state.fleet, state.mechanics, player.mines, stream);
    if (!placements) throw new RuleError('not-legal', 'no legal placement found');
  }
  const v = validatePlacement(state.fleet, placements, state.gridSize, state.mechanics, player.mines);
  if (!v.ok) throw noteInvalid(state, player.id, new RuleError(v.reason, 'illegal placement: ' + v.reason));
  player.ships = v.ships;
  player.placed = true;
  events.push({ type: 'placed', playerId: player.id, placements });
  if (state.players.every((p) => p.placed || !p.alive)) {
    state.phase = 'battle';
    state.pendingShots = shotsForTurn(state, currentPlayer(state));
    events.push({ type: 'phase', phase: 'battle' });
    state.log.push({ tick: state.tick, text: 'All fleets deployed. Battle stations.' });
  }
}

function shotsForTurn(state, player) {
  if (!state.mechanics.salvo) return 1;
  return Math.max(1, shipsRemaining(player));
}

function cmdFire(state, player, cmd, events) {
  if (state.phase !== 'battle') throw noteInvalid(state, player.id, new RuleError('phase', 'not in battle phase'));
  if (currentPlayer(state).id !== player.id) throw noteInvalid(state, player.id, new RuleError('not-your-turn', 'wait for your turn'));
  if (!player.alive) throw new RuleError('not-legal', 'eliminated players cannot fire');
  const target = getPlayer(state, cmd.targetId);
  if (!target) throw new RuleError('unknown-target', 'no such target');
  if (target.id === player.id) throw noteInvalid(state, player.id, new RuleError('not-legal', 'cannot target yourself'));
  if (!target.alive) throw noteInvalid(state, player.id, new RuleError('target-not-alive', 'that fleet is already sunk'));
  const { x, y } = cmd;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= state.gridSize || y >= state.gridSize) {
    throw noteInvalid(state, player.id, new RuleError('cell-out-of-bounds', 'coordinate off the chart'));
  }
  const cell = xyToCell(x, y, state.gridSize);
  const fired = (player.shotsFired[target.id] = player.shotsFired[target.id] || {});
  if (cell in fired) throw noteInvalid(state, player.id, new RuleError('cell-already-targeted', 'already fired there'));

  player.shotsUsed += 1;
  let result = 'miss';
  let sunkShip = null;
  const ship = target.ships.find((s) => s.cells.includes(cell));
  if (ship) {
    ship.hits += 1;
    player.hitsLanded += 1;
    result = 'hit';
    if (ship.hits >= ship.size) {
      ship.sunk = true;
      sunkShip = ship;
      result = 'sunk';
    }
  } else if (target.mines.includes(cell)) {
    result = 'mine';
    // Hazard: striking a mine consumes an extra shot from the player's allowance.
    player.shotsUsed += 1;
  }
  fired[cell] = result === 'sunk' ? 'hit' : result;

  const ev = {
    type: 'shot', by: player.id, targetId: target.id, cell, x, y,
    result,
    shipId: sunkShip && !state.mechanics.fog ? sunkShip.id : undefined,
    shipName: sunkShip && !state.mechanics.fog ? sunkShip.name : undefined,
  };
  events.push(ev);
  state.log.push({
    tick: state.tick,
    text: `${player.name} fires on ${cellName(cell, state.gridSize)} — ` +
      (result === 'miss' ? 'open water.' : result === 'mine' ? 'a mine! Extra charge spent.' :
       result === 'hit' ? 'hit!' : `${state.mechanics.fog ? 'an enemy ship' : sunkShip.name} sunk!`),
  });

  // Elimination / victory checks.
  if (target.ships.length && target.ships.every((s) => s.sunk)) {
    target.alive = false;
    events.push({ type: 'eliminated', playerId: target.id, by: player.id });
    state.log.push({ tick: state.tick, text: `${target.name}'s fleet has been destroyed.` });
  }
  const alive = alivePlayers(state);
  if (alive.length === 1) {
    finish(state, events, alive[0].id, 'fleet-destroyed');
    return;
  }
  if (alive.length === 0) { // theoretically impossible, guarded for fuzz safety
    finish(state, events, null, 'fleet-destroyed');
    return;
  }

  // Move-limit exhaustion.
  if (state.mechanics.moveLimit > 0) {
    const exhausted = alive.filter((p) => p.shotsUsed >= state.mechanics.moveLimit);
    if (exhausted.length === alive.length) {
      // Winner: most enemy ships sunk, then most hits, then fewest shots.
      const score = (p) => {
        let sunk = 0;
        for (const q of state.players) {
          if (q.id === p.id) continue;
          const f = p.shotsFired[q.id] || {};
          for (const s of q.ships) if (s.sunk && s.cells.some((c) => c in f)) sunk += 1;
        }
        return sunk;
      };
      const ranked = [...alive].sort((a, b) =>
        score(b) - score(a) || b.hitsLanded - a.hitsLanded || a.shotsUsed - b.shotsUsed);
      finish(state, events, ranked[0].id, 'move-limit');
      return;
    }
  }

  // Turn advancement.
  state.pendingShots -= 1;
  if (state.pendingShots <= 0) {
    advanceTurn(state);
    state.pendingShots = shotsForTurn(state, currentPlayer(state));
    events.push({ type: 'turn', playerId: currentPlayer(state).id });
  }
}

function advanceTurn(state) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (state.currentPlayerIndex + i) % n;
    const p = state.players[idx];
    if (!p.alive) continue;
    if (state.mechanics.moveLimit > 0 && p.shotsUsed >= state.mechanics.moveLimit) continue;
    state.currentPlayerIndex = idx;
    return;
  }
}

function cmdPass(state, player, events) {
  if (state.phase !== 'battle') throw noteInvalid(state, player.id, new RuleError('phase', 'not in battle phase'));
  if (currentPlayer(state).id !== player.id) throw noteInvalid(state, player.id, new RuleError('not-your-turn', 'wait for your turn'));
  const hasFire = listLegalActions(state, player.id).some((a) => a.type === 'fire');
  if (hasFire) throw noteInvalid(state, player.id, new RuleError('not-legal', 'you still have legal shots'));
  advanceTurn(state);
  state.pendingShots = shotsForTurn(state, currentPlayer(state));
  events.push({ type: 'turn', playerId: currentPlayer(state).id, passed: player.id });
}

function cmdResign(state, player, events) {
  if (state.phase === 'finished') throw new RuleError('phase', 'match is over');
  player.alive = false;
  events.push({ type: 'resigned', playerId: player.id });
  state.log.push({ tick: state.tick, text: `${player.name} strikes their colours.` });
  const alive = alivePlayers(state);
  if (state.phase === 'battle' && alive.length === 1) {
    finish(state, events, alive[0].id, 'resign');
  } else if (alive.length <= 1) {
    finish(state, events, alive[0] ? alive[0].id : null, 'resign');
  } else if (state.phase === 'battle' && currentPlayer(state).id === player.id) {
    advanceTurn(state);
    state.pendingShots = shotsForTurn(state, currentPlayer(state));
  }
}

function cmdAnnotate(state, player, cmd, events) {
  // Private deduction notes: never affect resolution, never end a turn.
  const target = getPlayer(state, cmd.targetId);
  if (!target) throw new RuleError('unknown-target', 'no such target');
  const { x, y, mark } = cmd;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= state.gridSize || y >= state.gridSize) {
    throw new RuleError('cell-out-of-bounds', 'coordinate off the chart');
  }
  if (mark !== 'flag' && mark !== 'unknown' && mark !== null) {
    throw new RuleError('malformed', 'mark must be flag|unknown|null');
  }
  const cell = xyToCell(x, y, state.gridSize);
  const notes = (player.notes[target.id] = player.notes[target.id] || {});
  if (mark === null) delete notes[cell]; else notes[cell] = mark;
  events.push({ type: 'annotated', playerId: player.id, targetId: target.id, cell, mark });
  state.tick -= 1; // annotations do not advance the clock (net zero with caller's +1)
}

function finish(state, events, winnerId, reason) {
  state.phase = 'finished';
  state.winner = winnerId;
  state.terminalReason = reason;
  events.push({ type: 'finish', winner: winnerId, reason });
  const w = winnerId ? getPlayer(state, winnerId) : null;
  state.log.push({ tick: state.tick, text: w ? `${w.name} wins — ${reason}.` : `Match drawn — ${reason}.` });
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

export const SCORE_TABLE = {
  win: 500,
  hit: 25,
  sunk: 100,
  accuracyMax: 300,
  shotSpared: 10,     // only when a move limit applies
  invalidPenalty: -15,
};

/** Component breakdown; all integers, formatted only in presentation. */
export function scoreMatch(state, playerId) {
  const p = getPlayer(state, playerId);
  if (!p) throw new RuleError('unknown-player', 'no such player');
  const won = state.winner === playerId;
  let sunk = 0;
  for (const q of state.players) {
    if (q.id === playerId) continue;
    const f = p.shotsFired[q.id] || {};
    for (const s of q.ships) if (s.sunk && s.cells.some((c) => c in f)) sunk += 1;
  }
  const accuracy = p.shotsUsed > 0 ? p.hitsLanded / p.shotsUsed : 0;
  const components = [];
  if (won) components.push({ key: 'win', label: 'Victory', points: SCORE_TABLE.win });
  components.push({ key: 'hits', label: `Hits landed (${p.hitsLanded})`, points: SCORE_TABLE.hit * p.hitsLanded });
  components.push({ key: 'sunk', label: `Ships sunk (${sunk})`, points: SCORE_TABLE.sunk * sunk });
  components.push({ key: 'accuracy', label: `Accuracy (${Math.round(accuracy * 100)}%)`, points: Math.round(SCORE_TABLE.accuracyMax * accuracy) });
  if (state.mechanics.moveLimit > 0 && won) {
    const spared = Math.max(0, state.mechanics.moveLimit - p.shotsUsed);
    components.push({ key: 'efficiency', label: `Shots spared (${spared})`, points: SCORE_TABLE.shotSpared * spared });
  }
  if (p.invalidActions > 0) {
    components.push({ key: 'invalid', label: `Invalid actions (${p.invalidActions})`, points: SCORE_TABLE.invalidPenalty * p.invalidActions });
  }
  const total = components.reduce((a, c) => a + c.points, 0);
  return { total, components, won, accuracy, shotsUsed: p.shotsUsed, sunk };
}

/**
 * Tie-break order per spec: score, primary objective, fewer invalid
 * actions, lower authoritative elapsed time, stable session identifier.
 * Result objects: {score, won, invalidActions, elapsedMs, sessionId}.
 * Returns negative if a ranks above b.
 */
export function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.won !== b.won) return (b.won ? 1 : 0) - (a.won ? 1 : 0);
  if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
  if ((a.elapsedMs | 0) !== (b.elapsedMs | 0)) return (a.elapsedMs | 0) - (b.elapsedMs | 0);
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

/** Journey star rating: win = 1, +1 at/under par shots, +1 accuracy ≥ 60%. */
export function starRating({ won, shotsUsed, accuracy, par }) {
  if (!won) return 0;
  let stars = 1;
  if (Number.isFinite(par) && shotsUsed <= par) stars += 1;
  if (accuracy >= 0.6) stars += 1;
  return stars;
}

/* ------------------------------------------------------------------ */
/* serialization, hashing, migration                                   */
/* ------------------------------------------------------------------ */

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

/** Stable short hash of the logical state (excludes seenCommandIds). */
export function hashState(state) {
  const clone = { ...state, seenCommandIds: [] };
  return hashString(canonical(clone)).toString(16).padStart(8, '0');
}

export function serializeState(state) {
  return JSON.stringify(state);
}

export function deserializeState(json) {
  const state = typeof json === 'string' ? JSON.parse(json) : json;
  return migrateState(state);
}

/** Versioned migration chain; each step upgrades exactly one version. */
export function migrateState(state) {
  if (!state || typeof state !== 'object') throw new RuleError('malformed', 'bad snapshot');
  let s = state;
  if (s.version === 1) { // v1 -> v2: invalidActions bookkeeping added
    for (const p of s.players) if (typeof p.invalidActions !== 'number') p.invalidActions = 0;
    s.version = 2;
  }
  if (s.version === 2) { // v2 -> v3: private notes added
    for (const p of s.players) if (!p.notes) p.notes = {};
    s.version = 3;
  }
  if (s.version !== RULES_VERSION) throw new RuleError('malformed', 'unsupported snapshot version ' + s.version);
  return s;
}

/* ------------------------------------------------------------------ */
/* replay envelope                                                     */
/* ------------------------------------------------------------------ */

export function createReplayEnvelope(config) {
  return {
    schema: 1,
    rulesVersion: RULES_VERSION,
    contentId: config.contentId || null,
    seed: config.seed,
    initialHash: null,
    timestampOffset: 0,
    commands: [],
    stateHashes: [],
    terminal: null,
  };
}

/** Record a command + resulting hash into a replay envelope. */
export function recordReplayStep(envelope, cmd, state) {
  if (envelope.initialHash === null && envelope.commands.length === 0 && state.phase === 'placement') {
    envelope.initialHash = hashState(state);
  }
  envelope.commands.push(cmd);
  envelope.stateHashes.push({ tick: state.tick, hash: hashState(state) });
  if (state.phase === 'finished') {
    envelope.terminal = { winner: state.winner, reason: state.terminalReason };
  }
}

/** Re-run an envelope; returns { ok, finalHash, mismatchAt? }. */
export function verifyReplay(config, envelope) {
  let state = createMatch(config);
  for (let i = 0; i < envelope.commands.length; i++) {
    applyCommand(state, envelope.commands[i]);
    const expected = envelope.stateHashes[i];
    if (expected && expected.hash !== hashState(state)) {
      return { ok: false, mismatchAt: i, finalHash: hashState(state) };
    }
  }
  return { ok: true, finalHash: hashState(state) };
}
