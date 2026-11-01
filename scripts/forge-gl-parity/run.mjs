#!/usr/bin/env node
/**
 * The GPU forge's parity and speed run: the CPU forges the parity set (prep.ts), an Electron window draws it on the
 * GPU (page.ts) and compares, and this prints the summary and fails when the GPU strays.
 *
 *   node scripts/forge-gl-parity/run.mjs [dataDir]       (default: <tmp>/forge-gl-parity)
 *
 * Targets: every element laid out exactly as the CPU does; mean difference below 1.5/255 and under 1% of pixels off by
 * more than 8/255 on every element. Run it after changing src/core/ui/forge (canvas, style, textures, forge) or
 * src/renderer/src/lib/forge-gl.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const here = import.meta.dirname;
const data = resolve(process.argv[2] ?? join(tmpdir(), 'forge-gl-parity'));
mkdirSync(data, { recursive: true });
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed (${r.status})`);
    process.exit(1);
  }
};
const q = (p) => (process.platform === 'win32' ? `"${p}"` : p);

// The glyph set and fonts: an ES module has no __dirname for shapes.ts to find resources by.
run('npx', ['tsx', '--tsconfig', 'tsconfig.node.json', q(join(here, 'prep.ts')), q(data)], { env: { ...process.env, SHURIKEN_RESOURCES: join(root, 'resources') } });
run(q(join(root, 'node_modules', '.bin', 'esbuild')), [q(join(here, 'page.ts')), '--bundle', '--format=iife', '--platform=browser', '--target=es2022', `--tsconfig=${q(join(root, 'tsconfig.web.json'))}`, '--external:fs', '--external:path', '--external:electron', `--outfile=${q(join(data, 'page.js'))}`, '--log-level=warning']);
writeFileSync(join(data, 'page.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="page.js"></script></body></html>');
run(q(join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')), [q(join(here, 'main.cjs')), q(data)], { shell: process.platform === 'win32' });

const r = JSON.parse(readFileSync(join(data, 'results.json'), 'utf8'));
const ok = r.items.filter((i) => i.sameLayout);
const bad = r.items.filter((i) => !i.sameLayout);
const mean = ok.reduce((a, b) => a + b.mean, 0) / Math.max(1, ok.length);
const off = ok.reduce((a, b) => a + b.off, 0) / Math.max(1, ok.length);
console.log(`\n${r.items.length} elements on ${r.renderer}: mean ${mean.toFixed(3)}/255, ${off.toFixed(3)}% of pixels off by > 8/255`);
for (const it of [...ok].sort((a, b) => b.mean - a.mean).slice(0, 8)) console.log(`  ${it.name.padEnd(36)} mean ${it.mean.toFixed(3)}  off ${it.off.toFixed(2)}%  max ${it.max.toFixed(0)}`);
const failing = ok.filter((i) => i.mean >= 1.5 || i.off >= 1);
if (bad.length) console.log(`laid out differently or failed: ${bad.map((b) => `${b.name}${b.failed ? ` (${b.failed})` : ''}`).join(', ')}`);
if (failing.length) console.log(`over the targets: ${failing.map((b) => b.name).join(', ')}`);
console.log(`pictures: ${data} (cpu-<i>.rgba, gpu-<i>.rgba; diff.ts draws CPU | GPU | difference)`);
process.exit(bad.length || failing.length ? 1 : 0);
