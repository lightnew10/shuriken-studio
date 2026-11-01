import * as THREE from 'three';
import { watchVisibility, type Visibility } from '../scene/visibility';
import { rpc } from '../../lib/rpc';
import type { EffectSpec } from '@shared/effects';
import { textureRefs } from '@shared/effects';
import { noise1 } from '@shared/fx/math';
import { GLOW_TEX, tessellate, type FxBatch } from '@shared/fx/mesh';
import { effectBounds, effectLength, EffectSim, undrawn, type FxFrame, type SimOptions } from '@shared/fx/sim';
import { BLOOM, cameraOf, dummySolids, frameEffect, GRID_STUDS, lightStrength, placementOf, STAGES, type FxCamera, type FxFraming, type FxPlacement, type FxStage } from '@shared/fx/stage';
import { compileEffect } from '@shared/fx/compile';

/**
 * The preview of a Shuriken effect: the shared effect player (`EffectSim`, the same rules as the game's
 * ShurikenEffects module) drawn with three.js from the triangles `tessellate` makes — every track of a
 * timeline (particles with flipbooks, flashes, rings, slashes, shells, circles, ribbons, beams and
 * lightning, lights on the floor, debris, decals, screen cues, camera shake, the highlight on a target),
 * bursts and effects that stay on, with the game's own textures. The core's software renderer draws the
 * same triangles for the contact sheets agents look at, so the two never disagree.
 *
 * It reads an `EffectSpec` and nothing else (a saved effect or a draft alike). Textures come by reference
 * from the core (`effects.textures`: the project's PNGs for "tex:<Name>", look-alikes for Roblox's
 * built-ins), and the effects a spawn track names from `effects.list`. What it can't show as Roblox does
 * is listed in `notes()` and behind the small note in the corner of an interactive preview.
 */
export interface FxTextureInfo {
  /** A picture (absent: the one held under this stamp is still right). */
  url?: string;
  /** Changes when the texture's pixels do. */
  stamp?: string;
  /** Why this isn't the texture the game shows. */
  note?: string;
}
export type FxTextureLoader = (refs: string[], have: Record<string, string>) => Promise<Record<string, FxTextureInfo>>;

export interface EffectsViewOptions {
  /** Drag to turn, wheel to zoom, the day/dark switch and the note about what is approximate. */
  interactive?: boolean;
  /** Pictures for texture references (default: the open project's, from the core). */
  textures?: FxTextureLoader;
  /** Called when what the preview can't show changes (a new effect, textures arriving). */
  onNotes?: (notes: string[]) => void;
  /** The most frames a second it draws (a dashboard tile: 30); unset, every frame. */
  fps?: number;
}

const fromCore: FxTextureLoader = (refs, have) => rpc<Record<string, FxTextureInfo>>('effects.textures', { refs, have });

