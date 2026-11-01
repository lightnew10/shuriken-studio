/**
 * How a UI answers a gamepad and a thumb, offline. Gamepad: the D-pad moves GuiService.SelectedObject
 * between selectable GuiObjects the way Roblox does (NextSelection* overrides, SelectionGroup with
 * SelectionBehavior Escape/Stop, then a directional search); the search itself is engine code no
 * script in the Studio install shows, so it is approximated (centres ahead in the pressed direction's
 * half-plane, scored by distance with an off-axis penalty: to calibrate in Studio) and a finding is only
 * reported when it holds under every scoring variant in NAV_VARIANTS. Touch: target sizes and gaps in
 * millimetres from a device's points per inch, and the thumbs' reach on a landscape phone. The capture
 * doesn't read Selectable, NextSelection*, SelectionGroup or SelectionOrder yet (UiNavProps lists what it
 * should add): until it does, Roblox's defaults are assumed. Findings come in auditUi's shape.
 */
import {
  UI_DEVICES,
  isButton,
  isText,
  layoutScreen,
  pageShown,
  plainText,
  strokesOf,
  type Measure,
  type UiBox,
  type UiDevice,
  type UiFinding,
  type UiNode,
  type UiScreen,
} from '@shared/ui-layout';

export type NavDir = 'up' | 'down' | 'left' | 'right';
export const NAV_DIRS: NavDir[] = ['up', 'down', 'left', 'right'];
const OPPOSITE: Record<NavDir, NavDir> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const VEC: Record<NavDir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/**
 * Gamepad properties the capture should add to a node (Roblox's defaults when absent): Selectable (true on
 * TextButton/ImageButton/TextBox, false elsewhere), Interactable (true), SelectionGroup (false),
 * SelectionBehaviorUp/Down/Left/Right (Escape), NextSelectionUp/Down/Left/Right (none), SelectionOrder (0)
 * and whether a SelectionImageObject is set.
 */
export interface UiNavProps {
  selectable?: boolean;
  interactable?: boolean;
  /** SelectionGroup = true. */
  selGroup?: boolean;
  /** The directions whose SelectionBehavior is Stop. */
  selStop?: NavDir[];
  /** NextSelection* targets, by capture id (a target outside the capture is left out). */
  next?: Partial<Record<NavDir, number>>;
  /** SelectionOrder: lower is picked first when selection starts. */
  selOrder?: number;
  /** SelectionImageObject is set (a custom highlight instead of Roblox's). */
  selImage?: boolean;
}
export type NavNode = UiNode & UiNavProps;

/** A finding in auditUi's shape, with what kind of check made it. */
export interface LabFinding extends UiFinding {
  kind: string;
}

// ─── Views: what is on the screen together ──────────────────────────────────────────────────────

/** A state of the UI to check: every enabled screen at start, a screen a script enables, or a hidden panel shown. */
export interface LabView {
  name: string;
  screens: UiNode[];
  /** Hidden elements laid out as if shown. */
  show: ReadonlySet<number>;
  /** Findings are about this subtree (a path) only; null: the whole view. */
  scope: string | null;
  whenShown: boolean;
}

/** The top-most hidden elements a script may show (Visible = false under shown parents, other UIPageLayout pages), as auditUi checks them. */
export function hiddenRoots(screen: UiNode): Array<{ node: UiNode; path: string }> {
  const out: Array<{ node: UiNode; path: string }> = [];
  const walk = (n: UiNode, path: string) => {
    const page = n.pages ? pageShown(n) : null;
    for (const c of n.kids ?? []) {
      const p = `${path}.${c.name}`;
      if (c.visible === false || (page && c !== page)) out.push({ node: c, path: p });
      else walk(c, p);
    }
  };
  walk(screen, screen.name);
  return out;
}

/** The views to check: every enabled ScreenGui together, each disabled one on its own, and each hidden panel shown in its screen. */
export function labViews(screens: UiNode[]): LabView[] {
  const none = new Set<number>();
  const out: LabView[] = [];
  const enabled = screens.filter((s) => s.enabled !== false);
  if (enabled.length) out.push({ name: 'start', screens: enabled, show: none, scope: null, whenShown: false });
  for (const s of screens) if (s.enabled === false) out.push({ name: s.name, screens: [s], show: none, scope: null, whenShown: true });
  for (const s of screens) for (const h of hiddenRoots(s)) out.push({ name: h.path, screens: [s], show: new Set([h.node.id]), scope: h.path, whenShown: true });
  return out;
}

export const inScope = (path: string, scope: string | null) => !scope || path === scope || path.startsWith(`${scope}.`);

