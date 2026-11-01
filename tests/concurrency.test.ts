import { describe, expect, it } from 'vitest';
import { AppPrefsService, DEFAULT_APP_PREFS } from '../src/core/app-prefs';
import { GLOBAL_MIGRATIONS } from '../src/core/db/schema';
import { Store } from '../src/core/db/store';
import { APP_MAX_AGENTS, AUTO_MAX_AGENTS, AUTO_MIN_AGENTS, DEFAULT_AGENT_CAP, MAX_FIXED_AGENTS, MAX_STUDIO_AGENTS, PROJECT_MAX_AGENTS, STUDIO_AGENTS, autoAgentLimit, fixedAgentWhy, fullestWindow, projectCeiling, studioBound, studioHeld, studioLimit, type AgentLoad } from '../src/core/orchestrator/concurrency';
import { coreHarness, waitFor } from './helpers/make-core';

const NOW = Date.parse('2026-10-01T10:00:00.000Z');
const inMin = (m: number) => Math.floor((NOW + m * 60_000) / 1000);
/** Ready tasks are off Studio unless said otherwise. */
const load = (o: Partial<AgentLoad> = {}): AgentLoad => ({ ready: 0, readyOffStudio: o.ready ?? 0, running: 0, studioRunning: 0, elsewhere: 0, accounts: [{}], now: NOW, ...o });
const fiveHour = (utilization: number, resetsInMin = 130) => ({ five_hour: { utilization, resetsAt: inMin(resetsInMin) } });

