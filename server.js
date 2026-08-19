/**
 * Fleet Signals — authoritative StarHermit game script for hosted play.
 *
 * Pure Node/browser-neutral ESM. Wraps the rules engine with session
 * membership, turn/tick validation, rate limiting, payload limits,
 * idempotent duplicate rejection, redacted snapshots, and the
 * authoritative result contract. All legality is decided by the engine;
 * client-supplied state is never trusted.
 */
import {
  createMatch, applyCommand, scoreMatch, RuleError,
  currentPlayer, getPlayer,
} from './src/rules/engine.js';

const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000; // per-turn, 24h
const MAX_PAYLOAD_BYTES = 4096;
const RATE_LIMIT_MAX = 20;        // messages
const RATE_LIMIT_WINDOW_MS = 10000;

let sessionCounter = 0;

/**
 * @param {object} config  passed straight to engine createMatch
 * @param {object} [options] {sessionId, deadlineMs, now}
 */
export function createSession(config, options = {}) {
  const players = (config && config.players) || [];
  if (players.length < 2 || players.length > 4) {
    throw new RuleError('malformed', 'need 2-4 players');
  }
  const state = createMatch(config);
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const deadlineMs = options.deadlineMs || DEFAULT_DEADLINE_MS;
  sessionCounter += 1;
  const sessionId = options.sessionId || `sess-${now.toString(36)}-${sessionCounter.toString(36)}`;
  const deadlines = {};
  for (const p of state.players) deadlines[p.id] = now + deadlineMs;
  return {
    sessionId,
    createdAt: now,
    state,
    moves: [],
    deadlines,
    result: null,
    deadlineMs,
    seenCommandIds: new Set(),
    rateLimits: {}, // playerId -> [timestamps]
  };
}

function isMember(session, playerId) {
  return !!getPlayer(session.state, playerId);
}

function checkRateLimit(session, playerId, nowMs) {
  const stamps = (session.rateLimits[playerId] = session.rateLimits[playerId] || []);
  const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
  while (stamps.length && stamps[0] <= cutoff) stamps.shift();
  if (stamps.length >= RATE_LIMIT_MAX) return false;
  stamps.push(nowMs);
  return true;
}

function refreshDeadline(session, nowMs) {
  const cur = currentPlayer(session.state);
  if (cur) session.deadlines[cur.id] = nowMs + session.deadlineMs;
}

function finalizeIfFinished(session, nowMs) {
  const state = session.state;
  if (state.phase !== 'finished' || session.result) return;
  const scores = {};
  for (const p of state.players) scores[p.id] = scoreMatch(state, p.id).total;
  session.result = {
    winner: state.winner,
    reason: state.terminalReason,
    scores,
    finishedAt: nowMs,
  };
}

/**
 * Handle one client message. msg must be a JSON-able object with
 * type 'command' | 'ping' and a serialized length <= 4096 bytes.
 */
export function handleMessage(session, playerId, msg, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, error: 'malformed' };
  }
  let payload;
  try {
    payload = JSON.stringify(msg);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (payload.length > MAX_PAYLOAD_BYTES) return { ok: false, error: 'payload-too-large' };
  if (!isMember(session, playerId)) return { ok: false, error: 'not-a-member' };
  if (!checkRateLimit(session, playerId, now)) return { ok: false, error: 'rate-limited' };

  if (msg.type === 'ping') {
    return { ok: true, snapshot: getSnapshot(session, playerId) };
  }
  if (msg.type !== 'command') return { ok: false, error: 'malformed' };

  const command = msg.command;
  if (!command || typeof command !== 'object' || typeof command.id !== 'string' || !command.id) {
    return { ok: false, error: 'malformed' };
  }
  // Idempotent duplicate rejection.
  if (session.seenCommandIds.has(command.id)) {
    return { ok: true, duplicate: true, events: [] };
  }
  // The sender is authoritative for identity; clients cannot spoof actors.
  command.playerId = playerId;

  let applied;
  try {
    applied = applyCommand(session.state, command);
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, error: err.code };
    throw err;
  }
  session.state = applied.state;
  session.seenCommandIds.add(command.id);
  session.moves.push({ tick: session.state.tick, playerId, command });
  refreshDeadline(session, now);
  finalizeIfFinished(session, now);
  return { ok: true, events: applied.events, snapshot: getSnapshot(session, playerId) };
}

/**
 * Authoritative per-turn timeout. If the current player's deadline has
 * passed during the battle phase, resign them and advance the match.
 * @returns {{timedOut: string}|null}
 */
export function checkDeadline(session, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const state = session.state;
  if (state.phase !== 'battle') return null;
  const cur = currentPlayer(state);
  if (!cur) return null;
  const deadline = session.deadlines[cur.id];
  if (typeof deadline !== 'number' || now <= deadline) return null;

  const command = { type: 'resign', playerId: cur.id, id: `timeout-${cur.id}-${state.tick}` };
  const applied = applyCommand(state, command);
  session.state = applied.state;
  session.seenCommandIds.add(command.id);
  session.moves.push({ tick: session.state.tick, playerId: cur.id, command });
  refreshDeadline(session, now);
  finalizeIfFinished(session, now);
  return { timedOut: cur.id };
}

/**
 * Redacted per-player snapshot: enemy unsunk ship cells, mines and
 * private notes are stripped; sunk wrecks stay visible. Derived only
 * from authoritative session state.
 */
export function getSnapshot(session, playerId) {
  const view = structuredClone(session.state);
  for (const p of view.players) {
    if (p.id === playerId) continue;
    for (const ship of p.ships) {
      if (!ship.sunk) ship.cells = [];
    }
    p.mines = [];
    p.notes = {};
  }
  view.seenCommandIds = [];
  return view;
}

/** Compact lobby/status summary. */
export function sessionSummary(session) {
  const state = session.state;
  const cur = currentPlayer(state);
  return {
    sessionId: session.sessionId,
    phase: state.phase,
    tick: state.tick,
    players: state.players.map((p) => ({
      id: p.id, name: p.name, alive: p.alive, placed: p.placed,
    })),
    currentPlayerId: cur ? cur.id : null,
    result: session.result,
  };
}
