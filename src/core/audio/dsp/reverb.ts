/**
 * A Freeverb-style stereo reverb (Schroeder/Moorer: eight parallel low-pass feedback combs and four series
 * allpasses per side, right side detuned) used as a SEND: it returns only the wet signal, the caller mixes
 * it back at the level it wants, and keeps kicks and bass out of it. Compared with the old four-comb
 * reverb on the whole mix: the tail is damped (highs die first, as in rooms), the input is high-passed so
 * the low end does not turn to mud, there is a pre-delay, and the room size is a parameter.
 */
import { SAMPLE_RATE } from './util';
import { Biquad } from './filter';

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];
const SPREAD = 23;

export interface ReverbOptions {
  /** 0..1: decay time (Freeverb's room size: feedback 0.70 to 0.98). Default 0.5. */
  room?: number;
  /** 0..1: how quickly the highs die in the tail. Default 0.5. */
  damp?: number;
  /** Scale of the delay lines: 0.3 a small room, 1 a hall. Default 1. */
  size?: number;
  /** 0..1 stereo width of the wet signal. Default 1. */
  width?: number;
  preDelayMs?: number;
  /** High-pass on the send (Hz). Default 180. */
  lowCutHz?: number;
  /** Low-pass on the send (Hz). Default 9000. */
  highCutHz?: number;
  /** The input is a loop: the tail wraps around into the start (the buffer is run through twice). */
  loop?: boolean;
}

/** Wet gain that makes a unit-RMS noise send come out at about unit RMS at room 0.5, damp 0.5. */
const WET_GAIN = 0.085;

/** Wet (reverb-only) left and right for a mono or stereo input of the same length as the outputs. */
export function reverbWet(inL: Float32Array, inR: Float32Array | null, o: ReverbOptions = {}): [Float32Array, Float32Array] {
  const n = inL.length;
  const room = Math.min(1, Math.max(0, o.room ?? 0.5));
  const damp = Math.min(1, Math.max(0, o.damp ?? 0.5));
  const size = Math.min(2, Math.max(0.1, o.size ?? 1));
  const width = Math.min(1, Math.max(0, o.width ?? 1));
  const feedback = room * 0.28 + 0.7;
  const damp1 = damp * 0.4;
  const damp2 = 1 - damp1;
  const pre = Math.round(((o.preDelayMs ?? 0) / 1000) * SAMPLE_RATE);

  // The send: mono sum, high-passed and low-passed.
  const send = new Float32Array(n);
  for (let i = 0; i < n; i++) send[i] = inR ? (inL[i]! + inR[i]!) * 0.5 : inL[i]!;
  Biquad.highpass(o.lowCutHz ?? 180, 0.707).processBuffer(send);
  Biquad.lowpass(o.highCutHz ?? 9000, 0.707).processBuffer(send);

  const sides: Float32Array[] = [];
  for (let side = 0; side < 2; side++) {
    const combLen = COMBS.map((c) => Math.max(8, Math.round((c + side * SPREAD) * size)));
    const combBuf = combLen.map((l) => new Float32Array(l));
    const combIdx = combLen.map(() => 0);
    const combStore = combLen.map(() => 0);
    const apLen = ALLPASS.map((c) => Math.max(8, Math.round((c + side * SPREAD) * size)));
    const apBuf = apLen.map((l) => new Float32Array(l));
    const apIdx = apLen.map(() => 0);
    const preBuf = new Float32Array(Math.max(1, pre));
    let preIdx = 0;
    const out = new Float32Array(n);
    for (let pass = 0; pass < (o.loop ? 2 : 1); pass++)
      for (let i = 0; i < n; i++) {
        let x = send[i]!;
        if (pre > 0) {
          const d = preBuf[preIdx]!;
          preBuf[preIdx] = x;
          preIdx = (preIdx + 1) % pre;
          x = d;
        }
        x *= WET_GAIN;
        let sum = 0;
        for (let c = 0; c < combBuf.length; c++) {
          const buf = combBuf[c]!;
          const k = combIdx[c]!;
          const y = buf[k]!;
          combStore[c] = y * damp2 + combStore[c]! * damp1;
          buf[k] = x + combStore[c]! * feedback;
          combIdx[c] = k + 1 === buf.length ? 0 : k + 1;
          sum += y;
        }
        for (let a = 0; a < apBuf.length; a++) {
          const buf = apBuf[a]!;
          const k = apIdx[a]!;
          const b = buf[k]!;
          const y = b - sum;
          buf[k] = sum + b * 0.5;
          apIdx[a] = k + 1 === buf.length ? 0 : k + 1;
          sum = y;
        }
        if (pass === (o.loop ? 1 : 0)) out[i] = sum;
      }
    sides.push(out);
  }
  const [a, b] = sides as [Float32Array, Float32Array];
  const w1 = width / 2 + 0.5;
  const w2 = (1 - width) / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = a[i]! * w1 + b[i]! * w2;
    R[i] = b[i]! * w1 + a[i]! * w2;
  }
  return [L, R];
}
