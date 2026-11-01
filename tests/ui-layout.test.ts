import { describe, expect, it } from 'vitest';
import { auditUi, contrast, estimateText, layoutScreen, type UiNode } from '../src/shared/ui-layout';
import { filmstripTimes } from '../src/shared/render';

let nextId = 1;
const node = (cls: string, name: string, props: Partial<UiNode> = {}, kids: UiNode[] = []): UiNode => ({ id: nextId++, cls, name, kids, ...props });
const screen = (props: Partial<UiNode>, kids: UiNode[]) => node('ScreenGui', 'HUD', props, kids);
const box = (boxes: ReturnType<typeof layoutScreen>, name: string) => boxes.find((b) => b.node.name === name)!;
const desktop = { w: 1920, h: 1080 };

describe('Roblox GUI layout', () => {
  it('places UDim2 position and size with the anchor point, below the top bar unless the inset is ignored', () => {
    const centered = node('Frame', 'Panel', { pos: [0.5, 0, 0.5, 0], size: [0, 400, 0, 200], anchor: [0.5, 0.5] });
    const b = box(layoutScreen(screen({}, [centered]), desktop), 'Panel');
    // Centered in the area under the 58-point top bar.
    expect([b.x, b.y, b.w, b.h]).toEqual([760, 58 + (1080 - 58) / 2 - 100, 400, 200]);
    const full = box(layoutScreen(screen({ ignoreInset: true }, [node('Frame', 'Panel', { pos: [0.5, 0, 0.5, 0], size: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5] })]), desktop), 'Panel');
    expect([full.x, full.y, full.w, full.h]).toEqual([480, 270, 960, 540]);
  });

  it('stacks a UIListLayout with padding and alignment, ignoring the children’s own positions', () => {
    const kids = [2, 1, 3].map((o) => node('TextButton', `B${o}`, { order: o, pos: [0, 999, 0, 999], size: [0, 100, 0, 40] }));
    const list = node('Frame', 'Menu', { size: [0, 300, 0, 300], padding: [[0, 10], [0, 0], [0, 0], [0, 0]], list: { dir: 'Vertical', h: 'Center', v: 'Top', pad: [0, 8] } }, kids);
    const boxes = layoutScreen(screen({ ignoreInset: true }, [list]), desktop);
    expect(['B1', 'B2', 'B3'].map((n) => [box(boxes, n).x, box(boxes, n).y])).toEqual([
      [100, 10],
      [100, 58],
      [100, 106],
    ]);
  });

  it('fills a UIGridLayout row by row with its cell size', () => {
    const cells = Array.from({ length: 5 }, (_, i) => node('ImageButton', `Slot${i}`, { order: i }));
    const grid = node('Frame', 'Inventory', { size: [0, 250, 0, 200], grid: { cell: [0, 50, 0, 50], pad: [0, 10, 0, 10], dir: 'Horizontal', h: 'Left', v: 'Top' } }, cells);
    const boxes = layoutScreen(screen({ ignoreInset: true }, [grid]), desktop);
    // (250 + 10) / (50 + 10) = 4 per row.
    expect(box(boxes, 'Slot3')).toMatchObject({ x: 180, y: 0, w: 50, h: 50 });
    expect(box(boxes, 'Slot4')).toMatchObject({ x: 0, y: 60 });
  });

  it('keeps an aspect ratio within the size, applies UIScale, and clips a ScrollingFrame’s canvas', () => {
    const square = node('Frame', 'Square', { size: [0.5, 0, 0.5, 0], aspect: { ratio: 1 } });
    const scaled = node('Frame', 'Scaled', { size: [0, 100, 0, 50], scale: 2 });
    const item = node('TextLabel', 'Row', { pos: [0, 0, 0, 500], size: [1, 0, 0, 30], text: 'x' });
    const scroll = node('ScrollingFrame', 'List', { pos: [0, 0, 0, 600], size: [0, 200, 0, 100], canvas: [0, 0, 0, 1000] }, [item]);
    const boxes = layoutScreen(screen({ ignoreInset: true }, [square, scaled, scroll]), desktop);
    expect(box(boxes, 'Square')).toMatchObject({ w: 540, h: 540 });
    expect(box(boxes, 'Scaled')).toMatchObject({ w: 200, h: 100 });
    expect(box(boxes, 'Row')).toMatchObject({ y: 1100, clip: [0, 600, 200, 100] });
  });

  it('draws siblings by ZIndex, children over their parent, and a Global screen by ZIndex alone', () => {
    const low = node('Frame', 'Low', { z: 5 }, [node('Frame', 'LowChild', { z: 1 })]);
    const high = node('Frame', 'High', { z: 3 });
    const sib = layoutScreen(screen({}, [low, high]), desktop);
    expect(sib.map((b) => b.node.name)).toEqual(['High', 'Low', 'LowChild']);
    const glob = layoutScreen(screen({ global: true }, [node('Frame', 'Low', { z: 5 }, [node('Frame', 'LowChild', { z: 1 })]), node('Frame', 'High', { z: 3 })]), desktop);
    expect(glob.map((b) => b.node.name)).toEqual(['LowChild', 'High', 'Low']);
  });

  it('fits TextScaled text to its box, within a UITextSizeConstraint', () => {
    const label = node('TextLabel', 'Title', { size: [0, 400, 0, 60], text: 'Coins', scaled: true });
    const capped = node('TextLabel', 'Capped', { size: [0, 400, 0, 60], text: 'Coins', scaled: true, textMax: 24 });
    const boxes = layoutScreen(screen({}, [label, capped]), desktop);
    expect(box(boxes, 'Title').fontSize).toBe(60);
    expect(box(boxes, 'Capped').fontSize).toBe(24);
  });
});

