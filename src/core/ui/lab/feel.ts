import { isText, type UiBox, type UiDevice, type UiFinding } from '@shared/ui-layout';
import { robloxEase, valueNumbers, type EasingDirection, type EasingStyle, type LabMotionKind, type MotionIntent, type MotionTimeline, type PropName } from './motion-sim';

/**
 * How motion feels, measured and judged: per move its timing (delay, duration, easing), its shape (overshoot,
 * swings, when it is visually still), how fast the element travels on the screen, frames it spends off the screen
 * or outside its clip, how long its text is unreadable and how long input is blocked; then rules from skill
 * roblox-ui-motion ("Rules that keep motion cheap and correct", "Designing motion") and standard UI motion practice,
 * as findings shaped like the audit's. The same rules run on moves read statically from a game's Luau
 * (motion-luau.ts): there only what the code states is judged.
 */

// ─── Curves ───────────────────────────────────────────────────────────────────────────────────────

export interface MotionCurve {
  /** Seconds on the timeline. */
  t: number[];
  /** Progress along the main component: 0 at the start, 1 at the goal; a kick (punch, shake) is excursion ÷ its peak. */
  p: number[];
  /** dp/dt (progress per second). */
  v: number[];
  /** A kick swings about its rest instead of travelling to a goal. */
  kick: boolean;
  path: string;
  prop: PropName;
  from: number;
  goal: number;
}

/** Visually still: within 2% of the travel (or of a kick's peak). */
export const STILL = 0.02;
/** A swing counts when it goes more than 5% of the travel past the goal (or the rest). */
export const SWING = 0.05;

/** The progress of a move's main property over its run (one cycle for a loop), `samples` a second. */
export function progressCurve(tl: MotionTimeline, index: number, samples?: number): MotionCurve | null {
  const span = tl.spans[index];
  if (!span?.primary) return null;
  // Springs step once a frame: sample them on frames (what the screen shows); tweens finer.
  const rate = samples ?? (/spring/.test(span.easing) ? tl.fps : 240);
  const { path, prop } = span.primary;
  const t0 = span.call;
  const t1 = span.loop ? span.start + (span.cycle ?? 1) : Math.max(span.end, t0 + 1 / tl.fps);
  const m = tl.motions[index]!;
  const n = Math.max(2, Math.min(1200, Math.ceil((t1 - t0) * rate) + 1));
  const ts = Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
  let raw: number[];
  let from: number;
  let goal: number;
  if (prop === 'Text' && m.kind === 'count') {
    const seconds = Math.max(1e-6, span.end - span.start);
    raw = ts.map((t) => robloxEase('Quad', 'Out', (t - span.start) / seconds));
    from = 0;
    goal = 1;
  } else {
    const at = (t: number) => valueNumbers(tl.valueAt(path, prop, t) ?? 0);
    // From and to as the move states them (another move may take the property over before it lands).
    const tr = span.loop ? null : tl.trackOf(index);
    const a = tr?.from ?? at(t0);
    const b = tr?.goal ?? at(t1);
    if (!a || !b || a.length !== b.length) return null;
    // The component that travels most (an offset, a scale, a colour channel).
    let c = 0;
    for (let i = 1; i < a.length; i++) if (Math.abs(b[i]! - a[i]!) > Math.abs(b[c]! - a[c]!)) c = i;
    if (span.loop || Math.abs(b[c]! - a[c]!) < 1e-9) {
      // A kick, or one cycle of a loop: the component that swings most, as a share of its biggest swing.
      const vals = ts.map((t) => at(t) ?? a);
      let best = 0;
      let bc = 0;
      let sign = 1;
      for (let i = 0; i < a.length; i++)
        for (const v of vals)
          if (Math.abs(v[i]! - a[i]!) > best) {
            best = Math.abs(v[i]! - a[i]!);
            bc = i;
            sign = Math.sign(v[i]! - a[i]!) || 1;
          }
      if (best < 1e-9) return null;
      const p = vals.map((v) => (v[bc]! - a[bc]!) / (best * (span.loop ? sign : 1)));
      return { t: ts, p, v: deriv(ts, p), kick: !span.loop, path, prop, from: a[bc]!, goal: span.loop ? a[bc]! + best * sign : a[bc]! };
    }
    raw = ts.map((t) => at(t)?.[c] ?? a[c]!);
    from = a[c]!;
    goal = b[c]!;
  }
  const p = raw.map((x) => (x - from) / (goal - from));
  return { t: ts, p, v: deriv(ts, p), kick: false, path, prop, from, goal };
}

const deriv = (t: number[], p: number[]) => p.map((_, i) => (i === 0 ? 0 : (p[i]! - p[i - 1]!) / Math.max(1e-9, t[i]! - t[i - 1]!)));

