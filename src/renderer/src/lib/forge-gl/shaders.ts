/**
 * The GPU forge's shaders (GLSL ES 3.00): the CPU engine's formulas (src/core/ui/forge/canvas.ts, style.ts,
 * textures.ts) as fragment passes. Every pass works on whole pixels by index (texelFetch); pixel (x, y) is row y from
 * the top, which is framebuffer row y. Fields are R32F, canvases premultiplied RGBA32F, jump-flood seeds RGBA16UI.
 */

/** A triangle over the whole viewport. */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
uniform ivec2 uSize;
const float PI = 3.141592653589793;
float clamp01(float x) { return clamp(x, 0.0, 1.0); }
// canvas.ts smoothstep: either edge order.
float sstep(float a, float b, float x) {
  float d = b - a;
  if (d == 0.0) d = 1e-9;
  float t = clamp01((x - a) / d);
  return t * t * (3.0 - 2.0 * t);
}
float frac(float x) { return x - floor(x); }
float jsRound(float x) { return floor(x + 0.5); }
bool onCanvas(ivec2 q) { return q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y; }
float at(sampler2D t, ivec2 q) { return onCanvas(q) ? texelFetch(t, q, 0).r : 0.0; }
// canvas.ts shift(): out(x, y) = the field bilinear at (x - dx, y - dy), nothing from past the canvas.
float shiftAt(sampler2D t, ivec2 P, vec2 d) {
  float ix = floor(d.x);
  float iy = floor(d.y);
  float tx = d.x - ix;
  float ty = d.y - iy;
  ivec2 q1 = P - ivec2(int(ix), int(iy));
  ivec2 q0 = q1 - ivec2(1, 1);
  return at(t, q1) * (1.0 - tx) * (1.0 - ty) + at(t, ivec2(q0.x, q1.y)) * tx * (1.0 - ty) + at(t, ivec2(q1.x, q0.y)) * (1.0 - tx) * ty + at(t, q0) * tx * ty;
}
// canvas.ts hash, valueNoise, fbm and noise, bit for bit in the hash.
float hash(int x, int y, int seed) {
  uint h = uint(x) * 374761393u + uint(y) * 668265263u + uint(seed) * 2147483647u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return float(h ^ (h >> 16u)) / 4294967295.0;
}
float valueNoise(float x, float y, int seed) {
  float x0 = floor(x);
  float y0 = floor(y);
  float tx = x - x0;
  float ty = y - y0;
  tx = tx * tx * (3.0 - 2.0 * tx);
  ty = ty * ty * (3.0 - 2.0 * ty);
  int ix = int(x0);
  int iy = int(y0);
  float a = hash(ix, iy, seed);
  float b = hash(ix + 1, iy, seed);
  float c = hash(ix, iy + 1, seed);
  float d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * tx) * (1.0 - ty) + (c + (d - c) * tx) * ty;
}
float fbm(float x, float y, int octaves, int seed) {
  float amp = 1.0;
  float total = 0.0;
  float norm = 0.0;
  float f = 1.0;
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    total += amp * valueNoise(x * f, y * f, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2.0;
  }
  return total / norm;
}
float noiseAt(float x, float y, float scale, int octaves, int seed, vec2 origin) {
  float amp = 1.0;
  float total = 0.0;
  float norm = 0.0;
  float s = scale;
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    total += amp * valueNoise((x + origin.x) / s, (y + origin.y) / s, seed + o);
    norm += amp;
    amp *= 0.5;
    s /= 2.0;
  }
  return total / norm;
}
// textures.ts sparkleAt.
float sparkleAt(float x, float y, float r) {
  float ax = abs(x) / r;
  float ay = abs(y) / r;
  float d = sqrt(ax) + sqrt(ay);
  float star = 1.0 - sstep(0.85, 1.05, d);
  float core = exp(-(ax * ax + ay * ay) * 9.0);
  return clamp01(max(star, core));
}
`;

/** Laying paint on a premultiplied canvas (canvas.ts lay, paint; style.ts paintPaint) and paints (style.ts gradientOf). */
const PAINT = `
uniform sampler2D uDst;
out vec4 outColor;
float blendCh(int m, float b, float s) {
  if (m == 1) return b * s;
  if (m == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m == 3) return b < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 4) return min(1.0, b + s);
  if (m == 5) return s < 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * ((b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b)) - b);
  if (m == 6) return s < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 7) return max(b, s);
  if (m == 8) return min(b, s);
  if (m == 9) return s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));
  return s;
}
vec4 lay(vec4 px, float a, vec3 col, int mode, bool clip) {
  float ba = px.a;
  if (clip || mode != 0) {
    // A layer clipped to what is under it: recolours the base, never grows it.
    if (ba <= 0.0) return px;
    vec3 base = px.rgb * (1.0 / ba);
    vec3 o = base + (vec3(blendCh(mode, base.r, col.r), blendCh(mode, base.g, col.g), blendCh(mode, base.b, col.b)) - base) * a;
    return vec4(o * ba, ba);
  }
  float k = 1.0 - a;
  return vec4(col * a + px.rgb * k, a + ba * k);
}
vec4 paintF(vec4 px, float alpha, float opacity, vec3 col, int mode, bool clip) {
  float a = alpha * opacity;
  if (a <= 0.0) return px;
  return lay(px, min(a, 1.0), col, mode, clip);
}
uniform int uPType;
uniform vec3 uPColor;
uniform sampler2D uLut;
uniform int uLutRow;
uniform vec4 uGBox;
uniform vec4 uGA;
uniform vec4 uGB;
// A paint at pixel p: colour and its alpha (gradients through their 1024-entry table).
vec4 paintAt(vec2 p) {
  if (uPType == 0) return vec4(uPColor, 1.0);
  float u = (p.x - uGBox.x) / uGBox.z;
  float v = (p.y - uGBox.y) / uGBox.w;
  float t;
  if (uPType == 2) t = length(vec2((u - uGA.x) * (uGBox.z / uGA.z), (v - uGA.y) * (uGBox.w / uGA.z))) * 2.0 / uGA.w;
  else if (uPType == 5) t = ((abs(u - uGA.x) * (uGBox.z / uGA.z) + abs(v - uGA.y) * (uGBox.w / uGA.z)) * 2.0) / uGA.w;
  else if (uPType == 3) {
    float yy = v - uGA.y;
    float xx = u - uGA.x;
    float q = ((xx == 0.0 && yy == 0.0 ? 0.0 : atan(yy, xx)) - uGB.w) / (2.0 * PI);
    t = q - floor(q);
  } else {
    float l = 0.5 + ((u - 0.5) * uGB.x * uGBox.z + (v - 0.5) * uGB.y * uGBox.w) / (2.0 * uGB.z);
    t = uPType == 4 ? abs(l - 0.5) * 2.0 : l;
  }
  return texelFetch(uLut, ivec2(int(jsRound(clamp01(t) * 1023.0)), uLutRow), 0);
}
vec4 paintP(vec4 px, vec2 p, float alpha, float opacity, int mode, bool clip) {
  float a0 = alpha * opacity;
  if (a0 <= 0.0) return px;
  vec4 pc = paintAt(p);
  float a = min(1.0, a0 * pc.a);
  if (a <= 0.0) return px;
  return lay(px, a, pc.rgb, mode, clip);
}
`;

const FS = (body: string, paint = true) => HEAD + (paint ? PAINT : '') + body;

// ─── Coverage: exact signed area per pixel (ui-raster.ts fillMask), summed by additive blending ─────

export const COVERAGE_VS = `#version 300 es
layout(location = 0) in vec4 aEdge;
uniform vec2 uCanvas;
flat out vec4 vEdge;
void main() {
  vec4 e = aEdge;
  // fillMask clamps x to its region: the canvas.
  e.x = clamp(e.x, 0.0, uCanvas.x);
  e.z = clamp(e.z, 0.0, uCanvas.x);
  vEdge = e;
  float y0 = min(e.y, e.w);
  float y1 = max(e.y, e.w);
  float top = max(0.0, floor(y0));
  float bot = min(uCanvas.y, ceil(y1));
  float left = max(0.0, floor(min(e.x, e.z)));
  if (y0 == y1 || bot <= top || left >= uCanvas.x) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // Every pixel right of the edge on its rows: the area it encloses there.
  float X = (gl_VertexID & 1) == 0 ? left : uCanvas.x;
  float Y = (gl_VertexID & 2) == 0 ? top : bot;
  gl_Position = vec4(X / uCanvas.x * 2.0 - 1.0, Y / uCanvas.y * 2.0 - 1.0, 0.0, 1.0);
}`;

export const COVERAGE_FS = `#version 300 es
precision highp float;
flat in vec4 vEdge;
out vec4 outColor;
// The integral of clamp(1 - u, 0, 1).
float G(float u) { return u <= 0.0 ? u : (u >= 1.0 ? 0.5 : u - 0.5 * u * u); }
void main() {
  vec2 P = floor(gl_FragCoord.xy);
  vec2 a = vEdge.xy - P;
  vec2 b = vEdge.zw - P;
  float dir = 1.0;
  if (a.y > b.y) {
    dir = -1.0;
    vec2 t = a;
    a = b;
    b = t;
  }
  float ya = max(a.y, 0.0);
  float yb = min(b.y, 1.0);
  if (yb <= ya) discard;
  float k = (b.x - a.x) / (b.y - a.y);
  float ua = a.x + (ya - a.y) * k;
  float ub = a.x + (yb - a.y) * k;
  float du = ub - ua;
  // The part of this pixel's slice of the row right of the edge, averaged over the slice.
  float avg = abs(du) < 1e-6 ? clamp(1.0 - 0.5 * (ua + ub), 0.0, 1.0) : (G(ub) - G(ua)) / du;
  outColor = vec4(dir * (yb - ya) * avg, 0.0, 0.0, 0.0);
}`;

export const COVERAGE_FINISH_FS = FS(`
uniform sampler2D uAcc;
out vec4 outColor;
void main() {
  float v = min(1.0, abs(texelFetch(uAcc, ivec2(gl_FragCoord.xy), 0).r));
  outColor = vec4(v > 0.001 ? v : 0.0, 0.0, 0.0, 0.0);
}`, false);

/** style.ts roughen: the edge pushed in and out by noise, as new coverage. */
export const ROUGHEN_FS = FS(`
uniform sampler2D uSd;
uniform float uAmount;
uniform float uScale;
uniform int uSeed;
uniform vec2 uOrigin;
out vec4 outColor;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float n = noiseAt(float(P.x), float(P.y), uScale, 3, uSeed, uOrigin);
  outColor = vec4(clamp01(0.5 - (texelFetch(uSd, P, 0).r + (n - 0.5) * 2.4 * uAmount)), 0.0, 0.0, 0.0);
}`, false);

// ─── Signed distance by jump flooding (canvas.ts signedDistance) ────────────────────────────────────

/** Seeds: the nearest inside pixel (xy) and the nearest outside pixel (zw); 65535 is none yet. */
export const JFA_INIT_FS = FS(`
uniform sampler2D uCov;
layout(location = 0) out uvec4 outSeed;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  uvec2 me = uvec2(P);
  outSeed = texelFetch(uCov, P, 0).r >= 0.5 ? uvec4(me, 65535u, 65535u) : uvec4(65535u, 65535u, me);
}`, false);

export const JFA_STEP_FS = FS(`
uniform usampler2D uSeeds;
uniform int uStep;
layout(location = 0) out uvec4 outSeed;
float d2(uvec2 s, ivec2 P) {
  if (s.x == 65535u) return 1e30;
  vec2 d = vec2(ivec2(s) - P);
  return dot(d, d);
}
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  uvec4 best = texelFetch(uSeeds, P, 0);
  float bi = d2(best.xy, P);
  float bo = d2(best.zw, P);
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = P + ivec2(dx, dy) * uStep;
      if (!onCanvas(q)) continue;
      uvec4 s = texelFetch(uSeeds, q, 0);
      float di = d2(s.xy, P);
      if (di < bi) { bi = di; best.xy = s.xy; }
      float dO = d2(s.zw, P);
      if (dO < bo) { bo = dO; best.zw = s.zw; }
    }
  outSeed = best;
}`, false);

export const JFA_FINISH_FS = FS(`
uniform usampler2D uSeeds;
uniform sampler2D uCov;
out vec4 outColor;
float dist(uvec2 s, ivec2 P) {
  if (s.x == 65535u) return 1e10;
  vec2 d = vec2(ivec2(s) - P);
  return sqrt(dot(d, d));
}
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  uvec4 s = texelFetch(uSeeds, P, 0);
  float c = texelFetch(uCov, P, 0).r;
  // Pixels next to the edge take their coverage as the edge's sub-pixel position; deeper ones their distance.
  float near = c >= 0.5 ? dist(s.zw, P) : dist(s.xy, P);
  float v = near <= 1.0 ? 0.5 - c : (c >= 0.5 ? -(near - 0.5) : near - 0.5);
  outColor = vec4(v, 0.0, 0.0, 0.0);
}`, false);

// ─── Fields ────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a blur blurs, made on the fly from its source: 0 the field as it is; 1 a distance field grown into coverage
 * (grow(uA)); 2 coverage inverted; 3 a bevel's height from a distance field (size uA, style uB: 0 smooth, 1 chisel,
 * 2 pillow, 3 round).
 */
const BLUR_SRC = `
uniform sampler2D uSrc;
uniform int uMode;
uniform float uA;
uniform int uB;
uniform int uClamp;
float srcAt(ivec2 q) {
  if (!onCanvas(q)) {
    if (uClamp == 0) return 0.0;
    q = clamp(q, ivec2(0), uSize - 1);
  }
  float v = texelFetch(uSrc, q, 0).r;
  if (uMode == 1) return clamp01(uA - v + 0.5);
  if (uMode == 2) return 1.0 - v;
  if (uMode == 3) {
    float d = -v;
    if (d <= 0.0) return 0.0;
    float t = d >= uA ? 1.0 : d / uA;
    return uB == 1 ? t : uB == 2 ? sin(t * PI / 2.0) : uB == 3 ? sqrt(max(0.0, 1.0 - (1.0 - t) * (1.0 - t))) : sstep(0.0, 1.0, t) * 0.6 + t * 0.4;
  }
  return v;
}
`;

/** One direction of an exact Gaussian (canvas.ts blur below sigma 2); radius 0 copies the made field. */
export const GAUSS_FS = FS(BLUR_SRC + `
uniform ivec2 uDir;
uniform int uR;
uniform float uSigma;
uniform float uInvSum;
out vec4 outColor;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  if (uR == 0) {
    outColor = vec4(srcAt(P), 0.0, 0.0, 0.0);
    return;
  }
  float acc = 0.0;
  float k = 1.0 / (2.0 * uSigma * uSigma);
  for (int i = -uR; i <= uR; i++) {
    ivec2 q = P + uDir * i;
    if (!onCanvas(q) && uClamp == 0) continue;
    acc += srcAt(q) * (exp(-float(i * i) * k) * uInvSum);
  }
  outColor = vec4(acc, 0.0, 0.0, 0.0);
}`, false);

/** One running box along a direction (canvas.ts boxH/boxV: three of each make the big blurs). */
export const BOX_FS = FS(BLUR_SRC + `
uniform ivec2 uDir;
uniform int uR;
out vec4 outColor;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  for (int i = -uR; i <= uR; i++) acc += srcAt(P + uDir * i);
  outColor = vec4(acc * (1.0 / float(2 * uR + 1)), 0.0, 0.0, 0.0);
}`, false);

/** An extrusion's stack: a silhouette moved step by step to its depth, the most of all copies (style.ts maxShifted). */
export const STACK_FS = FS(`
uniform sampler2D uSil;
uniform int uGrow;
uniform float uBy;
uniform vec2 uCS;
uniform float uDepth;
uniform int uSteps;
out vec4 outColor;
float sil(ivec2 q) {
  if (!onCanvas(q)) return 0.0;
  float v = texelFetch(uSil, q, 0).r;
  return uGrow == 1 ? clamp01(uBy - v + 0.5) : v;
}
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float m = 0.0;
  for (int i = 1; i <= uSteps; i++) {
    float dx = (uCS.x * uDepth * float(i)) / float(uSteps);
    float dy = (uCS.y * uDepth * float(i)) / float(uSteps);
    float rx = jsRound(dx);
    float ry = jsRound(dy);
    float v;
    if (abs(dx - rx) < 1e-4 && abs(dy - ry) < 1e-4) v = sil(P - ivec2(int(rx), int(ry)));
    else {
      float ix = floor(dx);
      float iy = floor(dy);
      float tx = dx - ix;
      float ty = dy - iy;
      ivec2 q1 = P - ivec2(int(ix), int(iy));
      ivec2 q0 = q1 - ivec2(1, 1);
      v = sil(q1) * (1.0 - tx) * (1.0 - ty) + sil(ivec2(q0.x, q1.y)) * tx * (1.0 - ty) + sil(ivec2(q1.x, q0.y)) * (1.0 - tx) * ty + sil(q0) * tx * ty;
    }
    m = max(m, v);
  }
  outColor = vec4(m, 0.0, 0.0, 0.0);
}`, false);

/** The box of a mask's covered pixels, row by row (a column of [x0, x1, any]) and then whole ([x0, y0, x1, y1]). */
export const ROWBOX_FS = FS(`
uniform sampler2D uMask;
uniform int uW;
out vec4 outColor;
void main() {
  int y = int(gl_FragCoord.y);
  int x0 = uW;
  int x1 = 0;
  for (int x = 0; x < uW; x++)
    if (texelFetch(uMask, ivec2(x, y), 0).r > 0.0) {
      x0 = min(x0, x);
      x1 = x + 1;
    }
  outColor = vec4(float(x0), float(x1), x1 > x0 ? 1.0 : 0.0, 0.0);
}`, false);

export const BBOX_FS = FS(`
uniform sampler2D uRows;
uniform int uW;
uniform int uH;
out vec4 outColor;
void main() {
  float x0 = float(uW);
  float x1 = 0.0;
  float y0 = float(uH);
  float y1 = 0.0;
  for (int y = 0; y < uH; y++) {
    vec4 r = texelFetch(uRows, ivec2(0, y), 0);
    if (r.z > 0.0) {
      x0 = min(x0, r.x);
      x1 = max(x1, r.y);
      y0 = min(y0, float(y));
      y1 = float(y + 1);
    }
  }
  outColor = vec4(x0, y0, x1, y1);
}`, false);

// ─── Patterns and textures (textures.ts) ───────────────────────────────────────────────────────────

const PATTERN = `
uniform float uCell;
uniform vec2 uPatCS;
uniform float uDuty;
uniform int uPatSeed;
uniform vec2 uPatOrigin;
float duty(float d) { return uDuty >= 0.0 ? uDuty : d; }
bool odd(float row) { return mod(row, 2.0) == 1.0; }
float heartSd(float px, float py) {
  float x = abs(px);
  float y = py + 0.5;
  if (x + y > 1.0) return length(vec2(x - 0.25, y - 0.75)) - sqrt(2.0) / 4.0;
  float a = length(vec2(x, y - 1.0));
  float m = 0.5 * max(x + y, 0.0);
  float b = length(vec2(x - m, y - m));
  return sqrt(min(a * a, b * b)) * sign(x - y);
}
float starSd(float px, float py) {
  float inner = 0.45;
  float an = PI / 5.0;
  float a = (px == 0.0 && py == 0.0) ? 0.0 : atan(px, -py);
  a = mod(a, 2.0 * an) - an;
  float r = length(vec2(px, py));
  float qx = abs(sin(a)) * r;
  float qy = cos(a) * r;
  float ex = sin(an) * inner;
  float ey = cos(an) * inner - 1.0;
  float t = clamp01((qx * ex + (qy - 1.0) * ey) / (ex * ex + ey * ey));
  float d = length(vec2(qx - ex * t, qy - 1.0 - ey * t));
  float side = (qx * -ey + (qy - 1.0) * ex) > 0.0 ? 1.0 : -1.0;
  return d * side;
}
// textures.ts patternField at one pixel.
float patternAt(ivec2 P) {
  float X = float(P.x) + 0.5 - uPatOrigin.x;
  float Y = float(P.y) + 0.5 - uPatOrigin.y;
  float u = X * uPatCS.x + Y * uPatCS.y;
  float v = -X * uPatCS.y + Y * uPatCS.x;
  float s = uCell;
  const int k = PAT;
  if (k == 0) {
    float d = duty(0.5);
    float p = frac(u / s) * s;
    return d >= 1.0 ? 1.0 : sstep(-0.6, 0.6, min(p, d * s - p));
  }
  if (k == 17) {
    float d = duty(0.35);
    float p = frac(v / s) * s;
    return sstep(-0.5, 0.5, min(p, d * s - p));
  }
  if (k == 1 || k == 16) {
    float du = frac(u / s) * s - s / 2.0;
    float dv = frac(v / s) * s - s / 2.0;
    if (k == 1) {
      float r = s * duty(0.22);
      return 1.0 - sstep(r - 0.7, r + 0.7, length(vec2(du, dv)));
    }
    float r = s * duty(0.3);
    return (1.0 - sstep(r - 0.7, r + 0.7, length(vec2(du, dv)))) * (0.55 + 0.45 * clamp01(-dv / r + 0.3));
  }
  if (k == 2) return mod(floor(u / s) + floor(v / s), 2.0) == 0.0 ? 1.0 : 0.0;
  if (k == 3) {
    float du = abs(frac(u / s) * s - s / 2.0);
    float dv = abs(frac(v / s) * s - s / 2.0);
    float lw = duty(0.08) * s;
    return 1.0 - sstep(lw / 2.0 - 0.4, lw / 2.0 + 0.6, s / 2.0 - max(du, dv));
  }
  if (k == 13) {
    float lw = duty(0.15) * s;
    float r2 = sqrt(2.0);
    float d1 = abs(frac((u + v) / (s * r2)) - 0.5) * s * r2;
    float d2 = abs(frac((u - v) / (s * r2)) - 0.5) * s * r2;
    return max(1.0 - sstep(lw / 2.0 - 0.4, lw / 2.0 + 0.6, d1 - 0.0), 1.0 - sstep(lw / 2.0 - 0.4, lw / 2.0 + 0.6, d2));
  }
  if (k == 5) {
    float du = abs(frac(u / s) * s - s / 2.0);
    float dv = abs(frac(v / s) * s - s / 2.0);
    return 1.0 - sstep(s * 0.3 - 0.7, s * 0.3 + 0.7, du + dv);
  }
  if (k == 4) {
    // Lines of a honeycomb: the offset to the nearest hexagon centre, then the distance to its edge.
    float qx = u / s;
    float qy = v / s;
    float ax = frac(qx) - 0.5;
    float ay = frac(qy / 1.732) * 1.732 - 0.866;
    float bx = frac(qx - 0.5) - 0.5;
    float by = frac((qy - 0.866) / 1.732) * 1.732 - 0.866;
    vec2 g = ax * ax + ay * ay < bx * bx + by * by ? vec2(ax, ay) : vec2(bx, by);
    float ex = abs(g.x);
    float ey = abs(g.y);
    float edge = (0.5 - max(ex * 0.5 + ey * 0.866, ex)) * s;
    float lw = duty(0.06) * s;
    return 1.0 - sstep(lw / 2.0 - 0.5, lw / 2.0 + 0.6, edge);
  }
  if (k == 6) return sstep(-0.8, 0.8, sin((u / s) * PI * 2.0 + sin((v / s) * PI) * 1.2) * s * 0.3);
  if (k == 18) {
    float p = frac(u / s);
    float tri = abs(p - 0.5) * 2.0 * s * 0.5;
    float d = frac((v - tri) / s) * s;
    float lw = duty(0.3) * s;
    return sstep(-0.6, 0.6, min(d, lw - d));
  }
  if (k == 12) {
    float p = abs(frac(u / s) - 0.5) * s;
    float d = frac((v + p) / s) * s;
    float lw = duty(0.4) * s;
    return sstep(-0.6, 0.6, min(d, lw - d));
  }
  if (k == 7) {
    float bh = s * 0.5;
    float uu = u + (odd(floor(v / bh)) ? s / 2.0 : 0.0);
    float du = abs(frac(uu / s) * s - s / 2.0);
    float dv = abs(frac(v / bh) * bh - bh / 2.0);
    float mortar = duty(0.08) * s;
    return 1.0 - sstep(-0.5, 0.7, min(s / 2.0 - du, bh / 2.0 - dv) - mortar / 2.0);
  }
  if (k == 8) {
    float row = floor(v / (s * 0.5));
    float uu = u + (odd(row) ? s / 2.0 : 0.0);
    float cx = (floor(uu / s) + 0.5) * s;
    float cy = row * s * 0.5;
    float d = length(vec2(uu - cx, v - cy));
    float r = s * 0.5;
    float lw = duty(0.12) * s;
    return 1.0 - sstep(lw / 2.0 - 0.5, lw / 2.0 + 0.5, abs(d - r + lw / 2.0));
  }
  if (k == 19) {
    float p = frac(u / s + (odd(floor(v / s)) ? 0.5 : 0.0));
    float q = frac(v / s);
    return sstep(-0.04, 0.04, q - abs(p - 0.5) * 2.0) * 1.0;
  }
  if (k == 14) {
    float d = duty(0.18);
    float bandA = abs(frac(u / s) - 0.5) < d ? 1.0 : 0.0;
    float bandB = abs(frac(v / s) - 0.5) < d ? 1.0 : 0.0;
    float thin = abs(frac(u / s + 0.5) - 0.5) < 0.03 || abs(frac(v / s + 0.5) - 0.5) < 0.03 ? 0.7 : 0.0;
    return max(0.55 * (bandA + bandB), thin);
  }
  // bubbles 9, stars 10, hearts 11, confetti 15, sparkles 20: one mark per cell.
  int cx = int(floor(u / s));
  int cy = int(floor(v / s));
  float keep = duty(k == 9 ? 0.7 : 0.55);
  if (hash(cx, cy, uPatSeed) > keep) return 0.0;
  float px = (float(cx) + 0.25 + 0.5 * hash(cx, cy, uPatSeed + 1)) * s;
  float py = (float(cy) + 0.25 + 0.5 * hash(cx, cy, uPatSeed + 2)) * s;
  float size = 0.45 + 0.55 * hash(cx, cy, uPatSeed + 3);
  float dx = u - px;
  float dy = v - py;
  if (k == 9) {
    float r = s * 0.28 * size;
    float d = length(vec2(dx, dy));
    float rim = 1.0 - sstep(0.5, 1.4, abs(d - r) - s * 0.02);
    float glint = 1.0 - sstep(r * 0.12, r * 0.12 + 0.8, length(vec2(dx + r * 0.38, dy + r * 0.38)));
    float body = (1.0 - sstep(r - 0.6, r + 0.6, d)) * 0.18;
    return max(max(rim, glint), body);
  }
  if (k == 15) {
    float ang = hash(cx, cy, uPatSeed + 4) * PI;
    float qx = dx * cos(ang) + dy * sin(ang);
    float qy = -dx * sin(ang) + dy * cos(ang);
    float hw = s * 0.16 * size;
    float hh = s * 0.06 * size;
    return (1.0 - sstep(-0.6, 0.6, abs(qx) - hw)) * (1.0 - sstep(-0.6, 0.6, abs(qy) - hh));
  }
  if (k == 10) {
    float r = s * 0.3 * size;
    return 1.0 - sstep(-0.7, 0.7, starSd(dx / r, dy / r) * r);
  }
  if (k == 11) {
    float r = s * 0.3 * size;
    return 1.0 - sstep(-0.7, 0.7, heartSd(dx / r, -dy / r + 0.1) * r);
  }
  return sparkleAt(dx, dy, s * 0.3 * size);
}
`;

/** A pattern inside the shape, clipped (style.ts patterns), or cut out of the layer (cutouts). */
export const PATTERN_FS = FS(PATTERN + `
uniform sampler2D uShape;
uniform vec3 uColor;
uniform float uOpacity;
uniform int uMode;
uniform int uErase;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  if (uErase == 1) {
    outColor = px * (1.0 - clamp01(patternAt(P)));
    return;
  }
  float s = texelFetch(uShape, P, 0).r;
  float m = s > 0.0 ? patternAt(P) * s : 0.0;
  outColor = paintF(px, m, uOpacity, uColor, uMode, true);
}`);

/** textures.ts textureAt: kinds by index (noise 0 … pixels 17; scratches 8 are drawn apart). */
const TEXTURE = `
vec2 worley(float x, float y, int seed, float jitter) {
  float cx = floor(x);
  float cy = floor(y);
  float f1 = 9.0;
  float f2 = 9.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      int gx = int(cx) + i;
      int gy = int(cy) + j;
      float px = float(gx) + 0.5 + (hash(gx, gy, seed) - 0.5) * jitter;
      float py = float(gy) + 0.5 + (hash(gx, gy, seed + 1) - 0.5) * jitter;
      float d = length(vec2(px - x, py - y));
      // The nearest two, without branches (Direct3D's compiler got the branching form wrong in some shaders).
      f2 = min(f2, max(f1, d));
      f1 = min(f1, d);
    }
  return vec2(f1, f2);
}
// f2 - f1 of a worley pair, through a max with a value only known when the shader runs: Direct3D's shader compiler
// (through ANGLE) otherwise miscompiles smoothstep(f2 - f1) in some kinds (measured: caustics' web came out wrong).
float gap(vec2 f, float density) { return max(f.y - f.x, density - 100.0); }
float textureAt(float u, float v, float s, int seed, float density) {
#if KIND == 0
  return fbm(u / s, v / s, 4, seed);
#elif KIND == 1
  return sstep(0.25, 0.75, fbm(u / s, v / s, 5, seed));
#elif KIND == 2
  float warp = fbm(u / (s * 9.0), v / (s * 2.2), 3, seed) * 2.2;
  float g = v / s + warp;
  float ring = 0.5 + 0.5 * sin(g * PI * 2.0);
  float late = pow(max(ring, 0.0), 2.5);
  float fibre = fbm(u / (s * 6.0), v / (s * 0.18), 3, seed + 5);
  return clamp01(0.62 * late + 0.38 * fibre);
#elif KIND == 3
  float streak = fbm(u / (s * 30.0), v / (s * 0.35), 3, seed);
  float fine = hash(int(floor(u / (s * 14.0))), int(floor(v)), seed + 3);
  return clamp01(0.7 * streak + 0.3 * fine);
#elif KIND == 4
  float w = 0.35 * (fbm(u / (s * 0.7), v / (s * 0.7), 2, seed + 9) - 0.5);
  vec2 f = worley(u / s + w, v / s + w, seed, 0.9);
  float crack = sstep(0.02, 0.09, gap(f, density));
  float mottle = fbm(u / (s * 0.35), v / (s * 0.35), 3, seed + 4);
  return clamp01(crack * (0.55 + 0.45 * mottle) - (1.0 - crack) * 0.1);
#elif KIND == 5
  return clamp01(1.0 - worley(u / s, v / s, seed, 0.9).x / 0.75);
#elif KIND == 6
  float tx = u / s;
  float ty = v / s;
  float cx = floor(tx);
  float cy = floor(ty);
  float fx = tx - cx;
  float fy = ty - cy;
  bool overWarp = mod(cx + cy, 2.0) == 0.0;
  float thread = overWarp ? sin(PI * fx) : sin(PI * fy);
  float shade = overWarp ? 0.9 + 0.1 * sin(PI * fy) : 0.8 + 0.1 * sin(PI * fx);
  float slub = 0.88 + 0.24 * hash(int(cx), int(cy), seed);
  return clamp01(pow(max(0.0, thread), 0.55) * shade * slub);
#elif KIND == 7
  float t = abs(sin((u / s + v / (s * 3.0)) * PI * 0.5 + 5.0 * fbm(u / (s * 2.0), v / (s * 2.0), 5, seed)));
  float vein = sstep(0.0, 0.22, t);
  float cloud = fbm(u / (s * 1.4), v / (s * 1.4), 3, seed + 7);
  return clamp01(vein * (0.82 + 0.18 * cloud));
#elif KIND == 9
  float b = fbm(u / s, v / s, 5, seed);
  float blot = sstep(0.45 - 0.25 * density, 0.6 - 0.25 * density, b);
  float pit = hash(int(floor(u / 1.5)), int(floor(v / 1.5)), seed + 2) > 0.93 ? 0.6 : 0.0;
  return clamp01(max(blot * (0.6 + 0.4 * fbm(u / (s * 0.25), v / (s * 0.25), 2, seed + 4)), pit * blot + pit * 0.3));
#elif KIND == 10
  float wx = fbm(u / (s * 1.3), v / (s * 1.3), 2, seed + 11) - 0.5;
  float wy = fbm(u / (s * 1.3) + 7.1, v / (s * 1.3) + 3.3, 2, seed + 13) - 0.5;
  return fbm(u / s + wx * 1.6, v / (s * 0.8) + wy * 1.6, 3, seed);
#elif KIND == 11
  float tx = u / s;
  float ty = v / s;
  float cx = floor(tx);
  float cy = floor(ty);
  float fx = tx - cx;
  float fy = ty - cy;
  bool along = mod(floor((cx + cy) / 2.0), 2.0) == 0.0;
  float prof = sin(PI * (along ? fy : fx));
  return clamp01(0.15 + 0.85 * pow(max(0.0, prof), 1.5) * (along ? 1.0 : 0.7));
#elif KIND == 12
  float wx = fbm(u / (s * 2.0), v / (s * 2.0), 2, seed + 3) - 0.5;
  float wy = fbm(u / (s * 2.0) + 4.7, v / (s * 2.0) + 1.9, 2, seed + 5) - 0.5;
  vec2 f = worley(u / s + wx * 1.6, v / s + wy * 1.6, seed, 0.9);
  float web = 1.0 - sstep(0.0, 0.2, gap(f, density));
  return clamp01(web * web * (0.75 + 0.5 * fbm(u / s, v / s, 2, seed + 9)));
#elif KIND == 13
  float a = fbm(u / (s * 0.4), v / (s * 3.0), 3, seed);
  float b = fbm(u / (s * 3.0), v / (s * 0.4), 3, seed + 1);
  float c = fbm(u / s, v / s, 4, seed + 2);
  return clamp01(0.3 * a + 0.3 * b + 0.4 * c);
#elif KIND == 14
  vec2 f = worley(u / s, v / s, seed, 1.0);
  float crease = sstep(0.0, 0.08, gap(f, density));
  return clamp01(crease * (0.7 + 0.3 * fbm(u / (s * 0.3), v / (s * 0.3), 2, seed + 6)));
#elif KIND == 15
  float f1 = worley(u / s, v / s, seed, 0.8).x;
  return clamp01(1.0 - (f1 * f1) / 0.45);
#elif KIND == 16
  int cx = int(floor(u / s));
  int cy = int(floor(v / s));
  if (hash(cx, cy, seed) > density) return 0.0;
  float px = (float(cx) + 0.2 + 0.6 * hash(cx, cy, seed + 1)) * s;
  float py = (float(cy) + 0.2 + 0.6 * hash(cx, cy, seed + 2)) * s;
  float r = s * (0.08 + 0.14 * hash(cx, cy, seed + 3));
  return 1.0 - sstep(r - 0.6, r + 0.6, length(vec2(u - px, v - py)));
#elif KIND == 17
  return hash(int(floor(u / s)), int(floor(v / s)), seed);
#else
  return 0.0;
#endif
}
`;

/** textures.ts textureField: the value over the mask's box (a coarse lattice for smooth kinds), contrast, invert. */
export const TEXTURE_FIELD_FS = FS(TEXTURE + `
uniform sampler2D uShape;
uniform sampler2D uBBox;
uniform float uS;
uniform int uSeed;
uniform float uDensity;
uniform vec2 uCS;
uniform vec2 uOrigin;
uniform int uCoarse;
uniform float uContrast;
uniform int uInvert;
out vec4 outColor;
float texAt(float x, float y) {
  float px = x - uOrigin.x;
  float py = y - uOrigin.y;
  return textureAt(px * uCS.x + py * uCS.y, -px * uCS.y + py * uCS.x, uS, uSeed, uDensity);
}
#if KIND == 8
// Thin random strokes along the grain (textures.ts scratches), the strongest one here.
float scratchesAt(ivec2 P, vec4 bb) {
  float s = uS;
  float cell = s * 3.0;
  float ox = uOrigin.x;
  float oy = uOrigin.y;
  int c0x = int(floor((bb.x - ox) / cell)) - 1;
  int c1x = int(ceil((bb.z - ox) / cell)) + 1;
  int c0y = int(floor((bb.y - oy) / cell)) - 1;
  int c1y = int(ceil((bb.w - oy) / cell)) + 1;
  float x = float(P.x);
  float y = float(P.y);
  int pcx = int(floor((x - ox) / cell));
  int pcy = int(floor((y - oy) / cell));
  int R = int(ceil((3.25 * s + 4.0) / cell)) + 1;
  float best = 0.0;
  for (int cy = max(c0y, pcy - R); cy <= min(c1y, pcy + R); cy++)
    for (int cx = max(c0x, pcx - R); cx <= min(c1x, pcx + R); cx++)
      for (int k = 0; k < 2; k++) {
        int sk = uSeed + k * 17;
        if (hash(cx, cy, sk) > uDensity) continue;
        float px = ox + (float(cx) + hash(cx, cy, sk + 1)) * cell;
        float py = oy + (float(cy) + hash(cx, cy, sk + 2)) * cell;
        float len = s * (1.5 + 5.0 * hash(cx, cy, sk + 3));
        float turn = (hash(cx, cy, sk + 4) - 0.5) * 0.9;
        float dx = uCS.x * cos(turn) - uCS.y * sin(turn);
        float dy = uCS.y * cos(turn) + uCS.x * sin(turn);
        float width = 0.35 + 0.6 * hash(cx, cy, sk + 5);
        float strength = 0.45 + 0.55 * hash(cx, cy, sk + 6);
        float ax = px - (dx * len) / 2.0;
        float ay = py - (dy * len) / 2.0;
        float bx = px + (dx * len) / 2.0;
        float by = py + (dy * len) / 2.0;
        if (x < max(bb.x, floor(min(ax, bx) - 2.0)) || x >= min(bb.z, ceil(max(ax, bx) + 2.0)) || y < max(bb.y, floor(min(ay, by) - 2.0)) || y >= min(bb.w, ceil(max(ay, by) + 2.0))) continue;
        float qx = x + 0.5 - ax;
        float qy = y + 0.5 - ay;
        float t = clamp01((qx * dx + qy * dy) / len);
        float d = length(vec2(qx - dx * len * t, qy - dy * len * t));
        float taper = sin(PI * t);
        best = max(best, (1.0 - sstep(width * taper - 0.5, width * taper + 0.6, d)) * strength);
      }
  return best;
}
#endif
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 bb = texelFetch(uBBox, ivec2(0, 0), 0);
  if (bb.z <= bb.x) {
    outColor = vec4(0.0);
    return;
  }
  float x = float(P.x);
  float y = float(P.y);
  bool inBox = x >= bb.x && x < bb.z && y >= bb.y && y < bb.w;
  float v = 0.0;
