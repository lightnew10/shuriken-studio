import { luauFnv } from '../../src/core/roblox/luau-toolchain';
import type { PlaceScript } from '../../src/core/roblox/code-sync';
import type { RobloxStudioAdapter } from '../../src/core/roblox/studio-adapter';

/**
 * A stand-in for Studio that runs the sync's Luau programs the way Studio does (the programs'
 * semantics mirrored in JS: put with drift checks, the sync mark, script listing and source reads).
 * The Luau itself is checked by the parse test in unit.test.ts and live in a scratch place.
 */
export class FakeStudio {
  connected = true;
  binding: string | null = 'Fake place';
  /** What the place survey returns. */
  survey: unknown = { place: { placeId: 0, gameId: 0, name: 'Fake place' }, services: {}, remotes: [], ui: [], map: [], spawns: [], lighting: { clock: 14, brightness: 2, effects: [] }, sounds: { count: 0, sample: [] }, animations: [], tools: [], teams: [], tags: [], player: {} };
  scripts = new Map<string, { className: 'Script' | 'LocalScript' | 'ModuleScript'; source: string }>();
  /** Instances that aren't scripts (for name clashes). */
  others = new Set<string>();
  marker: string | null = null;
  calls = 0;
  /** Studio since 2026-10-01: a script made in Luau can't be parented anywhere; its own script tool still makes them. */
  refusesNewScripts = false;
  /** Scripts made through Studio's script tool (multi_edit), by DataModel path. */
  madeByTool: string[] = [];
  /** The plugin's link drops under the next Luau calls (Studio froze): this many answer that Studio stopped answering. */
  linkDrops = 0;
  /** Whether the link comes back when it is waited for. */
  linkReturns = true;
  linkWaits = 0;

  async linkBack(): Promise<boolean> {
    this.linkWaits++;
    return this.linkReturns;
  }

  private refusal(path: string): string {
    const segs = path.split('/');
    const parent = segs.slice(0, -1).join('.');
    return `The current thread cannot reparent '${segs.at(-1)}' to '${parent}' since '${parent}' has additional values for the Capabilities property: LoadUnownedAsset (and 3 more)`;
  }

  /** Studio's own tools: multi_edit creates a script that isn't there (dot path, a class, its first content). */
  async call(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: unknown[]; error?: string; durationMs: number }> {
    this.calls++;
    if (tool !== 'multi_edit') return { ok: false, content: [], error: `FakeStudio: unexpected tool ${tool}`, durationMs: 1 };
    const path = String(args.file_path).replace(/^game\./, '').split('.').join('/');
    if (this.scripts.has(path)) return { ok: false, content: [], error: 'old_string not found', durationMs: 1 };
    const edits = args.edits as Array<{ old_string: string; new_string: string }>;
    this.scripts.set(path, { className: args.className as 'Script', source: edits[0]!.new_string });
    this.madeByTool.push(path);
    return { ok: true, content: [{ type: 'text', text: 'Created' }], durationMs: 1 };
  }

  asAdapter(): RobloxStudioAdapter {
    return this as unknown as RobloxStudioAdapter;
  }

  async luauJson<T>(code: string): Promise<T> {
    const r = await this.runLuau(code);
    if (!r.ok) throw new Error(r.output);
    return JSON.parse(r.output) as T;
  }

