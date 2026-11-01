import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { JOINTS, R15_RIG, REST_FOOT_LOW, clipDuration, sampleClip, solveRig, type AnimationClip, type Joint, type Xf } from '@shared/animation';
import { watchVisibility, type Visibility } from '../scene/visibility';
import { themeColor } from '../../lib/appearance';

type Part = Joint | 'HumanoidRootPart';

const BODY = 0xd8cdc2;
/** The torso wears the theme's colour (read when the mannequin is made). */
const torso = () => new THREE.Color(themeColor('accent'));
const HEAD = 0xe9e0d6;
const BLADE_LEN = 3.4;

function flashTexture(): THREE.Texture {
  const n = 64;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,240,210,0.8)');
  grd.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, n, n);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 2;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    g.beginPath();
    g.moveTo(n / 2 + Math.cos(a) * 6, n / 2 + Math.sin(a) * 6);
    g.lineTo(n / 2 + Math.cos(a) * 30, n / 2 + Math.sin(a) * 30);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Part transform → a three.js matrix (the rig stands with its feet on y = 0). */
function toMatrix(x: Xf, m: THREE.Matrix4): THREE.Matrix4 {
  const r = x.r;
  return m.set(r[0], r[1], r[2], x.p[0], r[3], r[4], r[5], x.p[1] - REST_FOOT_LOW, r[6], r[7], r[8], x.p[2], 0, 0, 0, 1);
}

export interface MannequinOptions {
  /** Drag to orbit and wheel to zoom. */
  interactive?: boolean;
  /** Smaller shadow map and no antialias tweaks, and thirty frames a second, for dashboard tiles. */
  compact?: boolean;
}

/**
 * A default R15 mannequin playing an animation clip with the same kinematics Roblox uses (the shared
 * solver is checked against rigs measured in Studio). Combat clips get a sword whose swing leaves a
 * short trail, so arcs and timing read at a glance.
 */
export class MannequinView {
  /** The sword trail's colour: the theme's light accent. */
  private readonly trailColor = new THREE.Color(themeColor('accent2', '#ffb454'));
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  private readonly parts = new Map<Part, THREE.Mesh>();
  private readonly sword = new THREE.Group();
  private readonly trail: THREE.Mesh;
  private readonly trailPts: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  /** Unarmed clips: which hand or foot the trail follows, and where each was last frame. */
  private trailLimb: Part | null = null;
  private readonly limbPos = new Map<Part, THREE.Vector3>();
  /** A flash where the strike lands, each time playback passes a "Hit" marker. */
  private readonly flash: THREE.Sprite;
  private flashAge = Infinity;
  private readonly ro: ResizeObserver;
  private readonly seen: Visibility;
  /** Frames still to draw after a change (a trail and a flash fade out over a few). */
  private settle = 0;
  private raf = 0;
  private last = performance.now();
  private clip: AnimationClip | null = null;
  private duration = 0;
  private hold = 0;
  private az = 0.62;
  private el = 0.16;
  private dist = 13;
  private zoom = 1;
  private readonly target = new THREE.Vector3(0, 2.7, 0);
  private disposed = false;
  time = 0;
  private play = true;
  get playing(): boolean {
    return this.play;
  }
  set playing(on: boolean) {
    this.play = on;
    this.invalidate();
  }
  speed = 1;
  /** Replay one-shot clips after a short pause. */
  repeat = true;
  onTime: ((t: number) => void) | null = null;

