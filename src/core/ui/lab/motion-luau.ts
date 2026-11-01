import { EASING_STYLES, PUNCH, SHAKE, SPRING_DEFAULT, runSpring, robloxEase, speedFor, tweenLength, type EasingDirection, type EasingStyle, type MotionIntent, type TweenSpec } from './motion-sim';
import { checkFeel, type FeelFinding, type MotionFacts } from './feel';

/**
 * A game's UI motion read from its Luau, statically: TweenInfo.new(...) wherever it is made (inline or as a named
 * token, resolved through local easing aliases and number constants), the tween calls that use it (TweenService:Create,
 * Motion.tween, scope:loop and the game's own wrappers) with their goal's properties, and the Motion module's calls
 * (spring, punch, shake, enter, count, transition, scope pulse/float/spin/shimmer). Each becomes MotionFacts for the
 * feel rules, with what it is for guessed from names (OPEN/CLOSE, function show/hide, MouseEnter…) and goals (a fade
 * to 1 leaves, a scale to 0 leaves). Only what the code states is judged: a duration from a variable stays unknown.
 * Not a Luau parser: comments and strings are blanked, then calls are matched by balanced brackets.
 */

/** One move found in code. */
export interface LuauMove extends MotionFacts {
  file: string;
  line: number;
  /** The call it was found in ("TweenService:Create", "Motion.spring", "scope:loop"). */
  callee: string;
  /** The token's name (a TweenInfo assigned to OPEN, Theme.tween.slow). */
  name?: string;
  /** The enclosing function or event ("open", "MouseEnter"). */
  context?: string;
  /** It animates UI (GUI properties), 3D or sound (false), or can't tell (null). */
  ui: boolean | null;
  /** Its duration comes from a variable or an expression. */
  dynamic: boolean;
  /** The source line, trimmed. */
  code: string;
}

// ─── Scanning helpers ─────────────────────────────────────────────────────────────────────────────

/** The source with comments blanked and string contents replaced by "_" (same length, newlines kept). */
export function blankLuau(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (a: number, b: number, keepEnds = false) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n' && !(keepEnds && (k === a || k === b - 1))) out[k] = keepEnds ? '_' : ' ';
  };
  const longEnd = (at: number): number => {
    // [[ ... ]] or [==[ ... ]==]
    const m = /^\[(=*)\[/.exec(src.slice(at, at + 20));
    if (!m) return -1;
    const close = `]${m[1]}]`;
    const e = src.indexOf(close, at + m[0].length);
    return e < 0 ? n : e + close.length;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '-' && src[i + 1] === '-') {
      const le = src[i + 2] === '[' ? longEnd(i + 2) : -1;
      const e = le >= 0 ? le : (src.indexOf('\n', i) + 1 || n) - (src.indexOf('\n', i) >= 0 ? 1 : 0);
      blank(i, e);
      i = e;
    } else if (c === '"' || c === "'" || c === '`') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      for (let j = i + 1; j < Math.min(k, n); j++) out[j] = '_';
      i = k + 1;
    } else if (c === '[' && (src[i + 1] === '[' || src[i + 1] === '=')) {
      const e = longEnd(i);
      if (e < 0) i++;
      else {
        for (let j = i + 1; j < e - 1; j++) if (out[j] !== '\n') out[j] = '_';
        i = e;
      }
    } else i++;
  }
  return out.join('');
}

const OPEN: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
/** The index of the bracket closing the one at `at` (in blanked code), or -1. */
function closing(code: string, at: number): number {
  const stack: string[] = [];
  for (let i = at; i < code.length; i++) {
    const c = code[i]!;
    if (OPEN[c]) stack.push(OPEN[c]!);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** The top-level comma-separated parts of code[a, b) as [start, end) ranges. */
function splitTop(code: string, a: number, b: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let s = a;
  for (let i = a; i < b; i++) {
    const c = code[i]!;
    if (OPEN[c]) depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push([s, i]);
      s = i + 1;
    }
  }
  if (b > s || parts.length) parts.push([s, b]);
  return parts.filter(([x, y]) => code.slice(x, y).trim().length > 0 || parts.length > 1);
}

/** A number an expression states: a literal, a known constant, `x or N` (N, dynamic), `if c then A else B` (both). */
interface Num {
  values: number[];
  dynamic: boolean;
}
function evalNum(expr: string, consts: Map<string, number>): Num | null {
  const e = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(e)) return { values: [Number(e)], dynamic: false };
  if (/^-?[A-Za-z_][\w.]*$/.test(e)) {
    const neg = e.startsWith('-');
    const v = consts.get(neg ? e.slice(1) : e);
    return v !== undefined ? { values: [neg ? -v : v], dynamic: false } : null;
  }
  const ifm = /^if\s+.+?\s+then\s+(.+?)\s+else\s+(.+)$/s.exec(e);
  if (ifm) {
    const a = evalNum(ifm[1]!, consts);
    const b = evalNum(ifm[2]!, consts);
    if (a && b) return { values: [...a.values, ...b.values], dynamic: a.dynamic || b.dynamic };
    return null;
  }
  const orm = /^(.+)\s+or\s+(-?(?:\d+\.?\d*|\.\d+))$/s.exec(e);
  if (orm) return { values: [Number(orm[2])], dynamic: true };
  const div = /^(-?(?:\d+\.?\d*|\.\d+))\s*\/\s*(\d+\.?\d*)$/.exec(e);
  if (div) return { values: [Number(div[1]) / Number(div[2])], dynamic: false };
  return null;
}

/** Words of a name: OPEN_FAST, slideIn, onMouseEnter → open fast / slide in / on mouse enter. */
const words = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);

