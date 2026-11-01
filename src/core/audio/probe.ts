/**
 * What an audio file is and how long it plays, read from its headers (no decoder): the checks an
 * imported track passes before it is saved (is it really audio, in a format Roblox takes, short
 * enough). mp3 (Layer III, frame by frame), Ogg Vorbis, WAV (PCM) and FLAC.
 */

export type AudioFormat = 'mp3' | 'ogg' | 'wav' | 'flac';
export const AUDIO_FORMATS: readonly AudioFormat[] = ['mp3', 'ogg', 'wav', 'flac'];

export type AudioProbe = { ok: true; format: AudioFormat; durationSec: number; sampleRate: number; channels: number } | { ok: false; error: string };

const ascii = (b: Uint8Array, at: number, n: number): string => {
  let s = '';
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]!);
  return s;
};
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** The container a file's first bytes say it is (the extension and the Content-Type are not trusted). */
export function sniffFormat(b: Uint8Array): AudioFormat | null {
  if (b.length < 12) return null;
  const head = ascii(b, 0, 4);
  if (head === 'OggS') return 'ogg';
  if (head === 'fLaC') return 'flac';
  if (head === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
  if (head.startsWith('ID3')) return 'mp3';
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}

// ─── mp3 ────────────────────────────────────────────────────────────────────

const MP3_BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATE: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Mp3Frame {
  length: number;
  samples: number;
  sampleRate: number;
  channels: number;
}

/** A Layer III frame header at `at` (null when the bytes there are not one). */
function mp3Frame(b: Uint8Array, at: number): Mp3Frame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1]! >> 3) & 3; // 0 = 2.5, 2 = 2, 3 = 1 (1 is reserved)
  const layer = (b[at + 1]! >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIx = (b[at + 2]! >> 4) & 15;
  const rateIx = (b[at + 2]! >> 2) & 3;
  if (bitrateIx === 0 || bitrateIx === 15 || rateIx === 3) return null;
  const sampleRate = MP3_RATE[version]![rateIx]!;
  const kbps = (version === 3 ? MP3_BITRATE_V1 : MP3_BITRATE_V2)[bitrateIx]!;
  const padding = (b[at + 2]! >> 1) & 1;
  const length = Math.floor(((version === 3 ? 144000 : 72000) * kbps) / sampleRate) + padding;
  return { length, samples: version === 3 ? 1152 : 576, sampleRate, channels: ((b[at + 3]! >> 6) & 3) === 3 ? 1 : 2 };
}

/** Where the first real frame starts: past an ID3v2 tag, at a header whose next frame follows on cue. */
function mp3Start(b: Uint8Array): number {
  let at = 0;
  if (ascii(b, 0, 3) === 'ID3' && b.length > 10) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    at = 10 + size + ((b[5]! & 0x10) !== 0 ? 10 : 0);
  }
  for (let i = at; i < Math.min(b.length - 4, at + 65536); i++) {
    const f = mp3Frame(b, i);
    if (f && mp3Frame(b, i + f.length)) return i;
  }
  return -1;
}

function probeMp3(b: Uint8Array): AudioProbe {
  const start = mp3Start(b);
  if (start < 0) return { ok: false, error: 'not a readable MP3 (no Layer III frames found)' };
  let at = start;
  let seconds = 0;
  let frames = 0;
  let first: Mp3Frame | null = null;
  let junk = 0;
  while (at + 4 <= b.length) {
    const f = mp3Frame(b, at);
    if (f) {
      first ??= f;
      seconds += f.samples / f.sampleRate;
      frames++;
      at += f.length;
      continue;
    }
    // A trailing tag ends the audio; anything else is skipped to the next header (a damaged stretch).
    if (ascii(b, at, 3) === 'TAG' || ascii(b, at, 8) === 'APETAGEX' || ascii(b, at, 3) === '3DI') break;
    at++;
    junk++;
    if (junk > 65536) break;
  }
  if (!first || frames < 2) return { ok: false, error: 'not a readable MP3 (too few frames)' };
  return { ok: true, format: 'mp3', durationSec: seconds, sampleRate: first.sampleRate, channels: first.channels };
}

// ─── wav ────────────────────────────────────────────────────────────────────

