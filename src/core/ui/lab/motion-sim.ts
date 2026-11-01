import { layoutScreen, UI_DEVICES, type RGB, type UDim2, type UiBox, type UiDevice, type UiNode, type UiScreen, type UiStateName, type UiStatePatch } from '@shared/ui-layout';
import type { MockMotion } from '@shared/ui-mockup';

/**
 * Motion as data, played offline: Roblox's TweenService easing (every EasingStyle and EasingDirection) and the
 * Motion module of skill roblox-ui-motion ported line for line (bezier solver, spring integrator, punch and shake,
 * count and its number formats, enter's stagger, swap, fly, transition, keyframes, curve, path, the scope loops,
 * Reduce Motion), plus the Ui kit's window open/close and Ui.react states. A list of moves (the mockup's MockMotion,
 * or a richer LabMotion that can also describe a game's own animations) compiles into a timeline of property
 * writers; `sample(t)` returns copies of the screens with every animated property applied at that moment, ready
 * for the layout engine and the software renderer. Deterministic: flights use a seeded random.
 *
 * What is not certain offline (measure in Studio before relying on it): Back InOut and Elastic InOut (built here as
 * In and Out joined at the middle; Penner's own InOut uses other constants), whether DelayTime repeats before every
 * RepeatCount repetition (assumed yes), that a reversing tween plays its easing backwards in time, that tweens read
 * their start value when the delay ends, that Color3 tweens interpolate R, G and B linearly, and that UDim offsets
 * (integers in Roblox) are not rounded here.
 */

// ─── Easing (TweenService) ────────────────────────────────────────────────────────────────────────

export type EasingStyle = 'Linear' | 'Sine' | 'Back' | 'Quad' | 'Quart' | 'Quint' | 'Bounce' | 'Elastic' | 'Exponential' | 'Circular' | 'Cubic';
export type EasingDirection = 'In' | 'Out' | 'InOut';
export const EASING_STYLES: readonly EasingStyle[] = ['Linear', 'Sine', 'Back', 'Quad', 'Quart', 'Quint', 'Bounce', 'Elastic', 'Exponential', 'Circular', 'Cubic'];
export const EASING_DIRECTIONS: readonly EasingDirection[] = ['In', 'Out', 'InOut'];

/** Back's overshoot constant (Penner's s): Back Out reaches 10.0% past its goal. */
export const BACK_S = 1.70158;
/** Elastic: period 0.3 of the tween, the wave shifted by a quarter period (2^(10t-10)·sin((10t-10.75)·2π/3)). */
export const ELASTIC_PERIOD = 0.3;
/** Bounce: Penner's four parabolas. */
export const BOUNCE_N = 7.5625;
export const BOUNCE_D = 2.75;

function bounceOut(x: number): number {
  if (x < 1 / BOUNCE_D) return BOUNCE_N * x * x;
  if (x < 2 / BOUNCE_D) return BOUNCE_N * (x -= 1.5 / BOUNCE_D) * x + 0.75;
  if (x < 2.5 / BOUNCE_D) return BOUNCE_N * (x -= 2.25 / BOUNCE_D) * x + 0.9375;
  return BOUNCE_N * (x -= 2.625 / BOUNCE_D) * x + 0.984375;
}

/** The In curve of a style (starts slow). */
export function easeIn(style: EasingStyle, t: number): number {
  switch (style) {
    case 'Linear':
      return t;
    case 'Sine':
      return 1 - Math.cos((t * Math.PI) / 2);
    case 'Back':
      return t * t * ((BACK_S + 1) * t - BACK_S);
    case 'Quad':
      return t * t;
    case 'Cubic':
      return t * t * t;
    case 'Quart':
      return t * t * t * t;
    case 'Quint':
      return t * t * t * t * t;
    case 'Bounce':
      return 1 - bounceOut(1 - t);
    case 'Elastic':
      if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
      return -Math.pow(2, 10 * t - 10) * Math.sin((t - 1 - ELASTIC_PERIOD / 4) * ((2 * Math.PI) / ELASTIC_PERIOD));
    case 'Exponential':
      return t <= 0 ? 0 : Math.pow(2, 10 * t - 10);
    case 'Circular':
      return 1 - Math.sqrt(Math.max(0, 1 - t * t));
  }
}

/**
 * TweenService's eased progress (0..1, past it for Back and Elastic) at linear progress `x`: In starts slow, Out ends
 * slow (1 − In(1 − x)), InOut is In for the first half and Out for the second (measured in Studio for Cubic, Elastic
 * and Bounce poses, which match TweenService: docs/ARCHITECTURE.md §11).
 */
export function robloxEase(style: EasingStyle, direction: EasingDirection, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  if (direction === 'In') return easeIn(style, t);
  if (direction === 'Out') return 1 - easeIn(style, 1 - t);
  return t < 0.5 ? easeIn(style, 2 * t) / 2 : 1 - easeIn(style, 2 - 2 * t) / 2;
}

/** A TweenInfo, as Roblox defaults it: TweenInfo.new(1, Quad, Out, 0, false, 0). RepeatCount −1 loops forever. */
export interface TweenSpec {
  time: number;
  style?: EasingStyle;
  direction?: EasingDirection;
  repeat?: number;
  reverses?: boolean;
  delay?: number;
}
export type TweenInfo = Required<TweenSpec>;
export const tweenInfo = (time = 1, style: EasingStyle = 'Quad', direction: EasingDirection = 'Out', repeat = 0, reverses = false, delay = 0): TweenInfo => ({ time, style, direction, repeat, reverses, delay });
const full = (s: TweenSpec): TweenInfo => tweenInfo(s.time, s.style, s.direction, s.repeat, s.reverses, s.delay);

/** Motion.T: the module's timing tokens. */
export const MOTION_T = {
  hover: tweenInfo(0.1, 'Quad', 'Out'),
  press: tweenInfo(0.07, 'Quad', 'Out'),
  open: tweenInfo(0.2, 'Back', 'Out'),
  close: tweenInfo(0.12, 'Quad', 'In'),
  slideIn: tweenInfo(0.25, 'Quint', 'Out'),
  slideOut: tweenInfo(0.18, 'Quad', 'In'),
  page: tweenInfo(0.2, 'Quint', 'Out'),
  enter: tweenInfo(0.24, 'Quint', 'Out'),
  pop: tweenInfo(0.4, 'Back', 'Out'),
  fade: tweenInfo(0.3, 'Quad', 'InOut'),
  bob: tweenInfo(1.2, 'Sine', 'InOut'),
} as const;

/** The Ui kit's own tweens (skill roblox-ui-design): hover/state changes, Ui.window open and close. */
export const KIT_T = { quick: tweenInfo(0.1, 'Quad', 'Out'), open: tweenInfo(0.18, 'Back', 'Out'), close: tweenInfo(0.1, 'Quad', 'In') } as const;
/** Ui.window grows its UIScale from this to 1 on open (and shrinks to it on close). */
export const WINDOW_FROM = 0.92;

/** Whether DelayTime waits before every repetition of a repeating tween, not only the first (unconfirmed: measure in Studio). */
export const DELAY_EACH_REPEAT = true;

/**
 * A tween's eased progress `elapsed` seconds after Play(): null while its first DelayTime runs (it hasn't written
 * yet), then the eased value; repetitions and Reverses as TweenInfo plays them (a reverse leg runs the easing
 * backwards in time); after the last repetition it holds at 1 (0 when it reverses).
 */
export function tweenAlpha(info: TweenSpec, elapsed: number): number | null {
  const i = full(info);
  if (elapsed < i.delay) return null;
  const loc = elapsed - i.delay;
  if (i.time <= 0) return i.reverses ? 0 : 1;
  const period = i.time * (i.reverses ? 2 : 1);
  const reps = i.repeat < 0 ? Infinity : i.repeat + 1;
  const stride = period + (DELAY_EACH_REPEAT ? i.delay : 0);
  const r = Math.floor(loc / stride);
  if (r >= reps) return i.reverses ? 0 : 1;
  const within = loc - r * stride;
  if (within >= period) return i.reverses ? 0 : 1;
  if (within < i.time) return robloxEase(i.style, i.direction, within / i.time);
  return robloxEase(i.style, i.direction, 1 - (within - i.time) / i.time);
}

/** When a tween stops changing (seconds after Play()); Infinity when it repeats forever. */
export function tweenLength(info: TweenSpec): number {
  const i = full(info);
  if (i.repeat < 0) return Infinity;
  const reps = i.repeat + 1;
  const period = i.time * (i.reverses ? 2 : 1);
  return i.delay + reps * period + (DELAY_EACH_REPEAT ? (reps - 1) * i.delay : 0);
}

// ─── The Motion module's math (1:1 with skill roblox-ui-motion) ───────────────────────────────────

/** Motion.bezier: a CSS cubic-bezier easing (Newton's method, 8 steps, t clamped to 0..1). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (t: number, a: number, b: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  const slope = (t: number, a: number, b: number) => {
    const u = 1 - t;
    return 3 * a * u * u + 6 * (b - a) * u * t + 3 * (1 - b) * t * t;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - (at(t, x1, x2) - x) / d));
    }
    return at(t, y1, y2);
  };
}

/** Springs step in substeps of 1/120 s (semi-implicit Euler), at most 0.1 s per frame. */
export const SPRING_SUBSTEP = 1 / 120;
/** A spring has settled when every part is within 1e-3 of its goal and moves slower than 1e-2 per second. */
export const SPRING_REST = { x: 1e-3, v: 1e-2 } as const;

