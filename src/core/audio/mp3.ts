import { Mp3Encoder } from '@breezystack/lamejs';
import { SAMPLE_RATE } from './dsp/util';

/**
 * 192 kbps CBR for everything: at 128 kbps lamejs overshoots the limiter's ceiling by up to 3.5 dB on sharp
 * sounds (measured with ffmpeg), at 192 the decoded true peak is the same or 0.1-0.3 dB lower. Roblox
 * transcodes uploads anyway, so a better source is the right thing to hand it.
 */
export const MP3_KBPS = 192;

/** MP3 bytes from float PCM (mono or stereo, 44.1 kHz). */
export function encodeMp3(channels: Float32Array[], kbps = MP3_KBPS): Buffer {
  const toI16 = (x: Float32Array) => {
    const out = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)));
    return out;
  };
  const l = toI16(channels[0]!);
  const r = channels[1] ? toI16(channels[1]) : undefined;
  const enc = new Mp3Encoder(r ? 2 : 1, SAMPLE_RATE, kbps);
  const chunks: Uint8Array[] = [];
  const block = 1152;
  for (let i = 0; i < l.length; i += block) {
    const out = enc.encodeBuffer(l.subarray(i, i + block), r?.subarray(i, i + block));
    if (out.length) chunks.push(out);
  }
  const end = enc.flush();
  if (end.length) chunks.push(end);
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.length)));
}
