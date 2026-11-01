import { rgbToHex, type Vec3 } from '@shared/curves';
import type { EffectSpec } from '@shared/effects';
import { tessellate, type FxBatch } from '@shared/fx/mesh';
import { vdot } from '@shared/fx/math';
import { effectBounds, EffectSim, type FxBounds, type FxFrame, type SimOptions } from '@shared/fx/sim';
import { BLOOM, cameraOf, dummySolids, floorColor, frameEffect, placementOf, skyColor, STAGES, type FxCamera, type FxFraming, type FxStage } from '@shared/fx/stage';
import type { RgbaImage } from '../modeling/png';
import type { PreviewTexture } from './preview-textures';

/**
 * Draws an effect without Roblox or a GPU: the shared player (`EffectSim`) and its triangles
 * (`tessellate`), rasterised in software on the same stage the app's preview uses. Agents and the critic
 * look at the contact sheets this makes (frames over the effect's time, by day and in the dark), and the
 * measurements taken while drawing say how it reads: how much of the view it covers, how much of each
 * layer shows against a bright background, whether it burns out to white, what colour it comes out.
 *
 * Colour is blended as Roblox's LightEmission does: colour × alpha is added, what is behind keeps
 * 1 - alpha × (1 - emission). Lighting and Bloom are approximations (see docs/ARCHITECTURE.md §11).
 */
export type TextureLookup = (ref: string) => PreviewTexture;

interface Mips {
  levels: Array<{ w: number; h: number; data: Float32Array }>;
}
const mipCache = new WeakMap<RgbaImage, Mips>();

/** The image premultiplied, with smaller copies for drawing it small without sparkle. */
function mipsOf(img: RgbaImage): Mips {
  const hit = mipCache.get(img);
  if (hit) return hit;
  let w = img.width;
  let h = img.height;
  let data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    data[i * 4] = (img.data[i * 4]! / 255) * a;
    data[i * 4 + 1] = (img.data[i * 4 + 1]! / 255) * a;
    data[i * 4 + 2] = (img.data[i * 4 + 2]! / 255) * a;
    data[i * 4 + 3] = a;
  }
  const levels = [{ w, h, data }];
  while (w > 4 && h > 4) {
    const nw = w >> 1;
    const nh = h >> 1;
    const next = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++)
        for (let c = 0; c < 4; c++) next[(y * nw + x) * 4 + c] = (data[(2 * y * w + 2 * x) * 4 + c]! + data[(2 * y * w + 2 * x + 1) * 4 + c]! + data[((2 * y + 1) * w + 2 * x) * 4 + c]! + data[((2 * y + 1) * w + 2 * x + 1) * 4 + c]!) / 4;
    levels.push({ w: nw, h: nh, data: next });
    w = nw;
    h = nh;
    data = next;
  }
  const mips = { levels };
  mipCache.set(img, mips);
  return mips;
}

export interface Canvas {
  width: number;
  height: number;
  /** r, g, b per pixel, 0..1 and above (clamped when written out). */
  rgb: Float32Array;
  depth: Float32Array;
  /** How much of the effect lies over each pixel (0 none … 1 opaque or fully lit), whatever is behind it. */
  ink: Float32Array;
  /**
   * The same picture over nothing but bright sky (by day, while layers are measured): the camera looks down
   * on most effects, so grass is behind them here, and in a game it is as often the sky.
   */
  sky?: Float32Array;
  /** Which layer last drew on each pixel (while layers are measured): how many pixels a layer covers. */
  stamp?: Int32Array;
  stamps?: number;
}

/** What one layer put on the picture: how much there was of it, and how much of that changed what you see. */
export interface LayerInk {
  /** Its strength summed over its pixels, as it would show on black. */
  ink: number;
  /** The change it actually made on this stage. */
  shown: number;
  /** The change it would make against a bright sky (by day). */
  shownOnSky: number;
  /** Its authored colour summed with its strength. */
  color: Vec3;
  /** Its LightEmission (the most of its parts): 1 adds its light onto what is behind it. */
  emission: number;
  /** How many times it drew on a pixel, and on how many pixels: their ratio is how often it draws over itself. */
  fragments: number;
  pixels: number;
  /** Its number in the frame being drawn (see Canvas.stamp). */
  id: number;
}

