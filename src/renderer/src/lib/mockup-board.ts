import type { UiBox, UiDevice } from '@shared/ui-layout';
import { PREVIEWED_MOTION, type MockMotion } from '@shared/ui-mockup';

/**
 * The UI page's mockup board, as logic: how the devices share the board (canvases at each device's true
 * shape, as big as the space allows), what the preview plays for each of the Motion module's moves,
 * and the message the Put it in the game button sends.
 */

export interface BoardItem {
  key: UiDevice;
  /** Width over height. */
  aspect: number;
}

export interface BoardCell {
  key: UiDevice;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every way to break the devices, in order, into rows, each row as tall as its devices fit the width (all scaled down when they don't fit the height), rows centred. */
function rowLayouts(items: BoardItem[], width: number, height: number, gap: number, caption: number): BoardCell[][] {
  const n = items.length;
  const out: BoardCell[][] = [];
  // Each of the n - 1 gaps between devices either breaks a row or doesn't.
  for (let mask = 0; mask < 1 << Math.max(0, n - 1); mask++) {
    const rows: BoardItem[][] = [[items[0]!]];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) rows.push([items[i]!]);
      else rows[rows.length - 1]!.push(items[i]!);
    }
    const hs = rows.map((r) => (width - gap * (r.length - 1)) / r.reduce((t, it) => t + it.aspect, 0));
    const fixed = caption * rows.length + gap * (rows.length - 1);
    const k = Math.min(1, Math.max(0, (height - fixed) / hs.reduce((t, h) => t + h, 0)));
    const cells: BoardCell[] = [];
    let y = 0;
    rows.forEach((r, i) => {
      const h = hs[i]! * k;
      let x = (width - r.reduce((t, it) => t + it.aspect * h, 0) - gap * (r.length - 1)) / 2;
      for (const it of r) {
        cells.push({ key: it.key, x, y, w: it.aspect * h, h });
        x += it.aspect * h + gap;
      }
      y += h + caption + gap;
    });
    out.push(cells);
  }
  return out;
}

/**
 * Lays the devices out on the board, each at its true shape with a caption under it: rows in order, or an
 * upright device as a full-height column beside the others' rows (in a row with landscape screens it would be
 * a sliver). Of all of those, the one where the devices are most legible together (the product of each
 * canvas's shorter side), so no device ends up a thumbnail for another's sake.
 */
export function boardLayout(items: BoardItem[], width: number, height: number, gap = 14, caption = 22): { cells: BoardCell[]; height: number } {
  if (!items.length || width <= 0 || height <= 0) return { cells: [], height: 0 };
  const options = rowLayouts(items, width, height, gap, caption);
  items.forEach((tall, i) => {
    if (tall.aspect >= 1 || items.length < 3) return;
    const w = Math.min(tall.aspect * (height - caption), width * 0.45);
    const rest = items.filter((_, j) => j !== i);
    for (const cells of rowLayouts(rest, width - w - gap, height, gap, caption)) options.push([{ key: tall.key, x: 0, y: 0, w, h: w / tall.aspect }, ...cells.map((c) => ({ ...c, x: c.x + w + gap }))]);
  });
  const legibility = (cells: BoardCell[]) => cells.reduce((t, c) => t + Math.log(Math.max(1, Math.min(c.w, c.h))), 0);
  const best = options.reduce((a, b) => (legibility(b) > legibility(a) + 1e-9 ? b : a));
  const cells = items.map((it) => best.find((c) => c.key === it.key)!);
  return { cells, height: Math.max(...cells.map((c) => c.y + c.h + caption)) };
}

/** The text the Put it in the game button sends to the UI copilot (the copilot service reads it as a build request). */
export const applyMessage = (title: string, version: string): string => `Put the “${title}” mockup, version ${version}, in the game.`;

// ─── Motion preview ───────────────────────────────────────────────────────────────────────────────

export type PreviewStep =
  | { kind: 'animate'; id: number; origin: string; keyframes: Keyframe[]; options: KeyframeAnimationOptions }
  | { kind: 'count'; id: number; from: number; to: number; delay: number; duration: number }
  | { kind: 'shimmer'; id: number; delay: number; every: number; times: number }
  | { kind: 'cover'; style: 'fade' | 'wipe' | 'iris'; delay: number; half: number };

/** The Motion module's easing curves as CSS (Quint Out, Back Out, Quad In/Out, Sine In/Out). */
export const EASE = {
  quintOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
  backOut: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  quadIn: 'cubic-bezier(0.55, 0.085, 0.68, 0.53)',
  quadOut: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  quadInOut: 'cubic-bezier(0.455, 0.03, 0.515, 0.955)',
  sineInOut: 'cubic-bezier(0.445, 0.05, 0.55, 0.95)',
};

/** How long a loop is shown in the preview before it stops by itself (the game loops it until the screen closes). */
export const LOOP_PREVIEW_S = 6;

