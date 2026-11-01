import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { estimateText, type Measure, type UiNode } from '@shared/ui-layout';
import type { Glyph, Pt } from '../ui-fonts';
import { CffTable } from './cff';

/**
 * Roblox's own fonts, read from the Studio install (content\fonts: TrueType and CFF faces, families\*.json naming
 * each family's faces), so the UI Lab draws and measures text in the faces Roblox draws with instead of Windows
 * stand-ins. A node's font (an Enum.Font name, a FontFace family, a FontFace string) and bold/italic/weight pick a
 * face the way Font.fromEnum and Roblox's family JSON do; faces that only exist as cloud assets fall back to
 * Studio's own copy (StudioFonts) or the nearest local weight, flagged `exact: false`. Roblox sizes a font so its
 * ascender−descender spans the TextSize (1.5× for Legacy), not its em; a line's width is the glyph advances plus pair
 * kerning (GPOS 'kern', else the legacy kern table) on a whole-pixel pen (PIXEL_BIAS): fitted to 736 TextBounds read
 * in Studio, monospaced faces exact, the rest about 2 px off on average (pinned in `tests/ui-lab-fonts.test.ts`).
 * Missing characters fall back through the install's fonts (Roblox's emoji and Noto script faces, CJK).
 *
 * Enum.Font → family + weight comes from RobloxStudioBeta.exe's own tables (the family json per Enum.Font in enum
 * order, and the legacy Enum.Font → file list: Gotham* → Montserrat-*.ttf, Arial/Legacy → Arimo-*.ttf); the
 * GothamSSm and Arial families have no json on disk and are redirected there (GothamSSm → Montserrat,
 * Arial → LegacyArimo), as the exe's remap pairs say.
 */

// ─── Finding the install ─────────────────────────────────────────────────────────────────────────

