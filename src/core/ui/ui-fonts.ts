import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fonts for UI pictures drawn without a browser (core/ui/ui-render.ts): TrueType outlines read from the
 * system's font files, picked for a Roblox font the way the UI page picks its CSS stand-ins
 * (renderer/components/ui/ui-canvas.tsx, cssFont): Segoe UI in its weights for the sans faces, Segoe UI Black for
 * the heavy display faces (FredokaOne, LuckiestGuy, Bangers…), Consolas for code and arcade, Georgia for the
 * serifs, Arial Narrow for the condensed ones, Bahnschrift for the sci-fi ones. Roblox's own fonts don't ship
 * with Windows: these are close stand-ins, and the picture says so. Where no font file can be read (not
 * Windows, or a font missing), text is drawn as blocks the size of its letters.
 */

export type Pt = [number, number];

/** A glyph in font units (y up): closed contours of straight segments (curves flattened), and its advance. */
export interface Glyph {
  contours: Pt[][];
  advance: number;
}

export class TrueTypeFont {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  private readonly view: DataView;
  private readonly tables = new Map<string, { offset: number; length: number }>();
  private readonly locShort: boolean;
  private readonly numGlyphs: number;
  private readonly numHMetrics: number;
  private readonly cmap: (cp: number) => number;
  private readonly glyphs = new Map<number, Glyph>();

  constructor(
    buf: Uint8Array,
    readonly name: string,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tag = this.view.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x74727565) throw new Error('not a TrueType font');
    const n = this.view.getUint16(4);
    for (let i = 0; i < n; i++) {
      const at = 12 + i * 16;
      const t = String.fromCharCode(buf[at]!, buf[at + 1]!, buf[at + 2]!, buf[at + 3]!);
      this.tables.set(t, { offset: this.view.getUint32(at + 8), length: this.view.getUint32(at + 12) });
    }
    for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'loca', 'glyf']) if (!this.tables.has(t)) throw new Error(`no ${t} table`);
    const head = this.table('head');
    this.unitsPerEm = this.view.getUint16(head + 18);
    this.locShort = this.view.getInt16(head + 50) === 0;
    const hhea = this.table('hhea');
    this.ascender = this.view.getInt16(hhea + 4);
    this.descender = this.view.getInt16(hhea + 6);
    this.numHMetrics = this.view.getUint16(hhea + 34);
    this.numGlyphs = this.view.getUint16(this.table('maxp') + 4);
    this.cmap = this.readCmap();
  }

  private table(t: string): number {
    return this.tables.get(t)!.offset;
  }

  /** The glyph index of a code point (0: the font has none). */
  private readCmap(): (cp: number) => number {
    const base = this.table('cmap');
    const v = this.view;
    const count = v.getUint16(base + 2);
    let f4 = -1;
    let f12 = -1;
    for (let i = 0; i < count; i++) {
      const platform = v.getUint16(base + 4 + i * 8);
      const encoding = v.getUint16(base + 6 + i * 8);
      const off = base + v.getUint32(base + 8 + i * 8);
      const format = v.getUint16(off);
      if (format === 12 && (platform === 3 || platform === 0)) f12 = off;
      else if (format === 4 && ((platform === 3 && (encoding === 1 || encoding === 0)) || platform === 0) && f4 < 0) f4 = off;
    }
    if (f12 >= 0) {
      const groups = v.getUint32(f12 + 12);
      return (cp) => {
        let lo = 0;
        let hi = groups - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const g = f12 + 16 + mid * 12;
          const start = v.getUint32(g);
          const end = v.getUint32(g + 4);
          if (cp < start) hi = mid - 1;
          else if (cp > end) lo = mid + 1;
          else return v.getUint32(g + 8) + (cp - start);
        }
        return 0;
      };
    }
    if (f4 >= 0) {
      const segX2 = v.getUint16(f4 + 6);
      const ends = f4 + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      return (cp) => {
        if (cp > 0xffff) return 0;
        for (let i = 0; i < segX2; i += 2) {
          if (cp > v.getUint16(ends + i)) continue;
          const start = v.getUint16(starts + i);
          if (cp < start) return 0;
          const delta = v.getInt16(deltas + i);
          const range = v.getUint16(ranges + i);
          if (!range) return (cp + delta) & 0xffff;
          const g = v.getUint16(ranges + i + range + (cp - start) * 2);
          return g ? (g + delta) & 0xffff : 0;
        }
        return 0;
      };
    }
    return () => 0;
  }

  advanceOf(gid: number): number {
    const hmtx = this.table('hmtx');
    return this.view.getUint16(hmtx + Math.min(gid, this.numHMetrics - 1) * 4);
  }

  has(cp: number): boolean {
    return this.cmap(cp) !== 0;
  }

  /** A character's glyph (the font's .notdef when it has none). */
  glyph(cp: number): Glyph {
    const gid = this.cmap(cp);
    const hit = this.glyphs.get(gid);
    if (hit) return hit;
    const g: Glyph = { contours: this.outline(gid, 0), advance: this.advanceOf(gid) };
    this.glyphs.set(gid, g);
    return g;
  }

  private outline(gid: number, depth: number): Pt[][] {
    if (gid >= this.numGlyphs || depth > 6) return [];
    const loca = this.table('loca');
    const v = this.view;
    const at = (i: number) => (this.locShort ? v.getUint16(loca + i * 2) * 2 : v.getUint32(loca + i * 4));
    const start = at(gid);
    const end = at(gid + 1);
    if (end <= start) return [];
    const g = this.table('glyf') + start;
    const contoursCount = v.getInt16(g);
    if (contoursCount < 0) return this.composite(g + 10, depth);
    const ends: number[] = [];
    for (let i = 0; i < contoursCount; i++) ends.push(v.getUint16(g + 10 + i * 2));
    const points = (ends[ends.length - 1] ?? -1) + 1;
    let p = g + 10 + contoursCount * 2;
    p += 2 + v.getUint16(p);
    const flags: number[] = [];
    while (flags.length < points) {
      const f = v.getUint8(p++);
      flags.push(f);
      if (f & 8) {
        const r = v.getUint8(p++);
        for (let i = 0; i < r; i++) flags.push(f);
      }
    }
    const xs: number[] = [];
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
      xs.push(x);
    }
    const ys: number[] = [];
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
      ys.push(y);
    }
    const out: Pt[][] = [];
    let first = 0;
    for (const last of ends) {
      const pts = [];
      for (let i = first; i <= last; i++) pts.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) === 1 });
      first = last + 1;
      if (pts.length > 1) out.push(flatten(pts, this.unitsPerEm));
    }
    return out;
  }

  private composite(p: number, depth: number): Pt[][] {
    const v = this.view;
    const out: Pt[][] = [];
    for (;;) {
      const flags = v.getUint16(p);
      const gid = v.getUint16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (flags & 1) {
        dx = v.getInt16(p);
        dy = v.getInt16(p + 2);
        p += 4;
      } else {
        dx = v.getInt8(p);
        dy = v.getInt8(p + 1);
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
      for (const contour of this.outline(gid, depth + 1)) out.push(contour.map(([x, y]) => [x * a + y * c + dx, x * b + y * d + dy] as Pt));
      if (!(flags & 0x20)) break;
    }
    return out;
  }
}

