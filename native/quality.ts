// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, the engraved chart and brushed-metal textures,
// the sea grid, round-geometry LOD, sky dust, sparks, reflections, water,
// ambient motion, model detail, the frosted HUD) is the browser build's four
// presets and their 60 FPS budgets (src/render/gfx.js before the port: TABLE
// and BUDGETS) keyed by the level's quality tier, with the spark budget
// scaled within the tier by the level's particle budget against the tier's
// anchor level (quantum, molecular, terrestrial, galactic), at most 2×. The
// runtime owns what the old Settings › Graphics panel did besides: Auto and
// the level choice, render scale and the pixel-ratio cap, adaptive
// resolution and the frame-rate limit and readout. The per-effect overrides
// of the old panel are gone with it.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Table, buoys and ships: Lambert on Low, Standard above; own hulls clearcoated Physical where "physical". */
  material: "lambert" | "standard" | "physical";
  /** Engraved chart texture size (px) and brushed-metal pedestal texture width, within the level's largest texture. */
  chart: number;
  brushed: number;
  /** Sea grid segments per side with the detailed sea (the simple sea is 48). */
  sea: number;
  /** Round-geometry LOD: multiplies the radial segments of the pedestal, rim, glass and chart discs. */
  segments: number;
  /** Sky-dust points. */
  stars: number;
  /** Multiplies shot particle counts and the pool size. */
  sparks: number;
  /** Frosted backdrop blur behind dimmed screens and overlays. */
  hudBlur: boolean;
}
export interface Look {
  preset: QualityTier;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  water: "simple" | "detailed";
  particles: "low" | "high";
  /** Ambient motion: the sonar sweep, bobbing buoys, breathing grid lines, smouldering wrecks. */
  animated: boolean;
  /** Model detail: detailed hulls, the engraved chart, the brushed pedestal. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "water" | "particles" | "animated" | "detailed">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, water: "simple", particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, water: "detailed", particles: "high", animated: true, detailed: true },
  high: { reflections: true, water: "detailed", particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, water: "detailed", particles: "high", animated: true, detailed: true },
};
export const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", chart: 512, brushed: 256, sea: 48, segments: 0.5, stars: 200, sparks: 0.5, hudBlur: false },
  balanced: { material: "standard", chart: 512, brushed: 512, sea: 96, segments: 0.75, stars: 300, sparks: 0.75, hudBlur: false },
  high: { material: "physical", chart: 1024, brushed: 512, sea: 144, segments: 1, stars: 400, sparks: 1, hudBlur: true },
  ultra: { material: "physical", chart: 2048, brushed: 1024, sea: 192, segments: 1.5, stars: 700, sparks: 1.5, hudBlur: true },
};
export const PARTICLE_CAP = { low: 600, high: 3200 };
export const SEA_SIMPLE = 48;
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  // Sparks grow with the level's particle budget above the tier's anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = BUDGETS[preset];
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: {
      ...b, chart: Math.min(b.chart, s.maxTextureSize), brushed: Math.min(b.brushed, s.maxTextureSize),
      sparks: Math.round(b.sparks * k * 100) / 100,
    },
  };
}
