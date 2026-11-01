import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from '../projects/project-service';
import { AssetService, type AssetRecord } from '../assets/asset-service';
import { SAMPLE_RATE, composeStyle, peaks, renderSong, songLoopStart, type SfxParams, type SongSpec, type Style } from './synth';
import { checkAudio, mp3LoopRegion, type AudioCategory, type AudioCheck, type LoopRegion } from './dsp/master';
import type { SoundKind } from './dsp/analyze';
import { bedParams, designSfx, type SfxDesign, type SfxFeedback } from './sfx-design';
import { composeStinger, type StingerMood } from './stinger';
import { MP3_KBPS, encodeMp3 } from './mp3';
import type { AudioFormat } from './probe';
import type { SoundCredit } from './audio-library';
import type { SampleBank } from './sampler';
import type { MixReport } from './music-analysis';

export { MP3_KBPS, encodeMp3 };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'sound';

export interface AudioResult {
  asset: AssetRecord;
  file: string;
  durationSec: number;
  variations?: string[];
  /** The mastering gate: peak, loudness, DC, start silence and (loops) the seam. */
  check: AudioCheck;
  /** Looped MP3s: where the audio sits in the decoded file (skips the encoder delay and padding). */
  loop?: LoopRegion;
}

/**
 * Makes game audio offline and keeps it with the project: files under assets/audio, entries in the
 * asset library (with waveform peaks for the UI and the spec that produced them, so a sound can be
 * regenerated or tweaked later).
 */
export class AudioService {
  constructor(private readonly project: ProjectContext) {}

  private dir(sub: 'sfx' | 'music' | 'ambience'): string {
    const d = join(this.project.root, 'assets', 'audio', sub);
    mkdirSync(d, { recursive: true });
    return d;
  }

  sfx(input: { name: string; preset?: string; params?: Partial<SfxParams>; category?: AudioCategory; variations?: number; kind?: SoundKind; heavy?: boolean; description?: string; actor: string; taskId?: string | null }): AudioResult & { feedback: SfxFeedback; stereo: boolean } {
    return this.saveDesign(designSfx(input), input, 'sfx');
  }

  /**
   * An ambience bed: a long seamless loop made with the effect engine. Every voice that says nothing about
   * its own length is held for the whole loop; a layer with `scatter` (or its own envelope) is an event in it.
   */
  ambience(input: { name: string; params: Partial<SfxParams>; seconds?: number; description?: string; actor: string; taskId?: string | null }): AudioResult & { feedback: SfxFeedback; stereo: boolean } {
    return this.saveDesign(designSfx({ name: input.name, params: bedParams(input.params, input.seconds ?? 24), category: 'ambience', kind: 'loop', description: input.description }), input, 'ambience');
  }

  private saveDesign(made: SfxDesign, input: { name: string; preset?: string; actor: string; taskId?: string | null }, sub: 'sfx' | 'ambience'): AudioResult & { feedback: SfxFeedback; stereo: boolean } {
    const { params, category, check, loop } = made;
    const name = slug(input.name);
    const dir = this.dir(sub);
    const pcm = made.takes[0]!;
    const file = join(dir, `${name}.mp3`);
    writeFileSync(file, encodeMp3(pcm, MP3_KBPS));
    const variations: string[] = [];
    for (let k = 1; k < made.takes.length; k++) {
      const f = join(dir, `${name}-${k + 1}.mp3`);
      writeFileSync(f, encodeMp3(made.takes[k]!, MP3_KBPS));
      variations.push(this.rel(f));
    }
    const durationSec = pcm[0]!.length / SAMPLE_RATE;
    const asset = new AssetService(this.project.store).record({
      name: input.name,
      kind: 'audio',
      source: `shuriken:${sub} by ${input.actor}`,
      path: this.rel(file),
      tags: [sub, ...(input.preset ? [input.preset] : [])],
      metadata: { type: sub, preset: input.preset ?? null, params, category, judgedAs: made.kind, durationSec, channels: pcm.length, peaks: peaks(pcm, 120), variations, file: this.rel(file), check: check.summary, ...(loop ? { loop } : {}) },
      event: 'generated',
      actor: input.actor,
      taskId: input.taskId ?? null,
    });
    return { asset, file: this.rel(file), durationSec, variations, check, feedback: made.feedback, stereo: pcm.length === 2, ...(loop ? { loop } : {}) };
  }

  /** A stinger: two to six seconds of music for a moment of the game, in the key and with the instruments of a music style. */
  stinger(input: { name: string; mood: StingerMood; style?: Style; key?: string; bpm?: number; actor: string; taskId?: string | null }): AudioResult & { spec: SongSpec } {
    const spec = composeStinger(input.mood, { style: input.style, key: input.key, bpm: input.bpm });
    const [L, R] = renderSong(spec, 7, { category: 'stinger', oneShot: true });
    const check = checkAudio([L, R], { category: 'stinger' });
    const file = join(this.dir('sfx'), `${slug(input.name)}.mp3`);
    writeFileSync(file, encodeMp3([L, R], MP3_KBPS));
    const durationSec = L.length / SAMPLE_RATE;
    const asset = new AssetService(this.project.store).record({
      name: input.name,
      kind: 'audio',
      source: `shuriken:stinger by ${input.actor}`,
      path: this.rel(file),
      tags: ['sfx', 'stinger', input.mood, ...(input.style ? [input.style] : [])],
      metadata: { type: 'sfx', stinger: input.mood, style: input.style ?? null, spec, category: 'stinger', durationSec, channels: 2, peaks: peaks([L, R], 120), file: this.rel(file), check: check.summary },
      event: 'generated',
      actor: input.actor,
      taskId: input.taskId ?? null,
    });
    return { asset, file: this.rel(file), durationSec, check, spec };
  }

