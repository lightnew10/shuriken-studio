import { describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core';
import type { AgentRunRequest } from '../src/core/providers/types';
import { OUTPUT_SCHEMAS, ROLES } from '../src/core/agents/roles';
import { asksFreeStudio } from '../src/core/director/director';
import { handsOff } from '../src/core/director/look';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * 2026-10-06: an agent's playtest held Studio for 90 minutes after Studio hung under it. The user asked the director
 * "is the playtest lock cleared?", then "kill that agent", then "we are not in a playtest, what do I do??", and was
 * told "I have no control that releases the lock directly". It has one now, for the user's own words only.
 */
const makeCore = coreHarness();
const isDirector = (req: AgentRunRequest) => 'intent' in ((req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
const replies = (core: Core) => core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === 'text').map((m) => m.text);

describe('the director frees Studio when the user asks', () => {
  it('knows it can, and only for the words of the message', () => {
    expect((OUTPUT_SCHEMAS.director as { properties: Record<string, unknown> }).properties.freeStudio).toBeTruthy();
    expect(ROLES.director!.instructions).toMatch(/set "freeStudio": true/);
    expect(handsOff({ intent: 'chat', reply: 'ok', freeStudio: true })).toMatchObject({ dropped: true, out: { freeStudio: false } });
    for (const yes of ['free studio', 'clear the playtest lock please', 'release the lock', 'kill whatever is holding studio', 'is the lock cleared? clear it']) expect(asksFreeStudio(yes), yes).toBe(true);
    for (const no of ['the bow is skewed on phones', 'how long do playtests take?', 'add a lock-on to the bow']) expect(asksFreeStudio(no), no).toBe(false);
  });

  it('stops the stuck playtest, frees Studio, and says what it freed', async () => {
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? { intent: 'chat', reply: 'Freeing Studio now.', freeStudio: true } : null) });
    h.core.orchestrator.pause();
    (h.core.studio as unknown as { setPlaying: () => Promise<unknown> }).setPlaying = async () => ({ mode: 'Edit', availableDataModels: ['Edit'], focused: 'Edit', raw: '' });
    h.core.lease.tryAcquire('run_audio');
    await h.core.director.send('free studio, the playtest lock is stuck');
    await waitFor(() => replies(h.core).find((t) => t.includes('Freed Studio')));
    expect(h.core.lease.holder).toBeNull();
    expect(h.core.lease.reclaimReasons.get('run_audio')).toBe('freed');
    expect(replies(h.core).at(-1)).toMatch(/Freeing Studio now\.[\s\S]*Freed Studio from another agent \(run_audio\)/);
  });

  it("never on the model's reading alone: a message that doesn't ask leaves Studio as it is", async () => {
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? { intent: 'chat', reply: 'Noted.', freeStudio: true } : null) });
    h.core.orchestrator.pause();
    h.core.lease.tryAcquire('run_audio');
    await h.core.director.send('the bow is skewed on phones');
    await waitFor(() => replies(h.core).length > 0);
    expect(h.core.lease.holder?.owner).toBe('run_audio');
    expect(replies(h.core).at(-1)).toMatch(/To free Studio, say so in plain words/);
  });
});
