// The holographic chart table over a stylized procedural sea on
// starhermit:scene, ported from the browser build's three.js renderer
// (src/render/scene.js before the port): the steel pedestal with its glowing
// rim, glass surface, engraved chart and sonar sweep; the sea (wave field
// and impact ripples); seeded stars and channel buoys; the two holo grids
// (the main board: the editor in placement, the target in battle; the side
// board: your own fleet in battle) with instanced grid lines, cursor ghost
// and ring; the procedural hulls (plain and detailed), markers, draft and
// preview hulls; the pooled particle bursts and shot arcs; and the authored
// camera poses on critically damped springs with the orbit gesture, the
// top-down view and the shake. It renders from rules snapshots and never
// mutates rules state; cosmetic jobs are interruption-safe (skip()).
//
// What changed from three.js, and why:
// - The water and sonar ShaderMaterials are WGSL (the same math; the water's
//   vertex hook keeps the old shader's object-space wave field exactly).
// - The particle pool's per-point size attribute and point shader become
//   three PointsMaterial pools by size class (sparks, splash, embers) with a
//   soft round dot; points fade by colour (they blend additively), where the
//   old shader shrank them.
// - The EffectComposer chain (GTAO, UnrealBloom, the grade ShaderPass,
//   SMAA / FXAA / MSAA) is renderer.ao / bloom / grade / antialias; the
//   adaptive resolution, pixel-ratio cap, render scale and the frame-rate
//   readout are the runtime's.
// - Light intensities are three.js r160's divided by π (the engine's convention).
// - The shadow camera's fitted box is the light's shadow distance.
// - Picking intersects the pointer's ray with the main board's plane (the
//   invisible pick plane of the old build).
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DataTexture, DirectionalLight, DoubleSide, Euler, ExtrudeGeometry, Float32BufferAttribute, Fog, Group,
  HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  OctahedronGeometry, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, Quaternion, Raycaster, RepeatWrapping,
  Box3, OrthographicCamera, PCFSoftShadowMap, RingGeometry, RoomEnvironment, SRGBColorSpace, Shape, ShaderMaterial, SphereGeometry, Spherical, TorusGeometry, Vector3, Vector4,
  pointerToNdc, renderer, scene,
} from "starhermit:scene";
import type { Material, Texture } from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { makeRng } from "../src/rules/rng.js";
import { cellToXY } from "../src/rules/engine.js";
import { PARTICLE_CAP, SEA_SIMPLE, type Budget, type Look } from "./quality.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const PI = Math.PI;
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

// Round-geometry LOD: radial segments scaled by the preset budget (at least 8).
const seg = (n: number, k: number): number => Math.max(8, Math.round(n * (k || 1)));

// ------------------------------------------------------------------ authored constants
const CAMERA_POSES: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  title: { pos: [0, 7.5, 10.5], look: [0, 0, -0.5] },
  placement: { pos: [0, 8.8, 5.2], look: [0, 0, -0.6] },
  battle: { pos: [0.6, 9.0, 7.2], look: [-0.9, 0, -0.9] },
  results: { pos: [0, 10.5, 9.0], look: [0, 0, -0.5] },
};
const BOARD_LAYOUT = {
  main: { center: new Vector3(0, 0.12, -1.6), scale: 1.0 },  // target in battle / editor in placement
  side: { center: new Vector3(-5.6, 0.12, 2.6), scale: 0.5 }, // own fleet in battle
};
let HIT_COLOR = 0xff7a3c;
let MISS_COLOR = 0xcfe8ff;
const MINE_COLOR = 0xc26bff;
const VALID_COLOR = 0x6ff2c8;
const INVALID_COLOR = 0xff5468;

// ------------------------------------------------------------------ state
let look: Look | null = null;
let budget: Budget | null = null;
let reducedMotion = false;
const visualSeed = "fleet-signals-v1";
let time = 0;
let envTex: Texture | null = null;
let built = false;

const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 120);
const keyLight = new DirectionalLight(0xfff2dd, 2.6);
const fillLight = new HemisphereLight(0x8fb7d9, 0x1a2433, 1.05);

/** Standard material with the scene-wide image-based-lighting strength. */
// three r160 scaled scene.environment by each material's envMapIntensity; r185 (minor 23+) scales
// only the material's own envMap, so envified materials carry the room as their envMap.
const envMats = new Set<MeshStandardMaterial>();
function envify<M extends MeshStandardMaterial>(mat: M, k = 1): M {
  mat.envMapIntensity = 0.32 * k;
  mat.envMap = scene.environment;
  envMats.add(mat);
  return mat;
}

// ------------------------------------------------------------------ textures
/** Engraved chart for the table top: range rings, bearing ticks, compass rose (drawn in 1024-px units). */
function makeChartTexture(n: number): Texture | null {
  const N = 1024;
  const c = new OffscreenCanvas(n, n);
  const g = c.getContext("2d");
  g.scale(n / N, n / N);
  g.fillStyle = "#000";
  g.fillRect(0, 0, N, N);
  const cx = N / 2, R = N / 2 - 4;
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 2;
  for (let i = 1; i <= 5; i++) {
    g.globalAlpha = i === 5 ? 0.9 : 0.35;
    g.beginPath(); g.arc(cx, cx, R * (i / 5) - 6, 0, PI * 2); g.stroke();
  }
  g.globalAlpha = 1;
  for (let d = 0; d < 360; d += 2) {
    const a = (d * PI) / 180;
    const len = d % 30 === 0 ? 34 : d % 10 === 0 ? 20 : 9;
    g.globalAlpha = d % 30 === 0 ? 0.95 : 0.55;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (R - 8), cx + Math.sin(a) * (R - 8));
    g.lineTo(cx + Math.cos(a) * (R - 8 - len), cx + Math.sin(a) * (R - 8 - len));
    g.stroke();
  }
  g.globalAlpha = 0.22;
  for (let k = 0; k < 16; k++) {
    const a = (k * PI) / 8;
    g.beginPath(); g.moveTo(cx, cx);
    g.lineTo(cx + Math.cos(a) * (R - 50), cx + Math.sin(a) * (R - 50));
    g.stroke();
  }
  g.globalAlpha = 0.9;
  g.fillStyle = "#fff";
  g.font = "bold 34px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const [t, a] of [["N", -PI / 2], ["E", 0], ["S", PI / 2], ["W", PI]] as [string, number][]) {
    g.fillText(t, cx + Math.cos(a) * (R - 66), cx + Math.sin(a) * (R - 66));
  }
  // faint survey speckle so the glass never reads as a flat fill
  const rng = makeRng("fleet-signals:chart-speckle");
  g.globalAlpha = 0.12;
  for (let i = 0; i < 2600; i++) {
    const a = rng.next() * PI * 2, r = Math.sqrt(rng.next()) * (R - 10);
    g.fillRect(cx + Math.cos(a) * r, cx + Math.sin(a) * r, 2, 2);
  }
  try {
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  } catch (e) { console.warn(`chart texture: ${String(e)}`); return null; }
}

/** Brushed-metal streaks for the pedestal (roughness + bump), drawn in 512 × 128 units. */
function makeBrushedTexture(n: number): Texture | null {
  const c = new OffscreenCanvas(n, n / 4);
  const g = c.getContext("2d");
  g.scale(n / 512, n / 512);
  g.fillStyle = "#8a8a8a";
  g.fillRect(0, 0, 512, 128);
  const rng = makeRng("fleet-signals:brushed");
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(90 + rng.next() * 110);
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(rng.next() * 512, rng.next() * 128, 30 + rng.next() * 160, 1);
  }
  g.fillStyle = "rgba(20,20,20,0.9)";
  for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 2, 128);
  g.fillRect(0, 40, 512, 2);
  try {
    const tex = new CanvasTexture(c);
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.repeat.set(3, 1);
    return tex;
  } catch (e) { console.warn(`brushed texture: ${String(e)}`); return null; }
}

/** The soft round dot of the particle shader (smoothstep(0.5, 0.05, r)). */
let dotTex: Texture | null = null;
function dotTexture(): Texture {
  if (dotTex) return dotTex;
  const n = 64;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / n;
    const t = clamp((d - 0.5) / (0.05 - 0.5), 0, 1);
    const a = t * t * (3 - 2 * t);
    const o = (y * n + x) * 4;
    px[o] = px[o + 1] = px[o + 2] = 255;
    px[o + 3] = Math.round(a * 255);
  }
  dotTex = new DataTexture(px, n, n);
  dotTex.generateMipmaps = true;
  return dotTex;
}

