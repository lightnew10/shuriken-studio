import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Session journal: every run of the app gets its own folder under <userData>/sessions with
 *   session.json  – metadata and counters (kept current)
 *   events.jsonl  – every recorded event (navigation, chat, agent runs, escalations, errors, crashes)
 *   chat.md       – the conversation, readable
 *   errors.log    – errors with detail
 *   screens/      – occasional window captures (first dashboard view, milestones, error bursts)
 *   summary.md    – what happened and what went wrong, rewritten as the session goes and at exit
 * so a developer (or Claude Code, see docs/SESSIONS.md) can review how the app actually behaved.
 */

export interface JournalEvent {
  ts: string;
  source: 'main' | 'renderer' | 'core';
  kind: string;
  data?: unknown;
}

interface Counters {
  events: number;
  userMessages: number;
  directorMessages: number;
  runsStarted: number;
  runsOk: number;
  runsFailed: number;
  tasksDone: number;
  tasksFailed: number;
  escalations: number;
  errors: number;
  coreRestarts: number;
  rendererCrashes: number;
  accountSwitches: number;
  limitWaits: number;
}

export class SessionJournal {
  readonly dir: string;
  readonly id: string;
  private readonly startedAt = new Date();
  private readonly counters: Counters = {
    events: 0,
    userMessages: 0,
    directorMessages: 0,
    runsStarted: 0,
    runsOk: 0,
    runsFailed: 0,
    tasksDone: 0,
    tasksFailed: 0,
    escalations: 0,
    errors: 0,
    coreRestarts: 0,
    rendererCrashes: 0,
    accountSwitches: 0,
    limitWaits: 0,
  };
  /** Things worth a developer's attention, in order (sub-par results, failures, friction). */
  private readonly flags: string[] = [];
  private readonly projects = new Set<string>();
  private lastSummaryAt = 0;
  private ended = false;

  constructor(
    root: string,
    private readonly meta: { appVersion: string; electron: string; platform: string; packaged: boolean },
  ) {
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    this.id = `${stamp}_${process.pid}`;
    this.dir = join(root, this.id);
    mkdirSync(join(this.dir, 'screens'), { recursive: true });
    writeFileSync(join(this.dir, 'chat.md'), `# Chat — session ${this.id}\n\n`, 'utf8');
    this.writeMeta();
    this.record('main', 'session.start', { ...meta, pid: process.pid });
  }

  record(source: JournalEvent['source'], kind: string, data?: unknown): void {
    if (this.ended) return;
    const ev: JournalEvent = { ts: new Date().toISOString(), source, kind, data };
    try {
      appendFileSync(join(this.dir, 'events.jsonl'), `${JSON.stringify(ev)}\n`, 'utf8');
    } catch {
      return;
    }
    this.counters.events++;
    this.digest(ev);
    if (Date.now() - this.lastSummaryAt > 15_000) this.writeSummary();
  }

  /** A readable line in chat.md (user and director messages). */
  chat(who: string, text: string, project?: string | null): void {
    const t = new Date().toLocaleTimeString();
    try {
      appendFileSync(join(this.dir, 'chat.md'), `**${who}** · ${t}${project ? ` · ${project}` : ''}\n\n${text.trim()}\n\n---\n\n`, 'utf8');
    } catch {
      /* best effort */
    }
  }

  error(source: JournalEvent['source'], message: string, detail?: unknown): void {
    this.counters.errors++;
    try {
      appendFileSync(join(this.dir, 'errors.log'), `[${new Date().toISOString()}] (${source}) ${message}\n${detail ? `${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}\n` : ''}\n`, 'utf8');
    } catch {
      /* best effort */
    }
    this.record(source, 'error', { message, detail });
    if (this.counters.errors === 1 || this.counters.errors % 10 === 0) this.flag(`Error (${source}): ${message.slice(0, 200)}`);
  }

  flag(text: string): void {
    this.flags.push(`${new Date().toLocaleTimeString()} — ${text}`);
    this.writeSummary();
  }

  screenPath(label: string): string {
    return join(this.dir, 'screens', `${new Date().toISOString().replace(/[:.]/g, '-')}_${label.replace(/[^\w-]+/g, '_').slice(0, 40)}.jpg`);
  }

  end(reason: string): void {
    if (this.ended) return;
    this.record('main', 'session.end', { reason });
    this.writeSummary(reason);
    this.ended = true;
  }

