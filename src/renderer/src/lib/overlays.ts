import { useEffect, useSyncExternalStore } from 'react';

/**
 * Menus and dialogs open in this page. A native view drawn over the page (Kiln's, on the Kiln page)
 * would hide them, so it steps aside while any is open.
 */
let open = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** Counts this menu or dialog as open while `active`. */
export function useOverlay(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    open++;
    notify();
    return () => {
      open--;
      notify();
    };
  }, [active]);
}

/** Whether any menu or dialog is open in this page. */
export function useOverlaysOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open > 0,
  );
}
