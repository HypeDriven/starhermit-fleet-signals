/**
 * Fleet Signals — fully procedural WebAudio sound system.
 *
 * No external assets: every sound is synthesized from oscillators, gain
 * envelopes, and one shared procedurally-generated brown-noise buffer.
 * Importing this module has no side effects and is safe in Node (tests):
 * without `window`/`AudioContext` every method is a no-op and
 * `getState().contextState` reports `'unavailable'`.
 *
 * Buses: 'music' | 'effects' | 'ambience' | 'voice' — each an independent
 * gain node feeding a master gain (mute). Music bus defaults to 0.5.
 *
 * @returns {{
 *   resume(): void, suspend(): void, dispose(): void,
 *   setVolume(bus: string, v: number): void, setMuted(muted: boolean): void,
 *   play(name: string, opts?: { variant?: number }): void,
 *   startMusic(mood: 'calm'|'tense'): void, stopMusic(): void,
 *   startAmbience(): void, stopAmbience(): void,
 *   setCaptionSink(fn: ((text: string) => void) | null): void,
 *   getState(): { muted: boolean, contextState: 'running'|'suspended'|'closed'|'unavailable',
 *     volumes: { music: number, effects: number, ambience: number, voice: number } },
 * }}
 */
export function createAudio() {
  const BUSES = ['music', 'effects', 'ambience', 'voice'];

  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {GainNode | null} */
  let master = null;
  /** @type {Record<string, GainNode>} */
  const busGains = {};
  /** @type {AudioBuffer | null} */
  let noiseBuf = null;

  const volumes = { music: 0.5, effects: 1, ambience: 1, voice: 1 };
  let muted = false;
  let disposed = false;
  let everHadContext = false;
  /** @type {((text: string) => void) | null} */
  let captionSink = null;

  // Music / ambience runtime state.
  let musicMood = null; // null | 'calm' | 'tense'
  let musicTimer = null;
  let musicNodes = [];
  let musicStep = 0;
  let ambRunning = false;
  let ambNodes = [];
  let ambTimer = null;
  let ambCountdown = 0;

  const hasAudio = () =>
    !disposed &&
    typeof globalThis.window !== 'undefined' &&
    !!(globalThis.AudioContext || globalThis.webkitAudioContext);

  const caption = (text) => {
    if (!captionSink) return;
    try { captionSink(text); } catch { /* sink errors must not break audio */ }
  };

  function ensureContext() {
    if (!hasAudio() || ctx) return !!ctx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    try { ctx = new AC(); } catch { ctx = null; return false; }
    everHadContext = true;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    for (const bus of BUSES) {
      const g = ctx.createGain();
      g.gain.value = volumes[bus];
      g.connect(master);
      busGains[bus] = g;
    }
    // Shared noise buffer: ~2s of brown-ish noise (integrated white noise).
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    return true;
  }

  const now = () => (ctx ? ctx.currentTime : 0);

  /** Attack/decay gain envelope on a bus (or explicit destination). */
  function env(bus, t0, peak, attack, decay, destOverride) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    g.connect(destOverride || busGains[bus]);
    return g;
  }

  function osc(type, freq, t0, t1, dest) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.connect(dest);
    o.start(t0);
    o.stop(t1);
    return o;
  }

  function noise(t0, t1, dest, playbackRate = 1) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.connect(dest);
    src.start(t0);
    src.stop(t1);
    return src;
  }

  /** Tone arpeggio helper: play freqs sequentially as enveloped notes. */
  function arp(freqs, step, type, peak, decay, t, pitch = 1) {
    freqs.forEach((f, i) => {
      const t0 = t + i * step;
      osc(type, f * pitch, t0, t0 + decay + 0.05, env('effects', t0, peak, 0.01, decay));
    });
  }

  // Deterministic per-variant pitch/timbre shift (same variant = same sound).
  function variantShift(variant) {
    const v = (((variant | 0) % 8) + 8) % 8;
    return { pitch: 1 + (v - 3.5) * 0.04, cutoff: 1 + (v - 3.5) * 0.08 };
  }

  /** @param {string} name @param {{variant?: number}} [opts] */
  function play(name, opts = {}) {
    if (!ctx || ctx.state !== 'running') return;
    const { pitch, cutoff } = variantShift(opts.variant ?? 0);
    const t = now();
    const fx = 'effects';
    switch (name) {
      case 'ui-press':
        osc('square', 660 * pitch, t, t + 0.12, env(fx, t, 0.18, 0.004, 0.09));
        caption('[ui press]');
        break;
      case 'ui-back':
        osc('square', 420 * pitch, t, t + 0.14, env(fx, t, 0.16, 0.004, 0.11));
        caption('[ui back]');
        break;
      case 'invalid': // dull double-thud
        for (let i = 0; i < 2; i++)
          osc('triangle', (140 - i * 15) * pitch, t + i * 0.11, t + i * 0.11 + 0.12,
            env(fx, t + i * 0.11, 0.25, 0.005, 0.09));
        caption('[invalid action]');
        break;
      case 'place': { // mechanical clunk + soft chirp
        osc('triangle', 180 * pitch, t, t + 0.18, env(fx, t, 0.35, 0.003, 0.14));
        noise(t, t + 0.08, env(fx, t, 0.2, 0.002, 0.06), 1.5);
        const o = osc('sine', 900 * pitch, t + 0.09, t + 0.25, env(fx, t + 0.09, 0.08, 0.01, 0.12));
        o.frequency.exponentialRampToValueAtTime(1400 * pitch, t + 0.22);
        caption('[ship placed]');
        break;
      }
      case 'rotate': // quick tick
        osc('square', 1100 * pitch, t, t + 0.06, env(fx, t, 0.14, 0.002, 0.045));
        caption('[rotate]');
        break;
      case 'fire': { // rising launch whoosh, ~0.5s
        const o = osc('sawtooth', 120 * pitch, t, t + 0.55, env(fx, t, 0.3, 0.05, 0.45));
        o.frequency.exponentialRampToValueAtTime(900 * pitch, t + 0.45);
        const nf = ctx.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.setValueAtTime(300 * cutoff, t);
        nf.frequency.exponentialRampToValueAtTime(2400 * cutoff, t + 0.45);
        nf.Q.value = 1.2;
        nf.connect(busGains[fx]);
        noise(t, t + 0.55, env(fx, t, 0.22, 0.05, 0.42, nf), 1);
        caption('[shot fired]');
        break;
      }
      case 'splash': { // filtered noise burst (miss)
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(2600 * cutoff, t);
        f.frequency.exponentialRampToValueAtTime(500 * cutoff, t + 0.4);
        f.connect(busGains[fx]);
        noise(t, t + 0.5, env(fx, t, 0.35, 0.01, 0.42, f), 0.9);
        const o = osc('sine', 300 * pitch, t + 0.15, t + 0.4, env(fx, t + 0.15, 0.06, 0.02, 0.2));
        o.frequency.exponentialRampToValueAtTime(120 * pitch, t + 0.38);
        caption('[splash — miss]');
        break;
      }
      case 'hit': { // metallic impact + low boom
        osc('square', 220 * pitch, t, t + 0.3, env(fx, t, 0.4, 0.002, 0.25));
        osc('triangle', 1250 * pitch, t, t + 0.4, env(fx, t, 0.18, 0.002, 0.35));
        const o = osc('sine', 90 * pitch, t + 0.03, t + 0.6, env(fx, t + 0.03, 0.45, 0.01, 0.5));
        o.frequency.exponentialRampToValueAtTime(45 * pitch, t + 0.55);
        caption('[impact — hit]');
        break;
      }
      case 'sunk': // hit + descending tone cascade
        play('hit', opts);
        [660, 520, 392, 262].forEach((f, i) => {
          const t0 = t + 0.25 + i * 0.16;
          osc('triangle', f * pitch, t0, t0 + 0.35, env(fx, t0, 0.22, 0.01, 0.3))
            .frequency.exponentialRampToValueAtTime(f * pitch * 0.85, t0 + 0.3);
        });
        caption('[ship sunk]');
        break;
      case 'mine': { // harsh detonation with noise
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(3200, t);
        f.frequency.exponentialRampToValueAtTime(200, t + 0.6);
        f.connect(busGains[fx]);
        noise(t, t + 0.7, env(fx, t, 0.5, 0.003, 0.6, f), 1.2);
        const o = osc('sine', 70 * pitch, t, t + 0.65, env(fx, t, 0.5, 0.005, 0.55));
        o.frequency.exponentialRampToValueAtTime(35, t + 0.6);
        osc('sawtooth', 180 * pitch, t, t + 0.2, env(fx, t, 0.2, 0.002, 0.15));
        caption('[mine detonated]');
        break;
      }
      case 'turn': // soft chime — your turn
        arp([880, 1320], 0.14, 'sine', 0.12, 0.35, t, pitch);
        caption('[your turn]');
        break;
      case 'countdown': { // variant 3/2/1 pitch ladder
        const ladder = [784, 587, 494, 392];
        const v = Math.min(3, Math.max(0, opts.variant | 0));
        osc('sine', ladder[v] * pitch, t, t + 0.2, env(fx, t, 0.2, 0.005, 0.15));
        caption('[countdown]');
        break;
      }
      case 'victory': // bright rising arpeggio
        arp([523, 659, 784, 1047, 1319], 0.12, 'triangle', 0.18, 0.4, t);
        caption('[victory fanfare]');
        break;
      case 'defeat': // low falling motif
        arp([392, 330, 262, 196], 0.22, 'triangle', 0.16, 0.5, t);
        caption('[defeat]');
        break;
      case 'lesson-done': // cheerful two-note
        arp([659, 880], 0.15, 'sine', 0.16, 0.3, t);
        caption('[lesson complete]');
        break;
      case 'achievement': // sparkle arpeggio
        arp([1047, 1319, 1568, 2093], 0.08, 'sine', 0.1, 0.35, t);
        caption('[achievement unlocked]');
        break;
      default:
        break; // unknown names silently ignored
    }
  }

  // --- music -------------------------------------------------------------

  const SCALE = [220, 261.6, 293.7, 329.6, 392, 440, 523.3]; // pentatonic-ish

  function scheduleMusicStep() {
    if (!ctx || !musicMood || ctx.state !== 'running') return;
    const t = now() + 0.5; // schedule 0.5s ahead
    const tense = musicMood === 'tense';
    musicStep += 1;
    const pluck = (type, freq, peak, decay) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      g.connect(busGains.music);
      osc(type, freq, t, t + decay + 0.1, g);
      musicNodes.push(g);
    };
    // Slow-evolving walk over the scale (deterministic pattern).
    const idx = (musicStep * 2 + Math.floor(musicStep / 5)) % SCALE.length;
    if (musicStep % (tense ? 2 : 3) === 0) pluck('triangle', SCALE[idx], 0.09, 1.1);
    if (tense && musicStep % 4 === 0) pluck('sine', 55, 0.07, 0.3); // low pulse
    if (musicNodes.length > 64) musicNodes.splice(0, musicNodes.length - 64);
  }

  function startMusic(mood) {
    if (!hasAudio() || musicMood === mood) return; // idempotent per mood
    if (!ensureContext()) return;
    stopMusicInternal();
    musicMood = mood;
    const tense = mood === 'tense';
    const t = now();
    // Pad: detuned oscillators through a slow LFO'd lowpass, faded in (crossfade).
    const padGain = ctx.createGain();
    padGain.gain.setValueAtTime(0.0001, t);
    padGain.gain.linearRampToValueAtTime(tense ? 0.05 : 0.04, t + 2);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = tense ? 700 : 500;
    padGain.connect(filter);
    filter.connect(busGains.music);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = tense ? 0.13 : 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = tense ? 260 : 160;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
    const base = tense ? 110 : 98;
    [0, 1.008, 0.5].forEach((det, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = base * (i === 2 ? 2 : 1) * (det || 1);
      o.connect(padGain);
      o.start();
      musicNodes.push(o);
    });
    musicNodes.push(padGain, filter, lfo, lfoGain);
    musicStep = 0;
    musicTimer = setInterval(scheduleMusicStep, 200);
    caption(tense ? '[tense music]' : '[calm music]');
  }

  /** Stop and disconnect a list of live nodes, ignoring per-node failures. */
  function teardown(nodes) {
    for (const n of nodes) {
      try { if (n.stop) n.stop(); } catch { /* already stopped */ }
      try { n.disconnect(); } catch { /* not connected */ }
    }
  }

  function stopMusicInternal() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    teardown(musicNodes);
    musicNodes = [];
  }

  function stopMusic() {
    if (!musicMood) return;
    musicMood = null;
    stopMusicInternal();
    caption('[music stopped]');
  }

  // --- ambience ----------------------------------------------------------

  function startAmbience() {
    if (!hasAudio() || ambRunning) return; // idempotent
    if (!ensureContext()) return;
    ambRunning = true;
    // Filtered brown noise through a slow LFO'd lowpass.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    filter.connect(g);
    g.connect(busGains.ambience);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.connect(filter);
    src.start();
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
    ambNodes.push(src, filter, g, lfo, lfoGain);
    // Occasional very quiet wave swell every 6-12s (internal counter).
    ambCountdown = 30 + Math.floor(Math.random() * 30); // x 200ms ticks
    ambTimer = setInterval(() => {
      if (!ctx || ctx.state !== 'running') return;
      if (--ambCountdown > 0) return;
      ambCountdown = 30 + Math.floor(Math.random() * 30);
      const ts = now();
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, ts);
      sg.gain.linearRampToValueAtTime(0.06, ts + 1.2);
      sg.gain.linearRampToValueAtTime(0.0001, ts + 2.6);
      const sf = ctx.createBiquadFilter();
      sf.type = 'lowpass';
      sf.frequency.value = 700;
      sg.connect(sf);
      sf.connect(busGains.ambience);
      noise(ts, ts + 2.8, sg, 0.8);
    }, 200);
    caption('[sea ambience]');
  }

  function stopAmbience() {
    if (!ambRunning) return;
    ambRunning = false;
    if (ambTimer) { clearInterval(ambTimer); ambTimer = null; }
    teardown(ambNodes);
    ambNodes = [];
    caption('[ambience stopped]');
  }

  // --- lifecycle ---------------------------------------------------------

  function resume() {
    if (!ensureContext()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function suspend() {
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopMusic();
    stopAmbience();
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    ctx = null;
    master = null;
    noiseBuf = null;
    captionSink = null;
  }

  function setVolume(bus, v) {
    if (!BUSES.includes(bus)) return;
    const vol = Math.min(1, Math.max(0, Number(v) || 0));
    volumes[bus] = vol;
    if (busGains[bus]) busGains[bus].gain.value = vol;
  }

  function setMuted(m) {
    muted = !!m;
    if (master) master.gain.value = muted ? 0 : 1;
  }

  function setCaptionSink(fn) {
    captionSink = typeof fn === 'function' ? fn : null;
  }

  function getState() {
    return {
      muted,
      volumes: { ...volumes },
      contextState: ctx ? ctx.state : (everHadContext && disposed ? 'closed' : 'unavailable'),
    };
  }

  return {
    resume, suspend, dispose, setVolume, setMuted, play,
    startMusic, stopMusic, startAmbience, stopAmbience,
    setCaptionSink, getState,
  };
}
