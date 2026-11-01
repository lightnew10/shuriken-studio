export interface DataModelSnapshot {
  roots: string[];
  count: number;
  /** The place has more instances than the snapshot's cap: the ones past the cut are not in `nodes`. */
  truncated: boolean;
  /** The place changed while the snapshot's pages were read (its last attempt keeps what it got). */
  unstable?: boolean;
  nodes: Record<string, Record<string, unknown>>;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: Array<{ path: string; fields: string[] }>;
  summary: string;
  /**
   * A cut or unstable snapshot is behind this diff: what looks removed (or added) may only lie outside
   * what was read, so it is not evidence that anything was deleted.
   */
  unreliable?: boolean;
}

/** Compare two DataModel snapshots produced by LUAU_SNAPSHOT (keys are "path#ClassName"). */
export function diffSnapshots(before: DataModelSnapshot | null, after: DataModelSnapshot | null): SnapshotDiff {
  const a = before?.nodes ?? {};
  const b = after?.nodes ?? {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ path: string; fields: string[] }> = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) added.push(k);
    else {
      const fields = diffFields(a[k]!, b[k]!);
      if (fields.length) changed.push({ path: k, fields });
    }
  }
  for (const k of Object.keys(a)) if (!(k in b)) removed.push(k);
  added.sort();
  removed.sort();
  changed.sort((x, y) => x.path.localeCompare(y.path));
  const truncated = !!(after?.truncated || before?.truncated);
  const unstable = !!(after?.unstable || before?.unstable);
  const summary =
    added.length + removed.length + changed.length === 0
      ? 'No DataModel changes'
      : `${added.length} added, ${removed.length} removed, ${changed.length} changed${truncated ? ' (snapshot truncated)' : ''}${unstable ? ' (the place was changing while it was read)' : ''}`;
  return { added, removed, changed, summary, ...(truncated || unstable ? { unreliable: true } : {}) };
}

function diffFields(x: Record<string, unknown>, y: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  const out: string[] = [];
  for (const k of keys) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push(k);
  return out;
}

export function renderDiff(d: SnapshotDiff, limit = 40): string {
  const lines = [d.summary];
  for (const p of d.added.slice(0, limit)) lines.push(`+ ${p}`);
  for (const p of d.removed.slice(0, limit)) lines.push(`- ${p}`);
  for (const c of d.changed.slice(0, limit)) lines.push(`~ ${c.path} (${c.fields.join(', ')})`);
  return lines.join('\n');
}

/**
 * How long the large-removal check waits before it asks Studio a second time: a folder another agent
 * destroys and builds again is gone in a snapshot taken between the two steps and back a moment later.
 * (An object so a test can shorten it.)
 */
export const REMOVAL_RECHECK = { delayMs: 4000 };

/**
 * The removals that still hold in a later snapshot: an instance that is back there was not deleted, only
 * rebuilt in between. Without a later snapshot (Studio busy or gone) nothing can be dropped.
 */
export function removalsStillGone(removed: readonly string[], later: DataModelSnapshot | null): string[] {
  if (!later) return [...removed];
  return removed.filter((k) => !Object.hasOwn(later.nodes, k));
}

/**
 * What an evidence file keeps of a task's two snapshots: only the nodes the diff is about (removed and
 * changed ones as they were, added and changed ones as they are). Each snapshot is as big as the whole place
 * (megabytes for a game-sized one), and every task and attempt writes a pair; `count` still says how big
 * the place was.
 */
export function diffEvidence(before: DataModelSnapshot, after: DataModelSnapshot, d: SnapshotDiff): { before: DataModelSnapshot; after: DataModelSnapshot } {
  const pick = (snap: DataModelSnapshot, keys: string[]): DataModelSnapshot => ({ ...snap, nodes: Object.fromEntries(keys.filter((k) => Object.hasOwn(snap.nodes, k)).map((k) => [k, snap.nodes[k]!])) });
  const changed = d.changed.map((c) => c.path);
  return { before: pick(before, [...d.removed, ...changed]), after: pick(after, [...d.added, ...changed]) };
}