export interface RobloxFontInstall {
  /** content\fonts (font files) */
  fonts: string;
  /** content\fonts\families (one json per family) */
  families: string;
  /** Studio's own UI fonts (more BuilderSans and SourceSansPro weights than content\fonts has), when present. */
  studioFonts: string | null;
  /** PlatformContent\pc\fonts (the CJK fallback), when present. */
  platformFonts: string | null;
  /** "version-…" when found under Roblox\Versions. */
  version: string | null;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function installAt(fonts: string, version: string | null): RobloxFontInstall | null {
  const families = join(fonts, 'families');
  if (!isDir(families)) return null;
  // content\fonts sits two levels under the version folder.
  const root = join(fonts, '..', '..');
  const studio = join(root, 'StudioFonts');
  const platform = join(root, 'PlatformContent', 'pc', 'fonts');
  return { fonts, families, studioFonts: isDir(studio) ? studio : null, platformFonts: isDir(platform) ? platform : null, version };
}

/**
 * Roblox's fonts folder: `SHURIKEN_ROBLOX_FONTS` (a content\fonts folder or a version folder) first, else the newest
 * `%LOCALAPPDATA%\Roblox\Versions\version-*` that has RobloxStudioBeta.exe and content\fonts\families. Null when
 * there is none (not Windows, Studio not installed).
 */
export function findRobloxFonts(env: NodeJS.ProcessEnv = process.env): RobloxFontInstall | null {
  const override = env.SHURIKEN_ROBLOX_FONTS;
  if (override) return installAt(override, null) ?? installAt(join(override, 'content', 'fonts'), basename(override).startsWith('version-') ? basename(override) : null);
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const versions = join(local, 'Roblox', 'Versions');
  let best: { at: number; dir: string; name: string } | null = null;
  try {
    for (const name of readdirSync(versions)) {
      if (!name.startsWith('version-')) continue;
      const dir = join(versions, name);
      const exe = join(dir, 'RobloxStudioBeta.exe');
      if (!existsSync(exe) || !isDir(join(dir, 'content', 'fonts', 'families'))) continue;
      const at = statSync(exe).mtimeMs;
      if (!best || at > best.at) best = { at, dir, name };
    }
  } catch {
    return null;
  }
  return best ? installAt(join(best.dir, 'content', 'fonts'), best.name) : null;
}

// ─── Reading a font file ─────────────────────────────────────────────────────────────────────────

const tagAt = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * One font file (TrueType glyf or OpenType CFF; a .ttc's first font): cmap 4/12, hmtx advances, outlines flattened
 * to straight segments in font units (y up; cached), GPOS pair kerning (formats 1 and 2, through Extension
 * lookups, the 'kern' feature of the Latin or default script) else the legacy kern table, and COLR v0 emoji
 * (their layers' outlines merged: the shape, not the colours).
 */
export class OpenTypeFont {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  /** OS/2 cap and x heights (font units), when the font has them. */
  readonly capHeight: number | null;
  readonly xHeight: number | null;
  readonly numGlyphs: number;
  /** head.flags (bit 3: the hinter scales by a whole number of pixels per em). */
  readonly headFlags: number;
  readonly outlines: 'truetype' | 'cff';
  /** Where its kerning comes from. */
  readonly kerning: 'gpos' | 'kern' | 'none';
  private readonly b: Uint8Array;
  private readonly v: DataView;
  private readonly tables = new Map<string, { offset: number; length: number }>();
  private readonly numHMetrics: number;
  private readonly locShort: boolean;
  private readonly cmap: (cp: number) => number;
  private readonly cff: CffTable | null = null;
  private readonly glyphs = new Map<number, Glyph>();
  private readonly gids = new Map<number, number>();
  private readonly pairs = new Map<number, number>();
  private readonly kernLookups: number[] = [];
  private readonly legacyKern: Array<{ at: number; n: number }> = [];
  private readonly colr: Map<number, Array<[gid: number, palette: number]>> | null = null;

  constructor(
    buf: Uint8Array,
    /** The file's name ("BuilderSans-Bold.otf"). */
    readonly name: string,
    /** Its full path. */
    readonly file = name,
  ) {
    this.b = buf;
    this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const v = this.v;
    let base = 0;
    if (tagAt(buf, 0) === 'ttcf') base = v.getUint32(12);
    const tag = v.getUint32(base);
    if (tag !== 0x00010000 && tag !== 0x74727565 && tag !== 0x4f54544f) throw new Error(`${name}: not an OpenType font`);
    const n = v.getUint16(base + 4);
    for (let i = 0; i < n; i++) {
      const at = base + 12 + i * 16;
      this.tables.set(tagAt(buf, at), { offset: v.getUint32(at + 8), length: v.getUint32(at + 12) });
    }
    for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap']) if (!this.tables.has(t)) throw new Error(`${name}: no ${t} table`);
    const head = this.table('head');
    this.unitsPerEm = v.getUint16(head + 18) || 1000;
    this.headFlags = v.getUint16(head + 16);
    this.locShort = v.getInt16(head + 50) === 0;
    const hhea = this.table('hhea');
    this.ascender = v.getInt16(hhea + 4);
    this.descender = v.getInt16(hhea + 6);
    this.lineGap = v.getInt16(hhea + 8);
    this.numHMetrics = Math.max(1, v.getUint16(hhea + 34));
    this.numGlyphs = v.getUint16(this.table('maxp') + 4);
    const os2 = this.tables.get('OS/2');
    const os2Version = os2 && os2.length >= 2 ? v.getUint16(os2.offset) : -1;
    this.capHeight = os2 && os2Version >= 2 && os2.length >= 90 ? v.getInt16(os2.offset + 88) : null;
    this.xHeight = os2 && os2Version >= 2 && os2.length >= 88 ? v.getInt16(os2.offset + 86) : null;
    this.cmap = this.readCmap();
    if (this.tables.has('glyf') && this.tables.has('loca')) this.outlines = 'truetype';
    else if (this.tables.has('CFF ')) {
      this.outlines = 'cff';
      const t = this.tables.get('CFF ')!;
      this.cff = new CffTable(buf.subarray(t.offset, t.offset + t.length), this.unitsPerEm);
    } else throw new Error(`${name}: no glyf or CFF outlines`);
    this.readGposKerning();
    if (!this.kernLookups.length) this.readLegacyKern();
    this.kerning = this.kernLookups.length ? 'gpos' : this.legacyKern.length ? 'kern' : 'none';
    if (this.tables.has('COLR')) this.colr = this.readColr();
  }

  private table(t: string): number {
    return this.tables.get(t)!.offset;
  }

  hasTable(t: string): boolean {
    return this.tables.has(t);
  }

  /** The glyph index of a code point (0: the font has none). */
  gid(cp: number): number {
    let g = this.gids.get(cp);
    if (g === undefined) {
      g = this.cmap(cp);
      this.gids.set(cp, g);
    }
    return g;
  }

  has(cp: number): boolean {
    return this.gid(cp) !== 0;
  }

  advanceOf(gid: number): number {
    const hmtx = this.table('hmtx');
    return this.v.getUint16(hmtx + Math.min(gid, this.numHMetrics - 1) * 4);
  }

  /** A character's advance in font units (the .notdef's when it has none). */
  advance(cp: number): number {
    return this.advanceOf(this.gid(cp));
  }

  /** A character's glyph (the font's .notdef when it has none). */
  glyph(cp: number): Glyph {
    return this.glyphById(this.gid(cp));
  }

  glyphById(gid: number): Glyph {
    const hit = this.glyphs.get(gid);
    if (hit) return hit;
    const step = this.unitsPerEm / 40;
    let contours: Pt[][];
    const layers = this.colr?.get(gid);
    if (layers) contours = layers.flatMap(([lg]) => this.outlineOf(lg, step));
    else contours = this.outlineOf(gid, step);
    const g: Glyph = { contours, advance: this.advanceOf(gid) };
    this.glyphs.set(gid, g);
    return g;
  }

  private outlineOf(gid: number, step: number): Pt[][] {
    if (gid < 0 || gid >= this.numGlyphs) return [];
    if (this.cff) return this.cff.glyph(gid, step).contours;
    return this.ttOutline(gid, 0, step);
  }

  /** The width a CFF charstring carries (to check against hmtx); null for TrueType. */
  charstringWidth(gid: number): number | null {
    return this.cff ? this.cff.glyph(gid, this.unitsPerEm / 40).width : null;
  }

  // ── cmap ──

  private readCmap(): (cp: number) => number {
    const base = this.table('cmap');
    const v = this.v;
    const count = v.getUint16(base + 2);
    let f4 = -1;
    let f12 = -1;
    let symbol = false;
    for (let i = 0; i < count; i++) {
      const platform = v.getUint16(base + 4 + i * 8);
      const encoding = v.getUint16(base + 6 + i * 8);
      const off = base + v.getUint32(base + 8 + i * 8);
      const format = v.getUint16(off);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (format === 12 && unicode && f12 < 0) f12 = off;
      else if (format === 4 && (unicode || (platform === 3 && encoding === 0)) && (f4 < 0 || symbol)) {
        symbol = platform === 3 && encoding === 0;
        f4 = off;
      }
    }
    if (f12 >= 0) {
      const groups = v.getUint32(f12 + 12);
      return (cp) => {
        let lo = 0;
        let hi = groups - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const g = f12 + 16 + mid * 12;
          if (cp < v.getUint32(g)) hi = mid - 1;
          else if (cp > v.getUint32(g + 4)) lo = mid + 1;
          else return v.getUint32(g + 8) + (cp - v.getUint32(g));
        }
        return 0;
      };
    }
    if (f4 >= 0) {
      const segX2 = v.getUint16(f4 + 6);
      const segs = segX2 / 2;
      const ends = f4 + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      const lookup = (cp: number) => {
        if (cp > 0xffff) return 0;
        // First segment whose end is at or past cp.
        let lo = 0;
        let hi = segs - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (v.getUint16(ends + mid * 2) < cp) lo = mid + 1;
          else hi = mid;
        }
        const i = lo * 2;
        if (cp > v.getUint16(ends + i)) return 0;
        const start = v.getUint16(starts + i);
        if (cp < start) return 0;
        const delta = v.getInt16(deltas + i);
        const range = v.getUint16(ranges + i);
        if (!range) return (cp + delta) & 0xffff;
        const g = v.getUint16(ranges + i + range + (cp - start) * 2);
        return g ? (g + delta) & 0xffff : 0;
      };
      // A symbol font maps its characters at U+F000.
      return symbol ? (cp) => lookup(cp) || (cp < 0x100 ? lookup(0xf000 + cp) : 0) : lookup;
    }
    return () => 0;
  }

  // ── TrueType outlines ──

  private ttOutline(gid: number, depth: number, step: number): Pt[][] {
    if (gid >= this.numGlyphs || depth > 6) return [];
    const loca = this.table('loca');
    const v = this.v;
    const at = (i: number) => (this.locShort ? v.getUint16(loca + i * 2) * 2 : v.getUint32(loca + i * 4));
    const start = at(gid);
    const end = at(gid + 1);
    if (end <= start) return [];
    const g = this.table('glyf') + start;
    const contoursCount = v.getInt16(g);
    if (contoursCount < 0) return this.ttComposite(g + 10, depth, step);
    const ends: number[] = [];
    for (let i = 0; i < contoursCount; i++) ends.push(v.getUint16(g + 10 + i * 2));
    const points = (ends[ends.length - 1] ?? -1) + 1;
    let p = g + 10 + contoursCount * 2;
    p += 2 + v.getUint16(p);
    const flags = new Uint8Array(points);
    for (let i = 0; i < points; ) {
      const f = v.getUint8(p++);
      flags[i++] = f;
      if (f & 8) {
        const r = v.getUint8(p++);
        for (let k = 0; k < r && i < points; k++) flags[i++] = f;
      }
    }
    const xs = new Float64Array(points);
    let x = 0;
    for (let i = 0; i < points; i++) {
      const f = flags[i]!;
      if (f & 2) {
        const d = v.getUint8(p++);
        x += f & 16 ? d : -d;
      } else if (!(f & 16)) {
        x += v.getInt16(p);
        p += 2;
      }
      xs[i] = x;
    }
    const ys = new Float64Array(points);
    let y = 0;
    for (let i = 0; i < points; i++) {
      const f = flags[i]!;
      if (f & 4) {
        const d = v.getUint8(p++);
        y += f & 32 ? d : -d;
      } else if (!(f & 32)) {
        y += v.getInt16(p);
        p += 2;
      }
      ys[i] = y;
    }
    const out: Pt[][] = [];
    let first = 0;
    for (const last of ends) {
      const pts: Array<{ x: number; y: number; on: boolean }> = [];
      for (let i = first; i <= last; i++) pts.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) === 1 });
      first = last + 1;
      if (pts.length > 2) {
        const c = flattenQuad(pts, step);
        if (c.length > 2) out.push(c);
      }
    }
    return out;
  }

  private ttComposite(p: number, depth: number, step: number): Pt[][] {
    const v = this.v;
    const out: Pt[][] = [];
    for (;;) {
      const flags = v.getUint16(p);
      const gid = v.getUint16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (flags & 1) {
        dx = flags & 2 ? v.getInt16(p) : v.getUint16(p);
        dy = flags & 2 ? v.getInt16(p + 2) : v.getUint16(p + 2);
        p += 4;
      } else {
        dx = flags & 2 ? v.getInt8(p) : v.getUint8(p);
        dy = flags & 2 ? v.getInt8(p + 1) : v.getUint8(p + 1);
        p += 2;
      }
      if (!(flags & 2)) dx = dy = 0; // point matching: rare in UI fonts
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2 = (o: number) => v.getInt16(o) / 16384;
      if (flags & 8) {
        a = d = f2(p);
        p += 2;
      } else if (flags & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (flags & 0x80) {
        [a, b, c, d] = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)];
        p += 8;
      }
      for (const contour of this.ttOutline(gid, depth + 1, step)) out.push(contour.map(([x, y]) => [x * a + y * c + dx, x * b + y * d + dy] as Pt));
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  // ── COLR (emoji): base glyph → layers ──

  private readColr(): Map<number, Array<[number, number]>> {
    const v = this.v;
    const t = this.table('COLR');
    const out = new Map<number, Array<[number, number]>>();
    const numBase = v.getUint16(t + 2);
    const baseOff = t + v.getUint32(t + 4);
    const layerOff = t + v.getUint32(t + 8);
    for (let i = 0; i < numBase; i++) {
      const r = baseOff + i * 6;
      const gid = v.getUint16(r);
      const first = v.getUint16(r + 2);
      const n = v.getUint16(r + 4);
      const layers: Array<[number, number]> = [];
      for (let k = 0; k < n; k++) layers.push([v.getUint16(layerOff + (first + k) * 4), v.getUint16(layerOff + (first + k) * 4 + 2)]);
      out.set(gid, layers);
    }
    return out;
  }

  // ── Kerning ──

  /** Pair kerning between two characters, font units (0 when either is missing or the pair isn't kerned). */
  kern(left: number, right: number): number {
    return this.kernGids(this.gid(left), this.gid(right));
  }

  kernGids(a: number, b: number): number {
    if (!a || !b || this.kerning === 'none') return 0;
    const key = a * 65536 + b;
    let k = this.pairs.get(key);
    if (k === undefined) {
      k = this.kerning === 'gpos' ? this.gposPair(a, b) : this.legacyPair(a, b);
      this.pairs.set(key, k);
    }
    return k;
  }

  private readGposKerning(): void {
    const t = this.tables.get('GPOS');
    if (!t) return;
    const v = this.v;
    const g = t.offset;
    try {
      const scripts = g + v.getUint16(g + 4);
      const features = g + v.getUint16(g + 6);
      const featureCount = v.getUint16(features);
      const kernFeature = (i: number) => i < featureCount && tagAt(this.b, features + 2 + i * 6) === 'kern';
      const lookupsOf = (i: number) => {
        const f = features + v.getUint16(features + 2 + i * 6 + 4);
        const n = v.getUint16(f + 2);
        const out: number[] = [];
        for (let k = 0; k < n; k++) out.push(v.getUint16(f + 4 + k * 2));
        return out;
      };
      // The Latin script's default language (else DFLT, else the first script), as a shaper picks for Latin text.
      const scriptCount = v.getUint16(scripts);
      const found = new Map<string, number>();
      for (let i = 0; i < scriptCount; i++) found.set(tagAt(this.b, scripts + 2 + i * 6), scripts + v.getUint16(scripts + 2 + i * 6 + 4));
      const script = found.get('latn') ?? found.get('DFLT') ?? [...found.values()][0];
      const picked = new Set<number>();
      if (script !== undefined) {
        let langSys = v.getUint16(script) ? script + v.getUint16(script) : 0;
        if (!langSys && v.getUint16(script + 2)) langSys = script + v.getUint16(script + 8);
        if (langSys) {
          const n = v.getUint16(langSys + 4);
          for (let k = 0; k < n; k++) {
            const fi = v.getUint16(langSys + 6 + k * 2);
            if (kernFeature(fi)) for (const l of lookupsOf(fi)) picked.add(l);
          }
        }
      }
      if (!picked.size) for (let i = 0; i < featureCount; i++) if (kernFeature(i)) for (const l of lookupsOf(i)) picked.add(l);
      this.kernLookups.push(...[...picked].sort((a, b) => a - b));
    } catch {
      this.kernLookups.length = 0;
    }
  }

  /** The pair adjustment the 'kern' lookups give (each lookup's first applicable subtable). */
  private gposPair(a: number, b: number): number {
    const v = this.v;
    const g = this.table('GPOS');
    const list = g + v.getUint16(g + 8);
    let total = 0;
    for (const li of this.kernLookups) {
      const lk = list + v.getUint16(list + 2 + li * 2);
      const type = v.getUint16(lk);
      const n = v.getUint16(lk + 4);
      for (let s = 0; s < n; s++) {
        let st = lk + v.getUint16(lk + 6 + s * 2);
        if (type === 9) {
          // Extension: the real subtable sits behind a 32-bit offset.
          const ext = v.getUint16(st + 2);
          st = st + v.getUint32(st + 4);
          if (ext !== 2) continue;
        } else if (type !== 2) break;
        const r = this.pairPos(st, a, b);
        if (r !== null) {
          total += r;
          break;
        }
      }
    }
    return total;
  }

  /** A PairPos subtable's x-advance adjustment for (a, b): null when it doesn't apply (next subtable). */
  private pairPos(st: number, a: number, b: number): number | null {
    const v = this.v;
    const format = v.getUint16(st);
    const ci = coverageIndex(v, st + v.getUint16(st + 2), a);
    if (ci < 0) return null;
    const vf1 = v.getUint16(st + 4);
    const vf2 = v.getUint16(st + 6);
    const size1 = valueSize(vf1);
    const size2 = valueSize(vf2);
    const xAdv = (rec: number, vf: number) => (vf & 4 ? v.getInt16(rec + 2 * popcount(vf & 3)) : 0);
    if (format === 1) {
      const sets = v.getUint16(st + 8);
      if (ci >= sets) return null;
      const set = st + v.getUint16(st + 10 + ci * 2);
      const count = v.getUint16(set);
      const rec = 2 + size1 + size2;
      let lo = 0;
      let hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const at = set + 2 + mid * rec;
        const second = v.getUint16(at);
        if (b < second) hi = mid - 1;
        else if (b > second) lo = mid + 1;
        else return xAdv(at + 2, vf1) + xAdv(at + 2 + size1, vf2);
      }
      return null;
    }
    if (format === 2) {
      const c1 = classOf(v, st + v.getUint16(st + 8), a);
      const c2 = classOf(v, st + v.getUint16(st + 10), b);
      const n1 = v.getUint16(st + 12);
      const n2 = v.getUint16(st + 14);
      if (c1 >= n1 || c2 >= n2) return null;
      const at = st + 16 + (c1 * n2 + c2) * (size1 + size2);
      return xAdv(at, vf1) + xAdv(at + size1, vf2);
    }
    return null;
  }

  private readLegacyKern(): void {
    const t = this.tables.get('kern');
    if (!t) return;
    const v = this.v;
    try {
      const apple = v.getUint16(t.offset) === 1;
      const n = apple ? v.getUint32(t.offset + 4) : v.getUint16(t.offset + 2);
      let p = t.offset + (apple ? 8 : 4);
      for (let i = 0; i < n && p < t.offset + t.length; i++) {
        if (apple) {
          const length = v.getUint32(p);
          const coverage = v.getUint16(p + 4);
          if ((coverage & 0xff) === 0 && !(coverage & 0xc000)) this.legacyKern.push({ at: p + 8 + 8, n: v.getUint16(p + 8) });
          p += length;
        } else {
          const length = v.getUint16(p + 2);
          const coverage = v.getUint16(p + 4);
          const nPairs = v.getUint16(p + 6);
          // Format 0, horizontal, not cross-stream.
          if (coverage >> 8 === 0 && coverage & 1 && !(coverage & 4)) this.legacyKern.push({ at: p + 14, n: nPairs });
          // Some fonts overflow the 16-bit length: walk by pair count instead.
          p += coverage >> 8 === 0 ? 14 + nPairs * 6 : length;
        }
      }
    } catch {
      this.legacyKern.length = 0;
    }
  }

  private legacyPair(a: number, b: number): number {
    const v = this.v;
    const key = a * 65536 + b;
    let total = 0;
    for (const s of this.legacyKern) {
      let lo = 0;
      let hi = s.n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const at = s.at + mid * 6;
        const k = v.getUint16(at) * 65536 + v.getUint16(at + 2);
        if (key < k) hi = mid - 1;
        else if (key > k) lo = mid + 1;
        else {
          total += v.getInt16(at + 4);
          break;
        }
      }
    }
    return total;
  }
}

