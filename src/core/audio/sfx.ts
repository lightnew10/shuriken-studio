/**
 * Sound effects. Each effect is a few voices (an oscillator, a noise colour, a bank of metal modes or an FM
 * pair) through resonant filters with their own cutoff and pitch moves, saturation and an exponential
 * envelope, mixed with delays, shaped as a whole (transient, weight, tone), put in a space, then mastered
 * to its loudness category (dsp/master).
 *
 * The presets are built the way real foley is: a TRANSIENT (the crack, the tick: a few ms of bright
 * noise), a BODY (the pitched thump or the ring) and a TAIL (air, debris, room), so combat sounds have
 * a front edge and top end instead of one dull filtered burst. The old sfxr-style flat parameters
 * (wave, freq, slide, envelope, one-pole-style lowpass/highpass, layers) all still work.
 *
 * Engine 3 (1.10) adds what the first agent-designed sound sets were missing (measured: dsp/analyze): a
 * transient designer and a peak clipper so a hit has a front edge the limiter does not flatten, spaces with
 * early reflections and a real tail, stereo (panned layers, decorrelated noise), struck materials with a
 * dozen or more modes, movement (pitch and level curves, tremolo, ring modulation, filter LFOs, unison,
 * jitter, comb resonators) and seamless loops.
 */
import { Rng, SAMPLE_RATE } from './dsp/util';
import { Osc, type OscWave } from './dsp/osc';
import { Noise } from './dsp/noise';
import { Biquad, OnePole, Svf } from './dsp/filter';
import { DECAY_K, breakpoints, type Breakpoint } from './dsp/env';
import { Saturator, addWeight, compress, shapeTransients, type CompressorOptions } from './dsp/fx';
import { reverbWet } from './dsp/reverb';
import { SPACES, applyDistance, spaceTailSeconds, spaceWet, type SpaceName } from './dsp/space';
import { MATERIALS, materialModes, type Material } from './dsp/modal';
import { master, type AudioCategory, type MasterReport } from './dsp/master';

export type Wave = 'square' | 'saw' | 'sine' | 'triangle' | 'noise' | 'white' | 'pink' | 'brown' | 'crunch' | 'modal' | 'fm';
export const WAVES: readonly Wave[] = ['square', 'saw', 'sine', 'triangle', 'noise', 'white', 'pink', 'brown', 'crunch', 'modal', 'fm'];

/** One voice. Everything but wave and freq is optional. Times in seconds, frequencies in Hz. */
export interface SfxVoice {
  /**
   * square/saw/triangle/sine: band-limited oscillators. noise (= white), pink, brown: noise colours (freq is
   * ignored; shape them with the filters). crunch: the old stepped noise at freq steps per second (lo-fi).
   * modal: a bank of decaying sine modes (metal, bells; see material and modes). fm: a carrier at freq with a modulator.
   */
  wave: Wave;
  freq: number;
  /** Pitch slide in octaves per second (negative = falling) and its change per second. */
  slide?: number;
  deltaSlide?: number;
  /** Exponential pitch move: the pitch falls (or rises) from freq to freqEnd with time constant pitchTime (thumps, zaps). */
  freqEnd?: number;
  pitchTime?: number;
  /** The pitch as a curve: [[seconds, Hz], ...] (exponential between the points; replaces freq): servo starts and stops, sirens, charge-ups. */
  freqCurve?: Breakpoint[];
  attack?: number;
  /**
   * Seconds held at full level after the attack. A hit, a crack or a thump has 0; a body of noise 0.02-0.06; a
   * held tone its length. Default 0 for sounds made with engine 3 (see SfxParams.engine), 0.1 for older ones.
   */
  sustain?: number;
  /** Seconds of exponential decay after the sustain (about -52 dB at the end; it is 20 dB down after a third of it). */
  decay?: number;
  /** Extra loudness at the start of the sustain (0..1), fading over it. */
  punch?: number;
  /** The level as a curve on top of the envelope: [[seconds, 0..1], ...] (stutters, swells, a motor under load). */
  levelCurve?: Breakpoint[];
  /** Square duty cycle 0.05..0.95. */
  duty?: number;
  vibratoDepth?: number;
  vibratoSpeed?: number;
  /** Random pitch drift in cents (an unsteady motor, plasma, a strained hinge) and how fast it wanders (Hz, default 12). */
  jitter?: number;
  jitterSpeed?: number;
  /** Jump to freq*arpMul after arpTime seconds. */
  arpMul?: number;
  arpTime?: number;
  /** Oscillators: this many detuned copies (1..7) spread by `detune` cents either way: thick beams, engines, sci-fi drones. */
  unison?: number;
  detune?: number;
  /**
   * Resonant filters (12 dB/octave): lowpass cutoff, moved linearly by lowpassSweep Hz/s or exponentially to
   * lowpassEnd over the sound's length (or over sweepTime seconds); highpass (same with highpassEnd); bandpass
   * centre (bandpassEnd). resonance is the Q of the low-pass and band-pass (0.707 flat, 3+ vocal, 8+ whistling;
   * it is not 0..1).
   */
  lowpass?: number;
  lowpassSweep?: number;
  lowpassEnd?: number;
  highpass?: number;
  highpassEnd?: number;
  bandpass?: number;
  bandpassEnd?: number;
  resonance?: number;
  /** Seconds the filter sweeps take (default: the voice's whole length). Short = the filter snaps shut behind the hit. */
  sweepTime?: number;
  /** An LFO on every cutoff of this voice: depth in octaves and speed in Hz (movement in beams, engines, wind). */
  filterLfoDepth?: number;
  filterLfoSpeed?: number;
  /** Tremolo: depth 0..1 and speed in Hz (gear chatter at 20-60 Hz, pulsing at 2-8 Hz). */
  tremoloDepth?: number;
  tremoloSpeed?: number;
  /** Ring modulation with a sine at this many Hz (robotic, metallic, radio), mixed in by ringMix 0..1 (default 1). */
  ring?: number;
  ringMix?: number;
  /** A tuned resonator after the filters: a feedback comb at this many Hz ringing for combDecay seconds (barrels, pipes, hollow hulls, robot voices). */
  comb?: number;
  combDecay?: number;
  /** Retrigger the whole voice every N seconds within its length (0 = off). */
  repeat?: number;
  volume?: number;
  /** Saturation 0..1 (0 off, 0.3 warm, 1 hard) and its kind: soft (tanh), hard (clipped: buzzy, aggressive), fold (wavefolding: energy weapons, sci-fi). */
  drive?: number;
  driveType?: 'soft' | 'hard' | 'fold';
  /** modal: [frequency ratio, gain, decay scale (1 = the voice's decay)] per mode. Prefer material. */
  modes?: Array<[number, number, number]>;
  /**
   * modal: what is struck. plate (armour, sheet metal), bar (girders, blades), bell, pipe (tubes, barrels),
   * wood, glass, membrane (hollow thuds, drums). Builds modeCount modes (default 14) with the material's own
   * ratios and damping; hardness 0..1 (soft mallet .. steel on steel), damping 0..1 (rings .. dead).
   */
  material?: Material;
  modeCount?: number;
  hardness?: number;
  damping?: number;
  /** fm: modulator frequency ratio, modulation index at the start, and how fast the index dies (s). */
  fmRatio?: number;
  fmIndex?: number;
  fmDecay?: number;
  /** Noise as sparse grains: this many per second (debris, droplets, gravel, sparks), each lasting `grain` seconds (default 0.003). */
  crackle?: number;
  grain?: number;
  /** Stereo: where the voice sits (-1 left .. 1 right) and where it ends up (panEnd: a pass-by). */
  pan?: number;
  panEnd?: number;
  /** Stereo: 0..1, how different left and right are (noise, unison and jitter are rendered twice): wide air, debris, tails. Keep lows at 0. */
  spread?: number;
}

