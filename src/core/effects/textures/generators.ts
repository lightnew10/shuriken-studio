import { clamp01, fbm3, perlin3, Raster, rng, smoothstep, worley } from './raster';

/**
 * VFX textures from parameters. Each kind draws one frame, or a flipbook of frames (2x2, 4x4 or 8x8 cells:
 * Roblox's FlipbookLayout) that evolves over the flipbook's time `t` 0..1. Textures are WHITE by default
 * (alpha carries the shape, brightness the form): Roblox multiplies them by the emitter's, beam's or
 * trail's Color, so one texture serves every element. Shapes stay inside their cell with a transparent
 * margin, so mipmaps and filtering never pull in a neighbouring frame.
 */

export type TextureKind =
  | 'soft'
  | 'glow'
  | 'smoke'
  | 'fire'
  | 'spark'
  | 'star'
  | 'ring'
  | 'slash'
  | 'trail'
  | 'electric'
  | 'energy'
  | 'dust'
  | 'debris'
  | 'magic'
  | 'gradient'
  | 'rain'
  | 'snow'
  | 'leaf'
  | 'splash'
  | 'water'
  | 'lightshaft'
  | 'wind'
  | 'vignette';

export interface KindInfo {
  description: string;
  /** Parameters with their default and range (agents describe textures with these). */
  params: Record<string, string>;
  /** A built-in Roblox texture of the same family, used in the place until it is uploaded. */
  fallback: string;
  /** Default frames (1 = a still). */
  frames: number;
  /** Width/height (strips for beams and trails are wider than tall). */
  aspect?: number;
  /** Its flipbook cells are variants (a Random flipbook), not frames in time. */
  variants?: boolean;
  /** Fills its whole image on purpose (strips, gradients, screen overlays): no transparent margin. */
  fullBleed?: boolean;
}

