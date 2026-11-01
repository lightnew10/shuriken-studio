/**
 * Content stress: real games show long names, big numbers, translations and lists of any length, where
 * mockups and captures show one happy case. stressVariants makes the worst cases (every text ~40% longer
 * with long German-like words, player names at Roblox's 20-character limit in its widest letter, player-driven
 * amounts at nine digits, every text empty, data lists with 0, 1 and 50 items); stressFindings lays each one
 * out and reports only what breaks under stress and not in the capture as it is: auditUi's checks (cut off,
 * off the screen, overlapping, running into each other, too small) plus TextScaled shrinking below a readable
 * size, wrapped text running out of its box, text spilling out of its panel or into other text, and a
 * ScrollingFrame whose fixed CanvasSize can't reach its items (only when the capture records AutomaticCanvasSize
 * None: `autoCanvas`, not read yet). Data lists are those named like clones ("Row1", "Card_Sword"), not menus,
 * tabs or fixed sets (slots, pips); the 50-item case only for lists that scroll.
 */
import {
  auditUi,
  estimateText,
  isButton,
  isText,
  pageShown,
  plainText,
  wrapText,
  UI_DEVICES,
  type Measure,
  type UiDevice,
  type UiNode,
} from '@shared/ui-layout';
import { findingSink, hiddenRoots, inScope, layView, type LabFinding, type LabView, type LaidOut } from './interact';

export interface StressVariant {
  /** translate | names | numbers | empty | items0 | items1 | items50 */
  key: string;
  label: string;
  screens: UiNode[];
  /** Texts or lists it changed. */
  changed: number;
  /** Where its effects count (a changed list's parent); absent: anywhere. */
  scopes?: string[];
}

export interface StressFinding extends LabFinding {
  /** The variant's label it appears under. */
  variant: string;
}

// ─── Texts ──────────────────────────────────────────────────────────────────────────────────────

const USERNAME = /^@?[A-Za-z0-9_]{3,20}$/;
const NAME_NODE = /(player|user|pilot|owner|winner|killer|opponent|rival|display|nick|friend|member|champion|mvp|teammate|enemy|victim|attacker|sender|author)/i;
const NAME_PLACE = /(row|standing|leaderboard|scoreboard|player|entry|podium|party|squad|team|killfeed|feed|profile|result|member|friend|winner|lobby)/i;
const NOT_NAME = /(item|part|move|track|map|mode|skin|trail|title|perk|quest|pet|weapon|tool|tower|car|boat|mech|rank|class|tier)/i;
const SHOP = /(shop|store|catalog|locker|cosmetic|inventory|backpack|craft|look|offer|bundle|pass)/i;

/** A text that shows a player's name (username or display name): by its name and where it sits, and a username-like text. */
export function isPlayerName(n: UiNode, up: UiNode[]): boolean {
  if (!isText(n) || n.cls === 'TextBox') return false;
  const t = plainText(n).trim();
  // A column header ("PLAYER", "Name") is not a name; a placeholder ("Player1", "PlayerName") is.
  if (/(column|header|heading)/i.test(up[0]?.name ?? '') || t === t.toUpperCase()) return /^(PLAYER|USER)\d+$/.test(t);
  if (/^(player|username|playername|displayname)\d*$/i.test(t)) return true;
  if (!USERNAME.test(t) || /^@?name$/i.test(t) || NOT_NAME.test(n.name) || up.some((a) => SHOP.test(a.name))) return false;
  if (NAME_NODE.test(n.name)) return true;
  // A plain "Name" label in a row, a leaderboard or a profile, holding something like a username (not an all-caps label).
  return /^(name|namelabel|nametext)$/i.test(n.name) && /[a-z]/.test(t) && up.slice(0, 4).some((a) => NAME_PLACE.test(a.name));
}

/** Words of a name: "CoinsLabel_2" → coins, label, 2. */
const words = (t: string) =>
  t
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9$€£¥¢]+/)
    .filter(Boolean);