type Rect = { x: number; y: number; w: number; h: number };
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function cut(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/** One element laid out in a view, with its ancestors and the part of it a player can see. */
export interface LaidOut {
  box: UiBox;
  screen: UiNode;
  /** Ancestors, nearest first (the ScreenGui last). */
  up: UiNode[];
  /** On screen and not clipped away; inside a ScrollingFrame, the frame's own visible part (it scrolls the rest into view). */
  shown: Rect;
  /** Where it draws: on screen and clipped; inside a ScrollingFrame, its whole box at the scroll it was captured at (0). */
  rect: Rect;
  /** Draw order across the view: higher is on top. */
  layer: number;
}

/** A copy of the tree with these elements hidden (untouched branches shared). */
export function hideIn(n: UiNode, ids: ReadonlySet<number>): UiNode {
  if (ids.has(n.id)) return { ...n, visible: false };
  if (!n.kids) return n;
  const kids = n.kids.map((c) => hideIn(c, ids));
  return kids.every((c, i) => c === n.kids![i]) ? n : { ...n, kids };
}

/**
 * Lays a view out on a device: every element with its ancestors and visible part, in draw order. A hidden panel
 * shown in its place hides the shown siblings it swaps with (the other page or tab body, the button it stands in for,
 * in the same place): a script that shows one hides the other.
 */
export function layView(view: LabView, dev: UiScreen, measure?: Measure): LaidOut[] {
  const out: LaidOut[] = [];
  const screenRect: Rect = { x: 0, y: 0, w: dev.w, h: dev.h };
  // ScreenGuis draw by DisplayOrder, then in the order given.
  const ordered = view.screens.map((s, i) => ({ s, i })).sort((a, b) => (a.s.displayOrder ?? 0) - (b.s.displayOrder ?? 0) || a.i - b.i);
  for (const [si, { s: s0 }] of ordered.entries()) {
    let s = s0;
    const parent = new Map<number, UiNode>();
    const walk = (n: UiNode) => {
      for (const c of n.kids ?? []) {
        parent.set(c.id, n);
        walk(c);
      }
    };
    walk(s);
    let boxes = layoutScreen(s, dev, { measure, show: view.show });
    if (view.scope && view.show.size === 1) {
      const [hid] = view.show;
      const h = boxes.find((b) => b.node.id === hid);
      const p = parent.get(hid!);
      if (h && p) {
        const swapped = new Set<number>();
        for (const b of boxes) {
          if (b.node === h.node || parent.get(b.node.id) !== p) continue;
          // A sibling holding most of the panel's place (a page, the button it stands in for) is the one it replaces.
          const o = area(cut(b, h));
          if (o > 0 && o >= 0.8 * area(h) && o >= 0.5 * area(b)) swapped.add(b.node.id);
        }
        if (swapped.size) {
          s = hideIn(s, swapped);
          boxes = layoutScreen(s, dev, { measure, show: view.show });
          parent.clear();
          walk(s);
        }
      }
    }
    const rects = new Map<number, Rect>();
    for (const b of boxes) {
      let rect = cut({ x: b.x, y: b.y, w: b.w, h: b.h }, screenRect);
      if (b.clip) rect = cut(rect, { x: b.clip[0], y: b.clip[1], w: b.clip[2], h: b.clip[3] });
      rects.set(b.node.id, rect);
    }
    for (const b of boxes) {
      const up: UiNode[] = [];
      for (let p = parent.get(b.node.id); p; p = parent.get(p.id)) up.push(p);
      // Inside ScrollingFrames, what shows is the outermost frame's visible part: the rest scrolls into view.
      const scrollers = up.filter((a) => a.cls === 'ScrollingFrame' && rects.has(a.id));
      const outer = scrollers[scrollers.length - 1];
      const rect = scrollers.length ? { x: b.x, y: b.y, w: b.w, h: b.h } : rects.get(b.node.id)!;
      const shown = outer ? rects.get(outer.id)! : rect;
      out.push({ box: b, screen: s, up, shown, rect, layer: si * 1e6 + b.order });
    }
  }
  return out;
}

/** What a player reads on a button: its text, else its first text inside, else its name. */
export function labelOf(n: UiNode): string {
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  const find = (m: UiNode): string | null => {
    if (m.visible === false) return null;
    if (isText(m)) {
      const t = clean(plainText(m));
      if (t) return t;
    }
    for (const c of m.kids ?? []) {
      const t = find(c);
      if (t) return t;
    }
    return null;
  };
  const t = find(n) ?? n.name;
  return t.length > 28 ? `${t.slice(0, 27)}…` : t;
}

/** Whether anything in it draws (a visible fill, text, image or stroke). */
function draws(n: UiNode): boolean {
  if (n.bg && (n.bgT ?? 0) < 0.95) return true;
  if (isText(n) && plainText(n).trim() && (n.textT ?? 0) < 0.95) return true;
  if (n.image && (n.imageT ?? 0) < 0.95) return true;
  return strokesOf(n).some((s) => s.t < 0.95);
}

/** A button over most of the screen is a modal's backdrop (it catches clicks outside the window), not a target. */
const isBackdrop = (l: LaidOut, dev: UiScreen) => l.box.w * l.box.h >= 0.5 * dev.w * dev.h && !(isText(l.box.node) && plainText(l.box.node).trim());

const scrollerOf = (l: LaidOut) => l.up.find((a) => a.cls === 'ScrollingFrame') ?? null;
const drawing = (laid: LaidOut[], dev: UiScreen) => laid.filter((l) => draws(l.box.node) && area(l.rect) >= 1 && !isBackdrop(l, dev));

/** Whether it has anything to show at any transparency (a script may fade text or an image in). */
const hasContent = (n: UiNode): boolean => (isText(n) && !!plainText(n).trim()) || !!n.image || n.skinned !== undefined || (n.kids ?? []).some((c) => c.visible !== false && hasContent(c));

/**
 * Whether something shows where it is: its own content (or content a script may fade in), or something about its size
 * under or over it covering a fifth of it (a card it sits on, a slider's track); a window's whole background doesn't count.
 */
export function visibleThere(lt: LaidOut, laid: LaidOut[], dev: UiScreen, drawn = drawing(laid, dev)): boolean {
  const r = lt.rect;
  if (hasContent(lt.box.node)) return true;
  return drawn.some((l) => {
    const mine = l === lt || l.up.includes(lt.box.node);
    const o = area(cut(l.rect, r));
    return mine ? o > 0 : area(l.rect) <= 4 * area(r) && o >= 0.2 * area(r);
  });
}

/** An opaque panel drawn over at least 90% of it (among what scrolls with it), if any. */
export function coverOf(lt: LaidOut, laid: LaidOut[], dev: UiScreen, drawn = drawing(laid, dev)): LaidOut | null {
  const r = lt.rect;
  if (area(r) < 1) return null;
  const sc = scrollerOf(lt);
  return (
    drawn.find((l) => {
      const n = l.box.node;
      if (l.layer <= lt.layer || l === lt || l.up.includes(lt.box.node) || lt.up.includes(n) || scrollerOf(l) !== sc) return false;
      if (!n.bg || (n.bgT ?? 0) > 0.05 || n.gradient?.transp?.some((k) => k[1] > 0.05)) return false;
      return area(cut(l.rect, r)) >= 0.9 * area(r);
    }) ?? null
  );
}

// ─── Gamepad ────────────────────────────────────────────────────────────────────────────────────

export interface NavTarget {
  id: number;
  path: string;
  label: string;
  screen: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** SelectionGroup ancestors (itself included), innermost first. */
  groups: number[];
}

export interface NavMove {
  to: number | null;
  /** override: its NextSelection*; search: the directional search; stop: a SelectionGroup's Stop; edge: nothing that way. */
  how: 'override' | 'search' | 'stop' | 'edge';
}

/** The D-pad's moves in one view on one device. */
export interface NavGraph {
  device: string;
  view: string;
  scope: string | null;
  whenShown: boolean;
  targets: NavTarget[];
  moves: Record<number, Record<NavDir, NavMove>>;
  /** Where focus starts: the captured SelectedObject, else the lowest SelectionOrder, a primary button, the top left (close buttons last). */
  entry: number | null;
  /** Buttons that can't take focus, and why. */
  skipped: Array<{ path: string; why: string }>;
  /** Buttons in scope (not backdrops), selectable or not. */
  buttons: number;
}

/**
 * How the directional search scores a candidate: distance along the pressed direction (centre to centre,
 * or edge to edge), plus `perp` times the gap across it (0 when they line up) and `center` times the
 * centres' offset across it; `cone` drops candidates more than that many times as far across as along.
 */
export interface NavWeights {
  perp: number;
  center: number;
  edges?: boolean;
  cone?: number;
}
/** The search the graphs show (to calibrate in Studio). */
export const NAV_SEARCH: NavWeights = { perp: 2, center: 0.25 };
/** The variants a finding must hold under: the engine's exact scoring isn't public. */
export const NAV_VARIANTS: NavWeights[] = [NAV_SEARCH, { perp: 1, center: 0.5 }, { perp: 4, center: 0.25, edges: true }, { perp: 1, center: 1, cone: 2 }];

function score(a: Rect, b: Rect, d: NavDir, wt: NavWeights): number | null {
  const [dx, dy] = VEC[d];
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const along = (bcx - acx) * dx + (bcy - acy) * dy;
  if (along <= 0.5) return null;
  const horiz = dx !== 0;
  const [a0, a1, b0, b1] = horiz ? [a.y, a.y + a.h, b.y, b.y + b.h] : [a.x, a.x + a.w, b.x, b.x + b.w];
  const gap = Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
  const perpC = Math.abs(horiz ? bcy - acy : bcx - acx);
  if (wt.cone && perpC > along * wt.cone) return null;
  let dist = along;
  if (wt.edges) {
    // Edge to edge along the direction (0 when they overlap), the centres breaking ties.
    const aFar = horiz ? (dx > 0 ? a.x + a.w : -a.x) : dy > 0 ? a.y + a.h : -a.y;
    const bNear = horiz ? (dx > 0 ? b.x : -(b.x + b.w)) : dy > 0 ? b.y : -(b.y + b.h);
    dist = Math.max(0, bNear - aFar) + 0.1 * along;
  }
  return dist + wt.perp * gap + wt.center * perpC;
}

interface Tgt extends NavTarget {
  node: NavNode;
}

function moveOf(from: Tgt, d: NavDir, all: Tgt[], byId: Map<number, Tgt>, groupNode: Map<number, NavNode>, wt: NavWeights): NavMove {
  const o = from.node.next?.[d];
  // An override to something that can't take focus falls back to the search (to calibrate).
  if (o !== undefined && byId.has(o) && o !== from.id) return { to: o, how: 'override' };
  // The search stays in the innermost SelectionGroup that has a candidate; a group whose behaviour that way is Stop keeps focus.
  for (const gid of [...from.groups, null]) {
    let best: Tgt | null = null;
    let bestScore = Infinity;
    for (const t of all) {
      if (t === from || (gid !== null && !t.groups.includes(gid))) continue;
      const s = score(from, t, d, wt);
      if (s !== null && (s < bestScore - 1e-6 || (Math.abs(s - bestScore) <= 1e-6 && best && t.id < best.id))) {
        best = t;
        bestScore = s;
      }
    }
    if (best) return { to: best.id, how: 'search' };
    if (gid !== null && groupNode.get(gid)?.selStop?.includes(d)) return { to: null, how: 'stop' };
  }
  return { to: null, how: 'edge' };
}

const PRIMARY = /^(play|start|continue|resume|ok|okay|confirm|accept|yes|buy|purchase|claim|collect|next|spawn|deploy|ready|join|enter|go|equip|spin)$/i;
/** A close or back button: where focus should not start. */
const CLOSE = /^(x|×|✕|close|back|cancel|exit)$/i;

interface Built {
  graph: NavGraph;
  tg: Tgt[];
  byId: Map<number, Tgt>;
  groupNode: Map<number, NavNode>;
  laid: LaidOut[];
}

function buildNav(view: LabView, device: string, dev: UiScreen, opts: { measure?: Measure; selected?: number | null }): Built {
  const laid = layView(view, dev, opts.measure);
  const tg: Tgt[] = [];
  const skipped: NavGraph['skipped'] = [];
  const groupNode = new Map<number, NavNode>();
  let buttons = 0;
  const scrollerHasTargets = new Set<number>();
  const candidates: Array<{ l: LaidOut; n: NavNode }> = [];
  for (const l of laid) {
    const n = l.box.node as NavNode;
    if (n.cls === 'ScrollingFrame') continue;
    const button = isButton(n) && !isBackdrop(l, dev);
    if (button && inScope(l.box.path, view.scope)) buttons++;
    const selectable = n.selectable ?? isButton(n);
    if (!selectable || n.interactable === false) {
      if (button && inScope(l.box.path, view.scope)) skipped.push({ path: l.box.path, why: n.interactable === false ? 'Interactable is off' : 'Selectable is off' });
      continue;
    }
    if (isBackdrop(l, dev) && n.selectable !== true) continue;
    candidates.push({ l, n });
  }
  const accept = (l: LaidOut, n: NavNode) => {
    const b = l.box;
    const why = b.w < 1 || b.h < 1 ? 'zero size' : area(l.shown) < 1 ? (area(cut({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: 0, y: 0, w: dev.w, h: dev.h })) < 1 ? 'off the screen' : 'clipped away') : null;
    if (why) {
      if (inScope(b.path, view.scope)) skipped.push({ path: b.path, why });
      return;
    }
    const groups = [n, ...l.up].filter((a) => (a as NavNode).selGroup).map((a) => a.id);
    for (const a of [n, ...l.up]) if ((a as NavNode).selGroup) groupNode.set(a.id, a as NavNode);
    tg.push({ id: n.id, node: n, path: b.path, label: labelOf(n), screen: l.screen.name, x: b.x, y: b.y, w: b.w, h: b.h, groups });
    for (const a of l.up) if (a.cls === 'ScrollingFrame') scrollerHasTargets.add(a.id);
  };
  for (const { l, n } of candidates) accept(l, n);
  // A ScrollingFrame whose content overflows takes focus itself when nothing inside can (so a gamepad can still scroll it; to calibrate).
  for (const l of laid) {
    const n = l.box.node as NavNode;
    if (n.cls !== 'ScrollingFrame' || scrollerHasTargets.has(n.id) || n.selectable === false || n.interactable === false) continue;
    const kids = laid.filter((k) => k.up[0] === n);
    const overflows = kids.some((k) => k.box.y + k.box.h > l.box.y + l.box.h + 1 || k.box.x + k.box.w > l.box.x + l.box.w + 1);
    if (overflows || n.selectable === true) accept(l, n);
  }
  const byId = new Map(tg.map((t) => [t.id, t]));
  const scoped = tg.filter((t) => inScope(t.path, view.scope));
  let entry: number | null = opts.selected != null && byId.has(opts.selected) && scoped.some((t) => t.id === opts.selected) ? opts.selected : null;
  if (entry === null && scoped.length) {
    const first = (t: Tgt) => t.label.split(' ')[0] ?? '';
    const rank = (t: Tgt) => [t.node.selOrder ?? 0, PRIMARY.test(first(t)) ? 0 : CLOSE.test(t.label) || /close|back/i.test(t.path.split('.').pop()!) ? 2 : 1, Math.round((t.y + t.h / 2) / 24), t.x + t.w / 2] as const;
    entry = [...scoped].sort((a, b) => {
      const [p, q] = [rank(a), rank(b)];
      return p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3];
    })[0]!.id;
  }
  const moves: NavGraph['moves'] = {};
  for (const t of tg) moves[t.id] = Object.fromEntries(NAV_DIRS.map((d) => [d, moveOf(t, d, tg, byId, groupNode, NAV_SEARCH)])) as Record<NavDir, NavMove>;
  const targets: NavTarget[] = tg.map(({ node: _n, ...t }) => t);
  return { graph: { device, view: view.name, scope: view.scope, whenShown: view.whenShown, targets, moves, entry, skipped, buttons }, tg, byId, groupNode, laid };
}

