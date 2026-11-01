import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutScreen, UI_DEVICES, type UiNode } from '../src/shared/ui-layout';
import { applyVersionSet, auditVersion, checkVersion, compareWithGame, formOf, mockOutline, nextVersionId, resolveVersion, type MockNode, type MockVersion } from '../src/shared/ui-mockup';
import { MockupStore } from '../src/core/ui/ui-mockups';
import { UiStore } from '../src/core/ui/ui-workshop';
import { coreHarness } from './helpers/make-core';

// UI mockups: designs the UI copilot makes in Shuriken (shown on the UI page) before anything goes into the
// game. They are laid out and audited by the same engine as ui_audit, per device form, versions kept.

const makeCore = coreHarness();

/** A shop on the Ui kit: a window (0.96 of the screen up to 980×680) with a grid of cards and a buy button. */
const shop = (): MockNode => ({
  name: 'Shop',
  kit: 'ui',
  displayOrder: 10,
  kids: [
    {
      name: 'Window',
      cls: 'Frame',
      anchor: [0.5, 0.5],
      pos: [0.5, 0, 0.5, 0],
      size: [0.96, 0, 0.96, 0],
      sizeMax: [980, 680],
      bg: '$surface',
      corner: [0, 12],
      stroke: { color: '#58607a', t: 0.5, px: 1 },
      kids: [
        { name: 'Title', cls: 'TextLabel', text: 'Shop', textSize: 32, font: 'BuilderSansBold', textColor: '$text', bgT: 1, size: [1, -120, 0, 72], pos: [0, 24, 0, 0], xAlign: 'Left' },
        { name: 'Close', cls: 'TextButton', text: 'X', textSize: 20, size: [0, 56, 0, 56], anchor: [1, 0], pos: [1, -16, 0, 8], bg: '$raised', textColor: '$text', corner: [0, 10] },
        {
          name: 'Grid',
          cls: 'ScrollingFrame',
          bgT: 1,
          pos: [0, 24, 0, 80],
          size: [1, -48, 1, -96],
          grid: { cell: [0, 200, 0, 260], pad: [0, 12, 0, 12], dir: 'Horizontal', h: 'Left', v: 'Top' },
          kids: [1, 2, 3, 4].map((i) => ({ name: `Card${i}`, cls: 'Frame', order: i, bg: '$raised', corner: [0, 12] }) as MockNode),
        },
      ],
    },
  ],
});
const theme = { surface: '#181b24', raised: '#242834', text: '#f2f4fa', accent: '#ffb020' };
const version = (screens: MockNode[] = [shop()]): MockVersion => ({ id: 'A', note: 'a shop', theme, screens, createdAt: new Date().toISOString() });

