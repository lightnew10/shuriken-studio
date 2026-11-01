import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UiNode } from '../src/shared/ui-layout';
import { isFrequentAction, navFindings, navGraphs, navMap, thumbReach, touchFindings, type NavGraph, type NavNode } from '../src/core/ui/lab/interact';
import { amountKind, isPlayerName, listItems, longer, stressFindings, stressVariants } from '../src/core/ui/lab/stress';

let nextId = 1;
const node = (cls: string, name: string, props: Partial<NavNode> = {}, kids: UiNode[] = []): NavNode => ({ id: nextId++, cls, name, kids, ...props });
const screen = (kids: UiNode[], props: Partial<UiNode> = {}) => node('ScreenGui', 'Menu', { ignoreInset: true, ...props }, kids);
const button = (name: string, x: number, y: number, props: Partial<NavNode> = {}) => node('TextButton', name, { pos: [0, x, 0, y], size: [0, 120, 0, 60], text: name, bg: [40, 40, 40], bgT: 0, ...props });
const startGraph = (gs: NavGraph[]) => gs.find((g) => g.view === 'start')!;
const move = (g: NavGraph, from: string, dir: 'up' | 'down' | 'left' | 'right') => {
  const id = g.targets.find((t) => t.label === from)!.id;
  const to = g.moves[id]![dir].to;
  return to === null ? null : g.targets.find((t) => t.id === to)!.label;
};

describe('gamepad navigation', () => {
  it('moves around a 2×2 grid of buttons in all four directions, and says so in a text map', () => {
    const s = screen([button('Play', 100, 100), button('Shop', 300, 100), button('Settings', 100, 250), button('Quit', 300, 250)]);
    const g = startGraph(navGraphs([s], 'desktop'));
    expect(move(g, 'Play', 'right')).toBe('Shop');
    expect(move(g, 'Play', 'down')).toBe('Settings');
    expect(move(g, 'Shop', 'left')).toBe('Play');
    expect(move(g, 'Shop', 'down')).toBe('Quit');
    expect(move(g, 'Quit', 'up')).toBe('Shop');
    expect(move(g, 'Quit', 'left')).toBe('Settings');
    expect(move(g, 'Settings', 'up')).toBe('Play');
    expect(move(g, 'Play', 'up')).toBeNull();
    expect(g.entry).toBe(g.targets.find((t) => t.label === 'Play')!.id);
    const map = navMap(g);
    expect(map).toContain('Play → (right) Shop');
    expect(map).toContain('Play → (down) Settings → (right) Quit');
    expect(navFindings([s], ['desktop'])).toEqual([]);
  });

  it('takes a NextSelection override over the search, and skips a hidden button', () => {
    const quit = button('Quit', 300, 250);
    const s = screen([button('Play', 100, 100, { next: { right: quit.id } }), button('Shop', 300, 100, { visible: false }), button('Settings', 100, 250), quit]);
    const g = startGraph(navGraphs([s], 'desktop'));
    expect(move(g, 'Play', 'right')).toBe('Quit');
    expect(g.moves[g.targets.find((t) => t.label === 'Play')!.id]!.right.how).toBe('override');
    expect(g.targets.map((t) => t.label)).not.toContain('Shop');
    // With Shop hidden, Settings' right is Quit (the search, no override).
    expect(move(g, 'Settings', 'right')).toBe('Quit');
  });

  it('reports a trap that overrides make, but not a SelectionGroup that stops every way (a modal by design)', () => {
    const a = button('A', 100, 100);
    const b = button('B', 300, 100);
    a.next = { up: b.id, down: b.id, left: b.id, right: b.id };
    b.next = { up: a.id, down: a.id, left: a.id, right: a.id };
    const start = button('Start', 100, 400);
    const trapped = navFindings([screen([a, b, start])], ['desktop'], { selected: start.id });
    expect(trapped.some((f) => f.kind === 'nav-trap' && f.message.includes('“A”') && f.message.includes('“B”'))).toBe(true);
    const modal = node('Frame', 'Dialog', { pos: [0, 80, 0, 80], size: [0, 400, 0, 120], selGroup: true, selStop: ['up', 'down', 'left', 'right'] }, [button('Yes', 20, 20), button('No', 200, 20)]);
    const out = navFindings([screen([modal, button('Behind', 100, 500)])], ['desktop']);
    expect(out.filter((f) => f.kind === 'nav-trap')).toEqual([]);
  });

  it('reports buttons a gamepad can never land on, and a screen with buttons but nothing focusable', () => {
    // Two buttons that overlap exactly: the second is never chosen over the first.
    const s = screen([button('Play', 100, 100), button('Shadow', 100, 100), button('Shop', 300, 100)]);
    expect(navFindings([s], ['desktop']).some((f) => f.kind === 'nav-unreachable' && f.path === 'Menu.Shadow')).toBe(true);
    const none = screen([button('Away', 2500, 100), button('Off', 100, 300, { selectable: false })]);
    expect(navFindings([none], ['desktop']).map((f) => f.kind)).toContain('nav-no-way-in');
    // A zero-size button alone is a script's to size (or the Modal trick that frees the mouse): not reported.
    expect(navFindings([screen([button('Gone', 100, 100, { size: [0, 0, 0, 0] })])], ['desktop'])).toEqual([]);
  });

  it('flags a focusable hit area that draws nothing and a button hidden under an opaque panel', () => {
    const empty = node('TextButton', 'FreeMouse', { pos: [0, 600, 0, 600], size: [0, 80, 0, 40], text: '', bgT: 1 });
    const under = button('Hidden', 100, 100);
    const panel = node('Frame', 'Cover', { pos: [0, 50, 0, 50], size: [0, 300, 0, 200], bg: [10, 10, 10], bgT: 0, z: 5 });
    const out = navFindings([screen([button('Play', 900, 100), empty, under, panel])], ['desktop']);
    expect(out.some((f) => f.kind === 'nav-invisible' && f.path === 'Menu.FreeMouse')).toBe(true);
    expect(out.some((f) => f.kind === 'nav-hidden-focus' && f.path === 'Menu.Cover' && f.message.includes('“Hidden”'))).toBe(true);
    // A skinned close button's art is its Skin child, which the checks are given without: it still draws.
    const skinned = node('TextButton', 'Close', { pos: [0, 600, 0, 600], size: [0, 48, 0, 48], text: '', bgT: 1, skinned: 6 });
    expect(navFindings([screen([button('Play', 900, 100), skinned])], ['desktop']).some((f) => f.kind === 'nav-invisible')).toBe(false);
  });
});

