import * as THREE from 'three';

/** Roblox Studio camera settings (File → Studio Settings → Studio → Camera). */
export interface StudioCameraSettings {
  /** "Camera Speed" multiplier. */
  speed: number;
  /** "Camera Shift Speed": multiplier while Shift is held (slower = precise). */
  shiftFactor: number;
  /** Studs the wheel flies per notch at Camera Speed 1 (times the speed, the right-drag + wheel multiplier and Shift). */
  wheelStuds: number;
  /** "Camera Pan Speed" / pan sensitivity. */
  panSensitivity: number;
  /** Orbit/look sensitivity. */
  lookSensitivity: number;
  /** "Camera Zoom to Mouse Position": the wheel flies toward the mouse instead of straight ahead. */
  zoomToMouse: boolean;
}

/** Default camera feel, as set in Studio's GlobalSettings_13.xml on a typical setup: Camera Speed 1.5, Shift 0.2, zoom to mouse. */
export const STUDIO_CAMERA: StudioCameraSettings = { speed: 1.5, shiftFactor: 0.2, wheelStuds: 8, panSensitivity: 1, lookSensitivity: 1, zoomToMouse: true };

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
const LOOK_RAD_PER_PX = 0.0042;
const BASE_STUDS_PER_SEC = 32;

/**
 * Roblox Studio's viewport camera, so the replica handles like the real thing: WASD to fly, Q/E
 * down/up, right-drag to look around (pointer hidden, as in Studio), middle-drag to pan, the wheel to
 * fly forward and back (toward the mouse), Shift for precise moves, right-drag + wheel to change speed,
 * F to focus, and , / . to turn. The speed is the same everywhere: it never changes with how close the
 * ground or a wall is (that made it jumpy near the ground).
 */
export class StudioCamera {
  yaw = 0;
  pitch = 0;
  /** Distance to what is in front of the camera (drives adaptive speed, panning and zoom). */
  focusDistance = 80;
  /** Movement speed multiplier set with right-drag + wheel. */
  speedMul = 1;
  onClick: ((clientX: number, clientY: number) => void) | null = null;
  onFocusKey: (() => void) | null = null;
  onSpeedChange: ((mul: number) => void) | null = null;
  /** The user moved the view, or a move was set off (the scene draws on demand: it draws again). */
  onInput: (() => void) | null = null;
  /** Nearest scene hit along a ray (normalized device coordinates), for zoom-to-mouse and adaptive speed. */
  raycast: ((ndc: THREE.Vector2) => THREE.Vector3 | null) | null = null;