describe('a mockup on a device', () => {
  it('knows the form each device builds for, as the kits’ Ui.device and Hud.device decide it', () => {
    expect(formOf('phone')).toBe('phone');
    expect(formOf('phonePortrait')).toBe('phonePortrait');
    expect(formOf('tablet')).toBe('tablet');
    expect(formOf('laptop')).toBe('desktop');
    expect(formOf('desktop')).toBe('desktop');
    expect(formOf('tv')).toBe('tv');
  });

  it('lays out a kit screen with the kit’s UIScale fit and insets, theme colours resolved', () => {
    const r = resolveVersion(version(), 'desktop');
    const s = r.screens[0]!;
    expect(s.fit).toEqual({ ref: [1920, 1080], min: 0.8, max: 1.5, tenFoot: 1.25 });
    expect(s.insets).toBe('CoreUISafeInsets');
    const window = s.kids![0]!;
    expect(window.bg).toEqual([0x18, 0x1b, 0x24]);
    expect(window.stroke).toEqual({ color: [0x58, 0x60, 0x7a], t: 0.5, px: 1, text: false });
    // Every node gets an id (the canvas and the motion preview find elements by it).
    const ids = new Set<number>();
    const walk = (n: UiNode) => {
      ids.add(n.id);
      n.kids?.forEach(walk);
    };
    walk(s);
    expect(ids.size).toBe(9);
    // The same layout engine as ui_audit: on a desktop the window is its design size under the kit's fit.
    const box = layoutScreen(s, UI_DEVICES.desktop).find((b) => b.path === 'Shop.Window')!;
    const k = Math.min(1920 / 1920, (1080 - 58) / 1080);
    expect(box.w).toBeCloseTo(Math.min(0.96 * 1920, 980 * k), 0);
    // A Hud.screen fits to 900×900 and leaves the top bar to the game.
    const hud = resolveVersion({ screens: [{ name: 'Hud', kit: 'hud', kids: [] }] }, 'phone').screens[0]!;
    expect(hud.fit).toEqual({ ref: [900, 900], min: 0.6, max: 1.4, tenFoot: 1.2 });
    expect(hud.insets).toBe('DeviceSafeInsets');
  });

  it('gives a screen its own layout per form: a portrait phone falls back to the phone’s, a TV to the desktop’s', () => {
    const s = shop();
    s.forms = {
      phone: { set: { 'Window.Grid': { grid: { cell: [0, 160, 0, 200] } }, 'Window.Hint': { cls: 'TextLabel', text: 'Swipe for more', bgT: 1, size: [1, 0, 0, 20], pos: [0, 0, 1, -20] } } },
      desktop: { kids: [{ name: 'Panel', cls: 'Frame', size: [0, 1200, 0, 700] }] },
    };
    const v = version([s]);
    const paths = (d: Parameters<typeof resolveVersion>[1]) => {
      const r = resolveVersion(v, d);
      return { layout: r.layouts.Shop, paths: layoutScreen(r.screens[0]!, UI_DEVICES[d]).map((b) => b.path) };
    };
    expect(paths('phone')).toMatchObject({ layout: 'phone', paths: expect.arrayContaining(['Shop.Window.Hint']) });
    expect(paths('phonePortrait').layout).toBe('phone');
    expect(paths('tablet')).toMatchObject({ layout: null, paths: expect.not.arrayContaining(['Shop.Window.Hint']) });
    expect(paths('desktop')).toMatchObject({ layout: 'desktop', paths: ['Shop.Panel'] });
    expect(paths('tv').layout).toBe('desktop');
    // The phone's grid cells are the phone's own; the default ones elsewhere.
    const cell = (d: 'phone' | 'tablet') => layoutScreen(resolveVersion(v, d).screens[0]!, UI_DEVICES[d]).find((b) => b.path === 'Shop.Window.Grid.Card1')!;
    expect(cell('phone').w / cell('phone').k).toBeCloseTo(160, 3);
    expect(cell('tablet').w / cell('tablet').k).toBeCloseTo(200, 3);
  });
});

