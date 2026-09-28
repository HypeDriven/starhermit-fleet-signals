/**
 * Fleet Signals render layer — Three.js holographic chart table over a
 * stylized procedural sea. Consumes immutable rules snapshots; never
 * mutates game state. Cosmetic jobs are interruption-safe: skip() settles
 * every animation into its deterministic end state and the UI always
 * re-syncs board contents from the authoritative snapshot afterwards.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectPreset, resolve, describe, SHADOW_MAP, SEA_SEGMENTS, PARTICLE_CAP } from './gfx.js';
import { makeRng } from '../rules/rng.js';
import { cellToXY, cellName } from '../rules/engine.js';

/* ------------------------------------------------------------------ */
/* post-processing: colour grade + vignette (display space in and out)  */
/* ------------------------------------------------------------------ */

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // Gentle S-curve, a touch more saturation, cool shadows / warm highlights.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 0.99, 1.06), vec3(1.04, 1.0, 0.95), smoothstep(0.25, 0.85, l));
      s = s * 0.975 + 0.018; // keep the night sea's blacks legible
      c = mix(c, s, uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

/** Standard material with the scene-wide image-based-lighting strength. */
function envify(mat, k = 1) {
  mat.envMapIntensity = 0.32 * k;
  return mat;
}

/** Engraved chart for the table top: range rings, bearing ticks, compass rose. */
function makeChartTexture() {
  const doc = globalThis.document;
  if (!doc) return null;
  const N = 1024;
  const c = doc.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#000';
  g.fillRect(0, 0, N, N);
  const cx = N / 2, R = N / 2 - 4;
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 2;
  for (let i = 1; i <= 5; i++) {
    g.globalAlpha = i === 5 ? 0.9 : 0.35;
    g.beginPath(); g.arc(cx, cx, R * (i / 5) - 6, 0, Math.PI * 2); g.stroke();
  }
  g.globalAlpha = 1;
  for (let d = 0; d < 360; d += 2) {
    const a = (d * Math.PI) / 180;
    const len = d % 30 === 0 ? 34 : d % 10 === 0 ? 20 : 9;
    g.globalAlpha = d % 30 === 0 ? 0.95 : 0.55;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (R - 8), cx + Math.sin(a) * (R - 8));
    g.lineTo(cx + Math.cos(a) * (R - 8 - len), cx + Math.sin(a) * (R - 8 - len));
    g.stroke();
  }
  // compass rose spokes
  g.globalAlpha = 0.22;
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    g.beginPath(); g.moveTo(cx, cx);
    g.lineTo(cx + Math.cos(a) * (R - 50), cx + Math.sin(a) * (R - 50));
    g.stroke();
  }
  g.globalAlpha = 0.9;
  g.fillStyle = '#fff';
  g.font = 'bold 34px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  [['N', -Math.PI / 2], ['E', 0], ['S', Math.PI / 2], ['W', Math.PI]].forEach(([t, a]) => {
    g.fillText(t, cx + Math.cos(a) * (R - 66), cx + Math.sin(a) * (R - 66));
  });
  // faint survey speckle so the glass never reads as a flat fill
  const rng = makeRng('fleet-signals:chart-speckle');
  g.globalAlpha = 0.12;
  for (let i = 0; i < 2600; i++) {
    const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * (R - 10);
    g.fillRect(cx + Math.cos(a) * r, cx + Math.sin(a) * r, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Brushed-metal streaks for the pedestal (roughness + bump). */
function makeBrushedTexture() {
  const doc = globalThis.document;
  if (!doc) return null;
  const c = doc.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#8a8a8a';
  g.fillRect(0, 0, 512, 128);
  const rng = makeRng('fleet-signals:brushed');
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(90 + rng.next() * 110);
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(rng.next() * 512, rng.next() * 128, 30 + rng.next() * 160, 1);
  }
  // panel seams
  g.fillStyle = 'rgba(20,20,20,0.9)';
  for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 2, 128);
  g.fillRect(0, 40, 512, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  return tex;
}

/* ------------------------------------------------------------------ */
/* camera poses (authored framing constants, no magic per-frame lerp)  */
/* ------------------------------------------------------------------ */

const CAMERA_POSES = {
  title:     { pos: [0, 7.5, 10.5],  look: [0, 0, -0.5] },
  placement: { pos: [0, 8.8, 5.2],   look: [0, 0, -0.6] },
  battle:    { pos: [0.6, 9.0, 7.2], look: [-0.9, 0, -0.9] },
  results:   { pos: [0, 10.5, 9.0],  look: [0, 0, -0.5] },
};

const BOARD_LAYOUT = {
  main: { center: new THREE.Vector3(0, 0.12, -1.6), scale: 1.0 },   // target in battle / editor in placement
  side: { center: new THREE.Vector3(-5.6, 0.12, 2.6), scale: 0.5 }, // own fleet in battle
};

const HIT_COLOR = 0xff7a3c;
const MISS_COLOR = 0xcfe8ff;
const MINE_COLOR = 0xc26bff;
const VALID_COLOR = 0x6ff2c8;
const INVALID_COLOR = 0xff5468;

/* ------------------------------------------------------------------ */
/* procedural ship hull geometry (authored, inspectable)               */
/* ------------------------------------------------------------------ */

function buildHullGeometry(size, detailed = false) {
  if (detailed) return buildDetailedHull(size);
  // A low-poly stylized hull: tapered bow, flat stern, deck and bridge.
  const L = size * 0.86;        // length in cells
  const W = 0.52;               // beam
  const H = 0.34;               // hull depth
  const shape = new THREE.Shape();
  // top-down outline: pointed bow at +L/2
  shape.moveTo(-L / 2, -W / 2);
  shape.lineTo(L / 2 - W * 0.9, -W / 2);
  shape.lineTo(L / 2, 0);
  shape.lineTo(L / 2 - W * 0.9, W / 2);
  shape.lineTo(-L / 2, W / 2);
  shape.lineTo(-L / 2, -W / 2);
  const hull = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false });
  hull.rotateX(-Math.PI / 2); // lay flat: shape XY -> XZ plane, extrude becomes height
  hull.translate(0, H, 0);

  const parts = [hull];
  // deck strip
  const deck = new THREE.BoxGeometry(L * 0.82, H * 0.35, W * 0.8);
  deck.translate(-L * 0.04, H + H * 0.17, 0);
  parts.push(deck);
  // bridge tower (position scales with size class)
  if (size >= 3) {
    const tower = new THREE.BoxGeometry(W * 0.7, H * 1.15, W * 0.62);
    tower.translate(-L * 0.16, H + H * 0.75, 0);
    parts.push(tower);
    const mast = new THREE.CylinderGeometry(0.02, 0.03, H * 1.3, 6);
    mast.translate(-L * 0.16, H + H * 1.7, 0);
    parts.push(mast);
  }
  return mergeGeometries(parts);
}

// Vertex colours for the detailed hull (multiplied by a white material).
const HULL_TONES = {
  hull: 0x8a97a8, deck: 0x5f6b79, house: 0xc5ced8, gun: 0x9ba7b6, dark: 0x343d48, glass: 0x7fd8ee,
};

/**
 * Detailed hull: bevelled plan with the same footprint and height band as
 * the plain hull, plus a deck, superstructure, turrets and mast so each
 * size class reads as a distinct vessel. Carriers get a flight deck and an
 * offset island.
 */
