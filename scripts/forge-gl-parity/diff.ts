/**
 * CPU | GPU | difference (×8; red where the GPU has more, blue less) for parity-run elements, over a checker:
 *
 *   npx tsx --tsconfig tsconfig.node.json scripts/forge-gl-parity/diff.ts <dataDir> <i,i,…> <out.png>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '../../src/core/modeling/png';

const [dir, list, out] = process.argv.slice(2) as [string, string, string];
const specs = JSON.parse(readFileSync(join(dir, 'specs.json'), 'utf8')) as Array<{ i: number; name: string; cpu: { width: number; height: number } }>;
const rows = list.split(',').map((i) => specs[Number(i)]!);
const W = Math.max(...rows.map((r) => r.cpu.width)) * 3 + 40;
const H = rows.reduce((s, r) => s + r.cpu.height + 10, 10);
const img = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const c = ((x >> 3) + (y >> 3)) & 1 ? 200 : 150;
    img.set([c, c, c, 255], (y * W + x) * 4);
  }
let oy = 10;
for (const r of rows) {
  const cpu = readFileSync(join(dir, `cpu-${r.i}.rgba`));
  const gpu = readFileSync(join(dir, `gpu-${r.i}.rgba`));
  const { width: w, height: h } = r.cpu;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      for (const [src, ox] of [[cpu, 10], [gpu, 20 + w]] as const) {
        const o = ((oy + y) * W + ox + x) * 4;
        const a = src[k + 3]! / 255;
        for (let c = 0; c < 3; c++) img[o + c] = Math.round(src[k + c]! * a + img[o + c]! * (1 - a));
      }
      let d = 0;
      for (let c = 0; c < 3; c++) d += (gpu[k + c]! * gpu[k + 3]!) / 255 - (cpu[k + c]! * cpu[k + 3]!) / 255;
      d = d / 3 + (gpu[k + 3]! - cpu[k + 3]!);
      const v = Math.min(255, Math.abs(d) * 8);
      img.set(d > 0 ? [255, 255 - v, 255 - v, 255] : [255 - v, 255 - v, 255, 255], ((oy + y) * W + 30 + 2 * w + x) * 4);
    }
  oy += h + 10;
}
writeFileSync(out, encodePng({ width: W, height: H, data: img }));
console.log(out, rows.map((r) => r.name).join(', '));
