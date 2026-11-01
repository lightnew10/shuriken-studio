import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { clock, riseWords, type ReferenceFrame, type ReferenceRecord } from '@shared/references';
import type { CapabilityRegistry } from './capability-registry';
import type { ReferenceService } from '../references/reference-service';
import { describeKind, statusWords, type ReferenceStore } from '../references/reference-store';
import { mimeForPath } from '../util/mime';
import { errorOutput, type ToolContent, type ToolRegistry } from './tool-registry';

/**
 * The agents' way to the user's reference footage and pictures: reference_list names them with what each is
 * for, reference_view shows one — its study, its frames by time (and new ones at a higher rate in a short
 * window), its sound, the picture. Reading only. Seen by the planner, the director's looking pass, the critic,
 * the dock copilots and the specialists whose work a reference can show (not QA, security, performance or
 * copy).
 */

export interface ReferenceToolDeps {
  references: () => ReferenceService | null;
  /** Whether the app can decode media here (detail frames; the capability's health). */
  canDecode: boolean;
  capabilities: CapabilityRegistry;
}

const COPILOT_ROLE_IDS = ['animation', 'audio', 'ui', 'effects', 'store', 'copy', 'thumbnails'].map((id) => `copilot-${id}`);

/** Who sees the reference tools (a role with its own tool list also has to list them). */
export const REFERENCE_TOOL_ROLES = [
  'executive', 'director', 'critic', 'reference-analyst',
  'game-designer', 'level-designer', 'environment-artist', 'roblox-engineer', 'luau-engineer', 'ui-engineer',
  'sound-designer', 'animator', 'vfx-artist', 'modeler', 'thumbnail-artist',
  ...COPILOT_ROLE_IDS,
];

export const REFERENCE_LIMITATIONS = [
  'Frames are samples (spread evenly, plus right after cuts and at loud hits): motion between two frames is not seen; reference_view detail captures up to 30 fps in a window of up to 4 s.',
  'Sound is measured, not heard: loudness, onsets, a tempo estimate (may be half or double), spectral balance and spectrograms.',
  'Speech is not transcribed.',
  'Videos are decoded by Chromium inside the app: MP4 (H.264/AAC), WebM (VP8/VP9/AV1, Opus/Vorbis) and most MOV; HEVC only where Windows has the decoder. The sound of files over 600 MB and beyond 15 minutes is not measured.',
];

function frameContent(store: ReferenceStore, rec: ReferenceRecord, f: ReferenceFrame): ToolContent[] {
  try {
    const abs = store.file(rec.id, `frames/${f.file}`);
    if (!existsSync(abs)) return [];
    return [
      { type: 'text', text: `Frame at ${f.t.toFixed(2)} s${f.why === 'scene' ? ' (right after a cut)' : f.why === 'sound' ? ' (at a loud hit)' : f.why === 'detail' ? ' (detail)' : ''}` },
      { type: 'image', data: readFileSync(abs).toString('base64'), mimeType: mimeForPath(abs) ?? 'image/jpeg' },
    ];
  } catch {
    return [];
  }
}

/** Up to `max` of the frames, spread evenly over them. */
function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / Math.max(1, max - 1))]!);
  return [...new Set(out)];
}

function recordLines(rec: ReferenceRecord): string[] {
  const out = [`"${rec.name}" (${rec.id}): ${describeKind(rec)}, ${statusWords(rec)}${rec.error ? ` — ${rec.error}` : ''}.`];
  if (rec.study?.summary) out.push(`Summary: ${rec.study.summary}`);
  if (rec.video) out.push(`Frames: ${rec.video.coverage}${rec.video.detail?.length ? ` Plus ${rec.video.detail.length} detail frames.` : ''}${rec.video.cuts.length ? ` Cuts at ${rec.video.cuts.map((t) => `${t.toFixed(1)} s`).join(', ')}.` : ''}`);
  if (rec.audio) out.push(`Sound (measured, not heard; speech not transcribed): ${rec.audio.integratedLufs ?? '—'} LUFS, ${rec.audio.tempo ? `about ${rec.audio.tempo.bpm} bpm` : 'no steady beat'}, bass/mid/high ${Math.round(rec.audio.balance.bass * 100)}/${Math.round(rec.audio.balance.mid * 100)}/${Math.round(rec.audio.balance.high * 100)}%, ${rec.audio.onsets} onsets, ${rec.audio.events.length} loud hits.`);
  else if (rec.audioNote) out.push(`Sound: ${rec.audioNote}`);
  const pal = rec.video?.palette ?? rec.image?.palette ?? [];
  if (pal.length) out.push(`Palette: ${pal.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(', ')}.`);
  return out;
}