function popcount(x: number): number {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}
const valueSize = (vf: number) => 2 * popcount(vf & 0xff);

function coverageIndex(v: DataView, c: number, gid: number): number {
  const format = v.getUint16(c);
  const n = v.getUint16(c + 2);
  let lo = 0;
  let hi = n - 1;
  if (format === 1) {
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = v.getUint16(c + 4 + mid * 2);
      if (gid < g) hi = mid - 1;
      else if (gid > g) lo = mid + 1;
      else return mid;
    }
    return -1;
  }
  if (format === 2) {
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = c + 4 + mid * 6;
      if (gid < v.getUint16(r)) hi = mid - 1;
      else if (gid > v.getUint16(r + 2)) lo = mid + 1;
      else return v.getUint16(r + 4) + gid - v.getUint16(r);
    }
  }
  return -1;
}

function classOf(v: DataView, c: number, gid: number): number {
  const format = v.getUint16(c);
  if (format === 1) {
    const start = v.getUint16(c + 2);
    const n = v.getUint16(c + 4);
    return gid >= start && gid < start + n ? v.getUint16(c + 6 + (gid - start) * 2) : 0;
  }
  if (format === 2) {
    let lo = 0;
    let hi = v.getUint16(c + 2) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = c + 4 + mid * 6;
      if (gid < v.getUint16(r)) hi = mid - 1;
      else if (gid > v.getUint16(r + 2)) lo = mid + 1;
      else return v.getUint16(r + 4);
    }
  }
  return 0;
}