describe('UI audit', () => {
  it('finds what a player would trip over on a phone and passes a sound HUD', () => {
    const bad = screen({ ignoreInset: true }, [
      // Offset-sized for a desktop: most of it hangs off a phone.
      node('Frame', 'Shop', { pos: [0, 300, 0, 100], size: [0, 900, 0, 600] }, [node('TextButton', 'Buy', { pos: [0, 700, 0, 500], size: [0, 120, 0, 50], text: 'Buy' })]),
      node('TextButton', 'Tiny', { pos: [1, -60, 1, -60], size: [0, 24, 0, 24], text: 'x', textSize: 8 }),
      node('TextButton', 'Menu', { pos: [0, 10, 0, 10], size: [0, 100, 0, 40], text: 'Menu' }),
      node('TextButton', 'Play', { pos: [0.5, -50, 0.5, 0], size: [0, 100, 0, 40], text: 'Play' }),
      node('TextButton', 'Quit', { pos: [0.5, -40, 0.5, 5], size: [0, 100, 0, 40], text: 'Quit' }),
      node('TextLabel', 'Hint', { pos: [0, 10, 1, -40], size: [0, 60, 0, 30], text: 'Press E to open the treasure chest', textSize: 18, textColor: [120, 120, 120], bg: [110, 110, 110], bgT: 0 }),
    ]);
    const findings = auditUi([bad]);
    const about = (path: string) => findings.filter((f) => f.path === path).map((f) => f.message).join(' | ');
    expect(about('HUD.Shop.Buy')).toMatch(/off the screen/);
    expect(findings.find((f) => f.path === 'HUD.Shop.Buy')!.devices).toEqual(['phone']);
    expect(about('HUD.Tiny')).toMatch(/Small to tap/);
    expect(about('HUD.Tiny')).toMatch(/reads tiny/);
    // Words want 13+ points on a phone (judges called 12.8 "tiny"); a 2-character count on a badge doesn't.
    const small = (text: string, textSize: number) => auditUi([screen({}, [node('TextLabel', 'L', { pos: [0, 100, 0, 100], size: [0, 200, 0, 30], text, textSize, bgT: 1 })])], ['phone']).some((f) => /reads tiny/.test(f.message));
    expect(small('Level 3', 12)).toBe(true);
    expect(small('Level 3', 14)).toBe(false);
    expect(small('x2', 12)).toBe(false);
    expect(about('HUD.Menu')).toMatch(/top bar/);
    expect(about('HUD.Play')).toMatch(/Overlaps HUD.Quit/);
    expect(about('HUD.Hint')).toMatch(/cut off/);
    expect(about('HUD.Hint')).toMatch(/Low contrast/);

    const good = screen({}, [
      node('Frame', 'Coins', { pos: [0, 16, 0, 16], size: [0.2, 0, 0.1, 0], sizeMin: [120, 44] }, [node('TextLabel', 'Amount', { size: [1, 0, 1, 0], text: '1,250', scaled: true, textColor: [255, 255, 255], bg: [20, 20, 20], bgT: 0 })]),
      node('TextButton', 'Shop', { pos: [1, -16, 1, -16], anchor: [1, 1], size: [0, 120, 0, 56], text: 'Shop', textSize: 22, textColor: [20, 20, 20], bg: [255, 200, 40], bgT: 0 }),
    ]);
    expect(auditUi([good])).toEqual([]);
    expect(contrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 0);
  });

  it('says so when there is no UI', () => {
    expect(auditUi([])[0]!.message).toMatch(/no UI yet/);
  });
});