/** Overshoot past the goal and anticipation below the start, as % of the travel. */
export function overshootOf(c: MotionCurve): { over: number; under: number; peakAt: number | null } {
  if (c.kick) {
    let peakAt = c.t[0]!;
    let best = 0;
    c.p.forEach((p, i) => {
      if (Math.abs(p) > best) {
        best = Math.abs(p);
        peakAt = c.t[i]!;
      }
    });
    return { over: 0, under: 0, peakAt };
  }
  let over = 0;
  let under = 0;
  let peakAt: number | null = null;
  c.p.forEach((p, i) => {
    if (p - 1 > over) {
      over = p - 1;
      peakAt = c.t[i]!;
    }
    if (-p > under) under = -p;
  });
  return { over: over * 100, under: under * 100, peakAt };
}

/** Swings past the goal (or rest) bigger than SWING, after the first approach (a kick's first swing is the kick). */
export function swingsOf(c: MotionCurve): number {
  const ref = c.kick ? 0 : 1;
  const lobes: number[] = [];
  let sign = 0;
  let peak = 0;
  for (const p of c.p) {
    const d = p - ref;
    const s = Math.abs(d) < 1e-9 ? sign : Math.sign(d);
    if (s !== sign && sign !== 0) {
      lobes.push(peak);
      peak = 0;
    }
    sign = s;
    peak = Math.max(peak, Math.abs(d));
  }
  lobes.push(peak);
  // The first lobe is the approach from below (a move) or the kick itself.
  return lobes.slice(1).filter((x) => x > SWING).length;
}

