/**
 * Fleet Signals graphics quality model: presets, per-category overrides,
 * hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js) so the Settings
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

// StarHermit hardware level (0–20, src/render/gpu-level.js → window.StarHermitGpu) at which Auto starts
// choosing each preset. 0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090; phones, tablets and
// ≤ 4 GB machines are capped at level 9 (Balanced); software renderers are level 0 (Low).
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

/*
 * Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the
 * preset (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070;
 * Ultra: level 17 RTX 4080; measured with tests/gfx-bench.mjs). Gameplay is identical on every preset.
 *   material  table, buoys and ships: 'lambert' (Low) | 'standard'; own hulls are clearcoated
 *             MeshPhysicalMaterial only where this is 'physical' (with Scene detail on)
 *   chart     engraved chart texture size in px (Scene detail on)
 *   brushed   brushed-metal pedestal texture width in px (height ¼ of it)
 *   sea       sea grid segments per side with Water: detailed (simple is always 48)
 *   segments  round-geometry LOD: multiplies the radial segments of the pedestal, rim, glass and chart discs
 *   stars     sky-dust points
 *   sparks    multiplies shot particle counts and the pool size (Particles low 600 / high 3200), then
 *             scaled by the hardware level within the preset (≤ 2×)
 *   hudBlur   backdrop blur behind dimmed screens and overlays (re-composited every frame over the live
 *             3D view); off below High, where they use a more opaque backing
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', chart: 512, brushed: 256, sea: 48, segments: 0.5, stars: 200, sparks: 0.5, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', chart: 512, brushed: 512, sea: 96, segments: 0.75, stars: 300, sparks: 0.75, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', chart: 1024, brushed: 512, sea: 144, segments: 1, stars: 400, sparks: 1, hudBlur: true, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', chart: 2048, brushed: 1024, sea: 192, segments: 1.5, stars: 700, sparks: 1.5, hudBlur: true, bloomRes: 1, aoRes: 1 },
};

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') });
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, LEVELS);
  return PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU; phones and tablets are capped at Balanced by the hardware level. */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system));
}

/** A preset's concrete budget for a hardware level (sparks scale within the preset, ≤ 2×). */
export function budget(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] ?? 0;
  const k = G ? Math.min(2, G.scaleBudget(1, Number.isFinite(level) ? level : floor, floor)) : 1;
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return b;
}

/** Particle pool size for a Particles tier under a budget. */
export function particleCap(tier, b) {
  return Math.round((PARTICLE_CAP[tier] || PARTICLE_CAP.low) * (b ? b.sparks : 1));
}

/** Map the pre-graphics-panel `qualityTier` setting onto a preset. */
export function fromLegacyTier(tier) {
  return { low: 'low', medium: 'balanced', high: 'high' }[tier] || 'auto';
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
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
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budget(preset, out.level);
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
