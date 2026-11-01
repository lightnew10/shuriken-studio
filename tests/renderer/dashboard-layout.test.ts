import { describe, expect, it } from 'vitest';
import { CELLS, DEFAULT_LAYOUT, addContainer, applyChoices, fillRect, isShown, loadSaved, placeCell, removeCell, restoreCell, type Cell } from '../../src/renderer/src/lib/dashboard-layout';
import { kilnBuildLine, type KilnBuildRow } from '../../src/renderer/src/lib/kiln-line';

// The dashboard's containers (pages/dashboard.tsx): Kiln's container is off by default and its room goes
// back to the others; any container can be hidden and shown again without leaving a hole or covering another.

const COLS = 12;
const ROWS = 20;
const at = (l: readonly Cell[], id: string) => {
  const c = l.find((x) => x.i === id);
  return c ? [c.x, c.y, c.w, c.h] : null;
};
/** No two containers overlap and all stay inside the grid. */
function valid(l: readonly Cell[]): boolean {
  for (const a of l) {
    if (a.x < 0 || a.y < 0 || a.x + a.w > COLS || a.y + a.h > ROWS) return false;
    for (const b of l) if (a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false;
  }
  return true;
}
/** Every cell of the grid is covered: no hole. */
const full = (l: readonly Cell[]) => l.reduce((n, c) => n + c.w * c.h, 0) === COLS * ROWS;
/** A layout as localStorage keeps it (positions only). */
const saved = (l: readonly Cell[]) => l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));

// The 1.8.1–1.9 default: Kiln under a shortened director chat.
const KILN_UNDER_CHAT: Cell[] = [
  { i: 'viewer', x: 0, y: 0, w: 8, h: 12 },
  { i: 'chat', x: 8, y: 0, w: 4, h: 12 },
  { i: 'kiln', x: 8, y: 12, w: 4, h: 8 },
  { i: 'pipeline', x: 0, y: 12, w: 4, h: 8 },
  { i: 'models', x: 4, y: 12, w: 2, h: 4 },
  { i: 'audio', x: 6, y: 12, w: 2, h: 4 },
  { i: 'animation', x: 4, y: 16, w: 2, h: 4 },
  { i: 'ui', x: 6, y: 16, w: 2, h: 4 },
];

describe('the default dashboard', () => {
  it('has no Kiln container and fills the grid', () => {
    expect(DEFAULT_LAYOUT.some((c) => c.i === 'kiln')).toBe(false);
    expect(isShown('kiln', {})).toBe(false);
    expect(isShown('models', {})).toBe(true);
    expect(valid(DEFAULT_LAYOUT) && full(DEFAULT_LAYOUT)).toBe(true);
    expect(loadSaved(null, {}, {})).toEqual(DEFAULT_LAYOUT);
  });
});

describe('a dashboard saved with Kiln on it', () => {
  it('puts the containers new since then where Kiln was (the old default becomes the new one)', () => {
    const l = loadSaved(saved(KILN_UNDER_CHAT), {}, {});
    expect(at(l, 'kiln')).toBeNull();
    expect(at(l, 'chat')).toEqual([8, 0, 4, 12]);
    expect(at(l, 'effects')).toEqual([8, 12, 2, 8]);
    // The Storefront (1.15) then takes the lower half of Quality, as on the default dashboard.
    expect(at(l, 'quality')).toEqual([10, 12, 2, 4]);
    expect(at(l, 'storefront')).toEqual([10, 16, 2, 4]);
    expect(valid(l) && full(l)).toBe(true);
    expect([...l].sort((a, b) => a.i.localeCompare(b.i))).toEqual([...DEFAULT_LAYOUT].sort((a, b) => a.i.localeCompare(b.i)));
  });

  it('gives Kiln’s room back to the director chat above it when nothing new wants it', () => {
    const l = loadSaved(saved(KILN_UNDER_CHAT), { effects: false, quality: false, storefront: false }, {});
    expect(at(l, 'kiln')).toBeNull();
    expect(at(l, 'effects')).toBeNull();
    expect(at(l, 'chat')).toEqual([8, 0, 4, 20]);
    expect(valid(l) && full(l)).toBe(true);
    // Minimums come from the defaults.
    expect(l.find((c) => c.i === 'chat')).toMatchObject({ minW: 3, minH: 6 });
  });

  it('gives it to the viewer when Kiln sat at the viewer’s right', () => {
    const l0: Cell[] = [
      { i: 'viewer', x: 0, y: 0, w: 5, h: 12 },
      { i: 'kiln', x: 5, y: 0, w: 3, h: 12 },
      { i: 'chat', x: 8, y: 0, w: 4, h: 20 },
      ...KILN_UNDER_CHAT.filter((c) => ['pipeline', 'models', 'audio', 'animation', 'ui'].includes(c.i)),
    ];
    const l = loadSaved(saved(l0), { effects: false, quality: false, storefront: false }, {});
    expect(at(l, 'viewer')).toEqual([0, 0, 8, 12]);
    expect(valid(l) && full(l)).toBe(true);
    // A tall place: the new containers one above the other.
    const fx = loadSaved(saved(l0), {}, {});
    expect(at(fx, 'effects')).toEqual([5, 0, 3, 6]);
    expect(at(fx, 'quality')).toEqual([5, 6, 3, 6]);
    expect(valid(fx) && full(fx)).toBe(true);
  });

  it('keeps Kiln for a user who turned it on, and still finds room for the new containers', () => {
    const l = loadSaved(saved(KILN_UNDER_CHAT), { kiln: true }, {});
    expect(at(l, 'kiln')).toEqual([8, 12, 4, 8]);
    expect(at(l, 'chat')).toEqual([8, 0, 4, 12]);
    expect(at(l, 'effects')).not.toBeNull();
    expect(at(l, 'quality')).not.toBeNull();
    expect(valid(l) && full(l)).toBe(true);
  });

  it('still adds the UI tile to a layout saved before it existed', () => {
    const old = KILN_UNDER_CHAT.filter((c) => c.i !== 'ui').map((c) => (c.i === 'animation' ? { ...c, w: 4 } : c));
    const l = loadSaved(saved(old), {}, {});
    expect(at(l, 'ui')).toEqual([6, 16, 2, 4]);
    expect(valid(l) && full(l)).toBe(true);
  });

  it('drops containers it doesn’t know', () => {
    const l = loadSaved([...saved(KILN_UNDER_CHAT), { i: 'gone', x: 0, y: 0, w: 1, h: 1 }], {}, {});
    expect(at(l, 'gone')).toBeNull();
  });
});