/** A TrueType contour (on- and off-curve points, quadratic) as straight segments. */
function flatten(pts: Array<{ x: number; y: number; on: boolean }>, upm: number): Pt[] {
  // Start on an on-curve point (or the midpoint of two off-curve ones).
  let s = pts.findIndex((q) => q.on);
  const ring = s < 0 ? [{ x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2, on: true }, ...pts] : [...pts.slice(s), ...pts.slice(0, s)];
  s = 0;
  const out: Pt[] = [[ring[0]!.x, ring[0]!.y]];
  const step = upm / 40;
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

// ─── Picking a font for a Roblox font ─────────────────────────────────────────────────────────────

const fontDir = (): string => process.env.SHURIKEN_FONT_DIR ?? join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
const loaded = new Map<string, TrueTypeFont | null>();

/** A font file from the system's fonts folder (cached; null when it can't be read). */
export function systemFont(file: string): TrueTypeFont | null {
  const path = join(fontDir(), file);
  if (loaded.has(path)) return loaded.get(path)!;
  let font: TrueTypeFont | null = null;
  try {
    if (existsSync(path)) font = new TrueTypeFont(readFileSync(path), file);
  } catch {
    font = null;
  }
  loaded.set(path, font);
  return font;
}

/** How a Roblox font looks, for picking a stand-in and for suggesting one. */
export type FontStyle = 'sans' | 'display' | 'comic' | 'condensed' | 'techno' | 'mono' | 'pixel' | 'serif';

/** The family's style (from its Enum.Font or FontFace name). */
export function fontStyle(font: string | undefined): FontStyle {
  const f = (font ?? 'BuilderSans').toLowerCase();
  if (/mono|code|inconsolata/.test(f)) return 'mono';
  if (/arcade|pixel|press/.test(f)) return 'pixel';
  if (/luckiest|fredoka|titan|denk|cartoon/.test(f)) return 'display';
  if (/bangers|comic|creepster|permanent|patrick|indie|kalam|amatic/.test(f)) return 'comic';
  if (/oswald|condensed|highway/.test(f)) return 'condensed';
  if (/scifi|michroma|jura|sarpanch|titillium|zekton/.test(f)) return 'techno';
  if (/garamond|merriweather|antique|fantasy|bodoni|playfair|fondamento|grenze|special/.test(f)) return 'serif';
  return 'sans';
}

export interface FontChoice {
  font: TrueTypeFont | null;
  /** The stand-in's name, for the picture's note. */
  standIn: string;
}

/** The font a text is drawn in: a stand-in for its Roblox font in its weight and slant. */
export function fontFor(font: string | undefined, bold?: boolean, italic?: boolean): FontChoice {
  const f = (font ?? 'BuilderSans').toLowerCase();
  const style = fontStyle(font);
  const heavy = /black|heavy|extrabold/.test(f) || style === 'display' || style === 'comic';
  const isBold = heavy || !!bold || /bold/.test(f);
  const medium = /medium|semi/.test(f);
  const light = /light|thin/.test(f);
  const pick = (files: Array<[string, string]>): FontChoice => {
    for (const [file, name] of files) {
      const t = systemFont(file);
      if (t) return { font: t, standIn: name };
    }
    return { font: null, standIn: 'blocks (no system font found)' };
  };
  const sans = (): Array<[string, string]> =>
    heavy
      ? [[italic ? 'seguibli.ttf' : 'seguibl.ttf', 'Segoe UI Black'], ['ariblk.ttf', 'Arial Black']]
      : isBold
        ? [[italic ? 'segoeuiz.ttf' : 'segoeuib.ttf', 'Segoe UI Bold'], ['arialbd.ttf', 'Arial Bold']]
        : medium
          ? [[italic ? 'seguisbi.ttf' : 'seguisb.ttf', 'Segoe UI Semibold'], ['segoeui.ttf', 'Segoe UI']]
          : light
            ? [['segoeuil.ttf', 'Segoe UI Light'], ['segoeui.ttf', 'Segoe UI']]
            : [[italic ? 'segoeuii.ttf' : 'segoeui.ttf', 'Segoe UI'], ['arial.ttf', 'Arial']];
  switch (style) {
    case 'mono':
    case 'pixel':
      return pick([[isBold || style === 'pixel' ? 'consolab.ttf' : italic ? 'consolai.ttf' : 'consola.ttf', 'Consolas'], ...sans()]);
    case 'serif':
      return pick([[isBold ? (italic ? 'georgiaz.ttf' : 'georgiab.ttf') : italic ? 'georgiai.ttf' : 'georgia.ttf', 'Georgia'], ...sans()]);
    case 'condensed':
      return pick([[isBold ? (italic ? 'ARIALNBI.TTF' : 'ARIALNB.TTF') : italic ? 'ARIALNI.TTF' : 'ARIALN.TTF', 'Arial Narrow'], ...sans()]);
    case 'techno':
      return pick([['bahnschrift.ttf', 'Bahnschrift'], ...sans()]);
    default:
      return pick(sans());
  }
}

// ─── The fonts Roblox ships ───────────────────────────────────────────────────────────────────────

/**
 * Every Enum.Font a game can use (create.roblox.com's Enum.Font page, read 2026-10-02; FontFace takes the same
 * families with Font.fromEnum, and Font.new("rbxasset://fonts/families/<Family>.json", weight) gives the weights a
 * family has), by look. Legacy and Unknown are left out.
 */
export const ROBLOX_FONTS: Record<FontStyle, string[]> = {
  sans: ['BuilderSans', 'BuilderSansMedium', 'BuilderSansBold', 'BuilderSansExtraBold', 'Gotham', 'GothamMedium', 'GothamBold', 'GothamBlack', 'Nunito', 'Roboto', 'SourceSans', 'SourceSansLight', 'SourceSansSemibold', 'SourceSansBold', 'SourceSansItalic', 'Ubuntu', 'JosefinSans', 'Arial', 'ArialBold', 'Arimo', 'ArimoBold'],
  display: ['FredokaOne', 'LuckiestGuy', 'DenkOne', 'Cartoon'],
  comic: ['Bangers', 'Creepster', 'PermanentMarker', 'PatrickHand', 'IndieFlower', 'Kalam', 'AmaticSC'],
  condensed: ['Oswald', 'RobotoCondensed', 'Highway'],
  techno: ['Michroma', 'Jura', 'Sarpanch', 'TitilliumWeb', 'SciFi'],
  mono: ['RobotoMono', 'Code'],
  pixel: ['Arcade'],
  serif: ['Merriweather', 'Bodoni', 'Garamond', 'Antique', 'Fantasy', 'Fondamento', 'GrenzeGotisch', 'SpecialElite'],
};

/** What each look is for, in a game's UI. */
export const FONT_USES: Record<FontStyle, string> = {
  sans: 'body text, labels, menus (BuilderSans is Roblox\'s own UI face; Gotham reads rounder)',
  display: 'chunky rounded titles and big numbers: simulators, obbies, tycoons (white with a thick dark stroke)',
  comic: 'loud cartoon or horror titles, banners and damage numbers',
  condensed: 'tall, tight headings and stat numbers: shooters, sports, HUDs',
  techno: 'sci-fi and mech HUDs: squared, wide, techy labels and ammo counts',
  mono: 'timers and numbers that must not jitter as they change',
  pixel: 'retro and arcade games',
  serif: 'fantasy, medieval, story and horror menus',
};