describe('automatic parallelism (pure)', () => {
  it('follows the work, between 3 and the cap of 8 (32 at most), so nothing idle is started', () => {
    expect([AUTO_MIN_AGENTS, DEFAULT_AGENT_CAP, AUTO_MAX_AGENTS, MAX_FIXED_AGENTS, PROJECT_MAX_AGENTS, APP_MAX_AGENTS]).toEqual([3, 8, 32, 32, 32, 96]);
    // The floor.
    expect(autoAgentLimit(load()).limit).toBe(3);
    expect(autoAgentLimit(load({ ready: 1, running: 1 })).limit).toBe(3);
    // Ready tasks plus the ones already running, up to the default cap.
    expect(autoAgentLimit(load({ ready: 4 })).limit).toBe(4);
    expect(autoAgentLimit(load({ ready: 4, running: 2 }))).toEqual({ limit: 6, why: '4 ready' });
    expect(autoAgentLimit(load({ ready: 8, running: 2 }))).toEqual({ limit: 8, why: '8 ready, 8 is the most at once in Settings' });
    expect(autoAgentLimit(load({ ready: 40, running: 5 })).limit).toBe(8);
    // The slider moves the ceiling, up to 32.
    expect(autoAgentLimit(load({ ready: 40, running: 5, cap: 6 }))).toEqual({ limit: 6, why: '40 ready, 6 is the most at once in Settings' });
    expect(autoAgentLimit(load({ ready: 40, running: 5, cap: 32 }))).toEqual({ limit: 32, why: '40 ready, 32 is the most at once in Settings' });
    expect(autoAgentLimit(load({ ready: 40, cap: 99 })).limit).toBe(32);
    expect(autoAgentLimit(load({ ready: 4, cap: 1 })).limit).toBe(1);
    expect(autoAgentLimit(load({ ready: 40, running: 1, cap: 2, capFrom: 'project' }))).toEqual({ limit: 2, why: '40 ready, 2 is the most at once set for this project' });
    expect(autoAgentLimit(load({ running: 4 }))).toEqual({ limit: 4, why: 'nothing else is ready' });
  });

  it('never goes slowly because usage is high: the same work costs the same usage fast or slow', () => {
    for (const used of [0.41, 0.75, 0.9, 0.99]) expect(autoAgentLimit(load({ ready: 4, accounts: [fiveHour(used)] })).limit, String(used)).toBe(4);
    expect(autoAgentLimit(load({ ready: 3, running: 1, accounts: [fiveHour(0.41)] }))).toEqual({ limit: 4, why: '3 ready' });
    expect(autoAgentLimit(load({ ready: 3, accounts: [fiveHour(0.9)] })).why).toBe('3 ready, usage 90% of the 5-hour window (work pauses at the limit and resumes in 2 h 10 min)');
    // Another account with room: the limit is not near.
    expect(autoAgentLimit(load({ ready: 3, accounts: [fiveHour(0.95), fiveHour(0.3)] })).why).toBe('3 ready');
    expect(autoAgentLimit(load({ ready: 3, accounts: [fiveHour(0.95), {}] })).why).toBe('3 ready');
    expect(fullestWindow({ ...fiveHour(0.2), seven_day: { utilization: 0.94, resetsAt: inMin(600) } }, NOW)).toMatchObject({ window: 'weekly', used: 0.94 });
    expect(fullestWindow({}, NOW)).toBeNull();
  });

  it('runs any number of builds side by side, keeping the app under 96 agents as a safety net', () => {
    expect(autoAgentLimit(load({ ready: 40, elsewhere: 40 })).limit).toBe(8);
    expect(projectCeiling(0)).toBe(32);
    expect(projectCeiling(64)).toBe(32);
    expect(projectCeiling(90)).toBe(6);
    expect(projectCeiling(93)).toBe(3);
    expect(projectCeiling(96)).toBe(1);
    expect(autoAgentLimit(load({ ready: 30, elsewhere: 94 }))).toEqual({ limit: 2, why: '30 ready, 2 is what 94 agents in other projects leave of 96 across the app' });
  });

  it('keeps at most the Studio limit (4 by default) of a build’s running tasks in Studio: the rest wait unstarted, off-Studio work goes ahead', () => {
    expect(STUDIO_AGENTS).toBe(4);
    expect(studioHeld(7, 0)).toBe(3);
    expect(studioHeld(5, 0, 2)).toBe(3);
    expect(studioHeld(5, 2, 2)).toBe(5);
    expect(studioHeld(1, 1)).toBe(0);
    // At a limit of two, two in Studio already: three ready Studio tasks wait, the one off Studio counts.
    const c = autoAgentLimit(load({ ready: 4, readyOffStudio: 1, running: 2, studioRunning: 2, studioCap: 2 }));
    expect(c).toEqual({ limit: 3, why: '4 ready, 3 of them wait for Studio (2 running tasks work there, 2 at most)' });
    expect(autoAgentLimit(load({ ready: 6, readyOffStudio: 2, running: 0, studioCap: 2 })).limit).toBe(4);
    expect(studioBound({ kind: 'implement', role: 'roblox-engineer', verification: [] })).toBe(true);
    expect(studioBound({ kind: 'implement', role: 'sound-designer', verification: [] })).toBe(false);
    expect(studioBound({ kind: 'implement', role: 'sound-designer', verification: [{ kind: 'playtest', name: 'x', durationSec: 5, failOnConsoleErrors: true }] })).toBe(true);
    expect(studioBound({ kind: 'plan', role: 'executive', verification: [] })).toBe(false);
  });

  it('says why a fixed number is what runs', () => {
    expect(fixedAgentWhy(5, 4)).toBe('5 ready, fixed at 4 in Settings');
    expect(fixedAgentWhy(0, 4, 10)).toBe('nothing else is ready, fixed at 4 in Settings');
    expect(fixedAgentWhy(4, 6, 93)).toBe('4 ready, fixed at 6 in Settings (3 now: 93 agents in other projects, 96 across the app)');
  });
});

