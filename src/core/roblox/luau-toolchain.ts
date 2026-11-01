import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { HealthCheckResult } from '@shared/domain';
import { errorMessage } from '../log';

/** Disk directory → DataModel path, e.g. { "src/Server": "ServerScriptService/Server" }. */
export type SyncMap = Record<string, string>;

export const DEFAULT_SYNC_MAP: SyncMap = {
  'src/Server': 'ServerScriptService/Server',
  'src/Shared': 'ReplicatedStorage/Shared',
  'src/Client': 'StarterPlayer/StarterPlayerScripts/Client',
};

export interface LuauProblem {
  /** 'compile': what Studio's compiler refuses and the analyzers miss (verification/compile-limits.ts). */
  tool: 'selene' | 'luau-lsp' | 'compile';
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface LuauCheckResult {
  ok: boolean;
  problems: LuauProblem[];
  toolErrors: string[];
  durationMs: number;
}

const TYPES_URL = 'https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/scripts/globalTypes.None.d.luau';
const SERVICES = new Set(['Workspace', 'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'StarterPlayerScripts', 'StarterCharacterScripts', 'Lighting', 'SoundService', 'Teams', 'TextChatService']);

/** Adds `node` under `parent`, merging into a same-named child (maps may nest: ReplicatedStorage and ReplicatedStorage/X). */
function mergeInto(parent: SourcemapNode, node: SourcemapNode): void {
  const kids = (parent.children ??= []);
  const same = kids.find((c) => c.name === node.name);
  if (!same) {
    kids.push(node);
    return;
  }
  if (node.filePaths && !same.filePaths) {
    same.filePaths = node.filePaths;
    same.className = node.className;
  }
  for (const c of node.children ?? []) mergeInto(same, c);
}
const SCRIPT_SUFFIX = /\.(server|client|legacy|plugin|local)\.luau$/;
const INIT = /^init(\.(server|client|legacy|plugin|local))?\.luau$/;

const posix = (p: string) => p.replaceAll('\\', '/');

/** Script Sync / Rojo naming: X.server.luau → Script, X.local.luau / X.client.luau → LocalScript, X.luau → ModuleScript. */
export function classOfFile(file: string): 'Script' | 'LocalScript' | 'ModuleScript' | null {
  const m = file.match(SCRIPT_SUFFIX);
  if (m) return m[1] === 'local' || m[1] === 'client' ? 'LocalScript' : 'Script';
  return file.endsWith('.luau') ? 'ModuleScript' : null;
}

interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

/**
 * Luau static analysis: selene (lint) + luau-lsp (types against the Roblox API), using a
 * Rojo-style sourcemap generated from the project's sync map so requires resolve.
 */
export class LuauToolchain {
  constructor(private readonly typesDir: string) {}

  private exe(tool: 'selene' | 'luau-lsp'): string {
    const local = join(homedir(), '.local', 'bin', `${tool}${process.platform === 'win32' ? '.exe' : ''}`);
    return existsSync(local) ? local : tool;
  }

  async versions(): Promise<{ selene: string | null; luauLsp: string | null }> {
    const v = async (tool: 'selene' | 'luau-lsp') => {
      const r = await run(this.exe(tool), ['--version'], process.cwd(), 15000);
      return r.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? r.stdout.trim()) : null;
    };
    return { selene: await v('selene'), luauLsp: await v('luau-lsp') };
  }

  async healthChecks(): Promise<HealthCheckResult[]> {
    const t0 = Date.now();
    const v = await this.versions();
    const types = await this.ensureTypes();
    return [
      { id: 'luau.selene', name: 'selene', status: v.selene ? 'healthy' : 'unavailable', message: v.selene ? `selene ${v.selene}` : 'selene not found (install via rokit/aftman or ~/.local/bin)', durationMs: Date.now() - t0 },
      { id: 'luau.lsp', name: 'luau-lsp', status: v.luauLsp ? 'healthy' : 'unavailable', message: v.luauLsp ? `luau-lsp ${v.luauLsp}` : 'luau-lsp not found', durationMs: 0 },
      { id: 'luau.types', name: 'Roblox type definitions', status: types ? 'healthy' : 'degraded', message: types ? this.typesFile() : 'Could not download Roblox type definitions (network?) — luau-lsp type checks will be skipped', durationMs: 0 },
    ];
  }

  typesFile(): string {
    return join(this.typesDir, 'globalTypes.d.luau');
  }

  async ensureTypes(): Promise<boolean> {
    if (existsSync(this.typesFile())) return true;
    try {
      const res = await fetch(TYPES_URL);
      if (!res.ok) return false;
      mkdirSync(this.typesDir, { recursive: true });
      writeFileSync(this.typesFile(), await res.text());
      return true;
    } catch {
      return false;
    }
  }

  writeSourcemap(root: string, syncMap: SyncMap): string {
    const game: SourcemapNode = { name: 'Game', className: 'DataModel', children: [] };
    for (const [diskPath, instancePath] of Object.entries(syncMap)) {
      const dir = join(root, diskPath);
      if (!existsSync(dir)) continue;
      const parts = instancePath.split('/');
      let parent = game;
      for (const part of parts.slice(0, -1)) {
        let child = parent.children!.find((c) => c.name === part);
        if (!child) {
          child = { name: part, className: SERVICES.has(part) ? part : 'Folder', children: [] };
          parent.children!.push(child);
        }
        parent = child;
      }
      const node = dirNode(root, dir, parts.at(-1)!);
      // A map entry that IS a service (a plugged-in game's src/ReplicatedStorage → ReplicatedStorage).
      if (parts.length === 1 && SERVICES.has(node.name) && node.className === 'Folder') node.className = node.name;
      mergeInto(parent, node);
    }
    const out = join(root, 'sourcemap.json');
    writeFileSync(out, JSON.stringify(game));
    return out;
  }

  /**
   * Syntax errors in a Luau snippet (selene's parser, well under a second), for code Studio refused
   * with nothing more than "Failed to parse command code". Empty when it parses or selene is missing.
   */
  async parseErrors(code: string): Promise<Array<{ line: number; column: number; message: string }>> {
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'shuriken-parse-'));
      writeFileSync(join(dir, 'selene.toml'), 'std = "roblox"\n');
      writeFileSync(join(dir, 'snippet.luau'), code);
      const r = await run(this.exe('selene'), ['--display-style=Quiet', '--no-summary', 'snippet.luau'], dir, 20000);
      const seen = new Set<string>();
      const out: Array<{ line: number; column: number; message: string }> = [];
      for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) {
        const m = /^snippet\.luau:(\d+):(\d+): error\[parse_error\]: (.*)$/.exec(line);
        if (m && !seen.has(line)) {
          seen.add(line);
          out.push({ line: +m[1]!, column: +m[2]!, message: m[3]! });
        }
      }
      return out;
    } catch {
      return [];
    } finally {
      // selene may still hold the folder right after a timeout kill (EBUSY on Windows): not our problem.
      try {
        if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* ignore */
      }
    }
  }

  async check(root: string, syncMap: SyncMap, opts: { paths?: string[] } = {}): Promise<LuauCheckResult> {
    const t0 = Date.now();
    const problems: LuauProblem[] = [];
    const toolErrors: string[] = [];
    const targets = opts.paths?.length ? opts.paths : Object.keys(syncMap).filter((p) => existsSync(join(root, p)));
    if (targets.length === 0) return { ok: true, problems, toolErrors: ['No Luau source directories found'], durationMs: 0 };
    this.writeSourcemap(root, syncMap);

    // selene
    const sel = await run(this.exe('selene'), ['--display-style=Quiet', '--no-summary', ...targets], root, 120000);
    if (sel.error) toolErrors.push(`selene: ${sel.error}`);
    for (const line of `${sel.stdout}\n${sel.stderr}`.split(/\r?\n/)) {
      const m = /^(.+?):(\d+):(\d+): (\w+)\[(\w+)\]: (.*)$/.exec(line);
      if (m) {
        problems.push({ tool: 'selene', file: posix(relative(root, resolve(root, m[1]!))), line: +m[2]!, column: +m[3]!, severity: m[4] === 'error' ? 'error' : 'warning', code: m[5]!, message: m[6]! });
      }
    }

    // luau-lsp
    if (await this.ensureTypes()) {
      const args = ['analyze', '--platform=roblox', '--sourcemap=sourcemap.json', `--definitions=@roblox=${this.typesFile()}`, '--ignore=**/Packages/**', ...targets];
      const lsp = await run(this.exe('luau-lsp'), args, root, 180000);
      if (lsp.error) toolErrors.push(`luau-lsp: ${lsp.error}`);
      for (const line of `${lsp.stdout}\n${lsp.stderr}`.split(/\r?\n/)) {
        const m = /^(.+?)(?: \[[^\]]*\])?\((\d+),(\d+)\): (\w+): (.*)$/.exec(line);
        if (m) {
          problems.push({ tool: 'luau-lsp', file: posix(relative(root, resolve(root, m[1]!))), line: +m[2]!, column: +m[3]!, severity: /warn/i.test(m[4]!) ? 'warning' : 'error', code: m[4]!, message: m[5]! });
        }
      }
    } else {
      toolErrors.push('luau-lsp skipped: Roblox type definitions missing and could not be downloaded');
    }
    return { ok: problems.length === 0 && toolErrors.length === 0, problems, toolErrors, durationMs: Date.now() - t0 };
  }
}

