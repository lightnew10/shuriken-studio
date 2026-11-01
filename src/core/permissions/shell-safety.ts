import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Where a destructive shell command lands, for autonomous mode (see owner-gate.ts and policy.ts): a command
 * the policy would ask about runs by itself only when everything it deletes or resets is inside the project
 * folder or the app's data folder. What can't be told (variables, `~`, a `cd` somewhere unknown) or lands
 * outside is refused, never waved through. Best effort on purpose: it reads the command line, it doesn't
 * run it, so the shapes it can't read are denials.
 */

export interface SafetyCheck {
  ok: boolean;
  /** Why not (a sentence fragment: "would delete C:\\Users\\x, outside the project"). */
  why: string;
}

const OK: SafetyCheck = { ok: true, why: '' };
const no = (why: string): SafetyCheck => ({ ok: false, why });

/** Which delete syntax a pattern is: rm -rf (unix), Remove-Item -Recurse (PowerShell), rd /s, del /s (cmd). */
export type DeleteStyle = 'unix' | 'ps' | 'cmd';

const DELETE_HEAD: Record<DeleteStyle, RegExp> = {
  unix: /\brm\b/gi,
  ps: /\bremove-item\b/gi,
  cmd: /\b(?:rd|rmdir|del)\b/gi,
};

/**
 * A path as Windows means it. The agents' shell is Git Bash, where drive C is `/c/…` (and `/mnt/c/…` in WSL,
 * `/cygdrive/c/…` in Cygwin); Node's `resolve` reads those as a folder named "c" on the current drive, so
 * `rm -rf "/c/Users/me/Projects/game/.shuriken/tmp"` was refused as `C:\c\Users\…`, "outside the project".
 * Anything else comes back as it is (mixed slashes are Node's own business); other platforms are untouched.
 */
export function drivePath(p: string, platform: string = process.platform): string {
  if (platform !== 'win32') return p;
  const m = /^[\\/]+(?:(?:mnt|cygdrive)[\\/]+)?([a-zA-Z])(?:[\\/]+(.*))?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:\\${m[2] ?? ''}` : p;
}

/** Where `path` lands when typed in `dir`. */
const landing = (dir: string, path: string): string => resolve(dir, drivePath(path));

const within = (root: string, abs: string): boolean => {
  const rel = relative(resolve(root), resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const insideAny = (roots: string[], abs: string): boolean => roots.some((r) => within(r, abs));
const sameAs = (a: string, b: string): boolean => relative(resolve(a), resolve(b)) === '';

/** Simple commands of a line: split at ; & | and line breaks (quotes ignored: more pieces only means more checks). */
export function splitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;&|\r\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The words of a simple command; quoted words stay whole, their quotes are dropped. */
export function shellTokens(segment: string): string[] {
  const out: string[] = [];
  const rx = /"([^"]*)"?|'([^']*)'?|([^\s"']+)/g;
  let cur = '';
  let m: RegExpExecArray | null;
  let last = -1;
  while ((m = rx.exec(segment))) {
    const piece = m[1] ?? m[2] ?? m[3] ?? '';
    // Adjacent pieces ("C:\a b"\x) form one word.
    if (last === m.index && cur) cur += piece;
    else {
      if (cur) out.push(cur);
      cur = piece;
    }
    last = m.index + m[0].length;
  }
  if (cur) out.push(cur);
  return out;
}

/** A word whose value can't be known from the command line (variables, `~`, command substitution). */
const unknownWord = (t: string): boolean => /[$%`]|^~/.test(t);