// ------------------------------------------------------------------ procedural hulls
/** Minimal geometry merge (positions/normals/uvs/colours, non-indexed), as scene.js mergeGeometries. */
function mergeParts(geos: BufferGeometry[], tones: number[] | null = null): BufferGeometry {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of parts) n += g.attributes.position!.count;
  const pos = new Float32Array(n * 3), norm = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  const c = new Color();
  let o = 0;
  parts.forEach((g, gi) => {
    const cnt = g.attributes.position!.count;
    pos.set(g.attributes.position!.array as Float32Array, o * 3);
    if (g.attributes.normal) norm.set(g.attributes.normal.array as Float32Array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array as Float32Array, o * 2);
    c.set(tones ? tones[gi]! : 0xffffff);
    for (let i = 0; i < cnt; i++) { col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b; }
    o += cnt;
  });
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new Float32BufferAttribute(norm, 3));
  out.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  out.setAttribute("color", new Float32BufferAttribute(col, 3));
  return out;
}

const hullCache = new Map<string, BufferGeometry>();
/** A low-poly stylized hull (tapered bow, flat stern, deck and bridge), or the detailed one. */
function hullGeometry(size: number, detailed: boolean): BufferGeometry {
  const key = `${size}:${detailed}`;
  const hit = hullCache.get(key);
  if (hit) return hit;
  const g = detailed ? buildDetailedHull(size) : buildPlainHull(size);
  hullCache.set(key, g);
  return g;
}
function buildPlainHull(size: number): BufferGeometry {
  const L = size * 0.86, W = 0.52, H = 0.34;
  const shape = new Shape();
  shape.moveTo(-L / 2, -W / 2);
  shape.lineTo(L / 2 - W * 0.9, -W / 2);
  shape.lineTo(L / 2, 0);
  shape.lineTo(L / 2 - W * 0.9, W / 2);
  shape.lineTo(-L / 2, W / 2);
  shape.lineTo(-L / 2, -W / 2);
  const hull = new ExtrudeGeometry(shape, { depth: H, bevelEnabled: false });
  hull.rotateX(-PI / 2);
  hull.translate(0, H, 0);
  const parts: BufferGeometry[] = [hull];
  const deck = new BoxGeometry(L * 0.82, H * 0.35, W * 0.8);
  deck.translate(-L * 0.04, H + H * 0.17, 0);
  parts.push(deck);
  if (size >= 3) {
    const tower = new BoxGeometry(W * 0.7, H * 1.15, W * 0.62);
    tower.translate(-L * 0.16, H + H * 0.75, 0);
    parts.push(tower);
    const mast = new CylinderGeometry(0.02, 0.03, H * 1.3, 6);
    mast.translate(-L * 0.16, H + H * 1.7, 0);
    parts.push(mast);
  }
  return mergeParts(parts);
}
// Vertex colours for the detailed hull (multiplied by a white material).
const HULL_TONES = { hull: 0x8a97a8, deck: 0x5f6b79, house: 0xc5ced8, gun: 0x9ba7b6, dark: 0x343d48, glass: 0x7fd8ee };
/** Bevelled plan with deck, superstructure, turrets and mast; carriers get a flight deck and an offset island. */
function buildDetailedHull(size: number): BufferGeometry {
  const L = size * 0.86, W = 0.52, H = 0.34, b = 0.035;
  const shape = new Shape();
  const l = L / 2 - b, w = W / 2 - b;
  shape.moveTo(-l, -w * 0.86);
  shape.quadraticCurveTo(-l, -w, -l + 0.06, -w);
  shape.lineTo(l - W * 0.95, -w);
  shape.quadraticCurveTo(l - W * 0.3, -w * 0.8, l, 0);
  shape.quadraticCurveTo(l - W * 0.3, w * 0.8, l - W * 0.95, w);
  shape.lineTo(-l + 0.06, w);
  shape.quadraticCurveTo(-l, w, -l, w * 0.86);
  shape.lineTo(-l, -w * 0.86);
  const hull = new ExtrudeGeometry(shape, { depth: H - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 6 });
  hull.rotateX(-PI / 2);
  hull.translate(0, H + b, 0);
  const top = 2 * H;
  const parts: { g: BufferGeometry; c: number }[] = [{ g: hull, c: HULL_TONES.hull }];
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, c: number): void => {
    const g = new BoxGeometry(sx, sy, sz);
    g.translate(x, y + sy / 2, z);
    parts.push({ g, c });
  };
  const cyl = (r: number, h: number, x: number, y: number, z: number, c: number, sg = 10): void => {
    const g = new CylinderGeometry(r, r, h, sg);
    g.translate(x, y + h / 2, z);
    parts.push({ g, c });
  };
  const turret = (x: number, dir: number): void => {
    cyl(0.1, 0.06, x, top, 0, HULL_TONES.gun);
    box(0.2, 0.03, 0.028, x + dir * 0.13, top + 0.025, 0.035, HULL_TONES.dark);
    box(0.2, 0.03, 0.028, x + dir * 0.13, top + 0.025, -0.035, HULL_TONES.dark);
  };
  if (size >= 5) {
    box(L * 0.9, 0.04, W * 0.92, -L * 0.02, top - 0.02, 0, HULL_TONES.deck);
    box(L * 0.7, 0.005, 0.02, -L * 0.05, top + 0.02, 0, HULL_TONES.house);
    box(0.34, 0.2, 0.13, -L * 0.12, top + 0.02, W * 0.3, HULL_TONES.house);
    box(0.2, 0.05, 0.135, -L * 0.1, top + 0.14, W * 0.3, HULL_TONES.glass);
    cyl(0.015, 0.26, -L * 0.14, top + 0.22, W * 0.3, HULL_TONES.dark, 6);
  } else {
    box(L * 0.8, 0.03, W * 0.62, -L * 0.04, top - 0.01, 0, HULL_TONES.deck);
    if (size >= 3) {
      box(W * 0.72, H * 0.62, W * 0.56, -L * 0.1, top, 0, HULL_TONES.house);
      box(W * 0.5, H * 0.3, W * 0.5, -L * 0.1, top + H * 0.62, 0, HULL_TONES.house);
      box(W * 0.52, 0.045, W * 0.52, -L * 0.1 + 0.02, top + H * 0.72, 0, HULL_TONES.glass);
      cyl(0.02, H * 1.25, -L * 0.14, top + H * 0.92, 0, HULL_TONES.dark, 6);
      box(0.03, 0.02, 0.22, -L * 0.14, top + H * 1.9, 0, HULL_TONES.dark);
      cyl(0.06, 0.16, -L * 0.28, top, 0, HULL_TONES.dark, 8); // funnel
      turret(L * 0.22, 1);
      if (size >= 4) turret(-L * 0.4, -1);
    } else {
      box(W * 0.6, H * 0.45, W * 0.5, -L * 0.05, top, 0, HULL_TONES.house);
      box(W * 0.42, 0.04, W * 0.52, -L * 0.05 + 0.03, top + H * 0.3, 0, HULL_TONES.glass);
      cyl(0.015, H * 0.9, -L * 0.18, top, 0, HULL_TONES.dark, 6);
    }
  }
  return mergeParts(parts.map((p) => p.g), parts.map((p) => p.c));
}

