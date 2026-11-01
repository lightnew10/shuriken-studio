import { describe, expect, it } from 'vitest';
import { DRAFT_DOCKS, addOutcome, dockIntro, dockItems, draftActions, draftRefs, isDraftDock, standing, standingLine } from '../../src/renderer/src/lib/workshop-drafts';

// What a copilot makes stays a draft in its dock until the user adds it: the chat's draft card and the pages'
// Add to game button (the user: "It should stay in their respective container previews so the viewer can
// iterate until they choose to click the import button or explicitly authorize it").

describe('drafts in the docks', () => {
  it('knows which docks add a draft with one call, and what each calls', () => {
    expect(isDraftDock('effects')).toBe(true);
    expect(isDraftDock('audio')).toBe(true);
    expect(isDraftDock('animation')).toBe(true);
    // A UI mockup is built into the game by its copilot (the mockup's Put it in the game button), not by a call.
    expect(isDraftDock('ui')).toBe(false);
    expect(DRAFT_DOCKS.effects).toMatchObject({ list: 'effects.list', use: 'effects.use', key: 'effects' });
    expect(DRAFT_DOCKS.animation).toMatchObject({ list: 'animations.list', use: 'animations.use', key: 'animations' });
    expect(DRAFT_DOCKS.audio).toMatchObject({ list: 'audio.list', use: 'audio.use', key: 'sounds' });
  });

  it("reads a reply's drafts from stored chat data, dropping what isn't one", () => {
    expect(draftRefs([{ name: 'HitSpark2', draft: true, of: 'HitSpark' }, { name: 'Dust' }, { draft: true }, 'x', null, { name: '' }])).toEqual([{ name: 'HitSpark2', draft: true, of: 'HitSpark' }, { name: 'Dust' }]);
    expect(draftRefs(undefined)).toEqual([]);
    expect(draftRefs('nope')).toEqual([]);
    expect(draftRefs(Array.from({ length: 12 }, (_, i) => ({ name: `E${i}`, draft: true })))).toHaveLength(6);
  });

  it('tells where a draft stands now: still a draft, in the game since, or gone', () => {
    const items = dockItems('effects', { effects: [{ name: 'HitSpark' }, { name: 'HitSpark2', draft: true, draftOf: 'HitSpark' }], presets: [] })!;
    expect([...items.entries()]).toEqual([
      ['HitSpark', { draft: false }],
      ['HitSpark2', { draft: true, of: 'HitSpark' }],
    ]);
    expect(standing({ name: 'HitSpark2', draft: true }, items)).toBe('draft');
    // Added since the reply (on the page, or by a later turn): the card says so and offers nothing more.
    expect(standing({ name: 'HitSpark', draft: true }, items)).toBe('in-game');
    expect(standing({ name: 'Dust', draft: true }, items)).toBe('gone');
    // Before the dock's list has answered: what the reply recorded.
    expect(dockItems('effects', undefined)).toBeNull();
    expect(standing({ name: 'Dust', draft: true }, null)).toBe('draft');
    expect(standing({ name: 'Dust' }, null)).toBe('in-game');
    expect(dockItems('audio', { sounds: [{ name: 'Jump', draft: true }, { name: 'Coin' }] })!.get('Jump')).toEqual({ draft: true });
    expect(dockItems('animation', { animations: [{ name: 'Slash1' }, { name: 'Slash1_2', draft: true, draftOf: 'Slash1' }] })!.get('Slash1_2')).toEqual({ draft: true, of: 'Slash1' });
  });

  it('never calls a draft part of the game', () => {
    expect(standingLine('effects', { name: 'Dust', draft: true }, 'draft')).toBe('Draft effect · not in the game');
    expect(standingLine('audio', { name: 'Jump', draft: true }, 'draft')).toBe('Draft sound · not in the game');
    expect(standingLine('animation', { name: 'Slash1_2', draft: true, of: 'Slash1' }, 'draft')).toBe('Draft · a new take of Slash1 · not in the game');
    expect(standingLine('effects', { name: 'Dust' }, 'in-game')).toBe('In the game');
    expect(standingLine('effects', { name: 'Dust', draft: true }, 'gone')).toMatch(/No longer here/);
    for (const dock of ['animation', 'audio', 'ui', 'effects'] as const) {
      expect(dockIntro(dock), dock).toMatch(/goes into your game only when you/);
      expect(dockIntro(dock), dock).not.toMatch(/right away/);
    }
  });

  it('offers Add to game, and Replace for a new take of something the game still has', () => {
    expect(draftActions('effects', { name: 'Dust' })).toEqual([{ label: 'Add to game', title: 'Put this effect in your game as Dust', params: { name: 'Dust' }, primary: true }]);
    const take = draftActions('animation', { name: 'Slash1_2', of: 'Slash1' }, (n) => n === 'Slash1');
    expect(take.map((a) => [a.label, a.params, a.primary])).toEqual([
      ['Replace Slash1', { name: 'Slash1_2', as: 'Slash1' }, true],
      ['Add as new', { name: 'Slash1_2' }, false],
    ]);
    // The one it was a take of is gone from the game: only Add to game is left.
    expect(draftActions('animation', { name: 'Slash1_2', of: 'Slash1' }, () => false).map((a) => a.label)).toEqual(['Add to game']);
  });

  it("says what an Add to game came to: an error, a note when Studio wasn't there, or nothing", () => {
    expect(addOutcome({ ok: true, text: '{}', data: { name: 'Dust', built: true } })).toEqual({ ok: true, note: null });
    expect(addOutcome({ ok: true, text: '{}', data: { name: 'Dust', built: false, note: 'Studio is not connected; world/Effects.luau builds the effects on the next world_rebuild.' } })).toEqual({
      ok: true,
      note: 'Studio is not connected; world/Effects.luau builds the effects on the next world_rebuild.',
    });
    expect(addOutcome({ ok: true, text: '{}', data: { built: true, standInTextures: ['Smoke (until it is uploaded: a built-in puff)'] } }).note).toMatch(/Not uploaded yet, so the game shows a stand-in: Smoke/);
    expect(addOutcome({ ok: false, text: 'No effect named Dust' })).toEqual({ ok: false, note: 'No effect named Dust' });
    expect(addOutcome(null)).toEqual({ ok: false, note: 'No answer.' });
  });
});