/** The directory after the `cd`-like command in this segment (null: unknown), or `dir` when there is none. */
function afterCd(segment: string, dir: string | null): string | null {
  const m = /(?:^|[\s"'(])(?:cd|chdir|pushd|set-location|sl)(?:\s+\/d)?(?:\s+(?:-path|-literalpath))?(?:\s+("[^"]+"|'[^']+'|[^\s"';&|]+))?/i.exec(segment);
  if (!m) return dir;
  const arg = m[1]?.replace(/^["']|["']$/g, '');
  if (!arg || arg === '-' || unknownWord(arg) || !dir) return null;
  return landing(dir, arg);
}

/** Why deleting `abs` is never done automatically even inside the allowed folders, or null. */
function protectedWhy(abs: string, roots: string[]): string | null {
  if (roots.some((r) => sameAs(r, abs))) return 'it is the whole project or app data folder';
  const parts = abs.split(/[\\/]+/).map((s) => s.toLowerCase());
  if (parts.includes('.git')) return "it is git's own data (the project's history and checkpoints)";
  const last = parts[parts.length - 1] ?? '';
  if (last === '.shuriken') return "it is the app's own project data";
  if (/^(project|global)\.db(-wal|-shm)?$/.test(last)) return "it is one of the app's databases";
  return null;
}

/** The targets a delete command names (after its head), by syntax. */
function deleteTargets(style: DeleteStyle, rest: string[]): string[] {
  const out: string[] = [];
  if (style === 'unix') {
    for (const t of rest) if (!t.startsWith('-')) out.push(t);
  } else if (style === 'cmd') {
    for (const t of rest) if (!/^\/[a-z](?::\S*)?$/i.test(t)) out.push(t);
  } else {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      if (/^-(?:literal)?path$/i.test(t)) {
        if (rest[i + 1] !== undefined) out.push(...rest[++i]!.split(','));
      } else if (/^-(?:include|exclude|filter|erroraction|ea|credential|stream|warningaction|wa|informationaction|ia)$/i.test(t)) i++;
      else if (/^-(?:literal)?path:/i.test(t)) out.push(...t.replace(/^-[a-z]+:/i, '').split(','));
      else if (!t.startsWith('-')) out.push(...t.split(','));
    }
  }
  return out.map((t) => t.replace(/^["']+|["']+$/g, '')).filter((t) => t !== '');
}

/**
 * Whether a recursive/bulk delete command (the segments where `pattern` matches) deletes only inside `roots`.
 * `cwd` is where the command line starts; `cd`s in the line move it.
 */
export function checkDeleteTargets(style: DeleteStyle, pattern: RegExp, command: string, roots: string[], cwd: string): SafetyCheck {
  let dir: string | null = cwd;
  let saw = false;
  for (const seg of splitSegments(command)) {
    dir = afterCd(seg, dir);
    if (!pattern.test(seg)) continue;
    saw = true;
    const head = new RegExp(DELETE_HEAD[style].source, 'gi');
    let h: RegExpExecArray | null;
    let any = false;
    while ((h = head.exec(seg))) {
      any = true;
      const targets = deleteTargets(style, shellTokens(seg.slice(h.index + h[0].length)));
      if (targets.length === 0) return no('names no path it can read');
      for (const t of targets) {
        if (unknownWord(t)) return no(`names "${t}", a path it can't read from the command (a variable or ~)`);
        if (!dir) return no('runs after a cd it can\'t read');
        const abs = landing(dir, t);
        if (!insideAny(roots, abs)) return no(`would delete ${abs}, outside the project and the app's data folder`);
        const prot = protectedWhy(abs, roots);
        if (prot) return no(`would delete ${abs}: ${prot}`);
      }
    }
    if (!any) return no('could not be read');
  }
  return saw ? OK : no('could not be read');
}

/** Whether a destructive git command (reset --hard, clean -f, branch -D …) works on a repository inside `roots`. */
export function checkGitRepo(pattern: RegExp, command: string, roots: string[], cwd: string): SafetyCheck {
  let dir: string | null = cwd;
  let saw = false;
  for (const seg of splitSegments(command)) {
    dir = afterCd(seg, dir);
    if (!pattern.test(seg)) continue;
    saw = true;
    if (!dir) return no('runs after a cd it can\'t read');
    if (!insideAny(roots, dir)) return no(`would run in ${dir}, outside the project and the app's data folder`);
    const toks = shellTokens(seg);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      let value: string | undefined;
      if (t === '-C') value = toks[i + 1];
      else if (/^--(?:git-dir|work-tree)=/.test(t)) value = t.replace(/^--[a-z-]+=/, '');
      else if (t === '--git-dir' || t === '--work-tree') value = toks[i + 1];
      if (value === undefined) continue;
      if (unknownWord(value)) return no(`names "${value}", a path it can't read from the command`);
      const abs = landing(dir, value);
      if (!insideAny(roots, abs)) return no(`would work on ${abs}, outside the project and the app's data folder`);
    }
  }
  return saw ? OK : no('could not be read');
}
