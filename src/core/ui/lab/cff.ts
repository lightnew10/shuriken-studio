/**
 * The CFF table of an OpenType font (BuilderSans and the other .otf faces Roblox ships): Type 2 charstrings run to
 * glyph outlines (cubic curves flattened to straight segments, font units, y up) and their widths. Subroutines
 * (local, global, per-FD for CID-keyed fonts), hints (counted and skipped: hstem/vstem/hm, hintmask, cntrmask),
 * flex, the arithmetic operators and endchar's accented-character form (seac) are handled. CFF2 is not.
 */

import type { Pt } from '../ui-fonts';

interface Index {
  count: number;
  /** Absolute start and end of each item. */
  at: (i: number) => [number, number];
}

function readIndex(v: DataView, p: number): { index: Index; end: number } {
  const count = v.getUint16(p);
  if (count === 0) return { index: { count: 0, at: () => [0, 0] }, end: p + 2 };
  const offSize = v.getUint8(p + 2);
  const offs = p + 3;
  const data = offs + (count + 1) * offSize - 1;
  const off = (i: number) => {
    let x = 0;
    for (let k = 0; k < offSize; k++) x = x * 256 + v.getUint8(offs + i * offSize + k);
    return x;
  };
  return { index: { count, at: (i) => [data + off(i), data + off(i + 1)] }, end: data + off(count) };
}

/** A DICT's operators (escaped ones as 1200 + b1) and their operands. */
function readDict(v: DataView, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  let p = start;
  while (p < end) {
    const b0 = v.getUint8(p);
    if (b0 <= 21) {
      let op = b0;
      p++;
      if (b0 === 12) op = 1200 + v.getUint8(p++);
      out.set(op, ops);
      ops = [];
    } else if (b0 === 28) {
      ops.push(v.getInt16(p + 1));
      p += 3;
    } else if (b0 === 29) {
      ops.push(v.getInt32(p + 1));
      p += 5;
    } else if (b0 === 30) {
      // A real number in nibbles.
      let s = '';
      p++;
      for (;;) {
        const b = v.getUint8(p++);
        const hi = b >> 4;
        const lo = b & 15;
        const nib = (n: number) => (n <= 9 ? String(n) : n === 0xa ? '.' : n === 0xb ? 'E' : n === 0xc ? 'E-' : n === 0xe ? '-' : '');
        if (hi === 0xf) break;
        s += nib(hi);
        if (lo === 0xf) break;
        s += nib(lo);
      }
      ops.push(Number(s) || 0);
    } else if (b0 >= 32 && b0 <= 246) {
      ops.push(b0 - 139);
      p++;
    } else if (b0 >= 247 && b0 <= 250) {
      ops.push((b0 - 247) * 256 + v.getUint8(p + 1) + 108);
      p += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      ops.push(-(b0 - 251) * 256 - v.getUint8(p + 1) - 108);
      p += 2;
    } else p++;
  }
  return out;
}

const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

interface Private {
  subrs: Index | null;
  defaultWidthX: number;
  nominalWidthX: number;
}

/** Adobe StandardEncoding codes to their standard string ids, for seac's accent and base characters. */
const STD_ENC: Record<number, number> = (() => {
  const m: Record<number, number> = {};
  // 32..126 map to SIDs 1..95; the rest of StandardEncoding as listed in the CFF spec (Appendix B).
  for (let c = 32; c <= 126; c++) m[c] = c - 31;
  const tail: Array<[number, number]> = [
    [161, 96], [162, 97], [163, 98], [164, 99], [165, 100], [166, 101], [167, 102], [168, 103], [169, 104], [170, 105], [171, 106], [172, 107], [173, 108], [174, 109], [175, 110],
    [177, 111], [178, 112], [179, 113], [180, 114], [182, 115], [183, 116], [184, 117], [185, 118], [186, 119], [187, 120], [188, 121], [189, 122], [191, 123],
    [193, 124], [194, 125], [195, 126], [196, 127], [197, 128], [198, 129], [199, 130], [200, 131], [202, 132], [203, 133], [205, 134], [206, 135], [207, 136], [208, 137],
    [225, 138], [227, 139], [232, 140], [233, 141], [234, 142], [235, 143], [241, 144], [245, 145], [248, 146], [249, 147], [250, 148], [251, 149],
  ];
  for (const [c, s] of tail) m[c] = s;
  return m;
})();

