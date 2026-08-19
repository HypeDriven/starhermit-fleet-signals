/**
 * Session layer: wraps the rules engine for one match.
 * Owns undo snapshots, the AI driver, the replay envelope, elapsed time
 * and result computation. Never renders; UI consumes events + snapshots.
 */
import * as E from '../rules/engine.js';
import { chooseCommand, suggestTarget } from '../rules/ai.js';
import { makeRng } from '../rules/rng.js';

export class GameSession {
  /**
   * @param {object} opts
   * @param {object} opts.config      engine createMatch config
   * @param {string} opts.mode        learn|journey|daily|practice|challenge|hosted
   * @param {object} [opts.assists]   { undo:bool, hints:bool }
   * @param {string} [opts.localPlayerId] primary human seat
   */
  constructor(opts) {
    this.config = opts.config;
    this.mode = opts.mode || 'practice';
    this.assists = { undo: false, hints: true, ...(opts.assists || {}) };
    this.localPlayerId = opts.localPlayerId || (opts.config.players[0] && opts.config.players[0].id);
    this.state = E.createMatch(opts.config);
    this.undoStack = [];
    this.replay = E.createReplayEnvelope(opts.config);
    this.replay.initialHash = E.hashState(this.state);
    this.aiStreams = new Map();
    this.startedAt = null;   // ms, set when battle begins
    this.finishedAt = null;
    this.elapsedCarry = 0;
    this.lastEvents = [];
  }

  /** Apply a command; assigns a command id; records replay + undo. */
  command(cmd) {
    if (!cmd.id) cmd.id = E.makeCommandId(this.mode);
    const wasBattle = this.state.phase === 'battle';
    if (this.assists.undo && !this.state.players.find((p) => p.id === cmd.playerId)?.isAI) {
      this.undoStack.push(E.serializeState(this.state));
      if (this.undoStack.length > 64) this.undoStack.shift();
    }
    const { events, duplicate } = E.applyCommand(this.state, cmd);
    if (!duplicate) E.recordReplayStep(this.replay, cmd, this.state);
    if (!wasBattle && this.state.phase === 'battle' && this.startedAt === null) {
      this.startedAt = Date.now();
    }
    if (this.state.phase === 'finished' && this.finishedAt === null) {
      this.finishedAt = Date.now();
    }
    this.lastEvents = events;
    return { events, duplicate: !!duplicate };
  }

  /** True when the current actor (or an unplaced one) is AI-controlled. */
  needsAI() {
    const s = this.state;
    if (s.phase === 'finished') return false;
    if (s.phase === 'placement') {
      return s.players.some((p) => p.isAI && !p.placed && p.alive);
    }
    const cur = E.currentPlayer(s);
    return !!(cur && cur.isAI && cur.alive);
  }

  /** Execute one AI command. Returns {events} or null. */
  stepAI() {
    const s = this.state;
    if (s.phase === 'placement') {
      const p = s.players.find((q) => q.isAI && !q.placed && q.alive);
      if (!p) return null;
      return this.command({ type: 'auto-place', playerId: p.id });
    }
    const cur = E.currentPlayer(s);
    if (!cur || !cur.isAI || !cur.alive) return null;
    const stream = this.aiStreamFor(cur.id);
    const cmd = chooseCommand(s, cur.id, stream);
    if (!cmd) return null;
    return this.command(cmd);
  }

  aiStreamFor(playerId) {
    if (!this.aiStreams.has(playerId)) {
      this.aiStreams.set(playerId, makeRng(E.hashState({ a: this.config.seed, b: playerId }) + playerId));
    }
    return this.aiStreams.get(playerId);
  }

  hint(playerId) {
    if (!this.assists.hints) return null;
    return suggestTarget(this.state, playerId);
  }

  /** Practice assist: revert to the snapshot before the last human command. */
  undo() {
    if (!this.assists.undo || this.undoStack.length === 0) return false;
    this.state = E.deserializeState(this.undoStack.pop());
    return true;
  }

  canUndo() {
    return this.assists.undo && this.undoStack.length > 0 && this.state.phase !== 'finished';
  }

  elapsedMs() {
    if (this.startedAt === null) return 0;
    const end = this.finishedAt !== null ? this.finishedAt : Date.now();
    return this.elapsedCarry + (end - this.startedAt);
  }

  /** Full results table with component breakdowns and stars. */
  results(par) {
    return this.state.players.map((p) => {
      const score = E.scoreMatch(this.state, p.id);
      return {
        playerId: p.id,
        name: p.name,
        isAI: p.isAI,
        ...score,
        stars: E.starRating({ won: score.won, shotsUsed: score.shotsUsed, accuracy: score.accuracy, par }),
        elapsedMs: this.elapsedMs(),
      };
    });
  }

  serialize() {
    return JSON.stringify({
      config: this.config,
      mode: this.mode,
      assists: this.assists,
      localPlayerId: this.localPlayerId,
      state: E.serializeState(this.state),
      undoStack: this.undoStack,
      replay: this.replay,
      elapsedCarry: this.elapsedMs(),
    });
  }

  static restore(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const session = new GameSession({
      config: data.config, mode: data.mode, assists: data.assists, localPlayerId: data.localPlayerId,
    });
    session.state = E.deserializeState(data.state);
    session.undoStack = data.undoStack || [];
    session.replay = data.replay;
    session.elapsedCarry = data.elapsedCarry || 0;
    if (session.state.phase === 'battle') session.startedAt = Date.now();
    if (session.state.phase === 'finished') session.finishedAt = Date.now();
    return session;
  }
}
