import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { newId, nowIso } from '@shared/ids';
import { REFERENCE_BUSY, REFERENCE_LIMITS, clock, referenceKindOf, type ReferenceRecord } from '@shared/references';
import type { AudioAnalysis } from './audio-features';

/**
 * Where a project's references live: `.shuriken/references/<id>/` with reference.json (the record), the
 * original (a copy: the user's file stays where it is), frames/, audio.pcm and audio.json (the measurement),
 * spectrogram-<n>.png, preview.* (a picture's copy for the model) and study.md. The folder is git-ignored:
 * a gigabyte of someone else's footage has no place in the game's history.
 */

const ID = /^ref_[0-9a-z]{10,40}$/;

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export class ReferenceStore {
  /** `dotDir` is the project's .shuriken folder (ProjectContext.dir). */
  constructor(private readonly dotDir: string) {}

  root(): string {
    return join(this.dotDir, 'references');
  }

  dir(id: string): string {
    if (!ID.test(id)) throw new Error(`Not a reference id: ${id}`);
    return join(this.root(), id);
  }

  list(): ReferenceRecord[] {
    const root = this.root();
    if (!existsSync(root)) return [];
    const out: ReferenceRecord[] = [];
    for (const id of readdirSync(root)) {
      if (!ID.test(id)) continue;
      const r = this.get(id);
      if (r) out.push(r);
    }
    return out.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  get(id: string): ReferenceRecord | null {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(readFileSync(join(this.dir(id), 'reference.json'), 'utf8')) as ReferenceRecord;
    } catch {
      return null;
    }
  }

  /** A reference by its id, or by its name (exact, then a unique start of it), ignoring case. */
  find(ref: string): ReferenceRecord | null {
    const all = this.list();
    const q = ref.trim().toLowerCase();
    return all.find((r) => r.id === ref.trim()) ?? all.find((r) => r.name.toLowerCase() === q) ?? (all.filter((r) => r.name.toLowerCase().startsWith(q)).length === 1 ? all.find((r) => r.name.toLowerCase().startsWith(q))! : null);
  }

  save(rec: ReferenceRecord): ReferenceRecord {
    const dir = this.dir(rec.id);
    mkdirSync(dir, { recursive: true });
    const next = { ...rec, updatedAt: nowIso() };
    // Written whole, then moved over: a reader never sees half a record.
    const tmp = join(dir, 'reference.json.tmp');
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, join(dir, 'reference.json'));
    return next;
  }

  patch(id: string, patch: Partial<ReferenceRecord>): ReferenceRecord | null {
    const cur = this.get(id);
    return cur ? this.save({ ...cur, ...patch }) : null;
  }

  remove(id: string): boolean {
    const dir = this.dir(id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  }

  /** A file inside a reference's folder (never outside it). */
  file(id: string, rel: string): string {
    const dir = this.dir(id);
    const abs = resolve(dir, rel);
    const r = relative(dir, abs);
    if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error('Not a file of this reference.');
    return abs;
  }

  /** The project-relative path of a reference's file (what agents pass to file tools such as ui_reference). */
  projectPath(id: string, rel: string): string {
    return `.shuriken/references/${id}/${rel}`.replaceAll('\\', '/');
  }

  study(id: string): string | null {
    try {
      return readFileSync(join(this.dir(id), 'study.md'), 'utf8');
    } catch {
      return null;
    }
  }

  writeStudy(id: string, markdown: string): void {
    writeFileSync(join(this.dir(id), 'study.md'), markdown, 'utf8');
  }

  audio(id: string): (AudioAnalysis & { events: AudioAnalysis['events'] }) | null {
    try {
      return JSON.parse(readFileSync(join(this.dir(id), 'audio.json'), 'utf8')) as AudioAnalysis;
    } catch {
      return null;
    }
  }

  writeAudio(id: string, a: AudioAnalysis): void {
    writeFileSync(join(this.dir(id), 'audio.json'), JSON.stringify(a), 'utf8');
  }

  /**
   * Checks a file the user gave and copies it in: a video or a picture the app reads, under its size cap,
   * within the project's count. The copy is async: a gigabyte must not stall the core.
   */
  async add(source: string, from: ReferenceRecord['from']): Promise<ReferenceRecord> {
    const name = basename(source);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(source);
    } catch {
      throw new Error(`${name}: the file isn't there any more.`);
    }
    if (!st.isFile()) throw new Error(`${name} is a folder, not a file.`);
    const kind = referenceKindOf(name);
    if (!kind) throw new Error(`${name} isn't a video or a picture Shuriken reads (videos: MP4, MOV, WebM, MKV; pictures: PNG, JPEG, WebP, GIF, BMP).`);
    const cap = kind === 'video' ? REFERENCE_LIMITS.videoBytes : REFERENCE_LIMITS.imageBytes;
    if (st.size > cap) throw new Error(kind === 'video' ? `${name} is ${mb(st.size)}: a reference video can be up to ${mb(cap)} (a copy goes with the project). Trim it to the part you want studied.` : `${name} is ${mb(st.size)}: a reference picture can be up to ${mb(cap)}.`);
    if (st.size === 0) throw new Error(`${name} is empty.`);
    if (this.list().length >= REFERENCE_LIMITS.perProject) throw new Error(`This project already has ${REFERENCE_LIMITS.perProject} references: remove some first.`);
    const id = newId('ref');
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    const original = `original${extname(name).toLowerCase()}`;
    try {
      await copyFile(source, join(dir, original));
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`${name} couldn't be copied into the project (${(e as Error).message}).`);
    }
    const now = nowIso();
    return this.save({ id, kind, name: name.replace(/\.[^.]+$/, '').slice(0, 80) || name, source: name, original, bytes: st.size, addedAt: now, updatedAt: now, from, status: 'queued', stage: 'Waiting to be analyzed', error: null });
  }
}