#if KIND == 8
  if (inBox) v = scratchesAt(P, bb);
#else
  if (inBox && texelFetch(uShape, P, 0).r > 0.0) {
    if (uCoarse == 1) v = texAt(x + 0.5, y + 0.5);
    else {
      float c = float(uCoarse);
      int gw = int(ceil((bb.z - bb.x) / c)) + 2;
      int gh = int(ceil((bb.w - bb.y) / c)) + 2;
      float gy = (y + 0.5 - bb.y) / c;
      int j = min(gh - 2, int(floor(gy)));
      float ty = gy - float(j);
      float gx = (x + 0.5 - bb.x) / c;
      int i = min(gw - 2, int(floor(gx)));
      float tx = gx - float(i);
      float X0 = bb.x + float(i) * c;
      float Y0 = bb.y + float(j) * c;
      v = (texAt(X0, Y0) * (1.0 - tx) + texAt(X0 + c, Y0) * tx) * (1.0 - ty) + (texAt(X0, Y0 + c) * (1.0 - tx) + texAt(X0 + c, Y0 + c) * tx) * ty;
    }
  }
#endif
  if (uContrast != 1.0) v = clamp01(0.5 + (v - 0.5) * uContrast);
  if (uInvert == 1) v = 1.0 - v;
  outColor = vec4(v, 0.0, 0.0, 0.0);
}`, false);

/** style.ts texture(): the value through a ramp, one colour or grey, then its relief. */
export const TEXTURE_PAINT_FS = FS(`
uniform sampler2D uShape;
uniform sampler2D uTex;
uniform int uHow;
uniform vec3 uColor;
uniform float uOp;
uniform int uMode;
uniform float uRelief;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  float s = texelFetch(uShape, P, 0).r;
  float v = texelFetch(uTex, P, 0).r;
  if (uHow == 0) {
    if (s > 0.0) {
      vec4 l = texelFetch(uLut, ivec2(int(jsRound(clamp01(v) * 1023.0)), uLutRow), 0);
      float a = min(1.0, s * uOp * l.a);
      if (a > 0.0) px = lay(px, a, l.rgb, uMode, true);
    }
  } else if (uHow == 1) {
    float a = min(1.0, s * v * uOp);
    if (a > 0.0) px = lay(px, a, uColor, uMode, true);
  } else {
    float a = min(1.0, s * uOp);
    if (a > 0.0) px = lay(px, a, vec3(v), uMode, true);
  }
  if (uRelief != 0.0 && s > 0.0 && P.x >= 1 && P.y >= 1 && P.x < uSize.x - 1 && P.y < uSize.y - 1) {
    float k = uRelief * 2.2;
    float gx = (texelFetch(uTex, P + ivec2(1, 0), 0).r - texelFetch(uTex, P - ivec2(1, 0), 0).r) * 0.5;
    float gy = (texelFetch(uTex, P + ivec2(0, 1), 0).r - texelFetch(uTex, P - ivec2(0, 1), 0).r) * 0.5;
    float lit = (-gx * -0.6 + -gy * -0.8) * k;
    if (lit > 0.0) px = lay(px, min(1.0, lit * s), vec3(1.0), 2, true);
    else if (lit < 0.0) px = lay(px, min(1.0, -lit * s), vec3(0.0), 1, true);
  }
  outColor = px;
}`);

// ─── Layer style passes (style.ts renderStyled) ────────────────────────────────────────────────────

/** A field (moved) in one colour: drop shadow and outer glow. */
export const FIELD_PAINT_FS = FS(`
uniform sampler2D uField;
uniform vec2 uShift;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  outColor = paintF(texelFetch(uDst, P, 0), shiftAt(uField, P, uShift), uOpacity, uColor, 0, false);
}`);

/** The inner shadow: the inverted shape blurred and moved (solid where it comes from past the canvas), inside. */
export const INNER_SHADOW_FS = FS(`
uniform sampler2D uField;
uniform sampler2D uShape;
uniform vec2 uShift;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float b = shiftAt(uField, P, uShift);
  if (uShift.x != 0.0 || uShift.y != 0.0) {
    float sx = float(P.x) - uShift.x;
    float sy = float(P.y) - uShift.y;
    if (sx < 0.0 || sx >= float(uSize.x) || sy < 0.0 || sy >= float(uSize.y)) b = 1.0;
  }
  outColor = paintF(texelFetch(uDst, P, 0), b * texelFetch(uShape, P, 0).r, uOpacity, uColor, 0, true);
}`);

/** The extrusion: its stroke's stack in one colour, then the stack in its paint's colour. */
export const EXTRUDE_FS = FS(`
uniform sampler2D uStack;
uniform sampler2D uRingStack;
uniform int uRing;
uniform vec3 uRingColor;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  if (uRing == 1) px = paintF(px, texelFetch(uRingStack, P, 0).r, 1.0, uRingColor, 0, false);
  outColor = paintP(px, vec2(P), texelFetch(uStack, P, 0).r, 1.0, 0, false);
}`);

/** A stroke (a band of the distance field) or the face (the shape) in a paint; also overlays (clipped, blended). */
export const STROKE_FS = FS(`
uniform sampler2D uSd;
uniform sampler2D uShape;
uniform int uFace;
uniform vec2 uBand;
uniform float uOpacity;
uniform int uMode;
uniform int uClip;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float f;
  if (uFace == 1) f = texelFetch(uShape, P, 0).r;
  else {
    float d = texelFetch(uSd, P, 0).r;
    f = clamp01(min(d - uBand.x + 0.5, uBand.y - d + 0.5));
  }
  outColor = paintP(texelFetch(uDst, P, 0), vec2(P), f, uOpacity, uMode, uClip == 1);
}`);

/** Grain: canvas.ts value noise (from the layer box's corner) blended over the face. */
export const GRAIN_FS = FS(`
uniform sampler2D uShape;
uniform float uScale;
uniform float uAmount;
uniform int uMode;
uniform vec2 uOrigin;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  float a = texelFetch(uShape, P, 0).r * uAmount;
  if (a > 0.0) {
    float n = noiseAt(float(P.x), float(P.y), uScale, 3, 11, uOrigin);
    px = lay(px, min(1.0, a), vec3(n), uMode, true);
  }
  outColor = px;
}`);

export const INNER_GLOW_FS = FS(`
uniform sampler2D uShape;
uniform sampler2D uSd;
uniform float uGlow;
uniform vec3 uColor;
uniform float uOpacity;
uniform int uMode;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float g = texelFetch(uShape, P, 0).r * (1.0 - sstep(0.0, uGlow, -texelFetch(uSd, P, 0).r));
  outColor = paintF(texelFetch(uDst, P, 0), g, uOpacity, uColor, uMode, true);
}`);

/** Chipped paint near the edges (style.ts wear). */
export const WEAR_FS = FS(`
uniform sampler2D uShape;
uniform sampler2D uSd;
uniform float uWidth;
uniform float uScale;
uniform int uSeed;
uniform float uAmount;
uniform vec4 uBox;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  float s = texelFetch(uShape, P, 0).r;
  float f = 0.0;
  if (s > 0.0) {
    float zone = 1.0 - sstep(0.0, uWidth, -texelFetch(uSd, P, 0).r);
    if (zone > 0.0) {
      float v = fbm((float(P.x) - uBox.x) / uScale, (float(P.y) - uBox.y) / uScale, 3, uSeed) * (0.45 + 0.55 * zone) + zone * 0.25;
      f = sstep(1.0 - uAmount * 0.75, 1.0 - uAmount * 0.75 + 0.06, v) * s;
    }
  }
  outColor = paintF(px, f, uOpacity, uColor, 0, true);
}`);

/** Bevel and emboss: the smoothed height's slope lit from a direction (style.ts bevel, with its specular). */
export const BEVEL_FS = FS(`
uniform sampler2D uShape;
uniform sampler2D uHeight;
uniform vec3 uL;
uniform float uDepth;
uniform vec3 uHi;
uniform vec3 uLo;
uniform float uHiOp;
uniform float uLoOp;
uniform float uSpec;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  float cov = texelFetch(uShape, P, 0).r;
  if (P.x >= 1 && P.y >= 1 && P.x < uSize.x - 1 && P.y < uSize.y - 1 && cov > 0.0) {
    float gx = (texelFetch(uHeight, P + ivec2(1, 0), 0).r - texelFetch(uHeight, P - ivec2(1, 0), 0).r) * 0.5 * uDepth;
    float gy = (texelFetch(uHeight, P + ivec2(0, 1), 0).r - texelFetch(uHeight, P - ivec2(0, 1), 0).r) * 0.5 * uDepth;
    if (gx != 0.0 || gy != 0.0) {
      float len = sqrt(gx * gx + gy * gy + 1.0);
      float ndl = (-gx * uL.x - gy * uL.y + uL.z) / len;
      float lit = ndl - uL.z;
      if (lit > 0.0) {
        float a = min(1.0, lit * 2.2) * uHiOp;
        if (uSpec > 0.0) a = min(1.0, a + pow(max(0.0, ndl), 24.0) * uSpec * 1.4);
        px = lay(px, a * cov, uHi, 2, true);
      } else if (lit < 0.0) px = lay(px, min(1.0, -lit * 2.2) * uLoOp * cov, uLo, 1, true);
    }
  }
  outColor = px;
}`);

/** style.ts gloss: arc (0), band (1), spot (2), glass (3). */
export const GLOSS_FS = FS(`
uniform sampler2D uShape;
uniform sampler2D uSd;
uniform vec4 uBox;
uniform float uInset;
uniform float uHeight;
uniform float uHRaw;
uniform float uCurve;
uniform int uStyle;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  float d = texelFetch(uSd, P, 0).r;
  float f = 0.0;
  if (!(d > -uInset + 1.5 || texelFetch(uShape, P, 0).r <= 0.0)) {
    float edgeIn = sstep(-uInset + 1.5, -uInset - 1.5, d);
    float x = float(P.x);
    float y = float(P.y);
    float u = (x - uBox.x) / uBox.z - 0.5;
    float v = (y - uBox.y) / max(1.0, uBox.w);
    float a = 0.0;
    bool skip = false;
    if (uStyle == 2) {
      float sx = (u + 0.2) / 0.26;
      float sy = (v - 0.24) / max(0.05, uHRaw * 0.36);
      a = 1.0 - sstep(0.55, 1.0, length(vec2(sx, sy)));
    } else if (uStyle == 3) {
      float line = uHRaw * (1.0 - (u + 0.5) * 0.65);
      float t = v - line;
      a = (1.0 - sstep(-0.006, 0.006, t)) * (0.55 + 0.45 * (1.0 - v / max(0.05, line)));
    } else {
      // A highlight whose lower edge bows down in the middle.
      float edge = uBox.y + uHeight * (1.0 - uCurve * 4.0 * u * u * 0.5);
      float t = (y - uBox.y) / max(1.0, edge - uBox.y);
      if (t < 0.0 || t > 1.05) skip = true;
      else a = uStyle == 1 ? (1.0 - sstep(0.93, 1.0, t)) * (1.0 - 0.45 * t) : 1.0 - sstep(0.35, 1.0, t);
    }
    if (!skip) f = a * edgeIn;
  }
  outColor = paintF(px, f, uOpacity, uColor, 2, true);
}`);

export const SHEEN_FS = FS(`
uniform sampler2D uShape;
uniform vec4 uBox;
uniform vec2 uSC;
uniform float uCx;
uniform float uDen;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float s = texelFetch(uShape, P, 0).r;
  float f = 0.0;
  if (s > 0.0) {
    float d = (float(P.x) - uCx) * uSC.x - (float(P.y) - uBox.y - uBox.w / 2.0) * uSC.y;
    f = s * exp(-(d * d) / uDen);
  }
  outColor = paintF(texelFetch(uDst, P, 0), f, uOpacity, uColor, 2, true);
}`);

/** style.ts rim: light on the inside of the edge facing it, shade on the other (hard: an exact band, all or nothing). */
export const RIM_FS = FS(`
uniform sampler2D uShape;
uniform sampler2D uSd;
uniform float uWidth;
uniform vec2 uL;
uniform float uPow;
uniform vec3 uColor;
uniform float uOpacity;
uniform int uShade;
uniform vec3 uShadeColor;
uniform float uShadeOpacity;
uniform int uHard;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 px = texelFetch(uDst, P, 0);
  float hi = 0.0;
  float lo = 0.0;
  float cov = texelFetch(uShape, P, 0).r;
  if (P.x >= 1 && P.y >= 1 && P.x < uSize.x - 1 && P.y < uSize.y - 1 && cov > 0.0) {
    float d = -texelFetch(uSd, P, 0).r;
    float zone = uHard == 1 ? (d < uWidth ? 1.0 : 0.0) : 1.0 - sstep(uWidth * 0.45, uWidth + 0.5, d);
    if (d <= uWidth + 1.0 && zone > 0.0) {
      float nx = texelFetch(uSd, P + ivec2(1, 0), 0).r - texelFetch(uSd, P - ivec2(1, 0), 0).r;
      float ny = texelFetch(uSd, P + ivec2(0, 1), 0).r - texelFetch(uSd, P - ivec2(0, 1), 0).r;
      float len = length(vec2(nx, ny));
      if (len >= 1e-6) {
        float facing = (nx * uL.x + ny * uL.y) / len;
        if (uHard == 1) {
          if (facing > 0.3) hi = zone * cov;
          else if (uShade == 1 && facing < -0.3) lo = zone * cov;
        } else if (facing > 0.0) hi = zone * pow(facing, uPow) * cov;
        else if (uShade == 1) lo = zone * pow(-facing, uPow) * cov;
      }
    }
  }
  px = paintF(px, hi, uOpacity, uColor, 2, true);
  if (uShade == 1) px = paintF(px, lo, uShadeOpacity, uShadeColor, 1, true);
  outColor = px;
}`);

/**
 * style.ts sparkles, placing: fragment i replays the placement and keeps the i-th spot (x, y, r, 1), or nothing.
 */
export const SPARKLE_PLACE_FS = FS(`
uniform sampler2D uSd;
uniform int uCount;
uniform float uSpark;
uniform int uSeed;
uniform int uArea;
uniform vec4 uBox;
out vec4 outColor;
void main() {
  int want = int(gl_FragCoord.x);
  vec3 spots[64];
  int placed = 0;
  vec4 mine = vec4(0.0);
  for (int tries = 0; tries < 2560; tries++) {
    if (tries >= uCount * 40 || placed >= uCount) break;
    // Round the shape ("around"): candidates over the box grown by the sparkles' reach, as the CPU picks them.
    float g = uArea == 3 ? uSpark * 1.6 : 0.0;
    float px = uBox.x - g + hash(tries, 1, uSeed) * (uBox.z + 2.0 * g);
    float py = uBox.y - g + hash(tries, 2, uSeed) * (uBox.w + 2.0 * g) * (uArea == 1 ? 0.5 : 1.0);
    float r = uSpark * (0.55 + 0.45 * hash(tries, 3, uSeed));
    int xi = int(jsRound(px));
    int yi = int(jsRound(py));
    if (xi < 0 || yi < 0 || xi >= uSize.x || yi >= uSize.y) continue;
    float d = texelFetch(uSd, ivec2(xi, yi), 0).r;
    bool ok = uArea == 3 ? d > r * 0.2 && d < r * 1.2 : uArea == 2 ? d > -r * 0.5 && d < r * 0.1 : d < -r * 0.6;
    if (!ok) continue;
    bool near = false;
    for (int k = 0; k < 64; k++) {
      if (k >= placed) break;
      if (length(spots[k].xy - vec2(px, py)) < (spots[k].z + r) * 1.4) near = true;
    }
    if (near) continue;
    spots[placed] = vec3(px, py, r);
    if (placed == want) mine = vec4(px, py, r, 1.0);
    placed++;
  }
  outColor = mine;
}`, false);

export const SPARKLE_PAINT_FS = FS(`
uniform sampler2D uSpots;
uniform int uCount;
uniform float uGlow;
uniform vec3 uColor;
uniform float uOpacity;
uniform int uAround;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  float x = float(P.x);
  float y = float(P.y);
  float f = 0.0;
  for (int k = 0; k < 64; k++) {
    if (k >= uCount) break;
    vec4 sp = texelFetch(uSpots, ivec2(k, 0), 0);
    if (sp.w == 0.0) continue;
    float reach = ceil(sp.z * 1.2);
    if (x < max(0.0, floor(sp.x - reach)) || x >= min(float(uSize.x), ceil(sp.x + reach)) || y < max(0.0, floor(sp.y - reach)) || y >= min(float(uSize.y), ceil(sp.y + reach))) continue;
    float dx = x + 0.5 - sp.x;
    float dy = y + 0.5 - sp.y;
    float g = sp.z * 0.35;
    f = max(f, max(sparkleAt(dx, dy, sp.z), uGlow * exp(-(dx * dx + dy * dy) / (2.0 * g * g))));
  }
  vec4 px = texelFetch(uDst, P, 0);
  outColor = uAround == 1 ? paintF(px, f, uOpacity, uColor, 0, false) : paintF(px, f, uOpacity, uColor, 2, true);
}`);

// ─── Compositing and the picture ───────────────────────────────────────────────────────────────────

/** A layer's canvas at its region (drawn with blending ONE, ONE_MINUS_SRC_ALPHA: canvas.ts over). */
export const OVER_FS = FS(`
uniform sampler2D uSrc;
uniform ivec2 uOrigin;
out vec4 outColor;
void main() {
  outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy) - uOrigin, 0);
}`, false);

/** canvas.ts pixelFinish: hard alpha, posterised colour with an ordered dither. */
export const PIXEL_FINISH_FS = FS(`
uniform sampler2D uSrc;
uniform float uThreshold;
uniform int uLevels;
uniform int uDither;
out vec4 outColor;
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uSrc, P, 0);
  if (c.a < uThreshold) {
    outColor = vec4(0.0);
    return;
  }
  vec3 v = clamp(c.rgb * (1.0 / c.a), 0.0, 1.0);
  if (uLevels > 1) {
    float step = float(uLevels - 1);
    float bias = uDither == 1 ? (BAYER[(P.y & 3) * 4 + (P.x & 3)] + 0.5) / 16.0 - 0.5 : 0.0;
    v = clamp(floor(v * step + bias + 0.5) / step, 0.0, 1.0);
  }
  outColor = vec4(v, 1.0);
}`, false);

/** canvas.ts toImage (after a whole-number nearest-neighbour upscale): straight alpha, rounded to 8 bits. */
export const TO_IMAGE_FS = FS(`
uniform sampler2D uSrc;
uniform int uK;
out vec4 outColor;
void main() {
  vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy) / uK, 0);
  float a = clamp01(c.a);
  vec3 col = a > 0.0 ? floor(clamp(c.rgb / a, 0.0, 1.0) * 255.0 + 0.5) : vec3(0.0);
  outColor = vec4(col, floor(a * 255.0 + 0.5)) / 255.0;
}`, false);
