import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { decideFileWrite, isInside } from '../permissions/policy';
import { reserveMutation } from '../orchestrator/mutations';
import { errorOutput, jsonOutput, type ToolRegistry } from './tool-registry';
import type { ProjectContext } from '../projects/project-service';

export const WORKSPACE_TOOLS = ['workspace_read_file', 'workspace_search', 'workspace_write_file', 'workspace_exec'] as const;
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const privateSegment = (name: string) => /^(?:\.git|\.shuriken|node_modules|\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh)$/i.test(name);

/** Resolve every existing ancestor: lexical containment alone does not contain junctions/symlinks. */
export function workspacePath(root: string, path: string, write = false, protectPrivatePaths = true): string {
  const base = realpathSync(root), target = resolve(base, path);
  if (!isInside(base, target)) throw new Error('Path outside project');
  const rel = relative(base, target);
  if (rel.split(/[\\/]/).some((part) => (protectPrivatePaths && privateSegment(part)) || part.includes(':') || /[. ]$/.test(part))) throw new Error('Protected project path');
  if (write && !rel) throw new Error('A project file path is required');
  let ancestor = target;
  while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new Error('Invalid path'); ancestor = parent; }
  const actual = realpathSync(ancestor);
  if (!isInside(base, actual) || relative(ancestor, actual) !== '') throw new Error('Symlink/junction aliases are not supported');
  if (write) { const decision = decideFileWrite(target, [base]); if (decision.outcome !== 'allow') throw new Error(decision.reason); }
  return target;
}

export function registerWorkspaceTools(reg: ToolRegistry, project: () => ProjectContext): void {
  reg.register({ name: 'workspace_read_file', title: 'Read a project file', description: 'Read UTF-8 text and its sha256. Paths are relative to the project. Use sha256 as expectedSha256 when updating.', capability: 'app.workspace', permission: 'read', builtinClass: 'read_files',
    input: { path: z.string(), startLine: z.number().int().min(1).optional(), lines: z.number().int().min(1).max(2000).optional() },
    handler: async ({ args, caller }) => { const path = workspacePath(caller.projectRoot ?? project().root, args.path); const file = lstatSync(path); if (!file.isFile() || file.size > 2_000_000) return errorOutput('Expected a regular text file no larger than 2 MB'); const data = readFileSync(path); const text = new TextDecoder('utf-8', { fatal: true }).decode(data); if (text.includes('\0')) return errorOutput('Expected a text file');
      const selected = text.split('\n').slice((args.startLine ?? 1) - 1, (args.startLine ?? 1) - 1 + (args.lines ?? 500)).join('\n');
      return jsonOutput({ sha256: sha(data), text: selected.slice(0, 200_000), truncated: selected.length > 200_000 }); } });
  reg.register({ name: 'workspace_search', title: 'Search project text', description: 'Find literal text in project files. Returns bounded file and line matches; skips dependencies, git internals, hidden state and symlinks.', capability: 'app.workspace', permission: 'read', builtinClass: 'read_files',
    input: { text: z.string().max(500), directory: z.string().optional() },
    handler: async ({ args, caller }) => { const root = caller.projectRoot ?? project().root, matches: Array<{ file: string; line: number; text: string }> = []; let visited = 0;
      const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (++visited > 5000 || matches.length >= 100) return; if (e.isSymbolicLink() || privateSegment(e.name) || e.name === 'out') continue; const path = join(dir, e.name); if (e.isDirectory()) walk(path); else if (e.isFile() && lstatSync(path).size < 250_000) { const text = readFileSync(path, 'utf8'); if (text.includes('\0')) continue; text.split('\n').forEach((line, i) => { if (matches.length < 100 && line.includes(args.text)) matches.push({ file: relative(root, path), line: i + 1, text: line.slice(0, 500) }); }); } } };
      walk(workspacePath(root, args.directory ?? '.')); return jsonOutput({ matches, truncated: visited > 5000 || matches.length >= 100 }); } });
  reg.register({ name: 'workspace_write_file', title: 'Update a project file', description: 'Write UTF-8 content atomically. expectedSha256 is required: use the hash from workspace_read_file, or "absent" to create a new file. A mismatch refuses the write.', capability: 'app.workspace', permission: 'write_project', builtinClass: 'edit_files',
    input: { path: z.string(), content: z.string().max(1_000_000), expectedSha256: z.string().regex(/^(absent|[a-f0-9]{64})$/) },
    handler: async ({ args, caller, signal }) => {
      const root = caller.projectRoot ?? project().root, path = workspacePath(root, args.path, true), release = reserveMutation(root, caller.runId ?? 'workspace', [path], true);
      let temp: string | null = null;
      try {
        if (signal.aborted || caller.runSignal?.aborted) return errorOutput('Run stopped');
        if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).size > 2_000_000)) return errorOutput('Expected a regular text file no larger than 2 MB');
        const current = () => existsSync(path) ? sha(readFileSync(path)) : 'absent';
        if (current() !== args.expectedSha256) return errorOutput('File changed since it was read; read it again before editing');
        caller.fileChange?.('started', [path]); mkdirSync(dirname(path), { recursive: true });
        temp = path + '.' + randomUUID() + '.tmp'; writeFileSync(temp, args.content, { flag: 'wx' });
        if (workspacePath(root, args.path, true) !== path || current() !== args.expectedSha256) throw new Error('File changed while preparing the write');
        renameSync(temp, path); temp = null; caller.fileChange?.('completed', [path]);
        return { ...jsonOutput({ path: args.path, sha256: sha(args.content) }), filesChanged: [path] };
      } catch (e) { caller.fileChange?.('failed', [path]); throw e; }
      finally { if (temp) rmSync(temp, { force: true }); release(); }
    } });
  reg.register({ name: 'workspace_exec', title: 'Run a sandboxed project command', description: 'Run a PowerShell command in the Codex OS sandbox with project-only writes and no network. No background/detached jobs. Conflicting mutations are refused. Commands time out after at most 120 seconds.', capability: 'app.workspace', permission: 'write_project', builtinClass: 'shell',
    input: { command: z.string().min(1).max(20_000), timeoutMs: z.number().int().min(100).max(120_000).optional() },
    handler: async ({ args, caller, signal }) => {
      if (process.platform !== 'win32') return errorOutput('Controlled shell is currently qualified on Windows only');
      if (/\b(Start-Process|Start-Job|start-job|cmd\s+\/c\s+start)\b/i.test(args.command)) return errorOutput('Detached/background commands are not allowed');
      const root = caller.projectRoot ?? project().root, release = reserveMutation(root, caller.runId ?? 'workspace', ['*'], true);
      try {
        if (!caller.executeCommand) return errorOutput('Controlled command executor unavailable');
        const combined = caller.runSignal ? AbortSignal.any([signal, caller.runSignal]) : signal;
        const result = await caller.executeCommand(args.command, root, combined, args.timeoutMs ?? 120_000);
        return { ...jsonOutput(result), isError: !result.ok };
      } finally { release(); }
    } });
}