// ------------------------------------------------------------------ the sea (WGSL)
// The old water shader read the plane's object-space position (x, y, 0) as
// p = position.xz and lifted object y: the same here, so the swell moves as it did.
const WATER_COMMON = `
fn fs_wave(p: vec2f, t: f32) -> f32 {
  var h = 0.0;
  h += sin(p.x * 0.32 + t * 0.9) * 0.16;
  h += sin(p.y * 0.24 - t * 0.7) * 0.13;
  h += sin((p.x + p.y) * 0.14 + t * 0.45) * 0.20;
  for (var i = 0; i < 8; i++) {
    let r = uniforms.uRipples[i];
    let age = t - r.z;
    if (r.w > 0.001 && age > 0.0 && age < 4.0) {
      let d = distance(p, r.xy);
      let ring = sin(d * 3.5 - age * 6.0) * exp(-d * 0.35) * exp(-age * 1.4);
      h += ring * r.w * 0.35;
    }
  }
  return h;
}`;
const WATER_VERTEX = `${WATER_COMMON}
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  let p = v.position.xz;
  let t = uniforms.uTime;
  let h = fs_wave(p, t);
  let e = 0.35;
  let hx = fs_wave(p + vec2f(e, 0.0), t) - h;
  let hz = fs_wave(p + vec2f(0.0, e), t) - h;
  o.position = vec3f(v.position.x, v.position.y + h, v.position.z);
  o.v0 = vec4f(normalize(vec3f(-hx / e, 1.0, -hz / e)), 0.0);
  return o;
}`;
// Detailed water adds a two-layer chop to the normal (glitter under the key
// light), a broad moon sheen and the holo table's cyan glow on the swell.
const WATER_FRAGMENT = `
fn fragment(f: Fragment) -> vec4f {
  var n = normalize(f.v0.xyz);
  let cam = camera_position();
  let viewDir = normalize(cam - f.world);
  let dist = length(cam - f.world);
  if (uniforms.uDetail > 0.5) {
    let p = f.world.xz;
    let t = uniforms.uTime;
    let fade = exp(-dist * 0.035);
    let nx = cos(p.x * 2.3 + t * 1.6 + sin(p.y * 0.9)) + 0.6 * cos((p.x - p.y) * 3.7 + t * 2.4);
    let nz = cos(p.y * 2.9 - t * 1.3 + sin(p.x * 1.2)) - 0.6 * cos((p.x - p.y) * 3.7 + t * 2.4);
    n = normalize(n + vec3f(nx, 0.0, nz) * 0.09 * fade);
  }
  let fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.2);
  let depthMix = clamp(0.35 + f.world.y * 0.8, 0.0, 1.0);
  let base = mix(uniforms.uDeep, uniforms.uShallow, depthMix);
  var col = mix(base, uniforms.uSky, fresnel * 0.65);
  let halfV = normalize(uniforms.uSunDir + viewDir);
  let nh = max(dot(n, halfV), 0.0);
  col += uniforms.uSunColor * pow(nh, 220.0) * 0.9;
  if (uniforms.uDetail > 0.5) {
    col += uniforms.uSunColor * pow(nh, 28.0) * 0.05;
    let r = length(f.world.xz - vec2f(0.0, -0.5));
    col += uniforms.uGlow * exp(-r * 0.22) * (0.10 + 0.08 * max(n.x + n.z, 0.0));
  }
  return vec4f(col, 1.0);
}`;
const ripples = Array.from({ length: 8 }, () => new Vector4(0, 0, -10, 0));
const waterUniforms = {
  uTime: { value: 0 },
  uRipples: { value: ripples as readonly Vector4[] },
  uDeep: { value: new Color(0x06283d) },
  uShallow: { value: new Color(0x1a5d7a) },
  uSky: { value: new Color(0x9fc6e0) },
  uSunDir: { value: new Vector3(0.5, 0.7, 0.4).normalize() },
  uSunColor: { value: new Color(0xffe9c4) },
  uGlow: { value: new Color(0x59e6ff) },
  uDetail: { value: 0 },
};
const waterMaterial = new ShaderMaterial({ uniforms: waterUniforms, vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT, fog: true });
let water: Mesh | null = null;
let rippleCursor = 0;

// The sonar sweep across the chart (`background` animated, off with reduced motion).
const SWEEP_FRAGMENT = `
fn fs_ss(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn fragment(f: Fragment) -> vec4f {
  let uv = vec2f(f.uv.x, 1.0 - f.uv.y);
  let p = uv * 2.0 - 1.0;
  let r = length(p);
  let a = uniforms.uAngle - atan2(p.y, p.x);
  let d = a - 6.2831853 * floor(a / 6.2831853);
  let wedge = exp(-d * 2.6) * fs_ss(1.0, 0.85, r) * fs_ss(0.0, 0.08, r);
  let edge = fs_ss(0.05, 0.0, d) * 0.8;
  return vec4f(uniforms.uColor, (wedge + edge * fs_ss(1.0, 0.9, r)) * uniforms.uAlpha);
}`;
const sweepUniforms = { uAngle: { value: 0 }, uColor: { value: new Color(0x63e2f2) }, uAlpha: { value: 0.16 } };

// ------------------------------------------------------------------ the table, buoys and stars
const table = new Group();
const lodMeshes: [Mesh, (k: number) => BufferGeometry][] = [];
function lod(mesh: Mesh, make: (k: number) => BufferGeometry): Mesh { lodMeshes.push([mesh, make]); return mesh; }
const pedestalStd = envify(new MeshStandardMaterial({ color: 0x2a3340, roughness: 0.55, metalness: 0.75 }));
const pedestal = lod(new Mesh(new CylinderGeometry(5.4, 6.2, 1.6, 64), pedestalStd), (k) => new CylinderGeometry(5.4, 6.2, 1.6, seg(64, k)));
const rimMat = envify(new MeshStandardMaterial({ color: 0x59e6ff, emissive: 0x59e6ff, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0.2 }), 0.5);
const rim = lod(new Mesh(new TorusGeometry(5.45, 0.09, 16, 96), rimMat), (k) => new TorusGeometry(5.45, 0.09, seg(16, k), seg(96, k)));
const surface = lod(new Mesh(new CylinderGeometry(5.4, 5.4, 0.08, 64), envify(new MeshStandardMaterial({
  color: 0x0d2438, roughness: 0.25, metalness: 0.4, emissive: 0x0d2c44, emissiveIntensity: 0.5, transparent: true, opacity: 0.92,
}), 0.3)), (k) => new CylinderGeometry(5.4, 5.4, 0.08, seg(64, k)));
const engravingMat = new MeshBasicMaterial({ color: 0x63e2f2, transparent: true, opacity: 0.32, blending: AdditiveBlending, depthWrite: false });
const engraving = lod(new Mesh(new CircleGeometry(5.36, 96), engravingMat), (k) => new CircleGeometry(5.36, seg(96, k)));
const sweep = lod(new Mesh(new CircleGeometry(5.36, 96), new ShaderMaterial({
  uniforms: sweepUniforms, fragmentShader: SWEEP_FRAGMENT, transparent: true, depthWrite: false, blending: AdditiveBlending,
})), (k) => new CircleGeometry(5.36, seg(96, k)));

const buoyStd = envify(new MeshStandardMaterial({ color: 0xb03a4a, roughness: 0.6 }));
const lampStd = new MeshStandardMaterial({ color: 0x220608, emissive: 0xff4a5a, emissiveIntensity: 2.4 });
const buoyLambert = new MeshLambertMaterial({ color: 0xb03a4a });
const lampLambert = new MeshLambertMaterial({ color: 0x220608, emissive: 0xff4a5a, emissiveIntensity: 2.4 });
const pedestalLambert = new MeshLambertMaterial({ color: 0x2a3340 });
const buoys = new InstancedMesh(new ConeGeometry(0.3, 0.9, 8), buoyStd, 10);
const lamps = new InstancedMesh(new SphereGeometry(0.09, 8, 6), lampStd, 10);
const buoySpots: { x: number; z: number; phase: number }[] = [];
let stars: Points | null = null;
let ambient = false;

function starGeometry(count: number): BufferGeometry {
  const vrng = makeRng(visualSeed + ":stars");
  const p = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const ang = vrng.next() * PI * 2;
    const el = 0.15 + vrng.next() * 1.2;
    const r = 70;
    p[i * 3] = Math.cos(ang) * Math.cos(el) * r;
    p[i * 3 + 1] = Math.sin(el) * r * 0.6;
    p[i * 3 + 2] = Math.sin(ang) * Math.cos(el) * r;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(p, 3));
  return geo;
}

function build(): void {
  built = true;
  renderer.camera = camera;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  scene.fog = new Fog(0x0a1626, 26, 60);
  scene.background = new Color(0x0a1626);
  keyLight.position.set(8, 12, 6);
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.02;
  renderer.shadowMap.type = PCFSoftShadowMap;
  scene.add(keyLight, keyLight.target, fillLight);

  pedestal.position.y = -0.85;
  pedestal.receiveShadow = true;
  rim.rotation.x = PI / 2;
  rim.position.y = -0.02;
  surface.position.y = -0.04;
  surface.receiveShadow = true;
  engraving.rotation.x = -PI / 2;
  engraving.position.y = 0.004;
  engraving.visible = false;
  engraving.noAO = true;
  sweep.rotation.x = -PI / 2;
  sweep.position.y = 0.008;
  sweep.visible = false;
  sweep.noAO = true;
  table.add(pedestal, rim, surface, engraving, sweep);
  scene.add(table);

  // decoration from the deterministic visual stream
  const vrng = makeRng(visualSeed + ":decor");
  const bm = new Matrix4();
  for (let i = 0; i < 10; i++) {
    const ang = vrng.next() * PI * 2;
    const r = 16 + vrng.next() * 20;
    const spot = { x: Math.cos(ang) * r, z: Math.sin(ang) * r, phase: vrng.next() * PI * 2 };
    buoySpots.push(spot);
    bm.makeTranslation(spot.x, -1.6, spot.z);
    buoys.setMatrixAt(i, bm);
    bm.makeTranslation(spot.x, -1.1, spot.z);
    lamps.setMatrixAt(i, bm);
  }
  buoys.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  scene.add(buoys, lamps);
}

