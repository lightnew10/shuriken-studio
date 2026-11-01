import { describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core';
import type { AgentRunRequest } from '../src/core/providers/types';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * 1.15.9: a message sent while the Claude account was at its usage limit was answered "at its usage limit" and then never
 * again, even after the reset. Now it is kept with the project and carried out when the limit resets (or another
 * account is chosen, or the project opens again).
 */
const makeCore = coreHarness();
const isDirector = (req: AgentRunRequest) => 'intent' in ((req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
const said = (core: Core, kind: string) => core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === kind).map((m) => m.text);
const limit = () => Object.assign(new Error("You've hit your session limit"), { errorKind: 'rate_limit' });

describe('messages sent at a usage limit', () => {
  it('are kept, and carried out together, in order, once the account can answer', async () => {
    let limited = true;
    const prompts: string[] = [];
    const h = await makeCore({
      respond: async (req) => {
        if (!isDirector(req)) return null;
        prompts.push(String(req.prompt));
        if (limited) throw limit();
        return { intent: 'chat', reply: 'Done: the sword is blue and the lobby sign is up.' };
      },
    });
    h.core.orchestrator.pause();
    h.core.director.send('make the sword blue');
    await waitFor(() => said(h.core, 'error').length === 1);
    expect(said(h.core, 'error')[0]).toMatch(/^Your Claude account is at its usage limit\. I'll answer this as soon as it resets, or right away if you switch accounts/);
    expect(h.ctx.extras().heldMessages?.map((m) => m.text)).toEqual(['make the sword blue']);
    // Another message while it is still at the limit: both are kept, and the reply says so.
    h.core.director.send('and add a lobby sign');
    await waitFor(() => said(h.core, 'error').length === 2);
    expect(said(h.core, 'error')[1]).toMatch(/I'll answer your messages as soon as it resets/);
    expect(h.ctx.extras().heldMessages?.map((m) => m.text)).toEqual(['make the sword blue', 'and add a lobby sign']);
    expect(said(h.core, 'text')).toEqual([]);
    // The account has room again (here: another account is chosen): both are answered in one reply, oldest first.
    limited = false;
    const before = prompts.length;
    h.core.bus.emit('accounts.changed', { providerId: 'claude', activeId: null });
    await waitFor(() => said(h.core, 'text').length === 1, 20_000);
    expect(said(h.core, 'text')[0]).toContain('the sword is blue');
    const last = prompts.at(-1)!;
    expect(prompts.length).toBe(before + 1);
    expect(last).toMatch(/\(1\) make the sword blue[\s\S]*\(2\) and add a lobby sign/);
    expect(last).toMatch(/These messages were written while the Claude account was at its usage limit[\s\S]*carry them out now/);
    expect(h.ctx.extras().heldMessages).toEqual([]);
    // Nothing more is said about the limit once they are answered.
    expect(said(h.core, 'error')).toHaveLength(2);
  }, 60_000);

  it('a retry that meets the limit again says nothing new, and a new message goes after the held one', async () => {
    let limited = true;
    const prompts: string[] = [];
    const h = await makeCore({
      respond: async (req) => {
        if (!isDirector(req)) return null;
        prompts.push(String(req.prompt));
        if (limited) throw limit();
        return { intent: 'chat', reply: 'Both handled.' };
      },
    });
    h.core.orchestrator.pause();
    h.core.director.send('stop the final reviewer');
    await waitFor(() => said(h.core, 'error').length === 1);
    // Tried again while still limited: quiet, still kept.
    h.core.bus.emit('accounts.changed', { providerId: 'claude', activeId: null });
    await waitFor(() => prompts.length === 2, 20_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(said(h.core, 'error')).toHaveLength(1);
    expect(h.ctx.extras().heldMessages?.map((m) => m.text)).toEqual(['stop the final reviewer']);
    // The limit resets and the user writes before the retry: the held message comes first, in the same reply.
    limited = false;
    h.core.director.send('also make the music louder');
    await waitFor(() => said(h.core, 'text').length === 1);
    expect(prompts.at(-1)).toMatch(/\(1\) stop the final reviewer[\s\S]*\(2\) also make the music louder/);
    expect(prompts.at(-1)).toMatch(/The first message was written while the Claude account was at its usage limit/);
    expect(h.ctx.extras().heldMessages).toEqual([]);
  }, 60_000);
});