  async runLuau(code: string): Promise<{ ok: boolean; output: string; durationMs: number }> {
    this.calls++;
    if (this.linkDrops > 0 && code.includes('local function put(')) {
      this.linkDrops--;
      return { ok: false, output: 'Studio stopped answering through Shuriken Link.', durationMs: 1 };
    }
    const out = (v: unknown) => ({ ok: true, output: typeof v === 'string' ? v : JSON.stringify(v), durationMs: 1 });
    const setMark = /SetAttribute\("ShurikenSync", ("[^"]*")\)/.exec(code);
    if (code.includes('local function put(')) {
      const c = /local continuous = (.+)\n/.exec(code)![1]!;
      const m = /GetAttribute\("ShurikenSync"\) == (nil|"[^"]*") and (true|false)/.exec(c);
      const continuous = m ? m[2] === 'true' && (m[1] === 'nil' ? null : JSON.parse(m[1]!)) === this.marker : c.trim() === 'true';
      const report = { created: [] as string[], updated: [] as string[], unchanged: [] as string[], classChanged: [] as string[], errors: [] as unknown[], drifted: [] as unknown[], gone: [] as string[], continuous };
      const re = /\nput\(("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*"), \[(=*)\[\n([\s\S]*?)\]\3\], ("(?:[^"\\]|\\.)*"), (nil|"(?:[^"\\]|\\.)*"), \{([^}]*)\}(?:, (true|false))?\)/g;
      for (const x of code.matchAll(re)) {
        const path = JSON.parse(x[1]!) as string;
        const className = JSON.parse(x[2]!) as 'Script';
        const source = x[4]!;
        const expected = JSON.parse(x[5]!) as string;
        const base = x[6] === 'nil' ? null : (JSON.parse(x[6]!) as string);
        const older = x[7]!.trim() ? x[7]!.split(',').map((h) => JSON.parse(h.trim()) as string) : [];
        const stale = x[8] === 'true';
        if (base) {
          const now = this.scripts.get(path);
          if (!now) {
            if (continuous && !stale) {
              report.gone.push(path);
              continue;
            }
          } else {
            const h = luauFnv(now.source.replace(/\r\n/g, '\n'));
            if (h !== base && h !== expected && !((stale || !continuous) && older.includes(h))) {
              report.drifted.push({ path, length: now.source.length });
              continue;
            }
          }
        }
        let existing = this.scripts.get(path);
        if (this.refusesNewScripts && (!existing || existing.className !== className)) {
          report.errors.push({ path, error: this.refusal(path) });
          continue;
        }
        if (existing && existing.className !== className) {
          existing = { className, source: existing.source };
          this.scripts.set(path, existing);
          report.classChanged.push(path);
        }
        if (!existing) {
          this.scripts.set(path, { className, source });
          report.created.push(path);
        } else if (luauFnv(existing.source) === expected) {
          report.unchanged.push(path);
          continue;
        } else {
          existing.source = source;
          report.updated.push(path);
        }
      }
      if (setMark) this.marker = JSON.parse(setMark[1]!) as string;
      return out(report);
    }
    if (setMark) {
      this.marker = JSON.parse(setMark[1]!) as string;
      return out('ok');
    }
    if (code.includes('out[it.path] = "occupied"')) {
      const items = JSON.parse(JSON.parse(/JSONDecode\(("(?:[^"\\]|\\.)*")\)/.exec(code)![1]!) as string) as Array<{ path: string; className: string }>;
      const state: Record<string, string> = {};
      for (const it of items) {
        const now = this.scripts.get(it.path);
        if (!now) state[it.path] = 'missing';
        else if (now.className === it.className) state[it.path] = 'there';
        else if (![...this.scripts.keys()].some((p) => p.startsWith(`${it.path}/`))) {
          this.scripts.delete(it.path);
          state[it.path] = 'missing';
        } else state[it.path] = 'occupied';
      }
      return out(state);
    }
    if (code.trim() === 'return tostring(game.PlaceId)') return out('0');
    if (code.includes('local out = { place = { placeId = game.PlaceId')) return out(this.survey);
    const decoded = /JSONDecode\(("(?:[^"\\]|\\.)*")\) do/.exec(code);
    const arg = decoded ? (JSON.parse(JSON.parse(decoded[1]!) as string) as unknown) : null;
    if (code.includes('local function walk(node, path, ambiguous)')) return out(this.list(arg as string[]));
    if (code.includes('local s = string.gsub(current(inst)')) {
      const reqs = arg as Array<{ path: string; part?: number; size?: number }>;
      return out(reqs.filter((r) => this.scripts.has(r.path)).map((r) => ({ path: r.path, text: this.scripts.get(r.path)!.source.replace(/\r\n/g, '\n') })));
    }
    if (code.includes('inst:Destroy() table.insert(deleted, p)')) {
      const paths = JSON.parse(JSON.parse(/JSONDecode\(("(?:[^"\\]|\\.)*")\)/.exec(code)![1]!) as string) as string[];
      const deleted = paths.filter((p) => this.scripts.delete(p));
      return out(deleted);
    }
    throw new Error(`FakeStudio: unexpected program\n${code.slice(0, 300)}`);
  }

  private list(roots: string[]): PlaceScript[] {
    const all = [...this.scripts.keys(), ...this.others];
    const out: PlaceScript[] = [];
    for (const [path, s] of this.scripts) {
      if (!roots.some((r) => path.startsWith(`${r}/`))) continue;
      const segs = path.split('/');
      let ambiguous = false;
      for (let i = 1; i < segs.length; i++) {
        const parent = segs.slice(0, i).join('/');
        const name = segs[i]!.toLowerCase();
        const siblings = new Set(all.filter((p) => p.split('/').length > i && p.split('/').slice(0, i).join('/') === parent && p.split('/')[i]!.toLowerCase() === name).map((p) => p.split('/').slice(0, i + 1).join('/')));
        if (siblings.size > 1 || all.filter((p) => p.toLowerCase() === `${parent}/${segs[i]}`.toLowerCase()).length > 1) ambiguous = true;
      }
      const children = [...this.scripts.keys()].some((p) => p.startsWith(`${path}/`));
      out.push({ path, className: s.className, length: s.source.length, hash: luauFnv(s.source.replace(/\r\n/g, '\n')), ...(children ? { children } : {}), ...(ambiguous ? { ambiguous } : {}) });
    }
    return out;
  }
}

