import { useEffect, useState } from 'react';

/**
 * How the app looks, chosen once for every window: the colour theme and a calm dashboard. Kept in localStorage,
 * which every window of the app shares; a change in one window reaches the others through the storage event, so
 * the bar, every project window and every app window follow at once. Read defensively: a window without storage
 * keeps the defaults.
 */

export type ThemeId = 'orange' | 'teal';

export const THEMES: ReadonlyArray<{ id: ThemeId; label: string; swatch: [string, string] }> = [
  { id: 'orange', label: 'Orange', swatch: ['#ffb454', '#ff7a1a'] },
  { id: 'teal', label: 'Teal', swatch: ['#6fe3d2', '#19c2ae'] },
];

const THEME_KEY = 'shuriken.theme';
const CALM_KEY = 'shuriken.calmDashboard';
/** Said in this window when a choice changes here (the storage event only reaches the other windows). */
const CHANGED = 'shuriken:appearance';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: this window still changes */
  }
  window.dispatchEvent(new Event(CHANGED));
}

export const themeNow = (): ThemeId => (read(THEME_KEY) === 'teal' ? 'teal' : 'orange');

/** The colour theme on this window's page (the CSS tokens under html[data-theme] in styles.css). */
export function applyTheme(theme: ThemeId = themeNow()): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: ThemeId): void {
  write(THEME_KEY, theme === 'orange' ? null : theme);
  applyTheme(theme);
}

/** Previews on the dashboard hold still: effects, animations and turning models (the workshop pages still play). */
export const calmDashboardNow = (): boolean => read(CALM_KEY) === '1';

export function setCalmDashboard(on: boolean): void {
  write(CALM_KEY, on ? '1' : null);
}

/** Follows the choices made in other windows. Called once per page, before the first render. */
export function watchAppearance(): void {
  applyTheme();
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === null) applyTheme();
    if (e.key === THEME_KEY || e.key === CALM_KEY || e.key === null) window.dispatchEvent(new Event(CHANGED));
  });
}

function useAppearance<T>(now: () => T): T {
  const [value, setValue] = useState(now);
  useEffect(() => {
    const on = () => setValue(now());
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [now]);
  return value;
}

export const useTheme = (): ThemeId => useAppearance(themeNow);
export const useCalmDashboard = (): boolean => useAppearance(calmDashboardNow);

/** A theme colour token's value now (canvas and WebGL drawing read it; CSS uses the variables directly). */
export function themeColor(token: 'accent' | 'accent2' | 'ember' | 'on-accent' | 'bg' | 'text' | 'code', fallback = '#ff7a1a'): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim() || fallback;
  } catch {
    return fallback;
  }
}
