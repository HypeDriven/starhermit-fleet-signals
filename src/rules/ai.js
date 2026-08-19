/**
 * Practice/hosted AI. Deterministic: given the same visible state and seed
 * stream it always picks the same command. Difficulty changes search
 * quality, never the rules.
 */
import {
  listLegalActions, cellToXY, xyToCell, getPlayer, alivePlayers,
} from './engine.js';

/** Pick the AI's next command for the current state. */
export function chooseCommand(state, playerId, rng) {
  const legal = listLegalActions(state, playerId);
  if (legal.length === 0) return null;
  if (state.phase === 'placement') {
    return { type: 'auto-place', playerId };
  }
  const fire = legal.find((a) => a.type === 'fire');
  if (!fire) return { type: 'pass', playerId };
  const me = getPlayer(state, playerId);
  const difficulty = me.difficulty || 'medium';

  // 1v1: single target. Skirmish: prefer the target we have already damaged.
  const targets = legal.filter((a) => a.type === 'fire');
  let chosen = targets[0];
  if (targets.length > 1) {
    let best = -1;
    for (const t of targets) {
      const f = me.shotsFired[t.targetId] || {};
      const hits = Object.values(f).filter((r) => r === 'hit').length;
      if (hits > best) { best = hits; chosen = t; }
    }
  }

  const cell = pickCell(state, me, chosen.targetId, chosen.cells, difficulty, rng);
  const { x, y } = cellToXY(cell, state.gridSize);
  return { type: 'fire', playerId, targetId: chosen.targetId, x, y };
}

function pickCell(state, me, targetId, legalCells, difficulty, rng) {
  const fired = me.shotsFired[targetId] || {};
  if (difficulty === 'easy') {
    return legalCells[rng.int(legalCells.length)];
  }
  // medium+: hunt/target — chase orthogonal neighbours of unsunk hits.
  const target = getPlayer(state, targetId);
  const unsunkHitCells = [];
  for (const [cellStr, result] of Object.entries(fired)) {
    if (result !== 'hit') continue;
    const cell = Number(cellStr);
    const ship = target.ships.find((s) => s.cells.includes(cell));
    if (ship && !ship.sunk) unsunkHitCells.push(cell);
  }
  const candidates = new Set();
  const size = state.gridSize;
  for (const cell of unsunkHitCells) {
    const { x, y } = cellToXY(cell, size);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const n = xyToCell(nx, ny, size);
      if (!(n in fired)) candidates.add(n);
    }
  }
  // hard: extend along known hit lines before radiating.
  if (difficulty === 'hard' && unsunkHitCells.length >= 2) {
    const line = lineExtension(unsunkHitCells, fired, size);
    if (line.length) return line[rng.int(line.length)];
  }
  if (candidates.size) {
    const arr = [...candidates];
    return arr[rng.int(arr.length)];
  }
  if (difficulty === 'hard') {
    // parity + probability density over remaining ship shapes
    return densityPick(state, target, fired, legalCells, rng);
  }
  // medium: plain parity checkerboard hunt
  const parity = legalCells.filter((c) => {
    const { x, y } = cellToXY(c, size);
    return (x + y) % 2 === 0;
  });
  const pool = parity.length ? parity : legalCells;
  return pool[rng.int(pool.length)];
}

function lineExtension(hitCells, fired, size) {
  const out = [];
  const byRow = new Map(), byCol = new Map();
  for (const c of hitCells) {
    const { x, y } = cellToXY(c, size);
    if (!byRow.has(y)) byRow.set(y, []);
    if (!byCol.has(x)) byCol.set(x, []);
    byRow.get(y).push(x);
    byCol.get(x).push(y);
  }
  const pushIfLegal = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const c = xyToCell(x, y, size);
    if (!(c in fired)) out.push(c);
  };
  for (const [y, xs] of byRow) {
    if (xs.length < 2) continue;
    pushIfLegal(Math.min(...xs) - 1, y);
    pushIfLegal(Math.max(...xs) + 1, y);
  }
  for (const [x, ys] of byCol) {
    if (ys.length < 2) continue;
    pushIfLegal(x, Math.min(...ys) - 1);
    pushIfLegal(x, Math.max(...ys) + 1);
  }
  return out;
}

/** Probability-density hunt: score each legal cell by placements covering it. */
function densityPick(state, target, fired, legalCells, rng) {
  const size = state.gridSize;
  const remaining = target.ships.filter((s) => !s.sunk).map((s) => s.size);
  const scores = new Map(legalCells.map((c) => [c, 0]));
  for (const len of remaining) {
    for (const dir of ['h', 'v']) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const cells = [];
          let ok = true;
          for (let i = 0; i < len; i++) {
            const cx = dir === 'h' ? x + i : x;
            const cy = dir === 'h' ? y : y + i;
            if (cx >= size || cy >= size) { ok = false; break; }
            const c = xyToCell(cx, cy, size);
            if (fired[c] === 'miss' || fired[c] === 'mine') { ok = false; break; }
            cells.push(c);
          }
          if (!ok) continue;
          const hitBonus = cells.some((c) => fired[c] === 'hit') ? 10 : 1;
          for (const c of cells) if (scores.has(c)) scores.set(c, scores.get(c) + hitBonus);
        }
      }
    }
  }
  let best = -1;
  let bestCells = [];
  for (const [c, s] of scores) {
    if (s > best) { best = s; bestCells = [c]; } else if (s === best) bestCells.push(c);
  }
  if (!bestCells.length) return legalCells[rng.int(legalCells.length)];
  return bestCells[rng.int(bestCells.length)];
}

/** Hint for the human player: reuse the hard AI's pick without consuming it. */
export function suggestTarget(state, playerId) {
  const legal = listLegalActions(state, playerId);
  const fire = legal.find((a) => a.type === 'fire');
  if (!fire) return null;
  const me = getPlayer(state, playerId);
  const stream = { int: (n) => 0, next: () => 0 }; // deterministic, no randomness spent
  const cell = pickCell(state, me, fire.targetId, fire.cells, 'hard', stream);
  return { targetId: fire.targetId, cell, ...cellToXY(cell, state.gridSize) };
}