/** Where a layer sits in time: once, after a delay, or scattered. */
export interface SfxPlacement {
  delay?: number;
  /**
   * Play the layer this many times (1..64) at random moments, each a little different: debris after a blast,
   * drips in a cave, distant clanks in a yard. In a loop the moments are spread over the whole loop; in a
   * one-shot over scatterOver seconds (default 1) after `delay`. Each one varies in pitch by up to scatterPitch
   * octaves (default 0.12), in level by up to scatterLevel dB (default 4) and, in stereo, in place by up to
   * scatterPan (default 0.7).
   */
  scatter?: number;
  scatterOver?: number;
  scatterPitch?: number;
  scatterLevel?: number;
  scatterPan?: number;
}

export interface SfxParams extends SfxVoice {
  /** More voices mixed in, each optionally delayed (seconds) or scattered. Variations vary every layer. */
  layers?: Array<SfxVoice & SfxPlacement>;
  /**
   * Which loudness class the finished sound is mastered to (see LOUDNESS_TARGETS): ui, pickup, impact,
   * footstep, movement or stinger. Default pickup.
   */
  category?: AudioCategory;
  /**
   * Small-room reverb on the whole sound: amount 0..1 (0 = none) and room size, which is about the tail length in
   * seconds (0.15 a booth, 0.6 a hall). The older, simpler reverb: prefer space.
   */
  room?: number;
  roomSize?: number;
  /**
   * The place the sound happens in (dsp/space SPACE_MODELS): early reflections and a tail. spaceMix 0..1 is
   * the energy of the space against the dry sound (0.1 a hint, 0.25 clearly in a place, 0.5 far inside it;
   * default 0.2), spaceDecay scales the tail's length (0.3..2).
   */
  space?: SpaceName;
  spaceMix?: number;
  spaceDecay?: number;
  /** 0 (at the listener) .. 1 (far away): the highs and the front edge go, the space takes over. */
  distance?: number;
  /**
   * Transient designer on the mix: 0 off .. 1 (the first 10-20 ms up to 9 dB over what follows, brighter too).
   * Negative softens the front. Default: impact 0.5, footstep 0.4, others 0.
   */
  transient?: number;
  /** Low-end weight 0..1: harmonics of the band under 160 Hz and a little of the octave below. */
  weight?: number;
  /** Tone of the mix in dB: low (shelf under 120 Hz), mid (350 Hz: boxiness), presence (3.5 kHz: bite, harshness), air (shelf above 7 kHz). */
  tone?: { low?: number; mid?: number; presence?: number; air?: number };
  /**
   * Soft clipping of the whole mix, relative to its peak (0 off .. 1 hard): rounds the front of a hit so its body
   * can be louder at the same ceiling and gives a thump harmonics small speakers can play. Default: impacts 0.5.
   */
  clip?: number;
  /** Compression of the mix before mastering (thresholds are dB under the mix's peak). Slow attacks keep the front edge and pull the body down, so it is for sounds that want sustain and weight. */
  comp?: Pick<CompressorOptions, 'thresholdDb' | 'ratio' | 'attackMs' | 'releaseMs' | 'makeupDb'>;
  /**
   * Stereo. width 0..1 spreads the noise layers and the space (lows and tonal bodies stay in the middle);
   * stereo: true forces a stereo file. A sound is stereo when width, stereo or any pan/spread is set, mono
   * otherwise. Stereo is for 2D sounds (UI, the player's own weapon, stingers, beds); sounds played at a
   * position in the world should stay mono.
   */
  width?: number;
  stereo?: boolean;
  /**
   * A seamless loop (engines, servos, beams, rumble): the loop is as long as the main voice holds (sustain +
   * decay, at most 6 s; an ambience bed, category ambience, up to 60 s). Voices that last the whole loop are held (no fade), their pitches and LFO speeds are
   * nudged so a whole number of cycles fits, and noise is crossfaded over the seam; shorter voices are events
   * inside the loop (their tails wrap around). Pitch slides and filter sweeps are ignored on held voices.
   */
  loop?: boolean;
  /**
   * Which defaults the voices get. 3 (stamped on every sound AudioService makes since 1.10): attack 0.001 and
   * sustain 0, so a voice is a hit unless it says how long it holds. Without it (sounds saved before): attack
   * 0.003 and sustain 0.1, which is how those sounds were made and how they keep rendering.
   */
  engine?: number;
}

/** The engine new sounds are stamped with. */
export const SFX_ENGINE = 3;
/** attack and sustain a voice has when it gives none. */
const envelopeDefaults = (engine: number | undefined): { attack: number; sustain: number } => ((engine ?? 2) >= 3 ? { attack: 0.001, sustain: 0 } : { attack: 0.003, sustain: 0.1 });

// ─── parameters as agents write them ─────────────────────────────────────────

const VOICE_KEYS: ReadonlySet<string> = new Set([
  'wave', 'freq', 'slide', 'deltaSlide', 'freqEnd', 'pitchTime', 'freqCurve', 'attack', 'sustain', 'decay', 'punch', 'levelCurve', 'duty', 'vibratoDepth', 'vibratoSpeed', 'jitter', 'jitterSpeed', 'arpMul', 'arpTime', 'unison', 'detune',
  'lowpass', 'lowpassSweep', 'lowpassEnd', 'highpass', 'highpassEnd', 'bandpass', 'bandpassEnd', 'resonance', 'sweepTime', 'filterLfoDepth', 'filterLfoSpeed', 'tremoloDepth', 'tremoloSpeed', 'ring', 'ringMix', 'comb', 'combDecay', 'repeat',
  'volume', 'drive', 'driveType', 'modes', 'material', 'modeCount', 'hardness', 'damping', 'fmRatio', 'fmIndex', 'fmDecay', 'crackle', 'grain', 'pan', 'panEnd', 'spread',
]);
const PLACEMENT_KEYS: ReadonlySet<string> = new Set(['delay', 'scatter', 'scatterOver', 'scatterPitch', 'scatterLevel', 'scatterPan']);
const MIX_KEYS: ReadonlySet<string> = new Set(['layers', 'category', 'room', 'roomSize', 'space', 'spaceMix', 'spaceDecay', 'distance', 'transient', 'weight', 'tone', 'clip', 'comp', 'width', 'stereo', 'loop', 'engine']);

