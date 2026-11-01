import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UiNode } from '../src/shared/ui-layout';
import { forgeSize, parseSkin, skinFile, skinKey } from '../src/core/ui/forge/spec';
import { MAX_IMAGE_PX, prepareSkins, SkinForge } from '../src/core/ui/forge/resolve';
import { AtlasStore, forgeForBuild, packAtlases, pointSkins } from '../src/core/ui/forge/publish';

const find = (n: UiNode, name: string): UiNode | null => (n.name === name ? n : (n.kids ?? []).map((k) => find(k, name)).find(Boolean) ?? null);

const shop = (): UiNode => ({
  id: 1,
  name: 'Shop',
  cls: 'ScreenGui',
  kids: [
    {
      id: 2,
      name: 'Window',
      cls: 'Frame',
      size: [0, 420, 0, 300],
      skin: 'candy:window',
      bg: [255, 0, 0],
      kids: [{ id: 3, name: 'Buy', cls: 'TextButton', size: [0, 180, 0, 56], skin: 'candy:button:primary', text: 'BUY', textSize: 24, font: 'FredokaOne', textColor: [255, 255, 255] }],
    },
  ],
});

describe('skin specs', () => {
  it('parses directions, kinds, variants, glyphs, titles and accents', () => {
    expect(parseSkin('candy:button:primary')).toEqual({ spec: { direction: 'candy', kind: 'button', variant: 'primary' } });
    expect(parseSkin('ember:icon:sword:legendary')).toEqual({ spec: { direction: 'ember', kind: 'icon', glyph: 'sword', variant: 'legendary' } });
    expect(parseSkin('candy:title:DAILY REWARD')).toEqual({ spec: { direction: 'candy', kind: 'title', text: 'DAILY REWARD' } });
    expect(parseSkin('neon:window#ff7ab8')).toEqual({ spec: { direction: 'neon', kind: 'window', accent: '#ff7ab8' } });
    expect('error' in parseSkin('nope:button')).toBe(true);
    expect('error' in parseSkin('candy:spaceship')).toBe(true);
    expect('error' in parseSkin('candy:button:sparkly')).toBe(true);
  });

  it('forges at the offset size, or the kind\'s nominal size for a scaled axis', () => {
    expect(forgeSize('button', [0, 180, 0, 56])).toEqual([180, 56]);
    expect(forgeSize('button', [0.5, 0, 0, 60])).toEqual([200, 60]);
    expect(forgeSize('window', undefined)).toEqual([720, 480]);
  });

  it('names cache files stably and safely', () => {
    const k = skinKey('candy:title:DAILY REWARD', [380.4, 100]);
    expect(k).toBe('candy:title:DAILY REWARD@380x100');
    expect(skinFile(k)).toBe(skinFile(k));
    expect(skinFile(k)).toMatch(/^[A-Za-z0-9-]+$/);
    expect(skinFile(k)).not.toBe(skinFile(skinKey('candy:title:DAILY REWARD', [381, 100])));
  });
});