export interface SpringState {
  x: number[];
  v: number[];
  goal: number[];
  /** 2π × frequency (Hz). */
  w: number;
  /** Damping ratio: 1 settles without overshoot, under 1 bounces. */
  z: number;
}

/** Motion's `advance`: one frame of `dt` seconds; false once it has settled (then it sits exactly on its goal). */
export function springAdvance(s: SpringState, dt: number): boolean {
  dt = Math.min(dt, 0.1);
  const n = Math.max(1, Math.ceil(dt / SPRING_SUBSTEP));
  const h = dt / n;
  let moving = false;
  s.goal.forEach((goal, i) => {
    let x = s.x[i]!;
    let v = s.v[i]!;
    for (let k = 0; k < n; k++) {
      v += (-s.w * s.w * (x - goal) - 2 * s.z * s.w * v) * h;
      x += v * h;
    }
    if (Math.abs(x - goal) > SPRING_REST.x || Math.abs(v) > SPRING_REST.v) moving = true;
    s.x[i] = x;
    s.v[i] = v;
  });
  if (!moving)
    s.goal.forEach((goal, i) => {
      s.x[i] = goal;
      s.v[i] = 0;
    });
  return moving;
}

/** Motion's `speedFor`: the starting speed that makes a spring at rest swing out to `peak` before it settles. */
export function speedFor(peak: number, frequency: number, damping: number): number {
  const root = Math.sqrt(1 - damping * damping);
  return peak * 2 * Math.PI * frequency * Math.exp((damping * Math.atan2(root, damping)) / root);
}

/** Punch (a bounce of the UIScale) and shake (a wobble in Rotation): amount, frequency and damping by default. */
export const PUNCH = { amount: 0.12, frequency: 4, damping: 0.35 } as const;
export const SHAKE = { degrees: 5, frequency: 7, damping: 0.25 } as const;
/** Motion.spring's defaults. */
export const SPRING_DEFAULT = { frequency: 4, damping: 0.75 } as const;

/**
 * A spring run frame by frame at `fps` (Motion steps on RenderStepped): the value after each frame until it settles
 * (or `maxSeconds`), and the frame it settled on (null if it didn't).
 */
export function runSpring(from: number[], goal: number[], opts: { v0?: number[]; frequency?: number; damping?: number; fps?: number; maxSeconds?: number } = {}): { frames: number[][]; velocities: number[][]; settled: number | null } {
  const fps = opts.fps ?? 60;
  const s: SpringState = { x: [...from], v: opts.v0 ? [...opts.v0] : from.map(() => 0), goal: [...goal], w: 2 * Math.PI * (opts.frequency ?? SPRING_DEFAULT.frequency), z: opts.damping ?? SPRING_DEFAULT.damping };
  const frames: number[][] = [];
  const velocities: number[][] = [];
  const max = Math.ceil((opts.maxSeconds ?? 8) * fps);
  for (let k = 0; k < max; k++) {
    const moving = springAdvance(s, 1 / fps);
    frames.push([...s.x]);
    velocities.push([...s.v]);
    if (!moving) return { frames, velocities, settled: k + 1 };
  }
  return { frames, velocities, settled: null };
}

/** Motion.path: a Catmull-Rom point through `points` (each a list of numbers, e.g. a UDim2) at progress k. */
export function catmullRom(points: number[][], k: number): number[] {
  const n = points.length - 1;
  if (n < 1) return [...(points[0] ?? [])];
  const s = Math.min(1, Math.max(0, k)) * n;
  const i = Math.min(Math.floor(s), n - 1);
  const u = s - i;
  const p0 = points[Math.max(i - 1, 0)]!;
  const p1 = points[i]!;
  const p2 = points[i + 1]!;
  const p3 = points[Math.min(i + 2, n)]!;
  return p1.map((b, j) => {
    const a = p0[j]!;
    const d = p2[j]!;
    const e = p3[j]!;
    return 0.5 * (2 * b + (d - a) * u + (2 * a - 5 * b + 4 * d - e) * u * u + (3 * b - a - 3 * d + e) * u * u * u);
  });
}

/** printf's %.0f: rounds halves to even (Luau's string.format). */
const fmt0 = (v: number): string => {
  const r = Math.round(v);
  const half = Math.abs(v - Math.trunc(v)) === 0.5;
  return String(half && r % 2 !== 0 ? r - Math.sign(v) : r).replace(/^-0$/, '0');
};

/** Motion.commas: 1234567 → "1,234,567" (rounded). */
export function commas(n: number): string {
  const digits = fmt0(Math.abs(n));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n <= -0.5 ? '-' : '') + grouped;
}

const SUFFIXES = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
/** Motion.short: 1234 → "1.2K", 3400000 → "3.4M" (truncates, so 999,999 never reads "1000K"). */
export function short(n: number): string {
  const a = Math.abs(n);
  const sign = n <= -0.5 ? '-' : '';
  if (a < 1000) return sign + fmt0(a);
  const tier = Math.min(Math.floor(Math.log10(a) / 3), SUFFIXES.length);
  const v = a / 10 ** (tier * 3);
  const text = v < 100 ? (Math.floor(v * 10) / 10).toFixed(1) : fmt0(Math.floor(v));
  return sign + text.replace(/\.0$/, '') + SUFFIXES[tier - 1]!;
}

/** Motion.count's default length: 0.4 to 1.2 s, longer for bigger jumps. */
export const countSeconds = (from: number, to: number): number => Math.min(1.2, Math.max(0.4, 0.35 + 0.12 * Math.log10(Math.abs(to - from) + 1)));

// ─── Properties ───────────────────────────────────────────────────────────────────────────────────

/**
 * The properties a move animates, by their Roblox names. Scale is the element's UIScale; StrokeTransparency is every
 * UIStroke's Transparency (one number per stroke); GroupTransparency is a CanvasGroup's (it fades the whole subtree);
 * GradientOffset/GradientRotation are its UIGradient's; FlipbookFrame is the sheet frame a flipbook shows.
 */
export type PropName =
  | 'Position'
  | 'Size'
  | 'AnchorPoint'
  | 'Rotation'
  | 'Scale'
  | 'BackgroundTransparency'
  | 'TextTransparency'
  | 'TextStrokeTransparency'
  | 'ImageTransparency'
  | 'StrokeTransparency'
  | 'ShadowTransparency'
  | 'GroupTransparency'
  | 'BackgroundColor3'
  | 'TextColor3'
  | 'ImageColor3'
  | 'GradientOffset'
  | 'GradientRotation'
  | 'Text'
  | 'TextSize'
  | 'Visible'
  | 'FlipbookFrame';
export type Value = number | number[] | string | boolean;
export type Goal = Partial<Record<PropName, Value>>;

/** A node as sampled: a UiNode plus what the renderer can't draw yet (a CanvasGroup's fade is folded in; a flipbook frame is kept). */
export type LabNode = UiNode & { group?: number; frame?: number; kids?: LabNode[] };

const strokeList = (n: UiNode) => n.strokes ?? (n.stroke ? [n.stroke] : []);

export function getProp(n: LabNode, prop: PropName): Value {
  switch (prop) {
    case 'Position':
      return [...(n.pos ?? [0, 0, 0, 0])];
    case 'Size':
      return [...(n.size ?? [0, 100, 0, 100])];
    case 'AnchorPoint':
      return [...(n.anchor ?? [0, 0])];
    case 'Rotation':
      return n.rot ?? 0;
    case 'Scale':
      return n.scale ?? 1;
    case 'BackgroundTransparency':
      return n.bgT ?? 0;
    case 'TextTransparency':
      return n.textT ?? 0;
    case 'TextStrokeTransparency':
      return n.strokeT ?? 1;
    case 'ImageTransparency':
      return n.imageT ?? 0;
    case 'StrokeTransparency':
      return strokeList(n).map((s) => s.t);
    case 'ShadowTransparency':
      return n.shadow?.t ?? 1;
    case 'GroupTransparency':
      return n.group ?? 0;
    case 'BackgroundColor3':
      return [...(n.bg ?? [255, 255, 255])];
    case 'TextColor3':
      return [...(n.textColor ?? [0, 0, 0])];
    case 'ImageColor3':
      return [...(n.imageColor ?? [255, 255, 255])];
    case 'GradientOffset':
      return [...(n.gradient?.offset ?? [0, 0])];
    case 'GradientRotation':
      return n.gradient?.rot ?? 0;
    case 'Text':
      return n.text ?? '';
    case 'TextSize':
      return n.textSize ?? 14;
    case 'Visible':
      return n.visible !== false;
    case 'FlipbookFrame':
      return n.frame ?? 0;
  }
}

const num = (v: Value, d = 0): number => (typeof v === 'number' ? v : d);
const arr = <T extends number[]>(v: Value, d: T): T => (Array.isArray(v) ? (v as T) : d);
const rgb = (v: Value): RGB => arr(v, [255, 255, 255]).map((c) => Math.max(0, Math.min(255, c))) as RGB;