/** When it is visually still for good (seconds on the timeline), or null if it never is in the window. */
export function stillAt(c: MotionCurve): number | null {
  const ref = c.kick ? 0 : 1;
  for (let i = c.p.length - 1; i >= 0; i--) if (Math.abs(c.p[i]! - ref) > STILL) return i + 1 < c.t.length ? c.t[i + 1]! : null;
  return c.t[0]!;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────────────────────────

export interface MotionMetrics {
  index: number;
  label: string;
  kind: LabMotionKind;
  intent: MotionIntent;
  target: string | null;
  props: PropName[];
  /** When it is called, how long before it changes anything, how long it changes for (one cycle for a loop). */
  call: number;
  delay: number;
  duration: number;
  loop: boolean;
  cycle: number | null;
  easing: string;
  /** % of the travel past the goal, and below the start (a Back In's wind-up). */
  overshootPct: number | null;
  anticipationPct: number | null;
  /** Swings past the goal or rest bigger than 5% of the travel. */
  swings: number | null;
  /** Seconds from its start until it is visually still (within 2%). */
  settle: number | null;
  /** The fastest any corner of the element moves: points per second, and screen widths per second. */
  peakSpeed: number | null;
  peakScreens: number | null;
  /** An entrance's items, the gap between them, the spread of their starts and the whole entrance. */
  stagger: { items: number; gap: number; spread: number; total: number } | null;
  /** Frames sampled, frames with the element more than 2 points past the screen's edge (or its clip) while it rests inside. */
  frames: number;
  offscreenFrames: number;
  clippedFrames: number;
  /** The longest a text inside it (readable at rest) stays below 50% opacity, after the call. */
  unreadable: { seconds: number; path: string } | null;
  /** Seconds the screen takes no input. */
  inputBlocking: number;
  /** Size animated on TextScaled text (it re-fits every frame and jitters). */
  textScaledSize: boolean;
  /** The element is hidden while it plays (a loop on a closed screen). */
  hidden: boolean;
  notes: string[];
}

const MOVE_PROPS = new Set<PropName>(['Position', 'Size', 'Scale', 'AnchorPoint']);

/** A box's corners, turned by its rotation about its centre. */
const corners = (b: UiBox): Array<[number, number]> => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const r = (b.rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [-b.w / 2, -b.h / 2],
    [b.w / 2, -b.h / 2],
    [b.w / 2, b.h / 2],
    [-b.w / 2, b.h / 2],
  ].map(([x, y]) => [cx + x! * c - y! * s, cy + x! * s + y! * c] as [number, number]);
};
const extent = (b: UiBox) => {
  const cs = corners(b);
  const xs = cs.map((p) => p[0]);
  const ys = cs.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/**
 * One move measured on its timeline: timing and shape from its main property's curve, travel and edges from the
 * layout frame by frame (at the timeline's frame rate, up to 3 s; a loop for one cycle).
 */
export function measureMotion(tl: MotionTimeline, index: number): MotionMetrics {
  const span = tl.spans[index]!;
  const m = tl.motions[index]!;
  const props = [...new Set(tl.propsOf(index).map((p) => p.prop))];
  const curve = progressCurve(tl, index);
  const shape = curve ? overshootOf(curve) : null;
  const still = curve ? stillAt(curve) : null;
  const duration = span.loop ? (span.cycle ?? 0) : Math.max(0, span.end - span.start);
  const out: MotionMetrics = {
    index,
    label: span.label,
    kind: span.kind,
    intent: span.intent,
    target: span.primary?.path ?? null,
    props,
    call: span.call,
    delay: Math.max(0, span.start - span.call),
    duration,
    loop: span.loop,
    cycle: span.cycle ?? null,
    easing: span.easing,
    overshootPct: shape && curve && !curve.kick ? shape.over : null,
    anticipationPct: shape && curve && !curve.kick ? shape.under : null,
    swings: curve && (span.kind === 'spring' || span.kind === 'punch' || span.kind === 'shake' || span.kind === 'react' || /spring/.test(span.easing)) ? swingsOf(curve) : null,
    settle: still !== null && !span.loop ? Math.max(0, still - span.start) : null,
    peakSpeed: null,
    peakScreens: null,
    stagger: span.items && span.items > 1 && span.gap !== undefined ? { items: span.items, gap: span.gap, spread: (span.items - 1) * span.gap, total: Math.max(0, span.end - span.call) } : null,
    frames: 0,
    offscreenFrames: 0,
    clippedFrames: 0,
    unreadable: null,
    inputBlocking: span.blocks ? span.blocks[1] - span.blocks[0] : 0,
    textScaledSize: false,
    hidden: false,
    notes: [...span.notes],
  };

  // Frame by frame on the device.
  const target = span.primary?.path;
  if (!target || span.kind === 'transition') return out;
  const dev = tl.device;
  const t0 = span.call;
  const t1 = Math.min(span.loop ? span.start + (span.cycle ?? 1) : span.end, t0 + 3);
  const dt = 1 / tl.fps;
  const n = Math.max(1, Math.ceil((t1 - t0) / dt)) + 1;
  const rest = tl.layoutAt(span.loop ? t0 : t1 + 0.001);
  const restBox = rest.find((b) => b.path === target);
  // Texts readable at rest that this move fades or hides (its own text fades, or a group fade or a hide above them).
  const written = tl.propsOf(index);
  const own = new Set(written.filter((w) => w.prop === 'TextTransparency').map((w) => w.path));
  const roots = written.filter((w) => w.prop === 'GroupTransparency' || w.prop === 'Visible');
  const under = (p: string) => own.has(p) || roots.some((r) => p === r.path || p.startsWith(`${r.path}.`));
  // Dark at t because of this move: its own fade, or a group fade or a hide it plays above the text.
  const darkBy = (p: string, t: number, node: UiBox['node'] | undefined): boolean => {
    if (own.has(p) && (!node || (node.textT ?? 0) > 0.5)) return true;
    return roots.some((r) => (p === r.path || p.startsWith(`${r.path}.`)) && (r.prop === 'Visible' ? tl.valueAt(r.path, 'Visible', t) === false : Number(tl.valueAt(r.path, 'GroupTransparency', t) ?? 0) > 0.5));
  };
  const readable = new Set(rest.filter((b) => under(b.path) && isText(b.node) && (b.node.text ?? '').trim() && (b.node.textT ?? 0) <= 0.5).map((b) => b.path));
  const dark = new Map<string, number>();
  let prev: Array<[number, number]> | null = null;
  let peak = 0;
  const inside = (e: ReturnType<typeof extent>, r: [number, number, number, number]) => e.x0 >= r[0] - 2 && e.y0 >= r[1] - 2 && e.x1 <= r[0] + r[2] + 2 && e.y1 <= r[1] + r[3] + 2;
  const screenRect: [number, number, number, number] = [0, 0, dev.w, dev.h];
  const restInside = restBox ? inside(extent(restBox), screenRect) : false;
  const restInClip = restBox ? !restBox.clip || inside(extent(restBox), restBox.clip) : false;
  let seenTarget = false;
  for (let i = 0; i < n; i++) {
    const t = Math.min(t1, t0 + i * dt);
    const boxes = tl.layoutAt(t);
    const b = boxes.find((x) => x.path === target);
    out.frames++;
    if (b) {
      seenTarget = true;
      const cs = corners(b);
      if (prev) for (let k = 0; k < 4; k++) peak = Math.max(peak, Math.hypot(cs[k]![0] - prev[k]![0], cs[k]![1] - prev[k]![1]) / dt);
      prev = cs;
      const e = extent(b);
      if (span.kind !== 'swap' && restInside && !inside(e, screenRect)) out.offscreenFrames++;
      if (span.kind !== 'swap' && restInClip && b.clip && !inside(e, b.clip)) out.clippedFrames++;
    } else prev = null;
    if (i > 0 && readable.size) {
      const shown = new Map(boxes.filter((x) => readable.has(x.path)).map((x) => [x.path, x]));
      for (const p of readable) {
        const x = shown.get(p);
        if (darkBy(p, t, x?.node)) dark.set(p, (dark.get(p) ?? 0) + dt);
      }
    }
  }
  if (!seenTarget && !span.loop) out.notes.push('its element is not on the screen while it plays');
  out.hidden = !seenTarget;
  if (peak > 0) {
    out.peakSpeed = peak;
    out.peakScreens = peak / dev.w;
  }
  let worst: { seconds: number; path: string } | null = null;
  for (const [p, s] of dark) if (!worst || s > worst.seconds) worst = { seconds: s, path: p };
  if (worst && worst.seconds > 1e-6) out.unreadable = worst;
  // Size animated where TextScaled text re-fits.
  if (props.includes('Size')) {
    const sized = new Set(tl.propsOf(index).filter((p) => p.prop === 'Size').map((p) => p.path));
    out.textScaledSize = rest.some((b) => [...sized].some((s) => b.path === s || b.path.startsWith(`${s}.`)) && isText(b.node) && !!b.node.scaled);
  }
  return out;
}

export const measureTimeline = (tl: MotionTimeline): MotionMetrics[] => tl.spans.map((s) => measureMotion(tl, s.index));

// ─── Facts and rules ──────────────────────────────────────────────────────────────────────────────

/** What the rules judge: a move from a timeline, or one read from a game's code (then only what the code states). */
export interface MotionFacts {
  /** An element path, or "file:line". */
  where: string;
  label: string;
  kind: LabMotionKind | 'raw';
  intent: MotionIntent;
  /** The intent came from the move itself, a name or a clear goal (rules about intent only judge sure ones). */
  intentSure: boolean;
  props: string[];
  duration: number | null;
  delay: number;
  style?: EasingStyle;
  direction?: EasingDirection;
  spring?: { frequency: number; damping: number };
  loop: boolean;
  cycle?: number | null;
  overshootPct?: number | null;
  swings?: number | null;
  settle?: number | null;
  stagger?: { gap: number; items?: number; spread?: number; total?: number } | null;
  /** An entrance's slide, in points. */
  distance?: number;
  /** A pulse's scale gain, a float's points. */
  amount?: number;
  peakSpeed?: number | null;
  offscreenFrames?: number;
  clippedFrames?: number;
  unreadable?: { seconds: number; path: string } | null;
  inputBlocking?: number;
  /** A raw TweenService tween (Motion.tween follows Reduce Motion; this doesn't). */
  raw?: boolean;
  /** The code checks Reduce Motion (Motion.reduced, ReducedMotionEnabled…). */
  reducedChecked?: boolean;
  /** A loop that something stops (a Motion scope, a Cancel); false: nothing does. */
  stopped?: boolean | null;
  hidden?: boolean;
  /** A progress bar, a timer, a cooldown: Linear and Reduce Motion don't apply. */
  progress?: boolean;
  /** A showpiece (loading, title, reward reveal, cutscene): longer moments are the point. */
  hero?: boolean;
  /** An effect (a flash, a floating number, a particle, a stamp): screen timing rules don't fit it. */
  effect?: boolean;
  /** The open that this close undoes (same element or token pair): its duration. */
  openDuration?: number | null;
  textScaledSize?: boolean;
  devices?: UiDevice[];
  file?: string;
  line?: number;
}

export interface FeelFinding extends UiFinding {
  rule: string;
  /** Where the rule comes from. */
  source: string;
  file?: string;
  line?: number;
}

export interface FeelRule {
  id: string;
  title: string;
  source: string;
  check: (f: MotionFacts) => Omit<FeelFinding, 'rule' | 'source' | 'devices' | 'path'> | null;
}

const SKILL = 'skill roblox-ui-motion';
const PRACTICE = 'UI motion practice';
const moves = (f: MotionFacts) => f.props.some((p) => MOVE_PROPS.has(p as PropName));
const ms = (s: number) => `${Math.round(s * 1000)} ms`;
/** Timing rules for screens leave showpieces and effects alone. */
const special = (f: MotionFacts) => !!(f.hero || f.effect || f.loop);
/** Alerts pulse fast on purpose (a timer running out, low health). */
const ALERT = /time|timer|clock|countdown|warn|low|alert|urgent|danger|near|hunger|health|heart|hp|ammo|reload/i;
const bouncy = (f: MotionFacts) => (f.style === 'Back' || f.style === 'Elastic' || f.style === 'Bounce') && f.direction !== 'In';

/**
 * The rules. Each one fires only on what it can see for sure; thresholds sit at the edge of the skill's ranges and
 * standard practice so that a finding means something (a check that cries wolf is worse than none).
 */
export const FEEL_RULES: FeelRule[] = [
  {
    id: 'linear-move',
    title: 'Linear on a move or scale',
    source: `${SKILL}, Designing motion 5 ("Linear: rotation and progress only")`,
    check: (f) =>
      f.style === 'Linear' && !f.loop && moves(f) && !f.progress
        ? { severity: f.duration !== null && f.duration >= 1 && (f.intent === 'open' || f.intent === 'enter') ? 'problem' : 'warning', message: `Linear easing on ${f.props.filter((p) => MOVE_PROPS.has(p as PropName)).join('/')}: it starts and stops dead. Use Quint/Quad Out arriving, Quad In leaving (or Back Out for a playful arrival).` }
        : null,
  },
  {
    id: 'open-slow',
    title: 'Slow open or entrance',
    source: `${SKILL}, Designing motion 3 (opens 0.18-0.25 s); ${PRACTICE} (open 200-350 ms)`,
    check: (f) => {
      if (special(f) || f.duration === null || !f.intentSure) return null;
      if (f.intent === 'open' && f.duration > 0.4) return { severity: f.duration >= 0.8 ? 'problem' : 'warning', message: `Opens in ${ms(f.duration)}: windows open in 0.18-0.35 s; past 0.4 s the player waits for the UI.` };
      if (f.intent === 'enter' && f.duration > 0.6 && !f.stagger) return { severity: f.duration >= 1 ? 'problem' : 'warning', message: `Arrives in ${ms(f.duration)}: entrances land in 0.24-0.4 s (a pop 0.4 s).` };
      return null;
    },
  },
  {
    id: 'close-slow',
    title: 'Slow close or exit',
    source: `${SKILL}, Designing motion 3 ("Enter slow, leave fast": closes 0.1-0.15 s); ${PRACTICE} (close ~60-80% of the open)`,
    check: (f) => {
      // A close the player asked for (named so), or a named exit that moves: fade-outs of toasts and labels may linger.
      if (special(f) || f.duration === null || !f.intentSure) return null;
      if (f.intent !== 'close' && !(f.intent === 'exit' && moves(f))) return null;
      if (f.openDuration && f.duration > f.openDuration * 1.05) return { severity: 'warning', message: `Leaves in ${ms(f.duration)}, longer than it arrives (${ms(f.openDuration)}): leave fast, about 60-80% of the open.` };
      const limit = f.intent === 'close' ? 0.3 : 0.4;
      if (f.duration > limit) return { severity: f.duration >= 2 * limit ? 'problem' : 'warning', message: `Leaves in ${ms(f.duration)}: closes take 0.1-0.15 s (at most ~${limit} s).` };
      return null;
    },
  },
  {
    id: 'exit-bounce',
    title: 'An exit that bounces',
    source: `${SKILL}, Designing motion 3 ("Exits never bounce")`,
    check: (f) => (!special(f) && f.intentSure && (f.intent === 'close' || f.intent === 'exit') && bouncy(f) && moves(f) ? { severity: 'warning', message: `Leaves with ${f.style} ${f.direction}: it overshoots at the end of an exit. Use Quad In.` } : null),
  },
  {
    id: 'entrance-ease-in',
    title: 'An entrance that eases in',
    source: `${SKILL}, Designing motion 5 (Quint/Quad Out arriving); ${PRACTICE} (ease-out for entrances)`,
    check: (f) =>
      !special(f) && f.intentSure && (f.intent === 'open' || f.intent === 'enter') && f.direction === 'In' && f.style && f.style !== 'Linear' && moves(f)
        ? { severity: 'warning', message: `Arrives with ${f.style} In: it speeds up into its resting place and stops dead. Arrivals ease out (Quint Out, Back Out).` }
        : null,
  },
  {
    id: 'exit-ease-out',
    title: 'An exit that eases out',
    source: `${SKILL}, Designing motion 5 ("Quad In: leaving"); ${PRACTICE} (ease-in for exits)`,
    check: (f) =>
      !special(f) && f.intentSure && (f.intent === 'close' || f.intent === 'exit') && f.direction === 'Out' && f.style && f.style !== 'Linear' && !bouncy(f) && moves(f)
        ? { severity: 'warning', message: `Leaves with ${f.style} Out: it slows down as it goes, so it lingers. Exits ease in (Quad In).` }
        : null,
  },
  {
    id: 'overshoot',
    title: 'Too much overshoot',
    source: `${PRACTICE} (overshoot ≤ ~15% for panels); ${SKILL}, Designing motion 5 (Back Out for playful arrivals)`,
    check: (f) => {
      const over = f.overshootPct ?? (f.style === 'Elastic' && f.direction !== 'In' ? 37.3 : null);
      if (over === null || over <= 15 || special(f) || ['feedback', 'press', 'release', 'hover', 'loop'].includes(f.intent)) return null;
      const panel = f.intent === 'open' || f.intent === 'page' || /window|panel|menu|dialog|modal|sheet|drawer/i.test(f.label);
      return panel || f.style === 'Elastic' ? { severity: 'warning', message: `Overshoots its goal by ${Math.round(over)}%: panels stay under ~15% (Back Out is 10%).` } : null;
    },
  },
  {
    id: 'wobble',
    title: 'A spring that wobbles',
    source: `${PRACTICE} (springs not under-damped to wobble more than twice); ${SKILL} (damping 0.4-0.6 bounces)`,
    check: (f) => (f.kind !== 'shake' && f.swings !== undefined && f.swings !== null && f.swings > 2 ? { severity: 'warning', message: `Swings past its goal ${f.swings} times${f.spring ? ` (spring ${f.spring.frequency} Hz, damping ${f.spring.damping})` : ''}: raise the damping (0.45-0.6 bounces once or twice).` } : null),
  },
  {
    id: 'press-feedback',
    title: 'Press feedback late or slow',
    source: `${PRACTICE} (press feedback starts within a frame and lasts ~80-150 ms); roblox-ui-design (press: a spring to 0.95)`,
    check: (f) => {
      if (f.intent !== 'press' || !f.intentSure) return null;
      if (f.delay > 1 / 60 + 1e-3) return { severity: f.delay >= 0.1 ? 'problem' : 'warning', message: `The press shows after ${ms(f.delay)}: press feedback starts within one frame.` };
      const d = f.settle ?? f.duration;
      if (d !== null && d !== undefined && d > 0.2) return { severity: 'warning', message: `The press takes ${ms(d)} to land: press feedback lasts ~80-150 ms.` };
      return null;
    },
  },
  {
    id: 'hover-slow',
    title: 'Slow hover',
    source: `${SKILL} (Motion.T.hover 0.1 s); roblox-ui-design (hovers 0.08-0.12 s); ${PRACTICE} (hover 100-200 ms)`,
    check: (f) => (f.intent === 'hover' && f.intentSure && f.duration !== null && f.duration > 0.25 ? { severity: 'warning', message: `Hover takes ${ms(f.duration)}: hovers answer in 0.1-0.2 s.` } : null),
  },
  {
    id: 'stagger',
    title: 'Stagger too slow',
    source: `${SKILL}, Designing motion 4 (25-40 ms between items, the list under 0.4 s); ${PRACTICE} (30-80 ms per item, the entrance ≤ ~600 ms)`,
    check: (f) => {
      if (!f.stagger || f.hero) return null;
      if (f.stagger.gap > 0.08) return { severity: 'warning', message: `${ms(f.stagger.gap)} between items: stagger 25-80 ms apart.` };
      if (f.stagger.total !== undefined && f.stagger.total > 0.6 && (f.stagger.items ?? 0) > 1) return { severity: 'warning', message: `The whole entrance takes ${ms(f.stagger.total)} (${f.stagger.items} items): keep it under ~0.6 s (past 12 items, stagger the first 12 and show the rest at once).` };
      return null;
    },
  },
  {
    id: 'slide-far',
    title: 'A slide that travels far',
    source: `${SKILL}, Designing motion 7 (slides travel 16-40 px unless they change context)`,
    check: (f) => (f.kind === 'enter' && !f.hero && f.distance !== undefined && f.distance > 48 ? { severity: 'warning', message: `Slides ${Math.round(f.distance)} points in: entrances travel 16-40 (a page swap or a drawer may go further).` } : null),
  },
  {
    id: 'loop-unstopped',
    title: 'A loop nothing stops',
    source: `${SKILL}, Rules ("Scopes end what they start"; loops only on what is shown)`,
    check: (f) => {
      if (!f.loop) return null;
      if (f.hidden) return { severity: 'warning', message: 'Loops while its element is hidden: start loops when the screen shows, in a scope tied to it.' };
      if (f.stopped === false) return { severity: 'warning', message: 'A forever-looping tween that is played and not kept: nothing can stop it but destroying its element, so it runs on while its screen is hidden. Play it in a Motion scope tied to the screen (scope:loop, pulse, float).' };
      return null;
    },
  },
  {
    id: 'loop-busy',
    title: 'An ambient loop too fast or too big',
    source: `${SKILL}, Designing motion 8 (ambient loops are slow, 1.2-6 s cycles, and small: scale 1.04-1.06, 4-8 px)`,
    check: (f) => {
      // Ambient loops only: alerts (a timer, low health) pulse fast on purpose. Read from code, only the extremes.
      if (!f.loop || f.hero || f.effect || f.progress || ALERT.test(f.label)) return null;
      const code = !!f.file;
      const [minCycle, maxPulse, maxFloat] = code ? [0.4, 0.25, 20] : [0.8, 0.1, 12];
      if ((f.kind === 'pulse' || f.kind === 'float') && f.cycle && f.cycle < minCycle) return { severity: 'warning', message: `A ${f.kind} cycling every ${ms(f.cycle)}: ambient loops breathe slowly (1.2-6 s).` };
      if (f.kind === 'pulse' && f.amount !== undefined && f.amount > maxPulse) return { severity: 'warning', message: `Pulses by ${Math.round(f.amount * 100)}%: ambient pulses stay at 4-6%.` };
      if (f.kind === 'float' && f.amount !== undefined && f.amount > maxFloat) return { severity: 'warning', message: `Floats ${Math.round(f.amount)} points: ambient floats stay at 4-8.` };
      return null;
    },
  },
  {
    id: 'reduce-motion',
    title: 'No Reduce Motion path',
    source: `${SKILL}, Rules (Reduce Motion: moves, scales and loops land at once; Motion does it for every call)`,
    check: (f) => (f.raw && !f.reducedChecked && !f.progress && f.props.some((p) => p === 'Position' || p === 'Size' || p === 'Scale' || p === 'Rotation') ? { severity: 'warning', message: `Moves UI with a raw TweenService tween and the file never checks Reduce Motion: play it through Motion.tween (or Ui.play) so it lands at once for players who turned motion off.` } : null),
  },
  {
    id: 'input-block',
    title: 'Input blocked too long',
    source: `${SKILL}, Rules ("Nothing blocks input for long": a transition's cover takes clicks for its 0.6 s)`,
    check: (f) => (f.inputBlocking !== undefined && f.inputBlocking > 0.8 ? { severity: 'warning', message: `Takes no input for ${ms(f.inputBlocking)}: keep covers under ~0.6 s, or make long reveals skippable after 0.3 s.` } : null),
  },
  {
    id: 'offscreen',
    title: 'Leaves the screen while it moves',
    source: `${PRACTICE} (motion stays where the player can see it); ui_audit (off the screen)`,
    check: (f) => {
      if (f.offscreenFrames) return { severity: 'warning', message: `Goes past the screen's edge for ${f.offscreenFrames} frame${f.offscreenFrames === 1 ? '' : 's'} while it moves (it rests inside): give it room, or move it the other way.` };
      if (f.clippedFrames) return { severity: 'warning', message: `Is cut by its clipping parent for ${f.clippedFrames} frame${f.clippedFrames === 1 ? '' : 's'} while it moves: scale or slide inside the clip, or animate a child.` };
      return null;
    },
  },
  {
    id: 'unreadable',
    title: 'Text unreadable too long',
    source: `${SKILL}, Designing motion 2 (content by ~0.1-0.3 s, the call to action at ~0.3 s)`,
    check: (f) => (f.unreadable && f.unreadable.seconds > 0.5 && !f.hero ? { severity: 'warning', message: `${f.unreadable.path} stays below 50% opacity for ${ms(f.unreadable.seconds)}: the player can't read it until then.` } : null),
  },
  {
    id: 'textscaled-size',
    title: 'Size animated on TextScaled text',
    source: `${SKILL}, Rules ("Never Size of TextScaled text: it re-fits every frame and jitters")`,
    check: (f) => (f.textScaledSize ? { severity: 'warning', message: 'Animates Size where TextScaled text re-fits every frame (it jitters): animate a UIScale instead.' } : null),
  },
  {
    id: 'count-long',
    title: 'A count-up that drags',
    source: `${SKILL} (Motion.count: 0.4-1.2 s)`,
    check: (f) => (f.kind === 'count' && f.duration !== null && f.duration > 1.5 ? { severity: 'warning', message: `Counts for ${ms(f.duration)}: count-ups take 0.4-1.2 s.` } : null),
  },
];

/** The rules over moves, findings in the audit's shape (problems first). */
export function checkFeel(facts: MotionFacts[]): FeelFinding[] {
  const out: FeelFinding[] = [];
  for (const f of facts)
    for (const r of FEEL_RULES) {
      const hit = r.check(f);
      if (hit) out.push({ ...hit, rule: r.id, source: r.source, devices: f.devices ?? [], path: f.where, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}) });
    }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1));
}

