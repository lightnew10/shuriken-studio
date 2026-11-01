import { describe, expect, it } from 'vitest';
import type { MockupSummary } from '../src/shared/ui-mockup';
import { applyTarget, parseMockupItem, uiTurnMode } from '../src/core/copilots/ui-intent';
import { COPILOT_IMPORT_ROLES, COPILOT_ROLES, UI_CODE } from '../src/core/copilots/copilot-roles';
import { hiddenToolsFor, ROLES } from '../src/core/agents/roles';
import { MockupStore } from '../src/core/ui/ui-mockups';
import { coreHarness, waitFor } from './helpers/make-core';

// The UI copilot designs in Shuriken by default (mockups on the UI page) and changes the game only when the
// user says to put it in the game. The user's complaint: "the UI designer copilot was putting what I asked
// for straight into Roblox studio, when all I wanted was to experiment with mockups inside the container."

const makeCore = coreHarness();

describe('what a message to the UI copilot asks for', () => {
  it('designs unless the user asks for the game', () => {
    for (const t of [
      'Design a clean HUD with health and coins',
      'show me three ideas for the shop',
      'make the shop work on phones',
      'build me a health bar',
      'add a shop button to the HUD',
      'apply a gradient to the buttons',
      'the coin counter overlaps the jump button in the game',
      'Put a coin counter in the top right',
      'what would the shop look like in the game?',
      "Don't put it in the game yet, just show me",
      'move the title in place of the logo',
    ])
      expect(uiTurnMode(t), t).toBe('draft');
    for (const t of [
      'Put it in the game',
      'put version B in the game please',
      'add it to the game',
      'build it',
      'Build B',
      'apply B',
      'apply the mockup',
      'Ship the sword shop mockup',
      'use B in my game',
      'fix the overlap in the game',
      'put the HUD into Studio',
      'apply',
      'Put the “Sword shop” mockup, version A, in the game.',
      'The coin counter is just a plain label. Make it look great and update live with the Coins leaderstat. Just make it.',
    ])
      expect(uiTurnMode(t), t).toBe('import');
  });

  it('takes a plain yes to its offer as the go-ahead, but not a yes with changes', () => {
    expect(uiTurnMode('yes', { offered: true })).toBe('import');
    expect(uiTurnMode('Sounds good, go ahead!', { offered: true })).toBe('import');
    expect(uiTurnMode('yes', { offered: false })).toBe('draft');
    expect(uiTurnMode('yes but make the buttons bigger', { offered: true })).toBe('draft');
    expect(uiTurnMode('ok, try a darker one', { offered: true })).toBe('draft');
  });

  it('finds the mockup and version meant: named, on screen, picked, or the latest', () => {
    const v = (id: string) => ({ id, note: id, createdAt: '2026-10-01T00:00:00.000Z' });
    const mockups: MockupSummary[] = [
      { name: 'sword-shop', title: 'Sword shop', versions: [v('A'), v('B'), v('C')], chosen: 'B', updatedAt: '2026-10-01T00:00:00.000Z' },
      { name: 'combat-hud', title: 'Combat HUD', versions: [v('A'), v('B')], updatedAt: '2026-10-01T00:00:00.000Z' },
    ];
    expect(parseMockupItem('mockup:sword-shop@C')).toEqual({ name: 'sword-shop', version: 'C' });
    expect(parseMockupItem('Shop.Window')).toBeNull();
    expect(applyTarget('put the combat HUD in the game', null, null, mockups)).toEqual({ name: 'combat-hud', version: 'B' });
    expect(applyTarget('put version A of the sword shop in the game', null, null, mockups)).toEqual({ name: 'sword-shop', version: 'A' });
    expect(applyTarget('build it', 'mockup:sword-shop@C', null, mockups)).toEqual({ name: 'sword-shop', version: 'C' });
    expect(applyTarget('build it', 'mockup:sword-shop', null, mockups)).toEqual({ name: 'sword-shop', version: 'B' });
    expect(applyTarget('yes', null, { name: 'combat-hud', version: 'A' }, mockups)).toEqual({ name: 'combat-hud', version: 'A' });
    expect(applyTarget('Apply C', null, { name: 'sword-shop', version: 'A' }, mockups)).toEqual({ name: 'sword-shop', version: 'C' });
    expect(applyTarget('add a coin counter to the game', null, null, mockups)).toBeNull();
  });

  it('gives a design turn no tool that changes the game, its code or Studio', () => {
    const design = COPILOT_ROLES.ui;
    const build = COPILOT_IMPORT_ROLES.ui;
    expect(design.id).toBe(build.id);
    expect(design.drafts).toBe(true);
    expect(design.builtinTools).not.toContain('edit_files');
    for (const t of ['roblox_sync_push', 'ui_audit']) {
      expect(design.appTools).not.toContain(t);
      expect(build.appTools).toContain(t);
    }
    // No copilot runs Luau in Studio or playtests, in either kind of turn (ui_audit reads the UI in a playtest of its own).
    for (const t of ['roblox_run_luau', 'roblox_playtest', 'roblox_call']) for (const r of [design, build]) expect(r.appTools).not.toContain(t);
    for (const t of ['ui_mockup_create', 'ui_mockup_update', 'ui_mockup_list', 'ui_mockup_audit', 'roblox_explore', 'code_query', 'store_search', 'look_analyze']) expect(design.appTools).toContain(t);
    expect(build.builtinTools).toContain('edit_files');
    expect(build.builtinTools).not.toContain('shell');
    // What it may edit when it builds a design: Luau code, never builders, another dock's data or the generated modules.
    expect(build.editOnly).toBe(UI_CODE);
    for (const f of ['src/Client/UI/Shop.client.luau', 'src/Shared/Ui.luau', 'src/Server/ShopService.server.luau']) expect(UI_CODE(f), f).toBe(true);
    for (const f of ['world/Effects.luau', 'effects/HitSpark.fx.json', 'animations/Slash.anim.json', '.shuriken/project.db', 'src/Shared/ShurikenEffects.luau', 'src/Client/ShurikenEffects.client.luau', 'README.md']) expect(UI_CODE(f), f).toBe(false);
    expect(design.instructions).toMatch(/Mockups first/);
  });

  it('lets the UI designer agent build a picked mockup or sketch with one; other specialists never see them', () => {
    expect(hiddenToolsFor(ROLES['ui-engineer']!)!.has('ui_mockup_create')).toBe(false);
    expect(hiddenToolsFor(ROLES['ui-engineer']!)!.has('ui_mockup_list')).toBe(false);
    expect(hiddenToolsFor(ROLES['level-designer']!)!.has('ui_mockup_create')).toBe(true);
    expect(ROLES['ui-engineer']!.instructions).toMatch(/A mockup the user picked in the UI dock \(ui_mockup_list\) is the design to build/);
    expect(ROLES.director!.instructions).toMatch(/UI ideas,\s+variations and "show me a design" belong in the UI dock/);
  });
});