/**
 * A spring kicked off its rest, as keyframes (Motion.punch and Motion.shake): it swings out to `peak` and
 * settles, with the module's frequency and damping. `at` turns a value into the CSS transform.
 */
export function springKeyframes(peak: number, frequency: number, damping: number, at: (v: number) => string): { keyframes: Keyframe[]; duration: number } {
  const w = 2 * Math.PI * frequency;
  const wd = w * Math.sqrt(1 - damping * damping);
  // Settled when the envelope is under 1% of the peak.
  const duration = Math.min(2.5, Math.log(100) / (damping * w));
  const raw = (t: number) => Math.exp(-damping * w * t) * Math.sin(wd * t);
  // The first swing's top: scale the curve so it reaches exactly `peak`.
  const tPeak = Math.atan2(Math.sqrt(1 - damping * damping), damping) / wd;
  const scale = peak / raw(tPeak);
  const steps = 36;
  const keyframes: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration;
    keyframes.push({ offset: i / steps, transform: at(i === steps ? 0 : scale * raw(t)) });
  }
  return { keyframes, duration: duration * 1000 };
}

const DIRECTIONS = new Set(['up', 'down', 'left', 'right', 'pop', 'fade']);

/** What can't be previewed, in words, for the note under the board. */
export const NOT_PREVIEWED: Record<string, string> = {
  swap: 'page swaps',
  fly: 'reward icons flying into a counter',
  flipbook: 'sprite-sheet flipbooks',
  keyframes: 'custom keyframe tracks',
};

/**
 * What the preview plays for a version's motion on one device: CSS animations on the laid-out elements
 * (an element moves with everything inside it, scaled about its AnchorPoint as a UIScale is), counting
 * text, a shimmer sweep, a full-screen cover. Every move starts at its delay, as if its moment had come.
 * Reduce Motion as Motion does it: moves, scales, loops and springs don't run; fades still play, a
 * transition becomes a short fade, a count lands at once.
 */