const isNoiseWave = (w: unknown): boolean => w === 'noise' || w === 'white' || w === 'pink' || w === 'brown' || w === 'crunch';

/**
 * crackle and grain as the renderer uses them: grains per second and seconds per grain. Agents have written
 * them as "amount 0..1" and "rate" (crackle: 0.7, grain: 60), which as grains per second and seconds is a
 * layer that stays silent until one grain fires and then never closes; in sounds made with engine 3 that
 * reading is taken as rate = grain, and a grain length above a quarter second as milliseconds. Sounds saved
 * before keep the literal reading (they render as they did).
 */
function grainSpec(crackle: number, grain: number | undefined, engine: number | undefined): { rate: number; seconds: number; reread: boolean } {
  if (!(crackle > 0) || (engine ?? 2) < 3) return { rate: Math.max(0, crackle), seconds: grain ?? 0.003, reread: false };
  if (crackle <= 1) {
    const rate = grain !== undefined && grain >= 1 ? grain : 20 + 180 * crackle;
    return { rate, seconds: 0.004, reread: true };
  }
  if (grain !== undefined && grain > 0.25) return { rate: crackle, seconds: grain / 1000, reread: true };
  return { rate: crackle, seconds: grain ?? 0.003, reread: false };
}

/**
 * What is wrong or surprising in the parameters as written, in the words of the tool's caller: unknown
 * fields (they do nothing), units read differently than written, defaults that bite. [] when there is nothing.
 */
export function lintSfx(input: SfxParams): string[] {
  const notes: string[] = [];
  const unknown = new Set<string>();
  const voices: Array<{ v: Record<string, unknown>; label: string; main: boolean }> = [{ v: input as unknown as Record<string, unknown>, label: 'the main voice', main: true }, ...(input.layers ?? []).map((l, i) => ({ v: l as unknown as Record<string, unknown>, label: `layer ${i + 1}`, main: false }))];
  const held: string[] = [];
  const lowQ: string[] = [];
  const env = envelopeDefaults(input.engine);
  for (const { v, label, main } of voices) {
    for (const k of Object.keys(v)) {
      if (VOICE_KEYS.has(k) || (main && MIX_KEYS.has(k)) || (!main && PLACEMENT_KEYS.has(k))) continue;
      if (main && k === 'looped') continue;
      unknown.add(k);
    }
    const wave = v.wave as string | undefined;
    if (wave !== undefined && !(WAVES as readonly string[]).includes(wave)) notes.push(`${label}: wave "${wave}" does not exist (${WAVES.join(', ')}); it plays as a square`);
    if (!isNoiseWave(wave) && !(typeof v.freq === 'number' && v.freq > 0) && !v.freqCurve) notes.push(`${label}: no freq on a ${wave ?? 'voice'}; it plays at 440 Hz`);
    const g = grainSpec(Number(v.crackle ?? 0), v.grain as number | undefined, SFX_ENGINE);
    if (g.reread) notes.push(`${label}: crackle is grains per second and grain is the length of one grain in seconds (crackle: 80, grain: 0.004 = sparks); crackle ${String(v.crackle)}, grain ${String(v.grain ?? 'default')} was read as ${Math.round(g.rate)} grains/s of ${Math.round(g.seconds * 1000)} ms`);
    if (typeof v.resonance === 'number' && v.resonance < 0.5) lowQ.push(label);
    if (env.sustain > 0 && v.sustain === undefined && !input.loop && typeof v.decay === 'number' && v.decay <= 0.08) held.push(label);
    if (wave === 'modal' && !v.material && Array.isArray(v.modes) && v.modes.length < 6) notes.push(`${label}: ${v.modes.length} modes ring like a toy bell; a struck object has a dozen or more. Use material (${MATERIALS.join(', ')}) instead of modes`);
    if (v.material !== undefined && !(MATERIALS as readonly string[]).includes(v.material as string)) notes.push(`${label}: material "${String(v.material)}" does not exist (${MATERIALS.join(', ')})`);
  }
  if (unknown.size) notes.push(`unknown parameter${unknown.size > 1 ? 's' : ''} ${[...unknown].join(', ')}: ignored`);
  if (held.length) notes.push(`${held.join(', ')}: no sustain given, so ${held.length > 1 ? 'they hold' : 'it holds'} at full level for 0.1 s before the short decay (a flat burst, not a crack). Set sustain: 0 on anything struck`);
  if (lowQ.length) notes.push(`${lowQ.join(', ')}: resonance is the filter's Q (0.707 flat, 2-4 vocal, 8+ ringing), not 0..1; under 0.5 the band-pass is so wide it hardly filters`);
  if (input.space !== undefined && !(SPACES as readonly string[]).includes(input.space)) notes.push(`space "${String(input.space)}" does not exist (${SPACES.join(', ')})`);
  if (input.loop && (input.sustain ?? env.sustain) + (input.decay ?? 0.2) < 0.5) notes.push('loop: the loop is as long as the main voice holds (sustain + decay); under half a second it buzzes. Give the main voice sustain: 2 (or more), decay: 0');
  return notes;
}

// ─── voice rendering ─────────────────────────────────────────────────────────

const MAX_SECONDS = 6;
/** An ambience bed may loop this long. */
const MAX_BED_SECONDS = 60;

interface VoiceRun {
  /** Samples to render (default: the voice's own length). */
  n?: number;
  /** Time of the first sample (negative = a pre-roll that lets filters settle). */
  t0?: number;
  /** Held at full level: no attack, decay or end taper (a loop's bed). */
  flat?: boolean;
  /** The sound's engine (SfxParams.engine): which attack and sustain a voice has when it gives none. */
  engine?: number;
}

