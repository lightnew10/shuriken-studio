/**
 * The effect presets. Impacts are layered transient + body + tail (a crack of bright noise, a pitched thump,
 * debris and a small room), tonal rewards are band-limited oscillators or FM bells with a bit of sparkle,
 * everything is mastered to its category's loudness (dsp/master LOUDNESS_TARGETS). Presets are plain data:
 * audio_sfx takes a preset and overrides any field, or layers of its own.
 */
import type { SfxParams, SfxVoice } from './sfx';

const hz = (base: number, semis: number): number => base * Math.pow(2, semis / 12);

/** A voice played at several pitches one after another (an arpeggio, a chime, a fanfare): notes ring over each other. */
function melody(base: SfxParams, semis: number[], step: number, extra: Partial<SfxParams> = {}): SfxParams {
  const { category, room, roomSize, comp, layers: own, ...voice } = base;
  const [first = 0, ...rest] = semis;
  const notes = rest.map((s, i) => ({ ...voice, freq: hz(voice.freq, s), delay: (i + 1) * step }));
  return { ...voice, freq: hz(voice.freq, first), category, room, roomSize, comp, ...extra, layers: [...(own ?? []), ...notes, ...(extra.layers ?? [])] };
}

/** A short burst of white noise shaped by a band-pass or a high-pass: the "crack" or "tick" at the front of a hit. */
const crack = (over: Partial<SfxVoice> & { delay?: number }): SfxVoice & { delay?: number } => ({ wave: 'white', freq: 1000, attack: 0.0003, sustain: 0, decay: 0.012, volume: 0.9, ...over });

