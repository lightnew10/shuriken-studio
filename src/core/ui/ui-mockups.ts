import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIRECTIONS } from './forge/directions';
import { TEMPLATES } from './forge/templates';
import { reskinScreens } from './forge/reskin';
import { genreContent, genres } from './forge/genres';
import type { UiNode } from '@shared/ui-layout';
import { applyVersionSet, checkVersion, readShorthands, fromCapture, mockupName, nextVersionId, summarizeMockup, type MockColor, type MockKnows, type MockMotion, type MockNode, type MockPatch, type Mockup, type MockupSummary, type MockVersion } from '@shared/ui-mockup';

/** One version as the copilot asks for it: whole screens, or changes to an earlier version (or to the game's UI as last read). */
export interface VersionInput {
  label?: string;
  note: string;
  /** Start from an earlier version ("B"), or from the game's UI as last read ("game", or "game:HUD" for one screen). */
  from?: string;
  theme?: Record<string, MockColor>;
  screens?: MockNode[];
  /** Changes by path ("Shop.Window.Grid", "phone:Shop.Window"): properties merge in, null removes, a new path with a cls adds. */
  set?: Record<string, MockPatch | null>;
  motion?: MockMotion[];
  /** Start from a Forge screen template in an art direction, with the game's content. */
  template?: { id: string; direction?: string; genre?: string; accent?: string; content?: Record<string, unknown> };
  /** Dress the screens (from an earlier version, the game's UI, or given) in an art direction. */
  reskin?: { direction: string; accent?: string };
}

/** A fix to a version in place: its letter stays, its revision counts up, the one before is kept to go back to. */
export interface ReviseInput {
  version: string;
  /** What this revision fixes (the version's note stays unless a new one is given). */
  note?: string;
  label?: string;
  theme?: Record<string, MockColor>;
  screens?: MockNode[];
  set?: Record<string, MockPatch | null>;
  motion?: MockMotion[];
}

export interface MockupChange {
  mockup: Mockup | null;
  added: MockVersion[];
  /** Versions fixed in place. */
  revised?: MockVersion[];
  errors: string[];
  warnings: string[];
  /** A check only: nothing was saved. */
  dryRun?: boolean;
}

/** Versions one mockup keeps (a new mockup takes the next idea further). */
export const MAX_VERSIONS = 60;
/** Earlier revisions kept per version. */
const MAX_HISTORY = 5;
const MAX_VERSION_BYTES = 400_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const VERSION_FIELDS = ['label', 'note', 'from', 'theme', 'screens', 'set', 'motion', 'template', 'reskin'];
const REVISE_FIELDS = ['version', 'note', 'label', 'theme', 'screens', 'set', 'motion'];
/** Fields written on a version that belong elsewhere, and where. */
const VERSION_HINTS: Record<string, string> = {
  forms: 'forms belong on a screen (a ScreenGui in screens), or change one form with set {"phone:Screen.Path": {…}}',
  kids: 'kids belong inside a screen (screens: [{name, kids}])',
  screen: 'screens (a list of ScreenGuis)',
  changes: 'set {"Screen.Path": props}',
  patch: 'set {"Screen.Path": props}',
  patches: 'set {"Screen.Path": props}',
  name: 'a version has a letter, not a name (label is its short name)',
  id: 'a version gets its letter by itself (to fix one in place: revise)',
  colors: 'theme {"token": "#rrggbb"}',
  tokens: 'theme {"token": "#rrggbb"}',
  animation: 'motion [{play, target, …}]',
  animations: 'motion [{play, target, …}]',
  base: 'from ("B", or "game")',
  version: 'to fix a version in place, use revise: [{version, set}]; a new version is made from one with from',
};

