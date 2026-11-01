import { useEffect, useRef } from 'react';
import { themeColor, useTheme } from '../lib/appearance';

/** A CSS hex colour as 0..1 RGB for the shader. */
function rgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Start page backdrop: glowing contour lines in the theme's colours on black. The lines are iso-lines of a slowly
 * drifting, domain-warped noise field (like a topographic map in motion), drawn anti-aliased with a
 * soft glow in one full-screen WebGL pass. Pauses when hidden; nearly still for reduced motion.
 */

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uLine;
uniform vec3 uIndex;
out vec4 outColor;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes.xy;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;
  float t = uTime * 0.028;

  // A slowly drifting, gently warped height field.
  vec2 q = vec2(fbm(p * 1.05 + vec2(0.0, t)), fbm(p * 1.05 + vec2(5.2, -t * 0.8)));
  float h = fbm(p * 1.25 + 1.6 * q + vec2(t * 0.5, -t * 0.35));

  // Contour lines at regular heights; every fifth line is a brighter "index" line.
  float k = 26.0;
  float v = h * k;
  float d = abs(fract(v + 0.5) - 0.5);
  float w = fwidth(v);
  float line = 1.0 - smoothstep(0.35 * w, 1.35 * w, d);
  float glow = exp(-d / max(w * 5.0, 1e-4)) * 0.28;
  float idx = abs(fract((v + 0.5) / 5.0) - 0.5) < (0.5 / 5.0) ? 1.0 : 0.0;

  // Brightness drifts across the field so some regions glow and others fade toward black.
  float sheen = smoothstep(0.25, 0.85, fbm(p * 0.8 + vec2(-t * 0.7, t * 0.4) + 3.1));
  float intensity = (line * (0.35 + 0.65 * sheen) * (0.55 + 0.45 * idx) + glow * sheen);

  vec3 col = mix(uLine, uIndex, idx * 0.6 + 0.25 * sheen) * intensity;

  // Calm the center behind the headline and the prompt; darken the edges.
  float center = smoothstep(0.62, 0.0, length((uv - vec2(0.5, 0.5)) * vec2(1.35, 1.9)));
  col *= mix(1.0, 0.28, center);
  col *= 0.55 + 0.45 * smoothstep(1.3, 0.3, length(uv - 0.5) * 1.5);
  outColor = vec4(col, 1.0);
}`;

export function FlowBackground({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // The theme's two colours, read again when it changes (the shader picks them up on its next frame).
  const theme = useTheme();
  const colors = useRef<{ line: [number, number, number]; index: [number, number, number] }>({ line: [1, 0.42, 0.06], index: [1, 0.7, 0.32] });
  useEffect(() => {
    colors.current = { line: rgb(themeColor('accent'), [1, 0.42, 0.06]), index: rgb(themeColor('accent2', '#ffb454'), [1, 0.7, 0.32]) };
  }, [theme]);
  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false, powerPreference: 'low-power' });
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uLine = gl.getUniformLocation(prog, 'uLine');
    const uIndex = gl.getUniformLocation(prog, 'uIndex');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Lines need full resolution to stay crisp; cap the pixel ratio to keep it light.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    let raf = 0;
    const t0 = performance.now() - 30_000;
    const resize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth * scale));
      const h = Math.max(1, Math.floor(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    const frame = (now: number) => {
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, ((now - t0) / 1000) * (reduced ? 0.12 : 1));
      gl.uniform3fv(uLine, colors.current.line);
      gl.uniform3fv(uIndex, colors.current.index);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);
  return <canvas ref={ref} className={className} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