describe('hiding and showing containers', () => {
  it('Kiln turned on takes the right of the viewer on the default dashboard (its old place is the new containers’)', () => {
    const l = addContainer(DEFAULT_LAYOUT, 'kiln', {});
    expect(at(l, 'kiln')).toEqual([4, 0, 4, 12]);
    expect(at(l, 'viewer')).toEqual([0, 0, 4, 12]);
    expect(valid(l) && full(l)).toBe(true);
  });

  it('Kiln turned on takes the lower part of a tall director chat when there is one', () => {
    const l = addContainer(applyChoices(DEFAULT_LAYOUT, { effects: false, quality: false, storefront: false }, {}), 'kiln', {});
    expect(at(l, 'kiln')).toEqual([8, 12, 4, 8]);
    expect(at(l, 'chat')).toEqual([8, 0, 4, 12]);
    expect(valid(l) && full(l)).toBe(true);
  });

  it('with that place taken, Kiln takes the right of the viewer (its own UI wants room)', () => {
    const l0: Cell[] = [
      { i: 'viewer', x: 0, y: 0, w: 8, h: 12, minW: 3, minH: 5 },
      { i: 'chat', x: 8, y: 0, w: 4, h: 12, minW: 3, minH: 6 },
      { i: 'pipeline', x: 0, y: 12, w: 4, h: 8 },
      { i: 'models', x: 4, y: 12, w: 4, h: 4 },
      { i: 'animation', x: 4, y: 16, w: 4, h: 4 },
      { i: 'audio', x: 8, y: 12, w: 4, h: 4 },
      { i: 'ui', x: 8, y: 16, w: 4, h: 4 },
    ];
    const l = addContainer(l0, 'kiln', {});
    expect(at(l, 'kiln')).toEqual([4, 0, 4, 12]);
    expect(at(l, 'viewer')).toEqual([0, 0, 4, 12]);
    expect(valid(l) && full(l)).toBe(true);
  });

  it('a hidden container’s room goes to its neighbours and comes back with it', () => {
    for (const { i } of DEFAULT_LAYOUT) {
      const before = DEFAULT_LAYOUT.find((c) => c.i === i)!;
      const without = removeCell(DEFAULT_LAYOUT, i);
      expect(without.some((c) => c.i === i)).toBe(false);
      expect(valid(without)).toBe(true);
      const back = addContainer(without, i, { [i]: { x: before.x, y: before.y, w: before.w, h: before.h } });
      expect(valid(back) && full(back)).toBe(true);
      expect(at(back, i)).toEqual([before.x, before.y, before.w, before.h]);
    }
  });

  it('applies choices both ways', () => {
    const hidden = applyChoices(DEFAULT_LAYOUT, { audio: false }, {});
    expect(at(hidden, 'audio')).toBeNull();
    expect(at(hidden, 'models')).toEqual([4, 12, 4, 4]);
    expect(valid(hidden) && full(hidden)).toBe(true);
    const shown = applyChoices(hidden, {}, { audio: { x: 6, y: 12, w: 2, h: 4 } });
    expect(shown.find((c) => c.i === 'audio')).toMatchObject({ x: 6, y: 12, w: 2, h: 4 });
  });
});