/** The navigation graph of every view on a device (views without anything that takes focus or a button are left out). */
export function navGraphs(screens: UiNode[], device: AnyDevice, opts: { measure?: Measure; selected?: number | null } = {}): NavGraph[] {
  const { id: name, dev } = deviceOf(device);
  return labViews(screens)
    .map((v) => buildNav(v, name, dev, opts).graph)
    .filter((g) => g.buttons > 0 || g.targets.some((t) => inScope(t.path, g.scope)));
}

function reach(from: number, moves: (id: number) => Iterable<number>): Set<number> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    for (const to of moves(id))
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
  }
  return seen;
}

/** The shortest D-pad route from the entry to each target, as "Play → (right) Shop → (down) Settings". */
export function navRoutes(g: NavGraph): Map<number, string> {
  const label = new Map(g.targets.map((t) => [t.id, t.label]));
  const out = new Map<number, string>();
  if (g.entry === null) return out;
  out.set(g.entry, label.get(g.entry)!);
  const queue = [g.entry];
  while (queue.length) {
    const id = queue.shift()!;
    for (const d of NAV_DIRS) {
      const to = g.moves[id]?.[d].to;
      if (to == null || out.has(to)) continue;
      out.set(to, `${out.get(id)} → (${d}) ${label.get(to)}`);
      queue.push(to);
    }
  }
  return out;
}