/** A TrueType contour (on- and off-curve points, quadratic) as straight segments. */
function flattenQuad(pts: Array<{ x: number; y: number; on: boolean }>, step: number): Pt[] {
  const s = pts.findIndex((q) => q.on);
  const ring = s < 0 ? [{ x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2, on: true }, ...pts] : [...pts.slice(s), ...pts.slice(0, s)];
  const out: Pt[] = [[ring[0]!.x, ring[0]!.y]];
  let prev = ring[0]!;
  let ctrl: { x: number; y: number } | null = null;
  const curve = (c: { x: number; y: number }, e: { x: number; y: number }) => {
    const len = Math.hypot(c.x - prev.x, c.y - prev.y) + Math.hypot(e.x - c.x, e.y - c.y);
    const n = Math.max(2, Math.min(16, Math.ceil(len / step)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      out.push([u * u * prev.x + 2 * u * t * c.x + t * t * e.x, u * u * prev.y + 2 * u * t * c.y + t * t * e.y]);
    }
  };
  for (let i = 1; i <= ring.length; i++) {
    const q = ring[i % ring.length]!;
    if (q.on) {
      if (ctrl) curve(ctrl, q);
      else out.push([q.x, q.y]);
      prev = q;
      ctrl = null;
    } else if (ctrl) {
      const mid = { x: (ctrl.x + q.x) / 2, y: (ctrl.y + q.y) / 2, on: true };
      curve(ctrl, mid);
      prev = mid;
      ctrl = q;
    } else ctrl = q;
  }
  out.pop(); // back at the start
  return out;
}

const fileCache = new Map<string, OpenTypeFont | null>();

/** A font file (cached; null when it can't be read or parsed). */
export function loadFont(path: string): OpenTypeFont | null {
  if (fileCache.has(path)) return fileCache.get(path)!;
  let f: OpenTypeFont | null = null;
  try {
    f = new OpenTypeFont(readFileSync(path), basename(path), path);
  } catch {
    f = null;
  }
  fileCache.set(path, f);
  return f;
}

// ─── Roblox fonts → families, weights and styles ─────────────────────────────────────────────────

export type FontStyleName = 'normal' | 'italic';

/**
 * Every Enum.Font and the FontFace Font.fromEnum gives it (family json name, weight, style), from the exe's enum-order
 * family table. GothamSemibold is GothamMedium's old name.
 */
export const ENUM_FONTS: Record<string, { family: string; weight: number; style?: 'italic' }> = {
  Legacy: { family: 'LegacyArial', weight: 400 },
  Arial: { family: 'Arial', weight: 400 },
  ArialBold: { family: 'Arial', weight: 700 },
  SourceSans: { family: 'SourceSansPro', weight: 400 },
  SourceSansBold: { family: 'SourceSansPro', weight: 700 },
  SourceSansLight: { family: 'SourceSansPro', weight: 300 },
  SourceSansItalic: { family: 'SourceSansPro', weight: 400, style: 'italic' },
  SourceSansSemibold: { family: 'SourceSansPro', weight: 600 },
  Bodoni: { family: 'AccanthisADFStd', weight: 400 },
  Garamond: { family: 'Guru', weight: 400 },
  Cartoon: { family: 'ComicNeueAngular', weight: 400 },
  Code: { family: 'Inconsolata', weight: 400 },
  Highway: { family: 'HighwayGothic', weight: 400 },
  SciFi: { family: 'Zekton', weight: 400 },
  Arcade: { family: 'PressStart2P', weight: 400 },
  Fantasy: { family: 'Balthazar', weight: 400 },
  Antique: { family: 'RomanAntique', weight: 400 },
  Gotham: { family: 'GothamSSm', weight: 400 },
  GothamMedium: { family: 'GothamSSm', weight: 500 },
  GothamSemibold: { family: 'GothamSSm', weight: 500 },
  GothamBold: { family: 'GothamSSm', weight: 700 },
  GothamBlack: { family: 'GothamSSm', weight: 900 },
  AmaticSC: { family: 'AmaticSC', weight: 400 },
  Bangers: { family: 'Bangers', weight: 400 },
  Creepster: { family: 'Creepster', weight: 400 },
  DenkOne: { family: 'DenkOne', weight: 400 },
  Fondamento: { family: 'Fondamento', weight: 400 },
  FredokaOne: { family: 'FredokaOne', weight: 400 },
  GrenzeGotisch: { family: 'GrenzeGotisch', weight: 400 },
  IndieFlower: { family: 'IndieFlower', weight: 400 },
  JosefinSans: { family: 'JosefinSans', weight: 400 },
  Jura: { family: 'Jura', weight: 400 },
  Kalam: { family: 'Kalam', weight: 400 },
  LuckiestGuy: { family: 'LuckiestGuy', weight: 400 },
  Merriweather: { family: 'Merriweather', weight: 400 },
  Michroma: { family: 'Michroma', weight: 400 },
  Nunito: { family: 'Nunito', weight: 400 },
  Oswald: { family: 'Oswald', weight: 400 },
  PatrickHand: { family: 'PatrickHand', weight: 400 },
  PermanentMarker: { family: 'PermanentMarker', weight: 400 },
  Roboto: { family: 'Roboto', weight: 400 },
  RobotoCondensed: { family: 'RobotoCondensed', weight: 400 },
  RobotoMono: { family: 'RobotoMono', weight: 400 },
  Sarpanch: { family: 'Sarpanch', weight: 400 },
  SpecialElite: { family: 'SpecialElite', weight: 400 },
  TitilliumWeb: { family: 'TitilliumWeb', weight: 400 },
  Ubuntu: { family: 'Ubuntu', weight: 400 },
  BuilderSans: { family: 'BuilderSans', weight: 400 },
  BuilderSansMedium: { family: 'BuilderSans', weight: 500 },
  BuilderSansBold: { family: 'BuilderSans', weight: 700 },
  BuilderSansExtraBold: { family: 'BuilderSans', weight: 800 },
  Arimo: { family: 'Arimo', weight: 400 },
  ArimoBold: { family: 'Arimo', weight: 700 },
};

/** Families with no json on disk that Roblox redirects (the exe's remap pairs), and other names for families. */
const FAMILY_ALIASES: Record<string, string> = {
  gothamssm: 'Montserrat',
  gotham: 'Montserrat',
  arial: 'LegacyArimo',
  arimolegacy: 'LegacyArimo',
};

export const FONT_WEIGHTS: Record<string, number> = { thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, heavy: 900, black: 900 };

interface FamilyFace {
  name: string;
  weight: number;
  style: FontStyleName;
  /** A local file (absolute), or null for a cloud asset (rbxassetid://). */
  file: string | null;
  asset: string;
}

interface Family {
  /** The json's name ("BuilderSans"). */
  key: string;
  /** Its display name ("Builder Sans"). */
  name: string;
  faces: FamilyFace[];
}

/** What a node's font asks for, before picking a file. */
export interface FontRequest {
  /** The family json name as Roblox stores it ("GothamSSm", "BuilderSans"). */
  family: string;
  weight: number;
  style: FontStyleName;
  /** The font string named a known Enum.Font or family. */
  known: boolean;
}

/**
 * What a node's `font` means: an Enum.Font name ("GothamBold", "Enum.Font.GothamBold"), a FontFace family json name
 * or path ("GothamSSm", "rbxasset://fonts/families/GothamSSm.json"), a family's display name ("Source Sans Pro"),
 * or a FontFace as Luau prints it ("Font { Family = …GothamSSm.json, Weight = Bold, Style = Italic }"). Bold makes a
 * lighter weight Bold (700) as the capture's `bold` (weight ≥ 600) and the Lab's builder do; `weight` wins.
 */
export function parseFont(font: string | undefined, bold?: boolean, italic?: boolean, weight?: number, familyKeys: Iterable<string> = Object.values(ENUM_FONTS).map((e) => e.family)): FontRequest {
  let s = (font ?? 'BuilderSans').trim();
  let w: number | null = null;
  let style: FontStyleName | null = null;
  const fw = /Weight\s*=\s*(?:Enum\.FontWeight\.)?(\w+)/i.exec(s);
  if (fw) w = FONT_WEIGHTS[fw[1]!.toLowerCase()] ?? (Number(fw[1]) || null);
  const fs = /Style\s*=\s*(?:Enum\.FontStyle\.)?(\w+)/i.exec(s);
  if (fs) style = /italic/i.test(fs[1]!) ? 'italic' : 'normal';
  const fam = /Family\s*=\s*([^,}]+)/i.exec(s);
  if (fam) s = fam[1]!.trim();
  s = s.replace(/^Enum\.Font\./, '');
  const path = /([\w-]+)\.json$/i.exec(s);
  if (path) s = path[1]!;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(s);
  let req: FontRequest | null = null;
  if (!path && !fam) {
    const e = Object.entries(ENUM_FONTS).find(([k]) => norm(k) === n);
    if (e) req = { family: e[1].family, weight: e[1].weight, style: e[1].style ?? 'normal', known: true };
  }
  if (!req) {
    const key = [...familyKeys].find((k) => norm(k) === n) ?? (FAMILY_ALIASES[n] ? s : undefined);
    req = key ? { family: key, weight: 400, style: 'normal', known: true } : { family: 'BuilderSans', weight: 400, style: 'normal', known: false };
  }
  if (w !== null) req.weight = w;
  if (style) req.style = style;
  if (weight && weight > 0) req.weight = weight;
  else if (bold && req.weight < 600) req.weight = 700;
  if (italic) req.style = 'italic';
  return req;
}