interface Projected {
  x: number;
  y: number;
  /** 1 / depth along the view. */
  w: number;
  u: number;
  v: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const NEAR = 0.2;

/** The stage behind the effect: floor (with the effect's lights on it) and sky; fills the depth of the floor. */
export function drawStage(c: Canvas, cam: FxCamera, stage: FxStage, lights: FxFrame['lights']): void {
  const tan = Math.tan((cam.fov * Math.PI) / 360);
  const aspect = c.width / c.height;
  for (let py = 0; py < c.height; py++) {
    const ny = (1 - (2 * (py + 0.5)) / c.height) * tan;
    for (let px = 0; px < c.width; px++) {
      const nx = ((2 * (px + 0.5)) / c.width - 1) * tan * aspect;
      const dx = cam.forward[0] + cam.right[0] * nx + cam.up[0] * ny;
      const dy = cam.forward[1] + cam.right[1] * nx + cam.up[1] * ny;
      const dz = cam.forward[2] + cam.right[2] * nx + cam.up[2] * ny;
      const i = py * c.width + px;
      let col: Vec3;
      if (dy < -1e-5) {
        const t = -cam.pos[1] / dy;
        const x = cam.pos[0] + dx * t;
        const z = cam.pos[2] + dz * t;
        col = floorColor(stage, x, z, 0, lights, (t * tan * 2) / c.height);
        // The far floor fades into the horizon.
        const fog = Math.min(1, Math.max(0, (t - 400) / 2600));
        if (fog > 0) col = [col[0] + (stage.skyHorizon[0] - col[0]) * fog, col[1] + (stage.skyHorizon[1] - col[1]) * fog, col[2] + (stage.skyHorizon[2] - col[2]) * fog];
        c.depth[i] = t;
      } else {
        col = skyColor(stage, dy / Math.hypot(dx, dy, dz));
        c.depth[i] = Infinity;
      }
      c.rgb[i * 3] = col[0];
      c.rgb[i * 3 + 1] = col[1];
      c.rgb[i * 3 + 2] = col[2];
    }
  }
}

function drawBatch(c: Canvas, cam: FxCamera, b: FxBatch, tex: Mips | null, stats: LayerInk | null): void {
  const tan = Math.tan((cam.fov * Math.PI) / 360);
  const aspect = c.width / c.height;
  const keep = 1 - b.emission;
  const count = b.pos.length / 9;
  for (let t = 0; t < count; t++) {
    // View space: x right, y up, z depth.
    const view: Array<{ x: number; y: number; z: number; u: number; v: number; r: number; g: number; b: number; a: number }> = [];
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const d: Vec3 = [b.pos[i * 3]! - cam.pos[0], b.pos[i * 3 + 1]! - cam.pos[1], b.pos[i * 3 + 2]! - cam.pos[2]];
      view.push({ x: vdot(d, cam.right), y: vdot(d, cam.up), z: vdot(d, cam.forward), u: b.uv[i * 2]!, v: b.uv[i * 2 + 1]!, r: b.col[i * 4]!, g: b.col[i * 4 + 1]!, b: b.col[i * 4 + 2]!, a: b.col[i * 4 + 3]! });
    }
    // Clip against the near plane (a big sprite or a beam passing the camera).
    let poly = view;
    if (view.some((p) => p.z < NEAR)) {
      poly = [];
      for (let k = 0; k < 3; k++) {
        const p = view[k]!;
        const q = view[(k + 1) % 3]!;
        if (p.z >= NEAR) poly.push(p);
        if (p.z >= NEAR !== q.z >= NEAR) {
          const s = (NEAR - p.z) / (q.z - p.z);
          const mix = (m: number, n: number) => m + (n - m) * s;
          poly.push({ x: mix(p.x, q.x), y: mix(p.y, q.y), z: NEAR, u: mix(p.u, q.u), v: mix(p.v, q.v), r: mix(p.r, q.r), g: mix(p.g, q.g), b: mix(p.b, q.b), a: mix(p.a, q.a) });
        }
      }
      if (poly.length < 3) continue;
    }
    const pts: Projected[] = poly.map((p) => ({ x: (p.x / (p.z * tan * aspect) + 1) * 0.5 * c.width, y: (1 - p.y / (p.z * tan)) * 0.5 * c.height, w: 1 / p.z, u: p.u, v: p.v, r: p.r, g: p.g, b: p.b, a: p.a }));
    for (let k = 1; k < pts.length - 1; k++) fillTriangle(c, pts[0]!, pts[k]!, pts[k + 1]!, tex, keep, b.opaque, stats);
  }
}