const OPEN_W = new Set(['open', 'opening', 'show', 'shown', 'appear', 'reveal', 'enter', 'in', 'expand', 'intro', 'arrive', 'pop', 'popin', 'slidein', 'fadein', 'grow', 'unfold']);
const CLOSE_W = new Set(['close', 'closing', 'hide', 'hidden', 'exit', 'out', 'leave', 'leaving', 'dismiss', 'collapse', 'disappear', 'away', 'slideout', 'fadeout', 'shrink', 'vanish']);
const HOVER_W = new Set(['hover', 'hovered', 'focus', 'lit', 'lift', 'highlight']);
const PRESS_W = new Set(['press', 'pressed', 'pressing', 'tap', 'dip']);
const RELEASE_W = new Set(['release', 'released', 'unpress']);
/** Input events: what a tween in their handler answers. */
const EVENTS: Record<string, MotionIntent> = { MouseEnter: 'hover', MouseLeave: 'release', SelectionGained: 'hover', SelectionLost: 'release', MouseButton1Down: 'press', InputBegan: 'press', TouchTap: 'press', MouseButton1Up: 'release', InputEnded: 'release', Activated: 'release', MouseButton1Click: 'release' };
/** Effects, not screens: flashes, floating numbers, particles, stamps. Timing rules for opening and closing don't fit them. */
const EFFECT_W = new Set(['flash', 'ghost', 'confetti', 'particle', 'particles', 'spark', 'sparkle', 'debris', 'shard', 'star', 'stars', 'burst', 'trail', 'popup', 'delta', 'gain', 'bonus', 'damage', 'dmg', 'hit', 'crit', 'combo', 'kill', 'feed', 'killfeed', 'toast', 'notif', 'notification', 'float', 'floating', 'rise', 'rising', 'number', 'numbers', 'xp', 'coin', 'coins', 'ping', 'marker', 'indicator', 'hint', 'slam', 'stamp', 'impact', 'land', 'landing', 'drop', 'squash', 'ripple', 'wave', 'ring', 'shine', 'sheen', 'sweep', 'reel', 'knob', 'thumb', 'stick', 'cursor', 'pointer', 'fx', 'vfx', 'cutin', 'banner', 'callout', 'word', 'words', 'text']);
const LOOP_W = new Set(['bob', 'breathe', 'pulse', 'float', 'spin', 'idle', 'glow', 'blink', 'loop', 'throb', 'beat', 'shimmer', 'sweep', 'bounce']);
const PROGRESS_W = new Set(['fill', 'bar', 'progress', 'timer', 'cooldown', 'meter', 'charge', 'load', 'loading', 'xp', 'hp', 'health', 'stamina', 'energy', 'gauge', 'countdown', 'remaining', 'trail', 'drain']);
const HERO_RE = /loading|title|intro|splash|cutscene|reward|victory|winmoment|end ?screen|\bwin\b|levelup|level ?up|prestige|unbox|gacha|egg|celebrat|killcam|results|roundend|round ?end|podium|credits|showcase|cutin|cut ?in|banner|spotlight|guide|tutorial/i;

const GUI_PROPS = new Set(['BackgroundTransparency', 'TextTransparency', 'ImageTransparency', 'TextStrokeTransparency', 'GroupTransparency', 'ScrollBarImageTransparency', 'BackgroundColor3', 'TextColor3', 'ImageColor3', 'TextStrokeColor3', 'Scale', 'AnchorPoint', 'TextSize', 'Rotation', 'Offset', 'ImageRectOffset', 'CanvasPosition', 'Thickness', 'MaxVisibleGraphemes']);
const NOT_UI = new Set(['CFrame', 'FieldOfView', 'Brightness', 'Volume', 'PlaybackSpeed', 'Density', 'Haze', 'Glare', 'Range', 'Intensity', 'Saturation', 'Contrast', 'TintColor', 'ClockTime', 'ExposureCompensation', 'GlobalWind', 'Orientation', 'Value', 'Size3', 'Angle', 'Color', 'Ambient', 'OutdoorAmbient', 'FogEnd', 'FogStart', 'Speed', 'Velocity', 'WalkSpeed', 'Pitch', 'Offset3']);

const STYLE_SET = new Set<string>(EASING_STYLES);

export interface LuauFile {
  path: string;
  source: string;
}

interface InfoDef {
  name: string;
  spec: TweenSpec;
  dynamic: boolean;
  /** Duration candidates (an if/else). */
  times: number[];
  line: number;
  file: string;
}

/** Everything the scan of one file needs: blanked code, line starts, aliases, constants. */
interface Ctx {
  file: string;
  src: string;
  code: string;
  lines: number[];
  styles: Map<string, EasingStyle>;
  dirs: Map<string, EasingDirection>;
  consts: Map<string, number>;
  reduced: boolean;
  hero: boolean;
}

