import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutScreen, UI_DEVICES } from '../src/shared/ui-layout';
import { auditVersion, checkVersion, MOCK_FORMAT, MOCK_NODE_KEYS, motionOf, resolveVersion, type MockNode } from '../src/shared/ui-mockup';
import { makeVersion, MockupStore, type VersionInput } from '../src/core/ui/ui-mockups';
import { coreHarness } from './helpers/make-core';
import { scifiVersion } from './fixtures/ui-mockup-scifi';

// The builder said a layout written in a format the tool ignored "silently did nothing", and that the tool's
// description was cut off so it guessed field names. The whole format is in the descriptions (under the 2,048
// characters an MCP client keeps), and everything outside it is refused with the field and its right place.

const makeCore = coreHarness();
const theme = { panel: '#0a1822', cyan: '#3fe0ff' };
const one = (kids: MockNode[], extra: Partial<MockNode> = {}): MockNode[] => [{ name: 'Hud', kids, ...extra }];

describe('the format in the tool descriptions', () => {
  it('fits in what a client keeps and names every property the checker knows', async () => {
    const { core } = await makeCore({ respond: async () => null });
    for (const name of ['ui_mockup_create', 'ui_mockup_update', 'ui_mockup_list', 'ui_mockup_audit', 'ui_mockup_render', 'ui_reference', 'ui_icon', 'ui_audit', 'ui_lab_check', 'ui_lab_review', 'ui_lab_view', 'ui_lab_motion', 'ui_lab_build', 'ui_forge']) {
      const def = core.tools.get(name)!;
      expect(def.description.length, name).toBeLessThanOrEqual(2048);
    }
    const create = core.tools.get('ui_mockup_create')!.description;
    expect(create).toContain(MOCK_FORMAT);
    for (const key of MOCK_NODE_KEYS) expect(MOCK_FORMAT, key).toMatch(new RegExp(`\\b${key}\\b`));
  });
});

