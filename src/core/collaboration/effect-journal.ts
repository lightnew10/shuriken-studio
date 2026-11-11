import { createHash } from 'node:crypto';
import type { Store } from '../db/store';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

type Reply = { text: string; error: boolean };
type Effect = { id: string; run_id: string; tool: string; state: string; result: string | null };

export class EffectJournal {
  constructor(private readonly db: Store) {}

  outstanding() {
    return this.db.all<{ id: string; task_id: string; tool: string; state: string }>(
      "SELECT id,task_id,tool,state FROM coop_effects WHERE state IN ('pending','uncertain') ORDER BY rowid LIMIT 100",
    );
  }

  verify(id: string, applied: boolean): void {
    if (applied) {
      this.db.run("UPDATE coop_effects SET state='complete',result=? WHERE id=? AND state IN ('pending','uncertain')", [JSON.stringify({ text: 'Host verified that this operation already took effect.', error: false }), id]);
    } else {
      this.db.run("DELETE FROM coop_effects WHERE id=? AND state IN ('pending','uncertain')", [id]);
    }
  }

  async apply(task: string, run: string, tool: string, input: unknown, signal: AbortSignal, effect: () => Promise<Reply>): Promise<Reply> {
    const id = createHash('sha256').update(JSON.stringify([task, tool, canonical(input)])).digest('hex');
    const previous = this.db.tx(() => {
      const existing = this.db.get<Effect>('SELECT * FROM coop_effects WHERE id=?', [id]);
      if (existing) return existing;
      const uncertain = this.db.get<Effect>("SELECT * FROM coop_effects WHERE task_id=? AND state IN ('pending','uncertain') LIMIT 1", [task]);
      if (uncertain) return uncertain;
      this.db.run("INSERT INTO coop_effects(id,task_id,run_id,tool,state) VALUES (?,?,?,?,'pending')", [id, task, run, tool]);
      return null;
    });
    if (previous) {
      if (previous.id === id && previous.state === 'complete') return JSON.parse(previous.result!) as Reply;
      return { text: `The host must verify the earlier ${previous.tool} operation before further changes to this task.`, error: true };
    }
    if (signal.aborted) {
      this.db.run('DELETE FROM coop_effects WHERE id=?', [id]);
      return { text: 'Run stopped before executing the operation.', error: true };
    }
    try {
      const result = await effect();
      if (result.error && /^(Requires human approval|Denied by policy|Denied by Shuriken policy|Unknown or unavailable tool|Invalid arguments|Run stopped$|Approval was not granted|File changed since|workspace_write_file failed: Path outside)/i.test(result.text)) {
        this.db.run('DELETE FROM coop_effects WHERE id=?', [id]);
      } else {
        const state = result.error ? 'uncertain' : 'complete';
        this.db.run('UPDATE coop_effects SET state=?,result=? WHERE id=?', [state, JSON.stringify({ ...result, text: result.text.slice(0, 24_000) }), id]);
      }
      return result;
    } catch (error) {
      this.db.run("UPDATE coop_effects SET state='uncertain' WHERE id=?", [id]);
      throw error;
    }
  }
}