const P = 'rbxasset://textures/particles/';
export const TEXTURE_KINDS: Record<TextureKind, KindInfo> = {
  soft: { description: 'A soft round particle: the base of glows, dust, mist and stylised puffs.', params: { hardness: '0.25 (0 all falloff … 0.95 crisp disc)', falloff: '"smooth" | "gaussian" | "linear"' }, fallback: `${P}forcefield_glow_main.dds`, frames: 1 },
  glow: { description: 'A bright core with a long exponential halo: flashes, orbs, fireflies, lights.', params: { core: '0.12 (bright centre size 0..0.5)', falloff: '2.5 (1 wide halo … 6 tight)' }, fallback: `${P}forcefield_glow_main.dds`, frames: 1 },
  smoke: { description: 'A lit, billowy smoke puff (self-shadowed from a light direction, so tinting keeps its volume); as a flipbook it churns, grows and thins out.', params: { billows: '6 (2..12 round lumps)', detail: '0.5 (0 smooth … 1 wispy)', shading: '0.55 (0 flat … 1 deep shadows; shadows stay light grey, never black)', light: '[-0.5, -0.7] (direction light comes from, screen x right / y down)', density: '0.75', dissolve: '0.7 (flipbook: how much it thins by the last frame)', expand: '0.25 (flipbook: growth)', loop: 'false (true: the last frame flows into the first)' }, fallback: `${P}explosion01_smoke_main.dds`, frames: 16 },
  fire: { description: 'A flame: a teardrop of turbulent fire, hotter (brighter) at the core; as a flipbook the turbulence rises.', params: { shape: '"tongue" | "ball" | "wisps"', turbulence: '0.6', core: '0.5 (how much of it is white-hot)', loop: 'true' }, fallback: `${P}fire_main.dds`, frames: 16 },
  spark: { description: 'A thin streak with a hot head and a fading tail: sparks, embers in motion, tracers (VelocityParallel).', params: { thickness: '0.06', tail: '0.7 (0 even … 1 long fade)', glow: '0.4' }, fallback: `${P}fire_sparks_main.dds`, frames: 1 },
  star: { description: 'An impact star: sharp rays from a hot centre (hit flashes, crits, sparkles).', params: { points: '6', spikiness: '0.75', glow: '0.5', irregular: '0.3 (ray length variation)' }, fallback: `${P}sparkles_main.dds`, frames: 1 },
  ring: { description: 'A shock ring: a soft-edged band with a faint inside, optionally broken up (ground rings, sonic booms).', params: { radius: '0.4', width: '0.06', softness: '0.5', inner: '0.15 (inside fill)', breakup: '0 (0 clean … 1 torn)' }, fallback: `${P}explosion01_shockwave_main.dds`, frames: 1 },
  slash: { description: 'A crescent slash: a curved blade of light with a bright leading edge fading to its tail; as a flipbook (OneShot) the arc sweeps open and fades.', params: { arc: '200 (degrees swept)', thickness: '0.16', taper: '0.8', edge: '0.7 (bright cutting edge)', fade: '0.8 (tail fade)', streaks: '0.3 (speed streaks inside)' }, fallback: `${P}explosion01_shockwave_main.dds`, frames: 1 },
  trail: { description: 'A strip for Trails and Beams (U along the length, V across): a soft or cored cross-section, optional flowing noise, tileable along its length.', params: { profile: '"soft" | "core" | "edge" | "double"', flow: '0.3 (noise along the length)', fadeEnds: 'false' }, fallback: '', frames: 1, aspect: 4, fullBleed: true },
  electric: { description: 'Lightning bolts with forks and glow; a flipbook holds different bolts (FlipbookMode Random flickers between them).', params: { branches: '2', jitter: '0.5', thickness: '0.02', glow: '0.6' }, fallback: `${P}fire_sparks_main.dds`, frames: 4, variants: true },
  energy: { description: 'Swirling plasma: domain-warped noise in an orb, or a tileable strip for beams.', params: { shape: '"orb" | "tile"', swirl: '0.6', scale: '3', contrast: '0.6' }, fallback: `${P}forcefield_vortex_main.dds`, frames: 1 },
  dust: { description: 'Clumpy, grainy dust: lower alpha than smoke, for footsteps, landings and debris clouds.', params: { clumps: '9', grain: '0.5', density: '0.6' }, fallback: `${P}smoke_main.dds`, frames: 1 },
  debris: { description: 'Rock chips and shards (one per cell, shaded) for a Random flipbook of pieces.', params: { jagged: '0.6', shading: '0.6', sharp: 'false (true: shards)' }, fallback: `${P}SquareParticle.png`, frames: 4, variants: true },
  magic: { description: 'A magic circle: concentric rings, a polygon or star, ticks and rune marks (ground decals, telegraphs, summons).', params: { rings: '2', sides: '6', star: 'true', runes: '12', ticks: '36', thickness: '0.012' }, fallback: `${P}explosion01_shockwave_main.dds`, frames: 1 },
  gradient: { description: 'A ramp: linear (U) or radial, alpha stops [[t, alpha], …].', params: { mode: '"linear" | "radial"', stops: '[[0, 1], [1, 0]]' }, fallback: '', frames: 1, fullBleed: true },
  rain: { description: 'A raindrop streak (VelocityParallel).', params: { thickness: '0.05' }, fallback: `${P}fire_sparks_main.dds`, frames: 1 },
  snow: { description: 'A soft snowflake.', params: { arms: '6', soft: '0.5' }, fallback: `${P}sparkles_main.dds`, frames: 1 },
  leaf: { description: 'Leaf silhouettes with a vein, one per cell (Random flipbook), for falling leaves.', params: { width: '0.45', serration: '0.2' }, fallback: `${P}SquareParticle.png`, frames: 4, variants: true },
  splash: { description: 'A water splash: a crown ring that opens and breaks into droplets (OneShot flipbook).', params: { droplets: '10' }, fallback: `${P}explosion01_shockwave_main.dds`, frames: 16 },
  water: { description: 'Falling-water streaks, tileable along U, for a waterfall Beam with TextureSpeed.', params: { streaks: '18', foam: '0.4' }, fallback: `${P}smoke_main.dds`, frames: 1, aspect: 0.5, fullBleed: true },
  lightshaft: { description: 'A soft shaft of light for a Beam (bright down its middle, fading at the sides and ends).', params: { width: '0.5', fadeEnds: 'true' }, fallback: '', frames: 1, aspect: 0.5, fullBleed: true },
  wind: { description: 'A faint wind streak with fading ends (wind lines, speed lines in 3D).', params: { thickness: '0.03', curl: '0.2' }, fallback: `${P}fire_sparks_main.dds`, frames: 1, aspect: 4, fullBleed: true },
  vignette: { description: 'A screen vignette for an ImageLabel (dark edges, clear middle).', params: { inner: '0.45', outer: '0.95' }, fallback: '', frames: 1, fullBleed: true },
};

export type Params = Record<string, unknown>;
type Rgba = [number, number, number, number];

const num = (p: Params, k: string, d: number, lo = -1e9, hi = 1e9) => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
const bool = (p: Params, k: string, d: boolean) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : d);
const str = <T extends string>(p: Params, k: string, options: readonly T[], d: T): T => (options.includes(p[k] as T) ? (p[k] as T) : d);

export interface Drawn {
  raster: Raster;
  /** Cells per side (1 = a still). */
  grid: number;
}

/** Cells per side for a frame count: 1, 4 → 2, 16 → 4, 64 → 8. */
export const gridFor = (frames: number) => (frames >= 64 ? 8 : frames >= 16 ? 4 : frames >= 4 ? 2 : 1);

function cells(r: Raster, grid: number, draw: (cell: { x: number; y: number; w: number; h: number }, index: number, t: number) => void): void {
  const cw = Math.floor(r.w / grid);
  const ch = Math.floor(r.h / grid);
  const count = grid * grid;
  for (let i = 0; i < count; i++) draw({ x: (i % grid) * cw, y: Math.floor(i / grid) * ch, w: cw, h: ch }, i, count > 1 ? i / (count - 1) : 0);
}

const WHITE = (a: number, l = 1): Rgba => [l, l, l, a];

/** Distance from the cell centre, 0 at the centre and 1 at the edge's midpoint. */
const radial = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5) * 2;

