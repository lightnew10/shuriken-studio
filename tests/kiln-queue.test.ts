import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { KilnModeling } from '../src/core/modeling/kiln-modeling';
import { GPU_QUEUE_MS, Gate, KILN_BUILDS_DEFAULT, KILN_BUILDS_UNGATED, KilnBuildQueue, SLOW_BAKE_MS, STEP_UP_MS, clampBuilds, effectiveBuildLimit, estimateBuild, type BuildEnd } from '../src/core/modeling/kiln-queue';
import { modelingEnvironment } from '../src/core/context/environment';
import { KILN_BUILD, registerKilnTools } from '../src/core/capabilities/kiln-tools';
import { AppPrefsService, DEFAULT_APP_PREFS } from '../src/core/app-prefs';
import { ROLES, hiddenToolsFor } from '../src/core/agents/roles';
import type { ProjectContext } from '../src/core/projects/project-service';
import type { CallerContext, ToolDefinition } from '../src/core/capabilities/tool-registry';
import { fakeBlender, fakeKiln } from './helpers/fake-kiln';

// Shuriken's queue of Kiln builds: first in, first out, `kilnBuildsAtOnce` at a time (at most 6 against a Kiln
// older than 0.8.2), one build per Kiln project at a time, a limit that steps itself down on evidence and says
// so, and builds that carry on whoever waits, so one modeler call waits for all of them.

const tick = () => new Promise((ok) => setTimeout(ok, 0));
const until = async (cond: () => unknown, ms = 5000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((ok) => setTimeout(ok, 5));
  }
};

/** A queue whose builds end when the test says so. */
function controlled(over: { setting?: number; version?: string | null } = {}) {
  let setting = over.setting ?? 6;
  let version = over.version === undefined ? '0.8.2' : over.version;
  const said: string[] = [];
  const started: string[] = [];
  const ends = new Map<string, (e: BuildEnd<unknown>) => void>();
  let clock = 1_000_000;
  const q = new KilnBuildQueue({ setting: () => setting, kilnVersion: () => version, say: (l) => void said.push(l), now: () => clock });
  const add = (name: string, project = name) =>
    q.submit({ root: 'C:/game', name, kilnProject: project, kind: 'new', by: '3D modeler', runId: 'run_1', taskId: null }, (b) => {
      started.push(b.name);
      return new Promise<BuildEnd<unknown>>((ok) => ends.set(b.name, ok));
    });
  const end = async (name: string, e: BuildEnd<unknown> = { state: 'done', result: { name }, evidence: { turnMs: 300_000, bakeMs: 20_000 } }) => {
    ends.get(name)!(e);
    await tick();
    await tick();
  };
  return { q, add, end, said, started, set: (n: number) => (setting = n), setVersion: (v: string | null) => (version = v), advance: (ms: number) => (clock += ms) };
}