describe('the agents-at-once preference', () => {
  const prefs = () => new AppPrefsService(new Store(':memory:', GLOBAL_MIGRATIONS));

  it('has a slider for the most at once: 8 by default, 1 to 32; older fixed numbers and saved defaults become it', () => {
    const p = prefs();
    expect(p.get().agentCap).toBe(8);
    for (const [asked, kept] of [[6, 6], [32, 32], [33, 32], [1, 1], [0, 8], [-4, 1], [50, 32], [3.6, 4]] as const) expect(p.set({ agentCap: asked }).agentCap, String(asked)).toBe(kept);
    const seeded = (value: unknown) => {
      const s = new AppPrefsService(new Store(':memory:', GLOBAL_MIGRATIONS));
      (s as unknown as { global: Store }).global.run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app.prefs', ?, ?)`, [JSON.stringify(value), new Date().toISOString()]);
      return s;
    };
    // 1.15.2's fixed 8, then 1.16's 4, then 1.16.1's default.
    expect(seeded({ maxConcurrentAgents: 8, agentThinking: 'faster' }).get()).toMatchObject({ agentCap: 8, maxConcurrentAgents: 0, agentEffort: 'medium' });
    expect(seeded({ agentCap: 20 }).get().agentCap).toBe(8);
    expect(seeded({ agentCap: 3 }).get().agentCap).toBe(3);
    expect(seeded({ agentCap: 20, maxConcurrentAgents: 12 }).get()).toMatchObject({ agentCap: 8, maxConcurrentAgents: 8 });
    // 1.16.0's saved defaults become today's; a number picked otherwise stays.
    expect(seeded({ agentCap: 6, agentCapV: 2 }).get().agentCap).toBe(6);
    expect(seeded({ agentCap: 4, agentCapV: 2, studioAgents: 2 }).get()).toMatchObject({ agentCap: 8, studioAgents: 4, agentCapV: 3 });
    expect(seeded({ agentCap: 5, agentCapV: 2, studioAgents: 1 }).get()).toMatchObject({ agentCap: 5, studioAgents: 1 });
    // A slider at its old top (8 agents, 3 in Studio) is at or below the new default: it moves up too.
    expect(seeded({ agentCap: 8, agentCapV: 2, studioAgents: 3 }).get()).toMatchObject({ agentCap: 8, studioAgents: 4, agentCapV: 3 });
    // Saved under these rules: kept as chosen, the old defaults included.
    expect(seeded({ agentCap: 4, agentCapV: 3, studioAgents: 2 }).get()).toMatchObject({ agentCap: 4, studioAgents: 2 });
    // A change in Settings saves under them.
    expect(seeded({ agentCap: 4, agentCapV: 2, studioAgents: 2 }).set({ autoSave: false })).toMatchObject({ agentCap: 8, studioAgents: 4, agentCapV: 3 });
  });

  it('is automatic by default and can be fixed up to 32', () => {
    const p = prefs();
    expect(p.get().maxConcurrentAgents).toBe(0);
    for (const [asked, kept] of [[0, 0], [2, 2], [6, 6], [32, 32], [33, 32], [99, 32], [-3, 0], [3.6, 4]] as const) expect(p.set({ maxConcurrentAgents: asked }).maxConcurrentAgents, String(asked)).toBe(kept);
  });

  it('opens five models at once by default (to eight at most)', () => {
    const p = prefs();
    expect(DEFAULT_APP_PREFS.modelingWorkspaces).toBe(8);
    expect(p.get().modelingWorkspaces).toBe(8);
    expect(p.set({ modelingWorkspaces: 0 }).modelingWorkspaces).toBe(8);
    expect(p.set({ modelingWorkspaces: 3 }).modelingWorkspaces).toBe(3);
    expect(p.set({ modelingWorkspaces: 40 }).modelingWorkspaces).toBe(24);
  });
});

const makeCore = coreHarness();

