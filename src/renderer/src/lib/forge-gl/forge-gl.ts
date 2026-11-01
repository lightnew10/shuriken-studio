import { edgesOf, fillHoles, fingerprint, gradientGeom, gradientLut, isCoverage, LUT, rgb, type Box, type ForgePlan, type PlanLayer } from '@shared/forge-plan';
import * as S from './shaders';
import type { Blend, Forged, LayerStyle, Paint, PatternKind, Stop, StrokeStyle, TextureKind } from '@shared/forge-types';

/**
 * The Forge on the GPU: draws a forge plan (@shared/forge-plan: the CPU forge's layout of an element, its shapes cut by the core)
 * to the same pixels the CPU engine draws (src/core/ui/forge/), with WebGL2 passes instead of loops. Each layer's
 * coverage is summed from its contours' exact signed areas (additive float blending), its signed distance field comes
 * from a jump flood, blurs are the CPU's (an exact Gaussian below sigma 2, three running boxes above), and every
 * layer style effect is a pass over a premultiplied float canvas; layers are laid over each other in their regions,
 * finished as pixel art when asked, and rounded to straight 8-bit RGBA as the CPU's toImage does.
 *
 * Coverage and distance fields are cached by shape, so re-forging an element in new colours (a live accent drag)
 * goes straight to the effects. One element at a time per context; calls queue.
 */

export interface ForgeGL {
  /** Draws a plan; resolves to what the CPU's forge(spec) returns for the plan's spec. */
  forge(plan: ForgePlan): Promise<Forged>;
  /** Draws several plans with one wait for the GPU (a screen's skins); a plan that fails gives its Error in its place. */
  forgeMany(plans: ReadonlyArray<ForgePlan>): Promise<Array<Forged | Error>>;
  /** Why a plan can't be drawn here (the caller forges it on the CPU), or null. */
  unsupported(plan: ForgePlan): string | null;
  /** A layer's coverage and signed distance field as the GPU made them (region-sized, rows top first): for tools and checks. */
  inspect(plan: ForgePlan, layer: number): Promise<{ width: number; height: number; coverage: Float32Array; distance: Float32Array }>;
  /** The GPU (from WEBGL_debug_renderer_info). */
  readonly renderer: string;
  /** True once the WebGL context is lost: every forge fails from then on (make a new engine). */
  lost(): boolean;
  /** Lets go of cached fields and working textures (they come back on the next forge); `fieldsOnly` keeps the latter. */
  trim(fieldsOnly?: boolean): void;
  dispose(): void;
}

export interface ForgeGLOptions {
  /** GPU memory for cached coverage and distance fields (default 256 MB). */
  cacheBytes?: number;
}

type Fmt = 'r32f' | 'rgba32f' | 'rgba16ui' | 'rgba8';
interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  w: number;
  h: number;
  fmt: Fmt;
}
interface Program {
  p: WebGLProgram;
  u: Map<string, { loc: WebGLUniformLocation; type: number }>;
  /** Shaders still compiling (checked and dropped on first use). */
  pending?: { vs: WebGLShader; fs: WebGLShader; name: string };
}
type UniformValue = number | ArrayLike<number> | Target;
type Uniforms = Record<string, UniformValue>;

const BLEND: Record<Blend, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4, softlight: 5, hardlight: 6, lighten: 7, darken: 8, colordodge: 9 };
const PATTERN: Record<PatternKind, number> = { stripes: 0, dots: 1, checker: 2, grid: 3, hex: 4, diamonds: 5, waves: 6, bricks: 7, scales: 8, bubbles: 9, stars: 10, hearts: 11, chevron: 12, crosshatch: 13, plaid: 14, confetti: 15, studs: 16, scanlines: 17, zigzag: 18, triangles: 19, sparkles: 20 };
const TEXTURE: Record<TextureKind, number> = { noise: 0, clouds: 1, wood: 2, brushed: 3, stone: 4, cells: 5, fabric: 6, marble: 7, scratches: 8, rust: 9, camo: 10, carbon: 11, caustics: 12, paper: 13, leather: 14, hammered: 15, speckle: 16, pixels: 17 };
/** textures.ts SMOOTH: kinds evaluated on a coarse lattice (cell = scale / this) and interpolated. */
const SMOOTH: Partial<Record<TextureKind, number>> = { noise: 6, clouds: 6, marble: 5, rust: 8, camo: 6, paper: 4, cells: 5, caustics: 4, hammered: 5 };
const MAX_SPARKLES = 64;
const LUT_ROWS = 64;
const nextPow2 = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));

