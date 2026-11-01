import { statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import { roleLabel } from '../agents/roles';
import { editedPath } from '../roblox/code-sync';

/**
 * What a task's `files` keep apart. Two tasks never run at the same time when they claim the SAME FILE; a folder
 * in `files` only says "I work somewhere in here" and excludes nobody. (Folder claims used to exclude: three tasks
 * that each listed src/Server/Combat ran one after another for 100 minutes although they touched different files.)
 * Sharing a folder is safe because roblox_sync_push leaves out the files other running agents are editing and
 * merges three ways, and because each agent is told at its start which files in its folders are someone else's
 * right now (`sharedFolderNote`). The planner is warned when two tasks claim the same folder (plan-checks.ts).
 */

/** A claim as it is compared: forward slashes, no leading "./", no trailing slash, lower case. */
export function claimKey(raw: string): string {
  return raw.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a `files` entry names a folder (or a pattern), not one file: it ends in a slash, has a wildcard, is a
 * directory on disk (`isDir`, given the entry with forward slashes), or its last segment has no extension.
 */
export function isFolderClaim(raw: string, isDir?: (rel: string) => boolean): boolean {
  const f = raw.trim().replaceAll('\\', '/');
  if (!f) return false;
  if (f.endsWith('/') || /[*?]/.test(f)) return true;
  if (isDir?.(f)) return true;
  return !/\.[A-Za-z0-9]{1,8}$/.test(f.split('/').pop() ?? '');
}

export interface Claims {
  /** Exact files (keys): exclusive. */
  files: Set<string>;
  /** Folders and patterns (keys, a pattern cut at its first wildcard): shared. */
  folders: string[];
}

export function claimsOf(files: readonly string[], isDir?: (rel: string) => boolean): Claims {
  const out: Claims = { files: new Set(), folders: [] };
  for (const raw of files) {
    if (!raw.trim()) continue;
    if (isFolderClaim(raw, isDir)) {
      const key = claimKey(raw.replace(/[*?].*$/, ''));
      if (!out.folders.includes(key)) out.folders.push(key);
    } else out.files.add(claimKey(raw));
  }
  return out;
}

/** The exact files both claim: what keeps two tasks from running together. */
export function sharedFiles(a: Claims, b: Claims): string[] {
  return [...a.files].filter((f) => b.files.has(f));
}

/** Whether `file` (a key) lies in `folder` (a key; '' is the whole project). */
export function inFolder(file: string, folder: string): boolean {
  return folder === '' || file === folder || file.startsWith(`${folder}/`);
}

/** The folders of `a` that are the same as, inside or around a folder of `b` (as `a` wrote them). */
export function sharedFolders(a: Claims, b: Claims): string[] {
  return a.folders.filter((f) => b.folders.some((g) => inFolder(f, g) || inFolder(g, f)));
}

/** Directory test for a project's claims (a claim is relative to the project root). */
export function dirTest(root: string): (rel: string) => boolean {
  return (rel) => {
    try {
      return statSync(join(root, rel)).isDirectory();
    } catch {
      return false;
    }
  };
}

/** The files the running agents of other tasks have edited so far (claim key → the file and that task's id). */
export function editsInFlight(p: ProjectContext, exceptTaskId: string): Map<string, { file: string; taskId: string }> {
  const out = new Map<string, { file: string; taskId: string }>();
  const runs = p.store.all<{ id: string; task_id: string }>("SELECT id, task_id FROM runs WHERE status IN ('starting', 'running') AND task_id IS NOT NULL AND task_id != ?", [exceptTaskId]);
  for (const r of runs) {
    for (const c of p.audit.toolCalls({ runId: r.id, limit: 400 })) {
      if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.tool)) continue;
      const fp = editedPath(c.args);
      if (!fp) continue;
      const rel = relative(p.root, resolve(p.root, fp)).replaceAll('\\', '/');
      if (!rel.startsWith('..')) out.set(claimKey(rel), { file: rel, taskId: r.task_id });
    }
  }
  return out;
}

/**
 * What an agent is told when it starts: the files in its folders that other running tasks are editing or have
 * claimed (not its to edit: it reports what it needs from them), and who else works in those folders. Empty when
 * the task claims no folder or nobody shares one.
 */
export function sharedFolderNote(p: ProjectContext, task: Task, running: readonly Task[]): string {
  const isDir = dirTest(p.root);
  const mine = claimsOf(task.files, isDir);
  if (!mine.folders.length) return '';
  const others = running.filter((t) => t.id !== task.id);
  if (!others.length) return '';
  const who = (t: Task) => `"${t.title}" (${roleLabel(t.role)})`;
  const within = (key: string) => mine.folders.some((f) => inFolder(key, f)) && !mine.files.has(key);
  const theirs = new Map<string, { file: string; task: Task }>();
  for (const t of others) {
    for (const raw of t.files) {
      if (!raw.trim() || isFolderClaim(raw, isDir)) continue;
      if (within(claimKey(raw))) theirs.set(claimKey(raw), { file: raw.trim().replaceAll('\\', '/'), task: t });
    }
  }
  for (const [key, e] of editsInFlight(p, task.id)) {
    const t = others.find((o) => o.id === e.taskId);
    if (t && within(key)) theirs.set(key, { file: e.file, task: t });
  }
  const owners = new Set([...theirs.values()].map((e) => e.task.id));
  const neighbours = others.filter((t) => !owners.has(t.id) && sharedFolders(mine, claimsOf(t.files, isDir)).length > 0);
  if (!theirs.size && !neighbours.length) return '';
  const lines = ['Other agents are working in your folders right now.'];
  if (theirs.size) {
    lines.push("These files are theirs for the moment. Don't edit them: if you need something changed in one, say exactly what in your result (a follow-up for its owner), and build your part in your own files.");
    for (const e of [...theirs.values()].slice(0, 30)) lines.push(`- ${e.file}: ${who(e.task)}`);
    if (theirs.size > 30) lines.push(`- …and ${theirs.size - 30} more (git_diff shows what changed)`);
  }
  if (neighbours.length) lines.push(`Also working somewhere in them: ${neighbours.slice(0, 8).map(who).join(', ')}. Before you change a file you didn't create, check it with git_diff: a file with someone else's fresh changes is theirs.`);
  return lines.join('\n');
}