export function putProp(n: LabNode, prop: PropName, v: Value): void {
  switch (prop) {
    case 'Position':
      n.pos = arr(v, [0, 0, 0, 0]) as UDim2;
      break;
    case 'Size':
      n.size = arr(v, [0, 100, 0, 100]) as UDim2;
      break;
    case 'AnchorPoint':
      n.anchor = arr(v, [0, 0]) as [number, number];
      break;
    case 'Rotation':
      n.rot = num(v);
      break;
    case 'Scale':
      n.scale = num(v, 1);
      break;
    case 'BackgroundTransparency':
      n.bgT = num(v);
      break;
    case 'TextTransparency':
      n.textT = num(v);
      break;
    case 'TextStrokeTransparency':
      n.strokeT = num(v, 1);
      break;
    case 'ImageTransparency':
      n.imageT = num(v);
      break;
    case 'StrokeTransparency': {
      const ts = arr(v, [] as number[]);
      if (n.strokes) n.strokes = n.strokes.map((s, i) => ({ ...s, t: ts[i] ?? s.t }));
      if (n.stroke) n.stroke = n.strokes ? n.strokes[0] : { ...n.stroke, t: ts[0] ?? n.stroke.t };
      break;
    }
    case 'ShadowTransparency':
      if (n.shadow) n.shadow = { ...n.shadow, t: num(v, 1) };
      break;
    case 'GroupTransparency':
      n.group = num(v);
      break;
    case 'BackgroundColor3':
      n.bg = rgb(v);
      break;
    case 'TextColor3':
      n.textColor = rgb(v);
      break;
    case 'ImageColor3':
      n.imageColor = rgb(v);
      break;
    case 'GradientOffset':
      if (n.gradient) n.gradient = { ...n.gradient, offset: arr(v, [0, 0]) as [number, number] };
      break;
    case 'GradientRotation':
      if (n.gradient) n.gradient = { ...n.gradient, rot: num(v) };
      break;
    case 'Text':
      n.text = String(v);
      break;
    case 'TextSize':
      n.textSize = num(v, 14);
      break;
    case 'Visible':
      n.visible = v !== false;
      break;
    case 'FlipbookFrame':
      n.frame = num(v);
      break;
  }
}

/** a + (b − a)·k for numbers and lists of numbers; anything else switches at the end. */
export function lerpValue(a: Value, b: Value, k: number): Value {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((x, i) => x + (b[i]! - x) * k);
  return k >= 1 ? b : a;
}
/** A value as numbers (a number, a UDim2, a colour…), or null for text and booleans. */
export const valueNumbers = (v: Value): number[] | null => (typeof v === 'number' ? [v] : Array.isArray(v) ? v : null);
const unvec = (template: Value, c: number[]): Value => (typeof template === 'number' ? c[0]! : c);

// ─── Moves as data ────────────────────────────────────────────────────────────────────────────────

/** What a move is for (the feel rules judge timing by it). */
export type MotionIntent = 'open' | 'close' | 'enter' | 'exit' | 'press' | 'release' | 'hover' | 'feedback' | 'emphasis' | 'loop' | 'transition' | 'page' | 'progress' | 'count' | 'hero' | 'other';

export type CurveEase = { bezier: [number, number, number, number] } | { style: EasingStyle; direction?: EasingDirection };
export interface KeyframeKey {
  at: number;
  value: Value;
  /** How it gets here from the key before (default Quad Out), or a bezier curve (Motion.curve). */
  ease?: CurveEase;
}

interface MoveBase {
  /** When the call happens, in seconds on the timeline (default 0). */
  at?: number;
  intent?: MotionIntent;
  /** A name for reports ("Shop open"). */
  label?: string;
}
/**
 * A move, as data. Targets are paths from the ScreenGui ("Shop.Window.Buy"), as the layout engine names boxes.
 * Durations and options follow the Motion module's calls; leaving one out takes the module's default.
 */
export type LabMotion = MoveBase &
  (
    | { kind: 'tween'; target: string; info: TweenSpec; goal: Goal; /** Values set just before it plays (a scale set to 0, then tweened to 1). */ from?: Goal; /** A raw TweenService tween ignores Reduce Motion; Motion.tween follows it. */ raw?: boolean }
    | { kind: 'curve'; target: string; seconds: number; goal: Goal; ease: CurveEase; from?: Goal }
    | { kind: 'path'; target: string; points: UDim2[]; seconds: number; ease?: CurveEase }
    | { kind: 'spring'; target: string; goal: Goal; frequency?: number; damping?: number; from?: Goal }
    | { kind: 'punch'; target: string; amount?: number }
    | { kind: 'shake'; target: string; degrees?: number }
    | { kind: 'count'; target: string; from: number; to: number; seconds?: number; format?: 'commas' | 'short'; prefix?: string; suffix?: string }
    | { kind: 'enter'; /** The items (else a container: its children when it has a layout, else itself). */ targets?: string[]; target?: string; from?: 'up' | 'down' | 'left' | 'right' | 'pop' | 'fade'; distance?: number; gap?: number; delay?: number; info?: TweenSpec }
    | { kind: 'swap'; target: string; old?: string; direction?: number }
    | { kind: 'fly'; from: string; to: string; count?: number; size?: number; spread?: number; seconds?: number; image?: string; seed?: number }
    | { kind: 'transition'; style?: 'fade' | 'wipe' | 'iris'; seconds?: number; color?: RGB }
    | { kind: 'keyframes'; target: string; tracks: Partial<Record<PropName, KeyframeKey[]>>; loop?: boolean }
    | { kind: 'loop'; target: string; info: TweenSpec; goal: Goal }
    | { kind: 'pulse'; target: string; amount?: number; seconds?: number }
    | { kind: 'float'; target: string; pixels?: number; seconds?: number }
    | { kind: 'spin'; target: string; seconds?: number }
    | { kind: 'shimmer'; target: string; every?: number }
    | { kind: 'flipbook'; target: string; sheet: { count: number; columns?: number; fps?: number; loop?: boolean; still?: number } }
    | { kind: 'open'; target: string; seconds?: number; /** Hidden until it opens (a mockup's window that opens after a delay). */ hiddenBefore?: boolean }
    | { kind: 'close'; target: string; seconds?: number }
    | { kind: 'react'; target: string; /** The states now on (Ui.react layers selected, hover, press, disabled); empty is idle. */ states: UiStateName[] }
  );
export type LabMotionKind = LabMotion['kind'];

/** The intent a kind of move has unless it says otherwise. */
export function intentOf(m: LabMotion): MotionIntent {
  if (m.intent) return m.intent;
  switch (m.kind) {
    case 'open':
      return 'open';
    case 'close':
      return 'close';
    case 'enter':
      return 'enter';
    case 'punch':
    case 'shake':
      return 'feedback';
    case 'count':
      return 'count';
    case 'swap':
      return 'page';
    case 'fly':
      return 'emphasis';
    case 'transition':
      return 'transition';
    case 'pulse':
    case 'float':
    case 'spin':
    case 'shimmer':
    case 'loop':
    case 'flipbook':
      return 'loop';
    case 'keyframes':
    case 'path':
      return 'hero';
    case 'react':
      return m.states.includes('press') ? 'press' : m.states.includes('hover') ? 'hover' : 'release';
    case 'spring': {
      const s = m.goal.Scale;
      return typeof s === 'number' && s < 1 ? 'press' : 'release';
    }
    default:
      return 'other';
  }
}

/** A mockup's move as a LabMotion (null when it carries too little to play, with why). */
export function fromMock(m: MockMotion): LabMotion | { skip: string } {
  const at = m.delay ?? 0;
  const label = `${m.play}${m.target ? ` ${m.target}` : ''}`;
  const target = m.target ?? '';
  switch (m.play) {
    case 'open':
      return { kind: 'open', target, at, label, ...(m.seconds !== undefined ? { seconds: m.seconds } : {}), hiddenBefore: at > 0 };
    case 'close':
      return { kind: 'close', target, at, label, ...(m.seconds !== undefined ? { seconds: m.seconds } : {}) };
    case 'enter': {
      const from = ['up', 'down', 'left', 'right', 'pop', 'fade'].includes(String(m.from)) ? (String(m.from) as 'up') : 'up';
      return { kind: 'enter', target, at: 0, label, from, ...(m.delay !== undefined ? { delay: m.delay } : {}), ...(m.gap !== undefined ? { gap: m.gap } : {}), ...(m.amount !== undefined ? { distance: m.amount } : {}) };
    }
    case 'pulse':
      return { kind: 'pulse', target, at, label, ...(m.amount !== undefined ? { amount: m.amount } : {}), ...(m.seconds !== undefined ? { seconds: m.seconds } : {}) };
    case 'float':
      return { kind: 'float', target, at, label, ...(m.amount !== undefined ? { pixels: m.amount } : {}), ...(m.seconds !== undefined ? { seconds: m.seconds } : {}) };
    case 'spin':
      return { kind: 'spin', target, at, label, ...(m.seconds !== undefined ? { seconds: m.seconds } : {}) };
    case 'shimmer':
      return { kind: 'shimmer', target, at, label, ...(m.seconds !== undefined ? { every: m.seconds } : {}) };
    case 'punch':
      return { kind: 'punch', target, at, label, ...(m.amount !== undefined ? { amount: m.amount } : {}) };
    case 'shake':
      return { kind: 'shake', target, at, label, ...(m.amount !== undefined ? { degrees: m.amount } : {}) };
    case 'count':
      return { kind: 'count', target, at, label, from: Number(m.from ?? 0), to: Number(m.to ?? 0), ...(m.seconds !== undefined ? { seconds: m.seconds } : {}) };
    case 'transition':
      return { kind: 'transition', at, label, style: m.style === 'wipe' || m.style === 'iris' ? m.style : 'fade', ...(m.seconds !== undefined ? { seconds: m.seconds } : {}) };
    case 'swap':
      return { kind: 'swap', target, at, label, ...(typeof m.from === 'string' ? { old: m.from } : {}), ...(m.amount !== undefined ? { direction: m.amount < 0 ? -1 : 1 } : {}) };
    case 'fly':
      if (typeof m.to !== 'string') return { skip: 'fly needs `to`: the element the icons fly into' };
      return { kind: 'fly', from: target, to: m.to, at, label, ...(m.amount !== undefined ? { count: Math.round(m.amount) } : {}), ...(m.seconds !== undefined ? { seconds: m.seconds } : {}) };
    case 'flipbook':
      return { kind: 'flipbook', target, at, label, sheet: { count: 16, columns: 4, fps: 24 } };
    case 'keyframes':
      return { skip: 'keyframes: a mockup move carries no keys (describe them as a LabMotion)' };
  }
}