const BIG = new Set(['coin', 'coins', 'cash', 'gold', 'gem', 'gems', 'money', 'buck', 'bucks', 'point', 'points', 'pts', 'score', 'xp', 'exp', 'token', 'tokens', 'diamond', 'diamonds', 'crystal', 'crystals', 'souls', 'bounty', 'balance', 'wallet', 'currency', 'valor', 'notes', 'damage', 'dmg']);
const SMALL = new Set(['kill', 'kills', 'ko', 'kos', 'win', 'wins', 'elo', 'rating', 'trophies', 'trophy']);
const FIXED = /(price|cost|buy|purchase|key|slot|place|position|time|timer|clock|wave|round|lap|day|stage|tier|step|page|ammo|clip|mag|hp|health|percent|chance|bonus|multiplier|fps|ping|version|need|require|unlock|reward|max|cap|limit|goal|target|level|lvl|streak|total)/i;

/**
 * A readout of a player-driven amount (a currency balance, points, kills): mostly a number, named after what it counts
 * (itself, its parent or grandparent, or its own words), and not a price, a requirement, a reward, a level, a timer or
 * a key. Returns how big it can get: `big` (currencies, points: billions) or `small` (kills, wins: tens of thousands).
 */
export function amountKind(n: UiNode, up: UiNode[]): 'big' | 'small' | null {
  if (!isText(n) || n.cls === 'TextBox') return null;
  const t = plainText(n).trim();
  if (!/\d/.test(t) || /\d:\d\d/.test(t) || /%/.test(t) || /^[+\-−]/.test(t)) return null;
  const letters = t.replace(/[\d.,\s$€£¥¢x×/·()\[\]:+-]/gi, '').replace(/^(K|M|B|T)$/i, '');
  if (letters.length > 6) return null;
  const names = [n.name, up[0]?.name ?? '', up[1]?.name ?? ''].join(' ');
  if (FIXED.test(names) || FIXED.test(t)) return null;
  const said = [...words(names), ...words(t.replace(/\d+/g, ' '))];
  if (said.some((w) => BIG.has(w)) || /[$€£¥¢]/.test(t)) return 'big';
  return said.some((w) => SMALL.has(w)) ? 'small' : null;
}

/** Every number in a text at its worst: nine digits with separators, or an abbreviated amount at its widest. */
function hugeNumbers(t: string, kind: 'big' | 'small'): string {
  return t.replace(/\d[\d,.]*(\s?[KMBT](?![a-z]))?/gi, (m, suffix: string | undefined) => (suffix ? `999.9${suffix.trim().toUpperCase() === suffix.trim() ? 'T' : 't'}` : kind === 'big' ? '999,999,999' : '99,999'));
}