const STAGE_VERT = `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;
// The stage: the same floor, grid, lights and sky as @shared/fx/stage (floorColor, skyColor).
const STAGE_FRAG = `
uniform vec3 uCamPos;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform float uTan;
uniform float uAspect;
uniform float uHeight;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uFloor;
uniform float uGrid;
uniform vec4 uLightPos[4];
uniform vec4 uLightCol[4];
uniform mat4 uViewProj;
varying vec2 vNdc;
void main() {
  vec3 d = uForward + uRight * (vNdc.x * uTan * uAspect) + uUp * (vNdc.y * uTan);
  if (d.y < -1e-5) {
    float t = -uCamPos.y / d.y;
    vec3 p = uCamPos + d * t;
    float px = t * uTan * 2.0 / uHeight;
    float w = max(0.04, px * 0.75);
    vec2 g = abs(fract(p.xz / ${GRID_STUDS.toFixed(1)} + 0.5) - 0.5) * ${GRID_STUDS.toFixed(1)};
    float line = (1.0 - smoothstep(w, w + px, min(g.x, g.y))) * uGrid * clamp((${GRID_STUDS.toFixed(1)} / max(px, 1e-6) - 6.0) / 18.0, 0.0, 1.0);
    vec3 col = uFloor * (1.0 - line);
    for (int i = 0; i < 4; i++) {
      float k = max(0.0, 1.0 - distance(p, uLightPos[i].xyz) / max(uLightPos[i].w, 1e-3));
      col += (uFloor * 1.6 + 0.12) * uLightCol[i].rgb * (k * k * uLightCol[i].a);
    }
    col = mix(col, uSkyHorizon, clamp((t - 400.0) / 2600.0, 0.0, 1.0));
    vec4 clip = uViewProj * vec4(p, 1.0);
    gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(col, 1.0);
  } else {
    gl_FragDepth = 1.0;
    gl_FragColor = vec4(mix(uSkyHorizon, uSkyTop, clamp(normalize(d).y * 1.6, 0.0, 1.0)), 1.0);
  }
}`;

const FX_VERT = `
attribute vec4 aColor;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vColor = aColor;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;
// Roblox's LightEmission: colour × alpha is added; what is behind keeps 1 - alpha × (1 - emission).
const FX_FRAG = `
uniform sampler2D uMap;
uniform float uHasMap;
uniform float uKeep;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vec4 t = mix(vec4(1.0), texture2D(uMap, vUv), uHasMap);
  float a = clamp(vColor.a * t.a, 0.0, 1.0);
  vec3 c = vColor.rgb * t.rgb * a;
  if (a <= 0.002 && c.r + c.g + c.b <= 0.002) discard;
  gl_FragColor = vec4(c, a * uKeep);
}`;

const POST_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
// What is brighter than white (layers adding up, Brightness above 1), a quarter of the size.
const BRIGHT_FRAG = `
uniform sampler2D tScene;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    vec3 c = texture2D(tScene, vUv + (vec2(float(x), float(y)) - 0.5) * 2.0 * uTexel).rgb;
    sum += min(vec3(${BLOOM.most.toFixed(2)}), max(vec3(0.0), c - ${BLOOM.threshold.toFixed(2)}));
  }
  gl_FragColor = vec4(sum * 0.25, 1.0);
}`;
const BLUR_FRAG = `
uniform sampler2D tMap;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(tMap, vUv).rgb * 0.1964;
  sum += (texture2D(tMap, vUv + uStep * 1.0).rgb + texture2D(tMap, vUv - uStep * 1.0).rgb) * 0.1747;
  sum += (texture2D(tMap, vUv + uStep * 2.0).rgb + texture2D(tMap, vUv - uStep * 2.0).rgb) * 0.1210;
  sum += (texture2D(tMap, vUv + uStep * 3.0).rgb + texture2D(tMap, vUv - uStep * 3.0).rgb) * 0.0654;
  sum += (texture2D(tMap, vUv + uStep * 4.0).rgb + texture2D(tMap, vUv - uStep * 4.0).rgb) * 0.0276;
  sum += (texture2D(tMap, vUv + uStep * 5.0).rgb + texture2D(tMap, vUv - uStep * 5.0).rgb) * 0.0091;
  gl_FragColor = vec4(sum, 1.0);
}`;
const COMPOSE_FRAG = `
uniform sampler2D tScene;
uniform sampler2D tBloom;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * ${BLOOM.strength.toFixed(2)}, 1.0);
}`;

/**
 * Bloom, as the core's software renderer does it (@shared/fx/stage BLOOM): the picture is drawn into a
 * float target so that light adding up keeps its brightness, what is brighter than white is blurred at a
 * quarter of the size, and the two are put together on screen.
 */
