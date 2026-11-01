import { useSyncExternalStore } from 'react';

/** The app is two places — the start page and the dashboard — plus detail pages reached from dashboard containers. */
export type Page = 'start' | 'dashboard' | 'viewer' | 'agents' | 'models' | 'audio' | 'animation' | 'ui' | 'kiln' | 'storefront' | 'references' | 'settings';

export interface Route {
  page: Page;
  /** Optional selection for the target page (a run, an asset, a clip, a settings section). */
  id?: string;
  seq: number;
}

// The window's first page comes from main (#dashboard for a window opened on a project).
let route: Route = { page: typeof location !== 'undefined' && location.hash === '#dashboard' ? 'dashboard' : 'start', seq: 0 };
const listeners = new Set<() => void>();

const history: Array<{ page: Page; id?: string }> = [];

export function navigate(page: Page, id?: string): void {
  if (route.page !== page) history.push({ page: route.page, id: route.id });
  if (history.length > 30) history.shift();
  route = { page, id, seq: route.seq + 1 };
  // Session journal: every navigation is recorded for later review of how the app was used.
  window.shuriken?.journal?.('nav', { page, id: id ?? null });
  for (const l of listeners) l();
}

/** Back to where the user came from (the dashboard when there is no history). */
export function goBack(): void {
  const prev = history.pop();
  const from = route.page;
  navigate(prev?.page ?? 'dashboard', prev?.id);
  if (from !== route.page) history.pop(); // navigate() pushed the page we just left; going back shouldn't record it.
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => route,
  );
}
