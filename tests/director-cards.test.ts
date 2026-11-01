import { describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core';
import type { AgentRunRequest } from '../src/core/providers/types';
import { OUTPUT_SCHEMAS, ROLES } from '../src/core/agents/roles';
import { asksClearCard, pickedOption, timesSaid } from '../src/core/director/cards';
import { handsOff } from '../src/core/director/look';
import type { ChatMessage, Escalation } from '../src/shared/domain';
import { coreHarness, waitFor } from './helpers/make-core';

/**
 * 2026-10-06/07: a card ("Critic rejected the store-art carve-out") whose task was replaced two minutes after it opened
 * stayed open for about 21 hours and was mentioned in about 21 of the director's replies; in another project the user
 * wrote "the card is outdated and no longer applies, forget it" and was told "I can't dismiss that card from the chat".
 */
const makeCore = coreHarness();
const isDirector = (req: AgentRunRequest) => 'intent' in ((req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
const replies = (core: Core) => core.director.chat()!.list().filter((m) => m.role === 'director' && m.kind === 'text').map((m) => m.text);
const card = (over: Partial<Escalation> = {}): Escalation => ({ id: 'esc_1', taskId: null, runId: null, kind: 'question', title: 'Critic rejected the store-art carve-out', detail: '', options: ['Upload the 19 PNGs yourself', 'Split into a blocked follow-up', 'Texture workaround'], status: 'open', response: null, createdAt: '2026-10-06T08:25:00.000Z', resolvedAt: null, ...over });

describe('cards close when they no longer apply', () => {
  it("closes a card when its task is done or cancelled, and leaves the task as it is", async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Store', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const task = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Store art', objective: 'x', role: 'ui-engineer', status: 'escalated', createdBy: 'executive' });
    const e = ctx.governance.escalate({ kind: 'question', title: 'Critic rejected the store-art carve-out', detail: 'x', taskId: task.id, options: ['a', 'b'] });
    core.orchestrator.cancel(task.id, 'Replaced by "Store cards: group-owned art"', 'executive');
    await waitFor(() => ctx.governance.escalation(e.id)?.status === 'dismissed');
    expect(ctx.governance.escalation(e.id)?.response).toMatch(/No longer needed: "Store art" was cancelled or replaced/);
    expect(ctx.tasks.get(task.id)?.status).toBe('cancelled');
    // A dismissed card never puts its task back in the queue (an answer would).
    const other = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Sign fix', objective: 'x', role: 'ui-engineer', status: 'escalated', createdBy: 'executive' });
    const e2 = ctx.governance.escalate({ kind: 'question', title: 'Studio playtests can not bind', detail: 'x', taskId: other.id, options: [] });
    ctx.governance.dismiss(e2.id, 'Cleared by you.', 'user');
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.tasks.get(other.id)?.status).toBe('escalated');
    expect(ctx.governance.dismiss(e2.id, 'again')).toBeNull(); // only open cards
  });

  it('a goal that finishes closes the cards of its tasks', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const goal = ctx.tasks.create({ kind: 'objective', title: 'Lobby', objective: 'x', role: 'executive', status: 'running', createdBy: 'user' });
    const t = ctx.tasks.create({ parentId: goal.id, kind: 'implement', title: 'Sign', objective: 'x', role: 'ui-engineer', status: 'blocked', createdBy: 'executive' });
    const e = ctx.governance.escalate({ kind: 'question', title: 'Sign blocked on Studio', detail: 'x', taskId: t.id });
    core.orchestrator.cancel(goal.id);
    await waitFor(() => ctx.governance.escalation(e.id)?.status === 'dismissed');
  });
});