const FILLER = 'ungsheitenkeitlichschaftsverwaltungs';
/** Each word of three letters or more grows by 40% (two letters at least), German-like: long words that don't break. */
export function longer(t: string): string {
  const grow = (w: string) => {
    const letters = [...w].filter((c) => /\p{L}/u.test(c)).length;
    if (letters < 3 || /\d/.test(w) || (letters <= 3 && w === w.toUpperCase())) return w;
    const add = Math.max(2, Math.ceil(letters * 0.4));
    const pad = FILLER.slice(0, add);
    return w + (w === w.toUpperCase() ? pad.toUpperCase() : pad);
  };
  // Rich text tags stay as they are.
  return t
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : part.replace(/[\p{L}\p{N}'’]+/gu, grow)))
    .join('');
}

/** Whether a text would be translated: it has words (not a key glyph like "E" or "X", nor only numbers), and isn't the game's logo. */
const translatable = (n: UiNode, up: UiNode[]) => isText(n) && [...plainText(n)].filter((c) => /\p{L}/u.test(c)).length >= 2 && !up.some((a) => /(brand|logo|wordmark)/i.test(a.name));

/** A copy of each screen with each text node passed through `edit` (null: unchanged), and how many changed. */
function editTexts(screens: UiNode[], edit: (n: UiNode, up: UiNode[]) => string | null): { screens: UiNode[]; changed: number } {
  let changed = 0;
  const walk = (n: UiNode, up: UiNode[]): UiNode => {
    let out = n;
    if (isText(n) && n.text) {
      const t = edit(n, up);
      if (t !== null && t !== n.text) {
        out = { ...n, text: t };
        changed++;
      }
    }
    if (n.kids) {
      const kids = n.kids.map((c) => walk(c, [n, ...up]));
      if (kids.some((c, i) => c !== n.kids![i])) out = { ...out, kids };
    }
    return out;
  };
  return { screens: screens.map((s) => walk(s, [])), changed };
}

// ─── Lists ──────────────────────────────────────────────────────────────────────────────────────

/** A node's shape: its class and its children's shapes (what a list's item template shares). */
const shape = (n: UiNode): string => `${n.cls}(${(n.kids ?? []).map(shape).join(',')})`;

/** A list that scrolls: a ScrollingFrame itself, or the content frame right inside one. */
const scrolls = (n: UiNode, up: UiNode[]) => n.cls === 'ScrollingFrame' || up[0]?.cls === 'ScrollingFrame';

/** Names a script gives what it clones: a shared stem and a number or an id after it ("Row1", "Row2"; "Card_Sword", "Card_Bow"). */
function numbered(items: UiNode[]): boolean {
  const stemOf = (name: string) => (/\d$/.test(name) ? name.replace(/\d+$/, '') : /[_-]/.test(name) ? name.split(/[_-]/)[0]! : null);
  const stems = items.map((i) => stemOf(i.name));
  return stems.every((x) => x !== null && x === stems[0]) && new Set(items.map((i) => i.name)).size > 1 && !FIXED_COUNT.test(stems[0]!);
}

/** Containers that are layout, not data: menus, tabs, settings rows. */
const STATIC = /(setting|option|tab|page|nav|menu|control|section|header|footer|toolbar|rail|bar$)/i;
/** Items a game has a fixed number of: hotbar and perk slots, pips, stars, days of a calendar, steps, lives. */
const FIXED_COUNT = /^(slot|pip|star|day|step|tier|level|heart|life|lives|dot|bar|segment|tick|stage|wave|round|lap)/i;

/**
 * The items of a data list (one a script fills from data): a UIListLayout or UIGridLayout with three or more children
 * of one shape named like clones ("Row1", "Card_Sword"), not a menu, tabs or settings, and not a fixed set (slots,
 * pips, days). `scrolling` also wants it to scroll (a ScrollingFrame, or the frame right inside one).
 */
export function listItems(n: UiNode, up: UiNode[] = [], scrolling = false): UiNode[] | null {
  if (!(n.list || n.grid) || !n.kids || n.kids.length < 3 || STATIC.test(n.name)) return null;
  const groups = new Map<string, UiNode[]>();
  for (const k of n.kids) groups.set(shape(k), [...(groups.get(shape(k)) ?? []), k]);
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]!;
  if (best.length < 3 || best.length * 2 < n.kids.length || !numbered(best) || (scrolling && !scrolls(n, up))) return null;
  return [...best].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

function maxId(screens: UiNode[]): number {
  let m = 0;
  const walk = (n: UiNode) => {
    m = Math.max(m, n.id);
    for (const c of n.kids ?? []) walk(c);
  };
  for (const s of screens) walk(s);
  return m;
}

/** Each data list with `count` items (copies of its first item); `onlyScrolling` for the long case. */
function resizeLists(screens: UiNode[], count: number, onlyScrolling: boolean): { screens: UiNode[]; changed: number; lists: UiNode[] } {
  let changed = 0;
  const lists: UiNode[] = [];
  let next = maxId(screens) + 1;
  const clone = (n: UiNode): UiNode => ({ ...n, id: next++, kids: n.kids?.map(clone) });
  const walk = (n: UiNode, up: UiNode[]): UiNode => {
    let kids = n.kids?.map((c) => walk(c, [n, ...up]));
    const items = listItems(n, up, onlyScrolling);
    if (items && items.length !== count) {
      lists.push(n);
      const template = items[0]!;
      const others = (kids ?? []).filter((k) => !items.some((i) => i.id === k.id));
      const made = count <= items.length ? (kids ?? []).filter((k) => items.slice(0, count).some((i) => i.id === k.id)) : [...(kids ?? []).filter((k) => items.some((i) => i.id === k.id)), ...Array.from({ length: count - items.length }, () => clone({ ...template, order: (items[items.length - 1]!.order ?? 0) }))];
      kids = [...others, ...made];
      changed++;
    }
    const same = (kids?.length ?? 0) === (n.kids?.length ?? 0) && (kids ?? []).every((c, i) => c === n.kids![i]);
    return same ? n : { ...n, kids };
  };
  return { screens: screens.map((s) => walk(s, [])), changed, lists };
}

/** The worst cases of the content: each variant changes one thing everywhere it applies (variants that change nothing are left out). */
export function stressVariants(screens: UiNode[]): StressVariant[] {
  const out: StressVariant[] = [];
  const paths = new Map<number, string>();
  const walk = (n: UiNode, path: string) => {
    paths.set(n.id, path);
    for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`);
  };
  for (const sc of screens) walk(sc, sc.name);
  const add = (key: string, label: string, r: { screens: UiNode[]; changed: number; lists?: UiNode[] }) => {
    if (!r.changed) return;
    const scopes = r.lists?.map((l) => paths.get(l.id)!.split('.').slice(0, -1).join('.') || paths.get(l.id)!);
    out.push({ key, label, screens: r.screens, changed: r.changed, ...(scopes ? { scopes } : {}) });
  };
  add('translate', 'Translated (+40%, long words)', editTexts(screens, (n, up) => (translatable(n, up) && !isPlayerName(n, up) && !amountKind(n, up) ? longer(n.text!) : null)));
  add('names', 'Long player names (20 × W)', editTexts(screens, (n, up) => (isPlayerName(n, up) ? 'W'.repeat(20) : null)));
  add('numbers', 'Huge amounts (999,999,999)', editTexts(screens, (n, up) => {
    const k = amountKind(n, up);
    return k ? hugeNumbers(n.text!, k) : null;
  }));
  add('empty', 'Empty texts', editTexts(screens, (n) => (n.cls !== 'TextBox' && plainText(n).trim() ? '' : null)));
  add('items0', 'Lists with 0 items', resizeLists(screens, 0, false));
  add('items1', 'Lists with 1 item', resizeLists(screens, 1, false));
  add('items50', 'Scrolling lists with 50 items', resizeLists(screens, 50, true));
  return out;
}

// ─── Checks ─────────────────────────────────────────────────────────────────────────────────────

type Rect = { x: number; y: number; w: number; h: number };
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clipTo(r: Rect, c: [number, number, number, number]): Rect {
  const x = Math.max(r.x, c[0]);
  const y = Math.max(r.y, c[1]);
  return { x, y, w: Math.max(0, Math.min(r.x + r.w, c[0] + c[2]) - x), h: Math.max(0, Math.min(r.y + r.h, c[1] + c[3]) - y) };
}

/** The smallest text size that reads well on each device (a TV is read from across the room). */
export const READABLE: Record<UiDevice, number> = { phone: 11, phonePortrait: 11, tablet: 11, laptop: 11, desktop: 11, tv: 16 };

/** Where a text's letters land: its lines measured, placed by its alignment in its box. */
function ink(l: LaidOut, measure: Measure): Rect | null {
  const n = l.box.node;
  const t = plainText(n);
  if (!t.trim() || l.box.fontSize <= 0 || (n.textT ?? 0) >= 0.95) return null;
  const size = l.box.fontSize;
  const lines = n.wrapped || n.scaled ? wrapText(t, size, Math.max(1, l.box.w), n, measure) : t.split('\n');
  // TextTruncate ends a line that doesn't fit in "…" inside the box.
  const w = Math.min(Math.max(...lines.map((s) => measure(s, size, n))), n.truncate ? l.box.w : Infinity);
  const h = lines.length * size * (n.lineHeight ?? 1);
  const x = n.xAlign === 'Left' ? l.box.x : n.xAlign === 'Right' ? l.box.x + l.box.w - w : l.box.x + (l.box.w - w) / 2;
  const y = n.yAlign === 'Top' ? l.box.y : n.yAlign === 'Bottom' ? l.box.y + l.box.h - h : l.box.y + (l.box.h - h) / 2;
  return { x, y, w, h };
}

/** Each screen on its own, and each hidden panel shown in its screen (as auditUi checks them). */
function screenViews(screens: UiNode[]): LabView[] {
  const none = new Set<number>();
  const out: LabView[] = [];
  for (const s of screens) {
    out.push({ name: s.name, screens: [s], show: none, scope: null, whenShown: s.enabled === false });
    for (const h of hiddenRoots(s)) out.push({ name: h.path, screens: [s], show: new Set([h.node.id]), scope: h.path, whenShown: true });
  }
  return out;
}

/**
 * The stress checks auditUi doesn't make, for one layout of the screens. `fitted` collects (from the screens as they
 * are) the ScrollingFrames whose CanvasSize matches their content: a script sizes those, so they follow it.
 */
function extraChecks(screens: UiNode[], devices: UiDevice[], measure: Measure, fitted: Set<string>, learn: boolean): LabFinding[] {
  const sink = findingSink();
  for (const device of devices) {
    const dev = UI_DEVICES[device];
    for (const view of screenViews(screens)) {
      const laid = layView(view, dev, measure);
      const extra = view.whenShown ? { whenShown: true } : {};
      const mine = (l: LaidOut) => inScope(l.box.path, view.scope);
      const inks: Array<{ l: LaidOut; r: Rect }> = [];
      for (const l of laid) {
        const n = l.box.node;
        if (!isText(n) || !plainText(n).trim() || l.box.w < 1 || l.box.h < 1) continue;
        const r = ink(l, measure);
        if (!r) continue;
        // What shows of it: clipped by ClipsDescendants and ScrollingFrames (a list's far items are out of view).
        const seen = l.box.clip ? clipTo(r, l.box.clip) : r;
        if (area(seen) > 0) inks.push({ l, r: seen });
        if (!mine(l)) continue;
        const size = l.box.fontSize;
        // TextScaled shrinking it below a readable size (auditUi checks phones).
        if (n.scaled && device !== 'phone' && device !== 'phonePortrait' && size < READABLE[device])
          sink.add({ kind: 'stress-scaled', severity: 'warning', path: l.box.path, message: `TextScaled shrinks it to ${Math.round(size)} points: too small to read on a ${dev.label.toLowerCase()} (${READABLE[device]}+)`, ...extra }, device);
        // Wrapped text needing more lines than its box holds, or a word wider than the box.
        if (n.wrapped && !n.scaled && !n.truncate && n.auto !== 'Y' && n.auto !== 'XY') {
          if (r.h > l.box.h * 1.1 + 4)
            sink.add({ kind: 'stress-wrap', severity: 'warning', path: l.box.path, message: `Wrapped text needs about ${Math.round(r.h)} points of height in a ${Math.round(l.box.h)}-point box: the last lines are cut or spill out`, ...extra }, device);
          if (r.w > l.box.w * 1.08 + 4)
            sink.add({ kind: 'stress-wrap', severity: 'warning', path: l.box.path, message: `A word is about ${Math.round(r.w)} points wide in a ${Math.round(l.box.w)}-point box: it can't wrap, so it runs out`, ...extra }, device);
        }
        // Text running outside the panel it sits on (the nearest ancestor that draws a fill; a scrolling list's
        // content scrolls, so a ScrollingFrame on the way ends the search).
        const panelAt = l.up.findIndex((a) => a.cls === 'ScrollingFrame' || (!!a.bg && (a.bgT ?? 0) < 0.5 && a.cls !== 'ScreenGui'));
        const panel = panelAt >= 0 && l.up[panelAt]!.cls !== 'ScrollingFrame' ? laid.find((p) => p.box.node === l.up[panelAt]) : undefined;
        if (panel) {
          const p = panel.box;
          const out = Math.max(p.x - r.x, r.x + r.w - (p.x + p.w), p.y - r.y, r.y + r.h - (p.y + p.h));
          if (out > 6 && out > 0.06 * Math.min(r.w, 400)) {
            const clipped = l.up.slice(0, panelAt + 1).some((a) => a.clips || a.cls === 'ScrollingFrame');
            sink.add({ kind: 'stress-spill', severity: 'warning', path: l.box.path, message: `Text runs about ${Math.round(out)} points past the edge of ${panel.box.path}${clipped ? ', which cuts it off' : ''}`, ...extra }, device);
          }
        }
      }
      // Text running into other text or into an icon (not its own parts).
      const icons = laid
        .filter((l) => !!l.box.node.image && (l.box.node.imageT ?? 0) < 0.9 && l.box.w * l.box.h < 0.05 * dev.w * dev.h)
        .map((l) => ({ l, r: l.box.clip ? clipTo(l.box, l.box.clip) : { x: l.box.x, y: l.box.y, w: l.box.w, h: l.box.h } }))
        .filter((i) => area(i.r) > 0);
      const things = [...inks, ...icons].sort((a, b) => a.r.x - b.r.x);
      for (let i = 0; i < things.length; i++) {
        const a = things[i]!;
        for (let j = i + 1; j < things.length && things[j]!.r.x < a.r.x + a.r.w; j++) {
          const b = things[j]!;
          if (!isText(a.l.box.node) && !isText(b.l.box.node)) continue;
          if (!mine(a.l) && !mine(b.l)) continue;
          if (a.l.up.includes(b.l.box.node) || b.l.up.includes(a.l.box.node)) continue;
          const o = overlap(a.r, b.r);
          if (o > 0.15 * Math.min(area(a.r), area(b.r))) {
            const [t, u] = isText(a.l.box.node) ? [a, b] : [b, a];
            sink.add({ kind: 'stress-collide', severity: 'warning', path: t.l.box.path, message: `Its text runs into ${u.l.box.path}`, ...extra }, device);
          }
        }
      }
      // A ScrollingFrame with a fixed CanvasSize that its content outgrows: what lies past it can't be scrolled to.
      for (const l of laid) {
        const n = l.box.node;
        const c = n.canvas;
        // Only when the capture says AutomaticCanvasSize is None (it doesn't read it yet): a script may size the canvas,
        // as one did on Studio's window for a 413-point canvas that fits nothing on a phone or a desktop.
        if (n.cls !== 'ScrollingFrame' || !c || !mine(l) || (n as UiNode & { autoCanvas?: string }).autoCanvas !== 'None' || (c[0] === 0 && c[1] === 0 && c[2] === 0 && c[3] === 0)) continue;
        const ch = c[2] * l.box.h + c[3] * l.box.k;
        const cw = c[0] * l.box.w + c[1] * l.box.k;
        const inside = laid.filter((k) => k.up[0] === n && k.box.w > 0 && k.box.h > 0);
        const bottom = Math.max(0, ...inside.map((k) => k.box.y + k.box.h - l.box.y));
        const right = Math.max(0, ...inside.map((k) => k.box.x + k.box.w - l.box.x));
        const past = Math.max(ch > 0 ? bottom - Math.max(ch, l.box.h) : 0, cw > 0 ? right - Math.max(cw, l.box.w) : 0);
        if (learn && ((ch > 0 && Math.abs(bottom - ch) <= Math.max(8, 0.02 * ch)) || (cw > 0 && Math.abs(right - cw) <= Math.max(8, 0.02 * cw)))) fitted.add(l.box.path);
        if (past > 4 && !fitted.has(l.box.path))
          sink.add({ kind: 'stress-scroll', severity: 'warning', path: l.box.path, message: `Content runs about ${Math.round(past)} points past its fixed CanvasSize: the items there can't be scrolled to (AutomaticCanvasSize grows it)`, ...extra }, device);
      }
      // Buttons that collapse (an AutomaticSize button whose text went empty).
      for (const l of laid)
        if (mine(l) && isButton(l.box.node) && l.box.node.auto && (l.box.w < 8 || l.box.h < 8))
          sink.add({ kind: 'stress-collapse', severity: 'warning', path: l.box.path, message: `Shrinks to ${Math.round(l.box.w)}×${Math.round(l.box.h)} points: nothing left to tap`, ...extra }, device);
    }
  }
  return sink.list();
}