describe('checking what the copilot wrote', () => {
  it('names the property it should have used, and refuses duplicate names, bad colours and unknown tokens', () => {
    const c = checkVersion({
      theme,
      screens: [
        {
          name: 'Shop',
          kids: [
            { name: 'A', cls: 'Frame', Size: [0, 1, 0, 1], bg: 'red' },
            { name: 'A', cls: 'TextLabel', text: 'x', textColor: '$nope' },
            { name: 'B', cls: 'Frame', text: 'drawn nowhere' },
            { name: 'C', cls: 'Gizmo' },
          ],
        },
      ],
      motion: [{ play: 'wiggle', target: 'Shop.A' }, { play: 'pulse', target: 'Shop.Missing' }],
    });
    expect(c.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Shop\.A: unknown property "Size" \(a mockup calls it "size"\)/),
        expect.stringMatching(/Shop\.A\.bg: a colour/),
        expect.stringMatching(/Shop\.A: two children share this name/),
        expect.stringMatching(/\$nope is not in the version's theme/),
        expect.stringMatching(/Shop\.C: cls must be one of/),
        expect.stringMatching(/motion\[0\]\.play: one of/),
        // What would draw nothing is refused, not saved with a warning.
        expect.stringMatching(/Shop\.B: text on a Frame draws nothing: text is on a TextLabel/),
      ]),
    );
    // A clean one passes; a move on an element no layout has is refused (a typo would play nothing).
    expect(checkVersion({ theme, screens: [shop()], motion: [{ play: 'enter', target: 'Shop.Window.Grid', from: 'up' }] })).toEqual({ errors: [], warnings: [] });
    const typo = checkVersion({ theme, screens: [shop()], motion: [{ play: 'pulse', target: 'Shop.Window.Gird' }] });
    expect(typo.errors).toEqual([expect.stringMatching(/motion\[0\]\.target: no element "Shop\.Window\.Gird" in any layout/)]);
  });

  it('revises by path: merges, removes, adds, and changes one form’s layout', () => {
    const errors: string[] = [];
    const next = applyVersionSet(
      [shop()],
      {
        'Shop.Window': { bg: '$accent', stroke: { px: 2 } },
        'Shop.Window.Close': null,
        'Shop.Window.Buy': { cls: 'TextButton', text: 'Buy', size: [0, 200, 0, 56] },
        'phone:Shop.Window.Title': { textSize: 24 },
        'Shop.Nowhere.Thing': { bg: '#000000' },
      },
      errors,
    );
    const w = next[0]!.kids![0]!;
    expect(w.bg).toBe('$accent');
    expect(w.stroke).toEqual({ color: '#58607a', t: 0.5, px: 2 });
    expect(w.kids!.map((k) => k.name)).toEqual(['Title', 'Grid', 'Buy']);
    expect(next[0]!.forms?.phone?.set).toEqual({ 'Window.Title': { textSize: 24 } });
    expect(errors).toEqual([expect.stringMatching(/no element Shop\.Nowhere/)]);
  });

  it('numbers versions A to Z, then AA', () => {
    expect(nextVersionId([])).toBe('A');
    expect(nextVersionId(['A', 'B'])).toBe('C');
    expect(nextVersionId(['A', 'Z'])).toBe('AA');
    expect(nextVersionId(['AZ'])).toBe('BA');
  });
});

describe('auditing a mockup', () => {
  it('runs ui_audit’s checks on every device, merging the devices a finding happens on', () => {
    // Offsets only, no UIScale: a 900-point panel hangs off a landscape phone, and a portrait one most of all.
    const wide: MockNode = { name: 'Menu', kids: [{ name: 'Panel', cls: 'Frame', bg: '#202020', size: [0, 900, 0, 300], pos: [0, 20, 0, 20], kids: [{ name: 'Play', cls: 'TextButton', text: 'Play', textSize: 18, size: [0, 120, 0, 30], pos: [0, 700, 0, 10], bg: '#333333', textColor: '#ffffff' }] }] };
    const a = auditVersion({ screens: [wide] });
    const off = a.findings.find((f) => f.path === 'Menu.Panel.Play' && /off the screen/.test(f.message));
    expect(off?.devices.sort()).toEqual(['phone', 'phonePortrait']);
    const small = a.findings.find((f) => /Small to tap/.test(f.message));
    expect(small?.devices.sort()).toEqual(['phone', 'phonePortrait']);
    expect(a.devices.find((d) => d.device === 'desktop')).toMatchObject({ form: 'desktop', problems: 0 });
    expect(a.devices.find((d) => d.device === 'phonePortrait')!.problems).toBeGreaterThan(0);
    // The shop on the Ui kit is clean everywhere.
    expect(auditVersion(version()).findings.filter((f) => f.severity === 'problem')).toEqual([]);
    expect(mockOutline(version()).join('\n')).toMatch(/Shop\.Window \(Frame\): phone \d+,\d+ \d+×\d+ · desktop/);
  });

  it('compares the game’s UI with the mockup it was built from, element by element', () => {
    const v = version();
    // The game as built: the same tree (as the kit would make it), but the close button 30 points lower.
    const built = resolveVersion(v, 'desktop').screens[0]!;
    const close = built.kids![0]!.kids!.find((k) => k.name === 'Close')!;
    close.pos = [1, -16, 0, 38];
    const cmp = compareWithGame(v, [built], ['phone', 'desktop']);
    expect(cmp.screens).toEqual([{ name: 'Shop', inGame: true }]);
    expect(cmp.differences).toEqual([{ path: 'Shop.Window.Close', devices: ['phone', 'desktop'], issue: expect.stringMatching(/in the game at .*; the mockup has/) }]);
    expect(cmp.matched).toBe(cmp.checked - 2);
    expect(compareWithGame(v, [], ['phone']).screens).toEqual([{ name: 'Shop', inGame: false }]);
  });
});