function probeWav(b: Uint8Array): AudioProbe {
  let at = 12;
  let fmt: { tag: number; channels: number; rate: number; byteRate: number } | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= b.length) {
      let tag = u16le(b, body);
      // WAVE_FORMAT_EXTENSIBLE: the real format tag is the first two bytes of the sub-format GUID.
      if (tag === 0xfffe && size >= 26 && body + 26 <= b.length) tag = u16le(b, body + 24);
      fmt = { tag, channels: u16le(b, body + 2), rate: u32le(b, body + 4), byteRate: u32le(b, body + 8) };
    } else if (id === 'data') {
      if (!fmt) return { ok: false, error: 'not a readable WAV (no fmt chunk before the data)' };
      if (fmt.tag !== 1 && fmt.tag !== 3) return { ok: false, error: `a WAV with a compressed encoding (format ${fmt.tag}); Roblox takes PCM WAV` };
      if (!fmt.byteRate || !fmt.rate) return { ok: false, error: 'not a readable WAV (bad format chunk)' };
      // A streamed WAV can leave the size 0 or 0xFFFFFFFF: the data then runs to the end of the file.
      const bytes = size === 0 || size === 0xffffffff || body + size > b.length ? b.length - body : size;
      return { ok: true, format: 'wav', durationSec: bytes / fmt.byteRate, sampleRate: fmt.rate, channels: fmt.channels };
    }
    at = body + size + (size & 1);
  }
  return { ok: false, error: 'not a readable WAV (no data chunk)' };
}

// ─── flac ───────────────────────────────────────────────────────────────────

function probeFlac(b: Uint8Array): AudioProbe {
  // The first metadata block is always STREAMINFO (type 0, 34 bytes).
  if (b.length < 42 || (b[4]! & 0x7f) !== 0) return { ok: false, error: 'not a readable FLAC (no STREAMINFO)' };
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[18 + i]!);
  const rate = Number(v >> 44n);
  const channels = Number((v >> 41n) & 7n) + 1;
  const samples = Number(v & ((1n << 36n) - 1n));
  if (!rate) return { ok: false, error: 'not a readable FLAC (no sample rate)' };
  if (!samples) return { ok: false, error: 'a FLAC that does not say how long it is' };
  return { ok: true, format: 'flac', durationSec: samples / rate, sampleRate: rate, channels };
}

// ─── ogg ────────────────────────────────────────────────────────────────────

function probeOgg(b: Uint8Array): AudioProbe {
  if (b.length < 28) return { ok: false, error: 'not a readable Ogg file' };
  const body = 27 + b[26]!;
  let rate = 0;
  let channels = 0;
  if (b[body] === 1 && ascii(b, body + 1, 6) === 'vorbis') {
    channels = b[body + 11]!;
    rate = u32le(b, body + 12);
  } else if (ascii(b, body, 8) === 'OpusHead') {
    return { ok: false, error: 'an Ogg Opus file; Roblox takes Ogg Vorbis, MP3, WAV and FLAC' };
  } else {
    return { ok: false, error: `an Ogg file that is not Vorbis audio (${JSON.stringify(ascii(b, body, 8).replace(/[^\x20-\x7e]/g, '?'))})` };
  }
  if (!rate) return { ok: false, error: 'not a readable Ogg Vorbis file' };
  // The last page that carries a position says how many samples there are.
  for (let i = b.length - 27, tries = 0; i > 0 && tries < 4096; i--) {
    if (b[i] !== 0x4f || ascii(b, i, 4) !== 'OggS' || b[i + 4] !== 0) continue;
    tries++;
    const lo = u32le(b, i + 6);
    const hi = u32le(b, i + 10);
    if (lo === 0xffffffff && hi === 0xffffffff) continue; // -1: no packet ends on this page
    const granule = hi * 4294967296 + lo;
    return { ok: true, format: 'ogg', durationSec: granule / rate, sampleRate: rate, channels };
  }
  return { ok: false, error: 'an Ogg file that does not say how long it is' };
}

/** What `bytes` is (by content) and how long it plays, or why it is not usable audio. */
export function probeAudio(bytes: Uint8Array): AudioProbe {
  switch (sniffFormat(bytes)) {
    case 'mp3':
      return probeMp3(bytes);
    case 'wav':
      return probeWav(bytes);
    case 'flac':
      return probeFlac(bytes);
    case 'ogg':
      return probeOgg(bytes);
    default:
      return { ok: false, error: 'not an MP3, Ogg Vorbis, WAV or FLAC file' };
  }
}
