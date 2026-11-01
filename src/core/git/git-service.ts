import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { newId, nowIso } from '@shared/ids';
import type { Checkpoint } from '@shared/domain';
import type { Store } from '../db/store';
import type { AuditService } from '../audit/audit-service';
import { run } from '../roblox/luau-toolchain';

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
}

export interface GitLogEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

/**
 * Git integration for project checkpoints. Every autonomous milestone becomes a commit with a
 * `Shuriken-Checkpoint` trailer; rollback always creates a safety checkpoint first so nothing is lost.
 */
export class GitService {
  constructor(
    private readonly root: string,
    private readonly store: Store,
    private readonly audit: AuditService,
  ) {}

  private async git(args: string[], timeoutMs = 60000): Promise<string> {
    const r = await run('git', args, this.root, timeoutMs);
    if (r.error) throw new Error(`git ${args[0]}: ${r.error}`);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
    return r.stdout;
  }

  static async version(): Promise<string | null> {
    const r = await run('git', ['--version'], process.cwd(), 10000);
    return r.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? r.stdout.trim()) : null;
  }

  isRepo(): boolean {
    return existsSync(join(this.root, '.git'));
  }

  /**
   * Git changes to the repository one at a time: two at once (opening a project initializes the repo
   * while a first checkpoint commits) fail on git's lock files.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(fn);
    this.queue = run;
    return run;
  }

  ensureRepo(): Promise<void> {
    return this.serial(() => this.initRepo());
  }

  private async initRepo(): Promise<void> {
    if (!this.isRepo()) await this.git(['init', '-q', '-b', 'main']);
    const name = await run('git', ['config', 'user.name'], this.root, 10000);
    if (!name.stdout.trim()) await this.git(['config', 'user.name', 'Shuriken Studio']);
    const email = await run('git', ['config', 'user.email'], this.root, 10000);
    if (!email.stdout.trim()) await this.git(['config', 'user.email', 'shuriken@localhost']);
  }

  async status(): Promise<GitStatusEntry[]> {
    const out = await this.git(['status', '--porcelain=v1', '-uall']);
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => ({ index: l[0]!, worktree: l[1]!, path: l.slice(3).replace(/^"|"$/g, '') }));
  }

  async head(): Promise<string | null> {
    const r = await run('git', ['rev-parse', 'HEAD'], this.root, 10000);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async branch(): Promise<string | null> {
    const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], this.root, 10000);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async diff(opts: { from?: string; to?: string; stat?: boolean; paths?: string[] } = {}): Promise<string> {
    const args = ['diff', '--no-color'];
    if (opts.stat) args.push('--stat');
    if (opts.from) args.push(opts.from);
    if (opts.to) args.push(opts.to);
    if (opts.paths?.length) args.push('--', ...opts.paths);
    return this.git(args);
  }

  /** Diff of everything (tracked + untracked) since a commit, without touching the index. */
  async changesSince(sha: string): Promise<{ files: string[]; stat: string }> {
    const tracked = (await this.git(['diff', '--name-only', sha])).split(/\r?\n/).filter(Boolean);
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard'])).split(/\r?\n/).filter(Boolean);
    const stat = await this.git(['diff', '--stat', sha]);
    return { files: [...new Set([...tracked, ...untracked])], stat };
  }

  async log(limit = 50): Promise<GitLogEntry[]> {
    if (!(await this.head())) return [];
    const out = await this.git(['log', `-${limit}`, '--pretty=format:%H%x1f%an%x1f%aI%x1f%s']);
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [sha, author, date, subject] = l.split('\x1f');
        return { sha: sha!, author: author!, date: date!, subject: subject! };
      });
  }

  /**
   * Commit the current state. When nothing changed (and a commit exists) the checkpoint simply
   * references HEAD, so history is not cluttered with empty commits.
   */
  checkpoint(input: { label: string; kind: Checkpoint['kind']; taskId?: string | null; runId?: string | null; snapshotPath?: string | null; commit?: boolean }): Promise<Checkpoint> {
    return this.serial(() => this.commitCheckpoint(input));
  }

  private async commitCheckpoint(input: { label: string; kind: Checkpoint['kind']; taskId?: string | null; runId?: string | null; snapshotPath?: string | null; commit?: boolean }): Promise<Checkpoint> {
    await this.initRepo();
    const hasHead = (await this.head()) !== null;
    // commit: false records a reference to HEAD without committing (used while other tasks are mid-edit,
    // so one task's checkpoint never captures another task's half-finished files).
    if (input.commit === false && hasHead) {
      const sha = (await this.head())!;
      const ref: Checkpoint = { id: newId('cp'), commitSha: sha, label: input.label, kind: input.kind, taskId: input.taskId ?? null, runId: input.runId ?? null, snapshotPath: input.snapshotPath ?? null, createdAt: nowIso() };
      this.store.run(`INSERT INTO checkpoints (id, commit_sha, label, kind, task_id, run_id, snapshot_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [ref.id, ref.commitSha, ref.label, ref.kind, ref.taskId, ref.runId, ref.snapshotPath, ref.createdAt]);
      return ref;
    }
    await this.git(['add', '-A']);
    const dirty = (await this.git(['status', '--porcelain'])).trim().length > 0;
    if (dirty || !hasHead) {
      const msg = `shuriken: ${input.label}`;
      const trailers = [`Shuriken-Checkpoint: ${input.kind}`];
      if (input.taskId) trailers.push(`Shuriken-Task: ${input.taskId}`);
      await this.git(['commit', '--allow-empty', '-q', '-m', msg, '-m', trailers.join('\n')]);
    }
    const sha = (await this.head())!;
    const cp: Checkpoint = {
      id: newId('cp'),
      commitSha: sha,
      label: input.label,
      kind: input.kind,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      snapshotPath: input.snapshotPath ?? null,
      createdAt: nowIso(),
    };
    this.store.run(`INSERT INTO checkpoints (id, commit_sha, label, kind, task_id, run_id, snapshot_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      cp.id,
      cp.commitSha,
      cp.label,
      cp.kind,
      cp.taskId,
      cp.runId,
      cp.snapshotPath,
      cp.createdAt,
    ]);
    this.audit.event({ kind: 'checkpoint.created', severity: 'success', title: `Checkpoint: ${input.label}`, taskId: cp.taskId, runId: cp.runId, detail: { sha: sha.slice(0, 10), kind: cp.kind } });
    return cp;
  }

  checkpoints(limit = 100): Checkpoint[] {
    return this.store
      .all<{ id: string; commit_sha: string; label: string; kind: Checkpoint['kind']; task_id: string | null; run_id: string | null; snapshot_path: string | null; created_at: string }>(
        'SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT ?',
        [limit],
      )
      .map((r) => ({ id: r.id, commitSha: r.commit_sha, label: r.label, kind: r.kind, taskId: r.task_id, runId: r.run_id, snapshotPath: r.snapshot_path, createdAt: r.created_at }));
  }

  /** Restore the working tree to a checkpoint. A safety checkpoint of the current state is created first. */
  async rollback(checkpointId: string, actor: string): Promise<{ safety: Checkpoint; restoredTo: string }> {
    const cp = this.checkpoints(1000).find((c) => c.id === checkpointId);
    if (!cp) throw new Error(`Unknown checkpoint ${checkpointId}`);
    const safety = await this.checkpoint({ label: `safety before rollback to ${cp.label}`, kind: 'auto' });
    await this.serial(() => this.git(['reset', '--hard', cp.commitSha]));
    this.audit.event({ kind: 'checkpoint.rollback', severity: 'warning', title: `Rolled back to: ${cp.label}`, role: actor, detail: { to: cp.commitSha, safety: safety.commitSha } });
    return { safety, restoredTo: cp.commitSha };
  }
}
