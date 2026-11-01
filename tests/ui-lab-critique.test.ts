import { describe, expect, it } from 'vitest';
import { critiqueScreen, critiqueUi, spacingGrid, type Critique } from '../src/core/ui/lab/critique';
import { resolveVersion, type MockNode } from '../src/shared/ui-mockup';
import type { UiNode } from '../src/shared/ui-layout';

// The design critic on synthetic screens with known faults: each fault is found, a clean screen outscores a messy
// one, and contrast is read from the pixels the backdrop puts behind the text.

const screen = (kids: MockNode[], name = 'S'): UiNode => resolveVersion({ screens: [{ name, ignoreInset: true, kids }] }, 'phone').screens[0]!;
const run = (kids: MockNode[], pixels = false): Critique => critiqueScreen(screen(kids), 'phone', { pixels });
const has = (c: Critique, check: string, re: RegExp) => c.findings.some((f) => f.check === check && re.test(f.message));

/** A dark window with a title, three rows and two buttons: the clean reference. */
const clean = (): MockNode[] => [
  {
    name: 'Window',
    cls: 'Frame',
    pos: [0, 200, 0, 40],
    size: [0, 440, 0, 300],
    bg: '#141925',
    corner: [0, 12],
    padding: [
      [0, 24],
      [0, 24],
      [0, 24],
      [0, 24],
    ],
    kids: [
      { name: 'Title', cls: 'TextLabel', pos: [0, 0, 0, 0], size: [0, 392, 0, 32], bgT: 1, text: 'Settings', textSize: 28, bold: true, textColor: '#f2f4f8', xAlign: 'Left' },
      ...[0, 1, 2].map((i): MockNode => ({ name: `Row${i}`, cls: 'Frame', pos: [0, 0, 0, 48 + i * 56], size: [0, 392, 0, 48], bg: '#1e2433', corner: [0, 8], kids: [{ name: 'Label', cls: 'TextLabel', pos: [0, 16, 0, 0], size: [0, 200, 1, 0], bgT: 1, text: `Option ${i + 1}`, textSize: 18, textColor: '#f2f4f8', xAlign: 'Left' }] })),
      { name: 'Cancel', cls: 'TextButton', pos: [0, 0, 0, 212], size: [0, 188, 0, 44], bg: '#1e2433', corner: [0, 8], text: 'Cancel', textSize: 18, textColor: '#9aa4b8' },
      { name: 'Confirm', cls: 'TextButton', pos: [0, 204, 0, 212], size: [0, 188, 0, 44], bg: '#36e3ff', corner: [0, 8], text: 'Confirm', textSize: 18, bold: true, textColor: '#031318' },
    ],
  },
];