function context(file: string, src: string): Ctx {
  const code = blankLuau(src);
  const lines = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lines.push(i + 1);
  const styles = new Map<string, EasingStyle>();
  const dirs = new Map<string, EasingDirection>();
  for (const m of code.matchAll(/local\s+([\w,\s]+?)\s*=\s*((?:Enum\.Easing(?:Style|Direction)\.\w+\s*,?\s*)+)/g)) {
    const names = m[1]!.split(',').map((s) => s.trim());
    const vals = m[2]!.split(',').map((s) => s.trim());
    names.forEach((nm, i) => {
      const v = vals[i];
      const sm = v && /Enum\.EasingStyle\.(\w+)/.exec(v);
      const dm = v && /Enum\.EasingDirection\.(\w+)/.exec(v);
      if (sm && STYLE_SET.has(sm[1]!)) styles.set(nm, sm[1] as EasingStyle);
      if (dm && ['In', 'Out', 'InOut'].includes(dm[1]!)) dirs.set(nm, dm[1] as EasingDirection);
    });
  }
  const consts = new Map<string, number>();
  for (const m of code.matchAll(/(?:^|\n)\s*(?:local\s+)?([A-Za-z_][\w.]*)\s*(?::\s*number\s*)?=\s*(-?(?:\d+\.?\d*|\.\d+))\s*(?:--|\n|$)/g)) consts.set(m[1]!, Number(m[2]));
  // Fields of constant tables: `X = 0.3,` inside a table (MIX.HumFade stays unknown unless it is a plain field).
  for (const m of code.matchAll(/\n\s*([A-Za-z_]\w*)\s*=\s*(-?(?:\d+\.?\d*|\.\d+))\s*,/g)) if (!consts.has(m[1]!)) consts.set(m[1]!, Number(m[2]));
  return { file, src, code, lines, styles, dirs, consts, reduced: /reduced\s*\(|ReducedMotionEnabled|reducedMotion|ReduceMotion|setReduced/i.test(code), hero: HERO_RE.test(file) };
}

const lineAt = (c: Ctx, at: number): number => {
  let lo = 0;
  let hi = c.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.lines[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};
const lineText = (c: Ctx, line: number) => c.src.slice(c.lines[line - 1]!, c.lines[line] ?? c.src.length).trim();

/** The function or event handler a position sits in: the nearest less-indented line that opens one. */
function enclosing(c: Ctx, at: number): string | undefined {
  const line = lineAt(c, at);
  const indentOf = (l: number) => /^[\t ]*/.exec(c.code.slice(c.lines[l - 1]!, c.lines[l] ?? c.code.length))![0].replace(/\t/g, '    ').length;
  let want = indentOf(line);
  for (let l = line; l >= 1 && l > line - 400; l--) {
    const text = c.code.slice(c.lines[l - 1]!, c.lines[l] ?? c.code.length);
    if (!text.trim()) continue;
    const ind = indentOf(l);
    if (ind >= want && l !== line) continue;
    const fn = /function\s+([\w.:]+)\s*\(/.exec(text) ?? /([\w.]+)\s*=\s*function\s*\(/.exec(text);
    const ev = /\.(\w+)\s*:\s*(?:Connect|Once)\s*\(\s*function/.exec(text);
    if (ev) return ev[1];
    if (fn) return fn[1];
    // An anonymous callback (task.delay(…, function()): a later phase whose purpose its outer name doesn't tell.
    if (/function\s*\(/.test(text)) return undefined;
    want = Math.min(want, ind);
  }
  return undefined;
}

/** Reads TweenInfo.new's arguments at `open` (the "(" index). */
function readInfo(c: Ctx, open: number, close: number): { spec: TweenSpec; dynamic: boolean; times: number[] } | null {
  const args = splitTop(c.code, open + 1, close).map(([a, b]) => c.code.slice(a, b).trim());
  const time = args[0] !== undefined ? evalNum(args[0], c.consts) : { values: [1], dynamic: false };
  const styleOf = (s: string | undefined): EasingStyle | undefined => {
    if (!s) return undefined;
    const m = /Enum\.EasingStyle\.(\w+)/.exec(s);
    if (m && STYLE_SET.has(m[1]!)) return m[1] as EasingStyle;
    return c.styles.get(s.trim());
  };
  const dirOf = (s: string | undefined): EasingDirection | undefined => {
    if (!s) return undefined;
    const m = /Enum\.EasingDirection\.(\w+)/.exec(s);
    if (m) return m[1] as EasingDirection;
    return c.dirs.get(s.trim());
  };
  const style = args[1] === undefined ? 'Quad' : styleOf(args[1]);
  const direction = args[2] === undefined ? 'Out' : dirOf(args[2]);
  const repeat = args[3] === undefined ? 0 : (evalNum(args[3], c.consts)?.values[0] ?? 0);
  const reverses = args[4] === undefined ? false : args[4] === 'true';
  const delay = args[5] === undefined ? 0 : (evalNum(args[5], c.consts)?.values[0] ?? 0);
  if (args[1] !== undefined && !style) return null;
  if (args[2] !== undefined && !direction) return null;
  return { spec: { time: time?.values[0] ?? NaN, style: style ?? 'Quad', direction: direction ?? 'Out', repeat, reverses, delay }, dynamic: !time || time.dynamic, times: time?.values ?? [] };
}

/** The keys of a table constructor `{ A = 1, ["B"] = 2 }` (code range inside the braces). */
function tableKeys(c: Ctx, a: number, b: number): Array<{ key: string; value: string }> {
  return splitTop(c.code, a, b).flatMap(([x, y]) => {
    const part = c.code.slice(x, y);
    const m = /^\s*(?:\[\s*"?([\w]+)"?\s*\]|([A-Za-z_]\w*))\s*=\s*/.exec(part);
    if (!m) return [];
    const key = m[1] ?? m[2]!;
    return [{ key, value: c.src.slice(x + m[0].length, y).trim() }];
  });
}

/** A call around position `at` (an argument of it): its callee text, argument ranges, and which argument holds `at`. */
function callAround(c: Ctx, at: number): { callee: string; args: Array<[number, number]>; index: number; open: number; close: number } | null {
  let depth = 0;
  for (let i = at - 1; i >= 0 && i > at - 4000; i--) {
    const ch = c.code[i]!;
    if (ch === ')' || ch === '}' || ch === ']') depth++;
    else if (ch === '(' || ch === '{' || ch === '[') {
      if (depth === 0) {
        if (ch !== '(') return null;
        const m = /([A-Za-z_][\w.:]*(?:\s*\[[^\]]*\])?)\s*$/.exec(c.code.slice(Math.max(0, i - 120), i));
        if (!m) return null;
        const close = closing(c.code, i);
        if (close < 0) return null;
        const args = splitTop(c.code, i + 1, close);
        const index = args.findIndex(([a, b]) => at >= a && at < b);
        return { callee: m[1]!.replace(/\s+/g, ''), args, index, open: i, close };
      }
      depth--;
    }
  }
  return null;
}

/**
 * What a tween is for. Names say it (the TweenInfo's name, then the enclosing function or input event); the goal
 * says it too (a fade to 1 or a scale to 0 leaves, a fade to 0 or a scale set small and grown to 1 arrives). `sure`
 * only when a name or an event says it and the goal doesn't contradict it: rules about intent judge only those.
 * `effect`: the element is a flash, a floating number, a particle… (named so), where screen timing doesn't apply.
 */
function intentFor(info: { name?: string; spec: TweenSpec | null }, fn: string | undefined, target: string, file: string, goal: Array<{ key: string; value: string }>, prior: string): { intent: MotionIntent; sure: boolean; progress: boolean; hero: boolean; effect: boolean } {
  const keys = goal.map((g) => g.key);
  const val = (k: string) => goal.find((g) => g.key === k)?.value ?? '';
  const targetWords = words(target);
  const fnWords = fn && !EVENTS[fn] ? words(fn) : [];
  const nameWords = words(info.name?.split('.').pop() ?? '');
  const any = (ws: string[], set: Set<string>) => ws.some((w) => set.has(w));
  const progress = (keys.includes('Size') && (any([...targetWords, ...nameWords], PROGRESS_W) || info.spec?.style === 'Linear')) || (any(targetWords, PROGRESS_W) && keys.length > 0 && keys.every((k) => k === 'Size' || k === 'Position'));
  const hero = HERO_RE.test([info.name, fn, target].join(' '));
  const fileWords = words(file.split(/[\\/]/).pop()!.replace(/\.(client|server)?\.?luau?$/, '')).map((w) => w.replace(/s$/, ''));
  const effect = any([...targetWords, ...fnWords, ...nameWords, ...fileWords], EFFECT_W);
  const out = (intent: MotionIntent, sure: boolean) => ({ intent, sure, progress, hero, effect });
  if ((info.spec?.repeat ?? 0) < 0 || any(nameWords, LOOP_W)) return out('loop', true);
  if (progress) return out('progress', true);
  // What the goal says.
  const fades = keys.filter((k) => /Transparency$/.test(k));
  const fadeOut = fades.length > 0 && fades.every((k) => /^1(\.0*)?$/.test(val(k)));
  const fadeIn = fades.length > 0 && fades.every((k) => /^0(\.0*)?$/.test(val(k)));
  const scaleTo = val('Scale');
  const grownFromSmall = /^1(\.0*)?$/.test(scaleTo) && /\.Scale\s*=\s*(0?\.\d+|0)\s*(\n|$)/m.test(prior);
  const goalSays: MotionIntent | null = fadeOut || /^0(\.0*)?$/.test(scaleTo) ? 'exit' : fadeIn || grownFromSmall ? 'enter' : null;
  // What names say: the token, then the event or function around it.
  const byNames = (ws: string[]): MotionIntent | null => {
    if (any(ws, PRESS_W)) return 'press';
    if (any(ws, HOVER_W)) return 'hover';
    if (any(ws, RELEASE_W)) return 'release';
    const c = any(ws, CLOSE_W);
    const o = any(ws, OPEN_W);
    if (c && !o) return any(ws, new Set(['close', 'closing', 'collapse', 'dismiss'])) ? 'close' : 'exit';
    if (o && !c) return any(ws, new Set(['open', 'opening', 'expand'])) ? 'open' : 'enter';
    return null;
  };
  const named = byNames(nameWords) ?? (fn && EVENTS[fn] ? EVENTS[fn]! : byNames(fnWords));
  const leaving = (i: MotionIntent | null) => i === 'exit' || i === 'close';
  const arriving = (i: MotionIntent | null) => i === 'enter' || i === 'open';
  if (named && goalSays && ((leaving(named) && arriving(goalSays)) || (arriving(named) && leaving(goalSays)))) return out(goalSays, false);
  if (named) return out(named, true);
  if (goalSays) return out(goalSays, false);
  return out('other', false);
}

/** UI, not UI, or unknown, from the goal's properties and values. */
function uiOf(goal: Array<{ key: string; value: string }>, file: string): boolean | null {
  if (!goal.length) return null;
  if (goal.some((g) => NOT_UI.has(g.key))) return false;
  if (goal.some((g) => (g.key === 'Position' || g.key === 'Size') && (/Vector3|CFrame/.test(g.value) || /^-?[\d.]+$/.test(g.value)))) return false;
  if (goal.some((g) => GUI_PROPS.has(g.key))) return true;
  if (goal.some((g) => (g.key === 'Position' || g.key === 'Size') && /UDim2/.test(g.value))) return true;
  if (goal.some((g) => g.key === 'Position' || g.key === 'Size')) return /ui|gui|hud|menu|screen|shop|panel|toast|button|window|frame|card|overlay/i.test(file) ? true : null;
  if (goal.every((g) => g.key === 'Transparency')) return null;
  return null;
}

const springIntent = (goal: string, f: number, z: number): MotionIntent => {
  const s = Number(/Scale\s*=\s*([\d.]+)/.exec(goal)?.[1] ?? NaN);
  if (s < 1 && z >= 0.9) return 'press';
  if (s === 1) return 'release';
  if (s > 1) return 'hover';
  return f >= 8 ? 'press' : 'other';
};

/** Swings and still time of a spring that travels (simulated with the module's integrator). */
function springShape(from: number, goal: number, f: number, z: number, kick?: number): { overshootPct: number; swings: number; settle: number } {
  const r = runSpring([from], [goal], { frequency: f, damping: z, ...(kick !== undefined ? { v0: [kick] } : {}) });
  const travel = kick !== undefined ? Math.max(...r.frames.map((x) => Math.abs(x[0]! - goal))) : goal - from;
  const p = r.frames.map((x) => (kick !== undefined ? (x[0]! - goal) / travel : (x[0]! - from) / travel));
  const ref = kick !== undefined ? 0 : 1;
  let over = 0;
  const lobes: number[] = [];
  let sign = 0;
  let peak = 0;
  for (const v of p) {
    if (kick === undefined) over = Math.max(over, v - 1);
    const d = v - ref;
    const s = Math.abs(d) < 1e-9 ? sign : Math.sign(d);
    if (s !== sign && sign !== 0) {
      lobes.push(peak);
      peak = 0;
    }
    sign = s;
    peak = Math.max(peak, Math.abs(d));
  }
  lobes.push(peak);
  let still = 0;
  for (let i = p.length - 1; i >= 0; i--)
    if (Math.abs(p[i]! - ref) > 0.02) {
      still = (i + 1) / 60;
      break;
    }
  return { overshootPct: over * 100, swings: lobes.slice(1).filter((x) => x > 0.05).length, settle: still };
}

// ─── The scan ─────────────────────────────────────────────────────────────────────────────────────

/** Named TweenInfos of a file: `local X = TweenInfo.new(...)`, `T.x = ...`, `x = TweenInfo.new(...)` in a table. */
function infoDefs(c: Ctx): InfoDef[] {
  const out: InfoDef[] = [];
  for (const m of c.code.matchAll(/TweenInfo\.new\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closing(c.code, open);
    if (close < 0) continue;
    const before = c.code.slice(Math.max(0, m.index! - 160), m.index!);
    const asg = /(?:local\s+)?([A-Za-z_][\w.]*)\s*(?::\s*TweenInfo\s*)?=\s*$/.exec(before);
    if (!asg) continue;
    const info = readInfo(c, open, close);
    if (!info) continue;
    // A table field: qualify it with the table's name when it is assigned (`Theme.tween = {` … `slow = …`).
    let name = asg[1]!;
    if (!name.includes('.') && !/local\s+$/.test(before.slice(0, before.length - asg[0].length + 6)) && !/^\s*local/.test(asg[0])) {
      const tbl = enclosingTable(c, m.index!);
      if (tbl) name = `${tbl}.${name}`;
    }
    out.push({ name, spec: info.spec, dynamic: info.dynamic, times: info.times, line: lineAt(c, m.index!), file: c.file });
  }
  return out;
}

/** The name a table constructor around `at` is assigned to (`Motion.T = {`, `local QUICK = {`), if any. */
function enclosingTable(c: Ctx, at: number): string | null {
  let depth = 0;
  for (let i = at - 1; i >= 0 && i > at - 6000; i--) {
    const ch = c.code[i]!;
    if (ch === '}' || ch === ')' || ch === ']') depth++;
    else if (ch === '{' || ch === '(' || ch === '[') {
      if (depth === 0) {
        if (ch !== '{') return null;
        const m = /(?:local\s+)?([A-Za-z_][\w.]*)\s*(?::\s*[\w<>{}\s,]+)?=\s*$/.exec(c.code.slice(Math.max(0, i - 120), i));
        return m ? m[1]! : null;
      }
      depth--;
    }
  }
  return null;
}

/** Functions that tween whatever they are given with a raw TweenService tween and never check Reduce Motion (a game's own `play`). */
function rawWrappers(c: Ctx): string[] {
  if (c.reduced) return [];
  const out: string[] = [];
  for (const m of c.code.matchAll(/function\s+([\w.:]+)\s*\(\s*(\w+)\s*(?::[^,)]*)?,\s*(\w+)\s*(?::[^,)]*)?,\s*(\w+)/g)) {
    const body = c.code.slice(m.index!, m.index! + 600);
    const end = body.search(/\n\s*end\b/);
    const text = end > 0 ? body.slice(0, end) : body;
    if (new RegExp(`\\w+\\s*:\\s*Create\\s*\\(\\s*${m[2]}\\s*,\\s*${m[3]}\\s*,\\s*${m[4]}\\s*\\)`).test(text)) out.push(m[1]!.replace(':', '.'));
  }
  return out;
}

const MOTION_CALL = /(?:^|[^\w.:])((?:[\w]+\.)*Motion)\.(spring|punch|shake|enter|count|transition|curve|path|fly|swap)\s*\(/g;
const SCOPE_CALL = /([A-Za-z_][\w.]*)\s*:\s*(pulse|float|spin|shimmer|loop|keyframes|flipbook)\s*\(/g;

/**
 * Every UI move a set of Luau files states, as facts for the feel rules. Named tokens are found across the files
 * (a Style module's SLIDE_IN used by a screen), and so are wrappers that play raw tweens.
 */
export function scanLuau(files: LuauFile[]): LuauMove[] {
  const ctxs = files.map((f) => context(f.path, f.source));
  const defs = ctxs.flatMap(infoDefs);
  const byLast = new Map<string, InfoDef[]>();
  for (const d of defs) {
    const k = d.name.split('.').pop()!;
    byLast.set(k, [...(byLast.get(k) ?? []), d]);
  }
  const wrappers = new Set(ctxs.flatMap(rawWrappers));
  const out: LuauMove[] = [];
  const usedDefs = new Set<InfoDef>();

  for (const c of ctxs) {
    // The Motion module itself is the skill's, line for line: its tokens and internals are by the book.
    if (/(^|[\\/])Motion\.luau$/.test(c.file)) continue;
    // Server scripts can't see a player's Reduce Motion setting.
    const server = /(^|[\\/])Server[\\/]|\.server\.luau$/i.test(c.file);
    const push = (at: number, f: Omit<LuauMove, 'file' | 'line' | 'code' | 'where'> & { where?: string }) => {
      const line = lineAt(c, at);
      out.push({ ...f, where: f.where ?? `${c.file}:${line}`, file: c.file, line, code: lineText(c, line).slice(0, 200) });
    };
    const resolveDef = (expr: string, line: number): InfoDef | null => {
      const e = expr.trim().replace(/\s+or\s+.*$/s, '');
      if (!/^[A-Za-z_][\w.]*$/.test(e)) return null;
      const last = e.split('.').pop()!;
      const cands = byLast.get(last) ?? [];
      if (!cands.length) return null;
      // The same file first, then a full-name match, then a unique one.
      const local = cands.filter((d) => d.file === c.file && (d.name === e || d.name.endsWith(`.${e}`) || e.endsWith(`.${d.name}`) || d.name === last));
      // In the same file, the nearest definition above the use (locals shadow each other), else the first below.
      if (local.length) {
        const above = local.filter((d) => d.line <= line).sort((a, b) => b.line - a.line);
        return above[0] ?? local[0]!;
      }
      const full = cands.filter((d) => d.name === e || e.endsWith(`.${d.name}`) || d.name.endsWith(`.${e}`));
      if (full.length === 1) return full[0]!;
      const sig = new Set(cands.map((d) => JSON.stringify(d.spec)));
      return sig.size === 1 ? cands[0]! : null;
    };

    // Tween calls: (target, info, goal) where info is TweenInfo.new(...) or a named one.
    const seenCalls = new Set<number>();
    const tweenCall = (open: number, close: number, callee: string) => {
      if (seenCalls.has(open)) return;
      seenCalls.add(open);
      const args = splitTop(c.code, open + 1, close);
      if (args.length < 3) return;
      const infoText = c.code.slice(args[1]![0], args[1]![1]).trim();
      const goalText = c.code.slice(args[2]![0], args[2]![1]).trim();
      let spec: TweenSpec | null = null;
      let dynamic = false;
      let times: number[] = [];
      let name: string | undefined;
      const inl = /^(?:[\w.]+\s+or\s+)?TweenInfo\.new\s*\(/.exec(infoText);
      if (inl) {
        const o = args[1]![0] + c.code.slice(args[1]![0]).indexOf('TweenInfo.new') + 'TweenInfo.new'.length;
        const io = c.code.indexOf('(', o);
        const r = readInfo(c, io, closing(c.code, io));
        if (r) [spec, dynamic, times] = [r.spec, r.dynamic, r.times];
      } else {
        if (/(^|\.)Motion\.T\.\w+$/.test(infoText)) return; // the module's tokens: by the book
        const d = resolveDef(infoText, lineAt(c, open));
        if (d) {
          [spec, dynamic, times, name] = [d.spec, d.dynamic, d.times, d.name];
          usedDefs.add(d);
        }
      }
      if (!spec) return;
      const goalOpen = c.code.indexOf('{', args[2]![0]);
      const goal = goalText.startsWith('{') && goalOpen >= 0 ? tableKeys(c, goalOpen + 1, closing(c.code, goalOpen)) : [];
      const ui = uiOf(goal, c.file);
      if (ui === false) return;
      const target = c.src.slice(args[0]![0], args[0]![1]).trim();
      const ctxName = enclosing(c, open);
      const prior = c.code.slice(Math.max(0, open - 900), open);
      const it = intentFor({ ...(name ? { name } : {}), spec: /:\s*loop$/.test(callee) ? { ...spec, repeat: -1 } : spec }, ctxName, target, c.file, goal, prior.split('\n').slice(-12).join('\n'));
      const raw = /:\s*Create$/.test(callee) || wrappers.has(callee.replace(':', '.'));
      const scoped = /:\s*loop$/.test(callee);
      const loop = (spec.repeat ?? 0) < 0 || scoped;
      // A raw forever-loop played and never kept (TweenService:Create(...):Play()): nothing can stop it but
      // destroying its element. Kept ones (in a variable, a table) are assumed stopped somewhere.
      let stopped: boolean | null = scoped ? true : null;
      if (loop && !scoped && /:\s*Create$/.test(callee) && /^\s*\)\s*:\s*Play\s*\(/.test(c.code.slice(close, close + 16))) {
        const before = c.code.slice(Math.max(0, open - callee.length - 60), open - callee.length);
        if (!/[=,(]\s*$/.test(before) && !/return\s*$/.test(before)) stopped = false;
      }
      const t = spec.time;
      const facts: LuauMove = {
        where: `${c.file}:${lineAt(c, open)}`,
        file: c.file,
        line: lineAt(c, open),
        code: '',
        label: `${callee}(${target})`,
        kind: /:\s*loop$/.test(callee) ? 'loop' : raw ? 'raw' : 'tween',
        intent: it.intent,
        intentSure: it.sure,
        props: goal.map((g) => g.key),
        duration: Number.isFinite(t) && !dynamic ? tweenLength({ ...spec, delay: 0, repeat: loop ? 0 : spec.repeat }) : null,
        delay: spec.delay ?? 0,
        style: spec.style,
        direction: spec.direction,
        loop,
        cycle: loop && Number.isFinite(t) ? t * (spec.reverses ? 2 : 1) : null,
        overshootPct: overshootOfStyle(spec.style!, spec.direction!),
        raw,
        reducedChecked: c.reduced || server,
        stopped,
        progress: it.progress,
        hero: it.hero || c.hero,
        effect: it.effect,
        callee,
        ...(name ? { name } : {}),
        ...(ctxName ? { context: ctxName } : {}),
        ui,
        dynamic,
      };
      if (times.length > 1 && !dynamic) {
        // An if/else duration: judge the longer one (the rules look for slow).
        facts.duration = Math.max(...times) * (spec.reverses ? 2 : 1);
      }
      push(open, facts);
    };

    for (const m of c.code.matchAll(/TweenInfo\.new\s*\(/g)) {
      const call = callAround(c, m.index!);
      if (call && call.index === 1) tweenCall(call.open, call.close, call.callee);
    }
    // Calls with a named info as the second argument.
    for (const m of c.code.matchAll(/([A-Za-z_][\w.]*(?:\s*:\s*\w+)?)\s*\(/g)) {
      const callee = m[1]!.replace(/\s+/g, '');
      if (/^(function|if|while|for|return|local|TweenInfo\.new|print|warn|error|assert|require|typeof|type|pcall|task\.\w+|math\.\w+|table\.\w+|string\.\w+)$/.test(callee)) continue;
      if (!/(Create|tween|Tween|play|Play|loop|animate|Animate)$/.test(callee)) continue;
      const open = m.index! + m[0].length - 1;
      const close = closing(c.code, open);
      if (close < 0) continue;
      const args = splitTop(c.code, open + 1, close);
      if (args.length < 3) continue;
      const infoText = c.code.slice(args[1]![0], args[1]![1]).trim();
      if (/TweenInfo\.new/.test(infoText)) continue;
      if (/(^|\.)Motion\.T\.\w+$/.test(infoText) || !resolveDef(infoText, lineAt(c, open))) continue;
      tweenCall(open, close, callee);
    }

    // The Motion module's calls (not its own definitions).
    if (!/(^|[\\/])Motion\.luau$/.test(c.file))
      for (const m of c.code.matchAll(MOTION_CALL)) {
        const kind = m[2]!;
        const open = m.index! + m[0].length - 1;
        if (/function\s*$/.test(c.code.slice(Math.max(0, m.index! - 12), m.index! + 1))) continue;
        const close = closing(c.code, open);
        if (close < 0) continue;
        const args = splitTop(c.code, open + 1, close).map(([a, b]) => ({ code: c.code.slice(a, b).trim(), src: c.src.slice(a, b).trim(), a, b }));
        const target = args[0]?.src ?? '';
        const ctxName = enclosing(c, open);
        const base = { label: `Motion.${kind}(${target})`, callee: `Motion.${kind}`, reducedChecked: true, raw: false, ui: true, dynamic: false, ...(ctxName ? { context: ctxName } : {}), hero: c.hero || HERO_RE.test(ctxName ?? '') } as const;
        if (kind === 'spring') {
          const goal = args[1]?.code ?? '';
          const fs = args[2] ? evalNum(args[2].code, c.consts) : { values: [SPRING_DEFAULT.frequency], dynamic: false };
          const zs = args[3] ? evalNum(args[3].code, c.consts) : { values: [SPRING_DEFAULT.damping], dynamic: false };
          if (!fs || !zs) continue;
          const pairs = fs.values.length === zs.values.length ? fs.values.map((f, i) => [f, zs.values[i]!]) : fs.values.flatMap((f) => zs.values.map((z) => [f, z]));
          const scaleGoal = Number(/Scale\s*=\s*([\d.]+)/.exec(goal)?.[1] ?? NaN);
          for (const [f, z] of pairs) {
            const intent = springIntent(goal, f!, z!);
            // Shape over a typical travel: a press 1 → goal, a release 0.95 → 1.
            const from = intent === 'press' ? 1 : intent === 'release' ? 0.95 : 1;
            const to = Number.isFinite(scaleGoal) && scaleGoal !== from ? scaleGoal : intent === 'press' ? 0.95 : 1.05;
            const sh = springShape(from, to, f!, z!);
            push(open, { ...base, kind: 'spring', intent, intentSure: intent !== 'other', props: tableKeys(c, c.code.indexOf('{', args[1]?.a ?? open) + 1, closing(c.code, c.code.indexOf('{', args[1]?.a ?? open))).map((g) => g.key), duration: sh.settle, settle: sh.settle, delay: 0, spring: { frequency: f!, damping: z! }, loop: false, overshootPct: sh.overshootPct, swings: sh.swings });
          }
        } else if (kind === 'punch' || kind === 'shake') {
          const amt = args[1] ? evalNum(args[1].code, c.consts) : null;
          const k = kind === 'punch' ? PUNCH : SHAKE;
          const peak = amt?.values[0] ?? (kind === 'punch' ? PUNCH.amount : SHAKE.degrees);
          const sh = springShape(0, 0, k.frequency, k.damping, speedFor(peak, k.frequency, k.damping));
          push(open, { ...base, kind, intent: 'feedback', intentSure: true, props: [kind === 'punch' ? 'Scale' : 'Rotation'], duration: sh.settle, settle: sh.settle, delay: 0, spring: { frequency: k.frequency, damping: k.damping }, loop: false, swings: sh.swings, amount: peak });
        } else if (kind === 'enter') {
          const optOpen = args[1] ? c.code.indexOf('{', args[1].a) : -1;
          const opts = optOpen >= 0 && optOpen < (args[1]?.b ?? 0) ? tableKeys(c, optOpen + 1, closing(c.code, optOpen)) : [];
          const opt = (k: string) => opts.find((o) => o.key === k)?.value;
          const from = (opt('from') ?? '"up"').replace(/["']/g, '');
          const gap = evalNum(opt('gap') ?? '0.035', c.consts)?.values[0];
          const distance = evalNum(opt('distance') ?? '24', c.consts)?.values[0];
          const delay = evalNum(opt('delay') ?? '0', c.consts)?.values[0] ?? 0;
          const time = from === 'pop' ? 0.4 : 0.24;
          push(open, { ...base, kind: 'enter', intent: 'enter', intentSure: true, props: from === 'fade' ? ['BackgroundTransparency'] : from === 'pop' ? ['Scale'] : ['Position'], duration: time, delay, style: from === 'pop' ? 'Back' : 'Quint', direction: 'Out', loop: false, ...(gap !== undefined ? { stagger: { gap } } : {}), ...(distance !== undefined && from !== 'fade' && from !== 'pop' ? { distance } : {}) });
        } else if (kind === 'count') {
          const optOpen = args[3] ? c.code.indexOf('{', args[3].a) : -1;
          const opts = optOpen >= 0 && optOpen < (args[3]?.b ?? 0) ? tableKeys(c, optOpen + 1, closing(c.code, optOpen)) : [];
          const secs = opts.find((o) => o.key === 'seconds');
          const s = secs ? evalNum(secs.value, c.consts) : null;
          push(open, { ...base, kind: 'count', intent: 'count', intentSure: true, props: ['Text'], duration: s && !s.dynamic ? Math.max(...s.values) : null, delay: 0, style: 'Quad', direction: 'Out', loop: false, dynamic: !s || s.dynamic });
        } else if (kind === 'transition') {
          const optArg = args[1];
          const optOpen = optArg ? c.code.indexOf('{', optArg.a) : -1;
          const opts = optOpen >= 0 && optArg && optOpen < optArg.b ? tableKeys(c, optOpen + 1, closing(c.code, optOpen)) : [];
          const secs = opts.find((o) => o.key === 'seconds');
          const s = secs ? evalNum(secs.value, c.consts) : { values: [0.3], dynamic: false };
          const half = s ? Math.max(...s.values) : null;
          push(open, { ...base, kind: 'transition', intent: 'transition', intentSure: true, props: ['BackgroundTransparency'], duration: half !== null ? 2 * half : null, delay: 0, loop: false, inputBlocking: half !== null ? 2 * half : undefined, dynamic: !s || s.dynamic });
        } else if (kind === 'curve' || kind === 'path') {
          const secArg = kind === 'curve' ? args[1] : args[2];
          const s = secArg ? evalNum(secArg.code, c.consts) : null;
          push(open, { ...base, kind, intent: 'hero', intentSure: false, props: ['Position'], duration: s && !s.dynamic ? Math.max(...s.values) : null, delay: 0, loop: false, hero: true, dynamic: !s || s.dynamic });
        } else if (kind === 'fly' || kind === 'swap') {
          push(open, { ...base, kind, intent: kind === 'fly' ? 'emphasis' : 'page', intentSure: true, props: ['Position'], duration: kind === 'swap' ? 0.2 : 0.85, delay: 0, loop: false, ...(kind === 'swap' ? { style: 'Quint' as const, direction: 'Out' as const } : {}) });
        }
      }

    // Scope loops: scope:pulse(target, amount, seconds), :float(target, px, seconds), :spin(target, s), :shimmer(target, every).
    if (!/(^|[\\/])Motion\.luau$/.test(c.file))
      for (const m of c.code.matchAll(SCOPE_CALL)) {
        const kind = m[2]! as 'pulse' | 'float' | 'spin' | 'shimmer' | 'loop' | 'keyframes' | 'flipbook';
        if (kind === 'loop' || kind === 'keyframes' || kind === 'flipbook') continue;
        if (/function\s*[\w.]*$/.test(c.code.slice(Math.max(0, m.index! - 30), m.index!))) continue;
        const open = m.index! + m[0].length - 1;
        const close = closing(c.code, open);
        if (close < 0) continue;
        const args = splitTop(c.code, open + 1, close).map(([a, b]) => c.code.slice(a, b).trim());
        const num = (i: number) => (args[i] !== undefined ? evalNum(args[i]!, c.consts) : null);
        const ctxName = enclosing(c, open);
        const amount = kind === 'pulse' ? (num(1)?.values[0] ?? 0.06) : kind === 'float' ? (num(1)?.values[0] ?? 6) : undefined;
        const secs = kind === 'pulse' ? num(2) : kind === 'float' ? num(2) : kind === 'spin' ? num(1) : num(1);
        const def = kind === 'pulse' ? 1.2 : kind === 'float' ? 2.4 : kind === 'spin' ? 6 : 3;
        const cycle = secs ? Math.min(...secs.values) : args[kind === 'spin' || kind === 'shimmer' ? 1 : 2] === undefined ? def : null;
        push(open, { label: `${m[1]}:${kind}(${args[0] ?? ''})`, callee: `scope:${kind}`, kind, intent: 'loop', intentSure: true, props: kind === 'pulse' ? ['Scale'] : kind === 'float' ? ['Position'] : kind === 'spin' ? ['Rotation'] : ['Offset'], duration: cycle, delay: 0, loop: true, cycle, ...(amount !== undefined ? { amount } : {}), reducedChecked: true, raw: false, stopped: true, ui: true, dynamic: cycle === null, hero: c.hero || HERO_RE.test(ctxName ?? ''), ...(ctxName ? { context: ctxName } : {}) });
      }
  }

  // Closes learn the duration of their open: tokens whose names differ only by the open/close word, in one file.
  const PAIR: Record<string, string> = { close: 'open', hide: 'show', out: 'in', exit: 'enter', leave: 'enter', collapse: 'expand', slideout: 'slidein', fadeout: 'fadein' };
  for (const mv of out) {
    if (!mv.name || !(mv.intent === 'close' || mv.intent === 'exit')) continue;
    const ws = words(mv.name.split('.').pop()!);
    const swapped = ws.map((w) => PAIR[w] ?? w).join(' ');
    if (swapped === ws.join(' ')) continue;
    const twin = defs.find((d) => d.file === mv.file && words(d.name.split('.').pop()!).join(' ') === swapped);
    if (twin && Number.isFinite(twin.spec.time) && !twin.dynamic) mv.openDuration = twin.spec.time;
  }
  return out;
}

/** How far past its goal a TweenService style goes, as % of the travel (0 for those that don't). */
export function overshootOfStyle(style: EasingStyle, direction: EasingDirection): number {
  let max = 0;
  for (let i = 0; i <= 400; i++) max = Math.max(max, robloxEase(style, direction, i / 400) - 1);
  return Math.round(max * 1000) / 10;
}

export interface LuauFeel {
  moves: LuauMove[];
  findings: Array<FeelFinding & { file: string; line: number; code: string }>;
}

/** Scans files and runs the feel rules on their UI moves (those that are clearly not UI are left out). */
export function luauFeel(files: LuauFile[]): LuauFeel {
  const moves = scanLuau(files).filter((m) => m.ui !== false);
  const findings = checkFeel(moves.filter((m) => m.ui === true)).map((f) => {
    const mv = moves.find((m) => m.where === f.path)!;
    return { ...f, file: mv.file, line: mv.line, code: mv.code };
  });
  return { moves, findings };
}