// ------------------------------------------------------------------ particles
type PoolSize = 0 | 1 | 2;
/** One size class of the particle pool: additive dots fading by colour. */
class ParticlePool {
  max: number;
  pos: Float32Array; vel: Float32Array; life: Float32Array; span: Float32Array; base: Float32Array; col: Float32Array; k: Float32Array;
  head = 0;
  points: Points;
  active = 0;
  constructor(max: number, size: number) {
    this.max = max;
    this.pos = new Float32Array(max * 3).fill(-1000);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.span = new Float32Array(max);
    this.base = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.k = new Float32Array(max);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new BufferAttribute(this.col, 3));
    this.points = new Points(geo, new PointsMaterial({
      size, sizeAttenuation: true, vertexColors: true, map: dotTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending,
    }));
    this.points.frustumCulled = false;
  }
  emit(o: Vector3, count: number, color: Color, speed: number, up: number, life: number, spread: number): void {
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % this.max;
      const i3 = i * 3;
      this.pos[i3] = o.x + (Math.random() - 0.5) * spread;
      this.pos[i3 + 1] = o.y;
      this.pos[i3 + 2] = o.z + (Math.random() - 0.5) * spread;
      const ang = Math.random() * PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.vel[i3] = Math.cos(ang) * v;
      this.vel[i3 + 1] = up * (0.5 + Math.random() * 0.8);
      this.vel[i3 + 2] = Math.sin(ang) * v;
      this.life[i] = this.span[i] = life * (0.6 + Math.random() * 0.6);
      // The old per-point size (0.7–1.3 ×) becomes brightness.
      const s = 0.7 + Math.random() * 0.6;
      this.base[i3] = color.r * s; this.base[i3 + 1] = color.g * s; this.base[i3 + 2] = color.b * s;
      this.k[i] = 1;
    }
    this.active = this.max;
  }
  update(dt: number): void {
    if (!this.active) return;
    let any = 0;
    for (let i = 0; i < this.max; i++) {
      const i3 = i * 3;
      if (this.life[i]! <= 0) { if (this.k[i]! > 0) { this.k[i] = 0; this.col[i3] = this.col[i3 + 1] = this.col[i3 + 2] = 0; this.pos[i3 + 1] = -1000; } continue; }
      any++;
      this.life[i] = this.life[i]! - dt;
      this.vel[i3 + 1] = this.vel[i3 + 1]! - 6.5 * dt; // gravity
      this.pos[i3] = this.pos[i3]! + this.vel[i3]! * dt;
      this.pos[i3 + 1] = this.pos[i3 + 1]! + this.vel[i3 + 1]! * dt;
      this.pos[i3 + 2] = this.pos[i3 + 2]! + this.vel[i3 + 2]! * dt;
      // The old shader shrank each point by (0.85 + 0.15 k) a frame (k the life left): fade as it shrank.
      const k = Math.max(this.life[i]! / this.span[i]!, 0);
      this.k[i] = this.k[i]! * Math.pow(0.85 + 0.15 * k, dt * 60);
      const f = this.life[i]! <= 0 ? 0 : this.k[i]!;
      this.col[i3] = this.base[i3]! * f; this.col[i3 + 1] = this.base[i3 + 1]! * f; this.col[i3 + 2] = this.base[i3 + 2]! * f;
    }
    this.points.geometry.attributes.position!.needsUpdate = true;
    this.points.geometry.attributes.color!.needsUpdate = true;
    if (!any) this.active = 0;
  }
  settle(): void {
    this.life.fill(0);
    this.k.fill(0);
    this.col.fill(0);
    for (let i = 0; i < this.max; i++) this.pos[i * 3 + 1] = -1000;
    this.points.geometry.attributes.position!.needsUpdate = true;
    this.points.geometry.attributes.color!.needsUpdate = true;
    this.active = 0;
  }
  dispose(): void { scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); }
}
// Size classes: the old psize 1.1–1.2 (sparks, spray), 2.2 (bursts), 3.2 (embers), in the old 180 / depth scale.
const POOL_SIZES = [0.52, 0.95, 1.4];
let pools: ParticlePool[] = [];
let sparksScale = 1;
function buildParticles(): void {
  for (const p of pools) p.dispose();
  const cap = Math.round(PARTICLE_CAP[look?.particles ?? "low"] * (budget?.sparks ?? 1));
  // Bursts take most of the pool; sparks and embers (High particles) the rest.
  pools = [new ParticlePool(Math.max(64, Math.round(cap * 0.3)), POOL_SIZES[0]!), new ParticlePool(Math.max(64, Math.round(cap * 0.55)), POOL_SIZES[1]!), new ParticlePool(Math.max(32, Math.round(cap * 0.15)), POOL_SIZES[2]!)];
  sparksScale = budget?.sparks ?? 1;
  for (const p of pools) scene.add(p.points);
}
const _pc = new Color();
function emit(origin: Vector3, o: { count: number; color: number; speed?: number; up?: number; size?: number; life?: number; spread?: number }): void {
  const size = o.size ?? 2.2;
  const cls: PoolSize = size < 1.6 ? 0 : size < 2.8 ? 1 : 2;
  const pool = pools[cls];
  if (!pool) return;
  _pc.set(o.color);
  pool.emit(origin, Math.max(1, Math.round(o.count * sparksScale)), _pc, o.speed ?? 2.2, o.up ?? 2.6, o.life ?? 0.8, o.spread ?? 0.4);
}

// ------------------------------------------------------------------ boards
interface Board {
  group: Group; plate: Mesh; lines: InstancedMesh; lineMat: MeshStandardMaterial; markers: Group; ghost: Mesh; ring: Mesh;
  gridSize: number; cell: number; half: number;
}
let boards: { main: Board; side: Board } | null = null;
let holoColor = new Color(0x1e5f73);
let holoShipColor = new Color(0x63e2f2);

function buildGridBoard(gridSize: number, color: Color): Board {
  const group = new Group();
  const cell = 1.0;
  const span = gridSize * cell;
  const half = span / 2;
  const plate = new Mesh(new BoxGeometry(span + 0.5, 0.06, span + 0.5), envify(new MeshStandardMaterial({
    color, transparent: true, opacity: 0.12, roughness: 0.35, metalness: 0.0, emissive: color, emissiveIntensity: 0.18, depthWrite: false,
  }), 0.5));
  plate.receiveShadow = true;
  plate.position.y = -0.03;
  plate.noAO = true;
  group.add(plate);
  const lineMat = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, transparent: true, opacity: 0.55, roughness: 0.4 });
  const lines = new InstancedMesh(new BoxGeometry(0.025, 0.02, span), lineMat, (gridSize + 1) * 2);
  const m = new Matrix4();
  let li = 0;
  for (let i = 0; i <= gridSize; i++) {
    m.makeTranslation(-half + i * cell, 0, 0);
    lines.setMatrixAt(li++, m);
    m.makeRotationY(PI / 2).setPosition(0, 0, -half + i * cell);
    lines.setMatrixAt(li++, m);
  }
  lines.instanceMatrix.needsUpdate = true;
  lines.noAO = true;
  group.add(lines);
  const markers = new Group();
  group.add(markers);
  const ghost = new Mesh(new PlaneGeometry(cell * 0.9, cell * 0.9), new MeshBasicMaterial({
    color: VALID_COLOR, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
  }));
  ghost.rotation.x = -PI / 2;
  ghost.position.y = 0.06;
  ghost.visible = false;
  ghost.noAO = true;
  group.add(ghost);
  const ring = new Mesh(new RingGeometry(cell * 0.42, cell * 0.5, 32), new MeshBasicMaterial({
    color: VALID_COLOR, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
  }));
  ring.rotation.x = -PI / 2;
  ring.position.y = 0.05;
  ring.visible = false;
  ring.noAO = true;
  group.add(ring);
  return { group, plate, lines, lineMat, markers, ghost, ring, gridSize, cell, half };
}
function disposeTree(o: Any): void {
  o.traverse?.((c: Any) => {
    if (c.geometry && !c.userData?.sharedGeo) c.geometry.dispose?.();
    if (c.material && !c.userData?.sharedMat) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m: Material) => m.dispose());
  });
}

