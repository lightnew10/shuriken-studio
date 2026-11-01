import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJpeg } from '@core/look/jpeg-decode';
import { analyzeLook, critiqueLook, decodeImage, type LookOptions } from '@core/look/look-analysis';
import type { RgbaImage } from '@core/modeling/png';
import { ROLES } from '@core/agents/roles';
import type { CallerContext } from '@core/capabilities/tool-registry';
import { coreHarness } from './helpers/make-core';

// Look analysis (core/look): a baseline JPEG decoder for Studio's screenshots, and measurements an art director
// checks, turned into likely problems. The fixtures are a synthetic scene written by Pillow's libjpeg
// (tests/fixtures/look); the scenes below are painted in code, so every finding is tied to a known cause.
const FIX = join(__dirname, 'fixtures', 'look');
const SKY = [110, 160, 230];
const GROUND = [150, 100, 60];
const BOX = [30, 30, 40];

/** The fixture scene: sky above 40% of the height, ground below, a dark box low in the middle. */
function expected(x: number, y: number, w: number, h: number): number[] {
  if (y < Math.floor(h * 0.4)) return SKY;
  if (x >= Math.floor(w * 0.42) && x < Math.floor(w * 0.58) && y >= Math.floor(h * 0.56) && y < Math.floor(h * 0.81)) return BOX;
  return GROUND;
}

/** Mean absolute error against the scene, away from the colour edges (JPEG rings and chroma bleeds there). */
function error(img: RgbaImage, grey = false): { mean: number; max: number } {
  let sum = 0;
  let n = 0;
  let max = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const e = expected(x, y, img.width, img.height);
      const near = [-3, 3].some((d) => expected(x + d, y, img.width, img.height) !== e || expected(x, y + d, img.width, img.height) !== e);
      if (near) continue;
      const want = grey ? [0, 0, 0].map(() => Math.round(e[0]! * 0.299 + e[1]! * 0.587 + e[2]! * 0.114)) : e;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(img.data[(y * img.width + x) * 4 + c]! - want[c]!);
        sum += d;
        max = Math.max(max, d);
        n++;
      }
    }
  }
  return { mean: sum / n, max };
}

describe('the JPEG decoder', () => {
  it('decodes baseline 4:2:0 (what Studio writes), 4:4:4 with restart markers, 4:2:2 at odd sizes, and grey', () => {
    const a = decodeJpeg(readFileSync(join(FIX, 'scene-420.jpg')));
    expect([a.width, a.height]).toEqual([96, 64]);
    // (Against Pillow's own decode of Studio screenshots the decoder differs by at most 3 levels at 4:4:4 and in grey;
    // the error here is mostly JPEG's own ringing, which reaches a whole 8-px block from an edge.)
    expect(error(a).mean).toBeLessThan(2.5);
    expect(error(a).max).toBeLessThan(32);
    const b = decodeJpeg(readFileSync(join(FIX, 'scene-444-restart.jpg')));
    expect(error(b).mean).toBeLessThan(1.5);
    expect(error(b).max).toBeLessThan(32);
    const c = decodeJpeg(readFileSync(join(FIX, 'odd-422.jpg')));
    expect([c.width, c.height]).toEqual([37, 29]);
    expect(error(c).mean).toBeLessThan(3);
    const g = decodeJpeg(readFileSync(join(FIX, 'scene-gray.jpg')));
    expect(error(g, true).mean).toBeLessThan(1.5);
    expect(g.data[0]).toBe(g.data[1]);
    expect(g.data[3]).toBe(255);
  });

  it('says plainly what it does not decode, and never hangs on a cut-off file', () => {
    expect(() => decodeJpeg(readFileSync(join(FIX, 'scene-progressive.jpg')))).toThrow(/progressive/);
    expect(() => decodeImage(Buffer.from('GIF89a........'))).toThrow(/not a JPEG or PNG/);
    const whole = readFileSync(join(FIX, 'scene-420.jpg'));
    const cut = whole.subarray(0, Math.floor(whole.length * 0.6));
    let img: RgbaImage | null = null;
    try {
      img = decodeJpeg(cut);
    } catch (e) {
      expect((e as Error).message).toMatch(/JPEG/);
    }
    if (img) expect([img.width, img.height]).toEqual([96, 64]);
  });
});