describe('the mockup store', () => {
  it('keeps every version, revisions made from earlier ones, the pick and what went into the game', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-mock-'));
    const store = new MockupStore(root);
    const made = store.create({ title: 'Sword shop', brief: 'the blacksmith', versions: [{ note: 'grid', theme, screens: [shop()] }, { label: 'Strip', note: 'one row', theme, screens: [shop()] }], by: 'copilot-ui' });
    expect(made.errors).toEqual([]);
    expect(made.mockup).toMatchObject({ name: 'sword-shop', title: 'Sword shop', versions: [{ id: 'A', by: 'copilot-ui' }, { id: 'B', label: 'Strip' }] });
    expect(readdirSync(join(root, '.shuriken', 'ui', 'mockups'))).toEqual(['sword-shop.json']);
    const rev = store.addVersions('sword-shop', [{ from: 'b', note: 'bigger title', set: { 'Shop.Window.Title': { textSize: 40 } }, theme: { accent: '#e53935' } }]);
    expect(rev.added.map((v) => v.id)).toEqual(['C']);
    const c = rev.mockup!.versions[2]!;
    expect(c).toMatchObject({ from: 'B', theme: { ...theme, accent: '#e53935' } });
    expect(c.screens[0]!.kids![0]!.kids![0]!.textSize).toBe(40);
    // Earlier versions stay as they were.
    expect(store.get('sword-shop')!.versions[1]!.screens[0]!.kids![0]!.kids![0]!.textSize).toBe(32);
    // A version with errors saves nothing.
    const bad = store.addVersions('sword-shop', [{ note: 'oops', screens: [{ name: 'X', kids: [{ name: 'Y', cls: 'Frame', Colour: 1 } as unknown as MockNode] }] }]);
    expect(bad.mockup).toBeNull();
    expect(bad.errors[0]).toMatch(/Version D: X\.Y: unknown property "Colour"/);
    expect(store.get('sword-shop')!.versions).toHaveLength(3);
    expect(store.choose('sword-shop', 'B')!.chosen).toBe('B');
    expect(store.markApplied('sword-shop', 'C', ['src/Client/UI/Shop.client.luau'])!).toMatchObject({ chosen: 'C', applied: { version: 'C', files: ['src/Client/UI/Shop.client.luau'] } });
    expect(store.find('Sword Shop')!.name).toBe('sword-shop');
    expect(store.find('shop')!.name).toBe('sword-shop');
    // A second mockup with the same title gets its own name; names never leave the folder.
    expect(store.create({ title: 'Sword shop', versions: [{ note: 'again', screens: [shop()], theme }] }).mockup!.name).toBe('sword-shop-2');
    expect(store.get('../project')).toBeNull();
    // From the game's UI as last read: its screens, ids dropped, with changes.
    const game = resolveVersion(version(), 'desktop').screens;
    const fromGame = store.create({ title: 'HUD fix', versions: [{ from: 'game:shop', note: 'the game’s shop, wider', set: { 'Shop.Window': { sizeMax: [1100, 680] } } }], game });
    expect(fromGame.errors).toEqual([]);
    expect(fromGame.mockup!.versions[0]!.screens[0]!.kids![0]!).toMatchObject({ sizeMax: [1100, 680] });
    expect(fromGame.mockup!.versions[0]!.screens[0]!.id).toBeUndefined();
    expect(store.create({ title: 'Nothing', versions: [{ from: 'game', note: 'x' }], game: null }).errors[0]).toMatch(/hasn't been read from Studio yet/);
  });
});

