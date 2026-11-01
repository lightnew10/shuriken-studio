/**
 * Reading a provider's rate-limit windows (five-hour, weekly, …), shared by the engine and the UI.
 *
 * A provider reports a window only when its status changes, so a reading stays in memory until the
 * window resets and says nothing about the account afterwards. Anything that shows or acts on a
 * utilization goes through these helpers so an expired reading is never mistaken for a current one.
 */

/** The part of a usage window these helpers read. `resetsAt` is epoch SECONDS (the provider's own unit). */
export interface UsageWindowReading {
  /** How much of the window is used, as a fraction (0–1). */
  utilization: number | null;
  resetsAt?: number | null;
}

/**
 * True once the window's reset time has passed: the reading no longer describes the account. A window
 * whose reset time is unknown never expires by itself.
 */
export function windowExpired(w: { resetsAt?: number | null }, nowMs: number): boolean {
  return typeof w.resetsAt === 'number' && w.resetsAt > 0 && w.resetsAt * 1000 <= nowMs;
}

/** The windows that still describe the account at `nowMs` (those whose reset time has not passed). */
export function liveWindows<W extends { resetsAt?: number | null }>(windows: Record<string, W>, nowMs: number): Array<[string, W]> {
  return Object.entries(windows).filter(([, w]) => !windowExpired(w, nowMs));
}

/**
 * The highest utilization (0–1) among the windows that have not reset yet, or null when none of them
 * reports one. Null is "nothing known", not 0%: callers choose what to show for it.
 */
export function liveUtilization(windows: Record<string, UsageWindowReading>, nowMs: number): number | null {
  let peak: number | null = null;
  for (const [, w] of liveWindows(windows, nowMs)) {
    if (typeof w.utilization === 'number' && Number.isFinite(w.utilization) && (peak === null || w.utilization > peak)) peak = w.utilization;
  }
  return peak;
}

/** One window as the accounts menu shows it. */
export interface UsageLine {
  /** The whole line, e.g. "5 h: 42% · resets 3:20 PM" or "5 h: no reading yet". */
  text: string;
  /** Percent used (0–100, whole numbers), or null when the provider gave none. */
  percent: number | null;
  /** When the window resets (epoch ms), or null when unknown. */
  resetsAtMs: number | null;
  /** False when there is no live reading for the window at all. */
  known: boolean;
}

/** What the accounts menu shows for one account: its five-hour window, and its weekly window when known. */
export interface AccountUsageSummary {
  fiveHour: UsageLine;
  weekly: UsageLine | null;
}

/** Why an account can say "no reading yet" without being unused: the provider only reports on thresholds and limits. */
export const NO_READING_HINT = 'Claude only reports a usage window when it nears a threshold or a limit is hit, so "no reading yet" does not mean the account is unused.';

const FIVE_HOUR_KEY = /five|5h|hour/i;
const WEEKLY_KEY = /seven|week|7d|7_day/i;
const MODEL_KEY = /opus|sonnet|haiku/i;

/** Which window a provider's key names: the 5-hour session window, a weekly one (any model's), or something else. */
export function windowKind(key: string): 'five_hour' | 'weekly' | 'other' {
  return WEEKLY_KEY.test(key) ? 'weekly' : FIVE_HOUR_KEY.test(key) ? 'five_hour' : 'other';
}

/** Clock text without the narrow no-break space newer ICU puts before AM/PM. */
const plain = (s: string) => s.replace(/[  ]/g, ' ');

/**
 * When something happens, as a person reads it: "3:20 PM" today, "Sun 9:00 AM" on another day (a weekly window
 * resets days away). `opts.locale` / `opts.timeZone` make it reproducible (tests); by default it follows the machine.
 */
export function clockText(ms: number, nowMs: number, opts: { locale?: string; timeZone?: string } = {}): string {
  const d = new Date(ms);
  const time = plain(d.toLocaleTimeString(opts.locale, { hour: 'numeric', minute: '2-digit', timeZone: opts.timeZone }));
  const day = (x: Date) => x.toLocaleDateString(opts.locale, { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: opts.timeZone });
  return day(d) === day(new Date(nowMs)) ? time : `${plain(d.toLocaleDateString(opts.locale, { weekday: 'short', timeZone: opts.timeZone }))} ${time}`;
}

/** The window of a kind (matched by its key) among the live ones: the general one first, then the most used. */
function pickWindow<W extends UsageWindowReading>(windows: Record<string, W>, nowMs: number, kind: RegExp): [string, W] | null {
  const live = liveWindows(windows, nowMs).filter(([key]) => kind.test(key));
  const general = live.filter(([key]) => !MODEL_KEY.test(key));
  const pool = general.length > 0 ? general : live;
  let best: [string, W] | null = null;
  const score = (w: W) => (typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? w.utilization : -1);
  for (const entry of pool) if (best === null || score(entry[1]) > score(best[1])) best = entry;
  return best;
}