function buildDetailedHull(size) {
  const L = size * 0.86;
  const W = 0.52;
  const H = 0.34;
  const b = 0.035;
  const shape = new THREE.Shape();
  const l = L / 2 - b, w = W / 2 - b;
  shape.moveTo(-l, -w * 0.86);
  shape.quadraticCurveTo(-l, -w, -l + 0.06, -w);
  shape.lineTo(l - W * 0.95, -w);
  shape.quadraticCurveTo(l - W * 0.3, -w * 0.8, l, 0);
  shape.quadraticCurveTo(l - W * 0.3, w * 0.8, l - W * 0.95, w);
  shape.lineTo(-l + 0.06, w);
  shape.quadraticCurveTo(-l, w, -l, w * 0.86);
  shape.lineTo(-l, -w * 0.86);
  const hull = new THREE.ExtrudeGeometry(shape, {
    depth: H - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 6,
  });
  hull.rotateX(-Math.PI / 2);
  hull.translate(0, H + b, 0);
  const top = 2 * H;
  const parts = [{ g: hull, c: HULL_TONES.hull }];
  const box = (sx, sy, sz, x, y, z, c) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y + sy / 2, z);
    parts.push({ g, c });
  };
  const cyl = (r, h, x, y, z, c, seg = 10) => {
    const g = new THREE.CylinderGeometry(r, r, h, seg);
    g.translate(x, y + h / 2, z);
    parts.push({ g, c });
  };
  const turret = (x, dir) => {
    cyl(0.1, 0.06, x, top, 0, HULL_TONES.gun);
    box(0.2, 0.03, 0.028, x + dir * 0.13, top + 0.025, 0.035, HULL_TONES.dark);
    box(0.2, 0.03, 0.028, x + dir * 0.13, top + 0.025, -0.035, HULL_TONES.dark);
  };
  if (size >= 5) {
    // carrier: full-length flight deck with an island on the starboard side
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
  return mergeGeometries(parts.map((p) => p.g), parts.map((p) => p.c));
}