/** The face CSS font matching picks for a weight among those there are (Roblox's own pick may differ: calibrate). */
function nearestWeight(want: number, have: number[]): number {
  const up = have.filter((w) => w >= want).sort((a, b) => a - b);
  const down = have.filter((w) => w < want).sort((a, b) => b - a);
  if (have.includes(want)) return want;
  if (want >= 400 && want <= 500) {
    const mid = up.filter((w) => w <= 500);
    return mid[0] ?? down[0] ?? up[0]!;
  }
  return want < 400 ? (down[0] ?? up[0]!) : (up[0] ?? down[0]!);
}

// ─── Faces ───────────────────────────────────────────────────────────────────────────────────────

/** A Roblox face, ready to draw and measure (the shape ui-render.ts reads from TrueTypeFont, plus kerning). */
export interface RobloxFace {
  /** The file's name ("BuilderSans-Bold.otf"). */
  name: string;
  /** The file drawn (absolute path). */
  file: string;
  /** The family json name Roblox uses ("GothamSSm") and the one whose file is drawn ("Montserrat"). */
  family: string;
  drawnFamily: string;
  /** What was asked and what is drawn. */
  wanted: { weight: number; style: FontStyleName };
  weight: number;
  style: FontStyleName;
  /** This is the file Roblox draws with for this font (false: a substitute, see `why`). */
  exact: boolean;
  why: string;
  /** Italic was asked for and the face drawn is upright: slant it (about 0.2). */
  synthItalic: boolean;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  /** TextSize multiplier Roblox draws this font at: 1.5 for Enum.Font.Legacy (LegacyArial), else 1. */
  sizeScale: number;
  /**
   * Pixels per font unit at a TextSize: Roblox fits the font's hhea ascender−descender to the TextSize (× sizeScale),
   * so glyphs are drawn at size × sizeScale / (ascender − descender), not size / unitsPerEm.
   */
  pxPerUnit(size: number): number;
  /** The glyph (the face's own; else the first fallback font that has it, scaled to this face's units; else the face's .notdef). */
  glyph(cp: number): Glyph;
  /** The face itself has the character. */
  has(cp: number): boolean;
  /** The font that draws a character (this face's or a fallback's), or null when none has it. */
  fontOf(cp: number): OpenTypeFont | null;
  /** Pair kerning (this face's units; 0 across fonts). */
  kern(left: number, right: number): number;
  /** A character's advance in this face's units (fallbacks scaled). */
  advance(cp: number): number;
  /** The font file read. */
  font: OpenTypeFont;
}