/** (Re)build both holo grids for a new match. */
export function buildBoards(gridSize: number): void {
  if (boards) for (const b of [boards.main, boards.side]) { scene.remove(b.group); disposeTree(b.group); }
  const main = buildGridBoard(gridSize, holoColor);
  const side = buildGridBoard(gridSize, holoColor);
  main.group.position.copy(BOARD_LAYOUT.main.center);
  side.group.position.copy(BOARD_LAYOUT.side.center);
  side.group.scale.setScalar(BOARD_LAYOUT.side.scale);
  scene.add(main.group, side.group);
  boards = { main, side };
  ownShips = []; enemyShips.clear(); draftShips = []; preview = []; wreckMats = [];
  interactive = null;
  fitShadow();
}
export function hasBoards(): boolean { return !!boards; }
export function gridSize(): number { return boards?.main.gridSize ?? 8; }

const _v = new Vector3();
export function cellWorldPos(boardId: "main" | "side", cell: number, out = new Vector3()): Vector3 {
  const b = boards?.[boardId];
  if (!b) return out.set(0, 0, 0);
  const { x, y } = cellToXY(cell, b.gridSize);
  out.set(-b.half + (x + 0.5) * b.cell, 0.1, -b.half + (y + 0.5) * b.cell);
  return b.group.localToWorld(out);
}
/** A cell's window position (physical pixels) and whether it is in front of the camera. */
export function projectCell(boardId: "main" | "side", cell: number, width: number, height: number): { x: number; y: number; visible: boolean } {
  const v = cellWorldPos(boardId, cell, _v).project(camera);
  return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height, visible: v.z < 1 };
}

// ------------------------------------------------------------------ ships and markers
let ownShips: Mesh[] = [];
const enemyShips = new Map<string, Mesh>();
let draftShips: Mesh[] = [];
let preview: Mesh[] = [];
let wreckMats: (MeshStandardMaterial | MeshLambertMaterial)[] = [];
let viewerId: string | null = null;
let lastSync: [Any, string, "placement" | "battle"] | null = null;
let lastDraft: [Any[], Map<string, Any>, number] | null = null;

