/**
 * Fleet Signals graphics quality model: presets, per-category overrides,
 * GPU detection and a cost summary. Pure (no three.js) so the Settings
 * panel, the renderer and the unit tests agree on what a setting means.
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

/** Category → allowed tiers, cheapest first. */
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  water: ['simple', 'detailed'],
  particles: ['low', 'high'],
  background: ['static', 'animated'],
  detail: ['plain', 'detailed'],
};

/** Each preset: a row of tiers, a render scale and a device-pixel-ratio cap. */
const TABLE = {
  low: { scale: 0.85, dpr: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', water: 'simple', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { scale: 1, dpr: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', water: 'detailed', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, dpr: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', water: 'detailed', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, dpr: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', water: 'detailed', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const SEA_SEGMENTS = { simple: 48, detailed: 144 };
export const PARTICLE_CAP = { low: 600, high: 3200 };

/**
 * Best preset for this GPU, from the unmasked renderer string when the
 * browser exposes it. Touch/mobile devices are capped at Balanced.
 */
export function detectPreset(gpu, { mobile = false } = {}) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/** Map the pre-graphics-panel `qualityTier` setting onto a preset. */
export function fromLegacyTier(tier) {
  return { low: 'low', medium: 'balanced', high: 'high' }[tier] || 'auto';
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset,
    auto,
    dpr: row.dpr,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when an effect needs it; Low renders straight to the canvas.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
  return out;
}

/** Choosing a preset clears every override (render scale and toggles stay). */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const next = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale !== undefined) next.render_scale = s.render_scale;
  if (s.adaptive !== undefined) next.adaptive = s.adaptive;
  if (s.show_fps !== undefined) next.show_fps = s.show_fps;
  return next;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** One-line cost summary for the panel. */
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full AO' : 'AO',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no AA' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