describe('layout moves', () => {
  it('removeCell grows the cells along one whole side, else just leaves the cell out', () => {
    const stack: Cell[] = [
      { i: 'a', x: 0, y: 0, w: 2, h: 2 },
      { i: 'b', x: 0, y: 2, w: 2, h: 2 },
      { i: 'gone', x: 2, y: 0, w: 2, h: 4 },
    ];
    expect(removeCell(stack, 'gone')).toEqual([
      { i: 'a', x: 0, y: 0, w: 4, h: 2 },
      { i: 'b', x: 0, y: 2, w: 4, h: 2 },
    ]);
    const ragged: Cell[] = [
      { i: 'a', x: 0, y: 0, w: 3, h: 2 },
      { i: 'gone', x: 1, y: 2, w: 2, h: 2 },
    ];
    expect(removeCell(ragged, 'gone')).toEqual([{ i: 'a', x: 0, y: 0, w: 3, h: 2 }]);
  });

  it('placeCell keeps the minimums of the container it splits, and goes under everything when none can spare room', () => {
    const tiny: Cell[] = [{ i: 'a', x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2 }];
    expect(placeCell(tiny, { i: 'k', x: 0, y: 0, w: 4, h: 8, minW: 3, minH: 4 })).toEqual([...tiny, { i: 'k', x: 0, y: 2, w: 4, h: 8, minW: 3, minH: 4 }]);
  });

  it('restoreCell refuses to carve a container that moved into the middle of the old place', () => {
    const l: Cell[] = [{ i: 'a', x: 0, y: 0, w: 4, h: 4 }];
    expect(restoreCell(l, { i: 'b', x: 1, y: 1, w: 2, h: 2 })).toBeNull();
    expect(restoreCell(l, { i: 'b', x: 0, y: 2, w: 4, h: 2 })).toEqual([
      { i: 'a', x: 0, y: 0, w: 4, h: 2 },
      { i: 'b', x: 0, y: 2, w: 4, h: 2 },
    ]);
  });

  it('fillRect shares a place side by side when it is wide, stacked when it is tall', () => {
    const two = [
      { i: 'a', x: 0, y: 0, w: 1, h: 1 },
      { i: 'b', x: 0, y: 0, w: 1, h: 1 },
    ];
    expect(fillRect({ i: 'r', x: 8, y: 12, w: 4, h: 8 }, two).map((c) => [c.i, c.x, c.y, c.w, c.h])).toEqual([
      ['a', 8, 12, 2, 8],
      ['b', 10, 12, 2, 8],
    ]);
    expect(fillRect({ i: 'r', x: 0, y: 0, w: 2, h: 9 }, two).map((c) => [c.i, c.x, c.y, c.w, c.h])).toEqual([
      ['a', 0, 0, 2, 5],
      ['b', 0, 5, 2, 4],
    ]);
  });

  it('every container has a default cell', () => {
    expect(CELLS.map((c) => c.i).sort()).toEqual(['animation', 'audio', 'chat', 'effects', 'kiln', 'models', 'pipeline', 'quality', 'storefront', 'ui', 'viewer']);
  });
});

describe('the Models container’s Kiln line', () => {
  const build = (b: Partial<KilnBuildRow>): KilnBuildRow => ({ id: 'kb', name: 'Mech', kind: 'model', by: 'Modeler', state: 'running', step: null, queuedAt: 0, startedAt: 0, endedAt: null, costUsd: null, error: null, ...b });

  it('says nothing when Kiln builds nothing for this project', () => {
    expect(kilnBuildLine(null)).toBeNull();
    expect(kilnBuildLine({ builds: [build({ state: 'done' }), build({ state: 'failed' })] })).toBeNull();
  });

  it('names the model or family, how far Kiln’s copilot is and what it does', () => {
    const line = kilnBuildLine({ builds: [build({ name: 'MechParts', family: true, kilnProject: 'kp1', step: 'building', progress: { done: 3, total: 7, current: 'Texturing the legs', etaMs: 4 * 60_000, lastRender: null } })] });
    expect(line).toEqual({ text: 'Kiln · MechParts family · 3/7 · Texturing the legs · ~4 min left', project: 'kp1' });
  });

  it('falls back to the queue’s step without Kiln 0.8.2 progress', () => {
    expect(kilnBuildLine({ builds: [build({ step: 'rigging' })] })?.text).toBe('Kiln · Mech · rigging');
  });

  it('counts the others building and waiting', () => {
    const builds = [build({ name: 'A' }), build({ name: 'B' }), build({ name: 'C', state: 'queued' }), build({ name: 'D', state: 'queued' })];
    expect(kilnBuildLine({ builds })?.text).toBe('Kiln · A · +1 building · +2 waiting');
    expect(kilnBuildLine({ builds: builds.slice(2) })?.text).toBe('Kiln · C waiting its turn · +1 waiting');
  });
});
