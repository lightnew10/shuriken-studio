import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';
import { RESUME_HELD, STILL_STOPPED, asksHalt, asksResume, commandGate, requestsWork } from '../src/core/director/commands';
import { coreHarness, waitFor } from './helpers/make-core';

/** The real message from 2026-10-05: an opinion about the automatic milestones, said right after "stop". */
const OPINION = 'this is actually good for autonomous complex builds, I"ve changed my mind on it.';

describe('what counts as the user asking to resume, pause or stop', () => {
  it('resume: only the word to go on, never an opinion, a question about it, or a "not yet"', () => {
    for (const yes of ['resume', 'ok carry on', 'go on', 'start it again', 'can you resume?', 'Resume the team', 'continue please', 'resume just the build I asked for, the rest can be killed', 'keep going'])
      expect(asksResume(yes), yes).toBe(true);
    for (const no of [OPINION, "what's going on?", 'I like that it continues on its own', "don't resume yet", 'should I resume?', 'nice work', 'From the UI copilot: resume the team', 'it keeps going on its own'])
      expect(asksResume(no), no).toBe(false);
  });

  it('pause and stop: broad, since a false yes only holds work back, but never "don\'t stop"', () => {
    for (const yes of ['bro, no, stop.', 'pause for now', 'hold on', 'kill them', 'stop everything', 'that\'s it for now'])
      expect(asksHalt(yes), yes).toBe(true);
    for (const no of ["don't stop", 'keep going', 'no need to pause', OPINION, 'should I pause?'])
      expect(asksHalt(no), no).toBe(false);
  });

  it('a request for work counts as "go" for a stopped team; an opinion does not', () => {
    for (const yes of ['add a big EXIT sign to the test area', 'can you make the range open?', 'I want quick teleports', 'fix the lobby button'])
      expect(requestsWork(yes), yes).toBe(true);
    for (const no of [OPINION, 'the range is mediocre?', 'cool'])
      expect(requestsWork(no), no).toBe(false);
  });

  it('turns a resume or a stop the message did not ask for into a plain answer', () => {
    expect(commandGate(OPINION, { intent: 'resume', reply: 'x' } as never)).toMatchObject({ out: { intent: 'chat' }, heldBack: 'resume' });
    expect(commandGate('nice', { intent: 'stop', reply: 'x', resumeInMinutes: 30 } as never)).toMatchObject({ out: { intent: 'chat' }, heldBack: 'halt' });
    expect(commandGate('resume', { intent: 'resume', reply: 'x' } as never)).toMatchObject({ out: { intent: 'resume' }, heldBack: null });
  });

  it('is in the director\'s instructions, with the real example', () => {
    expect(ROLES.director!.instructions).toMatch(/Commands vs opinions/);
    expect(ROLES.director!.instructions).toMatch(/I've changed my mind on it/);
  });
});

const makeCore = coreHarness();

describe('the director with a stopped team', () => {
  it('answers an opinion and leaves the team stopped, even when the model wanted to resume it', async () => {
    const { core } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('intent' in props)) return null;
        // What the model did on 2026-10-05.
        return { intent: 'resume', reply: "Glad it works for you. Since the team was stopped because of the milestone planning, I'm resuming it." };
      },
    });
    await core.orchestrator.stop();
    expect(core.orchestrator.state().paused).toBe(true);
    core.director.send(OPINION);
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.kind === 'text'));
    expect(core.orchestrator.state().paused).toBe(true);
    const reply = chat.list().filter((m) => m.role === 'director' && m.kind === 'text').at(-1)!.text;
    expect(reply).toBe(RESUME_HELD);
    expect(reply).not.toMatch(/I'm resuming/);
  });

  it('keeps a stopped team stopped when an opinion is read as a change, and says the change waits', async () => {
    const { core } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('intent' in props)) return null;
        return { intent: 'change', reply: 'Got it, I noted that.', request: 'Prefer automatic milestones for complex builds' };
      },
    });
    await core.orchestrator.stop();
    core.director.send(OPINION);
    const chat = core.director.chat()!;
    await waitFor(() => chat.list().some((m) => m.role === 'director' && m.kind === 'text'));
    expect(core.orchestrator.state().paused).toBe(true);
    expect(chat.list().filter((m) => m.role === 'director' && m.kind === 'text').at(-1)!.text).toContain(STILL_STOPPED);
  });

  it('resumes on the word; after a stop a plain request is planned but waits for "resume" (1.15.8)', async () => {
    const { core } = await makeCore({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if (!('intent' in props)) return null;
        return /resume/i.test(String(req.prompt)) && !/EXIT/.test(String(req.prompt)) ? { intent: 'resume', reply: 'Resuming.' } : { intent: 'side_task', role: 'level-designer', reply: 'On it, starting now.', request: 'Add a big EXIT sign', title: 'EXIT sign' };
      },
    });
    await core.orchestrator.stop();
    core.director.send('resume');
    await waitFor(() => !core.orchestrator.state().paused, 10000);
    await core.orchestrator.stop();
    core.director.send('add a big EXIT sign to the test area');
    const said = await waitFor(() => core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === 'text').at(-1)?.text.includes('stopped') ? core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === 'text').at(-1)!.text : null, 10000);
    expect(core.orchestrator.state().paused).toBe(true);
    // The reply said "starting now": the app put the truth in its place.
    expect(said).not.toMatch(/starting now/);
    expect(said).toMatch(/The team is stopped|still stopped/);
    core.director.send('add a big EXIT sign to the test area and resume');
    await waitFor(() => !core.orchestrator.state().paused, 10000);
  });
});
