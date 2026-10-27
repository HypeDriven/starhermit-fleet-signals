// The look per graphics level: the browser build's four presets and their
// 60 FPS budgets (src/render/gfx.js before the port: TABLE and BUDGETS)
// keyed by the runtime's quality tier (frame().quality), with the spark
// budget scaled within the tier by the level (frame().levelIndex) as the
// browser build scaled it by its hardware level (≤ 2×). The runtime owns
// what the old Settings › Graphics panel did besides: Auto and the level
// choice, render scale and the pixel-ratio cap, adaptive resolution, the
// frame-rate limit and readout, and the shadow map size it holds to the
// level. The per-effect overrides of the old panel are gone with it.
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Table, buoys and ships: Lambert on Low, Standard above; own hulls clearcoated Physical where "physical". */
  material: "lambert" | "standard" | "physical";
  /** Engraved chart texture size (px) and brushed-metal pedestal texture width. */
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, water: "simple", particles: "low", animated: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, water: "detailed", particles: "high", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, water: "detailed", particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, water: "detailed", particles: "high", animated: true, detailed: true },
};
export const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", chart: 512, brushed: 256, sea: 48, segments: 0.5, stars: 200, sparks: 0.5, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", chart: 512, brushed: 512, sea: 96, segments: 0.75, stars: 300, sparks: 0.75, hudBlur: false, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", chart: 1024, brushed: 512, sea: 144, segments: 1, stars: 400, sparks: 1, hudBlur: true, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", chart: 2048, brushed: 1024, sea: 192, segments: 1.5, stars: 700, sparks: 1.5, hudBlur: true, bloomRes: 1, aoRes: 1 },
};
export const PARTICLE_CAP = { low: 600, high: 3200 };
export const SEA_SIMPLE = 48;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  // Levels are about 1.64× apart in GPU throughput; sparks grow at most 2× within a tier.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  const b = BUDGETS[preset];
  return { preset, ...TABLE[preset], budget: { ...b, sparks: Math.round(b.sparks * k * 100) / 100 } };
}
