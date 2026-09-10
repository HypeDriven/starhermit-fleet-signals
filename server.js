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
import { pathToFileURL } from 'node:url';

const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000; // per-turn, 24h
const MAX_PAYLOAD_BYTES = 4096;
const RATE_LIMIT_MAX = 20;        // messages
const RATE_LIMIT_WINDOW_MS = 10000;
const MAX_SEEN_COMMAND_IDS = 512;  // mirrors the engine's own replay-guard cap

const _utf8Encoder = new TextEncoder();
/** Byte length of a UTF-8 string, matching the named byte cap. */
function utf8Bytes(str) {
  return _utf8Encoder.encode(str).length;
}

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

/** Record an accepted command id, evicting the oldest beyond the cap. */
function rememberCommandId(session, id) {
  session.seenCommandIds.add(id);
  while (session.seenCommandIds.size > MAX_SEEN_COMMAND_IDS) {
    const oldest = session.seenCommandIds.values().next().value;
    session.seenCommandIds.delete(oldest);
  }
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
  if (utf8Bytes(payload) > MAX_PAYLOAD_BYTES) return { ok: false, error: 'payload-too-large' };
  if (!isMember(session, playerId)) return { ok: false, error: 'not-a-member' };
  if (!checkRateLimit(session, playerId, now)) return { ok: false, error: 'rate-limited' };

  if (msg.type === 'ping') {
    return { ok: true, snapshot: getSnapshot(session, playerId) };
  }
  if (msg.type !== 'command') return { ok: false, error: 'malformed' };

  const incoming = msg.command;
  if (!incoming || typeof incoming !== 'object' || typeof incoming.id !== 'string' || !incoming.id) {
    return { ok: false, error: 'malformed' };
  }
  // Idempotent duplicate rejection.
  if (session.seenCommandIds.has(incoming.id)) {
    return { ok: true, duplicate: true, events: [] };
  }
  // The sender is authoritative for identity; clients cannot spoof actors.
  // Work on a copy so the transport's own message object is left untouched.
  const command = { ...incoming, playerId };

  let applied;
  try {
    applied = applyCommand(session.state, command);
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, error: err.code };
    throw err;
  }
  session.state = applied.state;
  rememberCommandId(session, command.id);
  session.moves.push({ tick: session.state.tick, playerId, command });
  refreshDeadline(session, now);
  finalizeIfFinished(session, now);
  return { ok: true, events: applied.events, snapshot: getSnapshot(session, playerId) };
}

/**
 * Authoritative per-turn timeout. If a player's stored deadline has
 * elapsed, resign them and advance the match. In battle this is the
 * current player's turn; in placement it is any unplaced, alive player
 * whose own deadline has passed (placement is turn-taking, so the phase
 * must also be enforced and not stall forever).
 * @returns {{timedOut: string}|null}
 */
export function checkDeadline(session, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const state = session.state;
  if (state.phase === 'finished') return null;

  let target = null;
  if (state.phase === 'battle') {
    const cur = currentPlayer(state);
    if (cur && cur.alive) target = cur;
  } else if (state.phase === 'placement') {
    for (const p of state.players) {
      if (!p.alive || p.placed) continue;
      const d = session.deadlines[p.id];
      if (typeof d === 'number' && now > d) { target = p; break; }
    }
  }
  if (!target) return null;

  const deadline = session.deadlines[target.id];
  if (typeof deadline !== 'number' || now <= deadline) return null;

  const command = { type: 'resign', playerId: target.id, id: `timeout-${target.id}-${state.tick}` };
  const applied = applyCommand(state, command);
  session.state = applied.state;
  rememberCommandId(session, command.id);
  session.moves.push({ tick: session.state.tick, playerId: target.id, command });
  refreshDeadline(session, now);
  finalizeIfFinished(session, now);
  return { timedOut: target.id };
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

/* ------------------------------------------------------------------ */
/* runnable host — only when this module is executed directly          */
/* ------------------------------------------------------------------ */

async function startHost() {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { extname, join, normalize, sep } = await import('node:path');

  const ROOT = process.cwd();
  const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2',
  };

  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.startsWith('/api/')) {
        // The offline-tolerant platform adapter's endpoints.
        if (path === '/api/v1/time') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ time: Date.now() }));
        }
        res.writeHead(204); // telemetry / presence and any other api route
        return res.end();
      }
      const file = normalize(join(ROOT, path === '/' ? '/index.html' : path));
      // Must stay inside ROOT itself — a bare prefix test would also accept
      // a sibling directory whose name starts with ROOT.
      if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403); return res.end(); }
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  const port = Number(process.env.PORT) || 8080;
  server.listen(port, () => {
    console.log(`Fleet Signals hosting on http://localhost:${port}`);
  });
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  startHost().catch((err) => { console.error(err); process.exit(1); });
}
