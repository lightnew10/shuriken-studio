/**
 * The GPU half of the parity run, in an Electron renderer (a harness window with Node integration): draws every plan
 * prep.ts made, compares with the CPU's pixels (mean absolute difference per channel, premultiplied as seen, and the
 * share of pixels off by more than 8/255), then times elements and whole screens, cold (no cached fields) and warm
 * (fields cached: a colour change). Writes <data>/results.json and gpu-<i>.rgba.
 */
import { createForgeGL } from '../../src/renderer/src/lib/forge-gl/forge-gl';
import { planFromWire, type WirePlan } from '../../src/shared/forge-plan';

declare const require: (m: string) => any;
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

interface Item {
  i: number;
  name: string;
  dir?: string;
  plan: WirePlan;
  cpu: { width: number; height: number; margin: number; scale: number; slice: number[] | null; drawn: number[] | null };
  cpuMs: number;
}

const log = (s: string) => console.log(s);

function compare(a: Uint8Array, b: Uint8Array, n: number) {
  let sum = 0;
  let off = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const aa = a[i * 4 + 3]!;
    const ba = b[i * 4 + 3]!;
    let px = Math.abs(aa - ba);
    let s = px;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs((a[i * 4 + k]! * aa) / 255 - (b[i * 4 + k]! * ba) / 255);
      s += d;
      if (d > px) px = d;
    }
    sum += s / 4;
    if (px > 8) off++;
    if (px > max) max = px;
  }
  return { mean: sum / n, off: (100 * off) / n, max };
}

async function main() {
  const dir = new URLSearchParams(location.search).get('dir')!;
  const items = JSON.parse(fs.readFileSync(path.join(dir, 'specs.json'), 'utf8')) as Item[];
  const t0 = performance.now();
  const gl = createForgeGL();
  const initMs = performance.now() - t0;
  log(`GPU ${gl.renderer}, ready in ${initMs.toFixed(0)} ms`);
  const sameMeta = (f: Awaited<ReturnType<typeof gl.forge>>, it: Item) =>
    f.image.width === it.cpu.width && f.image.height === it.cpu.height && f.margin === it.cpu.margin && f.scale === it.cpu.scale && JSON.stringify(f.slice) === JSON.stringify(it.cpu.slice) && JSON.stringify(f.drawn ?? null) === JSON.stringify(it.cpu.drawn);

  const results: unknown[] = [];
  for (const it of items) {
    gl.trim(true);
    const t = performance.now();
    try {
      const f = await gl.forge(planFromWire(it.plan));
      const ms = performance.now() - t;
      const same = sameMeta(f, it);
      const st = same ? compare(new Uint8Array(fs.readFileSync(path.join(dir, `cpu-${it.i}.rgba`))), f.image.data, f.image.width * f.image.height) : null;
      fs.writeFileSync(path.join(dir, `gpu-${it.i}.rgba`), f.image.data);
      results.push({ i: it.i, name: it.name, sameLayout: same, ...st, gpuMs: ms, cpuMs: it.cpuMs });
    } catch (e) {
      results.push({ i: it.i, name: it.name, failed: (e as Error).message });
    }
  }

  const time = async (list: Item[], warm: boolean, batch: boolean) => {
    const ps = list.map((it) => planFromWire(it.plan));
    if (warm) await gl.forgeMany(ps);
    else gl.trim(true);
    const t = performance.now();
    if (batch) await gl.forgeMany(ps);
    else
      for (const p of ps) {
        if (!warm) gl.trim(true);
        await gl.forge(p);
      }
    return performance.now() - t;
  };
  const bench = { n: items.length, cpuMs: items.reduce((a, b) => a + b.cpuMs, 0), coldMs: await time(items, false, false), warmMs: await time(items, true, false) };
  log(`${items.length} elements: CPU ${bench.cpuMs.toFixed(0)} ms (${((items.length * 1000) / bench.cpuMs).toFixed(0)}/s), GPU cold ${bench.coldMs.toFixed(0)} ms (${((items.length * 1000) / bench.coldMs).toFixed(0)}/s), warm ${bench.warmMs.toFixed(0)} ms (${((items.length * 1000) / bench.warmMs).toFixed(0)}/s)`);

  const screen: unknown[] = [];
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'screen.json'), 'utf8')) as Item[];
  for (const d of [...new Set(all.map((s) => s.dir!))]) {
    const s = all.filter((x) => x.dir === d);
    let mean = 0;
    let off = 0;
    let same = 0;
    gl.trim(true);
    const out = await gl.forgeMany(s.map((it) => planFromWire(it.plan)));
    out.forEach((f, k) => {
      const it = s[k]!;
      if (f instanceof Error || !sameMeta(f, it)) return;
      const st = compare(new Uint8Array(fs.readFileSync(path.join(dir, `cpu-s${it.i}.rgba`))), f.image.data, f.image.width * f.image.height);
      mean += st.mean;
      off += st.off;
      same++;
    });
    let cold = Infinity;
    let warm = Infinity;
    for (let r = 0; r < 3; r++) {
      cold = Math.min(cold, await time(s, false, true));
      warm = Math.min(warm, await time(s, true, true));
    }
    const cpuMs = s.reduce((a, b) => a + b.cpuMs, 0);
    screen.push({ dir: d, n: s.length, sameLayout: same, mean: mean / s.length, off: off / s.length, cpuMs, coldMs: cold, warmMs: warm });
    log(`screen ${d.padEnd(10)} ${s.length} skins: parity mean ${(mean / s.length).toFixed(3)} off ${(off / s.length).toFixed(3)}%  CPU ${cpuMs.toFixed(0)} ms  GPU cold ${cold.toFixed(1)} ms (x${(cpuMs / cold).toFixed(0)})  warm ${warm.toFixed(1)} ms (x${(cpuMs / warm).toFixed(0)})`);
  }
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ renderer: gl.renderer, initMs, items: results, bench, screen }, null, 1));
  gl.dispose();
}

main().then(
  () => ipcRenderer.send('done', 0),
  (e) => {
    console.log(`FAILED ${e?.stack ?? String(e)}`);
    ipcRenderer.send('done', 1);
  },
);