/** Roblox draws Enum.Font.Legacy's family half again as big as its TextSize (TextBounds 1.5× wide and tall, measured). */
const SIZE_SCALE: Record<string, number> = { LegacyArial: 1.5 };

/** Characters that take no room (joiners, variation selectors, controls) as a shaper drops them. */
const ignorable = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xad || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2064) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff || (cp >= 0xe0100 && cp <= 0xe01ef);

class Face implements RobloxFace {
  readonly name: string;
  readonly file: string;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly sizeScale: number;
  private readonly fallbackGlyphs = new Map<number, Glyph>();
  private readonly adv = new Map<number, number>();

  constructor(
    readonly font: OpenTypeFont,
    readonly family: string,
    readonly drawnFamily: string,
    readonly wanted: { weight: number; style: FontStyleName },
    readonly weight: number,
    readonly style: FontStyleName,
    readonly exact: boolean,
    readonly why: string,
    private readonly fallbacks: () => OpenTypeFont[],
  ) {
    this.name = font.name;
    this.file = font.file;
    this.unitsPerEm = font.unitsPerEm;
    this.ascender = font.ascender;
    this.descender = font.descender;
    this.lineGap = font.lineGap;
    this.sizeScale = SIZE_SCALE[family] ?? 1;
  }

  pxPerUnit(size: number): number {
    return (size * this.sizeScale) / Math.max(1, this.ascender - this.descender);
  }

  /** A fallback font's units in this face's units: each font is sized by its own ascender−descender. */
  private unitsOf(f: OpenTypeFont): number {
    return (this.ascender - this.descender) / Math.max(1, f.ascender - f.descender);
  }

  get synthItalic(): boolean {
    return this.wanted.style === 'italic' && this.style !== 'italic';
  }

  has(cp: number): boolean {
    return this.font.has(cp);
  }

  fontOf(cp: number): OpenTypeFont | null {
    if (this.font.has(cp)) return this.font;
    for (const f of this.fallbacks()) if (f.has(cp)) return f;
    return null;
  }

  glyph(cp: number): Glyph {
    const f = this.fontOf(cp);
    if (!f || f === this.font) return this.font.glyph(cp);
    let g = this.fallbackGlyphs.get(cp);
    if (!g) {
      const src = f.glyph(cp);
      const k = this.unitsOf(f);
      g = { contours: k === 1 ? src.contours : src.contours.map((c) => c.map(([x, y]) => [x * k, y * k] as Pt)), advance: src.advance * k };
      this.fallbackGlyphs.set(cp, g);
    }
    return g;
  }

  advance(cp: number): number {
    let a = this.adv.get(cp);
    if (a === undefined) {
      if (ignorable(cp)) a = 0;
      else {
        const f = this.fontOf(cp);
        a = !f || f === this.font ? this.font.advance(cp) : f.advance(cp) * this.unitsOf(f);
      }
      this.adv.set(cp, a);
    }
    return a;
  }

  kern(left: number, right: number): number {
    return this.font.kern(left, right);
  }
}

/** Roblox's fonts in one install: families, faces, fallbacks. */
export class RobloxFontLibrary {
  readonly families = new Map<string, Family>();
  private readonly faces = new Map<string, RobloxFace | null>();
  private readonly studio = new Map<string, string>();
  private fallbackFonts: OpenTypeFont[] | null = null;