export const SFX_PRESETS: Record<string, SfxParams> = {
  // ── UI ──────────────────────────────────────────────────────────────────────
  click: {
    wave: 'sine', freq: 1900, freqEnd: 1100, pitchTime: 0.006, attack: 0.0005, sustain: 0.004, decay: 0.035, volume: 0.8, category: 'ui', clip: 0.5,
    layers: [crack({ bandpass: 4600, resonance: 1.1, decay: 0.008, volume: 0.55 }), { wave: 'triangle', freq: 3800, attack: 0.0005, sustain: 0, decay: 0.012, volume: 0.15 }],
  },
  blip: {
    wave: 'sine', freq: 880, slide: 0.35, attack: 0.003, sustain: 0.03, decay: 0.09, volume: 0.7, category: 'ui',
    layers: [{ wave: 'sine', freq: 1760, slide: 0.35, attack: 0.003, sustain: 0.01, decay: 0.05, volume: 0.18 }, crack({ bandpass: 6000, resonance: 0.9, decay: 0.006, volume: 0.1 })],
  },
  error: {
    wave: 'saw', freq: 233, attack: 0.003, sustain: 0.06, decay: 0.09, lowpass: 2300, resonance: 1.4, drive: 0.15, volume: 0.7, category: 'ui',
    layers: [
      { wave: 'saw', freq: 175, attack: 0.003, sustain: 0.07, decay: 0.12, lowpass: 2000, resonance: 1.4, drive: 0.15, volume: 0.7, delay: 0.1 },
      { wave: 'square', freq: 117, attack: 0.003, sustain: 0.04, decay: 0.1, lowpass: 900, volume: 0.35, delay: 0.1 },
    ],
  },
  hover: {
    wave: 'sine', freq: 1500, attack: 0.002, sustain: 0.005, decay: 0.04, volume: 0.6, category: 'ui',
    layers: [crack({ bandpass: 5200, resonance: 0.9, decay: 0.006, volume: 0.15 })],
  },
  confirm: melody({ wave: 'triangle', freq: 784, attack: 0.002, sustain: 0.03, decay: 0.12, volume: 0.7, category: 'ui' }, [0, 7], 0.07, { room: 0.06, roomSize: 0.12, layers: [{ wave: 'sine', freq: 1568, attack: 0.002, sustain: 0.01, decay: 0.08, volume: 0.15, delay: 0.07 }] }),
  cancel: melody({ wave: 'triangle', freq: 659, attack: 0.002, sustain: 0.03, decay: 0.11, volume: 0.7, category: 'ui' }, [0, -5], 0.07, { room: 0.05, roomSize: 0.12 }),

  // ── rewards ─────────────────────────────────────────────────────────────────
  coin: {
    wave: 'fm', freq: 988, fmRatio: 3.5, fmIndex: 2.2, fmDecay: 0.06, attack: 0.002, sustain: 0.02, decay: 0.2, volume: 0.6, category: 'pickup', room: 0.12, roomSize: 0.3,
    layers: [
      { wave: 'sine', freq: 1976, attack: 0.002, sustain: 0, decay: 0.1, volume: 0.1 },
      { wave: 'fm', freq: 1319, fmRatio: 3.5, fmIndex: 2.4, fmDecay: 0.07, attack: 0.002, sustain: 0.03, decay: 0.34, volume: 0.65, delay: 0.065 },
      { wave: 'sine', freq: 2638, attack: 0.002, sustain: 0, decay: 0.18, volume: 0.12, delay: 0.065 },
      crack({ highpass: 7000, decay: 0.03, volume: 0.1, delay: 0.065 }),
    ],
  },
  pickup: {
    wave: 'triangle', freq: 660, slide: 1.1, attack: 0.003, sustain: 0.04, decay: 0.2, volume: 0.7, category: 'pickup', room: 0.1, roomSize: 0.3,
    layers: [{ wave: 'sine', freq: 1320, slide: 1.1, attack: 0.003, sustain: 0.02, decay: 0.15, volume: 0.2 }, crack({ highpass: 6000, decay: 0.02, volume: 0.07 })],
  },
  powerup: melody({ wave: 'saw', freq: 523.25, attack: 0.004, sustain: 0.03, decay: 0.14, lowpass: 3800, resonance: 1.5, volume: 0.55, category: 'pickup' }, [0, 4, 7, 12, 16], 0.07, {
    room: 0.2,
    roomSize: 0.4,
    layers: [
      { wave: 'triangle', freq: 1046.5, attack: 0.004, sustain: 0.02, decay: 0.3, volume: 0.35, delay: 0.28 },
      { wave: 'white', freq: 1000, attack: 0.05, sustain: 0.1, decay: 0.2, bandpass: 2500, bandpassEnd: 7000, resonance: 1.5, volume: 0.18 },
      crack({ highpass: 7500, decay: 0.15, volume: 0.1, delay: 0.28 }),
    ],
  }),
  checkpoint: melody({ wave: 'fm', freq: 784, fmRatio: 3.5, fmIndex: 1.8, fmDecay: 0.1, attack: 0.003, sustain: 0.05, decay: 0.45, volume: 0.6, category: 'pickup' }, [0, 5, 9], 0.09, {
    room: 0.3,
    roomSize: 0.6,
    layers: [{ wave: 'sine', freq: 3136, attack: 0.002, sustain: 0, decay: 0.25, volume: 0.07, delay: 0.18 }],
  }),
  levelup: melody({ wave: 'saw', freq: 523.25, attack: 0.005, sustain: 0.07, decay: 0.2, lowpass: 3500, resonance: 1.2, drive: 0.15, volume: 0.5, category: 'stinger' }, [0, 4, 7], 0.11, {
    room: 0.25,
    roomSize: 0.6,
    layers: [
      { wave: 'saw', freq: 1046.5, attack: 0.006, sustain: 0.28, decay: 0.45, lowpass: 3800, resonance: 1.2, volume: 0.5, delay: 0.33 },
      { wave: 'saw', freq: 1318.5, attack: 0.006, sustain: 0.28, decay: 0.45, lowpass: 3800, resonance: 1.2, volume: 0.4, delay: 0.33 },
      { wave: 'saw', freq: 1568, attack: 0.006, sustain: 0.28, decay: 0.45, lowpass: 3800, resonance: 1.2, volume: 0.35, delay: 0.33 },
      { wave: 'sine', freq: 2093, attack: 0.002, sustain: 0.05, decay: 0.5, volume: 0.15, delay: 0.33 },
      crack({ highpass: 7000, decay: 0.2, volume: 0.1, delay: 0.33 }),
    ],
  }),

  // ── movement ────────────────────────────────────────────────────────────────
  jump: {
    wave: 'triangle', freq: 240, slide: 4.2, attack: 0.004, sustain: 0.05, decay: 0.15, lowpass: 3600, resonance: 1.2, volume: 0.8, category: 'movement',
    layers: [{ wave: 'sine', freq: 480, slide: 4.2, attack: 0.004, sustain: 0.03, decay: 0.1, volume: 0.2 }, crack({ bandpass: 1800, resonance: 1, attack: 0.002, decay: 0.05, volume: 0.2 })],
  },
  swing: {
    wave: 'pink', freq: 1000, attack: 0.045, sustain: 0.02, decay: 0.15, bandpass: 700, bandpassEnd: 3600, resonance: 1.6, volume: 1, category: 'movement',
    layers: [
      { wave: 'white', freq: 1000, attack: 0.05, sustain: 0.01, decay: 0.12, highpass: 3500, volume: 0.3 },
      { wave: 'brown', freq: 1000, attack: 0.04, sustain: 0.02, decay: 0.15, lowpass: 500, volume: 0.2 },
    ],
  },
  whoosh: {
    wave: 'pink', freq: 1000, attack: 0.11, sustain: 0.04, decay: 0.28, bandpass: 380, bandpassEnd: 1900, resonance: 1.1, volume: 1, category: 'movement',
    layers: [
      { wave: 'white', freq: 1000, attack: 0.11, sustain: 0.03, decay: 0.24, highpass: 3000, volume: 0.22 },
      { wave: 'brown', freq: 1000, attack: 0.1, sustain: 0.04, decay: 0.3, lowpass: 280, volume: 0.35 },
    ],
  },
  splash: {
    wave: 'pink', freq: 1000, attack: 0.008, sustain: 0.06, decay: 0.5, lowpass: 5200, lowpassEnd: 800, resonance: 0.8, volume: 0.8, category: 'movement', room: 0.2, roomSize: 0.4,
    layers: [
      { wave: 'white', freq: 1000, attack: 0.004, sustain: 0.02, decay: 0.5, highpass: 3000, crackle: 110, grain: 0.005, volume: 0.45, delay: 0.02 },
      { wave: 'sine', freq: 330, freqEnd: 140, pitchTime: 0.07, attack: 0.004, sustain: 0.02, decay: 0.2, volume: 0.35, delay: 0.015 },
      crack({ highpass: 1800, lowpass: 9000, decay: 0.05, volume: 0.45 }),
    ],
  },

  dash: {
    wave: 'pink', freq: 1000, attack: 0.012, sustain: 0.02, decay: 0.18, bandpass: 600, bandpassEnd: 3200, resonance: 1.3, volume: 1, category: 'movement', clip: 0.5,
    layers: [
      { wave: 'white', freq: 1000, attack: 0.01, sustain: 0.01, decay: 0.12, highpass: 3500, volume: 0.25 },
      { wave: 'sine', freq: 130, freqEnd: 60, pitchTime: 0.04, attack: 0.003, sustain: 0.01, decay: 0.1, volume: 0.5 },
    ],
  },
  magic: {
    wave: 'fm', freq: 880, fmRatio: 2.01, fmIndex: 2.5, fmDecay: 0.15, slide: 0.5, attack: 0.01, sustain: 0.1, decay: 0.45, volume: 0.6, category: 'pickup', room: 0.3, roomSize: 0.5,
    layers: [
      { wave: 'fm', freq: 1319, fmRatio: 3.5, fmIndex: 2, fmDecay: 0.12, attack: 0.005, sustain: 0.05, decay: 0.4, volume: 0.5, delay: 0.08 },
      { wave: 'fm', freq: 1760, fmRatio: 3.5, fmIndex: 1.6, fmDecay: 0.1, attack: 0.005, sustain: 0.04, decay: 0.4, volume: 0.4, delay: 0.16 },
      { wave: 'white', freq: 1000, attack: 0.1, sustain: 0.1, decay: 0.35, bandpass: 2000, bandpassEnd: 9000, resonance: 2, volume: 0.25 },
      { wave: 'white', freq: 1000, attack: 0.05, sustain: 0.2, decay: 0.4, highpass: 6000, crackle: 60, grain: 0.006, volume: 0.3 },
    ],
  },
  heal: melody({ wave: 'triangle', freq: 523.25, attack: 0.02, sustain: 0.12, decay: 0.45, volume: 0.5, category: 'pickup' }, [0, 4, 7], 0.1, {
    room: 0.25,
    roomSize: 0.5,
    layers: [
      { wave: 'sine', freq: 1046.5, attack: 0.02, sustain: 0.15, decay: 0.5, volume: 0.25, delay: 0.2 },
      { wave: 'white', freq: 1000, attack: 0.12, sustain: 0.1, decay: 0.35, highpass: 6500, crackle: 45, grain: 0.006, volume: 0.2, delay: 0.1 },
    ],
  }),
  purchase: {
    wave: 'white', freq: 1000, attack: 0.0005, sustain: 0, decay: 0.02, highpass: 2500, volume: 0.6, category: 'pickup', room: 0.12, roomSize: 0.3,
    layers: [
      { wave: 'fm', freq: 1568, fmRatio: 3.5, fmIndex: 2.2, fmDecay: 0.08, attack: 0.001, sustain: 0.03, decay: 0.45, volume: 0.6, delay: 0.03 },
      { wave: 'fm', freq: 2093, fmRatio: 3.5, fmIndex: 2.2, fmDecay: 0.08, attack: 0.001, sustain: 0.03, decay: 0.5, volume: 0.55, delay: 0.1 },
      { wave: 'sine', freq: 4186, attack: 0.001, sustain: 0, decay: 0.2, volume: 0.08, delay: 0.1 },
    ],
  },
  victory: melody({ wave: 'saw', freq: 523.25, attack: 0.006, sustain: 0.08, decay: 0.2, lowpass: 3600, resonance: 1.2, drive: 0.15, volume: 0.5, category: 'stinger' }, [0, 4, 7, 12, 7, 12], 0.14, {
    room: 0.3,
    roomSize: 0.6,
    layers: [
      { wave: 'saw', freq: 1046.5, attack: 0.008, sustain: 0.28, decay: 0.4, lowpass: 3800, resonance: 1.2, volume: 0.5, delay: 0.84 },
      { wave: 'saw', freq: 1318.5, attack: 0.008, sustain: 0.28, decay: 0.4, lowpass: 3800, resonance: 1.2, volume: 0.4, delay: 0.84 },
      { wave: 'saw', freq: 1568, attack: 0.008, sustain: 0.28, decay: 0.4, lowpass: 3800, resonance: 1.2, volume: 0.35, delay: 0.84 },
      { wave: 'sine', freq: 2093, attack: 0.002, sustain: 0.05, decay: 0.45, volume: 0.15, delay: 0.84 },
    ],
  }),
  defeat: melody({ wave: 'saw', freq: 392, attack: 0.01, sustain: 0.12, decay: 0.2, lowpass: 1800, resonance: 1.5, drive: 0.15, volume: 0.55, category: 'stinger' }, [0, -1, -3, -7], 0.24, {
    room: 0.25,
    roomSize: 0.5,
    layers: [{ wave: 'saw', freq: 196, vibratoDepth: 0.015, vibratoSpeed: 5, attack: 0.02, sustain: 0.3, decay: 0.45, lowpass: 900, resonance: 1.2, volume: 0.4, delay: 0.72 }],
  }),

  // ── footsteps ───────────────────────────────────────────────────────────────
  footstep: {
    wave: 'sine', freq: 130, freqEnd: 75, pitchTime: 0.025, attack: 0.001, sustain: 0.012, decay: 0.08, volume: 0.45, category: 'footstep',
    layers: [
      { wave: 'pink', freq: 1000, attack: 0.001, sustain: 0.015, decay: 0.11, lowpass: 1900, lowpassEnd: 600, resonance: 0.9, volume: 1 },
      crack({ highpass: 2500, lowpass: 7500, attack: 0.0006, decay: 0.03, volume: 0.35, delay: 0.004 }),
    ],
  },

  stepgrass: {
    wave: 'pink', freq: 1000, attack: 0.004, sustain: 0.02, decay: 0.12, lowpass: 1500, lowpassEnd: 700, resonance: 0.7, volume: 1, category: 'footstep', clip: 0.5,
    layers: [
      { wave: 'sine', freq: 95, freqEnd: 58, pitchTime: 0.03, attack: 0.002, sustain: 0.01, decay: 0.07, volume: 0.5 },
      { wave: 'white', freq: 1000, attack: 0.002, sustain: 0.03, decay: 0.1, highpass: 3500, crackle: 90, grain: 0.004, volume: 0.35 },
    ],
  },
  stepgravel: {
    wave: 'white', freq: 1000, attack: 0.001, sustain: 0.04, decay: 0.14, highpass: 1200, lowpass: 7500, crackle: 220, grain: 0.0035, volume: 1, category: 'footstep',
    layers: [
      { wave: 'sine', freq: 100, freqEnd: 60, pitchTime: 0.03, attack: 0.001, sustain: 0.01, decay: 0.06, volume: 0.6 },
      { wave: 'pink', freq: 1000, attack: 0.001, sustain: 0.02, decay: 0.09, lowpass: 900, volume: 0.5 },
    ],
  },
  stepwood: {
    wave: 'sine', freq: 150, freqEnd: 95, pitchTime: 0.02, attack: 0.001, sustain: 0.01, decay: 0.07, volume: 0.9, category: 'footstep',
    layers: [
      { wave: 'modal', freq: 420, modes: [[1, 1, 1], [2.3, 0.55, 0.6], [3.9, 0.35, 0.4], [5.7, 0.2, 0.3]], attack: 0.0005, sustain: 0, decay: 0.13, volume: 0.7 },
      crack({ highpass: 2000, lowpass: 8000, attack: 0.0005, decay: 0.02, volume: 0.4 }),
    ],
  },
  stepmetal: {
    wave: 'sine', freq: 140, freqEnd: 90, pitchTime: 0.02, attack: 0.001, sustain: 0.01, decay: 0.06, volume: 0.7, category: 'footstep', clip: 0.5,
    layers: [
      { wave: 'modal', freq: 900, modes: [[1, 1, 1], [2.76, 0.7, 0.8], [5.4, 0.5, 0.6], [8.9, 0.35, 0.45]], attack: 0.0005, sustain: 0.005, decay: 0.28, volume: 0.9 },
      crack({ highpass: 3000, decay: 0.015, volume: 0.5 }),
    ],
  },
  stepsnow: {
    wave: 'pink', freq: 1000, attack: 0.006, sustain: 0.05, decay: 0.16, lowpass: 2200, lowpassEnd: 600, volume: 1, category: 'footstep',
    layers: [
      { wave: 'white', freq: 1000, attack: 0.004, sustain: 0.06, decay: 0.14, highpass: 2500, crackle: 140, grain: 0.004, volume: 0.4 },
      { wave: 'sine', freq: 80, freqEnd: 50, pitchTime: 0.04, attack: 0.002, sustain: 0.01, decay: 0.08, volume: 0.4 },
    ],
  },

  // ── combat ──────────────────────────────────────────────────────────────────
  hit: {
    wave: 'sine', freq: 210, freqEnd: 85, pitchTime: 0.03, attack: 0.001, sustain: 0.02, decay: 0.2, punch: 0.4, drive: 0.3, volume: 0.5, category: 'impact', clip: 0.75, room: 0.1, roomSize: 0.2,
    layers: [
      crack({ highpass: 2500, lowpass: 10000, decay: 0.02, volume: 0.9 }),
      crack({ highpass: 1200, lowpass: 7500, attack: 0.0004, sustain: 0.003, decay: 0.07, volume: 0.6 }),
      { wave: 'pink', freq: 1000, attack: 0.001, sustain: 0.03, decay: 0.22, lowpass: 2200, lowpassEnd: 450, resonance: 1.2, volume: 0.6 },
      { wave: 'saw', freq: 420, freqEnd: 150, pitchTime: 0.05, lowpass: 1800, lowpassEnd: 500, resonance: 1, attack: 0.001, sustain: 0.03, decay: 0.22, volume: 1.5 },
      { wave: 'sine', freq: 340, freqEnd: 190, pitchTime: 0.02, attack: 0.001, sustain: 0.01, decay: 0.12, volume: 0.5 },
      { wave: 'pink', freq: 1000, attack: 0.002, sustain: 0.02, decay: 0.12, bandpass: 750, resonance: 0.9, volume: 0.8 },
      { wave: 'brown', freq: 1000, attack: 0.004, sustain: 0.03, decay: 0.3, lowpass: 500, volume: 0.3, delay: 0.01 },
    ],
  },
  hurt: {
    wave: 'saw', freq: 250, freqEnd: 150, pitchTime: 0.12, attack: 0.006, sustain: 0.08, decay: 0.2, bandpass: 750, bandpassEnd: 480, resonance: 4, vibratoDepth: 0.02, vibratoSpeed: 28, volume: 0.9, category: 'impact', clip: 0.75, room: 0.06, roomSize: 0.15,
    layers: [
      { wave: 'saw', freq: 250, freqEnd: 150, pitchTime: 0.12, attack: 0.006, sustain: 0.08, decay: 0.2, bandpass: 1500, bandpassEnd: 1100, resonance: 5, vibratoDepth: 0.02, vibratoSpeed: 28, volume: 0.5 },
      { wave: 'white', freq: 1000, attack: 0.004, sustain: 0.05, decay: 0.14, bandpass: 2400, resonance: 1.2, volume: 0.25 },
      { wave: 'sine', freq: 150, freqEnd: 85, pitchTime: 0.03, attack: 0.001, sustain: 0.02, decay: 0.14, volume: 0.4 },
      crack({ highpass: 2200, lowpass: 9000, decay: 0.015, volume: 0.5 }),
    ],
  },
  punch: {
    wave: 'sine', freq: 170, freqEnd: 70, pitchTime: 0.035, attack: 0.001, sustain: 0.03, decay: 0.24, punch: 0.5, drive: 0.35, volume: 0.6, category: 'impact', clip: 0.7, room: 0.08, roomSize: 0.18,
    layers: [
      crack({ highpass: 2200, lowpass: 9000, decay: 0.02, volume: 0.8 }),
      crack({ highpass: 900, lowpass: 6000, attack: 0.0005, sustain: 0.003, decay: 0.07, volume: 0.55 }),
      { wave: 'pink', freq: 1000, attack: 0.001, sustain: 0.03, decay: 0.24, lowpass: 1600, lowpassEnd: 380, resonance: 1.2, volume: 0.7 },
      { wave: 'saw', freq: 300, freqEnd: 110, pitchTime: 0.05, lowpass: 1400, lowpassEnd: 400, resonance: 1, attack: 0.001, sustain: 0.04, decay: 0.26, volume: 1.4 },
      { wave: 'pink', freq: 1000, attack: 0.002, sustain: 0.02, decay: 0.12, bandpass: 600, resonance: 0.9, volume: 0.6 },
      { wave: 'brown', freq: 1000, attack: 0.003, sustain: 0.04, decay: 0.3, lowpass: 420, volume: 0.35, delay: 0.008 },
    ],
  },
  block: {
    wave: 'sine', freq: 240, freqEnd: 130, pitchTime: 0.025, attack: 0.001, sustain: 0.04, decay: 0.24, punch: 0.4, volume: 0.6, category: 'impact', clip: 0.85, room: 0.1, roomSize: 0.2,
    layers: [
      { wave: 'modal', freq: 640, modes: [[1, 1, 1], [2.4, 0.6, 0.7], [4.1, 0.4, 0.5], [6.2, 0.25, 0.35]], attack: 0.0005, sustain: 0, decay: 0.22, volume: 0.7 },
      crack({ highpass: 2500, lowpass: 10000, decay: 0.02, volume: 0.7 }),
      { wave: 'pink', freq: 1000, attack: 0.001, sustain: 0.05, decay: 0.26, lowpass: 2000, lowpassEnd: 500, volume: 0.9 },
      { wave: 'square', freq: 360, freqEnd: 200, pitchTime: 0.04, duty: 0.3, lowpass: 1600, lowpassEnd: 600, resonance: 1, attack: 0.001, sustain: 0.03, decay: 0.2, volume: 0.8 },
      { wave: 'pink', freq: 1000, attack: 0.002, sustain: 0.02, decay: 0.14, bandpass: 900, resonance: 0.9, volume: 0.6 },
      { wave: 'brown', freq: 1000, attack: 0.003, sustain: 0.05, decay: 0.3, lowpass: 450, volume: 0.35, delay: 0.008 },
    ],
  },
  clang: {
    wave: 'sine', freq: 1150, attack: 0.001, sustain: 0.03, decay: 0.55, punch: 0.3, vibratoDepth: 0.003, vibratoSpeed: 7, volume: 0.14, category: 'impact', clip: 0.8, room: 0.12, roomSize: 0.25,
    layers: [
      { wave: 'modal', freq: 1150, modes: [[1, 0.12, 1], [2.76, 0.7, 1], [5.4, 0.65, 0.85], [8.9, 0.5, 0.65], [13.3, 0.35, 0.45]], attack: 0.0005, sustain: 0.01, decay: 0.5, volume: 1 },
      crack({ highpass: 3500, attack: 0.0002, decay: 0.012, volume: 0.35 }),
      { wave: 'white', freq: 1000, attack: 0.001, sustain: 0.01, decay: 0.12, bandpass: 5200, resonance: 2, volume: 0.45 },
      { wave: 'sine', freq: 1720, attack: 0.001, sustain: 0.01, decay: 0.45, vibratoDepth: 0.004, vibratoSpeed: 5, volume: 0.12 },
      { wave: 'sine', freq: 230, freqEnd: 150, pitchTime: 0.02, attack: 0.001, sustain: 0.01, decay: 0.1, volume: 0.3 },
    ],
  },
  slam: {
    wave: 'sine', freq: 100, freqEnd: 45, pitchTime: 0.14, attack: 0.002, sustain: 0.06, decay: 0.6, punch: 0.5, drive: 0.4, volume: 0.7, category: 'impact', clip: 0.6, room: 0.2, roomSize: 0.45,
    comp: { thresholdDb: -14, ratio: 3, attackMs: 4, releaseMs: 120, makeupDb: 3 },
    layers: [
      crack({ highpass: 1800, lowpass: 9000, attack: 0.0004, sustain: 0.003, decay: 0.08, volume: 0.9 }),
      { wave: 'brown', freq: 1000, attack: 0.02, sustain: 0.12, decay: 0.62, lowpass: 380, lowpassEnd: 90, resonance: 0.9, volume: 0.8, delay: 0.03 },
      { wave: 'pink', freq: 1000, attack: 0.002, sustain: 0.06, decay: 0.4, lowpass: 2600, lowpassEnd: 400, volume: 1.2 },
      { wave: 'pink', freq: 1000, attack: 0.003, sustain: 0.04, decay: 0.2, bandpass: 700, resonance: 0.9, volume: 0.8 },
      { wave: 'white', freq: 1000, attack: 0.002, sustain: 0, decay: 0.45, highpass: 2500, crackle: 70, grain: 0.004, volume: 0.3, delay: 0.02 },
    ],
  },
  explosion: {
    wave: 'sine', freq: 75, freqEnd: 32, pitchTime: 0.25, attack: 0.003, sustain: 0.12, decay: 0.9, punch: 0.5, drive: 0.5, volume: 0.6, category: 'impact', clip: 0.6, room: 0.25, roomSize: 0.5,
    comp: { thresholdDb: -14, ratio: 3, attackMs: 5, releaseMs: 150, makeupDb: 3 },
    layers: [
      crack({ highpass: 1500, attack: 0.0004, decay: 0.07, volume: 1 }),
      { wave: 'pink', freq: 1000, attack: 0.002, sustain: 0.1, decay: 0.75, lowpass: 5000, lowpassEnd: 350, resonance: 0.9, volume: 1.2 },
      { wave: 'pink', freq: 1000, attack: 0.004, sustain: 0.1, decay: 0.5, bandpass: 900, bandpassEnd: 400, resonance: 0.9, volume: 0.9 },
      { wave: 'brown', freq: 1000, attack: 0.01, sustain: 0.2, decay: 0.9, lowpass: 600, lowpassEnd: 90, volume: 0.7, delay: 0.02 },
      { wave: 'white', freq: 1000, attack: 0.002, sustain: 0, decay: 0.8, highpass: 2500, crackle: 110, grain: 0.004, volume: 0.4, delay: 0.05 },
      { wave: 'white', freq: 1000, attack: 0.002, sustain: 0, decay: 0.25, highpass: 6000, volume: 0.35 },
    ],
  },
  laser: {
    wave: 'saw', freq: 2400, freqEnd: 260, pitchTime: 0.05, attack: 0.001, sustain: 0.03, decay: 0.16, lowpass: 6000, lowpassEnd: 1200, resonance: 3, drive: 0.3, volume: 0.8, category: 'impact', clip: 0.7, room: 0.08, roomSize: 0.15,
    layers: [{ wave: 'square', freq: 1200, freqEnd: 130, pitchTime: 0.05, duty: 0.25, attack: 0.001, sustain: 0.03, decay: 0.14, volume: 0.35 }, crack({ highpass: 3000, decay: 0.01, volume: 0.4 })],
  },
};
