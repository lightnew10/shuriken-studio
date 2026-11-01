/**
 * Offline audio for Roblox games: the public face of the audio engine. Sound effects (sfx.ts, sfx-presets.ts),
 * songs (music.ts renders a SongSpec, compose.ts writes one from a style) and the mastering behind both
 * (dsp/). Everything is plain TypeScript DSP (no native deps): mono/stereo Float32 PCM at 44.1 kHz, encoded to
 * WAV here and to MP3 by the encoder module. Every render is mastered to its loudness category and a -1.5 dBTP
 * ceiling (dsp/master.ts).
 */

import { SAMPLE_RATE } from './dsp/util';
export { SAMPLE_RATE };
export * from './sfx';
export { SFX_PRESETS } from './sfx-presets';
export * from './music';
export * from './compose';

// ─── Encoding helpers ─────────────────────────────────────────────────────────

/** 16-bit PCM WAV bytes. */
export function wavBytes(channels: Float32Array[]): Buffer {
  const n = channels[0]!.length;
  const ch = channels.length;
  const data = Buffer.alloc(44 + n * ch * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * ch * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(ch, 22);
  data.writeUInt32LE(SAMPLE_RATE, 24);
  data.writeUInt32LE(SAMPLE_RATE * ch * 2, 28);
  data.writeUInt16LE(ch * 2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[c]![i]! * 32767))), o);
      o += 2;
    }
  return data;
}

/** Peak envelope for waveform drawings (0..1 per bucket). */
export function peaks(channels: Float32Array[], buckets = 240): number[] {
  const n = channels[0]!.length;
  const out: number[] = [];
  const size = Math.max(1, Math.floor(n / buckets));
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    for (let i = b * size; i < Math.min(n, (b + 1) * size); i++) for (const c of channels) m = Math.max(m, Math.abs(c[i]!));
    out.push(Math.round(m * 1000) / 1000);
  }
  return out;
}