  constructor(readonly install: RobloxFontInstall) {
    for (const f of readdirSync(install.families)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      try {
        const j = JSON.parse(readFileSync(join(install.families, f), 'utf8')) as { name?: string; faces?: Array<{ name?: string; weight?: number; style?: string; assetId?: string }> };
        const key = f.slice(0, -5);
        const faces: FamilyFace[] = (j.faces ?? []).map((x) => {
          const asset = x.assetId ?? '';
          const local = /^rbxasset:\/\/fonts\/(.+)$/i.exec(asset);
          const file = local ? join(install.fonts, local[1]!) : null;
          return { name: x.name ?? '', weight: x.weight ?? 400, style: x.style === 'italic' ? 'italic' : 'normal', file: file && existsSync(file) ? file : null, asset };
        });
        this.families.set(key, { key, name: j.name ?? key, faces });
      } catch {
        // A family json that doesn't parse is left out.
      }
    }
    // Studio's own copies: "<Stem>-<Weight><It|Italic>.otf" → their weight and style.
    if (install.studioFonts)
      for (const f of readdirSync(install.studioFonts)) {
        const m = /^([A-Za-z0-9]+)-([A-Za-z]*?)(It|Italic)?\.(otf|ttf)$/.exec(f);
        if (!m) continue;
        const w = m[2] ? FONT_WEIGHTS[m[2].toLowerCase()] : 400;
        if (!w && !(m[2] === '' && m[3])) continue;
        this.studio.set(`${m[1]!.toLowerCase()}|${w ?? 400}|${m[3] ? 'italic' : 'normal'}`, join(install.studioFonts, f));
      }
  }

  /** Every font file of the install's content\fonts folder. */
  files(): string[] {
    return readdirSync(this.install.fonts)
      .filter((f) => /\.(ttf|otf|ttc)$/i.test(f))
      .map((f) => join(this.install.fonts, f));
  }

  /** The family json a request's family resolves to (aliases followed). */
  family(key: string): Family | null {
    const direct = this.families.get(key) ?? [...this.families.values()].find((f) => f.key.toLowerCase() === key.toLowerCase());
    if (direct && direct.faces.some((x) => x.file)) return direct;
    const alias = FAMILY_ALIASES[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
    return (alias ? this.families.get(alias) : undefined) ?? direct ?? null;
  }

  /** The face for what a node carries (see parseFont); null only when no font of the install can be read. */
  face(font?: string, bold?: boolean, italic?: boolean, weight?: number): RobloxFace | null {
    const key = `${font ?? ''}|${bold ? 1 : 0}|${italic ? 1 : 0}|${weight ?? ''}`;
    if (this.faces.has(key)) return this.faces.get(key)!;
    const req = parseFont(font, bold, italic, weight, this.families.keys());
    const face = this.pick(req, font);
    this.faces.set(key, face);
    return face;
  }

  private pick(req: FontRequest, asked: string | undefined): RobloxFace | null {
    const fam = [this.family(req.family), this.family('BuilderSans')].find((f) => f && f.faces.length);
    if (!fam) return null;
    const wanted = { weight: req.weight, style: req.style };
    const notes: string[] = [];
    let exact = req.known;
    if (!req.known) notes.push(`unknown font "${asked}": BuilderSans`);
    // Roblox's own pick among the family's faces (all of them, cloud ones included).
    const sameStyle = fam.faces.filter((f) => f.style === req.style);
    const pool = sameStyle.length ? sameStyle : fam.faces;
    const w = nearestWeight(req.weight, pool.map((f) => f.weight));
    let target = pool.find((f) => f.weight === w)!;
    if (w !== req.weight) notes.push(`${fam.key} has no ${req.weight}: its ${w}`);
    if (!sameStyle.length && req.style === 'italic') notes.push(`${fam.key} has no italic`);
    let file = target.file;
    if (!file) {
      // A cloud face: Studio's own copy of it, else the nearest local face.
      exact = false;
      const stem = fam.faces.map((f) => (f.file ? basename(f.file).split('-')[0]! : null)).find(Boolean) ?? fam.key;
      const studio = this.studio.get(`${stem.toLowerCase()}|${target.weight}|${target.style}`);
      if (studio && loadFont(studio)) {
        file = studio;
        notes.push(`${fam.key} ${target.weight}${target.style === 'italic' ? ' italic' : ''} is a cloud asset (${target.asset}): Studio's own copy`);
      } else {
        const local = fam.faces.filter((f) => f.file);
        if (!local.length) return fam.key === 'BuilderSans' ? null : this.pickFallbackFamily(req, notes);
        const localSame = local.filter((f) => f.style === target.style);
        const lp = localSame.length ? localSame : local;
        const lw = nearestWeight(target.weight, lp.map((f) => f.weight));
        const near = lp.find((f) => f.weight === lw)!;
        notes.push(`${fam.key} ${target.weight}${target.style === 'italic' ? ' italic' : ''} is a cloud asset (${target.asset}): nearest local ${near.weight}${near.style === 'italic' ? ' italic' : ''}`);
        target = near;
        file = near.file!;
      }
    }
    const font = loadFont(file);
    if (!font) return null;
    const m = /^.*-([A-Za-z]*?)(It|Italic)?\.(otf|ttf)$/.exec(basename(file));
    const drawnWeight = file === target.file ? target.weight : m?.[1] ? (FONT_WEIGHTS[m[1].toLowerCase()] ?? target.weight) : target.weight;
    const drawnStyle: FontStyleName = file === target.file ? target.style : m?.[2] ? 'italic' : 'normal';
    return new Face(font, req.family, fam.key, wanted, drawnWeight, drawnStyle, exact, notes.join('; ') || 'exact', () => this.fallbacks());
  }

  /** A family with no local file at all (NotoSansCJKFallback): drawn in BuilderSans. */
  private pickFallbackFamily(req: FontRequest, notes: string[]): RobloxFace | null {
    const f = this.face('BuilderSans', false, req.style === 'italic', req.weight);
    if (!f) return null;
    notes.push(`${req.family} has no local face: BuilderSans`);
    return new Face(f.font, req.family, f.drawnFamily, { weight: req.weight, style: req.style }, f.weight, f.style, false, notes.join('; '), () => this.fallbacks());
  }

  /** Fonts tried, in order, for a character the face lacks. */
  fallbacks(): OpenTypeFont[] {
    if (this.fallbackFonts) return this.fallbackFonts;
    const at = (dir: string | null, f: string) => (dir && existsSync(join(dir, f)) ? loadFont(join(dir, f)) : null);
    const fonts = this.install.fonts;
    const list: Array<OpenTypeFont | null> = [
      at(fonts, 'RobloxEmoji.ttf'),
      at(fonts, 'BuilderSans-Regular.otf'),
      at(fonts, 'Arimo-Regular.ttf'),
      ...readdirSync(fonts)
        .filter((f) => /^Noto.*\.ttf$/i.test(f))
        .sort()
        .map((f) => at(fonts, f)),
      at(this.install.platformFonts, 'NotoSansCJKjp-Regular.otf'),
      at(fonts, 'TwemojiMozilla.ttf'),
    ];
    this.fallbackFonts = list.filter((f): f is OpenTypeFont => !!f);
    return this.fallbackFonts;
  }
}

let defaultLib: RobloxFontLibrary | null | undefined;

/** The library for the install found on this machine (cached; null when there is none). */
export function robloxFonts(): RobloxFontLibrary | null {
  if (defaultLib === undefined) {
    const install = findRobloxFonts();
    try {
      defaultLib = install ? new RobloxFontLibrary(install) : null;
    } catch {
      defaultLib = null;
    }
  }
  return defaultLib;
}

/** The Roblox face for a node's font, bold, italic (and exact weight when captured); null without an install. */
export function robloxFaceFor(font?: string, bold?: boolean, italic?: boolean, weight?: number): RobloxFace | null {
  return robloxFonts()?.face(font, bold, italic, weight) ?? null;
}

// ─── Measuring ───────────────────────────────────────────────────────────────────────────────────

/**
 * How Roblox's TextBounds.X adds up, fitted to 736 single-line TextBounds read in Studio (56 faces, sizes 12–60;
 * `tests/ui-lab-fonts.test.ts`): each glyph's advance plus its GPOS/kern pair adjustment, at pxPerUnit, moves a
 * whole-pixel pen that rounds up from a tenth of a pixel (pen = floor(pen + step + PIXEL_BIAS)). Monospaced faces
 * come out exact; proportional ones land within about 2 px on average (Roblox's hinting moves single glyphs that a
 * linear model can't see).
 */
export const PIXEL_BIAS = 0.9;

export interface MeasureOptions {
  /** Apply pair kerning (default true). */
  kerning?: boolean;
  /** Snap the pen to whole pixels as Roblox does (default true); false gives the exact linear width. */
  pixels?: boolean;
  /** The snap's bias (default PIXEL_BIAS), for calibrating. */
  bias?: number;
}

/** A line's width at a TextSize, as Roblox's TextBounds.X (see PIXEL_BIAS); fallback characters in their own font. */
export function measureFace(face: RobloxFace, text: string, size: number, opts: MeasureOptions = {}): number {
  const kerning = opts.kerning !== false;
  const snap = opts.pixels !== false;
  const bias = opts.bias ?? PIXEL_BIAS;
  const k = face.pxPerUnit(size);
  let w = 0;
  let prev = -1;
  let prevOwn = false;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo < 0xe000) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (ignorable(cp)) continue;
    let step = face.advance(cp);
    const own = face.has(cp);
    if (kerning && prevOwn && own) step += face.kern(prev, cp);
    step *= k;
    w = snap ? Math.floor(w + step + bias) : w + step;
    prev = cp;
    prevOwn = own;
  }
  return w;
}