describe('the UI copilot with mockups', () => {
  it('mocks up a request without touching Studio, then builds the version the user says yes to', async () => {
    const shop = (title: string) => ({ name: 'Shop', kit: 'ui', kids: [{ name: 'Window', cls: 'Frame', anchor: [0.5, 0.5], pos: [0.5, 0, 0.5, 0], size: [0.96, 0, 0.96, 0], sizeMax: [980, 680], bg: '#181b24', kids: [{ name: 'Title', cls: 'TextLabel', text: title, textSize: 32, bgT: 1, size: [1, 0, 0, 72] }] }] });
    const tried: Record<string, boolean> = {};
    const { core, provider, root } = await makeCore({
      respond: async (req, _kind, call) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if ('intent' in props) return { intent: 'question', reply: 'Noted.' };
        if (!('copilotReply' in props)) return null;
        if (/This turn: DESIGN/.test(req.prompt)) {
          // A design turn can't sync code into Studio, even if it tries.
          const push = await call('roblox_sync_push', {}).then(
            (r) => !!(r as { isError?: boolean }).isError,
            () => true,
          );
          tried.pushRefused = push;
          if (/make the title bigger/.test(req.prompt)) {
            await call('ui_mockup_update', { name: 'sword-shop', versions: [{ from: 'B', note: 'a bigger title', set: { 'Shop.Window.Title': { textSize: 44 } } }] });
            return { copilotReply: 'Version C has a bigger title.' };
          }
          await call('ui_mockup_create', { title: 'Sword shop', versions: [{ note: 'a grid', screens: [shop('Shop')] }, { note: 'a strip', screens: [shop('Swords')] }] });
          return { copilotReply: 'Two versions on the UI page: A is a grid, B a strip. Want one in the game?', show: [{ page: 'ui', item: 'mockup:sword-shop', label: 'See them' }] };
        }
        if (/This turn: PUT IT IN THE GAME/.test(req.prompt)) {
          await call('ui_mockup_update', { name: 'sword-shop', applied: { version: 'B', files: ['src/Client/UI/Shop.client.luau'] } });
          return { copilotReply: 'B is in the game.', digest: 'Built the sword shop (mockup B)' };
        }
        return { copilotReply: 'No turn line.' };
      },
    });
    core.orchestrator.pause();
    const chat = core.copilots.chat('ui')!;
    const replies = () => chat.list().filter((m) => m.role === 'copilot');
    const runs = () => provider.runs.filter((r) => r.role === 'copilot-ui');

    core.copilots.send('ui', 'Show me two ideas for a sword shop');
    await waitFor(() => replies().length === 1);
    expect(runs()[0]!.prompt).toMatch(/This turn: DESIGN\. Answer with a mockup/);
    expect(runs()[0]!.builtinTools).not.toContain('edit_files');
    expect(tried.pushRefused).toBe(true);
    expect(replies()[0]!.data).toMatchObject({ mode: 'draft', mockup: { name: 'sword-shop', title: 'Sword shop', version: 'B', versions: ['A', 'B'] }, links: [{ page: 'ui', item: 'mockup:sword-shop' }] });
    // The dock's state lists the mockups for the next turns.
    expect(new MockupStore(root).get('sword-shop')!.versions.map((v) => v.id)).toEqual(['A', 'B']);

    // "yes" to the offer puts the copilot's latest version in the game, with every tool.
    core.copilots.send('ui', 'yes');
    await waitFor(() => replies().length === 2);
    expect(runs()[1]!.prompt).toMatch(/This turn: PUT IT IN THE GAME\. The user asked for it in their game: the mockup "Sword shop" \(sword-shop\), version B/);
    expect(runs()[1]!.builtinTools).toContain('edit_files');
    expect(runs()[1]!.resumeSessionId).toBe(`s-${runs()[0]!.runId}`);
    expect(replies()[1]!.data).toMatchObject({ mode: 'import', mockup: { name: 'sword-shop', version: 'B', applied: true } });

    // A yes after it was built is just a reply; a change is designed again, from the version on screen.
    core.copilots.send('ui', 'now make the title bigger', { page: 'ui', item: 'mockup:sword-shop@B', note: 'version B on the phone' });
    await waitFor(() => replies().length === 3);
    expect(runs()[2]!.prompt).toMatch(/This turn: DESIGN.*new version of "Sword shop" \(sword-shop\), whose version B they are looking at/s);
    expect(runs()[2]!.prompt).toMatch(/Mockups \(designs in Shuriken, in the game only where it says so\): "Sword shop" \[sword-shop\] versions A, B, B picked by the user, B in the game/);
    expect(replies()[2]!.data).toMatchObject({ mode: 'draft', mockup: { name: 'sword-shop', version: 'C', versions: ['C'] } });

    // The mockup's Put it in the game button names the version.
    core.copilots.send('ui', 'Put the “Sword shop” mockup, version C, in the game.', { page: 'ui', item: 'mockup:sword-shop@C' });
    await waitFor(() => replies().length === 4);
    expect(runs()[3]!.prompt).toMatch(/PUT IT IN THE GAME.*version C/s);

    // The director knows the user's designs, and which one is in the game.
    core.director.send('what UI do we have?');
    await waitFor(() => provider.runs.some((r) => r.role === 'director'));
    expect(provider.runs.find((r) => r.role === 'director')!.prompt).toMatch(/UI mockups in the UI dock \(the user's designs, in the game only where it says so\): Sword shop \(3 versions, B picked, B in the game\)/);
  });
});
