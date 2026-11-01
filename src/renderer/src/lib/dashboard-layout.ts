/**
 * Adding and taking away a dashboard container without leaving a hole or covering another: the grid
 * (react-grid-layout) only compacts upwards, so a container taken from the bottom of a column would
 * leave empty space. Pure, tested in tests/renderer.
 */

/** A container's cell on the dashboard grid (the fields of react-grid-layout's LayoutItem used here). */
export interface Cell {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

type Side = 'top' | 'left' | 'bottom' | 'right';
const SIDES: Side[] = ['top', 'left', 'bottom', 'right'];

/** `c` lies against side `side` of `g`, within its span. */
function touches(c: Cell, g: Cell, side: Side): boolean {
  if (side === 'top') return c.y + c.h === g.y && c.x >= g.x && c.x + c.w <= g.x + g.w;
  if (side === 'bottom') return c.y === g.y + g.h && c.x >= g.x && c.x + c.w <= g.x + g.w;
  if (side === 'left') return c.x + c.w === g.x && c.y >= g.y && c.y + c.h <= g.y + g.h;
  return c.x === g.x + g.w && c.y >= g.y && c.y + c.h <= g.y + g.h;
}

function grow<T extends Cell>(c: T, g: Cell, side: Side): T {
  if (side === 'top') return { ...c, h: c.h + g.h };
  if (side === 'bottom') return { ...c, y: g.y, h: c.h + g.h };
  if (side === 'left') return { ...c, w: c.w + g.w };
  return { ...c, x: g.x, w: c.w + g.w };
}

/**
 * The layout without one container, its space given to the containers beside it: those lining up with
 * one whole side of it (above first, then left, below, right) grow over it. With no such side it is
 * just left out (the grid then moves up what was under it).
 */
export function removeCell<T extends Cell>(layout: readonly T[], id: string): T[] {
  const gone = layout.find((c) => c.i === id);
  const rest = layout.filter((c) => c.i !== id);
  if (!gone) return rest;
  for (const side of SIDES) {
    const along = rest.filter((c) => touches(c, gone, side));
    const span = along.reduce((n, c) => n + (side === 'top' || side === 'bottom' ? c.w : c.h), 0);
    if (!along.length || span !== (side === 'top' || side === 'bottom' ? gone.w : gone.h)) continue;
    const growing = new Set(along.map((c) => c.i));
    return rest.map((c) => (growing.has(c.i) ? grow(c, gone, side) : c));
  }
  return rest;
}

const overlaps = (a: Cell, b: Cell): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** `c` without `g` when `g` covers one whole end of it (what `removeCell` grew over); null otherwise. */
function carve<T extends Cell>(c: T, g: Cell): T | null {
  let out: T | null = null;
  if (g.x <= c.x && g.x + g.w >= c.x + c.w) {
    if (g.y <= c.y && g.y + g.h < c.y + c.h) out = { ...c, y: g.y + g.h, h: c.y + c.h - g.y - g.h };
    else if (g.y > c.y && g.y + g.h >= c.y + c.h) out = { ...c, h: g.y - c.y };
  } else if (g.y <= c.y && g.y + g.h >= c.y + c.h) {
    if (g.x <= c.x && g.x + g.w < c.x + c.w) out = { ...c, x: g.x + g.w, w: c.x + c.w - g.x - g.w };
    else if (g.x > c.x && g.x + g.w >= c.x + c.w) out = { ...c, w: g.x - c.x };
  }
  return out && out.w >= (c.minW ?? 1) && out.h >= (c.minH ?? 1) ? out : null;
}

/**
 * A container back where it was (`cell` carries its old place): the containers that grew over that
 * place give the room back. Null when they moved since and it can't be carved out cleanly.
 */
export function restoreCell<T extends Cell>(layout: readonly T[], cell: T): T[] | null {
  const rest = layout.filter((c) => c.i !== cell.i);
  const next: T[] = [];
  for (const c of rest) {
    if (!overlaps(c, cell)) next.push(c);
    else {
      const cut = carve(c, cell);
      if (!cut) return null;
      next.push(cut);
    }
  }
  return [...next, cell];
}

/**
 * Several containers sharing one place (the room a container left): side by side when the place is
 * wider than tall on screen (a grid column is about three rows), else one above the other. Each keeps
 * its own fields (id, minimums); the place's size is shared out, the first ones getting any remainder.
 */
export function fillRect<T extends Cell>(rect: Cell, cells: readonly T[]): T[] {
  const n = cells.length;
  const across = rect.w * 3 >= rect.h && rect.w >= n;
  const total = across ? rect.w : rect.h;
  const base = Math.floor(total / n);
  let at = across ? rect.x : rect.y;
  return cells.map((c, k) => {
    const size = base + (k < total % n ? 1 : 0);
    const out = across ? { ...c, x: at, y: rect.y, w: size, h: rect.h } : { ...c, x: rect.x, y: at, w: rect.w, h: size };
    at += size;
    return out;
  });
}

/**
 * The layout with a container added where it fits: it takes part of one container (the first of
 * `prefer` that can spare the room, else the biggest that can): the lower rows of a tall one, the right
 * columns of a wide one, each keeping its own minimum size. With none that can, it goes under everything.
 */
export function placeCell<T extends Cell>(layout: readonly T[], cell: T, prefer: string[] = []): T[] {
  const rest = layout.filter((c) => c.i !== cell.i);
  const minW = cell.minW ?? 2;
  const minH = cell.minH ?? 2;
  const split = (c: T): [T, T] | null => {
    // A grid column is about three rows wide on screen: split the longer way.
    const tall = c.h > c.w * 3;
    if (tall && c.w >= minW) {
      const h = Math.min(cell.h, c.h - (c.minH ?? 2));
      if (h >= minH) return [{ ...c, h: c.h - h }, { ...cell, x: c.x, y: c.y + c.h - h, w: c.w, h }];
    }
    if (!tall && c.h >= minH) {
      const w = Math.min(cell.w, c.w - (c.minW ?? 2));
      if (w >= minW) return [{ ...c, w: c.w - w }, { ...cell, x: c.x + c.w - w, y: c.y, w, h: c.h }];
    }
    return null;
  };
  const order = [...rest].sort((a, b) => {
    const pa = prefer.indexOf(a.i);
    const pb = prefer.indexOf(b.i);
    if (pa >= 0 || pb >= 0) return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
    return b.w * b.h - a.w * a.h;
  });
  for (const c of order) {
    const made = split(c);
    if (made) return [...rest.map((x) => (x === c ? made[0] : x)), made[1]];
  }
  const bottom = rest.reduce((n, c) => Math.max(n, c.y + c.h), 0);
  return [...rest, { ...cell, x: 0, y: bottom }];
}

// ─── The dashboard's containers ───────────────────────────────────────────────

export type ContainerId = 'viewer' | 'chat' | 'pipeline' | 'models' | 'audio' | 'animation' | 'ui' | 'effects' | 'quality' | 'storefront' | 'kiln';

/** The default dashboard: 12 columns, 20 rows. Effects and Quality (1.9.x) sit where Kiln's container was; the Storefront (1.15) under Quality. */
export const DEFAULT_LAYOUT: Cell[] = [
  { i: 'viewer', x: 0, y: 0, w: 8, h: 12, minW: 3, minH: 5 },
  { i: 'chat', x: 8, y: 0, w: 4, h: 12, minW: 3, minH: 6 },
  { i: 'pipeline', x: 0, y: 12, w: 4, h: 8, minW: 2, minH: 4 },
  { i: 'models', x: 4, y: 12, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'audio', x: 6, y: 12, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'animation', x: 4, y: 16, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'ui', x: 6, y: 16, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'effects', x: 8, y: 12, w: 2, h: 8, minW: 2, minH: 4 },
  { i: 'quality', x: 10, y: 12, w: 2, h: 4, minW: 2, minH: 3 },
  { i: 'storefront', x: 10, y: 16, w: 2, h: 4, minW: 2, minH: 3 },
];
/** Containers that are off until the user turns them on (Edit layout), with the place they had by default: Kiln, whose models and clips the Models and Animation containers show. */
export const OFF_BY_DEFAULT: Cell[] = [{ i: 'kiln', x: 8, y: 12, w: 4, h: 8, minW: 3, minH: 4 }];
/** Every container's default cell (its size and minimums). */
export const CELLS: Cell[] = [...DEFAULT_LAYOUT, ...OFF_BY_DEFAULT];

/** The user's choices of which containers show; a container without one follows its default. */
export type Choices = Partial<Record<string, boolean>>;
/** Where a container was when the user hid it. */
export type Places = Partial<Record<string, { x: number; y: number; w: number; h: number }>>;

export const isShown = (id: string, choices: Choices): boolean => choices[id] ?? !OFF_BY_DEFAULT.some((c) => c.i === id);

/** A container coming back: where it was (or its default place) when that room can be given back, else where it fits. */
export function addContainer(l: readonly Cell[], id: string, places: Places): Cell[] {
  const cell = CELLS.find((c) => c.i === id);
  if (!cell) return [...l];
  const back = restoreCell(l, { ...cell, ...(places[id] ?? {}) });
  if (back) return back;
  // Kiln takes the lower part of a tall director chat, else the right of the viewer (its own UI wants room).
  const chat = l.find((c) => c.i === 'chat');
  return placeCell(l, cell, id === 'kiln' ? (chat && chat.h >= 14 ? ['chat', 'viewer'] : ['viewer', 'chat']) : []);
}

/** The containers that took the place of Kiln's when it went off by default (1.9). */
const KILN_HEIRS = ['effects', 'quality'];

/**
 * The containers the user wants, each where it belongs: a hidden one's room goes to its neighbours, a
 * shown one that is missing comes back (to its old place when it can). Effects and Quality, new since a
 * layout with Kiln on it was saved, first take the room of a Kiln container that is now off (it was on
 * everyone's dashboard); later ones (the Storefront, under Quality) go to their own place.
 */
export function applyChoices(layout: readonly Cell[], choices: Choices, places: Places): Cell[] {
  let l = layout.filter((c) => CELLS.some((d) => d.i === c.i));
  const fresh = DEFAULT_LAYOUT.filter((d) => KILN_HEIRS.includes(d.i) && !l.some((c) => c.i === d.i) && isShown(d.i, choices));
  const kiln = l.find((c) => c.i === 'kiln');
  if (kiln && !isShown('kiln', choices) && fresh.length) l = [...l.filter((c) => c !== kiln), ...fillRect(kiln, fresh)];
  for (const { i } of CELLS) {
    const has = l.some((c) => c.i === i);
    if (isShown(i, choices) && !has) l = addContainer(l, i, places);
    else if (!isShown(i, choices) && has) l = removeCell(l, i);
  }
  return l;
}

/**
 * The saved layout (positions only) as the dashboard shows it now: the containers added since in their
 * places, each container's minimums from the defaults, and the user's choices applied.
 */
export function loadSaved(saved: readonly Cell[] | null, choices: Choices, places: Places): Cell[] {
  if (!saved) return applyChoices(DEFAULT_LAYOUT, choices, places);
  let l = saved.filter((c) => CELLS.some((d) => d.i === c.i));
  // The UI tile (1.5) takes the right half of the Animation tile in a layout saved before it existed,
  // so it lands in free space instead of under another tile.
  if (!l.some((c) => c.i === 'ui')) {
    const anim = l.find((c) => c.i === 'animation');
    if (!anim || anim.w < 4) return applyChoices(DEFAULT_LAYOUT, choices, places);
    l = [...l.map((c) => (c === anim ? { ...c, w: c.w - 2 } : c)), { i: 'ui', x: anim.x + anim.w - 2, y: anim.y, w: 2, h: anim.h }];
  }
  return applyChoices(
    l.map((c) => ({ ...(CELLS.find((d) => d.i === c.i) ?? {}), ...c })),
    choices,
    places,
  );
}