describe('wearing skins', () => {
  it('puts the art under the content, turns the fill off and lifts the text above it', () => {
    const p = prepareSkins([shop()]);
    expect(p.errors).toEqual([]);
    const win = find(p.screens[0]!, 'Window')!;
    expect(win.bgT).toBe(1);
    const art = win.kids![0]!;
    expect(art.name).toBe('Skin');
    expect(art.cls).toBe('ImageLabel');
    expect(art.image).toMatch(/^skin:candy:window@420x300$/);
    // Drawn at the size it was forged at: stretched, exactly (Roblox crops a 9-slice centre it would have to shrink).
    expect(art.scaleType).toBe('Stretch');
    const buy = find(p.screens[0]!, 'Buy')!;
    expect(buy.text).toBe('');
    const label = find(buy, 'Label')!;
    expect(label.text).toBe('BUY');
    expect(label.z).toBeGreaterThan(find(buy, 'Skin')!.z ?? 0);
    const img = p.images(art.image!);
    expect(img && img.width > 0).toBe(true);
    expect(p.used.size).toBe(2);
  });

  it('gives a resizable element 9-sliced art with a narrow centre that only stretches', () => {
    const s = shop();
    s.kids![0]!.size = [0.5, 0, 0.6, 0];
    const p = prepareSkins([s]);
    const art = find(p.screens[0]!, 'Window')!.kids![0]!;
    expect(art.image).toMatch(/~9$/);
    expect(art.scaleType).toBe('Slice');
    const img = p.images(art.image!)!;
    const [x0, y0, x1, y1] = art.slice!;
    // The centre has at most a few pixels: any element bigger than the corners stretches it.
    expect(x1 - x0).toBeLessThanOrEqual(8);
    expect(y1 - y0).toBeLessThanOrEqual(8);
    expect(img.width).toBeGreaterThan(x1);
  });

  it('reports unknown specs and leaves the element as designed', () => {
    const s = shop();
    s.kids![0]!.skin = 'candy:spaceship';
    const p = prepareSkins([s]);
    expect(p.errors.join(' ')).toContain('spaceship');
    expect(find(p.screens[0]!, 'Window')!.bg).toEqual([255, 0, 0]);
  });

  it('caches forged art on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-cache-'));
    const a = new SkinForge(dir).get('candy:button:primary', [180, 56]);
    expect('forged' in a).toBe(true);
    const b = new SkinForge(dir).forged((a as { key: string }).key);
    expect(b?.image.width).toBe((a as { forged: { image: { width: number } } }).forged.image.width);
  });

  it('keeps every image within what Roblox loads (1024 px a side)', () => {
    const sf = new SkinForge(null);
    for (const size of [[1600, 1200], [1200, 300]] as Array<[number, number]>) {
      const got = sf.get('ember:window', size);
      expect('forged' in got).toBe(true);
      const f = (got as { forged: { image: { width: number; height: number } } }).forged;
      expect(Math.max(f.image.width, f.image.height)).toBeLessThanOrEqual(MAX_IMAGE_PX);
    }
  }, 60_000);
});

describe('skins into the game', () => {
  it('packs the art into atlases, points each skin at its sprite, and uses the upload once there is one', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-build-'));
    const s = shop();
    s.kids![0]!.kids![0]!.states = { press: { skin: 'candy:button:primary:pressed' } };
    const built = forgeForBuild({ desktop: [s] }, new SkinForge(null));
    expect(built.errors).toEqual([]);
    expect(built.art.size).toBe(3);
    const packed = packAtlases([...built.art].map(([key, f]) => ({ key, image: f.image })));
    expect(packed.atlases.length).toBe(1);
    for (const a of packed.atlases) expect(Math.max(a.image.width, a.image.height)).toBeLessThanOrEqual(1024);
    // Each sprite is the art, pixel for pixel, at its rect.
    for (const [key, f] of built.art) {
      const p = packed.placements.get(key)!;
      const atlas = packed.atlases.find((x) => x.hash === p.atlas)!.image;
      expect([p.rect[2], p.rect[3]]).toEqual([f.image.width, f.image.height]);
      const mid = ((p.rect[1] + (f.image.height >> 1)) * atlas.width + p.rect[0] + (f.image.width >> 1)) * 4;
      const src = ((f.image.height >> 1) * f.image.width + (f.image.width >> 1)) * 4;
      expect([...atlas.data.subarray(mid, mid + 4)]).toEqual([...f.image.data.subarray(src, src + 4)]);
    }
    const store = new AtlasStore(root);
    store.save(packed);
    const hash = packed.atlases[0]!.hash;
    expect(existsSync(store.file(hash))).toBe(true);

    let pointed = pointSkins(built.worn, packed.placements, store.all());
    expect(pointed.previews).toEqual([hash]);
    const buy = find(pointed.forms.desktop![0]!, 'Buy')!;
    const art = find(buy, 'Skin')!;
    expect(art.image).toBe(`rbxasset://shuriken-forge/atlas-${hash}.png`);
    expect(art.rect).toEqual(packed.placements.get(find(built.worn.desktop![0]!, 'Buy')!.kids![0]!.image!.slice(5))!.rect);
    expect(buy.states!.press!.skinArt!.rect).toBeDefined();
    expect(buy.states!.press!.skinArt!.image).toBe(art.image);

    // Uploaded: the image id, and the same pixels are the same atlas (no second upload).
    store.update(hash, { imageId: '123456789' });
    const again = packAtlases([...forgeForBuild({ desktop: [s] }, new SkinForge(null)).art].map(([key, f]) => ({ key, image: f.image })));
    expect(again.atlases[0]!.hash).toBe(hash);
    pointed = pointSkins(built.worn, again.placements, store.save(again));
    expect(pointed.previews).toEqual([]);
    expect(find(pointed.forms.desktop![0]!, 'Skin')!.image).toBe('rbxassetid://123456789');
  });

  it('covers a padded element with its art, padding and all', async () => {
    const s = shop();
    const buy = s.kids![0]!.kids![0]!;
    buy.padding = [[0, 4], [0, 6], [0, 4], [0, 54]];
    const { layoutScreen } = await import('../src/shared/ui-layout');
    const worn = prepareSkins([s]).screens[0]!;
    const boxes = layoutScreen(worn, { w: 1280, h: 720, topbar: 0, side: 0 } as never);
    const b = boxes.find((x) => x.path.endsWith('.Buy'))!;
    const art = boxes.find((x) => x.path.endsWith('.Buy.Skin'))!;
    const m = (art.w - b.w) / 2;
    expect(m).toBeGreaterThan(0);
    expect(art.x).toBeCloseTo(b.x - m, 3);
    expect(art.y).toBeCloseTo(b.y - (art.h - b.h) / 2, 3);
    // The text sits in the padded area once (not padded twice).
    const label = boxes.find((x) => x.path.endsWith('.Buy.Label'))!;
    expect(label.x).toBeCloseTo(b.x + 54, 3);
    expect(label.w).toBeCloseTo(b.w - 60, 3);
  });
});