export interface CffGlyph {
  contours: Pt[][];
  /** The width the charstring carries (defaultWidthX, or nominalWidthX + its first operand). */
  width: number;
}

export class CffTable {
  readonly glyphCount: number;
  private readonly v: DataView;
  private readonly charStrings: Index;
  private readonly gsubrs: Index;
  private readonly priv: Private;
  /** CID-keyed fonts: each glyph's font dict and the Private dicts. */
  private readonly fdSelect: ((gid: number) => number) | null = null;
  private readonly fdPrivs: Private[] = [];
  private readonly charset: ((gid: number) => number) | null = null;
  private readonly scale: number;
  private sidToGid: Map<number, number> | null = null;

  constructor(
    buf: Uint8Array,
    private readonly unitsPerEm: number,
  ) {
    this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const v = this.v;
    const hdrSize = v.getUint8(2);
    const names = readIndex(v, hdrSize);
    const tops = readIndex(v, names.end);
    const strings = readIndex(v, tops.end);
    this.gsubrs = readIndex(v, strings.end).index;
    const [ts, te] = tops.index.at(0);
    const top = readDict(v, ts, te);
    const cs = top.get(17)?.[0];
    if (cs === undefined) throw new Error('CFF without CharStrings');
    this.charStrings = readIndex(v, cs).index;
    this.glyphCount = this.charStrings.count;
    const matrix = top.get(1207);
    this.scale = matrix && matrix[0] ? matrix[0] * unitsPerEm : 1;
    this.priv = this.readPrivate(top.get(18));
    if (top.has(1230)) {
      // CID-keyed: FDArray and FDSelect.
      const fdArray = readIndex(v, top.get(1236)![0]!).index;
      for (let i = 0; i < fdArray.count; i++) {
        const [a, b] = fdArray.at(i);
        this.fdPrivs.push(this.readPrivate(readDict(v, a, b).get(18)));
      }
      this.fdSelect = this.readFdSelect(top.get(1237)![0]!);
    } else {
      const cset = top.get(15)?.[0] ?? 0;
      if (cset > 2) this.charset = this.readCharset(cset);
    }
  }

  private readPrivate(entry: number[] | undefined): Private {
    if (!entry || entry.length < 2) return { subrs: null, defaultWidthX: 0, nominalWidthX: 0 };
    const [size, off] = entry as [number, number];
    const d = readDict(this.v, off, off + size);
    const subrsOff = d.get(19)?.[0];
    return {
      subrs: subrsOff ? readIndex(this.v, off + subrsOff).index : null,
      defaultWidthX: d.get(20)?.[0] ?? 0,
      nominalWidthX: d.get(21)?.[0] ?? 0,
    };
  }

