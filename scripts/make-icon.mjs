// Generates build/icon.png (512) and build/icon.ico (16–256, PNG-embedded) procedurally:
// the app's pixel shuriken (amber to orange) on a dark rounded square. No image libraries required.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(OUT, { recursive: true });

// The Shuriken Studio mark, as the app draws it (src/renderer/src/brand/logo.tsx): a four-blade pinwheel on a 12×12
// pixel grid with a hollow core, amber to orange along the diagonal, the blades' long edges lighter.
const N = 12;
const UP = [[0, 7], [1, 6], [1, 7], [2, 5], [2, 6], [2, 7], [3, 4], [3, 5], [3, 6], [3, 7]];
const rot = ([r, c]) => [c, N - 1 - r];
const RIGHT = UP.map(rot);
const DOWN = RIGHT.map(rot);
const LEFT = DOWN.map(rot);
const CORE = [];
for (let r = 4; r <= 7; r++) for (let c = 4; c <= 7; c++) if (!((r === 5 || r === 6) && (c === 5 || c === 6))) CORE.push([r, c]);
const CELLS = new Set([...UP, ...RIGHT, ...DOWN, ...LEFT, ...CORE].map(([r, c]) => r * N + c));
const isEdge = (r, c) => (r === 3 && c >= 4 && c <= 7) || (c === 8 && r >= 4 && r <= 7) || (r === 8 && c >= 4 && c <= 7) || (c === 3 && r >= 4 && r <= 7);
const STOPS = [[0, [255, 196, 107]], [0.55, [255, 122, 26]], [1, [224, 72, 15]]];
const EDGE = [255, 208, 138];
function gradient(t) {
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

function render(size) {
  const ss = 4; // supersampling
  const px = new Uint8Array(size * size * 4);
  const bg = [16, 14, 13];
  // The mark fills most of the tile; at 16 and 24 px it gets more of it, and no gaps between its pixels.
  const margin = size <= 24 ? 0.1 : 0.16;
  const gap = size <= 32 ? 0 : 0.05;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size; // 0..1
          const v = (y + (sy + 0.5) / ss) / size;
          // Rounded square background.
          const r = 0.2;
          const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
          const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
          if (Math.hypot(dx, dy) > r) continue;
          let c = bg;
          const gx = ((u - margin) / (1 - 2 * margin)) * N;
          const gy = ((v - margin) / (1 - 2 * margin)) * N;
          const col = Math.floor(gx);
          const row = Math.floor(gy);
          if (col >= 0 && col < N && row >= 0 && row < N && CELLS.has(row * N + col)) {
            const fx = gx - col;
            const fy = gy - row;
            if (fx >= gap && fx <= 1 - gap && fy >= gap && fy <= 1 - gap) c = isEdge(row, col) ? EDGE : gradient((gx + gy) / (2 * N));
          }
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
          acc[3] += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const a = acc[3] / n;
      px[i] = a ? acc[0] / (acc[3] / 255) : 0;
      px[i + 1] = a ? acc[1] / (acc[3] / 255) : 0;
      px[i + 2] = a ? acc[2] / (acc[3] / 255) : 0;
      px[i + 3] = a;
    }
  }
  return px;
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, render(s)));
writeFileSync(join(OUT, 'icon.png'), png(512, render(512)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s;
  e[1] = s >= 256 ? 0 : s;
  e[2] = 0;
  e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
console.log('icon written to', OUT);