  /** Turns raw events into counters and flags. */
  private digest(ev: JournalEvent): void {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.kind) {
      case 'chat.user':
        this.counters.userMessages++;
        break;
      case 'chat.director':
        this.counters.directorMessages++;
        break;
      case 'run.started':
        this.counters.runsStarted++;
        break;
      case 'run.finished':
        if (d.status === 'completed') this.counters.runsOk++;
        else if (d.status !== 'interrupted') {
          this.counters.runsFailed++;
          this.flag(`Agent run failed: ${String(d.role ?? '?')} on "${String(d.task ?? '')}" — ${String(d.error ?? d.status ?? '').slice(0, 200)}`);
        }
        break;
      case 'task.done':
        this.counters.tasksDone++;
        if (typeof d.attempts === 'number' && d.attempts > 1) this.flag(`Task needed ${d.attempts} attempts: "${String(d.title ?? '')}"`);
        break;
      case 'task.failed':
        this.counters.tasksFailed++;
        this.flag(`Task failed: "${String(d.title ?? '')}" — ${String(d.reason ?? '').slice(0, 240)}`);
        break;
      case 'escalation':
        this.counters.escalations++;
        this.flag(`Needed the user: ${String(d.title ?? '')}`);
        break;
      case 'core.restart':
        this.counters.coreRestarts++;
        this.flag(`Core restarted (${String(d.reason ?? 'crash')})`);
        break;
      case 'renderer.crash':
        this.counters.rendererCrashes++;
        this.flag(`Renderer crashed (${String(d.reason ?? '')})`);
        break;
      case 'account.switched':
        this.counters.accountSwitches++;
        this.flag(String(d.title ?? 'Switched accounts'));
        break;
      case 'limit.wait':
        this.counters.limitWaits++;
        this.flag(String(d.reason ?? 'Waiting for a usage limit to reset'));
        break;
      case 'project.opened':
        if (typeof d.name === 'string') this.projects.add(d.name);
        break;
      case 'regression.failed':
        this.flag(`Regression suite failed: ${String(d.summary ?? '').slice(0, 240)}`);
        break;
      case 'critic.failed':
        this.flag(`Critic rejected "${String(d.task ?? '')}": ${String(d.summary ?? '').slice(0, 240)}`);
        break;
      case 'user.stop':
      case 'user.changePlan':
        this.flag(`User intervened: ${ev.kind === 'user.stop' ? 'stopped work' : 'changed the plan'}${d.text ? ` — "${String(d.text).slice(0, 160)}"` : ''}`);
        break;
    }
  }

  private writeMeta(): void {
    try {
      writeFileSync(
        join(this.dir, 'session.json'),
        JSON.stringify({ id: this.id, startedAt: this.startedAt.toISOString(), updatedAt: new Date().toISOString(), ...this.meta, projects: [...this.projects], counters: this.counters }, null, 2),
        'utf8',
      );
    } catch {
      /* best effort */
    }
  }

  private writeSummary(endReason?: string): void {
    this.lastSummaryAt = Date.now();
    this.writeMeta();
    const c = this.counters;
    const mins = Math.round((Date.now() - this.startedAt.getTime()) / 60000);
    const lines = [
      `# Session ${this.id}`,
      '',
      `- App ${this.meta.appVersion}${this.meta.packaged ? '' : ' (dev)'} · Electron ${this.meta.electron} · ${this.meta.platform}`,
      `- Started ${this.startedAt.toLocaleString()} · ${mins} min${endReason ? ` · ended: ${endReason}` : ' · running'}`,
      `- Projects: ${[...this.projects].join(', ') || '—'}`,
      `- Chat: ${c.userMessages} from the user, ${c.directorMessages} from the director`,
      `- Agent runs: ${c.runsStarted} started, ${c.runsOk} completed, ${c.runsFailed} failed`,
      `- Tasks: ${c.tasksDone} done, ${c.tasksFailed} failed · escalations ${c.escalations}`,
      `- Errors ${c.errors} · core restarts ${c.coreRestarts} · renderer crashes ${c.rendererCrashes} · account switches ${c.accountSwitches} · limit waits ${c.limitWaits}`,
      '',
      '## Needs attention',
      '',
      ...(this.flags.length ? this.flags.map((f) => `- ${f}`) : ['- Nothing flagged.']),
      '',
      'Files: events.jsonl (everything), chat.md (conversation), errors.log, screens/.',
      '',
    ];
    try {
      writeFileSync(join(this.dir, 'summary.md'), lines.join('\n'), 'utf8');
    } catch {
      /* best effort */
    }
  }
}

/** Marks sessions that never wrote session.end (the app was killed or crashed). */
export function markUnfinishedSessions(root: string, currentId: string): void {
  if (!existsSync(root)) return;
  for (const d of readdirSync(root)) {
    if (d === currentId) continue;
    const ev = join(root, d, 'events.jsonl');
    if (!existsSync(ev)) continue;
    const tail = readFileSync(ev, 'utf8').trimEnd().split('\n').pop() ?? '';
    if (tail.includes('"session.end"') || tail.includes('"session.abandoned"')) continue;
    try {
      appendFileSync(ev, `${JSON.stringify({ ts: new Date().toISOString(), source: 'main', kind: 'session.abandoned', data: { note: 'The app exited without a clean shutdown (crash, kill or power loss).' } })}\n`, 'utf8');
      appendFileSync(join(root, d, 'summary.md'), '\n**This session ended without a clean shutdown (crash, kill or power loss).**\n', 'utf8');
    } catch {
      /* best effort */
    }
  }
}