/** A text map of a graph an agent can read: where focus starts, the route to each button, what can't be reached, every move. */
export function navMap(g: NavGraph): string {
  const scoped = g.targets.filter((t) => inScope(t.path, g.scope));
  const names = new Map<number, string>();
  const seen = new Map<string, number>();
  for (const t of g.targets) {
    const k = (seen.get(t.label) ?? 0) + 1;
    seen.set(t.label, k);
    names.set(t.id, k > 1 ? `${t.label} #${k}` : t.label);
  }
  const lines = [`${g.view}${g.whenShown ? ' (when shown)' : ''} on ${g.device}: ${scoped.length} of ${g.targets.length} focusable things here, focus starts on ${g.entry !== null ? names.get(g.entry) : 'nothing'}`];
  const routes = navRoutes({ ...g, targets: g.targets.map((t) => ({ ...t, label: names.get(t.id)! })) });
  const order = [...scoped].sort((a, b) => Math.round((a.y + a.h / 2) / 24) - Math.round((b.y + b.h / 2) / 24) || a.x - b.x);
  for (const t of order) if (routes.has(t.id) && t.id !== g.entry) lines.push(`  ${routes.get(t.id)}`);
  const lost = order.filter((t) => !routes.has(t.id));
  if (lost.length) lines.push(`  can't reach: ${lost.map((t) => names.get(t.id)).join(', ')}`);
  const arrow: Record<NavDir, string> = { up: '↑', down: '↓', left: '←', right: '→' };
  for (const t of order) {
    const m = g.moves[t.id]!;
    lines.push(`  ${names.get(t.id)}: ${NAV_DIRS.map((d) => `${arrow[d]} ${m[d].to !== null ? names.get(m[d].to!) : m[d].how === 'stop' ? 'stop' : '—'}`).join('  ')}`);
  }
  if (g.skipped.length) lines.push(`  can't take focus: ${g.skipped.map((s) => `${s.path.split('.').pop()} (${s.why})`).join(', ')}`);
  return lines.join('\n');
}

