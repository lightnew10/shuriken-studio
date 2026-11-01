import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { RobloxStudioAdapter, SNAPSHOT_PAGE_CHARS } from '../src/core/roblox/studio-adapter';
import { diffSnapshots } from '../src/core/roblox/snapshot-diff';
import { LUAU_SNAPSHOT } from '../src/core/roblox/luau-snippets';

/** A node of the pretend place. */
interface Inst {
  name: string;
  cls: string;
  sig: Record<string, unknown>;
  children: Inst[];
}

const part = (name: string, i: number): Inst => ({
  name,
  cls: 'Part',
  sig: { c: 'Part', p: [i, i % 7, i * 2], s: [4, 1, 2], o: [0, 0, 0], a: true, cc: true, t: 0, col: 'a3a2a5', m: 'Enum.Material.Plastic', sh: 'Enum.PartType.Block' },
  children: [],
});
const folder = (name: string, children: Inst[] = []): Inst => ({ name, cls: 'Folder', sig: { c: 'Folder' }, children });

/** A place the size of a real game: `folders` folders with `perFolder` parts each, under Workspace. */
function bigPlace(folders: number, perFolder: number): Inst[] {
  const map = folder('Map');
  for (let f = 0; f < folders; f++) map.children.push(folder(`Area_${f}`, Array.from({ length: perFolder }, (_, i) => part(`Wall_${f}_${i}`, f * perFolder + i))));
  return [
    { name: 'Workspace', cls: 'Workspace', sig: { c: 'Workspace' }, children: [map] },
    { name: 'ServerScriptService', cls: 'ServerScriptService', sig: { c: 'ServerScriptService' }, children: [{ name: 'Main', cls: 'Script', sig: { c: 'Script', h: 'deadbeef', len: 120 }, children: [] }] },
  ];
}

function allKeys(roots: Inst[], rootNames: string[]): string[] {
  const out: string[] = [];
  const walk = (i: Inst, path: string) => {
    out.push(`${path}#${i.cls}`);
    for (const c of i.children) walk(c, `${path}.${c.name}`);
  };
  for (const n of rootNames) {
    const r = roots.find((x) => x.name === n);
    if (r) walk(r, r.name);
  }
  return out;
}

/**
 * Studio as far as a snapshot page can tell: LUAU_SNAPSHOT's walk mirrored in JS (the Luau itself is parsed by
 * the parse test in unit.test.ts and checked live in a scratch place), and Studio's habit of cutting a
 * result that is too long without saying so.
 */
class FakePlace extends RobloxStudioAdapter {
  calls = 0;
  cuts = 0;
  longest = 0;
  /** Called before each call (1-based): lets a test change the place between pages. */
  beforeCall: ((n: number) => void) | null = null;

  constructor(
    public place: Inst[],
    private readonly limit = 100_000,
  ) {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
  }