describe('refusing what would do nothing', () => {
  it('names misplaced and misspelt fields and where they belong', () => {
    const c = checkVersion({
      theme,
      screens: one([
        { name: 'List', cls: 'Frame', dir: 'Vertical', BackgroundTransparency: 0.5, glow: true } as unknown as MockNode,
        { name: 'Label', cls: 'Frame', text: 'x', textSize: 20 },
        { name: 'Pic', cls: 'TextLabel', text: 'y', image: 'rbxassetid://1' },
        { name: 'Inner', cls: 'Frame', displayOrder: 3 } as MockNode,
      ]),
    });
    expect(c.errors).toEqual(
      expect.arrayContaining([
        'Hud.List: unknown property "dir" (it belongs inside list or grid {…})',
        'Hud.List: unknown property "BackgroundTransparency" (a mockup calls it "bgT")',
        expect.stringMatching(/Hud\.List: unknown property "glow" \(a mockup calls it "shadow/),
        expect.stringMatching(/Hud\.Label: text, textSize on a Frame draws nothing/),
        expect.stringMatching(/Hud\.Pic: image on a TextLabel draws nothing/),
        expect.stringMatching(/Hud\.Inner\.displayOrder: a ScreenGui property/),
      ]),
    );
  });

  it('checks every form layout: set paths start below the screen and must land', () => {
    const screens: MockNode[] = [
      {
        name: 'Hud',
        kids: [{ name: 'Ammo', cls: 'TextLabel', text: '24', size: [0, 100, 0, 40] }],
        forms: {
          phone: { set: { 'Hud.Ammo': { textSize: 30 }, Amo: { textSize: 30 }, Ammo: { textSize: 'big' } } },
          tv: { kids: [{ name: 'Ammo', cls: 'TextLabel', text: '24', Colour: 1 } as unknown as MockNode] },
        },
      },
    ];
    const c = checkVersion({ screens });
    expect(c.errors).toEqual(
      expect.arrayContaining([
        'Hud[phone].set "Hud.Ammo": paths in a form\'s set start below the screen: "Ammo"',
        expect.stringMatching(/Hud\[phone\]\.set: no element Hud\.Amo .*Hud has Ammo/),
        'Hud[phone].Ammo.textSize: a number, 0 or more',
        'Hud[tv].Ammo: unknown property "Colour"',
      ]),
    );
  });

  it('holds values to what Roblox takes: transparency 0 to 1, sequences from 0 to 1, states and appear', () => {
    const c = checkVersion({
      screens: one([
        { name: 'A', cls: 'Frame', bgT: 50, gradient: { colors: [[0.2, '#ffffff'], [1, '#000000']] } },
        { name: 'B', cls: 'TextButton', text: 'Go', states: { hover: { size: [0, 1, 0, 1] } as never, pressed: {} } as never, appear: 'zoom' as never },
        { name: 'C', cls: 'TextLabel', text: 'Shaped', shape: { cut: [8, 8, 8, 8] } },
      ]),
    });
    expect(c.errors).toEqual(
      expect.arrayContaining([
        'Hud.A.bgT: 50 is outside 0 (opaque) to 1 (invisible)',
        'Hud.A.gradient.colors: keys start at time 0 and end at time 1 (Roblox refuses other sequences)',
        expect.stringMatching(/Hud\.B\.states: hover: "size" can't change in a state/),
        expect.stringMatching(/Hud\.B\.states: unknown state "pressed"/),
        expect.stringMatching(/Hud\.B\.appear: one of up, down/),
        expect.stringMatching(/Hud\.C: a shape is built from images under the element, which would cover its own text/),
      ]),
    );
  });

  it('knows the icons and glyphs a mockup shows', () => {
    const knows = { icon: (n: string) => n === 'Coin', glyph: (n: string) => n === 'rocket', glyphsLike: () => ['rocket', 'rocking-chair'] };
    const c = checkVersion({ screens: one([{ name: 'A', cls: 'ImageLabel', image: 'icon:Gem' }, { name: 'B', cls: 'ImageLabel', image: 'glyph:rockt' }, { name: 'C', cls: 'ImageLabel', image: 'sword.png' }, { name: 'D', cls: 'ImageLabel', image: 'icon:Coin' }]) }, knows);
    expect(c.errors).toEqual([
      expect.stringMatching(/Hud\.A\.image: no icon "Gem" in the project yet: make it first with ui_icon/),
      expect.stringMatching(/Hud\.B\.image: no glyph "rockt" \(close: rocket, rocking-chair\)/),
      expect.stringMatching(/Hud\.C\.image: "sword\.png" is not an image/),
    ]);
  });

  it('refuses version fields it does not know, saying where they go', () => {
    const made = makeVersion({ note: 'x', screens: one([]), forms: {}, changes: {} } as unknown as VersionInput, [], null, 'Version A');
    expect(made.version).toBeNull();
    expect(made.errors).toEqual(expect.arrayContaining([expect.stringMatching(/Version A: unknown field "forms" \(forms belong on a screen/), expect.stringMatching(/Version A: unknown field "changes" \(set/)]));
    expect(makeVersion({ note: 'x', set: { 'Hud.A': { bg: '#000000' } } }, [], null).errors).toEqual(expect.arrayContaining([expect.stringMatching(/set changes a version you start from/)]));
  });

  it('refuses an unknown argument to a mockup tool instead of dropping it', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const agent = { kind: 'agent' as const, runId: 'run_ui', taskId: null, role: 'copilot-ui', providerId: null, allowedTools: null };
    const r = await core.tools.invoke('ui_mockup_create', { title: 'X', versions: [{ note: 'x', screens: one([]) }], layouts: {} }, agent);
    expect(r.isError).toBe(true);
    expect(r.content.map((c) => ('text' in c ? c.text : '')).join(' ')).toMatch(/layouts/);
  });
});

describe('the richer pieces', () => {
  it('builds badges as children the audit sees, and appear as Motion.enter', () => {
    const v = scifiVersion();
    expect(checkVersion(v)).toEqual({ errors: [], warnings: [] });
    const r = resolveVersion(v, 'desktop');
    const boxes = r.screens.flatMap((s) => layoutScreen(s, UI_DEVICES.desktop));
    const badge = boxes.find((b) => b.path === 'Menu.Row.Shop.Badge')!;
    const shop = boxes.find((b) => b.path === 'Menu.Row.Shop')!;
    expect(badge.node).toMatchObject({ cls: 'TextLabel', text: '3', bg: [0xe5, 0x39, 0x35] });
    // Over the shop button's top right corner.
    expect(Math.abs(badge.x + badge.w / 2 - (shop.x + shop.w))).toBeLessThan(12);
    expect(boxes.find((b) => b.path === 'Menu.Row.Inventory.Badge')!.node.rot).toBe(-4);
    // Strokes resolve in order, with their own positions; states keep their colours resolved.
    const weapon = boxes.find((b) => b.path === 'Combat.Weapon')!.node;
    expect(weapon.strokes?.map((s) => [s.px, s.pos ?? 'Outer'])).toEqual([
      [7, 'Outer'],
      [1.5, 'Inner'],
    ]);
    expect(shop.node.states?.press).toEqual({ scale: 0.95 });
    const appear = motionOf({ screens: one([{ name: 'Panel', cls: 'Frame', appear: { from: 'pop', delay: 0.1 } }]) });
    expect(appear).toEqual([{ play: 'enter', target: 'Hud.Panel', from: 'pop', delay: 0.1, when: 'open' }]);
    expect(auditVersion(v).findings.filter((f) => f.severity === 'problem')).toEqual([]);
  });

  it('passes the worked example in skill roblox-ui-design as written', () => {
    const md = readFileSync(join(__dirname, '..', 'resources', 'skills', 'roblox-ui-design', 'SKILL.md'), 'utf8');
    const block = /## Building a mockup[\s\S]*?```json\r?\n([\s\S]*?)```/.exec(md)![1]!;
    // A screen, then one element of a menu: read both, the element inside a screen of its own.
    const split = block.indexOf('\n{"name": "Shop"');
    const screen = JSON.parse(block.slice(0, split)) as MockNode;
    const button = JSON.parse(block.slice(split)) as MockNode;
    const v = { theme: { panel: '#0a1822', cyan: '#3fe0ff' }, screens: [screen, { name: 'Menu', kit: 'ui' as const, kids: [button] }] };
    expect(checkVersion(v)).toEqual({ errors: [], warnings: [] });
    expect(md).toMatch(/Ui\.react\(shop, \{ hover = \{ Scale = 1\.04 \}, press = \{ Scale = 0\.95 \} \}\)/);
  });

  it('keeps a mockup that uses all of it through the store', () => {
    const store = new MockupStore(mkdtempSync(join(tmpdir(), 'shuriken-mock-')));
    const v = scifiVersion();
    const made = store.create({ title: 'Combat HUD', versions: [{ note: v.note, theme: v.theme!, screens: v.screens, motion: v.motion! }] });
    expect(made.errors).toEqual([]);
    expect(made.mockup!.versions[0]!.screens[0]!.kids![0]!.shape).toEqual({ slant: [30, 0], cut: [0, 16, 0, 0] });
  });
});

describe('pixel shorthands', () => {
  it('reads padding, corners and pads given as plain numbers as offsets, wherever they are', async () => {
    const { readShorthands, checkVersion } = await import('../src/shared/ui-mockup');
    // As the UI copilot first wrote its HUD in 1.14.
    const screens = readShorthands([
      {
        name: 'Hud',
        kids: [
          { name: 'Tape', cls: 'Frame', padding: [0, 40, 0, 40], corner: 6, corners: [4, 4, 0, 0], list: { dir: 'Vertical', pad: 10 }, kids: [{ name: 'In', cls: 'Frame', padding: 8 }] },
          { name: 'Grid', cls: 'Frame', grid: { cell: [100, 80], pad: [8, 8] } },
        ],
        forms: { phone: { set: { 'Hud.Tape': { padding: 4 } } } },
      },
    ]) as Array<{ kids: Array<Record<string, unknown>>; forms: { phone: { set: Record<string, Record<string, unknown>> } } }>;
    const tape = screens[0]!.kids[0]!;
    expect(tape.padding).toEqual([[0, 0], [0, 40], [0, 0], [0, 40]]);
    expect(tape.corner).toEqual([0, 6]);
    expect(tape.corners).toEqual([[0, 4], [0, 4], [0, 0], [0, 0]]);
    expect(tape.list).toEqual({ dir: 'Vertical', pad: [0, 10] });
    expect((tape.kids as Array<Record<string, unknown>>)[0]!.padding).toEqual([[0, 8], [0, 8], [0, 8], [0, 8]]);
    expect(screens[0]!.kids[1]!.grid).toEqual({ cell: [0, 100, 0, 80], pad: [0, 8, 0, 8] });
    expect(screens[0]!.forms.phone.set['Hud.Tape']!.padding).toEqual([[0, 4], [0, 4], [0, 4], [0, 4]]);
    expect(checkVersion({ screens }).errors.filter((e) => /padding|corner|pad|cell/.test(e))).toEqual([]);
  });
});