/** Merges findings that differ only by device (and numbers), as auditUi does. */
export function findingSink() {
  const found = new Map<string, LabFinding>();
  const add = (f: Omit<LabFinding, 'devices'>, device: string | null) => {
    const key = `${f.kind}|${f.path}|${f.message.replace(/\d+(\.\d+)?/g, '#')}`;
    const prev = found.get(key);
    if (!prev) found.set(key, { ...f, devices: device ? [device as UiDevice] : [] });
    else {
      if (device && !prev.devices.includes(device as UiDevice)) prev.devices.push(device as UiDevice);
      if (f.severity === 'problem') prev.severity = 'problem';
      if (!f.whenShown) delete prev.whenShown;
    }
  };
  const list = () => [...found.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1) || Number(!!a.whenShown) - Number(!!b.whenShown));
  return { add, list };
}

/**
 * What a gamepad player trips over, per view and device: buttons the D-pad can't reach from where focus starts,
 * focus that gets stuck (dead ends) or can't get back out (traps), moves that don't come back (one-way), focus
 * leaping across the screen at an angle (odd jumps), focus landing on things a player can't see (empty hit areas,
 * buttons under an opaque panel), and screens with buttons but nothing that takes focus. Moves the default search
 * makes count only when every scoring variant agrees.
 */