describe('UI audit of what scripts show later', () => {
  it('checks a disabled screen and a hidden menu as if shown, each on its own', () => {
    const shop = screen({ enabled: false, ignoreInset: true }, [node('Frame', 'Window', { pos: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], size: [0, 760, 0, 520] }, [node('TextButton', 'Close', { pos: [1, -10, 0, 10], anchor: [1, 0], size: [0, 30, 0, 30], text: 'X' })])]);
    shop.name = 'Shop';
    // Two panels in the same spot, never shown together: no overlap between them.
    const menus = screen({}, [
      node('Frame', 'Settings', { visible: false, size: [0, 300, 0, 200] }, [node('TextButton', 'Apply', { size: [0, 120, 0, 50], text: 'Apply' })]),
      node('Frame', 'Inventory', { visible: false, size: [0, 300, 0, 200] }, [node('TextButton', 'Equip', { size: [0, 120, 0, 50], text: 'Equip' })]),
    ]);
    menus.name = 'Menus';
    const findings = auditUi([shop, menus]);
    const close = findings.filter((f) => f.path === 'Shop.Window.Close');
    expect(close.map((f) => f.message).join(' | ')).toMatch(/Small to tap/);
    expect(close.every((f) => f.whenShown)).toBe(true);
    // The 520-point window doesn't fit a 390-point phone.
    expect(findings.find((f) => f.path === 'Shop.Window.Close' && /off the screen/.test(f.message)) ?? findings.find((f) => f.path === 'Shop.Window')).toBeTruthy();
    expect(findings.some((f) => /Overlaps/.test(f.message))).toBe(false);
  });
});

describe('UI audit of pieces a small screen squeezes together', () => {
  it('flags top-level pieces that run into each other on a phone but not on a desktop', () => {
    const hud = screen({}, [
      node('Frame', 'Coins', { pos: [0, 16, 0, 12], size: [0, 190, 0, 52], bg: [20, 20, 20], bgT: 0.2 }),
      node('Frame', 'Quest', { pos: [0.5, 0, 0, 10], anchor: [0.5, 0], size: [0, 420, 0, 38], bg: [20, 20, 20], bgT: 0.3 }),
      // A transparent row whose buttons spill onto the bar below it.
      node('Frame', 'Abilities', { pos: [0.5, 0, 1, -66], anchor: [0.5, 1], size: [0, 300, 0, 64], list: { dir: 'Horizontal', h: 'Center', v: 'Center', pad: [0, 12] } }, [
        node('ImageButton', 'Dash', { size: [0, 120, 0, 120], bg: [30, 30, 30], bgT: 0, aspect: { ratio: 1 } }),
      ]),
      node('Frame', 'Health', { pos: [0.5, 0, 1, -24], anchor: [0.5, 1], size: [0, 300, 0, 30], bg: [20, 20, 20], bgT: 0.2 }),
      // A full-screen vignette is not a piece.
      node('Frame', 'Vignette', { size: [1, 0, 1, 0], bg: [0, 0, 0], bgT: 0.8 }),
    ]);
    const f = auditUi([hud]);
    const coins = f.find((x) => x.path === 'HUD.Coins' && /Runs into HUD.Quest/.test(x.message));
    expect(coins?.devices).toEqual(['phone']);
    expect(f.some((x) => x.path === 'HUD.Abilities' && /Runs into HUD.Health/.test(x.message))).toBe(true);
    expect(f.some((x) => /Vignette/.test(x.path) || /Vignette/.test(x.message))).toBe(false);
  });
});