const styleOf = (easing: string): { style?: EasingStyle; direction?: EasingDirection } => {
  const m = /^(Linear|Sine|Back|Quad|Quart|Quint|Bounce|Elastic|Exponential|Circular|Cubic) (In|Out|InOut)$/.exec(easing);
  return m ? { style: m[1] as EasingStyle, direction: m[2] as EasingDirection } : {};
};

/** Facts of a timeline's moves (closes learn their opens' durations by element). */
export function factsOf(tl: MotionTimeline, metrics: MotionMetrics[] = measureTimeline(tl), device?: UiDevice): MotionFacts[] {
  const openOf = new Map<string, number>();
  for (const m of metrics) if (m.intent === 'open' && m.target) openOf.set(m.target, m.duration);
  return metrics.map((m) => {
    const mo = tl.motions[m.index]!;
    const sp = /^spring ([\d.]+) Hz ζ ([\d.]+)$/.exec(m.easing);
    return {
      where: m.target ?? m.label,
      label: m.label,
      kind: m.kind,
      intent: m.intent,
      intentSure: m.kind !== 'tween' && m.kind !== 'curve' ? true : !!mo.intent,
      props: m.props,
      duration: m.duration,
      delay: m.delay,
      ...styleOf(m.easing),
      ...(sp ? { spring: { frequency: Number(sp[1]), damping: Number(sp[2]) } } : {}),
      loop: m.loop,
      cycle: m.cycle,
      overshootPct: m.overshootPct,
      swings: m.swings,
      settle: m.settle,
      stagger: m.stagger,
      ...(mo.kind === 'enter' && mo.from !== 'fade' && mo.from !== 'pop' ? { distance: mo.distance ?? 24 } : {}),
      ...(mo.kind === 'pulse' ? { amount: mo.amount ?? 0.06 } : mo.kind === 'float' ? { amount: mo.pixels ?? 6 } : {}),
      peakSpeed: m.peakSpeed,
      offscreenFrames: m.offscreenFrames,
      clippedFrames: m.clippedFrames,
      unreadable: m.unreadable,
      inputBlocking: m.inputBlocking,
      raw: mo.kind === 'tween' && !!mo.raw,
      hidden: m.loop && m.hidden,
      progress: m.intent === 'progress',
      hero: m.intent === 'hero',
      openDuration: m.intent === 'close' && m.target ? (openOf.get(m.target) ?? null) : null,
      textScaledSize: m.textScaledSize,
      ...(device ? { devices: [device] } : {}),
    };
  });
}