export function navFindings(screens: UiNode[], devices: AnyDevice[] = ['desktop', 'tv'], opts: { measure?: Measure; selected?: number | null } = {}): LabFinding[] {
  const sink = findingSink();
  for (const d of devices) {
    const { id: device, dev } = deviceOf(d);
    for (const view of labViews(screens)) {
      const { graph, tg, byId, groupNode, laid } = buildNav(view, device, dev, opts);
      const extra = view.whenShown ? { whenShown: true } : {};
      const scoped = tg.filter((t) => inScope(t.path, view.scope));
      const where = view.scope ?? (view.name === 'start' ? 'the screens shown at start' : view.name);
      if (!scoped.length) {
        // Zero-size buttons alone don't count: a script sizes them when it shows them, or they are the Modal trick that frees the mouse.
        const why = [...new Set(graph.skipped.map((s) => s.why))];
        if (graph.buttons > 0 && why.some((w) => w !== 'zero size'))
          sink.add({ kind: 'nav-no-way-in', severity: 'problem', path: view.scope ?? view.screens[0]!.name, message: `${graph.buttons} button${graph.buttons === 1 ? '' : 's'} but nothing a gamepad can focus (${why.join(', ')})`, ...extra }, device);
        continue;
      }
      const label = (id: number) => byId.get(id)!.label;
      // Every variant's moves; findings hold only when all agree.
      const all = NAV_VARIANTS.map((wt) => {
        const m = new Map<number, Record<NavDir, NavMove>>();
        for (const t of tg) m.set(t.id, Object.fromEntries(NAV_DIRS.map((d) => [d, moveOf(t, d, tg, byId, groupNode, wt)])) as Record<NavDir, NavMove>);
        return m;
      });
      const nexts = (m: Map<number, Record<NavDir, NavMove>>) => (id: number) => NAV_DIRS.map((d) => m.get(id)![d].to).filter((x): x is number => x !== null);
      const entry = graph.entry!;
      const reached = all.map((m) => reach(entry, nexts(m)));
      // Unreachable from where focus starts.
      for (const t of scoped)
        if (reached.every((r) => !r.has(t.id)))
          sink.add({ kind: 'nav-unreachable', severity: 'problem', path: t.path, message: `A gamepad can't reach “${t.label}”: the D-pad never lands on it from “${label(entry)}”, where focus starts (in ${where})`, ...extra }, device);
      // Dead ends: nothing in any direction.
      if (tg.length > 1)
        for (const t of scoped)
          if (all.every((m) => NAV_DIRS.every((d) => m.get(t.id)![d].to === null)))
            sink.add({ kind: 'nav-dead-end', severity: 'problem', path: t.path, message: `Focus gets stuck on “${t.label}”: no direction moves it`, ...extra }, device);
      // Traps: once there, focus can't get back to what the start reaches (a SelectionGroup that stops every way is a modal by design).
      const reportedTraps = new Set<string>();
      for (const t of scoped) {
        if (!reached[0]!.has(t.id)) continue;
        const outs = all.map((m) => reach(t.id, nexts(m)));
        if (!outs.every((o, i) => [...reached[i]!].some((id) => !o.has(id)))) continue;
        const closed = [...outs[0]!].sort((a, b) => a - b);
        const key = closed.join(',');
        if (reportedTraps.has(key)) continue;
        reportedTraps.add(key);
        const modal = [...groupNode.values()].some((g) => NAV_DIRS.every((d) => g.selStop?.includes(d)) && closed.every((id) => byId.get(id)!.groups.includes(g.id)));
        if (modal) continue;
        const left = [...reached[0]!].filter((id) => !outs[0]!.has(id));
        sink.add({ kind: 'nav-trap', severity: 'problem', path: byId.get(closed[0]!)!.path, message: `Focus can't get out of ${closed.map((id) => `“${label(id)}”`).slice(0, 4).join(', ')}${closed.length > 4 ? '…' : ''}: from there the D-pad never gets back to ${left.length} other button${left.length === 1 ? '' : 's'} (“${label(left[0]!)}”…)`, ...extra }, device);
      }
      // One-way moves: the way back lands elsewhere and takes more than two presses to get home. Odd jumps: focus
      // leaps over a third of the screen, much more sideways than the way pressed.
      const span = Math.hypot(dev.w, dev.h);
      const presses = (m: Map<number, Record<NavDir, NavMove>>, from: number, to: number): number => {
        const dist = new Map([[from, 0]]);
        const queue = [from];
        while (queue.length) {
          const id = queue.shift()!;
          if (id === to) return dist.get(id)!;
          for (const n of nexts(m)(id))
            if (!dist.has(n)) {
              dist.set(n, dist.get(id)! + 1);
              queue.push(n);
            }
        }
        return Infinity;
      };
      const centre = (t: NavTarget) => [t.x + t.w / 2, t.y + t.h / 2] as const;
      const leap = (t: NavTarget, u: NavTarget, d: NavDir) => {
        const [dx, dy] = VEC[d];
        const vx = centre(u)[0] - centre(t)[0];
        const vy = centre(u)[1] - centre(t)[1];
        const along = vx * dx + vy * dy;
        const across = Math.abs(dx !== 0 ? vy : vx);
        return { len: Math.hypot(vx, vy), odd: Math.hypot(vx, vy) > 0.35 * span && across > 1.5 * along };
      };
      for (const t of scoped)
        for (const d of NAV_DIRS) {
          const tos = all.map((m) => m.get(t.id)![d].to);
          const to = tos[0];
          if (to == null) continue;
          if (tos.every((x) => x === to)) {
            const back = all.map((m) => m.get(to)![OPPOSITE[d]].to);
            if (back.every((b) => b !== t.id && b === back[0]) && all.every((m) => presses(m, to, t.id) > 2)) {
              const b = back[0];
              const home = presses(all[0]!, to, t.id);
              sink.add({ kind: 'nav-one-way', severity: 'warning', path: t.path, message: `${d[0]!.toUpperCase()}${d.slice(1)} from “${t.label}” goes to “${label(to)}”, but ${OPPOSITE[d]} from there goes ${b != null ? `to “${label(b)}”` : 'nowhere'}: getting back takes ${home === Infinity ? 'more than the D-pad allows' : `${home} presses`}`, ...extra }, device);
            }
          }
          const u = byId.get(to)!;
          if (leap(t, u, d).odd && all.every((m) => m.get(t.id)![d].to != null && leap(t, byId.get(m.get(t.id)![d].to!)!, d).odd))
            sink.add({ kind: 'nav-odd-jump', severity: 'warning', path: t.path, message: `Pressing ${d} on “${t.label}” sends focus ${Math.round(leap(t, u, d).len)} points away to “${u.label}”, mostly sideways (to calibrate: Roblox's search may not look that wide)`, ...extra }, device);
        }
      // Focus on things nobody can see: an empty hit area, or a button under an opaque panel drawn above it.
      const covered = new Map<string, number[]>();
      const drawn = drawing(laid, dev);
      for (const t of scoped) {
        const lt = laid.find((l) => l.box.node.id === t.id)!;
        if (area(lt.rect) < 1) continue;
        if (!visibleThere(lt, laid, dev, drawn))
          sink.add({ kind: 'nav-invisible', severity: 'warning', path: t.path, message: `Takes gamepad focus but nothing draws there: the selection box would frame empty space (draw something, or set Selectable false)`, ...extra }, device);
        const cover = coverOf(lt, laid, dev, drawn);
        if (cover) covered.set(cover.box.path, [...(covered.get(cover.box.path) ?? []), t.id]);
      }
      for (const [path, ids] of covered)
        sink.add({ kind: 'nav-hidden-focus', severity: 'warning', path, message: `Covers ${ids.length} button${ids.length === 1 ? '' : 's'} a gamepad can still focus unseen (${ids.slice(0, 3).map((id) => `“${label(id)}”`).join(', ')}${ids.length > 3 ? '…' : ''}): hide them, or keep focus in this panel with a SelectionGroup`, ...extra }, device);
    }
  }
  return sink.list();
}