  /**
   * A song: composed from a style, or a given score (an edited one renders with its own seed, so what was not
   * changed sounds the same). Tracks that play samples find them in `samples`. The score is saved next to the
   * MP3 (<name>.song.json) with its seed.
   */
  music(input: { name: string; style?: Style; spec?: SongSpec; key?: string; bpm?: number; bars?: number; seed?: number; category?: 'music' | 'ambience'; samples?: SampleBank; actor: string; taskId?: string | null }): AudioResult & { spec: SongSpec; loop: LoopRegion; report: MixReport | null } {
    const spec = input.spec ?? composeStyle(input.style ?? 'lofi', { key: input.key, bpm: input.bpm, bars: input.bars, seed: input.seed });
    const category = input.category ?? 'music';
    spec.seed = input.seed ?? spec.seed ?? 7;
    let report: MixReport | null = null;
    const [L, R] = renderSong(spec, spec.seed, { category, samples: input.samples, onReport: (r) => (report = r) });
    const introFrames = songLoopStart(spec);
    const check = checkAudio([L, R], { category, loop: true, loopStart: introFrames, ...(spec.loudness !== undefined ? { targetLufs: spec.loudness, measure: 'integrated' as const } : {}) });
    const loop = mp3LoopRegion(L.length - introFrames, SAMPLE_RATE, introFrames);
    const name = slug(input.name);
    const dir = this.dir('music');
    const file = join(dir, `${name}.mp3`);
    writeFileSync(file, encodeMp3([L, R], MP3_KBPS));
    writeFileSync(join(dir, `${name}.song.json`), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    const durationSec = L.length / SAMPLE_RATE;
    const svc = new AssetService(this.project.store);
    // Re-composing a track with the same name is a new version of the same asset.
    const existing = svc.list(undefined, 'audio').find((a) => a.path === this.rel(file));
    const metadata = { type: 'music', style: input.style ?? null, spec, category, durationSec, peaks: peaks([L, R], 240), file: this.rel(file), bpm: spec.bpm, beats: spec.beats, loop, check: check.summary };
    let asset: AssetRecord;
    if (existing) {
      svc.update(existing.id, { metadata, name: input.name });
      svc.addEvent(existing.id, 'modified', input.actor, `recomposed (${spec.tracks.length} tracks, ${Math.round(durationSec)} s)`, null, input.taskId);
      asset = svc.bumpVersion(existing.id);
    } else {
      asset = svc.record({ name: input.name, kind: 'audio', source: `shuriken:music by ${input.actor}`, path: this.rel(file), tags: ['music', ...(input.style ? [input.style] : [])], metadata, event: 'generated', actor: input.actor, taskId: input.taskId ?? null });
    }
    return { asset, file: this.rel(file), durationSec, spec, check, loop, report };
  }

  /**
   * Keeps a track brought in from the web (already checked by sourcing.downloadTrack) under
   * assets/audio/imported and records it in the asset library with its license. The file is saved as it
   * came: nothing is decoded or re-encoded, so it is not loudness-matched (set the sound's volume).
   */
  importTrack(input: { name: string; bytes: Uint8Array; format: AudioFormat; durationSec: number; sampleRate: number; channels: number; kind: 'sfx' | 'music' | 'ambience'; credit: SoundCredit; actor: string; taskId?: string | null }): { asset: AssetRecord; file: string; durationSec: number } {
    const dir = join(this.project.root, 'assets', 'audio', 'imported');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slug(input.name)}.${input.format}`);
    writeFileSync(file, input.bytes);
    const durationSec = Math.round(input.durationSec * 100) / 100;
    const metadata = { type: input.kind, imported: true, durationSec, format: input.format, sampleRate: input.sampleRate, channels: input.channels, bytes: input.bytes.length, file: this.rel(file), credit: input.credit };
    const svc = new AssetService(this.project.store);
    const existing = svc.list(undefined, 'audio').find((a) => a.path === this.rel(file));
    let asset: AssetRecord;
    if (existing) {
      svc.update(existing.id, { metadata, name: input.name });
      svc.addEvent(existing.id, 'modified', input.actor, `imported again from ${input.credit.sourceUrl}`, null, input.taskId);
      asset = svc.bumpVersion(existing.id);
    } else {
      asset = svc.record({
        name: input.name,
        kind: 'audio',
        source: `imported:${input.credit.origin ?? 'web'} ${input.credit.sourceUrl}`,
        path: this.rel(file),
        tags: [input.kind, 'imported', input.credit.license],
        metadata,
        event: 'registered',
        actor: input.actor,
        taskId: input.taskId ?? null,
        summary: `imported "${input.credit.title}" by ${input.credit.creator} (${input.credit.licenseName})`,
      });
    }
    return { asset, file: this.rel(file), durationSec };
  }

  private rel(abs: string): string {
    return abs.slice(this.project.root.length + 1).replaceAll('\\', '/');
  }
}
