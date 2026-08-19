/**
 * Fleet Signals — DOM UI shell and game controller.
 * Owns screens, HUD, overlays, keyboard/gamepad input, accessibility
 * mirrors, placement and battle interaction. Rules state changes only
 * ever happen through GameSession commands.
 */
import * as E from '../rules/engine.js';
import { makeRng } from '../rules/rng.js';
import { GameSession } from '../session/session.js';
import {
  STAGES, THEMES, CHALLENGES, dailyStage, stageById, challengeById, CONTENT_VERSION,
} from '../content/stages.js';
import { LESSONS, lessonById } from '../content/tutorial.js';
import {
  ACHIEVEMENTS, unlockAchievement, recordBoardEntry, storeSave,
} from '../platform/save.js';

const { cellName, cellToXY } = E;

const RESUME_KEY = 'fleet-signals-resume';
const AI_NAMES = { easy: 'Rookie Beacon', medium: 'Signal Officer', hard: 'Admiral Cipher' };
const ACH_ICONS = {
  'first-victory': '★', 'sharpshooter': '◎', 'daily-streak-3': '▲',
  'journey-mastery': '◆', 'long-voyage': '∞',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export class App {
  /**
   * @param {object} deps { scene, audio, saveDoc, platform, saveHooks }
   * platform: { utcToday(): string, track(name, props?), serverSynced: bool }
   * saveHooks: { persist(doc): void }
   */
  constructor({ scene, audio, saveDoc, platform, saveHooks }) {
    this.scene = scene;
    this.audio = audio;
    this.doc = saveDoc;
    this.platform = platform;
    this.saveHooks = saveHooks;

    this.ui = document.getElementById('ui');
    this.labelLayer = document.getElementById('label-layer');
    this.livePolite = document.getElementById('live-polite');
    this.liveAssertive = document.getElementById('live-assertive');
    this.captionLine = document.getElementById('caption-line');

    this.screen = null;
    this.session = null;
    this.mode = null;
    this.content = null;   // stage / challenge / lesson / daily descriptor
    this.phase = 'menu';   // menu|placement|countdown|battle|resolving|paused|results
    this.placement = null; // { placements:Map, selectedShipId, dir }
    this.cursorCell = null;
    this.selectedCell = null;
    this.annotateMode = false;
    this.inputLocked = false;
    this.paused = false;
    this.hotseat = null;   // { playerIds:[], handoverFor }
    this.hotTarget = null; // skirmish target selection
    this.lesson = null;    // active lesson runner
    this.lastFocus = null;
    this.cleanupFns = [];
    this.gamepadState = { seen: false, nextMove: 0 };

    this._wireSceneCallbacks();
    this._wireKeyboard();
    this._wireGamepad();
    this.applySettings();
    if (this.audio.setCaptionSink) {
      this.audio.setCaptionSink((text) => { this.captionLine.textContent = text; });
    }
  }

  /* ================= infrastructure ================= */

  persist() { this.saveHooks.persist(this.doc); }

  applySettings() {
    const s = this.doc.settings;
    const root = document.documentElement;
    root.classList.toggle('hc', !!s.highContrast);
    root.classList.toggle('bigtext', !!s.largerText);
    root.classList.toggle('lefty', !!s.leftHanded);
    root.classList.toggle('reduced-motion', !!s.reducedMotion);
    root.classList.toggle('captions', !!s.captions);
    root.classList.remove('palette-deuteranopia', 'palette-protanopia', 'palette-tritanopia');
    if (s.palette && s.palette !== 'default') root.classList.add('palette-' + s.palette);
    const theme = THEMES.find((t) => t.id === s.theme) || THEMES[0];
    root.style.setProperty('--accent', theme.ui.accent);
    root.style.setProperty('--bg', theme.ui.bg);
    root.style.setProperty('--panel', theme.ui.panel);
    root.style.setProperty('--text', theme.ui.text);
    this.scene.setTheme(theme);
    this.scene.setReducedMotion(!!s.reducedMotion);
    if (s.qualityTier && s.qualityTier !== 'auto') this.scene.setQuality(s.qualityTier);
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      this.audio.setVolume(bus, s[bus] ?? 1);
    }
    this.audio.setMuted(!!s.muted);
  }

  announce(msg, assertive = false) {
    const node = assertive ? this.liveAssertive : this.livePolite;
    node.textContent = '';
    // force re-announcement of identical strings
    requestAnimationFrame(() => { node.textContent = msg; });
  }

  toast(msg, isError = false, ms = 2600) {
    let stack = this.ui.querySelector('.toast-stack');
    if (!stack) {
      stack = el('<div class="toast-stack" aria-hidden="true"></div>');
      this.ui.appendChild(stack);
    }
    const t = el(`<div class="toast${isError ? ' error' : ''}">${esc(msg)}</div>`);
    stack.appendChild(t);
    setTimeout(() => t.remove(), ms);
    if (isError) this.announce(msg, true);
  }

  play(sound, opts) { this.audio.play(sound, opts); }

  /** Replace the UI layer contents; manages focus restoration. */
  mount(node, { focusSelector = 'button, [tabindex], input, select' } = {}) {
    this.cleanup();
    this.ui.innerHTML = '';
    this.ui.appendChild(node);
    const f = node.querySelector(focusSelector);
    if (f) f.focus({ preventScroll: true });
  }

  cleanup() {
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
  }

  onCleanup(fn) { this.cleanupFns.push(fn); }

  overlay(html, { focus = true } = {}) {
    const o = el(`<div class="overlay" role="dialog" aria-modal="true">${html}</div>`);
    this.ui.appendChild(o);
    if (focus) {
      this.lastFocus = document.activeElement;
      const f = o.querySelector('button, input, select');
      if (f) f.focus({ preventScroll: true });
    }
    return o;
  }

  closeOverlay(o) {
    o?.remove();
    if (this.lastFocus && document.contains(this.lastFocus)) {
      this.lastFocus.focus({ preventScroll: true });
    }
    this.lastFocus = null;
  }

  /* ================= title & menus ================= */

  showTitle() {
    this.phase = 'menu';
    this.sessionTeardown();
    this.scene.setView('title');
    this.scene.setInteractive(null);
    this.labelLayer.innerHTML = '';
    const resume = this._resumeAvailable();
    const dailyDone = !!this.doc.dailies[this.platform.utcToday()];
    const journeyDone = Object.keys(this.doc.journey.completed).length;
    const node = el(`
      <div class="screen" role="main" aria-label="Fleet Signals title">
        <div class="panel title-panel">
          <h1 class="game-title">FLEET SIGNALS</h1>
          <p class="game-subtitle">A captain's holographic chart table. Hide your fleet. Read the water.</p>
          <div class="menu-stack">
            ${resume ? '<button class="primary btn-play" data-act="resume">Resume Match</button>' : ''}
            <button class="primary btn-play" data-act="play">Play</button>
            <div class="menu-row">
              <button data-act="daily">Daily Signal${dailyDone ? ' ✓' : ''}</button>
              <button data-act="journey">Journey <span class="badge">${journeyDone}/40</span></button>
            </div>
            <div class="menu-row">
              <button data-act="practice">Practice</button>
              <button data-act="challenge">Challenge</button>
            </div>
            <div class="menu-row">
              <button data-act="learn">Learn</button>
              <button data-act="hosted">Hosted Table</button>
            </div>
            <div class="menu-row">
              <button class="ghost" data-act="profile">Profile</button>
              <button class="ghost" data-act="settings">Settings</button>
              <button class="ghost" data-act="help">Help</button>
            </div>
          </div>
        </div>
      </div>`);
    node.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      this.play('ui-press');
      this.audio.resume();
      ({
        play: () => this.showSetup('practice'),
        daily: () => this.showSetup('daily'),
        journey: () => this.showJourney(),
        practice: () => this.showSetup('practice'),
        challenge: () => this.showChallengeList(),
        learn: () => this.showLearn(),
        hosted: () => this.showLobby(),
        profile: () => this.showProfile(),
        settings: () => this.showSettings(() => this.showTitle()),
        help: () => this.showHelp(() => this.showTitle()),
        resume: () => this.resumeMatch(),
      })[act]?.();
    });
    this.mount(node);
    this.announce('Fleet Signals title screen. Press Play to start a practice match.');
  }

  /** Mode setup: rules, duration, players, assists, ranked — before commitment. */
  showSetup(mode, content = null) {
    if (mode === 'daily') content = dailyStage(this.platform.utcToday());
    const c = content || null;
    const gridSize = c?.gridSize || 8;
    const fleet = E.FLEETS[c?.fleetId || 'standard'];
    const mech = { ...E.DEFAULT_MECHANICS, ...(c?.mechanics || {}) };
    const fleetCells = fleet.reduce((a, s) => a + s.size, 0);
    const duration = gridSize <= 6 ? 'Short (about 4 min)' : gridSize <= 8 ? 'Medium (about 8 min)' : 'Long (about 12 min)';
    const ranked = mode === 'daily' || mode === 'journey' || mode === 'challenge';
    const mechList = [];
    if (mech.salvo) mechList.push('Salvo — one shot per surviving ship each turn');
    if (mech.moveLimit) mechList.push(`Shot limit — ${mech.moveLimit} shots for the whole match`);
    if (mech.mineCount) mechList.push(`Mines — ${mech.mineCount} hidden hazards per chart (striking one costs an extra shot)`);
    if (mech.noTouch) mechList.push('Discipline — ships may not touch when placed');
    if (mech.fog) mechList.push('Fog — sunken ships are not identified');
    if (!mechList.length) mechList.push('Classic duel — alternate single shots');

    const node = el(`
      <div class="screen dim" role="main" aria-label="Match setup">
        <div class="panel">
          <h2>${esc(mode === 'daily' ? 'Daily Signal — ' + this.platform.utcToday()
            : c ? c.name : 'Practice Skirmish')}
            <span class="badge ${ranked ? 'ranked' : ''}">${ranked ? 'Ranked' : 'Unranked'}</span>
          </h2>
          ${c?.briefing ? `<p>${esc(c.briefing)}</p>` : '<p>A straight duel against the practice intelligence. Undo and hints are available; nothing here affects ratings.</p>'}
          <table class="score-rows" aria-label="Rules summary">
            <tr><td>Chart</td><td>${gridSize}×${gridSize}</td></tr>
            <tr><td>Fleet</td><td>${fleet.length} ships, ${fleetCells} cells</td></tr>
            <tr><td>Rules</td><td>${esc(mechList.join('; '))}</td></tr>
            <tr><td>Players</td><td>2 — you vs ${esc(AI_NAMES[c?.aiDifficulty || 'medium'])}</td></tr>
            ${c?.par ? `<tr><td>Par</td><td>${c.par} shots for a star</td></tr>` : ''}
            ${c?.goalText ? `<tr><td>Challenge goal</td><td>${esc(c.goalText)}</td></tr>` : ''}
            <tr><td>Expected duration</td><td>${duration}</td></tr>
            <tr><td>Seed</td><td><code>${esc(c?.seed || 'random per match')}</code></td></tr>
          </table>
          ${mode === 'practice' ? `
            <label for="setup-diff">Opponent difficulty</label>
            <select id="setup-diff">
              <option value="easy">Easy — Rookie Beacon</option>
              <option value="medium" selected>Medium — Signal Officer</option>
              <option value="hard">Hard — Admiral Cipher</option>
            </select>
            <div class="toggle-row"><input type="checkbox" id="setup-hints" checked><label for="setup-hints">Hints available (H)</label></div>
            <div class="toggle-row"><input type="checkbox" id="setup-undo" checked><label for="setup-undo">Undo allowed (U)</label></div>` : ''}
          <div class="menu-row" style="margin-top:16px">
            <button class="primary" data-act="launch">Launch</button>
            <button data-act="back">Back</button>
          </div>
        </div>
      </div>`);
    node.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') { this.play('ui-back'); this.showTitle(); }
      if (act === 'launch') {
        this.play('ui-press');
        const opts = mode === 'practice' ? {
          difficulty: node.querySelector('#setup-diff').value,
          assists: {
            hints: node.querySelector('#setup-hints').checked,
            undo: node.querySelector('#setup-undo').checked,
          },
        } : { difficulty: c?.aiDifficulty || 'medium', assists: { hints: true, undo: false } };
        this.startMatch(mode, c, opts);
      }
    });
    this.mount(node);
    this.announce(`Setup for ${c ? c.name : 'practice'}. ${ranked ? 'Ranked.' : 'Unranked.'} Press Launch to begin.`);
  }

  showJourney() {
    const done = this.doc.journey.completed;
    const unlockedUpTo = STAGES.findIndex((s) => !done[s.id]);
    const limit = unlockedUpTo === -1 ? STAGES.length : unlockedUpTo + 1;
    const cells = STAGES.map((s, i) => {
      const rec = done[s.id];
      const locked = i >= limit;
      const stars = rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : '';
      return `<button class="stage-cell ${locked ? 'locked' : ''} ${s.mastery ? 'mastery-cell' : ''}"
        data-stage="${s.id}" ${locked ? 'disabled aria-disabled="true"' : ''}
        aria-label="Stage ${s.index}: ${esc(s.name)}${locked ? ' (locked)' : rec ? `, ${rec.stars} stars` : ''}">
        <span>${s.index}${s.mastery ? ' ◆' : ''}</span>
        <span class="stage-stars">${stars}</span>
      </button>`;
    }).join('');
    const node = el(`
      <div class="screen dim" role="main" aria-label="Journey stages">
        <div class="panel wide">
          <h2>Journey <span class="badge">${Object.keys(done).length}/40</span></h2>
          <p>Forty authored engagements. Win a stage to unlock the next; ◆ marks mastery trials. Earn up to three stars: victory, at or under par shots, and 60%+ accuracy.</p>
          <div class="stage-grid" role="list">${cells}</div>
          <div class="menu-row"><button data-act="back">Back</button></div>
        </div>
      </div>`);
    node.addEventListener('click', (ev) => {
      const stageBtn = ev.target.closest('[data-stage]');
      if (stageBtn && !stageBtn.disabled) {
        this.play('ui-press');
        this.showSetup('journey', stageById(stageBtn.dataset.stage));
        return;
      }
      if (ev.target.closest('[data-act="back"]')) { this.play('ui-back'); this.showTitle(); }
    });
    this.mount(node);
    this.announce(`Journey map. ${Object.keys(done).length} of 40 stages complete.`);
  }

  showChallengeList() {
    const rows = CHALLENGES.map((c) => {
      const rec = this.doc.challenges.completed[c.id];
      return `<div class="lobby-player">
        <div style="flex:1">
          <strong>${esc(c.name)}</strong>${rec ? ' <span class="badge">cleared ' + rec.score + '</span>' : ''}<br>
          <small>${esc(c.description)} Goal: ${esc(c.goalText)}</small>
        </div>
        <button data-ch="${c.id}">Run</button>
      </div>`;
    }).join('');
    const node = el(`
      <div class="screen dim" role="main" aria-label="Challenges">
        <div class="panel">
          <h2>Challenges <span class="badge ranked">Ranked</span></h2>
          <p>Constrained engagements: shot limits, minefields, fog and speed targets.</p>
          ${rows}
          <div class="menu-row" style="margin-top:12px"><button data-act="back">Back</button></div>
        </div>
      </div>`);
    node.addEventListener('click', (ev) => {
      const ch = ev.target.closest('[data-ch]');
      if (ch) { this.play('ui-press'); this.showSetup('challenge', challengeById(ch.dataset.ch)); return; }
      if (ev.target.closest('[data-act="back"]')) { this.play('ui-back'); this.showTitle(); }
    });
    this.mount(node);
  }

  showLearn() {
    const rows = LESSONS.map((l, i) => {
      const doneStep = this.doc.tutorial.done;
      return `<div class="lobby-player">
        <div style="flex:1"><strong>${esc(l.title)}</strong><br><small>${esc(l.intro)}</small></div>
        <button data-lesson="${l.id}">Start</button>
      </div>`;
    }).join('');
    const node = el(`
      <div class="screen dim" role="main" aria-label="Learn">
        <div class="panel">
          <h2>Learn ${this.doc.tutorial.done ? '<span class="badge">complete</span>' : ''}</h2>
          <p>Five short lessons. Each one asks you to perform the action yourself — the same rules the fleet plays by.</p>
          ${rows}
          <div class="menu-row" style="margin-top:12px"><button data-act="back">Back</button></div>
        </div>
      </div>`);
    node.addEventListener('click', (ev) => {
      const l = ev.target.closest('[data-lesson]');
      if (l) { this.play('ui-press'); this.startLesson(lessonById(l.dataset.lesson)); return; }
      if (ev.target.closest('[data-act="back"]')) { this.play('ui-back'); this.showTitle(); }
    });
    this.mount(node);
  }

  /* ================= hosted (local table) ================= */

  showLobby() {
    // Local hosted play: 2-4 captains at one table with privacy handover.
    const seats = this.lobbySeats || [
      { id: 'p1', name: 'Captain One', ready: false },
      { id: 'p2', name: 'Captain Two', ready: false },
    ];
    this.lobbySeats = seats;
    const rows = seats.map((s, i) => `
      <div class="lobby-player ${s.ready ? 'ready' : ''}">
        <span class="ready-dot" aria-hidden="true"></span>
        <input type="text" value="${esc(s.name)}" maxlength="18" data-seat-name="${i}" aria-label="Player ${i + 1} name">
        <button data-seat-ready="${i}" aria-pressed="${s.ready}">${s.ready ? 'Ready' : 'Not ready'}</button>
        ${seats.length > 2 ? `<button class="ghost" data-seat-drop="${i}" aria-label="Remove player ${i + 1}">✕</button>` : ''}
      </div>`).join('');
    const node = el(`
      <div class="screen dim" role="main" aria-label="Hosted table lobby">
        <div class="panel">
          <h2>Hosted Table <span class="badge">Local pass-and-play</span></h2>
          <p>Two to four captains share this table. The chart is hidden between turns — hand the device over when prompted. Placement and shots are validated by the same authoritative script that runs online sessions (<code>server.js</code>); reconnecting mid-match restores the last snapshot from the title screen.</p>
          <div role="list" aria-label="Roster">${rows}</div>
          <div class="menu-row" style="margin-top:12px">
            ${seats.length < 4 ? '<button data-act="add">Add player</button>' : ''}
            <button class="primary" data-act="start">Start match</button>
            <button data-act="back">Back</button>
          </div>
        </div>
      </div>`);
    node.addEventListener('input', (ev) => {
      const i = ev.target.dataset?.seatName;
      if (i !== undefined) seats[Number(i)].name = ev.target.value.slice(0, 18) || seats[i].name;
    });
    node.addEventListener('click', (ev) => {
      const readyBtn = ev.target.closest('[data-seat-ready]');
      if (readyBtn) {
        const s = seats[Number(readyBtn.dataset.seatReady)];
        s.ready = !s.ready;
        this.play('ui-press');
        this.showLobby();
        return;
      }
      const dropBtn = ev.target.closest('[data-seat-drop]');
      if (dropBtn) { seats.splice(Number(dropBtn.dataset.seatDrop), 1); this.showLobby(); return; }
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'add' && seats.length < 4) {
        seats.push({ id: 'p' + (seats.length + 1), name: 'Captain ' + (seats.length + 1), ready: false });
        this.showLobby();
      }
      if (act === 'start') {
        if (!seats.every((s) => s.ready)) { this.toast('Every captain must signal ready.', true); this.play('invalid'); return; }
        this.play('ui-press');
        this.startMatch('hosted', null, { seats });
      }
      if (act === 'back') { this.play('ui-back'); this.showTitle(); }
    });
    this.mount(node);
    this.announce('Hosted table lobby. Set names, signal ready, and start.');
  }

  /* ================= profile ================= */

  showProfile() {
    const st = this.doc.stats;
    const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : 0;
    const achRows = ACHIEVEMENTS.map((a) => {
      const unlocked = this.doc.achievements[a.key];
      return `<div class="achievement-row ${unlocked ? '' : 'locked'}">
        <span class="ach-icon" aria-hidden="true">${ACH_ICONS[a.key] || '★'}</span>
        <div style="flex:1"><strong>${esc(a.name)}</strong><br><small>${esc(a.description)}</small></div>
        <span>${unlocked ? '✓ ' + esc(String(unlocked).slice(0, 10)) : 'Locked'}</span>
      </div>`;
    }).join('');
    const boardRows = this.doc.boards.entries.slice(0, 10).map((b) =>
      `<tr><td>${esc(b.board)}</td><td>${b.score}</td><td>${esc(b.seed)}</td><td>${esc(String(b.date).slice(0, 10))}</td></tr>`).join('');
    const node = el(`
      <div class="screen dim" role="main" aria-label="Profile">
        <div class="panel wide">
          <h2>Profile ${this.doc.profile.guest ? '<span class="badge">Guest</span>' : ''}</h2>
          <label for="profile-name">Display name</label>
          <input type="text" id="profile-name" value="${esc(this.doc.profile.name)}" maxlength="18">
          <div class="stat-grid" role="list" aria-label="Career statistics">
            <div class="stat-box"><div class="stat-num">${st.sessions}</div><div class="stat-label">Sessions</div></div>
            <div class="stat-box"><div class="stat-num">${st.wins}</div><div class="stat-label">Victories</div></div>
            <div class="stat-box"><div class="stat-num">${acc}%</div><div class="stat-label">Accuracy</div></div>
            <div class="stat-box"><div class="stat-num">${st.sunk}</div><div class="stat-label">Ships sunk</div></div>
            <div class="stat-box"><div class="stat-num">${st.dailyStreak}</div><div class="stat-label">Daily streak</div></div>
          </div>
          <h3>Achievements</h3>
          ${achRows}
          <h3>Local leaderboard</h3>
          ${boardRows ? `<table class="score-rows"><tr><th>Board</th><th>Score</th><th>Seed</th><th>Date</th></tr>${boardRows}</table>` : '<p>No recorded results yet.</p>'}
          <div class="menu-row" style="margin-top:12px">
            <button data-act="save-name" class="primary">Save name</button>
            <button data-act="back">Back</button>
            <button class="danger" data-act="reset">Reset all progress</button>
          </div>
        </div>
      </div>`);
    node.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'save-name') {
        this.doc.profile.name = node.querySelector('#profile-name').value.trim().slice(0, 18) || 'Guest Captain';
        this.persist();
        this.toast('Name saved.');
        this.play('ui-press');
      }
      if (act === 'reset') {
        const o = this.overlay(`<div class="panel"><h2>Reset everything?</h2>
          <p>Journey stars, achievements, dailies and settings will be wiped from this device.</p>
          <div class="menu-row"><button class="danger" data-yes>Yes, reset</button><button data-no>Cancel</button></div></div>`);
        o.addEventListener('click', (e2) => {
          if (e2.target.closest('[data-yes]')) { this.saveHooks.reset(); this.closeOverlay(o); this.showTitle(); }
          if (e2.target.closest('[data-no]')) this.closeOverlay(o);
        });
      }
      if (act === 'back') { this.play('ui-back'); this.showTitle(); }
    });
    this.mount(node);
  }

  /* ================= settings ================= */

  showSettings(returnTo) {
    const s = this.doc.settings;
    const slider = (key, label) => `
      <label for="set-${key}">${label}</label>
      <input type="range" id="set-${key}" min="0" max="1" step="0.05" value="${s[key]}">`;
    const toggle = (key, label) => `
      <div class="toggle-row"><input type="checkbox" id="set-${key}" ${s[key] ? 'checked' : ''}><label for="set-${key}">${label}</label></div>`;
    const themeOpts = THEMES.map((t) => `<option value="${t.id}" ${s.theme === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    const node = el(`
      <div class="screen dim" role="main" aria-label="Settings">
        <div class="panel wide">
          <h2>Settings</h2>
          <div class="settings-grid">
            <fieldset><legend>Audio</legend>
              ${slider('music', 'Music')}
              ${slider('effects', 'Effects')}
              ${slider('ambience', 'Ambience')}
              ${slider('voice', 'Voice cues')}
              ${toggle('muted', 'Mute all audio')}
              ${toggle('captions', 'Captions for meaningful audio')}
            </fieldset>
            <fieldset><legend>Graphics</legend>
              <label for="set-quality">Quality tier</label>
              <select id="set-quality">
                <option value="auto" ${s.qualityTier === 'auto' ? 'selected' : ''}>Auto</option>
                <option value="low" ${s.qualityTier === 'low' ? 'selected' : ''}>Low — 30 fps fallback</option>
                <option value="medium" ${s.qualityTier === 'medium' ? 'selected' : ''}>Medium</option>
                <option value="high" ${s.qualityTier === 'high' ? 'selected' : ''}>High</option>
              </select>
              <label for="set-theme">Visual theme</label>
              <select id="set-theme">${themeOpts}</select>
              ${toggle('reducedMotion', 'Reduced motion (no camera swoops, shake, or heavy particles)')}
              ${toggle('highContrast', 'High contrast')}
            </fieldset>
            <fieldset><legend>Accessibility</legend>
              <label for="set-palette">Color-vision palette</label>
              <select id="set-palette">
                <option value="default" ${s.palette === 'default' ? 'selected' : ''}>Default</option>
                <option value="deuteranopia" ${s.palette === 'deuteranopia' ? 'selected' : ''}>Deuteranopia-safe</option>
                <option value="protanopia" ${s.palette === 'protanopia' ? 'selected' : ''}>Protanopia-safe</option>
                <option value="tritanopia" ${s.palette === 'tritanopia' ? 'selected' : ''}>Tritanopia-safe</option>
              </select>
              ${toggle('largerText', 'Larger text')}
              ${toggle('leftHanded', 'Left-handed controls')}
              ${toggle('haptics', 'Haptics (vibration)')}
              ${toggle('holdToConfirm', 'Hold to confirm destructive actions')}
            </fieldset>
            <fieldset><legend>Learning</legend>
              <p>Tutorial progress: ${this.doc.tutorial.done ? 'complete' : 'not finished'}.</p>
              <button data-act="replay-tutorial">Replay tutorial</button>
            </fieldset>
          </div>
          <div class="menu-row" style="margin-top:14px">
            <button class="primary" data-act="done">Done</button>
          </div>
        </div>
      </div>`);
    node.addEventListener('input', (ev) => {
      const id = ev.target.id;
      if (!id.startsWith('set-')) return;
      const key = id.slice(4);
      if (ev.target.type === 'range') s[key] = Number(ev.target.value);
      else if (ev.target.type === 'checkbox') s[key] = ev.target.checked;
      else s[key] = ev.target.value;
      this.applySettings();
      this.persist();
      this.platform.track('settings-change', { key });
    });
    node.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'done') { this.play('ui-back'); returnTo(); }
      if (act === 'replay-tutorial') { this.play('ui-press'); this.startLesson(LESSONS[0]); }
    });
    this.mount(node);
  }

  /* ================= help ================= */

  showHelp(returnTo) {
    const node = el(`
      <div class="screen dim" role="main" aria-label="Help and rules">
        <div class="panel wide">
          <h2>Captain's Manual</h2>
          <h3>The loop</h3>
          <p>Secretly place your fleet on the chart, then alternate calling coordinates. A white ring is open water; an orange spear is a hit. Strike every cell of a ship to sink it. Sink the whole enemy fleet to win.</p>
          <h3>Special rules on some charts</h3>
          <table class="score-rows">
            <tr><td>Salvo</td><td>Fire one shot per surviving ship each turn — protect your numbers.</td></tr>
            <tr><td>Shot limit</td><td>A fixed allowance for the whole match. Efficiency decides ties.</td></tr>
            <tr><td>Mines</td><td>Hidden hazard cells. Striking one wastes an extra shot.</td></tr>
            <tr><td>Discipline</td><td>Ships may not be placed touching side-to-side.</td></tr>
            <tr><td>Fog</td><td>Sunken ships are not identified — track sizes yourself.</td></tr>
          </table>
          <h3>Scoring</h3>
          <p>Victory 500 · each hit 25 · each ship sunk 100 · accuracy up to 300 · shots spared 10 each (limited charts) · invalid actions −15. Ties break on objective, fewer invalid actions, then faster time.</p>
          <h3>Controls</h3>
          <table class="kbd-table">
            <tr><td><kbd>←↑↓→</kbd></td><td>Move the chart cursor</td></tr>
            <tr><td><kbd>Enter</kbd> / <kbd>Space</kbd></td><td>Confirm / fire / place ship</td></tr>
            <tr><td><kbd>R</kbd></td><td>Rotate ship (deployment)</td></tr>
            <tr><td><kbd>A</kbd></td><td>Auto-deploy fleet</td></tr>
            <tr><td><kbd>N</kbd></td><td>Toggle note mode (private deductions)</td></tr>
            <tr><td><kbd>H</kbd></td><td>Hint (where allowed)</td></tr>
            <tr><td><kbd>U</kbd></td><td>Undo (practice only)</td></tr>
            <tr><td><kbd>C</kbd></td><td>Reset camera</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>Pause / cancel</td></tr>
            <tr><td>Gamepad</td><td>Stick/D-pad aim · A confirm · B cancel · Start pause</td></tr>
            <tr><td>Touch</td><td>Tap to select, tap again (or Fire) to commit. Drag the table to shift the camera.</td></tr>
          </table>
          <div class="menu-row" style="margin-top:14px"><button class="primary" data-act="done">Done</button></div>
        </div>
      </div>`);
    node.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-act="done"]')) { this.play('ui-back'); returnTo(); }
    });
    this.mount(node);
  }

  /* ================= match lifecycle ================= */

  sessionTeardown() {
    this.session = null;
    this.lesson = null;
    this.hotseat = null;
    this.placement = null;
    this.cursorCell = null;
    this.selectedCell = null;
    this.annotateMode = false;
    this.inputLocked = false;
    this.paused = false;
  }

  /**
   * Start a match.
   * @param mode learn|journey|daily|practice|challenge|hosted
   * @param content stage/challenge descriptor or null
   * @param opts { difficulty, assists, seats }
   */
  startMatch(mode, content, opts = {}) {
    this.sessionTeardown();
    this.mode = mode;
    this.content = content;
    let config;
    if (mode === 'hosted') {
      config = {
        seed: 'hosted-' + Date.now().toString(36),
        gridSize: 8, fleetId: 'standard', mechanics: {}, rulesetId: opts.seats.length > 2 ? 'skirmish' : 'duel',
        players: opts.seats.map((s) => ({ id: s.id, name: s.name })),
      };
      this.hotseat = { playerIds: opts.seats.map((s) => s.id), currentViewer: null };
    } else {
      config = {
        seed: content?.seed || ('practice-' + Date.now().toString(36)),
        gridSize: content?.gridSize || 8,
        fleetId: content?.fleetId || 'standard',
        mechanics: content?.mechanics || {},
        contentId: content?.id || null,
        players: [
          { id: 'you', name: this.doc.profile.name || 'You' },
          { id: 'ai', name: AI_NAMES[opts.difficulty || 'medium'], isAI: true, difficulty: opts.difficulty || 'medium' },
        ],
      };
    }
    if (mode === 'learn') config = { ...this.lessonConfig, contentId: this.lessonConfig.id };
    this.session = new GameSession({
      config, mode,
      assists: mode === 'practice'
        ? { undo: opts.assists?.undo !== false, hints: opts.assists?.hints !== false }
        : { undo: false, hints: mode === 'learn' },
      localPlayerId: this.hotseat ? null : 'you',
    });
    this.scene.buildBoards(config.gridSize);
    this.scene.setTheme(THEMES.find((t) => t.id === (content?.theme || this.doc.settings.theme)) || THEMES[0]);
    this.platform.track('round-start', { mode, contentId: config.contentId });
    this._buildGameScreen();
    this._beginPlacement();
  }

  startLesson(lesson) {
    this.lessonConfig = { ...lesson.config, id: lesson.id };
    this.startMatch('learn', null, {});
    this.lesson = { def: lesson, stepIdx: 0 };
    if (lesson.skipPlacement) {
      this.session.command({ type: 'auto-place', playerId: 'you' });
      this._afterPlacementComplete();
    }
    this._announceLessonStep();
  }

  _announceLessonStep() {
    if (!this.lesson) return;
    const step = this.lesson.def.steps[this.lesson.stepIdx];
    if (!step) return;
    this.toast(step.text, false, 6500);
    this.announce(this.lesson.def.title + '. ' + step.text);
  }

  _lessonCheck(events) {
    if (!this.lesson) return;
    const step = this.lesson.def.steps[this.lesson.stepIdx];
    if (!step) return;
    const hit = events.some((ev) =>
      (step.waitFor === 'fire' && ev.type === 'shot' && ev.by === 'you') ||
      (step.waitFor === 'hit' && ev.type === 'shot' && ev.by === 'you' && (ev.result === 'hit' || ev.result === 'sunk')) ||
      (step.waitFor === 'annotate' && ev.type === 'annotated') ||
      (step.waitFor === 'finish' && ev.type === 'finish'));
    if (hit) {
      const lessonId = this.lesson.def.id;
      this.play('lesson-done');
      this.toast('Lesson objective complete!', false, 3000);
      this.platform.track('tutorial-step', { lesson: lessonId });
      this.lesson = null;
      const idx = LESSONS.findIndex((l) => l.id === lessonId);
      this.doc.tutorial.step = Math.max(this.doc.tutorial.step, (idx >= 0 ? idx : 0) + 1);
      if (lessonId === LESSONS[LESSONS.length - 1].id) this.doc.tutorial.done = true;
      this.persist();
    }
  }

  /* ---------------- game screen scaffolding ---------------- */

  _buildGameScreen() {
    const st = this.session.state;
    const isHot = !!this.hotseat;
    const node = el(`
      <div class="game-root" role="main" aria-label="Match">
        <div class="hud-top">
          <button class="ghost" data-hud="pause" aria-label="Pause">❚❚</button>
          <div class="hud-objective">
            <div class="obj-title" id="hud-objective">Deploy your fleet</div>
            <div class="obj-sub" id="hud-sub">${esc(this._objectiveSub())}</div>
          </div>
          <div class="hud-turn" id="hud-turn" role="status">Placement</div>
          <button class="ghost drawer-toggle" data-hud="left" aria-label="Toggle fleet panel">☰</button>
          <button class="ghost drawer-toggle" data-hud="right" aria-label="Toggle log panel">≡</button>
        </div>
        <aside class="rail left" id="rail-left" aria-label="Fleet status"></aside>
        <aside class="rail right" id="rail-right" aria-label="Event log">
          <h3>Signals log</h3>
          <ul class="event-log" id="event-log"></ul>
        </aside>
        <div class="tray" id="tray" role="toolbar" aria-label="Actions"></div>
      </div>`);
    node.addEventListener('click', (ev) => {
      const hud = ev.target.closest('[data-hud]')?.dataset.hud;
      if (hud === 'pause') this.showPause();
      if (hud === 'left') node.querySelector('#rail-left').classList.toggle('open');
      if (hud === 'right') node.querySelector('#rail-right').classList.toggle('open');
    });
    this.mount(node);
    this._startLabelSync();
    this._startClock();
  }

  _objectiveSub() {
    const m = this.session?.state.mechanics || {};
    const bits = [];
    if (this.mode === 'daily') bits.push('Daily ' + this.platform.utcToday());
    if (this.content?.name) bits.push(this.content.name);
    if (m.salvo) bits.push('salvo');
    if (m.moveLimit) bits.push(m.moveLimit + ' shots');
    if (m.mineCount) bits.push('mines');
    if (m.fog) bits.push('fog');
    return bits.join(' · ') || 'Sink the opposing fleet';
  }

  _updateHud() {
    if (!this.session) return;
    const st = this.session.state;
    const objEl = this.ui.querySelector('#hud-objective');
    const turnEl = this.ui.querySelector('#hud-turn');
    if (!objEl || !turnEl) return;
    if (st.phase === 'placement') {
      objEl.textContent = 'Deploy your fleet';
    } else if (st.phase === 'battle') {
      const viewer = this._viewer();
      const me = st.players.find((p) => p.id === viewer);
      const foes = st.players.filter((p) => p.id !== viewer);
      const sunkTotal = foes.reduce((a, f) => a + f.ships.filter((s) => s.sunk).length, 0);
      const fleetTotal = foes.reduce((a, f) => a + f.ships.length, 0);
      const cur = st.players[st.currentPlayerIndex];
      const mine = cur.id === viewer;
      objEl.textContent = `Enemy fleet: ${sunkTotal}/${fleetTotal} sunk`;
      turnEl.textContent = st.phase === 'battle' ? (mine ? 'Your turn' : `${cur.name}'s turn`) : '';
      turnEl.className = 'hud-turn ' + (mine ? 'yours' : 'theirs');
      if (st.mechanics.moveLimit > 0 && me) {
        const left = Math.max(0, st.mechanics.moveLimit - me.shotsUsed);
        turnEl.textContent += ` · ${left} shots`;
      }
    } else if (st.phase === 'finished') {
      objEl.textContent = 'Engagement concluded';
    }
    this._renderRails();
  }

  _renderRails() {
    const st = this.session?.state;
    const left = this.ui.querySelector('#rail-left');
    const logEl = this.ui.querySelector('#event-log');
    if (!st || !left || !logEl) return;
    const viewer = this._viewer();
    const me = st.players.find((p) => p.id === viewer);
    const rows = st.players.map((p) => {
      const isMe = p.id === viewer;
      const label = isMe ? 'Your fleet' : p.name;
      const ships = isMe
        ? p.ships.map((s) => `<div class="fleet-row ${s.sunk ? 'sunk' : ''}"><span>${esc(s.name)}</span><span>${'●'.repeat(s.hits)}${'○'.repeat(s.size - s.hits)}</span></div>`).join('')
        : `<div class="fleet-row"><span>Ships sunk</span><span>${p.ships.filter((s) => s.sunk).length}/${p.ships.length}</span></div>
           <div class="fleet-row"><span>Your shots</span><span>${me?.shotsUsed ?? 0}</span></div>
           <div class="fleet-row"><span>Accuracy</span><span>${me && me.shotsUsed ? Math.round((me.hitsLanded / me.shotsUsed) * 100) : 0}%</span></div>`;
      return `<h3>${esc(label)}${p.alive ? '' : ' — eliminated'}</h3>${ships}`;
    }).join('');
    left.innerHTML = rows;
    const items = st.log.slice(-12).map((l, i, arr) =>
      `<li class="${i === arr.length - 1 ? 'latest' : ''}">${esc(l.text)}</li>`).join('');
    logEl.innerHTML = items;
  }

  _viewer() {
    if (this.hotseat) return this.hotseat.currentViewer || this.session.state.players[this.session.state.currentPlayerIndex]?.id;
    return this.session?.config.players[0].id || 'you';
  }

  /* ---------------- placement ---------------- */

  _beginPlacement() {
    const st = this.session.state;
    this.phase = 'placement';
    const viewer = this.hotseat ? this._nextPlacementSeat() : this.session.config.players[0].id;
    if (this.hotseat) this.hotseat.currentViewer = viewer;
    const me = st.players.find((p) => p.id === viewer);
    if (me?.isAI) { this._pumpAI(); return; }
    this.placement = { placements: new Map(), selectedShipId: null, dir: 'h' };
    this.scene.syncFromState(st, viewer, 'placement');
    this.scene.setView('placement');
    this.scene.setInteractive('main');
    this._renderTray();
    this._updateHud();
    this.announce('Deployment phase. Place every ship, then confirm.');
  }

  _nextPlacementSeat() {
    const st = this.session.state;
    return st.players.find((p) => !p.placed && p.alive)?.id;
  }

  _shipCellsFor(x, y, dir, size) {
    const g = this.session.state.gridSize;
    const cells = [];
    for (let i = 0; i < size; i++) {
      const cx = dir === 'h' ? x + i : x;
      const cy = dir === 'h' ? y : y + i;
      if (cx < 0 || cy < 0 || cx >= g || cy >= g) return null;
      cells.push(cy * g + cx);
    }
    return cells;
  }

  _placementCandidateValid(shipId, cells) {
    if (!cells) return false;
    const st = this.session.state;
    const me = st.players.find((p) => p.id === this._viewer());
    const occupied = new Set();
    for (const [otherId, pl] of this.placement.placements) {
      if (otherId === shipId) continue;
      for (const c of this._shipCellsFor(pl.x, pl.y, pl.dir, st.fleet.find((f) => f.id === otherId).size) || []) {
        occupied.add(c);
      }
    }
    for (const c of cells) {
      if (occupied.has(c)) return false;
      if (me.mines.includes(c)) return false;
    }
    if (st.mechanics.noTouch) {
      const g = st.gridSize;
      for (const c of cells) {
        const { x, y } = cellToXY(c, g);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= g || ny >= g) continue;
          const n = ny * g + nx;
          if (occupied.has(n) && !cells.includes(n)) return false;
        }
      }
    }
    return true;
  }

  _placementPick(cell) {
    const st = this.session.state;
    const pl = this.placement;
    if (!pl) return;
    // picking up an already-placed ship?
    for (const [shipId, p] of pl.placements) {
      const size = st.fleet.find((f) => f.id === shipId).size;
      const cells = this._shipCellsFor(p.x, p.y, p.dir, size);
      if (cells && cells.includes(cell)) {
        pl.placements.delete(shipId);
        pl.selectedShipId = shipId;
        this.play('rotate');
        this.scene.showDraftPlacements(st.fleet, pl.placements, st.gridSize);
        this._renderTray();
        this._previewPlacement(cell);
        return;
      }
    }
    if (!pl.selectedShipId) {
      const first = st.fleet.find((f) => !pl.placements.has(f.id));
      if (first) pl.selectedShipId = first.id; else return;
    }
    const def = st.fleet.find((f) => f.id === pl.selectedShipId);
    const { x, y } = cellToXY(cell, st.gridSize);
    const cells = this._shipCellsFor(x, y, pl.dir, def.size);
    if (!this._placementCandidateValid(def.id, cells)) {
      this.play('invalid');
      this.toast('Illegal position — ships must stay on the chart, clear of mines, other ships' + (st.mechanics.noTouch ? ', and may not touch.' : '.'), true);
      return;
    }
    pl.placements.set(def.id, { shipId: def.id, x, y, dir: pl.dir });
    this.play('place');
    const next = st.fleet.find((f) => !pl.placements.has(f.id));
    pl.selectedShipId = next ? next.id : null;
    this.scene.clearPreview();
    this.scene.showDraftPlacements(st.fleet, pl.placements, st.gridSize);
    this._renderTray();
  }

  _previewPlacement(cell) {
    const pl = this.placement;
    if (!pl || cell === null || cell === undefined) { this.scene.clearPreview(); return; }
    const st = this.session.state;
    const shipId = pl.selectedShipId;
    if (!shipId) { this.scene.clearPreview(); return; }
    const def = st.fleet.find((f) => f.id === shipId);
    const { x, y } = cellToXY(cell, st.gridSize);
    const cells = this._shipCellsFor(x, y, pl.dir, def.size);
    this.scene.previewShip(cells || [cell], this._placementCandidateValid(shipId, cells));
  }

  _confirmPlacement() {
    const st = this.session.state;
    const pl = this.placement;
    if (pl.placements.size !== st.fleet.length) {
      this.toast(`Deploy all ${st.fleet.length} ships first.`, true);
      this.play('invalid');
      return;
    }
    const viewer = this._viewer();
    try {
      const { events } = this.session.command({
        type: 'place', playerId: viewer, placements: [...pl.placements.values()],
      });
      this._saveResume();
      this._lessonCheckPlacementDone();
      this._afterPlacementCommand(events);
    } catch (err) {
      this.play('invalid');
      this.toast('Placement rejected: ' + err.message, true);
    }
  }

  _lessonCheckPlacementDone() {
    if (this.lesson && this.lesson.def.steps[this.lesson.stepIdx]?.waitFor === 'place-all') {
      this.play('lesson-done');
      this.toast('Fleet deployed. Objective complete!', false, 3000);
      this.platform.track('tutorial-step', { lesson: this.lesson.def.id });
      this.lesson = null;
    }
  }

  _afterPlacementCommand(events) {
    const st = this.session.state;
    if (st.phase === 'placement' && this.hotseat) {
      const next = this._nextPlacementSeat();
      if (next) {
        this._handover(next, () => this._beginPlacement());
        return;
      }
    }
    this._afterPlacementComplete();
  }

  /** AI seats place instantly (no ceremony needed for hidden placements). */
  _pumpPlacementAI() {
    let guard = 0;
    while (this.session.state.phase === 'placement' && this.session.needsAI() && guard++ < 8) {
      this.session.stepAI();
    }
  }

  _afterPlacementComplete() {
    this.placement = null;
    this.scene.clearPreview();
    this.scene.setInteractive(null);
    this._pumpPlacementAI();
    if (this.session.state.phase !== 'battle') return;
    this._runCountdown(() => this._beginBattle());
  }

  _runCountdown(done) {
    if (this.doc.settings.reducedMotion) { done(); return; }
    this.phase = 'countdown';
    let n = 3;
    const o = this.overlay('<div class="countdown-num" role="status" aria-live="assertive">3</div>', { focus: false });
    const tick = () => {
      if (!this.session) { o.remove(); return; }
      if (n === 0) {
        o.remove();
        done();
        return;
      }
      o.querySelector('.countdown-num').textContent = String(n);
      this.play('countdown', { variant: n });
      n -= 1;
      setTimeout(tick, 750);
    };
    tick();
  }

  /* ---------------- battle ---------------- */

  _beginBattle() {
    this.phase = 'battle';
    this.scene.setView('battle');
    this._startTurnForCurrent();
  }

  _startTurnForCurrent() {
    const st = this.session.state;
    if (!st || st.phase === 'finished') { this._finishIfNeeded([]); return; }
    if (this.session.needsAI()) { this._pumpAI(); return; }
    const cur = st.players[st.currentPlayerIndex];
    if (this.hotseat && this.hotseat.currentViewer !== cur.id) {
      this._handover(cur.id, () => this._enterTurn());
      return;
    }
    this._enterTurn();
  }

  _enterTurn() {
    const st = this.session.state;
    const viewer = this._viewer();
    this.phase = 'battle';
    this.inputLocked = false;
    this.selectedCell = null;
    this.cursorCell = null;
    this.annotateMode = false;
    this.scene.syncFromState(st, viewer, 'battle');
    this.scene.setInteractive('main');
    // skirmish target selection default
    if (st.players.length > 2) {
      const fires = E.listLegalActions(st, viewer).filter((a) => a.type === 'fire');
      this.hotTarget = fires[0]?.targetId || null;
    } else {
      this.hotTarget = st.players.find((p) => p.id !== viewer)?.id;
    }
    this._renderTray();
    this._updateHud();
    const cur = st.players[st.currentPlayerIndex];
    if (cur.id === viewer) {
      this.play('turn');
      this.announce('Your turn. Select a coordinate on the target chart.');
    }
  }

  _pumpAI() {
    if (!this.session || this.session.state.phase === 'finished') { this._finishIfNeeded([]); return; }
    if (!this.session.needsAI()) {
      if (this.session.state.phase === 'battle') this._startTurnForCurrent();
      return;
    }
    this.phase = 'resolving';
    this.inputLocked = true;
    this._renderTray();
    setTimeout(() => {
      if (!this.session) return;
      if (this.paused) { this._pumpAI(); return; } // solo sim frozen while paused/hidden
      const r = this.session.stepAI();
      if (!r) { this._startTurnForCurrent(); return; }
      this._afterCommand(r.events, { ai: true });
    }, this.aiDelay ? this.aiDelay() : 650 + Math.random() * 400);
  }

  _fire(cell) {
    const st = this.session.state;
    const viewer = this._viewer();
    if (this.inputLocked || st.phase !== 'battle') return;
    const cur = st.players[st.currentPlayerIndex];
    if (cur.id !== viewer) return;
    const { x, y } = cellToXY(cell, st.gridSize);
    try {
      const { events } = this.session.command({ type: 'fire', playerId: viewer, targetId: this.hotTarget, x, y });
      this.platform.track('first-action', this.session.state.tick <= 4 ? { quick: true } : undefined);
      this._saveResume();
      this.play('fire');
      this.inputLocked = true;
      this.phase = 'resolving';
      this._afterCommand(events, { ai: false });
    } catch (err) {
      this.play('invalid');
      this.toast(this._explainInvalid(err), true);
    }
  }

  _explainInvalid(err) {
    const map = {
      'not-your-turn': 'Hold fire — it is not your turn.',
      'cell-already-targeted': 'Already fired there. Pick a fresh coordinate.',
      'cell-out-of-bounds': 'That coordinate is off the chart.',
      'target-not-alive': 'That fleet is already destroyed.',
      'phase': 'Not possible in the current phase.',
    };
    return map[err.code] || ('Illegal action: ' + err.message);
  }

  _annotate(cell) {
    const st = this.session.state;
    const viewer = this._viewer();
    const me = st.players.find((p) => p.id === viewer);
    if (!this.hotTarget) return;
    const notes = me.notes[this.hotTarget] || {};
    const cur = notes[cell];
    const next = cur === 'flag' ? 'unknown' : cur === 'unknown' ? null : 'flag';
    const { x, y } = cellToXY(cell, st.gridSize);
    try {
      const { events } = this.session.command({ type: 'annotate', playerId: viewer, targetId: this.hotTarget, x, y, mark: next });
      this.play('ui-press');
      this._lessonCheck(events);
      this._renderTray();
      this.announce(next ? `Cell ${cellName(cell, st.gridSize)} marked ${next}.` : `Cell ${cellName(cell, st.gridSize)} note cleared.`);
    } catch (err) {
      this.play('invalid');
    }
  }

  /** Shared post-command pipeline: effects, announcements, AI follow-up, finish. */
  _afterCommand(events, { ai } = {}) {
    const st = this.session.state;
    const viewer = this._viewer();
    const dur = this.scene.playEvents(events, { mode: 'battle' });
    this._soundEvents(events, viewer);
    this._announceEvents(events, viewer);
    this._lessonCheck(events);
    this._updateHud();
    const settle = () => {
      if (!this.session) return;
      this.scene.syncFromState(st, this._viewer(), 'battle');
      this._renderTray();
      this._updateHud();
      if (this._finishIfNeeded(events)) return;
      this.inputLocked = false;
      if (this.session.needsAI()) this._pumpAI();
      else this._startTurnForCurrent();
    };
    if (dur > 0 && this.scene.jobsPending) {
      setTimeout(settle, dur + 60);
    } else {
      settle();
    }
  }

  _soundEvents(events, viewer) {
    for (const ev of events) {
      if (ev.type === 'shot') {
        if (ev.result === 'miss') this.play('splash');
        else if (ev.result === 'mine') this.play('mine');
        else if (ev.result === 'sunk') this.play('sunk');
        else this.play('hit');
        if (ev.targetId === viewer && this.doc.settings.haptics && navigator.vibrate) {
          navigator.vibrate(ev.result === 'miss' ? 10 : 40);
        }
      } else if (ev.type === 'placed') this.play('place');
      else if (ev.type === 'resigned') this.play('defeat');
    }
  }

  _announceEvents(events, viewer) {
    const st = this.session.state;
    for (const ev of events) {
      if (ev.type === 'shot') {
        const name = cellName(ev.cell, st.gridSize);
        const whose = ev.by === viewer ? 'You fire at' : `Incoming fire at`;
        const what = ev.result === 'miss' ? 'open water'
          : ev.result === 'mine' ? 'a mine! An extra shot is spent'
          : ev.result === 'sunk' ? `${ev.shipName || 'an enemy ship'} is sunk`
          : 'a hit';
        this.announce(`${whose} ${name} — ${what}.`, ev.result === 'sunk');
      } else if (ev.type === 'eliminated') {
        this.announce('A fleet has been destroyed.', true);
      } else if (ev.type === 'finish') {
        // handled by results screen
      }
    }
  }

  _finishIfNeeded(events) {
    const st = this.session?.state;
    if (!st || st.phase !== 'finished') return false;
    this.phase = 'results';
    this.inputLocked = true;
    this.scene.setInteractive(null);
    this.scene.setView('results');
    this._clearResume();
    this._recordOutcome();
    setTimeout(() => this._showResults(), this.doc.settings.reducedMotion ? 150 : 900);
    return true;
  }

  /* ---------------- results & progression ---------------- */

  _recordOutcome() {
    const st = this.session.state;
    const viewer = this.session.config.players[0].id;
    const me = st.players.find((p) => p.id === viewer);
    const res = E.scoreMatch(st, viewer);
    const stats = this.doc.stats;
    stats.sessions += 1;
    stats.shots += me.shotsUsed;
    stats.hits += me.hitsLanded;
    if (res.won) stats.wins += 1; else stats.losses += 1;
    stats.sunk += res.sunk;
    if (res.accuracy > stats.bestAccuracy) stats.bestAccuracy = res.accuracy;

    const unlocked = [];
    const unlock = (key) => { if (unlockAchievement(this.doc, key)) unlocked.push(key); };
    if (res.won) unlock('first-victory');
    if (res.won && res.accuracy >= 0.6) unlock('sharpshooter');
    if (stats.sessions >= 25) unlock('long-voyage');

    const par = this.content?.par;
    const stars = E.starRating({ won: res.won, shotsUsed: res.shotsUsed, accuracy: res.accuracy, par });
    this.lastResult = { res, stars, viewer };

    if (this.mode === 'journey' && this.content) {
      const prev = this.doc.journey.completed[this.content.id];
      if (res.won && (!prev || stars > prev.stars || res.total > prev.score)) {
        this.doc.journey.completed[this.content.id] = {
          stars: Math.max(stars, prev?.stars || 0),
          score: Math.max(res.total, prev?.score || 0),
          bestShots: Math.min(res.shotsUsed, prev?.bestShots ?? Infinity),
        };
      }
      const mastery3 = STAGES.filter((s) => s.mastery && this.doc.journey.completed[s.id]?.stars >= 3).length;
      if (mastery3 >= 8) unlock('journey-mastery');
    }
    if (this.mode === 'daily') {
      const date = this.platform.utcToday();
      const prev = this.doc.dailies[date];
      if (!prev || res.total > prev.score) this.doc.dailies[date] = { score: res.total, won: res.won, stars };
      if (res.won) {
        // consecutive UTC days with a won daily, ending today
        let streak = 0;
        let d = date;
        while (this.doc.dailies[d]?.won) {
          streak += 1;
          d = new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
        }
        stats.dailyStreak = streak;
        stats.lastDailyDate = date;
        if (streak >= 3) unlock('daily-streak-3');
      }
    }
    if (this.mode === 'challenge' && this.content) {
      const passed = this._challengePassed(res);
      const prev = this.doc.challenges.completed[this.content.id];
      if (passed && (!prev || res.total > prev.score)) {
        this.doc.challenges.completed[this.content.id] = { score: res.total };
      }
    }
    const ranked = ['daily', 'journey', 'challenge'].includes(this.mode);
    if (ranked || this.mode === 'practice') {
      recordBoardEntry(this.doc, {
        board: this.mode, score: res.total, ruleset: st.rulesetId,
        contentVersion: CONTENT_VERSION, seed: st.seed,
        assists: this.session.assists, durationMs: this.session.elapsedMs(),
        date: new Date().toISOString(),
      });
    }
    if (unlocked.length) {
      for (const key of unlocked) {
        const meta = ACHIEVEMENTS.find((a) => a.key === key);
        this.toast(`Achievement unlocked: ${meta?.name || key}`, false, 4200);
      }
      this.play('achievement');
    }
    this.platform.track('round-end', { mode: this.mode, won: res.won });
    this.persist();
  }

  _challengePassed(res) {
    const c = this.content?.constraint;
    if (!c) return res.won;
    if (!res.won) return false;
    if (c.type === 'move-limit') return res.shotsUsed <= c.value;
    if (c.type === 'accuracy') return res.accuracy * 100 >= c.value;
    if (c.type === 'speed') return this.session.elapsedMs() / 1000 <= c.value;
    return false;
  }

  _showResults() {
    if (!this.session) return;
    const { res, stars, viewer } = this.lastResult;
    const st = this.session.state;
    const rows = res.components.map((c) =>
      `<tr><td>${esc(c.label)}</td><td>${c.points > 0 ? '+' : ''}${c.points}</td></tr>`).join('');
    const isHot = !!this.hotseat;
    const winnerName = st.winner ? st.players.find((p) => p.id === st.winner)?.name : null;
    const headline = st.winner === null ? 'Draw'
      : isHot ? `${winnerName} wins`
      : res.won ? 'Victory' : 'Defeat';
    const cls = st.winner === null ? '' : (isHot ? 'win' : res.won ? 'win' : 'loss');
    this.play(res.won || (isHot && st.winner) ? 'victory' : 'defeat');
    this.announce(`${headline}. Final score ${res.total}.`, true);

    const nextStage = this.mode === 'journey' && this.content
      ? STAGES[STAGES.findIndex((s) => s.id === this.content.id) + 1] : null;
    const challengeNote = this.mode === 'challenge'
      ? `<p>${this._challengePassed(res) ? '✓ Challenge goal met.' : '✗ Challenge goal missed: ' + esc(this.content.goalText)}</p>` : '';
    const o = this.overlay(`
      <div class="panel" role="document" aria-label="Results">
        <h2 class="result-headline ${cls}">${esc(headline)}</h2>
        ${this.mode === 'journey' ? `<div class="stars" aria-label="${stars} of 3 stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</div>` : ''}
        ${challengeNote}
        <table class="score-rows" aria-label="Score breakdown">
          ${rows}
          <tr class="total"><td>Total</td><td>${res.total}</td></tr>
        </table>
        <p><small>Reason: ${esc(st.terminalReason || '—')} · Seed: <code>${esc(st.seed)}</code> · Rules v${E.RULES_VERSION} · Time ${Math.round(this.session.elapsedMs() / 1000)}s</small></p>
        <div class="menu-row">
          <button class="primary" data-act="retry">Retry</button>
          ${nextStage ? '<button data-act="next">Next stage</button>' : ''}
          <button data-act="modes">Change mode</button>
          <button class="ghost" data-act="title">Title</button>
        </div>
      </div>`);
    o.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      this.play('ui-press');
      this.closeOverlay(o);
      if (act === 'retry') this.startMatch(this.mode, this.content, { difficulty: this.session.config.players[1]?.difficulty });
      if (act === 'next' && nextStage) this.showSetup('journey', nextStage);
      if (act === 'modes') this.showTitle();
      if (act === 'title') this.showTitle();
    });
  }

  /* ---------------- pause ---------------- */

  showPause() {
    if (!this.session || this.phase === 'results') return;
    this.paused = true;
    this.play('ui-back');
    const o = this.overlay(`
      <div class="panel" role="document" aria-label="Paused">
        <h2>Paused</h2>
        <div class="menu-stack">
          <button class="primary" data-act="resume">Resume</button>
          <button data-act="settings">Settings</button>
          <button data-act="help">Help</button>
          ${this.mode === 'practice' ? '<button data-act="restart">Restart match</button>' : ''}
          <button class="danger" data-act="leave">Leave match</button>
        </div>
      </div>`);
    o.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      this.play('ui-press');
      if (act === 'resume') { this.paused = false; this.closeOverlay(o); }
      if (act === 'settings') { this.closeOverlay(o); this.showSettings(() => this.showPause()); }
      if (act === 'help') { this.closeOverlay(o); this.showHelp(() => this.showPause()); }
      if (act === 'restart') { this.paused = false; this.closeOverlay(o); this.startMatch(this.mode, this.content, {}); }
      if (act === 'leave') { this.paused = false; this.closeOverlay(o); this.showTitle(); }
    });
  }

  /* ---------------- hot-seat handover ---------------- */

  _handover(forPlayerId, ready) {
    const name = this.session.state.players.find((p) => p.id === forPlayerId)?.name || 'next captain';
    this.scene.setInteractive(null);
    if (this.hotseat) this.hotseat.currentViewer = forPlayerId;
    this.inputLocked = true;
    const o = this.overlay(`
      <div class="panel" style="text-align:center">
        <h2>Pass the chart</h2>
        <p>Hand the device to <strong>${esc(name)}</strong>. The fleet positions are secret — no peeking.</p>
        <button class="primary" data-act="ready">I am ${esc(name)} — ready</button>
      </div>`);
    o.addEventListener('click', (ev) => {
      if (!ev.target.closest('[data-act="ready"]')) return;
      this.play('ui-press');
      this.closeOverlay(o);
      this.inputLocked = false;
      ready();
    });
  }

  /* ---------------- tray (context actions) ---------------- */

  _renderTray() {
    const tray = this.ui.querySelector('#tray');
    if (!tray || !this.session) return;
    const st = this.session.state;
    const viewer = this._viewer();
    const cur = st.players[st.currentPlayerIndex];
    const myTurn = st.phase === 'battle' && cur.id === viewer && !this.inputLocked && !this.paused;
    let html = '';
    if (st.phase === 'placement' && this.placement) {
      const pl = this.placement;
      const chips = st.fleet.map((f) => {
        const placed = pl.placements.has(f.id);
        const sel = pl.selectedShipId === f.id;
        return `<button class="ship-chip ${placed ? 'placed' : ''} ${sel ? 'selected' : ''}" data-ship="${f.id}"
          aria-pressed="${sel}">${esc(f.name)} <span class="pips">${'▮'.repeat(f.size)}</span></button>`;
      }).join('');
      html = `
        <div class="ship-list">${chips}</div>
        <button data-tact="rotate" aria-label="Rotate ship (R)">⟳ Rotate</button>
        <button data-tact="auto" aria-label="Auto-deploy (A)">Auto-deploy</button>
        <button class="primary" data-tact="confirm" ${pl.placements.size !== st.fleet.length ? 'disabled' : ''}>Confirm deployment</button>`;
    } else if (st.phase === 'battle') {
      const sel = this.selectedCell !== null ? cellName(this.selectedCell, st.gridSize) : null;
      let targetPicker = '';
      if (st.players.length > 2 && myTurn) {
        const fires = E.listLegalActions(st, viewer).filter((a) => a.type === 'fire');
        targetPicker = fires.map((f) => {
          const p = st.players.find((q) => q.id === f.targetId);
          return `<button data-target="${f.targetId}" aria-pressed="${this.hotTarget === f.targetId}">${esc(p.name)}</button>`;
        }).join('');
      }
      html = `
        ${targetPicker}
        <button class="primary" data-tact="fire" ${!myTurn || !sel ? 'disabled' : ''}>Fire${sel ? ' ' + sel : ''}</button>
        <button data-tact="note" aria-pressed="${this.annotateMode}" ${!myTurn ? 'disabled' : ''}>✎ Note (N)</button>
        ${this.session.assists.hints ? `<button data-tact="hint" ${!myTurn ? 'disabled' : ''}>Hint (H)</button>` : ''}
        ${this.session.canUndo() ? '<button data-tact="undo">Undo (U)</button>' : ''}
        ${this.scene.jobsPending ? '<button data-tact="skip">Skip ▸▸</button>' : ''}`;
    } else {
      html = '<span style="color:var(--text-dim);padding:8px">Resolving…</span>';
    }
    tray.innerHTML = html;
    if (!tray.dataset.wired) {
      tray.dataset.wired = '1';
      tray.addEventListener('click', (ev) => this._trayClick(ev));
    }
  }

  _trayClick(ev) {
    const shipBtn = ev.target.closest('[data-ship]');
    if (shipBtn && this.placement) {
      const id = shipBtn.dataset.ship;
      if (this.placement.placements.has(id)) {
        // pick it back up
        this.placement.placements.delete(id);
        this.scene.showDraftPlacements(this.session.state.fleet, this.placement.placements, this.session.state.gridSize);
      }
      this.placement.selectedShipId = id;
      this.play('ui-press');
      this._renderTray();
      if (this.cursorCell !== null) this._previewPlacement(this.cursorCell);
      return;
    }
    const targetBtn = ev.target.closest('[data-target]');
    if (targetBtn) {
      this.hotTarget = targetBtn.dataset.target;
      this.play('ui-press');
      this._renderTray();
      return;
    }
    const act = ev.target.closest('[data-tact]')?.dataset.tact;
    if (!act) return;
    if (act === 'rotate') { this.placement.dir = this.placement.dir === 'h' ? 'v' : 'h'; this.play('rotate'); if (this.cursorCell !== null) this._previewPlacement(this.cursorCell); }
    if (act === 'auto') this._autoPlace();
    if (act === 'confirm') this._confirmPlacement();
    if (act === 'fire' && this.selectedCell !== null) this._fire(this.selectedCell);
    if (act === 'note') { this.annotateMode = !this.annotateMode; this.play('ui-press'); this._renderTray(); }
    if (act === 'hint') this._showHint();
    if (act === 'undo') this._undo();
    if (act === 'skip') { this.scene.skip(); }
  }

  _autoPlace() {
    // Draft only: fills the tray with a legal layout; the player confirms.
    const st = this.session.state;
    const viewer = this._viewer();
    const me = st.players.find((p) => p.id === viewer);
    const placements = E.autoPlaceFleet(
      st.gridSize, st.fleet, st.mechanics, me.mines,
      makeRng('draft-' + Date.now() + '-' + Math.random()),
    );
    if (!placements) { this.play('invalid'); this.toast('No legal layout found — try manual placement.', true); return; }
    this.placement.placements = new Map(placements.map((p) => [p.shipId, p]));
    this.placement.selectedShipId = null;
    this.scene.showDraftPlacements(st.fleet, this.placement.placements, st.gridSize);
    this.play('place');
    this._renderTray();
    this.announce('Draft layout ready. Confirm deployment, or tap a ship to pick it up and adjust.');
  }

  _showHint() {
    const viewer = this._viewer();
    const hint = this.session.hint(viewer);
    if (!hint) { this.toast('No hint available right now.', true); return; }
    this.selectedCell = hint.cell;
    this.cursorCell = hint.cell;
    this.scene.setCursor('main', hint.cell, true);
    this._renderTray();
    this.toast(`Signal analysis suggests ${cellName(hint.cell, this.session.state.gridSize)}.`, false, 3000);
    this.announce(`Hint: try ${cellName(hint.cell, this.session.state.gridSize)}.`);
    this.play('ui-press');
  }

  _undo() {
    if (!this.session.canUndo()) { this.toast('Nothing to undo.', true); this.play('invalid'); return; }
    // undoStack snapshots are taken before each human command, so one pop
    // reverts the last human shot and any AI reply that followed it.
    this.session.undo();
    this.scene.skip();
    this.scene.syncFromState(this.session.state, this._viewer(), 'battle');
    this.selectedCell = null;
    this._renderTray();
    this._updateHud();
    this.play('ui-back');
    this.announce('Last exchange undone.');
    this._saveResume();
  }

  /* ---------------- pointer callbacks ---------------- */

  _wireSceneCallbacks() {
    this.scene.onCellHover = (board, cell) => {
      if (this.inputLocked || this.paused) return;
      this.cursorCell = cell;
      if (this.phase === 'placement') {
        this._previewPlacement(cell);
      } else if (this.phase === 'battle') {
        const st = this.session?.state;
        if (!st || cell === null) { this.scene.setCursor('main', null); return; }
        const viewer = this._viewer();
        const fired = st.players.find((p) => p.id === viewer)?.shotsFired[this.hotTarget] || {};
        this.scene.setCursor('main', cell, !(cell in fired));
      }
    };
    this.scene.onCellPick = (board, cell) => {
      if (this.inputLocked || this.paused) return;
      this.audio.resume();
      if (this.phase === 'placement') { this._placementPick(cell); return; }
      if (this.phase !== 'battle') return;
      const st = this.session.state;
      const viewer = this._viewer();
      if (st.players[st.currentPlayerIndex].id !== viewer) return;
      if (this.annotateMode) { this._annotate(cell); return; }
      if (this.selectedCell === cell) { this._fire(cell); return; }
      this.selectedCell = cell;
      this.play('ui-press');
      const fired = st.players.find((p) => p.id === viewer)?.shotsFired[this.hotTarget] || {};
      this.scene.setCursor('main', cell, !(cell in fired));
      this._renderTray();
    };
  }

  /* ---------------- keyboard ---------------- */

  _wireKeyboard() {
    document.addEventListener('keydown', (ev) => {
      if (ev.target.matches('input, select, textarea')) return;
      const st = this.session?.state;
      if (ev.key === 'Escape') {
        if (this.session && this.phase !== 'results' && this.phase !== 'menu') {
          if (this.ui.querySelector('.overlay')) return; // overlays handle their own buttons
          this.showPause();
          ev.preventDefault();
        }
        return;
      }
      if (!this.session || this.inputLocked || this.paused) return;
      if (this.phase !== 'battle' && this.phase !== 'placement') return;
      const g = st.gridSize;
      const move = (dx, dy) => {
        const cur = this.cursorCell ?? 0;
        const { x, y } = cellToXY(cur, g);
        const nx = Math.min(g - 1, Math.max(0, x + dx));
        const ny = Math.min(g - 1, Math.max(0, y + dy));
        const cell = ny * g + nx;
        this.cursorCell = cell;
        this.scene.onCellHover?.(this.scene.interactiveBoard, cell);
        ev.preventDefault();
      };
      switch (ev.key) {
        case 'ArrowLeft': move(-1, 0); break;
        case 'ArrowRight': move(1, 0); break;
        case 'ArrowUp': move(0, -1); break;
        case 'ArrowDown': move(0, 1); break;
        case 'Enter': case ' ':
          if (this.cursorCell !== null) this.scene.onCellPick?.(this.scene.interactiveBoard, this.cursorCell);
          ev.preventDefault();
          break;
        case 'r': case 'R':
          if (this.phase === 'placement' && this.placement) {
            this.placement.dir = this.placement.dir === 'h' ? 'v' : 'h';
            this.play('rotate');
            if (this.cursorCell !== null) this._previewPlacement(this.cursorCell);
          }
          break;
        case 'a': case 'A':
          if (this.phase === 'placement') this._autoPlace();
          break;
        case 'n': case 'N':
          if (this.phase === 'battle') { this.annotateMode = !this.annotateMode; this._renderTray(); }
          break;
        case 'h': case 'H':
          if (this.phase === 'battle' && this.session.assists.hints) this._showHint();
          break;
        case 'u': case 'U':
          if (this.phase === 'battle') this._undo();
          break;
        case 'c': case 'C':
          this.scene.resetCamera();
          break;
      }
    });
  }

  /* ---------------- gamepad ---------------- */

  _wireGamepad() {
    const poll = (now) => {
      this._gpRaf = requestAnimationFrame(poll);
      const pads = navigator.getGamepads?.();
      if (!pads) return;
      const gp = [...pads].find(Boolean);
      if (!gp) return;
      if (!this.gamepadState.seen) {
        this.gamepadState.seen = true;
        this.toast('Gamepad connected — stick aims, A confirms, B cancels.');
        this.platform.track('input-modality', { kind: 'gamepad' });
      }
      if (!this.session || this.inputLocked || this.paused) return;
      if (this.phase !== 'battle' && this.phase !== 'placement') return;
      const g = this.session.state.gridSize;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const dpad = { l: gp.buttons[14]?.pressed, r: gp.buttons[15]?.pressed, u: gp.buttons[12]?.pressed, d: gp.buttons[13]?.pressed };
      let dx = 0, dy = 0;
      if (ax < -0.5 || dpad.l) dx = -1; else if (ax > 0.5 || dpad.r) dx = 1;
      if (ay < -0.5 || dpad.u) dy = -1; else if (ay > 0.5 || dpad.d) dy = 1;
      if ((dx || dy) && now > this.gamepadState.nextMove) {
        this.gamepadState.nextMove = now + 180;
        const cur = this.cursorCell ?? 0;
        const { x, y } = cellToXY(cur, g);
        const cell = Math.min(g - 1, Math.max(0, y + dy)) * g + Math.min(g - 1, Math.max(0, x + dx));
        this.cursorCell = cell;
        this.scene.onCellHover?.(this.scene.interactiveBoard, cell);
      }
      const pressed = (i) => gp.buttons[i]?.pressed && !this.gamepadState['b' + i];
      if (pressed(0) && this.cursorCell !== null) this.scene.onCellPick?.(this.scene.interactiveBoard, this.cursorCell);
      if (pressed(1)) { this.selectedCell = null; this._renderTray(); }
      if (pressed(9)) this.showPause();
      for (const i of [0, 1, 9]) this.gamepadState['b' + i] = gp.buttons[i]?.pressed;
    };
    this._gpRaf = requestAnimationFrame(poll);
  }

  /* ---------------- labels & clock ---------------- */

  _startLabelSync() {
    cancelAnimationFrame(this._labelRaf);
    const sync = () => {
      if (!this.session) return;
      this._labelRaf = requestAnimationFrame(sync);
      const st = this.session.state;
      const boardId = 'main';
      if (!this.scene.boards) return;
      const g = st.gridSize;
      let html = '';
      const rect = this.scene.canvas.getBoundingClientRect();
      for (let i = 0; i < g; i++) {
        const col = this.scene.projectCell(boardId, i, rect);
        const row = this.scene.projectCell(boardId, i * g, rect);
        if (col.visible) html += `<span class="cell-label" style="left:${col.x}px;top:${col.y - 22}px">${String.fromCharCode(65 + i)}</span>`;
        if (row.visible) html += `<span class="cell-label" style="left:${row.x - 26}px;top:${row.y}px">${i + 1}</span>`;
      }
      if (this._lastLabels !== html) {
        this.labelLayer.innerHTML = html;
        this._lastLabels = html;
      }
    };
    sync();
    this.onCleanup(() => {
      cancelAnimationFrame(this._labelRaf);
      this.labelLayer.innerHTML = '';
      this._lastLabels = null;
    });
  }

  _startClock() {
    clearInterval(this._clockTimer);
    this._clockTimer = setInterval(() => {
      if (!this.session || this.session.state.phase !== 'battle' || this.paused) return;
      // refresh move-limit/time line once per second
      this._updateHud();
    }, 1000);
    this.onCleanup(() => clearInterval(this._clockTimer));
  }

  /* ---------------- resume (reconnect) ---------------- */

  _saveResume() {
    if (!this.session || this.session.state.phase === 'finished') return;
    try {
      localStorage.setItem(RESUME_KEY, this.session.serialize());
    } catch { /* storage full — resume is best-effort */ }
  }

  _clearResume() {
    try { localStorage.removeItem(RESUME_KEY); } catch { /* ignore */ }
  }

  _resumeAvailable() {
    try { return !!localStorage.getItem(RESUME_KEY); } catch { return false; }
  }

  resumeMatch() {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (!raw) throw new Error('no snapshot');
      this.sessionTeardown();
      this.session = GameSession.restore(raw);
      this.mode = this.session.mode;
      this.content = this.session.config.contentId
        ? stageById(this.session.config.contentId) || challengeById(this.session.config.contentId) || null
        : null;
      if (this.session.config.players.every((p) => !p.isAI)) {
        this.hotseat = { playerIds: this.session.config.players.map((p) => p.id), currentViewer: null };
      }
      this.scene.buildBoards(this.session.state.gridSize);
      this._buildGameScreen();
      if (this.session.state.phase === 'placement') this._beginPlacement();
      else if (this.session.state.phase === 'battle') this._beginBattle();
      else { this.showTitle(); return; }
      this.announce('Match restored from the last safe snapshot.');
    } catch (err) {
      this._clearResume();
      this.showTitle();
    }
  }
}