// ─── Touch ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Roblox UI points per inch on each touch device: the phone is 844×390 points (an iPhone 12-14, 460 ppi at 3×),
 * the tablet 1180×820 (an iPad Air, 264 ppi at 2×). A 163 points-per-inch phone is the original iPhone's.
 */
export const DEVICE_PPI: Partial<Record<UiDevice, number>> = { phone: 153.3, phonePortrait: 153.3, tablet: 132 };

export const TOUCH_LIMITS = {
  /** Smallest comfortable target (a fingertip; Apple's 44 pt and Material's 48 dp are 7-9 mm). */
  minMm: 7,
  /** Below this a tap misses often. */
  tinyMm: 4.5,
  /** A fingertip: neighbours whose centres are closer than this want a gap. */
  roomyMm: 9,
  gapMm: 2,
  /** Landscape two-thumb grip: each thumb pivots just outside a bottom corner; beyond `hardMm` from both is a stretch mid-game. */
  pivotMm: 8,
  hardMm: 80,
};

const mmAt = (pt: number, ppi: number) => (pt / ppi) * 25.4;

/** A device by name (UI_DEVICES; points per inch from DEVICE_PPI) or given whole (a Lab device: size, insets, ppi, input). */
export type AnyDevice = UiDevice | (UiScreen & { id: string; label: string; ppi?: number; input?: string });
function deviceOf(d: AnyDevice, ppi?: Partial<Record<string, number>>): { id: string; label: string; dev: UiScreen; ppi: number | undefined; input?: string } {
  if (typeof d === 'string') return { id: d, label: UI_DEVICES[d].label, dev: UI_DEVICES[d], ppi: ppi?.[d] ?? DEVICE_PPI[d] };
  return { id: d.id, label: d.label, dev: d, ppi: ppi?.[d.id] ?? d.ppi, input: d.input };
}

/** How far a point (in points) is from the nearer thumb on a landscape phone held in both hands, and the zone it is in. */
export function thumbReach(x: number, y: number, dev: UiScreen, ppi: number): { mm: number; zone: 'easy' | 'stretch' | 'hard' } {
  const mx = mmAt(x, ppi);
  const my = mmAt(y, ppi);
  const W = mmAt(dev.w, ppi);
  const H = mmAt(dev.h, ppi);
  const p = TOUCH_LIMITS.pivotMm;
  const mm = Math.min(Math.hypot(mx + p, H + p - my), Math.hypot(W + p - mx, H + p - my));
  return { mm, zone: mm > TOUCH_LIMITS.hardMm ? 'hard' : mm > 55 ? 'stretch' : 'easy' };
}

/** Words of a name or label: "AttackBtn_2" → attack, btn, 2. */
const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const FREQUENT = new Set(['attack', 'jump', 'sprint', 'ability', 'shoot', 'fire', 'reload', 'use', 'interact', 'dash', 'block', 'crouch', 'slide', 'aim', 'punch', 'kick', 'throw', 'skill', 'ult', 'ultimate', 'swing', 'parry', 'dodge', 'strike', 'slash', 'cast']);
/** Whether a button is one players press over and over mid-game (attack, jump, sprint, ability…), by its name or label. */
export const isFrequentAction = (n: UiNode) => [...words(n.name), ...words(isText(n) ? plainText(n) : '')].some((w) => FREQUENT.has(w));

/**
 * Touch ergonomics per view on the touch devices among `devices` (those with points per inch: DEVICE_PPI, `opts.ppi`,
 * or a Lab device's own): targets under 7 mm (beyond the layout's 2-point error; under 4.5 mm is a problem), neighbours
 * under 2 mm apart whose centres are under 9 mm apart, and frequent-action buttons (attack, jump, sprint, ability…)
 * beyond the thumbs' comfortable reach on a landscape phone (the top centre). Buttons hidden under an opaque panel are
 * left out. Buttons under Roblox's own jump button and thumbstick are core-overlays' to find.
 */
