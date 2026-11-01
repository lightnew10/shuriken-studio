import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blur, field } from '../src/core/ui/forge/canvas';
import { BUTTON_ROLES, DIRECTIONS, ELEMENT_KINDS, inkContrast, inkFor, type ElementRequest } from '../src/core/ui/forge/directions';
import { forge, MAX_IMAGE, type Forged, type ForgeSpec } from '../src/core/ui/forge/forge';
import { shapeContours, type ShapeSpec } from '../src/core/ui/forge/shapes';
import { robloxFonts } from '../src/core/ui/lab/roblox-fonts';

/**
 * The UI Forge's engine and its art directions: the same recipe draws the same pixels, 9-slice centres sit inside the
 * art round its corners, every element of every direction forges into real art no bigger than Roblox's 1024 px, a
 * typical element forges in well under 150 ms, button labels read on their faces, and states look like states.
 */

const hash = (f: Forged) => createHash('sha1').update(f.image.data).digest('hex');
const fonts = robloxFonts() !== null;

/** Share of the image that is painted. */
const filled = (f: Forged) => {
  let n = 0;
  const d = f.image.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! > 8) n++;
  return n / (d.length / 4);
};

/** Mean colour of a part of the element (fractions of its box; default the middle, the label's area), alpha-weighted. */
const faceColor = (f: Forged, w: number, h: number, area: [number, number, number, number] = [0.25, 0.3, 0.75, 0.7]): [number, number, number] => {
  const { width: W, data } = f.image;
  const m = f.margin * f.scale;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.round(m + h * f.scale * area[1]); y < Math.round(m + h * f.scale * area[3]); y++)
    for (let x = Math.round(m + w * f.scale * area[0]); x < Math.round(m + w * f.scale * area[2]); x++) {
      const k = (y * W + x) * 4;
      const a = data[k + 3]! / 255;
      r += data[k]! * a;
      g += data[k + 1]! * a;
      b += data[k + 2]! * a;
      n += a;
    }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
};

/** A request for each kind at a small typical size (fast), with the variants that change its art. */
function requests(): ElementRequest[] {
  const out: ElementRequest[] = [];
  for (const kind of ELEMENT_KINDS) {
    const size: [number, number] = kind === 'window' ? [260, 180] : kind === 'card' ? [110, 140] : kind === 'header' ? [220, 56] : kind === 'title' ? [200, 60] : kind === 'divider' ? [140, 6] : kind === 'barTrack' || kind === 'barFill' ? [140, 22] : ['badge', 'close', 'coin', 'icon', 'iconFrame', 'slot'].includes(kind) ? [56, 56] : [130, 46];
    if (kind === 'button') for (const v of BUTTON_ROLES) out.push({ kind, variant: v, size });
    else if (kind === 'tab') out.push({ kind, variant: 'active', size }, { kind, variant: 'inactive', size });
    else if (kind === 'card' || kind === 'slot') out.push({ kind, variant: 'common', size }, { kind, variant: 'mythic', size });
    else if (kind === 'icon') out.push({ kind, glyph: 'sword', variant: 'epic', size }, { kind, glyph: 'heart', size });
    else if (kind === 'coin') out.push({ kind, size }, { kind, glyph: 'gem', size: [24, 24] });
    else if (kind === 'title') out.push({ kind, text: 'SHOP', size });
    else out.push({ kind, size });
  }
  return out;
}

