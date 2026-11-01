import { applySet, type MockForm, type MockFormLayout, type MockNode, type MockPatch } from '@shared/ui-mockup';

/**
 * The device forms a template lays itself out for, as the design canvas each one gets under kit "ui" (Ui.screen: a
 * 1920×1080 reference fitted with a UIScale of 0.8-1.5, 1.25× on a TV, below the top bar): the smallest canvas any of
 * the Lab's devices of that form gives, so a layout that fits it fits them all (the bigger ones only add margin).
 *
 *   phone          834×377   iPhone SE 667×375 is the tightest (a notch phone is 937×389, a big Android 1144×442)
 *   phonePortrait  487×881   an upright notch phone (status bar, top bar and home bar taken out)
 *   tablet        1416×832   iPad mini (an iPad Air is 1475×927)
 *   desktop       1707×887   a 1366×768 laptop (1080p is 2029×1080)
 *   tv            1671×864   1080p at 10 feet: the kit fits 1.25× bigger, and TVs crop 5% at the edges
 *
 * Text sizes are design points for what reads at a glance, not the legibility floor: secondary labels at 14 pt on a
 * phone and 16 pt on a tablet or computer (18 design points at the phone's 0.8 UIScale, 20 at a laptop's), tabs and
 * buttons 18 pt and up; buttons meet a finger (7 mm: 54 design points on a phone).
 */

export interface FormCtx {
  form: MockForm;
  w: number;
  h: number;
  /** Safe margins inside the canvas: left, top, right, bottom (a TV's 5% overscan). */
  inset: [number, number, number, number];
  touch: boolean;
  tv: boolean;
  phone: boolean;
  portrait: boolean;
  /** Text sizes by role. */
  ts: { title: number; h1: number; h2: number; body: number; small: number; button: number; num: number; big: number };
  /** The least height of a button a player taps. */
  tap: number;
  gap: number;
  /** A general scale against the desktop design (sizes of art, icons, cards). */
  k: number;
}

const F: Record<MockForm, FormCtx> = {
  phone: { form: 'phone', w: 834, h: 377, inset: [10, 8, 10, 8], touch: true, tv: false, phone: true, portrait: false, ts: { title: 58, h1: 23, h2: 20, body: 19, small: 18, button: 22, num: 21, big: 36 }, tap: 54, gap: 8, k: 0.62 },
  phonePortrait: { form: 'phonePortrait', w: 487, h: 881, inset: [12, 12, 12, 16], touch: true, tv: false, phone: true, portrait: true, ts: { title: 60, h1: 23, h2: 20, body: 19, small: 18, button: 22, num: 21, big: 40 }, tap: 56, gap: 10, k: 0.66 },
  tablet: { form: 'tablet', w: 1416, h: 832, inset: [24, 20, 24, 20], touch: true, tv: false, phone: false, portrait: false, ts: { title: 72, h1: 28, h2: 24, body: 22, small: 20, button: 24, num: 26, big: 50 }, tap: 56, gap: 14, k: 0.9 },
  desktop: { form: 'desktop', w: 1707, h: 887, inset: [28, 24, 28, 24], touch: false, tv: false, phone: false, portrait: false, ts: { title: 78, h1: 30, h2: 25, body: 22, small: 20, button: 26, num: 28, big: 56 }, tap: 52, gap: 16, k: 1 },
  tv: { form: 'tv', w: 1671, h: 864, inset: [84, 16, 84, 50], touch: false, tv: true, phone: false, portrait: false, ts: { title: 80, h1: 32, h2: 27, body: 25, small: 22, button: 30, num: 32, big: 60 }, tap: 60, gap: 18, k: 1.04 },
};

export const formCtx = (form: MockForm): FormCtx => F[form];

/** The usable box of a form: its canvas less the safe margins. */
export const safeBox = (f: FormCtx) => ({ x: f.inset[0], y: f.inset[1], w: f.w - f.inset[0] - f.inset[2], h: f.h - f.inset[1] - f.inset[3] });

export const MENU_FORMS: MockForm[] = ['phone', 'phonePortrait', 'tablet', 'desktop', 'tv'];
/** What a full-screen menu hides of Roblox's own UI while it is open. */
export const MENU_HIDES = 'chat playerList touch';
export const HUD_FORMS: MockForm[] = ['phone', 'tablet', 'desktop', 'tv'];