export function touchFindings(screens: UiNode[], devices: AnyDevice[] = ['phone', 'tablet'], opts: { measure?: Measure; ppi?: Partial<Record<string, number>> } = {}): LabFinding[] {
  const sink = findingSink();
  for (const d of devices) {
    const { id: device, label: devLabel, dev, ppi, input } = deviceOf(d, opts.ppi);
    if (!ppi || (input && input !== 'touch')) continue;
    const mm = (pt: number) => mmAt(pt, ppi);
    const fmt = (v: number) => v.toFixed(1);
    const slack = mm(2);
    for (const view of labViews(screens)) {
      const laid = layView(view, dev, opts.measure);
      const drawn = drawing(laid, dev);
      const extra = view.whenShown ? { whenShown: true } : {};
      // What a finger can hit: the visible part of each button (a scrolling list's items whole: they scroll into view).
      const targets = laid
        .filter((l) => isButton(l.box.node) && !isBackdrop(l, dev) && (l.box.node as NavNode).interactable !== false && l.box.w >= 1 && l.box.h >= 1 && area(l.shown) >= 1 && area(l.rect) >= 1)
        // Not under an opaque panel, and not an invisible hit area with nothing to aim at (the Modal trick's 1-point button).
        .filter((l) => !coverOf(l, laid, dev, drawn) && visibleThere(l, laid, dev, drawn))
        .map((l) => ({ l, r: l.rect, scroller: scrollerOf(l) }));
      const scoped = targets.filter((t) => inScope(t.l.box.path, view.scope));
      for (const t of scoped) {
        const s = Math.min(t.r.w, t.r.h);
        if (mm(s) < TOUCH_LIMITS.minMm - slack) {
          const partly = area(t.r) < 0.7 * t.l.box.w * t.l.box.h ? `, all of it a finger can reach: the rest is off the screen or clipped` : '';
          sink.add({ kind: 'touch-size', severity: mm(s) < TOUCH_LIMITS.tinyMm ? 'problem' : 'warning', path: t.l.box.path, message: `${fmt(mm(t.r.w))}×${fmt(mm(t.r.h))} mm to a finger on a ${devLabel.toLowerCase()} (${Math.round(t.r.w)}×${Math.round(t.r.h)} points${partly}): aim for 7 mm (44 points) or more`, ...extra }, device);
        }
        // A landscape phone, held in both hands.
        if (dev.w > dev.h && dev.h <= 500 && isFrequentAction(t.l.box.node) && !t.scroller) {
          const reachMm = thumbReach(t.r.x + t.r.w / 2, t.r.y + t.r.h / 2, dev, ppi);
          if (reachMm.zone === 'hard')
            sink.add({ kind: 'touch-reach', severity: 'warning', path: t.l.box.path, message: `“${labelOf(t.l.box.node)}” is pressed often but sits ${Math.round(reachMm.mm)} mm from the nearer thumb on a landscape phone (the top-centre stretch): move it near a bottom corner`, ...extra }, device);
        }
      }
      // Small targets packed together: a 2 mm gap at least when either is under 9 mm across the gap.
      for (let i = 0; i < targets.length; i++)
        for (let j = i + 1; j < targets.length; j++) {
          const a = targets[i]!;
          const b = targets[j]!;
          if (!inScope(a.l.box.path, view.scope) && !inScope(b.l.box.path, view.scope)) continue;
          if (a.scroller !== b.scroller || a.l.up.includes(b.l.box.node) || b.l.up.includes(a.l.box.node)) continue;
          const gx = Math.max(a.r.x, b.r.x) - Math.min(a.r.x + a.r.w, b.r.x + b.r.w);
          const gy = Math.max(a.r.y, b.r.y) - Math.min(a.r.y + a.r.h, b.r.y + b.r.h);
          // Side by side (sharing a row) or stacked (sharing a column); overlaps are auditUi's. Crowded: under 2 mm
          // apart with centres under a fingertip (9 mm) apart, so a tap on one lands half on the other.
          const [gap, pitch] = gy < 0 && gx >= 0 ? [gx, gx + (a.r.w + b.r.w) / 2] : gx < 0 && gy >= 0 ? [gy, gy + (a.r.h + b.r.h) / 2] : [Infinity, Infinity];
          // Under 0.8 mm the edges all but touch, however far apart the centres are (a swatch 4 pt from a long RACE button).
          if (mm(gap) < TOUCH_LIMITS.gapMm && (mm(pitch) < TOUCH_LIMITS.roomyMm || mm(gap) < 0.8)) {
            const [small, other] = (a.r.w * a.r.h <= b.r.w * b.r.h ? [a, b] : [b, a]) as [typeof a, typeof a];
            sink.add({ kind: 'touch-gap', severity: 'warning', path: small.l.box.path, message: `${fmt(mm(gap))} mm from ${other.l.box.path}, centres ${fmt(mm(pitch))} mm apart: a finger can hit the wrong one (2 mm gaps, or centres 9 mm apart)`, ...extra }, device);
          }
        }
    }
  }
  return sink.list();
}
