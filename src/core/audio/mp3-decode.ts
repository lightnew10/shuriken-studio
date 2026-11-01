/**
 * An MP3 decoder (MPEG-1, MPEG-2 and MPEG-2.5 Layer III) in plain TypeScript, so a sample found on the web
 * (Freesound's previews are MP3) or a user's own one-shot becomes PCM the composer can play. It follows the
 * standard step by step and favours being clear over being fast (a minute of stereo decodes in well under a
 * second): frame sync, side info, the bit reservoir, scale factors, Huffman decoding, requantization, joint
 * stereo (mid/side and intensity), reordering, alias reduction, the IMDCT with its block windows, and the
 * polyphase synthesis. A LAME/Xing tag's encoder delay and padding are trimmed, so a loop stays a loop.
 * Free-format streams (no bitrate in the header) are not read; damaged frames are skipped.
 */
import { HUFFMAN_CODES, HUFFMAN_XLEN, LINBITS, SFB_BANDS, SYNTH_WINDOW } from './mp3-tables';

export interface DecodedPcm {
  sampleRate: number;
  /** One Float32Array per channel, -1..1. */
  channels: Float32Array[];
}

export type Mp3Decoded = ({ ok: true } & DecodedPcm & { frames: number; gapless: boolean }) | { ok: false; error: string };

// ─── headers ────────────────────────────────────────────────────────────────

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Header {
  /** MPEG-2 or 2.5: one granule per frame, other side info and scale factors. */
  lsf: boolean;
  sampleRate: number;
  channels: number;
  /** 0 stereo, 1 joint stereo, 2 dual channel, 3 mono. */
  mode: number;
  modeExt: number;
  crc: boolean;
  length: number;
}

function header(b: Uint8Array, at: number): Header | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1]! >> 3) & 3; // 0 = 2.5, 2 = 2, 3 = 1
  const layer = (b[at + 1]! >> 1) & 3; // 1 = Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIx = (b[at + 2]! >> 4) & 15;
  const rateIx = (b[at + 2]! >> 2) & 3;
  if (bitrateIx === 0 || bitrateIx === 15 || rateIx === 3) return null;
  const sampleRate = RATES[version]![rateIx]!;
  const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIx]!;
  const padding = (b[at + 2]! >> 1) & 1;
  const mode = (b[at + 3]! >> 6) & 3;
  return {
    lsf: version !== 3,
    sampleRate,
    channels: mode === 3 ? 1 : 2,
    mode,
    modeExt: (b[at + 3]! >> 4) & 3,
    crc: (b[at + 1]! & 1) === 0,
    length: Math.floor(((version === 3 ? 144000 : 72000) * kbps) / sampleRate) + padding,
  };
}

/** Where the audio starts: past an ID3v2 tag, at a header whose next frame follows on cue. */
function firstFrame(b: Uint8Array): number {
  let at = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 && b.length > 10) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    at = 10 + size + ((b[5]! & 0x10) !== 0 ? 10 : 0);
  }
  return resync(b, at, null);
}

/** The next frame at or after `at` whose following frame is a frame too (and of the same stream). */
function resync(b: Uint8Array, at: number, like: Header | null): number {
  for (let i = at; i + 4 <= b.length && i < at + (1 << 20); i++) {
    const h = header(b, i);
    if (!h || (like && (h.sampleRate !== like.sampleRate || h.channels !== like.channels))) continue;
    const next = header(b, i + h.length);
    if ((next && next.sampleRate === h.sampleRate) || i + h.length === b.length) return i;
  }
  return -1;
}

// ─── bits and Huffman codes ─────────────────────────────────────────────────