export function draw(kind: TextureKind, params: Params, size: number, frames: number, seed: number): Drawn {
  const info = TEXTURE_KINDS[kind];
  const grid = gridFor(frames);
  const aspect = info.aspect ?? 1;
  const w = aspect >= 1 ? size : Math.max(16, Math.round(size * aspect));
  const h = aspect >= 1 ? Math.max(16, Math.round(size / aspect)) : size;
  const r = new Raster(w, h);
  const noise = perlin3(seed);
  const rand = rng(seed);
  const ss = size <= 256 ? 2 : 1;

  switch (kind) {
    case 'soft': {
      const hard = num(params, 'hardness', 0.25, 0, 0.95);
      const fall = str(params, 'falloff', ['smooth', 'gaussian', 'linear'] as const, 'smooth');
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          const d = radial(u, v) / 0.94;
          if (d >= 1) return WHITE(0);
          const x = clamp01((d - hard) / (1 - hard));
          const a = fall === 'gaussian' ? Math.exp(-x * x * 4.5) * (1 - x) : fall === 'linear' ? 1 - x : 1 - smoothstep(0, 1, x);
          return WHITE(d < hard ? 1 : a);
        }, c, ss),
      );
      break;
    }
    case 'glow': {
      const core = num(params, 'core', 0.12, 0, 0.5);
      const fall = num(params, 'falloff', 2.5, 0.5, 8);
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          const d = radial(u, v) / 0.95;
          if (d >= 1) return WHITE(0);
          const halo = Math.exp(-fall * 3 * d) * (1 - d * d);
          const hot = core > 0 ? clamp01(1 - d / core) : 0;
          return WHITE(clamp01(halo + hot), 1);
        }, c, ss),
      );
      break;
    }
    case 'smoke': {
      const billows = Math.round(num(params, 'billows', 6, 2, 12));
      const detail = num(params, 'detail', 0.5, 0, 1);
      const shading = num(params, 'shading', 0.55, 0, 1);
      const density = num(params, 'density', 0.75, 0.1, 1);
      const dissolve = num(params, 'dissolve', 0.7, 0, 1);
      const expand = num(params, 'expand', 0.25, 0, 1);
      const loop = bool(params, 'loop', false);
      const light = Array.isArray(params.light) && params.light.length === 2 ? (params.light as number[]) : [-0.5, -0.7];
      const ll = Math.hypot(light[0]!, light[1]!) || 1;
      const lx = light[0]! / ll;
      const ly = light[1]! / ll;
      // A height field: soft blobs (metaballs) round the centre, roughened by fractal noise. Its iso-contour is
      // the puff's silhouette and its slope gives the light and shadow.
      const lumps = Array.from({ length: billows }, (_, i) => {
        const a = (i / billows) * Math.PI * 2 + rand() * 0.9;
        const d = 0.16 + rand() * 0.11;
        return { x: 0.5 + Math.cos(a) * d, y: 0.5 + Math.sin(a) * d * 0.9, r: 0.15 + rand() * 0.06 };
      });
      lumps.push({ x: 0.5, y: 0.5, r: 0.22 });
      const height = (u: number, v: number, t: number) => {
        const grow = 1.22 + expand * t * 0.22;
        const cu = 0.5 + (u - 0.5) / grow;
        const cv = 0.5 + (v - 0.5) / grow;
        let field = 0;
        for (const l of lumps) {
          const d = Math.hypot(cu - l.x, cv - l.y) / l.r;
          field += Math.exp(-d * d * 2.2);
        }
        const z = loop ? Math.cos(t * Math.PI * 2) * 0.7 : t * 1.2;
        const z2 = loop ? Math.sin(t * Math.PI * 2) * 0.7 : 0;
        const n = fbm3(noise, cu * 3.2 + z2, cv * 3.2 - t * 0.5, z, 4 + Math.round(detail * 2), 0.5 + detail * 0.12);
        return field * (0.85 + n * (0.45 + detail * 0.5)) + n * 0.12;
      };
      cells(r, grid, (c, _i, t) => {
        const threshold = loop ? 0.32 : 0.28 + dissolve * smoothstep(0.25, 1, t) * 0.6;
        const soft = 0.3 + detail * 0.15;
        const fade = loop ? 1 : 1 - smoothstep(0.6, 1, t) * dissolve * 0.5;
        r.paint((u, v) => {
          const edge = smoothstep(0.97, 0.86, radial(u, v));
          if (edge <= 0) return WHITE(0);
          const hgt = height(u, v, t);
          const a = smoothstep(threshold, threshold + soft, hgt) * edge * (0.8 + 0.2 * clamp01(hgt - threshold));
          if (a <= 0.002) return WHITE(0);
          // Light from the slope: faces turned toward the light are white, the far side a light grey (never
          // dark: a dark texture can only become a dark blob once the emitter's colour multiplies it).
          const e = 1 / 40;
          const gx = (height(u + e, v, t) - height(u - e, v, t)) / (2 * e);
          const gy = (height(u, v + e, t) - height(u, v - e, t)) / (2 * e);
          const nl = Math.hypot(gx, gy, 3);
          const lit = clamp01(0.5 + ((-gx * lx - gy * ly) / nl) * 1.6);
          const l = 1 - shading * 0.6 * (1 - lit);
          return [l, l, l, clamp01(a * density * 1.3) * fade];
        }, c, 1);
      });
      break;
    }
    case 'fire': {
      const shape = str(params, 'shape', ['tongue', 'ball', 'wisps'] as const, 'tongue');
      const turb = num(params, 'turbulence', 0.6, 0, 1);
      const core = num(params, 'core', 0.5, 0, 1);
      cells(r, grid, (c, _i, t) =>
        r.paint((u, v) => {
          const x = (u - 0.5) * 2;
          const y = v; // 0 top, 1 bottom
          const z = Math.cos(t * Math.PI * 2) * 0.8;
          const z2 = Math.sin(t * Math.PI * 2) * 0.8;
          const n = fbm3(noise, u * 3 + z2, v * 3 + t * 2, z, 4) * turb;
          let body: number;
          if (shape === 'ball') body = 1 - radial(u, v) / 0.8 + n * 0.5;
          else {
            // A teardrop, wide at the bottom; higher up the noise tears it into licking tongues.
            const rise = 1 - y; // 0 bottom … 1 top
            const width = shape === 'wisps' ? 0.22 + y * 0.3 : 0.12 + Math.sin(clamp01(y) * Math.PI * 0.85) * 0.5;
            const sway = n * 0.7 * rise;
            const tongues = fbm3(noise, x * 2.5 + z2, y * 5 + t * 3, z + 7.7, 3) * rise * turb * 1.2;
            body = 1 - Math.abs(x + sway) / Math.max(width, 0.05) - rise * 0.25 + tongues + n * 0.25;
            body *= smoothstep(0.97, 0.8, y) * smoothstep(0.02, 0.12, y);
          }
          const a = clamp01(body * 1.5) * smoothstep(1, 0.9, radial(u, v) * 0.9);
          const hot = clamp01((body - (1 - core) * 0.6) * 2);
          const l = 0.55 + 0.45 * hot;
          return [l, l, l, a];
        }, c, 1),
      );
      break;
    }
    case 'spark':
    case 'rain':
    case 'wind': {
      const thick = num(params, 'thickness', kind === 'rain' ? 0.05 : kind === 'wind' ? 0.03 : 0.06, 0.005, 0.3);
      const tail = num(params, 'tail', kind === 'spark' ? 0.7 : 0.4, 0, 1);
      const glow = num(params, 'glow', kind === 'spark' ? 0.4 : 0.15, 0, 1);
      const curl = kind === 'wind' ? num(params, 'curl', 0.2, 0, 1) : 0;
      const vertical = kind !== 'wind';
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          // Along: 0 at the head, 1 at the tail end (vertical streaks: head at the top).
          const along = vertical ? v : u;
          let across = (vertical ? u : v) - 0.5;
          if (curl) across -= Math.sin(along * Math.PI * 2) * curl * 0.15;
          const len = smoothstep(0.03, 0.12, along) * (1 - smoothstep(0.88, 0.97, along));
          const taper = 1 - tail * along;
          const core = Math.exp(-((across / (thick * taper + 1e-4)) ** 2) * 2);
          const halo = glow * Math.exp(-((across / (thick * 3.5 + 1e-4)) ** 2)) * 0.5;
          const a = clamp01((core + halo) * len * (kind === 'wind' ? 0.6 : 1));
          return WHITE(a, kind === 'spark' ? 0.8 + 0.2 * (1 - along) : 1);
        }, c, ss),
      );
      break;
    }
    case 'star': {
      const points = Math.round(num(params, 'points', 6, 3, 16));
      const spiky = num(params, 'spikiness', 0.75, 0, 1);
      const glow = num(params, 'glow', 0.5, 0, 1);
      const irregular = num(params, 'irregular', 0.3, 0, 1);
      const lengths = Array.from({ length: points }, () => 1 - irregular * rand() * 0.6);
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          const dx = u - 0.5;
          const dy = v - 0.5;
          const d = Math.hypot(dx, dy) * 2;
          const ang = Math.atan2(dy, dx);
          const sector = ((ang / (Math.PI * 2)) * points + points) % points;
          const i = Math.floor(sector + 0.5) % points;
          const off = Math.abs(sector - Math.round(sector));
          const rayLen = 0.92 * lengths[i]!;
          const ray = Math.exp(-((off / (0.5 - spiky * 0.46)) ** 2) * 3 * (1 + d * 6)) * clamp01(1 - d / rayLen);
          const core = Math.exp(-d * d * 30);
          const halo = glow * Math.exp(-d * 5) * 0.6 * (1 - d);
          return WHITE(clamp01(ray + core + halo) * smoothstep(1, 0.9, d));
        }, c, ss),
      );
      break;
    }
    case 'ring': {
      const radius = num(params, 'radius', 0.4, 0.1, 0.46);
      const width = num(params, 'width', 0.06, 0.005, 0.3);
      const soft = num(params, 'softness', 0.5, 0, 1);
      const inner = num(params, 'inner', 0.15, 0, 1);
      const breakup = num(params, 'breakup', 0, 0, 1);
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          const d = Math.hypot(u - 0.5, v - 0.5);
          const band = Math.exp(-(((d - radius) / (width * (0.5 + soft))) ** 2) * 2);
          const fill = inner * smoothstep(radius, radius * 0.4, d) * smoothstep(0, radius, d) * 0.6;
          const ang = Math.atan2(v - 0.5, u - 0.5);
          const torn = breakup > 0 ? clamp01(0.6 + noise(Math.cos(ang) * 3, Math.sin(ang) * 3, d * 8) * 2 - breakup) : 1;
          return WHITE(clamp01(band * torn + fill) * smoothstep(0.5, 0.47, d));
        }, c, ss),
      );
      break;
    }
    case 'slash': {
      const arc = num(params, 'arc', 200, 30, 330);
      const thick = num(params, 'thickness', 0.16, 0.03, 0.4);
      const taper = num(params, 'taper', 0.8, 0, 1);
      const edge = num(params, 'edge', 0.7, 0, 1);
      const fade = num(params, 'fade', 0.8, 0, 1);
      const streaks = num(params, 'streaks', 0.3, 0, 1);
      const radius = 0.4;
      cells(r, grid, (c, _i, t) => {
        // Flipbook: the arc sweeps open over the first 60 %, then thins and fades.
        const animated = grid > 1;
        const open = animated ? smoothstep(0, 0.6, t) : 1;
        const gone = animated ? smoothstep(0.45, 1, t) : 0;
        r.paint((u, v) => {
          const dx = u - 0.5;
          const dy = 0.5 - v;
          const d = Math.hypot(dx, dy);
          // The sweep runs counter-clockwise over the top, from the right (its tail) to the left (its head):
          // s is 0 at the tail and 1 at the leading edge.
          const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
          const start = 90 - arc / 2;
          const s = ((((deg - start) % 360) + 360) % 360) / arc;
          if (s > 1) return WHITE(0);
          const head = open;
          if (s > head) return WHITE(0);
          const along = head > 0 ? s / head : 0; // 0 tail … 1 head
          // Widest just behind the head, a point at both ends.
          const profile = Math.sin(Math.PI * clamp01(along) ** 0.75) ** 0.8;
          const width = thick * (1 - taper + taper * profile) * (1 - gone * 0.6);
          const outer = radius;
          const inside = outer - width;
          const radial01 = (d - inside) / Math.max(width, 1e-4); // 0 inner edge … 1 outer edge
          if (radial01 < -0.15 || radial01 > 1.15) return WHITE(0);
          const body = smoothstep(-0.15, 0.35, radial01) * (1 - smoothstep(0.85, 1.12, radial01));
          const cutting = edge * Math.exp(-(((radial01 - 0.88) / 0.12) ** 2));
          const lines = streaks > 0 ? 1 - streaks * 0.5 * (0.5 + 0.5 * Math.sin(radial01 * 40 + noise(along * 4, radial01 * 3, 0) * 3)) : 1;
          const tailFade = smoothstep(0, 0.15 + fade * 0.75, along) * smoothstep(1, 0.96, along);
          const a = clamp01((body * lines * 0.8 + cutting) * tailFade * (1 - gone));
          return WHITE(a, 0.85 + 0.15 * cutting);
        }, c, ss);
      });
      break;
    }
    case 'trail': {
      const profile = str(params, 'profile', ['soft', 'core', 'edge', 'double'] as const, 'soft');
      const flow = num(params, 'flow', 0.3, 0, 1);
      const fadeEnds = bool(params, 'fadeEnds', false);
      r.paint((u, v) => {
        const y = Math.abs(v - 0.5) * 2;
        let a: number;
        if (profile === 'core') a = Math.exp(-y * y * 18) + 0.45 * Math.exp(-y * y * 3);
        else if (profile === 'edge') a = Math.exp(-(((y - 0.75) / 0.15) ** 2)) + 0.25 * (1 - y);
        else if (profile === 'double') a = Math.exp(-(((y - 0.45) / 0.2) ** 2)) + 0.2;
        else a = Math.exp(-y * y * 3.2);
        a *= 1 - smoothstep(0.85, 1, y);
        // Noise on a cylinder in U: the strip tiles end to end.
        const ang = u * Math.PI * 2;
        const n = flow > 0 ? fbm3(noise, Math.cos(ang) * 1.2, Math.sin(ang) * 1.2, v * 3, 3) : 0;
        a *= 1 - flow * 0.5 + flow * n;
        if (fadeEnds) a *= smoothstep(0, 0.15, u) * (1 - smoothstep(0.85, 1, u));
        return WHITE(clamp01(a), 0.9 + 0.1 * (1 - y));
      }, undefined, 1);
      break;
    }
    case 'electric': {
      const branches = Math.round(num(params, 'branches', 2, 0, 5));
      const jitter = num(params, 'jitter', 0.5, 0, 1);
      const thick = num(params, 'thickness', 0.02, 0.004, 0.08);
      const glow = num(params, 'glow', 0.6, 0, 1);
      cells(r, grid, (c) => {
        const bolts: Array<Array<[number, number]>> = [];
        const bolt = (x0: number, y0: number, x1: number, y1: number, depth: number, amp: number) => {
          let pts: Array<[number, number]> = [[x0, y0], [x1, y1]];
          for (let level = 0; level < 6; level++) {
            const next: Array<[number, number]> = [];
            for (let i = 0; i < pts.length - 1; i++) {
              const [ax, ay] = pts[i]!;
              const [bx, by] = pts[i + 1]!;
              const len = Math.hypot(bx - ax, by - ay);
              const nx = -(by - ay) / (len || 1);
              const ny = (bx - ax) / (len || 1);
              const off = (rand() - 0.5) * len * amp;
              next.push([ax, ay], [(ax + bx) / 2 + nx * off, (ay + by) / 2 + ny * off]);
            }
            next.push(pts[pts.length - 1]!);
            pts = next;
          }
          bolts.push(pts);
          if (depth < 1) {
            for (let b = 0; b < branches; b++) {
              const from = pts[Math.floor(pts.length * (0.25 + rand() * 0.5))]!;
              const ang = Math.atan2(y1 - y0, x1 - x0) + (rand() - 0.5) * 1.6;
              const reach = 0.15 + rand() * 0.2;
              bolt(from[0], from[1], from[0] + Math.cos(ang) * reach, from[1] + Math.sin(ang) * reach, depth + 1, amp);
            }
          }
        };
        bolt(0.5 + (rand() - 0.5) * 0.16, 0.12, 0.5 + (rand() - 0.5) * 0.16, 0.88, 0, 0.25 + jitter * 0.35);
        for (const pts of bolts) for (const pt of pts) [pt[0], pt[1]] = [Math.min(0.84, Math.max(0.16, pt[0])), Math.min(0.86, Math.max(0.14, pt[1]))];
        r.paint((u, v) => {
          let best = 9;
          bolts.forEach((pts) => {
            for (let i = 0; i < pts.length - 1; i++) {
              const [ax, ay] = pts[i]!;
              const [bx, by] = pts[i + 1]!;
              const vx = bx - ax;
              const vy = by - ay;
              const t = clamp01(((u - ax) * vx + (v - ay) * vy) / (vx * vx + vy * vy || 1));
              const d = Math.hypot(u - ax - vx * t, v - ay - vy * t);
              if (d < best) best = d;
            }
          });
          const core = Math.exp(-((best / thick) ** 2) * 1.5);
          const halo = glow * Math.exp(-best / (thick * 2.5)) * 0.55;
          return WHITE(clamp01(core + halo) * smoothstep(0.5, 0.42, Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5))), 0.85 + 0.15 * core);
        }, c, 1);
      });
      break;
    }
    case 'energy': {
      const shape = str(params, 'shape', ['orb', 'tile'] as const, 'orb');
      const swirl = num(params, 'swirl', 0.6, 0, 1);
      const scale = num(params, 'scale', 3, 1, 10);
      const contrast = num(params, 'contrast', 0.6, 0, 1);
      cells(r, grid, (c, _i, t) =>
        r.paint((u, v) => {
          const ang = u * Math.PI * 2;
          const x = shape === 'tile' ? Math.cos(ang) * scale * 0.3 : (u - 0.5) * scale;
          const y = shape === 'tile' ? Math.sin(ang) * scale * 0.3 : (v - 0.5) * scale;
          const z = shape === 'tile' ? v * scale * 0.5 : t * 2;
          const wx = fbm3(noise, x, y, z, 3) * swirl * 2;
          const wy = fbm3(noise, x + 5.2, y + 1.3, z, 3) * swirl * 2;
          const n = fbm3(noise, x + wx, y + wy, z + 3.7, 4);
          const veins = 1 - Math.abs(n) * (2 + contrast * 4);
          let a = clamp01(0.25 + veins * 0.75);
          if (shape === 'orb') a *= smoothstep(1, 0.6, radial(u, v)) * (0.6 + 0.4 * (1 - radial(u, v)));
          return WHITE(a, 0.75 + 0.25 * clamp01(veins));
        }, c, 1),
      );
      break;
    }
    case 'dust': {
      const clumps = Math.round(num(params, 'clumps', 9, 3, 24));
      const grain = num(params, 'grain', 0.5, 0, 1);
      const density = num(params, 'density', 0.6, 0.1, 1);
      const cell = worley(seed, 3 + clumps / 3);
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          const base = 1 - radial(u, v) / 0.92;
          if (base <= 0) return WHITE(0);
          const lumps = 1 - cell(u, v) * 1.4;
          const g = grain > 0 ? noise(u * 60, v * 60, 3.3) * grain * 0.5 : 0;
          const a = clamp01((base * 1.3 + lumps * 0.5 - 0.35 + g) * density);
          return WHITE(a, 0.85 + 0.15 * lumps);
        }, c, 1),
      );
      break;
    }
    case 'debris': {
      const jagged = num(params, 'jagged', 0.6, 0, 1);
      const shading = num(params, 'shading', 0.6, 0, 1);
      const sharp = bool(params, 'sharp', false);
      cells(r, grid, (c) => {
        const corners = sharp ? 3 + Math.floor(rand() * 2) : 5 + Math.floor(rand() * 3);
        const pts = Array.from({ length: corners }, (_, i) => {
          const a = (i / corners) * Math.PI * 2 + (rand() - 0.5) * jagged * 0.9;
          const d = (sharp ? 0.2 + rand() * 0.22 : 0.26 + rand() * 0.14) * (1 - jagged * 0.3 * rand());
          return [0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d] as [number, number];
        });
        const inside = (u: number, v: number) => {
          let ins = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i]!;
            const [xj, yj] = pts[j]!;
            if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) ins = !ins;
          }
          return ins;
        };
        r.paint((u, v) => {
          if (!inside(u, v)) return WHITE(0);
          // Facets: shade by a fixed light from the top left plus a little noise.
          const facet = 0.5 + 0.5 * noise(u * 6, v * 6, 1.1);
          const l = 1 - shading * 0.5 * (1 - clamp01((0.5 - u + 0.5 - v) * 0.8 + facet * 0.6));
          return [l, l, l, 1];
        }, c, ss);
      });
      break;
    }
    case 'magic': {
      const rings = Math.round(num(params, 'rings', 2, 1, 4));
      const sides = Math.round(num(params, 'sides', 6, 3, 12));
      const star = bool(params, 'star', true);
      const runes = Math.round(num(params, 'runes', 12, 0, 32));
      const ticks = Math.round(num(params, 'ticks', 36, 0, 96));
      const t = num(params, 'thickness', 0.012, 0.003, 0.04);
      const line = (d: number) => Math.exp(-((d / t) ** 2));
      const runeAngles = Array.from({ length: runes }, (_, i) => ({ a: (i / Math.max(runes, 1)) * Math.PI * 2, kind: Math.floor(rand() * 4), tilt: rand() }));
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          const dx = u - 0.5;
          const dy = v - 0.5;
          const d = Math.hypot(dx, dy);
          const ang = Math.atan2(dy, dx);
          let a = 0;
          // Rings: an outer double ring, then inner ones.
          a = Math.max(a, line(d - 0.46), line(d - 0.43));
          for (let i = 1; i < rings; i++) a = Math.max(a, line(d - (0.43 - i * 0.12)));
          // Ticks between the outer rings.
          if (ticks > 0 && d > 0.43 && d < 0.46) {
            const s = ((ang / (Math.PI * 2)) * ticks + ticks) % 1;
            a = Math.max(a, Math.exp(-(((s - 0.5) / 0.08) ** 2)) * 0.9);
          }
          // A polygon (or a star polygon) inscribed in the inner ring.
          const R = 0.43 - Math.max(1, rings - 1) * 0.12 + 0.01;
          const step = star ? 2 : 1;
          for (let i = 0; i < sides; i++) {
            const a0 = (i / sides) * Math.PI * 2 - Math.PI / 2;
            const a1 = (((i + step) % sides) / sides) * Math.PI * 2 - Math.PI / 2;
            const ax = Math.cos(a0) * R;
            const ay = Math.sin(a0) * R;
            const bx = Math.cos(a1) * R;
            const by = Math.sin(a1) * R;
            const vx = bx - ax;
            const vy = by - ay;
            const k = clamp01(((dx - ax) * vx + (dy - ay) * vy) / (vx * vx + vy * vy));
            a = Math.max(a, line(Math.hypot(dx - ax - vx * k, dy - ay - vy * k)));
          }
          // Rune marks: small strokes around the band between the first two rings.
          if (runes > 0 && d > 0.33 && d < 0.42) {
            for (const r0 of runeAngles) {
              const ca = Math.cos(r0.a);
              const sa = Math.sin(r0.a);
              const lx = dx * ca + dy * sa - 0.375;
              const ly = -dx * sa + dy * ca;
              if (Math.abs(lx) > 0.03 || Math.abs(ly) > 0.03) continue;
              // Simple marks (a bar with a cap, a pair of bars, a chevron, a bar with a tick): x radial, y along the ring.
              const GLYPHS = [
                [[-0.022, 0, 0.022, 0], [0.022, -0.012, 0.022, 0.012]],
                [[-0.02, -0.008, 0.02, -0.008], [-0.02, 0.008, 0.02, 0.008]],
                [[-0.02, -0.012, 0.02, 0], [0.02, 0, -0.02, 0.012]],
                [[-0.022, 0, 0.022, 0], [-0.022, -0.012, -0.022, 0.012], [0, 0, 0.012, 0.012 * (r0.tilt > 0.5 ? 1 : -1)]],
              ];
              const strokes = GLYPHS[r0.kind]!;
              for (const [x0, y0, x1, y1] of strokes) {
                const vx = x1! - x0!;
                const vy = y1! - y0!;
                const k = clamp01(((lx - x0!) * vx + (ly - y0!) * vy) / (vx * vx + vy * vy || 1));
                a = Math.max(a, line(Math.hypot(lx - x0! - vx * k, ly - y0! - vy * k)) * 0.9);
              }
            }
          }
          return WHITE(clamp01(a) * smoothstep(0.5, 0.48, d));
        }, c, ss),
      );
      break;
    }
    case 'gradient': {
      const mode = str(params, 'mode', ['linear', 'radial'] as const, 'linear');
      const given = Array.isArray(params.stops) ? (params.stops as Array<[number, number]>).filter((s) => Array.isArray(s) && s.length === 2 && typeof s[0] === 'number' && typeof s[1] === 'number') : [];
      const stops: Array<[number, number]> = given.length ? given : [[0, 1], [1, 0]];
      const at = (x: number): number => {
        const s = [...stops].sort((a, b) => a[0] - b[0]);
        if (x <= s[0]![0]) return s[0]![1];
        for (let i = 0; i < s.length - 1; i++) if (x <= s[i + 1]![0]) return s[i]![1] + ((s[i + 1]![1] - s[i]![1]) * (x - s[i]![0])) / (s[i + 1]![0] - s[i]![0] || 1);
        return s[s.length - 1]![1];
      };
      r.paint((u, v) => WHITE(clamp01(at(mode === 'radial' ? Math.min(1, radial(u, v)) : u))));
      break;
    }
    case 'snow': {
      const arms = Math.round(num(params, 'arms', 6, 4, 8));
      const soft = num(params, 'soft', 0.5, 0, 1);
      cells(r, grid, (c) =>
        r.paint((u, v) => {
          const dx = u - 0.5;
          const dy = v - 0.5;
          const d = Math.hypot(dx, dy) * 2;
          const ang = Math.atan2(dy, dx);
          const s = Math.abs(((ang / (Math.PI * 2)) * arms + arms + 0.5) % 1 - 0.5);
          const arm = Math.exp(-((s / 0.08) ** 2)) * clamp01(1 - d / 0.85);
          const disc = Math.exp(-d * d * (8 - soft * 6));
          return WHITE(clamp01(arm * (1 - soft) + disc) * smoothstep(1, 0.9, d));
        }, c, ss),
      );
      break;
    }
    case 'leaf': {
      const width = num(params, 'width', 0.45, 0.2, 0.8);
      const serr = num(params, 'serration', 0.2, 0, 1);
      cells(r, grid, (c) => {
        const bend = (rand() - 0.5) * 0.3;
        const wid = width * (0.8 + rand() * 0.4);
        r.paint((u, v) => {
          const y = 1 - v; // 0 stem … 1 tip
          const x = u - 0.5 - bend * y * y;
          if (y < 0.08 || y > 0.94) return WHITE(Math.exp(-((x / 0.012) ** 2)) * (y < 0.08 && y > 0.02 ? 1 : 0));
          const yy = (y - 0.08) / 0.86;
          const half = wid * 0.5 * Math.sin(Math.PI * yy ** 0.8) * (1 + serr * 0.15 * Math.sin(yy * 40));
          const inLeaf = smoothstep(half + 0.01, half - 0.01, Math.abs(x));
          const vein = 1 - 0.25 * Math.exp(-((x / 0.008) ** 2));
          return [vein, vein, vein, inLeaf];
        }, c, ss);
      });
      break;
    }
    case 'splash': {
      const droplets = Math.round(num(params, 'droplets', 10, 3, 24));
      const angles = Array.from({ length: droplets }, () => rand() * Math.PI * 2);
      cells(r, grid, (c, _i, t) =>
        r.paint((u, v) => {
          const dx = u - 0.5;
          const dy = v - 0.5;
          const d = Math.hypot(dx, dy);
          const rad = 0.08 + t * 0.32;
          const ring = Math.exp(-(((d - rad) / (0.02 + 0.03 * (1 - t))) ** 2)) * (1 - t) ** 1.2;
          let drops = 0;
          for (const a of angles) {
            const px = Math.cos(a) * (rad + 0.05 + t * 0.06);
            const py = Math.sin(a) * (rad + 0.05 + t * 0.06);
            drops = Math.max(drops, Math.exp(-((Math.hypot(dx - px, dy - py) / (0.018 * (1 - t * 0.6))) ** 2)) * smoothstep(0.1, 0.3, t) * (1 - t));
          }
          return WHITE(clamp01(ring + drops) * smoothstep(0.5, 0.46, d));
        }, c, ss),
      );
      break;
    }
    case 'water': {
      const streaks = Math.round(num(params, 'streaks', 18, 4, 48));
      const foam = num(params, 'foam', 0.4, 0, 1);
      r.paint((u, v) => {
        // U across the sheet (tile edges soft), V along the fall; noise on a cylinder in V tiles the length.
        const ang = v * Math.PI * 2;
        const across = u * streaks;
        const n = fbm3(noise, across * 0.5, Math.cos(ang) * 1.5, Math.sin(ang) * 1.5, 3);
        const lines = 0.5 + 0.5 * Math.sin(across * Math.PI * 2 + n * 4);
        const sides = smoothstep(0, 0.08, u) * smoothstep(1, 0.92, u);
        const a = clamp01(0.35 + lines * 0.45 + foam * clamp01(n) * 0.5) * sides;
        return WHITE(a, 0.85 + 0.15 * lines);
      });
      break;
    }
    case 'lightshaft': {
      const width = num(params, 'width', 0.5, 0.1, 1);
      const fadeEnds = bool(params, 'fadeEnds', true);
      r.paint((u, v) => {
        const across = Math.abs(u - 0.5) * 2;
        let a = Math.exp(-((across / width) ** 2) * 2.2);
        if (fadeEnds) a *= smoothstep(0, 0.2, v) * smoothstep(1, 0.7, v);
        a *= 0.85 + 0.15 * noise(u * 8, 0.5, 2.2);
        return WHITE(clamp01(a));
      });
      break;
    }
    case 'vignette': {
      const inner = num(params, 'inner', 0.45, 0, 0.9);
      const outer = num(params, 'outer', 0.95, 0.5, 1.5);
      r.paint((u, v) => {
        const d = Math.hypot(u - 0.5, v - 0.5) * 2 / Math.SQRT2;
        return [0, 0, 0, smoothstep(inner, outer, d)];
      });
      break;
    }
  }
  return { raster: r, grid };
}