function dirNode(root: string, dir: string, name: string): SourcemapNode {
  const entries = readdirSync(dir, { withFileTypes: true });
  const init = entries.find((e) => e.isFile() && INIT.test(e.name));
  const node: SourcemapNode = { name, className: init ? classOfFile(init.name)! : 'Folder', children: [] };
  if (init) node.filePaths = [posix(relative(root, join(dir, init.name)))];
  for (const e of entries) {
    if (e.isDirectory()) node.children!.push(dirNode(root, join(dir, e.name), e.name));
    else if (!INIT.test(e.name) && classOfFile(e.name)) {
      node.children!.push({
        name: e.name.replace(SCRIPT_SUFFIX, '').replace(/\.luau$/, ''),
        className: classOfFile(e.name)!,
        filePaths: [posix(relative(root, join(dir, e.name)))],
      });
    }
  }
  return node;
}

export function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    const finish = (code: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, error });
    };
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => finish(null, errorMessage(e)));
    child.on('close', (code) => finish(code, null));
  });
}

/** FNV-1a variant identical to the Luau implementation in luau-snippets.ts (double arithmetic). */
export function luauFnv(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let h = 2166136261;
  for (const b of bytes) {
    h = (h ^ b) >>> 0;
    h = (h * 16777619) % 4294967296;
  }
  return h.toString(16).padStart(8, '0');
}

export function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

export { dirname };