class Bits {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  bit(): number {
    const v = ((this.b[this.pos >> 3] ?? 0) >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
}

/** A code table as a binary tree: node k's children are at 2k and 2k + 1; a negative entry is the leaf -(value + 1). */
const TREES = new Map<number, Int32Array>();
function tree(table: number): Int32Array {
  let t = TREES.get(table);
  if (t) return t;
  const nodes: number[] = [0, 0];
  HUFFMAN_CODES[table]!.trim().split(/\s+/).forEach((code, value) => {
    let at = 0;
    for (let i = 0; i < code.length; i++) {
      const slot = at * 2 + (code.charCodeAt(i) - 48);
      if (i === code.length - 1) nodes[slot] = -(value + 1);
      else {
        if (!nodes[slot]) {
          nodes[slot] = nodes.length / 2;
          nodes.push(0, 0);
        }
        at = nodes[slot]!;
      }
    }
  });
  t = Int32Array.from(nodes);
  TREES.set(table, t);
  return t;
}

function huff(br: Bits, t: Int32Array): number {
  let at = 0;
  for (let guard = 0; guard < 32; guard++) {
    const next = t[at * 2 + br.bit()]!;
    if (next < 0) return -next - 1;
    at = next;
  }
  throw new Error('bad Huffman code');
}

// ─── side info ──────────────────────────────────────────────────────────────

interface Granule {
  part23: number;
  bigValues: number;
  globalGain: number;
  sfCompress: number;
  blockType: number;
  mixed: boolean;
  tables: [number, number, number];
  subblockGain: [number, number, number];
  region0: number;
  region1: number;
  preflag: number;
  sfScale: number;
  count1Table: number;
  switched: boolean;
}

interface SideInfo {
  mainDataBegin: number;
  scfsi: number[][];
  gr: Granule[][];
}

function sideInfo(b: Uint8Array, h: Header): SideInfo {
  const br = new Bits(b);
  const nch = h.channels;
  const mainDataBegin = br.read(h.lsf ? 8 : 9);
  br.read(h.lsf ? (nch === 1 ? 1 : 2) : nch === 1 ? 5 : 3);
  const scfsi: number[][] = [];
  if (!h.lsf) for (let ch = 0; ch < nch; ch++) scfsi.push([br.bit(), br.bit(), br.bit(), br.bit()]);
  const gr: Granule[][] = [];
  for (let g = 0; g < (h.lsf ? 1 : 2); g++) {
    const row: Granule[] = [];
    for (let ch = 0; ch < nch; ch++) {
      const part23 = br.read(12);
      const bigValues = Math.min(288, br.read(9));
      const globalGain = br.read(8);
      const sfCompress = br.read(h.lsf ? 9 : 4);
      const switched = br.bit() === 1;
      let blockType = 0;
      let mixed = false;
      const tables: [number, number, number] = [0, 0, 0];
      const subblockGain: [number, number, number] = [0, 0, 0];
      let region0 = 0;
      let region1 = 0;
      if (switched) {
        blockType = br.read(2);
        mixed = br.bit() === 1;
        tables[0] = br.read(5);
        tables[1] = br.read(5);
        for (let w = 0; w < 3; w++) subblockGain[w] = br.read(3);
      } else {
        for (let r = 0; r < 3; r++) tables[r] = br.read(5);
        region0 = br.read(4);
        region1 = br.read(3);
      }
      const preflag = h.lsf ? 0 : br.bit();
      const sfScale = br.bit();
      const count1Table = br.bit();
      row.push({ part23, bigValues, globalGain, sfCompress, blockType, mixed, tables, subblockGain, region0, region1, preflag, sfScale, count1Table, switched });
    }
    gr.push(row);
  }
  return { mainDataBegin, scfsi, gr };
}

// ─── scale factors ──────────────────────────────────────────────────────────

const SLEN = [
  [0, 0, 0, 0, 3, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4],
  [0, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 2, 3],
];
const PRETAB = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 3, 2, 0];
/** MPEG-2: how many scale factors each of the four slen groups holds, by table, block kind (long, short, mixed). */
const NR_OF_SFB = [
  [[6, 5, 5, 5], [9, 9, 9, 9], [6, 9, 9, 9]],
  [[6, 5, 7, 3], [9, 9, 12, 6], [6, 9, 12, 6]],
  [[11, 10, 0, 0], [18, 18, 0, 0], [15, 18, 0, 0]],
  [[7, 7, 7, 0], [12, 12, 12, 0], [6, 15, 12, 0]],
  [[6, 6, 6, 3], [12, 9, 9, 6], [6, 12, 9, 6]],
  [[8, 8, 5, 0], [15, 12, 9, 0], [6, 18, 9, 0]],
];

interface Scales {
  long: number[];
  /** [sfb][window] */
  short: number[][];
  /** MPEG-2 intensity stereo: the position that means "not intensity" per band (long) and per short band. */
  isMaxLong?: number[];
  isMaxShort?: number[];
}

const newScales = (): Scales => ({ long: new Array(22).fill(0), short: Array.from({ length: 13 }, () => [0, 0, 0]) });

function scalesMpeg1(br: Bits, g: Granule, scfsi: number[], gi: number, prev: Scales | null): Scales {
  const s = newScales();
  const slen1 = SLEN[0]![g.sfCompress]!;
  const slen2 = SLEN[1]![g.sfCompress]!;
  if (g.switched && g.blockType === 2) {
    if (g.mixed) {
      for (let sfb = 0; sfb < 8; sfb++) s.long[sfb] = br.read(slen1);
      for (let sfb = 3; sfb < 12; sfb++) for (let w = 0; w < 3; w++) s.short[sfb]![w] = br.read(sfb < 6 ? slen1 : slen2);
    } else for (let sfb = 0; sfb < 12; sfb++) for (let w = 0; w < 3; w++) s.short[sfb]![w] = br.read(sfb < 6 ? slen1 : slen2);
    return s;
  }
  const groups = [
    [0, 6],
    [6, 11],
    [11, 16],
    [16, 21],
  ];
  groups.forEach(([a, z], k) => {
    for (let sfb = a!; sfb < z!; sfb++) s.long[sfb] = gi === 1 && scfsi[k] && prev ? prev.long[sfb]! : br.read(k < 2 ? slen1 : slen2);
  });
  return s;
}

function scalesLsf(br: Bits, g: Granule, intensityRight: boolean): Scales {
  let sfc = g.sfCompress;
  let slen: number[];
  let table: number;
  if (intensityRight) {
    sfc >>= 1;
    if (sfc < 180) {
      slen = [Math.floor(sfc / 36), Math.floor((sfc % 36) / 6), (sfc % 36) % 6, 0];
      table = 3;
    } else if (sfc < 244) {
      sfc -= 180;
      slen = [(sfc % 64) >> 4, (sfc % 16) >> 2, sfc % 4, 0];
      table = 4;
    } else {
      sfc -= 244;
      slen = [Math.floor(sfc / 3), sfc % 3, 0, 0];
      table = 5;
    }
  } else if (sfc < 400) {
    slen = [Math.floor((sfc >> 4) / 5), (sfc >> 4) % 5, (sfc % 16) >> 2, sfc % 4];
    table = 0;
  } else if (sfc < 500) {
    sfc -= 400;
    slen = [Math.floor((sfc >> 2) / 5), (sfc >> 2) % 5, sfc % 4, 0];
    table = 1;
  } else {
    sfc -= 500;
    slen = [Math.floor(sfc / 3), sfc % 3, 0, 0];
    table = 2;
    g.preflag = 1;
  }
  const kind = g.switched && g.blockType === 2 ? (g.mixed ? 2 : 1) : 0;
  const counts = NR_OF_SFB[table]![kind]!;
  const values: number[] = [];
  const maxes: number[] = [];
  counts.forEach((n, k) => {
    for (let i = 0; i < n; i++) {
      values.push(br.read(slen[k]!));
      maxes.push((1 << slen[k]!) - 1);
    }
  });
  const s = newScales();
  s.isMaxLong = new Array(22).fill(-1);
  s.isMaxShort = new Array(13).fill(-1);
  let i = 0;
  if (kind === 0) {
    for (let sfb = 0; sfb < 21; sfb++, i++) {
      s.long[sfb] = values[i] ?? 0;
      s.isMaxLong[sfb] = maxes[i] ?? -1;
    }
  } else {
    let from = 0;
    if (kind === 2) {
      for (let sfb = 0; sfb < 6; sfb++, i++) {
        s.long[sfb] = values[i] ?? 0;
        s.isMaxLong[sfb] = maxes[i] ?? -1;
      }
      from = 3;
    }
    for (let sfb = from; sfb < 12; sfb++)
      for (let w = 0; w < 3; w++, i++) {
        s.short[sfb]![w] = values[i] ?? 0;
        s.isMaxShort[sfb] = maxes[i] ?? -1;
      }
  }
  return s;
}

// ─── Huffman data and requantization ────────────────────────────────────────

const POW43 = (() => {
  const t = new Float64Array(8207);
  for (let i = 0; i < t.length; i++) t[i] = Math.pow(i, 4 / 3);
  return t;
})();

/** The 576 quantized values of one granule and channel; returns how many lines may be non-zero. */
function huffmanData(br: Bits, g: Granule, end: number, bands: { long: number[]; short: number[] }, out: Int32Array): number {
  out.fill(0);
  let r1: number;
  let r2: number;
  if (g.switched) {
    r1 = g.blockType === 2 && !g.mixed ? bands.short[3]! * 3 : bands.long[8]!;
    r2 = 576;
  } else {
    r1 = bands.long[Math.min(22, g.region0 + 1)]!;
    r2 = bands.long[Math.min(22, g.region0 + g.region1 + 2)]!;
  }
  const bigEnd = Math.min(576, g.bigValues * 2);
  let i = 0;
  for (; i < bigEnd; i += 2) {
    const tn = i < r1 ? g.tables[0] : i < r2 ? g.tables[1] : g.tables[2];
    if (tn === 0 || tn === 4 || tn === 14) continue;
    const lin = LINBITS[tn];
    const codes = lin ? lin.codes : tn;
    const xlen = HUFFMAN_XLEN[codes]!;
    const v = huff(br, tree(codes));
    let x = Math.floor(v / xlen);
    let y = v % xlen;
    if (lin && x === 15) x += br.read(lin.bits);
    if (x && br.bit()) x = -x;
    if (lin && y === 15) y += br.read(lin.bits);
    if (y && br.bit()) y = -y;
    out[i] = x;
    out[i + 1] = y;
  }
  const quad = tree(g.count1Table ? 33 : 32);
  while (i < 576 && br.pos < end) {
    const q = huff(br, quad);
    const vals = [(q >> 3) & 1, (q >> 2) & 1, (q >> 1) & 1, q & 1];
    for (let k = 0; k < 4; k++) if (vals[k] && br.bit()) vals[k] = -1;
    // A quadruple that runs past this granule's bits was never meant (the encoder's stuffing): drop it.
    if (br.pos > end) break;
    for (let k = 0; k < 4 && i + k < 576; k++) out[i + k] = vals[k]!;
    i += 4;
  }
  return Math.min(576, i);
}

function requantize(q: Int32Array, g: Granule, s: Scales, bands: { long: number[]; short: number[] }, lsf: boolean, xr: Float64Array): void {
  const mul = g.sfScale ? 1 : 0.5;
  const base = g.globalGain - 210;
  const deq = (v: number, exp: number): number => {
    if (!v) return 0;
    const a = v < 0 ? -v : v;
    const m = (a < POW43.length ? POW43[a]! : Math.pow(a, 4 / 3)) * Math.pow(2, exp);
    return v < 0 ? -m : m;
  };
  const longEnd = !(g.switched && g.blockType === 2) ? 576 : g.mixed ? bands.long[lsf ? 6 : 8]! : 0;
  for (let sfb = 0; sfb < 22 && bands.long[sfb]! < longEnd; sfb++) {
    const exp = 0.25 * base - mul * (s.long[sfb]! + g.preflag * PRETAB[sfb]!);
    for (let i = bands.long[sfb]!; i < Math.min(longEnd, bands.long[sfb + 1]!); i++) xr[i] = deq(q[i]!, exp);
  }
  if (longEnd >= 576) return;
  for (let sfb = g.mixed ? 3 : 0; sfb < 13; sfb++) {
    const start = bands.short[sfb]!;
    const width = bands.short[sfb + 1]! - start;
    for (let w = 0; w < 3; w++) {
      const exp = 0.25 * (base - 8 * g.subblockGain[w]!) - mul * (s.short[sfb]![w] ?? 0);
      for (let j = 0; j < width; j++) {
        const i = 3 * start + w * width + j;
        xr[i] = deq(q[i]!, exp);
      }
    }
  }
}

// ─── stereo ─────────────────────────────────────────────────────────────────

const IS_RATIO = Array.from({ length: 7 }, (_, p) => Math.tan((p * Math.PI) / 12));

/**
 * Joint stereo on one granule: intensity bands (above the right channel's last non-zero line) are rebuilt from
 * the left channel and the band's position, the rest is mid/side when the frame says so.
 */
function jointStereo(h: Header, g: Granule, sr: Scales, bands: { long: number[]; short: number[] }, L: Float64Array, R: Float64Array): void {
  let nzRight = 0;
  for (let i = 575; i >= 0; i--)
    if (R[i] !== 0) {
      nzRight = i + 1;
      break;
    }
  const ms = (h.modeExt & 2) !== 0;
  const intensity = (h.modeExt & 1) !== 0;
  const isLine = new Int8Array(576); // 1: handled by intensity
  if (intensity) {
    const apply = (i: number, pos: number, max: number | undefined, sfbLsfScale: boolean): boolean => {
      if (h.lsf) {
        if (pos === max) return false;
        const io = sfbLsfScale ? Math.SQRT1_2 : Math.pow(2, -0.25);
        const l = L[i]!;
        if (pos === 0) R[i] = l;
        else if (pos & 1) {
          L[i] = l * Math.pow(io, (pos + 1) >> 1);
          R[i] = l;
        } else R[i] = l * Math.pow(io, pos >> 1);
        return true;
      }
      if (pos >= 7) return false;
      const k = IS_RATIO[pos]!;
      const l = L[i]!;
      L[i] = (l * k) / (1 + k);
      R[i] = l / (1 + k);
      return true;
    };
    const lsfScale = (g.sfCompress & 1) === 1;
    if (g.switched && g.blockType === 2) {
      // Per window: intensity from the band after the right channel's last non-zero band in that window.
      for (let w = 0; w < 3; w++) {
        let last = -1;
        for (let sfb = g.mixed ? 3 : 0; sfb < 13; sfb++) {
          const start = bands.short[sfb]!;
          const width = bands.short[sfb + 1]! - start;
          for (let j = 0; j < width; j++) if (R[3 * start + w * width + j] !== 0) last = sfb;
        }
        for (let sfb = Math.max(last + 1, g.mixed ? 3 : 0); sfb < 13; sfb++) {
          const start = bands.short[sfb]!;
          const width = bands.short[sfb + 1]! - start;
          const band = sfb === 12 ? 11 : sfb;
          const pos = sr.short[band]![w] ?? 0;
          for (let j = 0; j < width; j++) {
            const i = 3 * start + w * width + j;
            if (apply(i, pos, sr.isMaxShort?.[band], lsfScale)) isLine[i] = 1;
          }
        }
      }
    } else {
      let sfb = 0;
      while (sfb < 22 && bands.long[sfb + 1]! <= nzRight) sfb++;
      if (bands.long[sfb]! < nzRight) sfb++;
      for (; sfb < 22; sfb++) {
        const band = sfb === 21 ? 20 : sfb;
        const pos = sr.long[band]!;
        for (let i = bands.long[sfb]!; i < bands.long[sfb + 1]!; i++) if (apply(i, pos, sr.isMaxLong?.[band], lsfScale)) isLine[i] = 1;
      }
    }
  }
  if (ms)
    for (let i = 0; i < 576; i++) {
      if (isLine[i]) continue;
      const m = L[i]!;
      const s = R[i]!;
      L[i] = (m + s) * Math.SQRT1_2;
      R[i] = (m - s) * Math.SQRT1_2;
    }
}

// ─── reorder, alias reduction, IMDCT, synthesis ─────────────────────────────

function reorder(g: Granule, bands: { long: number[]; short: number[] }, xr: Float64Array): void {
  if (!(g.switched && g.blockType === 2)) return;
  const tmp = new Float64Array(576);
  for (let sfb = g.mixed ? 3 : 0; sfb < 13; sfb++) {
    const start = bands.short[sfb]!;
    const width = bands.short[sfb + 1]! - start;
    for (let w = 0; w < 3; w++) for (let j = 0; j < width; j++) tmp[3 * start + 3 * j + w] = xr[3 * start + w * width + j]!;
  }
  const from = g.mixed ? 3 * bands.short[3]! : 0;
  for (let i = from; i < 576; i++) xr[i] = tmp[i]!;
}

const CI = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
const CS = CI.map((c) => 1 / Math.sqrt(1 + c * c));
const CA = CI.map((c) => c / Math.sqrt(1 + c * c));

function antialias(g: Granule, xr: Float64Array): void {
  if (g.switched && g.blockType === 2 && !g.mixed) return;
  const bands = g.switched && g.blockType === 2 ? 2 : 32;
  for (let sb = 1; sb < bands; sb++)
    for (let i = 0; i < 8; i++) {
      const a = xr[18 * sb - 1 - i]!;
      const b = xr[18 * sb + i]!;
      xr[18 * sb - 1 - i] = a * CS[i]! - b * CA[i]!;
      xr[18 * sb + i] = b * CS[i]! + a * CA[i]!;
    }
}

const COS36 = (() => {
  const t = new Float64Array(36 * 18);
  for (let i = 0; i < 36; i++) for (let k = 0; k < 18; k++) t[i * 18 + k] = Math.cos((Math.PI / 72) * (2 * i + 1 + 18) * (2 * k + 1));
  return t;
})();
const COS12 = (() => {
  const t = new Float64Array(12 * 6);
  for (let i = 0; i < 12; i++) for (let k = 0; k < 6; k++) t[i * 6 + k] = Math.cos((Math.PI / 24) * (2 * i + 1 + 6) * (2 * k + 1));
  return t;
})();
/** The long block windows by block type (0 normal, 1 start, 3 stop) and the short window. */
const WINDOWS = (() => {
  const w = [new Float64Array(36), new Float64Array(36), new Float64Array(36), new Float64Array(36)];
  for (let i = 0; i < 36; i++) w[0]![i] = Math.sin((Math.PI / 36) * (i + 0.5));
  for (let i = 0; i < 18; i++) w[1]![i] = Math.sin((Math.PI / 36) * (i + 0.5));
  for (let i = 18; i < 24; i++) w[1]![i] = 1;
  for (let i = 24; i < 30; i++) w[1]![i] = Math.sin((Math.PI / 12) * (i - 18 + 0.5));
  for (let i = 6; i < 12; i++) w[3]![i] = Math.sin((Math.PI / 12) * (i - 6 + 0.5));
  for (let i = 12; i < 18; i++) w[3]![i] = 1;
  for (let i = 18; i < 36; i++) w[3]![i] = Math.sin((Math.PI / 36) * (i + 0.5));
  for (let i = 0; i < 12; i++) w[2]![i] = Math.sin((Math.PI / 12) * (i + 0.5));
  return w;
})();

/** IMDCT and overlap-add of one granule: xr (576 lines) becomes 18 time samples per subband, in place. */
function hybrid(g: Granule, xr: Float64Array, overlap: Float64Array): void {
  const z = new Float64Array(36);
  for (let sb = 0; sb < 32; sb++) {
    const type = g.switched && g.mixed && sb < 2 ? 0 : g.blockType;
    const o = sb * 18;
    z.fill(0);
    if (type === 2) {
      const win = WINDOWS[2]!;
      for (let w = 0; w < 3; w++)
        for (let i = 0; i < 12; i++) {
          let s = 0;
          for (let k = 0; k < 6; k++) s += xr[o + 3 * k + w]! * COS12[i * 6 + k]!;
          z[6 + 6 * w + i]! += s * win[i]!;
        }
    } else {
      const win = WINDOWS[type]!;
      for (let i = 0; i < 36; i++) {
        let s = 0;
        for (let k = 0; k < 18; k++) s += xr[o + k]! * COS36[i * 18 + k]!;
        z[i] = s * win[i]!;
      }
    }
    for (let i = 0; i < 18; i++) {
      xr[o + i] = z[i]! + overlap[o + i]!;
      overlap[o + i] = z[18 + i]!;
    }
  }
  // Frequency inversion: every odd time sample of every odd subband changes sign.
  for (let sb = 1; sb < 32; sb += 2) for (let ts = 1; ts < 18; ts += 2) xr[sb * 18 + ts] = -xr[sb * 18 + ts]!;
}

const MATRIX = (() => {
  const t = new Float64Array(64 * 32);
  for (let i = 0; i < 64; i++) for (let k = 0; k < 32; k++) t[i * 32 + k] = Math.cos(((16 + i) * (2 * k + 1) * Math.PI) / 64);
  return t;
})();
const WINDOW = Float64Array.from(SYNTH_WINDOW, (v) => v / 65536);

/** The polyphase synthesis filterbank of one channel. */
class Synth {
  private readonly v = new Float64Array(1024);
  private off = 0;
  /** 18 slots of 32 subband samples (xr after hybrid(): subband-major) → 576 PCM samples at out[at...]. */
  run(xr: Float64Array, out: Float32Array, at: number): void {
    const v = this.v;
    for (let ts = 0; ts < 18; ts++) {
      this.off = (this.off - 64) & 1023;
      const off = this.off;
      for (let i = 0; i < 64; i++) {
        let s = 0;
        const row = i * 32;
        for (let k = 0; k < 32; k++) s += MATRIX[row + k]! * xr[k * 18 + ts]!;
        v[(off + i) & 1023] = s;
      }
      for (let j = 0; j < 32; j++) {
        let s = 0;
        for (let i = 0; i < 8; i++) {
          s += WINDOW[j + 64 * i]! * v[(off + 128 * i + j) & 1023]!;
          s += WINDOW[j + 64 * i + 32]! * v[(off + 128 * i + 96 + j) & 1023]!;
        }
        const k = at + ts * 32 + j;
        if (k < out.length) out[k] = s;
      }
    }
  }
}

// ─── the gapless tag ────────────────────────────────────────────────────────

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));