  private readFdSelect(p: number): (gid: number) => number {
    const v = this.v;
    const format = v.getUint8(p);
    if (format === 0) return (gid) => v.getUint8(p + 1 + gid);
    // Format 3: ranges, binary searched.
    const n = v.getUint16(p + 1);
    return (gid) => {
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const first = v.getUint16(p + 3 + mid * 3);
        const next = mid + 1 < n ? v.getUint16(p + 3 + (mid + 1) * 3) : v.getUint16(p + 3 + n * 3);
        if (gid < first) hi = mid - 1;
        else if (gid >= next) lo = mid + 1;
        else return v.getUint8(p + 3 + mid * 3 + 2);
      }
      return 0;
    };
  }

  /** gid → SID (names) for a custom charset; used to find seac's components. */
  private readCharset(p: number): (gid: number) => number {
    const v = this.v;
    const format = v.getUint8(p);
    const sids = new Uint16Array(this.glyphCount);
    let gid = 1;
    let q = p + 1;
    if (format === 0) {
      for (; gid < this.glyphCount; gid++, q += 2) sids[gid] = v.getUint16(q);
    } else {
      while (gid < this.glyphCount) {
        const first = v.getUint16(q);
        const left = format === 1 ? v.getUint8(q + 2) : v.getUint16(q + 2);
        q += format === 1 ? 3 : 4;
        for (let i = 0; i <= left && gid < this.glyphCount; i++) sids[gid++] = first + i;
      }
    }
    return (g) => sids[g] ?? 0;
  }

  private gidOfStdCode(code: number): number {
    const sid = STD_ENC[code];
    if (sid === undefined) return 0;
    if (!this.charset) return sid < this.glyphCount ? sid : 0; // ISOAdobe charset: gid = sid
    if (!this.sidToGid) {
      this.sidToGid = new Map();
      for (let g = 0; g < this.glyphCount; g++) this.sidToGid.set(this.charset(g), g);
    }
    return this.sidToGid.get(sid) ?? 0;
  }

  /** A glyph's outline (flattened; `step` font units per segment) and its charstring width. */
  glyph(gid: number, step: number): CffGlyph {
    const out: Pt[][] = [];
    let width = NaN;
    const priv = this.fdSelect ? (this.fdPrivs[this.fdSelect(gid)] ?? this.priv) : this.priv;
    this.run(gid, priv, out, step, (w) => (width = w), 0, 0, 0);
    if (Number.isNaN(width)) width = priv.defaultWidthX;
    const s = this.scale;
    const contours = s === 1 ? out : out.map((c) => c.map(([x, y]) => [x * s, y * s] as Pt));
    return { contours, width: width * s };
  }

  private run(gid: number, priv: Private, out: Pt[][], step: number, setWidth: (w: number) => void, ox: number, oy: number, depth: number): void {
    if (gid < 0 || gid >= this.glyphCount || depth > 2) return;
    const v = this.v;
    const stack: number[] = [];
    const store: number[] = [];
    let nStems = 0;
    let haveWidth = false;
    let x = ox;
    let y = oy;
    let cur: Pt[] | null = null;
    let done = false;
    const gsubrs = this.gsubrs;
    const subrs = priv.subrs;
    const gBias = bias(gsubrs.count);
    const lBias = subrs ? bias(subrs.count) : 0;

    const close = () => {
      if (cur && cur.length > 1) {
        const a = cur[0]!;
        const b = cur[cur.length - 1]!;
        if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) cur.pop();
        if (cur.length > 2) out.push(cur);
      }
      cur = null;
    };
    const moveTo = (nx: number, ny: number) => {
      close();
      x = nx;
      y = ny;
      cur = [[x, y]];
    };
    const lineTo = (nx: number, ny: number) => {
      if (!cur) cur = [[x, y]];
      x = nx;
      y = ny;
      cur.push([x, y]);
    };
    const curveTo = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => {
      if (!cur) cur = [[x, y]];
      const len = Math.hypot(c1x - x, c1y - y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(ex - c2x, ey - c2y);
      const n = Math.max(2, Math.min(16, Math.ceil(len / step)));
      const x0 = x;
      const y0 = y;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const d = t * t * t;
        cur.push([a * x0 + b * c1x + c * c2x + d * ex, a * y0 + b * c1y + c * c2y + d * ey]);
      }
      x = ex;
      y = ey;
    };
    // The width rides on the first stack-clearing operator as an extra leading operand.
    const width = (extra: boolean) => {
      if (!haveWidth) {
        haveWidth = true;
        if (extra) setWidth(stack.shift()! + priv.nominalWidthX);
      }
    };
    const stems = () => {
      width(stack.length % 2 !== 0);
      nStems += stack.length >> 1;
      stack.length = 0;
    };

    const exec = (start: number, end: number, level: number): void => {
      if (level > 12) return;
      let p = start;
      while (p < end && !done) {
        const b0 = v.getUint8(p++);
        if (b0 >= 32 || b0 === 28) {
          if (b0 === 28) {
            stack.push(v.getInt16(p));
            p += 2;
          } else if (b0 <= 246) stack.push(b0 - 139);
          else if (b0 <= 250) stack.push((b0 - 247) * 256 + v.getUint8(p++) + 108);
          else if (b0 <= 254) stack.push(-(b0 - 251) * 256 - v.getUint8(p++) - 108);
          else {
            stack.push(v.getInt32(p) / 65536);
            p += 4;
          }
          continue;
        }
        switch (b0) {
          case 1: // hstem
          case 3: // vstem
          case 18: // hstemhm
          case 23: // vstemhm
            stems();
            break;
          case 19: // hintmask
          case 20: // cntrmask
            stems();
            p += (nStems + 7) >> 3;
            break;
          case 21: // rmoveto
            width(stack.length > 2);
            moveTo(x + stack[0]!, y + stack[1]!);
            stack.length = 0;
            break;
          case 22: // hmoveto
            width(stack.length > 1);
            moveTo(x + stack[0]!, y);
            stack.length = 0;
            break;
          case 4: // vmoveto
            width(stack.length > 1);
            moveTo(x, y + stack[0]!);
            stack.length = 0;
            break;
          case 5: // rlineto
            for (let i = 0; i + 1 < stack.length; i += 2) lineTo(x + stack[i]!, y + stack[i + 1]!);
            stack.length = 0;
            break;
          case 6: // hlineto
          case 7: {
            // vlineto
            let horiz = b0 === 6;
            for (let i = 0; i < stack.length; i++) {
              if (horiz) lineTo(x + stack[i]!, y);
              else lineTo(x, y + stack[i]!);
              horiz = !horiz;
            }
            stack.length = 0;
            break;
          }
          case 8: // rrcurveto
            for (let i = 0; i + 5 < stack.length; i += 6) {
              const c1x = x + stack[i]!;
              const c1y = y + stack[i + 1]!;
              const c2x = c1x + stack[i + 2]!;
              const c2y = c1y + stack[i + 3]!;
              curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 4]!, c2y + stack[i + 5]!);
            }
            stack.length = 0;
            break;
          case 24: {
            // rcurveline
            let i = 0;
            for (; i + 7 < stack.length; i += 6) {
              const c1x = x + stack[i]!;
              const c1y = y + stack[i + 1]!;
              const c2x = c1x + stack[i + 2]!;
              const c2y = c1y + stack[i + 3]!;
              curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 4]!, c2y + stack[i + 5]!);
            }
            lineTo(x + stack[i]!, y + stack[i + 1]!);
            stack.length = 0;
            break;
          }
          case 25: {
            // rlinecurve
            let i = 0;
            for (; i + 6 < stack.length; i += 2) lineTo(x + stack[i]!, y + stack[i + 1]!);
            const c1x = x + stack[i]!;
            const c1y = y + stack[i + 1]!;
            const c2x = c1x + stack[i + 2]!;
            const c2y = c1y + stack[i + 3]!;
            curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 4]!, c2y + stack[i + 5]!);
            stack.length = 0;
            break;
          }
          case 26: {
            // vvcurveto
            let i = 0;
            let dx1 = 0;
            if (stack.length % 2) dx1 = stack[i++]!;
            for (; i + 3 < stack.length; i += 4) {
              const c1x = x + dx1;
              const c1y = y + stack[i]!;
              const c2x = c1x + stack[i + 1]!;
              const c2y = c1y + stack[i + 2]!;
              curveTo(c1x, c1y, c2x, c2y, c2x, c2y + stack[i + 3]!);
              dx1 = 0;
            }
            stack.length = 0;
            break;
          }
          case 27: {
            // hhcurveto
            let i = 0;
            let dy1 = 0;
            if (stack.length % 2) dy1 = stack[i++]!;
            for (; i + 3 < stack.length; i += 4) {
              const c1x = x + stack[i]!;
              const c1y = y + dy1;
              const c2x = c1x + stack[i + 1]!;
              const c2y = c1y + stack[i + 2]!;
              curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 3]!, c2y);
              dy1 = 0;
            }
            stack.length = 0;
            break;
          }
          case 30: // vhcurveto
          case 31: {
            // hvcurveto
            let horiz = b0 === 31;
            let i = 0;
            while (i + 3 < stack.length) {
              const last = stack.length - i === 5;
              if (horiz) {
                const c1x = x + stack[i]!;
                const c1y = y;
                const c2x = c1x + stack[i + 1]!;
                const c2y = c1y + stack[i + 2]!;
                curveTo(c1x, c1y, c2x, c2y, c2x + (last ? stack[i + 4]! : 0), c2y + stack[i + 3]!);
              } else {
                const c1x = x;
                const c1y = y + stack[i]!;
                const c2x = c1x + stack[i + 1]!;
                const c2y = c1y + stack[i + 2]!;
                curveTo(c1x, c1y, c2x, c2y, c2x + stack[i + 3]!, c2y + (last ? stack[i + 4]! : 0));
              }
              i += last ? 5 : 4;
              horiz = !horiz;
            }
            stack.length = 0;
            break;
          }
          case 10: {
            // callsubr
            const i = stack.pop()! + lBias;
            if (subrs && i >= 0 && i < subrs.count) {
              const [a, b] = subrs.at(i);
              exec(a, b, level + 1);
            }
            break;
          }
          case 29: {
            // callgsubr
            const i = stack.pop()! + gBias;
            if (i >= 0 && i < gsubrs.count) {
              const [a, b] = gsubrs.at(i);
              exec(a, b, level + 1);
            }
            break;
          }
          case 11: // return
            return;
          case 14: {
            // endchar (with 4 operands: seac, an accented character from two standard glyphs)
            width(stack.length === 1 || stack.length === 5);
            close();
            if (stack.length >= 4) {
              const [adx, ady, bchar, achar] = stack.slice(-4) as [number, number, number, number];
              this.run(this.gidOfStdCode(bchar), priv, out, step, () => {}, ox, oy, depth + 1);
              this.run(this.gidOfStdCode(achar), priv, out, step, () => {}, ox + adx, oy + ady, depth + 1);
            }
            stack.length = 0;
            done = true;
            return;
          }
          case 12: {
            const b1 = v.getUint8(p++);
            escape(b1);
            break;
          }
          default:
            stack.length = 0;
        }
      }
    };

    const escape = (op: number) => {
      const s = stack;
      switch (op) {
        case 35: {
          // flex
          const x0 = x;
          const y0 = y;
          const c1x = x0 + s[0]!;
          const c1y = y0 + s[1]!;
          const c2x = c1x + s[2]!;
          const c2y = c1y + s[3]!;
          const px = c2x + s[4]!;
          const py = c2y + s[5]!;
          curveTo(c1x, c1y, c2x, c2y, px, py);
          const c3x = px + s[6]!;
          const c3y = py + s[7]!;
          const c4x = c3x + s[8]!;
          const c4y = c3y + s[9]!;
          curveTo(c3x, c3y, c4x, c4y, c4x + s[10]!, c4y + s[11]!);
          s.length = 0;
          return;
        }
        case 34: {
          // hflex
          const y0 = y;
          const c1x = x + s[0]!;
          const c2x = c1x + s[1]!;
          const c2y = y0 + s[2]!;
          const px = c2x + s[3]!;
          curveTo(c1x, y0, c2x, c2y, px, c2y);
          const c3x = px + s[4]!;
          const c4x = c3x + s[5]!;
          curveTo(c3x, c2y, c4x, y0, c4x + s[6]!, y0);
          s.length = 0;
          return;
        }
        case 36: {
          // hflex1
          const y0 = y;
          const c1x = x + s[0]!;
          const c1y = y0 + s[1]!;
          const c2x = c1x + s[2]!;
          const c2y = c1y + s[3]!;
          const px = c2x + s[4]!;
          curveTo(c1x, c1y, c2x, c2y, px, c2y);
          const c3x = px + s[5]!;
          const c4x = c3x + s[6]!;
          const c4y = c2y + s[7]!;
          curveTo(c3x, c2y, c4x, c4y, c4x + s[8]!, y0);
          s.length = 0;
          return;
        }
        case 37: {
          // flex1
          const x0 = x;
          const y0 = y;
          const c1x = x0 + s[0]!;
          const c1y = y0 + s[1]!;
          const c2x = c1x + s[2]!;
          const c2y = c1y + s[3]!;
          const px = c2x + s[4]!;
          const py = c2y + s[5]!;
          curveTo(c1x, c1y, c2x, c2y, px, py);
          const c3x = px + s[6]!;
          const c3y = py + s[7]!;
          const c4x = c3x + s[8]!;
          const c4y = c3y + s[9]!;
          const dx = c4x - x0;
          const dy = c4y - y0;
          if (Math.abs(dx) > Math.abs(dy)) curveTo(c3x, c3y, c4x, c4y, c4x + s[10]!, y0);
          else curveTo(c3x, c3y, c4x, c4y, x0, c4y + s[10]!);
          s.length = 0;
          return;
        }
        // Arithmetic and storage (rare in fonts, kept so a charstring that uses them still draws).
        case 3: {
          const b = s.pop()!;
          const a = s.pop()!;
          s.push(a && b ? 1 : 0);
          return;
        }
        case 4: {
          const b = s.pop()!;
          const a = s.pop()!;
          s.push(a || b ? 1 : 0);
          return;
        }
        case 5:
          s.push(s.pop() ? 0 : 1);
          return;
        case 9:
          s.push(Math.abs(s.pop()!));
          return;
        case 10:
          s.push(s.pop()! + s.pop()!);
          return;
        case 11: {
          const b = s.pop()!;
          s.push(s.pop()! - b);
          return;
        }
        case 12: {
          const b = s.pop()!;
          s.push(b ? s.pop()! / b : 0);
          return;
        }
        case 14:
          s.push(-s.pop()!);
          return;
        case 15:
          s.push(s.pop() === s.pop() ? 1 : 0);
          return;
        case 18:
          s.pop();
          return;
        case 20: {
          const i = s.pop()!;
          store[i] = s.pop()!;
          return;
        }
        case 21:
          s.push(store[s.pop()!] ?? 0);
          return;
        case 22: {
          const v2 = s.pop()!;
          const v1 = s.pop()!;
          const s2 = s.pop()!;
          const s1 = s.pop()!;
          s.push(v1 <= v2 ? s1 : s2);
          return;
        }
        case 23:
          s.push(0.5);
          return;
        case 24:
          s.push(s.pop()! * s.pop()!);
          return;
        case 26:
          s.push(Math.sqrt(Math.max(0, s.pop()!)));
          return;
        case 27:
          s.push(s[s.length - 1] ?? 0);
          return;
        case 28: {
          const b = s.pop()!;
          const a = s.pop()!;
          s.push(b, a);
          return;
        }
        case 29: {
          const i = s.pop()!;
          s.push(s[s.length - 1 - Math.max(0, i)] ?? 0);
          return;
        }
        case 30: {
          const j = s.pop()!;
          const n = s.pop()!;
          if (n > 0 && n <= s.length) {
            const part = s.splice(s.length - n, n);
            const k = ((j % n) + n) % n;
            s.push(...part.slice(n - k), ...part.slice(0, n - k));
          }
          return;
        }
        default:
          s.length = 0;
      }
    };

    const [a, b] = this.charStrings.at(gid);
    exec(a, b, 0);
    close();
  }
}