// ─── The timeline ─────────────────────────────────────────────────────────────────────────────────

type WriterKind = 'set' | 'tween' | 'curve' | 'spring' | 'path' | 'count' | 'flip';
interface Writer {
  path: string;
  prop: PropName;
  motion: number;
  seq: number;
  kind: WriterKind;
  /** When it starts writing (after a tween's first delay). */
  start: number;
  /** When it was made (Play() for a tween). */
  call: number;
  /** When its value stops changing (Infinity: never). */
  end: number;
  value?: Value;
  info?: TweenInfo;
  goal?: Value;
  ease?: (k: number) => number;
  seconds?: number;
  points?: number[][];
  spring?: { goal?: number[]; w: number; z: number; kick?: number; reuseGoal?: boolean };
  count?: { from: number; to: number; seconds: number; format: (n: number) => string; prefix: string; suffix: string };
  flip?: { count: number; fps: number; loop: boolean };
  // Filled in when the timeline is built: the state it starts from.
  from?: Value;
  fromV?: number[];
  run?: { frames: number[][]; velocities: number[][]; settled: number | null; goal: number[] };
  /** When a newer writer takes the property over (Infinity: never). */
  cut?: number;
}

/** One move as it plays: when, on what, how. */
export interface MotionSpan {
  index: number;
  kind: LabMotionKind;
  intent: MotionIntent;
  label: string;
  /** When the call happens. */
  call: number;
  /** When it first changes something (after delays). */
  start: number;
  /** When it stops changing (Infinity for loops). */
  end: number;
  loop: boolean;
  /** One cycle of a loop, in seconds. */
  cycle?: number;
  /** Every path it writes, and the one that shows it best (the element moved, scaled or faded). */
  paths: string[];
  primary: { path: string; prop: PropName } | null;
  /** "Back Out", "spring 9 Hz ζ 1", "bezier(0.2, 0.8, 0.2, 1)", … */
  easing: string;
  /** An entrance's items and the time between them. */
  items?: number;
  gap?: number;
  /** Time the screen takes no input (a transition's cover). */
  blocks: [number, number] | null;
  notes: string[];
}

export interface CompileOptions {
  /** The screen the moves play on (flights and covers need its size). Default: phone. */
  device?: UiDevice | (UiScreen & { label?: string });
  /** Play it as Motion does with Reduce Motion on. */
  reduced?: boolean;
  /** Frames per second springs and flipbooks step at (Motion steps on RenderStepped). Default 60. */
  fps?: number;
  /** How far loops and looping keyframes are laid out (seconds). Default 20. */
  horizon?: number;
}

export interface MotionTimeline {
  device: UiScreen & { label?: string };
  /** The device's name when it was given by name. */
  deviceKey?: UiDevice;
  reduced: boolean;
  fps: number;
  motions: LabMotion[];
  spans: MotionSpan[];
  /** Moves that couldn't play here, and why. */
  skipped: Array<{ motion: LabMotion | MockMotion; reason: string }>;
  /** The last moment anything finite changes. */
  end: number;
  /** The screens at time t: animated properties applied, flights and covers added. The originals are never changed; what a move touches is copied, the rest is shared (treat the result as read-only). */
  sample(t: number): LabNode[];
  /** One property's value at time t (undefined: nothing animates it). */
  valueAt(path: string, prop: PropName, t: number): Value | undefined;
  /** The value before any move touched it. */
  baseValue(path: string, prop: PropName): Value | undefined;
  /** The animated properties of one move: [path, prop] pairs. */
  propsOf(index: number): Array<{ path: string; prop: PropName }>;
  /** The layout of the screens at time t on the timeline's device. */
  layoutAt(t: number): UiBox[];
  /** When a move's spring settled (seconds on the timeline), if it has springs. */
  settleOf(index: number): number | null;
  /** A move's main property as it plays: when it writes (until it settles or another move takes the property over), from what to what (numbers; null for text and flags). */
  trackOf(index: number): { path: string; prop: PropName; start: number; end: number; from: number[] | null; goal: number[] | null } | null;
}

const resolveScreen = (d: CompileOptions['device']): UiScreen & { label?: string } => (d === undefined ? UI_DEVICES.phone : typeof d === 'string' ? UI_DEVICES[d] : d);

