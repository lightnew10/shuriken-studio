import * as THREE from 'three';
import { StudioCamera } from './studio-camera';
import { GradientSky } from './sky';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { detailTexture, materialSpec, triplanarMaterial } from './materials';
import type { V3 } from '@shared/viewer';
import { frameScene, contentBox, terrainExtent, type FramePart } from './framing';
import { partMatrix, planPart, type Drawn, type Proxy } from './placement';
import { watchVisibility, type Visibility } from './visibility';

export interface ScenePart {
  cls: string;
  shape: string;
  pos: [number, number, number];
  size: [number, number, number];
  rot: [number, number, number];
  color: string;
  material: string;
  transparency: number;
  name: string;
  textured: boolean;
  reflectance: number;
  /** The modeled mesh this MeshPart shows (its geometry comes from the project). */
  model?: string;
  /** Its folder/model path under Workspace ("Map/Arena/Pillars"; "" = directly in Workspace). */
  parent?: string;
  /** Row flags (@shared/viewer PART_FLAG): ShurikenTurned, has a colour map, FileMesh Part, temporary mesh. */
  flags?: number;
  /** A Part drawn through a SpecialMesh FileMesh: the mesh's Scale and Offset (its size comes from the model). */
  fileMesh?: { scale: V3; offset: V3 };
}

/** A modeled mesh the scene can draw (see SceneEngine.setModel). */
export interface SceneModel {
  /** The mesh's geometry as the project made it (never changed here: scenes share it). */
  geo: THREE.BufferGeometry;
  /** The model's size in studs. */
  size: V3;
  /** Its upload predates the importer-turn compensation: Studio draws the mesh turned 180° about Y. */
  legacy: boolean;
  /** Its colour map (sRGB, glTF UV orientation), when it has one. */
  texture: THREE.Texture | null;
  /** The map has cut-out texels. */
  alpha: boolean;
}

export interface SceneLighting {
  clock: number;
  lat: number;
  brightness: number;
  ambient: string;
  outdoor: string;
  fogColor: string;
  fogStart: number;
  fogEnd: number;
  atmosphere?: { density: number; offset: number; color: string; decay: string; glare: number; haze: number };
  cc?: { brightness: number; contrast: number; saturation: number; tint: string };
  bloom?: { intensity: number; size: number; threshold: number };
  sky?: boolean;
  /** Lighting.ExposureCompensation (stops). */
  exposure?: number;
  clouds?: { cover: number; density: number; color: string };
  /** Point/spot/surface lights: position, color, brightness, range, kind (P/S/U). */
  lights?: Array<{ p: [number, number, number]; c: string; b: number; rg: number; k: string }>;
}

export interface TerrainInterval {
  top: number;
  bottom: number;
  /** Index into names (1-based). */
  mat: number;
}

export interface TerrainData {
  n: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** n*n cells, row-major: up to three voxel intervals (solid or water) from the top down; null = none. */
  cells: Array<TerrainInterval[] | null>;
  names: string[];
  colors: string[];
  waterColor: string;
}

export interface CameraPose {
  pos: [number, number, number];
  look: [number, number, number];
}

const hex = (h: string) => new THREE.Color(`#${h.replace('#', '')}`);

/** The 12 edges of each box (centre, size, rotation) as one line-segment geometry. */
function edgeGeometry(boxes: Array<{ pos: THREE.Vector3; size: THREE.Vector3; rot: THREE.Euler }>): THREE.BufferGeometry {
  const unit = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)).getAttribute('position') as THREE.BufferAttribute;
  const out = new Float32Array(boxes.length * unit.count * 3);
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  boxes.forEach((b, i) => {
    m.compose(b.pos, new THREE.Quaternion().setFromEuler(b.rot), b.size);
    for (let k = 0; k < unit.count; k++) {
      v.fromBufferAttribute(unit, k).applyMatrix4(m);
      out.set([v.x, v.y, v.z], (i * unit.count + k) * 3);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return geo;
}

/** How a part is drawn: its real primitive, or a stand-in for mesh geometry the viewer cannot load. */
function proxyFor(p: ScenePart): Proxy {
  if (p.cls === 'Part' || p.cls === 'SpawnLocation' || p.cls === 'Seat' || p.cls === 'VehicleSeat') {
    if (p.shape === 'Ball') return 'ball';
    if (p.shape === 'Cylinder') return 'cylinder';
    if (p.shape === 'Wedge') return 'wedge';
    if (p.shape === 'CornerWedge') return 'corner';
    return 'box';
  }
  if (p.cls === 'WedgePart') return 'wedge';
  if (p.cls === 'CornerWedgePart') return 'corner';
  if (p.cls === 'MeshPart' || p.cls === 'UnionOperation' || p.cls === 'IntersectOperation' || p.cls === 'NegateOperation') {
    const n = p.name.toLowerCase();
    if (/trunk|stem|log|bark|stump/.test(n)) return 'trunk';
    if (/leaf|leaves|bush|tree|foliage|canopy|shrub|hedge|plant|flower|fern|pine|palm|blossom/.test(n)) return 'foliage';
    if (/rock|stone|boulder|cliff|pebble|ore|crystal|mountain/.test(n)) return 'rock';
    if (p.cls === 'MeshPart') {
      const c = hex(p.color);
      const [sx, sy, sz] = p.size;
      if (c.g > c.r + 0.06 && c.g > c.b + 0.02) return 'foliage';
      if (c.r > c.b + 0.08 && c.g < c.r && sy > 2.2 * Math.max(sx, sz)) return 'trunk';
      if (Math.abs(c.r - c.g) < 0.06 && Math.abs(c.g - c.b) < 0.06 && Math.min(sx, sy, sz) > 1.5) return 'rock';
    }
  }
  return 'box';
}

function wedgeGeometry(): THREE.BufferGeometry {
  // Roblox wedge: full bottom and back (+Z) faces, slope rising from front-bottom to back-top.
  const v = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
    [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5],
  ];
  const tris = [
    [0, 1, 2], [0, 2, 3], // bottom
    [3, 2, 5], [3, 5, 4], // back
    [0, 4, 5], [0, 5, 1], // slope
    [0, 3, 4], // left
    [1, 5, 2], // right
  ];
  return indexedToFlat(v, tris);
}

function cornerGeometry(): THREE.BufferGeometry {
  const v = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
    [0.5, 0.5, -0.5],
  ];
  const tris = [[0, 1, 2], [0, 2, 3], [0, 4, 1], [1, 4, 2], [2, 4, 3], [3, 4, 0]];
  return indexedToFlat(v, tris);
}

