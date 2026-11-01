import { auditUi, isButton, isText, layoutScreen, plainText, withStartStates, type AuditScreen, type UiBox, type UiDevice, type UiNode } from '@shared/ui-layout';
import { resolveVersion, type MockMotion, type MockVersion, type Mockup } from '@shared/ui-mockup';
import type { RgbaImage } from '../../modeling/png';
import { sideBySide, type Backdrop } from '../ui-render';
import { wearSkins } from '../ui-pictures';
import type { SkinForge } from '../forge/resolve';
import { coreOverlays, coreWhileShown, mergeFindings, overlayFindings, renderLab, type CoreOptions, type CoreRegion } from './core-overlays';
import { labDevice, labDevicesFor, LAB_DEVICES, normalizeInsets, type LabDevice } from './devices';
import { feelOf } from './feel';
import { filmstrip } from './filmstrip';
import { robloxFontPicker } from './lab-text';
import { compileMotion, type LabMotion } from './motion-sim';
import { findRobloxFonts, robloxMeasure } from './roblox-fonts';
import { navFindings, touchFindings, type LabFinding as InteractFinding } from './interact';
import { stressFindings } from './stress';
import { critiqueUi, overallScore, VIEWING } from './critique';
import { phoneChecks } from './phone';

/**
 * The UI Lab: a design (a mockup version) or the game's UI as read from Studio, checked on the devices players use as
 * Roblox would show it — Roblox's own fonts and text metrics (fitted to TextBounds read in Studio), the layout engine,
 * Roblox's own touch controls, top bar, hotbar, player list and chat from its scripts, motion as the Motion module plays
 * it — with no Studio call. One check returns everything an agent needs to fix, by category; the pictures are the
 * devices as a player sees them.
 */

/** What is checked: screens per device (a mockup resolves its form layouts), the moves it makes, the game's settings. */
export interface LabSubject {
  title: string;
  screensOn(dev: LabDevice): UiNode[];
  motion: Array<LabMotion | MockMotion>;
  /** StarterGui.ScreenOrientation: Portrait or Sensor adds the upright phones. */
  orientation?: string | null;
  /** What the game turns off of Roblox's own UI (SetCoreGuiEnabled, touch controls, tools held). */
  core?: CoreOptions;
  /** The game's UI as read from Studio (one layout, Studio's window); adaptive: its code lays it out per device. */
  captured?: { adaptive: boolean };
  /** The images its screens show (forged skins and the project's), for checks that judge the rendered pixels. */
  images?: (ref: string, px: number) => RgbaImage | null;
}

/** The subject without drawn art (worn skins' "Skin" children): what layout checks measure. */
export function withoutDecor(subject: LabSubject): LabSubject {
  const strip = (n: UiNode): UiNode => (n.kids?.some((k) => k.decor) || n.kids?.some((k) => k.kids) ? { ...n, ...(n.kids.some((k) => k.decor) ? { skinned: n.skinned ?? 0 } : {}), kids: n.kids.filter((k) => !k.decor).map(strip) } : n);
  const memo = new Map<string, UiNode[]>();
  return { ...subject, screensOn: (dev) => memo.get(dev.id) ?? (memo.set(dev.id, subject.screensOn(dev).map(strip)), memo.get(dev.id)!) };
}

/** The subject with its forged skins worn, as they ship (art under each element, text lifted above it). */
export function wornSubject(subject: LabSubject, images: (ref: string, px: number) => RgbaImage | null = () => null, sf?: SkinForge): { subject: LabSubject; errors: () => string[] } {
  const memo = new Map<string, UiNode[]>();
  const errors = new Set<string>();
  const imgs: Array<(ref: string, px: number) => RgbaImage | null> = [];
  const worn: LabSubject = {
    ...subject,
    screensOn: (dev) => {
      const hit = memo.get(dev.id);
      if (hit) return hit;
      const w = wearSkins(subject.screensOn(dev), images, sf);
      w.errors.forEach((e) => errors.add(e));
      imgs.push(w.images);
      // As they start: the open tab selected, a button not usable yet disabled (after wearing: a state may swap art).
      const started = withStartStates(w.screens);
      memo.set(dev.id, started);
      return started;
    },
    images: (ref, px) => {
      for (const f of imgs) {
        const got = f(ref, px);
        if (got) return got;
      }
      return images(ref, px);
    },
  };
  return { subject: worn, errors: () => [...errors] };
}

/** The mockup device a lab device takes its form layout from. */
export function formDevice(dev: LabDevice): UiDevice {
  if (dev.form === 'phone') return dev.orientation === 'portrait' ? 'phonePortrait' : 'phone';
  if (dev.form === 'tablet') return 'tablet';
  if (dev.form === 'console') return 'tv';
  return 'desktop';
}

export function mockupSubject(m: Pick<Mockup, 'title'>, v: MockVersion, core?: CoreOptions): LabSubject {
  return { title: `${m.title} ${v.id}`, screensOn: (dev) => resolveVersion(v, formDevice(dev)).screens, motion: v.motion ?? [], core };
}