/** Every node by its path (the screen's name first); the first of same-named siblings wins, as FindFirstChild does. */
export function indexPaths(screens: UiNode[]): Map<string, UiNode> {
  const out = new Map<string, UiNode>();
  const walk = (n: UiNode, path: string) => {
    if (!out.has(path)) out.set(path, n);
    for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`);
  };
  for (const s of screens) walk(s, s.name);
  return out;
}
const parentPath = (p: string) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : null);
const isTextCls = (cls: string) => cls === 'TextLabel' || cls === 'TextButton' || cls === 'TextBox';
const isImageCls = (cls: string) => cls === 'ImageLabel' || cls === 'ImageButton';

/** Small seeded random (mulberry32): flights burst the same way every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const easeName = (i: TweenSpec) => `${i.style ?? 'Quad'} ${i.direction ?? 'Out'}`;
const curveFn = (e: CurveEase | undefined, fallback: (k: number) => number): ((k: number) => number) => (!e ? fallback : 'bezier' in e ? bezier(...e.bezier) : (k: number) => robloxEase(e.style, e.direction ?? 'Out', k));
const curveName = (e: CurveEase | undefined, fallback: string) => (!e ? fallback : 'bezier' in e ? `bezier(${e.bezier.join(', ')})` : `${e.style} ${e.direction ?? 'Out'}`);

let synthId = 9_000_000;

/**
 * Compiles moves (LabMotion, or a mockup's MockMotion) against screens: who writes which property when, in the
 * Motion module's own terms. Newer writers take a property over from older ones (TweenService cancels the older
 * tween; a spring retargeted keeps its speed; a punch kicks a running spring afresh).
 */
export function compileMotion(screens: UiNode[], motions: Array<LabMotion | MockMotion>, opts: CompileOptions = {}): MotionTimeline {
  const dev = resolveScreen(opts.device);
  const reduced = !!opts.reduced;
  const fps = opts.fps ?? 60;
  const horizon = opts.horizon ?? 20;
  const nodes = indexPaths(screens);
  const writers: Writer[] = [];
  const spans: MotionSpan[] = [];
  const skipped: MotionTimeline['skipped'] = [];
  const lab: LabMotion[] = [];
  // Nodes a move adds (flight icons, a transition's cover, a shimmer's shine), alive [from, to).
  const added: Array<{ parent: string | null; node: LabNode; from: number; to: number }> = [];
  const addedNodes = new Map<string, LabNode>();
  let seq = 0;
  let baseBoxes: Map<string, UiBox> | null = null;
  const boxes = () => {
    if (!baseBoxes) {
      baseBoxes = new Map(screens.filter((s) => s.enabled !== false).flatMap((s) => layoutScreen(s, dev)).map((b) => [b.path, b]));
    }
    return baseBoxes;
  };
  const nodeAt = (p: string): LabNode | undefined => nodes.get(p) ?? addedNodes.get(p);
  const base = (p: string, prop: PropName): Value => getProp(nodeAt(p) ?? ({ id: 0, name: '', cls: 'Frame' } as UiNode), prop);

  for (const raw of motions) {
    const m = 'play' in raw ? fromMock(raw) : raw;
    if ('skip' in m) {
      skipped.push({ motion: raw, reason: m.skip });
      continue;
    }
    const index = lab.length;
    lab.push(m);
    const call = m.at ?? 0;
    const span: MotionSpan = { index, kind: m.kind, intent: intentOf(m), label: m.label ?? `${m.kind}${'target' in m && m.target ? ` ${m.target}` : ''}`, call, start: call, end: call, loop: false, paths: [], primary: null, easing: '', blocks: null, notes: [] };
    spans.push(span);
    const mine: Writer[] = [];
    const w = (x: Omit<Writer, 'motion' | 'seq' | 'call'> & { call?: number }) => {
      const out: Writer = { ...x, call: x.call ?? x.start, motion: index, seq: seq++ };
      writers.push(out);
      mine.push(out);
      return out;
    };
    const set = (path: string, prop: PropName, value: Value, at: number) => w({ path, prop, kind: 'set', start: at, end: at, value });
    const tween = (path: string, prop: PropName, goal: Value, info: TweenSpec, at: number, follow = true) => {
      const i = full(info);
      if (reduced && follow) return set(path, prop, goal, at);
      return w({ path, prop, kind: 'tween', start: at + i.delay, call: at, end: at + tweenLength(i), info: i, goal });
    };
    const kick = (path: string, prop: PropName, peak: number, frequency: number, damping: number, at: number) =>
      w({ path, prop, kind: 'spring', start: at, end: Infinity, spring: { w: 2 * Math.PI * frequency, z: damping, kick: speedFor(peak, frequency, damping), reuseGoal: true } });
    const spring = (path: string, prop: PropName, goal: Value, frequency: number, damping: number, at: number) => {
      if (reduced) return set(path, prop, goal, at);
      return w({ path, prop, kind: 'spring', start: at, end: Infinity, spring: { goal: valueNumbers(goal) ?? [0], w: 2 * Math.PI * frequency, z: damping } });
    };
    const need = (p: string | undefined): p is string => {
      if (p && nodeAt(p)) return true;
      span.notes.push(`no element "${p ?? ''}"`);
      return false;
    };

    switch (m.kind) {
      case 'tween': {
        if (!need(m.target)) break;
        for (const [prop, v] of Object.entries(m.from ?? {}) as Array<[PropName, Value]>) set(m.target, prop, v, call);
        for (const [prop, v] of Object.entries(m.goal) as Array<[PropName, Value]>) tween(m.target, prop, v, m.info, call, !m.raw);
        span.easing = easeName(m.info);
        if ((m.info.repeat ?? 0) < 0) {
          span.loop = true;
          span.cycle = (m.info.time ?? 1) * (m.info.reverses ? 2 : 1) + (DELAY_EACH_REPEAT ? (m.info.delay ?? 0) : 0);
        }
        break;
      }
      case 'curve': {
        if (!need(m.target)) break;
        for (const [prop, v] of Object.entries(m.from ?? {}) as Array<[PropName, Value]>) set(m.target, prop, v, call);
        const ease = curveFn(m.ease, (k) => k);
        for (const [prop, v] of Object.entries(m.goal) as Array<[PropName, Value]>)
          if (reduced) set(m.target, prop, v, call);
          else w({ path: m.target, prop, kind: 'curve', start: call, end: call + Math.max(m.seconds, 1e-3), ease, seconds: Math.max(m.seconds, 1e-3), goal: v });
        span.easing = curveName(m.ease, 'Linear');
        break;
      }
      case 'path': {
        if (!need(m.target)) break;
        const last = m.points[m.points.length - 1];
        if (reduced || m.points.length < 2) {
          if (last) set(m.target, 'Position', [...last], call);
        } else w({ path: m.target, prop: 'Position', kind: 'path', start: call, end: call + Math.max(m.seconds, 1e-3), seconds: Math.max(m.seconds, 1e-3), points: m.points.map((p) => [...p]), ease: curveFn(m.ease, bezier(0.42, 0, 0.58, 1)) });
        span.easing = curveName(m.ease, 'bezier(0.42, 0, 0.58, 1)');
        break;
      }
      case 'spring': {
        if (!need(m.target)) break;
        for (const [prop, v] of Object.entries(m.from ?? {}) as Array<[PropName, Value]>) set(m.target, prop, v, call);
        const f = m.frequency ?? SPRING_DEFAULT.frequency;
        const z = m.damping ?? SPRING_DEFAULT.damping;
        for (const [prop, v] of Object.entries(m.goal) as Array<[PropName, Value]>) spring(m.target, prop, v, f, z, call);
        span.easing = `spring ${f} Hz ζ ${z}`;
        break;
      }
      case 'punch': {
        if (!need(m.target)) break;
        if (!reduced) kick(m.target, 'Scale', m.amount ?? PUNCH.amount, PUNCH.frequency, PUNCH.damping, call);
        span.easing = `spring ${PUNCH.frequency} Hz ζ ${PUNCH.damping}`;
        break;
      }
      case 'shake': {
        if (!need(m.target)) break;
        if (!reduced) kick(m.target, 'Rotation', m.degrees ?? SHAKE.degrees, SHAKE.frequency, SHAKE.damping, call);
        span.easing = `spring ${SHAKE.frequency} Hz ζ ${SHAKE.damping}`;
        break;
      }
      case 'count': {
        if (!need(m.target)) break;
        const format = m.format === 'short' ? short : commas;
        const prefix = m.prefix ?? '';
        const suffix = m.suffix ?? '';
        if (reduced || m.from === m.to) set(m.target, 'Text', prefix + format(m.to) + suffix, call);
        else {
          const seconds = m.seconds ?? countSeconds(m.from, m.to);
          w({ path: m.target, prop: 'Text', kind: 'count', start: call, end: call + seconds, count: { from: m.from, to: m.to, seconds, format, prefix, suffix } });
        }
        span.easing = 'Quad Out';
        break;
      }
      case 'enter': {
        let items: string[];
        if (m.targets?.length) items = m.targets;
        else if (m.target) {
          const t = nodeAt(m.target);
          if (!t) {
            need(m.target);
            break;
          }
          items = t.list || t.grid || t.pages ? (t.kids ?? []).map((c) => `${m.target}.${c.name}`) : [m.target];
        } else items = [];
        let list = items.filter((p) => nodeAt(p) && nodeAt(p)!.visible !== false);
        if (!list.length || reduced) {
          if (!list.length) span.notes.push('nothing visible to enter');
          break;
        }
        const parent = nodeAt(parentPath(list[0]!) ?? '');
        const laidOut = !!(parent && (parent.list || parent.grid || parent.pages));
        if (laidOut) {
          const order = new Map(list.map((p, i) => [p, i]));
          list = [...list].sort((a, b) => (nodeAt(a)!.order ?? 0) - (nodeAt(b)!.order ?? 0) || order.get(a)! - order.get(b)!);
        }
        const from = laidOut ? 'fade' : (m.from ?? 'up');
        const distance = m.distance ?? 24;
        const gap = m.gap ?? 0.035;
        const info = m.info ? full(m.info) : from === 'pop' ? MOTION_T.pop : MOTION_T.enter;
        list.forEach((item, i) => {
          const delay = (m.delay ?? 0) + i * gap;
          const timed = { ...info, repeat: 0, reverses: false, delay };
          if (from === 'pop') {
            const rest = num(base(item, 'Scale'), 1);
            set(item, 'Scale', rest * 0.6, call);
            tween(item, 'Scale', rest, timed, call);
          } else if (from !== 'fade') {
            const home = arr(base(item, 'Position'), [0, 0, 0, 0]);
            const dx = from === 'left' ? -distance : from === 'right' ? distance : 0;
            const dy = from === 'up' ? distance : from === 'down' ? -distance : 0;
            set(item, 'Position', [home[0]!, home[1]! + dx, home[2]!, home[3]! + dy], call);
            tween(item, 'Position', home, timed, call);
          }
          // fadeIn: the item and up to 39 of its parts, from invisible to their designed transparency.
          const fadeInfo = { ...(from === 'pop' ? MOTION_T.enter : info), repeat: 0, reverses: false, delay };
          let parts = 0;
          const fade = (p: string, n: UiNode) => {
            if (parts >= 40) return;
            parts++;
            const props: PropName[] = isTextCls(n.cls) ? ['BackgroundTransparency', 'TextTransparency', 'TextStrokeTransparency'] : isImageCls(n.cls) ? ['BackgroundTransparency', 'ImageTransparency'] : ['BackgroundTransparency'];
            for (const prop of props) {
              const v = num(getProp(n, prop));
              if (v < 1) {
                set(p, prop, 1, call);
                tween(p, prop, v, fadeInfo, call);
              }
            }
            const strokes = strokeList(n);
            if (strokes.length) {
              parts += strokes.length;
              const ts = strokes.map((s) => s.t);
              if (ts.some((t) => t < 1)) {
                set(p, 'StrokeTransparency', ts.map((t) => (t < 1 ? 1 : t)), call);
                tween(p, 'StrokeTransparency', ts, fadeInfo, call);
              }
            }
            if (n.shadow && n.shadow.t < 1) {
              parts++;
              set(p, 'ShadowTransparency', 1, call);
              tween(p, 'ShadowTransparency', n.shadow.t, fadeInfo, call);
            }
            for (const c of n.kids ?? []) fade(`${p}.${c.name}`, c);
          };
          fade(item, nodeAt(item)!);
        });
        span.items = list.length;
        span.gap = gap;
        span.easing = from === 'pop' ? `Back Out (scale), Quint Out (fade)` : easeName(info);
        if (laidOut && m.from && m.from !== 'fade') span.notes.push(`children of a layout fade (asked: ${m.from})`);
        break;
      }
      case 'swap': {
        if (!need(m.target)) break;
        const dir = m.direction ?? 1;
        const parent = parentPath(m.target);
        let old = m.old;
        if (!old && parent) {
          const p = nodeAt(parent);
          const sib = (p?.kids ?? []).find((c) => `${parent}.${c.name}` !== m.target && c.visible !== false);
          if (sib) old = `${parent}.${sib.name}`;
        }
        const home = arr(base(m.target, 'Position'), [0, 0, 0, 0]);
        set(m.target, 'Visible', true, call);
        if (reduced) set(m.target, 'Position', home, call);
        else {
          set(m.target, 'Position', [home[0]! + dir, home[1]!, home[2]!, home[3]!], call);
          tween(m.target, 'Position', home, MOTION_T.page, call);
        }
        if (old && nodeAt(old)) {
          const oldHome = arr(base(old, 'Position'), [0, 0, 0, 0]);
          if (reduced) set(old, 'Visible', false, call);
          else {
            tween(old, 'Position', [oldHome[0]! - dir, oldHome[1]!, oldHome[2]!, oldHome[3]!], MOTION_T.page, call);
            set(old, 'Visible', false, call + MOTION_T.page.time);
            set(old, 'Position', oldHome, call + MOTION_T.page.time);
          }
        }
        if (parent && !nodeAt(parent)?.clips) span.notes.push(`its parent ${parent} doesn't clip: the pages slide over what is beside it`);
        span.easing = 'Quint Out';
        break;
      }
      case 'fly': {
        if (!need(m.from) || !need(m.to)) break;
        const count = m.count ?? 6;
        const toBox = boxes().get(m.to);
        const fromBox = boxes().get(m.from);
        if (!toBox || !fromBox) {
          span.notes.push('its elements are not laid out (hidden?)');
          break;
        }
        if (reduced) {
          span.notes.push('Reduce Motion: no flight; every icon lands at once');
          break;
        }
        const layer = 'MotionLayer';
        if (!addedNodes.has(layer)) {
          const node: LabNode = { id: synthId++, name: layer, cls: 'ScreenGui', ignoreInset: true, insets: 'None', displayOrder: 90, kids: [] };
          added.push({ parent: null, node, from: -Infinity, to: Infinity });
          addedNodes.set(layer, node);
        }
        const centre = (b: UiBox): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];
        const start = centre(fromBox);
        const goal = centre(toBox);
        const px = m.size ?? Math.min(72, Math.max(24, toBox.h));
        const spread = m.spread ?? 70;
        const seconds = m.seconds ?? 0.55;
        const rand = rng(m.seed ?? 1);
        const toNode = nodeAt(m.to)!;
        const image = m.image ?? (isImageCls(toNode.cls) ? toNode.image : undefined);
        const burst = tweenInfo(0.25, 'Back', 'Out');
        for (let i = 0; i < count; i++) {
          const leave = call + 0.3 + i * 0.05;
          const holderPath = `${layer}.Flight${i + 1}`;
          const iconPath = `${holderPath}.Icon`;
          const icon: LabNode = image
            ? { id: synthId++, name: 'Icon', cls: 'ImageLabel', anchor: [0.5, 0.5], size: [0, px, 0, px], image, imageColor: [255, 255, 255], scaleType: 'Fit', scale: 0.3 }
            : { id: synthId++, name: 'Icon', cls: 'Frame', anchor: [0.5, 0.5], size: [0, px, 0, px], bg: [255, 196, 40], corner: [0.5, 0], stroke: { color: [140, 90, 0], t: 0, px: 2, text: false }, scale: 0.3 };
          const holder: LabNode = { id: synthId++, name: `Flight${i + 1}`, cls: 'Frame', bgT: 1, size: [0, 0, 0, 0], pos: [0, start[0], 0, start[1]], kids: [icon] };
          added.push({ parent: layer, node: holder, from: call, to: leave + seconds });
          addedNodes.set(holderPath, holder);
          addedNodes.set(iconPath, icon);
          const angle = rand() * 2 * Math.PI;
          const r = spread * (0.4 + rand() * 0.6);
          const out: [number, number] = [start[0] + Math.cos(angle) * r, start[1] + Math.sin(angle) * r];
          tween(holderPath, 'Position', [0, out[0], 0, out[1]], burst, call);
          tween(iconPath, 'Scale', 1, burst, call);
          tween(holderPath, 'Position', [0, goal[0], 0, out[1]], tweenInfo(seconds, 'Quad', 'Out'), leave);
          tween(iconPath, 'Position', [0, 0, 0, goal[1] - out[1]], tweenInfo(seconds, 'Back', 'In'), leave);
          tween(iconPath, 'Scale', 0.7, tweenInfo(seconds, 'Quad', 'Out'), leave);
          kick(m.to, 'Scale', 0.1, PUNCH.frequency, PUNCH.damping, leave + seconds);
        }
        span.easing = 'Back Out burst, Quad Out across, Back In up/down';
        // The first icon shows the flight best (its holder only moves across).
        span.primary = { path: `${layer}.Flight1.Icon`, prop: 'Position' };
        break;
      }
      case 'transition': {
        const style = reduced ? 'fade' : (m.style ?? 'fade');
        const half = reduced ? Math.min(m.seconds ?? 0.3, 0.15) : (m.seconds ?? 0.3);
        const name = `MotionTransition${index}`;
        const cover: LabNode = { id: synthId++, name: 'Cover', cls: 'TextButton', text: '', bg: m.color ?? [0, 0, 0], border: 0 };
        const gui: LabNode = { id: synthId++, name, cls: 'ScreenGui', ignoreInset: true, insets: 'None', displayOrder: 100, kids: [cover] };
        added.push({ parent: null, node: gui, from: call, to: call + 2 * half });
        addedNodes.set(name, gui);
        const path = `${name}.Cover`;
        addedNodes.set(path, cover);
        const inInfo = tweenInfo(half, 'Quad', 'In');
        const outInfo = tweenInfo(half, 'Quad', 'Out');
        if (style === 'wipe') {
          cover.size = [1, 0, 1, 0];
          cover.pos = [-1, 0, 0, 0];
          tween(path, 'Position', [0, 0, 0, 0], inInfo, call, false);
          tween(path, 'Position', [1, 0, 0, 0], outInfo, call + half, false);
        } else if (style === 'iris') {
          const d = Math.hypot(dev.w, dev.h) + 8;
          cover.anchor = [0.5, 0.5];
          cover.pos = [0.5, 0, 0.5, 0];
          cover.size = [0, 0, 0, 0];
          cover.corner = [0.5, 0];
          tween(path, 'Size', [0, d, 0, d], inInfo, call, false);
          tween(path, 'Size', [0, 0, 0, 0], outInfo, call + half, false);
        } else {
          cover.size = [1, 0, 1, 0];
          cover.bgT = 1;
          tween(path, 'BackgroundTransparency', 0, inInfo, call, false);
          tween(path, 'BackgroundTransparency', 1, outInfo, call + half, false);
        }
        span.blocks = [call, call + 2 * half];
        span.easing = 'Quad In, then Quad Out';
        break;
      }
      case 'keyframes': {
        if (!need(m.target)) break;
        const tracks = Object.entries(m.tracks).filter(([, k]) => k && k.length) as Array<[PropName, KeyframeKey[]]>;
        const first: Goal = {};
        const final: Goal = {};
        let length = 0;
        const segments: Array<{ at: number; prop: PropName; seconds: number; to: Value; ease?: CurveEase }> = [];
        for (const [prop, keys] of tracks) {
          const sorted = [...keys].sort((a, b) => a.at - b.at);
          first[prop] = sorted[0]!.at <= 0 ? sorted[0]!.value : base(m.target, prop);
          final[prop] = sorted[sorted.length - 1]!.value;
          const fromAt = sorted[0]!.at <= 0 ? sorted[0]!.at : 0;
          sorted.forEach((key, i) => {
            if (i === 0 && key.at <= 0) return;
            const before = i === 0 ? fromAt : sorted[i - 1]!.at;
            segments.push({ at: before, prop, seconds: key.at - before, to: key.value, ...(key.ease ? { ease: key.ease } : {}) });
            length = Math.max(length, key.at);
          });
        }
        segments.sort((a, b) => a.at - b.at);
        if (reduced) {
          for (const [prop, v] of Object.entries(final) as Array<[PropName, Value]>) set(m.target, prop, v, call);
          break;
        }
        const loops = m.loop && length > 0 ? Math.max(1, Math.ceil(horizon / length)) : 1;
        for (let r = 0; r < loops; r++) {
          const s0 = call + r * length;
          for (const [prop, v] of Object.entries(first) as Array<[PropName, Value]>) set(m.target, prop, v, s0);
          for (const seg of segments) {
            const at = s0 + seg.at;
            if (seg.ease && 'bezier' in seg.ease) w({ path: m.target, prop: seg.prop, kind: 'curve', start: at, end: at + Math.max(seg.seconds, 1e-3), seconds: Math.max(seg.seconds, 1e-3), ease: bezier(...seg.ease.bezier), goal: seg.to });
            else tween(m.target, seg.prop, seg.to, tweenInfo(seg.seconds, seg.ease && 'style' in seg.ease ? seg.ease.style : 'Quad', seg.ease && 'style' in seg.ease ? (seg.ease.direction ?? 'Out') : 'Out'), at);
          }
        }
        if (m.loop) {
          span.loop = true;
          span.cycle = length;
        }
        span.easing = 'keyframes';
        break;
      }
      case 'loop':
      case 'pulse':
      case 'float':
      case 'spin': {
        if (!need(m.target)) break;
        if (reduced) {
          span.notes.push('Reduce Motion: loops do not run');
          break;
        }
        let info: TweenInfo;
        let goal: Goal;
        if (m.kind === 'loop') {
          info = full({ ...m.info, repeat: (m.info.repeat ?? 0) === 0 ? -1 : m.info.repeat! });
          goal = m.goal;
        } else if (m.kind === 'pulse') {
          info = tweenInfo((m.seconds ?? 1.2) / 2, 'Sine', 'InOut', -1, true);
          goal = { Scale: num(base(m.target, 'Scale'), 1) * (1 + (m.amount ?? 0.06)) };
        } else if (m.kind === 'float') {
          const p = arr(base(m.target, 'Position'), [0, 0, 0, 0]);
          info = tweenInfo((m.seconds ?? 2.4) / 2, 'Sine', 'InOut', -1, true);
          goal = { Position: [p[0]!, p[1]!, p[2]!, p[3]! - (m.pixels ?? 6)] };
        } else {
          info = tweenInfo(m.seconds ?? 6, 'Linear', 'In', -1);
          goal = { Rotation: num(base(m.target, 'Rotation')) + 360 };
        }
        for (const [prop, v] of Object.entries(goal) as Array<[PropName, Value]>) tween(m.target, prop, v, info, call);
        span.loop = info.repeat < 0;
        span.cycle = info.time * (info.reverses ? 2 : 1) + (DELAY_EACH_REPEAT ? info.delay : 0);
        span.easing = easeName(info);
        break;
      }
      case 'shimmer': {
        if (!need(m.target)) break;
        if (reduced) {
          span.notes.push('Reduce Motion: loops do not run');
          break;
        }
        const t = nodeAt(m.target)!;
        const every = m.every ?? 3;
        const shine: LabNode = {
          id: synthId++,
          name: 'Shine',
          cls: 'Frame',
          bg: [255, 255, 255],
          border: 0,
          size: [1, 0, 1, 0],
          z: 50,
          ...(t.corner ? { corner: t.corner } : {}),
          ...(t.corners ? { corners: t.corners } : {}),
          gradient: { rot: 20, colors: [[0, 255, 255, 255], [1, 255, 255, 255]], transp: [[0, 1], [0.4, 1], [0.5, 0.6], [0.6, 1], [1, 1]], offset: [-1, 0] },
        };
        const path = `${m.target}.Shine`;
        added.push({ parent: m.target, node: shine, from: call, to: Infinity });
        addedNodes.set(path, shine);
        const sweep = tweenInfo(0.7, 'Quad', 'InOut');
        const period = sweep.time + every;
        for (let s = call; s < call + horizon; s += period) {
          set(path, 'GradientOffset', [-1, 0], s);
          tween(path, 'GradientOffset', [1, 0], sweep, s);
        }
        span.loop = true;
        span.cycle = period;
        span.easing = 'Quad InOut sweep';
        break;
      }
      case 'flipbook': {
        if (!need(m.target)) break;
        const sheet = m.sheet;
        if (reduced) set(m.target, 'FlipbookFrame', sheet.still ?? 0, call);
        else w({ path: m.target, prop: 'FlipbookFrame', kind: 'flip', start: call, end: sheet.loop === false ? call + sheet.count / (sheet.fps ?? 24) : Infinity, flip: { count: sheet.count, fps: sheet.fps ?? 24, loop: sheet.loop !== false } });
        span.loop = sheet.loop !== false;
        span.cycle = sheet.count / (sheet.fps ?? 24);
        span.easing = `${sheet.fps ?? 24} fps`;
        span.notes.push('flipbook frames are counted, not drawn (no ImageRectOffset in the capture format)');
        break;
      }
      case 'open': {
        if (!need(m.target)) break;
        const rest = num(base(m.target, 'Scale'), 1);
        if (m.hiddenBefore && call > 0) set(m.target, 'Visible', false, 0);
        set(m.target, 'Visible', true, call);
        if (reduced) set(m.target, 'Scale', rest, call);
        else {
          set(m.target, 'Scale', rest * WINDOW_FROM, call);
          tween(m.target, 'Scale', rest, { ...KIT_T.open, time: m.seconds ?? KIT_T.open.time }, call);
        }
        span.easing = 'Back Out';
        break;
      }
      case 'close': {
        if (!need(m.target)) break;
        const rest = num(base(m.target, 'Scale'), 1);
        const seconds = m.seconds ?? KIT_T.close.time;
        if (reduced) set(m.target, 'Visible', false, call);
        else {
          tween(m.target, 'Scale', rest * WINDOW_FROM, { ...KIT_T.close, time: seconds }, call);
          set(m.target, 'Visible', false, call + seconds);
        }
        span.easing = 'Quad In';
        break;
      }
      case 'react': {
        if (!need(m.target)) break;
        const n = nodeAt(m.target)!;
        const st = n.states ?? {};
        const on = new Set(m.states);
        const FIELDS: Array<[keyof UiStatePatch, PropName]> = [
          ['bg', 'BackgroundColor3'],
          ['bgT', 'BackgroundTransparency'],
          ['textColor', 'TextColor3'],
          ['textT', 'TextTransparency'],
          ['imageColor', 'ImageColor3'],
          ['imageT', 'ImageTransparency'],
          ['rot', 'Rotation'],
        ];
        const goal = new Map<PropName, Value>();
        for (const s of ['hover', 'press', 'selected', 'disabled'] as UiStateName[]) for (const [f, prop] of FIELDS) if (st[s]?.[f] !== undefined) goal.set(prop, base(m.target, prop));
        let size = 1;
        const layer = (s: UiStateName) => {
          const p = st[s];
          if (!p) return;
          for (const [f, prop] of FIELDS) if (p[f] !== undefined) goal.set(prop, p[f] as Value);
          if (p.scale !== undefined) size = p.scale;
        };
        const disabled = on.has('disabled');
        if (on.has('selected')) layer('selected');
        if (on.has('hover') && !disabled) layer('hover');
        if (on.has('press') && !disabled) layer('press');
        if (disabled) layer('disabled');
        for (const [prop, v] of goal) tween(m.target, prop, v, KIT_T.quick, call);
        const pressing = on.has('press') && !disabled;
        const rest = 1;
        spring(m.target, 'Scale', rest * size, pressing ? 9 : 5, pressing ? 1 : 0.45, call);
        span.easing = pressing ? 'spring 9 Hz ζ 1' : 'spring 5 Hz ζ 0.45';
        break;
      }
    }
    span.paths = [...new Set(mine.map((x) => x.path))];
    const prefer: PropName[] = ['Position', 'Scale', 'Rotation', 'Size', 'Text', 'BackgroundTransparency', 'ImageTransparency', 'TextTransparency', 'GradientOffset', 'FlipbookFrame'];
    const moving = mine.filter((x) => x.kind !== 'set' || x.prop === 'Visible');
    const pick = prefer.map((p) => moving.find((x) => x.prop === p && x.kind !== 'set')).find(Boolean) ?? moving.find((x) => x.kind !== 'set') ?? mine[0];
    span.primary ??= pick ? { path: pick.path, prop: pick.prop } : null;
    const changing = mine.filter((x) => x.kind !== 'set');
    span.start = changing.length ? Math.min(...changing.map((x) => x.start)) : call;
  }

  // Order the writers of each property and work out the state each starts from.
  const groups = new Map<string, Writer[]>();
  for (const x of writers) {
    const key = `${x.path}|${x.prop}`;
    const g = groups.get(key);
    if (g) g.push(x);
    else groups.set(key, [x]);
  }
  const runFor = (x: Writer): NonNullable<Writer['run']> => {
    if (!x.run) {
      const from = valueNumbers(x.from!) ?? [0];
      const v0 = x.fromV ?? from.map(() => 0);
      const sp = x.spring!;
      const goal = sp.goal ?? from;
      const s: SpringState = { x: [...from], v: sp.kick !== undefined ? [sp.kick, ...v0.slice(1)] : [...v0], goal: [...goal], w: sp.w, z: sp.z };
      const frames: number[][] = [];
      const velocities: number[][] = [];
      let settled: number | null = null;
      const max = Math.ceil(10 * fps);
      for (let k = 0; k < max; k++) {
        const moving = springAdvance(s, 1 / fps);
        frames.push([...s.x]);
        velocities.push([...s.v]);
        if (!moving) {
          settled = k + 1;
          break;
        }
      }
      x.run = { frames, velocities, settled, goal };
      x.end = x.start + (settled ?? max) / fps;
    }
    return x.run;
  };
  const evalAt = (x: Writer, t: number): { value: Value; v?: number[]; goal?: number[] } => {
    const from = x.from!;
    switch (x.kind) {
      case 'set':
        return { value: x.value! };
      case 'tween': {
        const a = tweenAlpha(x.info!, t - x.call);
        return { value: a === null ? from : lerpValue(from, x.goal!, a) };
      }
      case 'curve': {
        const k = Math.min(1, Math.max(0, (t - x.start) / x.seconds!));
        return { value: lerpValue(from, x.goal!, x.ease!(k)) };
      }
      case 'path': {
        const k = Math.min(1, Math.max(0, (t - x.start) / x.seconds!));
        return { value: catmullRom(x.points!, x.ease!(k)) };
      }
      case 'count': {
        const c = x.count!;
        if (t >= x.start + c.seconds) return { value: c.prefix + c.format(c.to) + c.suffix };
        const v = c.from + (c.to - c.from) * robloxEase('Quad', 'Out', (t - x.start) / c.seconds);
        return { value: c.prefix + c.format(Math.floor(v + 0.5)) + c.suffix };
      }
      case 'flip': {
        const f = x.flip!;
        let i = Math.floor((t - x.start) * f.fps);
        if (i >= f.count) i = f.loop ? i % f.count : f.count - 1;
        return { value: Math.max(0, i) };
      }
      case 'spring': {
        const run = runFor(x);
        const k = Math.floor((t - x.start) * fps + 1e-9);
        if (k <= 0) return { value: from, v: x.fromV ?? (valueNumbers(from) ?? [0]).map(() => 0), goal: run.goal };
        const i = Math.min(k, run.frames.length) - 1;
        const settled = run.settled !== null && k >= run.settled;
        return { value: unvec(from, run.frames[i]!), v: settled ? undefined : run.velocities[i], goal: settled ? undefined : run.goal };
      }
    }
  };
  for (const [key, g] of groups) {
    g.sort((a, b) => a.start - b.start || a.seq - b.seq);
    const [path, prop] = key.split('|') as [string, PropName];
    let prevState: { value: Value; v?: number[]; goal?: number[] } = { value: base(path, prop) };
    g.forEach((x, i) => {
      if (i > 0) prevState = evalAt(g[i - 1]!, x.start);
      x.from = prevState.value;
      // A spring retargeted (or kicked) while the last spring still moves keeps its speed (and a kick its rest).
      const prev = g[i - 1];
      if (x.kind === 'spring' && prev?.kind === 'spring' && prevState.v) {
        x.fromV = prevState.v;
        if (x.spring!.reuseGoal && prevState.goal) x.spring!.goal = prevState.goal;
      } else if (x.kind === 'spring' && x.spring!.reuseGoal) x.spring!.goal = valueNumbers(prevState.value) ?? [0];
      if (x.kind === 'spring') runFor(x);
      x.cut = g[i + 1]?.start ?? Infinity;
    });
  }

  // Spans end when their writers do (springs only know once run).
  for (const span of spans) {
    const mine = writers.filter((x) => x.motion === span.index);
    if (!mine.length) continue;
    const ends = mine.map((x) => Math.min(x.end, x.cut ?? Infinity));
    if (!span.loop) span.end = Math.max(span.start, ...ends.filter((e) => Number.isFinite(e)));
    else span.end = Infinity;
  }

  const finiteEnd = Math.max(0, ...spans.map((s) => (Number.isFinite(s.end) ? s.end : s.call + (s.cycle ?? 0))));
  const valueAt = (path: string, prop: PropName, t: number): Value | undefined => {
    const g = groups.get(`${path}|${prop}`);
    if (!g) return undefined;
    let cur: Writer | null = null;
    for (const x of g) if (x.start <= t + 1e-9) cur = x;
    return cur ? evalAt(cur, t).value : base(path, prop);
  };

  // Copy on write: only the nodes on the way to what changes are copied (a game's UI has thousands of nodes).
  const hasGroups = writers.some((x) => x.prop === 'GroupTransparency');
  const sample = (t: number): LabNode[] => {
    const out = [...screens] as LabNode[];
    const copied = new Set<LabNode>();
    /** The node at a path in `out`, copied along the way so it can be changed. */
    const own = (path: string): LabNode | null => {
      const names = path.split('.');
      let i = out.findIndex((s) => s.name === names[0]);
      if (i < 0) return null;
      if (!copied.has(out[i]!)) {
        out[i] = { ...out[i]! };
        copied.add(out[i]!);
      }
      let n = out[i]!;
      for (const name of names.slice(1)) {
        const kids = n.kids ?? [];
        const k = kids.findIndex((c) => c.name === name);
        if (k < 0) return null;
        if (!copied.has(kids[k]!)) {
          const next = [...kids];
          next[k] = { ...kids[k]! };
          copied.add(next[k]!);
          n.kids = next;
        }
        n = n.kids![k]!;
      }
      return n;
    };
    // Added nodes alive at t, under their parents (or as new screens).
    const live = added.filter((a) => a.from <= t + 1e-9 && t < a.to - 1e-9);
    for (const a of live.filter((a) => a.parent === null)) {
      const copy = structuredClone({ ...a.node, kids: (a.node.kids ?? []).filter((c) => !added.some((l) => l.node === c)) }) as LabNode;
      out.push(copy);
      copied.add(copy);
      const mark = (n: LabNode) => {
        copied.add(n);
        n.kids?.forEach(mark);
      };
      mark(copy);
    }
    for (const a of live.filter((a) => a.parent !== null)) {
      const parent = own(a.parent!);
      if (!parent) continue;
      const copy = structuredClone(a.node) as LabNode;
      const mark = (n: LabNode) => {
        copied.add(n);
        n.kids?.forEach(mark);
      };
      mark(copy);
      parent.kids = [...(parent.kids ?? []), copy];
    }
    for (const [key, g] of groups) {
      let cur: Writer | null = null;
      for (const x of g) if (x.start <= t + 1e-9) cur = x;
      if (!cur) continue;
      const [path, prop] = key.split('|') as [string, PropName];
      const n = own(path);
      if (n) putProp(n, prop, evalAt(cur, t).value);
    }
    if (hasGroups)
      for (let i = 0; i < out.length; i++) {
        // A CanvasGroup's fade reaches every part inside: those subtrees are copied whole.
        const deep = (n: LabNode, outer: number): LabNode => {
          const g = 1 - (1 - outer) * (1 - (n.group ?? 0));
          if (g <= 0) return n.kids?.length ? { ...n, kids: n.kids.map((c) => deep(c, 0)) } : n;
          const copy = structuredClone(n) as LabNode;
          foldGroups(copy, outer);
          return copy;
        };
        out[i] = deep(out[i]!, 0);
      }
    return out;
  };

  return {
    device: dev,
    ...(typeof opts.device === 'string' ? { deviceKey: opts.device } : opts.device === undefined ? { deviceKey: 'phone' as UiDevice } : {}),
    reduced,
    fps,
    motions: lab,
    spans,
    skipped,
    end: finiteEnd,
    sample,
    valueAt,
    baseValue: (path, prop) => (nodeAt(path) ? base(path, prop) : undefined),
    propsOf: (index) => {
      const seen = new Set<string>();
      const out: Array<{ path: string; prop: PropName }> = [];
      for (const x of writers)
        if (x.motion === index && !seen.has(`${x.path}|${x.prop}`)) {
          seen.add(`${x.path}|${x.prop}`);
          out.push({ path: x.path, prop: x.prop });
        }
      return out;
    },
    layoutAt: (t) => {
      const shot = sample(t);
      return shot.filter((s) => s.enabled !== false).flatMap((s) => layoutScreen(s, dev));
    },
    trackOf: (index) => {
      const pr = spans[index]?.primary;
      if (!pr) return null;
      const w = writers.find((x) => x.motion === index && x.path === pr.path && x.prop === pr.prop && x.kind !== 'set');
      if (!w) return null;
      const from = valueNumbers(w.from ?? 0);
      const goal = w.kind === 'tween' || w.kind === 'curve' ? valueNumbers(w.goal!) : w.kind === 'spring' ? (w.run?.goal ?? null) : w.kind === 'path' ? (w.points?.[w.points.length - 1] ?? null) : null;
      return { path: w.path, prop: w.prop, start: w.start, end: Math.min(w.end, w.cut ?? Infinity), from, goal };
    },
    settleOf: (index) => {
      const sp = writers.filter((x) => x.motion === index && x.kind === 'spring');
      if (!sp.length) return null;
      return Math.max(...sp.map((x) => (x.run?.settled ? x.start + x.run.settled / fps : Infinity)));
    },
  };
}