describe('how many Kiln builds run at once', () => {
  it('is the setting (default 8, 1 to 32), held to 6 against a Kiln older than 0.8.2', () => {
    expect(KILN_BUILDS_DEFAULT).toBe(8);
    expect(DEFAULT_APP_PREFS.kilnBuildsAtOnce).toBe(KILN_BUILDS_DEFAULT);
    expect([clampBuilds(0), clampBuilds(1), clampBuilds(2.6), clampBuilds(20), clampBuilds(99), clampBuilds('x'), clampBuilds(undefined)]).toEqual([8, 1, 3, 20, 32, 8, 8]);
    // Kiln 0.8.2 gates GPU work itself (3 renders or bakes at a time): the setting applies as given.
    expect(effectiveBuildLimit(KILN_BUILDS_DEFAULT, '0.8.2')).toEqual({ limit: 8, capped: false, why: null });
    // The default against the Kiln that froze the PC with 12 Blenders: six.
    expect(effectiveBuildLimit(KILN_BUILDS_DEFAULT, '0.8.1')).toEqual({ limit: 6, capped: true, why: 'Kiln 0.8.1 runs at most 6 builds at once; Kiln 0.8.2 lifts this' });
    expect(effectiveBuildLimit(20, '0.8.2')).toEqual({ limit: 20, capped: false, why: null });
    expect(effectiveBuildLimit(20, '0.9.0')).toMatchObject({ limit: 20, capped: false });
    expect(effectiveBuildLimit(20, '0.8.1')).toEqual({ limit: KILN_BUILDS_UNGATED, capped: true, why: 'Kiln 0.8.1 runs at most 6 builds at once; Kiln 0.8.2 lifts this' });
    expect(effectiveBuildLimit(8, '0.7.3')).toMatchObject({ limit: 6, capped: true });
    // The setting is the user's when it is no higher than what an older Kiln can take.
    expect(effectiveBuildLimit(6, '0.8.1')).toEqual({ limit: 6, capped: false, why: null });
    expect(effectiveBuildLimit(3, '0.8.1')).toEqual({ limit: 3, capped: false, why: null });
    // A Kiln whose version isn't known is treated as an old one: the safe side.
    expect(effectiveBuildLimit(12, null)).toMatchObject({ limit: 6, capped: true, why: 'Kiln (version unknown) runs at most 6 builds at once; Kiln 0.8.2 lifts this' });
  });

  it('keeps the preference within 1 to 32', () => {
    const rows = new Map<string, string>();
    const store = { get: (_sql: string, [k]: string[]) => (rows.has(k!) ? { value: rows.get(k!) } : undefined), run: (_sql: string, [k, v]: string[]) => void rows.set(k!, v!) };
    const prefs = new AppPrefsService(store as never);
    expect(prefs.get().kilnBuildsAtOnce).toBe(KILN_BUILDS_DEFAULT);
    expect(prefs.set({ kilnBuildsAtOnce: 32 }).kilnBuildsAtOnce).toBe(32);
    expect(prefs.set({ kilnBuildsAtOnce: 45 }).kilnBuildsAtOnce).toBe(32);
    expect(prefs.set({ kilnBuildsAtOnce: 0 }).kilnBuildsAtOnce).toBe(KILN_BUILDS_DEFAULT);
    expect(prefs.set({ kilnBuildsAtOnce: 1 }).kilnBuildsAtOnce).toBe(1);
  });

  it('shows in the queue: the cap of an older Kiln with its reason, the setting from 0.8.2', async () => {
    const c = controlled({ setting: 12, version: '0.8.1' });
    expect(c.q.status()).toEqual({ running: 0, queued: 0, atOnce: 6, setting: 12, note: 'Kiln 0.8.1 runs at most 6 builds at once; Kiln 0.8.2 lifts this' });
    for (let i = 1; i <= 9; i++) c.add(`M${i}`);
    expect(c.q.status()).toMatchObject({ running: 6, queued: 3 });
    // The same queue against Kiln 0.8.2: the setting applies as given, and the waiting builds start.
    c.setVersion('0.8.2');
    await c.end('M1');
    expect(c.q.status()).toMatchObject({ running: 8, queued: 0, atOnce: 12, setting: 12, note: null });
  });

  it('says what the builds waiting and running are expected to take, from Kiln’s own measured builds', async () => {
    expect(estimateBuild('new', true)).toEqual({ minutes: 9.8, usd: 1.95 });
    expect(estimateBuild('new', false)).toEqual({ minutes: 5.4, usd: 1.2 });
    expect(estimateBuild('fix', true)).toEqual({ minutes: 3.1, usd: 0.64 });
    const c = controlled({ setting: 2 });
    expect(c.q.status().estimate).toBeUndefined();
    c.add('Crate');
    c.add('Barrel');
    c.add('Lantern');
    // Three props at two at once: $3.60, and 16 minutes of building shared by two lanes.
    expect(c.q.status().estimate).toEqual({ usd: 3.6, minutes: 8 });
    // A running build's own estimate (Kiln 0.8.2 progress) is used where Kiln gives one.
    c.q.list().find((b) => b.name === 'Crate')!.progress = { done: 3, total: 4, current: 'Materials', etaMs: 60_000, lastRender: null };
    expect(c.q.status().estimate).toEqual({ usd: 3.6, minutes: 6 });
  });

  it('tells the planner how many build at once', () => {
    const [line] = modelingEnvironment({ ready: true, detail: 'Blender 5.2', max: 5 }, { available: true, detail: 'Kiln 0.8.1', buildsAtOnce: 6 });
    expect(line).toMatch(/they build in parallel \(up to 6 at once; the rest queue; one request per project at a time\)/);
  });
});

