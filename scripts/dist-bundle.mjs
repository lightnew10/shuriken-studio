// npm run dist:bundle -- "<path to Kiln Setup <version>.exe>": Shuriken Studio's installer with Kiln inside. The Kiln
// installer rides along as resources\kiln\Kiln-Setup.exe and build/installer.nsh installs it after Shuriken Studio.
// KILN_SETUP can name the file instead of the argument. Without either this stops; plain `npm run dist` has no Kiln.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] ?? process.env.KILN_SETUP;
if (!src || !existsSync(src)) {
  console.error('Name Kiln\'s installer: npm run dist:bundle -- "C:\\path\\to\\Kiln Setup 0.8.7.exe" (or set KILN_SETUP).');
  process.exit(1);
}
const dest = join(root, 'build', 'bundle', 'kiln', 'Kiln-Setup.exe');
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`Bundling ${src}`);
try {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dist'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
} finally {
  rmSync(dest, { force: true });
}