function fillTriangle(c: Canvas, p0: Projected, p1: Projected, p2: Projected, tex: Mips | null, keep: number, opaque: boolean, stats: LayerInk | null): void {
  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const x1 = Math.min(c.width - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const y0 = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const y1 = Math.min(c.height - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (x0 > x1 || y0 > y1) return;
  // One mip level per triangle: texels per pixel from its size on screen and in the texture.
  let level = tex ? tex.levels[0]! : null;
  if (tex) {
    const uvArea = Math.abs((p1.u - p0.u) * (p2.v - p0.v) - (p1.v - p0.v) * (p2.u - p0.u)) * tex.levels[0]!.w * tex.levels[0]!.h;
    const lod = Math.max(0, Math.min(tex.levels.length - 1, Math.round(0.5 * Math.log2(Math.max(uvArea / Math.abs(area), 1e-9)))));
    level = tex.levels[lod]!;
  }
  const inv = 1 / area;
  const rgb = c.rgb;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;
      const w0 = ((p1.x - sx) * (p2.y - sy) - (p1.y - sy) * (p2.x - sx)) * inv;
      const w1 = ((p2.x - sx) * (p0.y - sy) - (p2.y - sy) * (p0.x - sx)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      // Perspective-correct: interpolate over 1/z.
      const q0 = w0 * p0.w;
      const q1 = w1 * p1.w;
      const q2 = w2 * p2.w;
      const z = 1 / (q0 + q1 + q2);
      const i = y * c.width + x;
      if (z > c.depth[i]!) continue;
      const k0 = q0 * z;
      const k1 = q1 * z;
      const k2 = q2 * z;
      const cr = k0 * p0.r + k1 * p1.r + k2 * p2.r;
      const cg = k0 * p0.g + k1 * p1.g + k2 * p2.g;
      const cb = k0 * p0.b + k1 * p1.b + k2 * p2.b;
      let a = k0 * p0.a + k1 * p1.a + k2 * p2.a;
      let r = cr * a;
      let g = cg * a;
      let b = cb * a;
      if (level) {
        // Bilinear, repeating along u (strips scroll and tile). The texture is premultiplied.
        const u = k0 * p0.u + k1 * p1.u + k2 * p2.u;
        const v = k0 * p0.v + k1 * p1.v + k2 * p2.v;
        const fx = (u - Math.floor(u)) * level.w - 0.5;
        const fy = Math.min(1, Math.max(0, v)) * level.h - 0.5;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const xa = ((ix % level.w) + level.w) % level.w;
        const xb = (xa + 1) % level.w;
        const ya = Math.min(level.h - 1, Math.max(0, iy));
        const yb = Math.min(level.h - 1, Math.max(0, iy + 1));
        const d = level.data;
        const i00 = (ya * level.w + xa) * 4;
        const i10 = (ya * level.w + xb) * 4;
        const i01 = (yb * level.w + xa) * 4;
        const i11 = (yb * level.w + xb) * 4;
        const f00 = (1 - tx) * (1 - ty);
        const f10 = tx * (1 - ty);
        const f01 = (1 - tx) * ty;
        const f11 = tx * ty;
        r = cr * a * (d[i00]! * f00 + d[i10]! * f10 + d[i01]! * f01 + d[i11]! * f11);
        g = cg * a * (d[i00 + 1]! * f00 + d[i10 + 1]! * f10 + d[i01 + 1]! * f01 + d[i11 + 1]! * f11);
        b = cb * a * (d[i00 + 2]! * f00 + d[i10 + 2]! * f10 + d[i01 + 2]! * f01 + d[i11 + 2]! * f11);
        a *= d[i00 + 3]! * f00 + d[i10 + 3]! * f10 + d[i01 + 3]! * f01 + d[i11 + 3]! * f11;
      }
      if (a <= 0.002 && r + g + b <= 0.002) continue;
      const kept = 1 - Math.min(1, a) * keep;
      const j = i * 3;
      const or = rgb[j]!;
      const og = rgb[j + 1]!;
      const ob = rgb[j + 2]!;
      const nr = r + or * kept;
      const ng = g + og * kept;
      const nb = b + ob * kept;
      rgb[j] = nr;
      rgb[j + 1] = ng;
      rgb[j + 2] = nb;
      if (stats) {
        // How strongly it lies here: what it would add on black, or how much it covers.
        const s = Math.min(1, Math.max(a * keep, (r + g + b) / 3));
        c.ink[i] = 1 - (1 - c.ink[i]!) * (1 - s);
        if (s > 0.02 && c.stamp) {
          stats.fragments++;
          if (c.stamp[i] !== stats.id) {
            c.stamp[i] = stats.id;
            stats.pixels++;
          }
        }
        stats.ink += s;
        stats.shown += (Math.abs(Math.min(1, nr) - Math.min(1, or)) + Math.abs(Math.min(1, ng) - Math.min(1, og)) + Math.abs(Math.min(1, nb) - Math.min(1, ob))) / 3;
        const sky = c.sky;
        if (sky) {
          const sr = sky[j]!;
          const sg = sky[j + 1]!;
          const sb = sky[j + 2]!;
          sky[j] = r + sr * kept;
          sky[j + 1] = g + sg * kept;
          sky[j + 2] = b + sb * kept;
          stats.shownOnSky += (Math.abs(Math.min(1, sky[j]!) - Math.min(1, sr)) + Math.abs(Math.min(1, sky[j + 1]!) - Math.min(1, sg)) + Math.abs(Math.min(1, sky[j + 2]!) - Math.min(1, sb))) / 3;
        }
        stats.color[0] += cr * s;
        stats.color[1] += cg * s;
        stats.color[2] += cb * s;
      }
      if (opaque) c.depth[i] = z;
    }
  }
}

/** Bloom: what is brighter than the threshold, blurred at a quarter of the size and added back. */
function bloom(c: Canvas): void {
  const w = Math.max(1, c.width >> 2);
  const h = Math.max(1, c.height >> 2);
  let buf = new Float32Array(w * h * 3);
  let any = false;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) sum += Math.min(BLOOM.most, Math.max(0, c.rgb[((y * 4 + dy) * c.width + x * 4 + dx) * 3 + k]! - BLOOM.threshold));
        if (sum > 0) any = true;
        buf[(y * w + x) * 3 + k] = sum / 16;
      }
  if (!any) return;
  // Three box blurs of radius r come close to a gaussian of sigma r + 0.5.
  const r = Math.max(1, Math.round(h * BLOOM.radius - 0.5));
  let tmp = new Float32Array(buf.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      const n = horizontal ? w : h;
      const lines = horizontal ? h : w;
      for (let l = 0; l < lines; l++)
        for (let k = 0; k < 3; k++) {
          const at = (i: number) => (horizontal ? (l * w + i) * 3 + k : (i * w + l) * 3 + k);
          let sum = 0;
          for (let i = -r; i <= r; i++) sum += buf[at(Math.min(n - 1, Math.max(0, i)))]!;
          for (let i = 0; i < n; i++) {
            tmp[at(i)] = sum / (2 * r + 1);
            sum += buf[at(Math.min(n - 1, i + r + 1))]! - buf[at(Math.max(0, i - r))]!;
          }
        }
      [buf, tmp] = [tmp, buf];
    }
  }
  for (let y = 0; y < c.height; y++) {
    // Bilinear back up to the picture's size.
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / 4 - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < c.width; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / 4 - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      for (let k = 0; k < 3; k++) {
        const v = (buf[(y0 * w + x0) * 3 + k]! * (1 - tx) + buf[(y0 * w + x1) * 3 + k]! * tx) * (1 - ty) + (buf[(y1 * w + x0) * 3 + k]! * (1 - tx) + buf[(y1 * w + x1) * 3 + k]! * tx) * ty;
        c.rgb[(y * c.width + x) * 3 + k] = c.rgb[(y * c.width + x) * 3 + k]! + v * BLOOM.strength;
      }
    }
  }
}