describe('touch ergonomics', () => {
  it('measures a 30-point button on a 163 points-per-inch phone as under 7 mm', () => {
    const s = screen([node('TextButton', 'Tiny', { pos: [0, 300, 0, 200], size: [0, 30, 0, 30], text: 'x', bg: [0, 0, 0], bgT: 0 })]);
    const f = touchFindings([s], ['phone'], { ppi: { phone: 163 } }).find((x) => x.kind === 'touch-size')!;
    expect(f.path).toBe('Menu.Tiny');
    // 30 / 163 inch = 4.7 mm.
    expect(f.message).toMatch(/^4\.7×4\.7 mm/);
    expect(touchFindings([screen([node('TextButton', 'Big', { pos: [0, 300, 0, 200], size: [0, 60, 0, 60], text: 'Go' })])], ['phone'])).toEqual([]);
  });

  it('flags small neighbours with no gap, and an attack button at the top centre of a landscape phone', () => {
    const row = [0, 1, 2].map((i) => node('ImageButton', `Slot${i}`, { pos: [0, 200 + i * 40, 0, 300], size: [0, 38, 0, 38], image: 'rbxassetid://1' }));
    expect(touchFindings([screen(row)], ['phone']).some((f) => f.kind === 'touch-gap')).toBe(true);
    const attack = node('TextButton', 'AttackButton', { pos: [0.5, -40, 0, 20], size: [0, 80, 0, 80], text: 'ATTACK' });
    expect(isFrequentAction(attack)).toBe(true);
    expect(touchFindings([screen([attack])], ['phone']).some((f) => f.kind === 'touch-reach')).toBe(true);
    // Bottom right is where the right thumb rests.
    expect(thumbReach(800, 360, { w: 844, h: 390 }, 153.3).zone).toBe('easy');
    expect(thumbReach(422, 20, { w: 844, h: 390 }, 153.3).zone).toBe('hard');
  });
});