class Bloom {
  private readonly scene: THREE.WebGLRenderTarget;
  private readonly a: THREE.WebGLRenderTarget;
  private readonly b: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly bright: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly compose: THREE.ShaderMaterial;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const float = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.scene = new THREE.WebGLRenderTarget(4, 4, { ...float, depthBuffer: true, samples: 4 });
    this.a = new THREE.WebGLRenderTarget(4, 4, float);
    this.b = new THREE.WebGLRenderTarget(4, 4, float);
    const material = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ vertexShader: POST_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.bright = material(BRIGHT_FRAG, { tScene: { value: this.scene.texture }, uTexel: { value: new THREE.Vector2() } });
    this.blur = material(BLUR_FRAG, { tMap: { value: null }, uStep: { value: new THREE.Vector2() } });
    this.compose = material(COMPOSE_FRAG, { tScene: { value: this.scene.texture }, tBloom: { value: this.a.texture } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bright);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Whether this GPU can draw into a float target (else the picture goes straight to the screen, without bloom). */
  static supported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(4, size.x);
    const h = Math.max(4, size.y);
    if (this.scene.width !== w || this.scene.height !== h) {
      this.scene.setSize(w, h);
      this.a.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
      this.b.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    }
    r.setRenderTarget(this.scene);
    r.render(scene, camera);
    const pass = (m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = m;
      r.setRenderTarget(target);
      r.render(this.quadScene, this.quadCamera);
    };
    (this.bright.uniforms.uTexel!.value as THREE.Vector2).set(1 / w, 1 / h);
    pass(this.bright, this.a);
    // A gaussian of sigma BLOOM.radius of the picture's height (the blur's weights are one of 2.06 steps).
    const step = BLOOM.radius / 2.06;
    for (const [from, to, x, y] of [
      [this.a, this.b, step / (w / h), 0],
      [this.b, this.a, 0, step],
    ] as Array<[THREE.WebGLRenderTarget, THREE.WebGLRenderTarget, number, number]>) {
      this.blur.uniforms.tMap!.value = from.texture;
      (this.blur.uniforms.uStep!.value as THREE.Vector2).set(x, y);
      pass(this.blur, to);
    }
    pass(this.compose, null);
  }

  dispose(): void {
    for (const t of [this.scene, this.a, this.b]) t.dispose();
    for (const m of [this.bright, this.blur, this.compose]) m.dispose();
    this.quad.geometry.dispose();
  }
}

/** A soft white dot: what a texture looks like until its picture arrives. */
function softDot(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false;
  return t;
}

