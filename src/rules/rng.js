/**
 * Deterministic seeded random streams.
 * Rules, content decoration and audiovisual variants each use their own
 * forked stream so cosmetic randomness can never alter rules outcomes.
 */

/** FNV-1a string hash -> uint32. Used for seeds and state hashing. */
export function hashString(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 core — small, fast, fully deterministic. */
function mulberry32(state) {
  let a = state >>> 0;
  const next = function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.state = () => a >>> 0;
  return next;
}

/**
 * Create a named random stream.
 * @param {number|string} seed
 * @returns stream with next/int/pick/shuffle/fork and serializable state.
 */
export function makeRng(seed) {
  const s = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  const core = mulberry32(s);
  const stream = {
    /** float in [0, 1) */
    next: () => core(),
    /** integer in [0, n) */
    int: (n) => Math.floor(core() * n),
    /** integer in [lo, hi] inclusive */
    range: (lo, hi) => lo + Math.floor(core() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(core() * arr.length)],
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(core() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** Independent derived stream; stable for a given label. */
    fork: (label) => makeRng((s ^ hashString(String(label))) >>> 0),
    getState: () => core.state(),
  };
  return stream;
}

/** Resume a stream from a previously captured state. */
export function resumeRng(state) {
  return makeRng(state >>> 0);
}