/** canvas.ts boxesFor: three box widths whose passes approximate a Gaussian. */
function boxesFor(sigma: number, n = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** How far from the edge (pixels) a layer's effects read its distance field: beyond it they have all saturated. */
export function distanceReach(s: LayerStyle, box: Box): number {
  const strokes = s.strokes ?? [];
  const outside = Math.max(0, ...strokes.filter((k) => (k.position ?? 'outside') === 'outside').map((k) => k.width));
  return (
    Math.max(
      2,
      ...strokes.map((k) => k.width),
      s.extrude ? outside + (s.extrude.stroke?.width ?? 0) : 0,
      s.bevel ? Math.max(1, s.bevel.size) : 0,
      s.innerGlow?.size ?? 0,
      s.wear ? (s.wear.width ?? 8) : 0,
      s.gloss ? (s.gloss.inset ?? Math.max(2, box.h * 0.06)) + 1.5 : 0,
      s.rim ? s.rim.width + 2 : 0,
      s.dropShadow?.spread ?? 0,
      s.outerGlow?.spread ?? 0,
      s.sparkles ? (s.sparkles.size ?? 6) * 1.2 : 0,
      s.roughen ? s.roughen.amount * 1.2 + 1 : 0,
    ) + 3
  );
}

export function createForgeGL(canvas?: OffscreenCanvas | HTMLCanvasElement, opts: ForgeGLOptions = {}): ForgeGL {
  const cv = canvas ?? new OffscreenCanvas(1, 1);
  const gl = cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('forge-gl: WebGL2 is not available');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('forge-gl: float render targets (EXT_color_buffer_float) are not available');
  if (!gl.getExtension('EXT_float_blend')) throw new Error('forge-gl: float blending (EXT_float_blend) is not available');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  let lost = false;
  cv.addEventListener('webglcontextlost', ((e: Event) => {
    e.preventDefault();
    lost = true;
  }) as EventListener);

  // ─── Programs ──────────────────────────────────────────────────────────────────────────────────

  gl.getExtension('KHR_parallel_shader_compile');
  const shader = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  /** A program, linked now (drivers compile in the background) and checked when first used. */
  const program = (name: string, fs: string, vs = S.FULLSCREEN_VS): Program => {
    const p = gl.createProgram()!;
    const v = shader(gl.VERTEX_SHADER, vs);
    const f = shader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    return { p, u: new Map(), pending: { vs: v, fs: f, name } };
  };
  const ready = (prog: Program): Program => {
    const w = prog.pending;
    if (!w) return prog;
    if (!gl.getProgramParameter(prog.p, gl.LINK_STATUS)) throw new Error(`forge-gl: ${w.name}: ${gl.getShaderInfoLog(w.fs) || gl.getShaderInfoLog(w.vs) || gl.getProgramInfoLog(prog.p)}`);
    gl.deleteShader(w.vs);
    gl.deleteShader(w.fs);
    const n = gl.getProgramParameter(prog.p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog.p, i)!;
      prog.u.set(info.name.replace(/\[0\]$/, ''), { loc: gl.getUniformLocation(prog.p, info.name)!, type: info.type });
    }
    prog.pending = undefined;
    return prog;
  };
  const P = {
    coverage: program('coverage', S.COVERAGE_FS, S.COVERAGE_VS),
    coverageFinish: program('coverageFinish', S.COVERAGE_FINISH_FS),
    roughen: program('roughen', S.ROUGHEN_FS),
    jfaInit: program('jfaInit', S.JFA_INIT_FS),
    jfaStep: program('jfaStep', S.JFA_STEP_FS),
    jfaFinish: program('jfaFinish', S.JFA_FINISH_FS),
    gauss: program('gauss', S.GAUSS_FS),
    box: program('box', S.BOX_FS),
    stack: program('stack', S.STACK_FS),
    rowbox: program('rowbox', S.ROWBOX_FS),
    bbox: program('bbox', S.BBOX_FS),
    texturePaint: program('texturePaint', S.TEXTURE_PAINT_FS),
    field: program('field', S.FIELD_PAINT_FS),
    innerShadow: program('innerShadow', S.INNER_SHADOW_FS),
    extrude: program('extrude', S.EXTRUDE_FS),
    stroke: program('stroke', S.STROKE_FS),
    grain: program('grain', S.GRAIN_FS),
    innerGlow: program('innerGlow', S.INNER_GLOW_FS),
    wear: program('wear', S.WEAR_FS),
    bevel: program('bevel', S.BEVEL_FS),
    gloss: program('gloss', S.GLOSS_FS),
    sheen: program('sheen', S.SHEEN_FS),
    rim: program('rim', S.RIM_FS),
    sparklePlace: program('sparklePlace', S.SPARKLE_PLACE_FS),
    sparklePaint: program('sparklePaint', S.SPARKLE_PAINT_FS),
    over: program('over', S.OVER_FS),
    pixelFinish: program('pixelFinish', S.PIXEL_FINISH_FS),
    toImage: program('toImage', S.TO_IMAGE_FS),
  };
  /** Patterns and textures: one small program per kind, made the first time a kind is used. */
  const variants = new Map<string, Program>();
  const variant = (name: 'pattern' | 'textureField', define: string, n: number): Program => {
    const key = `${name}:${n}`;
    let prog = variants.get(key);
    if (!prog) {
      const src = (name === 'pattern' ? S.PATTERN_FS : S.TEXTURE_FIELD_FS).replace('#version 300 es\n', `#version 300 es\n#define ${define} ${n}\n`);
      prog = program(key, src);
      variants.set(key, prog);
    }
    return prog;
  };

  const emptyVao = gl.createVertexArray()!;
  const edgeVao = gl.createVertexArray()!;
  const edgeBuf = gl.createBuffer()!;
  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.bindVertexArray(null);

  // ─── Textures ──────────────────────────────────────────────────────────────────────────────────

  const alloc = (fmt: Fmt, w: number, h: number): Target => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const [internal, format, type] =
      fmt === 'r32f' ? [gl.R32F, gl.RED, gl.FLOAT] : fmt === 'rgba32f' ? [gl.RGBA32F, gl.RGBA, gl.FLOAT] : fmt === 'rgba16ui' ? [gl.RGBA16UI, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`forge-gl: ${fmt} target incomplete (${status})`);
    return { tex, fb, w, h, fmt };
  };
  const free = (t: Target) => {
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  };

  /** Working textures by name, grown (to multiples of 64) to the largest canvas seen. */
  const slots = new Map<string, Target>();
  const slot = (name: string, fmt: Fmt, w: number, h: number): Target => {
    const t = slots.get(name);
    if (t && t.w >= w && t.h >= h) return t;
    if (t) free(t);
    const n = alloc(fmt, Math.ceil(Math.max(w, t?.w ?? 0) / 64) * 64, Math.ceil(Math.max(h, t?.h ?? 0) / 64) * 64);
    slots.set(name, n);
    return n;
  };

  /** A layer's coverage and distance field, cached by shape and region, least recently used out first. */
  interface Fields {
    cov: Target;
    sd: Target;
    bytes: number;
  }
  const cache = new Map<string, Fields>();
  let cacheUsed = 0;
  const cacheBudget = opts.cacheBytes ?? 256 * 1024 * 1024;
  const dropFields = (k: string, f: Fields) => {
    free(f.cov);
    free(f.sd);
    cacheUsed -= f.bytes;
    cache.delete(k);
  };

  // Gradient tables: one row each in a 1024-wide atlas, rebuilt per layer.
  const lutTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, LUT, LUT_ROWS, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const lutTarget: Target = { tex: lutTex, fb: null as unknown as WebGLFramebuffer, w: LUT, h: LUT_ROWS, fmt: 'rgba32f' };
  const lutRows = new Map<string, number>();
  const lutMemo = new Map<string, Float32Array>();
  const lutRow = (stops: Stop[]): number => {
    const key = JSON.stringify(stops);
    const have = lutRows.get(key);
    if (have !== undefined) return have;
    if (lutRows.size >= LUT_ROWS) throw new Error('forge-gl: too many gradients in one layer');
    let lut = lutMemo.get(key);
    if (!lut) {
      lut = gradientLut(stops);
      if (lutMemo.size > 256) lutMemo.clear();
      lutMemo.set(key, lut);
    }
    const row = lutRows.size;
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, LUT, 1, gl.RGBA, gl.FLOAT, lut);
    lutRows.set(key, row);
    return row;
  };

  // ─── Passes ────────────────────────────────────────────────────────────────────────────────────

  const setUniforms = (prog: Program, u: Uniforms) => {
    let unit = 0;
    for (const name in u) {
      const info = prog.u.get(name);
      if (!info) continue;
      const v = u[name]!;
      const { loc, type } = info;
      if (type === gl.SAMPLER_2D || type === gl.UNSIGNED_INT_SAMPLER_2D) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, (v as Target).tex);
        gl.uniform1i(loc, unit++);
        continue;
      }
      const arr = typeof v === 'number' ? [v] : (v as ArrayLike<number>);
      if (type === gl.FLOAT) gl.uniform1fv(loc, arr as Float32List);
      else if (type === gl.FLOAT_VEC2) gl.uniform2fv(loc, arr as Float32List);
      else if (type === gl.FLOAT_VEC3) gl.uniform3fv(loc, arr as Float32List);
      else if (type === gl.FLOAT_VEC4) gl.uniform4fv(loc, arr as Float32List);
      else if (type === gl.INT) gl.uniform1iv(loc, arr as Int32List);
      else if (type === gl.INT_VEC2) gl.uniform2iv(loc, arr as Int32List);
    }
  };
  /** The region being drawn (pixels). */
  let W = 1;
  let H = 1;
  /** One pass of a program over [0, w) × [0, h) of a target (default: the region). */
  const pass = (prog: Program, out: Target, u: Uniforms, w = W, h = H) => {
    ready(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    setUniforms(prog, { uSize: [W, H], ...u });
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const clear = (t: Target) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
  };

  /** A paint's uniforms over a box: a solid colour, or a gradient's table row and geometry. */
  const paintU = (p: Paint, box: Box): Uniforms => {
    if (typeof p === 'string' || Array.isArray(p)) return { uPType: 0, uPColor: rgb(p) };
    const g = gradientGeom(p, box);
    return { uPType: g.type, uLut: lutTarget, uLutRow: lutRow(p.stops), uGBox: g.box, uGA: g.a, uGB: g.b };
  };

  /**
   * canvas.ts blur of a field made from `src` (blur modes in shaders.ts): exact Gaussian below sigma 2, three
   * running boxes from 2, a copy at 0.3 or less.
   */
  const blur = (src: Target, sigma: number, out: Target, make: { mode: number; a?: number; b?: number; clampEdges?: boolean }): Target => {
    const base = { uMode: make.mode, uA: make.a ?? 0, uB: make.b ?? 0, uClamp: make.clampEdges ? 1 : 0 };
    if (sigma <= 0.3) {
      pass(P.gauss, out, { uSrc: src, ...base, uR: 0, uDir: [1, 0], uSigma: 1, uInvSum: 1 });
      return out;
    }
    const t1 = slot('blurA', 'r32f', W, H);
    if (sigma < 2) {
      const r = Math.ceil(sigma * 3);
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += Math.exp(-(i * i) / (2 * sigma * sigma));
      pass(P.gauss, t1, { uSrc: src, ...base, uR: r, uSigma: sigma, uInvSum: 1 / sum, uDir: [1, 0] });
      pass(P.gauss, out, { uSrc: t1, ...base, uMode: 0, uR: r, uSigma: sigma, uInvSum: 1 / sum, uDir: [0, 1] });
      return out;
    }
    const t2 = slot('blurB', 'r32f', W, H);
    let from = src;
    let first = true;
    const sizes = boxesFor(sigma);
    sizes.forEach((size, i) => {
      const r = (size - 1) >> 1;
      pass(P.box, t1, { uSrc: from, ...base, uMode: first ? make.mode : 0, uR: r, uDir: [1, 0] });
      first = false;
      const to = i === sizes.length - 1 ? out : t2;
      pass(P.box, to, { uSrc: t1, ...base, uMode: 0, uR: r, uDir: [0, 1] });
      from = to;
    });
    return out;
  };

  /** canvas.ts signedDistance of a coverage field, flooding as far as `reach` pixels (effects saturate beyond). */
  const signedDistance = (cov: Target, out: Target, reach: number) => {
    let a = slot('jfaA', 'rgba16ui', W, H);
    let b = slot('jfaB', 'rgba16ui', W, H);
    pass(P.jfaInit, a, { uCov: cov });
    const k0 = Math.max(1, Math.min(nextPow2(Math.max(W, H)) / 2, nextPow2(reach)));
    // 1+JFA+2: a first step of one pixel and two last ones mend nearly all of plain JFA's misses.
    const steps: number[] = [1];
    for (let k = k0; k >= 1; k >>= 1) steps.push(k);
    steps.push(2, 1);
    for (const k of steps) {
      pass(P.jfaStep, b, { uSeeds: a, uStep: k });
      [a, b] = [b, a];
    }
    pass(P.jfaFinish, out, { uSeeds: a, uCov: cov });
  };

  /** A layer's coverage and distance field (roughened when the style says): from the cache, or drawn. */
  const shapeFields = (l: PlanLayer, reach: number): Fields => {
    const s = l.style;
    const rough = s.roughen && s.roughen.amount > 0 ? s.roughen : null;
    const salt = [W, H, reach, l.fillHoles ? 1 : 0, ...(rough ? [rough.amount, rough.scale ?? 6, rough.seed ?? 21, l.box.x, l.box.y] : [])];
    let edges: Float32Array | null = null;
    let bitmap: Float32Array | null = null;
    let key: string;
    if (isCoverage(l.shape)) {
      if (l.shape.width !== W || l.shape.height !== H) throw new Error(`forge-gl: coverage is ${l.shape.width}×${l.shape.height}, the region ${W}×${H}`);
      bitmap = l.shape.coverage instanceof Float32Array ? l.shape.coverage : Float32Array.from(l.shape.coverage, (v) => v / 255);
      key = 'c' + fingerprint(bitmap, salt);
    } else {
      edges = edgesOf(l.shape);
      key = 'e' + fingerprint(edges, salt);
    }
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const bytes = W * H * 8;
    for (const [k, f] of cache) {
      if (cacheUsed + bytes <= cacheBudget) break;
      dropFields(k, f);
    }
    const f: Fields = { cov: alloc('r32f', W, H), sd: alloc('r32f', W, H), bytes };
    if (bitmap) {
      gl.bindTexture(gl.TEXTURE_2D, f.cov.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.FLOAT, bitmap);
    } else {
      // Signed areas summed over every edge, then the nonzero coverage.
      const acc = slot('covAcc', 'r32f', W, H);
      clear(acc);
      if (edges!.length) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fb);
        gl.viewport(0, 0, W, H);
        gl.useProgram(ready(P.coverage).p);
        setUniforms(P.coverage, { uCanvas: [W, H] });
        gl.bindVertexArray(edgeVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, edgeBuf);
        gl.bufferData(gl.ARRAY_BUFFER, edges!, gl.DYNAMIC_DRAW);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, edges!.length / 4);
        gl.disable(gl.BLEND);
      }
      pass(P.coverageFinish, f.cov, { uAcc: acc });
    }
    if (l.fillHoles) {
      // A flood fill from the border: on the CPU, over the coverage read back (solid glyphs are small).
      const px = new Float32Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.cov.fb);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
      const v = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) v[i] = px[i * 4]!;
      fillHoles(v, W, H);
      gl.bindTexture(gl.TEXTURE_2D, f.cov.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.FLOAT, v);
    }
    signedDistance(f.cov, f.sd, reach);
    if (rough) {
      const r = slot('rough', 'r32f', W, H);
      pass(P.roughen, r, { uSd: f.sd, uAmount: rough.amount, uScale: Math.max(1, rough.scale ?? 6), uSeed: rough.seed ?? 21, uOrigin: [-l.box.x, -l.box.y] });
      // The roughened shape is the shape from here on: its coverage, and its own distance field.
      const tmp = f.cov;
      f.cov = r;
      slots.set('rough', tmp);
      signedDistance(f.cov, f.sd, reach);
    }
    cache.set(key, f);
    cacheUsed += bytes;
    return f;
  };

  /** style.ts renderStyled for one layer on its region; returns the canvas holding it. */
  const renderLayer = (l: PlanLayer): Target => {
    const s = l.style;
    const box = l.box;
    const fields = shapeFields(l, distanceReach(s, box));
    const { cov: shape, sd } = fields;
    lutRows.clear();
    let cur = slot('layerA', 'rgba32f', W, H);
    let nxt = slot('layerB', 'rgba32f', W, H);
    clear(cur);
    const paint = (prog: Program, u: Uniforms) => {
      pass(prog, nxt, { uDst: cur, ...u });
      [cur, nxt] = [nxt, cur];
    };
    const blurred = slot('blurred', 'r32f', W, H);
    const boxArr = [box.x, box.y, box.w, box.h];
    const stroke = (k: StrokeStyle) => {
      const pos = k.position ?? 'outside';
      const band = pos === 'outside' ? [0, k.width] : pos === 'inside' ? [-k.width, 0] : [-k.width / 2, k.width / 2];
      paint(P.stroke, { uSd: sd, uShape: shape, uFace: 0, uBand: band, uOpacity: k.opacity ?? 1, uMode: 0, uClip: 0, ...paintU(k.paint, { x: box.x - k.width, y: box.y - k.width, w: box.w + 2 * k.width, h: box.h + 2 * k.width }) });
    };
    /** grow(by) as a blur's source: the shape itself at 0 or less, else the distance field grown. */
    const growSrc = (by: number): [Target, { mode: number; a: number }] => (by <= 0 ? [shape, { mode: 0, a: 0 }] : [sd, { mode: 1, a: by }]);

    if (s.dropShadow) {
      const ds = s.dropShadow;
      const [src, make] = growSrc(ds.spread ?? 0);
      blur(src, ds.blur, blurred, make);
      paint(P.field, { uField: blurred, uShift: [ds.offset?.[0] ?? 0, ds.offset?.[1] ?? 4], uColor: rgb(ds.color), uOpacity: ds.opacity ?? 0.5 });
    }
    if (s.outerGlow) {
      const g = s.outerGlow;
      const [src, make] = growSrc(g.spread ?? 0);
      blur(src, g.size, blurred, make);
      paint(P.field, { uField: blurred, uShift: [0, 0], uColor: rgb(g.color), uOpacity: g.opacity ?? 0.8 });
    }
    const outside = (s.strokes ?? []).filter((k) => (k.position ?? 'outside') === 'outside').sort((a, b) => b.width - a.width);
    if (s.extrude && s.extrude.depth > 0) {
      const e = s.extrude;
      const reach = Math.max(0, ...outside.map((k) => k.width));
      const a = ((e.angle ?? 90) * Math.PI) / 180;
      const stackOf = (by: number, out: Target) =>
        pass(P.stack, out, { uSil: by <= 0 ? shape : sd, uGrow: by <= 0 ? 0 : 1, uBy: by, uCS: [Math.cos(a), Math.sin(a)], uDepth: e.depth, uSteps: Math.max(1, Math.ceil(e.depth)) });
      const ring = !!(e.stroke && e.stroke.width > 0);
      const ringStack = slot('stackRing', 'r32f', W, H);
      if (ring) stackOf(reach + e.stroke!.width, ringStack);
      const stack = slot('stack', 'r32f', W, H);
      stackOf(reach, stack);
      paint(P.extrude, { uStack: stack, uRingStack: ringStack, uRing: ring ? 1 : 0, uRingColor: ring ? rgb(e.stroke!.color) : [0, 0, 0], ...paintU(e.color, { x: box.x, y: box.y, w: box.w, h: box.h + e.depth }) });
    }
    for (const k of outside) stroke(k);
    paint(P.stroke, { uShape: shape, uSd: sd, uFace: 1, uBand: [0, 0], uOpacity: s.fillOpacity ?? 1, uMode: 0, uClip: 0, ...paintU(s.fill, box) });
    const patternU = (pt: NonNullable<LayerStyle['patterns']>[number]): Uniforms => {
      const a = ((pt.angle ?? 0) * Math.PI) / 180;
      const [offX, offY] = pt.offset ?? [0, 0];
      return { uCell: pt.size ?? 12, uPatCS: [Math.cos(a), Math.sin(a)], uDuty: pt.duty ?? -1, uPatSeed: pt.seed ?? 5, uPatOrigin: [box.x + offX, box.y + offY] };
    };
    for (const pt of s.patterns ?? []) paint(variant('pattern', 'PAT', PATTERN[pt.kind] ?? 0), { uShape: shape, ...patternU(pt), uColor: rgb(pt.color), uOpacity: pt.opacity ?? 0.15, uMode: BLEND[pt.blend ?? 'normal'], uErase: 0 });
    if (s.textures?.length) {
      // The mask's box first (textures are evaluated over it), then each texture's field and its paint.
      const rows = slot('rowbox', 'rgba32f', 1, H);
      pass(P.rowbox, rows, { uMask: shape, uW: W }, 1, H);
      const bb = slot('bbox', 'rgba32f', 1, 1);
      pass(P.bbox, bb, { uRows: rows, uW: W, uH: H }, 1, 1);
      const tf = slot('texture', 'r32f', W, H);
      for (const t of s.textures) {
        const sc = Math.max(0.5, t.scale ?? 12);
        const a = ((t.angle ?? 0) * Math.PI) / 180;
        const sm = SMOOTH[t.kind];
        pass(variant('textureField', 'KIND', TEXTURE[t.kind] ?? 0), tf, { uShape: shape, uBBox: bb, uS: sc, uSeed: t.seed ?? 3, uDensity: t.density ?? 0.5, uCS: [Math.cos(a), Math.sin(a)], uOrigin: [box.x, box.y], uCoarse: sm ? Math.max(1, Math.min(4, Math.floor(sc / sm))) : 1, uContrast: t.contrast ?? 1, uInvert: t.invert ? 1 : 0 });
        const how = t.ramp ? 0 : t.color !== undefined ? 1 : 2;
        paint(P.texturePaint, {
          uShape: shape,
          uTex: tf,
          uHow: how,
          uColor: t.color !== undefined ? rgb(t.color) : [0, 0, 0],
          uOp: t.opacity ?? 0.5,
          uMode: BLEND[t.blend ?? (how === 2 ? 'overlay' : 'normal')],
          uRelief: t.relief ?? 0,
          ...(t.ramp ? { uLut: lutTarget, uLutRow: lutRow(t.ramp) } : {}),
        });
      }
    }
    if (s.grain) paint(P.grain, { uShape: shape, uScale: s.grain.scale ?? 3, uAmount: s.grain.amount, uMode: BLEND[s.grain.blend ?? 'overlay'], uOrigin: [-box.x, -box.y] });
    for (const o of s.overlays ?? []) paint(P.stroke, { uShape: shape, uSd: sd, uFace: 1, uBand: [0, 0], uOpacity: o.opacity ?? 1, uMode: BLEND[o.blend ?? 'normal'], uClip: 1, ...paintU(o.paint, box) });
    if (s.innerShadow) {
      const k = s.innerShadow;
      blur(shape, k.size / 2, blurred, { mode: 2, clampEdges: true });
      paint(P.innerShadow, { uField: blurred, uShape: shape, uShift: [k.offset?.[0] ?? 0, k.offset?.[1] ?? 2], uColor: rgb(k.color), uOpacity: k.opacity ?? 0.5 });
    }
    if (s.innerGlow) {
      const k = s.innerGlow;
      paint(P.innerGlow, { uShape: shape, uSd: sd, uGlow: k.size, uColor: rgb(k.color), uOpacity: k.opacity ?? 0.6, uMode: BLEND[k.blend ?? 'screen'] });
    }
    if (s.wear && s.wear.amount > 0) {
      const k = s.wear;
      paint(P.wear, { uShape: shape, uSd: sd, uWidth: k.width ?? 8, uScale: Math.max(1, k.scale ?? 4), uSeed: k.seed ?? 31, uAmount: k.amount, uBox: boxArr, uColor: rgb(k.color), uOpacity: k.opacity ?? 1 });
    }
    if (s.bevel) {
      const b = s.bevel;
      const size = Math.max(1, b.size);
      const style = b.style === 'chisel' ? 1 : b.style === 'pillow' ? 2 : b.style === 'round' ? 3 : 0;
      blur(sd, b.style === 'chisel' ? 0.5 : Math.max(0.6, size / 6), blurred, { mode: 3, a: size, b: style });
      const az = (((b.angle ?? 120) - 90) * Math.PI) / 180;
      const alt = ((b.altitude ?? 40) * Math.PI) / 180;
      const L = [Math.cos(alt) * Math.cos(az + Math.PI / 2), -Math.cos(alt) * Math.sin(az + Math.PI / 2), Math.sin(alt)];
      paint(P.bevel, { uShape: shape, uHeight: blurred, uL: L, uDepth: (b.depth ?? 1) * size * 0.9, uHi: rgb(b.highlight ?? '#ffffff'), uLo: rgb(b.shadow ?? '#000000'), uHiOp: b.highlightOpacity ?? 0.75, uLoOp: b.shadowOpacity ?? 0.6, uSpec: b.specular ?? 0 });
    }
    if (s.gloss) {
      const g = s.gloss;
      const style = g.style === 'band' ? 1 : g.style === 'spot' ? 2 : g.style === 'glass' ? 3 : 0;
      paint(P.gloss, { uShape: shape, uSd: sd, uBox: boxArr, uInset: g.inset ?? Math.max(2, box.h * 0.06), uHeight: (g.height ?? 0.48) * box.h, uHRaw: g.height ?? 0.48, uCurve: g.curve ?? 0.35, uStyle: style, uColor: rgb(g.color ?? '#ffffff'), uOpacity: g.opacity ?? 0.45 });
    }
    if (s.sheen) {
      const k = s.sheen;
      const a = ((k.angle ?? 60) * Math.PI) / 180;
      const width = (k.width ?? 0.18) * Math.max(box.w, box.h);
      paint(P.sheen, { uShape: shape, uBox: boxArr, uSC: [Math.sin(a), Math.cos(a)], uCx: box.x + box.w * (k.at ?? 0.35), uDen: 2 * (width / 2.5) ** 2, uColor: rgb(k.color ?? '#ffffff'), uOpacity: k.opacity ?? 0.25 });
    }
    if (s.rim) {
      const r = s.rim;
      const ang = ((r.angle ?? 90) * Math.PI) / 180;
      paint(P.rim, { uShape: shape, uSd: sd, uWidth: r.width, uL: [Math.cos(ang), -Math.sin(ang)], uPow: r.falloff ?? 1.5, uColor: rgb(r.color ?? '#ffffff'), uOpacity: r.opacity ?? 0.6, uShade: r.shade ? 1 : 0, uShadeColor: r.shade ? rgb(r.shade) : [0, 0, 0], uShadeOpacity: r.shadeOpacity ?? 0.4, uHard: r.hard ? 1 : 0 });
    }
    for (const k of (s.strokes ?? []).filter((k) => (k.position ?? 'outside') !== 'outside')) stroke(k);
    if (s.sparkles) {
      const k = s.sparkles;
      const count = Math.min(MAX_SPARKLES, k.count ?? 3);
      const area = k.area ?? 'inside';
      if (count > 0) {
        const spots = slot('sparkles', 'rgba32f', MAX_SPARKLES, 1);
        pass(P.sparklePlace, spots, { uSd: sd, uCount: count, uSpark: k.size ?? 6, uSeed: k.seed ?? 9, uArea: area === 'top' ? 1 : area === 'edge' ? 2 : area === 'around' ? 3 : 0, uBox: boxArr }, count, 1);
        paint(P.sparklePaint, { uSpots: spots, uCount: count, uGlow: k.glow ?? 0.35, uColor: rgb(k.color ?? '#ffffff'), uOpacity: k.opacity ?? 0.95, uAround: area === 'around' ? 1 : 0 });
      }
    }
    for (const pt of s.cutouts ?? []) paint(variant('pattern', 'PAT', PATTERN[pt.kind] ?? 0), { uShape: shape, ...patternU(pt), uColor: [0, 0, 0], uOpacity: 1, uMode: 0, uErase: 1 });
    return cur;
  };

  let queue: Promise<unknown> = Promise.resolve();

  const unsupported = (plan: ForgePlan): string | null => {
    for (const l of plan.layers) {
      const s = l.style;
      if ((s.sparkles?.count ?? 3) > MAX_SPARKLES) return `more than ${MAX_SPARKLES} sparkles`;
      for (const t of s.textures ?? []) if (TEXTURE[t.kind] === undefined) return `texture "${t.kind}"`;
      for (const pt of [...(s.patterns ?? []), ...(s.cutouts ?? [])]) if (PATTERN[pt.kind] === undefined) return `pattern "${pt.kind}"`;
      const gradients = [s.fill, ...(s.strokes ?? []).map((k) => k.paint), s.extrude?.color, ...(s.overlays ?? []).map((o) => o.paint)].filter((p) => p && typeof p === 'object' && !Array.isArray(p)).length + (s.textures ?? []).filter((t) => t.ramp).length;
      if (gradients > LUT_ROWS) return 'too many gradients in a layer';
    }
    return null;
  };

  /**
   * Draws a plan and reads its picture: at once (`now`: one short wait for the GPU), or into a pixel buffer to read
   * when the GPU is done (a batch waits once).
   */
  const draw = (plan: ForgePlan, now: boolean): { buf: WebGLBuffer | null; data: Uint8Array | null; width: number; height: number; meta: ForgePlan['meta'] } => {
    if (lost || gl.isContextLost()) throw new Error('forge-gl: the WebGL context was lost');
    const why = unsupported(plan);
    if (why) throw new Error(`forge-gl: ${why}`);
    const cw = plan.width;
    const ch = plan.height;
    let out = slot('outA', 'rgba32f', cw, ch);
    clear(out);
    for (const l of plan.layers) {
      const [rx, ry, rw, rh] = l.region;
      W = rw;
      H = rh;
      const layer = renderLayer(l);
      // Over what is below, in the layer's region: premultiplied "over" is ONE, ONE_MINUS_SRC_ALPHA.
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
      gl.viewport(rx, ry, rw, rh);
      gl.useProgram(ready(P.over).p);
      setUniforms(P.over, { uSrc: layer, uOrigin: [rx, ry] });
      gl.bindVertexArray(emptyVao);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    }
    W = cw;
    H = ch;
    let k = 1;
    if (plan.pixel) {
      const fin = slot('outB', 'rgba32f', cw, ch);
      pass(P.pixelFinish, fin, { uSrc: out, uThreshold: plan.pixel.threshold, uLevels: plan.pixel.levels, uDither: plan.pixel.dither ? 1 : 0 });
      out = fin;
      k = Math.max(1, plan.pixel.k);
    }
    const iw = cw * k;
    const ih = ch * k;
    const img = slot('image', 'rgba8', iw, ih);
    pass(P.toImage, img, { uSrc: out, uK: k }, iw, ih);
    gl.bindFramebuffer(gl.FRAMEBUFFER, img.fb);
    if (now) {
      const data = new Uint8Array(iw * ih * 4);
      gl.readPixels(0, 0, iw, ih, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return { buf: null, data, width: iw, height: ih, meta: plan.meta };
    }
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, iw * ih * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, iw, ih, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return { buf, data: null, width: iw, height: ih, meta: plan.meta };
  };

  // Waiting for the GPU without blocking the page: a fence polled between tasks (a message channel, which timers'
  // clamping doesn't slow).
  const tick = new MessageChannel();
  const ticks: Array<() => void> = [];
  tick.port1.onmessage = () => ticks.shift()?.();
  const nextTask = () =>
    new Promise<void>((resolve) => {
      ticks.push(resolve);
      tick.port2.postMessage(0);
    });
  const settle = async () => {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();
    try {
      for (;;) {
        const r = gl.clientWaitSync(sync, 0, 0);
        if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED) return;
        if (r === gl.WAIT_FAILED || lost) throw new Error('forge-gl: waiting for the GPU failed');
        await nextTask();
      }
    } finally {
      gl.deleteSync(sync);
    }
  };

  /** Draws every plan, waits for the GPU once, then reads each picture: element N+1 is drawn while N is read back. */
  const forgeBatch = async (plans: ReadonlyArray<ForgePlan>): Promise<Array<Forged | Error>> => {
    const drawn = plans.map((p) => {
      try {
        return draw(p, false);
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    });
    await settle();
    return drawn.map((d) => {
      if (d instanceof Error) return d;
      const data = new Uint8Array(d.width * d.height * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, d.buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(d.buf!);
      return { image: { width: d.width, height: d.height, data }, ...d.meta };
    });
  };

  const inspectNow = (plan: ForgePlan, i: number) => {
    const l = plan.layers[i];
    if (!l) throw new Error(`forge-gl: no layer ${i}`);
    W = l.region[2];
    H = l.region[3];
    const f = shapeFields(l, distanceReach(l.style, l.box));
    const read = (t: Target) => {
      const px = new Float32Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
      return Float32Array.from({ length: W * H }, (_, k) => px[k * 4]!);
    };
    return { width: W, height: H, coverage: read(f.cov), distance: read(f.sd) };
  };

  const trim = (fieldsOnly = false) => {
    for (const [k, f] of cache) dropFields(k, f);
    if (fieldsOnly) return;
    for (const t of slots.values()) free(t);
    slots.clear();
  };

  return {
    renderer,
    lost: () => lost || gl.isContextLost(),
    inspect(plan, layer) {
      const job = queue.then(() => inspectNow(plan, layer));
      queue = job.catch(() => undefined);
      return job;
    },
    unsupported,
    forge(plan) {
      const job = queue.then((): Forged => {
        const d = draw(plan, true);
        return { image: { width: d.width, height: d.height, data: d.data! }, ...d.meta };
      });
      queue = job.catch(() => undefined);
      return job;
    },
    forgeMany(plans) {
      const job = queue.then(() => forgeBatch(plans));
      queue = job.catch(() => undefined);
      return job;
    },
    trim,
    dispose() {
      if (!lost && !gl.isContextLost()) {
        trim();
        for (const p of [...Object.values(P), ...variants.values()]) gl.deleteProgram(p.p);
        gl.deleteTexture(lutTex);
        gl.deleteBuffer(edgeBuf);
        gl.deleteVertexArray(edgeVao);
        gl.deleteVertexArray(emptyVao);
      }
      tick.port1.close();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