/**
 * Where each character of a line starts (pixels from the line's start, the pen measureFace moves) and the line's
 * width: for drawing glyphs exactly where the measure put them. Code points, as `[...text]` splits them.
 */
export function placeLine(face: RobloxFace, text: string, size: number, opts: MeasureOptions = {}): { cps: number[]; x: number[]; width: number } {
  const kerning = opts.kerning !== false;
  const snap = opts.pixels !== false;
  const bias = opts.bias ?? PIXEL_BIAS;
  const k = face.pxPerUnit(size);
  const cps: number[] = [];
  const x: number[] = [];
  let w = 0;
  let prev = -1;
  let prevOwn = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    cps.push(cp);
    if (ignorable(cp)) {
      x.push(w);
      continue;
    }
    const own = face.has(cp);
    // A pair adjustment moves the second glyph (and everything after it).
    const kern = kerning && prevOwn && own ? face.kern(prev, cp) : 0;
    x.push(w + kern * k);
    const step = (face.advance(cp) + kern) * k;
    w = snap ? Math.floor(w + step + bias) : w + step;
    prev = cp;
    prevOwn = own;
  }
  return { cps, x, width: w };
}

/** Roblox's TextBounds width for a node's text (falls back to estimateText without an install). Same signature as estimateText. */
export const robloxMeasure: Measure = (text, size, node) => {
  const face = robloxFaceFor(node.font, node.bold, node.italic, node.weight);
  return face ? measureFace(face, text, size) : estimateText(text, size, node);
};

/** A Measure for a library other than this machine's (tests, another install) or other options. */
export function measureWith(lib: RobloxFontLibrary | null, opts: MeasureOptions = {}): Measure {
  return (text, size, node: UiNode) => {
    const face = lib?.face(node.font, node.bold, node.italic, node.weight) ?? null;
    return face ? measureFace(face, text, size, opts) : estimateText(text, size, node);
  };
}

export interface LineMetrics {
  /** A line's height: TextSize × sizeScale × LineHeight (TextBounds.Y = lines × this, measured for LineHeight 1). */
  lineHeight: number;
  /** The baseline below the top of its line: the font's ascender at pxPerUnit (measured within 1 px on six faces). */
  baseline: number;
  /** The font's ascent and descent (hhea), cap and x heights at this size: ascent + descent = TextSize × sizeScale. */
  ascent: number;
  descent: number;
  capHeight: number;
  xHeight: number;
  /** Pixels per font unit (glyph outlines scale by this). */
  scale: number;
}

/**
 * Where a line sits at a TextSize. Measured in Studio (LineHeight 1): lines are TextSize apart (1.5× for Legacy) and
 * the ascender−descender box fills the line, so the baseline is the ascender down from the line's top. ASSUMED for
 * LineHeight ≠ 1: the extra (or missing) height is split above and below the glyphs.
 */
export function robloxLineMetrics(face: Pick<RobloxFace, 'ascender' | 'descender' | 'sizeScale' | 'pxPerUnit'> & { font?: OpenTypeFont }, size: number, lineHeight = 1): LineMetrics {
  const k = face.pxPerUnit(size);
  const em = size * face.sizeScale;
  const lh = em * lineHeight;
  const cap = face.font?.capHeight ?? face.ascender * 0.72;
  const xh = face.font?.xHeight ?? face.ascender * 0.52;
  return { lineHeight: lh, baseline: (lh - em) / 2 + face.ascender * k, ascent: face.ascender * k, descent: -face.descender * k, capHeight: cap * k, xHeight: xh * k, scale: k };
}

/** A node's line height at a size (TextSize × 1.5 for Legacy), for layouts that stack lines; no install: size × LineHeight. */
export function robloxLineHeight(node: UiNode, size: number): number {
  const face = robloxFaceFor(node.font, node.bold, node.italic, node.weight);
  return size * (face?.sizeScale ?? 1) * (node.lineHeight ?? 1);
}