describe('the scheduler on Auto', () => {
  const ROLES = ['level-designer', 'environment-artist', 'modeler', 'sound-designer', 'vfx-artist', 'ui-engineer', 'roblox-engineer', 'luau-engineer', 'animator', 'game-designer', 'qa-engineer', 'security-engineer', 'performance-engineer', 'architect'];

  async function start(count: number) {
    let releaseWork!: () => void;
    const workBlocked = new Promise<void>((r) => (releaseWork = r));
    const made = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          await workBlocked;
          return { status: 'implemented', summary: 'done' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    const { core, ctx } = made;
    ctx.updateSettings({ maxConcurrentAgents: 0 });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Maze', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    const tasks = ROLES.slice(0, count).map((role, i) => ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: `Piece ${i + 1}`, objective: 'x', role, status: 'ready', createdBy: 'test' }));
    const running = () => tasks.filter((t) => ctx.tasks.get(t.id)!.status === 'running').length;
    return { ...made, tasks, running, releaseWork };
  }

  // Order of ROLES: level-designer and environment-artist work in Studio, modeler and sound-designer don't, and so on.
  // 14 tasks: 5 off Studio (modeler, sound, luau, game design, architect), 9 in it.
  it('runs 8 agents by default, at most 4 of them in Studio, and says why', async () => {
    const { core, ctx, tasks, running, releaseWork } = await start(14);
    core.orchestrator.resume();
    await waitFor(() => running() === 8, 30000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(running()).toBe(8);
    const inStudio = tasks.filter((t) => ctx.tasks.get(t.id)!.status === 'running' && studioBound(ctx.tasks.get(t.id)!)).length;
    expect(inStudio).toBe(4);
    expect(core.orchestrator.parallelLimit()).toEqual({ now: 8, auto: true, why: '6 ready, 5 of them wait for Studio (4 running tasks work there, 4 at most), 8 is the most at once in Settings' });
    expect(core.orchestrator.state()).toMatchObject({ activeRuns: 8, agents: { limit: 8, auto: true } });
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 120000);
  }, 180000);

  it('runs what is ready at 90% usage, and says the limit is near', async () => {
    const { core, running, releaseWork, tasks, ctx } = await start(4);
    core.usage.recordRateLimit('fake', { status: 'allowed_warning', window: 'five_hour', utilization: 0.9, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600, raw: {} });
    core.orchestrator.resume();
    await waitFor(() => running() === 4, 30000);
    await waitFor(() => /^nothing else is ready, usage 90% of the 5-hour window \(work pauses at the limit and resumes in (2 h|1 h 5\d min)\)$/.test(core.orchestrator.parallelLimit().why), 15000);
    expect(core.orchestrator.parallelLimit()).toMatchObject({ now: 4, auto: true });
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 90000);
  }, 180000);

  it('holds to this project’s own "most agents at once", and follows the app again when it is cleared', async () => {
    const { core, running, releaseWork, tasks, ctx } = await start(9);
    ctx.updateSettings({ agentCap: 2 });
    core.orchestrator.resume();
    await waitFor(() => running() === 2, 30000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(running()).toBe(2);
    expect(core.orchestrator.parallelLimit().why).toMatch(/^7 ready, .*2 is the most at once set for this project$/);
    ctx.updateSettings({ agentCap: null });
    core.orchestrator.kick();
    await waitFor(() => running() === 7, 30000);
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 90000);
  }, 180000);

  it('keeps under what the app’s other project windows leave of 96', async () => {
    const { core, running, releaseWork, tasks, ctx } = await start(9);
    core.setAgentsElsewhere(94);
    core.orchestrator.resume();
    await waitFor(() => running() === 2, 30000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(running()).toBe(2);
    expect(core.orchestrator.parallelLimit().why).toMatch(/2 is what 94 agents in other projects leave of 96 across the app$/);
    core.setAgentsElsewhere(0);
    await waitFor(() => running() === 7, 30000);
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 90000);
  }, 180000);

  // Three modelers waited 70–90 minutes each on Kiln builds and held all three places.
  it('an agent that only waits (a Kiln build, an upload) holds no place: ready work starts beside it', async () => {
    const { core, ctx, running, releaseWork, tasks } = await start(6);
    core.prefs.set({ studioAgents: 2 });
    ctx.updateSettings({ maxConcurrentAgents: 3 });
    core.orchestrator.resume();
    await waitFor(() => running() === 3, 30000);
    const busy = tasks.filter((t) => ctx.tasks.get(t.id)!.status === 'running');
    core.orchestrator.park(busy[0]!.id, true);
    core.orchestrator.park(busy[1]!.id, true);
    // The one ready task off Studio starts beside them; the two that need Studio wait (both waiting agents hold its places).
    await waitFor(() => running() === 4, 30000);
    expect(core.orchestrator.state()).toMatchObject({ working: 2, agents: { limit: 3 } });
    core.orchestrator.park(busy[0]!.id, false);
    core.orchestrator.park(busy[1]!.id, false);
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 90000);
  }, 180000);

  // 1.16: planning holds a place like any agent, and goes first when one frees up.
  it('planning takes a place and waits for one, then goes first in line', async () => {
    const { core, ctx, provider, running, releaseWork, tasks } = await start(6);
    ctx.updateSettings({ maxConcurrentAgents: 3 });
    core.orchestrator.resume();
    await waitFor(() => running() === 3, 30000);
    const goal = ctx.tasks.get(tasks[0]!.id)!.parentId!;
    const plan = ctx.tasks.create({ parentId: goal, kind: 'plan', title: 'Triage defects (1)', objective: 'x', role: 'executive', status: 'ready', createdBy: 'system' });
    core.orchestrator.kick();
    await new Promise((r) => setTimeout(r, 1500));
    expect(ctx.tasks.get(plan.id)!.status).toBe('ready');
    expect(provider.runs.some((r) => r.role === 'executive')).toBe(false);
    releaseWork();
    await waitFor(() => provider.runs.some((r) => r.role === 'executive'), 30000);
    // It started before any of the three tasks still waiting.
    const executive = provider.runs.findIndex((r) => r.role === 'executive');
    const builders = provider.runs.map((r, i) => (r.role !== 'executive' && r.role !== 'critic' ? i : -1)).filter((i) => i >= 0);
    expect(builders.filter((i) => i < executive).length).toBe(3);
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 90000);
  }, 180000);

  it('uses a number fixed in Settings as it is (Studio rule included), and says that', async () => {
    const { core, ctx, running, releaseWork, tasks } = await start(6);
    ctx.updateSettings({ maxConcurrentAgents: 4 });
    core.orchestrator.resume();
    await waitFor(() => running() === 4, 30000);
    await waitFor(() => core.orchestrator.parallelLimit().why === '2 ready, fixed at 4 in Settings', 15000);
    expect(core.orchestrator.parallelLimit()).toEqual({ now: 4, auto: false, why: '2 ready, fixed at 4 in Settings' });
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 90000);
  }, 180000);
});

