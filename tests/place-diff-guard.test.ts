import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core';
import { diffEvidence, diffSnapshots, REMOVAL_RECHECK, removalsStillGone, type DataModelSnapshot } from '../src/core/roblox/snapshot-diff';
import { coreHarness, waitFor } from './helpers/make-core';

const makeCore = coreHarness();
afterEach(() => {
  REMOVAL_RECHECK.delayMs = 4000;
});

interface PlaceHandle {
  nodes: Record<string, Record<string, unknown>>;
  /** Snapshots Studio has answered. */
  snapshots: number;
  /** Runs before the nth answer (1-based): lets a test change the place or cut the answer between them. */
  hook: ((n: number) => { truncated?: boolean } | void) | null;
}

/** A Studio whose place is a set of scenery models: snapshots copy it, agents (the test's scripts) change it. */
function fakePlace(core: Core, count = 60): PlaceHandle {
  const place: PlaceHandle = { nodes: {}, snapshots: 0, hook: null };
  for (let i = 0; i < count; i++) place.nodes[`ServerStorage.Scenery.Tree_${i}#Model`] = { c: 'Model' };
  const studio = core.studio as unknown as Record<string, unknown>;
  // 'connected' is the connection's state; the connection itself is never used (every other Studio call answers 'not connected').
  core.studio.conn.state = 'connected';
  studio.state = async () => ({ mode: 'Edit', availableDataModels: ['Edit'], focused: null, raw: '' });
  studio.snapshot = async (): Promise<DataModelSnapshot> => {
    place.snapshots++;
    const cut = place.hook?.(place.snapshots) ?? {};
    return { roots: ['ServerStorage'], count: Object.keys(place.nodes).length, truncated: !!cut.truncated, nodes: structuredClone(place.nodes) };
  };
  return place;
}

/** Deletes the first n instances of the place; returns what puts them back. */
function clear(place: PlaceHandle, n: number): () => void {
  const saved = Object.entries(place.nodes).slice(0, n);
  for (const [k] of saved) delete place.nodes[k];
  return () => {
    for (const [k, v] of saved) place.nodes[k] = v;
  };
}

const implement = (title: string) => ({ kind: 'implement' as const, title, objective: `${title}.`, role: 'roblox-engineer', createdBy: 't', status: 'ready' as const, acceptanceCriteria: ['It is done'], verification: [{ kind: 'critic' as const }] });
const pass = { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };

describe('the large-removal approval', () => {
  it('asks when a task deleted a lot and it is still gone a moment later; the approval carries the task on to its checks without redoing the work', async () => {
    REMOVAL_RECHECK.delayMs = 20;
    let place: PlaceHandle | null = null;
    const { core, ctx, provider } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          clear(place!, 30);
          return { status: 'implemented', summary: 'Cleared the old trees' };
        }
        if (kind === 'review') return pass;
        return null;
      },
    });
    place = fakePlace(core);
    ctx.updateSettings({ autonomy: 'manual', permissionMode: 'ask' });
    core.orchestrator.attach(ctx);
    const task = ctx.tasks.create(implement('Clear the old scenery'));
    core.orchestrator.runNow(task.id);

    const open = await waitFor(() => ctx.governance.escalations('open')[0]);
    expect(open).toMatchObject({ kind: 'approval', title: 'Clear the old scenery removed 30 instances from the place', taskId: task.id });
    expect(open.detail).toContain('ServerStorage.Scenery.Tree_0#Model');
    // Before the task, after it, and the second look.
    expect(place.snapshots).toBe(3);
    expect(ctx.tasks.get(task.id)!.status).toBe('escalated');
    expect(provider.runs.filter((r) => r.role === 'roblox-engineer')).toHaveLength(1);
    // The evidence file the approval points to holds the nodes the diff is about, not two copies of the whole place.
    const saved = JSON.parse(readFileSync(ctx.tasks.evidence(task.id).find((e) => e.kind === 'datamodel_snapshot')!.path!, 'utf8')) as { before: DataModelSnapshot; after: DataModelSnapshot; diff: { removed: string[] } };
    expect(Object.keys(saved.before.nodes)).toHaveLength(30);
    expect(Object.keys(saved.after.nodes)).toHaveLength(0);
    expect([saved.before.count, saved.after.count]).toEqual([60, 30]);
    expect(saved.diff.removed).toHaveLength(30);

    // Approved: the finished work is checked, not redone (and not asked about again).
    ctx.governance.resolveEscalation(open.id, 'approved', null);
    core.orchestrator.runNow(task.id); // (autonomy is manual here; otherwise it would simply start again)
    await waitFor(() => ctx.tasks.get(task.id)?.status === 'done');
    expect(provider.runs.filter((r) => r.role === 'roblox-engineer')).toHaveLength(1);
    expect(provider.runs.some((r) => r.role === 'critic')).toBe(true);
    expect(ctx.governance.escalations('open')).toHaveLength(0);
    expect(place.snapshots).toBe(3);
  }, 60000);

  it("doesn't ask when what looked removed was back a moment later (another agent rebuilding it)", async () => {
    REMOVAL_RECHECK.delayMs = 20;
    let place: PlaceHandle | null = null;
    let restore: (() => void) | null = null;
    const { core, ctx, provider } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          restore = clear(place!, 30);
          return { status: 'implemented', summary: 'Retuned the lighting' };
        }
        if (kind === 'review') return pass;
        return null;
      },
    });
    place = fakePlace(core);
    // The kit's builder puts it back between the task's after-snapshot (2) and the second look (3).
    place.hook = (n) => {
      if (n === 3) restore!();
    };
    ctx.updateSettings({ autonomy: 'manual' });
    core.orchestrator.attach(ctx);
    const task = ctx.tasks.create(implement('Retune the lighting'));
    core.orchestrator.runNow(task.id);
    await waitFor(() => ctx.tasks.get(task.id)?.status === 'done');
    expect(place.snapshots).toBe(3);
    expect(ctx.governance.escalations()).toHaveLength(0);
    // The evidence still says what the first look saw.
    expect(ctx.tasks.evidence(task.id).find((e) => e.kind === 'datamodel_snapshot')!.title).toMatch(/30 removed/);
    expect(provider.runs.filter((r) => r.role === 'critic')).toHaveLength(1);
  }, 60000);

  it("doesn't blame a task for what vanished while other agents worked in the place, and tells its critic", async () => {
    REMOVAL_RECHECK.delayMs = 20;
    let place: PlaceHandle | null = null;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { core, ctx, provider } = await makeCore({
      respond: async (req, kind) => {
        if (kind === 'work') {
          if (req.prompt.includes('Light the lobby')) {
            await gate; // still working while the other task finishes
            return { status: 'implemented', summary: 'Lit the lobby' };
          }
          clear(place!, 30);
          return { status: 'implemented', summary: 'Cleared the old trees' };
        }
        if (kind === 'review') return pass;
        return null;
      },
    });
    place = fakePlace(core);
    ctx.updateSettings({ autonomy: 'manual' });
    core.orchestrator.attach(ctx);
    const clearing = ctx.tasks.create(implement('Clear the old scenery'));
    const lighting = ctx.tasks.create(implement('Light the lobby'));
    core.orchestrator.runNow(clearing.id);
    core.orchestrator.runNow(lighting.id);
    // The clearing task gets past its place check (and is under review) while the lighting task is still at work.
    await waitFor(() => ctx.tasks.get(clearing.id)?.status === 'reviewing' || ctx.tasks.get(clearing.id)?.status === 'done');
    expect(ctx.tasks.get(lighting.id)!.status).toBe('running');
    expect(ctx.governance.escalations()).toHaveLength(0);
    release();
    await waitFor(() => ctx.tasks.get(clearing.id)?.status === 'done' && ctx.tasks.get(lighting.id)?.status === 'done');
    expect(ctx.governance.escalations()).toHaveLength(0);
    const critic = provider.runs.find((r) => r.role === 'critic' && r.prompt.includes('Clear the old scenery'))!;
    expect(critic.prompt).toMatch(/Other agents were working in the place at the same time[\s\S]*30 removed/);
  }, 60000);

  it('is quiet about a diff from a snapshot cut at its cap: what is missing may only lie outside what was read', async () => {
    REMOVAL_RECHECK.delayMs = 20;
    let place: PlaceHandle | null = null;
    const { core, ctx } = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          clear(place!, 30);
          return { status: 'implemented', summary: 'Added a lot of parts' };
        }
        if (kind === 'review') return pass;
        return null;
      },
    });
    place = fakePlace(core);
    // The place outgrew the snapshot's cap while the task worked: the after-snapshot is cut.
    place.hook = (n) => (n >= 2 ? { truncated: true } : undefined);
    ctx.updateSettings({ autonomy: 'manual' });
    core.orchestrator.attach(ctx);
    const task = ctx.tasks.create(implement('Build the arena'));
    core.orchestrator.runNow(task.id);
    await waitFor(() => ctx.tasks.get(task.id)?.status === 'done');
    expect(ctx.governance.escalations()).toHaveLength(0);
    expect(ctx.tasks.evidence(task.id).find((e) => e.kind === 'datamodel_snapshot')!.title).toContain('(snapshot truncated)');
    // No second look was taken either: nothing was going to be asked.
    expect(place.snapshots).toBe(2);
  }, 60000);

  it('keeps removals only for what is missing in the later snapshot', () => {
    const later = (...keys: string[]): DataModelSnapshot => ({ roots: [], count: keys.length, truncated: false, nodes: Object.fromEntries(keys.map((k) => [k, { c: 'Model' }])) });
    expect(removalsStillGone(['A#Model', 'B#Model', 'C#Model'], later('B#Model'))).toEqual(['A#Model', 'C#Model']);
    // No later snapshot (Studio busy): nothing can be dropped.
    expect(removalsStillGone(['A#Model'], null)).toEqual(['A#Model']);
    // A key that merely names an Object.prototype member is not "present".
    expect(removalsStillGone(['constructor'], later())).toEqual(['constructor']);
  });

  it('keeps of two snapshots only the nodes the diff is about, with the real counts', () => {
    const snap = (count: number, nodes: Record<string, Record<string, unknown>>): DataModelSnapshot => ({ roots: ['Workspace'], count, truncated: false, nodes });
    const before = snap(4, { 'W.A#Part': { c: 'Part', col: 'aa' }, 'W.B#Part': { c: 'Part', col: 'bb' }, 'W.C#Part': { c: 'Part' }, 'W#Workspace': { c: 'Workspace' } });
    const after = snap(4, { 'W.A#Part': { c: 'Part', col: 'cc' }, 'W.C#Part': { c: 'Part' }, 'W.D#Part': { c: 'Part' }, 'W#Workspace': { c: 'Workspace' } });
    const d = diffSnapshots(before, after);
    expect(d).toMatchObject({ added: ['W.D#Part'], removed: ['W.B#Part'], changed: [{ path: 'W.A#Part', fields: ['col'] }] });
    const kept = diffEvidence(before, after, d);
    expect(Object.keys(kept.before.nodes).sort()).toEqual(['W.A#Part', 'W.B#Part']);
    expect(Object.keys(kept.after.nodes).sort()).toEqual(['W.A#Part', 'W.D#Part']);
    expect(kept.before.nodes['W.A#Part']).toEqual({ c: 'Part', col: 'aa' });
    expect(kept.after.nodes['W.A#Part']).toEqual({ c: 'Part', col: 'cc' });
    expect([kept.before.count, kept.after.count, kept.before.roots]).toEqual([4, 4, ['Workspace']]);
  });
});