/** One voice at its own volume (mixing happens in renderSfx). */
export function renderVoice(input: SfxVoice, seed: number, run: VoiceRun = {}): Float32Array {
  const p = {
    ...envelopeDefaults(run.engine), decay: 0.2, punch: 0, duty: 0.5, slide: 0, deltaSlide: 0, vibratoDepth: 0, vibratoSpeed: 0, arpMul: 1, arpTime: 0,
    lowpass: 0, lowpassSweep: 0, highpass: 0, bandpass: 0, resonance: 0.707, repeat: 0, volume: 0.6, drive: 0, crackle: 0, pitchTime: 0.05, fmRatio: 2, fmIndex: 0,
    jitter: 0, jitterSpeed: 12, unison: 1, detune: 12, filterLfoDepth: 0, filterLfoSpeed: 0, tremoloDepth: 0, tremoloSpeed: 0, ring: 0, comb: 0, combDecay: 0.15, ...input,
  };
  if (!(p.freq > 0)) p.freq = 440;
  const length = Math.max(0.02, p.attack + p.sustain + p.decay);
  const n = run.n ?? Math.min(SAMPLE_RATE * MAX_SECONDS, Math.ceil(length * SAMPLE_RATE));
  const t0 = run.t0 ?? 0;
  const out = new Float32Array(n);
  const noise = new Noise(seed * 7919 + 13);
  const fmMod = new Osc(0);
  const isNoise = isNoiseWave(p.wave);
  const modes: Array<[number, number, number]> =
    p.wave !== 'modal' ? [] : p.modes && p.modes.length ? p.modes : p.material ? materialModes(p.material, { count: p.modeCount, hardness: p.hardness, damping: p.damping, seed: Math.round(p.freq), strike: new Rng(seed * 61 + 17).bipolar() }) : [[1, 1, 1]];
  const modePhase = modes.map(() => 0);
  const hp = p.highpass > 0 ? new Svf(p.highpass, 0.707) : null;
  const lp = p.lowpass > 0 ? new Svf(p.lowpass, p.resonance) : null;
  const bp = p.bandpass > 0 ? new Svf(p.bandpass, p.resonance) : null;
  const sat = p.drive > 0 && (p.driveType ?? 'soft') === 'soft' ? new Saturator(0.5 + p.drive * 5) : null;
  const shaper = p.drive > 0 && !sat ? p.driveType : null;
  const filterTime = Math.max(1e-3, p.sweepTime ?? length);
  const expSweep = (a: number, b: number, t: number): number => a * Math.pow(b / a, Math.min(1, Math.max(0, t) / filterTime));
  const grains = grainSpec(p.crackle, p.grain, run.engine);
  const grainDecay = Math.exp(-1 / (Math.max(0.0005, grains.seconds) * SAMPLE_RATE));
  const grainRate = grains.rate / SAMPLE_RATE;
  const rand = new Rng(seed * 31 + 7);
  let gate = 0;
  const decayK = DECAY_K / Math.max(1e-3, p.decay);
  const holdEnd = p.attack + p.sustain;
  let phase = 0;
  // Unison: detuned copies with their own start phases (one copy = the plain oscillator, phase 0).
  const copies = !isNoise && p.wave !== 'modal' && p.wave !== 'fm' ? Math.round(Math.min(7, Math.max(1, p.unison))) : 1;
  const uniRand = new Rng(seed * 53 + 11);
  const oscs = Array.from({ length: copies }, () => new Osc(copies > 1 ? uniRand.next() : 0));
  const uniMul = oscs.map((_, k) => (copies > 1 ? Math.pow(2, ((k / (copies - 1)) * 2 - 1) * p.detune / 1200) : 1));
  const uniGain = 1 / Math.sqrt(copies);
  // Jitter: a slow random walk of the pitch.
  const jitRand = p.jitter > 0 ? new Rng(seed * 97 + 3) : null;
  const jitLp = p.jitter > 0 ? new OnePole(Math.max(0.5, p.jitterSpeed)) : null;
  const jitGain = p.jitter > 0 ? (p.jitter / 1200) * Math.sqrt(SAMPLE_RATE / (2 * Math.PI * Math.max(0.5, p.jitterSpeed))) * 1.2 : 0;
  // Comb resonator.
  const combLen = p.comb > 0 ? Math.max(2, Math.round(SAMPLE_RATE / Math.min(8000, Math.max(25, p.comb)))) : 0;
  const combBuf = combLen ? new Float32Array(combLen) : null;
  const combFb = combLen ? Math.min(0.995, Math.pow(10, (-3 * combLen) / (Math.max(0.005, p.combDecay) * SAMPLE_RATE))) : 0;
  const combNorm = Math.sqrt(1 - combFb * combFb);
  const combLp = combLen ? new OnePole(7000) : null;
  let combIdx = 0;
  const lfo = p.filterLfoDepth > 0 && p.filterLfoSpeed > 0;
  const ringMix = p.ring > 0 ? Math.min(1, Math.max(0, p.ringMix ?? 1)) : 0;
  const nyq = SAMPLE_RATE * 0.45;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / SAMPLE_RATE;
    const tr = p.repeat > 0 ? (t >= 0 ? t % p.repeat : ((t % p.repeat) + p.repeat) % p.repeat) : t;
    // Pitch: a curve or an exponential move, slide in octaves per second, arpeggio jump, vibrato, jitter.
    let f = p.freqCurve && p.freqCurve.length ? breakpoints(p.freqCurve, tr, true) : p.freq;
    if (p.freqEnd && !p.freqCurve) f = p.freqEnd * Math.pow(p.freq / p.freqEnd, Math.exp(-Math.max(0, tr) / Math.max(1e-3, p.pitchTime)));
    f *= Math.pow(2, p.slide * tr + 0.5 * p.deltaSlide * tr * tr);
    if (p.arpTime > 0 && tr >= p.arpTime) f *= p.arpMul;
    if (p.vibratoDepth > 0) f *= 1 + p.vibratoDepth * Math.sin(2 * Math.PI * p.vibratoSpeed * t);
    if (jitLp) f *= Math.pow(2, jitLp.lp(jitRand!.bipolar()) * jitGain);
    f = Math.max(20, Math.min(18000, f));
    // Source.
    let s: number;
    if (isNoise) {
      s = p.wave === 'crunch' ? noise.crunch(f) : p.wave === 'pink' ? noise.pink() : p.wave === 'brown' ? noise.brown() : noise.white();
      if (grainRate > 0) {
        if (rand.next() < grainRate) gate += 0.35 + 0.65 * rand.next();
        gate *= grainDecay;
        s *= Math.min(1.2, gate * 3);
      }
    } else if (p.wave === 'modal') {
      s = 0;
      const base = decayTau(p.decay);
      for (let m = 0; m < modes.length; m++) {
        const [ratio, gain, scale] = modes[m]!;
        const fm = f * ratio;
        if (fm > nyq) continue;
        modePhase[m]! += fm / SAMPLE_RATE;
        s += gain * Math.sin(2 * Math.PI * modePhase[m]!) * Math.exp(-Math.max(0, tr) / Math.max(1e-3, base * scale));
      }
    } else if (p.wave === 'fm') {
      const index = run.flat ? p.fmIndex : p.fmIndex * Math.exp(-tr / Math.max(1e-3, p.fmDecay ?? p.decay / 3));
      phase += f / SAMPLE_RATE;
      if (phase >= 1) phase -= 1;
      s = Math.sin(2 * Math.PI * phase + index * fmMod.sine(f * p.fmRatio));
    } else if (copies === 1) {
      s = oscs[0]!.tick(p.wave as OscWave, f, p.duty);
    } else {
      s = 0;
      for (let k = 0; k < copies; k++) s += oscs[k]!.tick(p.wave as OscWave, f * uniMul[k]!, p.duty);
      s *= uniGain;
    }
    if (ringMix > 0) s *= 1 - ringMix + ringMix * Math.sin(2 * Math.PI * p.ring * t);
    // Filters (coefficients move every 4th sample when a sweep is set).
    const move = (i & 3) === 0;
    const wob = lfo && move ? Math.pow(2, p.filterLfoDepth * Math.sin(2 * Math.PI * p.filterLfoSpeed * t)) : 1;
    if (hp) {
      if (move) hp.set((p.highpassEnd ? expSweep(p.highpass, p.highpassEnd, t) : p.highpass) * wob, 0.707);
      hp.process(s);
      s = hp.hp;
    }
    if (lp) {
      if (move) lp.set((p.lowpassEnd ? expSweep(p.lowpass, p.lowpassEnd, t) : Math.max(60, p.lowpass + p.lowpassSweep * t)) * wob, p.resonance);
      s = lp.process(s);
    }
    if (bp) {
      if (move) bp.set((p.bandpassEnd ? expSweep(p.bandpass, p.bandpassEnd, t) : p.bandpass) * wob, p.resonance);
      bp.process(s);
      s = bp.bandpass;
    }
    if (combBuf) {
      const y = s + combFb * combLp!.lp(combBuf[combIdx]!);
      combBuf[combIdx] = y;
      combIdx = combIdx + 1 === combLen ? 0 : combIdx + 1;
      s = y * combNorm;
    }
    if (sat) s = sat.process(s);
    else if (shaper === 'hard') s = Math.max(-1, Math.min(1, s * (1 + p.drive * 8))) * (0.6 + 0.4 / (1 + p.drive * 2));
    else if (shaper === 'fold') s = Math.sin(s * (1 + p.drive * 6) * (Math.PI / 2));
    // Envelope: linear attack, hold with punch, exponential decay.
    let env: number;
    if (run.flat) env = 1;
    else if (tr < p.attack) env = tr / Math.max(3e-4, p.attack);
    else if (tr < holdEnd) env = 1 + p.punch * (1 - (tr - p.attack) / Math.max(1e-4, p.sustain));
    else env = Math.exp(-decayK * (tr - holdEnd));
    if (p.levelCurve && p.levelCurve.length) env *= Math.max(0, breakpoints(p.levelCurve, tr));
    if (p.tremoloDepth > 0) env *= 1 - Math.min(1, p.tremoloDepth) * (0.5 - 0.5 * Math.cos(2 * Math.PI * p.tremoloSpeed * t));
    // Taper the last 4 ms so the tail never clicks.
    if (!run.flat) {
      const left = (n - 1 - i) / SAMPLE_RATE;
      if (left < 0.004) env *= left / 0.004;
    }
    out[i] = s * env * p.volume;
  }
  return out;
}

