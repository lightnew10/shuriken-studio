import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { CodeSync } from '../roblox/code-sync';
import type { EventBus } from '../events';
import { resolveCreator, type OpenCloudAssets, type UploadResult } from '../roblox/open-cloud-assets';
import { errorOutput, jsonOutput, type CallerContext, type ToolRegistry } from './tool-registry';
import { AudioService } from '../audio/audio-service';
import { SFX_PRESETS, composeStyle, type SfxParams, type Style } from '../audio/synth';
import { SOUND_KINDS } from '../audio/dsp/analyze';
import { SPACES } from '../audio/dsp/space';
import { MATERIALS } from '../audio/dsp/modal';
import { STINGER_MOODS } from '../audio/stinger';
import { AUDIO_CATEGORIES, LOUDNESS_TARGETS, type AudioCheck } from '../audio/dsp/master';
import { AUDIO_BUILDER_REL, AUDIO_CREDITS_REL, SoundLibrary, type SampleUse, type SoundCredit, type SoundEntry } from '../audio/audio-library';
import { COMMERCIAL_LICENSES, MAX_IMPORT_BYTES, MAX_IMPORT_SECONDS, OpenverseClient, checkUrl, downloadTrack, licenseName, needsCredit, type Fetch, type FoundTrack } from '../audio/sourcing';
import { parseStoreResults } from '../roblox/store-search';
import { AssetService } from '../assets/asset-service';
import { SAMPLE_LICENSES, SampleLibrary, noteName, prepareSample, type SampleInfo, type SampleLicense } from '../audio/sample-library';
import { SAMPLE_KINDS, SAMPLE_ROLES } from '../audio/sample-analysis';
import { decodeAudio } from '../audio/decode';
import { INSTRUMENTS, midiOf, samplePlayback, type SongSpec } from '../audio/music';
import { EditError, PATTERNS, describeScore, editScore, findTrack, type EditOp } from '../audio/score-edit';
import type { MixReport } from '../audio/music-analysis';
import { LEGACY_OWNER, ownerKey } from '../roblox/upload-owner';

export interface AudioToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  sync: CodeSync;
  bus: EventBus;
  cloud: OpenCloudAssets;
  /** Whether generated assets may be uploaded, and to which creator (resolved from Studio when unset). */
  uploads: () => { enabled: boolean; creatorId: string | null };
  rememberCreator: (id: string) => void;
  /** The fetch audio_find, audio_import and audio_sample_* use for the web (tests pass a fake: no network). */
  fetch?: Fetch;
  /** The app's sample library folder (web samples, the user's "My samples" folder). */
  samplesDir: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** "D minor", "f#", "Bb3" → a root note the composer understands (the style sets the scale). */