  override async runLuau(code: string): Promise<{ ok: boolean; output: string; durationMs: number }> {
    this.calls++;
    this.beforeCall?.(this.calls);
    expect(code).not.toMatch(/__(ROOTS|FROM|BUDGET|MAX)__/);
    const roots = JSON.parse(JSON.parse(/JSONDecode\(("(?:[^"\\]|\\.)*")\)/.exec(code)![1]!) as string) as string[];
    const m = /local FROM, BUDGET, MAX = (\d+), (\d+), (\d+)/.exec(code)!;
    const [from, budget, max] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const nodes: Record<string, Record<string, unknown>> = {};
    let size = 0;
    let emitted = 0;
    let total = 0;
    let next = -1;
    let truncated = false;
    const visit = (i: Inst, path: string) => {
      if (truncated) return;
      if (total >= max) {
        truncated = true;
        return;
      }
      total++;
      if (total > from && next < 0) {
        const key = `${path}#${i.cls}`;
        const cost = key.length + JSON.stringify(i.sig).length + 4;
        if (emitted > 0 && size + cost > budget) next = total - 1;
        else {
          nodes[key] = i.sig;
          size += cost;
          emitted++;
        }
      }
      for (const c of i.children) visit(c, `${path}.${c.name}`);
    };
    for (const r of roots) {
      let cur: Inst | undefined;
      let path = '';
      for (const seg of r.split('.')) {
        cur = (cur ? cur.children : this.place).find((x) => x.name === seg);
        path = path ? `${path}.${seg}` : seg;
        if (!cur) break;
      }
      if (cur) visit(cur, path);
    }
    // JSONEncode writes an empty table as [].
    let output = JSON.stringify({ roots, count: total, truncated, from, emitted, next, nodes: emitted ? nodes : [] });
    this.longest = Math.max(this.longest, output.length);
    if (output.length > this.limit) {
      this.cuts++;
      output = output.slice(0, this.limit);
    }
    return { ok: true, output, durationMs: 1 };
  }
}

const ROOTS = ['Workspace', 'ServerScriptService'];

describe('DataModel snapshot pages', () => {
  it('reads a place far over Studio\'s 100,000-character limit, page by page, without losing or doubling a node', async () => {
    const studio = new FakePlace(bigPlace(20, 300));
    const snap = await studio.snapshot(ROOTS, 'Edit', 6000, 60_000);
    const want = allKeys(studio.place, ROOTS);
    expect(want.length).toBeGreaterThan(6000);
    // The cap (6000) cuts the walk; a place that fits is checked in the next test.
    expect(snap.truncated).toBe(true);
    expect(snap.count).toBe(6000);
    expect(Object.keys(snap.nodes)).toEqual(want.slice(0, 6000));
    expect(studio.cuts).toBe(0);
    expect(studio.longest).toBeLessThan(100_000);
    expect(studio.calls).toBeGreaterThan(8);
  });

  it('a place that fits is whole: every node once, with its record', async () => {
    const studio = new FakePlace(bigPlace(20, 300));
    const snap = await studio.snapshot(ROOTS, 'Edit', 20_000, 60_000);
    const want = allKeys(studio.place, ROOTS);
    expect(snap.truncated).toBe(false);
    expect(snap.unstable).toBeUndefined();
    expect(snap.count).toBe(want.length);
    expect(Object.keys(snap.nodes)).toEqual(want);
    expect(snap.nodes['Workspace.Map.Area_7.Wall_7_5#Part']).toMatchObject({ c: 'Part', a: true });
    expect(snap.nodes['ServerScriptService.Main#Script']).toMatchObject({ h: 'deadbeef' });
    expect(snap.roots).toEqual(ROOTS);
    expect(studio.cuts).toBe(0);
  });

  it('asks again with smaller pages when Studio cuts one, and remembers the size that works', async () => {
    const studio = new FakePlace(bigPlace(10, 300), 30_000);
    const snap = await studio.snapshot(ROOTS, 'Edit', 20_000, 60_000);
    expect(Object.keys(snap.nodes)).toEqual(allKeys(studio.place, ROOTS));
    // 80,000 → 40,000 → 20,000 characters: two cut pages, then every page arrives whole.
    expect(studio.cuts).toBe(2);
    const cutsAfterFirst = studio.cuts;
    const again = await studio.snapshot(ROOTS, 'Edit', 20_000, 60_000);
    expect(again.nodes).toEqual(snap.nodes);
    expect(studio.cuts).toBe(cutsAfterFirst);
  });

  it('gives up with the facts when even a small page arrives cut', async () => {
    const studio = new FakePlace(bigPlace(2, 50), 1500);
    await expect(studio.snapshot(ROOTS, 'Edit', 1000, 10_000)).rejects.toThrow(/did not return JSON \(1500 characters, even for pages of 4000\)/);
  });

  it('starts over when the place changes between pages, and reports what it finally read', async () => {
    const studio = new FakePlace(bigPlace(10, 300));
    // The place gains a folder right after its first page was read (it sits before the cursor).
    studio.beforeCall = (n) => {
      if (n === 2) studio.place[0]!.children[0]!.children.unshift(folder('Added', [part('Late', 1)]));
    };
    const snap = await studio.snapshot(ROOTS, 'Edit', 20_000, 60_000);
    expect(snap.unstable).toBeUndefined();
    expect(Object.keys(snap.nodes)).toEqual(allKeys(studio.place, ROOTS));
    expect(snap.nodes['Workspace.Map.Added.Late#Part']).toBeDefined();
  });

  it('takes a place that never settles as it is, flagged, instead of failing', async () => {
    const studio = new FakePlace(bigPlace(10, 300));
    let n = 0;
    studio.beforeCall = () => {
      // Every call finds one more part: no two pages agree on the size.
      studio.place[0]!.children[0]!.children[0]!.children.push(part(`Extra${n++}`, n));
    };
    const snap = await studio.snapshot(ROOTS, 'Edit', 20_000, 60_000);
    expect(snap.unstable).toBe(true);
    expect(Object.keys(snap.nodes).length).toBeGreaterThan(3000);
    // A diff against it is not evidence of deletions.
    expect(diffSnapshots(snap, snap).unreliable).toBe(true);
  });

  it('marks a place bigger than the cap truncated, and a diff of it unreliable', async () => {
    const studio = new FakePlace(bigPlace(5, 100));
    const snap = await studio.snapshot(ROOTS, 'Edit', 100, 60_000);
    expect(snap.truncated).toBe(true);
    expect(snap.count).toBe(100);
    expect(Object.keys(snap.nodes)).toHaveLength(100);
    const whole = await studio.snapshot(ROOTS, 'Edit', 10_000, 60_000);
    const d = diffSnapshots(whole, snap);
    expect(d.removed.length).toBeGreaterThan(400);
    expect(d.unreliable).toBe(true);
    expect(d.summary).toContain('(snapshot truncated)');
  });

  it('roots that are not there give an empty snapshot, not an error (JSONEncode writes {} as [])', async () => {
    const studio = new FakePlace(bigPlace(1, 1));
    const snap = await studio.snapshot(['Nowhere'], 'Edit', 100, 10_000);
    expect(snap).toMatchObject({ count: 0, truncated: false, nodes: {} });
    expect(studio.calls).toBe(1);
  });

  it('feeds the diff: deleted, new and changed instances are told apart', async () => {
    const studio = new FakePlace(bigPlace(10, 300));
    const before = await studio.snapshot(ROOTS, 'Edit', 20_000, 60_000);
    const map = studio.place[0]!.children[0]!;
    const gone = map.children.splice(3, 1)[0]!; // a whole area: 1 folder + 300 parts
    map.children[0]!.children[5]!.sig = { ...map.children[0]!.children[5]!.sig, col: 'ff0000' };
    map.children.push(folder('Fresh', [part('New1', 1), part('New2', 2)]));
    const after = await studio.snapshot(ROOTS, 'Edit', 20_000, 60_000);
    const d = diffSnapshots(before, after);
    expect(d.removed).toHaveLength(301);
    expect(d.removed).toContain(`Workspace.Map.${gone.name}#Folder`);
    expect(d.added).toEqual(['Workspace.Map.Fresh#Folder', 'Workspace.Map.Fresh.New1#Part', 'Workspace.Map.Fresh.New2#Part']);
    expect(d.changed).toEqual([{ path: 'Workspace.Map.Area_0.Wall_0_5#Part', fields: ['col'] }]);
    expect(d.unreliable).toBeUndefined();
  });

  it('surfaces a Luau error from Studio as it is', async () => {
    const studio = new FakePlace(bigPlace(1, 1));
    studio.runLuau = async () => ({ ok: false, output: 'attempt to index nil with Name', durationMs: 1 });
    await expect(studio.snapshot(ROOTS)).rejects.toThrow('attempt to index nil with Name');
  });

  it('luauJson says how long the answer was and how it ended when it is not JSON', async () => {
    const studio = new FakePlace(bigPlace(1, 1));
    const cut = `{"nodes":{"A#Part":{"p":[1,2,3]}},"x":"${'y'.repeat(3000)}`;
    studio.runLuau = async () => ({ ok: true, output: cut, durationMs: 1 });
    await expect(studio.luauJson('return 1')).rejects.toThrow(new RegExp(`\\(${cut.length} characters\\).*y{200}$`, 's'));
  });

  it('asks for pages that fit under the limit with room to spare', () => {
    expect(SNAPSHOT_PAGE_CHARS).toBeLessThanOrEqual(90_000);
    expect(LUAU_SNAPSHOT).toContain('__FROM__');
    expect(LUAU_SNAPSHOT).toContain('__BUDGET__');
  });
});
