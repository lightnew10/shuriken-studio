import * as THREE from 'three';
import type { Xform } from '@shared/rig';
import type { RenderInstance } from '@shared/render';
import { instancedMeshes } from './instances';
import { watchVisibility, type Visibility } from '../scene/visibility';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** A model (or one part of an assembly) to show: its GLB as a data: URL and how it looks. */
export interface ModelPart {
  url: string;
  color?: number | string;
  /** Enum.Material name */
  material?: string;
  /** Where its centre sits in its assembly (Y-up studs). */
  origin?: [number, number, number];
  /** A mesh used many times: drawn once per use (instanced), at its position, turned and scaled; `origin` is then ignored. */
  instances?: RenderInstance[];
  /** A rigged model's part: the segment (joint) it moves with (see pose()). */
  segment?: string;
}

/** A preview material close to Roblox's: Neon glows, metals shine, Glass is see-through, stone and wood are matte. */
function materialFor(color: number | string, material: string | undefined, wireframe: boolean): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color);
  const m = (material ?? '').toLowerCase();
  const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0.05, wireframe });
  if (m === 'neon') {
    mat.emissive = c.clone();
    mat.emissiveIntensity = 1.6;
    mat.roughness = 0.4;
  } else if (/metal|diamondplate|foil/.test(m)) {
    mat.metalness = 0.75;
    mat.roughness = 0.35;
  } else if (m === 'glass' || m === 'forcefield') {
    mat.transparent = true;
    mat.opacity = 0.45;
    mat.roughness = 0.08;
  } else if (/wood|slate|rock|brick|concrete|cobble|granite|sand|fabric|grass|ground|marble|basalt|limestone|pavement/.test(m)) {
    mat.roughness = 0.88;
  } else if (/smoothplastic|plastic/.test(m)) mat.roughness = 0.45;
  return mat;
}

/**
 * A part whose GLB carries texture maps (a textured Blender/Kiln material) keeps them on the preview
 * material, the way a SurfaceAppearance does in Roblox; an untextured part uses the plain one.
 */
function textured(plain: THREE.MeshStandardMaterial, own: THREE.MeshStandardMaterial | undefined): THREE.MeshStandardMaterial {
  if (!own || !(own.map || own.normalMap || own.roughnessMap || own.emissiveMap)) return plain;
  const m = plain.clone();
  m.map = own.map;
  m.normalMap = own.normalMap;
  m.roughnessMap = own.roughnessMap;
  m.metalnessMap = own.metalnessMap;
  if (own.emissiveMap) {
    m.emissiveMap = own.emissiveMap;
    m.emissive.set(0xffffff);
    m.emissiveIntensity = own.emissiveIntensity;
  }
  if (own.map) m.color.set(0xffffff);
  if (own.roughnessMap) m.roughness = 1;
  if (own.metalnessMap) m.metalness = 1;
  m.needsUpdate = true;
  own.dispose();
  return m;
}

/** A default Roblox character (R15, blocky) is about this many studs tall. */
export const PLAYER_HEIGHT = 5.2;

/** A blocky player, feet at the origin, facing +z: legs 2, torso 2, head 1.2 studs; 4 studs across the arms. */
function playerFigure(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0x71869c, roughness: 0.75 });
  const head = new THREE.MeshStandardMaterial({ color: 0x93a6ba, roughness: 0.7 });
  const part = (w: number, h: number, d: number, x: number, y: number, mat: THREE.Material, r = 0.12) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat);
    m.position.set(x, y, 0);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };
  part(0.96, 2, 1, -0.5, 1, body);
  part(0.96, 2, 1, 0.5, 1, body);
  part(2, 2, 1, 0, 3, body);
  part(0.96, 2, 1, -1.5, 3, body);
  part(0.96, 2, 1, 1.5, 3, body);
  part(1.2, 1.18, 1.2, 0, 4.61, head, 0.34);
  return g;
}