/** Time constant (s) that makes an exponential reach about -52 dB after `decay`. */
const decayTau = (decay: number): number => Math.max(1e-3, decay) / DECAY_K;

/** Whether two renders of a voice with different seeds differ (so `spread` can make it wide). */
const hasRandomness = (v: SfxVoice): boolean => isNoiseWave(v.wave) || (v.unison ?? 1) > 1 || (v.jitter ?? 0) > 0 || (v.wave === 'modal' && !!v.material && !(v.modes && v.modes.length));

// ─── loops ───────────────────────────────────────────────────────────────────

const LOOP_PRE = 0.25;
const LOOP_FADE = 0.15;

/**
 * A voice that lasts the whole loop, rendered so its end runs into its start: pitches and LFO speeds are
 * moved to the nearest value with a whole number of cycles in the loop, drifts are dropped, and what is not
 * periodic (noise, grains, jitter) is crossfaded over the seam with equal power.
 */
function renderHeld(v: SfxVoice, seed: number, frames: number, engine: number | undefined): Float32Array {
  const T = frames / SAMPLE_RATE;
  const q = (hz: number | undefined): number | undefined => (hz && hz > 0 ? Math.max(1, Math.round(hz * T)) / T : hz);
  const freq = q(v.freq) ?? v.freq;
  const curve = v.freqCurve && v.freqCurve.length ? v.freqCurve.map(([t, hz]) => [t, hz] as Breakpoint) : undefined;
  const p: SfxVoice = {
    ...v,
    freq,
    freqCurve: curve,
    slide: 0, deltaSlide: 0, freqEnd: undefined, arpTime: 0, lowpassSweep: 0, lowpassEnd: undefined, highpassEnd: undefined, bandpassEnd: undefined, punch: 0,
    vibratoSpeed: q(v.vibratoSpeed), tremoloSpeed: q(v.tremoloSpeed), filterLfoSpeed: q(v.filterLfoSpeed), ring: q(v.ring),
    repeat: v.repeat && v.repeat > 0 ? T / Math.max(1, Math.round(T / v.repeat)) : v.repeat,
    fmRatio: v.wave === 'fm' && freq > 0 ? (q(freq * (v.fmRatio ?? 2)) ?? freq * 2) / freq : v.fmRatio,
  };
  const periodic = !isNoiseWave(v.wave) && !(v.jitter && v.jitter > 0) && !curve && (v.unison ?? 1) <= 1;
  const pre = Math.round(LOOP_PRE * SAMPLE_RATE);
  const fade = periodic ? 0 : Math.min(Math.round(LOOP_FADE * SAMPLE_RATE), frames >> 1);
  const x = renderVoice(p, seed, { n: pre + frames + fade, t0: -pre / SAMPLE_RATE, flat: true, engine });
  const out = x.slice(pre, pre + frames);
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = out[i]! * Math.sqrt(w) + x[pre + frames + i]! * Math.sqrt(1 - w);
  }
  return out;
}

// ─── the mix ─────────────────────────────────────────────────────────────────