function drawScreens(c: Canvas, screens: FxFrame['screens']): void {
  for (const s of screens) {
    if (s.fx !== 'flash' && s.fx !== 'tint' && s.fx !== 'vignette') continue;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        let a = s.alpha;
        if (s.fx === 'vignette') {
          const d = Math.hypot((x + 0.5) / c.width - 0.5, (y + 0.5) / c.height - 0.5) / 0.7071;
          a *= Math.min(1, Math.max(0, (d - 0.45) / 0.55)) ** 1.5;
        }
        const i = (y * c.width + x) * 3;
        c.rgb[i] = c.rgb[i]! * (1 - a) + s.color[0] * a;
        c.rgb[i + 1] = c.rgb[i + 1]! * (1 - a) + s.color[1] * a;
        c.rgb[i + 2] = c.rgb[i + 2]! * (1 - a) + s.color[2] * a;
      }
  }
}

export interface RenderOptions {
  width: number;
  height: number;
  camera: FxCamera;
  stage: FxStage;
  textures: TextureLookup;
  /** A character standing where the effect plays (its root), when the effect goes on one. */
  dummy?: Vec3 | null;
  /** Collects what each layer (by name) put on the picture. */
  layers?: Map<string, LayerInk>;
}

/** One frame of an effect on the stage. */
export function renderFrame(frame: FxFrame, o: RenderOptions): Canvas {
  const n = o.width * o.height;
  const c: Canvas = { width: o.width, height: o.height, rgb: new Float32Array(n * 3), depth: new Float32Array(n), ink: new Float32Array(n) };
  drawStage(c, o.camera, o.stage, frame.lights);
  if (o.layers && o.stage.name === 'day') {
    // A sky a third of the way up from the horizon, behind everything.
    const sky = skyColor(o.stage, 0.22);
    c.sky = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.sky.set(sky, i * 3);
  }
  if (o.layers) {
    c.stamp = new Int32Array(n);
    c.stamps = 0;
  }
  const extra = o.dummy ? dummySolids(o.dummy, frame.highlight ? { color: frame.highlight.color, fill: frame.highlight.fill } : undefined) : [];
  for (const b of tessellate(frame, o.camera, o.stage, extra)) {
    // The stage's own things (the character it plays on) are drawn, not measured.
    let stats: LayerInk | null = null;
    if (o.layers && b.name) {
      stats = o.layers.get(b.name) ?? { ink: 0, shown: 0, shownOnSky: 0, color: [0, 0, 0], emission: 0, fragments: 0, pixels: 0, id: 0 };
      stats.emission = Math.max(stats.emission, b.emission);
      stats.id = c.stamps = (c.stamps ?? 0) + 1;
      o.layers.set(b.name, stats);
    }
    drawBatch(c, o.camera, b, b.tex ? mipsOf(o.textures(b.tex).image) : null, stats);
  }
  bloom(c);
  drawScreens(c, frame.screens);
  return c;
}