/** A Xing/Info frame (not audio) and, when it has a LAME tag, the encoder delay and padding it records. */
function xingTag(b: Uint8Array, at: number, h: Header): { frames: number | null; delay: number; padding: number } | null {
  const side = h.lsf ? (h.channels === 1 ? 9 : 17) : h.channels === 1 ? 17 : 32;
  let p = at + 4 + (h.crc ? 2 : 0) + side;
  const id = ascii(b, p, 4);
  if (id !== 'Xing' && id !== 'Info') return ascii(b, at + 36, 4) === 'VBRI' ? { frames: null, delay: -1, padding: 0 } : null;
  const flags = ((b[p + 4]! << 24) | (b[p + 5]! << 16) | (b[p + 6]! << 8) | b[p + 7]!) >>> 0;
  p += 8;
  let frames: number | null = null;
  if (flags & 1) {
    frames = ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
    p += 4;
  }
  if (flags & 2) p += 4;
  if (flags & 4) p += 100;
  if (flags & 8) p += 4;
  // The LAME extension: a 9-byte encoder name, then at byte 21 the delay and padding (12 bits each).
  const enc = ascii(b, p, 4);
  if ((enc === 'LAME' || enc === 'Lavc' || enc === 'Lavf' || enc === 'L3.9') && p + 24 <= at + h.length) {
    const d0 = b[p + 21]!;
    const d1 = b[p + 22]!;
    const d2 = b[p + 23]!;
    return { frames, delay: (d0 << 4) | (d1 >> 4), padding: ((d1 & 15) << 8) | d2 };
  }
  return { frames, delay: -1, padding: 0 };
}

