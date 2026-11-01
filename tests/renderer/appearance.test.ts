import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The colour theme and the calm dashboard (lib/appearance.ts): one choice for every window, kept in localStorage,
 * and a window without storage keeps the defaults instead of failing.
 */
const store = new Map<string, string>();
const events: string[] = [];
const listeners = new Map<string, Array<(e: { key: string | null }) => void>>();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
g.document = { documentElement: { dataset: {} as Record<string, string> } };
g.window = {
  dispatchEvent: (e: { type: string }) => void events.push(e.type),
  addEventListener: (type: string, fn: (e: { key: string | null }) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  removeEventListener: () => {},
};
if (typeof g.Event === 'undefined') g.Event = class {
  constructor(readonly type: string) {}
};

const { applyTheme, calmDashboardNow, setCalmDashboard, setTheme, themeNow, watchAppearance } = await import('../../src/renderer/src/lib/appearance');
const root = () => (g.document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset;

describe('appearance', () => {
  beforeEach(() => {
    store.clear();
    events.length = 0;
  });

  it('is orange and lively by default, and remembers a choice', () => {
    expect(themeNow()).toBe('orange');
    expect(calmDashboardNow()).toBe(false);
    setTheme('teal');
    expect(store.get('shuriken.theme')).toBe('teal');
    expect(root().theme).toBe('teal');
    expect(themeNow()).toBe('teal');
    expect(events).toContain('shuriken:appearance');
    // Orange is the default: nothing stored.
    setTheme('orange');
    expect(store.has('shuriken.theme')).toBe(false);
    setCalmDashboard(true);
    expect(calmDashboardNow()).toBe(true);
    setCalmDashboard(false);
    expect(store.has('shuriken.calmDashboard')).toBe(false);
  });

  it('follows a change made in another window', () => {
    watchAppearance();
    store.set('shuriken.theme', 'teal');
    for (const fn of listeners.get('storage') ?? []) fn({ key: 'shuriken.theme' });
    expect(root().theme).toBe('teal');
    expect(events).toContain('shuriken:appearance');
  });

  it('keeps the defaults when storage refuses', () => {
    const saved = g.localStorage;
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    try {
      expect(themeNow()).toBe('orange');
      setTheme('teal');
      // This window still changes.
      expect(root().theme).toBe('teal');
      applyTheme('orange');
      expect(root().theme).toBe('orange');
    } finally {
      g.localStorage = saved;
    }
  });
});