const auditKind = (m: string) =>
  /cut off/.test(m) ? 'stress-cut' : /off the screen/.test(m) ? 'stress-offscreen' : /^Overlaps/.test(m) ? 'stress-overlap' : /^Runs into/.test(m) ? 'stress-collide' : /hard to read/.test(m) ? 'stress-small-text' : /Small to tap/.test(m) ? 'stress-small-target' : null;

/** Everything the checks find in one version of the screens, keyed so versions compare. */
function checkAll(screens: UiNode[], devices: UiDevice[], measure: Measure, fitted: Set<string>, learn: boolean): Map<string, LabFinding> {
  const out = new Map<string, LabFinding>();
  const key = (f: LabFinding) => `${f.kind}|${f.path}|${f.message.replace(/\d+(\.\d+)?/g, '#')}`;
  for (const f of auditUi(screens, devices, measure)) {
    const kind = auditKind(f.message);
    if (kind) out.set(key({ ...f, kind }), { ...f, kind });
  }
  for (const f of extraChecks(screens, devices, measure, fitted, learn)) out.set(key(f), f);
  return out;
}

/** A screen without the hidden panels (Visible = false, other pages) that hold none of `scopes`: their checks can't change. */
function pruneFor(screen: UiNode, scopes: string[]): UiNode {
  const holds = (path: string) => scopes.some((sc) => sc === path || sc.startsWith(`${path}.`));
  const walk = (n: UiNode, path: string): UiNode => {
    if (!n.kids) return n;
    const page = n.pages ? pageShown(n) : null;
    const kids = n.kids.filter((c) => !(c.visible === false || (page && c !== page)) || holds(`${path}.${c.name}`)).map((c) => walk(c, `${path}.${c.name}`));
    return kids.length === n.kids.length && kids.every((c, i) => c === n.kids![i]) ? n : { ...n, kids };
  };
  return walk(screen, screen.name);
}