describe('the queue', () => {
  it('starts builds first in, first out, never more than the limit', async () => {
    const c = controlled({ setting: 2 });
    const ids = ['A', 'B', 'C', 'D', 'E'].map((n) => c.add(n).build.id);
    expect(c.started).toEqual(['A', 'B']);
    expect(c.q.status()).toMatchObject({ running: 2, queued: 3, atOnce: 2 });
    expect([c.q.position(ids[2]!), c.q.position(ids[3]!), c.q.position(ids[4]!), c.q.position(ids[0]!)]).toEqual([1, 2, 3, null]);
    await c.end('B');
    expect(c.started).toEqual(['A', 'B', 'C']);
    await c.end('A');
    await c.end('C');
    expect(c.started).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(c.q.running).toBe(2);
    await c.end('D');
    await c.end('E');
    expect(c.q.status()).toMatchObject({ running: 0, queued: 0 });
    expect(c.q.list().map((b) => b.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(c.q.resultOf(ids[0]!)).toEqual({ name: 'A' });
  });

  it('never runs two builds of the same Kiln project together, and lets the next project past', async () => {
    const c = controlled({ setting: 3 });
    c.add('Torsos', 'p-torsos');
    c.add('Torso_Heavy fix', 'p-torsos');
    c.add('Legs', 'p-legs');
    expect(c.started).toEqual(['Torsos', 'Legs']);
    await c.end('Legs');
    expect(c.started).toEqual(['Torsos', 'Legs']);
    await c.end('Torsos');
    expect(c.started).toEqual(['Torsos', 'Legs', 'Torso_Heavy fix']);
  });

  it('takes a waiting build out of line, and resolves whoever waits for it', async () => {
    const c = controlled({ setting: 1 });
    c.add('A');
    const b = c.add('B');
    expect(c.q.stop(b.build.id)).toBe(true);
    expect((await b.done).build).toMatchObject({ state: 'stopped', error: 'Taken out of the queue' });
    await c.end('A');
    expect(c.started).toEqual(['A']);
    expect(c.q.stop(b.build.id)).toBe(false);
  });

  it('counts a build whose job throws as failed, and carries on', async () => {
    const q = new KilnBuildQueue({ setting: () => 1, kilnVersion: () => '0.8.2' });
    const info = { root: 'r', name: 'X', kilnProject: 'x', kind: null, by: null, runId: null, taskId: null };
    const bad = q.submit(info, async () => {
      throw new Error('boom');
    });
    const good = q.submit({ ...info, name: 'Y', kilnProject: 'y' }, async () => ({ state: 'done' as const, result: 1 }));
    expect((await bad.done).build).toMatchObject({ state: 'failed', error: 'boom' });
    expect((await good.done).result).toBe(1);
  });
});

describe('stepping its own limit down on evidence', () => {
  const failed: BuildEnd<unknown> = { state: 'failed', error: 'Kiln’s turn ended failed: Blender crashed.', evidence: { turnMs: 60_000 } };

  it('steps down when two of the last four builds failed while several ran, says so in one line, and comes back up one at a time when it stays quiet', async () => {
    const c = controlled({ setting: 6 });
    for (let i = 1; i <= 10; i++) c.add(`M${i}`);
    expect(c.q.running).toBe(6);
    await c.end('M1');
    await c.end('M2', failed);
    expect(c.q.status().atOnce).toBe(6);
    expect(c.said).toHaveLength(0);
    await c.end('M3', failed);
    const s = c.q.status();
    expect(s.atOnce).toBe(4);
    expect(s.setting).toBe(6);
    expect(c.said).toEqual([`Kiln builds were in trouble with 6 at once (M2: failed; M3: failed), so 4 run at once now. One more runs again after every 15 minutes without trouble.`]);
    expect(s.note).toBe(c.said[0]);
    // The five still running finish; nothing new starts until fewer than four run.
    expect(c.q.running).toBe(5);
    await c.end('M4');
    expect(c.q.running).toBe(4);
    await c.end('M5');
    expect(c.q.running).toBe(4);
    // Good builds don't raise it again.
    for (const n of ['M6', 'M7', 'M8', 'M9', 'M10']) await c.end(n);
    expect(c.q.status().atOnce).toBe(4);
    // More trouble at four: down to two, then one, never below.
    for (let i = 11; i <= 22; i++) c.add(`M${i}`);
    await c.end('M11', failed);
    await c.end('M12', failed);
    expect(c.q.status().atOnce).toBe(2);
    for (const n of ['M13', 'M14']) await c.end(n);
    await c.end('M15', failed);
    await c.end('M16', failed);
    expect(c.q.status().atOnce).toBe(1);
    expect(c.said).toHaveLength(3);
    // A quiet quarter of an hour: one more runs again, and a waiting build starts with it; then one more, up to the setting.
    c.advance(STEP_UP_MS - 1);
    expect(c.q.status().atOnce).toBe(1);
    c.advance(1);
    expect(c.q.status()).toMatchObject({ atOnce: 2, note: expect.stringMatching(/so 2 run at once now\. One more runs again after every 15 minutes without trouble\.$/) });
    const before = c.q.running;
    c.q.observeLoad({ waiting: 0, waitedMs: 0 });
    expect(c.q.running).toBeGreaterThanOrEqual(Math.min(2, before + 1));
    c.advance(2 * STEP_UP_MS);
    expect(c.q.status().atOnce).toBe(4);
    c.advance(5 * STEP_UP_MS);
    expect(c.q.status()).toMatchObject({ atOnce: 6, note: null });
    // The user sets the number again: theirs counts.
    c.set(5);
    expect(c.q.status()).toMatchObject({ atOnce: 5, setting: 5, note: null });
  });

  it('steps down at once when Kiln refuses a brief (503)', async () => {
    const c = controlled({ setting: 6 });
    for (let i = 1; i <= 6; i++) c.add(`M${i}`);
    await c.end('M4', { state: 'failed', error: 'Kiln refused the brief (503: Blender is missing)', evidence: { refused: true } });
    expect(c.q.status().atOnce).toBe(4);
    expect(c.said[0]).toMatch(/^Kiln builds were in trouble with 6 at once \(M4: Kiln refused its brief \(503\)\), so 4 run at once now\./);
  });

  it('reads bakes and turns that slow sharply as trouble: against the builds that ran with little company, or a bake past two minutes', async () => {
    // A Kiln without its own GPU gate: a turn that slows sharply is the load.
    const c = controlled({ setting: 6, version: '0.8.1' });
    // Two builds alone set what "normal" is here: a 5 minute turn, a 20 s bake.
    c.add('Calm1');
    await c.end('Calm1');
    c.add('Calm2');
    await c.end('Calm2');
    for (let i = 1; i <= 6; i++) c.add(`M${i}`);
    await c.end('M1', { state: 'done', evidence: { turnMs: 320_000, bakeMs: 25_000 } });
    // A bake three times slower than calm (and a turn three times slower): slowing sharply.
    await c.end('M2', { state: 'done', evidence: { turnMs: 300_000, bakeMs: 70_000 } });
    expect(c.q.status().atOnce).toBe(6);
    await c.end('M3', { state: 'done', evidence: { turnMs: 16 * 60_000, bakeMs: 20_000 } });
    expect(c.q.status().atOnce).toBe(4);
    expect(c.said[0]).toContain('M2: its bake took 70 s; M3: its turn took 16 min');
    // Without any calm builds to compare with, a bake past two minutes is still trouble.
    const d = controlled({ setting: 6 });
    for (let i = 1; i <= 6; i++) d.add(`N${i}`);
    await d.end('N1', { state: 'done', evidence: { turnMs: 300_000, bakeMs: SLOW_BAKE_MS + 1000 } });
    await d.end('N2', { state: 'done', evidence: { turnMs: 300_000, bakeMs: 200_000 } });
    expect(d.q.status().atOnce).toBe(4);
    expect(d.said[0]).toContain('N1: its bake took 2 min; N2: its bake took 3 min');
  });

  // Two kits at max effort took 55 and 56 minutes; the queue ran 3 at once instead of 5 for the rest of the day.
  it('does not read a long turn as trouble against a Kiln that gates the graphics card itself: that is effort, not load', async () => {
    const c = controlled({ setting: 5 });
    c.add('Calm1');
    await c.end('Calm1');
    c.add('Calm2');
    await c.end('Calm2');
    for (let i = 1; i <= 5; i++) c.add(`M${i}`);
    await c.end('M1', { state: 'done', evidence: { turnMs: 56 * 60_000, bakeMs: 20_000 } });
    await c.end('M2', { state: 'done', evidence: { turnMs: 55 * 60_000, bakeMs: 25_000 } });
    await c.end('M3', { state: 'done', evidence: { turnMs: 40 * 60_000, bakeMs: 22_000 } });
    expect(c.q.status()).toMatchObject({ atOnce: 5, note: null });
    expect(c.said).toHaveLength(0);
  });

  it('does not blame the load for a usage limit, the user’s Stop, or a build that failed alone', async () => {
    const c = controlled({ setting: 6 });
    for (let i = 1; i <= 6; i++) c.add(`M${i}`);
    await c.end('M1', { state: 'failed', error: 'Your account has reached its usage limit.', evidence: { unrelated: true } });
    await c.end('M2', { state: 'stopped', error: 'Stopped.', evidence: { unrelated: true } });
    await c.end('M3', { state: 'failed', error: 'usage limit', evidence: { unrelated: true } });
    expect(c.q.status().atOnce).toBe(6);
    for (const n of ['M4', 'M5', 'M6']) await c.end(n);
    // One at a time: a failure is the build's own.
    c.add('S1');
    await c.end('S1', failed);
    c.add('S2');
    await c.end('S2', failed);
    expect(c.q.status().atOnce).toBe(6);
    expect(c.said).toHaveLength(0);
  });
});

describe('stepping down when builds queue for Kiln 0.8.2’s GPU gate', () => {
  it('steps down when renders or bakes wait for the graphics card for over a minute, once per two minutes', () => {
    const c = controlled({ setting: 12 });
    for (let i = 1; i <= 12; i++) c.add(`M${i}`);
    expect(c.q.running).toBe(12);
    // A short wait is what the gate is for: nothing happens.
    c.q.observeLoad({ waiting: 2, waitedMs: 4000 });
    c.advance(15_000);
    c.q.observeLoad({ waiting: 0, waitedMs: 9000 });
    c.advance(15_000);
    c.q.observeLoad({ waiting: 1, waitedMs: 12_000 });
    c.advance(GPU_QUEUE_MS);
    c.q.observeLoad({ waiting: 0, waitedMs: 20_000 });
    expect(c.q.status().atOnce).toBe(12);
    // Waiting without a break for a minute: more parallel builds won't finish sooner.
    for (let i = 0; i < 5; i++) {
      c.advance(15_000);
      c.q.observeLoad({ waiting: 3, waitedMs: 30_000 + i * 10_000 });
    }
    expect(c.q.status().atOnce).toBe(8);
    expect(c.said).toEqual([`Kiln builds were queuing for the graphics card with 12 at once (3 waiting for the graphics card for over a minute), so 8 run at once now. One more runs again after every 15 minutes without trouble.`]);
    // Still queuing right after: the new limit gets two minutes before it is judged.
    for (let i = 0; i < 6; i++) {
      c.advance(15_000);
      c.q.observeLoad({ waiting: 3, waitedMs: 200_000 });
    }
    expect(c.q.status().atOnce).toBe(8);
    for (let i = 0; i < 6; i++) {
      c.advance(15_000);
      c.q.observeLoad({ waiting: 2, waitedMs: 300_000 });
    }
    expect(c.q.status().atOnce).toBe(5);
    expect(c.said).toHaveLength(2);
  });

  it('steps down when the waiting adds up fast even with gaps, and ignores the gate while one build runs', () => {
    const c = controlled({ setting: 9 });
    for (let i = 1; i <= 9; i++) c.add(`M${i}`);
    c.q.observeLoad({ waiting: 0, waitedMs: 0 });
    for (let i = 1; i <= 5; i++) {
      c.advance(15_000);
      // Nothing waiting at the moment of the reading, but 20 s of waiting were added since the last one.
      c.q.observeLoad({ waiting: 0, waitedMs: i * 20_000 });
    }
    expect(c.q.status().atOnce).toBe(6);
    expect(c.said[0]).toMatch(/\(1 min of waiting for the graphics card in the last minute\)|\(80 s of waiting for the graphics card in the last minute\)/);
    const one = controlled({ setting: 8 });
    one.add('Only');
    for (let i = 0; i < 8; i++) {
      one.advance(15_000);
      one.q.observeLoad({ waiting: 5, waitedMs: i * 60_000 });
    }
    expect(one.q.status().atOnce).toBe(8);
  });
});

describe('the gate on Shuriken’s own GPU work through Kiln', () => {
  it('runs two at a time, the rest in order', async () => {
    const gate = new Gate(() => 2);
    let active = 0;
    let most = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        gate.run(async () => {
          order.push(n);
          most = Math.max(most, ++active);
          await new Promise((ok) => setTimeout(ok, 10));
          active--;
          return n;
        }),
      ),
    );
    expect(most).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
    expect(gate.busy).toBe(0);
  });
});