describe('game concepts as glyphs', () => {
  it('draws a game word the icon names lack with its best glyph', async () => {
    const { glyphName, glyphSet, searchGlyphs } = await import('../src/core/ui/ui-glyphs');
    const set = glyphSet(join(__dirname, '..', 'resources'))!;
    expect(set.concepts && Object.keys(set.concepts).length).toBeGreaterThan(400);
    expect(glyphName(set, 'sword')).toBe('sword');
    const rebirth = glyphName(set, 'rebirth');
    expect(rebirth && set.icons[rebirth]).toBeTruthy();
    expect(searchGlyphs(set, 'rebirth')[0]).toBe(rebirth);
    expect(glyphName(set, 'no-such-thing-at-all')).toBeNull();
  });
});

describe('state art', () => {
  it('parses a variant with a state', () => {
    expect(parseSkin('ember:button:danger:pressed')).toEqual({ spec: { direction: 'ember', kind: 'button', variant: 'danger', state: 'pressed' } });
    expect('error' in parseSkin('ember:button:danger:sideways')).toBe(true);
  });

  it('forges each state\'s art and swaps it on the Skin child (the text follows a sunk face)', async () => {
    const { withState } = await import('../src/shared/ui-layout');
    const s = shop();
    const buy = s.kids![0]!.kids![0]!;
    buy.states = { press: { skin: 'candy:button:primary:pressed', scale: 0.97 }, hover: { textColor: [255, 240, 120] } };
    const p = prepareSkins([s]);
    expect(p.errors).toEqual([]);
    const worn = find(p.screens[0]!, 'Buy')!;
    const press = worn.states!.press!;
    expect(press.skinArt?.image).toMatch(/^skin:candy:button:primary:pressed@180x56$/);
    expect(press.scale).toBe(0.97);
    expect(p.images(press.skinArt!.image)).toBeTruthy();
    // Hover's text colour moved to the Label, where the text is.
    expect(worn.states!.hover!.textColor).toBeUndefined();
    expect(worn.states!.hover!.label?.textColor).toEqual([255, 240, 120]);
    const pressed = withState(worn, 'press');
    expect(find(pressed, 'Skin')!.image).toBe(press.skinArt!.image);
    const shown = withState(worn, 'hover');
    expect(find(shown, 'Label')!.textColor).toEqual([255, 240, 120]);
  });

  it('reports a state skin on an element that wears none', () => {
    const s = shop();
    const buy = s.kids![0]!.kids![0]!;
    delete buy.skin;
    buy.states = { press: { skin: 'candy:button:pressed' } };
    expect(prepareSkins([s]).errors.join(' ')).toContain('wears no skin');
  });
});

