import { useSyncExternalStore } from 'react';
import { rpc } from './rpc';

/**
 * What the UI calls each role: the core's own table (agents/roles.ts roleLabels, the dock copilots and Kiln
 * builds included), loaded once. Until it arrives (or for an id it doesn't know) a role shows as its id.
 */
let labels: Record<string, string> = {};
let asked = false;
const listeners = new Set<() => void>();

function load(): void {
  if (asked) return;
  asked = true;
  rpc<Record<string, string>>('roles.labels').then(
    (l) => {
      labels = l ?? {};
      for (const f of listeners) f();
    },
    () => {
      asked = false;
    },
  );
}

const nameOf = (table: Record<string, string>) => (id: string) => table[id] ?? id;

/** The role names, and the component draws again once they have loaded. */
export function useRoleLabels(): (id: string) => string {
  const table = useSyncExternalStore(
    (f) => {
      listeners.add(f);
      load();
      return () => listeners.delete(f);
    },
    () => labels,
  );
  return nameOf(table);
}