export function previewPlan(motions: MockMotion[], boxes: UiBox[], opts: { reduced?: boolean } = {}): { steps: PreviewStep[]; skipped: MockMotion[] } {
  const steps: PreviewStep[] = [];
  const skipped: MockMotion[] = [];
  const byPath = new Map(boxes.map((b) => [b.path, b]));
  const within = (t: UiBox) => boxes.filter((b) => b === t || b.path.startsWith(`${t.path}.`));
  const reduced = !!opts.reduced;
  // One animation per element of the group, all about the group's anchor point.
  const group = (t: UiBox, members: UiBox[], keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    const a = t.node.anchor ?? [0, 0];
    const ax = t.x + a[0] * t.w;
    const ay = t.y + a[1] * t.h;
    for (const b of members) steps.push({ kind: 'animate', id: b.node.id, origin: `${ax - b.x}px ${ay - b.y}px`, keyframes: keyframes.map((k) => withRotation(k, b.rot)), options });
  };
  for (const m of motions) {
    if (!PREVIEWED_MOTION.has(m.play)) {
      skipped.push(m);
      continue;
    }
    const delay = Math.max(0, (m.delay ?? 0) * 1000);
    if (m.play === 'transition') {
      const style = m.style === 'wipe' || m.style === 'iris' ? m.style : 'fade';
      const half = (reduced ? Math.min(m.seconds ?? 0.3, 0.15) : (m.seconds ?? 0.3)) * 1000;
      steps.push({ kind: 'cover', style: reduced ? 'fade' : style, delay, half });
      continue;
    }
    const t = m.target ? byPath.get(m.target) : undefined;
    if (!t) {
      skipped.push(m);
      continue;
    }
    const k = t.k || 1;
    switch (m.play) {
      case 'open': {
        // Ui.window: hidden, then shown at 0.92 and grown to 1 with Back Out in 0.18 s.
        const kf: Keyframe[] = reduced
          ? [{ offset: 0, opacity: 0 }, { offset: 0.001, opacity: 1 }, { offset: 1, opacity: 1 }]
          : [{ offset: 0, opacity: 0, transform: 'scale(0.92)' }, { offset: 0.001, opacity: 1, transform: 'scale(0.92)' }, { offset: 1, opacity: 1, transform: 'scale(1)' }];
        group(t, within(t), kf, { duration: (m.seconds ?? 0.18) * 1000, delay, easing: EASE.backOut, fill: 'backwards' });
        break;
      }
      case 'close': {
        // Ui.window: shrinks to 0.92 with Quad In in 0.1 s and hides; the preview shows it again after a moment.
        const d = (m.seconds ?? 0.1) * 1000;
        const hold = 600;
        const end = d / (d + hold);
        const kf: Keyframe[] = reduced
          ? [{ offset: 0, opacity: 1 }, { offset: 0.001, opacity: 0 }, { offset: 1, opacity: 0 }]
          : [{ offset: 0, opacity: 1, transform: 'scale(1)', easing: EASE.quadIn }, { offset: end, opacity: 1, transform: 'scale(0.92)' }, { offset: Math.min(1, end + 0.001), opacity: 0, transform: 'scale(0.92)' }, { offset: 1, opacity: 0, transform: 'scale(0.92)' }];
        group(t, within(t), kf, { duration: d + hold, delay, fill: 'none' });
        break;
      }
      case 'enter': {
        // Motion.enter: a container with a layout brings its children in one after another, and children of a
        // layout always fade (the layout owns their position); a free element slides or pops.
        const laidOut = !!(t.node.list || t.node.grid || t.node.pages);
        const items = laidOut ? boxes.filter((b) => b.depth === t.depth + 1 && b.path.startsWith(`${t.path}.`)) : [t];
        const parent = byPath.get(t.path.slice(0, t.path.lastIndexOf('.')));
        const from = laidOut || parent?.node.list || parent?.node.grid ? 'fade' : DIRECTIONS.has(String(m.from)) ? String(m.from) : 'up';
        const dist = (m.amount ?? 24) * k;
        const gap = (m.gap ?? 0.035) * 1000;
        items.forEach((item, i) => {
          const at = delay + i * gap;
          const fade: Keyframe[] = [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }];
          if (reduced || from === 'fade') return group(item, within(item), fade, { duration: 240, delay: at, easing: EASE.quintOut, fill: 'backwards' });
          if (from === 'pop') return group(item, within(item), [{ offset: 0, opacity: 0, transform: 'scale(0.6)' }, { offset: 1, opacity: 1, transform: 'scale(1)' }], { duration: 400, delay: at, easing: EASE.backOut, fill: 'backwards' });
          const [dx, dy] = from === 'left' ? [-dist, 0] : from === 'right' ? [dist, 0] : from === 'down' ? [0, -dist] : [0, dist];
          group(item, within(item), [{ offset: 0, opacity: 0, transform: `translate(${dx}px, ${dy}px)` }, { offset: 1, opacity: 1, transform: 'translate(0px, 0px)' }], { duration: 240, delay: at, easing: EASE.quintOut, fill: 'backwards' });
        });
        break;
      }
      case 'pulse':
      case 'float':
      case 'spin': {
        if (reduced) break;
        const cycle = (m.seconds ?? (m.play === 'pulse' ? 1.2 : m.play === 'float' ? 2.4 : 6)) * 1000;
        const iterations = Math.max(1, Math.floor((LOOP_PREVIEW_S * 1000) / cycle));
        const kf: Keyframe[] =
          m.play === 'pulse'
            ? [{ transform: 'scale(1)' }, { transform: `scale(${1 + (m.amount ?? 0.06)})` }, { transform: 'scale(1)' }]
            : m.play === 'float'
              ? [{ transform: 'translateY(0px)' }, { transform: `translateY(${-(m.amount ?? 6) * k}px)` }, { transform: 'translateY(0px)' }]
              : [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }];
        group(t, within(t), kf, { duration: cycle, delay, iterations, easing: m.play === 'spin' ? 'linear' : EASE.sineInOut });
        break;
      }
      case 'punch':
      case 'shake': {
        if (reduced) break;
        const s = m.play === 'punch' ? springKeyframes(m.amount ?? 0.12, 4, 0.35, (v) => `scale(${1 + v})`) : springKeyframes(m.amount ?? 5, 7, 0.25, (v) => `rotate(${v}deg)`);
        group(t, within(t), s.keyframes, { duration: s.duration, delay });
        break;
      }
      case 'shimmer':
        if (!reduced) steps.push({ kind: 'shimmer', id: t.node.id, delay, every: (m.seconds ?? 3) * 1000, times: Math.max(1, Math.floor(LOOP_PREVIEW_S / ((m.seconds ?? 3) + 0.7))) });
        break;
      case 'count': {
        const from = Number(m.from ?? 0);
        const to = Number(m.to ?? 0);
        const seconds = m.seconds ?? Math.min(1.2, Math.max(0.4, 0.4 + Math.log10(Math.abs(to - from) + 1) * 0.2));
        steps.push({ kind: 'count', id: t.node.id, from: reduced ? to : from, to, delay, duration: reduced ? 0 : seconds * 1000 });
        break;
      }
    }
  }
  return { steps, skipped };
}

/** An element drawn rotated keeps its rotation under the animation's transform. */
function withRotation(k: Keyframe, rot: number): Keyframe {
  if (!rot || typeof k.transform !== 'string') return k;
  return { ...k, transform: `rotate(${rot}deg) ${k.transform}` };
}

/** Thousands separators, as Motion.commas writes them. */
export const commas = (n: number): string => Math.round(n).toLocaleString('en-US');