/** Measures a timeline and runs the rules: metrics, findings, and a short report an agent can act on. */
export function feelOf(tl: MotionTimeline, device?: UiDevice): { metrics: MotionMetrics[]; findings: FeelFinding[]; report: string } {
  const metrics = measureTimeline(tl);
  const findings = checkFeel(factsOf(tl, metrics, device));
  return { metrics, findings, report: feelReport(tl, metrics, findings) };
}

const pct = (v: number | null) => (v === null ? '' : `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10}%`);

/** A few lines per move and the findings: what an agent reads before deciding what to change. */
export function feelReport(tl: MotionTimeline, metrics: MotionMetrics[], findings: FeelFinding[]): string {
  const lines: string[] = [];
  const finite = metrics.filter((m) => !m.loop);
  const end = Math.max(0, ...finite.map((m) => m.call + m.delay + m.duration));
  lines.push(`Motion on ${tl.device.label ?? `${tl.device.w}×${tl.device.h}`}${tl.reduced ? ' with Reduce Motion' : ''}: ${metrics.length} move${metrics.length === 1 ? '' : 's'}, settled by ${ms(end)}${metrics.some((m) => m.loop) ? ' (plus loops)' : ''}.`);
  for (const m of metrics) {
    const bits = [`${m.easing || m.kind}`, m.loop ? `cycle ${ms(m.cycle ?? 0)}` : ms(m.duration)];
    if (m.delay > 0) bits.push(`after ${ms(m.delay)}`);
    if (m.overshootPct !== null && m.overshootPct > 0.5) bits.push(`overshoot ${pct(m.overshootPct)}`);
    if (m.anticipationPct !== null && m.anticipationPct > 0.5) bits.push(`wind-up ${pct(-m.anticipationPct)}`);
    if (m.swings !== null) bits.push(`${m.swings} swing${m.swings === 1 ? '' : 's'}`);
    if (m.settle !== null && Math.abs(m.settle - m.duration) > 0.02) bits.push(`still at ${ms(m.settle)}`);
    if (m.peakSpeed !== null) bits.push(`peak ${Math.round(m.peakSpeed)} pt/s (${(m.peakScreens ?? 0).toFixed(1)} screens/s)`);
    if (m.stagger) bits.push(`${m.stagger.items} items ${ms(m.stagger.gap)} apart, all in by ${ms(m.stagger.total)}`);
    if (m.unreadable && m.unreadable.seconds > 0.05) bits.push(`text unreadable ${ms(m.unreadable.seconds)}`);
    if (m.inputBlocking) bits.push(`blocks input ${ms(m.inputBlocking)}`);
    lines.push(`- ${m.label} at ${ms(m.call)}: ${bits.join(', ')}.${m.notes.length ? ` (${m.notes.join('; ')})` : ''}`);
  }
  for (const s of tl.skipped) lines.push(`- not played: ${'play' in s.motion ? s.motion.play : s.motion.kind}: ${s.reason}`);
  if (!findings.length) lines.push('No feel findings.');
  else {
    lines.push(`Findings (${findings.length}):`);
    for (const f of findings) lines.push(`- ${f.severity === 'problem' ? 'PROBLEM' : 'warning'} ${f.path}: ${f.message} [${f.rule}]`);
  }
  return lines.join('\n');
}