export function rootNote(key: string, style: string): string | undefined {
  const m = /^\s*([A-Ga-g])([#b♯♭]?)(-?\d)?/.exec(key);
  if (!m) return undefined;
  const accidental = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : (m[2] ?? '');
  const octave = m[3] ?? (style === 'epic' || style === 'spooky' || style === 'phonk' ? '2' : '3');
  return `${m[1]!.toUpperCase()}${accidental}${octave}`;
}
const CLEAR = `local root = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenAudio")
if root then root:ClearAllChildren() end
return "cleared"`;
const STYLES = ['lofi', 'chiptune', 'epic', 'ambient', 'action', 'japanese', 'tropical', 'spooky', 'phonk'] as const;
const SFX_CATEGORIES = AUDIO_CATEGORIES.filter((c) => c !== 'music' && c !== 'ambience') as ['ui', 'pickup', 'impact', 'footstep', 'movement', 'stinger'];
const LOUDNESS = AUDIO_CATEGORIES.map((c) => `${c} ${LOUDNESS_TARGETS[c].lufs}`).join(', ');
/** The mastering gate as tool output: the summary line, and what to fix when it does not pass. */
const gate = (c: AudioCheck) => ({ ok: c.ok, summary: c.summary, ...(c.issues.length ? { fix: c.issues } : {}) });
const DRAFT =
  'Keep it a draft: the user listens to it in the Audio dock, and it is not in the game (not uploaded, not in ReplicatedStorage.ShurikenAudio) until audio_use adds it. Default: true when made in the dock (by the user or its copilot), false for the team. A draft never replaces a game sound of the same name (it gets the next free name).';

const mmss = (sec: number | null) => (sec === null ? '?' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const mb = (n: number | null) => (n === null ? '' : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** Creators whose Creator Store audio is a licensed library, cleared for any Roblox experience. */
const LICENSED_LIBRARY = /^(roblox|apm ?music|apmofficial|pro ?sound ?effects|prosoundeffects|kpm|monstercat)\b/i;

/** The credit an imported sound carries, as tool output: what the agent tells the user. */
function creditOut(c: SoundCredit) {
  const required = c.license === 'by' || c.license === 'by-sa';
  return {
    credit: { title: c.title, creator: c.creator, license: c.licenseName, creditRequired: required, line: c.attribution, source: c.sourceUrl, file: AUDIO_CREDITS_REL },
    mention: `Tell the user this track is "${c.title}" by ${c.creator} under ${c.licenseName}: ${required ? `it needs a credit line in the game (put the line in the game's credits or description; ${AUDIO_CREDITS_REL} has it)` : `no credit is required, ${AUDIO_CREDITS_REL} lists it anyway`}.`,
  };
}

/** Sounds made in the Audio dock (by the user, or its copilot) are drafts to try out; the team's go in the game. */
const draftByDefault = (caller: CallerContext) => caller.kind === 'ui' || caller.role === 'copilot-audio';
/** Whether a sound is made as a draft. A copilot's draft turn (caller.drafts) makes nothing else, whatever it passes. */
/**
 * Music is found before it is composed (the user: "for full audio tracks please prefer to source it elsewhere
 * rather than synth"). The prompt alone didn't hold: in the first 1.13 build the planner wrote "audio_music for an
 * upbeat warehouse loop" into the task and both tracks were composed without one search. So an agent's audio_music
 * says why it composes, and "nothing found" is only true after a search for music in the same run.
 */
export const MUSIC_QUERY = /music|theme|loop|song|track|soundtrack|bgm|beat|instrumental|jingle|ambien/i;
const musicSearches = new Map<string, number>();
/** A search that could have found a track: a music query, or one that asks for long recordings. */
export function noteMusicSearch(runId: string | null | undefined, queries: string[], minSeconds?: number): void {
  if (!runId || !(queries.some((q) => MUSIC_QUERY.test(q)) || (minSeconds ?? 0) >= 20)) return;
  if (musicSearches.size > 500) musicSearches.clear();
  musicSearches.set(runId, (musicSearches.get(runId) ?? 0) + 1);
}
/** Why an agent may not compose this track yet, or null. The user's own Audio page and copilot are never asked. */
export function composeBlocker(caller: CallerContext, why: string | undefined): string | null {
  if (caller.kind !== 'agent' || caller.role === 'copilot-audio') return null;
  const how = 'Find it first: audio_find {queries: ["<genre or mood> music loop", "<another phrasing> instrumental"], min_seconds: 45}, then audio_add (Creator Store: the Roblox, APM, Pro Sound Effects and Monstercat libraries are cleared for any game) or audio_import (Openverse) the best fit.';
  if (!why) return `Music is found before it is composed. ${how} Compose only with why: "nothing_found" (after that search, in this run), "adaptive" (layers or stems the game mixes itself), or "user_asked" (the user asked for original music). A task that says "audio_music" names a tool, not a decision: the source is yours to choose.`;
  if (why === 'nothing_found' && !(caller.runId && musicSearches.get(caller.runId))) return `No search for music was made in this run. ${how} If nothing fits after that, call audio_music again with why: "nothing_found".`;
  return null;
}

const isDraft = (asked: boolean | undefined, caller: CallerContext) => caller.drafts === true || (asked ?? draftByDefault(caller));

// ─── score edits: the input schema (strict, so a misspelt field is an error, not a silent no-op) ──────────────

const BARS = z.tuple([z.number().int().min(1), z.number().int().min(1)]).describe('[first, last] bar, counted from 1, both included');
const SPAN = { bars: BARS.optional(), section: z.string().min(1).optional().describe('A section by name (audio_score lists them), instead of bars') };
const TRACK = z.union([z.number().int().min(0), z.string().min(1)]).describe('A track: its number (audio_score), its name or its instrument');
const CURVE = z.array(z.tuple([z.number().min(0), z.number()])).min(1).max(64).describe('[[beat, value], ...]: linear between points (filters on a log scale)');
const AUTO = z.object({ lp: CURVE.optional().describe('Low-pass Hz'), hp: CURVE.optional().describe('High-pass Hz'), gain: CURVE.optional().describe('Gain 0..2') }).strict();
const NOTE = z.union([
  z.object({ t: z.number().min(0), d: z.number().positive(), n: z.union([z.string(), z.number()]).optional(), v: z.number().min(0).max(1).optional(), o: z.number().min(0).optional(), glide: z.union([z.string(), z.number()]).optional() }).strict(),
  z.tuple([z.number().min(0), z.number().positive(), z.union([z.string(), z.number()]).optional(), z.number().min(0).max(1).optional()]),
]);
const PROPS = {
  instrument: z.enum(INSTRUMENTS as unknown as [string, ...string[]]).optional(),
  name: z.string().min(1).max(40).optional(),
  sample: z.string().nullable().optional().describe('A sample id (audio_samples), or null for the synthesized voice'),
  volume: z.number().min(0).max(3).optional(),
  pan: z.number().min(-1).max(1).optional(),
  send: z.number().min(0).max(1).optional().describe('Reverb send'),
  delay: z.number().min(0).max(1).optional().describe('Delay send'),
  hp: z.number().min(0).max(4000).optional(),
  lp: z.number().min(150).max(20000).nullable().optional(),
  width: z.number().min(0).max(1).optional(),
  duck: z.number().min(0).max(1).optional().describe('Sidechain pump from the kick'),
  drive: z.number().min(0).max(1).optional(),
  crush: z.number().min(0).max(1).optional(),
  slide: z.number().min(0.05).max(1).optional().describe('808: share of a gliding note the slide takes'),
  pitched: z.boolean().optional(),
  tune: z.number().min(-36).max(36).optional(),
  gate: z.boolean().optional(),
  release: z.number().min(0).max(4).optional(),
  reverse: z.boolean().optional(),
  start: z.number().min(0).max(30).optional(),
  mute: z.boolean().optional(),
  auto: AUTO.nullable().optional(),
  tone: z.enum(['chip']).nullable().optional(),
};
const TAPE = z.object({ wow: z.number().min(0).max(1).optional(), hiss: z.number().min(0).max(1).optional(), crackle: z.number().min(0).max(1).optional(), warmth: z.number().min(0).max(1).optional() }).strict();
const OPS = z
  .array(
    z.discriminatedUnion('op', [
      z.object({ op: z.literal('set'), track: TRACK, ...PROPS }).strict(),
      z.object({ op: z.literal('clear'), track: z.union([z.literal('all'), TRACK]), ...SPAN }).strict(),
      z.object({ op: z.literal('thin'), track: z.union([z.literal('all'), TRACK]), keep: z.enum(['downbeats', 'beats', 'offbeats', 'every2', 'accents']), ...SPAN }).strict(),
      z.object({ op: z.literal('notes'), track: TRACK, notes: z.array(NOTE).min(1).max(512), every: z.number().int().min(1).max(16).optional(), ...SPAN }).strict(),
      z.object({ op: z.literal('transpose'), track: TRACK, semitones: z.number().int().min(-36).max(36), ...SPAN }).strict(),
      z.object({ op: z.literal('velocity'), track: z.union([z.literal('all'), TRACK]), scale: z.number().min(0.05).max(3), ...SPAN }).strict(),
      z.object({ op: z.literal('add'), ...PROPS, instrument: z.enum(INSTRUMENTS as unknown as [string, ...string[]]), pattern: z.enum(PATTERNS).optional(), rhythm: z.string().max(64).optional(), octave: z.number().int().min(-3).max(3).optional(), notes: z.array(NOTE).max(512).optional(), every: z.number().int().min(1).max(16).optional(), ...SPAN }).strict(),
      z.object({ op: z.literal('remove'), track: TRACK }).strict(),
      z.object({ op: z.literal('copy'), from: BARS, to: z.number().int().min(1), tracks: z.array(TRACK).max(32).optional() }).strict(),
      z.object({ op: z.literal('insert'), at: z.number().int().min(1), bars: z.number().int().min(1).max(32), copy: BARS.optional() }).strict(),
      z.object({ op: z.literal('delete'), bars: BARS }).strict(),
      z.object({ op: z.literal('sections'), sections: z.array(z.object({ name: z.string().min(1).max(30), bars: z.number().int().min(1) }).strict()).min(1).max(16) }).strict(),
      z
        .object({
          op: z.literal('song'),
          bpm: z.number().min(50).max(200).optional(),
          reverb: z.number().min(0).max(1).optional(),
          tone: z.number().min(-1).max(1).optional(),
          drive: z.number().min(0).max(1).optional(),
          loudness: z.number().min(-24).max(-8).nullable().optional(),
          key: z.string().max(20).optional(),
          delay: z.object({ left: z.number().min(0.0625).max(4).optional(), right: z.number().min(0.0625).max(4).optional(), feedback: z.number().min(0).max(0.9).optional() }).strict().optional(),
          duckRelease: z.number().min(0.02).max(0.4).optional(),
          tape: TAPE.nullable().optional(),
          auto: AUTO.nullable().optional(),
          introBars: z.number().int().min(0).optional(),
        })
        .strict(),
      z.object({ op: z.literal('riser'), at: z.number().int().min(1), bars: z.number().int().min(1).max(8).optional(), volume: z.number().min(0).max(2).optional() }).strict(),
      z.object({ op: z.literal('impact'), at: z.number().int().min(1), volume: z.number().min(0).max(2).optional() }).strict(),
    ]),
  )
  .min(1)
  .max(40);

const EDIT_HELP = `ops, applied in order (bars count from 1, both ends included; "section": a section's name instead of bars; track: number, name or instrument):
- set {track, ...}: a part's sound and mix: instrument, sample (an id from audio_samples, null = back to the voice), volume, pan, send (reverb), delay, hp, lp, width, duck (pump from the kick), drive, crush, slide (808 glide length), tune, pitched, gate, release, reverse, start, mute, auto {lp|hp|gain: [[beat, value], ...]} (sweeps, fades)
- clear {track|"all", bars|section}: no notes there (a breakdown without drums)
- thin {track|"all", keep: downbeats|beats|offbeats|every2|accents, bars|section}: fewer notes
- notes {track, notes: [{t, d, n, v}] or [t, d, n, v], bars|section, every?}: rewrites that span (t in beats from its start; every: the notes are a pattern of that many bars, repeated)
- transpose {track, semitones}, velocity {track|"all", scale}
- add {instrument, sample?, pattern: chords|stabs|arp|bass|drone|hits|bed|chops, rhythm?: "x..x..x." per bar, octave?, or notes, bars|section, + any set field}: a new part from the song's chords or a rhythm (bed: a loop or texture throughout; chops: a loop gated to the rhythm)
- remove {track}; copy {from: [a, b], to: bar, tracks?}; insert {at: bar, bars, copy?: [a, b]}; delete {bars: [a, b]}; sections {sections: [{name, bars}]}
- song {bpm, reverb, tone, drive, loudness, key, delay {left, right (beats), feedback}, duckRelease (s: longer pumps more), tape {wow, hiss, crackle, warmth}, auto {lp|hp|gain} on the whole mix, introBars}
- riser {at: bar it builds into, bars}; impact {at: bar}`;

/**
 * The audio workshop for agents: sound effects and music synthesized here (or picked from the Creator
 * Store), uploaded to Roblox when an Open Cloud key allows it, and played by games through the
 * generated ShurikenAudio module (sound templates in ReplicatedStorage.ShurikenAudio).
 */
export function registerAudioTools(reg: ToolRegistry, d: AudioToolDeps): void {
  const proj = (): ProjectContext => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return p;
  };
  const leaseBlocked = async (_caller: CallerContext, _signal?: AbortSignal) => {
    const w = await d.studio.waitForLease();
    return w.ok ? null : `${w.message} The sounds are saved and build on the next audio_build or world_rebuild.`;
  };

  /** The creator uploads go to: settings, else the user signed in to Studio. */
  const creator = () => resolveCreator(d.studio, d.uploads().creatorId, d.rememberCreator);

  // One Openverse client for the app run: its short memory spares the small anonymous search quota.
  const net: Fetch = (...a) => (d.fetch ?? fetch)(...a);
  const openverse = new OpenverseClient(net);

  /** The sample library: the app's folder and the open project's. */
  const samples = () => new SampleLibrary(d.samplesDir, d.project()?.root ?? null);

  /**
   * The samples a score plays: each must be in the library (else an error naming them). Copies them into the
   * project, and says what a listener would notice: a sample pitched far from its root, a melody on a sample
   * without one, a loop stretched too far.
   */
  const checkSamples = (lib: SampleLibrary, spec: SongSpec): { uses: SampleUse[]; notes: string[]; error?: string } => {
    const ids = [...new Set(spec.tracks.filter((t) => t.sample && !t.mute).map((t) => t.sample!))];
    const missing = ids.filter((id) => !lib.info(id));
    if (missing.length) return { uses: [], notes: [], error: `Not in the sample library: ${missing.join(', ')} (audio_samples lists the ids; audio_sample_add brings one in)` };
    const notes: string[] = [];
    for (const t of spec.tracks) {
      if (!t.sample || t.mute) continue;
      const s = lib.get(t.sample);
      if (!s) continue;
      const play = samplePlayback(t, s);
      const label = `${t.name ?? t.instrument} (${t.sample})`;
      const pitchedNotes = t.notes.filter((n) => n.n !== undefined);
      if (s.kind === 'oneshot' && play.pitched && s.root !== undefined && pitchedNotes.length) {
        const far = Math.max(...pitchedNotes.map((n) => Math.abs(midiOf(n.n!) - s.root! + (t.tune ?? 0))));
        if (far > 19) notes.push(`${label}: notes up to ${Math.round(far)} semitones from the sample's root ${noteName(s.root)}; that far it sounds thin or muddy: transpose the part by octaves, or fix the root (audio_sample_add {sample, root})`);
      }
      if (s.kind === 'oneshot' && !play.pitched && !play.drum && pitchedNotes.length) notes.push(`${label}: the sample has no root, so every note plays at its own pitch: give it one (audio_sample_add {sample, root}) to play the melody`);
      if (s.kind === 'loop' && s.bpm && (spec.bpm / s.bpm > 1.3 || spec.bpm / s.bpm < 0.75)) notes.push(`${label}: a ${s.bpm} bpm loop stretched to ${spec.bpm} bpm; past about 30 % it smears: pick a loop nearer the tempo`);
    }
    const uses = lib.keepInProject(ids).map((i): SampleUse => ({ id: i.id, name: i.name, source: i.source.kind, ...(i.source.license ? { license: i.source.license, licenseName: i.source.licenseName ?? i.source.license, creator: i.source.creator, sourceUrl: i.source.sourceUrl } : {}) }));
    return { uses, notes };
  };

  /** A sample as tool output: what it is and how to use it. */
  const sampleOut = (s: SampleInfo) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    role: s.role,
    ...(s.root !== undefined ? { root: noteName(s.root), ...(s.pitchConfidence ? { pitchConfidence: s.pitchConfidence } : {}) } : {}),
    ...(s.bpm ? { bpm: s.bpm, beats: s.beats } : {}),
    ...(s.key ? { key: s.key } : {}),
    seconds: s.durationSec,
    ...(s.channels > 1 ? { stereo: true } : {}),
    ...(s.spectrum ? { energy: `sub ${s.spectrum.sub}% low ${s.spectrum.low}% mid ${s.spectrum.mid}% high ${s.spectrum.high}%, centre ${s.spectrum.centroidHz} Hz` } : {}),
    source: s.source.kind === 'web' ? `${s.source.licenseName ?? 'CC0'}, "${s.source.title ?? s.name}" by ${s.source.creator ?? 'unknown'}, ${s.source.sourceUrl ?? ''}`.trim() : s.source.kind === 'user' ? `the user's own (${s.source.folder === 'project' ? 'project' : 'My samples'}: ${s.source.file})` : 'built in (synthesized)',
  });

  /** A composed song's score, by sound name. */
  const loadScore = (p: ProjectContext, name: string): { entry: SoundEntry; spec: SongSpec; file: string } | { error: string } => {
    const e = new SoundLibrary(p.root).get(name);
    if (!e) return { error: `No sound named ${name}` };
    const file = e.file && e.source === 'generated' && (e.kind === 'music' || e.kind === 'ambience') ? join(p.root, e.file.replace(/\.mp3$/, '.song.json')) : null;
    if (!file || !existsSync(file)) return { error: `${name} has no score to edit: only songs composed with audio_music have one${e.source === 'imported' ? ' (it is an imported track)' : e.source === 'store' ? ' (it is a Creator Store sound)' : ''}` };
    try {
      return { entry: e, spec: JSON.parse(readFileSync(file, 'utf8')) as SongSpec, file };
    } catch {
      return { error: `${e.file!.replace(/\.mp3$/, '.song.json')} can't be read` };
    }
  };

  /** What a rendered song measures as, and what to change (music-analysis.ts), as tool output. */
  const mixAnalysis = (r: MixReport | null) =>
    r
      ? {
          analysis: {
            heard: r.heard,
            sections: r.sections.map((x) => `${x.name} (bars ${x.bars}): ${x.lufs ?? '?'} LUFS, ${x.lowPct}% under 150 Hz, ${x.highPct}% over 4 kHz`),
            improve: r.improve,
            next: r.improve.length ? 'Change what improve names with audio_music_edit and listen again: two or three passes.' : 'Nothing stands out in the measurements.',
          },
        }
      : {};

  /** The parts of a song, one line each, for results. */
  const parts = (spec: SongSpec) => spec.tracks.map((t, i) => `${i} ${t.name ?? t.instrument}${t.sample ? ` (sample ${t.sample})` : t.name && t.name !== t.instrument ? ` (${t.instrument})` : ''}${t.mute ? ' muted' : ''}`);

  const upload = async (p: ProjectContext, rel: string, name: string, signal?: AbortSignal, description = 'Sound made with Shuriken Studio'): Promise<UploadResult> => {
    if (!d.uploads().enabled) return { ok: false, error: 'Uploading is turned off in Settings.' };
    if (!(await d.cloud.configured())) return { ok: false, needsUser: true, error: 'No Open Cloud API key is set (Settings → Roblox). Uploading needs one with the Assets read/write permission.' };
    const who = await creator();
    if (!who) return { ok: false, needsUser: true, error: 'Uploading needs the Roblox creator (sign in to Studio, or set the creator id in Settings).' };
    return d.cloud.upload({ file: join(p.root, rel), type: 'Audio', name, description, creator: { userId: who } }, signal);
  };

  const build = async (p: ProjectContext, lib: SoundLibrary, caller: CallerContext, signal?: AbortSignal) => {
    const runtime = lib.ensureRuntime(p.extras().syncMap);
    const code = lib.writeBuilder();
    if (!d.studio.connected) return { runtime, note: `Studio is not connected; ${AUDIO_BUILDER_REL} adds the sounds on the next world_rebuild.` };
    const blocked = await leaseBlocked(caller, signal);
    if (blocked) return { runtime, note: blocked };
    const r = await d.studio.runLuau(code || CLEAR, 'Edit', 120_000, signal);
    if (!r.ok) return { runtime, note: `Build failed: ${r.output.slice(0, 800)}` };
    d.bus.emit('roblox.changed', { reason: 'luau' });
    const mode = p.extras().syncMode;
    let sync = 'Studio Script Sync';
    if (mode === 'none') sync = `code sync is off: add ${runtime.file} yourself`;
    else if (mode !== 'script-sync') {
      const rep = await d.sync.push(p.root, p.extras().syncMap, { only: [runtime.file] });
      sync = rep.errors.length ? `failed: ${rep.errors.map((e) => e.error).join('; ').slice(0, 300)}` : rep.created.length || rep.updated.length ? 'pushed' : 'up to date';
    }
    return { runtime: { ...runtime, sync } };
  };

  /** Uploads a generated or imported entry's files that have no asset id yet; returns the updated entry and notes. */
  const uploadEntry = async (p: ProjectContext, e: SoundEntry, signal?: AbortSignal): Promise<{ entry: SoundEntry; note: string | null }> => {
    if (e.source === 'store' || !e.file) return { entry: e, note: null };
    let entry = { ...e };
    let note: string | null = null;
    // A sound uploaded for another owner is uploaded again: a community's game plays only sounds it owns or was
    // granted, so a game that moved to a community needs its sounds under it.
    const owner = ownerKey(await d.cloud.owner().catch(() => null));
    const ownedHere = (o: string | undefined) => (o ?? LEGACY_OWNER) === owner;
    if (!entry.assetId || !ownedHere(entry.assetOwner)) {
      const about = e.credit ? `Imported: "${e.credit.title}" by ${e.credit.creator}, ${e.credit.licenseName}. ${e.credit.sourceUrl}`.slice(0, 900) : undefined;
      const r = await upload(p, entry.file!, entry.name, signal, about);
      if (r.ok && r.assetId) entry = { ...entry, assetId: r.assetId, assetOwner: r.owner && r.owner !== LEGACY_OWNER ? r.owner : undefined, upload: undefined };
      else {
        entry = { ...entry, upload: { operation: r.operation, error: r.error, at: new Date().toISOString() } };
        note = r.error ?? 'upload failed';
        return { entry, note };
      }
    }
    const vars = [];
    for (const v of entry.variations ?? []) {
      if (v.assetId && ownedHere(v.assetOwner)) {
        vars.push(v);
        continue;
      }
      const r = await upload(p, v.file, `${entry.name} (alt)`, signal);
      vars.push({ ...v, assetId: r.ok ? (r.assetId ?? null) : null, assetOwner: r.ok && r.owner && r.owner !== LEGACY_OWNER ? r.owner : undefined });
      if (!r.ok) note = r.error ?? 'a variation did not upload';
    }
    return { entry: { ...entry, variations: vars }, note };
  };

  const finish = async (p: ProjectContext, entry: SoundEntry, caller: CallerContext, signal?: AbortSignal, uploadNow = true, check?: AudioCheck, extra: Record<string, unknown> = {}) => {
    if (entry.draft) {
      const saved = new SoundLibrary(p.root).save(entry);
      d.bus.emit('assets.changed', { id: saved.asset });
      return {
        name: saved.name,
        kind: saved.kind,
        file: saved.file ?? null,
        durationSec: saved.durationSec,
        ...(check ? { check: gate(check) } : {}),
        ...extra,
        draft: true,
        ...(entry.credit ? creditOut(entry.credit) : {}),
        plays:
          "nowhere yet: it's a draft the user can listen to in the Audio dock (not in the game, not uploaded). audio_use adds it to the game when they want it in (it uploads it and builds it into ReplicatedStorage.ShurikenAudio); then wire it.",
      };
    }
    const up = uploadNow ? await uploadEntry(p, entry, signal) : { entry, note: 'upload skipped' };
    const lib = new SoundLibrary(p.root);
    const saved = lib.save(up.entry);
    if (saved.asset && saved.assetId) new AssetService(p.store).update(saved.asset, { robloxAssetId: saved.assetId });
    d.bus.emit('assets.changed', { id: saved.asset });
    const b = await build(p, lib, caller, signal);
    const call = saved.kind === 'music' ? `Audio.music("${saved.name}")` : `Audio.play("${saved.name}", position) -- or Audio.play("${saved.name}") for 2D`;
    return {
      name: saved.name,
      kind: saved.kind,
      file: saved.file ?? null,
      assetId: saved.assetId,
      durationSec: saved.durationSec,
      ...(check ? { check: gate(check) } : {}),
      ...extra,
      plays: saved.assetId ? 'in Studio and the published game (after Roblox moderation, usually minutes)' : 'nowhere yet: it needs uploading (see note), meanwhile the game stays silent for it',
      ...(up.note ? { note: up.note } : {}),
      ...(saved.credit ? creditOut(saved.credit) : {}),
      runtime: b.runtime,
      ...('note' in b && b.note ? { studio: b.note } : {}),
      usage: `local Audio = require(${b.runtime.requirePath})\n${call}`,
    };
  };

  reg.register({
    name: 'audio_sfx',
    title: 'Make a sound effect',
    description: `Design a game sound effect (MP3) by describing it in params, the way a sound designer builds one, or start from a preset (${Object.keys(SFX_PRESETS).join(', ')}) and override fields. You have no ears here: the result's analysis is how you listen. Make it, read analysis.improve, change those parameters, call again with the same name; two or three passes make a good sound (pass upload: false until it is right: Roblox limits audio uploads per month).\n\nANATOMY. A sound is a main voice plus layers (each a voice with its own envelope, filters and delay), placed in time and in bands: a TRANSIENT (the first 5-10 ms: a crack or click of bright noise, the loudest thing at the start), a BODY (10-200 ms: the thump, the ring, the dense noise that carries the loudness), a TAIL (rumble, debris, hiss, darker as it dies) and a PLACE (space). One layer per band: thump under 150 Hz, body 200-2000 Hz, crack and air above 3 kHz. Skill roblox-audio has the recipe for each family (gunshots, explosions, footsteps, metal, servos, whooshes, UI).\n\nVOICE: wave sine|triangle|saw|square (band-limited), noise|white|pink|brown (freq ignored; shape with filters), crunch (stepped lo-fi noise), modal (a struck object: material ${MATERIALS.join('|')}, freq = its lowest mode, modeCount, hardness 0..1, damping 0..1; or your own modes [[ratio, gain, decay scale], ...]), fm (fmRatio, fmIndex, fmDecay). Envelope: attack (default 0.001), sustain = seconds HELD at full level (default 0: a voice is a hit unless you hold it; a noise body wants 0.02-0.06), decay = seconds to silence (it is 20 dB down after a third of it; default 0.2), punch, levelCurve [[seconds, 0..1], ...]. Pitch: freq, freqEnd + pitchTime (an exponential drop: thumps, zaps), slide (octaves/s), freqCurve [[seconds, Hz], ...] (servo starts and stops, sirens), vibratoDepth + vibratoSpeed, jitter (cents of random drift), unison 1..7 + detune (cents), arpMul + arpTime, duty. Filters (12 dB/octave): lowpass, highpass, bandpass in Hz, each with ...End (a sweep over the voice, or over sweepTime seconds), resonance = Q (0.707 flat, 2-4 vocal, 8+ ringing; NOT 0..1), filterLfoDepth (octaves) + filterLfoSpeed (Hz). Movement: tremoloDepth + tremoloSpeed, ring (Hz) + ringMix, comb (Hz) + combDecay (a tuned resonator: barrels, pipes, hollow hulls). drive 0..1 + driveType soft|hard|fold. crackle = grains per second with grain = seconds per grain (sparks, debris, gravel: crackle 80, grain 0.004). repeat (retrigger every N seconds). volume (noise is about 6 dB quieter than an oscillator at the same volume: a crack that must lead wants 1.5-2.5). Stereo: pan -1..1, panEnd, spread 0..1. layers: [voices with the same fields + delay seconds].\n\nTHE WHOLE SOUND: transient 0..1 (sharpens the front edge; default 0.5 for impacts, 0.4 for footsteps, 0 otherwise), weight 0..1 (harmonics and sub-octave of the lows), tone {low, mid, presence, air} in dB, clip 0..1 (saturation: density), comp {thresholdDb, ratio, attackMs, releaseMs, makeupDb}, space ${SPACES.join('|')} + spaceMix (energy of the place against the dry sound: 0.1 a hint, 0.25 clearly in it, 0.5 far inside) + spaceDecay 0.3..2, distance 0..1 (far away: no highs, no edge, more space), width 0..1 or stereo: true (a stereo file: only for 2D sounds like UI, the player's own weapon, stingers; sounds played at a position in the world stay mono), loop: true (a seamless loop as long as the main voice: sustain 2, decay 0; held voices get whole cycles, noise is crossfaded at the seam, shorter voices are events inside it; engines, servos, beams), room + roomSize (the older small reverb).\n\nWHAT MAKES WHAT. Weight: a sine falling from 110-180 to 35-55 Hz (pitchTime 0.03-0.08) with drive, brown noise under lowpass 200, weight. Crack: white noise, highpass 2500-6000, attack 0.0003, sustain 0, decay 0.01-0.04, loud. Air: white above highpass 6000 with a longer decay, tone.air. Body: pink or white through lowpass 6000-12000 falling to lowpassEnd 500-1500, sustain 0.02-0.06, decay 0.2-0.5. Metal: modal with a material, plus a noise knock. Space: space + spaceMix, a rumble layer for outdoors. Movement: freqCurve, filter sweeps and LFOs, tremolo, jitter, unison beating, panEnd. Loudness comes from the body, not the peak: a sound with a sharp front and nothing behind it ends up quieter than its target.\n\nMastered to its loudness category (LUFS: ${LOUDNESS}; true peak under -1.5 dBTP): category says what class the sound is (a footstep is footstep even for a giant; balance with volume), kind says what to judge it as. The result: check (the loudness gate, with fix when it fails) and analysis {judgedAs, heard (the measurements: front edge against the body, crack, six bands, brightness start to end, noisiness, decay, movement, stereo), improve (what a sound designer would change, most audible first, with the parameters that do it), notes (parameters that did nothing or were read differently), takes (how the variations differ)}. Extra takes (variations) differ in grain and layer balance, not only pitch: only for sounds heard constantly (footsteps, hits). Shuriken saves it under assets/audio, uploads it to Roblox when an Open Cloud key allows (free), adds it to ReplicatedStorage.ShurikenAudio and the asset library. A real recording (audio_find, then audio_add or audio_import) wins for voices, music and nature; design everything else here. Play it with the ShurikenAudio module (see usage).`,
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: {
      name: z.string().describe('Sound name (letters, digits, _), e.g. SwordSwing'),
      preset: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional().describe('The sound: the fields of the main voice, layers: [...] and the whole-sound fields (see the description). Unknown fields are reported in analysis.notes.'),
      category: z.enum(SFX_CATEGORIES).optional().describe(`Loudness class the sound is mastered to (LUFS: ${LOUDNESS}). Default: the preset's own (custom sounds: pickup). A hit, a shot or an explosion is impact, a click ui, a footstep footstep, a reload or a servo movement. Do not pick a louder class to make a sound bigger: design it bigger and set volume.`),
      kind: z.enum(SOUND_KINDS).optional().describe('What the analysis judges it as: shot (gunfire, cannons, launches), explosion, impact (one thing struck: hits, clangs, slams), step, mechanism (several small events: reloads, latches, equips), ui, tonal (chimes, alarms, pickups), whoosh (swings, dashes, thrusters), riser (charge-ups, power-ups, deploys), loop. Default: guessed from the name, description and shape.'),
      heavy: z.boolean().optional().describe('Meant to be heavy (a mech step, a cannon, a boss slam): the analysis then expects weight under 150 Hz and a longer body.'),
      variations: z.number().int().min(1).max(4).optional().describe('Takes to generate (default 1). Use 2–3 only for sounds heard constantly (footsteps, hits): every take is a separate upload and Roblox limits audio uploads per month.'),
      volume: z.number().min(0).max(10).optional(),
      description: z.string().optional(),
      upload: z.boolean().optional().describe('Upload to Roblox now (default true)'),
      draft: z.boolean().optional().describe(DRAFT),
    },
    handler: async ({ args, caller, signal }) => {
      if (!NAME.test(args.name)) return errorOutput('name must be letters, digits and _ (start with a letter)');
      const p = proj();
      const draft = isDraft(args.draft, caller);
      const name = draft ? new SoundLibrary(p.root).freeName(args.name) : args.name;
      let made;
      try {
        made = new AudioService(p).sfx({ name, preset: args.preset, params: args.params as Partial<SfxParams> | undefined, category: args.category, variations: args.variations ?? 1, kind: args.kind, heavy: args.heavy, description: args.description, actor: caller.role ?? caller.kind, taskId: caller.taskId });
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const entry: Omit<SoundEntry, 'updatedAt'> = {
        name,
        kind: 'sfx',
        source: 'generated',
        assetId: null,
        file: made.file,
        variations: (made.variations ?? []).map((f) => ({ file: f, assetId: null })),
        volume: args.volume ?? 0.6,
        looped: !!made.loop,
        // A loop is pitched by the game (PlaybackSpeed with speed or load), not at random.
        pitchVariation: made.loop ? 0 : 0.06,
        description: args.description,
        preset: args.preset,
        category: made.check.target?.category,
        ...(made.loop ? { loop: made.loop } : {}),
        check: made.check.summary,
        durationSec: Math.round(made.durationSec * 100) / 100,
        asset: made.asset.id,
        ...(draft ? { draft: true } : {}),
      };
      const f = made.feedback;
      const analysis = {
        judgedAs: f.judgedAs,
        heard: f.heard,
        improve: f.improve,
        ...(f.notes.length ? { notes: f.notes } : {}),
        ...(f.takes ? { takes: f.takes } : {}),
        next: f.improve.length || f.notes.length || !made.check.ok ? 'Change the parameters named in improve (and fix, notes) and call audio_sfx again with the same name; stop when what is left is intended.' : 'Nothing stands out in the measurements.',
      };
      return jsonOutput(await finish(p, entry as SoundEntry, caller, signal, args.upload !== false, made.check, { analysis, ...(made.loop ? { looped: true } : {}), ...(made.stereo ? { stereo: true } : {}) }));
    },
  });

  reg.register({
    name: 'audio_music',
    title: 'Compose music',
    description: `Compose and render a looping music track in a style (${STYLES.join(', ')}) with an optional key (a root note like "D", "F#" or "Bb3"; "D minor" works too — the style decides major/minor), bpm, bars (4–64) and seed for variety. The track is composed, not looped: voice-led chords (7ths in lofi and ambient), a melody developed over an A and a B section (16-32 bars let both play out), a bass line, drums with fills every 4 and 8 bars, swing and human timing, a wide mix with a mono bass. It is mastered to -16 LUFS-I (kind ambience: -24), and the result's check line reports loudness, true peak and the loop seam. Saves the MP3 and its song spec under assets/audio/music, uploads it when an Open Cloud key allows, adds it to ReplicatedStorage.ShurikenAudio with the loop region that skips the MP3 encoder delay. phonk is built as an intro that plays once, then drop / breakdown / drop that loops (use 20-32 bars), louder than other styles (-11 LUFS-I). samples puts real sounds on parts: {"cowbell": "<sample id>"} plays every cowbell note on that sample, pitched to the riff (audio_samples lists ids; a sample is matched in loudness to the voice it replaces). You listen through analysis: heard (each part's share of the mix, the sections' loudness, low end, highs, the pump) and improve (low-end clashes, a drop that doesn't lift, a buried melody, mud, dullness, with the parameters that fix them). The score is saved: change it with audio_music_edit (audio_score shows it) instead of composing again with another seed. Games play it with Audio.music(name) (crossfades, loops). A finished song or genre track with real instruments or vocals is better found (audio_find, then audio_import or audio_add) than synthesized; compose for tracks that must match a key or tempo, layer, or adapt.`,
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: {
      name: z.string(),
      style: z.enum(STYLES),
      key: z.string().optional().describe('Root note, e.g. "D", "F#3", "D minor"'),
      bpm: z.number().min(50).max(200).optional(),
      bars: z.number().int().min(4).max(64).optional(),
      seed: z.number().int().optional(),
      volume: z.number().min(0).max(10).optional(),
      kind: z.enum(['music', 'ambience']).optional(),
      why: z.enum(['nothing_found', 'adaptive', 'user_asked']).optional().describe('Agents: why this track is composed and not found. "nothing_found": audio_find for music in this run gave no fit; "adaptive": layers or stems the game mixes; "user_asked": the user asked for original music.'),
      samples: z.record(z.string(), z.string()).optional().describe('Parts played by samples: instrument or part name → sample id, e.g. {"cowbell": "tr808-cowbell", "pad": "rhodes-chord-c"}'),
      upload: z.boolean().optional(),
      draft: z.boolean().optional().describe(DRAFT),
    },
    handler: async ({ args, caller, signal }) => {
      if (!NAME.test(args.name)) return errorOutput('name must be letters, digits and _ (start with a letter)');
      const blocked = composeBlocker(caller, args.why);
      if (blocked) return errorOutput(blocked);
      const p = proj();
      const draft = isDraft(args.draft, caller);
      const name = draft ? new SoundLibrary(p.root).freeName(args.name) : args.name;
      const lib = samples();
      let made;
      let used: ReturnType<typeof checkSamples> = { uses: [], notes: [] };
      try {
        const key = args.key ? rootNote(args.key, args.style) : undefined;
        let spec: SongSpec | undefined;
        if (args.samples && Object.keys(args.samples).length) {
          spec = composeStyle(args.style as Style, { key, bpm: args.bpm, bars: args.bars ?? 16, seed: args.seed });
          for (const [part, id] of Object.entries(args.samples)) {
            const want = part.trim().toLowerCase();
            const hit = spec.tracks.filter((t) => t.instrument === want || (t.name ?? '').toLowerCase() === want);
            if (!hit.length) return errorOutput(`samples: this ${args.style} song has no part "${part}" (its parts: ${parts(spec).join(', ')})`);
            for (const t of hit) t.sample = id;
          }
          used = checkSamples(lib, spec);
          if (used.error) return errorOutput(used.error);
        }
        made = new AudioService(p).music({ name, style: args.style as Style, spec, key, bpm: args.bpm, bars: args.bars ?? 16, seed: args.seed, category: args.kind === 'ambience' ? 'ambience' : 'music', samples: lib, actor: caller.role ?? caller.kind, taskId: caller.taskId });
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const entry: Omit<SoundEntry, 'updatedAt'> = {
        name,
        kind: args.kind ?? 'music',
        source: 'generated',
        assetId: null,
        file: made.file,
        volume: args.volume ?? 0.45,
        looped: true,
        style: args.style,
        category: args.kind === 'ambience' ? 'ambience' : 'music',
        loop: made.loop,
        check: made.check.summary,
        durationSec: Math.round(made.durationSec * 10) / 10,
        asset: made.asset.id,
        ...(used.uses.length ? { samples: used.uses } : {}),
        ...(draft ? { draft: true } : {}),
      };
      return jsonOutput({
        ...(await finish(p, entry as SoundEntry, caller, signal, args.upload !== false, made.check)),
        bpm: made.spec.bpm,
        bars: Math.round(made.spec.beats / 4),
        parts: parts(made.spec),
        ...(used.notes.length ? { sampleNotes: used.notes } : {}),
        ...mixAnalysis(made.report),
        edit: `Change it with audio_music_edit {name: "${name}", ops: [...]} (same seed: what you don't touch stays as it is); audio_score shows the parts and notes.`,
      });
    },
  });

  reg.register({
    name: 'audio_music_edit',
    title: 'Edit a song',
    description: `Change a composed song's score and render it again with the same seed, so everything you don't touch sounds the same: craft, not another roll of the dice. Swap a part for a sample, rewrite the cowbell riff, layer a pad, thin the drums for a breakdown, add a riser into the drop, sweep a filter, set the pump, add tape. Read it first with audio_score. ${EDIT_HELP}
The result says what changed, the check line, notes on the samples, and analysis {heard, sections, improve}: change what improve names and edit again, two or three passes. A draft is edited in place; editing a game song from the dock makes a new draft (as names one); the team's edits replace the song (uploaded again).`,
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: {
      name: z.string().describe('The song (a sound made with audio_music)'),
      ops: OPS,
      as: z.string().optional().describe('Save the result as another sound (the original stays)'),
      upload: z.boolean().optional(),
      draft: z.boolean().optional().describe(DRAFT),
    },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const got = loadScore(p, args.name);
      if ('error' in got) return errorOutput(got.error);
      let edited;
      try {
        edited = editScore(got.spec, args.ops as EditOp[]);
      } catch (e) {
        return errorOutput(e instanceof EditError ? e.message : `The edit failed: ${(e as Error).message}`);
      }
      const lib = samples();
      const used = checkSamples(lib, edited.spec);
      if (used.error) return errorOutput(used.error);
      const target = args.as?.trim() || got.entry.name;
      if (!NAME.test(target)) return errorOutput('as must be letters, digits and _ (start with a letter)');
      // An edited draft stays a draft; a game song edited in the dock becomes a new draft beside it.
      const draft = isDraft(args.draft ?? (got.entry.draft ? true : undefined), caller);
      const name = draft ? new SoundLibrary(p.root).freeName(target) : target;
      let made;
      try {
        made = new AudioService(p).music({ name, spec: edited.spec, category: got.entry.kind === 'ambience' ? 'ambience' : 'music', samples: lib, actor: caller.role ?? caller.kind, taskId: caller.taskId });
      } catch (e) {
        return errorOutput(`The edited score doesn't render: ${(e as Error).message}`);
      }
      const entry: Omit<SoundEntry, 'updatedAt'> = {
        ...got.entry,
        name,
        // New audio: any earlier upload is of the old version.
        assetId: null,
        file: made.file,
        loop: made.loop,
        check: made.check.summary,
        durationSec: Math.round(made.durationSec * 10) / 10,
        asset: made.asset.id,
      };
      delete entry.upload;
      delete entry.variations;
      if (used.uses.length) entry.samples = used.uses;
      else delete entry.samples;
      if (draft) entry.draft = true;
      else delete entry.draft;
      return jsonOutput({
        ...(await finish(p, entry as SoundEntry, caller, signal, args.upload !== false, made.check)),
        ...(name !== args.name ? { editedFrom: args.name } : {}),
        changes: edited.changes,
        bpm: made.spec.bpm,
        bars: Math.round(made.spec.beats / 4),
        parts: parts(made.spec),
        ...(used.notes.length ? { sampleNotes: used.notes } : {}),
        ...mixAnalysis(made.report),
      });
    },
  });

  reg.register({
    name: 'audio_score',
    title: 'Read a song score',
    description: "A composed song's score, to edit it with audio_music_edit: tempo, key, bars, sections (with their bars), the chords bar by bar, the mix, and every part (number, name, instrument or sample, how many notes, which bars it plays in, its range and settings). tracks: the parts whose notes to show, bar by bar (beat in the bar, note, length, velocity); bars narrows that to [first, last].",
    capability: 'roblox.app.audio',
    permission: 'read',
    input: {
      name: z.string(),
      tracks: z.array(TRACK).max(6).optional(),
      bars: BARS.optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const p = proj();
      const got = loadScore(p, args.name);
      if ('error' in got) return errorOutput(got.error);
      let idx: number[] = [];
      try {
        idx = (args.tracks ?? []).map((t) => findTrack(got.spec, t));
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const bars = Math.round(got.spec.beats / 4);
      if (args.bars && !(args.bars[0] <= args.bars[1] && args.bars[1] <= bars)) return errorOutput(`bars must be within 1-${bars}, first <= last`);
      return jsonOutput({ name: got.entry.name, ...(got.entry.draft ? { draft: true } : {}), ...describeScore(got.spec, { tracks: idx, ...(args.bars ? { bars: args.bars } : {}) }) });
    },
  });

  reg.register({
    name: 'audio_sample_find',
    title: 'Find samples on the web',
    description: `Search Openverse (Freesound, Wikimedia) for sounds to compose with: one-shots (a real 808 cowbell, a vocal chop, a Rhodes chord, a clap), loops, textures (rain, vinyl, tape). Only CC0 and public-domain sounds are listed: a sample becomes part of a new song that is uploaded, so nothing that asks for a credit or limits use. Each candidate has what to judge it by: title, creator, length, tags, page, file type (Ogg files can't be used). Query by what it is and its character ("808 cowbell", "female vocal chop", "rhodes chord", "vinyl crackle"); put every phrasing in one call (Openverse allows few anonymous searches). Then audio_sample_add the best fit. audio_samples lists what is already there: the user's own, earlier finds, built-in TR-808 emulations.`,
    capability: 'roblox.app.audio',
    permission: 'read',
    input: {
      queries: z.array(z.string().min(2).max(80)).min(1).max(3),
      kind: z.enum(SAMPLE_KINDS).optional().describe('oneshot: up to 6 s; loop or texture: 1-90 s (default: any length up to 90 s)'),
      limit: z.number().int().min(1).max(10).optional().describe('Candidates per query (default 6)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ args, signal }) => {
      const limit = args.limit ?? 6;
      const [lo, hi] = args.kind === 'oneshot' ? [0, 6] : args.kind ? [1, 90] : [0, 90];
      const lines: string[] = [];
      const notes: string[] = [];
      const seen = new Set<string>();
      const found: Array<Record<string, unknown>> = [];
      let ogg = 0;
      for (const q of args.queries) {
        const r = await openverse.search(q, limit, { signal, licenses: SAMPLE_LICENSES });
        if ('error' in r) {
          if (!notes.includes(r.error)) notes.push(r.error);
          if (r.fatal) break;
          continue;
        }
        if (r.note) notes.push(r.note);
        for (const t of r.tracks) {
          if (seen.has(t.id) || (t.durationSec !== null && (t.durationSec < lo || t.durationSec > hi))) continue;
          if (t.format === 'ogg') {
            ogg++;
            continue;
          }
          seen.add(t.id);
          if (found.filter((f) => f.query === q).length >= limit) continue;
          found.push({ query: q, id: t.id, title: t.title, creator: t.creator, seconds: t.durationSec, license: t.licenseName, format: t.format, tags: t.tags ?? [], page: t.sourceUrl });
          lines.push(`  ${t.id} | "${t.title.slice(0, 70)}" | ${t.creator.slice(0, 30)} | ${t.durationSec === null ? '?' : `${t.durationSec} s`} | ${t.licenseName} | ${t.format}${t.tags?.length ? ` | tags: ${t.tags.slice(0, 6).join(', ')}` : ''} | ${t.sourceUrl}`);
        }
      }
      if (ogg) notes.push(`${ogg} Ogg file${ogg === 1 ? '' : 's'} left out (Ogg can't be decoded here).`);
      const text = [lines.length ? 'CC0 / public domain samples (add with audio_sample_add id):' : 'Nothing found: try other words (what it is, not how it should feel), or a built-in (audio_samples).', ...lines, ...notes].join('\n');
      return { content: [{ type: 'text', text }], data: { samples: found, notes } };
    },
  });

  reg.register({
    name: 'audio_sample_add',
    title: 'Add a sample',
    description: `Bring a sample into the library to compose with. id (from audio_sample_find): its license is looked up again on Openverse and must be CC0 or public domain; it is downloaded, decoded (MP3, WAV, FLAC, AIFF), cut to start/end when given, trimmed of silence, normalised, and measured: its pitch (a melodic one-shot's root), tempo and beats (a loop; a tempo in its name wins), key when named, loudness, where its energy is. Name it for what it is ("808 cowbell"). sample (a library id) instead changes what is known about one: root ("C#5"), kind, role, bpm, beats, name. Then play it: audio_music {samples} or audio_music_edit {op: "set", track, sample}. Samples are kept for every project; a song that uses one keeps a copy.`,
    capability: 'roblox.app.audio',
    permission: 'write_project',
    input: {
      id: z.string().optional().describe('An Openverse id from audio_sample_find'),
      sample: z.string().optional().describe('A sample already in the library, to correct what is known about it'),
      name: z.string().min(2).max(60).optional(),
      kind: z.enum(SAMPLE_KINDS).optional().describe('oneshot (a hit or a note), loop (rhythmic, fitted to the tempo), texture (a bed, played at its own speed). Default: guessed from its name and length'),
      role: z.enum(SAMPLE_ROLES).optional(),
      root: z.union([z.string(), z.number()]).optional().describe('The note it sounds at ("C#5" or MIDI), when the detected one is wrong'),
      bpm: z.number().min(50).max(220).optional(),
      beats: z.number().int().min(1).max(256).optional(),
      start: z.number().min(0).optional().describe('Seconds into the file to keep from'),
      end: z.number().positive().optional().describe('Seconds into the file to keep to'),
    },
    handler: async ({ args, signal, progress }) => {
      if (!!args.id === !!args.sample) return errorOutput('Give either id (an Openverse id from audio_sample_find) or sample (a library id to correct), not both and not neither.');
      let root: number | undefined;
      if (args.root !== undefined) {
        try {
          root = typeof args.root === 'number' ? args.root : midiOf(args.root.trim());
        } catch {
          return errorOutput(`root "${args.root}": a note like "C#5" or a MIDI number`);
        }
        if (!(root >= 12 && root <= 120)) return errorOutput('root must be a note between C0 and C9');
      }
      const lib = samples();
      if (args.sample) {
        try {
          const info = lib.update(args.sample, { ...(root !== undefined ? { root } : {}), ...(args.kind ? { kind: args.kind } : {}), ...(args.role ? { role: args.role } : {}), ...(args.bpm ? { bpm: args.bpm, beats: args.beats ?? Math.max(1, Math.round((lib.info(args.sample)!.durationSec * args.bpm) / 60)) } : {}), ...(args.name ? { name: args.name } : {}) });
          return jsonOutput({ updated: sampleOut(info) });
        } catch (e) {
          return errorOutput((e as Error).message);
        }
      }
      const id = args.id!.trim().replace(/^(openverse|ov):/i, '');
      const r = await openverse.lookup(id, { signal });
      if ('error' in r) return errorOutput(r.error);
      const t = r.track;
      if (!(SAMPLE_LICENSES as readonly string[]).includes(t.license)) return errorOutput(`"${t.title}" is ${t.licenseName}: samples take only CC0 or public domain (a sample becomes part of a new song, so nothing that needs a credit or limits use). Find another, or import the whole track with audio_import.`);
      progress?.({ message: `Downloading "${t.title}"` });
      const got = await downloadTrack(t.downloadUrl, net, { signal, maxSeconds: 900 });
      if (!got.ok) return errorOutput(got.error);
      const dec = decodeAudio(got.bytes, { maxSeconds: Math.max(90, (args.end ?? 0) + 1) });
      if (!dec.ok) return errorOutput(`"${t.title}" can't be used as a sample: ${dec.error}`);
      const name = (args.name ?? t.title).trim().slice(0, 60);
      let prepared;
      try {
        prepared = prepareSample(dec, { words: `${name} ${t.title} ${(t.tags ?? []).join(' ')}`, ...(args.kind ? { kind: args.kind } : {}), ...(args.role ? { role: args.role } : {}), ...(root !== undefined ? { root } : {}), ...(args.bpm ? { bpm: args.bpm } : {}), ...(args.beats ? { beats: args.beats } : {}), ...(args.start !== undefined ? { start: args.start } : {}), ...(args.end !== undefined ? { end: args.end } : {}) });
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const info = lib.saveWeb(name, prepared, {
        kind: 'web',
        license: t.license as SampleLicense,
        licenseName: t.licenseName,
        title: t.title,
        creator: t.creator,
        sourceUrl: t.sourceUrl,
        downloadUrl: t.downloadUrl,
        origin: t.origin,
        openverseId: t.id,
        ...(args.start !== undefined || args.end !== undefined ? { cut: { start: args.start ?? 0, end: args.end ?? dec.channels[0]!.length / dec.sampleRate } } : {}),
      }, t.tags ?? []);
      return jsonOutput({
        added: sampleOut(info),
        ...(prepared.notes.length ? { notes: prepared.notes } : {}),
        use: `audio_music_edit {name: "<song>", ops: [{op: "set", track: "<part>", sample: "${info.id}"}]} or audio_music {samples: {"<part>": "${info.id}"}}`,
      });
    },
  });

  reg.register({
    name: 'audio_samples',
    title: 'List samples',
    description: "The samples to compose with: the project's own, the web finds (CC0 / public domain), the user's own one-shots and loops (their \"My samples\" folder, picked up as they drop files in), and built-in TR-808 emulations (tr808-cowbell, -clap, -hat, -openhat, -kick, -snare, -rim) and textures (vinyl-crackle, tape-hiss). Each with its kind, role, root note, tempo, length, where its energy is, and where it came from. query filters by id, name, role or tags.",
    capability: 'roblox.app.audio',
    permission: 'read',
    input: {
      query: z.string().max(60).optional(),
      kind: z.enum(SAMPLE_KINDS).optional(),
      role: z.enum(SAMPLE_ROLES).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const lib = samples();
      const q = args.query?.trim().toLowerCase();
      const all = lib.list().filter((s) => (!args.kind || s.kind === args.kind) && (!args.role || s.role === args.role) && (!q || [s.id, s.name, s.role, ...(s.tags ?? [])].some((w) => w.toLowerCase().includes(q))));
      return jsonOutput({
        samples: all.slice(0, 80).map(sampleOut),
        ...(all.length > 80 ? { more: all.length - 80 } : {}),
        folders: { yours: lib.userDir, ...(lib.projectDir ? { project: lib.projectDir } : {}) },
        ...(lib.prepared.length ? { preparedNow: lib.prepared } : {}),
        ...(lib.skipped.length ? { skipped: lib.skipped } : {}),
        note: "The user adds their own by dropping WAV, AIFF, FLAC or MP3 files into the folders above (a tempo in a loop's file name, like \"85bpm\", fits it to the song).",
      });
    },
  });

  reg.register({
    name: 'audio_ambience',
    title: 'Make an ambience bed',
    description: `Design the sound of a place: a long seamless loop (8-60 s, stereo) that sits under everything, made of a bed and of things that happen in it. params is the audio_sfx voice language (see audio_sfx): the main voice and every layer that says nothing about its own length are HELD for the whole loop (wind, hum, hiss, rumble: noise through filters, low tones), and a layer with scatter: N plays N times at random moments of the loop, each a little different (scatterPitch octaves, scatterLevel dB, scatterPan), for the events (a far clank, a drip, a creak, a bird: any small sound with its own envelope). A bed evolves: give each held voice its own slow breathing (tremoloDepth 0.4-0.7 with tremoloSpeed 0.04-0.15 Hz, filterLfoDepth 0.5-1 with filterLfoSpeed 0.05-0.12 Hz: periods of 8-25 s that do not line up). width 0.6-0.9 and a space (outdoor, hangar, cave...) put it around the listener; keep it dark and low (it must leave 2-6 kHz to the game's effects). Mastered to -24 LUFS; the seam is closed for you (held voices get whole cycles, noise is crossfaded, events wrap). The result carries check (with the loop seam) and analysis {heard, improve, notes} like audio_sfx: static, short, mono, too bright and no-events beds are named with the parameters that fix them; change those and call again. It becomes a looping sound in the ambience group: play it with Audio.play(name) when the player enters the place, keep the Sound, stop it when they leave. A real recording (audio_find: rain, forest, city, crowds) beats this for natural places; design the ones no library has (a scrapyard arena, a reactor hall, an alien cave).`,
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: {
      name: z.string().describe('Sound name (letters, digits, _), e.g. Ambience_Scrapyard'),
      params: z.record(z.string(), z.unknown()).describe('The bed: the main voice, layers: [...] (held voices and scatter events) and the whole-sound fields (width, space, spaceMix, tone). See the description.'),
      seconds: z.number().min(8).max(60).optional().describe('Loop length (default 24). 20-40 s keeps its events from coming round like a clock.'),
      volume: z.number().min(0).max(10).optional(),
      description: z.string().optional(),
      upload: z.boolean().optional().describe('Upload to Roblox now (default true)'),
      draft: z.boolean().optional().describe(DRAFT),
    },
    handler: async ({ args, caller, signal }) => {
      if (!NAME.test(args.name)) return errorOutput('name must be letters, digits and _ (start with a letter)');
      const p = proj();
      const draft = isDraft(args.draft, caller);
      const name = draft ? new SoundLibrary(p.root).freeName(args.name) : args.name;
      let made;
      try {
        made = new AudioService(p).ambience({ name, params: args.params as Partial<SfxParams>, seconds: args.seconds, description: args.description, actor: caller.role ?? caller.kind, taskId: caller.taskId });
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const entry: Omit<SoundEntry, 'updatedAt'> = {
        name,
        kind: 'ambience',
        source: 'generated',
        assetId: null,
        file: made.file,
        volume: args.volume ?? 0.45,
        looped: true,
        pitchVariation: 0,
        description: args.description,
        category: 'ambience',
        ...(made.loop ? { loop: made.loop } : {}),
        check: made.check.summary,
        durationSec: Math.round(made.durationSec * 10) / 10,
        asset: made.asset.id,
        ...(draft ? { draft: true } : {}),
      };
      const f = made.feedback;
      const analysis = { heard: f.heard, improve: f.improve, ...(f.notes.length ? { notes: f.notes } : {}), next: f.improve.length || f.notes.length || !made.check.ok ? 'Change the parameters named in improve (and fix, notes) and call audio_ambience again with the same name.' : 'Nothing stands out in the measurements.' };
      return jsonOutput(await finish(p, entry as SoundEntry, caller, signal, args.upload !== false, made.check, { analysis, looped: true, ...(made.stereo ? { stereo: true } : {}) }));
    },
  });

  reg.register({
    name: 'audio_stinger',
    title: 'Compose a stinger',
    description: `Compose the few seconds of music that mark a moment: mood win (a rising figure into a held bright chord), lose (a falling one into a low dark chord), start (two pulses and an accent: ready, set, go) or reward (a quick bright run). It is written in the key and scale of the game's music and played by that style's instruments, so it never clashes with the track under it: give the same style (${STYLES.join(', ')}) and key you gave audio_music. Mastered as a stinger (-14 LUFS, stereo, 2-7 s, rings out). Play it 2D with Audio.play(name) at the moment (and duck or stop the music for a win or a loss).`,
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: {
      name: z.string().describe('Sound name (letters, digits, _), e.g. Stinger_Win'),
      mood: z.enum(STINGER_MOODS),
      style: z.enum(STYLES).optional().describe("The style of the game's music (default epic)"),
      key: z.string().optional().describe('The root note of the game\'s music, as given to audio_music: "D", "F#3", "D minor"'),
      bpm: z.number().min(50).max(200).optional(),
      volume: z.number().min(0).max(10).optional(),
      description: z.string().optional(),
      upload: z.boolean().optional().describe('Upload to Roblox now (default true)'),
      draft: z.boolean().optional().describe(DRAFT),
    },
    handler: async ({ args, caller, signal }) => {
      if (!NAME.test(args.name)) return errorOutput('name must be letters, digits and _ (start with a letter)');
      const p = proj();
      const draft = isDraft(args.draft, caller);
      const name = draft ? new SoundLibrary(p.root).freeName(args.name) : args.name;
      const style = (args.style ?? 'epic') as Style;
      let made;
      try {
        made = new AudioService(p).stinger({ name, mood: args.mood, style, key: args.key ? rootNote(args.key, style) : undefined, bpm: args.bpm, actor: caller.role ?? caller.kind, taskId: caller.taskId });
      } catch (e) {
        return errorOutput((e as Error).message);
      }
      const entry: Omit<SoundEntry, 'updatedAt'> = {
        name,
        kind: 'sfx',
        source: 'generated',
        assetId: null,
        file: made.file,
        volume: args.volume ?? 0.6,
        looped: false,
        pitchVariation: 0,
        description: args.description ?? `${args.mood} stinger (${style})`,
        style,
        category: 'stinger',
        check: made.check.summary,
        durationSec: Math.round(made.durationSec * 100) / 100,
        asset: made.asset.id,
        ...(draft ? { draft: true } : {}),
      };
      return jsonOutput({ ...(await finish(p, entry as SoundEntry, caller, signal, args.upload !== false, made.check)), mood: args.mood, style, bpm: made.spec.bpm });
    },
  });

  reg.register({
    name: 'audio_add',
    title: 'Add a Creator Store sound',
    description: 'Add a sound by Roblox asset id (e.g. from store_search asset_type Audio) to the game under a name, so code plays it through the ShurikenAudio module like the generated ones.',
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: {
      name: z.string(),
      asset_id: z.string().regex(/^\d+$/),
      kind: z.enum(['sfx', 'music', 'ambience']),
      volume: z.number().min(0).max(10).optional(),
      looped: z.boolean().optional(),
      pitch_variation: z.number().min(0).max(0.3).optional(),
      description: z.string().optional(),
    },
    handler: async ({ args, caller, signal }) => {
      if (!NAME.test(args.name)) return errorOutput('name must be letters, digits and _ (start with a letter)');
      const p = proj();
      const rec = new AssetService(p.store).record({
        name: args.name,
        kind: 'audio',
        source: `creator-store:${args.asset_id}`,
        robloxAssetId: args.asset_id,
        tags: [args.kind, 'store'],
        metadata: { type: args.kind, description: args.description ?? null },
        event: 'inserted',
        actor: caller.role ?? caller.kind,
        taskId: caller.taskId,
        runId: caller.runId,
      });
      const entry: Omit<SoundEntry, 'updatedAt'> = {
        name: args.name,
        kind: args.kind,
        source: 'store',
        assetId: args.asset_id,
        volume: args.volume ?? (args.kind === 'sfx' ? 0.6 : 0.45),
        looped: args.looped ?? args.kind !== 'sfx',
        pitchVariation: args.pitch_variation ?? (args.kind === 'sfx' ? 0.05 : 0),
        description: args.description,
        asset: rec.id,
        ...(caller.drafts ? { draft: true } : {}),
      };
      // A copilot's draft turn: under a free name (a draft never replaces a game sound), and not in the game.
      if (caller.drafts) entry.name = new SoundLibrary(p.root).freeName(args.name);
      return jsonOutput(await finish(p, entry as SoundEntry, caller, signal, false));
    },
  });

  reg.register({
    name: 'audio_find',
    title: 'Find existing tracks and sounds',
    description: `Search for a track or recording that already exists, before synthesizing one: (1) the Roblox Creator Store (free audio; the licensed libraries APM Music, Pro Sound Effects, KPM, Monstercat and Roblox's own are cleared for any Roblox game; needs Studio connected), and (2) Openverse (Freesound, Jamendo, Wikimedia; only licenses a game may use: CC0, public domain, CC BY, CC BY-SA, never non-commercial or no-derivatives). Returns candidates: title, creator, length, license, source page and the file's URL. Phrase queries as material + action + size ("heavy wooden door slam", "orchestral battle music epic", "drift phonk instrumental"). Openverse allows only a few anonymous searches an hour: put every phrasing in one call (queries, up to 3). Then add the best fit: a Creator Store hit with audio_add (asset_id), an Openverse hit with audio_import (id; it checks the license again, downloads it, keeps the credit). Search twice at most; when nothing fits, synthesize (audio_sfx, audio_music).`,
    capability: 'roblox.app.audio',
    permission: 'read',
    input: {
      queries: z.array(z.string().min(2).max(120)).min(1).max(3).describe('Different phrasings of what you need, e.g. ["drift phonk instrumental", "dark 808 cowbell trap"]'),
      sources: z.array(z.enum(['creator-store', 'openverse'])).min(1).optional().describe('Where to look (default: both)'),
      limit: z.number().int().min(1).max(10).optional().describe('Candidates per source and query (default 5)'),
      min_seconds: z.number().min(0).optional().describe('Leave out anything shorter (e.g. 60 for a track that has to loop as music)'),
      max_seconds: z.number().min(1).optional().describe('Leave out anything longer'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async ({ args, signal, caller }) => {
      noteMusicSearch(caller.runId, args.queries, args.min_seconds);
      const want = new Set(args.sources ?? ['creator-store', 'openverse']);
      const limit = args.limit ?? 5;
      const notes: string[] = [];
      const longEnough = (t: FoundTrack) => (args.min_seconds === undefined || t.durationSec === null || t.durationSec >= args.min_seconds) && (args.max_seconds === undefined || t.durationSec === null || t.durationSec <= args.max_seconds);

      const store: Array<{ id: string; title: string; creator: string; library: boolean; description: string }> = [];
      if (want.has('creator-store')) {
        if (!d.studio.connected) notes.push('Creator Store not searched: Studio is not connected (it is searched through Studio).');
        else {
          const seen = new Set<string>();
          const results = await Promise.all(
            args.queries.map((q) => d.studio.call('search_asset', { query: q, scope: 'creator_store', assetType: 'Audio', priceFilter: 'free', maxResults: Math.min(20, limit * 2) }, { timeoutMs: 60_000, signal })),
          );
          results.forEach((r, i) => {
            if (!r.ok) {
              notes.push(`Creator Store search for "${args.queries[i]}" failed: ${(r.error ?? 'unknown error').slice(0, 160)}`);
              return;
            }
            const found = parseStoreResults(r.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join(''), 'Audio', seen) ?? [];
            // The cleared libraries first: they are the ones a game can rely on.
            const sorted = [...found].sort((a, b) => Number(LICENSED_LIBRARY.test(b.creator)) - Number(LICENSED_LIBRARY.test(a.creator)));
            for (const a of sorted.slice(0, limit)) store.push({ id: a.assetId, title: a.name, creator: a.creator, library: LICENSED_LIBRARY.test(a.creator), description: a.description });
          });
        }
      }

      const web: FoundTrack[] = [];
      if (want.has('openverse')) {
        const seen = new Set<string>();
        const dropped: Record<string, number> = {};
        for (const q of args.queries) {
          const r = await openverse.search(q, limit, { signal });
          if ('error' in r) {
            // One refused or failed query does not end the search: the others are still asked (unless the site is down or the quota is spent).
            if (!notes.includes(r.error)) notes.push(r.error);
            if (r.fatal) break;
            continue;
          }
          if (r.note) notes.push(r.note);
          for (const [why, n] of Object.entries(r.dropped)) dropped[why] = (dropped[why] ?? 0) + n;
          for (const t of r.tracks.filter(longEnough).slice(0, limit))
            if (!seen.has(t.id)) {
              seen.add(t.id);
              web.push(t);
            }
        }
        const skipped = Object.entries(dropped)
          .map(([why, n]) => `${n} ${why}`)
          .join(', ');
        if (skipped) notes.push(`Openverse: left out ${skipped}.`);
      }

      const lines: string[] = [];
      if (store.length) {
        lines.push('Creator Store (add with audio_add asset_id):');
        for (const s of store) lines.push(`  ${s.id} | ${s.title.slice(0, 70)} | ${s.creator}${s.library ? ' (licensed library, cleared)' : ''}${s.description ? ` | ${s.description.slice(0, 80)}` : ''}`);
      }
      if (web.length) {
        lines.push('Openverse (import with audio_import id; CC0, public domain, CC BY, CC BY-SA only):');
        for (const t of web) lines.push(`  ${t.id} | "${t.title.slice(0, 70)}" | ${t.creator.slice(0, 40)} | ${mmss(t.durationSec)} | ${t.licenseName}${needsCredit(t.license) ? ' (credit required)' : ''} | ${t.format}${t.sizeBytes ? ` ${mb(t.sizeBytes)}` : ''} | ${t.origin} | page ${t.sourceUrl} | file ${t.downloadUrl}`);
      }
      if (!lines.length) lines.push('Nothing found for these queries.');
      for (const n of notes) lines.push(n);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        data: { creatorStore: store, openverse: web, notes },
      };
    },
  });

  reg.register({
    name: 'audio_import',
    title: 'Import a licensed track from the web',
    description: `Bring a web track into the game: downloads it (https only, at most ${MAX_IMPORT_BYTES / 1024 / 1024} MB and ${MAX_IMPORT_SECONDS / 60} minutes, a real mp3/ogg/wav/flac), saves it under assets/audio/imported, records its source, creator and license in the sound, and writes audio/CREDITS.md. After that it goes the way generated audio does: a draft when made from the Audio dock, otherwise uploaded to Roblox and built into ReplicatedStorage.ShurikenAudio. Give id (an Openverse id from audio_find): the license is looked up again, from Openverse, not taken from you. url (a direct https link) is only for a track whose page you read: then license (${COMMERCIAL_LICENSES.join(', ')}), title, creator and source_url are required. Never import without a clear commercial-use license: CC0, public domain, CC BY and CC BY-SA are accepted, nothing else. CC BY and CC BY-SA need a credit: tell the user, the result has the line (and audio/CREDITS.md lists every imported sound). The file is used as it is (not re-mastered or loudness-matched): set volume to balance it against the generated sounds.`,
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: {
      name: z.string().describe('Sound name (letters, digits, _), e.g. PhonkTheme'),
      kind: z.enum(['sfx', 'music', 'ambience']),
      id: z.string().optional().describe('Openverse id from audio_find'),
      url: z.string().optional().describe('A direct https link to the audio file (instead of id)'),
      license: z.enum(COMMERCIAL_LICENSES).optional().describe('With url: the license the source page states'),
      license_version: z.string().optional().describe('With url: e.g. "4.0"'),
      license_url: z.string().optional(),
      title: z.string().optional().describe('With url: the track title'),
      creator: z.string().optional().describe('With url: the creator or artist'),
      source_url: z.string().optional().describe('With url: the page the track is on (where its license is stated)'),
      volume: z.number().min(0).max(10).optional(),
      looped: z.boolean().optional().describe('Default: loops for music and ambience, not for effects'),
      description: z.string().optional(),
      upload: z.boolean().optional().describe('Upload to Roblox now (default true)'),
      draft: z.boolean().optional().describe(DRAFT),
    },
    handler: async ({ args, caller, signal, progress }) => {
      if (!NAME.test(args.name)) return errorOutput('name must be letters, digits and _ (start with a letter)');
      if (!!args.id === !!args.url) return errorOutput('Give either id (an Openverse id from audio_find) or url, not both and not neither.');
      let credit: SoundCredit;
      let downloadUrl: string;
      if (args.id) {
        const id = args.id.trim().replace(/^(openverse|ov):/i, '');
        if (/^(store:)?\d+$/i.test(id)) return errorOutput('That is a Creator Store asset id: add it with audio_add (asset_id), it needs no download.');
        const r = await openverse.lookup(id, { signal });
        if ('error' in r) return errorOutput(r.error);
        const t = r.track;
        downloadUrl = t.downloadUrl;
        credit = { title: t.title, creator: t.creator, ...(t.creatorUrl ? { creatorUrl: t.creatorUrl } : {}), license: t.license, licenseName: t.licenseName, ...(t.licenseUrl ? { licenseUrl: t.licenseUrl } : {}), sourceUrl: t.sourceUrl, downloadUrl: t.downloadUrl, attribution: t.attribution, origin: t.origin, importedAt: new Date().toISOString() };
      } else {
        const missing = (['license', 'title', 'creator', 'source_url'] as const).filter((k) => !args[k]?.trim());
        if (missing.length) return errorOutput(`With url, ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required: the license must be one you read on the track's page (${COMMERCIAL_LICENSES.join(', ')}). Without a clear commercial-use license, do not import it.`);
        const u = checkUrl(args.url!);
        if (!u.ok) return errorOutput(`url refused: ${u.error}`);
        const page = checkUrl(args.source_url!);
        if (!page.ok) return errorOutput(`source_url refused: ${page.error}`);
        const license = args.license!;
        const lname = licenseName(license, args.license_version?.trim() || null);
        downloadUrl = args.url!;
        credit = {
          title: args.title!.trim().slice(0, 120),
          creator: args.creator!.trim().slice(0, 120),
          license,
          licenseName: lname,
          ...(args.license_url ? { licenseUrl: args.license_url } : {}),
          sourceUrl: args.source_url!,
          downloadUrl,
          attribution: `"${args.title!.trim()}" by ${args.creator!.trim()}, ${needsCredit(license) ? 'licensed under' : 'marked'} ${lname}${args.license_url ? ` (${args.license_url})` : ''}. Source: ${args.source_url}`,
          origin: u.url.hostname,
          importedAt: new Date().toISOString(),
        };
      }
      // A slow server can take minutes: say so now and then, so the caller does not give up on a quiet call.
      let lastNote = 0;
      progress?.({ message: `Downloading "${credit.title}"` });
      const got = await downloadTrack(downloadUrl, net, {
        signal,
        onProgress: (bytes) => {
          if (Date.now() - lastNote > 5000) {
            lastNote = Date.now();
            progress?.({ message: `Downloading "${credit.title}": ${mb(bytes)}` });
          }
        },
      });
      if (!got.ok) return errorOutput(got.error);
      const p = proj();
      const draft = isDraft(args.draft, caller);
      const name = draft ? new SoundLibrary(p.root).freeName(args.name) : args.name;
      const made = new AudioService(p).importTrack({ name, bytes: got.bytes, format: got.format, durationSec: got.durationSec, sampleRate: got.sampleRate, channels: got.channels, kind: args.kind, credit, actor: caller.role ?? caller.kind, taskId: caller.taskId });
      const entry: Omit<SoundEntry, 'updatedAt'> = {
        name,
        kind: args.kind,
        source: 'imported',
        assetId: null,
        file: made.file,
        volume: args.volume ?? (args.kind === 'sfx' ? 0.6 : 0.45),
        looped: args.looped ?? args.kind !== 'sfx',
        pitchVariation: args.kind === 'sfx' ? 0.05 : 0,
        description: args.description ?? credit.title,
        credit,
        check: `imported ${got.format}, ${mmss(got.durationSec)}, ${mb(got.bytes.length)}, used as downloaded (not loudness-matched: balance it with volume)`,
        durationSec: made.durationSec,
        asset: made.asset.id,
        ...(draft ? { draft: true } : {}),
      };
      return jsonOutput({ ...(await finish(p, entry as SoundEntry, caller, signal, args.upload !== false)), format: got.format, bytes: got.bytes.length });
    },
  });

  reg.register({
    name: 'audio_upload',
    title: 'Upload sounds to Roblox',
    description: 'Upload generated sounds that have no Roblox asset id yet (all, or one by name). Needs an Open Cloud key with the Assets permission; reports exactly what the user must fix when it cannot.',
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: { name: z.string().optional() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const lib = new SoundLibrary(p.root);
      const todo = lib.inGame().filter((s) => s.source !== 'store' && (!args.name || s.name === args.name) && (!s.assetId || (s.variations ?? []).some((v) => !v.assetId)));
      if (!todo.length) return jsonOutput({ uploaded: [], note: 'nothing to upload' });
      const done: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const s of todo) {
        const r = await uploadEntry(p, s, signal);
        lib.save(r.entry);
        if (r.entry.asset && r.entry.assetId) new AssetService(p.store).update(r.entry.asset, { robloxAssetId: r.entry.assetId });
        if (r.note) failed.push({ name: s.name, error: r.note });
        else done.push(s.name);
        if (r.note && /key|permission|creator/i.test(r.note)) break;
      }
      const b = await build(p, lib, caller, signal);
      const body = { uploaded: done, failed, studio: 'note' in b ? b.note : 'rebuilt' };
      return failed.length ? { ...jsonOutput(body, 'Some sounds did not upload'), isError: true } : jsonOutput(body);
    },
  });

  reg.register({
    name: 'audio_use',
    title: 'Add a draft sound to the game',
    description:
      'Adds a draft (a sound made in the Audio dock to try out) to the game: uploads it when an Open Cloud key allows and builds it into ReplicatedStorage.ShurikenAudio, so code can play it with the ShurikenAudio module. as: put it in under another name, replacing that sound (a better take of "Jump" made as the draft "Jump2").',
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: { name: z.string(), as: z.string().optional().describe('The game sound it replaces (default: its own name).') },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const lib = new SoundLibrary(p.root);
      const e = lib.get(args.name);
      if (!e) return errorOutput(`No sound named ${args.name}`);
      const target = args.as?.trim() || e.name;
      if (!NAME.test(target)) return errorOutput('as must be letters, digits and _ (start with a letter)');
      if (!e.draft && target === e.name) return jsonOutput({ name: e.name, note: 'It is in the game already.' });
      const entry: SoundEntry = { ...e, name: target };
      delete entry.draft;
      if (target !== e.name) lib.remove(e.name);
      const out = await finish(p, entry, caller, signal, true);
      return jsonOutput({ ...out, ...(target !== e.name ? { replaced: target, was: e.name } : {}) });
    },
  });

  reg.register({
    name: 'audio_list',
    title: 'List sounds',
    description: "The game's sounds and the Audio dock's drafts (audio/*.sound.json): kind, source, asset id (upload state), volume, draft (made in the dock to try out, not in the game until audio_use), playedBy (the scripts that play it), and the SFX presets and music styles available.",
    capability: 'roblox.app.audio',
    permission: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const p = proj();
      const lib = new SoundLibrary(p.root);
      const use = lib.usage(p.extras().syncMap);
      return jsonOutput({
        sounds: lib.all().map((s) => ({
          name: s.name,
          kind: s.kind,
          source: s.source,
          assetId: s.assetId,
          volume: s.volume,
          looped: s.looped,
          variations: (s.variations ?? []).length,
          ...(s.category ? { category: s.category } : {}),
          ...(s.check ? { check: s.check } : {}),
          ...(s.credit ? { license: s.credit.licenseName, creator: s.credit.creator, creditRequired: s.credit.license === 'by' || s.credit.license === 'by-sa' } : {}),
          uploadError: s.upload?.error ?? null,
          ...(s.draft ? { draft: true } : { playedBy: use.get(s.name) ?? [] }),
        })),
        runtime: SoundLibrary.runtimeLocation(p.extras().syncMap),
        sfxPresets: Object.keys(SFX_PRESETS),
        musicStyles: STYLES,
        loudnessTargets: Object.fromEntries(AUDIO_CATEGORIES.map((c) => [c, `${LOUDNESS_TARGETS[c].lufs} LUFS (${LOUDNESS_TARGETS[c].measure})`])),
      });
    },
  });

  reg.register({
    name: 'audio_remove',
    title: 'Remove a sound',
    description: 'Remove a sound from the game (its entry; generated files stay in assets/audio).',
    capability: 'roblox.app.audio',
    permission: 'roblox_write',
    input: { name: z.string() },
    handler: async ({ args, caller, signal }) => {
      const p = proj();
      const lib = new SoundLibrary(p.root);
      const was = lib.get(args.name);
      if (caller.drafts && was && !was.draft) return errorOutput(`${args.name} is in the game: removing it changes the game, which this turn can't. It goes when the user says so ("remove ${args.name} from the game").`);
      if (!lib.remove(args.name)) return errorOutput(`No sound named ${args.name}`);
      d.bus.emit('assets.changed', {});
      if (was?.draft) return jsonOutput({ removed: args.name, draft: true, remaining: lib.names() });
      const b = await build(p, lib, caller, signal);
      return jsonOutput({ removed: args.name, remaining: lib.names(), studio: 'note' in b ? b.note : 'rebuilt' });
    },
  });
}
