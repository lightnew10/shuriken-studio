import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDEAS, suggestionsFor } from '../src/core/director/suggestions';
import { START_IDEAS, StartIdeas } from '../src/core/director/start-ideas';
import { LiveSuggestions } from '../src/core/director/live-suggestions';
import { coreHarness } from './helpers/make-core';

/**
 * The start page's game ideas (1.14). The user: some bubbles "are not game ideas, instead game change suggestions",
 * "both the variety and quantity of game ideas there is limited", they should be written by Haiku from what the user
 * builds, and "the prompts contained within the suggestion bubbles on the start page should also be longer and
 * more detailed". And in a blank project the director's bubbles asked the user questions about a game that wasn't
 * there, built from a song they had tried in the Audio dock.
 */
const idea = (n: number) => ({ label: `Idea ${n}`, prompt: `A game number ${n}: ${'with a setting, a core loop, mechanics and progression. '.repeat(3)}` });

describe('hand-written ideas (the fallback)', () => {
  it('are whole new games with detailed first messages, never changes to a game the user has', () => {
    expect(IDEAS.length).toBeGreaterThanOrEqual(24);
    for (const i of IDEAS) {
      expect(i.label.length, i.label).toBeLessThanOrEqual(32);
      expect(i.prompt.length, i.label).toBeGreaterThan(200);
      expect(i.prompt, i.label).not.toMatch(/\b(my|our) (game|obby|tycoon|arena|map)\b|^Add\b/i);
    }
    expect(new Set(IDEAS.map((i) => i.label)).size).toBe(IDEAS.length);
  });

  it('lean about a third toward what the user builds, the rest fresh, in a daily order', () => {
    const projects = [{ name: 'Very Simple', description: 'an extremely simple drift game' }, { name: 'Sword Fighting Arena', description: 'pvp sword combat' }];
    const picked = suggestionsFor(projects, 6, 'Fri Oct 02 2026');
    expect(picked).toHaveLength(6);
    const near = picked.filter((p) => IDEAS.find((i) => i.label === p.label)!.tags.split(' ').some((t) => ['drift', 'sword', 'pvp', 'combat'].includes(t)));
    expect(near.length).toBeGreaterThanOrEqual(1);
    expect(near.length).toBeLessThanOrEqual(3);
    expect(suggestionsFor(projects, 6, 'Fri Oct 02 2026')).toEqual(picked);
    expect(suggestionsFor(projects, 6, 'Sat Oct 03 2026')).not.toEqual(picked);
  });
});

describe('ideas written for the user', () => {
  function setup(answer: () => unknown, projects = [{ name: 'Touge Drift', description: 'a chill drift game on a mountain pass' }]) {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-ideas-'));
    const prompts: string[] = [];
    const runner = {
      quick: async ({ prompt, role }: { prompt: string; role: { id: string } }) => {
        prompts.push(`${role.id}: ${prompt}`);
        const structured = answer();
        return structured ? { structured, costUsd: 0.002 } : null;
      },
    };
    const emitted: string[] = [];
    const bus = { emit: (e: string) => emitted.push(e) };
    const list = [...projects];
    const ideas = new StartIdeas({ runner: runner as never, bus: bus as never, log: { warn: () => {} } as never, file: join(dir, 'start-ideas.json'), cwd: dir, projects: () => list, enabled: () => true });
    return { ideas, prompts, emitted, list, file: join(dir, 'start-ideas.json') };
  }

  it('writes twelve from the projects, shows six at a time, and moves on with More ideas', async () => {
    const { ideas, prompts, emitted, file } = setup(() => ({ ideas: Array.from({ length: 12 }, (_, i) => idea(i + 1)) }));
    // Until written: the hand-written ones, and a set is asked for.
    expect(ideas.get(6)).toHaveLength(6);
    await ideas.refresh();
    expect(prompts[0]).toMatch(/^ideas: Write the start page's game ideas[\s\S]*Touge Drift: a chill drift game on a mountain pass/);
    expect(existsSync(file)).toBe(true);
    expect(emitted).toContain('start.ideas');
    expect(ideas.get(6).map((i) => i.label)).toEqual(['Idea 1', 'Idea 2', 'Idea 3', 'Idea 4', 'Idea 5', 'Idea 6']);
    expect(ideas.more(6)).toBe(true);
    expect(ideas.get(6).map((i) => i.label)).toEqual(['Idea 7', 'Idea 8', 'Idea 9', 'Idea 10', 'Idea 11', 'Idea 12']);
  });

  it('writes again when the projects change, at most every ten minutes, and tells the model what it showed last time', async () => {
    const { ideas, prompts, list } = setup(() => ({ ideas: Array.from({ length: 8 }, (_, i) => idea(i + 1)) }));
    await ideas.refresh();
    expect(prompts).toHaveLength(1);
    list.unshift({ name: 'Haunted School', description: 'horror escape' });
    ideas.get(6);
    // Throttled: the last try was a moment ago.
    expect(prompts).toHaveLength(1);
    const saved = START_IDEAS.throttleMs;
    START_IDEAS.throttleMs = 0;
    try {
      ideas.get(6);
      await new Promise((r) => setTimeout(r, 20));
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatch(/Haunted School[\s\S]*Ideas they were shown last time \(write different ones\): Idea 1; Idea 2/);
    } finally {
      START_IDEAS.throttleMs = saved;
    }
  });

  it('keeps the hand-written ones when the model answers too few or too short', async () => {
    const { ideas, file } = setup(() => ({ ideas: [idea(1), { label: 'Short', prompt: 'too short' }] }));
    expect(await ideas.refresh()).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(ideas.get(6).every((i) => IDEAS.some((h) => h.label === i.label))).toBe(true);
  });
});

describe('the director’s bubbles in a project with no game yet', () => {
  const makeCore = coreHarness();
  it('are games to start, not questions about a game that is not there; with a goal, the game’s own', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const games = [{ label: 'Touge drift battles', prompt: 'A mountain touge drifting game ...' }];
    const live = new LiveSuggestions({ runner: core.runner, bus: core.bus, log: core.logger.scope('test'), enabled: () => false, ideas: () => games });
    expect(live.get(ctx, 'director')).toEqual(games);
    ctx.tasks.create({ kind: 'objective', title: 'A drift game', objective: 'x', role: 'executive', status: 'running', createdBy: 'test' });
    expect(live.get(ctx, 'director')).toBeNull();
  });

  it('the app-level call reaches the fast model with no tools and gives back its answer', async () => {
    const { core, provider } = await makeCore({ respond: async (req) => (req.role === 'ideas' ? { ideas: [idea(1)] } : null) });
    const { ROLES } = await import('../src/core/agents/roles');
    const out = await core.runner.quick({ role: ROLES.ideas!, prompt: 'Write ideas', cwd: tmpdir(), signal: new AbortController().signal });
    expect(out?.structured).toEqual({ ideas: [idea(1)] });
    const run = provider.runs.find((r) => r.role === 'ideas')!;
    expect(run.modelTier).toBe('fast');
    expect(run.toolServers).toEqual([]);
    expect(run.builtinTools).toEqual([]);
  });
});
