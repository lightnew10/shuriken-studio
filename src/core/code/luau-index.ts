import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { planSync } from '../roblox/code-sync';
import type { SyncMap } from '../roblox/luau-toolchain';

export type RunContext = 'server' | 'client' | 'shared';

export interface LuauSymbol {
  name: string;
  kind: 'function' | 'method' | 'type' | 'constant';
  line: number;
  exported: boolean;
}

export interface RemoteUse {
  name: string;
  kind: 'RemoteEvent' | 'RemoteFunction' | 'UnreliableRemoteEvent' | 'BindableEvent' | 'unknown';
  role: 'defines' | 'fires_server' | 'fires_client' | 'handles_server' | 'handles_client' | 'invokes_server' | 'handles_invoke' | 'references';
  line: number;
}

export interface LuauFileIndex {
  file: string;
  instancePath: string;
  className: 'Script' | 'LocalScript' | 'ModuleScript';
  context: RunContext;
  lines: number;
  requires: Array<{ expr: string; target: string | null; line: number }>;
  symbols: LuauSymbol[];
  services: string[];
  remotes: RemoteUse[];
  dataStores: string[];
  attributes: string[];
  tags: string[];
  strict: boolean;
}

export interface LuauIndex {
  root: string;
  builtAt: string;
  files: LuauFileIndex[];
}

/**
 * Lightweight static index of a Roblox project's Luau code. Heuristic (regex-based) but fast and
 * dependency-free: answers "where is X used", "what depends on this module", "which remotes exist
 * and who fires/handles them", and "what runs on the client vs the server" without re-grepping.
 */
export class LuauIndexer {
  private cache: { key: string; index: LuauIndex } | null = null;

  build(root: string, map: SyncMap): LuauIndex {
    const entries = planSync(root, map);
    const key = entries.map((e) => `${e.file}:${e.hash}`).join('|');
    if (this.cache?.key === key && this.cache.index.root === root) return this.cache.index;
    const byInstance = new Map(entries.map((e) => [e.instancePath, e.file]));
    const files = entries.map((e) => indexFile(e.file, e.instancePath, e.className, e.source, byInstance));
    const index: LuauIndex = { root, builtAt: new Date().toISOString(), files };
    this.cache = { key, index };
    return index;
  }

  summary(index: LuauIndex) {
    const remotes = new Map<string, { kind: string; definedIn: string[]; firedBy: string[]; handledBy: string[] }>();
    for (const f of index.files) {
      for (const r of f.remotes) {
        const e = remotes.get(r.name) ?? { kind: r.kind, definedIn: [], firedBy: [], handledBy: [] };
        if (r.kind !== 'unknown') e.kind = r.kind;
        if (r.role === 'defines') e.definedIn.push(f.file);
        else if (r.role.startsWith('fires') || r.role === 'invokes_server') e.firedBy.push(`${f.file} (${f.context})`);
        else if (r.role.startsWith('handles')) e.handledBy.push(`${f.file} (${f.context})`);
        remotes.set(r.name, e);
      }
    }
    return {
      files: index.files.length,
      byContext: { server: index.files.filter((f) => f.context === 'server').length, client: index.files.filter((f) => f.context === 'client').length, shared: index.files.filter((f) => f.context === 'shared').length },
      nonStrict: index.files.filter((f) => !f.strict).map((f) => f.file),
      remotes: Object.fromEntries(remotes),
      dataStores: [...new Set(index.files.flatMap((f) => f.dataStores))],
      tags: [...new Set(index.files.flatMap((f) => f.tags))],
      attributes: [...new Set(index.files.flatMap((f) => f.attributes))],
    };
  }

  dependents(index: LuauIndex, file: string, transitive = true): string[] {
    const direct = new Map<string, Set<string>>();
    for (const f of index.files) for (const r of f.requires) if (r.target) (direct.get(r.target) ?? direct.set(r.target, new Set()).get(r.target)!).add(f.file);
    const out = new Set<string>();
    const walk = (t: string) => {
      for (const d of direct.get(t) ?? []) {
        if (out.has(d)) continue;
        out.add(d);
        if (transitive) walk(d);
      }
    };
    walk(file);
    return [...out];
  }