/** A CanvasGroup's GroupTransparency fades everything inside it (folded into each part; overlaps blend a little differently). */
function foldGroups(n: LabNode, outer: number): void {
  const g = 1 - (1 - outer) * (1 - (n.group ?? 0));
  if (g > 0) {
    const f = (t: number | undefined, d: number) => 1 - (1 - (t ?? d)) * (1 - g);
    if (n.bg) n.bgT = f(n.bgT, 0);
    if (n.text !== undefined) n.textT = f(n.textT, 0);
    if (n.image) n.imageT = f(n.imageT, 0);
    if (n.strokes) n.strokes = n.strokes.map((s) => ({ ...s, t: f(s.t, 0) }));
    if (n.stroke) n.stroke = { ...n.stroke, t: f(n.stroke.t, 0) };
    if (n.shadow) n.shadow = { ...n.shadow, t: f(n.shadow.t, 0) };
  }
  for (const c of n.kids ?? []) foldGroups(c, g);
}

/** The screens at time t with the moves applied (copies where they change; compiles every call, so keep a timeline for many samples). */
export function sampleAt(screens: UiNode[], motions: Array<LabMotion | MockMotion>, t: number, opts: CompileOptions = {}): LabNode[] {
  return compileMotion(screens, motions, opts).sample(t);
}

/** A press and its release on an element with states, as Ui.react plays them (the release `hold` seconds later). */
export const pressAndRelease = (target: string, at = 0, hold = 0.12): LabMotion[] => [
  { kind: 'react', target, at, states: ['hover', 'press'], label: `press ${target}` },
  { kind: 'react', target, at: at + hold, states: ['hover'], label: `release ${target}` },
];