  constructor(private readonly host: HTMLElement, private readonly opts: MannequinOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    host.appendChild(this.renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xfff4ea, 0x2a2521, 1.6);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-5, 9, -6);
    key.castShadow = true;
    const size = opts.compact ? 512 : 1024;
    key.shadow.mapSize.set(size, size);
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 7;
    key.shadow.camera.bottom = -2;
    key.shadow.radius = 4;
    key.shadow.bias = -0.0005;
    const rim = new THREE.DirectionalLight(0xffb27a, 1.1);
    rim.position.set(6, 5, 7);
    this.scene.add(hemi, key, rim);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(7, 64), new THREE.MeshStandardMaterial({ color: 0x1d1916, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const grid = new THREE.PolarGridHelper(7, 12, 6, 64, 0x3a332d, 0x2b2622);
    grid.position.y = 0.002;
    this.scene.add(floor, grid);

    for (const part of ['HumanoidRootPart', ...JOINTS] as Part[]) {
      if (part === 'HumanoidRootPart') continue;
      const [sx, sy, sz] = R15_RIG.sizes[part];
      const radius = part === 'Head' ? 0.32 : Math.min(sx, sy, sz) * 0.22;
      const color = part === 'UpperTorso' || part === 'LowerTorso' ? torso() : part === 'Head' ? HEAD : BODY;
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(sx, sy, sz, 3, radius), new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.02 }));
      mesh.castShadow = true;
      mesh.matrixAutoUpdate = false;
      this.parts.set(part, mesh);
      this.scene.add(mesh);
      if (part === 'Head') {
        // A visor shows which way the rig faces (-Z).
        const visor = new THREE.Mesh(new RoundedBoxGeometry(0.78, 0.22, 0.12, 2, 0.05), new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.3 }));
        visor.position.set(0, 0.1, -sz / 2 - 0.02);
        mesh.add(visor);
      }
    }

    // Sword: grip at the hand's grip point, blade along the hand's -Z.
    const steel = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.25, metalness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a211b, roughness: 0.7 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.26, BLADE_LEN), steel);
    blade.position.z = -BLADE_LEN / 2 - 0.35;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.8, 0.14), dark);
    guard.position.z = -0.3;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.7), dark);
    handle.position.z = 0.05;
    for (const m of [blade, guard, handle]) m.castShadow = true;
    this.sword.add(blade, guard, handle);
    this.sword.position.set(0, -0.15, 0);
    this.sword.visible = false;
    this.parts.get('RightHand')!.add(this.sword);

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 24 * 3), 3));
    trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(2 * 24 * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < 23; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    trailGeo.setIndex(idx);
    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: flashTexture(), color: 0xffd9a0, blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }),
    );
    this.flash.renderOrder = 998;
    this.flash.visible = false;
    this.scene.add(this.flash);
    this.trail = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    // Tiles: frame feet to a raised head (arms up, jumps) above the label strip along the bottom.
    if (opts.compact) this.target.y = 2.7;
    this.pose(0);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    // Drawn while a clip plays or after a change, never while it can't be seen.
    this.seen = watchVisibility(host, () => this.invalidate());
    if (opts.interactive) this.bindOrbit();
    this.resize();
    this.invalidate();
  }

  /** Something changed: draw it (and the few frames its trail takes to fade). */
  private invalidate(): void {
    this.settle = 30;
    if (this.raf || this.disposed) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * `under`: a looping clip playing beneath (a run under an upper-body move): the clip's keyed joints
   * win and the rest come from it, joint by joint, as Roblox layers a higher-priority track.
   */
  setClip(clip: AnimationClip | null, opts: { sword?: boolean | 'left' | 'right'; keepTime?: boolean; under?: AnimationClip | null } = {}): void {
    this.clip = clip;
    this.under = opts.under ?? null;
    this.duration = clip ? clipDuration(clip) : 0;
    this.sword.visible = !!opts.sword;
    const hand = this.parts.get(opts.sword === 'left' ? 'LeftHand' : 'RightHand')!;
    if (this.sword.parent !== hand) hand.add(this.sword);
    this.trailPts.length = 0;
    this.limbPos.clear();
    this.trailLimb = null;
    if (!opts.keepTime) this.time = 0;
    this.time = Math.min(this.time, this.duration);
    this.hold = 0;
    this.pose(this.time);
    this.invalidate();
  }

  /**
   * Stills of the clip at the given times (data URLs, w×h), rendered from a fixed three-quarter view
   * in one tick; the live pose is restored afterwards.
   */
  snapshots(times: number[], w = 160, h = 200): string[] {
    if (!this.clip) return [];
    const trail = this.trail.visible;
    this.trail.visible = false;
    const flash = this.flash.visible;
    this.flash.visible = false;
    const saved = { az: this.az, el: this.el, dist: this.dist };
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d')!;
    const src = this.renderer.domElement;
    const out: string[] = [];
    for (const t of times) {
      this.pose(t);
      this.az = 0.62;
      this.el = 0.16;
      this.placeCamera();
      this.renderer.render(this.scene, this.camera);
      // Crop the middle of the stage to the frame's aspect, then scale down.
      const sh = src.height;
      const sw = Math.min(src.width, (sh * w) / h);
      g.clearRect(0, 0, w, h);
      g.drawImage(src, (src.width - sw) / 2, 0, sw, sh, 0, 0, w, h);
      out.push(off.toDataURL('image/png'));
    }
    Object.assign(this, saved);
    this.trail.visible = trail;
    this.flash.visible = flash;
    this.pose(this.time);
    // The stills were drawn on the live canvas.
    this.invalidate();
    return out;
  }

  /** Holds the clip at `at` of its length (the calm dashboard), or plays again. */
  setStill(on: boolean, at = 0.4): void {
    this.playing = !on;
    if (on) this.seek(this.duration * at);
    else this.invalidate();
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.hold = 0;
    this.trailPts.length = 0;
    this.limbPos.clear();
    this.trailLimb = null;
    this.pose(this.time);
    this.onTime?.(this.time);
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.seen.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private under: AnimationClip | null = null;

  private pose(t: number): void {
    const top = this.clip ? sampleClip({ ...this.clip, loop: false }, t) : {};
    const frames = solveRig(this.under ? { ...sampleClip({ ...this.under, loop: true }, t), ...top } : top);
    const m = new THREE.Matrix4();
    for (const [part, mesh] of this.parts) {
      mesh.matrix.copy(toMatrix(frames[part], m));
      mesh.matrixWorldNeedsUpdate = true;
    }
  }

  /** Starts the hit flash at the striking limb: the hand or raised foot furthest in front. */
  private hitFlash(t: number): void {
    if (!this.clip) return;
    const f = solveRig(sampleClip({ ...this.clip, loop: false }, t));
    const limbs = ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot'] as const;
    let best: (typeof limbs)[number] = 'RightHand';
    for (const l of limbs) {
      if (l.endsWith('Foot') && f[l].p[1] - REST_FOOT_LOW < 0.8) continue;
      if (-f[l].p[2] > -f[best].p[2]) best = l;
    }
    // With a sword, the blade's far end lands the hit, not the fist.
    const at = new THREE.Vector3(f[best].p[0], f[best].p[1] - REST_FOOT_LOW, f[best].p[2]);
    if (this.sword.visible && best.endsWith('Hand')) {
      this.sword.updateMatrixWorld(true);
      at.copy(new THREE.Vector3(0, 0, -BLADE_LEN * 0.8).applyMatrix4(this.sword.matrixWorld));
    }
    this.flash.position.copy(at);
    this.flashAge = 0;
  }

  private updateFlash(dt: number): void {
    const life = 0.16;
    if (this.flashAge >= life) {
      this.flash.visible = false;
      return;
    }
    this.flashAge += dt;
    const k = Math.min(1, this.flashAge / life);
    this.flash.visible = true;
    this.flash.scale.setScalar(0.6 + k * 1.8);
    (this.flash.material as THREE.SpriteMaterial).opacity = (1 - k) * 0.95;
  }

  private updateTrail(): void {
    const geo = this.trail.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    let a: THREE.Vector3;
    let b: THREE.Vector3;
    if (this.sword.visible) {
      this.sword.updateMatrixWorld(true);
      a = new THREE.Vector3(0, 0, -1.2).applyMatrix4(this.sword.matrixWorld);
      b = new THREE.Vector3(0, 0, -BLADE_LEN - 0.35).applyMatrix4(this.sword.matrixWorld);
    } else {
      // Unarmed: a short ribbon follows the fastest hand or foot, so punches and kicks read like swings.
      const limbs: Part[] = ['RightHand', 'LeftHand', 'RightFoot', 'LeftFoot'];
      const moved = new Map<Part, number>();
      for (const l of limbs) {
        const at = new THREE.Vector3().setFromMatrixPosition(this.parts.get(l)!.matrix);
        const before = this.limbPos.get(l);
        moved.set(l, before ? at.distanceTo(before) : 0);
        this.limbPos.set(l, at);
      }
      let fastest: Part = limbs.reduce((x, y) => (moved.get(y)! > moved.get(x)! ? y : x));
      // Stay on the limb being followed unless another clearly takes over (no flicker mid-strike).
      if (this.trailLimb && moved.get(this.trailLimb)! >= moved.get(fastest)! * 0.67) fastest = this.trailLimb;
      if (fastest !== this.trailLimb) {
        this.trailLimb = fastest;
        this.trailPts.length = 0;
      }
      const m = this.parts.get(fastest)!.matrix;
      const center = new THREE.Vector3().setFromMatrixPosition(m);
      const up = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize().multiplyScalar(0.22);
      a = center.clone().sub(up);
      b = center.clone().add(up);
    }
    this.trailPts.unshift({ a, b });
    if (this.trailPts.length > 24) this.trailPts.length = 24;
    const n = this.trailPts.length;
    const accent = this.trailColor;
    for (let i = 0; i < 24; i++) {
      const p = this.trailPts[Math.min(i, n - 1)]!;
      pos.setXYZ(2 * i, p.a.x, p.a.y, p.a.z);
      pos.setXYZ(2 * i + 1, p.b.x, p.b.y, p.b.z);
      // Fades along its length; only fast swings leave a visible trail.
      const next = this.trailPts[Math.min(i + 1, n - 1)]!;
      const speed = Math.min(1, next.b.distanceTo(p.b) * 3);
      const f = (1 - i / 24) * speed * 0.55;
      col.setXYZ(2 * i, accent.r * f * 0.3, accent.g * f * 0.3, accent.b * f * 0.3);
      col.setXYZ(2 * i + 1, accent.r * f, accent.g * f, accent.b * f);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.trail.visible = n > 2;
  }

  private loop = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    const now = performance.now();
    // A dashboard tile draws thirty frames a second: the same motion for half the work.
    if (this.opts.compact && now - this.last < 30) {
      this.raf = requestAnimationFrame(this.loop);
      return;
    }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    // Unseen: nothing is drawn, and it draws again when it shows (watchVisibility).
    if (!this.seen.visible()) return;
    const animating = !!this.clip && this.playing && this.duration > 0;
    if (this.clip && animating) {
      if (this.hold > 0) {
        this.hold -= dt;
        if (this.hold <= 0) {
          this.time = 0;
          this.trailPts.length = 0;
          this.limbPos.clear();
          this.trailLimb = null;
        }
      } else {
        const before = this.time;
        this.time += dt * this.speed;
        for (const mk of this.clip.markers ?? []) if (/hit|impact|strike/i.test(mk.name) && before < mk.t && this.time >= mk.t) this.hitFlash(mk.t);
        if (this.time >= this.duration) {
          if (this.clip.loop) this.time %= this.duration;
          else if (this.repeat) {
            this.time = this.duration;
            this.hold = 0.7;
          } else {
            this.time = this.duration;
            this.playing = false;
          }
        }
      }
      this.pose(this.time);
      this.onTime?.(this.time);
    }
    this.updateTrail();
    this.updateFlash(dt * (this.playing ? this.speed : 1));
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
    this.settle = animating ? 30 : this.settle - 1;
    if (this.settle > 0 && !this.raf) this.raf = requestAnimationFrame(this.loop);
  };

  private placeCamera(): void {
    // The rig faces -Z: az 0 looks at its front.
    const c = Math.cos(this.el);
    this.camera.position.set(this.target.x + Math.sin(this.az) * c * this.dist, this.target.y + Math.sin(this.el) * this.dist, this.target.z - Math.cos(this.az) * c * this.dist);
    this.camera.lookAt(this.target);
  }

  private resize(): void {
    this.invalidate();
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole body in frame in narrow tiles.
    const base = this.opts.compact ? 16.5 : 14;
    this.dist = (w / h < 0.9 ? (base / Math.max(0.55, w / h)) * 0.9 : base) * this.zoom;
    this.camera.updateProjectionMatrix();
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
      this.el = Math.max(-0.2, Math.min(1.2, this.el + (e.clientY - drag.y) * 0.006));
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
        const k = e.deltaY > 0 ? 1.1 : 0.9;
        const next = Math.max(5, Math.min(26, this.dist * k));
        this.zoom *= next / this.dist;
        this.dist = next;
        this.invalidate();
      },
      { passive: false },
    );
  }
}