  references(root: string, index: LuauIndex, name: string, limit = 200): Array<{ file: string; line: number; text: string }> {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const out: Array<{ file: string; line: number; text: string }> = [];
    for (const f of index.files) {
      const lines = readFileSync(join(root, f.file), 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        if (out.length < limit && re.test(l) && !/^\s*--/.test(l)) out.push({ file: f.file, line: i + 1, text: l.trim().slice(0, 200) });
      });
    }
    return out;
  }

  findSymbol(index: LuauIndex, name: string): Array<{ file: string; symbol: LuauSymbol }> {
    return index.files.flatMap((f) => f.symbols.filter((s) => s.name === name || s.name.endsWith(`.${name}`) || s.name.endsWith(`:${name}`)).map((symbol) => ({ file: f.file, symbol })));
  }
}

function contextOf(instancePath: string, className: string): RunContext {
  if (className === 'LocalScript' || /StarterPlayerScripts|StarterCharacterScripts|StarterGui|ReplicatedFirst/.test(instancePath)) return 'client';
  if (/^(ServerScriptService|ServerStorage)/.test(instancePath) || className === 'Script') return 'server';
  return 'shared';
}

function indexFile(file: string, instancePath: string, className: LuauFileIndex['className'], source: string, byInstance: Map<string, string>): LuauFileIndex {
  const lines = source.split('\n');
  const idx: LuauFileIndex = {
    file,
    instancePath,
    className,
    context: contextOf(instancePath, className),
    lines: lines.length,
    requires: [],
    symbols: [],
    services: [],
    remotes: [],
    dataStores: [],
    attributes: [],
    tags: [],
    strict: /^\s*--!strict/m.test(source.slice(0, 400)),
  };
  const services = new Set<string>();
  const serviceVars = new Map<string, string>();
  lines.forEach((raw, i) => {
    const line = raw.replace(/--.*$/, '');
    const n = i + 1;
    for (const m of line.matchAll(/(?:local\s+(\w+)\s*=\s*)?game:GetService\(\s*["'](\w+)["']\s*\)/g)) {
      services.add(m[2]!);
      if (m[1]) serviceVars.set(m[1], m[2]!);
    }
    // Instance aliases (`local Shared = ReplicatedStorage:WaitForChild("Shared")`), so requires through
    // them resolve too.
    const alias = /^local\s+(\w+)\s*(?::\s*[\w.]+\s*)?=\s*(.*?);?$/.exec(line.trim());
    if (alias && !alias[2]!.includes('require(') && !serviceVars.has(alias[1]!)) {
      const path = instancePathOf(alias[2]!, instancePath, serviceVars);
      if (path && path.includes('/')) serviceVars.set(alias[1]!, path);
    }
    for (const expr of requireArgs(line)) {
      idx.requires.push({ expr, target: resolveRequire(expr, instancePath, serviceVars, byInstance), line: n });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\s*local\s+function\s+(\w+)/.exec(line))) idx.symbols.push({ name: m[1]!, kind: 'function', line: n, exported: false });
    else if ((m = /^\s*function\s+([\w.]+)([.:])(\w+)\s*\(/.exec(line))) idx.symbols.push({ name: `${m[1]}${m[2]}${m[3]}`, kind: m[2] === ':' ? 'method' : 'function', line: n, exported: true });
    else if ((m = /^\s*function\s+(\w+)\s*\(/.exec(line))) idx.symbols.push({ name: m[1]!, kind: 'function', line: n, exported: false });
    else if ((m = /^\s*(\w+)\.(\w+)\s*=\s*function\s*\(/.exec(line))) idx.symbols.push({ name: `${m[1]}.${m[2]}`, kind: 'function', line: n, exported: true });
    if ((m = /^\s*(export\s+)?type\s+(\w+)/.exec(line))) idx.symbols.push({ name: m[2]!, kind: 'type', line: n, exported: !!m[1] });
    if ((m = /^\s*local\s+([A-Z][A-Z0-9_]{2,})\s*=/.exec(line))) idx.symbols.push({ name: m[1]!, kind: 'constant', line: n, exported: false });

    for (const r of line.matchAll(/Instance\.new\(\s*["'](RemoteEvent|RemoteFunction|UnreliableRemoteEvent|BindableEvent)["']/g)) {
      const name = /\.Name\s*=\s*["'](\w+)["']/.exec(lines.slice(i, i + 4).join('\n'))?.[1] ?? `(unnamed ${r[1]})`;
      idx.remotes.push({ name, kind: r[1] as RemoteUse['kind'], role: 'defines', line: n });
    }
    const remoteRoles: Array<[RegExp, RemoteUse['role']]> = [
      [/(\w+)\s*:\s*FireServer\s*\(/g, 'fires_server'],
      [/(\w+)\s*:\s*FireClient\s*\(|(\w+)\s*:\s*FireAllClients\s*\(/g, 'fires_client'],
      [/(\w+)\.OnServerEvent\s*:\s*Connect/g, 'handles_server'],
      [/(\w+)\.OnClientEvent\s*:\s*Connect/g, 'handles_client'],
      [/(\w+)\s*:\s*InvokeServer\s*\(/g, 'invokes_server'],
      [/(\w+)\.OnServerInvoke\s*=/g, 'handles_invoke'],
    ];
    for (const [re, role] of remoteRoles) for (const r of line.matchAll(re)) idx.remotes.push({ name: r[1] ?? r[2] ?? '?', kind: 'unknown', role, line: n });
    for (const d of line.matchAll(/Get(?:Ordered)?DataStore\(\s*["']([^"']+)["']/g)) idx.dataStores.push(d[1]!);
    for (const a of line.matchAll(/[:.](?:Set|Get)Attribute\(\s*["']([^"']+)["']/g)) idx.attributes.push(a[1]!);
    for (const t of line.matchAll(/(?:GetTagged|AddTag|HasTag|RemoveTag|GetInstanceAddedSignal|GetInstanceRemovedSignal)\(\s*(?:[\w.]+\s*,\s*)?["']([^"']+)["']/g)) idx.tags.push(t[1]!);
  });
  idx.services = [...services].sort();
  idx.dataStores = [...new Set(idx.dataStores)];
  idx.attributes = [...new Set(idx.attributes)];
  idx.tags = [...new Set(idx.tags)];
  // Resolve variable names of remotes defined via WaitForChild("Name") to the remote's instance name.
  return idx;
}

/** Arguments of every require(...) call on a line, with balanced parentheses (WaitForChild chains). */
function requireArgs(line: string): string[] {
  const out: string[] = [];
  let i = line.indexOf('require(');
  while (i >= 0) {
    let depth = 0;
    let j = i + 'require'.length;
    for (; j < line.length; j++) {
      if (line[j] === '(') depth++;
      else if (line[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && j < line.length) out.push(line.slice(i + 'require('.length, j).trim());
    i = line.indexOf('require(', j);
  }
  return out;
}

/** Resolve common require forms to a file: script.Parent.X, Service.Folder.X, WaitForChild chains, aliases. */
function resolveRequire(expr: string, self: string, vars: Map<string, string>, byInstance: Map<string, string>): string | null {
  const path = instancePathOf(expr, self, vars);
  return path ? (byInstance.get(path) ?? null) : null;
}

/** The instance path an expression names ("ReplicatedStorage/Shared/X"), or null when it isn't a plain path. */
function instancePathOf(expr: string, self: string, vars: Map<string, string>): string | null {
  let e = expr.replace(/\s+/g, '');
  e = e.replace(/:WaitForChild\(["'](\w+)["'](?:,[\d.]+)?\)/g, '.$1').replace(/:FindFirstChild\(["'](\w+)["']\)/g, '.$1');
  e = e.replace(/game:GetService\(["'](\w+)["']\)/g, '$1');
  if (!/^[\w.]+$/.test(e)) return null;
  const parts = e.split('.');
  const head = (): string | undefined => parts[0];
  let base: string[];
  if (head() === 'script') {
    base = self.split('/');
    parts.shift();
    while (head() === 'Parent') {
      base.pop();
      parts.shift();
    }
  } else if (parts[0] && vars.has(parts[0])) {
    base = vars.get(parts.shift()!)!.split('/');
  } else if (parts[0] === 'game') {
    parts.shift();
    base = [];
  } else {
    base = [];
  }
  return [...base, ...parts].filter(Boolean).join('/');
}

export function fileMtime(root: string, file: string): number {
  try {
    return statSync(join(root, file)).mtimeMs;
  } catch {
    return 0;
  }
}
