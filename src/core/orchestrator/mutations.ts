import { relative, resolve } from 'node:path';

/** Synchronous acquisition: a conflict is refused before a provider/tool can change a file. */
const leases = new Map<string, Map<string, Map<string, number>>>();
const key = (path: string) => resolve(path).replaceAll('\\', '/').toLowerCase();
export function reserveMutation(root: string, owner: string, paths: string[], exclusiveWithinRun = false): () => void {
  const project = key(root), requested = new Set(paths.map((p) => p === '*' ? '*' : key(resolve(root, p))));
  const held = leases.get(project) ?? new Map<string, Map<string, number>>();
  for (const [other, files] of held) {
    if ((other !== owner || exclusiveWithinRun) && (files.has('*') || requested.has('*') || [...requested].some((p) => files.has(p)))) throw new Error('File mutation conflict: another operation owns this file or project');
  }
  const files = held.get(owner) ?? new Map<string, number>();
  for (const p of requested) files.set(p, (files.get(p) ?? 0) + 1);
  held.set(owner, files); leases.set(project, held);
  let released = false;
  return () => {
    if (released || held.get(owner) !== files) return;
    released = true;
    for (const p of requested) {
      const remaining = (files.get(p) ?? 0) - 1;
      if (remaining > 0) files.set(p, remaining); else files.delete(p);
    }
    if (!files.size) held.delete(owner);
    if (!held.size && leases.get(project) === held) leases.delete(project);
  };
}
export function releaseMutations(root: string, owner: string): void { const held = leases.get(key(root)); held?.delete(owner); if (!held?.size) leases.delete(key(root)); }
export function mutationsInFlight(root: string, exceptOwner: string | null): string[] {
  return [...(leases.get(key(root)) ?? [])].filter(([owner]) => owner !== exceptOwner).flatMap(([, paths]) => [...paths.keys()].map((p) => p === '*' ? p : relative(key(root), p).replaceAll('\\', '/')));
}