describe('content stress', () => {
  it('makes worst cases: longer words, player names, huge amounts, and data lists only', () => {
    expect(longer('Play Now')).toBe('Playun Nowun');
    expect(longer('<b>SETTINGS</b> XP')).toBe('<b>SETTINGSUNGS</b> XP');
    const row = node('Frame', 'Row1', {}, [node('TextLabel', 'Name', { text: 'Builderman' })]);
    expect(isPlayerName(row.kids![0]!, [row, node('Frame', 'Leaderboard')])).toBe(true);
    expect(isPlayerName(node('TextLabel', 'Name', { text: 'Name' }), [row])).toBe(false);
    expect(amountKind(node('TextLabel', 'Value', { text: '1,250' }), [node('Frame', 'Coins')])).toBe('big');
    expect(amountKind(node('TextLabel', 'Price', { text: '399' }), [node('Frame', 'Coins')])).toBeNull();
    const tabs = node('Frame', 'Tabs', { list: { dir: 'Horizontal', h: 'Left', v: 'Top', pad: [0, 0] } }, ['A', 'B', 'C'].map((n) => node('TextButton', n)));
    expect(listItems(tabs)).toBeNull();
    const rows = node('Frame', 'List', { list: { dir: 'Vertical', h: 'Left', v: 'Top', pad: [0, 0] } }, [1, 2, 3].map((i) => node('Frame', `Row${i}`, {}, [node('TextLabel', 'Name', { text: 'x' })])));
    expect(listItems(rows)?.length).toBe(3);
    const vs = stressVariants([screen([rows])]);
    const one = vs.find((v) => v.key === 'items1')!;
    expect(one.screens[0]!.kids![0]!.kids!.length).toBe(1);
  });

  it('finds a scrolling list whose fixed CanvasSize 50 items outgrow (only when the capture says AutomaticCanvasSize is None)', () => {
    const items = [1, 2, 3].map((i) => node('TextButton', `Row${i}`, { size: [1, 0, 0, 60], text: `Item ${i}` }));
    const list = (autoCanvas?: string) =>
      screen([node('ScrollingFrame', 'List', { pos: [0, 100, 0, 100], size: [0, 300, 0, 300], canvas: [0, 0, 0, 400], list: { dir: 'Vertical', h: 'Left', v: 'Top', pad: [0, 4] }, ...(autoCanvas ? { autoCanvas } : {}) } as Partial<NavNode>, items.map((n) => ({ ...n, id: nextId++ })))]);
    expect(stressFindings([list('None')], ['desktop']).some((f) => f.kind === 'stress-scroll' && f.variant === 'Scrolling lists with 50 items')).toBe(true);
    expect(stressFindings([list()], ['desktop']).some((f) => f.kind === 'stress-scroll')).toBe(false);
  });

  it('finds a fixed-width name label that a long player name cuts off, and nothing the capture already had', () => {
    const name = node('TextLabel', 'PlayerName', { pos: [0, 10, 0, 10], size: [0, 160, 0, 30], text: 'Builderman', textSize: 20 });
    const card = node('Frame', 'PlayerCard', { pos: [0, 100, 0, 100], size: [0, 400, 0, 50], bg: [20, 20, 20], bgT: 0 }, [name]);
    const already = node('TextLabel', 'Motto', { pos: [0, 100, 0, 300], size: [0, 60, 0, 30], text: 'This text never fit in its box', textSize: 20 });
    const out = stressFindings([screen([card, already])], ['desktop']);
    const cut = out.find((f) => f.kind === 'stress-cut' && f.path === 'Menu.PlayerCard.PlayerName');
    expect(cut?.variant).toBe('Long player names (20 × W)');
    expect(cut?.message).toMatch(/Text is cut off/);
    // Cut off before any stress: not a stress finding.
    expect(out.some((f) => f.path === 'Menu.Motto' && f.kind === 'stress-cut' && f.variant.startsWith('Long'))).toBe(false);
  });
});

// The jump button and thumbstick numbers are core-overlays'; the selection APIs this models must still exist in the
// Studio install (skipped when there is none).
const studio = (() => {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const versions = join(local, 'Roblox', 'Versions');
  if (!existsSync(versions)) return null;
  const v = readdirSync(versions).find((d) => existsSync(join(versions, d, 'RobloxStudioBeta.exe')) && existsSync(join(versions, d, 'ReflectionMetadata.xml')));
  return v ? join(versions, v) : null;
})();
describe.skipIf(!studio)('against the Studio install', () => {
  it('still has the gamepad selection properties the capture should read', () => {
    const meta = readFileSync(join(studio!, 'ReflectionMetadata.xml'), 'utf8');
    for (const p of ['SelectionGroup', 'SelectionBehaviorUp', 'SelectionOrder', 'SelectionImageObject']) expect(meta).toContain(`<string name="Name">${p}</string>`);
  });
});