export function gameSubject(title: string, screens: UiNode[], o: { orientation?: string | null; core?: CoreOptions; motion?: LabMotion[]; adaptive?: boolean } = {}): LabSubject {
  return { title, screensOn: () => screens, motion: o.motion ?? [], orientation: o.orientation, core: o.core, captured: { adaptive: !!o.adaptive } };
}

/**
 * A game's code that lays its UI out per device (the kits' onDevice, input or screen-size switches): a capture holds
 * the one layout Studio's window got, so what it shows on other devices is a guess (graded against the games' code:
 * most such findings on phones were layouts the game never shows there).
 */
export const ADAPTS_PER_DEVICE = /onDevice\s*\(|PreferredInput|TouchEnabled|IsTenFootInterface|ViewportSize|GetPropertyChangedSignal\(\s*["']AbsoluteSize["']\s*\)/;

export type LabCategory = 'layout' | 'text' | 'roblox-ui' | 'touch' | 'gamepad' | 'stress' | 'design' | 'motion';
export const LAB_CATEGORIES: LabCategory[] = ['roblox-ui', 'layout', 'text', 'touch', 'gamepad', 'stress', 'design', 'motion'];

export interface LabFinding {
  category: LabCategory;
  severity: 'problem' | 'warning' | 'note';
  path: string;
  message: string;
  /** Lab device ids (empty: not about a screen size). */
  devices: string[];
  whenShown?: boolean;
}

export interface LabCheckOptions {
  /** Device ids (lab ids or ui_audit's), "phones", "touch", or all (default: every device the game's orientation allows). */
  devices?: string[] | 'all' | 'phones' | 'touch';
  core?: CoreOptions;
  /** The project's images; with skins, every check sees the screens as they ship. */
  images?: (ref: string, px: number) => RgbaImage | null;
  skins?: SkinForge;
}

export interface LabReport {
  title: string;
  devices: string[];
  findings: LabFinding[];
  counts: Partial<Record<LabCategory, { problems: number; warnings: number }>>;
  /** Text drawn and measured in Roblox's own fonts (false: no Studio install, stand-ins and estimates). */
  exactText: boolean;
  notes: string[];
  motion: string | null;
  /** The design critic's score (0-100, defects only: a clean screen scores high whether or not it is beautiful) per form. */
  design: Record<string, number>;
  ms: number;
}

export function pickDevices(subject: Pick<LabSubject, 'orientation'>, want: LabCheckOptions['devices']): LabDevice[] {
  const allowed = labDevicesFor(subject.orientation);
  if (!want || want === 'all') return allowed;
  if (want === 'phones') return allowed.filter((d) => d.form === 'phone');
  if (want === 'touch') return allowed.filter((d) => d.input === 'touch');
  return want.map((id) => labDevice(id)).filter((d): d is LabDevice => !!d);
}

const auditScreen = (d: LabDevice): AuditScreen => ({ ...d, id: d.id, phone: d.form === 'phone' });

/** Whether an element sits inside a ScrollingFrame (which can scroll it into view). */
function subjectScrolls(screen: UiNode, path: string): boolean {
  let n: UiNode | undefined = screen;
  for (const seg of path.split('.').slice(1, -1)) {
    n = n?.kids?.find((k) => k.name === seg);
    if (n?.cls === 'ScrollingFrame') return true;
  }
  return false;
}

/** Hidden menus and screens a script shows later: checked as if shown, like the audit does. */
function hiddenRoots(screen: UiNode): Array<{ node: UiNode; path: string }> {
  const out: Array<{ node: UiNode; path: string }> = [];
  const walk = (n: UiNode, path: string) => {
    for (const c of n.kids ?? []) {
      const p = `${path}.${c.name}`;
      if (c.visible === false) out.push({ node: c, path: p });
      else walk(c, p);
    }
  };
  walk(screen, screen.name);
  return out;
}

/** Text that fits its box by a hair: a longer word, a translation or another device's pixel rounding spills it. */
function tightText(boxes: UiBox[]): Array<{ path: string; spare: number }> {
  const out: Array<{ path: string; spare: number }> = [];
  for (const b of boxes) {
    const n = b.node;
    if (!isText(n) || n.scaled || n.wrapped || n.truncate || n.auto || b.fontSize <= 0 || b.w < 1) continue;
    const text = plainText(n).trim();
    if (!text) continue;
    const pad = n.padding ? (n.padding[1][0] + n.padding[3][0]) * b.w + (n.padding[1][1] + n.padding[3][1]) * b.k : 0;
    const room = b.w - pad;
    const tw = Math.max(...text.split('\n').map((l) => robloxMeasure(l, b.fontSize, n)));
    const spare = room - tw;
    if (spare >= -1 && spare < Math.max(2, 0.03 * room)) out.push({ path: b.path, spare });
  }
  return out;
}

/**
 * Everything the Lab checks, on every device: the audit with Roblox's text metrics (off screen, overlaps, small
 * targets and text, text running out of its box, contrast), Roblox's own UI over the game's (jump button, thumbstick,
 * top bar, hotbar, player list, chat), tight text, and the motion's feel. Interaction, stress and design checks join
 * through `extraChecks`.
 */
export function labCheck(raw: LabSubject, o: LabCheckOptions = {}): LabReport {
  const t0 = performance.now();
  // Skins worn as they ship (a no-op for screens without any).
  const wearing = wornSubject(raw, o.images, o.skins);
  const subject = wearing.subject;
  // Layout, overlap, Roblox-UI, text and interaction checks look past the art (its glow reaches outside the box).
  const plain = withoutDecor(subject);
  const devices = pickDevices(subject, o.devices);
  const core: CoreOptions = { ...subject.core, ...o.core };
  const exactText = !!findRobloxFonts();
  const findings: LabFinding[] = [];
  const notes = new Set<string>();
  const add = (f: LabFinding) => findings.push(f);

  // 1. The audit, per device, in Roblox's own text metrics.
  const byForm = new Map<string, { screens: UiNode[]; devices: LabDevice[] }>();
  for (const d of devices) {
    const screens = plain.screensOn(d).map(normalizeInsets);
    const key = JSON.stringify(screens.map((s) => s.id ?? s.name)) + formDevice(d);
    const e = byForm.get(key) ?? { screens, devices: [] };
    e.devices.push(d);
    byForm.set(key, e);
  }
  for (const { screens, devices: ds } of byForm.values()) {
    for (const f of auditUi(screens, ds.map(auditScreen), robloxMeasure, { exactText }))
      add({ category: /^(Text |Low contrast)/.test(f.message) ? 'text' : 'layout', severity: f.severity, path: f.path, message: f.message, devices: f.devices as string[], ...(f.whenShown ? { whenShown: true } : {}) });
  }

  // 1b. Cut by the screen's edge or reaching under a notch: the audit only calls 30% off the screen; a button with a
  // sliver cut off (a judge found Heal clipped on an iPhone SE that the audit passed) or under the notch is one too.
  const edges = new Map<string, { devices: string[]; cut: number; notch: boolean; whenShown: boolean }>();
  for (const d of devices)
    for (const s of plain.screensOn(d).map(normalizeInsets)) {
      const views: Array<{ show?: Set<number>; scope?: string }> = [{}, ...hiddenRoots(s).map((h) => ({ show: new Set([h.node.id]), scope: h.path }))];
      for (const v of views)
        for (const b of layoutScreen(s, d, { measure: robloxMeasure, ...(v.show ? { show: v.show } : {}) })) {
          if (v.scope && b.path !== v.scope && !b.path.startsWith(`${v.scope}.`)) continue;
          const n = b.node;
          const matters = isButton(n) || (isText(n) && !!plainText(n).trim());
          if (!matters || b.w < 4 || b.h < 4 || b.w * b.h > 0.5 * d.w * d.h) continue;
          // What its clipping container leaves of it (a list scrolls it into view).
          const [cx, cy, cw, ch] = b.clip ?? [-1e9, -1e9, 2e9, 2e9];
          if (b.clip && subjectScrolls(s, b.path)) continue;
          const x0 = Math.max(b.x, cx);
          const y0 = Math.max(b.y, cy);
          const x1 = Math.min(b.x + b.w, cx + cw);
          const y1 = Math.min(b.y + b.h, cy + ch);
          if (x1 <= x0 || y1 <= y0) continue;
          const shown = ((Math.min(x1, d.w) - Math.max(x0, 0)) * (Math.min(y1, d.h) - Math.max(y0, 0))) / ((x1 - x0) * (y1 - y0));
          if (shown < 0.7 || !Number.isFinite(shown)) continue; // the audit's own "off the screen"
          const cut = Math.max(0, -x0, x1 - d.w, -y0, y1 - d.h);
          const side = d.side ?? 0;
          const notch = isButton(n) && side > 0 && Math.max(side - x0, x1 - (d.w - side)) > 4;
          if (cut <= 2 && !notch) continue;
          const e = edges.get(b.path) ?? { devices: [], cut: 0, notch: false, whenShown: !!v.scope || s.enabled === false };
          e.devices.push(d.id);
          e.cut = Math.max(e.cut, cut);
          e.notch ||= notch && cut <= 2;
          edges.set(b.path, e);
        }
    }
  for (const [path, e] of edges)
    add({ category: 'layout', severity: e.cut > 2 ? 'problem' : 'warning', path, message: e.cut > 2 ? `Cut off by the screen's edge: ${Math.round(e.cut)} points of it are past the edge` : 'Reaches under the notch or rounded corner (outside the safe area): keep buttons inside it', devices: [...new Set(e.devices)], ...(e.whenShown ? { whenShown: true } : {}) });

  // 1c. Forged art drawn smaller than its 9-slice corners (Roblox squashes the corners into each other), or art that
  // can't stretch drawn at another shape (it distorts).
  const skinIssues = new Map<string, { devices: string[]; message: string; problem: boolean }>();
  const skinImg = (ref: string) => (ref.startsWith('skin:') ? (subject.images?.(ref, 64) ?? null) : null);
  for (const d of devices)
    for (const s of subject.screensOn(d).map(normalizeInsets))
      for (const b of layoutScreen(s, d, { measure: robloxMeasure })) {
        const n = b.node;
        if (n.name !== 'Skin' || !n.image?.startsWith('skin:') || b.w < 1 || b.h < 1) continue;
        const img = skinImg(n.image);
        if (!img) continue;
        const owner = b.path.replace(/\.Skin$/, '');
        let message: string | null = null;
        let problem = false;
        if (n.scaleType === 'Slice' && n.slice) {
          const k = (n.sliceScale ?? 1) * (b.k || 1);
          const cw = (n.slice[0] + img.width - n.slice[2]) * k;
          const ch = (n.slice[1] + img.height - n.slice[3]) * k;
          if (b.w + 0.5 < cw || b.h + 0.5 < ch) {
            problem = b.w + 0.5 < cw * 0.8 || b.h + 0.5 < ch * 0.8;
            const glow = 2 * Math.max(0, -(n.pos?.[1] ?? 0)) * (b.k || 1);
            message = `Its forged art needs at least ${Math.ceil(cw - glow)}×${Math.ceil(ch - glow)} points (the 9-slice's corners) but gets ${Math.round(b.w - glow)}×${Math.round(b.h - glow)}: Roblox squashes the corners. Make it bigger on this device, or skin it with a smaller kind`;
          }
        } else {
          const want = img.width / img.height;
          const got = b.w / b.h;
          if (Math.abs(Math.log(got / want)) > 0.12) message = `Its forged art (${(want).toFixed(2)}:1) is drawn at ${(got).toFixed(2)}:1 and distorts (this kind doesn't 9-slice): keep the element's shape, or give it an aspect constraint`;
        }
        if (!message) continue;
        const e = skinIssues.get(owner) ?? { devices: [], message, problem };
        e.devices.push(d.id);
        e.problem ||= problem;
        skinIssues.set(owner, e);
      }
  for (const [path, e] of skinIssues) add({ category: 'layout', severity: e.problem ? 'problem' : 'warning', path, message: e.message, devices: [...new Set(e.devices)] });

  // 2. Roblox's own UI over the game's, on each device, at spawn and with each hidden menu shown.
  const overlay = [];
  for (const d of devices) {
    const screens = plain.screensOn(d).map(normalizeInsets);
    for (const s of screens) {
      const later = s.enabled === false;
      // What this screen hides while it is open (and what the shown ones hide) is not over it.
      const regions = coreOverlays(d, coreWhileShown(core, screens.map((x) => (x === s ? { ...x, enabled: true } : x))));
      overlay.push(overlayFindings(layoutScreen(s, d, { measure: robloxMeasure }), regions, d, { screens, whenShown: later }));
      for (const h of hiddenRoots(s)) overlay.push(overlayFindings(layoutScreen(s, d, { measure: robloxMeasure, show: new Set([h.node.id]) }), regions, d, { screens, scope: h.path, whenShown: true }));
    }
  }
  for (const f of mergeFindings(overlay)) add({ category: 'roblox-ui', severity: f.severity, path: f.path, message: f.message, devices: f.devices, ...(f.whenShown ? { whenShown: true } : {}) });

  // 3. Text that fits by a hair (on the devices it is tight on).
  const tight = new Map<string, { devices: string[]; spare: number }>();
  for (const d of devices)
    for (const s of plain.screensOn(d).map(normalizeInsets))
      for (const t of tightText(layoutScreen(s, d, { measure: robloxMeasure }))) {
        const e = tight.get(t.path) ?? { devices: [], spare: t.spare };
        e.devices.push(d.id);
        e.spare = Math.min(e.spare, t.spare);
        tight.set(t.path, e);
      }
  // TextTruncate hides what doesn't fit: fine for a long name, a defect when a short word loses its letters ("Y…" for
  // "You", graded by a judge on a design the Lab had passed).
  const cut = new Map<string, { devices: string[]; shown: number; total: number; text: string }>();
  for (const d of devices)
    for (const s of plain.screensOn(d).map(normalizeInsets))
      for (const b of layoutScreen(s, d, { measure: robloxMeasure })) {
        const n = b.node;
        if (!isText(n) || !n.truncate || n.scaled || b.fontSize <= 0) continue;
        const text = plainText(n).trim();
        if (!text || text.includes('\n')) continue;
        const pad = n.padding ? (n.padding[1][0] + n.padding[3][0]) * b.w + (n.padding[1][1] + n.padding[3][1]) * b.k : 0;
        const room = b.w - pad;
        if (robloxMeasure(text, b.fontSize, n) <= room + 0.5) continue;
        const ell = robloxMeasure('…', b.fontSize, n);
        let shown = text.length;
        while (shown > 0 && robloxMeasure(text.slice(0, shown), b.fontSize, n) + ell > room) shown--;
        const e = cut.get(b.path) ?? { devices: [], shown, total: text.length, text };
        e.devices.push(d.id);
        e.shown = Math.min(e.shown, shown);
        cut.set(b.path, e);
      }
  for (const [path, c] of cut) {
    // Long names are meant to be cut; a short word or half a word isn't.
    const bad = c.total <= 6 || c.shown < Math.min(6, c.total * 0.5);
    if (bad) add({ category: 'text', severity: 'warning', path, message: `Truncated to "${c.text.slice(0, c.shown)}…" (${c.shown} of ${c.total} letters show): give it room for the text it carries`, devices: c.devices });
  }
  for (const [path, t] of tight)
    add({ category: 'text', severity: 'note', path, message: `Fits its box by ${Math.max(0, Math.round(t.spare * 10) / 10)} points: a longer word, a translation or a rounding on another screen spills it (give it room, TextScaled with a max, or TextTruncate)`, devices: t.devices });

  // 4. Motion: how it feels, on a phone (the timings don't change with the screen; the distances do).
  let motion: string | null = null;
  if (subject.motion.length) {
    const phone = devices.find((d) => d.form === 'phone') ?? devices[0] ?? LAB_DEVICES[0]!;
    const tl = compileMotion(subject.screensOn(phone), subject.motion, { device: phone });
    const feel = feelOf(tl);
    motion = feel.report;
    for (const f of feel.findings) add({ category: 'motion', severity: f.severity, path: f.path, message: f.message, devices: [] });
  }

  // Measured in Studio (2026-10-09): UIGradient.Type takes Radial, Conical and Elliptical, but Studio still draws them linear.
  const curved = new Set<string>();
  for (const d of devices.slice(0, 1))
    for (const s of subject.screensOn(d)) {
      const walk = (n: UiNode, path: string) => {
        for (const g of [n.gradient, ...(n.strokes ?? (n.stroke ? [n.stroke] : [])).map((x) => x.gradient)]) if (g?.type && g.type !== 'Linear') curved.add(path);
        for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`);
      };
      walk(s, s.name);
    }
  for (const path of curved) add({ category: 'design', severity: 'warning', path, message: 'A Radial/Conical gradient: Roblox Studio draws it as a plain left-to-right gradient (measured), so the game won\'t look like this picture. Use a Linear gradient, or an image', devices: [] });
  // A check that fails says so and the others still report (a crash here once hid every finding from a designer).
  for (const x of extraChecks) {
    try {
      for (const f of x(x === designChecks ? subject : plain, devices)) add(f);
    } catch (e) {
      notes.add(`The ${x.name.replace(/Checks$/, '')} check failed and was skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Keyboard and controller hints ("E", "Alt + click", key caps) mean nothing on a touch screen: their slips there are
  // notes (graded by eye: 4 of the first sample's 7 false problems were such hints).
  const touchIds = new Set(devices.filter((d) => d.input === 'touch').map((d) => d.id));
  for (const f of findings) {
    if (f.severity === 'note' || !f.devices.length || !f.devices.some((d) => touchIds.has(d)) || !isKeyHint(f.path)) continue;
    const others = f.devices.filter((d) => !touchIds.has(d));
    if (others.length) f.devices = others;
    else f.severity = 'note';
  }
  // A capture of a game that adapts its UI per device holds Studio's window's layout only: on other kinds of device
  // its problems are what that layout would do there, not what the game shows. Said so, and not called problems.
  if (subject.captured?.adaptive) {
    const computer = new Set(devices.filter((d) => d.form === 'computer').map((d) => d.id));
    let capped = 0;
    for (const f of findings) {
      if (f.severity !== 'problem' || !f.devices.length || f.devices.some((d) => computer.has(d))) continue;
      f.severity = 'warning';
      f.message = `${f.message} [as captured on Studio's window: this game lays its UI out per device in code, so check it captured on that device]`;
      capped++;
    }
    if (capped) notes.add(`${capped} problem${capped === 1 ? '' : 's'} on phones, tablets or a TV are warnings: the game builds its own layout per device, and this capture holds the one Studio's window got`);
  }
  const merged = collapse(findings);
  findings.length = 0;
  findings.push(...merged);
  if (!exactText) notes.add('Roblox Studio is not installed here: text is measured by estimate and drawn in stand-in fonts');
  const counts: LabReport['counts'] = {};
  for (const f of findings) {
    if (f.severity === 'note') continue;
    const c = (counts[f.category] ??= { problems: 0, warnings: 0 });
    if (f.severity === 'problem') c.problems++;
    else c.warnings++;
  }
  const rank = (f: LabFinding) => (f.severity === 'problem' ? 0 : f.severity === 'warning' ? 1 : 2);
  findings.sort((a, b) => rank(a) - rank(b) || LAB_CATEGORIES.indexOf(a.category) - LAB_CATEGORIES.indexOf(b.category) || Number(!!a.whenShown) - Number(!!b.whenShown));
  for (const e of wearing.errors()) notes.add(`skin ${e}`);
  return { title: subject.title, devices: devices.map((d) => d.id), findings, counts, exactText, notes: [...notes], motion, design: Object.fromEntries(lastScores), ms: Math.round(performance.now() - t0) };
}

/** An element that shows a keyboard or controller hint (a key cap, a hotkey, "KeyHint"), by its name or an ancestor's. */
export const isKeyHint = (path: string): boolean => path.split('.').slice(1).some((seg) => /^(keys?|kbd)$/i.test(seg) || /key ?(hint|cap|bind|badge|label|prompt)|hotkey|shortcut|keyboard|pc ?hint|gamepad ?hint|button ?prompt/i.test(seg));

/**
 * The same warning on three or more siblings (every hotbar slot near a TV's edge) is one finding about their parent:
 * an agent fixes the row, not nine slots. Problems stay one by one.
 */
export function collapse(findings: LabFinding[]): LabFinding[] {
  const groups = new Map<string, LabFinding[]>();
  const out: LabFinding[] = [];
  // Small phone text is one finding however many labels share the size (every slot's name in a grid): one line in
  // the report, not twenty.
  const tiny = new Map<string, LabFinding[]>();
  for (const f of findings)
    if (f.severity !== 'problem' && /^Text is [\d.]+ points on a phone/.test(f.message)) {
      const key = `${f.path.split('.')[0]}|${f.message}`;
      tiny.set(key, [...(tiny.get(key) ?? []), f]);
    }
  const merged = new Set<LabFinding>();
  for (const list of tiny.values()) {
    if (list.length < 3) continue;
    for (const f of list) merged.add(f);
    const parts = list.map((f) => f.path.split('.'));
    let common = parts[0]!;
    for (const ps of parts.slice(1)) {
      let i = 0;
      while (i < common.length && common[i] === ps[i]) i++;
      common = common.slice(0, i);
    }
    const at = common.join('.');
    const rel = (p: string) => (at ? p.slice(at.length + 1) : p);
    out.push({ ...list[0]!, path: at || list[0]!.path, message: `${list.length} texts (${list.slice(0, 3).map((f) => rel(f.path)).join(', ')}${list.length > 3 ? '…' : ''}): ${list[0]!.message}`, devices: [...new Set(list.flatMap((f) => f.devices))] });
  }
  for (const f of findings) {
    if (merged.has(f)) continue;
    if (f.severity === 'problem' || !f.path.includes('.')) {
      out.push(f);
      continue;
    }
    const parent = f.path.slice(0, f.path.lastIndexOf('.'));
    const key = `${f.category}|${f.severity}|${parent}|${f.message.replace(/\b[\w.:-]+\.[\w.:-]+\b/g, '§').replace(/\d+(\.\d+)?/g, '#')}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const list of groups.values()) {
    if (list.length < 3) {
      out.push(...list);
      continue;
    }
    const first = list[0]!;
    const parent = first.path.slice(0, first.path.lastIndexOf('.'));
    out.push({ ...first, path: parent, message: `${list.length} of its elements (${list.slice(0, 3).map((f) => f.path.slice(parent.length + 1)).join(', ')}${list.length > 3 ? '…' : ''}): ${first.message}`, devices: [...new Set(list.flatMap((f) => f.devices))] });
  }
  // A warning an ancestor already carries says nothing new about its children (the slot's count and icon).
  const shape = (f: LabFinding) => `${f.category}|${f.severity}|${f.message.replace(/^\d+ of its elements \([^)]*\): /, '').replace(/\d+(\.\d+)?/g, '#')}`;
  const carried = new Map<string, string[]>();
  for (const f of out) if (f.severity !== 'problem') carried.set(shape(f), [...(carried.get(shape(f)) ?? []), f.path]);
  return out.filter((f) => f.severity === 'problem' || !(carried.get(shape(f)) ?? []).some((p) => f.path.startsWith(`${p}.`)));
}

/** Screens grouped by the form layout they use, with the devices that show each. */
function byLayout(subject: LabSubject, devices: LabDevice[]): Array<{ screens: UiNode[]; devices: LabDevice[] }> {
  const groups = new Map<string, { screens: UiNode[]; devices: LabDevice[] }>();
  for (const d of devices) {
    const key = formDevice(d);
    const g = groups.get(key) ?? { screens: subject.screensOn(d).map(normalizeInsets), devices: [] };
    g.devices.push(d);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Gamepad focus, touch targets, and what longer words, bigger numbers and other list lengths do to the layout. */
function interactionChecks(subject: LabSubject, devices: LabDevice[]): LabFinding[] {
  const out: LabFinding[] = [];
  const take = (f: InteractFinding, category: LabCategory, severity?: LabFinding['severity']) =>
    out.push({ category, severity: severity ?? f.severity, path: f.path, message: f.message, devices: f.devices as string[], ...(f.whenShown ? { whenShown: true } : {}) });
  for (const g of byLayout(subject, devices)) {
    const pads = g.devices.filter((d) => d.input === 'gamepad' || d.id === 'desktop');
    // Roblox's directional search is the engine's own (not in any script): a jump that only the search explains is a note until measured.
    if (pads.length) for (const f of navFindings(g.screens, pads, { measure: robloxMeasure })) take(f, 'gamepad', f.kind === 'nav-odd-jump' || f.kind === 'nav-one-way' ? 'note' : undefined);
    // Targets packed close (inventory grids, settings rows) are how most games are built: a note, not a fault.
    const touch = g.devices.filter((d) => d.input === 'touch');
    // ...but targets under 0.8 mm apart (about 5 pt) read as touching: blind judges marked swatches and buy
    // buttons 2-5 pt apart on an iPhone SE down as "crowded, easy to tap the wrong one".
    const gapOf = (f: InteractFinding) => Number(/^([\d.]+) mm from/.exec(f.message)?.[1] ?? 99);
    if (touch.length) for (const f of touchFindings(g.screens, touch, { measure: robloxMeasure })) take(f, 'touch', f.kind === 'touch-gap' ? (gapOf(f) < 0.8 ? 'warning' : 'note') : undefined);
    // Longer translations matter to a game that localizes; bigger numbers and longer names to every game.
    const legacy = [...new Set(g.devices.map(formDevice))];
    for (const f of stressFindings(g.screens, legacy, robloxMeasure)) {
      const lab = (f.devices as string[]).map((id) => g.devices.find((d) => formDevice(d) === id)?.id ?? id);
      const severity = /^Translated/.test(f.variant) ? 'note' : 'warning';
      out.push({ category: 'stress', severity, path: f.path, message: f.message, devices: [...new Set(lab)], ...(f.whenShown ? { whenShown: true } : {}) });
    }
  }
  return out;
}

/**
 * The design critic on one device per form (a phone, a tablet, a computer, a TV): legibility on a bright and a dark
 * scene by the rendered pixels, spacing, alignment, type, colour, hierarchy, consistency, density. About 3 in 4 of
 * its findings are real (checked by eye), so only text a player can't read stays a problem; the rest are warnings.
 */
function designChecks(subject: LabSubject, devices: LabDevice[]): LabFinding[] {
  const out: LabFinding[] = [];
  lastScores.clear();
  const merged = new Map<string, LabFinding>();
  for (const g of byLayout(subject, devices)) {
    const legacy = [...new Set(g.devices.map(formDevice))];
    // Each real phone is judged on its own size, safe area and points per inch (the iPhone SE is where phone layouts
    // break, and the critic only ever saw the 844-point one: blind judges found what it passed); legibility by the
    // rendered pixels on the smallest phone only (the slow part); the other forms once, by their numbers.
    const phones = g.devices.filter((d) => formDevice(d) === 'phone' || formDevice(d) === 'phonePortrait');
    const smallest = [...phones].sort((a, b) => a.w * a.h - b.w * b.h)[0];
    const parts: Array<{ ids: string[] | null; c: ReturnType<typeof critiqueUi> }> = phones.map((d) => {
      const form = formDevice(d);
      const pixels = d === smallest ? (subject.images ? { images: subject.images } : {}) : { pixels: false };
      return { ids: [d.id], c: critiqueUi(g.screens, { devices: [form], screens: { [form]: d }, viewing: { [form]: { ppi: d.ppi, mm: VIEWING[form].mm } }, measure: robloxMeasure, ...pixels }) };
    });
    const rest = legacy.filter((d) => d !== 'phone' && d !== 'phonePortrait');
    if (rest.length) parts.push({ ids: null, c: critiqueUi(g.screens, { devices: rest, measure: robloxMeasure, pixels: false }) });
    for (const { ids, c } of parts)
      for (const f of c.findings) {
        const lab = ids ?? [...new Set(f.devices.flatMap((id) => g.devices.filter((d) => formDevice(d) === id).map((d) => d.id)))];
        // Text that only fails over a bright scene depends on the game's world: a warning; text that fails on its own panel is a problem.
        const sceneOnly = /on the dark backdrop but/.test(f.message);
        // Contrast read from the layout can pick the wrong colour behind a text (graded by eye: 2 of 6 real): a warning.
        // Text too small to read on the device stays a problem (graded real).
        const contrastOnly = /\d:1\b/.test(f.message);
        const severity = f.severity === 'problem' && f.check === 'legibility' && !sceneOnly && !contrastOnly ? 'problem' : f.severity === 'note' ? 'note' : 'warning';
        const message = `${f.message}${f.fix ? ` Fix: ${f.fix}` : ''}`;
        const path = f.paths[0] ?? f.view;
        // The same finding on several phones is one finding on those phones (its numbers are the first phone's).
        const key = `${path}|${message.replace(/\d+(\.\d+)?/g, '#').replace(/on an? [^:]*?(?=:)/, '')}`;
        const prev = merged.get(key);
        if (!prev) merged.set(key, { category: 'design', severity, path, message, devices: [...lab] });
        else {
          for (const id of lab) if (!prev.devices.includes(id)) prev.devices.push(id);
          if (severity === 'problem') prev.severity = 'problem';
        }
      }
    // A form's score is its worst real device's (the phone that breaks first).
    for (const id of legacy) {
      const s = parts.map((p) => overallScore(p.c, id)).filter((x): x is number => x !== null);
      if (s.length) lastScores.set(id, Math.min(...s));
    }
  }
  out.push(...merged.values());
  return out;
}
/** The design score (0-100) per form from the last check, for the report. */
const lastScores = new Map<string, number>();

/** More checks, run after the built-in ones. */
export const extraChecks: Array<(subject: LabSubject, devices: LabDevice[]) => LabFinding[]> = [interactionChecks, designChecks, phoneChecks];

export interface LabViewOptions {
  /** Roblox's own UI drawn as in play ("controls"), as tinted zones, both, or not at all. */
  roblox?: 'controls' | 'zones' | 'both' | 'none';
  backdrop?: Backdrop;
  images?: (ref: string, px: number) => RgbaImage | null;
  /** Paths outlined in red (the elements a finding is about). */
  mark?: string[];
  /** Hidden elements drawn as shown. */
  show?: string[];
  states?: Record<string, 'hover' | 'press' | 'selected' | 'disabled'>;
  focus?: string;
  scale?: number;
  caption?: boolean;
  /** Where forged skins are cached (the project's; memory only without). */
  skins?: SkinForge;
}

/**
 * The hidden screens and elements that must be shown for these paths to be seen (a marked button inside a closed
 * menu shows the menu), as paths for `show`.
 */
export function revealFor(screens: UiNode[], paths: string[]): string[] {
  const out = new Set<string>();
  const walk = (n: UiNode, path: string) => {
    if ((n.enabled === false || n.visible === false) && paths.some((p) => p === path || p.startsWith(`${path}.`))) out.add(path);
    for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`);
  };
  for (const s of screens) walk(s, s.name);
  return [...out];
}

/** One device as a player sees it: the game's UI in Roblox's fonts, Roblox's controls over it, marked elements. */
export function labView(subject: LabSubject, dev: LabDevice, o: LabViewOptions = {}): { image: RgbaImage; regions: CoreRegion[]; notes: string[] } {
  // Forged skins worn as they ship (their art drawn under each element's content).
  const worn = wearSkins(subject.screensOn(dev).map(normalizeInsets), o.images ?? (() => null), o.skins);
  const screens = worn.screens;
  o = { ...o, images: worn.images };
  if (o.mark?.length) {
    const reveal = revealFor(screens, o.mark);
    if (reveal.length) o = { ...o, show: [...new Set([...(o.show ?? []), ...reveal])] };
  }
  const marks: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (o.mark?.length) {
    const show = new Set<number>();
    const want = new Set(o.show ?? []);
    const walk = (n: UiNode, path: string) => {
      if (want.has(path)) show.add(n.id);
      for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`);
    };
    for (const s of screens) walk(s, s.name);
    for (const s of screens)
      for (const b of layoutScreen(s, dev, { measure: robloxMeasure, show }))
        if (o.mark.includes(b.path)) marks.push({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 });
  }
  const pic = renderLab(screens, dev, {
    core: coreWhileShown(subject.core, screens, o.show),
    roblox: o.roblox ?? 'controls',
    marks,
    measure: robloxMeasure,
    fonts: robloxFontPicker,
    ...(o.backdrop ? { backdrop: o.backdrop } : {}),
    ...(o.images ? { images: o.images } : {}),
    ...(o.show ? { show: o.show } : {}),
    ...(o.states ? { states: o.states } : {}),
    ...(o.focus ? { focus: o.focus } : {}),
    ...(o.scale ? { scale: o.scale } : {}),
    ...(o.caption !== false ? { caption: `${subject.title} · ${dev.label} ${dev.w}×${dev.h} pt` } : {}),
  });
  return { image: pic.image, regions: pic.regions, notes: pic.notes };
}

/** Every device small, side by side, problems outlined: the whole matrix at a glance. */
export function labSheet(subject: LabSubject, devices: LabDevice[], report: LabReport | null, o: Omit<LabViewOptions, 'mark' | 'scale' | 'caption'> & { width?: number } = {}): RgbaImage {
  const width = o.width ?? 360;
  const items = devices.map((d) => {
    const mark = report ? [...new Set(report.findings.filter((f) => f.severity === 'problem' && f.devices.includes(d.id)).map((f) => f.path))] : [];
    const v = labView(subject, d, { ...o, mark, scale: width / d.w, caption: false });
    const problems = report ? report.findings.filter((f) => f.severity === 'problem' && f.devices.includes(d.id)).length : 0;
    return { image: v.image, label: `${d.label}${problems ? ` · ${problems} problem${problems === 1 ? '' : 's'}` : ''}` };
  });
  // Rows of four.
  const rows: RgbaImage[] = [];
  for (let i = 0; i < items.length; i += 4) rows.push(sideBySide(items.slice(i, i + 4)));
  return stack(rows);
}

/** Pictures one under another (left-aligned, dark between). */
export function stack(images: RgbaImage[], gap = 8): RgbaImage {
  const w = Math.max(1, ...images.map((i) => i.width));
  const h = images.reduce((t, i) => t + i.height, 0) + gap * Math.max(0, images.length - 1);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([22, 21, 20, 255], i * 4);
  let y = 0;
  for (const img of images) {
    for (let r = 0; r < img.height; r++) data.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((y + r) * w) * 4);
    y += img.height + gap;
  }
  return { width: w, height: h, data };
}

/** The motion of a subject as a filmstrip on a device, in Roblox's fonts, with its feel report. */
export function labMotion(subject: LabSubject, dev: LabDevice, o: { only?: number[]; reduced?: boolean; images?: LabViewOptions['images']; backdrop?: Backdrop; skins?: SkinForge } = {}): { image: RgbaImage; report: string } | null {
  if (!subject.motion.length) return null;
  const worn = wearSkins(subject.screensOn(dev), o.images ?? (() => null), o.skins);
  const screens = worn.screens;
  o = { ...o, images: worn.images };
  const strip = filmstrip(screens, subject.motion, { device: dev, ...(o.only ? { only: o.only } : {}), ...(o.reduced ? { reduced: true } : {}), ...(o.images ? { images: o.images } : {}), ...(o.backdrop ? { backdrop: o.backdrop } : {}), text: { measure: robloxMeasure, fonts: robloxFontPicker } });
  const feel = feelOf(compileMotion(screens, subject.motion, { device: dev, ...(o.reduced ? { reduced: true } : {}) }));
  return { image: strip.image, report: feel.report };
}