/** A record as the app shows it: an analysis this core isn't running any more (the app or the project closed mid-way) is said to have stopped. */
export function settled(rec: ReferenceRecord, running: boolean): ReferenceRecord {
  if (running || !REFERENCE_BUSY.includes(rec.status)) return rec;
  return { ...rec, status: 'failed', stage: null, error: 'The analysis stopped before it finished (the app or the project was closed). Analyze it again.' };
}

// ─── What agents are told ─────────────────────────────────────────────────────

/** The tags each role reads first (the rest still follow, shorter). */
const ROLE_TAGS: Record<string, string[]> = {
  'ui-engineer': ['ui', 'style'],
  'copilot-ui': ['ui', 'style'],
  'roblox-engineer': ['combat', 'movement', 'camera', 'pacing'],
  'luau-engineer': ['combat', 'movement', 'camera'],
  'game-designer': ['combat', 'movement', 'pacing', 'ui'],
  'level-designer': ['environment', 'camera', 'pacing', 'movement'],
  'environment-artist': ['environment', 'style'],
  animator: ['animation', 'combat', 'movement'],
  'copilot-animation': ['animation', 'combat', 'movement'],
  'vfx-artist': ['vfx', 'combat', 'style'],
  'copilot-effects': ['vfx', 'combat', 'style'],
  'sound-designer': ['audio'],
  'copilot-audio': ['audio'],
  modeler: ['style', 'environment'],
  'thumbnail-artist': ['style', 'environment'],
  'copilot-thumbnails': ['style'],
};

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

/** References ordered for a role and a task: its tags first, then words they share with the task. */
export function rankReferences(refs: ReferenceRecord[], role: string, query: string): ReferenceRecord[] {
  const tags = ROLE_TAGS[role] ?? [];
  const q = words(query);
  const score = (r: ReferenceRecord) => {
    const t = r.study?.tags ?? [];
    const tagHits = tags.filter((x) => t.includes(x)).length;
    let shared = 0;
    for (const w of words(`${r.name} ${r.study?.summary ?? ''} ${(r.study?.takeaways ?? []).join(' ')}`)) if (q.has(w)) shared++;
    // A reference the task names by id or name comes first.
    const named = query.includes(r.id) || (r.name.length > 3 && query.toLowerCase().includes(r.name.toLowerCase())) ? 100 : 0;
    return named + tagHits * 3 + Math.min(shared, 6) + (r.study ? 1 : 0);
  };
  return [...refs].sort((a, b) => score(b) - score(a) || a.addedAt.localeCompare(b.addedAt));
}