describe('the mockup tools', () => {
  it('make, revise, list and audit mockups without touching Studio, and compare the game with one', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const agent = { kind: 'agent' as const, runId: 'run_ui', taskId: null, role: 'copilot-ui', providerId: null, allowedTools: null };
    const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');
    const events: string[] = [];
    core.bus.on('ui.mockups', (e) => events.push(e.name));

    const made = await core.tools.invoke('ui_mockup_create', { title: 'Sword shop', versions: [{ note: 'a grid', theme, screens: [shop()] }, { note: 'cards in one row', theme, screens: [shop()], motion: [{ play: 'enter', target: 'Shop.Window.Grid' }] }] }, agent);
    expect(made.isError, text(made)).toBeFalsy();
    expect(text(made)).toMatch(/Made "Sword shop" \(sword-shop\): A: .*; B: .*nothing in the game changed/);
    expect(made.data).toMatchObject({ name: 'sword-shop', versions: ['A', 'B'], made: [{ version: 'A', show: { page: 'ui', item: 'mockup:sword-shop@A' } }, { version: 'B' }] });
    expect(events).toEqual(['sword-shop']);

    const bad = await core.tools.invoke('ui_mockup_update', { name: 'Sword shop', versions: [{ from: 'A', note: 'x', set: { 'Shop.Window': { BackgroundColor3: [1, 2, 3] } } }] }, agent);
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Nothing saved\. Fix these.*unknown property "BackgroundColor3" \(a mockup calls it "bg"\)/s);

    const rev = await core.tools.invoke('ui_mockup_update', { name: 'sword-shop', versions: [{ from: 'A', note: 'accent title', set: { 'Shop.Window.Title': { textColor: '$accent' } } }], choose: 'C' }, agent);
    expect(rev.isError, text(rev)).toBeFalsy();
    expect(rev.data).toMatchObject({ versions: ['A', 'B', 'C'], chosen: 'C' });

    const list = await core.tools.invoke('ui_mockup_list', {}, agent);
    expect(text(list)).toMatch(/1 mockup\(s\): Sword shop \(3 version\(s\), C picked\)/);
    const one = await core.tools.invoke('ui_mockup_list', { name: 'sword-shop' }, agent);
    expect(one.data).toMatchObject({ chosen: 'C', version: { id: 'C', from: 'A' } });

    // Compare needs the game's UI: none read yet.
    const noGame = await core.tools.invoke('ui_mockup_audit', { name: 'sword-shop', compare: true }, agent);
    expect(text(noGame)).toMatch(/hasn't been read from Studio yet/);
    // Built into the game exactly (as a playtest would read it), the game matches the mockup.
    const store = new MockupStore(root);
    const c = store.get('sword-shop')!.versions[2]!;
    new UiStore(root).save({ source: 'PlayerGui', screens: resolveVersion(c, 'desktop').screens, count: 8, truncated: false });
    const cmp = await core.tools.invoke('ui_mockup_audit', { name: 'sword-shop', compare: true }, agent);
    expect(cmp.isError, text(cmp)).toBeFalsy();
    const compare = (cmp.data as { compare: { checked: number; matched: number; differences: unknown[] } }).compare;
    expect(compare.differences).toEqual([]);
    expect(compare.matched).toBe(compare.checked);

    const applied = await core.tools.invoke('ui_mockup_update', { name: 'sword-shop', applied: { version: 'c', files: ['src/Client/UI/Shop.client.luau'] } }, agent);
    expect(applied.data).toMatchObject({ chosen: 'C' });
    expect(store.get('sword-shop')!.applied).toMatchObject({ version: 'C' });
  });
});