/** Halves a canvas (2x2 averages): rendering at twice the size and halving smooths edges. */
function halve(c: Canvas): Canvas {
  const w = c.width >> 1;
  const h = c.height >> 1;
  const rgb = new Float32Array(w * h * 3);
  const ink = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = (2 * y * c.width + 2 * x) * 3;
      const b = a + c.width * 3;
      for (let k = 0; k < 3; k++) rgb[(y * w + x) * 3 + k] = (Math.min(1, c.rgb[a + k]!) + Math.min(1, c.rgb[a + 3 + k]!) + Math.min(1, c.rgb[b + k]!) + Math.min(1, c.rgb[b + 3 + k]!)) / 4;
      const i = 2 * y * c.width + 2 * x;
      ink[y * w + x] = (c.ink[i]! + c.ink[i + 1]! + c.ink[i + c.width]! + c.ink[i + c.width + 1]!) / 4;
    }
  return { width: w, height: h, rgb, depth: new Float32Array(0), ink };
}

// A 3x5 font for the frame times.
const GLYPHS: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
  '5': '111100111001111', '6': '111100111101111', '7': '111001001001001', '8': '111101111101111', '9': '111101111001111',
  '.': '000000000000010', s: '000011100010110', ' ': '000000000000000',
};

function label(img: RgbaImage, text: string, x0: number, y0: number, scale = 2): void {
  const put = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    img.data.set([v, v, v, 255], (y * img.width + x) * 4);
  };
  const w = text.length * 4 * scale + scale;
  for (let y = -scale; y < 5 * scale + scale; y++) for (let x = -scale; x < w; x++) put(x0 + x, y0 + y, 16);
  [...text].forEach((ch, n) => {
    const g = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let i = 0; i < 15; i++) if (g[i] === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x0 + (n * 4 + (i % 3)) * scale + dx, y0 + Math.floor(i / 3) * scale + dy, 240);
  });
}

