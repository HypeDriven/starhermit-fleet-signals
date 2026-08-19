/**
 * Fleet Signals render layer — Three.js holographic chart table over a
 * stylized procedural sea. Consumes immutable rules snapshots; never
 * mutates game state. Cosmetic jobs are interruption-safe: skip() settles
 * every animation into its deterministic end state and the UI always
 * re-syncs board contents from the authoritative snapshot afterwards.
 */
import * as THREE from 'three';
import { makeRng } from '../rules/rng.js';
import { cellToXY, cellName } from '../rules/engine.js';

/* ------------------------------------------------------------------ */
/* quality tiers                                                       */
/* ------------------------------------------------------------------ */

export const QUALITY_TIERS = {
  low:    { dpr: 1.0, seaSegments: 48,  particles: 600,  shadows: false, antialias: false, renderScale: 0.85 },
  medium: { dpr: 1.5, seaSegments: 96,  particles: 1600, shadows: false, antialias: true,  renderScale: 1.0 },
  high:   { dpr: 2.0, seaSegments: 160, particles: 3200, shadows: true,  antialias: true,  renderScale: 1.0 },
};

export function pickAutoTier() {
  const dpr = (globalThis.devicePixelRatio || 1);
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  const mobile = /Mobi|Android/i.test(globalThis.navigator?.userAgent || '');
  if (mobile && (cores <= 4 || dpr > 2.5)) return 'low';
  if (mobile || cores <= 4) return 'medium';
  return 'high';
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

function buildHullGeometry(size) {
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

/** Minimal BufferGeometry merge (positions/normals/uvs, non-indexed). */
function mergeGeometries(geos) {
  const nonIndexed = geos.map((g) => g.index ? g.toNonIndexed() : g);
  const pos = [], norm = [], uv = [];
  for (const g of nonIndexed) {
    pos.push(...g.attributes.position.array);
    norm.push(...g.attributes.normal.array);
    if (g.attributes.uv) uv.push(...g.attributes.uv.array);
    else uv.push(...new Array((g.attributes.position.count) * 2).fill(0));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

/* ------------------------------------------------------------------ */
/* water shader — shared wave field, bounded ripples                   */
/* ------------------------------------------------------------------ */

const WATER_VERT = /* glsl */`
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
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const WATER_FRAG = /* glsl */`
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vNormalW;
varying vec3 vPosW;

void main() {
  vec3 n = normalize(vNormalW);
  vec3 viewDir = normalize(cameraPosition - vPosW);
  float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 2.2);
  float depthMix = clamp(0.35 + vPosW.y * 0.8, 0.0, 1.0);
  vec3 base = mix(uDeep, uShallow, depthMix);
  vec3 col = mix(base, uSky, fresnel * 0.65);
  // sun glints
  vec3 halfV = normalize(uSunDir + viewDir);
  float spec = pow(max(dot(n, halfV), 0.0), 220.0);
  col += uSunColor * spec * 0.9;
  gl_FragColor = vec4(col, 1.0);
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

  return { group, plate, pick, markers, ghost, ring, gridSize, cell, half };
}

/* ------------------------------------------------------------------ */
/* main scene class                                                    */
/* ------------------------------------------------------------------ */

export class FleetScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { theme, qualityTier, reducedMotion, visualSeed }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.tierName = opts.qualityTier && opts.qualityTier !== 'auto' ? opts.qualityTier : pickAutoTier();
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

    // callbacks assigned by UI
    this.onCellHover = null; // (boardId, cell|null)
    this.onCellPick = null;  // (boardId, cell)
    this.onCameraGesture = null;

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initEnvironment();
    this._initPointer();
    this.setTheme(opts.theme || null);

    this.boards = null; // { main, side }
    this.ownShipMeshes = [];
    this.enemyShipMeshes = new Map(); // shipId -> mesh
    this.previewMeshes = [];

    this._boundResize = () => this.resize();
    globalThis.addEventListener?.('resize', this._boundResize);
  }

  /* ---------------- setup ---------------- */

  _initRenderer() {
    const tier = QUALITY_TIERS[this.tierName];
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: tier.antialias,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (tier.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.running = false;
      this.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this._initRenderer();
      this.resize();
      this.running = true;
    });
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
    if (QUALITY_TIERS[this.tierName].shadows) {
      this.keyLight.castShadow = true;
      this.keyLight.shadow.mapSize.set(1024, 1024);
      this.keyLight.shadow.camera.left = -12;
      this.keyLight.shadow.camera.right = 12;
      this.keyLight.shadow.camera.top = 12;
      this.keyLight.shadow.camera.bottom = -12;
    }
    this.scene.add(this.keyLight);
    this.fillLight = new THREE.HemisphereLight(0x8fb7d9, 0x1a2433, 1.05);
    this.scene.add(this.fillLight);

    // sea
    const tier = QUALITY_TIERS[this.tierName];
    this.waterUniforms = {
      uTime: { value: 0 },
      uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -10, 0)) },
      uDeep: { value: new THREE.Color(0x06283d) },
      uShallow: { value: new THREE.Color(0x1a5d7a) },
      uSky: { value: new THREE.Color(0x9fc6e0) },
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.4).normalize() },
      uSunColor: { value: new THREE.Color(0xffe9c4) },
    };
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140, tier.seaSegments, tier.seaSegments),
      new THREE.ShaderMaterial({
        vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: this.waterUniforms,
      }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -2.2;
    this.water.raycast = () => {};
    this.scene.add(this.water);

    // captain's chart table: pedestal + rim + holo surface
    this.table = new THREE.Group();
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(5.4, 6.2, 1.6, 48),
      new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.55, metalness: 0.75 }),
    );
    pedestal.position.y = -0.85;
    pedestal.receiveShadow = true;
    this.table.add(pedestal);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(5.45, 0.09, 12, 64),
      new THREE.MeshStandardMaterial({
        color: 0x59e6ff, emissive: 0x59e6ff, emissiveIntensity: 1.4, roughness: 0.3, metalness: 0.2,
      }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.02;
    this.table.add(rim);
    const surface = new THREE.Mesh(
      new THREE.CylinderGeometry(5.4, 5.4, 0.08, 48),
      new THREE.MeshStandardMaterial({
        color: 0x0d2438, roughness: 0.25, metalness: 0.4,
        emissive: 0x0d2c44, emissiveIntensity: 0.5, transparent: true, opacity: 0.92,
      }),
    );
    surface.position.y = -0.04;
    surface.receiveShadow = true;
    this.table.add(surface);
    this.scene.add(this.table);

    // decoration from the deterministic visual stream
    const vrng = makeRng(this.visualSeed + ':decor');
    const buoyGeo = new THREE.ConeGeometry(0.3, 0.9, 8);
    const buoyMat = new THREE.MeshStandardMaterial({ color: 0xb03a4a, roughness: 0.6 });
    const buoys = new THREE.InstancedMesh(buoyGeo, buoyMat, 10);
    const bm = new THREE.Matrix4();
    for (let i = 0; i < 10; i++) {
      const ang = vrng.next() * Math.PI * 2;
      const r = 16 + vrng.next() * 20;
      bm.makeTranslation(Math.cos(ang) * r, -1.6, Math.sin(ang) * r);
      buoys.setMatrixAt(i, bm);
    }
    buoys.instanceMatrix.needsUpdate = true;
    this.scene.add(buoys);

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

    // particle pool
    this.particles = new ParticlePool(QUALITY_TIERS[this.tierName].particles);
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
    this.table.children[1].material.color.set(s.holoGrid);
    this.table.children[1].material.emissive.set(s.holoGrid);
  }

  setQuality(tierName) {
    if (!QUALITY_TIERS[tierName] || tierName === this.tierName) return;
    this.tierName = tierName;
    const tier = QUALITY_TIERS[tierName];
    this.renderer.shadowMap.enabled = tier.shadows;
    this.keyLight.castShadow = tier.shadows;
    // rebuild water mesh at new density
    const old = this.water;
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140, tier.seaSegments, tier.seaSegments),
      old.material,
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -2.2;
    this.water.raycast = () => {};
    this.scene.remove(old);
    old.geometry.dispose();
    this.scene.add(this.water);
    // rebuild particle pool
    this.scene.remove(this.particles.points);
    this.particles.points.geometry.dispose();
    this.particles.points.material.dispose();
    this.particles = new ParticlePool(tier.particles);
    this.scene.add(this.particles.points);
    this.resize();
  }

  setReducedMotion(flag) {
    this.reducedMotion = !!flag;
    if (this.reducedMotion) this.shake = 0;
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
    if (kind === 'own') {
      return new THREE.MeshStandardMaterial({ color: 0x8a97a8, roughness: 0.45, metalness: 0.85 });
    }
    if (kind === 'wreck') {
      return new THREE.MeshStandardMaterial({
        color: 0x3a2f2f, roughness: 0.9, metalness: 0.2,
        emissive: 0xff3300, emissiveIntensity: 0.12,
      });
    }
    return new THREE.MeshStandardMaterial({
      color: this.holoShipColor || 0x59e6ff, transparent: true, opacity: 0.4,
      emissive: this.holoShipColor || 0x59e6ff, emissiveIntensity: 0.6, roughness: 0.4,
    });
  }

  _addShipMesh(board, ship, kind) {
    const geo = buildHullGeometry(ship.size);
    const mesh = new THREE.Mesh(geo, this._shipMaterial(kind));
    mesh.castShadow = kind === 'own';
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
        new THREE.MeshStandardMaterial({ color: MINE_COLOR, emissive: MINE_COLOR, emissiveIntensity: 0.9 }),
      );
      mesh.position.y = 0.2;
    } else { // hit
      mesh = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.42, 4),
        new THREE.MeshStandardMaterial({ color: HIT_COLOR, emissive: HIT_COLOR, emissiveIntensity: 1.1 }),
      );
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
    this.camTarget.pos.fromArray(pose.pos);
    this.camTarget.look.fromArray(pose.look);
    if (instant || this.reducedMotion) {
      this.camera.position.copy(this.camTarget.pos);
      this.camLook.copy(this.camTarget.look);
      this.camVel.pos.set(0, 0, 0);
      this.camVel.look.set(0, 0, 0);
    }
  }

  resetCamera() {
    this.orbitOffset.x = 0;
    this.orbitOffset.y = 0;
  }

  _updateCamera(dt) {
    // critically damped springs (interruptible, not cumulative lerp)
    const k = 42, c = 2 * Math.sqrt(k);
    for (const [cur, vel, tgt] of [
      [this.camera.position, this.camVel.pos, this.camTarget.pos],
      [this.camLook, this.camVel.look, this.camTarget.look],
    ]) {
      vel.x += (k * (tgt.x - cur.x) - c * vel.x) * dt;
      vel.y += (k * (tgt.y - cur.y) - c * vel.y) * dt;
      vel.z += (k * (tgt.z - cur.z) - c * vel.z) * dt;
      cur.x += vel.x * dt; cur.y += vel.y * dt; cur.z += vel.z * dt;
    }
    const look = this.camLook.clone();
    // orbit gesture: rotate camera around the look point
    if (this.orbitOffset.x || this.orbitOffset.y) {
      const off = this.camera.position.clone().sub(look);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta += this.orbitOffset.x;
      sph.phi = THREE.MathUtils.clamp(sph.phi + this.orbitOffset.y, 0.25, 1.35);
      this.camera.position.copy(look).add(new THREE.Vector3().setFromSpherical(sph));
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
      new THREE.MeshBasicMaterial({ color: 0xaefcff }),
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
      this.particles.update(dt);
      this._updateCamera(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() { this.running = false; if (this._raf) cancelAnimationFrame(this._raf); }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 1;
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 1;
    const tier = QUALITY_TIERS[this.tierName];
    const dpr = Math.min(globalThis.devicePixelRatio || 1, tier.dpr) * tier.renderScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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
    this.renderer.dispose();
  }
}

export { cellName };