/**
 * The accounts menu's usage lines for one account's windows (`windows` is that account's own: usage keys are
 * per account). Windows whose reset time has passed do not count. The five-hour line is always present
 * ("no reading yet" when the provider has not reported one); the weekly line only when a weekly window is live.
 * `opts.locale` / `opts.timeZone` make the clock text reproducible (tests); by default it follows the machine.
 */
export function formatAccountUsage(
  windows: Record<string, UsageWindowReading>,
  nowMs: number,
  opts: { locale?: string; timeZone?: string } = {},
): AccountUsageSummary {
  // A weekly reset on another day says which one.
  const fmt = (ms: number, withDay: boolean): string => (withDay ? clockText(ms, nowMs, opts) : plain(new Date(ms).toLocaleTimeString(opts.locale, { hour: 'numeric', minute: '2-digit', timeZone: opts.timeZone })));
  const line = (label: string, picked: [string, UsageWindowReading] | null, withDay: boolean): UsageLine => {
    if (!picked) return { text: `${label}: no reading yet`, percent: null, resetsAtMs: null, known: false };
    const [, w] = picked;
    const percent = typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? Math.min(100, Math.max(0, Math.round(w.utilization * 100))) : null;
    const resetsAtMs = typeof w.resetsAt === 'number' && w.resetsAt > 0 ? w.resetsAt * 1000 : null;
    const parts: string[] = [];
    if (percent !== null) parts.push(`${percent}%`);
    else if (resetsAtMs === null) return { text: `${label}: no reading yet`, percent: null, resetsAtMs: null, known: false };
    else parts.push('% not reported');
    if (resetsAtMs !== null) parts.push(`resets ${fmt(resetsAtMs, withDay)}`);
    return { text: `${label}: ${parts.join(' · ')}`, percent, resetsAtMs, known: true };
  };
  const fiveHour = line('5 h', pickWindow(windows, nowMs, FIVE_HOUR_KEY), false);
  const weeklyPick = pickWindow(windows, nowMs, WEEKLY_KEY);
  // A weekly limit of one model says so ("Week (opus)"): it is not the account's whole week.
  const model = weeklyPick ? MODEL_KEY.exec(weeklyPick[0])?.[0].toLowerCase() : undefined;
  const weekly = weeklyPick ? line(model ? `Week (${model})` : 'Week', weeklyPick, true) : null;
  return { fiveHour, weekly: weekly && weekly.known ? weekly : null };
}

/** The reading that limits work now, as the account pill shows it. */
export interface LimitingUsage {
  /** Which window: "5 h", "Week", "Week (opus)". */
  label: string;
  /** The same in words, for a sentence: "5-hour window", "weekly window", "weekly opus window". */
  name: string;
  /** Percent used (0-100, whole numbers). */
  percent: number;
  /** When it resets (epoch ms), or null when unknown. */
  resetsAtMs: number | null;
  /** At or over its limit: no work on this account until it resets. */
  atLimit: boolean;
  /** "5 h 42%", or at the limit "Week 100% · until Sun 9:00 AM". */
  text: string;
}

/**
 * The window that limits work now among an account's live windows: one at its limit (the one that resets last,
 * since work waits for it), else the fullest. Always named, so a weekly reading at 100% reads "Week 100% · until
 * Sun 9:00 AM", never a bare "100%" for days. Null when no live window reports a percent.
 */
export function limitingUsage(windows: Record<string, UsageWindowReading>, nowMs: number, opts: { locale?: string; timeZone?: string } = {}): LimitingUsage | null {
  let best: { key: string; u: number; reset: number | null } | null = null;
  for (const [key, w] of liveWindows(windows, nowMs)) {
    if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const u = Math.min(1, Math.max(0, w.utilization));
    const reset = typeof w.resetsAt === 'number' && w.resetsAt > 0 ? w.resetsAt * 1000 : null;
    const later = best !== null && u >= 1 && best.u >= 1 && (reset ?? Infinity) > (best.reset ?? Infinity);
    if (best === null || u > best.u || later) best = { key, u, reset };
  }
  if (!best) return null;
  const kind = windowKind(best.key);
  const model = MODEL_KEY.exec(best.key)?.[0].toLowerCase();
  const label = kind === 'five_hour' ? '5 h' : kind === 'weekly' ? (model ? `Week (${model})` : 'Week') : 'Limit';
  const name = kind === 'five_hour' ? '5-hour window' : kind === 'weekly' ? (model ? `weekly ${model} window` : 'weekly window') : 'usage window';
  const percent = Math.round(best.u * 100);
  const atLimit = best.u >= 1;
  const until = atLimit && best.reset !== null ? ` · until ${clockText(best.reset, nowMs, opts)}` : '';
  return { label, name, percent, resetsAtMs: best.reset, atLimit, text: `${label} ${percent}%${until}` };
}