/** Transient designer applied to struck sounds unless a sound says otherwise (the amount: 0..1). */
const CATEGORY_TRANSIENT: Partial<Record<AudioCategory, number>> = { impact: 0.5, footstep: 0.4 };
/** Categories whose peaks may be clipped instead of limited when mastering (dB): what is struck, not what is sung. */
const CATEGORY_PEAK_CLIP: Partial<Record<AudioCategory, number>> = { impact: 6, footstep: 6 };
/** Soft clipping applied to impacts unless a preset says otherwise. */
const CATEGORY_CLIP: Partial<Record<AudioCategory, number>> = { impact: 0.5 };

export interface SfxRenderInfo {
  master?: MasterReport;
  /** Whether the render is a loop, and stereo. */
  loop?: boolean;
  stereo?: boolean;
}

/** Whether these parameters make a stereo file. */
export function isStereoSfx(p: SfxParams): boolean {
  if (p.stereo !== undefined) return p.stereo;
  if ((p.width ?? 0) > 0) return true;
  return [p as SfxVoice, ...(p.layers ?? [])].some((v) => v.pan !== undefined || v.panEnd !== undefined || (v.spread ?? 0) > 0);
}

/** Renders one sound effect to mastered PCM: one channel, or two when the parameters ask for stereo. `seed` makes noise deterministic (takes use other seeds). */
export function renderSfxChannels(input: SfxParams, seed = 1, info?: SfxRenderInfo): Float32Array[] {
  const { layers, category, room, roomSize, comp, clip, space, spaceMix, spaceDecay, distance, transient, weight, tone, width, stereo: _stereo, loop, engine, ...main } = input;
  const env = envelopeDefaults(engine);
  const lengthOf = (v: SfxVoice): number => (v.attack ?? env.attack) + (v.sustain ?? env.sustain) + (v.decay ?? 0.2);
  const cat = category ?? 'pickup';
  const stereo = isStereoSfx(input);
  const place = space && (SPACES as readonly string[]).includes(space) ? space : undefined;
  const voiceSeed = (i: number): number => (i === 0 ? seed : seed * 31 + i);
  const wide = Math.min(1, Math.max(0, width ?? 0));
  // A voice's width: its own spread, else the mix's width for anything noisy (bodies and lows stay in the middle).
  const spreadOf = (v: SfxVoice): number => (stereo ? Math.min(1, Math.max(0, v.spread ?? (isNoiseWave(v.wave) && !(v.lowpass && v.lowpass < 400) ? wide : 0))) : 0);

  // A loop is as long as its main voice holds and decays (an attack means nothing on a held voice).
  const longest = SAMPLE_RATE * (loop && cat === 'ambience' ? MAX_BED_SECONDS : MAX_SECONDS);
  const loopFrames = loop ? Math.min(longest, Math.max(Math.round(0.1 * SAMPLE_RATE), Math.round(((main.sustain ?? env.sustain) + (main.decay ?? 0.2)) * SAMPLE_RATE))) : 0;
  // The voices as they are placed: the main one, each layer once, a scattered layer as that many events.
  const placed: Array<{ v: SfxVoice & SfxPlacement; seed: number; main: boolean }> = [{ v: main, seed, main: true }];
  (layers ?? []).forEach((l, k) => {
    const count = Math.round(Math.min(64, Math.max(0, l.scatter ?? 0)));
    if (!count) {
      placed.push({ v: l, seed: voiceSeed(k + 1), main: false });
      return;
    }
    const rand = new Rng(voiceSeed(k + 1) * 211 + 19);
    const over = loop ? loopFrames / SAMPLE_RATE : Math.max(0.05, l.scatterOver ?? 1);
    for (let e = 0; e < count; e++) {
      // One event somewhere in each of `count` equal stretches: sparse, never bunched.
      const at = (l.delay ?? 0) + ((e + rand.next()) / count) * over;
      const pitch = Math.pow(2, rand.bipolar() * (l.scatterPitch ?? 0.12));
      const level = Math.pow(10, (rand.bipolar() * (l.scatterLevel ?? 4)) / 20);
      const pan = Math.min(1, Math.max(-1, (l.pan ?? 0) + rand.bipolar() * (l.scatterPan ?? 0.7)));
      placed.push({
        v: { ...l, freq: l.freq * pitch, ...(l.freqEnd ? { freqEnd: l.freqEnd * pitch } : {}), ...(l.comb ? { comb: l.comb * pitch } : {}), ...(l.freqCurve ? { freqCurve: l.freqCurve.map(([t, hz]) => [t, hz * pitch] as Breakpoint) } : {}), volume: (l.volume ?? 0.6) * level, ...(stereo ? { pan } : {}), delay: at },
        seed: voiceSeed(k + 1) * 1009 + e,
        main: false,
      });
    }
  });
  const voices = placed.map(({ v, seed: s, main: first }) => {
    const held = !!loop && v.wave !== 'modal' && lengthOf(v) >= 0.9 * (loopFrames / SAMPLE_RATE);
    const one = (sd: number): Float32Array => (held ? renderHeld(v, sd, loopFrames, engine) : renderVoice(v, sd, { engine }));
    const spread = spreadOf(v);
    return { pcm: one(s), other: spread > 0 && hasRandomness(v) ? one(s * 131 + 977) : null, spread, at: Math.round((first || held ? 0 : (v.delay ?? 0)) * SAMPLE_RATE), pan: v.pan ?? 0, panEnd: v.panEnd, held };
  });

  const dryLen = loop ? loopFrames : Math.min(SAMPLE_RATE * MAX_SECONDS, Math.max(...voices.map((v) => v.at + v.pcm.length)));
  const oldTail = !loop && room && room > 0 ? Math.round(Math.min(1.2, 0.05 + (roomSize ?? 0.3)) * SAMPLE_RATE) : 0;
  const newTail = !loop && place ? Math.round(spaceTailSeconds(place, spaceDecay) * SAMPLE_RATE) : 0;
  const total = loop ? loopFrames : Math.min(SAMPLE_RATE * MAX_SECONDS, dryLen + Math.max(oldTail, newTail));
  const chs = stereo ? [new Float32Array(total), new Float32Array(total)] : [new Float32Array(total)];
  for (const v of voices) {
    const len = v.pcm.length;
    for (let i = 0; i < len; i++) {
      let at = v.at + i;
      if (at >= total) {
        if (!loop) break;
        at %= total;
      }
      const a = v.pcm[i]!;
      if (!stereo) {
        chs[0]![at]! += a;
        continue;
      }
      let l = a;
      let r = a;
      if (v.other) {
        const b = v.other[i] ?? 0;
        const th = ((1 - v.spread) * Math.PI) / 4;
        const c = Math.cos(th);
        const s = Math.sin(th);
        l = c * a + s * b;
        r = c * b + s * a;
      }
      const pan = Math.min(1, Math.max(-1, v.panEnd === undefined ? v.pan : v.pan + (v.panEnd - v.pan) * (i / Math.max(1, len - 1))));
      if (pan !== 0) {
        const ang = ((pan + 1) * Math.PI) / 4;
        l *= Math.SQRT2 * Math.cos(ang);
        r *= Math.SQRT2 * Math.sin(ang);
      }
      chs[0]![at]! += l;
      chs[1]![at]! += r;
    }
  }

  // The dry sound as a whole: tone, weight, distance.
  if (tone) settled(chs, !!loop, (x) => applyTone(x, tone));
  if (weight && weight > 0) settled(chs, !!loop, (x) => addWeight(x, weight));
  const far = Math.min(1, Math.max(0, distance ?? 0));
  if (far > 0) settled(chs, !!loop, (x) => applyDistance(x, far));

  // The place.
  if (room && room > 0) {
    const [wl, wr] = reverbWet(chs[0]!, chs[1] ?? null, { room: 0.3, damp: 0.65, size: roomSize ?? 0.3, preDelayMs: 2, lowCutHz: 220, highCutHz: 7500, loop: !!loop });
    if (!stereo) for (let i = 0; i < total; i++) chs[0]![i]! += room * 2.2 * (wl[i]! + wr[i]!) * 0.5;
    else mixWet(chs, wl, wr, room * 2.2, Math.max(0.5, wide));
  }
  if (place) {
    const [wl, wr] = spaceWet(chs[0]!, chs[1] ?? null, place, { decay: spaceDecay, loop: !!loop });
    // spaceMix is energy against the dry sound, whatever the space: the wet is scaled to it.
    let dry = 0;
    let wet = 0;
    for (const x of chs) for (let i = 0; i < total; i++) dry += x[i]! * x[i]!;
    dry /= chs.length;
    for (let i = 0; i < total; i++) wet += 0.5 * (wl[i]! * wl[i]! + wr[i]! * wr[i]!);
    const amount = Math.min(1, Math.max(0, spaceMix ?? 0.2)) * (1 + 2 * far);
    const g = wet > 0 ? amount * Math.sqrt(dry / wet) : 0;
    if (!stereo) for (let i = 0; i < total; i++) chs[0]![i]! += g * (wl[i]! + wr[i]!) * Math.SQRT1_2;
    else mixWet(chs, wl, wr, g, Math.max(0.6, wide));
  }

  // Stereo keeps its lows in the middle: what differs between the sides under 150 Hz is taken out.
  if (stereo) settled(chs, !!loop, centreLows);

  let kept: Float32Array[] = chs;
  if (!loop) {
    // Trim against the main voice's own peak (in voice units), so adding layers to a sound can never shorten it.
    let ref = 0;
    for (let i = 0; i < voices[0]!.pcm.length; i++) ref = Math.max(ref, Math.abs(voices[0]!.pcm[i]!));
    kept = trimTail(chs, ref);
  }
  // Work relative to the mix's own peak: thresholds below are dB under it, so presets do not depend on voice volumes.
  let top = 0;
  for (const x of kept) for (let i = 0; i < x.length; i++) top = Math.max(top, Math.abs(x[i]!));
  if (top > 0) for (const x of kept) for (let i = 0; i < x.length; i++) x[i]! /= top;
  if (comp) compress(kept, { ...comp, loop: !!loop });
  const amount = clip ?? CATEGORY_CLIP[cat] ?? 0;
  if (amount > 0) softClipMix(kept, amount);
  // The front edge last, so the saturation above does not round it off again.
  const snap = loop ? 0 : (transient ?? CATEGORY_TRANSIENT[cat] ?? 0);
  if (snap) shapeTransients(kept, { attackDb: 9 * Math.min(1, Math.max(-1, snap)) });
  // Mastering: DC out, end fades, the category's loudness, true peaks under -1.5 dBTP.
  const report = master(kept, { category: cat, loop: !!loop, ...(loop ? {} : { clipDb: CATEGORY_PEAK_CLIP[cat] ?? 0 }) });
  if (info) {
    info.master = report;
    info.loop = !!loop;
    info.stereo = stereo;
  }
  return kept;
}