describe('forge engine', () => {
  it('draws the same pixels for the same recipe', () => {
    const spec: ForgeSpec = {
      size: [180, 120],
      layers: [
        { shape: { kind: 'torn', rough: 3, seed: 2 }, style: { fill: { type: 'radial', stops: [[0, '#ffcc66'], [1, '#884400']] }, textures: [{ kind: 'wood', scale: 6, ramp: [[0, '#331100'], [1, '#aa7744']], relief: 0.4 }, { kind: 'scratches', scale: 5, density: 0.5, color: '#ffffff' }], wear: { amount: 0.4, color: '#999999' }, roughen: { amount: 1.5 }, bevel: { size: 4, style: 'round', specular: 0.6 }, rim: { width: 5, shade: '#000000' }, sparkles: { count: 3 }, dropShadow: { color: '#000000', blur: 6, offset: [0, 5] }, outerGlow: { color: '#ff8800', size: 8 } } },
        { shape: { kind: 'rivets', radius: 4, inset: 8 }, style: { fill: '#dddddd', bevel: { size: 2 } } },
        { shape: { kind: 'glyph', name: 'sword', solid: true }, style: { fill: '#ffffff', strokes: [{ width: 2, paint: '#000000' }] }, at: [60, 30, 60, 60] },
      ],
    };
    const a = forge(spec);
    const b = forge(spec);
    expect(hash(a)).toBe(hash(b));
    expect(filled(a)).toBeGreaterThan(0.3);
    // Pixel art too.
    const px = forge({ ...spec, pixel: { size: 3 } });
    expect(hash(px)).toBe(hash(forge({ ...spec, pixel: { size: 3 } })));
  });

  it('blurs a point into a centred, conserved bump at any radius', () => {
    for (const sigma of [1, 4, 12]) {
      const f = field(101, 101);
      f.v[50 * 101 + 50] = 1;
      const b = blur(f, sigma);
      const sum = b.v.reduce((s, v) => s + v, 0);
      expect(sum).toBeCloseTo(1, 2);
      expect(b.v[50 * 101 + 50]!).toBeGreaterThan(b.v[50 * 101 + 50 + Math.ceil(sigma)]!);
      expect(b.v[50 * 101 + 49]!).toBeCloseTo(b.v[50 * 101 + 51]!, 5);
    }
  });

  it('gives every shape contours inside its box', () => {
    const shapes: ShapeSpec[] = [{ kind: 'star' }, { kind: 'sparkle', points: 8 }, { kind: 'heart' }, { kind: 'polygon', points: [[0, 0], [1, 0], [0.5, 1]] }, { kind: 'puffy', bump: 10 }, { kind: 'torn', rough: 3 }, { kind: 'drip', drips: 4 }, { kind: 'wave', side: 'both' }, { kind: 'studs', cols: 4 }, { kind: 'leaf', angle: 30 }, { kind: 'ring', thickness: 6 }, { kind: 'stairs', step: 4, steps: 2 }, { kind: 'arrow', dir: 'up' }];
    for (const s of shapes) {
      const c = shapeContours(s, 10, 10, 120, 80);
      expect(c.length, s.kind).toBeGreaterThan(0);
      for (const p of c.flat()) {
        expect(p[0]).toBeGreaterThan(-20);
        expect(p[1]).toBeGreaterThan(-20);
        expect(p[0]).toBeLessThan(150);
        expect(p[1]).toBeLessThan(110);
      }
    }
  });

  it('keeps 9-slice centres inside the art, past its corners', () => {
    for (const d of Object.values(DIRECTIONS))
      for (const r of [{ kind: 'button', size: [200, 56] }, { kind: 'card', variant: 'rare', size: [196, 214] }, { kind: 'window', size: [360, 240] }, { kind: 'pill', size: [190, 46] }, { kind: 'barFill', size: [240, 26] }, { kind: 'header', size: [420, 78] }] as ElementRequest[]) {
        const f = forge(d.element(r));
        const s = f.slice!;
        expect(s, `${d.id} ${r.kind}`).not.toBeNull();
        const [x0, y0, x1, y1] = s;
        expect(x0).toBeGreaterThanOrEqual(Math.round(f.margin * f.scale));
        expect(y0).toBeGreaterThanOrEqual(Math.round(f.margin * f.scale));
        expect(x1).toBeGreaterThan(x0);
        expect(y1).toBeGreaterThan(y0);
        expect(x1).toBeLessThanOrEqual(f.image.width - Math.round(f.margin * f.scale));
        expect(y1).toBeLessThanOrEqual(f.image.height - Math.round(f.margin * f.scale));
        // Symmetric corners: the right one as wide as the left.
        expect(Math.abs(f.image.width - x1 - x0)).toBeLessThanOrEqual(f.scale * 2 + 1);
      }
  });

  it('never draws an image over 1024 px, narrowing a sliced centre when even scale 1 is too big', () => {
    // The heaviest windows and the pixel-art path.
    for (const d of ['grunge', 'parchment', 'royal', 'aqua', 'pixel'].map((id) => DIRECTIONS[id]!)) {
      for (const r of [{ kind: 'window', size: [1600, 1200] }] as ElementRequest[]) {
        const f = forge(d.element(r));
        expect(f.image.width, `${d.id} ${r.kind}`).toBeLessThanOrEqual(MAX_IMAGE);
        expect(f.image.height, `${d.id} ${r.kind}`).toBeLessThanOrEqual(MAX_IMAGE);
        expect(f.scale).toBeGreaterThanOrEqual(1 / 3 - 1e-9);
        if (f.drawn) expect(f.drawn[0]).toBeLessThanOrEqual(1600);
      }
    }
    // Every kind of one direction at the largest size, sliced or not.
    for (const kind of ELEMENT_KINDS) {
      const f = forge(DIRECTIONS.candy!.element({ kind, size: [1600, 1200], text: 'BIG', glyph: 'star' }));
      expect(f.image.width, kind).toBeLessThanOrEqual(MAX_IMAGE);
      expect(f.image.height, kind).toBeLessThanOrEqual(MAX_IMAGE);
    }
    // Big art keeps 2x when it fits, and lowers the scale towards 1 when it doesn't.
    expect(forge(DIRECTIONS.candy!.element({ kind: 'card', size: [300, 300] })).scale).toBe(2);
    const mid = forge(DIRECTIONS.candy!.element({ kind: 'card', size: [700, 300] }));
    expect(mid.scale).toBeLessThan(2);
    expect(mid.scale).toBeGreaterThanOrEqual(1);
  });

  it('forges every element of every direction into real art', () => {
    for (const d of Object.values(DIRECTIONS))
      for (const r of requests()) {
        let f: Forged | undefined;
        expect(() => (f = forge(d.element(r))), `${d.id} ${r.kind} ${r.variant ?? ''}`).not.toThrow();
        if (r.kind === 'title' && !fonts) continue;
        // Thin elements (dividers) cover little of their canvas once shadows and glows add a margin.
        expect(filled(f!), `${d.id} ${r.kind} ${r.variant ?? ''}`).toBeGreaterThan(r.kind === 'divider' ? 0.02 : 0.08);
      }
  }, 120000);

  it('draws states: pressed sinks the face and moves the content, disabled greys, hover lights', () => {
    for (const d of Object.values(DIRECTIONS)) {
      const base: ElementRequest = { kind: 'button', variant: 'primary', size: [160, 50] };
      const normal = forge(d.element(base));
      const pressed = forge(d.element({ ...base, state: 'pressed' }));
      const disabled = forge(d.element({ ...base, state: 'disabled' }));
      const hover = forge(d.element({ ...base, state: 'hover' }));
      expect(hash(pressed), d.id).not.toBe(hash(normal));
      expect(hash(hover), d.id).not.toBe(hash(normal));
      expect(pressed.content?.[1] ?? 0, d.id).toBeGreaterThan(0);
      const sat = (c: [number, number, number]) => Math.max(...c) - Math.min(...c);
      expect(sat(faceColor(disabled, 160, 50)), d.id).toBeLessThan(sat(faceColor(normal, 160, 50)) + 1);
      // A variant still in a state: a danger button pressed stays danger-coloured, not primary.
      const danger = faceColor(forge(d.element({ kind: 'button', variant: 'danger', state: 'pressed', size: [160, 50] })), 160, 50);
      const primary = faceColor(pressed, 160, 50);
      expect(Math.abs(danger[0] - primary[0]) + Math.abs(danger[1] - primary[1]) + Math.abs(danger[2] - primary[2]), d.id).toBeGreaterThan(30);
    }
  });

  it('gives every button label 4.5:1 contrast on its face', () => {
    for (const d of Object.values(DIRECTIONS))
      for (const role of BUTTON_ROLES) {
        const f = forge(d.element({ kind: 'button', variant: role, size: [168, 50] }));
        const ink = inkFor(d, { kind: 'button', variant: role });
        expect(inkContrast(ink, faceColor(f, 168, 50)), `${d.id} ${role}`).toBeGreaterThanOrEqual(4.5);
      }
  });

  it('gives tab, card and pill labels 4.5:1 contrast on their surfaces', () => {
    for (const d of Object.values(DIRECTIONS)) {
      const checks: Array<[ElementRequest, [number, number, number, number]]> = [
        [{ kind: 'tab', variant: 'active', size: [150, 48] }, [0.25, 0.3, 0.75, 0.7]],
        [{ kind: 'tab', variant: 'inactive', size: [150, 48] }, [0.25, 0.3, 0.75, 0.7]],
        [{ kind: 'pill', size: [190, 46] }, [0.35, 0.3, 0.85, 0.7]],
        [{ kind: 'card', variant: 'common', size: [196, 214] }, [0.15, 0.53, 0.85, 0.64]],
        [{ kind: 'card', variant: 'legendary', size: [196, 214] }, [0.15, 0.53, 0.85, 0.64]],
      ];
      for (const [r, area] of checks) {
        const f = forge(d.element(r));
        expect(inkContrast(inkFor(d, r), faceColor(f, r.size[0], r.size[1], area)), `${d.id} ${r.kind} ${r.variant ?? ''}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps display faces for big text: a small label falls back to the body face', () => {
    for (const d of Object.values(DIRECTIONS)) {
      const big = inkFor(d, { kind: 'button', variant: 'primary' }, 30);
      const small = inkFor(d, { kind: 'button', variant: 'primary' }, 10);
      if (big.minSize && big.minSize > 10) expect(small.font, d.id).toBe(d.fonts.body);
      for (const k of ['tabOn', 'tabOff', 'onCard', 'muted', 'disabled'] as const) if (d.id !== 'pixel') expect(d.text[k].weight ?? 0, `${d.id} ${k}`).toBeGreaterThanOrEqual(600);
    }
  });

  it('gives every direction an ink for every surface', () => {
    for (const d of Object.values(DIRECTIONS)) {
      for (const k of ['title', 'button', 'tabOn', 'tabOff', 'onCard', 'onPill', 'muted', 'disabled'] as const) expect(d.text[k].color, `${d.id} ${k}`).toBeTruthy();
      for (const role of BUTTON_ROLES) expect(d.text.buttons[role].color, `${d.id} ${role}`).toBeTruthy();
      expect(d.backdrop).toBeTruthy();
    }
  });

  it('draws pixel art in hard-edged whole blocks', () => {
    const f = forge(DIRECTIONS.pixel!.element({ kind: 'button', variant: 'primary', size: [120, 42] }));
    const { width: W, height: H, data } = f.image;
    const k = Math.round(f.scale * 3);
    expect(k).toBeGreaterThan(1);
    for (let i = 3; i < data.length; i += 4) expect(data[i] === 0 || data[i] === 255).toBe(true);
    for (let y = 0; y + k <= H; y += k)
      for (let x = 0; x + k <= W; x += k) {
        const o = (y * W + x) * 4;
        const p = (y * W + x + k - 1) * 4;
        expect(data[p]).toBe(data[o]);
        expect(data[p + 3]).toBe(data[o + 3]);
      }
  });

  it('forges a typical element in under 150 ms at 2x', () => {
    const typical: ElementRequest[] = [
      { kind: 'button', variant: 'primary', size: [200, 56] },
      { kind: 'tab', variant: 'active', size: [150, 48] },
      { kind: 'card', variant: 'epic', size: [196, 214] },
      { kind: 'slot', variant: 'rare', size: [96, 96] },
      { kind: 'icon', glyph: 'sword', variant: 'epic', size: [96, 96] },
      { kind: 'pill', size: [190, 46] },
    ];
    // Warm up (fonts, glyphs, JIT).
    for (const d of Object.values(DIRECTIONS)) forge(d.element(typical[0]!));
    const times: number[] = [];
    for (const d of Object.values(DIRECTIONS))
      for (const r of typical) {
        const t0 = performance.now();
        const f = forge(d.element(r));
        times.push(performance.now() - t0);
        expect(f.scale).toBe(2);
      }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const p90 = times[Math.floor(times.length * 0.9)]!;
    expect(median).toBeLessThan(150);
    // Loaded test machines are slower: a wide ceiling for the slowest, still far under the old 0.5–25 s.
    expect(p90).toBeLessThan(400);
  }, 120000);
});