/** The decoder's own delay: the synthesis filterbank and the IMDCT overlap. */
const DECODER_DELAY = 529;

// ─── the decoder ────────────────────────────────────────────────────────────

/** Decodes an MP3 file to PCM at its own sample rate (at most `maxSeconds` of it). */
export function decodeMp3(bytes: Uint8Array, opts: { maxSeconds?: number } = {}): Mp3Decoded {
  let at = firstFrame(bytes);
  if (at < 0) return { ok: false, error: 'not a readable MP3 (no Layer III frames found)' };
  const first = header(bytes, at)!;
  const nch = first.channels;
  const rate = first.sampleRate;
  const bands = SFB_BANDS[rate]!;
  const perFrame = first.lsf ? 576 : 1152;
  const limit = Math.ceil((opts.maxSeconds ?? 600) * rate) + DECODER_DELAY + 4096;
  const tag = xingTag(bytes, at, first);
  if (tag) at += first.length;
  const outs = Array.from({ length: nch }, () => new Float32Array(Math.min(limit, perFrame * 64)));
  let written = 0;
  const grow = (need: number) => {
    if (need <= outs[0]!.length) return;
    const size = Math.min(limit, Math.max(need, outs[0]!.length * 2));
    for (let c = 0; c < nch; c++) {
      const next = new Float32Array(size);
      next.set(outs[c]!);
      outs[c] = next;
    }
  };
  const synth = Array.from({ length: nch }, () => new Synth());
  const overlap = Array.from({ length: nch }, () => new Float64Array(576));
  let reservoir = new Uint8Array(0);
  const q = new Int32Array(576);
  const xr = Array.from({ length: nch }, () => new Float64Array(576));
  let frames = 0;
  let scfsiPrev: Scales[] = [];
  while (at >= 0 && at + 4 <= bytes.length && written < limit) {
    const h = header(bytes, at);
    if (!h || h.sampleRate !== rate || h.channels !== nch) {
      at = resync(bytes, at + 1, first);
      continue;
    }
    const end = Math.min(bytes.length, at + h.length);
    const sideStart = at + 4 + (h.crc ? 2 : 0);
    const sideLen = h.lsf ? (nch === 1 ? 9 : 17) : nch === 1 ? 17 : 32;
    if (sideStart + sideLen > end) break;
    const si = sideInfo(bytes.subarray(sideStart, sideStart + sideLen), h);
    const main = bytes.subarray(sideStart + sideLen, end);
    const granules = h.lsf ? 1 : 2;
    grow(written + granules * 576);
    if (reservoir.length >= si.mainDataBegin) {
      const data = new Uint8Array(si.mainDataBegin + main.length + 8);
      data.set(reservoir.subarray(reservoir.length - si.mainDataBegin), 0);
      data.set(main, si.mainDataBegin);
      const br = new Bits(data);
      try {
        for (let gi = 0; gi < granules; gi++) {
          const scales: Scales[] = [];
          for (let ch = 0; ch < nch; ch++) {
            const g = si.gr[gi]![ch]!;
            const start = br.pos;
            const s = h.lsf ? scalesLsf(br, g, ch === 1 && (h.modeExt & 1) !== 0 && h.mode === 1) : scalesMpeg1(br, g, si.scfsi[ch]!, gi, scfsiPrev[ch] ?? null);
            scales.push(s);
            huffmanData(br, g, start + g.part23, bands, q);
            br.pos = start + g.part23;
            xr[ch]!.fill(0);
            requantize(q, g, s, bands, h.lsf, xr[ch]!);
          }
          if (!h.lsf) scfsiPrev = scales;
          // Intensity positions are the right channel's scale factors, laid out by its block type.
          if (nch === 2 && h.mode === 1) jointStereo(h, si.gr[gi]![1]!, scales[1]!, bands, xr[0]!, xr[1]!);
          for (let ch = 0; ch < nch; ch++) {
            const g = si.gr[gi]![ch]!;
            reorder(g, bands, xr[ch]!);
            antialias(g, xr[ch]!);
            hybrid(g, xr[ch]!, overlap[ch]!);
            synth[ch]!.run(xr[ch]!, outs[ch]!, written + gi * 576);
          }
        }
      } catch {
        // A damaged frame plays as silence; the stream goes on.
      }
    }
    written += granules * 576;
    frames++;
    // The bit reservoir: a later frame's data may start in this frame's bytes (at most 511 bytes back).
    const joined = new Uint8Array(reservoir.length + main.length);
    joined.set(reservoir, 0);
    joined.set(main, reservoir.length);
    reservoir = joined.length > 2048 ? joined.slice(joined.length - 2048) : joined;
    at += h.length;
  }
  if (!frames) return { ok: false, error: 'not a readable MP3 (no frame decoded)' };
  // Gapless: skip the encoder's delay and the decoder's, and the padding at the end, when the tag says how much.
  const gapless = !!tag && tag.delay >= 0;
  const start = gapless ? tag!.delay + DECODER_DELAY : DECODER_DELAY;
  let total = written - start;
  if (gapless) total = Math.min(total, (tag!.frames ?? frames) * perFrame - tag!.delay - tag!.padding);
  if (opts.maxSeconds !== undefined) total = Math.min(total, Math.ceil(opts.maxSeconds * rate));
  total = Math.max(0, Math.min(total, written - start));
  return { ok: true, sampleRate: rate, channels: outs.map((o) => o.slice(start, start + total)), frames, gapless };
}