/** Renders one sound effect to mastered mono PCM (a stereo sound is summed). See renderSfxChannels. */
export function renderSfx(input: SfxParams, seed = 1, info?: SfxRenderInfo): Float32Array {
  const chs = renderSfxChannels(input, seed, info);
  if (chs.length === 1) return chs[0]!;
  const [l, r] = chs as [Float32Array, Float32Array];
  const out = new Float32Array(l.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (l[i]! + r[i]!);
  return out;
}

/** Adds a stereo wet signal: `width` 0 = its mono sum on both sides, 1 = left and right as they are. */
function mixWet(chs: Float32Array[], wl: Float32Array, wr: Float32Array, gain: number, width: number): void {
  const [L, R] = chs as [Float32Array, Float32Array];
  const w = Math.min(1, Math.max(0, width));
  for (let i = 0; i < L.length; i++) {
    const mid = (wl[i]! + wr[i]!) * 0.5;
    const side = (wl[i]! - wr[i]!) * 0.5 * w;
    L[i]! += gain * (mid + side);
    R[i]! += gain * (mid - side);
  }
}

/**
 * Runs a filter over the channels in place. For a loop the loop's own end is its lead-in, so the filter has
 * settled by the seam and the end still runs into the start.
 */
function settled(chs: Float32Array[], loop: boolean, run: (chs: Float32Array[]) => void): void {
  if (!loop) return run(chs);
  const n = chs[0]!.length;
  const warm = Math.min(n, 8192);
  const ext = chs.map((x) => {
    const e = new Float32Array(warm + n);
    e.set(x.subarray(n - warm), 0);
    e.set(x, warm);
    return e;
  });
  run(ext);
  chs.forEach((x, c) => x.set(ext[c]!.subarray(warm)));
}

/** Removes the side signal (left minus right) under 150 Hz, so bass and sub are the same on both sides. */
function centreLows(chs: Float32Array[]): void {
  const [L, R] = chs as [Float32Array, Float32Array];
  const hp = [Biquad.highpass(150, 0.707), Biquad.highpass(150, 0.707)];
  for (let i = 0; i < L.length; i++) {
    const mid = (L[i]! + R[i]!) * 0.5;
    const side = hp[1]!.process(hp[0]!.process((L[i]! - R[i]!) * 0.5));
    L[i] = mid + side;
    R[i] = mid - side;
  }
}

/** The tone controls: shelves at the ends, bells in the middle. */
function applyTone(chs: Float32Array[], tone: NonNullable<SfxParams['tone']>): void {
  const db = (v: number | undefined): number => Math.min(12, Math.max(-12, v ?? 0));
  for (const x of chs) {
    if (db(tone.low)) Biquad.lowShelf(120, db(tone.low)).processBuffer(x);
    if (db(tone.mid)) Biquad.peaking(350, 0.8, db(tone.mid)).processBuffer(x);
    if (db(tone.presence)) Biquad.peaking(3500, 0.8, db(tone.presence)).processBuffer(x);
    if (db(tone.air)) Biquad.highShelf(7000, db(tone.air)).processBuffer(x);
  }
}

/** tanh-style saturation relative to the buffer's own peak (the peak stays, everything under it comes up). */
function softClipMix(chs: Float32Array[], amount: number): void {
  let peak = 0;
  for (const x of chs) for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  if (peak === 0) return;
  for (const x of chs) {
    const sat = new Saturator(0.8 + 4 * Math.min(1, amount));
    for (let i = 0; i < x.length; i++) x[i] = sat.process(x[i]! / peak) * peak;
  }
}

/**
 * Cuts the silent end: the sound ends after the last 10 ms window that still has anything above -54 dB of `ref`
 * (default the buffer's peak), plus 5 ms and at least 30 ms in all. Whole windows, so the length does not jitter
 * with one random noise peak.
 */
function trimTail(chs: Float32Array[], ref = 0): Float32Array[] {
  const n = chs[0]!.length;
  let peak = ref;
  if (peak <= 0) for (const x of chs) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]!));
  const thr = peak * 0.002;
  const win = Math.round(0.01 * SAMPLE_RATE);
  let lastWindow = -1;
  for (let w = Math.floor((n - 1) / win); w >= 0 && lastWindow < 0; w--) {
    for (const x of chs) {
      for (let i = w * win; i < Math.min(n, (w + 1) * win); i++)
        if (Math.abs(x[i]!) > thr) {
          lastWindow = w;
          break;
        }
      if (lastWindow >= 0) break;
    }
  }
  const keep = Math.min(n, Math.max(Math.round(0.03 * SAMPLE_RATE), (lastWindow + 1) * win + Math.round(0.005 * SAMPLE_RATE)));
  return keep === n ? chs : chs.map((x) => x.slice(0, keep));
}