describe('directions for a reference', () => {
  it('ranks a direction first for a picture in its own colours', async () => {
    const { matchDirections } = await import('../src/core/ui/forge/match');
    const { DIRECTIONS } = await import('../src/core/ui/forge/directions');
    let right = 0;
    const ids = Object.keys(DIRECTIONS);
    for (const id of ids) {
      const hexes = Object.values(DIRECTIONS[id]!.palette).filter((v): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
      const got = matchDirections({ main: hexes.map((hex) => ({ hex, share: 1 / hexes.length })), accents: [] });
      if (got[0]?.id === id) right++;
    }
    expect(right / ids.length).toBeGreaterThanOrEqual(0.8);
  });
});

describe('the Lab on skins', () => {
  it('flags art squeezed below its 9-slice corners', async () => {
    const { labCheck, gameSubject } = await import('../src/core/ui/lab/lab');
    const s: UiNode = { id: 1, name: 'Hud', cls: 'ScreenGui', kids: [{ id: 2, name: 'Tiny', cls: 'Frame', pos: [0.5, 0, 0.5, 0], size: [0, 60, 0, 30], skin: 'candy:window' }] };
    // Forged at its own size it fits; at a nominal size (scaled) and drawn small, the corners collide.
    s.kids![0]!.size = [0.05, 0, 0.04, 0];
    const r = labCheck(gameSubject('t', [s]), { devices: ['phone-small'] });
    expect(r.findings.some((f) => f.path === 'Hud.Tiny' && /9-slice/.test(f.message))).toBe(true);
  }, 60_000);
});

describe('ink', () => {
  it('gives skinned text the direction\'s ink where the design leaves it unset, and a disabled state its own', () => {
    const s = shop();
    const buy = s.kids![0]!.kids![0]!;
    delete buy.textColor;
    delete buy.font;
    buy.states = { disabled: { skin: 'candy:button:primary:disabled' } };
    const p = prepareSkins([s]);
    const worn = find(p.screens[0]!, 'Buy')!;
    const label = find(worn, 'Label')!;
    expect(label.textColor).toBeDefined();
    expect(label.font).toBeDefined();
    const dis = worn.states!.disabled!;
    expect(dis.label?.textColor ?? dis.textColor).toBeDefined();
    // A colour the designer chose stays.
    const kept = prepareSkins([shop()]);
    expect(find(find(kept.screens[0]!, 'Buy')!, 'Label')!.textColor).toEqual([255, 255, 255]);
  });
});

describe('batch forging (the GPU hook)', () => {
  it('forges a screen set in two batches, and wearing after is the same art as forging on demand', async () => {
    const { setForgeBatch, warmSkins } = await import('../src/core/ui/forge/resolve');
    const { forge } = await import('../src/core/ui/forge/forge');
    const s = shop();
    s.kids![0]!.kids![0]!.states = { press: { skin: 'candy:button:primary:pressed' } };
    s.kids!.push({ id: 9, name: 'Bar', cls: 'Frame', pos: [0, 0, 0, 0], size: [0.5, 0, 0, 20], skin: 'candy:barFill' });
    const batches: number[] = [];
    setForgeBatch(async (specs) => {
      batches.push(specs.length);
      return specs.map((x) => forge(x));
    });
    try {
      const warm = new SkinForge(null);
      await warmSkins([s], warm);
      expect(batches.length).toBeGreaterThanOrEqual(1);
      expect(batches.length).toBeLessThanOrEqual(2);
      expect(batches[0]).toBe(4);
      const a = prepareSkins([s], warm);
      const b = prepareSkins([s], new SkinForge(null));
      expect([...a.used.keys()].sort()).toEqual([...b.used.keys()].sort());
      for (const [k, f] of a.used) {
        const g = b.used.get(k)!;
        expect([f.image.width, f.image.height, f.slice]).toEqual([g.image.width, g.image.height, g.slice]);
        expect(Buffer.from(f.image.data).equals(Buffer.from(g.image.data))).toBe(true);
      }
    } finally {
      setForgeBatch(null);
    }
  }, 60_000);
});

describe('state text outlines', () => {
  it('moves a state\'s letter stroke to the Label and leaves a border stroke on the element', async () => {
    const { withState } = await import('../src/shared/ui-layout');
    const s = shop();
    const buy = s.kids![0]!.kids![0]!;
    delete buy.stroke;
    buy.states = { selected: { skin: 'candy:button:primary:hover', strokes: [{ color: [10, 10, 10], t: 0, px: 3, text: true }, { color: [255, 0, 0], t: 0, px: 2, text: false }] } };
    const worn = find(prepareSkins([s]).screens[0]!, 'Buy')!;
    const sel = worn.states!.selected!;
    expect(sel.label?.stroke?.text).toBe(true);
    expect(sel.stroke?.text).toBe(false);
    const on = withState(worn, 'selected');
    expect(find(on, 'Label')!.stroke?.px).toBe(3);
  });
});

describe('fx', () => {
  it('forges light in any colour for every direction, and refuses an unknown effect', () => {
    expect(parseSkin('fx:glow#ffd23f')).toEqual({ spec: { direction: 'fx', kind: 'glow', accent: '#ffd23f' } });
    expect('error' in parseSkin('fx:lasers')).toBe(true);
    const sf = new SkinForge(null);
    for (const k of ['glow', 'rays', 'halo', 'sparkles', 'shine', 'vignette', 'spotlight']) {
      const g = sf.get(`fx:${k}#88ccff`, [160, 160], 'stretch');
      expect('forged' in g).toBe(true);
      const img = (g as { forged: { image: { data: Uint8Array } } }).forged.image;
      expect(img.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
    }
    const s: UiNode = { id: 1, name: 'S', cls: 'ScreenGui', kids: [{ id: 2, name: 'Glow', cls: 'ImageLabel', size: [0, 200, 0, 200], skin: 'fx:glow#ffd23f' }] };
    expect(prepareSkins([s]).errors).toEqual([]);
  });
});

describe('screens that hide Roblox UI while open', () => {
  it('no chat or touch-control findings for a screen that hides them', async () => {
    const { labCheck, gameSubject } = await import('../src/core/ui/lab/lab');
    const shopScreen = (hides?: string): UiNode => ({
      id: 1, name: 'Shop', cls: 'ScreenGui', ...(hides ? { hides } : {}),
      kids: [{ id: 2, name: 'Window', cls: 'Frame', pos: [0, 0, 0, 0], size: [1, 0, 1, 0], bg: [40, 40, 60], kids: [
        { id: 3, name: 'Buy', cls: 'TextButton', pos: [0, 20, 0, 70], size: [0, 160, 0, 50], text: 'BUY', textSize: 22, bg: [60, 200, 90] },
        { id: 4, name: 'Sell', cls: 'TextButton', anchor: [1, 1], pos: [1, -20, 1, -20], size: [0, 160, 0, 50], text: 'SELL', textSize: 22, bg: [200, 60, 60] },
      ] }],
    });
    const roblox = (r: ReturnType<typeof labCheck>) => r.findings.filter((f) => f.category === 'roblox-ui');
    const open = labCheck(gameSubject('t', [shopScreen()]), { devices: ['ipad', 'laptop', 'phone-notch'] });
    const hidden = labCheck(gameSubject('t', [shopScreen('chat playerList touch')]), { devices: ['ipad', 'laptop', 'phone-notch'] });
    expect(roblox(open).length).toBeGreaterThan(0);
    expect(roblox(hidden).filter((f) => /chat|thumbstick|jump|player list/i.test(f.message))).toEqual([]);
  }, 60_000);
});

describe('art on elements that lay out their children', () => {
  it('lays a Folder\'s children out in the parent\'s padded area, outside its list (as measured in Studio)', async () => {
    const { layoutScreen } = await import('../src/shared/ui-layout');
    // Studio, 2026-10-10: Padded [100,100,400,120] with padding t10 r20 b10 l30 and a horizontal list:
    // Art.Skin [120,100,370,120], Art.Label [130,110,350,100], A [130,120,80,80]; nested folders: Deep [300,505].
    const screen: UiNode = { id: 1, name: 'S', cls: 'ScreenGui', ignoreInset: true, kids: [
      { id: 2, name: 'Padded', cls: 'Frame', pos: [0, 100, 0, 100], size: [0, 400, 0, 120], padding: [[0, 10], [0, 20], [0, 10], [0, 30]], list: { dir: 'Horizontal', h: 'Left', v: 'Center', pad: [0, 10] }, kids: [
        { id: 3, name: 'Art', cls: 'Folder', kids: [
          { id: 4, name: 'Skin', cls: 'ImageLabel', pos: [0, -10, 0, -10], size: [1, 20, 1, 20] },
          { id: 5, name: 'Label', cls: 'TextLabel', pos: [0, 0, 0, 0], size: [1, 0, 1, 0], text: 'HELLO', textSize: 20 },
        ] },
        { id: 6, name: 'A', cls: 'Frame', size: [0, 80, 0, 80], order: 1 },
      ] },
      { id: 7, name: 'Nested', cls: 'Frame', pos: [0, 100, 0, 500], size: [0, 400, 0, 120], kids: [{ id: 8, name: 'F1', cls: 'Folder', kids: [{ id: 9, name: 'F2', cls: 'Folder', kids: [{ id: 10, name: 'Deep', cls: 'Frame', pos: [0.5, 0, 0, 5], size: [0, 40, 0, 40] }] }] }] },
    ] };
    const b = new Map(layoutScreen(screen, { w: 1216, h: 825, topbar: 0, side: 0 } as never).map((x) => [x.path, [x.x, x.y, x.w, x.h]]));
    expect(b.get('S.Padded.Skin')).toEqual([120, 100, 370, 120]);
    expect(b.get('S.Padded.Label')).toEqual([130, 110, 350, 100]);
    expect(b.get('S.Padded.A')).toEqual([130, 120, 80, 80]);
    expect(b.get('S.Nested.Deep')).toEqual([300, 505, 40, 40]);
  });

  it('puts a skinned list\'s art and text in an Art folder, so the list lays out only its own children', async () => {
    const { layoutScreen } = await import('../src/shared/ui-layout');
    const s: UiNode = { id: 1, name: 'S', cls: 'ScreenGui', kids: [
      { id: 2, name: 'Pill', cls: 'TextButton', pos: [0, 100, 0, 100], size: [0, 220, 0, 50], skin: 'candy:pill', text: '48,250', textSize: 22, list: { dir: 'Horizontal', h: 'Left', v: 'Center', pad: [0, 6] }, kids: [
        { id: 3, name: 'Coin', cls: 'ImageLabel', size: [0, 36, 0, 36], order: 1 },
      ] },
    ] };
    const worn = prepareSkins([s]).screens[0]!;
    const pill = find(worn, 'Pill')!;
    expect(pill.kids![0]!.cls).toBe('Folder');
    expect(pill.kids![0]!.kids!.map((k) => k.name).sort()).toEqual(['Label', 'Skin']);
    const b = new Map(layoutScreen(worn, { w: 1280, h: 720, topbar: 0, side: 0 } as never).map((x) => [x.path, x]));
    expect(b.get('S.Pill.Coin')!.x).toBeCloseTo(100, 3);
    expect(b.get('S.Pill.Skin')!.w).toBeGreaterThan(220);
  });
});

describe('reskin', () => {
  it('reads what each element is and dresses it in a direction', async () => {
    const { reskinScreens } = await import('../src/core/ui/forge/reskin');
    const screens = [{ name: 'Shop', kids: [
      { name: 'Window', cls: 'Frame', size: [0, 900, 0, 560], bg: [40, 40, 60], stroke: { color: [255, 255, 255], px: 2 }, kids: [
        { name: 'Title', cls: 'TextLabel', text: 'Shop', textSize: 40, size: [0, 300, 0, 60], bgT: 1 },
        { name: 'Close', cls: 'TextButton', text: 'X', size: [0, 44, 0, 44], bg: [200, 50, 50] },
        { name: 'Tabs', cls: 'Frame', bgT: 1, size: [0, 500, 0, 50], list: { dir: 'Horizontal', h: 'Left', v: 'Center', pad: [0, 8] }, kids: [
          { name: 'A', cls: 'TextButton', text: 'Eggs', size: [0, 120, 0, 44], bg: [90, 90, 120] },
          { name: 'B', cls: 'TextButton', text: 'Pets', size: [0, 120, 0, 44], bg: [90, 90, 120] },
        ] },
        { name: 'Grid', cls: 'Frame', bgT: 1, size: [0, 600, 0, 300], grid: { cell: [0, 140, 0, 180], pad: [0, 8, 0, 8], dir: 'Horizontal', h: 'Left', v: 'Top' }, kids: [
          { name: 'Item', cls: 'Frame', bg: [60, 60, 80], kids: [{ name: 'Rarity', cls: 'TextLabel', text: 'LEGENDARY', textSize: 14 }, { name: 'Buy', cls: 'TextButton', text: '500', size: [0, 120, 0, 40], bg: [40, 200, 90] }] },
        ] },
        { name: 'Xp', cls: 'Frame', size: [0, 300, 0, 20], bg: [20, 20, 30], kids: [{ name: 'Fill', cls: 'Frame', size: [0.4, 0, 1, 0], bg: [80, 200, 255] }] },
        { name: 'Coins', cls: 'Frame', size: [0, 180, 0, 44], bg: [30, 30, 40], kids: [{ name: 'Amount', cls: 'TextLabel', text: '48,250', textSize: 20, textColor: [20, 20, 20] }] },
      ] },
    ] }] as unknown as import('../src/shared/ui-mockup').MockNode[];
    const r = reskinScreens(screens, { direction: 'candy' });
    const get = (path: string) => path.split('.').slice(1).reduce((n: any, name) => n?.kids?.find((k: any) => k.name === name), r.screens[0]);
    expect(get('Shop.Window').skin).toBe('candy:window');
    expect(get('Shop.Window').stroke).toBeUndefined();
    expect(get('Shop.Window.Title').skin).toBe('candy:title:SHOP');
    expect(get('Shop.Window.Close').skin).toBe('candy:close');
    expect(get('Shop.Window.Tabs.A').skin).toBe('candy:tab:inactive');
    expect(get('Shop.Window.Tabs.A').state).toBe('selected');
    expect(get('Shop.Window.Tabs.B').state).toBeUndefined();
    expect(get('Shop.Window.Grid.Item').skin).toBe('candy:card:legendary');
    expect(get('Shop.Window.Grid.Item.Buy').skin).toBe('candy:button:success');
    expect(get('Shop.Window.Grid.Item.Buy').states.press.skin).toBe('candy:button:success:pressed');
    expect(get('Shop.Window.Xp').skin).toBe('candy:barTrack');
    expect(get('Shop.Window.Xp.Fill').skin).toBe('candy:barFill');
    expect(get('Shop.Window.Coins').skin).toBe('candy:pill');
    expect(get('Shop.Window.Coins.Amount').textColor).not.toEqual([20, 20, 20]);
    expect(r.notes[0]).toMatch(/reskinned in candy/);
    expect(() => reskinScreens(screens, { direction: 'nope' })).toThrow(/no art direction/);
  });
});

describe('uploading skin atlases', () => {
  it('uploads each new atlas once, records its image id, retries a moderated one, and refuses a blocked picture', async () => {
    const { uploadSkinAtlases } = await import('../src/core/ui/forge/publish');
    const root = mkdtempSync(join(tmpdir(), 'forge-upload-'));
    const s = shop();
    const built = forgeForBuild({ desktop: [s] }, new SkinForge(null));
    const packed = packAtlases([...built.art].map(([key, f]) => ({ key, image: f.image })));
    const store = new AtlasStore(root);
    store.save(packed);
    const hash = packed.atlases[0]!.hash;
    const sent: string[] = [];
    let readable = false;
    const deps = {
      creator: async () => '42',
      upload: async (file: string, name: string, _d: string, userId: string) => (sent.push(`${name}|${userId}|${file.endsWith(`atlas-${hash}.png`)}`), { ok: true, assetId: '777' }),
      blocked: () => null,
      imageId: async (decal: string) => (readable && decal === '777' ? '99999' : undefined),
    };
    // Moderation: uploaded, image id not readable yet.
    let lines = await uploadSkinAtlases(root, [hash], deps);
    expect(sent).toEqual([`UI art atlas ${hash}|42|true`]);
    expect(lines.join(' ')).toMatch(/isn't readable yet/);
    expect(store.all()[hash]!.decalId).toBe('777');
    // Next build: no second upload, the id is read.
    readable = true;
    lines = await uploadSkinAtlases(root, [hash], deps);
    expect(sent.length).toBe(1);
    expect(lines[0]).toBe('1 atlas uploaded');
    expect(store.all()[hash]!.imageId).toBe('99999');
    // Then nothing left to do; and points the screens at the uploaded sprite.
    expect(await uploadSkinAtlases(root, [hash], deps)).toEqual([]);
    expect(find(pointSkins(built.worn, packed.placements, store.all()).forms.desktop![0]!, 'Skin')!.image).toBe('rbxassetid://99999');
    // A picture Roblox would remove is never sent.
    const root2 = mkdtempSync(join(tmpdir(), 'forge-upload-'));
    new AtlasStore(root2).save(packed);
    const lines2 = await uploadSkinAtlases(root2, [hash], { ...deps, blocked: () => 'a QR code' });
    expect(lines2.join(' ')).toMatch(/NOT uploaded: it has a QR code/);
    expect(sent.length).toBe(1);
  });
});

describe('kind aliases', () => {
  it('reads the names designers reach for first', () => {
    expect(parseSkin('candy:bar')).toEqual({ spec: { direction: 'candy', kind: 'barTrack' } });
    expect(parseSkin('candy:progress')).toEqual({ spec: { direction: 'candy', kind: 'barTrack' } });
    expect(parseSkin('neon:panel')).toEqual({ spec: { direction: 'neon', kind: 'window' } });
    expect(parseSkin('ember:fill:danger')).toEqual({ spec: { direction: 'ember', kind: 'barFill', variant: 'danger' } });
  });
});

describe('genres', () => {
  it('loads the catalogue and starts a template as a genre\'s game (its look, accent and content; the game\'s own content over it)', async () => {
    const { genres, genreContent } = await import('../src/core/ui/forge/genres');
    const { makeVersion } = await import('../src/core/ui/ui-mockups');
    const all = genres();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(50);
    const pets = all['pet-simulator']!;
    const content = genreContent(pets);
    expect((content.items as unknown[]).length).toBeGreaterThan(3);
    expect(content.currency).toBeTruthy();
    const made = makeVersion({ note: 'a pet shop', template: { id: 'shop', genre: 'pet-simulator', content: { title: 'EGG SHOP' } } }, [], null);
    expect(made.errors).toEqual([]);
    const json = JSON.stringify(made.version);
    expect(json).toContain(`"skin":"${pets.direction}:`);
    expect(json).toContain('EGG SHOP');
    const bad = makeVersion({ note: 'x', template: { id: 'shop', genre: 'no-such-genre' } }, [], null);
    expect(bad.errors.join(' ')).toMatch(/no genre "no-such-genre"/);
    const none = makeVersion({ note: 'x', template: { id: 'shop' } }, [], null);
    expect(none.errors.join(' ')).toMatch(/or give a genre/);
  });
});

describe('panel shapes as forged art', () => {
  it('wears a cut-cornered panel as a custom shape skin carrying its fill, gradient and outlines', async () => {
    const { shapesAsSkins, shapeSpec } = await import('../src/core/ui/forge/shaped');
    const { SkinForge } = await import('../src/core/ui/forge/resolve');
    const panel: UiNode = { id: 1, name: 'Paint', cls: 'Frame', size: [0, 300, 0, 120], bg: [10, 13, 21], bgT: 0.25, shape: { cut: [18, 0, 18, 0] }, gradient: { rot: 90, colors: [[0, 255, 255, 255], [1, 128, 128, 128]] }, strokes: [{ color: [255, 255, 255], px: 1, t: 0.85, text: false, pos: 'Inner' }], kids: [{ id: 2, name: 'Label', cls: 'TextLabel', text: 'PAINT', strokes: [{ color: [0, 0, 0], px: 2, t: 0, text: true }] }] };
    const spec = shapeSpec(panel)!;
    expect(spec.layers[0]!.shape).toMatchObject({ kind: 'cut', cut: [18, 0, 18, 0] });
    expect(spec.layers[0]!.style.fillOpacity).toBeCloseTo(0.75);
    expect(spec.layers[0]!.style.strokes![0]).toMatchObject({ width: 1, position: 'inside' });
    const sf = new SkinForge(null);
    const screen: UiNode = { id: 0, name: 'S', cls: 'ScreenGui', kids: [panel, { id: 3, name: 'Plain', cls: 'Frame', size: [0, 50, 0, 50], bg: [1, 2, 3] }] };
    const { screens, made } = shapesAsSkins([screen], sf);
    expect(made).toBe(1);
    const worn = screens[0]!.kids![0]!;
    expect(worn.skin).toMatch(/^custom:shape-/);
    expect(worn.shape).toBeUndefined();
    expect(worn.gradient).toBeUndefined();
    expect(sf.forged(worn.skin!)).toBeTruthy();
    // A panel with a skin of its own keeps it; an unshaped one is untouched.
    expect(screens[0]!.kids![1]).toBe(screen.kids![1]);
    expect(shapesAsSkins([{ ...screen, kids: [{ ...panel, skin: 'candy:window' }] }], sf).made).toBe(0);
    // A state that changes the colour or outline wears its own shape art (the art is the colour now); a scale stays.
    const button: UiNode = { ...panel, cls: 'TextButton', states: { hover: { bg: [40, 60, 90], scale: 1.04 }, press: { scale: 0.95 } } };
    const b = shapesAsSkins([{ ...screen, kids: [button] }], sf).screens[0]!.kids![0]!;
    expect(b.states!.hover!.skin).toMatch(/^custom:shape-/);
    expect(b.states!.hover!.skin).not.toBe(b.skin);
    expect(b.states!.hover!.bg).toBeUndefined();
    expect(b.states!.hover!.scale).toBe(1.04);
    expect(b.states!.press).toEqual({ scale: 0.95 });
  });
});
