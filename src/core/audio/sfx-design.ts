/**
 * One pass of sound design, without the files: the parameters as they will be rendered, the takes, the
 * mastering gate and the feedback (dsp/analyze: what it measures as and what a sound designer would change).
 * AudioService saves what this returns; tests and the proof scripts call it directly.
 */
import { SFX_ENGINE, lintSfx, renderTakeChannels, type SfxParams, type SfxPlacement, type SfxRenderInfo, type SfxVoice } from './sfx';
import { SFX_PRESETS } from './sfx-presets';
import { checkAudio, mp3LoopRegion, type AudioCategory, type AudioCheck, type LoopRegion } from './dsp/master';
import { analyzeSound, critiqueSound, guessKind, takeDifference, type SoundAnalysis, type SoundKind } from './dsp/analyze';

/**
 * What an effect sounds like, in numbers and in a sound designer's words: what audio_sfx hands back so the
 * next call can be better than this one.
 */
export interface SfxFeedback {
  /** What it was judged as: "shot, heavy". */
  judgedAs: string;
  /** The measurements, one line. */
  heard: string;
  /** What to change, most audible first, with the parameters that do it. Empty when nothing stands out. */
  improve: string[];
  /** Parameters that did nothing or were read differently than written. */
  notes: string[];
  /** How the takes differ from the first (only with variations). */
  takes?: string[];
}

export interface SfxDesignInput {
  name: string;
  preset?: string;
  params?: Partial<SfxParams>;
  category?: AudioCategory;
  variations?: number;
  kind?: SoundKind;
  heavy?: boolean;
  description?: string;
}

export interface SfxDesign {
  params: SfxParams;
  category: AudioCategory;
  kind: SoundKind;
  /** Each take as its channels (one, or two for a stereo sound); the first is the sound itself. */
  takes: Float32Array[][];
  check: AudioCheck;
  analysis: SoundAnalysis;
  feedback: SfxFeedback;
  /** Loops: where the audio sits in the encoded MP3. */
  loop?: LoopRegion;
}

const monoSum = (chs: Float32Array[]): Float32Array => {
  if (chs.length === 1) return chs[0]!;
  const out = new Float32Array(chs[0]!.length);
  for (const x of chs) for (let i = 0; i < out.length; i++) out[i]! += x[i]! / chs.length;
  return out;
};

const signed = (v: number): string => `${v > 0 ? '+' : ''}${v}`;

/** The parameters a call renders: the preset (if any) with the caller's fields over it, stamped with the current engine. */
export function sfxParams(input: Pick<SfxDesignInput, 'preset' | 'params' | 'category'>): SfxParams {
  const base = input.preset ? SFX_PRESETS[input.preset] : undefined;
  if (input.preset && !base) throw new Error(`Unknown preset "${input.preset}". Presets: ${Object.keys(SFX_PRESETS).join(', ')}`);
  // A sound described by its own parameters starts from nothing (it used to inherit the blip preset's rising
  // pitch and its layers); no preset and no parameters is the blip. `looped` is read as `loop`.
  const { looped, ...given } = (input.params ?? {}) as Partial<SfxParams> & { looped?: unknown };
  const start = base ?? (input.params ? ({ wave: 'sine', freq: 440 } as SfxParams) : SFX_PRESETS.blip!);
  return { ...start, ...given, ...(looped === true && given.loop === undefined ? { loop: true } : {}), ...(input.category ? { category: input.category } : {}), engine: SFX_ENGINE } as SfxParams;
}

/**
 * The parameters of an ambience bed `seconds` long: a loop in which the main voice and every layer that says
 * nothing about its own length are held for the whole of it; a layer with scatter, a delay or its own
 * envelope (and anything struck) is an event inside it.
 */
export function bedParams(params: Partial<SfxParams>, seconds: number): Partial<SfxParams> {
  const s = Math.min(60, Math.max(8, seconds));
  const timed = (v: Partial<SfxVoice & SfxPlacement>): boolean => v.wave === 'modal' || v.scatter !== undefined || v.delay !== undefined || v.sustain !== undefined || v.decay !== undefined;
  const layers = params.layers?.map((l) => (timed(l) ? l : { ...l, sustain: s, decay: 0 }));
  return { ...params, ...(layers ? { layers } : {}), sustain: s, decay: 0, loop: true };
}

export function designSfx(input: SfxDesignInput): SfxDesign {
  const params = sfxParams(input);
  const category = params.category ?? 'pickup';
  const loopSound = !!params.loop;
  // Takes: the same sound varied, so repeated actions do not sound robotic (take 1 is the sound itself).
  const info: SfxRenderInfo = {};
  const takes = renderTakeChannels(params, Math.min(6, Math.max(1, input.variations ?? 1)), info);
  const pcm = takes[0]!;
  const check = checkAudio(pcm, { category, loop: loopSound });
  const differ: string[] = [];
  for (let k = 1; k < takes.length; k++) {
    const v = takes[k]!;
    const vc = checkAudio(v, { category });
    if (!vc.ok) for (const issue of vc.issues) check.issues.push(`take ${k + 1}: ${issue}`);
    const d = takeDifference(monoSum(pcm), monoSum(v));
    const verdict = d.spectrumDb < 1.5 ? ' (nearly the same sound: it will still read as a repeat)' : Math.abs(d.toneOct) > 0.8 ? ' (nearly an octave away in colour: it may read as another object)' : '';
    differ.push(`take ${k + 1}: level ${signed(d.levelDb)} dB, length ${signed(d.lengthPct)} %, brightness ${signed(d.toneOct)} oct, spectrum ${d.spectrumDb} dB apart${verdict}`);
  }
  check.ok = check.issues.length === 0;
  // Listening with numbers: what it measures as, and what a sound designer would change.
  const analysis = analyzeSound(pcm, { loop: loopSound });
  const guess = guessKind(analysis, category, loopSound, `${input.name} ${input.description ?? ''}`);
  const kind = loopSound ? 'loop' : (input.kind ?? guess.kind);
  const heavy = input.heavy ?? guess.heavy;
  const bed = loopSound && category === 'ambience';
  const critique = critiqueSound(analysis, { kind, heavy, bed, far: (params.distance ?? 0) >= 0.4, ...(info.master ? { master: info.master } : {}) });
  if (bed && !(params.layers ?? []).some((l) => (l.scatter ?? 0) > 0)) critique.improve.push('no events: a place is a bed plus things that happen in it now and then (a far clank, a drip, a creak, a bird). Add two or three layers with scatter (how many times each plays in the loop: one every 5-10 s), each a small sound of its own, quiet (volume 0.1-0.4)');
  if (kind === 'loop' && !loopSound) critique.improve.unshift('meant to loop but rendered as a one-shot (it fades in and out, and its end does not meet its start): set loop: true in params and give the main voice sustain: <the loop length>, decay: 0');
  const feedback: SfxFeedback = {
    judgedAs: `${kind}${heavy ? ', heavy' : ''}${input.kind || loopSound ? '' : ' (guessed from the name and shape: pass kind to judge it as something else)'}`,
    heard: critique.heard,
    improve: critique.improve,
    notes: lintSfx(params),
    ...(differ.length ? { takes: differ } : {}),
  };
  return { params, category, kind, takes, check, analysis, feedback, ...(loopSound ? { loop: mp3LoopRegion(pcm[0]!.length) } : {}) };
}