// ---- Against a fake Kiln ---------------------------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'kiln-queue-'));
const root = join(tmp, 'project');
mkdirSync(root, { recursive: true });
const kiln = await fakeKiln(tmp, { version: '0.8.1' });
const blender = fakeBlender();
let atOnce = 2;
const chat: string[] = [];
const events: string[] = [];
const bus = new EventBus();
bus.on('kiln.builds', () => void events.push('kiln.builds'));
const modeling = new KilnModeling(
  blender.backend,
  { enabled: () => false, resourcesDir: resolve(__dirname, '..', 'resources'), runtimeFile: () => kiln.runtimeFile, bakeWaitMs: 400, buildsAtOnce: () => atOnce, note: (text) => (chat.push(text), `m${chat.length}`) },
  bus,
  new Logger(null, null).scope('kiln'),
);
/** The project's store, as far as a build needs it: the run it records. */
const runs: unknown[][] = [];
const project = { root, store: { run: (_sql: string, args: unknown[]) => void runs.push(args) } } as unknown as ProjectContext;
type Handler = ToolDefinition['handler'];
const tools = new Map<string, Handler>();
registerKilnTools({ register: (def: { name: string; handler: Handler }) => void tools.set(def.name, def.handler), get: () => undefined, invoke: async () => ({ content: [] }) } as never, { project: () => project, kiln: () => modeling, modeling: () => blender.backend, bus });
const caller: CallerContext = { kind: 'agent', runId: 'run_q', taskId: 'task_q', role: 'modeler', providerId: null, allowedTools: null };
const call = async (name: string, args: Record<string, unknown>, who: CallerContext = caller) => {
  const notes: string[] = [];
  const out = await tools.get(name)!({ args, caller: who, signal: new AbortController().signal, progress: (n: { message?: string }) => void notes.push(n.message ?? '') } as never);
  const text = out.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { out, text, notes, data: out.data as Record<string, any> | undefined };
};
const chats = () => kiln.hits(/\/chat$/);
const turnOf = (model: string) => [...kiln.turns.values()].find((t) => t.projectId.startsWith(`${model.toLowerCase()}-`) && t.state === 'running');