// ─── Painted scenes ──────────────────────────────────────────────────────────

function paint(w: number, h: number, f: (x: number, y: number) => number[]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const o = (y * w + x) * 4;
      data[o] = Math.max(0, Math.min(255, Math.round(r!)));
      data[o + 1] = Math.max(0, Math.min(255, Math.round(g!)));
      data[o + 2] = Math.max(0, Math.min(255, Math.round(b!)));
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const W = 320;
const H = 180;
const HORIZON = Math.round(H * 0.4);
/** Sky with a gradient, a ground of patches, dark props, a few light stones and one red accent. */
function goodScene(): RgbaImage {
  return paint(W, H, (x, y) => {
    if (y < HORIZON) {
      const t = y / HORIZON;
      return [120 + 70 * t, 170 + 45 * t, 235 + 5 * t];
    }
    const cell = ((x >> 5) + (y >> 4)) % 3;
    if (x % 64 > 40 && x % 64 < 56 && y > 100 && y < 150) return [38, 36, 40];
    if (x % 80 > 70 && y > 150 && y < 162) return [225, 220, 205];
    if (x > 150 && x < 160 && y > 110 && y < 125) return [200, 45, 40];
    return cell === 0 ? [92, 124, 64] : cell === 1 ? [140, 112, 80] : [116, 120, 72];
  });
}
const problems = (img: RgbaImage, o: LookOptions = {}) => critiqueLook(analyzeLook(img, o), o).problems;
const titles = (img: RgbaImage, o: LookOptions = {}) => problems(img, o).map((p) => p.split(':')[0]!);

describe('what the analysis measures', () => {
  it('a readable sunny frame: mid-key, a horizon where it is, several hue families, nothing to fix', () => {
    const a = analyzeLook(goodScene());
    expect(a.blank).toBe(false);
    expect(a.exposure.key).toBe('mid');
    expect(a.contrast.range).toBeGreaterThan(35);
    expect(a.horizon!.y).toBeGreaterThan(0.35);
    expect(a.horizon!.y).toBeLessThan(0.45);
    expect(a.colour.families).toBeGreaterThanOrEqual(2);
    expect(a.colour.palette.length).toBeGreaterThanOrEqual(3);
    expect(a.colour.palette.every((p) => /^#[0-9a-f]{6}$/.test(p.hex))).toBe(true);
    expect(a.exposure.histogram.reduce((s, v) => s + v, 0)).toBeGreaterThanOrEqual(98);
    const c = critiqueLook(a);
    expect(c.problems).toEqual([]);
    expect(c.seen).toMatch(/^mid-key: L\* median \d+ \(5-95%: \d+-\d+\)/);
    expect(c.seen).toMatch(/horizon 4\d% from the top/);
    expect(c.seen.length).toBeLessThan(900);
  });

  it('one flat colour is "nothing to measure", not a list of problems', () => {
    const c = critiqueLook(analyzeLook(paint(200, 100, () => [0, 0, 0])));
    expect(c.problems).toHaveLength(1);
    expect(c.problems[0]).toMatch(/one flat colour: Studio wasn't drawing/);
  });

  it('monochrome orange with a warm cast (the dusk arena of 2026-10-01): monochrome always, the cast forgiven only up to a limit at dusk', () => {
    const r = rng(3);
    const img = paint(W, H, (x, y) => {
      if (y < HORIZON) return [235, 160, 100];
      const v = r() < 0.15 ? 0.35 : r() < 0.1 ? 1.5 : 1;
      return [150 * v, 92 * v, 52 * v];
    });
    const a = analyzeLook(img);
    expect(a.colour.dominant!.name).toBe('orange');
    expect(a.colour.dominant!.share).toBeGreaterThan(0.8);
    expect(titles(img)).toEqual(expect.arrayContaining(['Monochrome', 'Strong warm (orange-yellow) cast']));
    const dusk = titles(img, { mood: 'dusk' });
    expect(dusk).toContain('Monochrome');
    if (Math.hypot(a.colour.castA, a.colour.castB) < 40) expect(dusk).not.toContain('Strong warm (orange-yellow) cast');
  });

  it('a dark frame is "Dark" by day and fine at night, unless it is too dark even for night', () => {
    const scene = goodScene();
    const dim = paint(W, H, (x, y) => [0, 1, 2].map((c) => scene.data[(y * W + x) * 4 + c]! * 0.22));
    expect(titles(dim)).toContain('Dark');
    expect(titles(dim, { mood: 'night' })).not.toContain('Dark');
    const black = paint(W, H, (x, y) => [0, 1, 2].map((c) => scene.data[(y * W + x) * 4 + c]! * 0.12));
    expect(titles(black, { mood: 'night' }).some((t) => t.startsWith('Too dark even for night'))).toBe(true);
    // A dark UI theme is a style, not a problem.
    expect(titles(dim, { view: 'ui' })).not.toContain('Dark');
  });

  it('a washed-out frame is flat, and says why (no darks)', () => {
    const r = rng(5);
    const img = paint(W, H, (_x, y) => (y < HORIZON ? [200, 205, 212] : [150 + 30 * r(), 148 + 30 * r(), 140 + 30 * r()]));
    const p = problems(img);
    expect(p.some((x) => /^Flat: values span only \d+ L\*.*washed out/.test(x))).toBe(true);
  });

  it('haze that swallows the distance: the band under the horizon is nearly the sky and flat, the foreground has contrast', () => {
    const hazy = (sky: number[]) =>
      paint(W, H, (x, y) => {
        if (y < HORIZON) return sky;
        if (y < HORIZON + 30) return [190 + (x / W) * 4, 190 + (x / W) * 4, 194];
        // Stripes that average the far band's colour, so the strongest boundary is the horizon itself.
        return (x >> 3) % 2 ? [130, 130, 134] : [250, 250, 254];
      });
    const img = hazy([218, 219, 228]);
    const a = analyzeLook(img);
    expect(a.horizon!.y).toBeCloseTo(0.4, 1);
    expect(a.depth!.ratio).toBeLessThan(0.25);
    expect(titles(img)).toContain('Haze swallows the distance');
    expect(titles(img, { mood: 'overcast' })).not.toContain('Haze swallows the distance');
    // Thicker: the far band and the sky merge, so no horizon is left to find.
    const thick = hazy([196, 196, 200]);
    expect(analyzeLook(thick).horizon).toBeNull();
    expect(problems(thick).some((p) => p.startsWith('Haze swallows the distance: there is no horizon to see'))).toBe(true);
  });

  it('a speckled ground (a noisy material on a big surface) and blown highlights below the horizon', () => {
    const r = rng(9);
    const speckle = paint(W, H, (_x, y) => (y < HORIZON ? [130, 175, 230] : [0, 0, 0].map(() => 90 + (r() - 0.5) * 120)));
    const a = analyzeLook(speckle);
    expect(a.detail.noisePlay).toBeGreaterThan(3);
    expect(titles(speckle)).toContain('Speckled');
    const blown = paint(W, H, (x, y) => (y < HORIZON ? [130, 175, 230] : x < 40 ? [255, 255, 255] : [120, 100, 70]));
    expect(titles(blown)).toContain('Blown highlights');
  });

  it('a grey baseplate ground and a bare plain are named as such', () => {
    const grey = paint(W, H, (_x, y) => (y < HORIZON ? [120, 180, 235] : [100, 100, 100]));
    expect(titles(grey)).toContain('The ground is grey (chroma 0)');
    const bare = paint(W, H, (_x, y) => (y < HORIZON ? [120, 180, 235] : [130, 110, 80]));
    expect(titles(bare)).toContain('Bare');
    expect(titles(bare, { view: 'overview' })).not.toContain('Bare');
  });

  it('crushed blacks', () => {
    const img = paint(W, H, (x, y) => (y < HORIZON ? [120, 170, 230] : x < 80 ? [0, 0, 0] : [120, 100, 70]));
    expect(titles(img)).toContain('Crushed blacks');
  });

  it('regions: a target that blends into its surroundings is named, one that stands out is not', () => {
    const img = paint(W, H, (x, y) => {
      if (y < HORIZON) return [130, 175, 230];
      if (x >= 60 && x < 80 && y >= 110 && y < 140) return [124, 122, 118];
      if (x >= 220 && x < 240 && y >= 110 && y < 140) return [220, 40, 40];
      return [120, 118, 114];
    });
    const regions = [
      { name: 'grey mech', box: [60 / W, 110 / H, 80 / W, 140 / H] as [number, number, number, number] },
      { name: 'red mech', box: [220 / W, 110 / H, 240 / W, 140 / H] as [number, number, number, number] },
    ];
    const a = analyzeLook(img, { regions });
    expect(a.regions.map((r) => r.name)).toEqual(['grey mech', 'red mech']);
    expect(a.regions[1]!.dE).toBeGreaterThan(40);
    const p = critiqueLook(a, { regions }).problems;
    expect(p.some((x) => x.startsWith("grey mech doesn't separate"))).toBe(true);
    expect(p.some((x) => x.startsWith('red mech'))).toBe(false);
    expect(critiqueLook(a, { regions }).seen).toMatch(/red mech: L\* [\d.]+ against [\d.]+ around it \(ΔL\* [-+\d.]+, ΔE [\d.]+\)/);
  });

  it('never words a finding as taste: no "ugly", "beautiful" or "looks good"', () => {
    const all = [goodScene(), paint(W, H, () => [10, 10, 10])].flatMap((img) => problems(img).concat(critiqueLook(analyzeLook(img)).seen));
    for (const t of all) expect(t).not.toMatch(/\b(ugly|beautiful|pretty|looks good|looks bad)\b/i);
  });
});

describe('look_analyze, the tool', () => {
  const makeCore = coreHarness();

  it('measures a task screenshot for the roles that judge looks, and is hidden from the others', async () => {
    const { core, ctx } = await makeCore({ respond: async () => ({}) });
    const task = ctx.tasks.create({ kind: 'implement', title: 'Arena lighting', objective: 'x', role: 'environment-artist', createdBy: 't', status: 'done', acceptanceCriteria: ['lit'], verification: [] });
    const file = join(ctx.dir, 'evidence', `${task.id}-1.jpg`);
    copyFileSync(join(FIX, 'scene-420.jpg'), file);
    const ev = ctx.tasks.addEvidence({ taskId: task.id, runId: null, kind: 'screenshot', title: 'overview', passed: null, data: null, path: file });
    const caller = (role: string): CallerContext => ({ kind: 'agent', runId: 'run_x', taskId: task.id, role, providerId: null, allowedTools: null });

    const out = await core.tools.invoke('look_analyze', {}, caller('environment-artist'));
    expect(out.isError).toBeFalsy();
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain(`overview (${ev.id})`);
    expect(text).toMatch(/seen: (low|mid|high)-key: L\* median/);
    expect(text).toMatch(/likely problems/);

    const byId = await core.tools.invoke('look_analyze', { evidence: [ev.id], view: 'overview', regions: [{ name: 'box', box: [0.42, 0.56, 0.58, 0.81] }] }, caller('critic'));
    expect((byId.content[0] as { text: string }).text).toMatch(/box: L\* [\d.]+ against/);

    const outside = await core.tools.invoke('look_analyze', { file: '../elsewhere.jpg' }, caller('level-designer'));
    expect(outside.isError).toBe(true);

    for (const role of ['environment-artist', 'level-designer', 'ui-engineer', 'critic']) expect(core.tools.visibleTo(caller(role)).some((t) => t.name === 'look_analyze'), role).toBe(true);
    expect(core.tools.visibleTo(caller('roblox-engineer')).some((t) => t.name === 'look_analyze')).toBe(false);
    expect(ROLES.critic!.appTools).toContain('look_analyze');
  });
});