describe('the user’s word to clear or answer a card', () => {
  it('reads "clear it" and "it no longer applies", never a question or an opinion', () => {
    for (const yes of ['forget that card', 'clear the store-art question', 'the card is outdated and no longer applies, forget it', 'dismiss those cards', "that card doesn't apply anymore"]) expect(asksClearCard(yes), yes).toBe(true);
    for (const no of ['what does that card mean?', 'the bow is still skewed on phones', 'resume the team']) expect(asksClearCard(no), no).toBe(false);
  });

  it('finds the button the user picked: its words, its number, its place', () => {
    const c = card();
    expect(pickedOption(c, 'go with option 2')).toBe('Split into a blocked follow-up');
    expect(pickedOption(c, 'the third one')).toBe('Texture workaround');
    expect(pickedOption(c, "I'll upload the 19 PNGs myself, upload the 19 pngs yourself is fine")).toBe('Upload the 19 PNGs yourself');
    expect(pickedOption(c, 'split it', 'Split into a blocked follow-up')).toBe('Split into a blocked follow-up');
    expect(pickedOption(c, 'sounds good', 'Split into a blocked follow-up')).toBeNull();
    expect(pickedOption(card({ options: [] }), 'option 1')).toBeNull();
  });

  it('counts the replies that already talked about a card', () => {
    const said = (text: string, at = '2026-10-06T18:00:00.000Z'): ChatMessage => ({ id: text, role: 'director', kind: 'text', text, data: null, createdAt: at }) as ChatMessage;
    const c = card();
    expect(timesSaid(c, [said('The store-art card about the 19 PNGs is still waiting.'), said('Nothing needs you.'), said('The critic rejected the carve-out.'), said('The store-art carve-out card', '2026-10-05T00:00:00.000Z')])).toBe(2);
  });
});

describe('the director clears and answers cards', () => {
  it('knows it can, and the schema carries the cards', () => {
    expect((OUTPUT_SCHEMAS.director as { properties: Record<string, unknown> }).properties.cards).toBeTruthy();
    expect(ROLES.director!.instructions).toMatch(/"action": "dismiss"/);
    expect(handsOff({ intent: 'chat', reply: 'ok', cards: [{ card: 'esc_1', action: 'dismiss' }] })).toMatchObject({ dropped: true, out: { cards: [] } });
  });

  it('clears a card at the user’s word, and lists cards with their task and how often they were said', async () => {
    let cardId = '';
    let seen = '';
    const h = await makeCore({
      respond: async (req) => {
        if (!isDirector(req)) return null;
        seen = req.prompt ?? '';
        return { intent: 'chat', reply: 'Cleared it.', cards: [{ card: cardId, action: 'dismiss' }] };
      },
    });
    h.core.orchestrator.pause();
    const t = h.ctx.tasks.create({ kind: 'implement', title: 'Store art', objective: 'x', role: 'ui-engineer', status: 'escalated', createdBy: 'executive' });
    cardId = h.ctx.governance.escalate({ kind: 'question', title: 'Critic rejected the store-art carve-out', detail: 'x', taskId: t.id, options: ['Upload them yourself', 'Split'] }).id;
    h.core.director.send('the store-art card is outdated, forget it');
    await waitFor(() => replies(h.core).length > 0);
    expect(h.ctx.governance.escalation(cardId)?.status).toBe('dismissed');
    expect(h.ctx.governance.escalation(cardId)?.response).toMatch(/Cleared at your word/);
    expect(seen).toMatch(new RegExp(`card id:${cardId} "Critic rejected the store-art carve-out" \\[buttons: Upload them yourself \\| Split\\] — about "Store art" \\(escalated\\)`));
  });

  it('answers a card with the button the user picked, and never on its own reading', async () => {
    let cardId = '';
    let words = 'go with option 2';
    const h = await makeCore({ respond: async (req) => (isDirector(req) ? { intent: 'chat', reply: 'Done.', cards: [{ card: cardId, action: 'answer', answer: 'Split' }] } : null) });
    h.core.orchestrator.pause();
    cardId = h.ctx.governance.escalate({ kind: 'question', title: 'Store art route', detail: 'x', options: ['Upload them yourself', 'Split'] }).id;
    h.core.director.send('what is that store card about?');
    await waitFor(() => replies(h.core).length > 0);
    expect(h.ctx.governance.escalation(cardId)?.status).toBe('open');
    expect(replies(h.core).at(-1)).toMatch(/tell me which button you pick/);
    h.core.director.send(words);
    await waitFor(() => h.ctx.governance.escalation(cardId)?.status === 'answered');
    expect(h.ctx.governance.escalation(cardId)?.response).toBe('Split');
    words = '';
  });
});