const unknownFields = (input: object, allowed: string[], at: string): string[] =>
  Object.keys(input)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${at}: unknown field "${k}" (${VERSION_HINTS[k] ?? `a version has ${allowed.join(', ')}`})`);

/**
 * A version from what the copilot gave: its screens, or an earlier version's (or the game's) with changes;
 * the theme merges over the earlier one. Checked before it is kept: errors say what to fix.
 */
export function makeVersion(input: VersionInput, earlier: MockVersion[], game: UiNode[] | null, tag = input.label ?? 'version', knows: MockKnows = {}): { version: Omit<MockVersion, 'id' | 'createdAt'> | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const at = (m: string) => `${tag}: ${m}`;
  errors.push(...unknownFields(input, VERSION_FIELDS, tag));
  if (typeof input.note !== 'string' || !input.note.trim()) errors.push(at('a note saying what this version tries'));
  let base: Pick<MockVersion, 'screens' | 'theme' | 'motion'> | null = null;
  const templateNotes: string[] = [];
  if (input.from) {
    const g = /^game(?::(.+))?$/i.exec(input.from);
    if (g) {
      const wanted = g[1]?.trim();
      const screens = (game ?? []).filter((s) => !wanted || s.name.toLowerCase() === wanted.toLowerCase());
      if (!game?.length) errors.push(at("the game's UI hasn't been read from Studio yet (the UI page's Read from Studio, or ui_audit in a turn that may use Studio)"));
      else if (!screens.length) errors.push(at(`the game's UI has no screen "${wanted}" (it has ${game.map((s) => s.name).join(', ')})`));
      else base = { screens: screens.map(fromCapture) };
    } else {
      const v = earlier.find((x) => x.id === input.from!.toUpperCase());
      if (!v) errors.push(at(`no version ${input.from} to start from (versions: ${earlier.map((x) => x.id).join(', ') || 'none yet'})`));
      else base = { screens: v.screens, ...(v.theme ? { theme: v.theme } : {}), ...(v.motion ? { motion: v.motion } : {}) };
    }
  }
  if (input.template) {
    if (input.from || input.screens) errors.push(at('template starts the version: give it without from or screens'));
    else {
      const t = TEMPLATES[input.template.id];
      // A genre gives the direction, accent and believable content; the game's own content goes over it.
      const g = input.template.genre ? genres()[input.template.genre] : undefined;
      const direction = input.template.direction ?? g?.direction ?? '';
      const accent = input.template.accent ?? g?.accent;
      const content = g ? { ...genreContent(g, input.template.id), ...(input.template.content ?? {}) } : input.template.content;
      if (!t) errors.push(at(`no template "${input.template.id}" (templates: ${Object.keys(TEMPLATES).join(', ')})`));
      else if (input.template.genre && !g) errors.push(at(`no genre "${input.template.genre}" (genres: ${Object.keys(genres()).slice(0, 80).join(', ')})`));
      else if (!DIRECTIONS[direction]) errors.push(at(`no art direction "${direction}" (directions: ${Object.keys(DIRECTIONS).join(', ')}; or give a genre)`));
      else {
        try {
          const built = t.build({ direction, ...(accent ? { accent } : {}), ...(content ? { content } : {}) });
          base = { screens: built.screens, ...(built.motion.length ? { motion: built.motion } : {}) };
          templateNotes.push(...built.notes);
        } catch (e) {
          errors.push(at(`template "${input.template.id}": ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    }
  }
  if (input.set && !input.from && !input.screens && !input.template) errors.push(at('set changes a version you start from: give from ("B") with it'));
  if (input.reskin && !input.from && !input.screens && !input.template) errors.push(at('reskin dresses screens: give from ("B", "game:HUD") or screens with it'));
  let screens = input.screens ?? base?.screens;
  if (!screens) errors.push(at('give screens, or from (an earlier version, or "game") with set'));
  if (errors.length || !screens) return { version: null, errors, warnings: [] };
  const theme = base?.theme || input.theme ? { ...(base?.theme ?? {}), ...(input.theme ?? {}) } : undefined;
  const motion = input.motion ?? base?.motion;
  if (input.reskin) {
    try {
      const r = reskinScreens(screens, { direction: input.reskin.direction, ...(input.reskin.accent ? { accent: input.reskin.accent } : {}), ...(theme ? { theme } : {}) });
      screens = r.screens;
      templateNotes.push(...r.notes);
    } catch (e) {
      errors.push(at(`reskin: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (input.set) screens = applyVersionSet(screens, input.set, errors);
  screens = readShorthands(screens);
  const check = checkVersion({ screens, ...(theme ? { theme } : {}), ...(motion ? { motion } : {}) }, knows);
  errors.push(...check.errors.map(at));
  const version: Omit<MockVersion, 'id' | 'createdAt'> = {
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 40) } : {}),
    note: String(input.note ?? '').trim().slice(0, 600),
    ...(input.from ? { from: /^game/i.test(input.from) ? input.from : input.from.toUpperCase() } : {}),
    ...(theme ? { theme } : {}),
    screens,
    ...(motion?.length ? { motion } : {}),
  };
  if (!errors.length && JSON.stringify(version).length > MAX_VERSION_BYTES) errors.push(at(`too big to keep (over ${MAX_VERSION_BYTES / 1000} KB): describe repeated items once (a grid of 4 cards, not 50)`));
  return { version: errors.length ? null : version, errors, warnings: [...templateNotes.map((n) => at(`template: ${n}`)), ...check.warnings.map(at)] };
}

/**
 * The project's UI mockups, one JSON file each in `.shuriken/ui/mockups/` (with the project, so they travel
 * with it and outlive the app). New ideas are new versions (A, B, C…); a fix to one is made in place (its
 * revision counts up and the one before is kept); superseded versions can be retired out of the way; the user
 * picks one; applying it is recorded.
 */
export class MockupStore {
  constructor(
    private readonly root: string,
    /** What the project has, for checking the icons and glyphs a mockup shows. */
    private readonly knows: MockKnows = {},
  ) {}

  private get dir(): string {
    return join(this.root, '.shuriken', 'ui', 'mockups');
  }

  private file(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  /** Every mockup, the most recently changed first. */
  all(): Mockup[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Mockup[] = [];
    for (const f of files) {
      const m = this.get(f.slice(0, -5));
      if (m) out.push(m);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  summaries(): MockupSummary[] {
    return this.all().map(summarizeMockup);
  }

  get(name: string): Mockup | null {
    if (!NAME.test(name)) return null;
    try {
      const m = JSON.parse(readFileSync(this.file(name), 'utf8')) as Mockup;
      return m && Array.isArray(m.versions) ? m : null;
    } catch {
      return null;
    }
  }

  /** A mockup by its name, or by its title (case aside), or by a word of either. */
  find(nameOrTitle: string): Mockup | null {
    const q = nameOrTitle.trim().toLowerCase();
    if (!q) return null;
    const exact = this.get(mockupName(q)) ?? this.get(q);
    if (exact) return exact;
    const all = this.all();
    return all.find((m) => m.title.toLowerCase() === q) ?? all.find((m) => m.name.includes(mockupName(q)) || m.title.toLowerCase().includes(q)) ?? null;
  }

  private save(m: Mockup): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(m.name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(m, null, 1));
    renameSync(tmp, this.file(m.name));
  }

  /** A new mockup with its first versions (A, B, C…). Nothing is saved when a version has errors, or on a dry run. */
  create(opts: { title: string; name?: string; brief?: string; versions: VersionInput[]; by?: string; game?: UiNode[] | null; dryRun?: boolean }): MockupChange {
    const title = opts.title.trim().slice(0, 80);
    if (!title) return { mockup: null, added: [], errors: ['a title'], warnings: [] };
    let name = mockupName(opts.name?.trim() || title);
    for (let i = 2; this.get(name); i++) name = `${mockupName(opts.name?.trim() || title).slice(0, 36)}-${i}`;
    const now = new Date().toISOString();
    const m: Mockup = { name, title, ...(opts.brief?.trim() ? { brief: opts.brief.trim().slice(0, 600) } : {}), versions: [], createdAt: now, updatedAt: now };
    return this.extend(m, opts.versions, opts.by, opts.game ?? null, !!opts.dryRun);
  }

  /** New versions of a mockup (more ideas, or new takes made from earlier ones); earlier ones stay as they were. */
  addVersions(name: string, versions: VersionInput[], by?: string, game: UiNode[] | null = null, dryRun = false): MockupChange {
    const m = this.get(name);
    if (!m) return { mockup: null, added: [], errors: [`no mockup "${name}"`], warnings: [] };
    return this.extend(m, versions, by, game, dryRun);
  }

  private extend(m: Mockup, inputs: VersionInput[], by: string | undefined, game: UiNode[] | null, dryRun: boolean): MockupChange {
    if (!inputs.length) return { mockup: null, added: [], errors: ['at least one version'], warnings: [] };
    if (m.versions.length + inputs.length > MAX_VERSIONS) return { mockup: null, added: [], errors: [`"${m.title}" already has ${m.versions.length} versions: start a new mockup for the next idea`], warnings: [] };
    const versions = [...m.versions];
    const added: MockVersion[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const now = new Date().toISOString();
    for (const input of inputs) {
      const id = nextVersionId(versions.map((v) => v.id));
      const made = makeVersion(input, versions, game, `Version ${id}${input.label ? ` (${input.label})` : ''}`, this.knows);
      errors.push(...made.errors);
      warnings.push(...made.warnings);
      if (!made.version) continue;
      const v: MockVersion = { ...made.version, id, createdAt: now, ...(by ? { by } : {}) };
      versions.push(v);
      added.push(v);
    }
    if (errors.length) return { mockup: null, added: [], errors, warnings };
    const next: Mockup = { ...m, versions, updatedAt: now };
    if (!dryRun) this.save(next);
    return { mockup: next, added, errors: [], warnings, ...(dryRun ? { dryRun: true } : {}) };
  }

  /**
   * Fixes versions in place: each keeps its letter, its revision counts up, and the revision before goes into its
   * history (the last few). A fix to the version that is in the game leaves the record of what was built.
   */
  revise(name: string, inputs: ReviseInput[], by?: string, dryRun = false): MockupChange {
    const m = this.get(name);
    if (!m) return { mockup: null, added: [], errors: [`no mockup "${name}"`], warnings: [] };
    const versions = m.versions.map((v) => ({ ...v }));
    const revised: MockVersion[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const now = new Date().toISOString();
    for (const input of inputs) {
      const id = String(input.version ?? '').trim().toUpperCase();
      const i = versions.findIndex((v) => v.id === id);
      const tag = `Version ${id || '?'} (fix)`;
      errors.push(...unknownFields(input, REVISE_FIELDS, tag));
      if (i < 0) {
        errors.push(`${tag}: no version "${input.version}" to fix (versions: ${versions.map((v) => v.id).join(', ')})`);
        continue;
      }
      const cur = versions[i]!;
      if (!input.set && !input.screens && !input.theme && !input.motion && input.label === undefined && input.note === undefined) {
        errors.push(`${tag}: nothing to change (give set, screens, theme, motion, label or note)`);
        continue;
      }
      const made = makeVersion(
        { note: input.note ?? cur.note, ...(input.label !== undefined ? { label: input.label } : cur.label ? { label: cur.label } : {}), from: id, ...(input.theme ? { theme: input.theme } : {}), ...(input.screens ? { screens: input.screens } : {}), ...(input.set ? { set: input.set } : {}), ...(input.motion ? { motion: input.motion } : {}) },
        versions,
        null,
        tag,
        this.knows,
      );
      errors.push(...made.errors);
      warnings.push(...made.warnings);
      if (!made.version) continue;
      const rev = (cur.rev ?? 1) + 1;
      const history = [...(cur.history ?? []), { rev: cur.rev ?? 1, note: cur.note, at: cur.revisedAt ?? cur.createdAt, ...(cur.theme ? { theme: cur.theme } : {}), screens: cur.screens, ...(cur.motion ? { motion: cur.motion } : {}) }].slice(-MAX_HISTORY);
      const { from: _from, ...made2 } = made.version;
      const next: MockVersion = { ...made2, ...(cur.from ? { from: cur.from } : {}), id, createdAt: cur.createdAt, ...(cur.by || by ? { by: by ?? cur.by } : {}), rev, revisedAt: now, history, ...(cur.retired ? { retired: true } : {}) };
      if (!input.theme && !cur.theme) delete next.theme;
      if (!input.motion && !cur.motion) delete next.motion;
      versions[i] = next;
      revised.push(next);
    }
    if (errors.length) return { mockup: null, added: [], revised: [], errors, warnings };
    const next: Mockup = { ...m, versions, updatedAt: now };
    if (m.applied && revised.some((v) => v.id === m.applied!.version)) warnings.push(`${m.applied.version} is in the game as it was before this fix: build it again to bring the fix in`);
    if (!dryRun) this.save(next);
    return { mockup: next, added: [], revised, errors: [], warnings, ...(dryRun ? { dryRun: true } : {}) };
  }

  /** Retires versions (kept, out of the way) or brings them back. The user's pick, what is in the game and the last shown version stay. */
  retire(name: string, ids: string[], retired: boolean): { mockup: Mockup | null; errors: string[] } {
    const m = this.get(name);
    if (!m) return { mockup: null, errors: [`no mockup "${name}"`] };
    const want = [...new Set(ids.map((x) => x.trim().toUpperCase()))];
    const errors: string[] = [];
    for (const id of want) {
      if (!m.versions.some((v) => v.id === id)) errors.push(`no version "${id}" (versions: ${m.versions.map((v) => v.id).join(', ')})`);
      else if (retired && m.applied?.version === id) errors.push(`${id} is in the game: it stays`);
      else if (retired && m.chosen === id) errors.push(`${id} is the user's pick: it stays`);
    }
    const versions: MockVersion[] = m.versions.map((v) => {
      if (!want.includes(v.id)) return v;
      const { retired: _was, ...rest } = v;
      return retired ? { ...rest, retired: true } : rest;
    });
    if (retired && !versions.some((v) => !v.retired)) errors.push('every version would be retired: keep at least one');
    if (errors.length) return { mockup: null, errors };
    const next: Mockup = { ...m, versions, updatedAt: new Date().toISOString() };
    this.save(next);
    return { mockup: next, errors: [] };
  }

  /** The user's pick (or none). */
  choose(name: string, version: string | null): Mockup | null {
    const m = this.get(name);
    if (!m) return null;
    if (version && !m.versions.some((v) => v.id === version)) throw new Error(`"${m.title}" has no version ${version}`);
    const next: Mockup = { ...m, updatedAt: new Date().toISOString() };
    if (version) {
      next.chosen = version;
      // A version picked comes back from retirement.
      next.versions = m.versions.map((v) => (v.id === version && v.retired ? (({ retired: _r, ...rest }) => rest)(v) : v));
    } else delete next.chosen;
    this.save(next);
    return next;
  }

  /** A version was built into the game (with the files that hold it). */
  markApplied(name: string, version: string, files: string[] = []): Mockup | null {
    const m = this.get(name);
    if (!m) return null;
    const v = m.versions.find((x) => x.id === version);
    if (!v) throw new Error(`"${m.title}" has no version ${version}`);
    const now = new Date().toISOString();
    const next: Mockup = { ...m, chosen: version, applied: { version, at: now, ...(v.rev && v.rev > 1 ? { rev: v.rev } : {}), ...(files.length ? { files: files.slice(0, 40) } : {}) }, updatedAt: now };
    this.save(next);
    return next;
  }
}
