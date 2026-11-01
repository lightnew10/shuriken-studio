import { shell } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Windows shortcuts to an older side-by-side copy of Shuriken (`…\Versions\Shuriken Studio <x.y.z>\Shuriken.exe`, one
 * folder per version) are pointed at the one running (1.16). Windows Search and the Start menu open the Start menu's
 * shortcut, and an install or a hand edit often updated only one of the shortcuts, so Search kept opening the old
 * version. A shortcut is written afresh (`replace`), with the app id it had, so Windows has no stale target inside it to
 * fall back to. Only a newer version moves a shortcut: an older one started by hand leaves them alone. The installer's
 * own layout (one folder, updated in place) has no version in its path, so it is never touched.
 */

/** The version in a side-by-side Shuriken path, or null for anything else. */
export function shurikenVersion(path: string | undefined | null): string | null {
  return /\\Versions\\Shuriken Studio (\d+(?:\.\d+)+)\\Shuriken\.exe$/i.exec(path ?? '')?.[1] ?? null;
}

/** Negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The folders whose shortcuts are kept current: the Start menu's programs and the Desktop. */
export function shortcutFolders(p: { appData: string; desktop: string }): string[] {
  return [join(p.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), p.desktop];
}

/** The shortcuts in `folders` that open an older Shuriken than `exe`, with what they hold now. Reads only. */
export function shortcutsToRepoint(exe: string, folders: string[]): Array<{ file: string; link: Electron.ShortcutDetails }> {
  const mine = shurikenVersion(exe);
  if (!mine) return [];
  const out: Array<{ file: string; link: Electron.ShortcutDetails }> = [];
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter((n) => n.toLowerCase().endsWith('.lnk'))) {
      const file = join(folder, name);
      let link: Electron.ShortcutDetails;
      try {
        link = shell.readShortcutLink(file);
      } catch {
        continue;
      }
      const theirs = shurikenVersion(link.target);
      if (theirs && compareVersions(theirs, mine) < 0) out.push({ file, link });
    }
  }
  return out;
}

/** Points every shortcut in `folders` that opens an older Shuriken at `exe`. Returns the shortcuts it changed. */
export function repointShortcuts(exe: string, folders: string[]): string[] {
  const changed: string[] = [];
  for (const { file, link } of shortcutsToRepoint(exe, folders)) {
    const ok = shell.writeShortcutLink(file, 'replace', {
      target: exe,
      cwd: dirname(exe),
      ...(link.args ? { args: link.args } : {}),
      ...(link.description ? { description: link.description } : {}),
      icon: exe,
      iconIndex: 0,
      ...(link.appUserModelId ? { appUserModelId: link.appUserModelId } : {}),
    });
    if (ok) changed.push(file);
  }
  return changed;
}