describe('the design critic', () => {
  it('infers the spacing grid', () => {
    expect(spacingGrid([8, 16, 24, 32, 8]).base).toBe(8);
    expect(spacingGrid([4, 12, 20, 8]).base).toBe(4);
    expect(spacingGrid([5, 7, 13, 11]).base).toBe(null);
  });

  it('flags uneven gaps in a row, near-duplicate paddings and spacing off any grid', () => {
    const c = run([
      {
        name: 'Bar',
        cls: 'Frame',
        pos: [0, 100, 0, 100],
        size: [0, 300, 0, 80],
        bg: '#202020',
        padding: [
          [0, 15],
          [0, 13],
          [0, 15],
          [0, 12],
        ],
        kids: [
          { name: 'A', cls: 'Frame', pos: [0, 0, 0, 0], size: [0, 60, 0, 50], bg: '#606060' },
          { name: 'B', cls: 'Frame', pos: [0, 67, 0, 0], size: [0, 60, 0, 50], bg: '#606060' },
          { name: 'C', cls: 'Frame', pos: [0, 141, 0, 0], size: [0, 60, 0, 50], bg: '#606060' },
          { name: 'D', cls: 'Frame', pos: [0, 215, 0, 0], size: [0, 60, 0, 50], bg: '#606060' },
        ],
      },
    ]);
    expect(has(c, 'spacing', /spaced unevenly: gaps 7, 14, 14/)).toBe(true);
    expect(has(c, 'spacing', /near-duplicate paddings in S\.Bar: 12 and 13/)).toBe(true);
    expect(has(run(clean()), 'spacing', /near-duplicate|unevenly|no grid/)).toBe(false);
  });

  it('flags an element a few points off a line its neighbours share', () => {
    const kids = clean();
    kids[0]!.kids![2] = { ...kids[0]!.kids![2]!, pos: [0, 3, 0, 104] };
    const c = run(kids);
    const f = c.findings.find((x) => x.check === 'alignment');
    expect(f?.paths[0]).toBe('S.Window.Row1');
    expect(f?.numbers.off).toBe(3);
    expect(run(clean()).findings.filter((x) => x.check === 'alignment')).toEqual([]);
  });

  it('flags TextScaled labels of one kind at different sizes, near sizes side by side, and colliding words', () => {
    const card = (n: string, label: string, x: number): MockNode => ({ name: n, cls: 'Frame', pos: [0, x, 0, 60], size: [0, 120, 0, 60], bg: '#303040', kids: [{ name: 'Name', cls: 'TextLabel', size: [1, 0, 1, 0], bgT: 1, text: label, scaled: true, textColor: '#ffffff' }] });
    const c = run([
      { name: 'Shop', cls: 'Frame', pos: [0, 100, 0, 40], size: [0, 600, 0, 300], bg: '#141925', kids: [card('A', 'Sword', 20), card('B', 'Legendary Hammer', 160), card('C', 'Bow', 300)] },
      { name: 'Info', cls: 'Frame', pos: [0, 100, 0, 360], size: [0, 400, 0, 20], bg: '#141925', kids: [{ name: 'One', cls: 'TextLabel', size: [0, 200, 1, 0], bgT: 1, text: 'Gold earned', textSize: 14, textColor: '#ffffff', xAlign: 'Left' }, { name: 'Two', cls: 'TextLabel', pos: [0, 20, 0, 0], size: [0, 200, 1, 0], bgT: 1, text: 'Kills this round', textSize: 15, textColor: '#ffffff', xAlign: 'Left' }] },
    ]);
    expect(has(c, 'type', /3 TextScaled labels of one kind render at/)).toBe(true);
    expect(has(c, 'type', /text sizes 14, 15 pt side by side/)).toBe(true);
    expect(has(c, 'density', /print over each other/)).toBe(true);
  });

  it('finds a secondary button outshining the primary', () => {
    const kids = clean();
    const w = kids[0]!.kids!;
    w[4] = { ...w[4]!, bg: '#ff3b30', size: [0, 240, 0, 56], textColor: '#ffffff' };
    w[5] = { ...w[5]!, bg: '#1e2433', pos: [0, 252, 0, 212], size: [0, 140, 0, 40], textColor: '#9aa4b8' };
    w[4]!.text = 'Close';
    expect(has(run(kids), 'hierarchy', /"Close" \(secondary\) is as salient as "Confirm"/)).toBe(true);
    expect(run(clean()).findings.filter((f) => f.check === 'hierarchy')).toEqual([]);
  });

  it('scores a clean screen above a messy one', () => {
    const messy: MockNode[] = [
      { name: 'Panel', cls: 'Frame', pos: [0, 203, 0, 37], size: [0, 437, 0, 303], bg: '#8b8b8b', kids: [
        { name: 'Title', cls: 'TextLabel', pos: [0, 13, 0, 7], size: [0, 300, 0, 30], bgT: 1, text: 'SETTINGS', scaled: true, textColor: '#9a9a9a' },
        { name: 'A', cls: 'TextButton', pos: [0, 15, 0, 50], size: [0, 200, 0, 40], bg: '#7a7a7a', text: 'Music volume', scaled: true, textColor: '#bbbbbb' },
        { name: 'B', cls: 'TextButton', pos: [0, 13, 0, 97], size: [0, 200, 0, 40], bg: '#7a7a7a', text: 'Sounds', scaled: true, textColor: '#bbbbbb' },
        { name: 'C', cls: 'TextButton', pos: [0, 15, 0, 151], size: [0, 200, 0, 40], bg: '#7a7a7a', text: 'Graphics quality', scaled: true, textColor: '#bbbbbb' },
        { name: 'Hint', cls: 'TextLabel', pos: [0, 15, 0, 160], size: [0, 300, 0, 16], bgT: 1, text: 'Changes save automatically', textSize: 9, textColor: '#aaaaaa' },
        { name: 'X', cls: 'TextButton', pos: [0, 395, 0, 5], size: [0, 37, 0, 37], bg: '#ff0000', text: 'X', textSize: 20, textColor: '#ffffff' },
      ] },
    ];
    const good = run(clean()).scores[0]!;
    const bad = run(messy).scores[0]!;
    expect(good.score).toBeGreaterThan(bad.score + 15);
    expect(good.score).toBeGreaterThanOrEqual(90);
    for (const s of Object.values(bad.sub)) expect(typeof s.why).toBe('string');
  });

  it('reads the contrast of text from the backdrop behind it', () => {
    const label = (extra: Partial<MockNode> = {}): MockNode[] => [{ name: 'Coins', cls: 'TextLabel', pos: [0, 300, 0, 60], size: [0, 200, 0, 40], bgT: 1, text: '12,450 coins', textSize: 22, textColor: '#ffffff', ...extra }];
    // White text straight on the world: fine on a dark scene, gone on a bright sky.
    const bare = critiqueUi([screen(label())], { devices: ['phone'] });
    const f = bare.findings.find((x) => x.check === 'legibility');
    expect(f?.message).toMatch(/on the dark scene backdrop but 1\.\d:1 on the bright sky/);
    expect(f?.fix).toMatch(/outline/);
    // A dark outline round the letters makes it read on both.
    const stroked = critiqueUi([screen(label({ stroke: { color: '#000000', px: 2, text: true } }))], { devices: ['phone'] });
    expect(stroked.findings.filter((x) => x.check === 'legibility')).toEqual([]);
    // Only the dark scene behind it: nothing to report.
    const dark = critiqueUi([screen(label())], { devices: ['phone'], backdrops: [{ name: 'dark scene', image: 'dark' }] });
    expect(dark.findings.filter((x) => x.check === 'legibility')).toEqual([]);
  });

  it("judges a screen that hides Roblox's chat and controls as a menu, not a HUD covering the game", () => {
    // A garage of cards and buttons with no big panel behind them (its backdrop is another screen).
    const cards = (): MockNode[] => [0, 1, 2, 3].map((i): MockNode => ({ name: `Card${i}`, cls: 'TextButton', pos: [0, 40 + (i % 2) * 300, 0, 40 + Math.floor(i / 2) * 160], size: [0, 280, 0, 140], bg: '#1e2433', corner: [0, 8], text: `Upgrade ${i}`, textSize: 20, textColor: '#f2f4f8' }));
    const hud = critiqueUi([screen(cards())], { devices: ['phone'], pixels: false });
    expect(hud.play.length).toBe(1);
    const owned = { ...screen(cards()), hides: 'chat playerList touch' } as UiNode;
    expect(critiqueUi([owned], { devices: ['phone'], pixels: false }).play).toEqual([]);
  });
});