/** How the effect reads on one stage, from the pixels. */
export interface StageRead {
  stage: FxStage['name'];
  /** Share of what it draws that changes what you see there (1: all of it shows; near 0: it melts into the background). */
  shown: number;
  /** By day: the same against a bright sky instead of the grass the camera mostly sees behind it. */
  onSky?: number;
  /** Share of its pixels burnt out to white at its fullest frame. */
  whiteOut: number;
  /** Its mean colour where it shows, at its fullest frame (what it reads as). */
  color: string | null;
}

export interface LayerRead {
  name: string;
  /** Its share of everything the effect draws. */
  share: number;
  /** Share of it that shows, per stage (in the order of `stages`). */
  shown: number[];
  /** Share of it that shows against a bright sky (null without the day stage). */
  onSky: number | null;
  /** Whether it adds its light onto what is behind it (LightEmission 0.5 and up). */
  glows: boolean;
  /** How many times over it draws the pixels it covers (1: nothing of it overlaps itself). */
  overdraw: number;
}

export interface ContactSheet {
  image: RgbaImage;
  /** The times of the frames, left to right (seconds after the effect starts). */
  times: number[];
  stages: Array<FxStage['name']>;
  framing: FxFraming;
  /** How far the camera is from the middle of the effect (studs). */
  distance: number;
  /** Share of the picture it covers per frame, the most it reaches and when, and how opaque the middle of the picture gets then. */
  coverage: { perFrame: number[]; peak: number; at: number; center: number };
  reads: StageRead[];
  /** The layers by how much they draw, with how much of each shows per stage. */
  layers: LayerRead[];
  /** The colour its layers were given (weighted by how much each draws): compare with reads[].color. */
  authored: string | null;
  /** What this picture doesn't show as the game does. */
  notes: string[];
}

export interface SheetOptions {
  textures: TextureLookup;
  resolve?: SimOptions['resolve'];
  /** Frame times in seconds (default: six, where the effect shows most; the first frame always). */
  times?: number[];
  stages?: Array<FxStage['name']>;
  /** One frame's size in pixels (default 256 × 192). */
  frame?: [number, number];
  seed?: number;
}

/**
 * When to look at an effect: its first frame (the impact), then spread over what it shows (so a long,
 * faint tail doesn't take the frames); a persistent effect once it is going.
 */
export function sheetTimes(spec: EffectSpec, bounds: FxBounds, count = 6): number[] {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  if (spec.kind !== 'burst') return Array.from({ length: count }, (_, i) => r2(0.4 + i * 0.4));
  const { step, ink } = bounds.activity;
  const total = ink.reduce((n, v) => n + v, 0);
  if (total <= 0) return Array.from({ length: count }, (_, i) => r2(0.02 + i * step * (ink.length / count)));
  const times = [0.02];
  let acc = 0;
  let at = 0;
  for (let k = 1; k < count; k++) {
    const want = total * (0.06 + (0.9 * k) / count);
    while (at < ink.length - 1 && acc + ink[at]! < want) acc += ink[at++]!;
    times.push(Math.max(times[times.length - 1]! + 0.02, at * step));
  }
  return times.map(r2);
}