class BatchMesh {
  readonly mesh: THREE.Mesh;
  private capacity = 0;
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly fallback: THREE.Texture) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FX_VERT,
      fragmentShader: FX_FRAG,
      uniforms: { uMap: { value: fallback }, uHasMap: { value: 0 }, uKeep: { value: 1 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      premultipliedAlpha: true,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
  }

  set(b: FxBatch, order: number, tex: THREE.Texture | null): void {
    const n = b.pos.length / 3;
    const geo = this.mesh.geometry;
    if (n > this.capacity) {
      this.capacity = Math.ceil(n * 1.5) + 6;
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
    }
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const col = geo.getAttribute('aColor') as THREE.BufferAttribute;
    (pos.array as Float32Array).set(b.pos);
    (uv.array as Float32Array).set(b.uv);
    (col.array as Float32Array).set(b.col);
    pos.needsUpdate = uv.needsUpdate = col.needsUpdate = true;
    geo.setDrawRange(0, n);
    const m = this.material;
    m.uniforms.uMap!.value = tex ?? this.fallback;
    m.uniforms.uHasMap!.value = b.tex ? 1 : 0;
    m.uniforms.uKeep!.value = b.opaque ? 1 : 1 - b.emission;
    if (m.transparent === b.opaque) {
      // Solid parts hide what is behind them; everything else blends over the picture so far.
      m.transparent = !b.opaque;
      m.depthWrite = b.opaque;
      m.blending = b.opaque ? THREE.NoBlending : THREE.CustomBlending;
      m.needsUpdate = true;
    }
    this.mesh.renderOrder = order;
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export class EffectsView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.2, 6000);
  private readonly ro: ResizeObserver;
  private readonly stageMesh: THREE.Mesh;
  private readonly stageUniforms: Record<string, THREE.IUniform>;
  private readonly bloom: Bloom | null;
  private readonly overlay: HTMLDivElement;
  private readonly cueLine: HTMLDivElement;
  private readonly fallback = softDot();
  private readonly pool: BatchMesh[] = [];
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly stamps = new Map<string, string>();
  private info: HTMLDivElement | null = null;
  private textureNotes = new Map<string, string>();
  private library: EffectSpec[] = [];
  private spec: EffectSpec | null = null;
  private specKey = '';
  private sim: EffectSim | null = null;
  /** A still picture instead of playing (the calm dashboard): the effect at its fullest, drawn once per change. */
  private still = false;
  private place: FxPlacement = { height: 3, dummy: false };
  private framing: FxFraming = { target: [0, 3, 0], distance: 16, azimuth: 0.5, elevation: 0.24 };
  /** The camera that frames the effect, before the user turned it. */
  private home: FxFraming = this.framing;
  private fit = 16;
  private length = 0;
  private stage: FxStage = STAGES.dark;
  private seed = 1;
  private idle = 0;
  private cues: Array<{ text: string; until: number }> = [];
  private clock = 0;
  private raf = 0;
  private last = performance.now();
  /** Drawn while an effect plays, or after a change; never while it can't be seen. */
  private readonly seen: Visibility;
  private dirty = true;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: EffectsViewOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    Object.assign(this.renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });
    host.appendChild(this.renderer.domElement);
    this.bloom = Bloom.supported(this.renderer) ? new Bloom(this.renderer) : null;
    this.stageUniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uRight: { value: new THREE.Vector3() },
      uUp: { value: new THREE.Vector3() },
      uForward: { value: new THREE.Vector3() },
      uTan: { value: 1 },
      uAspect: { value: 1 },
      uHeight: { value: 1 },
      uSkyTop: { value: new THREE.Vector3() },
      uSkyHorizon: { value: new THREE.Vector3() },
      uFloor: { value: new THREE.Vector3() },
      uGrid: { value: 0 },
      uLightPos: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uLightCol: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uViewProj: { value: new THREE.Matrix4() },
    };
    this.stageMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: STAGE_VERT, fragmentShader: STAGE_FRAG, uniforms: this.stageUniforms, depthFunc: THREE.AlwaysDepth }));
    this.stageMesh.frustumCulled = false;
    this.stageMesh.renderOrder = -1000;
    this.scene.add(this.stageMesh);
    // Screen cues (flash, tint, vignette, speed lines, banner, hit marker) and the cues with nothing to draw.
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    this.cueLine = document.createElement('div');
    Object.assign(this.cueLine.style, { position: 'absolute', left: '10px', top: '8px', font: '10.5px ui-monospace, monospace', color: 'rgba(255,255,255,0.72)', textShadow: '0 1px 2px rgba(0,0,0,0.8)', pointerEvents: 'none', whiteSpace: 'nowrap' });
    host.append(this.overlay, this.cueLine);
    if (opts.interactive) {
      // Day or dark behind it, and what this preview can't show as Roblox does.
      const bar = document.createElement('div');
      Object.assign(bar.style, { position: 'absolute', left: '10px', bottom: '34px', display: 'flex', gap: '6px', alignItems: 'center', font: '11px system-ui', color: 'rgba(255,255,255,0.8)' });
      const chip = (text: string) => {
        const el = document.createElement('div');
        Object.assign(el.style, { padding: '3px 8px', borderRadius: '999px', background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(6px)', cursor: 'default', userSelect: 'none' });
        el.textContent = text;
        return el;
      };
      const stage = chip('Dark stage');
      stage.style.cursor = 'pointer';
      stage.title = 'Switch between a dark stage and daylight over grass (where glowing colours wash out)';
      stage.addEventListener('click', () => {
        this.setStage(this.stage.name === 'dark' ? 'day' : 'dark');
        stage.textContent = this.stage.name === 'dark' ? 'Dark stage' : 'Daylight';
      });
      this.info = chip('Approximate preview');
      bar.append(stage, this.info);
      host.appendChild(bar);
    }
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.seen = watchVisibility(host, () => (this.dirty = true));
    if (opts.interactive) {
      const el = this.renderer.domElement;
      let drag: { x: number; y: number } | null = null;
      el.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        this.framing.azimuth -= (e.clientX - drag.x) * 0.008;
        this.framing.elevation = Math.max(-0.05, Math.min(1.4, this.framing.elevation + (e.clientY - drag.y) * 0.006));
        drag = { x: e.clientX, y: e.clientY };
        this.dirty = true;
      });
      el.addEventListener('pointerup', () => (drag = null));
      el.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          this.framing.distance = Math.max(this.fit * 0.15, Math.min(this.fit * 5, this.framing.distance * (e.deltaY > 0 ? 1.1 : 0.9)));
          this.dirty = true;
        },
        { passive: false },
      );
    }
    this.resize();
    this.loop();
  }

  /** The game's other effects (spawn tracks play them). */
  setLibrary(effects: EffectSpec[]): void {
    this.library = effects;
  }

  setStage(name: FxStage['name']): void {
    this.stage = STAGES[name];
    this.dirty = true;
  }

  private simOptions(seed: number): SimOptions {
    return { seed, at: [0, this.place.height, 0], floor: 0, target: this.place.dummy, resolve: (name) => this.library.find((e) => e.name === name) ?? null };
  }

  setEffect(spec: EffectSpec | null): void {
    // The same effect again (the list it came from was read anew): it plays on.
    const key = spec ? JSON.stringify(spec) : '';
    if (key === this.specKey && (this.sim || !spec)) {
      if (spec) this.requestTextures(this.refsOf(spec));
      return;
    }
    this.specKey = key;
    this.dirty = true;
    // The effects its spawn tracks play come from the game's list.
    if (spec && !this.library.length && (spec.tracks ?? []).some((t) => t.type === 'spawn')) {
      void rpc<{ effects: EffectSpec[] }>('effects.list', {})
        .then((r) => {
          if (this.disposed || this.spec !== spec || !r.effects.length) return;
          this.library = r.effects;
          this.specKey = '';
          this.setEffect(spec);
        })
        .catch(() => undefined);
    }
    this.spec = spec;
    this.sim = null;
    this.clock = 0;
    this.cues = [];
    if (!spec) {
      this.opts.onNotes?.([]);
      return;
    }
    try {
      this.place = placementOf(spec);
      const o = this.simOptions(1);
      const bounds = effectBounds(spec, o);
      // How long a burst shows: until all but its last faint 3% has played (its light smoke may linger on).
      this.length = 0;
      if (spec.kind === 'burst') {
        const { step, ink } = bounds.activity;
        const total = ink.reduce((n, v) => n + v, 0);
        let acc = 0;
        let i = 0;
        while (i < ink.length - 1 && acc + ink[i]! < total * 0.97) acc += ink[i++]!;
        this.length = total > 0 ? Math.max(0.15, i * step) : effectLength(spec, o.resolve);
      }
      this.home = frameEffect(bounds, this.aspect(), 40, this.place.dummy ? [0, this.place.height, 0] : null);
      this.framing = { ...this.home };
      this.fit = this.home.distance;
      this.fire();
    } catch (e) {
      // A draft that isn't a whole effect yet: nothing plays, and it says why.
      this.sim = null;
      this.opts.onNotes?.([`This effect can't be played yet: ${(e as Error).message}`]);
      return;
    }
    this.requestTextures(this.refsOf(spec));
    this.emitNotes();
  }

  /** Every texture the effect (and what it spawns) can draw. */
  private refsOf(spec: EffectSpec, depth = 0): string[] {
    const out = new Set<string>([GLOW_TEX]);
    for (const m of compileEffect(spec).emitters) out.add(m.texture);
    for (const t of spec.tracks ?? []) {
      const tex = (t as { texture?: string }).texture;
      if (tex) out.add(tex);
      if (t.type === 'ribbon' && t.trail?.texture) out.add(t.trail.texture);
      if (t.type === 'spawn' && depth < 3) {
        const other = this.library.find((e) => e.name === t.effect);
        if (other) for (const r of this.refsOf(other, depth + 1)) out.add(r);
      }
    }
    if (spec.trail?.texture) out.add(spec.trail.texture);
    if (spec.beam?.texture) out.add(spec.beam.texture);
    for (const n of textureRefs(spec)) out.add(`tex:${n}`);
    return [...out];
  }

  /** Asks for the pictures of these references; ones whose stamp still matches don't travel again. */
  private requestTextures(refs: string[]): void {
    // Built-ins and look-alikes never change; the game's own textures can be remade under the same name.
    const wanted = refs.filter((r) => !this.stamps.has(r) || r.startsWith('tex:') || r.startsWith('rbxassetid:'));
    if (!wanted.length) return;
    void (this.opts.textures ?? fromCore)(wanted, Object.fromEntries(wanted.filter((r) => this.stamps.has(r)).map((r) => [r, this.stamps.get(r)!])))
      .then((got) => {
        if (this.disposed) return;
        for (const [ref, info] of Object.entries(got)) {
          if (info.note) this.textureNotes.set(ref, info.note);
          else this.textureNotes.delete(ref);
          if (info.stamp) this.stamps.set(ref, info.stamp);
          if (!info.url) continue;
          const img = new Image();
          img.onload = () => {
            if (this.disposed) return;
            const t = new THREE.Texture(img);
            t.flipY = false;
            t.wrapS = THREE.RepeatWrapping;
            t.minFilter = THREE.LinearMipmapLinearFilter;
            t.needsUpdate = true;
            this.textures.get(ref)?.dispose();
            this.textures.set(ref, t);
            this.dirty = true;
          };
          img.src = info.url;
        }
        this.emitNotes();
      })
      .catch(() => undefined); // The pictures didn't come: soft dots stay.
  }

  /** What this preview doesn't show the way Roblox will. */
  notes(): string[] {
    const s = this.spec;
    if (!s) return [];
    const used = new Set(this.refsOf(s));
    return [...undrawn(s), ...[...this.textureNotes.entries()].filter(([ref]) => used.has(ref)).map(([, note]) => note), 'Lighting and Bloom are approximated: check the final look with Play in Studio.'];
  }

  private emitNotes(): void {
    const notes = this.notes();
    if (this.info) this.info.title = notes.join('\n');
    this.opts.onNotes?.(notes);
  }

  /**
   * Stills of the effect at the given times (seconds after it starts), played with fixed randomness
   * from the camera that frames it: a filmstrip of how it develops.
   */
  snapshots(times: number[], w = 140, h = 110): string[] {
    const s = this.spec;
    if (!s || s.kind !== 'burst') return [];
    const sim = new EffectSim(s, this.simOptions(7));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d')!;
    const src = this.renderer.domElement;
    const out: string[] = [];
    for (const t of times) {
      sim.advance(t);
      this.draw(sim.frame(), cameraOf(this.home), false);
      const sh = src.height;
      const sw = Math.min(src.width, (sh * w) / h);
      g.clearRect(0, 0, w, h);
      g.drawImage(src, (src.width - sw) / 2, 0, sw, sh, 0, 0, w, h);
      out.push(off.toDataURL('image/png'));
    }
    // The stills were drawn on the live canvas.
    this.dirty = true;
    return out;
  }

  /** How long a burst shows (what a filmstrip of it should span). */
  burstLength(): number {
    return this.spec?.kind === 'burst' ? this.length : 0;
  }

  /** Holds still (one frame of the effect at its fullest) or plays again. */
  setStill(on: boolean): void {
    if (on === this.still) return;
    this.still = on;
    this.dirty = true;
    if (!on) this.fire();
  }

  /** Plays it again from the start. */
  fire(): void {
    if (!this.spec) return;
    this.sim = new EffectSim(this.spec, this.simOptions(this.seed++));
    this.clock = 0;
    this.idle = 0;
    this.dirty = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.seen.dispose();
    for (const b of this.pool) b.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.fallback.dispose();
    this.bloom?.dispose();
    this.stageMesh.geometry.dispose();
    (this.stageMesh.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.overlay.remove();
    this.cueLine.remove();
  }

  private aspect(): number {
    return Math.max(0.2, this.host.clientWidth / Math.max(1, this.host.clientHeight));
  }

  private resize(): void {
    this.dirty = true;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** One frame of the effect from a camera: the stage, then the effect's triangles in order. */
  /** One frame of the effect where it shows most: a burst about a third in, anything else after a second. */
  private drawStill(): void {
    if (!this.spec) {
      this.draw({ t: 0, layers: [], lights: [], screens: [], shake: 0, highlight: null, hitstop: false, cues: [] }, cameraOf(this.framing), false);
      return;
    }
    try {
      const sim = new EffectSim(this.spec, this.simOptions(1));
      sim.advance(this.spec.kind === 'burst' ? Math.max(0.12, this.length * 0.35) : 1.2);
      this.draw(sim.frame(), cameraOf(this.framing), false);
    } catch {
      /* a draft that isn't a whole effect yet: its note says why */
    }
  }

  private draw(frame: FxFrame, cam: FxCamera, shake: boolean): void {
    const three = this.camera;
    three.position.set(...cam.pos);
    three.up.set(0, 1, 0);
    three.lookAt(cam.pos[0] + cam.forward[0], cam.pos[1] + cam.forward[1], cam.pos[2] + cam.forward[2]);
    if (shake && frame.shake > 0) {
      // ShurikenEffects' shake: a few degrees of noise on every axis, fading out.
      const t = this.clock * 30;
      const k = (frame.shake * Math.PI) / 180;
      three.rotateX(noise1(t, 0.5) * k * 2);
      three.rotateY(noise1(t, 7.5) * k * 2);
      three.rotateZ(noise1(t, 3.3) * k);
    }
    three.far = Math.max(6000, this.framing.distance * 8);
    three.updateProjectionMatrix();
    three.updateMatrixWorld();
    const u = this.stageUniforms;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const fwd = new THREE.Vector3();
    three.getWorldDirection(fwd);
    (u.uCamPos!.value as THREE.Vector3).copy(three.position);
    (u.uForward!.value as THREE.Vector3).copy(fwd);
    (u.uRight!.value as THREE.Vector3).setFromMatrixColumn(three.matrixWorld, 0);
    (u.uUp!.value as THREE.Vector3).setFromMatrixColumn(three.matrixWorld, 1);
    u.uTan!.value = tan;
    u.uAspect!.value = three.aspect;
    u.uHeight!.value = this.renderer.domElement.height;
    (u.uSkyTop!.value as THREE.Vector3).set(...this.stage.skyTop);
    (u.uSkyHorizon!.value as THREE.Vector3).set(...this.stage.skyHorizon);
    (u.uFloor!.value as THREE.Vector3).set(...this.stage.floor);
    u.uGrid!.value = this.stage.grid;
    (u.uViewProj!.value as THREE.Matrix4).multiplyMatrices(three.projectionMatrix, three.matrixWorldInverse);
    const lights = [...frame.lights].sort((a, b) => b.brightness * b.range - a.brightness * a.range).slice(0, 4);
    for (let i = 0; i < 4; i++) {
      const l = lights[i];
      (u.uLightPos!.value as THREE.Vector4[])[i]!.set(l?.p[0] ?? 0, l?.p[1] ?? 0, l?.p[2] ?? 0, l?.range ?? 0);
      (u.uLightCol!.value as THREE.Vector4[])[i]!.set(l?.color[0] ?? 0, l?.color[1] ?? 0, l?.color[2] ?? 0, l ? lightStrength(l.brightness) : 0);
    }
    const extra = this.place.dummy ? dummySolids([0, this.place.height, 0], frame.highlight ? { color: frame.highlight.color, fill: frame.highlight.fill } : undefined) : [];
    const batches = tessellate(frame, cam, this.stage, extra);
    while (this.pool.length < batches.length) {
      const b = new BatchMesh(this.fallback);
      this.pool.push(b);
      this.scene.add(b.mesh);
    }
    this.pool.forEach((m, i) => {
      const b = batches[i];
      if (b) m.set(b, i + 1, b.tex ? (this.textures.get(b.tex) ?? null) : null);
      else m.mesh.visible = false;
    });
    if (this.bloom) this.bloom.render(this.scene, three);
    else this.renderer.render(this.scene, three);
    this.screens(frame);
  }

  /** The 2D cues ShurikenScreenFX draws over the game. */
  private screens(frame: FxFrame): void {
    const css = (c: [number, number, number], a: number) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a.toFixed(3)})`;
    const layers: string[] = [];
    let banner = '';
    let marker = false;
    for (const s of frame.screens) {
      if (s.fx === 'flash' || s.fx === 'tint') layers.push(`linear-gradient(${css(s.color, s.alpha)},${css(s.color, s.alpha)})`);
      else if (s.fx === 'vignette') layers.push(`radial-gradient(ellipse at center, ${css(s.color, 0)} 45%, ${css(s.color, s.alpha)} 100%)`);
      else if (s.fx === 'speedlines') layers.push(`repeating-conic-gradient(from 0deg at 50% 50%, ${css(s.color, 0)} 0deg 5deg, ${css(s.color, 0.22)} 5.5deg 6deg)`);
      else if (s.fx === 'banner') banner = s.text ?? '';
      else if (s.fx === 'hitmarker') marker = true;
    }
    const key = `${layers.join('|')}#${banner}#${marker}`;
    if (this.overlay.dataset.key === key) return;
    this.overlay.dataset.key = key;
    this.overlay.style.background = layers.join(',');
    this.overlay.textContent = '';
    if (banner || marker) {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'absolute', left: '0', right: '0', top: marker ? '50%' : '18%', transform: 'translateY(-50%)', textAlign: 'center', color: 'white', font: marker ? '600 18px system-ui' : '800 20px system-ui', letterSpacing: marker ? '0' : '0.04em', textShadow: '0 2px 6px rgba(0,0,0,0.7)' });
      el.textContent = marker ? '✕' : banner;
      this.overlay.appendChild(el);
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.opts.fps && !this.dirty && now - this.last < 1000 / this.opts.fps - 2) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    // Unseen, or nothing playing and nothing changed: nothing to draw.
    if (!this.seen.visible() || (!this.sim && !this.dirty)) return;
    if (this.still) {
      if (!this.dirty) return;
      this.dirty = false;
      this.drawStill();
      return;
    }
    this.dirty = false;
    this.clock += dt;
    const sim = this.sim;
    if (!sim) {
      this.draw({ t: 0, layers: [], lights: [], screens: [], shake: 0, highlight: null, hitstop: false, cues: [] }, cameraOf(this.framing), false);
      return;
    }
    sim.advance(this.clock);
    const frame = sim.frame();
    for (const c of frame.cues) if (c.type === 'sound' || c.type === 'hitstop') this.cues.push({ text: c.type === 'sound' ? `♪ ${c.label}` : `hit-stop ${c.label}`, until: now + 900 });
    this.cues = this.cues.filter((c) => c.until > now);
    const line = this.cues.map((c) => c.text).join('   ');
    if (this.cueLine.textContent !== line) this.cueLine.textContent = line;
    this.draw(frame, cameraOf(this.framing), true);
    // A burst plays again by itself, after a breath.
    if (sim.done) {
      this.idle += dt;
      if (this.idle > 0.7) this.fire();
    }
  };
}
