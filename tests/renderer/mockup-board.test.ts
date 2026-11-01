import { describe, expect, it } from 'vitest';
import { layoutScreen, UI_DEVICES, type UiDevice } from '../../src/shared/ui-layout';
import { resolveVersion, type MockMotion, type MockNode } from '../../src/shared/ui-mockup';
import { applyMessage, boardLayout, previewPlan, springKeyframes } from '../../src/renderer/src/lib/mockup-board';
import { uiTurnMode } from '../../src/core/copilots/ui-intent';

// The UI page's mockup board: the devices side by side at their true shapes, and what the preview plays for
// the Motion module's moves (pages/ui-mockups.tsx, components/ui/mockup-board.tsx).

const ALL: UiDevice[] = ['phone', 'phonePortrait', 'tablet', 'desktop', 'tv'];
const items = (ds: UiDevice[]) => ds.map((d) => ({ key: d, aspect: UI_DEVICES[d].w / UI_DEVICES[d].h }));

describe('the board', () => {
  it('puts every device in order, at its own shape, without overlap, inside the space', () => {
    const { cells, height } = boardLayout(items(ALL), 880, 700, 14, 22);
    expect(cells.map((c) => c.key)).toEqual(ALL);
    for (const c of cells) {
      expect(c.w / c.h).toBeCloseTo(UI_DEVICES[c.key].w / UI_DEVICES[c.key].h, 6);
      expect(c.x).toBeGreaterThanOrEqual(-0.01);
      expect(c.x + c.w).toBeLessThanOrEqual(880.01);
    }
    expect(height).toBeLessThanOrEqual(700.01);
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i]!;
        const b = cells[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h + 22, b.y + b.h + 22) - Math.max(a.y, b.y);
        expect(ox <= 0.01 || oy <= 0.01, `${a.key} and ${b.key} overlap`).toBe(true);
      }
    // No device ends up a thumbnail: the upright phone gets a column of its own rather than a sliver of a row.
    expect(Math.min(...cells.map((c) => Math.min(c.w, c.h)))).toBeGreaterThan(120);
    const upright = cells.find((c) => c.key === 'phonePortrait')!;
    expect(upright.w).toBeGreaterThan(250);
    // A wide board keeps them in rows, in order.
    const wide = boardLayout(items(ALL), 1180, 760, 14, 22).cells;
    expect(wide.map((c) => Math.round(c.y))).toEqual([0, 0, 0, expect.any(Number), expect.any(Number)]);
  });

  it('gives one device all the room the height allows', () => {
    const { cells } = boardLayout(items(['desktop']), 900, 400, 14, 22);
    expect(cells[0]!.h).toBeCloseTo(378, 3);
    expect(cells[0]!.x).toBeCloseTo((900 - 378 * (1920 / 1080)) / 2, 3);
  });
});

describe('the Put it in the game button', () => {
  it('sends what the UI copilot reads as a request to build that version', () => {
    const text = applyMessage('Sword shop', 'B');
    expect(text).toBe('Put the “Sword shop” mockup, version B, in the game.');
    expect(uiTurnMode(text)).toBe('import');
  });
});

describe('the motion preview', () => {
  const screen: MockNode = {
    name: 'Shop',
    kit: 'ui',
    kids: [
      {
        name: 'Window',
        cls: 'Frame',
        anchor: [0.5, 0.5],
        pos: [0.5, 0, 0.5, 0],
        size: [0, 600, 0, 400],
        bg: '#202020',
        kids: [
          { name: 'Grid', cls: 'Frame', size: [1, 0, 1, -80], pos: [0, 0, 0, 80], grid: { cell: [0, 100, 0, 100], pad: [0, 10, 0, 10], dir: 'Horizontal', h: 'Left', v: 'Top' }, kids: [1, 2, 3].map((i) => ({ name: `Card${i}`, cls: 'Frame', order: i, bg: '#303030' }) as MockNode) },
          { name: 'Coins', cls: 'TextLabel', text: '1,250', textSize: 20, size: [0, 120, 0, 40] },
        ],
      },
    ],
  };
  const boxes = layoutScreen(resolveVersion({ screens: [screen] }, 'desktop').screens[0]!, UI_DEVICES.desktop);
  const id = (path: string) => boxes.find((b) => b.path === path)!.node.id;

  it('opens a window with everything in it, scaled about its anchor point', () => {
    const { steps } = previewPlan([{ play: 'open', target: 'Shop.Window' }], boxes);
    const ids = steps.map((s) => (s.kind === 'animate' ? s.id : -1));
    expect(ids).toEqual(expect.arrayContaining([id('Shop.Window'), id('Shop.Window.Grid'), id('Shop.Window.Grid.Card1'), id('Shop.Window.Coins')]));
    const win = boxes.find((b) => b.path === 'Shop.Window')!;
    const card = boxes.find((b) => b.path === 'Shop.Window.Grid.Card1')!;
    const cardStep = steps.find((s) => s.kind === 'animate' && s.id === card.node.id)!;
    expect(cardStep.kind === 'animate' && cardStep.origin).toBe(`${win.x + win.w / 2 - card.x}px ${win.y + win.h / 2 - card.y}px`);
  });

  it('brings a grid’s cards in one after another, fading (a layout owns their position), and lists what it can’t play', () => {
    const motion: MockMotion[] = [
      { play: 'enter', target: 'Shop.Window.Grid', from: 'up', delay: 0.1 },
      { play: 'fly', target: 'Shop.Window.Coins', to: 'Shop.Window.Coins' },
      { play: 'count', target: 'Shop.Window.Coins', from: 1000, to: 1250 },
    ];
    const { steps, skipped } = previewPlan(motion, boxes);
    const cards = [1, 2, 3].map((i) => steps.find((s) => s.kind === 'animate' && s.id === id(`Shop.Window.Grid.Card${i}`))!);
    expect(cards.map((c) => (c.kind === 'animate' ? c.options.delay : null))).toEqual([100, 135, 170]);
    expect(cards.every((c) => c.kind === 'animate' && c.keyframes.every((k) => k.transform === undefined))).toBe(true);
    expect(skipped.map((m) => m.play)).toEqual(['fly']);
    expect(steps.find((s) => s.kind === 'count')).toMatchObject({ id: id('Shop.Window.Coins'), from: 1000, to: 1250 });
  });

  it('plays it as Reduce Motion would: no moves or loops, fades still, counts land at once', () => {
    const { steps } = previewPlan(
      [
        { play: 'open', target: 'Shop.Window' },
        { play: 'pulse', target: 'Shop.Window.Coins' },
        { play: 'count', target: 'Shop.Window.Coins', from: 0, to: 50 },
        { play: 'transition', style: 'iris' },
      ],
      boxes,
      { reduced: true },
    );
    expect(steps.filter((s) => s.kind === 'animate').every((s) => s.kind === 'animate' && s.keyframes.every((k) => k.transform === undefined))).toBe(true);
    expect(steps.find((s) => s.kind === 'count')).toMatchObject({ from: 50, to: 50, duration: 0 });
    expect(steps.find((s) => s.kind === 'cover')).toMatchObject({ style: 'fade', half: 150 });
  });

  it('springs a punch out to its peak and back to rest', () => {
    const s = springKeyframes(0.12, 4, 0.35, (v) => String(v));
    const values = s.keyframes.map((k) => Number(k.transform));
    expect(Math.max(...values)).toBeGreaterThan(0.1);
    expect(Math.max(...values)).toBeLessThanOrEqual(0.1201);
    expect(values[values.length - 1]).toBe(0);
    expect(s.duration).toBeGreaterThan(300);
  });
});