const blank = (): FxFrame => ({ t: 0, layers: [], lights: [], screens: [], shake: 0, highlight: null, hitstop: false, cues: [] });

/**
 * Frames of an effect over its time, on each stage, in one picture (a row per stage, time left to right),
 * with what the pixels measure. The camera frames the effect from behind and beside whoever plays it.
 */
export function contactSheet(spec: EffectSpec, o: SheetOptions): ContactSheet {
  const [fw, fh] = o.frame ?? [256, 192];
  const stages = o.stages ?? ['day', 'dark'];
  const place = placementOf(spec);
  const at: Vec3 = [0, place.height, 0];
  const simOpts: SimOptions = { seed: o.seed ?? 1, at, floor: 0, target: place.dummy, resolve: o.resolve };
  const bounds = effectBounds(spec, simOpts);
  const framing = frameEffect(bounds, fw / fh, 40, place.dummy ? at : null);
  const camera = cameraOf(framing);
  const times = (o.times?.length ? [...o.times].sort((a, b) => a - b) : sheetTimes(spec, bounds)).slice(0, 12);
  const sim = new EffectSim(spec, simOpts);
  const frames: FxFrame[] = [];
  for (const t of times) {
    sim.advance(t);
    frames.push(sim.frame());
  }
  const gap = 4;
  const width = times.length * (fw + gap) + gap;
  const height = stages.length * (fh + gap) + gap;
  const image: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
  for (let i = 0; i < width * height; i++) image.data.set([24, 22, 20, 255], i * 4);
  const notes = new Set<string>();
  const textures: TextureLookup = (ref) => {
    const t = o.textures(ref);
    if (t.note) notes.add(t.note);
    return t;
  };
  const reads: StageRead[] = [];
  const perStage: Array<Map<string, LayerInk>> = [];
  const coverage = { perFrame: [] as number[], peak: 0, at: 0, center: 0 };
  stages.forEach((name, row) => {
    const layers = new Map<string, LayerInk>();
    perStage.push(layers);
    const base: RenderOptions = { width: fw * 2, height: fh * 2, camera, stage: STAGES[name], textures, dummy: place.dummy ? at : null, layers };
    // The stage with nothing playing: what the effect is seen against.
    const empty = halve(renderFrame(blank(), { ...base, layers: undefined }));
    let best = { cover: -1, white: 0, color: null as string | null };
    frames.forEach((frame, col) => {
      const c = halve(renderFrame(frame, base));
      let covered = 0;
      let white = 0;
      let mid = 0;
      let midCount = 0;
      const sum: Vec3 = [0, 0, 0];
      let weight = 0;
      for (let i = 0; i < fw * fh; i++) {
        const r = c.rgb[i * 3]!;
        const g = c.rgb[i * 3 + 1]!;
        const b = c.rgb[i * 3 + 2]!;
        const x = i % fw;
        const y = Math.floor(i / fw);
        const ink = c.ink[i]!;
        if (ink > 0.1) {
          covered++;
          if (r > 0.965 && g > 0.965 && b > 0.965) white++;
          const d = (Math.abs(r - empty.rgb[i * 3]!) + Math.abs(g - empty.rgb[i * 3 + 1]!) + Math.abs(b - empty.rgb[i * 3 + 2]!)) / 3;
          sum[0] += r * d;
          sum[1] += g * d;
          sum[2] += b * d;
          weight += d;
        }
        if (Math.abs(x - fw / 2) < fw * 0.1 && Math.abs(y - fh / 2) < fh * 0.1) {
          mid += ink;
          midCount++;
        }
        image.data.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255], ((gap + row * (fh + gap) + y) * width + gap + col * (fw + gap) + x) * 4);
      }
      const cover = covered / (fw * fh);
      if (row === 0) {
        coverage.perFrame.push(Math.round(cover * 1000) / 1000);
        if (cover > coverage.peak) Object.assign(coverage, { peak: Math.round(cover * 1000) / 1000, at: Math.round(frame.t * 100) / 100, center: Math.round((mid / Math.max(1, midCount)) * 100) / 100 });
      }
      if (cover > best.cover) best = { cover, white: covered ? white / covered : 0, color: weight > 0 ? rgbToHex([sum[0] / weight, sum[1] / weight, sum[2] / weight]) : null };
      label(image, `${frame.t.toFixed(2)}s`, gap + col * (fw + gap) + 6, gap + row * (fh + gap) + 6);
    });
    let ink = 0;
    let shown = 0;
    let onSky = 0;
    for (const l of layers.values()) {
      ink += l.ink;
      shown += l.shown;
      onSky += l.shownOnSky;
    }
    const share = (v: number) => (ink > 0 ? Math.round(Math.min(1, v / ink) * 100) / 100 : 0);
    reads.push({ stage: name, shown: share(shown), ...(name === 'day' ? { onSky: share(onSky) } : {}), whiteOut: Math.round(best.white * 100) / 100, color: best.color });
  });
  const first = perStage[0] ?? new Map<string, LayerInk>();
  const total = [...first.values()].reduce((n, l) => n + l.ink, 0);
  const authoredSum: Vec3 = [0, 0, 0];
  for (const l of first.values()) for (let k = 0; k < 3; k++) authoredSum[k] = authoredSum[k]! + l.color[k]!;
  const shownOf = (m: Map<string, LayerInk>, name: string) => {
    const x = m.get(name);
    return x && x.ink > 0 ? Math.round(Math.min(1, x.shown / x.ink) * 100) / 100 : 0;
  };
  const day = perStage[stages.indexOf('day')];
  const skyOf = (name: string) => {
    const x = day?.get(name);
    return x && x.ink > 0 ? Math.round(Math.min(1, x.shownOnSky / x.ink) * 100) / 100 : 0;
  };
  const layers: LayerRead[] = [...first.entries()]
    .map(([name, l]) => ({ name, share: total > 0 ? Math.round((l.ink / total) * 100) / 100 : 0, shown: perStage.map((m) => shownOf(m, name)), onSky: day ? skyOf(name) : null, glows: l.emission >= 0.5, overdraw: l.pixels > 0 ? Math.round((l.fragments / l.pixels) * 10) / 10 : 1 }))
    .sort((a, b) => b.share - a.share);
  return {
    image,
    times: frames.map((f) => Math.round(f.t * 100) / 100),
    stages,
    framing,
    distance: Math.round(framing.distance * 10) / 10,
    coverage,
    reads,
    layers,
    authored: total > 0 ? rgbToHex([authoredSum[0] / total, authoredSum[1] / total, authoredSum[2] / total]) : null,
    notes: [...notes],
  };
}

/** A single frame as an image (tests, and pictures of one moment). */
export function renderStill(spec: EffectSpec, t: number, o: SheetOptions & { stage?: FxStage['name']; size?: [number, number] }): RgbaImage {
  const [w, h] = o.size ?? [512, 384];
  const place = placementOf(spec);
  const at: Vec3 = [0, place.height, 0];
  const simOpts: SimOptions = { seed: o.seed ?? 1, at, floor: 0, target: place.dummy, resolve: o.resolve };
  const camera = cameraOf(frameEffect(effectBounds(spec, simOpts), w / h, 40, place.dummy ? at : null));
  const sim = new EffectSim(spec, simOpts);
  sim.advance(t);
  const c = halve(renderFrame(sim.frame(), { width: w * 2, height: h * 2, camera, stage: STAGES[o.stage ?? 'dark'], textures: o.textures, dummy: place.dummy ? at : null }));
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([Math.round(c.rgb[i * 3]! * 255), Math.round(c.rgb[i * 3 + 1]! * 255), Math.round(c.rgb[i * 3 + 2]! * 255), 255], i * 4);
  return { width: w, height: h, data };
}