function shipMaterial(kind: "own" | "wreck" | "draft"): Material {
  const detailed = !!look?.detailed;
  const mat = budget?.material ?? "standard";
  if (mat === "lambert") {
    if (kind === "own") return new MeshLambertMaterial(detailed ? { color: 0xffffff, vertexColors: true } : { color: 0x8a97a8 });
    if (kind === "wreck") {
      const m = new MeshLambertMaterial({ color: 0x3a2f2f, emissive: 0xff3300, emissiveIntensity: 0.12 });
      wreckMats.push(m);
      return m;
    }
    return new MeshLambertMaterial({ color: holoShipColor, transparent: true, opacity: 0.4, emissive: holoShipColor, emissiveIntensity: 0.6 });
  }
  if (kind === "own") {
    if (detailed && mat !== "physical") return envify(new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.7 }), 1.2);
    if (detailed) return envify(new MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.7, clearcoat: 0.55, clearcoatRoughness: 0.28 }), 1.2);
    return envify(new MeshStandardMaterial({ color: 0x8a97a8, roughness: 0.45, metalness: 0.85 }));
  }
  if (kind === "wreck") {
    const m = envify(new MeshStandardMaterial({ color: 0x3a2f2f, roughness: 0.9, metalness: 0.2, emissive: 0xff3300, emissiveIntensity: 0.12 }), 0.5);
    wreckMats.push(m);
    return m;
  }
  return new MeshStandardMaterial({ color: holoShipColor, transparent: true, opacity: 0.4, emissive: holoShipColor, emissiveIntensity: 0.6, roughness: 0.4 });
}
function addShipMesh(board: Board, ship: { size: number; cells: number[] }, kind: "own" | "wreck" | "draft"): Mesh {
  const mesh = new Mesh(hullGeometry(ship.size, !!look?.detailed), shipMaterial(kind));
  mesh.userData.sharedGeo = true;
  mesh.castShadow = kind !== "draft";
  mesh.receiveShadow = kind === "own";
  const first = cellToXY(ship.cells[0]!, board.gridSize);
  const last = cellToXY(ship.cells[ship.cells.length - 1]!, board.gridSize);
  const horizontal = first.y === last.y;
  mesh.position.set(-board.half + ((first.x + last.x) / 2 + 0.5) * board.cell, 0.1, -board.half + ((first.y + last.y) / 2 + 0.5) * board.cell);
  if (!horizontal) mesh.rotation.y = PI / 2;
  board.group.add(mesh);
  return mesh;
}
const markerGeo = { miss: new RingGeometry(0.16, 0.26, 20), mine: new OctahedronGeometry(0.24), hit: new ConeGeometry(0.2, 0.42, 4) };
function addMarker(board: Board, cell: number, kind: string): void {
  let mesh: Mesh;
  if (kind === "miss") {
    mesh = new Mesh(markerGeo.miss, new MeshBasicMaterial({ color: MISS_COLOR, transparent: true, opacity: 0.85, side: DoubleSide }));
    mesh.rotation.x = -PI / 2;
    mesh.noAO = true;
  } else if (kind === "mine") {
    mesh = new Mesh(markerGeo.mine, envify(new MeshStandardMaterial({ color: MINE_COLOR, emissive: MINE_COLOR, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.4 })));
    mesh.castShadow = true;
    mesh.position.y = 0.2;
  } else {
    mesh = new Mesh(markerGeo.hit, envify(new MeshStandardMaterial({ color: HIT_COLOR, emissive: HIT_COLOR, emissiveIntensity: 2.0, roughness: 0.35 })));
    mesh.castShadow = true;
    mesh.position.y = 0.24;
    mesh.rotation.y = PI / 4;
  }
  mesh.userData.sharedGeo = true;
  const { x, y } = cellToXY(cell, board.gridSize);
  mesh.position.x = -board.half + (x + 0.5) * board.cell;
  mesh.position.z = -board.half + (y + 0.5) * board.cell;
  if (kind === "miss") mesh.position.y = 0.07;
  board.markers.add(mesh);
}
function removeMesh(m: Mesh): void {
  m.parent?.remove(m);
  if (!m.userData.sharedGeo) m.geometry.dispose();
  (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
}
export function clearShips(): void {
  for (const m of ownShips) removeMesh(m);
  ownShips = [];
  for (const m of enemyShips.values()) removeMesh(m);
  enemyShips.clear();
  for (const m of draftShips) removeMesh(m);
  draftShips = [];
  wreckMats = [];
  clearPreview();
  if (boards) for (const b of [boards.main, boards.side]) while (b.markers.children.length) removeMesh(b.markers.children[0] as Mesh);
}

/**
 * Full resync from an authoritative snapshot (the only path that sets board
 * contents). viewer = the seat the screen currently belongs to; mode
 * "placement" renders the own fleet on main, "battle" puts the target grid on
 * main and the own fleet on side.
 */
export function syncFromState(state: Any, viewer: string, mode: "placement" | "battle"): void {
  if (!boards || boards.main.gridSize !== state.gridSize) buildBoards(state.gridSize);
  lastSync = [state, viewer, mode];
  lastDraft = null;
  clearShips();
  viewerId = viewer;
  const me = state.players.find((p: Any) => p.id === viewer);
  if (!me || !boards) return;
  const ownBoard = mode === "placement" ? boards.main : boards.side;
  const targetBoard = mode === "placement" ? boards.side : boards.main;
  for (const ship of me.ships) ownShips.push(addShipMesh(ownBoard, ship, ship.sunk ? "wreck" : "own"));
  for (const foe of state.players) {
    if (foe.id === me.id) continue;
    for (const [cellStr, result] of Object.entries(foe.shotsFired[me.id] || {})) addMarker(ownBoard, Number(cellStr), result as string);
  }
  if (mode === "battle") {
    for (const foe of state.players) {
      if (foe.id === me.id) continue;
      for (const [cellStr, result] of Object.entries(me.shotsFired[foe.id] || {})) addMarker(targetBoard, Number(cellStr), result as string);
      for (const ship of foe.ships) {
        const key = foe.id + ":" + ship.id;
        if (ship.sunk && !enemyShips.has(key)) enemyShips.set(key, addShipMesh(targetBoard, ship, "wreck"));
      }
    }
  }
  if (mode === "placement" && me.mines) for (const cell of me.mines) addMarker(ownBoard, cell, "mine");
}

export function previewShip(cells: number[] | null, valid: boolean): void {
  clearPreview();
  if (!cells || !cells.length || !boards) return;
  const b = boards.main;
  for (const cell of cells) {
    const m = new Mesh(previewGeo, new MeshBasicMaterial({ color: valid ? VALID_COLOR : INVALID_COLOR, transparent: true, opacity: 0.4, blending: AdditiveBlending, depthWrite: false }));
    m.userData.sharedGeo = true;
    m.rotation.x = -PI / 2;
    m.noAO = true;
    const { x, y } = cellToXY(cell, b.gridSize);
    m.position.set(-b.half + (x + 0.5), 0.08, -b.half + (y + 0.5));
    b.group.add(m);
    preview.push(m);
  }
}
const previewGeo = new PlaneGeometry(0.86, 0.86);
export function clearPreview(): void { for (const m of preview) removeMesh(m); preview = []; }

/** Draft (uncommitted) placement hulls on the main board. */
export function showDraftPlacements(fleet: Any[], placements: Map<string, Any>, gridSize: number): void {
  for (const m of draftShips) removeMesh(m);
  draftShips = [];
  lastDraft = [fleet, placements, gridSize];
  const board = boards?.main;
  if (!board) return;
  for (const pl of placements.values()) {
    const def = fleet.find((f) => f.id === pl.shipId);
    if (!def) continue;
    const cells: number[] = [];
    for (let i = 0; i < def.size; i++) cells.push(pl.dir === "h" ? pl.y * gridSize + pl.x + i : (pl.y + i) * gridSize + pl.x);
    draftShips.push(addShipMesh(board, { size: def.size, cells }, "draft"));
  }
}

// ------------------------------------------------------------------ cursor / selection
let interactive: "main" | "side" | null = null;
export function setInteractive(boardId: "main" | "side" | null): void {
  interactive = boardId;
  if (!boards || boardId) return;
  for (const b of [boards.main, boards.side]) { b.ghost.visible = false; b.ring.visible = false; }
}
export function interactiveBoard(): "main" | "side" | null { return interactive; }
export function setCursor(boardId: "main" | "side", cell: number | null, valid = true): void {
  if (!boards) return;
  for (const id of ["main", "side"] as const) {
    const b = boards[id];
    const active = id === boardId && cell !== null && cell !== undefined;
    b.ghost.visible = active;
    b.ring.visible = active;
    if (active) {
      const { x, y } = cellToXY(cell!, b.gridSize);
      const px = -b.half + (x + 0.5) * b.cell, pz = -b.half + (y + 0.5) * b.cell;
      b.ghost.position.set(px, 0.06, pz);
      b.ring.position.set(px, 0.05, pz);
      const col = valid ? VALID_COLOR : INVALID_COLOR;
      (b.ghost.material as MeshBasicMaterial).color.set(col);
      (b.ring.material as MeshBasicMaterial).color.set(col);
    }
  }
}

const _ray = new Raycaster();
const _hit = new Vector3();
/** The interactive board's cell under a window pixel, or null (the old pick plane at y + 0.02). */
export function pickCell(x: number, y: number): number | null {
  if (!boards || !interactive) return null;
  const b = boards[interactive];
  _ray.setFromCamera(pointerToNdc(x, y), camera);
  const planeY = b.group.position.y + 0.02 * b.group.scale.y;
  const r = _ray.ray;
  if (Math.abs(r.direction.y) < 1e-6) return null;
  const t = (planeY - r.origin.y) / r.direction.y;
  if (t <= 0) return null;
  _hit.copy(r.origin).addScaledVector(r.direction, t);
  const lx = (_hit.x - b.group.position.x) / b.group.scale.x;
  const lz = (_hit.z - b.group.position.z) / b.group.scale.z;
  const cx = Math.floor((lx + b.half) / b.cell);
  const cy = Math.floor((lz + b.half) / b.cell);
  if (cx < 0 || cy < 0 || cx >= b.gridSize || cy >= b.gridSize) return null;
  return cy * b.gridSize + cx;
}

// ------------------------------------------------------------------ theme and look
export interface SceneTheme { waterDeep: string; waterShallow: string; sky: string; fog: string; holoGrid: string; holoShip: string; sun: string }
let themeScene: SceneTheme | null = null;
export function setTheme(t: SceneTheme | null): void {
  if (!t) return;
  themeScene = t;
  waterUniforms.uDeep.value.set(t.waterDeep);
  waterUniforms.uShallow.value.set(t.waterShallow);
  waterUniforms.uSky.value.set(t.sky);
  waterUniforms.uSunColor.value.set(t.sun);
  waterUniforms.uGlow.value.set(t.holoShip);
  if (scene.fog) (scene.fog as Fog).color.set(t.fog);
  scene.background = new Color(t.fog);
  fillLight.color.set(t.sky);
  keyLight.color.set(t.sun);
  holoColor = new Color(t.holoGrid);
  holoShipColor = new Color(t.holoShip);
  if (boards) for (const b of [boards.main, boards.side]) {
    (b.plate.material as MeshStandardMaterial).color.set(t.holoGrid);
    (b.plate.material as MeshStandardMaterial).emissive.set(t.holoGrid);
    b.lineMat.color.set(t.holoGrid);
    b.lineMat.emissive.set(t.holoGrid);
  }
  rimMat.color.set(t.holoGrid);
  rimMat.emissive.set(t.holoShip);
  engravingMat.color.set(t.holoShip);
  sweepUniforms.uColor.value.set(t.holoShip);
}
/** The colour-vision palette's hit and miss colours on the chart's markers (styles.css html.palette-*). */
export function setMarkerColors(hit: string, miss: string): void {
  const h = new Color(hit).getHex(), m = new Color(miss).getHex();
  if (h === HIT_COLOR && m === MISS_COLOR) return;
  HIT_COLOR = h; MISS_COLOR = m;
  resync();
}
function resync(): void {
  if (!lastSync) return;
  const draft = lastDraft;
  syncFromState(...lastSync);
  if (draft) showDraftPlacements(...draft);
}

export function setReducedMotion(v: boolean): void {
  reducedMotion = v;
  if (reducedMotion) shake = 0;
  applyAmbient();
}

/** The look for the frame's graphics level; cheap when nothing changed. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  const pb = prev?.budget;
  look = next;
  budget = next.budget;
  if (!built) build();
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  keyLight.castShadow = shadows;
  if (shadows) keyLight.shadow.mapSize = next.shadows;
  fitShadow();
  // Reflections: the PMREM-filtered RoomEnvironment, per-material envMapIntensity (0.32 × k).
  if (next.reflections && !envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  scene.environment = next.reflections ? envTex : null;
  for (const m of envMats) m.envMap = scene.environment;
  if (!prev || prev.water !== next.water || pb!.sea !== next.budget.sea) buildWater();
  waterUniforms.uDetail.value = next.water === "detailed" ? 1 : 0;
  if (!prev || prev.particles !== next.particles || pb!.sparks !== next.budget.sparks) buildParticles();
  if (!pb || pb.segments !== next.budget.segments) for (const [mesh, make] of lodMeshes) { mesh.geometry.dispose(); mesh.geometry = make(next.budget.segments); }
  if (!pb || pb.stars !== next.budget.stars) {
    if (stars) { scene.remove(stars); stars.geometry.dispose(); stars.material.dispose(); }
    stars = new Points(starGeometry(next.budget.stars), new PointsMaterial({ color: 0xbfd9ff, size: 0.25, sizeAttenuation: true, transparent: true, opacity: 0.7 }));
    scene.add(stars);
  }
  applyMaterialClass(next.budget.material === "lambert");
  if (!prev || prev.detailed !== next.detailed || pb!.chart !== next.budget.chart || pb!.brushed !== next.budget.brushed || pb!.material !== next.budget.material) applyDetail(pb);
  applyAmbient();
  // Post: GTAO for contact darkening, bloom on emissive highlights only (threshold 0.86),
  // the colour grade (gentle S-curve, +10 % saturation, cool shadows / warm highlights,
  // vignette) after the output, and FXAA / SMAA / MSAA.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.7 : 0.55, radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  renderer.bloom = next.bloom ? { strength: 0.45, radius: 0.4, threshold: 0.86, resolution: next.budget.bloomRes } : null;
  renderer.grade = next.grade ? {
    space: "display", contrast: 0.11, saturation: 1.1,
    shadows: [0.95, 0.99, 1.06], highlights: [1.04, 1.0, 0.95], split: [0.25, 0.85],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.9 },
  } : null;
  renderer.antialias = next.antialias;
}

function buildWater(): void {
  const n = look?.water === "detailed" ? budget!.sea : SEA_SIMPLE;
  const geo = new PlaneGeometry(140, 140, n, n);
  if (water) { water.geometry.dispose(); water.geometry = geo; return; }
  water = new Mesh(geo, waterMaterial);
  water.rotation.x = -PI / 2;
  water.position.y = -2.2;
  water.noAO = true;
  water.frustumCulled = false;
  scene.add(water);
}

// Material class: Lambert twins of the pedestal, buoys and lamps on Low; Standard above.
function applyMaterialClass(lambert: boolean): void {
  pedestal.material = lambert ? pedestalLambert : pedestalStd;
  buoys.material = lambert ? buoyLambert : buoyStd;
  lamps.material = lambert ? lampLambert : lampStd;
}

let chartTex: Texture | null = null;
let brushTex: Texture | null = null;
function applyDetail(pb?: Budget): void {
  const detailed = !!look?.detailed;
  const b = budget!;
  if (chartTex && pb?.chart !== b.chart) { chartTex.dispose(); chartTex = null; }
  if (brushTex && pb?.brushed !== b.brushed) { brushTex.dispose(); brushTex = null; }
  if (detailed && !chartTex) chartTex = makeChartTexture(b.chart);
  if (detailed && !brushTex) brushTex = makeBrushedTexture(b.brushed);
  engravingMat.map = detailed ? chartTex : null;
  engraving.visible = detailed && !!chartTex;
  pedestalStd.roughnessMap = detailed ? brushTex : null;
  pedestalStd.bumpMap = detailed ? brushTex : null;
  pedestalStd.bumpScale = 0.6;
  pedestalStd.roughness = detailed ? 0.8 : 0.55;
  // rebuild ship meshes with the other hull set
  resync();
}

function applyAmbient(): void {
  ambient = !!look && look.animated && !reducedMotion;
  sweep.visible = ambient;
  if (ambient) return;
  const m = new Matrix4();
  buoySpots.forEach((b, i) => {
    m.makeTranslation(b.x, -1.6, b.z); buoys.setMatrixAt(i, m);
    m.makeTranslation(b.x, -1.1, b.z); lamps.setMatrixAt(i, m);
  });
  buoys.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  lampStd.emissiveIntensity = 2.4;
  lampLambert.emissiveIntensity = 2.4;
  setGridGlow(0.9);
  for (const w of wreckMats) w.emissiveIntensity = 0.12;
}
function setGridGlow(k: number): void {
  if (boards) for (const b of [boards.main, boards.side]) b.lineMat.emissiveIntensity = k;
}
const _m = new Matrix4(), _q = new Quaternion(), _e = new Euler(), _one = new Vector3(1, 1, 1), _bv = new Vector3();
/** Gentle idle motion: buoys bob and blink, the sonar sweeps, grids breathe, wrecks smoulder. */
function animateAmbient(): void {
  const t = time;
  buoySpots.forEach((b, i) => {
    const bob = Math.sin(t * 1.1 + b.phase) * 0.12;
    _e.set(Math.sin(t * 0.9 + b.phase) * 0.08, 0, Math.cos(t * 0.7 + b.phase) * 0.08);
    _q.setFromEuler(_e);
    _m.compose(_bv.set(b.x, -1.6 + bob, b.z), _q, _one);
    buoys.setMatrixAt(i, _m);
    _m.compose(_bv.set(b.x, -1.1 + bob, b.z), _q, _one);
    lamps.setMatrixAt(i, _m);
  });
  buoys.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  const lamp = (t % 2.4) < 0.5 ? 3.2 : 0.5;
  lampStd.emissiveIntensity = lamp;
  lampLambert.emissiveIntensity = lamp;
  sweepUniforms.uAngle.value = (t * 0.55) % (PI * 2);
  setGridGlow(0.9 + Math.sin(t * 1.3) * 0.12);
  wreckMats.forEach((w, i) => { w.emissiveIntensity = 0.14 + 0.1 * Math.max(0, Math.sin(t * 5.3 + i) * Math.sin(t * 2.1)); });
}

/** Fit the key light's shadow box to the table and both boards (the page's _fitShadow). */
function fitShadow(): void {
  keyLight.target.position.set(0, 0, 0);
  const cam = keyLight.shadow.camera as OrthographicCamera;
  cam.position.copy(keyLight.position);
  cam.lookAt(keyLight.target.position);
  cam.updateMatrixWorld();
  const pts: Vector3[] = [];
  const add = (x: number, z: number): void => { pts.push(new Vector3(x, -1.7, z), new Vector3(x, 1.4, z)); };
  for (const dx of [-6.3, 6.3]) for (const dz of [-6.3, 6.3]) add(dx, dz);
  if (boards) {
    for (const b of [boards.main, boards.side]) {
      const h = (b.half + 0.3) * b.group.scale.x;
      const c = b.group.position;
      for (const dx of [-h, h]) for (const dz of [-h, h]) add(c.x + dx, c.z + dz);
    }
  }
  const box = new Box3();
  for (const p of pts) box.expandByPoint(p.applyMatrix4(cam.matrixWorldInverse));
  cam.left = box.min.x - 0.3; cam.right = box.max.x + 0.3; cam.bottom = box.min.y - 0.3; cam.top = box.max.y + 0.3;
  cam.near = Math.max(0.1, -box.max.z - 1); cam.far = -box.min.z + 1;
  cam.updateProjectionMatrix();
}

// ------------------------------------------------------------------ camera
const camLook = new Vector3().fromArray(CAMERA_POSES.title!.look);
const camTarget = { pos: new Vector3().fromArray(CAMERA_POSES.title!.pos), look: new Vector3().fromArray(CAMERA_POSES.title!.look) };
const camVel = { pos: new Vector3(), look: new Vector3() };
let camBase: { pos: Vector3; look: Vector3 } | null = null;
let viewName = "title";
const orbit = { x: 0, y: 0 };
let topDown = false;
let shake = 0;
/** The HUD-free rectangle of the window, as fractions of each edge (from the screens' layout). */
let insets = { l: 0, r: 0, t: 0, b: 0 };
let aspect = 16 / 9;
camera.position.fromArray(CAMERA_POSES.title!.pos);
camera.lookAt(camLook);

export function setSafeInsets(next: { l: number; r: number; t: number; b: number }): void {
  const n = { ...next };
  if (n.l + n.r > 0.6) { n.l = 0; n.r = 0; }
  if (n.t + n.b > 0.7) { n.t = Math.min(n.t, 0.3); n.b = Math.min(n.b, 0.3); }
  if (Math.abs(n.l - insets.l) + Math.abs(n.r - insets.r) + Math.abs(n.t - insets.t) + Math.abs(n.b - insets.b) < 0.004) return;
  insets = n;
  refit();
}

const fitCam = new PerspectiveCamera(40, 1, 0.1, 120);
/** Distance along the pose's line of sight at which the main board fits the safe rectangle. */
function fitDistance(basePos: Vector3, lookAt: Vector3): number {
  const b = boards?.main;
  if (!b) return basePos.distanceTo(lookAt);
  const dir = basePos.clone().sub(lookAt).normalize();
  const c = BOARD_LAYOUT.main.center;
  const half = b.half + 0.6;
  const corners: Vector3[] = [];
  for (const dx of [-half, half]) for (const dz of [-half, half]) corners.push(new Vector3(c.x + dx, c.y, c.z + dz));
  const xMin = -1 + 2 * insets.l + 0.06, xMax = 1 - 2 * insets.r - 0.06;
  const yMin = -1 + 2 * insets.b + 0.06, yMax = 1 - 2 * insets.t - 0.06;
  fitCam.fov = camera.fov; fitCam.aspect = aspect; fitCam.near = camera.near; fitCam.far = camera.far;
  fitCam.updateProjectionMatrix();
  let dist = basePos.distanceTo(lookAt);
  const v = new Vector3();
  for (let i = 0; i < 12; i++) {
    fitCam.position.copy(lookAt).addScaledVector(dir, dist);
    fitCam.lookAt(lookAt);
    fitCam.updateMatrixWorld();
    let over = 0;
    for (const p of corners) {
      v.copy(p).project(fitCam);
      over = Math.max(over, xMin - v.x, v.x - xMax, yMin - v.y, v.y - yMax);
    }
    if (over <= 0) break;
    dist *= 1 + Math.min(0.5, over * 0.6 + 0.02);
  }
  return dist;
}
export function setView(name: string, instant = false): void {
  const pose = CAMERA_POSES[name] || CAMERA_POSES.battle!;
  viewName = name;
  const basePos = new Vector3().fromArray(pose.pos);
  const lookAt = new Vector3().fromArray(pose.look);
  const dir = basePos.clone().sub(lookAt).normalize();
  camTarget.pos.copy(lookAt).addScaledVector(dir, fitDistance(basePos, lookAt));
  camTarget.look.copy(lookAt);
  if (instant || reducedMotion) {
    camera.position.copy(camTarget.pos);
    camLook.copy(camTarget.look);
    camBase = { pos: camTarget.pos.clone(), look: camTarget.look.clone() };
    camVel.pos.set(0, 0, 0);
    camVel.look.set(0, 0, 0);
  }
}
/** Re-fit the current view (HUD or viewport changed). */
export function refit(): void { setView(viewName, false); }
export function resetCamera(): void { orbit.x = 0; orbit.y = 0; topDown = false; refit(); }
export function toggleTopDown(): boolean { topDown = !topDown; orbit.x = 0; orbit.y = 0; return topDown; }
export function isTopDown(): boolean { return topDown; }
/** The orbit gesture (a drag of the table): window-pixel deltas over logical scale. */
export function orbitBy(dx: number, dy: number): void {
  if (reducedMotion) return;
  orbit.x = clamp(orbit.x - dx * 0.002, -0.35, 0.35);
  orbit.y = clamp(orbit.y + dy * 0.002, -0.2, 0.25);
}
const _sph = new Spherical();
function updateCamera(dt: number): void {
  // critically damped springs on the BASE pose; orbit and shake are applied on top each frame
  if (!camBase) camBase = { pos: camera.position.clone(), look: camLook.clone() };
  const k = 42, c = 2 * Math.sqrt(k);
  for (const [cur, vel, tgt] of [[camBase.pos, camVel.pos, camTarget.pos], [camBase.look, camVel.look, camTarget.look]] as [Vector3, Vector3, Vector3][]) {
    vel.x += (k * (tgt.x - cur.x) - c * vel.x) * dt;
    vel.y += (k * (tgt.y - cur.y) - c * vel.y) * dt;
    vel.z += (k * (tgt.z - cur.z) - c * vel.z) * dt;
    cur.x += vel.x * dt; cur.y += vel.y * dt; cur.z += vel.z * dt;
  }
  const lookAt = camBase.look.clone();
  camLook.copy(lookAt);
  camera.position.copy(camBase.pos);
  if (orbit.x || orbit.y) {
    const off = camera.position.clone().sub(lookAt);
    _sph.setFromVector3(off);
    _sph.theta += orbit.x;
    _sph.phi = clamp(_sph.phi + orbit.y, 0.2, 1.05);
    camera.position.copy(lookAt).add(new Vector3().setFromSpherical(_sph));
  }
  if (topDown) {
    const d = camera.position.distanceTo(lookAt);
    camera.position.set(lookAt.x, lookAt.y + d, lookAt.z + 0.01);
  }
  if (shake > 0 && !reducedMotion) {
    const s = shake * 0.06;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    shake = Math.max(0, shake - dt * 3);
  }
  camera.lookAt(lookAt);
}

// ------------------------------------------------------------------ cosmetic event playback
interface Job { t: number; done: boolean; update(dt: number): boolean; settle(): void }
let jobs: Job[] = [];
const projGeo = new SphereGeometry(0.11, 10, 10);
/** Queue cosmetic animations for rule events; returns the total duration (ms). */
export function playEvents(events: Any[], mode: "placement" | "battle" = "battle"): number {
  let delay = 0;
  const fast = reducedMotion;
  for (const ev of events) {
    if (ev.type === "shot") {
      const boardId = mode === "placement" ? "main" : (ev.targetId === viewerId ? "side" : "main");
      const dest = cellWorldPos(boardId, ev.cell);
      jobs.push(makeShotJob(dest, ev.result, delay));
      delay += fast ? 60 : (ev.result === "miss" ? 420 : 620);
    } else if (ev.type === "finish") {
      delay += fast ? 0 : 500;
    }
  }
  return delay;
}
function makeShotJob(dest: Vector3, result: string, delayMs: number): Job {
  const start = dest.clone().add(new Vector3(2.5, 6.5, 5.5));
  const proj = new Mesh(projGeo, new MeshBasicMaterial({ color: new Color(0xaefcff).multiplyScalar(2.2) }));
  proj.userData.sharedGeo = true;
  proj.visible = false;
  proj.noAO = true;
  scene.add(proj);
  const dur = reducedMotion ? 0.12 : 0.55;
  const p = new Vector3();
  return {
    t: -delayMs / 1000,
    done: false,
    update(dt: number): boolean {
      this.t += dt;
      if (this.t < 0) return false;
      const k = Math.min(this.t / dur, 1);
      proj.visible = true;
      p.copy(start).lerp(dest, k);
      p.y += Math.sin(k * PI) * 2.2;
      proj.position.copy(p);
      if (k >= 1) {
        removeMesh(proj);
        const color = result === "miss" ? MISS_COLOR : result === "mine" ? MINE_COLOR : HIT_COLOR;
        const count = result === "miss" ? 26 : result === "mine" ? 70 : result === "sunk" ? 90 : 55;
        emit(dest, { count: Math.min(count, 90), color, speed: result === "miss" ? 1.4 : 3.0, up: result === "miss" ? 2.2 : 3.4 });
        if (look?.particles === "high" && !reducedMotion) {
          // hot sparks and slow embers (hits) or fine spray (misses)
          if (result === "miss") emit(dest, { count: 30, color: 0xeaf6ff, speed: 0.9, up: 3.6, size: 1.2, life: 1.0, spread: 0.25 });
          else {
            emit(dest, { count: 40, color: 0xffd08a, speed: 4.2, up: 4.0, size: 1.1, life: 0.55, spread: 0.2 });
            emit(dest, { count: 24, color: 0xff5a1e, speed: 0.8, up: 1.4, size: 3.2, life: 1.6, spread: 0.5 });
          }
        }
        addRipple(dest, result === "miss" ? 0.5 : 1.0);
        if (result !== "miss") shake = result === "sunk" || result === "mine" ? 1.0 : 0.55;
        this.done = true;
      }
      return this.done;
    },
    settle(): void { if (!this.done) removeMesh(proj); this.done = true; },
  };
}
function addRipple(pos: Vector3, strength: number): void {
  rippleCursor = (rippleCursor + 1) % 8;
  ripples[rippleCursor]!.set(pos.x, pos.z, time, strength);
}
/** Skip / fast-forward: settle every cosmetic job into its end state. */
export function skip(): void {
  for (const j of jobs) j.settle();
  jobs = [];
  for (const p of pools) p.settle();
  shake = 0;
}
export function jobsPending(): boolean { return jobs.length > 0; }

// ------------------------------------------------------------------ the frame
/** Per frame: the camera's aspect from the window, ambient motion, jobs, particles and the camera. */
export function update(dtRaw: number, width: number, height: number, paused: boolean): void {
  if (!look) return;
  const dt = Math.min(0.1, Math.max(0, dtRaw || 0));
  if (width > 0 && height > 0) {
    const a = width / height;
    if (Math.abs(a - aspect) > 1e-4) { aspect = a; camera.aspect = a; camera.updateProjectionMatrix(); refit(); }
  }
  if (paused) { updateCamera(0); return; }
  time += dt;
  waterUniforms.uTime.value = time;
  if (jobs.length) jobs = jobs.filter((j) => !j.update(dt));
  if (ambient) animateAmbient();
  for (const p of pools) p.update(dt);
  updateCamera(dt);
}
export function currentTheme(): SceneTheme | null { return themeScene; }
export function isReduced(): boolean { return reducedMotion; }
