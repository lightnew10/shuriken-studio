// Checks src/main/shortcuts.ts in real Electron (Windows shortcuts): a Start menu shortcut to an older side-by-side
// Shuriken moves to the running one with its app id kept, a Desktop one too; a shortcut to a newer Shuriken, one to
// another app and one to the installer's own layout stay as they are. Everything lives in a temporary folder.
//   node scripts/shortcuts-check.mjs
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'shortcuts-check-'));
await build({ entryPoints: [join(root, 'src/main/shortcuts.ts')], bundle: true, platform: 'node', format: 'esm', external: ['electron'], outfile: join(work, 'shortcuts.mjs'), logLevel: 'silent' });
writeFileSync(
  join(work, 'main.mjs'),
  `import { app, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const W = process.env.SHORTCUTS_CHECK_WORK;
app.whenReady().then(async () => {
  const report = {};
  try {
    const { repointShortcuts, shortcutFolders, shortcutsToRepoint } = await import('./shortcuts.mjs');
    const exe = (v) => { const d = join(W, 'Versions', 'Shuriken Studio ' + v); mkdirSync(d, { recursive: true }); const f = join(d, 'Shuriken.exe'); writeFileSync(f, 'x'); return f; };
    const other = join(W, 'Other', 'Other.exe'); mkdirSync(join(W, 'Other'), { recursive: true }); writeFileSync(other, 'x');
    const installed = join(W, 'Programs', 'Shuriken Studio', 'Shuriken.exe'); mkdirSync(join(W, 'Programs', 'Shuriken Studio'), { recursive: true }); writeFileSync(installed, 'x');
    const p = { appData: join(W, 'Roaming'), desktop: join(W, 'Desktop') };
    const folders = shortcutFolders(p);
    const [start, desktop] = folders;
    for (const d of folders) mkdirSync(d, { recursive: true });
    const old = exe('1.15.9'), current = exe('1.16.0'), newer = exe('1.16.8');
    shell.writeShortcutLink(join(start, 'Shuriken Studio.lnk'), 'create', { target: old, cwd: join(old, '..'), appUserModelId: 'com.shurikenstudio.app' });
    shell.writeShortcutLink(join(desktop, 'Shuriken Studio.lnk'), 'create', { target: old, cwd: join(old, '..') });
    shell.writeShortcutLink(join(desktop, 'Shuriken newer.lnk'), 'create', { target: newer });
    shell.writeShortcutLink(join(desktop, 'Shuriken installed.lnk'), 'create', { target: installed });
    shell.writeShortcutLink(join(desktop, 'Other.lnk'), 'create', { target: other });
    // The installer's layout runs from a folder without a version: it plans and moves nothing.
    report.fromInstalled = shortcutsToRepoint(installed, folders).length;
    report.planned = shortcutsToRepoint(current, folders).map((x) => x.file.slice(W.length));
    report.changed = repointShortcuts(current, folders).map((f) => f.slice(W.length));
    const read = (f) => shell.readShortcutLink(f);
    report.start = read(join(start, 'Shuriken Studio.lnk'));
    report.desktop = read(join(desktop, 'Shuriken Studio.lnk'));
    report.newer = read(join(desktop, 'Shuriken newer.lnk')).target;
    report.installed = read(join(desktop, 'Shuriken installed.lnk')).target;
    report.other = read(join(desktop, 'Other.lnk')).target;
    report.expect = { current, newer, other, installed };
    // Started again (or by an older version): nothing more to change.
    report.again = repointShortcuts(current, folders).length;
    report.byOlder = repointShortcuts(exe('1.15.10'), folders).length;
  } catch (e) {
    report.error = String(e && e.stack || e);
  }
  writeFileSync(join(W, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(0);
});
`,
);
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'shortcuts-check', type: 'module', main: 'main.mjs' }));
const electron = createRequire(import.meta.url)('electron');
spawnSync(electron, [work], { stdio: 'inherit', timeout: 60000, env: { ...process.env, SHORTCUTS_CHECK_WORK: work } });
const r = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8'));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const checks = [
  ['the Start menu shortcut to 1.15.9 opens the running version', same(r.start?.target, r.expect?.current) && same(r.start?.cwd, r.expect?.current.replace(/\\Shuriken\.exe$/i, ''))],
  ['it keeps its app id (Search and notifications find the app by it)', r.start?.appUserModelId === 'com.shurikenstudio.app'],
  ["the Desktop's shortcut to 1.15.9 opens the running version too", same(r.desktop?.target, r.expect?.current)],
  ['a shortcut to a newer Shuriken (1.16.8) stays', same(r.newer, r.expect?.newer)],
  ["a shortcut to the installer's layout stays", same(r.installed, r.expect?.installed)],
  ['a shortcut to another app stays', same(r.other, r.expect?.other)],
  ['the plan named exactly the two old ones, and exactly those changed', r.planned?.length === 2 && JSON.stringify(r.planned) === JSON.stringify(r.changed)],
  ["run from the installer's layout: nothing to change", r.fromInstalled === 0],
  ['started again: nothing to change', r.again === 0],
  ['an older version started by hand moves nothing', r.byOlder === 0],
];
for (const [what, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
if (r.error) console.log(r.error);
if (checks.some(([, ok]) => !ok)) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(1);
}
console.log('All shortcut checks passed.');