  private readonly keys = new Set<string>();
  private shift = false;
  private readonly velocity = new THREE.Vector3();
  private looking = false;
  private panning = false;
  private leftDown: { x: number; y: number; moved: number } | null = null;
  private hover = false;
  private lastProbe = 0;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; yaw0: number; yaw1: number; p0: number; p1: number; t: number; dur: number } | null = null;
  /** What the wheel still has to fly (it glides there over a few frames). */
  private readonly glide = new THREE.Vector3();
  private readonly off: Array<() => void> = [];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly el: HTMLElement,
    public settings: StudioCameraSettings = STUDIO_CAMERA,
  ) {
    el.tabIndex = 0;
    el.style.outline = 'none';
    el.style.touchAction = 'none';
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(el, 'pointerdown', (e) => this.down(e));
    on(window, 'pointermove', (e) => this.move(e));
    on(window, 'pointerup', (e) => this.up(e));
    on(el, 'wheel', (e) => this.wheel(e), { passive: false });
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(el, 'pointerenter', () => (this.hover = true));
    on(el, 'pointerleave', () => (this.hover = false));
    on(window, 'keydown', (e) => this.key(e, true));
    on(window, 'keyup', (e) => this.key(e, false));
    on(window, 'blur', () => this.keys.clear());
    this.apply();
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f();
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  /** Point the camera at a target (keeps its position). */
  lookAt(target: THREE.Vector3): void {
    const d = target.clone().sub(this.camera.position);
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    this.focusDistance = Math.max(4, d.length());
    this.velocity.set(0, 0, 0);
    this.glide.set(0, 0, 0);
    this.tween = null;
    this.apply();
    this.onInput?.();
  }

  /** Glide to a new position looking at a target (Studio's F / "Camera Tween Focus"). */
  flyTo(position: THREE.Vector3, target: THREE.Vector3, dur = 0.45): void {
    const d = target.clone().sub(position);
    let yaw1 = Math.atan2(-d.x, -d.z);
    while (yaw1 - this.yaw > Math.PI) yaw1 -= Math.PI * 2;
    while (yaw1 - this.yaw < -Math.PI) yaw1 += Math.PI * 2;
    this.tween = { from: this.camera.position.clone(), to: position.clone(), yaw0: this.yaw, yaw1, p0: this.pitch, p1: Math.atan2(d.y, Math.hypot(d.x, d.z)), t: 0, dur };
    this.focusDistance = Math.max(4, d.length());
    this.velocity.set(0, 0, 0);
    this.glide.set(0, 0, 0);
    this.onInput?.();
  }

  /** Still moving by itself (a glide, a tween, easing out, a move key held): the scene keeps drawing. */
  moving(): boolean {
    return !!this.tween || this.velocity.lengthSq() > 1e-6 || this.glide.lengthSq() > 1e-6 || (this.keys.size > 0 && this.keysActive());
  }

  /** Advance one frame; returns true when the camera moved. */
  update(dt: number): boolean {
    const before = `${this.camera.position.x.toFixed(3)},${this.camera.position.y.toFixed(3)},${this.camera.position.z.toFixed(3)},${this.yaw.toFixed(4)},${this.pitch.toFixed(4)}`;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const k = 1 - Math.pow(1 - tw.t, 3);
      this.camera.position.lerpVectors(tw.from, tw.to, k);
      this.yaw = tw.yaw0 + (tw.yaw1 - tw.yaw0) * k;
      this.pitch = tw.p0 + (tw.p1 - tw.p0) * k;
      if (tw.t >= 1) this.tween = null;
    }
    const active = this.keysActive();
    const f = this.forward();
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = new THREE.Vector3();
    if (active) {
      if (this.keys.has('KeyW')) want.add(f);
      if (this.keys.has('KeyS')) want.sub(f);
      if (this.keys.has('KeyD')) want.add(right);
      if (this.keys.has('KeyA')) want.sub(right);
      if (this.keys.has('KeyE')) want.y += 1;
      if (this.keys.has('KeyQ')) want.y -= 1;
    }
    if (want.lengthSq() > 0) {
      this.tween = null;
      this.probe();
      want.normalize().multiplyScalar(this.speed());
    }
    // Studio eases in and out of moves instead of starting and stopping dead.
    this.velocity.lerp(want, 1 - Math.exp(-dt * 12));
    if (this.velocity.lengthSq() > 1e-6) this.camera.position.addScaledVector(this.velocity, dt);
    else this.velocity.set(0, 0, 0);
    if (this.glide.lengthSq() > 1e-6) {
      const step = this.glide.lengthSq() < 1e-3 ? this.glide.clone() : this.glide.clone().multiplyScalar(1 - Math.exp(-dt * 14));
      this.camera.position.add(step);
      this.glide.sub(step);
    }
    this.apply();
    const after = `${this.camera.position.x.toFixed(3)},${this.camera.position.y.toFixed(3)},${this.camera.position.z.toFixed(3)},${this.yaw.toFixed(4)},${this.pitch.toFixed(4)}`;
    return before !== after;
  }

  /** Studs per second, the same everywhere: Camera Speed × the right-drag + wheel multiplier × Shift. */
  private speed(): number {
    return BASE_STUDS_PER_SEC * this.settings.speed * this.speedMul * (this.shift ? this.settings.shiftFactor : 1);
  }

  /** Measure how far the scene is in front of the camera (a few times a second while moving; for panning and shots). */
  private probe(): void {
    const now = performance.now();
    if (!this.raycast || now - this.lastProbe < 150) return;
    this.lastProbe = now;
    const hit = this.raycast(new THREE.Vector2(0, 0));
    if (hit) this.focusDistance = Math.max(4, hit.distanceTo(this.camera.position));
  }

  private apply(): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    this.camera.updateMatrixWorld();
  }

  private keysActive(): boolean {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== this.el && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
    return this.hover || this.looking || this.panning || document.activeElement === this.el;
  }

  private key(e: KeyboardEvent, down: boolean): void {
    this.shift = e.shiftKey;
    if (!down) {
      this.keys.delete(e.code);
      return;
    }
    if (!this.keysActive() || e.ctrlKey || e.altKey || e.metaKey) return;
    if (MOVE_KEYS.has(e.code)) {
      this.keys.add(e.code);
      e.preventDefault();
      this.onInput?.();
    } else if (e.code === 'KeyF') {
      this.onFocusKey?.();
      e.preventDefault();
    } else if (e.code === 'Comma' || e.code === 'Period') {
      this.yaw += (e.code === 'Comma' ? 1 : -1) * (Math.PI / 8);
      this.tween = null;
      this.apply();
      e.preventDefault();
      this.onInput?.();
    }
  }

  private down(e: PointerEvent): void {
    this.el.focus({ preventScroll: true });
    if (e.button === 2) {
      this.looking = true;
      this.tween = null;
      // Studio hides the pointer while looking around; pointer lock also lets the drag go on forever.
      try {
        void (this.el.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => undefined);
      } catch {
        /* no pointer lock: movementX/Y still work within the window */
      }
    } else if (e.button === 1) {
      this.panning = true;
      this.tween = null;
      e.preventDefault();
      this.el.setPointerCapture(e.pointerId);
      const hit = this.raycast?.(this.ndc(e.clientX, e.clientY));
      if (hit) this.focusDistance = Math.max(4, hit.distanceTo(this.camera.position));
    } else if (e.button === 0) {
      this.leftDown = { x: e.clientX, y: e.clientY, moved: 0 };
    }
  }

  private move(e: PointerEvent): void {
    if (this.looking) {
      const k = LOOK_RAD_PER_PX * this.settings.lookSensitivity;
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k;
      this.apply();
      this.onInput?.();
    } else if (this.panning) {
      // Grab-and-drag: the point under the cursor (at the focus distance) follows the mouse.
      const h = this.el.clientHeight || 1;
      const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.focusDistance) / h;
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const up = new THREE.Vector3().crossVectors(right, this.forward()).normalize();
      this.camera.position.addScaledVector(right, -e.movementX * worldPerPx * this.settings.panSensitivity);
      this.camera.position.addScaledVector(up, e.movementY * worldPerPx * this.settings.panSensitivity);
      this.onInput?.();
    } else if (this.leftDown) {
      this.leftDown.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    }
  }

  private up(e: PointerEvent): void {
    if (e.button === 2 && this.looking) {
      this.looking = false;
      if (document.pointerLockElement === this.el) document.exitPointerLock();
    } else if (e.button === 1 && this.panning) {
      this.panning = false;
      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    } else if (e.button === 0 && this.leftDown) {
      const click = this.leftDown.moved < 5 && e.target === this.el;
      this.leftDown = null;
      if (click) this.onClick?.(e.clientX, e.clientY);
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    // Shift + wheel arrives sideways in Chromium.
    const delta = e.deltaY || (e.shiftKey ? e.deltaX : 0);
    const notches = -delta / (e.deltaMode === 1 ? 3 : 100);
    if (!notches) return;
    if (this.looking) {
      // Right-drag + wheel changes the camera speed (Studio's speed adjust binding).
      this.speedMul = THREE.MathUtils.clamp(this.speedMul * Math.pow(1.25, notches), 0.1, 25);
      this.onSpeedChange?.(this.speedMul);
      return;
    }
    this.tween = null;
    // Studio's wheel: fly forward or back (toward the mouse) by the same studs per notch wherever the
    // camera is, never through the surface under the mouse.
    const ndc = this.settings.zoomToMouse ? this.ndc(e.clientX, e.clientY) : new THREE.Vector2(0, 0);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    let step = notches * this.settings.wheelStuds * this.settings.speed * this.speedMul * (e.shiftKey ? this.settings.shiftFactor : 1);
    if (step > 0) {
      const hit = this.raycast?.(ndc) ?? null;
      if (hit) {
        const dist = hit.distanceTo(this.camera.position);
        step = Math.min(step, Math.max(0, dist - this.glide.length() - 1.5));
        this.focusDistance = Math.max(4, dist - step);
      }
    }
    this.glide.addScaledVector(ray.ray.direction, step);
    this.onInput?.();
  }

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.el.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }
}