function indexedToFlat(v: number[][], tris: number[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (const t of tris) for (const i of t) {
    pos.push(...v[i]!);
    uv.push(0, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function geometryFor(proxy: Proxy): THREE.BufferGeometry {
  switch (proxy) {
    case 'ball':
      return new THREE.SphereGeometry(0.5, 28, 18);
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
      g.rotateZ(Math.PI / 2); // Roblox cylinders run along X
      return g;
    }
    case 'wedge':
      return wedgeGeometry();
    case 'corner':
      return cornerGeometry();
    case 'foliage':
      return new THREE.IcosahedronGeometry(0.5, 2);
    case 'rock': {
      const g = new THREE.IcosahedronGeometry(0.5, 1);
      // Deterministic lumps so rocks read as rocks, not balls.
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const k = 0.86 + 0.22 * Math.abs(Math.sin(p.getX(i) * 12.9898 + p.getY(i) * 78.233 + p.getZ(i) * 37.719) * 43758.5453 % 1);
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
      }
      g.computeVertexNormals();
      return g.toNonIndexed();
    }
    case 'trunk':
      return new THREE.CylinderGeometry(0.4, 0.5, 1, 12);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

/** Sun direction for a Roblox ClockTime and GeographicLatitude (Studio's sun path, roughly). */
function sunDirection(clock: number, latitude: number): THREE.Vector3 {
  const lat = THREE.MathUtils.degToRad(latitude);
  const dec = THREE.MathUtils.degToRad(23.44);
  const h = THREE.MathUtils.degToRad((clock - 12) * 15);
  const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h));
  const az = Math.atan2(-Math.sin(h), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(h));
  // Roblox: +Y up, -Z north, +X east.
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
}

const ColorCorrectionShader = {
  uniforms: { tDiffuse: { value: null }, uBrightness: { value: 0 }, uContrast: { value: 0 }, uSaturation: { value: 0 }, uTint: { value: new THREE.Color(1, 1, 1) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uBrightness; uniform float uContrast; uniform float uSaturation; uniform vec3 uTint; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb + uBrightness;
      col = (col - 0.5) * (1.0 + uContrast) + 0.5;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, 1.0 + uSaturation);
      gl_FragColor = vec4(col * uTint, c.a);
    }`,
};

interface Batch {
  mesh: THREE.InstancedMesh;
  parts: number[];
  /** Its geometry belongs to a model shared between scenes: not disposed with the batch. */
  shared: boolean;
}

/** A model in the scene: its mesh and what is needed to fit it to a part. */
interface ModelEntry extends SceneModel {
  center: V3;
  extent: V3;
}

/**
 * The live replica of a Roblox place: instanced parts with Roblox-like materials, terrain, sky, sun,
 * fog, soft shadows, bloom for Neon and Studio's color correction.
 */
export interface LightTuning {
  exposure: number;
  sun: number;
  hemi: number;
  ambient: number;
  fog: number;
  /** Place lights (torches, lamps). */
  lights: number;
}

/** Calibrated against Studio renders of real places (smoke --smoke-calibrate). */
// Calibrated 2026-09-29 against Studio renders of a sunset arena and sky lobby (Neutral tone mapping).
export const LIGHT_TUNING: LightTuning = { exposure: 1.15, sun: 1.05, hemi: 1.05, ambient: 1.05, fog: 0.9, lights: 1 };

export class SceneEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly cam: StudioCamera;
  private readonly clock = new THREE.Clock();
  private selection: THREE.LineSegments | null = null;
  private selectedGroup: ScenePart[] | null = null;
  /** A part was clicked (null: clicked empty space). */
  onSelect: ((p: ScenePart | null) => void) | null = null;
  onSpeedChange: ((mul: number) => void) | null = null;
  private readonly scene = new THREE.Scene();
  private readonly world = new THREE.Group();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly cc: ShaderPass;
  private readonly sky = new GradientSky();
  private lights: THREE.PointLight[] = [];
  private lightsKey = '';
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.6);
  private readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a5048, 1.1);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.25);
  private batches: Batch[] = [];
  /**
   * The batches' materials by what they look like, kept from one rebuild to the next. A rebuild used to dispose
   * them all and make new ones, so every shader was compiled again: seconds of a frozen window on a big place,
   * after each change in Studio and every 250 ms while models arrived.
   */
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private parts: ScenePart[] = [];
  private terrain: THREE.Object3D | null = null;
  private bounds = new THREE.Box3();
  private raf = 0;
  /** Something changed since the last frame drawn (see invalidate). */
  private dirty = true;
  /** The clouds' clock: it runs while the view is live and rests with it. */
  private skyTime = 0;
  private readonly seen: Visibility;
  private idleTimer = 0;
  private lastPose = '';
  private disposed = false;
  onIdle: ((pose: CameraPose) => void) | null = null;
  onMove: (() => void) | null = null;

  constructor(private readonly host: HTMLElement, private readonly opts: { quality: 'high' | 'low' } = { quality: 'high' }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.quality === 'high' ? 2 : 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral keeps saturated colors (sunsets, team colors) the way Roblox shows them; ACES washes them out.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.5, 20000);
    this.camera.position.set(80, 70, 110);
    // Roblox Studio's camera: WASD/QE to fly, right-drag to look, middle-drag to pan, wheel to fly forward and back.
    this.cam = new StudioCamera(this.camera, this.renderer.domElement);
    this.cam.lookAt(new THREE.Vector3(0, 0, 0));
    this.cam.raycast = (ndc) => this.hitPoint(ndc);
    this.cam.onClick = (x, y) => this.select(this.pick(x, y), true);
    this.cam.onFocusKey = () => this.focusSelection();
    this.cam.onSpeedChange = (m) => this.onSpeedChange?.(m);

    this.scene.add(this.sky.mesh, this.hemi, this.ambient, this.sun, this.sun.target, this.world);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(opts.quality === 'high' ? 4096 : 1024, opts.quality === 'high' ? 4096 : 1024);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.cc = new ShaderPass(ColorCorrectionShader);
    this.composer.addPass(this.cc);
    this.composer.addPass(new OutputPass());

    this.setLighting(null);
    this.resize();
    // Drawn on demand: when something changes, while the camera moves, when the user touches it, and never while
    // it can't be seen (a dashboard left open all night kept the GPU busy, and Kiln's builds share it).
    this.cam.onInput = () => this.invalidate();
    this.seen = watchVisibility(host, () => this.invalidate());
    // The GPU took the context away and gave it back (a driver reset, memory pressure with several Studio windows
    // open): three rebuilds its state, but a view that is drawn on demand has to be asked to draw again, or it stays blank.
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onRestored);
  }

  private readonly onRestored = (): void => {
    if (!this.disposed) this.resize();
  };

  /** Something changed: draw it on the next frame. */
  invalidate(): void {
    this.dirty = true;
    if (this.raf || this.disposed) return;
    // The time at rest is no step for the camera's easing.
    this.clock.getDelta();
    this.raf = requestAnimationFrame(this.loop);
  }

  private readonly loop = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = Math.min(0.1, this.clock.getDelta());
    const moving = this.cam.update(dt) || this.cam.moving();
    if (moving) this.skyTime += dt;
    this.watchCamera();
    // Unseen: nothing is drawn, and it draws again when it shows (watchVisibility).
    if (!this.seen.visible()) return;
    if (moving || this.dirty) {
      this.dirty = false;
      this.sky.follow(this.camera, this.skyTime);
      this.composer.render();
    }
    if (moving && !this.raf) this.raf = requestAnimationFrame(this.loop);
  };

  resize(): void {
    this.invalidate();
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Current camera as a Roblox-space pose (for Studio shots). */
  pose(): CameraPose {
    const p = this.camera.position;
    const t = p.clone().addScaledVector(this.cam.forward(), this.cam.focusDistance);
    return { pos: [p.x, p.y, p.z], look: [t.x, t.y, t.z] };
  }

  /** The nearest scene point along a ray (parts and terrain), or null. */
  private hitPoint(ndc: THREE.Vector2): THREE.Vector3 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = this.batches.map((b) => b.mesh);
    if (this.terrain) targets.push(this.terrain);
    const hit = ray.intersectObjects(targets, true)[0];
    return hit ? hit.point.clone() : null;
  }

  /** Studio-style selection: a blue outline around the clicked part. */
  select(p: ScenePart | null, notify = false): void {
    this.selectParts(p ? [p] : null);
    if (notify) this.onSelect?.(p);
  }

  /**
   * Selects several parts (an Explorer folder or model): one blue outline per part, or around the
   * whole group when it is large.
   */
  selectParts(parts: ScenePart[] | null): void {
    this.invalidate();
    this.selectedGroup = parts?.length ? parts : null;
    if (this.selection) {
      this.world.remove(this.selection);
      this.selection.geometry.dispose();
      (this.selection.material as THREE.Material).dispose();
      this.selection = null;
    }
    if (!parts?.length) return;
    const boxes: Array<{ pos: THREE.Vector3; size: THREE.Vector3; rot: THREE.Euler }> = [];
    if (parts.length <= 400) {
      for (const p of parts) boxes.push(this.boxOf(p, 0.08));
    } else {
      const b = this.groupBounds(parts);
      boxes.push({ pos: b.getCenter(new THREE.Vector3()), size: b.getSize(new THREE.Vector3()).addScalar(0.2), rot: new THREE.Euler() });
    }
    const line = new THREE.LineSegments(edgeGeometry(boxes), new THREE.LineBasicMaterial({ color: 0x00a2ff, depthTest: false, transparent: true, opacity: 0.95 }));
    line.renderOrder = 999;
    this.selection = line;
    this.world.add(line);
  }

  /** A part's box as it is drawn (the mesh's size for a SpecialMesh piece, its offset applied), `grow` studs bigger. */
  private boxOf(p: ScenePart, grow = 0): { pos: THREE.Vector3; size: THREE.Vector3; rot: THREE.Euler } {
    const d = this.drawn.get(p);
    const rot = new THREE.Euler(THREE.MathUtils.degToRad(p.rot[0]), THREE.MathUtils.degToRad(p.rot[1]), THREE.MathUtils.degToRad(p.rot[2]), 'YXZ');
    const size = d ? d.size : p.size;
    const pos = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]);
    if (d?.offset) pos.add(new THREE.Vector3(d.offset[0], d.offset[1], d.offset[2]).applyEuler(rot));
    return { pos, size: new THREE.Vector3(size[0] + grow, size[1] + grow, size[2] + grow), rot };
  }

  /** Axis-aligned bounds of parts (each part's box turned by its rotation). */
  private groupBounds(parts: ScenePart[]): THREE.Box3 {
    const box = new THREE.Box3();
    const one = new THREE.Box3();
    for (const p of parts) {
      const b = this.boxOf(p);
      one.setFromCenterAndSize(new THREE.Vector3(), b.size);
      one.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(b.rot));
      one.translate(b.pos);
      box.union(one);
    }
    return box;
  }

  /** Every part in the scene (for the Explorer). */
  allParts(): ScenePart[] {
    return this.parts;
  }

  /** F: glide to frame the selection (keeping the view direction), or back to the map. */
  focusSelection(): void {
    const group = this.selectedGroup;
    if (!group?.length) {
      this.frameMap(true);
      return;
    }
    const b = this.groupBounds(group);
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const radius = Math.max(2, size.length() * 0.5);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = Math.min(3000, (radius / Math.sin(fov / 2)) * 1.1);
    this.cam.flyTo(center.clone().addScaledVector(this.cam.forward(), -dist), center);
  }

  private watchCamera(): void {
    const p = this.camera.position;
    const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${this.cam.yaw.toFixed(4)},${this.cam.pitch.toFixed(4)},${this.host.clientWidth}x${this.host.clientHeight}`;
    if (key !== this.lastPose) {
      const first = this.lastPose === '';
      this.lastPose = key;
      if (!first) this.onMove?.();
      window.clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => this.onIdle?.(this.pose()), 750);
    }
  }

  /** Lighting multipliers calibrated against Studio's own renders (see smoke --smoke-calibrate). */
  tuning: LightTuning = { ...LIGHT_TUNING };
  private lastLighting: SceneLighting | null = null;

  tune(t: Partial<LightTuning>): void {
    this.tuning = { ...this.tuning, ...t };
    this.lightsKey = '';
    this.setLighting(this.lastLighting);
  }

  setLighting(l: SceneLighting | null): void {
    this.invalidate();
    this.lastLighting = l;
    const tn = this.tuning;
    this.renderer.toneMappingExposure = THREE.MathUtils.clamp(tn.exposure * Math.pow(2, l?.exposure ?? 0), 0.2, 4);
    const clock = l?.clock ?? 14;
    const dir = sunDirection(clock, l?.lat ?? 41.73);
    const day = THREE.MathUtils.smoothstep(dir.y, -0.08, 0.18);
    // Low sun: golden hour colors. Sky colors follow the place's Atmosphere when it has one.
    const golden = day * (1 - THREE.MathUtils.smoothstep(dir.y, 0.04, 0.42));
    const zenith = new THREE.Color(0x2f6fd1).lerp(new THREE.Color(0x4a64a8), golden).lerp(new THREE.Color(0x03060e), 1 - day);
    const horizon = new THREE.Color(0xa9cbe8).lerp(new THREE.Color(0xffb27c), golden).lerp(new THREE.Color(0x0d1628), 1 - day);
    const atm = l?.atmosphere;
    if (atm && atm.density > 0) {
      // Roblox's Atmosphere tints the horizon strongly and, with haze, the whole sky.
      const tintAmount = THREE.MathUtils.clamp(0.45 + atm.density * 1.5, 0, 0.92) * (0.35 + 0.65 * day);
      horizon.lerp(hex(atm.color), tintAmount);
      zenith.lerp(hex(atm.color), THREE.MathUtils.clamp(atm.haze * 0.22, 0, 0.6) * day).lerp(hex(atm.decay), 0.2 * golden);
    }
    const su = this.sky.uniforms;
    (su.uZenith!.value as THREE.Color).copy(zenith);
    (su.uHorizon!.value as THREE.Color).copy(horizon);
    (su.uGround!.value as THREE.Color).copy(horizon.clone().lerp(new THREE.Color(0x2e2a26), 0.65));
    (su.uSunDir!.value as THREE.Vector3).copy(dir);
    (su.uSunColor!.value as THREE.Color).setHSL(0.075, 0.85 * golden + 0.1, 0.62 + 0.3 * (1 - golden)).multiplyScalar(day);
    su.uGlow!.value = 0.6 + 0.8 * golden + (atm?.glare ?? 0) * 0.5;
    su.uCloudCover!.value = l?.clouds ? THREE.MathUtils.clamp(l.clouds.cover, 0, 1) : 0;
    (su.uCloudColor!.value as THREE.Color).copy(l?.clouds ? hex(l.clouds.color) : new THREE.Color(1, 1, 1)).lerp(horizon, 0.25).multiplyScalar(0.35 + 0.65 * day);
    this.scene.background = null;
    this.setPlaceLights(l?.lights ?? []);
    const brightness = l?.brightness ?? 2;
    this.sun.intensity = (1.2 + Math.min(brightness, 5) * 0.75) * day * tn.sun;
    this.sun.color.setHSL(0.09, 0.55 * (1 - Math.min(1, dir.y * 2.2)), 0.72 + 0.28 * Math.min(1, dir.y * 2));
    this.sunDir = dir;
    const outdoor = hex(l?.outdoor ?? '808080');
    this.hemi.color.copy(new THREE.Color(0xbfd8ff).lerp(outdoor, 0.35));
    this.hemi.groundColor.copy(new THREE.Color(0x6a5a4c).lerp(outdoor, 0.25));
    this.hemi.intensity = (0.55 + 0.75 * day) * tn.hemi;
    this.ambient.color.copy(hex(l?.ambient ?? '808080'));
    this.ambient.intensity = (0.22 + 0.2 * (1 - day)) * tn.ambient;
    if (l?.atmosphere && l.atmosphere.density > 0) {
      // Haze takes the atmosphere's own color, blended toward the horizon so distance fades into the sky.
      const haze = hex(l.atmosphere.color).lerp(horizon, 0.45);
      const density = (0.00025 + l.atmosphere.density * 0.0022 * (0.6 + l.atmosphere.haze * 0.15)) * tn.fog;
      this.scene.fog = density > 1e-6 ? new THREE.FogExp2(haze, density) : null;
    } else if (l && l.fogEnd < 10000) {
      this.scene.fog = new THREE.Fog(hex(l.fogColor), l.fogStart, l.fogEnd);
    } else {
      this.scene.fog = null;
    }
    this.bloom.strength = l?.bloom ? Math.min(1.4, 0.35 + l.bloom.intensity * 0.6) : 0.55;
    // Bloom is for Neon and lights, not for bright walls and sunlit floors.
    this.bloom.threshold = l?.bloom ? Math.max(0.85, Math.min(0.99, l.bloom.threshold * 0.6)) : 0.95;
    const u = this.cc.uniforms;
    u.uBrightness!.value = l?.cc ? l.cc.brightness * 0.5 : 0;
    u.uContrast!.value = l?.cc ? l.cc.contrast * 0.6 : 0.04;
    u.uSaturation!.value = l?.cc ? l.cc.saturation * 0.7 : 0.08;
    (u.uTint!.value as THREE.Color).copy(l?.cc ? hex(l.cc.tint) : new THREE.Color(1, 1, 1));
    this.fitShadow();
  }

  private sunDir = new THREE.Vector3(0.4, 0.8, 0.3);

  /** Roblox lights as point lights (the 24 strongest), so torches and lamps light what is around them. */
  private setPlaceLights(list: NonNullable<SceneLighting['lights']>): void {
    const key = JSON.stringify(list.slice(0, 24));
    if (key === this.lightsKey) return;
    this.lightsKey = key;
    for (const l of this.lights) {
      this.world.remove(l);
      l.dispose();
    }
    this.lights = list.slice(0, 24).map((d) => {
      const scale = d.k === 'P' ? 1 : 0.6; // spot/surface lights light less than a full sphere
      // Roblox lights fade gently to zero at their range: close to linear falloff, not inverse-square.
      const light = new THREE.PointLight(hex(d.c), Math.min(12, Math.max(0, d.b)) * 4.5 * scale * this.tuning.lights, d.rg * 1.15, 1);
      light.position.set(d.p[0], d.p[1], d.p[2]);
      this.world.add(light);
      return light;
    });
  }

  private fitShadow(): void {
    const b = this.bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-128, -10, -128), new THREE.Vector3(128, 60, 128)) : this.bounds;
    const center = b.getCenter(new THREE.Vector3());
    const radius = Math.max(40, b.getSize(new THREE.Vector3()).length() * 0.55);
    this.sun.position.copy(center).addScaledVector(this.sunDir, radius * 2);
    this.sun.target.position.copy(center);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 1;
    cam.far = radius * 4;
    cam.updateProjectionMatrix();
  }

  /** The project's modeled meshes by name (null: tried and not available). */
  private readonly models = new Map<string, ModelEntry | null>();
  /** Where each part is drawn this time. */
  private drawn = new Map<ScenePart, Drawn>();
  private ghostLines: THREE.LineSegments | null = null;
  private rebuildTimer = 0;
  private frameParts: FramePart[] = [];

  /** Models the current parts show whose mesh hasn't been provided yet, the widest first (ground before props). */
  modelsWanted(): string[] {
    const reach = new Map<string, number>();
    for (const p of this.parts) {
      if (!p.model || this.models.has(p.model)) continue;
      reach.set(p.model, Math.max(reach.get(p.model) ?? 0, p.size[0] * p.size[2]));
    }
    return [...reach.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }

  /**
   * Provides a model's mesh (null: it can't be had, its parts keep their stand-ins) and redraws soon. The
   * geometry is shared and left as it is: fitting it to a part is done by the part's matrix.
   */
  setModel(name: string, model: SceneModel | null): void {
    let entry: ModelEntry | null = null;
    if (model) {
      model.geo.computeBoundingBox();
      const b = model.geo.boundingBox!;
      const size = b.getSize(new THREE.Vector3());
      const c = b.getCenter(new THREE.Vector3());
      if (!model.geo.getAttribute('normal')) model.geo.computeVertexNormals();
      entry = { ...model, center: [c.x, c.y, c.z], extent: [Math.max(1e-4, size.x), Math.max(1e-4, size.y), Math.max(1e-4, size.z)] };
    }
    this.models.set(name, entry);
    if (this.parts.some((p) => p.model === name)) this.scheduleRebuild();
  }

  /** Forget the models that could not be had (one built since, or a read that failed): the next load asks again. */
  forgetFailedModels(): void {
    for (const [name, m] of this.models) if (!m) this.models.delete(name);
  }

  /** The ground the terrain should be sampled over: around what is drawn (see terrainExtent). */
  terrainBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return terrainExtent(this.frameParts);
  }

  /** Models arrive one after another: redraw a few times a second, not after each. */
  private scheduleRebuild(): void {
    if (this.rebuildTimer || this.disposed) return;
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = 0;
      if (!this.disposed) this.setParts(this.parts);
    }, 250);
  }

  setParts(parts: ScenePart[]): void {
    this.invalidate();
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = 0;
    for (const b of this.batches) {
      this.world.remove(b.mesh);
      b.mesh.dispose(); // its instance buffers
      if (!b.shared) b.mesh.geometry.dispose();
    }
    this.batches = [];
    if (this.ghostLines) {
      this.world.remove(this.ghostLines);
      this.ghostLines.geometry.dispose();
      (this.ghostLines.material as THREE.Material).dispose();
      this.ghostLines = null;
    }
    this.parts = parts;
    this.drawn = new Map();
    interface Group {
      proxy: Proxy;
      model: string | null;
      textured: boolean;
      material: string;
      alpha: string;
      idx: number[];
    }
    const groups = new Map<string, Group>();
    const ghosts: ScenePart[] = [];
    parts.forEach((p, i) => {
      if (p.transparency >= 0.98) return;
      const d = planPart(p, p.model ? this.models.get(p.model) : undefined, () => proxyFor(p));
      this.drawn.set(p, d);
      if (d.kind === 'ghost') {
        ghosts.push(p);
        return;
      }
      const spec = materialSpec(p.material);
      const see = p.transparency > 0.02 || spec.family === 'glass' || spec.family === 'forcefield';
      const alpha = see ? String(Math.round(p.transparency * 10)) : 'o';
      const key = `${d.model !== null ? `m:${d.model}` : d.proxy}|${d.textured ? 't' : ''}|${p.material}|${alpha}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { proxy: d.proxy, model: d.model, textured: d.textured, material: p.material, alpha, idx: [] }));
      g.idx.push(i);
    });
    const m4 = new THREE.Matrix4();
    for (const g of groups.values()) {
      const { proxy, material, idx } = g;
      const spec = materialSpec(material);
      const transparent = g.alpha !== 'o';
      const opacity = transparent ? Math.max(0.12, 1 - Number(g.alpha) / 10) : 1;
      const neon = spec.family === 'neon';
      const glassy = spec.family === 'glass' || spec.family === 'forcefield';
      const entry = g.model !== null ? this.models.get(g.model)! : null;
      const look = entry && g.textured ? `m:${g.model}` : proxy === 'rock' ? 'rock' : '';
      const matKey = `${look}|${material}|${g.alpha}`;
      let mat = this.materials.get(matKey);
      // A model read again (its texture is new) gets a new material.
      if (mat && entry && g.textured && mat.map !== entry.texture) {
        mat.dispose();
        mat = undefined;
      }
      if (mat) {
        // As it was made (below).
      } else if (entry && g.textured) {
        // The model's own colour map through its UVs, as Studio's SurfaceAppearance shows it (no tint).
        mat = new THREE.MeshStandardMaterial({
          map: entry.texture,
          color: 0xffffff,
          roughness: spec.family === 'smooth' ? 0.7 : spec.roughness,
          metalness: spec.metalness,
          transparent: transparent || glassy,
          opacity: glassy ? Math.min(opacity, 0.45) : opacity,
          depthWrite: !(transparent || glassy),
          alphaTest: entry.alpha ? 0.5 : 0,
          side: entry.alpha ? THREE.DoubleSide : THREE.FrontSide,
        });
      } else {
        mat = triplanarMaterial(
          {
            color: 0xffffff,
            roughness: spec.family === 'glass' ? 0.05 : spec.roughness,
            metalness: spec.metalness,
            map: neon || spec.family === 'smooth' || glassy ? null : detailTexture(spec.family),
            transparent: transparent || glassy,
            opacity: spec.family === 'glass' ? Math.min(opacity, 0.45) : spec.family === 'forcefield' ? 0.35 : opacity,
            depthWrite: !(transparent || glassy),
            flatShading: proxy === 'rock',
          },
          spec.tile,
        );
      }
      if (neon) {
        // Neon glows in its own color (emissive via onBeforeCompile would lose instance colors; boost instead).
        mat.toneMapped = false;
        mat.roughness = 0.4;
      }
      this.materials.set(matKey, mat);
      // Model instances share the model's geometry (fitted to each part by its matrix), so it outlives the batch.
      const geo = entry ? entry.geo : geometryFor(proxy);
      const mesh = new THREE.InstancedMesh(geo, mat, idx.length);
      mesh.castShadow = !transparent && !neon;
      mesh.receiveShadow = !neon;
      idx.forEach((pi, k) => {
        const p = parts[pi]!;
        partMatrix(m4, p, this.drawn.get(p)!, entry);
        mesh.setMatrixAt(k, m4);
        const c = g.textured ? new THREE.Color(1, 1, 1) : hex(p.color);
        if (neon) c.multiplyScalar(2.4);
        if (p.textured && proxy === 'foliage') c.offsetHSL(0, 0.05, 0.02);
        mesh.setColorAt(k, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.world.add(mesh);
      this.batches.push({ mesh, parts: idx, shared: !!entry });
    }
    if (ghosts.length) {
      const lines = new THREE.LineSegments(edgeGeometry(ghosts.map((p) => this.boxOf(p))), new THREE.LineBasicMaterial({ color: 0x8fa6bf, transparent: true, opacity: 0.3, depthWrite: false }));
      lines.frustumCulled = false;
      this.ghostLines = lines;
      this.world.add(lines);
    }
    // What the camera and the sun's shadow fit to: the robust box of what is really drawn (a few far props or a
    // stand-in slab must not stretch it).
    this.frameParts = parts.map((p) => {
      const d = this.drawn.get(p);
      return { cls: p.cls, name: p.name, parent: p.parent, pos: p.pos, size: d ? d.size : p.size, transparency: p.transparency, ghost: d?.kind === 'ghost' };
    });
    const cb = contentBox(this.frameParts);
    this.bounds.makeEmpty();
    if (cb) this.bounds.set(new THREE.Vector3(...cb.min), new THREE.Vector3(...cb.max));
    this.fitShadow();
  }

  setTerrain(t: TerrainData | null): void {
    this.invalidate();
    if (this.terrain) {
      this.world.remove(this.terrain);
      this.terrain.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
      this.terrain = null;
    }
    if (!t) return;
    const n = t.n;
    const dx = (t.maxX - t.minX) / (n - 1);
    const dz = (t.maxZ - t.minZ) / (n - 1);
    const colors = t.colors.map(hex);
    const isWater = (m: number) => t.names[m - 1] === 'Water';
    // Per cell: the ground (lowest solid interval), one floating mass above it (islands, arches,
    // overhangs), and a water surface. Voxel intervals come top-down.
    const groundTop = new Float32Array(n * n).fill(Number.NaN);
    const groundBottom = new Float32Array(n * n).fill(Number.NaN);
    const groundMat = new Uint8Array(n * n);
    const floatTop = new Float32Array(n * n).fill(Number.NaN);
    const floatBottom = new Float32Array(n * n).fill(Number.NaN);
    const floatMat = new Uint8Array(n * n);
    const waterTop = new Float32Array(n * n).fill(Number.NaN);
    for (let i = 0; i < n * n; i++) {
      const cell = t.cells[i];
      if (!cell?.length) continue;
      const solids = cell.filter((c) => !isWater(c.mat));
      const water = cell.find((c) => isWater(c.mat));
      if (water) waterTop[i] = water.top;
      const g = solids.at(-1);
      if (g) {
        groundTop[i] = g.top;
        groundBottom[i] = g.bottom;
        groundMat[i] = g.mat;
      }
      if (solids.length >= 2) {
        floatTop[i] = solids[0]!.top;
        floatBottom[i] = solids[0]!.bottom;
        floatMat[i] = solids[0]!.mat;
      }
    }
    const brk = Math.max(8, 2.5 * Math.max(dx, dz));
    // Two ground columns are one piece of terrain when their solid spans overlap: however steep the
    // slope between them (a FillBall mountain's flank), it is joined, not left as a hole with a wall.
    const joined = (a: number, b: number) => groundBottom[a]! <= groundTop[b]! + 0.5 && groundBottom[b]! <= groundTop[a]! + 0.5;
    const xAt = (x: number) => t.minX + x * dx;
    const zAt = (z: number) => t.minZ + z * dz;
    const tint = (m: number, x: number, z: number) => {
      const c = (colors[m - 1] ?? new THREE.Color(0x6a7f3f)).clone();
      const jitter = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      c.offsetHSL(0, 0, (jitter - 0.5) * 0.05);
      return c;
    };
    /**
     * A heightfield over the cells that have a value. Neighbors join when `link` says so (ground:
     * overlapping spans), otherwise only when their heights are close.
     */
    const surface = (h: Float32Array, mat: Uint8Array | null, flip: boolean, fixedColor?: THREE.Color, link?: (a: number, b: number) => boolean, shade = 1): THREE.BufferGeometry | null => {
      const pos: number[] = [];
      const col: number[] = [];
      const index: number[] = [];
      const vid = new Int32Array(n * n).fill(-1);
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const i = z * n + x;
          if (Number.isNaN(h[i]!)) continue;
          vid[i] = pos.length / 3;
          pos.push(xAt(x), h[i]!, zAt(z));
          const c = fixedColor ?? tint(mat ? mat[i]! : 0, x, z);
          col.push(c.r * shade, c.g * shade, c.b * shade);
        }
      const close = link
        ? (a: number, b: number, c: number) => link(a, b) && link(b, c) && link(a, c)
        : (a: number, b: number, c: number) => Math.max(h[a]!, h[b]!, h[c]!) - Math.min(h[a]!, h[b]!, h[c]!) < brk;
      for (let z = 0; z < n - 1; z++)
        for (let x = 0; x < n - 1; x++) {
          const a = z * n + x;
          const b = a + 1;
          const c = a + n;
          const d = c + 1;
          if (vid[a]! >= 0 && vid[b]! >= 0 && vid[c]! >= 0 && close(a, b, c)) index.push(...(flip ? [vid[a]!, vid[b]!, vid[c]!] : [vid[a]!, vid[c]!, vid[b]!]));
          if (vid[b]! >= 0 && vid[c]! >= 0 && vid[d]! >= 0 && close(b, c, d)) index.push(...(flip ? [vid[b]!, vid[d]!, vid[c]!] : [vid[b]!, vid[c]!, vid[d]!]));
        }
      if (!index.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(index);
      g.computeVertexNormals();
      return g;
    };
    /**
     * Vertical faces: where ground columns don't touch (a mass beside a lower one it isn't part of),
     * where terrain ends beside empty cells or the sampled area's edge (so an overhang or a slab shows
     * its side instead of being hollow), and the sides of floating masses.
     */
    const walls = (): THREE.BufferGeometry | null => {
      const pos: number[] = [];
      const col: number[] = [];
      const quad = (x0: number, z0: number, x1: number, z1: number, lo: number, hi: number, c: THREE.Color) => {
        if (hi - lo < 0.5) return;
        const v = [
          [x0, lo, z0], [x1, lo, z1], [x1, hi, z1],
          [x0, lo, z0], [x1, hi, z1], [x0, hi, z0],
        ];
        for (const p of v) {
          pos.push(p[0]!, p[1]!, p[2]!);
          col.push(c.r, c.g, c.b);
        }
        // Both windings so walls show from either side (their facing depends on which cell is higher).
        for (const p of [v[0], v[2], v[1], v[3], v[5], v[4]]) {
          pos.push(p![0]!, p![1]!, p![2]!);
          col.push(c.r, c.g, c.b);
        }
      };
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const i = z * n + x;
          // Terrain running into the sampled area's edge: close it with its side.
          if (!Number.isNaN(groundTop[i]!)) {
            const side = (ex0: number, ez0: number, ex1: number, ez1: number) => quad(ex0, ez0, ex1, ez1, groundBottom[i]!, groundTop[i]!, tint(groundMat[i]!, x, z).multiplyScalar(0.72));
            if (x === 0) side(xAt(0) - dx / 2, zAt(z) - dz / 2, xAt(0) - dx / 2, zAt(z) + dz / 2);
            if (x === n - 1) side(xAt(n - 1) + dx / 2, zAt(z) - dz / 2, xAt(n - 1) + dx / 2, zAt(z) + dz / 2);
            if (z === 0) side(xAt(x) - dx / 2, zAt(0) - dz / 2, xAt(x) + dx / 2, zAt(0) - dz / 2);
            if (z === n - 1) side(xAt(x) - dx / 2, zAt(n - 1) + dz / 2, xAt(x) + dx / 2, zAt(n - 1) + dz / 2);
          }
          for (const [nx, nz] of [[x + 1, z], [x, z + 1]] as const) {
            if (nx >= n || nz >= n) continue;
            const j = nz * n + nx;
            // The shared edge between the two cells, one cell wide, at their midpoint.
            const mx = (xAt(x) + xAt(nx)) / 2;
            const mz = (zAt(z) + zAt(nz)) / 2;
            const [ex0, ez0, ex1, ez1] = nx !== x ? [mx, mz - dz / 2, mx, mz + dz / 2] : [mx - dx / 2, mz, mx + dx / 2, mz];
            const gi = groundTop[i]!;
            const gj = groundTop[j]!;
            const hasI = !Number.isNaN(gi);
            const hasJ = !Number.isNaN(gj);
            if (hasI !== hasJ) {
              // Terrain beside empty cells: its whole side, bottom to top.
              const k = hasI ? i : j;
              quad(ex0, ez0, ex1, ez1, groundBottom[k]!, groundTop[k]!, tint(groundMat[k]!, x, z).multiplyScalar(0.72));
            } else if (hasI && hasJ && !joined(i, j)) {
              // Separate masses side by side: the higher one's side above the lower one.
              const k = gi > gj ? i : j;
              const lo = Math.max(Math.min(gi, gj), groundBottom[k]!);
              quad(ex0, ez0, ex1, ez1, lo, Math.max(gi, gj), tint(groundMat[k]!, x, z).multiplyScalar(0.82));
            }
            const fi = !Number.isNaN(floatTop[i]!);
            const fj = !Number.isNaN(floatTop[j]!);
            if (fi !== fj || (fi && fj && Math.abs(floatTop[i]! - floatTop[j]!) >= brk)) {
              const k = fi && (!fj || floatTop[i]! > floatTop[j]!) ? i : j;
              quad(ex0, ez0, ex1, ez1, floatBottom[k]!, floatTop[k]!, tint(floatMat[k]!, x, z).multiplyScalar(0.78));
            }
          }
        }
      if (!pos.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      return g;
    };
    const group = new THREE.Group();
    const solidMat = () => triplanarMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: detailTexture('grass') }, 10);
    const add = (g: THREE.BufferGeometry | null, material: THREE.Material, shadows: boolean) => {
      if (!g) return;
      const mesh = new THREE.Mesh(g, material);
      mesh.receiveShadow = true;
      mesh.castShadow = shadows;
      group.add(mesh);
    };
    add(surface(groundTop, groundMat, false, undefined, joined), solidMat(), true);
    // Its underside, for terrain that hangs over nothing (overhangs, floating slabs, cliff edges).
    add(surface(groundBottom, groundMat, true, undefined, joined, 0.55), solidMat(), true);
    add(surface(floatTop, floatMat, false), solidMat(), true);
    add(surface(floatBottom, floatMat, true), solidMat(), true);
    add(walls(), triplanarMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, map: detailTexture('slate'), side: THREE.FrontSide }, 10), true);
    add(surface(waterTop, null, false, hex(t.waterColor)), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.72, roughness: 0.08, metalness: 0.1 }), false);
    if (!group.children.length) return;
    this.terrain = group;
    this.world.add(group);
    const tb = new THREE.Box3().setFromObject(group);
    if (this.bounds.isEmpty()) this.bounds.copy(tb);
    this.fitShadow();
  }

  /** Frame an explicit pose (e.g. a saved view). */
  frame(pose: CameraPose): void {
    this.camera.position.set(...pose.pos);
    this.cam.lookAt(new THREE.Vector3(...pose.look));
  }

  /**
   * Frame the place's meaningful content from an elevated three-quarter view: its StartGrid, else its
   * SpawnLocation (when it lies within the build), else the robust box of what is drawn (see framing.ts).
   * Studio's own camera is not used — it can point anywhere (agents move it for screenshots). Stand-in slabs,
   * huge baseplates and far outliers don't pull the view off the build.
   */
  frameMap(glide = false): void {
    this.glide = glide;
    const f = frameScene(this.frameParts);
    if (f) {
      this.lookFrom(new THREE.Vector3(...f.target), f.radius);
      return;
    }
    if (this.bounds.isEmpty()) return;
    const c = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const d = Math.min(Math.max(size.x, size.z, 60), 900);
    this.lookFrom(new THREE.Vector3(c.x, this.bounds.min.y + Math.min(size.y, 60) * 0.3, c.z), d * 0.6);
  }

  private glide = false;

  private lookFrom(target: THREE.Vector3, radius: number): void {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fit = Math.min(4000, (radius / Math.sin(fov / 2)) * 0.85);
    const elev = THREE.MathUtils.degToRad(32);
    const azim = THREE.MathUtils.degToRad(40);
    const pos = new THREE.Vector3(target.x + fit * Math.cos(elev) * Math.sin(azim), target.y + fit * Math.sin(elev), target.z + fit * Math.cos(elev) * Math.cos(azim));
    if (this.glide) {
      this.cam.flyTo(pos, target, 0.6);
    } else {
      this.camera.position.copy(pos);
      this.cam.lookAt(target);
    }
    this.glide = false;
  }

  pick(clientX: number, clientY: number): ScenePart | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(this.batches.map((b) => b.mesh), false)[0];
    if (!hit || hit.instanceId == null) return null;
    const batch = this.batches.find((b) => b.mesh === hit.object);
    const idx = batch?.parts[hit.instanceId];
    return idx == null ? null : (this.parts[idx] ?? null);
  }

  /** JPEG of the current frame (for project thumbnails). */
  snapshot(width = 640): string | null {
    try {
      this.composer.render();
      const src = this.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = width;
      c.height = Math.round((src.height / src.width) * width);
      c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    } catch {
      return null;
    }
  }

  partCount(): number {
    return this.parts.length;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.seen.dispose();
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.rebuildTimer);
    this.setParts([]);
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.models.clear();
    this.setTerrain(null);
    this.cam.dispose();
    this.select(null);
    this.setPlaceLights([]);
    this.sky.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    // Free the WebGL context now: browsers cap live contexts, and switching pages creates new viewers.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