/** "video 0:42" / "picture 1920×1080" */
export function describeKind(r: ReferenceRecord): string {
  return r.kind === 'video' ? `video ${r.duration ? clock(r.duration) : ''}`.trim() : `picture${r.width ? ` ${r.width}×${r.height}` : ''}`;
}

const STATUS_WORDS: Record<ReferenceRecord['status'], string> = {
  queued: 'waiting to be analyzed',
  decoding: 'being read',
  measuring: 'being measured',
  studying: 'its study is being written',
  measured: 'measured, no study yet',
  ready: 'studied',
  failed: 'analysis failed',
};

export function statusWords(r: ReferenceRecord): string {
  return STATUS_WORDS[r.status];
}

/**
 * The context section for planner and worker runs: every reference with its one-line summary, and the takeaways
 * of the ones that matter most to this role and task, within `budget` characters.
 */
export function referencesSection(refs: ReferenceRecord[], opts: { role: string; query: string; budget?: number }): string {
  const usable = refs.filter((r) => r.status !== 'failed');
  if (!usable.length) return '';
  const budget = opts.budget ?? 3200;
  const ranked = rankReferences(usable, opts.role, opts.query);
  const head =
    opts.role === 'executive'
      ? 'The user gave these as references for how the game should look, feel or sound. Plan toward them: a task that builds what a reference shows names it (its id, and the seconds for a video) in its objective or criteria, so its specialist looks with reference_view.'
      : 'The user gave these as references for how the game should look, feel or sound. Build toward what they show where your work touches it. reference_view shows one (its study, frames by time, the picture); never copy another game\'s names, logos, characters or exact art.';
  const lines = [head];
  let used = head.length;
  for (const [i, r] of ranked.entries()) {
    const title = `- "${r.name}" (${r.id}, ${describeKind(r)}${r.status === 'ready' ? '' : `, ${statusWords(r)}`})${r.study?.summary ? `: ${r.study.summary}` : ''}`;
    let block = title;
    if (r.study?.takeaways.length && i < 3) {
      const take = r.study.takeaways.slice(0, 6).map((t) => (t.length > 220 ? `${t.slice(0, 219)}…` : t));
      block += `\n  Take: ${take.join(' · ')}`;
    }
    if (used + block.length + 1 > budget) {
      if (used + title.length + 1 > budget) {
        lines.push(`- … and ${ranked.length - i} more (reference_list)`);
        break;
      }
      block = title;
    }
    lines.push(block);
    used += block.length + 1;
  }
  return lines.join('\n');
}

/** The director's lines about the references (its state): names, where they stand, and what each is for. */
export function directorLines(refs: ReferenceRecord[]): string[] {
  if (!refs.length) return [];
  const out = ['', `References the user gave (the References page; the team sees them while building${refs.some((r) => r.kind === 'video') ? '; frames are samples and sound is measured, not heard — speech is not transcribed' : ''}):`];
  for (const r of refs.slice(-12)) out.push(`- "${r.name}" (${r.id}, ${describeKind(r)}): ${r.status === 'ready' ? (r.study?.summary ?? 'studied') : r.status === 'failed' ? `analysis failed${r.error ? ` — ${r.error.slice(0, 160)}` : ''}` : statusWords(r)}`);
  if (refs.length > 12) out.push(`- … and ${refs.length - 12} older`);
  return out;
}

/** One paragraph for a dock copilot's state. */
export function copilotLines(refs: ReferenceRecord[], copilotRole: string): string {
  const usable = refs.filter((r) => r.status === 'ready' || r.status === 'measured');
  if (!usable.length) return '';
  const ranked = rankReferences(usable, copilotRole, '');
  return `References the user gave (reference_view shows one; take the feel, never another game's names or art):\n${ranked
    .slice(0, 6)
    .map((r) => `- "${r.name}" (${r.id}, ${describeKind(r)})${r.study?.summary ? `: ${r.study.summary}` : ''}`)
    .join('\n')}`;
}