// Every number below was measured in Studio 0.740 (AbsolutePosition/AbsoluteSize of the same UI).
describe('Roblox layout rules measured in Studio', () => {
  const big = { w: 3256, h: 1212 };
  const at = (boxes: ReturnType<typeof layoutScreen>, name: string, rel?: string) => {
    const b = box(boxes, name);
    const r = rel ? box(boxes, rel) : { x: 0, y: 0 };
    return [b.x - r.x, b.y - r.y, b.w, b.h].map((v) => Math.round(v * 10) / 10);
  };

  it("scales a ScreenGui's offsets (not its scale sizes) by its UIScale, size constraints before scaling, a frame's UIScale about its anchor", () => {
    const s = screen({ ignoreInset: true, scale: 0.5 }, [
      node('Frame', 'A', { pos: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], size: [0, 400, 0, 200] }),
      node('Frame', 'B', { pos: [0, 100, 0, 100], size: [0.5, 0, 0.25, 0] }),
      node('Frame', 'C', { size: [0, 400, 0, 200], sizeMax: [300, 300] }),
      node('Frame', 'D', { pos: [0, 1000, 0, 100], size: [0, 400, 0, 200], scale: 0.5 }, [node('Frame', 'Dk', { pos: [0, 100, 0, 50], size: [0.5, 0, 0.5, 0] })]),
      node('Frame', 'E', { pos: [0, 2000, 0, 400], anchor: [0.5, 0.5], size: [0, 400, 0, 200], scale: 0.5 }),
      node('Frame', 'F', { pos: [0, 3000, 0, 800], anchor: [1, 1], size: [0, 400, 0, 200], scale: 0.5 }),
    ]);
    const b = layoutScreen(s, big);
    expect(at(b, 'A')).toEqual([1528, 556, 200, 100]);
    expect(at(b, 'B')).toEqual([50, 50, 1628, 303]);
    expect(at(b, 'C')).toEqual([0, 0, 150, 100]);
    expect(at(b, 'D')).toEqual([500, 50, 100, 50]);
    expect(at(b, 'Dk')).toEqual([525, 62.5, 50, 25]);
    expect(at(b, 'E')).toEqual([950, 175, 100, 50]);
    expect(at(b, 'F')).toEqual([1400, 350, 100, 50]);
  });

  it('lays out UIListLayout flex: Fill, SpaceBetween/Around/Evenly, UIFlexItem Fill/Grow/Custom/Shrink, Wraps and Stretch', () => {
    type Kid = { w?: number; h?: number; size?: [number, number, number, number]; flex?: UiNode['flex'] };
    const row = (name: string, list: Partial<NonNullable<UiNode['list']>>, kids: Kid[]) =>
      node(
        'Frame',
        name,
        { size: [0, 600, 0, 100], list: { dir: 'Horizontal', h: 'Left', v: 'Top', pad: [0, 10], ...list } },
        kids.map((k, i) => node('Frame', `${name}${i + 1}`, { order: i + 1, size: k.size ?? [0, k.w ?? 100, 0, k.h ?? 40], ...(k.flex ? { flex: k.flex } : {}) })),
      );
    const three = [{}, {}, {}];
    const rows = [
      row('Fill', { hFlex: 'Fill' }, three),
      row('Between', { hFlex: 'SpaceBetween' }, three),
      row('Around', { hFlex: 'SpaceAround' }, three),
      row('Evenly', { hFlex: 'SpaceEvenly' }, three),
      row('ItemFill', {}, [{}, { flex: { mode: 'Fill' } }, {}]),
      row('ItemGrow', {}, [{ flex: { mode: 'Grow' } }, { flex: { mode: 'Custom', grow: 3, shrink: 1 } }, {}]),
      row('Shrink', {}, [{ w: 300, flex: { mode: 'Shrink' } }, { w: 300 }, {}]),
      row('Wrap', { wraps: true }, [{ w: 250 }, { w: 250, h: 30 }, { w: 250, h: 20 }, { w: 100 }]),
      row('Stretch', { itemAlign: 'Stretch', v: 'Center' }, [{}, { h: 60 }]),
      row('FillZero', {}, [{ size: [0, 0, 1, 0], flex: { mode: 'Fill' } }, { w: 52, h: 52 }]),
    ];
    const got: Record<string, number[]> = {};
    for (const r of rows) {
      const b = layoutScreen(screen({ ignoreInset: true }, [r]), big);
      for (const k of r.kids!) got[k.name] = at(b, k.name, r.name);
    }
    expect(got).toEqual({
      Fill1: [0, 0, 193.3, 40],
      Fill2: [203.3, 0, 193.3, 40],
      Fill3: [406.7, 0, 193.3, 40],
      Between1: [0, 0, 100, 40],
      Between2: [250, 0, 100, 40],
      Between3: [500, 0, 100, 40],
      Around1: [50, 0, 100, 40],
      Around2: [250, 0, 100, 40],
      Around3: [450, 0, 100, 40],
      Evenly1: [75, 0, 100, 40],
      Evenly2: [250, 0, 100, 40],
      Evenly3: [425, 0, 100, 40],
      ItemFill1: [0, 0, 100, 40],
      ItemFill2: [110, 0, 380, 40],
      ItemFill3: [500, 0, 100, 40],
      ItemGrow1: [0, 0, 170, 40],
      ItemGrow2: [180, 0, 310, 40],
      ItemGrow3: [500, 0, 100, 40],
      Shrink1: [0, 0, 180, 40],
      Shrink2: [190, 0, 300, 40],
      Shrink3: [500, 0, 100, 40],
      Wrap1: [0, 0, 250, 40],
      Wrap2: [260, 0, 250, 30],
      Wrap3: [0, 50, 250, 20],
      Wrap4: [260, 50, 100, 40],
      Stretch1: [0, 20, 100, 60],
      Stretch2: [110, 20, 100, 60],
      FillZero1: [0, 0, 538, 100],
      FillZero2: [548, 0, 52, 52],
    });
    // A vertical list spread SpaceBetween.
    const col = node(
      'Frame',
      'Col',
      { size: [0, 200, 0, 400], list: { dir: 'Vertical', h: 'Center', v: 'Top', pad: [0, 0], vFlex: 'SpaceBetween' } },
      [100, 50, 60].map((h, i) => node('Frame', `C${i + 1}`, { order: i, size: [1, 0, 0, h] })),
    );
    const cb = layoutScreen(screen({ ignoreInset: true }, [col]), big);
    expect(['C1', 'C2', 'C3'].map((n) => at(cb, n, 'Col'))).toEqual([
      [0, 0, 200, 100],
      [0, 195, 200, 50],
      [0, 340, 200, 60],
    ]);
  });

  it('sizes AutomaticSize text to its text plus UIPadding before the list places it, and shows one UIPageLayout page', () => {
    const widths: Record<string, number> = { Cancel: 60, 'Confirm purchase': 140 };
    const measure = (t: string) => widths[t] ?? 0;
    const buttons = ['Cancel', 'Confirm purchase'].map((text, i) =>
      node('TextButton', `B${i + 1}`, { order: i + 1, text, textSize: 20, bold: true, auto: 'X', size: [0, 120, 0, 52], padding: [[0, 0], [0, 20], [0, 0], [0, 20]] }),
    );
    const rowF = node('Frame', 'Row', { size: [0, 800, 0, 60], list: { dir: 'Horizontal', h: 'Right', v: 'Top', pad: [0, 12] } }, buttons);
    const b = layoutScreen(screen({ ignoreInset: true }, [rowF]), big, { measure });
    expect(at(b, 'B1', 'Row')).toEqual([488, 0, 120, 52]);
    expect(at(b, 'B2', 'Row')).toEqual([620, 0, 180, 52]);

    const pages = node(
      'Frame',
      'Pages',
      { size: [0, 400, 0, 300], clips: true, pages: {} },
      [1, 2, 3].map((i) => node('Frame', `Page${i}`, { order: i, size: [0.5, 0, 1, 0] }, [node('TextButton', `Go${i}`, { size: [0, 150, 0, 50], text: 'Go' })])),
    );
    const pb = layoutScreen(screen({ ignoreInset: true }, [pages]), big);
    expect(pb.map((x) => x.node.name)).toEqual(['Pages', 'Page1', 'Go1']);
    expect(at(pb, 'Page1', 'Pages')).toEqual([0, 0, 200, 300]);
    // The other pages are checked as if shown, each on its own: no overlaps between pages.
    const f = auditUi([screen({}, [pages])]);
    expect(f.some((x) => /Overlaps/.test(x.message))).toBe(false);
  });

  it('fits a script-fitted UIScale per device, so a window capped in design units fits a phone', () => {
    const win = node('Frame', 'Window', { pos: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], size: [0.96, 0, 0.96, 0], sizeMax: [980, 680] }, [
      node('TextButton', 'Close', { pos: [1, -16, 0, 16], anchor: [1, 0], size: [0, 56, 0, 56], text: 'X', textSize: 20 }),
    ]);
    const s = screen({ scale: 0.83, fit: { ref: [1920, 1080], min: 0.8, max: 1.5 } }, [win]);
    const phone = box(layoutScreen(s, { w: 844, h: 390, side: 44 }), 'Window');
    // 0.8 on the phone: 0.96 of its 332-point-high area, under the 680 × 0.8 cap.
    expect(phone.k).toBeCloseTo(0.8);
    expect(phone.h).toBeCloseTo(0.96 * 332);
    const desk = box(layoutScreen(s, { w: 1920, h: 1080 }), 'Window');
    expect(desk.k).toBeCloseTo(1022 / 1080);
    expect(desk.w).toBeCloseTo(980 * (1022 / 1080));
    expect(auditUi([s]).filter((x) => x.severity === 'problem')).toEqual([]);
    // Without the attributes the captured value is used everywhere, and the audit says so.
    const plain = screen({ scale: 0.83 }, [node('Frame', 'Panel', { size: [0, 100, 0, 100] })]);
    expect(auditUi([plain]).map((x) => x.message).join(' ')).toMatch(/FitReference/);
  });

  it("estimates text close to Roblox's TextBounds for BuilderSans", () => {
    const n = (bold: boolean): UiNode => ({ id: 0, name: 't', cls: 'TextLabel', bold });
    const near = (v: number, want: number) => expect(Math.abs(v - want) / want).toBeLessThan(0.09);
    near(estimateText('Buy Golden Sword for 900 coins?', 20, n(false)), 256);
    near(estimateText('Confirm purchase', 20, n(true)), 140);
    near(estimateText('Golden Sword', 18, n(true)), 99);
    near(estimateText('SHOP', 32, n(true)), 70);
  });

  it('calls an element off every screen parked (a slide-in), and one off a phone only a problem', () => {
    const toast = node('TextLabel', 'Toast', { pos: [0.5, 0, 0, -200], anchor: [0.5, 0], size: [0, 520, 0, 64], text: 'Level up!', textSize: 24 });
    const wide = node('TextButton', 'Wide', { pos: [0, 700, 0, 100], size: [0, 400, 0, 60], text: 'Play' });
    const f = auditUi([screen({}, [toast, wide])]);
    const parked = f.find((x) => x.path === 'HUD.Toast')!;
    expect(parked.severity).toBe('warning');
    expect(parked.message).toMatch(/parked/);
    const slip = f.find((x) => x.path === 'HUD.Wide' && /off the screen/.test(x.message))!;
    expect(slip.devices).toEqual(['phone']);
  });

  it('warns about buttons under the top bar on screens that cover it (DeviceSafeInsets too)', () => {
    const corner = () => node('TextButton', 'Menu', { pos: [0, 10, 0, 10], size: [0, 100, 0, 40], text: 'Menu' });
    const device = screen({ insets: 'DeviceSafeInsets' }, [corner()]);
    const safe = screen({ insets: 'CoreUISafeInsets' }, [corner()]);
    expect(auditUi([device]).some((f) => /top bar/.test(f.message))).toBe(true);
    expect(auditUi([safe]).some((f) => /top bar/.test(f.message))).toBe(false);
  });

  it("doesn't call truncated text cut off", () => {
    const label = (truncate: boolean) => node('TextLabel', 'Name', { size: [0, 80, 0, 30], text: 'A very long player name here', textSize: 18, truncate });
    expect(auditUi([screen({}, [label(false)])]).some((f) => /cut off/.test(f.message))).toBe(true);
    expect(auditUi([screen({}, [label(true)])]).some((f) => /cut off/.test(f.message))).toBe(false);
    // …but says where its end doesn't show ("MAX" as "M…"), and not where it fits.
    expect(auditUi([screen({}, [label(true)])]).some((f) => /ends in "…"/.test(f.message))).toBe(true);
    const short = node('TextLabel', 'Name', { size: [0, 200, 0, 30], text: 'Short', textSize: 18, truncate: true });
    expect(auditUi([screen({}, [short])]).some((f) => /ends in "…"/.test(f.message))).toBe(false);
  });

  it('finds small content hidden under a button (a skinned one by its art), not the button\'s own or a shadow plate', () => {
    const row = (pipX: number, skinned?: number) =>
      screen({}, [
        node('Frame', 'Row', { pos: [0, 100, 0, 200], size: [0, 300, 0, 60], bgT: 1 }, [
          node('Frame', 'Pip', { pos: [0, pipX, 0, 20], size: [0, 20, 0, 12], bg: [255, 200, 0] }),
          node('Frame', 'Shadow', { pos: [0, 184, 0, 9], size: [0, 110, 0, 46], bg: [0, 0, 0], bgT: 0.4 }),
          node('TextButton', 'Buy', { pos: [0, 180, 0, 5], size: [0, 110, 0, 46], text: '95,000', ...(skinned !== undefined ? { skinned, bgT: 1 } : {}) }, [node('ImageLabel', 'Coin', { pos: [0, 4, 0, 10], size: [0, 24, 0, 24], image: 'icon:Coin' })]),
        ]),
      ]);
    const hidden = (s: UiNode) => auditUi([s]).filter((f) => /Hidden under/.test(f.message));
    expect(hidden(row(175)).map((f) => f.path)).toEqual(['HUD.Row.Pip']);
    expect(hidden(row(175))[0]!.severity).toBe('problem');
    expect(hidden(row(150))).toEqual([]);
    // The art of a skinned button reaches past its box: a pip just clear of the box is under its outline and side.
    expect(hidden(row(165, 16)).map((f) => f.path)).toEqual(['HUD.Row.Pip']);
    expect(hidden(row(165))).toEqual([]);
  });

  it('finds a list spilling out of its window (a ScrollingFrame grown by AutomaticSize), not a sticker or a title over the top', () => {
    const rows = [0, 1, 2, 3, 4].map((i) => node('Frame', `Row${i}`, { size: [1, 0, 0, 70], bg: [255, 255, 255], order: i }));
    const win = (list: Partial<UiNode>) =>
      screen({}, [
        node('Frame', 'Window', { pos: [0, 40, 0, 20], size: [0, 500, 0, 260], bg: [200, 60, 40] }, [
          node('TextLabel', 'Title', { pos: [0, 100, 0, -30], size: [0, 300, 0, 50], text: 'UPGRADES', textSize: 30, bgT: 1 }),
          node('Frame', 'Sticker', { pos: [1, -20, 0, 40], size: [0, 40, 0, 24], bg: [255, 200, 0] }),
          node('ScrollingFrame', 'List', { pos: [0, 10, 0, 40], size: [1, -20, 0, 200], bgT: 1, list: { dir: 'Vertical', h: 'Center', v: 'Top', pad: [0, 8] }, ...list }, rows),
        ]),
      ]);
    const spills = (s: UiNode) => auditUi([s], ['desktop']).filter((f) => /Spills out|AutomaticSize/.test(f.message));
    // Sized to the window, it scrolls: nothing spills, and the title and sticker over the edges are fine.
    expect(spills(win({}))).toEqual([]);
    // AutomaticSize grows the frame to its rows: the last ones draw below the window, and the cause is named.
    const grown = spills(win({ size: [1, -20, 0, 0], auto: 'Y' }));
    expect(grown.some((f) => f.path === 'HUD.Window.List.Row4' && f.severity === 'problem' && /bottom edge/.test(f.message))).toBe(true);
    expect(grown.some((f) => f.path === 'HUD.Window.List' && /AutomaticSize Y on a ScrollingFrame/.test(f.message))).toBe(true);
  });
});

describe('filmstrip frames', () => {
  it('spreads frames across the clip and puts one exactly on each marker', () => {
    expect(filmstripTimes(0.5, [], 6)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    const t = filmstripTimes(0.5, [{ t: 0.2 }], 8);
    expect(t).toHaveLength(8);
    expect(t).toContain(0.2);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBe(0.5);
    // Two markers close together each get their own frame.
    expect(filmstripTimes(1, [{ t: 0.5 }, { t: 0.52 }], 8)).toEqual(expect.arrayContaining([0.5, 0.52]));
  });
});