const saved = { env: process.env.SHURIKEN_NO_KILN, build: { ...KILN_BUILD } };
beforeAll(async () => {
  delete process.env.SHURIKEN_NO_KILN;
  Object.assign(KILN_BUILD, { pollMs: 15, busyPollMs: 15, noteMs: 40 });
  kiln.autoFinish = null;
  await modeling.kiln.check(true);
});
afterAll(async () => {
  if (saved.env === undefined) delete process.env.SHURIKEN_NO_KILN;
  else process.env.SHURIKEN_NO_KILN = saved.env;
  Object.assign(KILN_BUILD, saved.build);
  modeling.stop();
  await kiln.close();
});

describe('several builds from one modeler call', () => {
  it('queues them, runs the limit at once in order, and one kiln_builds call waits for all of them', async () => {
    const names = ['Crate', 'Barrel', 'Lantern', 'Gate', 'Sign'];
    const queued = [];
    for (const model of names) queued.push(await call('kiln_request', { model, text: `A scrapyard ${model.toLowerCase()}.`, wait: false }));
    // Two went to Kiln at once (their turn ids are back); three wait in line, in the order they were asked for.
    expect(queued.map((q) => q.data!.state)).toEqual(['running', 'running', 'queued', 'queued', 'queued']);
    expect(queued.map((q) => q.data!.position ?? null)).toEqual([null, null, 1, 2, 3]);
    expect(queued[0]!.data).toMatchObject({ name: 'Crate', model: 'Crate', kind: 'new', turn: expect.any(String), queue: { running: 1, queued: 0, atOnce: 2 } });
    expect(queued[1]!.data!.queue).toMatchObject({ running: 2, queued: 0, atOnce: 2 });
    // What they are expected to cost and take, before any has finished.
    expect(queued[1]!.data!.queue.expect).toEqual({ usd: 2.4, minutes: 5 });
    expect(queued[4]!.data!.expect).toEqual({ minutes: 5.4, usd: 1.2 });
    expect(queued[4]!.data!.queue).toMatchObject({ running: 2, queued: 3, atOnce: 2 });
    expect(queued[4]!.data!.next).toMatch(/kiln_builds \{wait: true\} waits for this build \(and any others you queued\) in one call/);
    expect(chats().map((c) => c.path.split('/')[4]!.split('-')[0])).toEqual(['crate', 'barrel']);
    expect(modeling.builds.running).toBe(2);
    // The waiting ones cost Kiln nothing yet: no brief was sent.
    expect(kiln.running()).toHaveLength(2);
    // The modeler waits for all five in ONE call while Kiln works through them.
    const waiting = call('kiln_builds', { timeout_min: 1 });
    kiln.finish(turnOf('Barrel')!.turnId);
    await until(() => chats().length === 3);
    expect(chats()[2]!.path).toContain('/lantern-');
    kiln.finish(turnOf('Crate')!.turnId, { costUsd: 2.5 });
    await until(() => chats().length === 4);
    expect(chats()[3]!.path).toContain('/gate-');
    for (const m of ['Lantern', 'Gate']) kiln.finish(turnOf(m)!.turnId);
    await until(() => chats().length === 5);
    await until(() => turnOf('Sign'));
    kiln.finish(turnOf('Sign')!.turnId);
    const r = await waiting;
    expect(r.out.isError).toBeFalsy();
    expect(r.data).toMatchObject({ allEnded: true, queue: { running: 0, queued: 0, atOnce: 2 } });
    expect(r.data!.builds.map((b: { name: string }) => b.name).sort()).toEqual([...names].sort());
    for (const b of r.data!.builds) {
      expect(b, b.name).toMatchObject({ state: 'done', reply: 'Built it.', imported: { ok: true, model: b.name }, delivery: { tris: 4200 }, kind: 'new' });
      expect(blender.exported.some((e) => e.name === b.name), b.name).toBe(true);
    }
    // Five results in one answer come in brief (fifteen whole ones were 48,000 characters: the modeler's client put
    // them in a file it then failed to read three times): Kiln's own measurements and renders are left out, what
    // came into the game stays, and one build alone still comes whole.
    expect(r.data!.brief).toMatch(/One build in full: kiln_builds \{builds: \["<its build id>"\], wait: false\}/);
    for (const b of r.data!.builds) {
      expect(Object.keys(b.delivery).every((k) => ['tris', 'size', 'checks', 'fit'].includes(k) || /problem|warning/.test(k)), JSON.stringify(Object.keys(b.delivery))).toBe(true);
      expect(b.delivery.renders).toBeUndefined();
      expect(b.delivery.models).toBeUndefined();
    }
    const one = await call('kiln_builds', { builds: [r.data!.builds[0].build], wait: false });
    expect(one.data!.brief).toBeUndefined();
    expect(JSON.stringify(one.data!.builds[0].delivery).length).toBeGreaterThanOrEqual(JSON.stringify(r.data!.builds[0].delivery).length);
    // It said what it was waiting for meanwhile.
    expect(r.notes.some((n) => /^Kiln: .*(building|waiting \(\d in line\))/.test(n))).toBe(true);
    // Never more than two of Kiln's turns at once, and never more than two bakes.
    expect(kiln.bakesAtOnce).toBeLessThanOrEqual(2);
    // The UI was told as the queue changed.
    await until(() => events.length > 0);
  }, 30_000);

  it('counts what each build cost: Kiln’s own figure, in the result and as a run of the project', () => {
    // Kiln reports a turn's cost on its reply in the transcript: 2.50 for the crate, 1.25 for the others.
    expect(runs).toHaveLength(5);
    const crate = runs.find((r) => r[10] === 'Kiln built Crate')!;
    expect(crate.slice(1, 6)).toEqual(['task_q', 'kiln', 'kiln', 'Kiln copilot (low)', 'completed']);
    expect(crate[8]).toBe(2.5);
    expect(runs.reduce((t, r) => t + (r[8] as number), 0)).toBeCloseTo(2.5 + 4 * 1.25, 5);
    const b = modeling.builds.list(root).find((x) => x.name === 'Crate')!;
    expect(b.costUsd).toBe(2.5);
    expect(modeling.builds.resultOf<{ costUsd: number }>(b.id)!.costUsd).toBe(2.5);
  });

  it('waits by default, and says when the time is up while the build carries on', async () => {
    Object.assign(KILN_BUILD, { noteMs: 20 });
    const pending = call('kiln_request', { model: 'Crate', kind: 'rework', text: 'Heavier planks.', timeout_min: 1 });
    await until(() => turnOf('Crate'));
    kiln.finish(turnOf('Crate')!.turnId);
    const done = await pending;
    expect(done.data).toMatchObject({ kind: 'rework', reply: 'Built it.', costUsd: 1.25, imported: { ok: true, model: 'Crate' } });
    // A wait that runs out: the build is still Kiln's, and kiln_builds picks it up.
    const short = await call('kiln_request', { model: 'Barrel', kind: 'fix', text: 'The lid floats.', timeout_min: 0.002 });
    expect(short.data).toMatchObject({ state: 'running', name: 'Barrel', note: expect.stringMatching(/kiln_builds \{wait: true\} keeps waiting for it/) });
    const peek = await call('kiln_builds', { builds: [short.data!.build], wait: false });
    expect(peek.data).toMatchObject({ allEnded: false, builds: [{ build: short.data!.build, state: 'running', step: "Kiln's copilot is building" }] });
    kiln.finish(turnOf('Barrel')!.turnId);
    const later = await call('kiln_builds', { builds: [short.data!.build] });
    expect(later.data).toMatchObject({ allEnded: true, builds: [{ state: 'done', imported: { ok: true } }] });
    // By its turn id as well (the older way to follow a request).
    const byTurn = await call('kiln_request', { turn: later.data!.builds[0].turn });
    expect(byTurn.data).toMatchObject({ state: 'done', name: 'Barrel' });
    expect((await call('kiln_request', { turn: 'nope' })).text).toMatch(/No build with turn nope is known here/);
  }, 30_000);

  it('waits for a project that is busy with the user’s own turn instead of failing', async () => {
    // The user is chatting in the Lantern project: Kiln 0.8.1 answers 409 until that turn ends.
    const lantern = [...kiln.projects.keys()].find((id) => id.startsWith('lantern-'))!;
    kiln.turns.set('user-turn', { projectId: lantern, turnId: 'user-turn', state: 'running', reply: '', clips: [], effort: null, effortWhy: null, delivery: null, pollsLeft: null, costUsd: null, body: {} });
    const before = chats().length;
    const pending = call('kiln_request', { model: 'Lantern', kind: 'fix', text: 'Warmer glow.', timeout_min: 1 });
    await until(() => chats().length >= before + 2);
    expect(modeling.builds.list(root).find((b) => b.name === 'Lantern' && b.state === 'running')!.step).toBe("Waiting: its Kiln project is busy with another turn (the user's own)");
    kiln.finish('user-turn');
    await until(() => [...kiln.turns.values()].some((t) => t.projectId === lantern && t.state === 'running'));
    kiln.finish(turnOf('Lantern')!.turnId);
    expect((await pending).data).toMatchObject({ kind: 'fix', imported: { ok: true, model: 'Lantern' } });
  }, 30_000);

  it('holds to six against Kiln 0.8.1 whatever the setting says, and says so', async () => {
    atOnce = 20;
    const s = await call('kiln_status', {});
    expect(s.data!.queue).toEqual({ running: 0, queued: 0, atOnce: 6, setting: 20, note: 'Kiln 0.8.1 runs at most 6 builds at once; Kiln 0.8.2 lifts this' });
    // The default setting against this Kiln is six as well.
    atOnce = KILN_BUILDS_DEFAULT;
    expect((await call('kiln_status', {})).data!.queue).toMatchObject({ atOnce: 6, setting: 8 });
    atOnce = 20;
    kiln.version = '0.8.2';
    await modeling.kiln.check(true);
    expect((await call('kiln_status', {})).data!.queue).toEqual({ running: 0, queued: 0, atOnce: 20 });
    kiln.version = '0.8.1';
    await modeling.kiln.check(true);
    atOnce = 2;
  });

  it('lowers its own limit when Kiln refuses a brief while others build, and tells the chat', async () => {
    chat.length = 0;
    const first = await call('kiln_request', { model: 'Crate', kind: 'fix', text: 'x', wait: false });
    kiln.chatFails = { status: 503, times: 1, error: 'Blender is missing' };
    const refused = await call('kiln_request', { model: 'Barrel', kind: 'fix', text: 'y', wait: false });
    expect(refused.out.isError).toBe(true);
    expect(refused.text).toBe('Kiln refused the brief (503: Blender is missing)');
    expect(modeling.builds.status()).toMatchObject({ atOnce: 1, setting: 2 });
    expect(chat).toEqual([expect.stringMatching(/^Kiln builds were in trouble with 2 at once \(Barrel: Kiln refused its brief \(503\)\), so 1 runs at once now\./)]);
    kiln.finish(turnOf('Crate')!.turnId);
    await call('kiln_builds', { builds: [first.data!.build] });
  }, 30_000);

  it('never runs more than two of its own bakes at once against Kiln 0.8.1', async () => {
    kiln.bakeMs = 40;
    kiln.bakesAtOnce = 0;
    await Promise.all(['Crate', 'Barrel', 'Lantern', 'Gate', 'Sign'].map((m) => modeling.importFromKiln(root, [...kiln.projects.keys()].find((id) => id.startsWith(`${m.toLowerCase()}-`))!, m)));
    expect(kiln.bakesAtOnce).toBe(2);
    // Kiln 0.8.2 gates GPU work itself: Shuriken no longer holds its own bakes back.
    kiln.version = '0.8.2';
    await modeling.kiln.check(true);
    kiln.bakesAtOnce = 0;
    await Promise.all(['Crate', 'Barrel', 'Lantern', 'Gate', 'Sign'].map((m) => modeling.importFromKiln(root, [...kiln.projects.keys()].find((id) => id.startsWith(`${m.toLowerCase()}-`))!, m)));
    expect(kiln.bakesAtOnce).toBeGreaterThan(2);
    kiln.version = '0.8.1';
    kiln.bakeMs = 0;
    await modeling.kiln.check(true);
  }, 30_000);
});

describe('who sees the queue', () => {
  it('gives kiln_builds to the modeler and the animator, and tells the modeler to wait for all builds in one call', () => {
    expect(hiddenToolsFor(ROLES.modeler!)!.has('kiln_builds')).toBe(false);
    expect(hiddenToolsFor(ROLES.animator!)!.has('kiln_builds')).toBe(false);
    expect(hiddenToolsFor(ROLES['level-designer']!)!.has('kiln_builds')).toBe(true);
    const modeler = ROLES.modeler!.instructions.replace(/\s+/g, ' ');
    expect(modeler).toMatch(/pass wait: false to each kiln_request, then kiln_builds \{wait: true\} waits for all of them in one call/);
    const planner = ROLES.executive!.instructions.replace(/\s+/g, ' ');
    expect(planner).toMatch(/go into ONE modeler task per group, not a task each: the modeler queues their Kiln builds, which run side by side, and waits for all of them, so no agent sits idle per build/);
  });
});