/** Minimal BufferGeometry merge (positions/normals/uvs/colours, non-indexed). */
function mergeGeometries(geos, tones = null) {
  const nonIndexed = geos.map((g) => g.index ? g.toNonIndexed() : g);
  const pos = [], norm = [], uv = [], col = [];
  const c = new THREE.Color();
  nonIndexed.forEach((g, gi) => {
    pos.push(...g.attributes.position.array);
    norm.push(...g.attributes.normal.array);
    if (g.attributes.uv) uv.push(...g.attributes.uv.array);
    else uv.push(...new Array((g.attributes.position.count) * 2).fill(0));
    c.set(tones ? tones[gi] : 0xffffff);
    for (let i = 0; i < g.attributes.position.count; i++) col.push(c.r, c.g, c.b);
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

/* ------------------------------------------------------------------ */
/* water shader — shared wave field, bounded ripples                   */
/* ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */`
#include <fog_pars_vertex>
uniform float uTime;
uniform vec4 uRipples[8]; // x, z, startTime, strength
varying vec3 vNormalW;
varying vec3 vPosW;

float waveH(vec2 p, float t) {
  float h = 0.0;
  h += sin(p.x * 0.32 + t * 0.9) * 0.16;
  h += sin(p.y * 0.24 - t * 0.7) * 0.13;
  h += sin((p.x + p.y) * 0.14 + t * 0.45) * 0.20;
  for (int i = 0; i < 8; i++) {
    vec4 r = uRipples[i];
    float age = t - r.z;
    if (r.w > 0.001 && age > 0.0 && age < 4.0) {
      float d = distance(p, r.xy);
      float ring = sin(d * 3.5 - age * 6.0) * exp(-d * 0.35) * exp(-age * 1.4);
      h += ring * r.w * 0.35;
    }
  }
  return h;
}

void main() {
  vec3 pos = position;
  vec2 p = pos.xz;
  float t = uTime;
  float h = waveH(p, t);
  float e = 0.35;
  float hx = waveH(p + vec2(e, 0.0), t) - h;
  float hz = waveH(p + vec2(0.0, e), t) - h;
  pos.y += h;
  vNormalW = normalize(vec3(-hx / e, 1.0, -hz / e));
  vPosW = (modelMatrix * vec4(pos, 1.0)).xyz;
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

// Detailed water adds a two-layer chop to the normal (glitter under the key
// light), a broad moon sheen and the holo table's cyan glow on the swell.
const WATER_FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uGlow;
uniform float uTime;
uniform float uDetail;
varying vec3 vNormalW;
varying vec3 vPosW;

void main() {
  vec3 n = normalize(vNormalW);
  vec3 viewDir = normalize(cameraPosition - vPosW);
  float dist = length(cameraPosition - vPosW);
  if (uDetail > 0.5) {
    vec2 p = vPosW.xz;
    float t = uTime;
    float fade = exp(-dist * 0.035);
    float nx = cos(p.x * 2.3 + t * 1.6 + sin(p.y * 0.9)) + 0.6 * cos((p.x - p.y) * 3.7 + t * 2.4);
    float nz = cos(p.y * 2.9 - t * 1.3 + sin(p.x * 1.2)) - 0.6 * cos((p.x - p.y) * 3.7 + t * 2.4);
    n = normalize(n + vec3(nx, 0.0, nz) * 0.09 * fade);
  }
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.2);
  float depthMix = clamp(0.35 + vPosW.y * 0.8, 0.0, 1.0);
  vec3 base = mix(uDeep, uShallow, depthMix);
  vec3 col = mix(base, uSky, fresnel * 0.65);
  // sun / moon glints
  vec3 halfV = normalize(uSunDir + viewDir);
  float nh = max(dot(n, halfV), 0.0);
  col += uSunColor * pow(nh, 220.0) * 0.9;
  if (uDetail > 0.5) {
    col += uSunColor * pow(nh, 28.0) * 0.05;
    float r = length(vPosW.xz - vec2(0.0, -0.5));
    col += uGlow * exp(-r * 0.22) * (0.10 + 0.08 * max(n.x + n.z, 0.0));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/* ------------------------------------------------------------------ */
/* particle pool (bounded, additive, deterministic-free cosmetics)     */
/* ------------------------------------------------------------------ */

class ParticlePool {
  constructor(max) {
    this.max = max;
    this.positions = new Float32Array(max * 3);
    this.velocities = new Float32Array(max * 3);
    this.life = new Float32Array(max);      // remaining
    this.span = new Float32Array(max);      // total
    this.colors = new Float32Array(max * 3);
    this.sizes = new Float32Array(max);
    this.head = 0;
    this.active = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float psize;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * (180.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float a = smoothstep(0.5, 0.05, length(d));
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.raycast = () => {}; // cosmetics never intercept picking
    this.color = new THREE.Color();
  }

  emit(origin, { count, color, speed = 2.2, up = 2.6, size = 2.2, life = 0.8, spread = 0.4 }) {
    this.color.set(color);
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % this.max;
      const i3 = i * 3;
      this.positions[i3] = origin.x + (Math.random() - 0.5) * spread;
      this.positions[i3 + 1] = origin.y;
      this.positions[i3 + 2] = origin.z + (Math.random() - 0.5) * spread;
      const ang = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.velocities[i3] = Math.cos(ang) * v;
      this.velocities[i3 + 1] = up * (0.5 + Math.random() * 0.8);
      this.velocities[i3 + 2] = Math.sin(ang) * v;
      this.life[i] = this.span[i] = life * (0.6 + Math.random() * 0.6);
      this.colors[i3] = this.color.r;
      this.colors[i3 + 1] = this.color.g;
      this.colors[i3 + 2] = this.color.b;
      this.sizes[i] = size * (0.7 + Math.random() * 0.6);
    }
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.sizes[i] = 0; continue; }
      any = true;
      this.life[i] -= dt;
      const i3 = i * 3;
      this.velocities[i3 + 1] -= 6.5 * dt; // gravity
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;
      const k = Math.max(this.life[i] / this.span[i], 0);
      this.sizes[i] = this.sizes[i] * (0.85 + 0.15 * k);
      if (this.life[i] <= 0) this.sizes[i] = 0;
    }
    if (any) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.psize.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }

  settle() {
    this.life.fill(0);
    this.sizes.fill(0);
    this.points.geometry.attributes.psize.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* board builder                                                       */
/* ------------------------------------------------------------------ */

function buildGridBoard(gridSize, holoColor) {
  const group = new THREE.Group();
  const cell = 1.0;
  const span = gridSize * cell;
  const half = span / 2;

  // base plate — translucent hologram slab
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(span + 0.5, 0.06, span + 0.5),
    new THREE.MeshStandardMaterial({
      color: holoColor, transparent: true, opacity: 0.12,
      roughness: 0.35, metalness: 0.0, emissive: holoColor, emissiveIntensity: 0.18,
      depthWrite: false,
    }),
  );
  envify(plate.material, 0.5);
  plate.receiveShadow = true;
  plate.position.y = -0.03;
  group.add(plate);

  // grid lines — instanced thin bars
  const lineMat = new THREE.MeshStandardMaterial({
    color: holoColor, emissive: holoColor, emissiveIntensity: 0.9,
    transparent: true, opacity: 0.55, roughness: 0.4,
  });
  const lineGeo = new THREE.BoxGeometry(0.025, 0.02, span);
  const lines = new THREE.InstancedMesh(lineGeo, lineMat, (gridSize + 1) * 2);
  const m = new THREE.Matrix4();
  let li = 0;
  for (let i = 0; i <= gridSize; i++) {
    m.makeTranslation(-half + i * cell, 0, 0);
    lines.setMatrixAt(li++, m);
    m.makeRotationY(Math.PI / 2).setPosition(0, 0, -half + i * cell);
    lines.setMatrixAt(li++, m);
  }
  lines.instanceMatrix.needsUpdate = true;
  group.add(lines);

  // invisible pick plane (explicit interaction layer)
  const pick = new THREE.Mesh(
    new THREE.PlaneGeometry(span, span),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  pick.rotation.x = -Math.PI / 2;
  pick.position.y = 0.02;
  group.add(pick);

  // marker holder + selection ghost
  const markers = new THREE.Group();
  group.add(markers);

  const ghost = new THREE.Mesh(
    new THREE.PlaneGeometry(cell * 0.9, cell * 0.9),
    new THREE.MeshBasicMaterial({
      color: VALID_COLOR, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  ghost.rotation.x = -Math.PI / 2;
  ghost.position.y = 0.06;
  ghost.visible = false;
  group.add(ghost);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(cell * 0.42, cell * 0.5, 32),
    new THREE.MeshBasicMaterial({
      color: VALID_COLOR, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.visible = false;
  group.add(ring);

  return { group, plate, lines, pick, markers, ghost, ring, gridSize, cell, half };
}

/* ------------------------------------------------------------------ */
/* main scene class                                                    */
/* ------------------------------------------------------------------ */

export class FleetScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { theme, graphics, reducedMotion, visualSeed }
   *   graphics: saved Graphics settings (see gfx.js `resolve`); {} = Auto.
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.reducedMotion = !!opts.reducedMotion;
    this.visualSeed = opts.visualSeed || 'fleet-signals';
    this.running = false;
    this.disposed = false;
    this.time = 0;
    this.jobs = [];            // cosmetic animation jobs
    this.ripples = [];         // pending water ripples
    this.shake = 0;
    this.orbitOffset = { x: 0, y: 0 };
    this.viewerId = null;
    this.q = null;             // resolved graphics settings
    this.size = [0, 0];
    this.pixelRatio = 1;
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this.wreckMats = [];

    // callbacks assigned by UI
    this.onCellHover = null; // (boardId, cell|null)
    this.onCellPick = null;  // (boardId, cell)
    this.onCameraGesture = null;

    this._initRenderer();
    this._detectGpu();
    this._initScene();
    this._initCamera();
    this._initEnvironment();
    this._initPointer();
    this.setTheme(opts.theme || null);

    this.boards = null; // { main, side }
    this.ownShipMeshes = [];
    this.enemyShipMeshes = new Map(); // shipId -> mesh
    this.previewMeshes = [];

    this.setGraphics(opts.graphics || {}, true);

    this._boundResize = () => this.resize();
    globalThis.addEventListener?.('resize', this._boundResize);
  }

  /* ---------------- setup ---------------- */

  _initRenderer() {
    // Canvas MSAA stays off: anti-aliasing comes from the post chain
    // (FXAA / SMAA / multisampled target), so Low costs what it always did.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (this._contextHandlers) return;
    this._contextHandlers = true;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.running = false;
      this.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._initRenderer();
      this.composer = null;
      this._envTex = null;
      this.setGraphics(this.gfxSaved, true);
      this.running = true;
    });
  }

  _detectGpu() {
    let gpu = '';
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { gpu = ''; }
    this.gpu = String(gpu || '') || 'unknown GPU';
    const nav = globalThis.navigator || {};
    const mm = (q) => { try { return globalThis.matchMedia?.(q).matches; } catch { return false; } };
    const mobile = /Mobi|Android|iPhone|iPad/i.test(nav.userAgent || '')
      || (mm('(pointer: coarse)') && !mm('(any-pointer: fine)'));
    this.detected = detectPreset(gpu, { mobile });
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a1626, 26, 60);
  }

  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
    const pose = CAMERA_POSES.title;
    this.camera.position.fromArray(pose.pos);
    this.camLook = new THREE.Vector3().fromArray(pose.look);
    this.camTarget = {
      pos: new THREE.Vector3().fromArray(pose.pos),
      look: new THREE.Vector3().fromArray(pose.look),
    };
    this.camVel = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this.camera.lookAt(this.camLook);
  }

  _initEnvironment() {
    // lighting: one dominant key + soft fill
    this.keyLight = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.keyLight.position.set(8, 12, 6);
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);
    this.fillLight = new THREE.HemisphereLight(0x8fb7d9, 0x1a2433, 1.05);
    this.scene.add(this.fillLight);

    // sea (mesh density follows the `water` setting, built in setGraphics)
    this.waterUniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -10, 0)) },
      uDeep: { value: new THREE.Color(0x06283d) },
      uShallow: { value: new THREE.Color(0x1a5d7a) },
      uSky: { value: new THREE.Color(0x9fc6e0) },
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.4).normalize() },
      uSunColor: { value: new THREE.Color(0xffe9c4) },
      uGlow: { value: new THREE.Color(0x59e6ff) },
      uDetail: { value: 0 },
    };
    this.waterMaterial = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: this.waterUniforms, fog: true,
    });
    this.water = null;

    // captain's chart table: pedestal + rim + holo surface
    this.table = new THREE.Group();
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(5.4, 6.2, 1.6, 64),
      envify(new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.55, metalness: 0.75 })),
    );
    pedestal.position.y = -0.85;
    pedestal.receiveShadow = true;
    this.table.add(pedestal);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(5.45, 0.09, 16, 96),
      envify(new THREE.MeshStandardMaterial({
        color: 0x59e6ff, emissive: 0x59e6ff, emissiveIntensity: 0.8, roughness: 0.3, metalness: 0.2,
      }), 0.5),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.02;
    this.table.add(rim);
    const surface = new THREE.Mesh(
      new THREE.CylinderGeometry(5.4, 5.4, 0.08, 64),
      envify(new THREE.MeshStandardMaterial({
        color: 0x0d2438, roughness: 0.25, metalness: 0.4,
        emissive: 0x0d2c44, emissiveIntensity: 0.5, transparent: true, opacity: 0.92,
      }), 0.3),
    );
    surface.position.y = -0.04;
    surface.receiveShadow = true;
    this.table.add(surface);
    // engraved chart (range rings, bearing ticks) — `detail` setting
    this.engraving = new THREE.Mesh(
      new THREE.CircleGeometry(5.36, 96),
      new THREE.MeshBasicMaterial({
        color: 0x63e2f2, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.engraving.rotation.x = -Math.PI / 2;
    this.engraving.position.y = 0.004;
    this.engraving.visible = false;
    this.engraving.raycast = () => {};
    this.table.add(this.engraving);
    // sonar sweep across the chart — `background` setting, off with reduced motion
    this.sweepUniforms = { uAngle: { value: 0 }, uColor: { value: new THREE.Color(0x63e2f2) }, uAlpha: { value: 0.16 } };
    this.sweep = new THREE.Mesh(
      new THREE.CircleGeometry(5.36, 96),
      new THREE.ShaderMaterial({
        uniforms: this.sweepUniforms,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
          uniform float uAngle; uniform vec3 uColor; uniform float uAlpha;
          varying vec2 vUv;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p);
            float d = mod(uAngle - atan(p.y, p.x), 6.2831853);
            float wedge = exp(-d * 2.6) * smoothstep(1.0, 0.85, r) * smoothstep(0.0, 0.08, r);
            float edge = smoothstep(0.05, 0.0, d) * 0.8;
            gl_FragColor = vec4(uColor, (wedge + edge * smoothstep(1.0, 0.9, r)) * uAlpha);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.sweep.rotation.x = -Math.PI / 2;
    this.sweep.position.y = 0.008;
    this.sweep.visible = false;
    this.sweep.raycast = () => {};
    this.table.add(this.sweep);
    this.pedestal = pedestal;
    this.rim = rim;
    this.surface = surface;
    this.scene.add(this.table);

    // decoration from the deterministic visual stream
    const vrng = makeRng(this.visualSeed + ':decor');
    const buoyGeo = new THREE.ConeGeometry(0.3, 0.9, 8);
    const buoyMat = envify(new THREE.MeshStandardMaterial({ color: 0xb03a4a, roughness: 0.6 }));
    const buoys = new THREE.InstancedMesh(buoyGeo, buoyMat, 10);
    const lamps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x220608, emissive: 0xff4a5a, emissiveIntensity: 2.4 }),
      10,
    );
    const bm = new THREE.Matrix4();
    this.buoySpots = [];
    for (let i = 0; i < 10; i++) {
      const ang = vrng.next() * Math.PI * 2;
      const r = 16 + vrng.next() * 20;
      const spot = { x: Math.cos(ang) * r, z: Math.sin(ang) * r, phase: vrng.next() * Math.PI * 2 };
      this.buoySpots.push(spot);
      bm.makeTranslation(spot.x, -1.6, spot.z);
      buoys.setMatrixAt(i, bm);
      bm.makeTranslation(spot.x, -1.1, spot.z);
      lamps.setMatrixAt(i, bm);
    }
    buoys.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    buoys.raycast = () => {};
    lamps.raycast = () => {};
    this.buoys = buoys;
    this.lamps = lamps;
    this.scene.add(buoys);
    this.scene.add(lamps);

    // stars / sky dust
    const starCount = 400;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const ang = vrng.next() * Math.PI * 2;
      const el = 0.15 + vrng.next() * 1.2;
      const r = 70;
      starPos[i * 3] = Math.cos(ang) * Math.cos(el) * r;
      starPos[i * 3 + 1] = Math.sin(el) * r * 0.6;
      starPos[i * 3 + 2] = Math.sin(ang) * Math.cos(el) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xbfd9ff, size: 0.25, sizeAttenuation: true, transparent: true, opacity: 0.7,
    }));
    this.stars.raycast = () => {};
    this.scene.add(this.stars);

    // particle pool (capacity follows the `particles` setting, built in setGraphics)
    this.particles = null;
  }

  _buildWater() {
    const seg = SEA_SEGMENTS[this.q.water] || SEA_SEGMENTS.simple;
    const geo = new THREE.PlaneGeometry(140, 140, seg, seg);
    if (this.water) {
      this.water.geometry.dispose();
      this.water.geometry = geo;
      return;
    }
    this.water = new THREE.Mesh(geo, this.waterMaterial);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -2.2;
    this.water.raycast = () => {};
    this.scene.add(this.water);
  }

  _buildParticles() {
    if (this.particles) {
      this.scene.remove(this.particles.points);
      this.particles.points.geometry.dispose();
      this.particles.points.material.dispose();
    }
    this.particles = new ParticlePool(PARTICLE_CAP[this.q.particles] || PARTICLE_CAP.low);
    this.scene.add(this.particles.points);
  }

  /* ---------------- theme / settings ---------------- */

  setTheme(theme) {
    if (!theme || !theme.scene) return;
    const s = theme.scene;
    const set = (uniform, hex) => uniform.value.set(hex);
    set(this.waterUniforms.uDeep, s.waterDeep);
    set(this.waterUniforms.uShallow, s.waterShallow);
    set(this.waterUniforms.uSky, s.sky);
    set(this.waterUniforms.uSunColor, s.sun);
    set(this.waterUniforms.uGlow, s.holoShip);
    this.scene.fog.color.set(s.fog);
    this.scene.background = new THREE.Color(s.fog);
    this.fillLight.color.set(s.sky);
    this.keyLight.color.set(s.sun);
    this.holoColor = new THREE.Color(s.holoGrid);
    this.holoShipColor = new THREE.Color(s.holoShip);
    if (this.boards) {
      for (const b of [this.boards.main, this.boards.side]) {
        b.plate.material.color.set(s.holoGrid);
        b.plate.material.emissive.set(s.holoGrid);
        b.group.children.forEach((c) => {
          if (c.isInstancedMesh) { c.material.color.set(s.holoGrid); c.material.emissive.set(s.holoGrid); }
        });
      }
    }
    this.rim.material.color.set(s.holoGrid);
    this.rim.material.emissive.set(s.holoShip);
    this.engraving.material.color.set(s.holoShip);
    this.sweepUniforms.uColor.value.set(s.holoShip);
  }

  /**
   * Apply saved Graphics settings live (no reload). `saved` is the object the
   * Settings panel stores: { preset, render_scale, adaptive, show_fps, <category> }.
   */
  setGraphics(saved, force = false) {
    const json = JSON.stringify(saved || {});
    if (!force && json === this._gfxJson) return;
    this._gfxJson = json;
    this.gfxSaved = JSON.parse(json);
    const prev = force ? {} : (this.q || {});
    const g = resolve(this.gfxSaved, this.detected);
    this.q = g;
    // shadows: enable + map size; every lit material recompiles on a toggle
    const size = SHADOW_MAP[g.shadows];
    const shadowToggle = this.renderer.shadowMap.enabled !== size > 0;
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    this._fitShadow();
    this._applyReflections();
    if (prev.water !== g.water) this._buildWater();
    this.waterUniforms.uDetail.value = g.water === 'detailed' ? 1 : 0;
    if (prev.particles !== g.particles) this._buildParticles();
    if (prev.detail !== g.detail) this._applyDetail();
    this._applyAmbient();
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    if (shadowToggle || force) {
      this.scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      });
    }
    this.canvas.dataset.gfxPreset = g.preset;
    if (globalThis.document?.body) globalThis.document.body.dataset.gfxPreset = g.preset;
    this.resize();
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu,
      detected: this.detected,
      resolved: { ...this.q },
      summary: describe(this.q, px),
      pixels: px,
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _applyReflections() {
    if (this.q.reflections === 'on') {
      if (!this._envTex) {
        try {
          const pm = new THREE.PMREMGenerator(this.renderer);
          const room = new RoomEnvironment(this.renderer);
          this._envTex = pm.fromScene(room, 0.04).texture;
          room.dispose();
          pm.dispose();
        } catch { this._envTex = null; }
      }
      this.scene.environment = this._envTex || null;
    } else {
      this.scene.environment = null;
    }
  }

  _applyDetail() {
    const detailed = this.q.detail === 'detailed';
    if (detailed && !this._chartTex) this._chartTex = makeChartTexture();
    if (detailed && !this._brushTex) this._brushTex = makeBrushedTexture();
    this.engraving.material.map = detailed ? this._chartTex : null;
    this.engraving.material.needsUpdate = true;
    this.engraving.visible = detailed && !!this._chartTex;
    const ped = this.pedestal.material;
    ped.roughnessMap = detailed ? this._brushTex : null;
    ped.bumpMap = detailed ? this._brushTex : null;
    ped.bumpScale = 0.6;
    ped.roughness = detailed ? 0.8 : 0.55;
    ped.needsUpdate = true;
    // rebuild ship meshes with the other hull set
    if (this._lastSync) {
      const draft = this._lastDraft;
      this.syncFromState(...this._lastSync);
      if (draft) this.showDraftPlacements(...draft);
    }
  }

  _applyAmbient() {
    this.ambient = !!this.q && this.q.background === 'animated' && !this.reducedMotion;
    this.sweep.visible = this.ambient;
    if (!this.ambient) {
      // settle ambient motion into its rest pose
      const m = new THREE.Matrix4();
      this.buoySpots.forEach((b, i) => {
        m.makeTranslation(b.x, -1.6, b.z); this.buoys.setMatrixAt(i, m);
        m.makeTranslation(b.x, -1.1, b.z); this.lamps.setMatrixAt(i, m);
      });
      this.buoys.instanceMatrix.needsUpdate = true;
      this.lamps.instanceMatrix.needsUpdate = true;
      this.lamps.material.emissiveIntensity = 2.4;
      this._setGridGlow(0.9);
      for (const m2 of this.wreckMats) m2.emissiveIntensity = 0.12;
    }
  }

  _setGridGlow(k) {
    if (!this.boards) return;
    for (const b of [this.boards.main, this.boards.side]) b.lines.material.emissiveIntensity = k;
  }

  /** Gentle idle motion: buoys bob and blink, the sonar sweeps, grids breathe, wrecks smoulder. */
  _animateAmbient() {
    const t = this.time;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    const v = new THREE.Vector3();
    this.buoySpots.forEach((b, i) => {
      const bob = Math.sin(t * 1.1 + b.phase) * 0.12;
      e.set(Math.sin(t * 0.9 + b.phase) * 0.08, 0, Math.cos(t * 0.7 + b.phase) * 0.08);
      q.setFromEuler(e);
      m.compose(v.set(b.x, -1.6 + bob, b.z), q, one);
      this.buoys.setMatrixAt(i, m);
      m.compose(v.set(b.x, -1.1 + bob, b.z), q, one);
      this.lamps.setMatrixAt(i, m);
    });
    this.buoys.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
    this.lamps.material.emissiveIntensity = (t % 2.4) < 0.5 ? 3.2 : 0.5;
    this.sweepUniforms.uAngle.value = (t * 0.55) % (Math.PI * 2);
    this._setGridGlow(0.9 + Math.sin(t * 1.3) * 0.12);
    for (const w of this.wreckMats) w.emissiveIntensity = 0.14 + 0.1 * Math.max(0, Math.sin(t * 5.3 + w.id) * Math.sin(t * 2.1));
  }

  /** Fit the key light's shadow box to the table and both boards. */
  _fitShadow() {
    const cam = this.keyLight.shadow.camera;
    cam.position.copy(this.keyLight.position);
    cam.lookAt(this.keyLight.target.position);
    cam.updateMatrixWorld();
    const pts = [];
    const add = (x, z) => { pts.push(new THREE.Vector3(x, -1.7, z), new THREE.Vector3(x, 1.4, z)); };
    for (const dx of [-6.3, 6.3]) for (const dz of [-6.3, 6.3]) add(dx, dz);
    if (this.boards) {
      for (const id of ['main', 'side']) {
        const b = this.boards[id];
        const h = (b.half + 0.3) * b.group.scale.x;
        const c = b.group.position;
        for (const dx of [-h, h]) for (const dz of [-h, h]) add(c.x + dx, c.z + dz);
      }
    }
    const box = new THREE.Box3();
    for (const p of pts) box.expandByPoint(p.applyMatrix4(cam.matrixWorldInverse));
    Object.assign(cam, {
      left: box.min.x - 0.3, right: box.max.x + 0.3, bottom: box.min.y - 0.3, top: box.max.y + 0.3,
      near: Math.max(0.1, -box.max.z - 1), far: -box.min.z + 1,
    });
    cam.updateProjectionMatrix();
  }

  setReducedMotion(flag) {
    this.reducedMotion = !!flag;
    if (this.reducedMotion) this.shake = 0;
    if (this.q) this._applyAmbient();
  }

  /* ---------------- post-processing / resolution ---------------- */

  _fpsVisible(on) {
    const doc = globalThis.document;
    if (!doc) return;
    let el = doc.getElementById('fps-meter');
    if (on && !el) {
      el = doc.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      doc.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey() {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, this.size[0], this.size[1], this.pixelRatio].join('|') : 'none';
  }

  _buildPost() {
    const g = this.q;
    if (this.composer) {
      for (const pass of this.composer.passes) pass.dispose?.();
      this.composer.dispose();
    }
    this.composer = null;
    if (!g.post || this.postFailed) return;
    const [w, h] = this.size;
    const pr = this.pixelRatio;
    try {
      const target = new THREE.WebGLRenderTarget(Math.max(1, w * pr), Math.max(1, h * pr), {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = g.ao === 'high' ? 0.7 : 0.55;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only emissive highlights (rim, hit spears, mines, sparks, buoy lamps) bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.4, 0.86));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(w * pr, h * pr));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly and say so in the panel.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = globalThis.document?.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, Math.round((this.adaptiveScale - 0.1) * 100) / 100);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, Math.round((this.adaptiveScale + 0.05) * 100) / 100);
    return before !== this.adaptiveScale;
  }

  _targetPixelRatio() {
    const g = this.q;
    return Math.min(globalThis.devicePixelRatio || 1, g.dpr) * g.scale * this.adaptiveScale;
  }

  /* ---------------- boards ---------------- */

  /** (Re)build both holo grids for a new match. */
  buildBoards(gridSize) {
    if (this.boards) {
      for (const b of [this.boards.main, this.boards.side]) {
        this.scene.remove(b.group);
        b.group.traverse((o) => { o.geometry?.dispose?.(); if (o.material) o.material.dispose?.(); });
      }
    }
    const color = this.holoColor || new THREE.Color(0x59e6ff);
    const main = buildGridBoard(gridSize, color);
    const side = buildGridBoard(gridSize, color);
    main.group.position.copy(BOARD_LAYOUT.main.center);
    side.group.position.copy(BOARD_LAYOUT.side.center);
    side.group.scale.setScalar(BOARD_LAYOUT.side.scale);
    this.scene.add(main.group);
    this.scene.add(side.group);
    this.boards = { main, side };
    this.clearShips();
    this.interactiveBoard = null;
    this._fitShadow();
  }

  cellWorldPos(boardId, cell, out = new THREE.Vector3()) {
    const b = this.boards?.[boardId];
    if (!b) return out.set(0, 0, 0);
    const { x, y } = cellToXY(cell, b.gridSize);
    out.set(-b.half + (x + 0.5) * b.cell, 0.1, -b.half + (y + 0.5) * b.cell);
    b.group.localToWorld(out);
    return out;
  }

  /** Project a cell to CSS pixels relative to the canvas (DOM label alignment). */
  projectCell(boardId, cell, canvasRect) {
    const v = this.cellWorldPos(boardId, cell);
    v.project(this.camera);
    const rect = canvasRect || this.canvas.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * rect.width,
      y: (-v.y * 0.5 + 0.5) * rect.height,
      visible: v.z < 1,
    };
  }

  clearShips() {
    for (const mesh of this.ownShipMeshes) { mesh.parent?.remove(mesh); mesh.geometry.dispose(); }
    this.ownShipMeshes = [];
    for (const mesh of this.enemyShipMeshes.values()) { mesh.parent?.remove(mesh); mesh.geometry.dispose(); }
    this.enemyShipMeshes.clear();
    for (const mesh of this.draftMeshes || []) { mesh.parent?.remove(mesh); mesh.geometry.dispose(); }
    this.draftMeshes = [];
    this.wreckMats = [];
    this.clearPreview();
    if (this.boards) {
      for (const b of [this.boards.main, this.boards.side]) {
        while (b.markers.children.length) {
          const c = b.markers.children[0];
          b.markers.remove(c);
          c.geometry?.dispose?.();
          c.material?.dispose?.();
        }
      }
    }
  }

  _shipMaterial(kind) {
    const detailed = this.q?.detail === 'detailed';
    if (kind === 'own') {
      if (detailed) {
        return envify(new THREE.MeshPhysicalMaterial({
          color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.7,
          clearcoat: 0.55, clearcoatRoughness: 0.28,
        }), 1.2);
      }
      return envify(new THREE.MeshStandardMaterial({ color: 0x8a97a8, roughness: 0.45, metalness: 0.85 }));
    }
    if (kind === 'wreck') {
      const m = envify(new THREE.MeshStandardMaterial({
        color: 0x3a2f2f, roughness: 0.9, metalness: 0.2,
        emissive: 0xff3300, emissiveIntensity: 0.12,
      }), 0.5);
      this.wreckMats.push(m);
      return m;
    }
    return new THREE.MeshStandardMaterial({
      color: this.holoShipColor || 0x59e6ff, transparent: true, opacity: 0.4,
      emissive: this.holoShipColor || 0x59e6ff, emissiveIntensity: 0.6, roughness: 0.4,
    });
  }

  _addShipMesh(board, ship, kind) {
    const geo = buildHullGeometry(ship.size, this.q?.detail === 'detailed');
    const mesh = new THREE.Mesh(geo, this._shipMaterial(kind));
    mesh.castShadow = kind !== 'draft';
    mesh.receiveShadow = kind === 'own';
    // orient along ship cells
    const first = cellToXY(ship.cells[0], board.gridSize);
    const last = cellToXY(ship.cells[ship.cells.length - 1], board.gridSize);
    const horizontal = first.y === last.y;
    const midX = (first.x + last.x) / 2;
    const midY = (first.y + last.y) / 2;
    mesh.position.set(-board.half + (midX + 0.5) * board.cell, 0.1, -board.half + (midY + 0.5) * board.cell);
    if (!horizontal) mesh.rotation.y = Math.PI / 2;
    board.group.add(mesh);
    return mesh;
  }

  _addMarker(board, cell, kind) {
    let mesh;
    if (kind === 'miss') {
      mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.16, 0.26, 20),
        new THREE.MeshBasicMaterial({ color: MISS_COLOR, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      mesh.rotation.x = -Math.PI / 2;
    } else if (kind === 'mine') {
      mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.24),
        envify(new THREE.MeshStandardMaterial({ color: MINE_COLOR, emissive: MINE_COLOR, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.4 })),
      );
      mesh.castShadow = true;
      mesh.position.y = 0.2;
    } else { // hit
      mesh = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.42, 4),
        envify(new THREE.MeshStandardMaterial({ color: HIT_COLOR, emissive: HIT_COLOR, emissiveIntensity: 2.0, roughness: 0.35 })),
      );
      mesh.castShadow = true;
      mesh.position.y = 0.24;
      mesh.rotation.y = Math.PI / 4;
    }
    const { x, y } = cellToXY(cell, board.gridSize);
    mesh.position.x = -board.half + (x + 0.5) * board.cell;
    mesh.position.z = -board.half + (y + 0.5) * board.cell;
    if (kind === 'miss') mesh.position.y = 0.07;
    board.markers.add(mesh);
    return mesh;
  }

  /**
   * Full resync from an authoritative snapshot (the only path that sets
   * board contents). viewerId = the seat the screen currently belongs to.
   * mode: 'placement' renders own fleet on main; 'battle' puts the target
   * grid on main and own fleet on side.
   */
  syncFromState(state, viewerId, mode) {
    if (!this.boards || this.boards.main.gridSize !== state.gridSize) this.buildBoards(state.gridSize);
    this._lastSync = [state, viewerId, mode];
    this._lastDraft = null;
    this.clearShips();
    this.viewerId = viewerId;
    const me = state.players.find((p) => p.id === viewerId);
    if (!me) return;

    const ownBoard = mode === 'placement' ? this.boards.main : this.boards.side;
    const targetBoard = mode === 'placement' ? this.boards.side : this.boards.main;

    // own fleet + damage
    for (const ship of me.ships) {
      const mesh = this._addShipMesh(ownBoard, ship, ship.sunk ? 'wreck' : 'own');
      this.ownShipMeshes.push(mesh);
    }
    // enemy shots on my board
    for (const foe of state.players) {
      if (foe.id === me.id) continue;
      const fired = foe.shotsFired[me.id] || {};
      for (const [cellStr, result] of Object.entries(fired)) {
        this._addMarker(ownBoard, Number(cellStr), result);
      }
    }
    if (mode === 'battle') {
      // my shots on enemies; sunk enemy ships revealed as wrecks
      for (const foe of state.players) {
        if (foe.id === me.id) continue;
        const fired = me.shotsFired[foe.id] || {};
        for (const [cellStr, result] of Object.entries(fired)) {
          this._addMarker(targetBoard, Number(cellStr), result);
        }
        for (const ship of foe.ships) {
          if (ship.sunk && !this.enemyShipMeshes.has(foe.id + ':' + ship.id)) {
            const mesh = this._addShipMesh(targetBoard, ship, 'wreck');
            this.enemyShipMeshes.set(foe.id + ':' + ship.id, mesh);
          }
        }
      }
    }
    // own mines are visible to the owner during placement
    if (mode === 'placement' && me.mines) {
      for (const cell of me.mines) this._addMarker(ownBoard, cell, 'mine');
    }
  }

  /* ---------------- placement preview ---------------- */

  previewShip(cells, valid) {
    this.clearPreview();
    if (!cells || !cells.length || !this.boards) return;
    const mat = new THREE.MeshBasicMaterial({
      color: valid ? VALID_COLOR : INVALID_COLOR,
      transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const geo = new THREE.PlaneGeometry(0.86, 0.86);
    for (const cell of cells) {
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      const { x, y } = cellToXY(cell, this.boards.main.gridSize);
      m.position.set(-this.boards.main.half + (x + 0.5), 0.08, -this.boards.main.half + (y + 0.5));
      this.boards.main.group.add(m);
      this.previewMeshes.push(m);
    }
  }

  clearPreview() {
    for (const m of this.previewMeshes) { m.parent?.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.previewMeshes = [];
  }

  /** Draft (uncommitted) placement hulls on the main board. */
  showDraftPlacements(fleet, placements, gridSize) {
    for (const m of this.draftMeshes || []) { m.parent?.remove(m); m.geometry.dispose(); }
    this.draftMeshes = [];
    this._lastDraft = [fleet, placements, gridSize];
    const board = this.boards?.main;
    if (!board) return;
    for (const pl of placements.values()) {
      const def = fleet.find((f) => f.id === pl.shipId);
      if (!def) continue;
      const cells = [];
      for (let i = 0; i < def.size; i++) {
        cells.push(pl.dir === 'h' ? pl.y * gridSize + pl.x + i : (pl.y + i) * gridSize + pl.x);
      }
      this.draftMeshes.push(this._addShipMesh(board, { size: def.size, cells }, 'draft'));
    }
  }

  /* ---------------- cursor / selection ---------------- */

  setInteractive(boardId) {
    this.interactiveBoard = boardId;
    if (!this.boards) return;
    if (!boardId) {
      this.boards.main.ghost.visible = false;
      this.boards.main.ring.visible = false;
      this.boards.side.ghost.visible = false;
      this.boards.side.ring.visible = false;
    }
  }

  setCursor(boardId, cell, valid = true) {
    if (!this.boards) return;
    for (const id of ['main', 'side']) {
      const b = this.boards[id];
      const active = id === boardId && cell !== null && cell !== undefined;
      b.ghost.visible = !!active;
      b.ring.visible = !!active;
      if (active) {
        const { x, y } = cellToXY(cell, b.gridSize);
        const px = -b.half + (x + 0.5) * b.cell;
        const pz = -b.half + (y + 0.5) * b.cell;
        b.ghost.position.set(px, 0.06, pz);
        b.ring.position.set(px, 0.05, pz);
        const col = valid ? VALID_COLOR : INVALID_COLOR;
        b.ghost.material.color.set(col);
        b.ring.material.color.set(col);
      }
    }
  }

  /* ---------------- input ---------------- */

  _initPointer() {
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragState = null;

    const posToCell = (ev) => {
      if (!this.boards || !this.interactiveBoard) return null;
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const b = this.boards[this.interactiveBoard];
      const hits = this.raycaster.intersectObject(b.pick, false);
      if (!hits.length) return null;
      const local = b.group.worldToLocal(hits[0].point.clone());
      const x = Math.floor((local.x + b.half) / b.cell);
      const y = Math.floor((local.z + b.half) / b.cell);
      if (x < 0 || y < 0 || x >= b.gridSize || y >= b.gridSize) return null;
      return y * b.gridSize + x;
    };

    this.canvas.addEventListener('pointerdown', (ev) => {
      this.canvas.setPointerCapture?.(ev.pointerId);
      this.dragState = { x: ev.clientX, y: ev.clientY, t: performance.now(), moved: false, id: ev.pointerId };
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (this.dragState) {
        const dx = ev.clientX - this.dragState.x;
        const dy = ev.clientY - this.dragState.y;
        if (Math.hypot(dx, dy) > 10) this.dragState.moved = true;
        if (this.dragState.moved && !this.reducedMotion) {
          this.orbitOffset.x = THREE.MathUtils.clamp(this.orbitOffset.x - dx * 0.002, -0.35, 0.35);
          this.orbitOffset.y = THREE.MathUtils.clamp(this.orbitOffset.y + dy * 0.002, -0.2, 0.25);
          this.dragState.x = ev.clientX;
          this.dragState.y = ev.clientY;
        }
        return;
      }
      const cell = posToCell(ev);
      this.onCellHover?.(this.interactiveBoard, cell);
    });
    this.canvas.addEventListener('pointerup', (ev) => {
      const wasDrag = this.dragState?.moved;
      const dt = performance.now() - (this.dragState?.t || 0);
      this.dragState = null;
      if (wasDrag || dt > 600) return; // drag / long-press = camera gesture, not a pick
      const cell = posToCell(ev);
      if (cell !== null) this.onCellPick?.(this.interactiveBoard, cell);
    });
    this.canvas.addEventListener('lostpointercapture', () => { this.dragState = null; });
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.dragState) this.onCellHover?.(this.interactiveBoard, null);
    });
  }

  /* ---------------- camera ---------------- */

  setView(name, instant = false) {
    const pose = CAMERA_POSES[name] || CAMERA_POSES.battle;
    this.viewName = name;
    const basePos = new THREE.Vector3().fromArray(pose.pos);
    const look = new THREE.Vector3().fromArray(pose.look);
    // Fit the main board inside the HUD-free rectangle for this viewport.
    const dir = basePos.clone().sub(look).normalize();
    const dist = this._fitDistance(basePos, look);
    this.camTarget.pos.copy(look).addScaledVector(dir, dist);
    this.camTarget.look.copy(look);
    if (instant || this.reducedMotion) {
      this.camera.position.copy(this.camTarget.pos);
      this.camLook.copy(this.camTarget.look);
      this.camBase = { pos: this.camTarget.pos.clone(), look: this.camTarget.look.clone() };
      this.camVel.pos.set(0, 0, 0);
      this.camVel.look.set(0, 0, 0);
    }
  }

  /** Re-fit the current view (HUD or viewport changed). */
  refit() { if (this.viewName) this.setView(this.viewName, false); }

  resetCamera() {
    this.orbitOffset.x = 0;
    this.orbitOffset.y = 0;
    this.topDown = false;
    this.refit();
  }

  toggleTopDown() {
    this.topDown = !this.topDown;
    this.orbitOffset.x = 0;
    this.orbitOffset.y = 0;
    return this.topDown;
  }

  // The HUD-free rectangle of the canvas (fractions). Panels hugging an edge
  // carve that edge; the board is fitted inside what remains.
  _safeInsets() {
    const ins = { l: 0, r: 0, t: 0, b: 0 };
    const doc = globalThis.document;
    if (!doc) return ins;
    const cr = this.canvas.getBoundingClientRect();
    const W = cr.width || 1, H = cr.height || 1;
    for (const sel of ['.hud-top', '#tray', '#rail-left', '#rail-right']) {
      const el = doc.querySelector(sel);
      if (!el || el.hidden || !el.offsetParent) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const e = { l: (b.left - cr.left) / W, t: (b.top - cr.top) / H, r: (b.right - cr.left) / W, b: (b.bottom - cr.top) / H };
      if (e.l >= 1 || e.r <= 0) continue; // parked drawers
      if (e.b <= 0.45 && e.r - e.l > 0.5) ins.t = Math.max(ins.t, e.b);
      else if (e.t >= 0.55) ins.b = Math.max(ins.b, 1 - e.t);
      else if (e.r <= 0.42) ins.l = Math.max(ins.l, e.r);
      else if (e.l >= 0.58) ins.r = Math.max(ins.r, 1 - e.l);
    }
    if (ins.l + ins.r > 0.6) { ins.l = 0; ins.r = 0; }
    if (ins.t + ins.b > 0.7) { ins.t = Math.min(ins.t, 0.3); ins.b = Math.min(ins.b, 0.3); }
    return ins;
  }

  // Distance along the pose's line of sight at which the main board fits the
  // safe rectangle (checked by projecting the board corners).
  _fitDistance(basePos, look) {
    const b = this.boards?.main;
    if (!b) return basePos.distanceTo(look);
    const ins = this._safeInsets();
    const dir = basePos.clone().sub(look).normalize();
    const c = BOARD_LAYOUT.main.center;
    const half = b.half + 0.6;
    const corners = [];
    for (const dx of [-half, half]) for (const dz of [-half, half]) corners.push(new THREE.Vector3(c.x + dx, c.y, c.z + dz));
    // NDC bounds of the safe rect
    const xMin = -1 + 2 * ins.l + 0.06, xMax = 1 - 2 * ins.r - 0.06;
    const yMin = -1 + 2 * ins.b + 0.06, yMax = 1 - 2 * ins.t - 0.06;
    const cam = this._fitCam || (this._fitCam = new THREE.PerspectiveCamera());
    cam.fov = this.camera.fov; cam.aspect = this.camera.aspect; cam.near = this.camera.near; cam.far = this.camera.far;
    cam.updateProjectionMatrix();
    let dist = basePos.distanceTo(look);
    const v = new THREE.Vector3();
    for (let i = 0; i < 12; i++) {
      cam.position.copy(look).addScaledVector(dir, dist);
      cam.lookAt(look);
      cam.updateMatrixWorld();
      let over = 0;
      for (const p of corners) {
        v.copy(p).project(cam);
        over = Math.max(over, xMin - v.x, v.x - xMax, yMin - v.y, v.y - yMax);
      }
      if (over <= 0) break;
      dist *= 1 + Math.min(0.5, over * 0.6 + 0.02);
    }
    return dist;
  }

  _updateCamera(dt) {
    // critically damped springs on the BASE pose (interruptible, not cumulative
    // lerp); orbit and shake are applied on top each frame and never fed back.
    if (!this.camBase) {
      this.camBase = { pos: this.camera.position.clone(), look: this.camLook.clone() };
    }
    const k = 42, c = 2 * Math.sqrt(k);
    for (const [cur, vel, tgt] of [
      [this.camBase.pos, this.camVel.pos, this.camTarget.pos],
      [this.camBase.look, this.camVel.look, this.camTarget.look],
    ]) {
      vel.x += (k * (tgt.x - cur.x) - c * vel.x) * dt;
      vel.y += (k * (tgt.y - cur.y) - c * vel.y) * dt;
      vel.z += (k * (tgt.z - cur.z) - c * vel.z) * dt;
      cur.x += vel.x * dt; cur.y += vel.y * dt; cur.z += vel.z * dt;
    }
    const look = this.camBase.look.clone();
    this.camLook.copy(look);
    this.camera.position.copy(this.camBase.pos);
    // orbit gesture: rotate the base pose around the look point (pitch is
    // clamped so the board never flattens into an unreadable horizon)
    if (this.orbitOffset.x || this.orbitOffset.y) {
      const off = this.camera.position.clone().sub(look);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta += this.orbitOffset.x;
      sph.phi = THREE.MathUtils.clamp(sph.phi + this.orbitOffset.y, 0.2, 1.05);
      this.camera.position.copy(look).add(new THREE.Vector3().setFromSpherical(sph));
    }
    if (this.topDown) {
      const d = this.camera.position.distanceTo(look);
      this.camera.position.set(look.x, look.y + d, look.z + 0.01);
    }
    // event-tiered shake (never affects raycast truth: applied to view only)
    if (this.shake > 0 && !this.reducedMotion) {
      const s = this.shake * 0.06;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 3);
    }
    this.camera.lookAt(look);
  }

  /* ---------------- event playback (cosmetic) ---------------- */

  /**
   * Queue cosmetic animations for rule events. Returns total duration (ms).
   * End-state correctness comes from syncFromState, which the UI calls after.
   */
  playEvents(events, ctx = {}) {
    let delay = 0;
    const fast = this.reducedMotion;
    for (const ev of events) {
      if (ev.type === 'shot') {
        const boardId = ctx.mode === 'placement' ? 'main'
          : (ev.targetId === this.viewerId ? 'side' : 'main');
        const dest = this.cellWorldPos(boardId, ev.cell);
        this.jobs.push(this._makeShotJob(dest, ev.result, delay, boardId, ev));
        delay += fast ? 60 : (ev.result === 'miss' ? 420 : 620);
      } else if (ev.type === 'finish') {
        delay += fast ? 0 : 500;
      }
    }
    return delay;
  }

  _makeShotJob(dest, result, delayMs, boardId, ev) {
    const scene = this;
    const start = dest.clone().add(new THREE.Vector3(2.5, 6.5, 5.5));
    const proj = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 10, 10),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xaefcff).multiplyScalar(2.2) }),
    );
    proj.visible = false;
    this.scene.add(proj);
    const dur = this.reducedMotion ? 0.12 : 0.55;
    return {
      t: -delayMs / 1000,
      done: false,
      update(dt) {
        this.t += dt;
        if (this.t < 0) return false;
        const k = Math.min(this.t / dur, 1);
        proj.visible = true;
        // parabolic arc
        const p = start.clone().lerp(dest, k);
        p.y += Math.sin(k * Math.PI) * 2.2;
        proj.position.copy(p);
        if (k >= 1) {
          scene.scene.remove(proj);
          proj.geometry.dispose();
          proj.material.dispose();
          const color = result === 'miss' ? MISS_COLOR : result === 'mine' ? MINE_COLOR : HIT_COLOR;
          const count = result === 'miss' ? 26 : result === 'mine' ? 70 : result === 'sunk' ? 90 : 55;
          scene.particles.emit(dest, { count: Math.min(count, 90), color, speed: result === 'miss' ? 1.4 : 3.0, up: result === 'miss' ? 2.2 : 3.4 });
          if (scene.q?.particles === 'high' && !scene.reducedMotion) {
            // hot sparks and slow embers (hits) or fine spray (misses)
            if (result === 'miss') scene.particles.emit(dest, { count: 30, color: 0xeaf6ff, speed: 0.9, up: 3.6, size: 1.2, life: 1.0, spread: 0.25 });
            else {
              scene.particles.emit(dest, { count: 40, color: 0xffd08a, speed: 4.2, up: 4.0, size: 1.1, life: 0.55, spread: 0.2 });
              scene.particles.emit(dest, { count: 24, color: 0xff5a1e, speed: 0.8, up: 1.4, size: 3.2, life: 1.6, spread: 0.5 });
            }
          }
          scene.addRipple(dest, result === 'miss' ? 0.5 : 1.0);
          if (result !== 'miss') scene.shake = result === 'sunk' || result === 'mine' ? 1.0 : 0.55;
          this.done = true;
        }
        return this.done;
      },
      settle() {
        scene.scene.remove(proj);
        proj.geometry.dispose();
        proj.material.dispose();
        this.done = true;
      },
    };
  }

  addRipple(worldPos, strength) {
    const slot = this.waterUniforms.uRipples.value[this._rippleCursor = ((this._rippleCursor || 0) + 1) % 8];
    slot.set(worldPos.x, worldPos.z, this.time, strength);
  }

  /** Skip/fast-forward: settle every cosmetic job into its end state. */
  skip() {
    for (const j of this.jobs) j.settle?.();
    this.jobs.length = 0;
    this.particles.settle();
    this.shake = 0;
  }

  get jobsPending() { return this.jobs.length > 0; }

  /* ---------------- frame loop ---------------- */

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this.running || this.disposed) return;
      this._raf = requestAnimationFrame(loop);
      const dt = Math.min((now - this._last) / 1000, 0.1);
      this._last = now;
      this.time += dt;
      this.waterUniforms.uTime.value = this.time;
      // cosmetic jobs
      if (this.jobs.length) {
        this.jobs = this.jobs.filter((j) => !j.update(dt));
      }
      if (this.ambient) this._animateAmbient();
      this.particles.update(dt);
      this._updateCamera(dt);
      this._render(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() { this.running = false; if (this._raf) cancelAnimationFrame(this._raf); }

  _render(dt) {
    if (this._adapt(dt * 1000)) this._applySize();
    const key = this._postKey();
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost();
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  _applySize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 1;
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 1;
    const ratio = this._targetPixelRatio();
    this.size = [w, h];
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    return [w, h];
  }

  resize() {
    if (!this.q) return;
    const [w, h] = this._applySize();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.refit();
  }

  dispose() {
    this.disposed = true;
    this.pause();
    globalThis.removeEventListener?.('resize', this._boundResize);
    this.skip();
    this.scene.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    this.composer?.dispose?.();
    this._envTex?.dispose();
    this._chartTex?.dispose();
    this._brushTex?.dispose();
    this.renderer.dispose();
  }
}

export { cellName };
