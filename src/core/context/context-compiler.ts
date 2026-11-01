import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listWorldBuilders } from '../roblox/world-builder';
import { AssetService, analysisSummary } from '../assets/asset-service';
import { AnimationStore } from '../animation/animation-service';
import { EffectStore } from '../effects/effects-service';
import { SoundLibrary } from '../audio/audio-library';
import { ModelStore } from '../modeling/model-store';
import type { KnowledgeEntry, Task } from '@shared/domain';
import type { ProjectContext } from '../projects/project-service';
import type { KnowledgeService } from '../knowledge/knowledge-service';
import type { SkillService } from '../skills/skill-service';
import type { CapabilityRegistry } from '../capabilities/capability-registry';
import type { RoleDefinition } from '../agents/roles';
import { COMPLETE } from '../tasks/task-graph';
import { DossierStore } from '../projects/game-study';
import { readPlannerNotes } from '../orchestrator/planner-notes';
import { ReferenceStore, referencesSection } from '../references/reference-store';

export interface ContextSection {
  key: string;
  title: string;
  body: string;
  tokens: number;
  priority: number;
  truncated: boolean;
}

export interface ContextPackage {
  runId: string;
  role: string;
  taskId: string | null;
  sections: ContextSection[];
  text: string;
  tokensEst: number;
  budget: number;
  omitted: string[];
  path: string | null;
}

export interface CompileInput {
  runId: string;
  role: RoleDefinition;
  task: Task | null;
  /** Extra, run-specific instructions (e.g. research session id, repair defects). */
  directive: string;
  budgetTokens?: number;
  /** Live Roblox status line(s) provided by the caller (kept provider/adapter independent). */
  robloxStatus?: string | null;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

/**
 * Builds the minimal, dense context an agent needs for one run. Sections are gathered from
 * project state, ranked by priority, and fitted to a token budget; every package is saved to
 * `.shuriken/context/<runId>.md` so the exact input of any run is inspectable later.
 */
/** The skill a role's whole craft is: always first in its context. */
const ROLE_SKILL: Record<string, string> = { 'store-designer': 'roblox-monetization', copywriter: 'roblox-store-copy', 'thumbnail-artist': 'roblox-store-art' };

export class ContextCompiler {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly skills: SkillService,
    private readonly capabilities: CapabilityRegistry,
    /** More "what works right now" lines (e.g. whether 3D modeling can run on this PC). */
    private readonly environment: () => string[] = () => [],
  ) {}