/**
 * What breaks under each stress variant and not in the screens as they are, per device: findings carry the variant's
 * label (in `variant` and at the start of the message). A finding that also appears without stress is left out.
 */
export function stressFindings(screens: UiNode[], devices: UiDevice[] = ['phone', 'tablet', 'desktop', 'tv'], measure: Measure = estimateText): StressFinding[] {
  const fitted = new Set<string>();
  const base = checkAll(screens, devices, measure, fitted, true);
  const out: StressFinding[] = [];
  for (const v of stressVariants(screens)) {
    const within = (path: string) => !v.scopes || v.scopes.some((sc) => path === sc || path.startsWith(`${sc}.`));
    // Only the screens it changed are checked again (for a list, without the hidden panels it isn't in).
    const touched = v.screens.filter((sc, i) => sc !== screens[i]).map((sc) => (v.scopes ? pruneFor(sc, v.scopes) : sc));
    for (const [k, f] of checkAll(touched, devices, measure, fitted, false)) {
      if (base.has(k) || !within(f.path)) continue;
      // auditUi's overlaps don't know a ScrollingFrame clips its far items: for a list, only the clip-aware checks.
      if (v.scopes && (f.kind === 'stress-overlap' || (f.kind === 'stress-collide' && f.message.startsWith('Runs into')))) continue;
      // A device where it already broke without stress doesn't count.
      const devs = f.devices.filter((d) => ![...base.values()].some((b) => b.kind === f.kind && b.path === f.path && b.devices.includes(d)));
      if (f.devices.length && !devs.length) continue;
      out.push({ ...f, devices: devs, variant: v.label, message: `${v.label}: ${f.message}` });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1));
}