// ─── A screen from one layout function per form ───────────────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A tree without null and undefined fields (what a patch's nulls leave behind reads the same as a missing field). */
function clean<T>(x: T): T {
  if (Array.isArray(x)) return x.map(clean) as T;
  if (!isObj(x)) return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) if (v !== null && v !== undefined) out[k] = clean(v);
  return out as T;
}

/**
 * The changes that turn the default children into a form's: per element, the properties that differ (null for those
 * it drops; objects merge one level deep as `set` does), elements it removes (null) or adds (whole, with cls). Null
 * when the form's tree can't be reached that way (children in another order).
 */
function diffKids(base: MockNode[], form: MockNode[], prefix: string, out: Record<string, MockPatch | null>): boolean {
  const names = (l: MockNode[]) => l.map((n) => n.name);
  const kept = names(base).filter((n) => names(form).includes(n));
  // Kept children in the same order, added ones after them.
  if (!same(kept, names(form).filter((n) => names(base).includes(n)))) return false;
  const firstAdded = form.findIndex((n) => !names(base).includes(n.name));
  if (firstAdded >= 0 && form.slice(firstAdded).some((n) => names(base).includes(n.name))) return false;
  for (const b of base) {
    const path = prefix ? `${prefix}.${b.name}` : b.name;
    const g = form.find((n) => n.name === b.name);
    if (!g) {
      out[path] = null;
      continue;
    }
    const patch: MockPatch = {};
    const keys = new Set([...Object.keys(b), ...Object.keys(g)].filter((k) => k !== 'kids' && k !== 'name'));
    for (const k of keys) {
      const bv = (b as Record<string, unknown>)[k];
      const gv = (g as Record<string, unknown>)[k];
      if (same(bv, gv)) continue;
      if (gv === undefined) patch[k] = null;
      else if (isObj(bv) && isObj(gv)) {
        // One level deep: changed fields, and nulls for the ones the form drops.
        const sub: Record<string, unknown> = {};
        for (const sk of new Set([...Object.keys(bv), ...Object.keys(gv)])) if (!same(bv[sk], gv[sk])) sub[sk] = gv[sk] === undefined ? null : gv[sk];
        patch[k] = sub;
      } else patch[k] = gv;
    }
    if (Object.keys(patch).length) out[path] = patch;
    if (!diffKids(b.kids ?? [], g.kids ?? [], path, out)) return false;
  }
  for (const g of form) if (!base.some((b) => b.name === g.name)) out[prefix ? `${prefix}.${g.name}` : g.name] = g as unknown as MockPatch;
  return true;
}

/** A form's layout as changes to the default children when that reproduces it exactly, else its own children. */
export function formLayout(screen: string, base: MockNode[], form: MockNode[]): MockFormLayout | null {
  if (same(clean(base), clean(form))) return null;
  const set: Record<string, MockPatch | null> = {};
  if (diffKids(base, form, '', set)) {
    const errors: string[] = [];
    const got = applySet(base, set, screen, errors);
    // States can't carry a null (a dropped state): those forms keep their own children.
    const nullState = Object.values(set).some((p) => isObj(p) && isObj(p.states) && Object.values(p.states).some((s) => s === null));
    if (!errors.length && !nullState && same(clean(got), clean(form))) return { set };
  }
  return { kids: form };
}

export interface ScreenSpec {
  name: string;
  displayOrder?: number;
  /** A screen a script enables later (a menu, a toast, a dialog). */
  enabled?: boolean;
  /** Roblox's own UI it hides while open (a full-screen menu: "chat playerList touch"); the builder restores it on close. */
  hides?: string;
  note?: string;
  forms: MockForm[];
  /** The children for a form. */
  build: (f: FormCtx) => MockNode[];
}

/** A ScreenGui under kit "ui": the desktop layout as its children, every other form as changes to it (or its own). */
export function composeScreen(s: ScreenSpec): MockNode {
  const base = s.build(F.desktop);
  const forms: NonNullable<MockNode['forms']> = {};
  for (const form of s.forms) {
    if (form === 'desktop') continue;
    const layout = formLayout(s.name, base, s.build(F[form]));
    if (layout) forms[form] = layout;
  }
  return {
    name: s.name,
    kit: 'ui',
    ...(s.displayOrder !== undefined ? { displayOrder: s.displayOrder } : {}),
    ...(s.enabled === false ? { enabled: false } : {}),
    ...(s.hides ? { hides: s.hides } : {}),
    ...(s.note ? { note: s.note } : {}),
    kids: base,
    ...(Object.keys(forms).length ? { forms } : {}),
  };
}