// ─── takes ───────────────────────────────────────────────────────────────────

const tweak = (v: number | undefined, rand: Rng, spread: number): number | undefined => (v === undefined || v === 0 ? v : v * (1 + (rand.next() * 2 - 1) * spread));

/**
 * One variation of a sound, differing in grain and balance and not only in pitch: every layer gets its own
 * level (+-2 dB), onset (+-1.5 ms), filter cutoffs (+-22 %), attack, sustain and resonance (+-25 %), decay (+-10 %), a touch of detune, a different noise
 * stream and debris density. Take 0 is the sound itself.
 */
export function varyTake(p: SfxParams, take: number, seed = 1): SfxParams {
  if (take === 0) return p;
  const rand = new Rng(seed * 977 + take * 131 + 5);
  const pitch = 1 + (take % 2 ? 1 : -1) * 0.04 * Math.ceil(take / 2);
  const stretch = 1 + 0.05 * (rand.next() * 2 - 1) * take + 0.02 * take;
  const one = <T extends SfxVoice>(v: T, main: boolean): T => {
    const gain = main ? 1 : Math.pow(10, ((rand.next() * 2 - 1) * 2) / 20);
    const out: T = { ...v, freq: v.freq * pitch * (main ? 1 : 1 + (rand.next() * 2 - 1) * 0.012), decay: (v.decay ?? 0.2) * stretch * (1 + (rand.next() * 2 - 1) * 0.1), volume: (v.volume ?? 0.6) * gain };
    for (const k of ['lowpass', 'highpass', 'bandpass', 'lowpassEnd', 'highpassEnd', 'bandpassEnd', 'freqEnd'] as const) if (out[k] !== undefined) (out as SfxVoice)[k] = tweak(out[k], rand, 0.22);
    for (const k of ['attack', 'sustain', 'resonance'] as const) if (out[k] !== undefined) (out as SfxVoice)[k] = tweak(out[k], rand, 0.25);
    if (out.crackle) out.crackle *= 1 + (rand.next() * 2 - 1) * 0.3;
    if (out.modes) out.modes = out.modes.map(([r, g, d]) => [r * (1 + (rand.next() * 2 - 1) * 0.006), g * (1 + (rand.next() * 2 - 1) * 0.25), d] as [number, number, number]);
    if (out.freqCurve) out.freqCurve = out.freqCurve.map(([t, hz]) => [t, hz * pitch] as Breakpoint);
    if (out.comb) out.comb *= pitch;
    return out;
  };
  const layers = p.layers?.map((l) => {
    const v = one(l, false);
    return { ...v, delay: Math.max(0, (l.delay ?? 0) + (rand.next() * 2 - 1) * 0.0015) };
  });
  return { ...one(p, true), layers };
}

/**
 * The takes of a sound exactly as AudioService makes them, each as its channels: take 1 is the sound itself,
 * the others vary it (see varyTake). A take that lands more than 0.5 LU away from the sound's loudness is
 * drawn again (up to four tries, then the closest is kept), so the takes of one sound play at one level.
 * A loop has one take.
 */
export function renderTakeChannels(params: SfxParams, count: number, info?: SfxRenderInfo): Float32Array[][] {
  const first: SfxRenderInfo = {};
  const takes = [renderSfxChannels(params, 1, first)];
  if (info) Object.assign(info, first);
  const level = first.master?.loudness ?? null;
  for (let k = 1; k < (params.loop ? 1 : count); k++) {
    let best: Float32Array[] | null = null;
    let bestErr = Infinity;
    for (let attempt = 0; attempt < 4; attempt++) {
      const got: SfxRenderInfo = {};
      const x = renderSfxChannels(varyTake(params, k, 1 + attempt * 7), 1 + k * 17 + attempt * 5, got);
      const err = level === null || got.master?.loudness == null ? 0 : Math.abs(got.master.loudness - level);
      if (err < bestErr) {
        best = x;
        bestErr = err;
      }
      if (err <= 0.5) break;
    }
    takes.push(best!);
  }
  return takes;
}

/** The takes of a sound as mono PCM (see renderTakeChannels). */
export function renderTakes(params: SfxParams, count: number): Float32Array[] {
  return renderTakeChannels({ ...params, stereo: false, width: 0 }, count).map((chs) => chs[0]!);
}

/** Detunes and stretches a sound (every layer together): the simple variation. */
export function varySfx(p: SfxParams, pitch: number, stretch: number): SfxParams {
  const one = <T extends SfxVoice>(v: T): T => ({ ...v, freq: v.freq * pitch, decay: (v.decay ?? 0.2) * stretch });
  return { ...one(p), layers: p.layers?.map(one) };
}