export function registerReferenceTools(reg: ToolRegistry, d: ReferenceToolDeps): void {
  d.capabilities.upsert({
    id: 'app.references',
    integration: 'shuriken',
    name: 'Reference footage and images',
    status: d.canDecode ? 'healthy' : 'degraded',
    description: "The user's reference clips and pictures: sampled frames, measured sound, a study per reference.",
    detail: d.canDecode ? null : 'No media decoder here (plain Node): pictures in PNG or JPEG only, no videos, no detail frames.',
    limitations: REFERENCE_LIMITATIONS,
  });
  const svc = (): ReferenceService => {
    const s = d.references();
    if (!s) throw new Error('No project is open in Shuriken');
    return s;
  };

  reg.register({
    name: 'reference_list',
    title: 'List the reference footage and pictures',
    description:
      "The user's references for this game: clips of other games whose feel they want (combat, movement, UI, effects, sound) and pictures (concept art, UI screenshots). Each with its id, kind, whether its study is written, and what it is a reference for. reference_view shows one.",
    capability: 'app.references',
    permission: 'read',
    roles: REFERENCE_TOOL_ROLES,
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const refs = svc().list();
      if (!refs.length) return { content: [{ type: 'text', text: 'The user has given no references for this game (they add them on the References page or by dropping a video or picture in the chat).' }], data: [] };
      const lines = [`${refs.length} reference${refs.length === 1 ? '' : 's'} (reference_view {id} shows one):`];
      for (const r of refs) {
        lines.push(`- ${r.id} "${r.name}" — ${describeKind(r)}, ${statusWords(r)}${r.study?.summary ? `: ${r.study.summary}` : ''}${r.study?.tags.length ? ` [${r.study.tags.join(', ')}]` : ''}`);
        if (r.study?.takeaways.length) lines.push(`  Take: ${r.study.takeaways.slice(0, 4).join(' · ')}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        data: refs.map((r) => ({ id: r.id, name: r.name, kind: r.kind, status: r.status, duration: r.duration ?? null, summary: r.study?.summary ?? null, tags: r.study?.tags ?? [], takeaways: r.study?.takeaways ?? [] })),
      };
    },
  });

  reg.register({
    name: 'reference_view',
    title: 'Look at a reference',
    description:
      'One of the user\'s references. By default: its study (what it is, its UI, combat and movement timings, effects, style, sound, what to take into our game) and a few frames spread over it, or the picture. part "frames" with from/to (seconds) shows the stored frames there (frames are samples: about one a second plus after cuts and at loud hits); detail: true first captures new frames at fps (up to 30) in that window (at most 4 s), for reading a wind-up, an impact or a hit-stop closely. part "sound": the measured sound (it is measured, not heard; speech is not transcribed) with the loud hits and their nearest frames, and its spectrogram for that time. part "study": the study\'s text only.',
    capability: 'app.references',
    permission: 'read',
    roles: REFERENCE_TOOL_ROLES,
    input: {
      id: z.string().describe('The reference: its id (ref_…) or its name'),
      part: z.enum(['overview', 'study', 'frames', 'sound']).optional().describe('Default overview: the study and a few frames (or the picture)'),
      from: z.number().min(0).optional().describe('Seconds: the start of the stretch to look at'),
      to: z.number().min(0).optional().describe('Seconds: its end'),
      max: z.number().int().min(1).max(16).optional().describe('At most this many frames (default 8 for overview, 12 for frames)'),
      detail: z.boolean().optional().describe('part frames: capture new frames at `fps` between from and to (at most 4 s) first'),
      fps: z.number().min(1).max(30).optional().describe('Detail frames per second (default 15)'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const s = svc();
      const store = s.store();
      const found = store.find(args.id);
      if (!found) return errorOutput(`No reference "${args.id}". reference_list names them.`);
      const rec = s.get(found.id) ?? found;
      const part = args.part ?? 'overview';
      const content: ToolContent[] = [];
      const text = (t: string) => content.push({ type: 'text', text: t });
      const from = args.from ?? 0;
      const to = args.to ?? rec.duration ?? Infinity;
      if (part === 'study' || part === 'overview') {
        const study = store.study(rec.id);
        text(study ?? [...recordLines(rec), rec.status === 'failed' ? '' : 'Its study is not written yet.'].filter(Boolean).join('\n'));
        if (part === 'study') return { content, data: { id: rec.id, status: rec.status } };
      }
      if (rec.kind === 'image') {
        if (rec.image) {
          const abs = store.file(rec.id, rec.image.preview);
          if (existsSync(abs)) content.push({ type: 'text', text: `The picture (${rec.image.width}×${rec.image.height}; ui_reference {file: "${store.projectPath(rec.id, rec.image.preview)}"} samples its colours and fonts and compares a mockup with it):` }, { type: 'image', data: readFileSync(abs).toString('base64'), mimeType: mimeForPath(abs) ?? 'image/png' });
        }
        return { content, data: { id: rec.id, kind: rec.kind, status: rec.status } };
      }
      if (!rec.video) {
        text(`Its frames aren't taken yet (${statusWords(rec)}).`);
        return { content, data: { id: rec.id, status: rec.status } };
      }
      if (part === 'sound') {
        const audio = store.audio(rec.id);
        if (!audio) {
          text(`No sound was measured: ${rec.audioNote ?? 'none was found.'}`);
          return { content, data: { id: rec.id } };
        }
        const inRange = audio.events.filter((e) => e.t >= from - 1e-6 && e.t <= to + 1e-6);
        text(
          [
            `Sound of "${rec.name}" — measured from the waveform, not heard; speech is not transcribed.`,
            ...recordLines(rec).filter((l) => l.startsWith('Sound')),
            `Loudness range ${audio.rangeDb} dB, silence ${Math.round(audio.silenceRatio * 100)}%, peak ${audio.peakDb} dBFS, centroid ${audio.centroidHz} Hz, ${audio.onsetsPerMinute} onsets a minute.`,
            inRange.length ? `Loud hits${args.from !== undefined || args.to !== undefined ? ` between ${from} and ${Number.isFinite(to) ? to : 'the end'} s` : ''} (time, peak, jump, character, decay → nearest frame):` : 'No loud hits in that stretch.',
            ...inRange.map((e) => `  ${e.t.toFixed(2)} s  ${e.peakDb} dBFS  ${riseWords(e.riseDb)}  ${e.character}  ${e.decayMs} ms${e.frame ? `  → frame ${e.frame.t.toFixed(2)} s (${e.frame.dt >= 0 ? '+' : ''}${e.frame.dt} s)` : ''}`),
            `Onsets in that stretch: ${audio.onsetList.filter((o) => o.t >= from && o.t <= to).slice(0, 80).map((o) => o.t.toFixed(2)).join(', ') || 'none'}`,
          ].join('\n'),
        );
        const strips = (rec.spectrograms ?? []).filter((st) => st.t1 > from && st.t0 < to).slice(0, 3);
        for (const st of strips) {
          const abs = store.file(rec.id, st.file);
          if (existsSync(abs)) content.push({ type: 'text', text: `Spectrogram ${st.t0}–${st.t1} s (log frequency, lines at 100/1000/5000 Hz; level lane below; white ticks onsets, orange marks loud hits; ruler in seconds)` }, { type: 'image', data: readFileSync(abs).toString('base64'), mimeType: 'image/png' });
        }
        return { content, data: { id: rec.id, events: inRange.length } };
      }
      let frames: ReferenceFrame[];
      if (part === 'frames' && args.detail) {
        if (args.from === undefined) return errorOutput('detail needs from (and to): the window to capture, at most 4 s.');
        try {
          frames = await s.captureDetail(rec.id, from, Math.min(to, from + 4), args.fps ?? 15);
        } catch (e) {
          return errorOutput((e as Error).message);
        }
      } else frames = [...rec.video.frames, ...(rec.video.detail ?? [])].filter((f) => f.t >= from - 1e-6 && f.t <= to + 1e-6).sort((a, b) => a.t - b.t);
      const max = args.max ?? (part === 'frames' ? (args.detail ? 16 : 12) : 8);
      const shown = spread(frames, max);
      if (part === 'frames') text(`${frames.length} frame${frames.length === 1 ? '' : 's'} of "${rec.name}" between ${clock(from, true)} and ${Number.isFinite(to) ? clock(to, true) : 'the end'}${shown.length < frames.length ? `; ${shown.length} shown, spread over them (narrow from/to for the rest)` : ''}. Motion between frames is not seen.`);
      else text(`${shown.length} of its ${frames.length} frames, spread over it (part "frames" with from/to for a stretch):`);
      for (const f of shown) content.push(...frameContent(store, rec, f));
      return { content, data: { id: rec.id, frames: frames.map((f) => ({ t: f.t, why: f.why })) } };
    },
  });
}