/**
 * Preview of a model (the GLB parts Shuriken exports from Blender): studio lighting, a floor that
 * shows its footprint and scale (1-stud grid), orbit on drag, zoom on wheel, optional slow turntable,
 * and optionally a player standing beside it so its size in the game is obvious.
 */
/** Frees the meshes of a tree: geometry, materials and their maps. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: THREE.MeshStandardMaterial) => {
        for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.emissiveMap]) t?.dispose();
        m.dispose();
      });
    }
  });
}

export class ModelView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
  private readonly holder = new THREE.Group();
  private readonly figure = playerFigure();
  /** The loaded model's size (it stands centered on the origin); null when nothing is loaded. */
  private modelSize: THREE.Vector3 | null = null;
  /** Parts of a rigged model, to move with their segments. */
  private posable: Array<{ obj: THREE.Object3D; segment: string; origin: [number, number, number] }> = [];
  private readonly grid: THREE.GridHelper;
  /** The room a bare view's model reflects (icons). */
  private env: THREE.Texture | null = null;
  private readonly ro: ResizeObserver;
  private raf = 0;
  /** Something changed since the last frame drawn (see invalidate). */
  private dirty = true;
  private seen: Visibility | null = null;
  private disposed = false;
  /** Counts loads: a load overtaken by a newer one (another model picked while its parts parse) is dropped. */
  private loads = 0;
  private az = 0.7;
  private el = 0.42;
  private dist = 10;
  private zoom = 1;
  private radius = 2;
  private readonly target = new THREE.Vector3();
  private last = performance.now();
  wireframe = false;
  private frameFn: ((dt: number) => void) | null = null;

  /** Called every frame before drawing (a player animating a rigged model): the view draws every frame while set. */
  get onFrame(): ((dt: number) => void) | null {
    return this.frameFn;
  }
  set onFrame(fn: ((dt: number) => void) | null) {
    this.frameFn = fn;
    this.invalidate();
  }

  constructor(private readonly host: HTMLElement, private readonly opts: { interactive?: boolean; turntable?: boolean; player?: boolean; still?: boolean; /** Nothing but the model: no floor grid, a transparent background (a UI icon). */ bare?: boolean } = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !opts.still || !!opts.bare, powerPreference: 'low-power' });
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    Object.assign(this.renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });
    host.appendChild(this.renderer.domElement);
    const hemi = new THREE.HemisphereLight(0xfff4ea, 0x2a2521, 1.5);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-4, 8, -5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    const rim = new THREE.DirectionalLight(0xffb27a, 0.9);
    rim.position.set(5, 3, 6);
    this.scene.add(hemi, key, rim, key.target, this.holder);
    this.grid = new THREE.GridHelper(20, 20, 0x3a332d, 0x2b2622);
    this.figure.visible = false;
    this.scene.add(this.grid, this.figure);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    if (opts.interactive) this.bindOrbit();
    this.resize();
    if (opts.bare) {
      this.grid.visible = false;
      this.renderer.setClearColor(0x000000, 0);
      // An icon is seen small, on a coloured panel: a room to reflect (metal with nothing around it draws
      // black) and a brighter exposure than the preview's moody stage.
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      this.scene.environment = this.env;
      this.scene.environmentIntensity = 0.85;
      this.renderer.toneMappingExposure = 1.25;
    }
    // A still view (pictures for agents) draws only when asked, on a solid background (a bare one on none).
    if (opts.still) {
      if (!opts.bare) this.scene.background = new THREE.Color(0x1b1714);
    } else {
      // Drawn when something changes or the user turns it, every frame while it turns or animates, never unseen.
      this.seen = watchVisibility(host, () => this.invalidate());
      this.invalidate();
    }
  }

  /** Something changed: draw it on the next frame. */
  invalidate(): void {
    this.dirty = true;
    if (this.raf || this.disposed || this.opts.still) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Looks from an angle (azimuth and elevation in radians), with the player re-placed beside the model for it. */
  setView(az: number, el: number): void {
    this.az = az;
    this.el = el;
    this.zoom = 1;
    this.frame();
  }

  /** Draws one frame now and returns the canvas (read it before yielding: the buffer isn't kept). */
  renderNow(): HTMLCanvasElement {
    this.resize();
    this.place();
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }

  /** Shows a model from GLB bytes (a data: URL); null clears it. */
  async load(url: string | null, color: number | string = 0xd8cdc2, material?: string): Promise<{ triangles: number } | null> {
    return this.loadParts(url ? [{ url, color, material }] : []);
  }

  /**
   * Shows one model, or the parts of an assembly each at its origin, in their own colours and
   * materials (Neon glows, Metal shines, Glass is see-through); the whole stands on the floor, centred.
   */
  async loadParts(parts: ModelPart[]): Promise<{ triangles: number } | null> {
    const seq = ++this.loads;
    this.clear();
    if (!parts.length) return null;
    const group = new THREE.Group();
    let triangles = 0;
    for (const part of parts) {
      // Decode the data: URL here (the app's content policy doesn't allow fetching data: URLs).
      const bin = atob(part.url.slice(part.url.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
      if (this.disposed) return null;
      if (seq !== this.loads) {
        // A newer load started while this one parsed: drawing both put two models on top of each other.
        disposeTree(gltf.scene);
        disposeTree(group);
        return null;
      }
      const mat = materialFor(part.color ?? 0xd8cdc2, part.material, this.wireframe);
      gltf.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.material = textured(mat, o.material as THREE.MeshStandardMaterial);
          o.castShadow = true;
          o.receiveShadow = true;
          const idx = o.geometry.getIndex();
          if (!part.instances?.length) triangles += idx ? idx.count / 3 : o.geometry.getAttribute('position').count / 3;
        }
      });
      if (part.instances?.length) {
        // Every use of the mesh, as one instanced mesh (a map's thousand trees are one draw call).
        const drawn = instancedMeshes(gltf.scene, part.instances);
        drawn.group.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        triangles += drawn.triangles;
        group.add(drawn.group);
        continue;
      }
      if (part.origin) gltf.scene.position.set(part.origin[0], part.origin[1], part.origin[2]);
      if (part.segment) this.posable.push({ obj: gltf.scene, segment: part.segment, origin: part.origin ?? [0, 0, 0] });
      group.add(gltf.scene);
    }
    // Stand it on the floor, centred.
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    group.position.set(-center.x, -box.min.y, -center.z);
    this.holder.add(group);
    this.modelSize = size;
    this.zoom = 1;
    this.frame();
    return { triangles };
  }

  /**
   * Poses a rigged model: each part moved by its segment's transform from rest (model space, as
   * @shared/rig's forwardKinematics gives them); null puts it back at rest. The floor and framing stay.
   */
  pose(xforms: Map<string, Xform> | null): void {
    this.invalidate();
    for (const p of this.posable) {
      const x = xforms?.get(p.segment);
      if (!x) {
        p.obj.matrixAutoUpdate = true;
        p.obj.position.set(...p.origin);
        p.obj.quaternion.identity();
        continue;
      }
      const r = x.r;
      const m = new THREE.Matrix4().set(r[0]!, r[1]!, r[2]!, x.t[0], r[3]!, r[4]!, r[5]!, x.t[1], r[6]!, r[7]!, r[8]!, x.t[2], 0, 0, 0, 1);
      m.multiply(new THREE.Matrix4().makeTranslation(p.origin[0], p.origin[1], p.origin[2]));
      p.obj.matrixAutoUpdate = false;
      p.obj.matrix.copy(m);
      p.obj.matrixWorldNeedsUpdate = true;
    }
  }

  /** Shows or hides the player standing beside the model (it frames both). */
  setPlayer(on: boolean): void {
    this.opts.player = on;
    this.frame();
  }

  /**
   * Places the player beside the model, to the right as seen from the camera right now, and frames
   * what's shown: the grid covers it and the camera fits it.
   */
  private frame(): void {
    const size = this.modelSize;
    const show = !!size && !!this.opts.player;
    this.figure.visible = show;
    const box = new THREE.Box3();
    if (size) box.set(new THREE.Vector3(-size.x / 2, 0, -size.z / 2), new THREE.Vector3(size.x / 2, size.y, size.z / 2));
    else box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
    if (show) {
      // The camera's right, flat on the floor; the player faces the camera, turned a little toward the model.
      const right = new THREE.Vector3(-Math.cos(this.az), 0, -Math.sin(this.az));
      const across = Math.abs(right.x) * (size.x / 2) + Math.abs(right.z) * (size.z / 2);
      const gap = 0.8 + 0.06 * Math.max(size.x, size.z);
      this.figure.position.copy(right).multiplyScalar(across + gap + 2.1);
      this.figure.rotation.y = Math.PI - this.az - 0.3;
      this.figure.updateMatrixWorld(true);
      box.union(new THREE.Box3().setFromObject(this.figure));
    }
    const span = box.getSize(new THREE.Vector3());
    this.radius = Math.max(0.5, span.length() / 2);
    box.getCenter(this.target);
    const reach = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
    const cells = Math.max(4, Math.min(400, Math.ceil(reach * 2 * 1.3)));
    this.grid.scale.setScalar(cells / 20);
    this.resize();
  }

  setWireframe(on: boolean): void {
    this.invalidate();
    this.wireframe = on;
    this.holder.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.MeshStandardMaterial).wireframe = on;
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.seen?.dispose();
    this.ro.disconnect();
    this.clear();
    this.figure.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.env?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private clear(): void {
    this.invalidate();
    this.modelSize = null;
    this.posable = [];
    this.figure.visible = false;
    for (const c of [...this.holder.children]) {
      this.holder.remove(c);
      disposeTree(c);
    }
  }

  private resize(): void {
    this.invalidate();
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const fit = this.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.min(1, w / h);
    this.dist = fit * 1.08 * this.zoom;
    this.camera.near = Math.max(0.01, this.dist / 200);
    this.camera.far = this.dist * 20;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    // Unseen: nothing is drawn, and it draws again when it shows (watchVisibility).
    if (this.seen && !this.seen.visible()) return;
    const moving = !!this.opts.turntable || !!this.frameFn;
    if (!moving && !this.dirty) return;
    const now = performance.now();
    // A turntable alone turns slowly: thirty frames a second show it as smoothly as sixty, for half the GPU.
    if (this.dirty || this.frameFn || now - this.last >= 30) {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.dirty = false;
      this.frameFn?.(dt);
      if (this.opts.turntable) this.az += dt * 0.35;
      this.place();
      this.renderer.render(this.scene, this.camera);
    }
    if (moving && !this.raf) this.raf = requestAnimationFrame(this.loop);
  };

  private place(): void {
    const c = Math.cos(this.el);
    this.camera.position.set(this.target.x + Math.sin(this.az) * c * this.dist, this.target.y + Math.sin(this.el) * this.dist, this.target.z - Math.cos(this.az) * c * this.dist);
    this.camera.lookAt(this.target);
  }

  private bindOrbit(): void {
    const el = this.renderer.domElement;
    let drag: { x: number; y: number } | null = null;
    el.style.cursor = 'grab';
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.az += (e.clientX - drag.x) * 0.008;
      this.el = Math.max(-0.3, Math.min(1.45, this.el + (e.clientY - drag.y) * 0.006));
      drag = { x: e.clientX, y: e.clientY };
      this.invalidate();
    });
    const end = () => {
      drag = null;
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = Math.max(0.25, Math.min(6, this.zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
        this.resize();
      },
      { passive: false },
    );
  }
}