// How many agents may be in Studio at once is a setting (1 to 16, 4 by default).
describe('agents in Studio at once (the setting)', () => {
  it('is 4 by default, 1 to 16, and the limit follows it', () => {
    expect([STUDIO_AGENTS, MAX_STUDIO_AGENTS]).toEqual([4, 16]);
    for (const [asked, kept] of [[undefined, 4], [0, 4], [1, 1], [3, 3], [16, 16], [17, 16], [2.4, 2], ['x', 4]] as const) expect(studioLimit(asked), String(asked)).toBe(kept);
    expect(studioHeld(5, 0, 3)).toBe(2);
    expect(studioHeld(5, 0, 1)).toBe(4);
    expect(autoAgentLimit(load({ ready: 4, readyOffStudio: 0, running: 0, studioCap: 3 }))).toEqual({ limit: 3, why: '4 ready, 1 of them wait for Studio (0 running tasks work there, 3 at most)' });
    const prefs = new AppPrefsService(new Store(':memory:', GLOBAL_MIGRATIONS));
    expect(prefs.get().studioAgents).toBe(4);
    expect(prefs.set({ studioAgents: 16 }).studioAgents).toBe(16);
    expect(prefs.set({ studioAgents: 99 }).studioAgents).toBe(16);
    expect(prefs.set({ studioAgents: 1 }).studioAgents).toBe(1);
  });

  it('holds the top of both sliders with far more work ready: 32 agents, 16 of them in Studio', async () => {
    let releaseWork!: () => void;
    const workBlocked = new Promise<void>((r) => (releaseWork = r));
    const made = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          await workBlocked;
          return { status: 'implemented', summary: 'done' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    const { core, ctx } = made;
    core.prefs.set({ agentCap: 32, studioAgents: 16 });
    ctx.updateSettings({ maxConcurrentAgents: 0 });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Maze', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    // 24 tasks that need Studio and 24 that don't.
    const tasks = Array.from({ length: 48 }, (_, i) => ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: `Piece ${i + 1}`, objective: 'x', role: i % 2 ? 'luau-engineer' : 'level-designer', status: 'ready', createdBy: 'test' }));
    const live = () => tasks.map((t) => ctx.tasks.get(t.id)!).filter((t) => t.status === 'running');
    core.orchestrator.resume();
    await waitFor(() => live().length === 32, 60000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(live().length).toBe(32);
    expect(live().filter((t) => studioBound(t)).length).toBe(16);
    expect(core.orchestrator.state()).toMatchObject({ activeRuns: 32, agents: { limit: 32, auto: true } });
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 240000);
  }, 360000);

  it('runs 3 in Studio when it is set to 3', async () => {
    let releaseWork!: () => void;
    const workBlocked = new Promise<void>((r) => (releaseWork = r));
    const made = await makeCore({
      respond: async (_req, kind) => {
        if (kind === 'work') {
          await workBlocked;
          return { status: 'implemented', summary: 'done' };
        }
        if (kind === 'review') return { verdict: 'pass', summary: 'ok', criteria: [], defects: [] };
        return null;
      },
    });
    const { core, ctx } = made;
    core.prefs.set({ studioAgents: 3 });
    ctx.updateSettings({ maxConcurrentAgents: 0 });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Maze', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    // Five tasks that all need Studio.
    const tasks = ['level-designer', 'environment-artist', 'vfx-artist', 'ui-engineer', 'roblox-engineer'].map((role, i) => ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: `Piece ${i + 1}`, objective: 'x', role, status: 'ready', createdBy: 'test' }));
    const running = () => tasks.filter((t) => ctx.tasks.get(t.id)!.status === 'running').length;
    core.orchestrator.resume();
    await waitFor(() => running() === 3, 30000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(running()).toBe(3);
    expect(core.orchestrator.parallelLimit().why).toMatch(/2 ready, 2 of them wait for Studio \(3 running tasks work there, 3 at most\)/);
    releaseWork();
    await waitFor(() => tasks.every((t) => ctx.tasks.get(t.id)!.status === 'done'), 90000);
  }, 180000);
});