  compile(project: ProjectContext, input: CompileInput): ContextPackage {
    const budget = input.budgetTokens ?? 28000;
    const sections: ContextSection[] = [];
    const add = (key: string, title: string, body: string, priority: number) => {
      const b = body.trim();
      if (b) sections.push({ key, title, body: b, tokens: estimateTokens(b), priority, truncated: false });
    };
    const task = input.task;
    const queryText = task ? `${task.title} ${task.objective} ${task.acceptanceCriteria.join(' ')} ${task.robloxSystems.join(' ')}` : input.directive;

    // 1. Directive + task (always first, never truncated).
    add('directive', 'Directive', input.directive, 100);
    if (task) add('task', 'Your task', renderTask(task), 99);

    // 2. Lineage: objective and milestone this task serves.
    if (task) {
      const lineage: string[] = [];
      let parentId = task.parentId;
      let guard = 0;
      while (parentId && guard++ < 6) {
        const parent = project.tasks.get(parentId);
        if (!parent) break;
        lineage.push(`- ${parent.kind === 'objective' ? 'Objective' : 'Parent'}: **${parent.title}** — ${parent.objective}`);
        parentId = parent.parentId;
      }
      add('lineage', 'Why this task exists', lineage.reverse().join('\n'), 95);
    }
    // The planner's notes for the whole project: the user's standing instructions and the decisions to keep.
    if (input.role.id === 'executive') add('planner_notes', "Your notes for this project (planner_notes; the user's standing instructions are in them)", readPlannerNotes(project), 96);

    // 3. Results of dependencies (what already exists and was verified).
    if (task?.dependencies.length) {
      const deps = task.dependencies
        .map((id) => project.tasks.get(id))
        .filter((d): d is Task => !!d)
        .map((d) => `- **${d.title}** [${d.status}${COMPLETE.has(d.status) ? '' : d.landedAt ? ' — its work is on disk, still being checked' : ' — NOT complete'}]: ${d.result ?? '(no result recorded)'}`);
      add('dependencies', 'Completed prerequisite work', deps.join('\n'), 90);
    }

    // 4. Previous attempts and failures of this task.
    if (task && task.attempts > 0) {
      const failures = project.tasks.failures(task.id).slice(-5);
      const reviews = project.tasks
        .evidence(task.id)
        .filter((e) => e.kind === 'critic_review' || (e.passed === false && e.kind !== 'note'))
        .slice(-6);
      const lines = [
        ...failures.map((f) => `- Attempt ${f.attempt} failed at ${f.stage}: ${f.summary}${f.detail ? `\n  ${truncate(f.detail, 1600).replace(/\n/g, '\n  ')}` : ''}`),
        ...reviews.map((e) => `- Evidence "${e.title}" (${e.kind}, passed=${e.passed}): ${truncate(JSON.stringify(e.data), 1600)}`),
      ];
      add('failures', 'Previous attempts — learn from these, do not repeat them', lines.join('\n'), 92);
    }

    // 5. Project instructions + spec.
    add('instructions', 'Project instructions', truncate(project.instructions(), 6000), 85);
    // 5a. A plugged-in game's study: what the game is, its systems, conventions and risks.
    const study = new DossierStore(project.root).brief();
    if (study) add('study', 'This game — an existing game the user plugged in: what its study found', truncate(study, 9000), 84);
    // 5b. The user's reference footage and pictures: what each is for, and the takeaways of the ones this run's work touches.
    const refs = referencesSection(new ReferenceStore(project.dir).list(), { role: input.role.id, query: `${queryText} ${task ? input.directive : ''}` });
    if (refs) add('references', 'Reference footage and pictures from the user', refs, 82);
    const spec = project.governance.spec().filter((s) => s.body.trim());
    if (spec.length) {
      const words = keywords(queryText);
      const ranked = spec
        .map((s) => ({ s, score: overlap(words, `${s.title} ${s.body}`) + (s.key === 'vision' ? 3 : 0) + (s.key === 'constraints' ? 3 : 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      add('spec', 'Project specification (relevant sections)', ranked.map(({ s }) => `### ${s.title} (${s.status}, v${s.version})\n${truncate(s.body, 2500)}`).join('\n\n'), 80);
    }

    // 6. Decisions.
    const decisions = project.governance.decisions().filter((d) => d.status === 'accepted' || d.status === 'proposed').slice(0, 12);
    if (decisions.length) add('decisions', 'Architectural decisions', decisions.map((d) => `- [${d.status}] **${d.title}**: ${truncate(d.decision, 400)}`).join('\n'), 70);

    // 7. Code layout.
    const extras = project.extras();
    const tree = sourceTree(project.root, Object.keys(extras.syncMap), 160);
    add(
      'code',
      'Code layout (disk → Studio)',
      `${Object.entries(extras.syncMap).map(([d, s]) => `- ${d} → ${s.replaceAll('/', '.')}`).join('\n')}\nSync mode: ${extras.syncMode}\n\nFiles:\n${tree || '(no source files yet)'}${task?.files.length ? `\n\nFiles named by the task: ${task.files.join(', ')}` : ''}`,
      75,
    );

    // 7b. World as code: which builders exist, in what order, and which are structured geometry specs.
    const world = listWorldBuilders(project.root);
    if (world.files.length) {
      const specs = world.files.filter((f) => existsSync(join(project.root, 'world', f.replace(/\.luau$/, '.geometry.json'))));
      add(
        'world',
        'World builders (world/)',
        [
          `Run order${world.manifest ? ' (world/world.json)' : ' (alphabetical; pin it in world/world.json when builders depend on each other)'}: ${world.files.join(' → ')}`,
          specs.length ? `Generated from geometry specs (edit the .geometry.json and re-apply with geometry_apply, never the .luau): ${specs.join(', ')}` : '',
          (() => {
            const gen = world.files.filter((f) => ['Animations.luau', 'Effects.luau', 'Audio.luau', 'Models.luau'].includes(f));
            return gen.length ? `Generated by the workshops (change them with the animation_/vfx_/audio_/model_ tools, never by editing): ${gen.join(', ')}` : '';
          })(),
          'world_rebuild runs them all in order; geometry_read turns an existing model into an editable spec.',
          ...world.problems.map((p) => `Problem: ${p}`),
        ]
          .filter(Boolean)
          .join('\n'),
        72,
      );
    }

    // 7b2. Workshop content: the game's moves, effects, sounds and models by name, and how to play them.
    // The game's: what the docks hold as drafts (the user's experiments) is listed apart, below.
    const animStore = new AnimationStore(project.root);
    const fxStore = new EffectStore(project.root);
    const anims = animStore.inGame();
    const effects = fxStore.inGame();
    const dockDrafts = [...animStore.all().filter((f) => f.draft).map((f) => `${f.clip.name} (animation)`), ...fxStore.all().filter((f) => f.draft).map((f) => `${f.effect.name} (effect)`)];
    const allSounds = new SoundLibrary(project.root).all();
    const sounds = allSounds.filter((s) => !s.draft);
    const drafts = allSounds.filter((s) => s.draft);
    const models = new ModelStore(project.root).all();
    // Not for the reviewer: it judges what was built and reads names with the *_list tools when it needs them; the
    // list (about 3,700 tokens in a game with a hundred assets) was loaded into every one of some 150 reviews a build.
    if (input.role.id !== 'critic' && (anims.length || effects.length || sounds.length || models.length || dockDrafts.length)) {
      const shared = AnimationStore.runtimeLocation(extras.syncMap).requirePath.replace(/\.ShurikenAnimations$/, '');
      const lines: string[] = [];
      if (anims.length)
        lines.push(
          `Animations — require(${shared}.ShurikenAnimations); Anims.play(character, name, {fadeTime?, weight?, speed?}) → track, Anims.stop(character, name), Anims.onMarker(track, marker, fn), Anims.markerTime(name, marker), Anims.length(name), Anims.hitStop(character, seconds?), Anims.useMovement(character, {idle, walk, run, jump, fall, climb}): ${anims
            .map((f) => `${f.clip.name} (${f.clip.loop ? 'loop' : `${Math.max(...f.clip.keys.map((k) => k.t))}s`}${(f.clip.markers ?? []).map((m) => `, ${m.name} @${m.t}s`).join('')})`)
            .join('; ')}`,
        );
      if (effects.length) lines.push(`Effects — require(${shared}.ShurikenEffects); Effects.burst(name, position, {color?, scale?, count?}) / attach(name, part) → {stop} / trail(name, blade) / beam(name, a0, a1) / shake(degrees?, seconds?, player?): ${effects.map((f) => `${f.effect.name} (${f.effect.kind})`).join('; ')}`);
      if (sounds.length)
        lines.push(
          `Sounds — require(${shared}.ShurikenAudio); Audio.play(name, position?) / Audio.music(name): ${sounds.map((s) => `${s.name} (${s.kind}${s.assetId ? '' : ', NOT uploaded yet: silent in game'})`).join('; ')}`,
        );
      if (drafts.length) lines.push(`Audio dock drafts (the user's experiments, NOT in the game; use one only when asked, after audio_use adds it): ${drafts.map((s) => `${s.name} (${s.kind})`).join('; ')}`);
      if (dockDrafts.length) lines.push(`Animation and Effects dock drafts (the user's experiments, NOT in the game: nothing can play them until the user adds them there): ${dockDrafts.join('; ')}`);
      if (models.length) lines.push(`3D models (model_place to put more copies in the world): ${models.map((m) => `${m.name} ${m.size.map((v) => Math.round(v * 10) / 10).join('×')} studs, ${m.placements.length} placed`).join('; ')}`);
      add('content', 'Game content from the workshops (use these names in code)', lines.join('\n'), 74);
    }

    // 7c. Asset library: what already exists, so agents reuse instead of regenerating.
    const assetSvc = new AssetService(project.store);
    const assetCount = assetSvc.count();
    if (assetCount) {
      const relevant = assetSvc.relevant(queryText, 6);
      add(
        'assets',
        'Asset library (reuse before inserting or generating)',
        [
          `${assetCount} asset(s) recorded. Search with asset_search, place copies with asset_reuse.`,
          ...relevant.map((a) => `- ${a.name} [${a.kind}, ${a.id}${a.robloxAssetId ? `, rbxassetid://${a.robloxAssetId}` : ''}]${a.instancePaths[0] ? ` at ${a.instancePaths[0]}` : ''}${a.analysis ? ` — ${analysisSummary(a.analysis)}` : ''}`),
        ].join('\n'),
        65,
      );
    }

    // 8. Knowledge relevant to the task.
    const found = this.knowledge.search({ text: queryText, limit: 14 });
    if (found.length) add('knowledge', 'Relevant knowledge (with provenance)', found.map(renderKnowledge).join('\n'), 78);

    // 9. Skills.
    this.skills.refreshIfStale();
    // A role whose craft is one skill always has it (its instructions say it is in the context).
    const own = ROLE_SKILL[input.role.id];
    const matched = this.skills.match({ text: queryText, requested: [...(own ? [own] : []), ...(task?.requiredSkills ?? [])], robloxSystems: task?.robloxSystems }, 4);
    const skills = own ? [...matched.filter((m) => m.name === own), ...matched.filter((m) => m.name !== own)] : matched;
    if (skills.length) {
      const [first, ...rest] = skills;
      const full = this.skills.get(first!.name);
      const body = [
        full ? `### Skill: ${full.name}\n${truncate(full.body, 14000)}` : '',
        rest.length ? `Other relevant skills (fetch with skill_get): ${rest.map((s) => `${s.name} — ${s.description}`).join('; ')}` : '',
      ].join('\n\n');
      add('skills', 'Skills (procedural knowledge)', body, 76);
    }

    // 10. Capabilities: what works right now and known limitations.
    const caps = this.capabilities.list().filter((c) => c.integration === 'roblox-studio' || c.integration.startsWith('provider:'));
    const studio = caps.filter((c) => c.integration === 'roblox-studio');
    const broken = caps.filter((c) => c.status === 'unavailable' || c.status === 'unsupported' || c.status === 'degraded');
    const capLines = [
      input.robloxStatus ? `Studio: ${input.robloxStatus}` : '',
      studio.length ? `Studio MCP tools: ${studio.filter((c) => c.status === 'healthy').length}/${studio.length} healthy.` : 'Studio MCP: not discovered.',
      broken.length ? `Unavailable/degraded: ${broken.map((c) => `${c.id} (${c.status}${c.detail ? `: ${truncate(c.detail, 80)}` : ''})`).join('; ')}` : '',
      ...safeLines(this.environment),
      'Use capabilities_query for tool limitations before relying on a Studio capability.',
      // Facts agents otherwise rediscover the hard way, run after run.
      'Studio facts: scripts can’t read the avatar type (StarterPlayer.GameSettingsAvatar) — check a spawned character’s Humanoid.RigType in a playtest; Lighting.Technology can’t be read or written (use Lighting.LightingStyle) and Terrain.Decoration no longer exists — either one fails a whole builder; screenshots and user_mouse_input need Studio’s window drawn — Shuriken restores a minimized Studio behind the user’s windows by itself, but a sleeping or locked screen stops them (then measure instead: drive the client code from roblox_run_luau on the Client); probe calls run one at a time, so drive and observe in the same call; a probe can’t fake input (VirtualInputManager and VirtualUser are refused there): press keys and click with roblox_input in a playtest you started.',
    ].filter(Boolean);
    add('capabilities', 'Capabilities', capLines.join('\n'), 60);

    // Fit to budget: keep highest-priority sections, truncate the last one that partially fits.
    sections.sort((a, b) => b.priority - a.priority);
    const kept: ContextSection[] = [];
    const omitted: string[] = [];
    let used = 0;
    for (const s of sections) {
      if (used + s.tokens <= budget) {
        kept.push(s);
        used += s.tokens;
      } else if (s.priority >= 90 || budget - used > 800) {
        const room = Math.max(400, budget - used);
        const cut = truncate(s.body, Math.floor(room * 3.6));
        kept.push({ ...s, body: cut, tokens: estimateTokens(cut), truncated: true });
        used += estimateTokens(cut);
      } else omitted.push(s.key);
    }
    const text = kept.map((s) => `## ${s.title}${s.truncated ? ' (truncated)' : ''}\n\n${s.body}`).join('\n\n');
    const header = `# Shuriken context package\nProject: ${project.summary.name} · Role: ${input.role.name} · Run: ${input.runId}${task ? ` · Task: ${task.id}` : ''}\n\n`;
    const full = header + text;
    let path: string | null = null;
    try {
      path = join(project.dir, 'context', `${input.runId}.md`);
      writeFileSync(path, full, 'utf8');
    } catch {
      path = null;
    }
    return { runId: input.runId, role: input.role.id, taskId: task?.id ?? null, sections: kept, text: full, tokensEst: estimateTokens(full), budget, omitted, path };
  }
}

function renderTask(t: Task): string {
  const v = t.verification.map((m) => `- ${m.kind}${'name' in m && m.name ? ` "${m.name}"` : ''}${m.kind === 'playtest' ? ` (${m.durationSec}s)` : ''}`).join('\n');
  return [
    `**${t.title}** (${t.kind}, id ${t.id}, attempt ${t.attempts}/${t.maxAttempts})`,
    '',
    `Objective: ${t.objective}`,
    t.reason ? `Reason: ${t.reason}` : '',
    '',
    'Acceptance criteria:',
    ...t.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    v ? `Shuriken will verify with:\n${v}` : '',
    t.robloxSystems.length ? `Roblox systems: ${t.robloxSystems.join(', ')}` : '',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

function renderKnowledge(k: KnowledgeEntry): string {
  const src = k.sources[0];
  return `- [${k.category}/${k.scope} · conf ${k.confidence.toFixed(2)}${k.versionApplicability ? ` · ${k.versionApplicability}` : ''}${k.status !== 'active' ? ` · ${k.status}` : ''}] **${k.title}** (${k.id}): ${truncate(k.body, 700)}${src ? ` — source: ${src.title ?? src.ref}${src.authority ? ` (${src.authority})` : ''}` : ''}`;
}

function sourceTree(root: string, dirs: string[], limit: number): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit || !existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= limit) return;
      const full = join(dir, name);
      // Other agents write while this looks: an editor's temporary file can be gone before it is read.
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === 'Packages' || name === 'node_modules') continue;
        walk(full);
      } else if (/\.(luau|lua)$/.test(name)) out.push(`${relative(root, full).replaceAll('\\', '/')} (${st.size} B)`);
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.join('\n') + (out.length >= limit ? '\n…(truncated)' : '');
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${s.length - max} more chars]`;
}

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
}

function overlap(words: Set<string>, text: string): number {
  let n = 0;
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (words.has(w)) n++;
  return n;
}

function safeLines(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}
