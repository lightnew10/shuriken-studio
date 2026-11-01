import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIRECTIONS, type ElementRequest, type Variant } from '../src/core/ui/forge/directions';
import { forge, MAX_IMAGE, type ForgeSpec } from '../src/core/ui/forge/forge';
import { PROP_ALIASES, PROP_LOOKS, PROP_NAMES, PROPS, propCtx, propElement, resolveProp, withProps } from '../src/core/ui/forge/props';
import { scaleShape, shapeContours } from '../src/core/ui/forge/shapes';
import { glyphName, glyphSet } from '../src/core/ui/ui-glyphs';
import { planForge, unknownInSpec, type Cut } from '../src/shared/forge-plan';

/**
 * Props: filled, shaded game objects (eggs, chests, potions, gems…) that icon skins (and currency coin skins) draw in
 * every art direction's style instead of a line-art sticker.
 */

const LOOKS = Object.keys(PROP_LOOKS).filter((id) => PROP_LOOKS[id]);
const VARIANTS: Array<Variant | undefined> = [undefined, 'common', 'rare', 'epic', 'legendary', 'mythic', 'danger', 'success', 'premium', 'secondary'];
const icon = (glyph: string, size: number, variant?: Variant): ElementRequest => ({ kind: 'icon', glyph, size: [size, size], ...(variant ? { variant } : {}) });
const glyphLayers = (s: ForgeSpec) => s.layers.filter((l) => l.shape.kind === 'glyph').length;
/** Drawn as a prop: no layer is the requested glyph's sticker (props draw a $ emblem at most). */
const isProp = (s: ForgeSpec, glyph: string) => !s.layers.some((l) => l.shape.kind === 'glyph' && l.shape.name === glyph);
const finite = (s: ForgeSpec) => s.layers.every((l) => (l.at ?? [0, 0, 1, 1]).every(Number.isFinite) && JSON.stringify(l.shape).indexOf('null') < 0);

describe('props', () => {
  it('draw at least 45 game objects, each described', () => {
    expect(PROP_NAMES.length).toBeGreaterThanOrEqual(120);
    for (const n of PROP_NAMES) expect(PROPS[n]!.about.length, n).toBeGreaterThan(4);
    for (const n of ['egg', 'chest', 'potion', 'gem', 'coin', 'cash', 'key', 'crown', 'trophy', 'scroll', 'gift', 'sword', 'shield', 'heart', 'lightning', 'flame', 'star', 'skull', 'lock', 'ticket', 'money-bag', 'apple', 'paw', 'rocket', 'bomb', 'book', 'map', 'clock', 'hourglass', 'dice', 'magnet', 'mushroom', 'crystal', 'orb', 'ring', 'wings', 'feather', 'x2', 'boost']) expect(PROPS[n], n).toBeTruthy();
  });

  it('build a sound recipe for every prop and direction, in every variant and size', () => {
    let k = 0;
    const sizes = [32, 48, 96, 160];
    for (const n of PROP_NAMES)
      for (const d of LOOKS) {
        // Variants and sizes rotate through the directions (every combination would take minutes).
        const v = VARIANTS[k % VARIANTS.length];
        const size = sizes[k++ % sizes.length]!;
        if (size < (PROP_LOOKS[d]!.minSide ?? 0)) continue;
        const s = DIRECTIONS[d]!.element(icon(n, size, v));
        expect(s.layers.length, `${d}:${n}:${v}@${size}`).toBeGreaterThanOrEqual(2);
        expect(isProp(s, n) && glyphLayers(s) <= 1, `${d}:${n}`).toBe(true);
        expect(finite(s), `${d}:${n}:${v}@${size}`).toBe(true);
      }
    for (const v of VARIANTS) for (const size of sizes) expect(finite(DIRECTIONS.candy!.element(icon('chest', size, v)))).toBe(true);
  });

  it('come in several designs, and themed ones keep their own colours', () => {
    const designs = ['egg-1', 'egg-2', 'egg-3', 'egg-4', 'egg-5', 'egg-6', 'potion-2', 'potion-3', 'potion-4', 'chest-2', 'chest-3', 'sword-2', 'sword-3', 'sword-4', 'gem-2', 'gem-3', 'gem-4'];
    for (const n of designs) expect(PROPS[n], n).toBeTruthy();
    for (const [n, base] of [['potion-1', 'potion'], ['chest-1', 'chest'], ['sword-1', 'sword'], ['gem-1', 'gem']]) expect(resolveProp(n)).toBe(base);
    // Every egg design draws differently, plain and in a rarity.
    const print = (s: ForgeSpec) => JSON.stringify(s.layers.map((l) => [l.shape, l.at]));
    for (const v of [undefined, 'rare'] as Array<Variant | undefined>) {
      const eggs = ['egg', 'egg-2', 'egg-3', 'egg-4', 'egg-5', 'egg-6'].map((n) => print(DIRECTIONS.candy!.element(icon(n, 96, v))));
      expect(new Set(eggs).size).toBe(eggs.length);
    }
    for (const [word, prop] of [['dragon-egg', 'dragon-egg'], ['lava-egg', 'lava-egg'], ['frost-egg', 'frost-egg'], ['galaxy-egg', 'galaxy-egg'], ['ice-egg', 'frost-egg'], ['space-egg', 'galaxy-egg'], ['katana', 'sword-3'], ['vial', 'potion-4'], ['royal-chest', 'chest-3'], ['ruby', 'ruby']]) expect(resolveProp(word), word).toBe(prop);
    const fill = (n: string, v?: Variant) => JSON.stringify(DIRECTIONS.candy!.element(icon(n, 64, v)).layers.map((l) => l.style.fill));
    expect(fill('dragon-egg')).not.toEqual(fill('egg-4'));
    expect(fill('dragon-egg', 'epic')).not.toEqual(fill('dragon-egg'));
  });

  it('include weapons and creatures', () => {
    for (const n of ['pistol', 'rifle', 'shotgun', 'sniper', 'blaster', 'smg', 'grenade', 'launcher', 'laser', 'dragon', 'phoenix', 'unicorn', 'horse', 'wolf', 'cat', 'dog', 'bunny', 'slime']) expect(PROPS[n], n).toBeTruthy();
    for (const [word, prop] of [['gun', 'pistol'], ['bazooka', 'launcher'], ['rabbit', 'bunny'], ['puppy', 'dog'], ['pony', 'horse'], ['werewolf', 'wolf']]) expect(resolveProp(word), word).toBe(prop);
  });

  it('include vehicles, the diner and survival gear, by their Lucide names and game words', () => {
    const names = ['sports-car', 'race-car', 'kart', 'truck', 'motorbike', 'boat', 'plane', 'helicopter', 'burger', 'fries', 'soda', 'donut', 'chef-hat', 'flashlight', 'battery', 'key-card', 'bandage', 'syringe', 'crowbar', 'torn-note', 'medkit'];
    for (const n of names) expect(PROPS[n], n).toBeTruthy();
    const words: Array<[string, string]> = [['car', 'sports-car'], ['car-front', 'sports-car'], ['supercar', 'sports-car'], ['racing-car', 'sports-car'], ['f1', 'race-car'], ['go-kart', 'kart'], ['monster-truck', 'truck'], ['bike', 'motorbike'], ['motorcycle', 'motorbike'], ['ship', 'boat'], ['airplane', 'plane'], ['jet', 'plane'], ['chopper', 'helicopter'], ['hamburger', 'burger'], ['cup-soda', 'soda'], ['doughnut', 'donut'], ['chef', 'chef-hat'], ['battery-charging', 'battery'], ['keycard', 'key-card'], ['band-aid', 'bandage'], ['briefcase-medical', 'medkit'], ['first-aid-kit', 'medkit'], ['note', 'torn-note'], ['cars', 'sports-car'],
      // Through the catalogue: a game word whose glyph is one of theirs.
      ['vehicle', 'sports-car'], ['racing', 'sports-car'], ['delivery', 'truck'], ['airport', 'plane'], ['charge', 'battery']];
    for (const [word, prop] of words) expect(resolveProp(word), word).toBe(prop);
    // The paint wears the variant; tyres and glass keep theirs.
    const fill = (n: string, v?: Variant) => JSON.stringify(DIRECTIONS.candy!.element(icon(n, 96, v)).layers.map((l) => l.style.fill));
    expect(fill('sports-car', 'legendary')).not.toEqual(fill('sports-car'));
    // A vehicle in a wide card spans the card (not the card's centred square); square icons are framed as before.
    const bounds = (size: [number, number]) => {
      const spec = DIRECTIONS.candy!.element({ kind: 'icon', glyph: 'sports-car', size });
      const xs = spec.layers.flatMap((l) => [l.at![0], l.at![0] + l.at![2]]);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(bounds([320, 140])).toBeGreaterThan(280);
    expect(bounds([140, 140])).toBeLessThan(145);
    expect(propCtx(icon('sports-car', 96), PROP_LOOKS.candy!, undefined, PROPS['sports-car']).u).toBeCloseTo(0.96);
  });

  it('forge in every direction and rarity without error, within 1024 px, with ink where the object is', () => {
    let k = 0;
    for (const n of PROP_NAMES)
      for (const d of LOOKS) {
        const v = VARIANTS[k++ % VARIANTS.length];
        const f = forge(DIRECTIONS[d]!.element(icon(n, 48, v)));
        expect(Math.max(f.image.width, f.image.height), `${d}:${n}`).toBeLessThanOrEqual(MAX_IMAGE);
        // Something opaque at the middle third of the art (the object, not just its glow).
        const { width: w, height: h, data } = f.image;
        let solid = 0;
        for (let y = Math.floor(h / 3); y < (2 * h) / 3; y++) for (let x = Math.floor(w / 3); x < (2 * w) / 3; x++) if (data[(y * w + x) * 4 + 3]! > 200) solid++;
        expect(solid, `${d}:${n}`).toBeGreaterThan(0);
      }
    // Every rarity of a few in the heaviest looks, and the biggest art stays under Roblox's cap.
    for (const n of ['chest', 'egg', 'wings'])
      for (const d of ['grunge', 'royal', 'neon'])
        for (const v of VARIANTS) expect(() => forge(DIRECTIONS[d]!.element(icon(n, 64, v)))).not.toThrow();
    const big = forge(DIRECTIONS.candy!.element(icon('chest', 900, 'mythic')));
    expect(Math.max(big.image.width, big.image.height)).toBeLessThanOrEqual(MAX_IMAGE);
  });

  it('are deterministic', () => {
    for (const n of ['egg', 'cookie', 'crystal', 'cash'])
      for (const d of ['candy', 'grunge']) {
        const a = DIRECTIONS[d]!.element(icon(n, 72, 'epic'));
        expect(DIRECTIONS[d]!.element(icon(n, 72, 'epic'))).toEqual(a);
        expect(Buffer.from(forge(a).image.data).equals(Buffer.from(forge(a).image.data))).toBe(true);
      }
  });

  it('forge quickly at 96 pt (about 20–40 ms each on a quiet machine)', () => {
    // Wall-clock bounds are generous: the suite runs beside other CPU-heavy work. Warm up, then judge the median.
    for (const d of ['candy', 'grunge']) for (let i = 0; i < 3; i++) forge(DIRECTIONS[d]!.element(icon('chest', 96)));
    const times: number[] = [];
    const slow: string[] = [];
    for (const n of PROP_NAMES)
      for (const d of ['candy', 'grunge']) {
        const spec = DIRECTIONS[d]!.element(icon(n, 96, 'rare'));
        const t = performance.now();
        forge(spec);
        const ms = performance.now() - t;
        times.push(ms);
        if (ms > 1000) slow.push(`${d}:${n} ${ms.toFixed(0)} ms`);
      }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(150);
    expect(slow).toEqual([]);
  });

  it('wear the variant: rarity, role and accent tint the object; food keeps its colour with a glow', () => {
    const ctx = (v?: Variant, accent?: string) => propCtx(icon('egg', 96, v), PROP_LOOKS.candy!, accent);
    expect(ctx().tint).toBeNull();
    expect(ctx('rare').tint).not.toBeNull();
    expect(ctx('mythic').tint?.holo).toBe(true);
    expect(ctx('legendary').tint?.glint).toBe(true);
    expect(ctx('danger').tint?.mid).not.toEqual(ctx('success').tint?.mid);
    expect(ctx(undefined, '#ff00aa').tint).not.toBeNull();
    const fill = (s: ForgeSpec) => JSON.stringify(s.layers.map((l) => l.style.fill));
    expect(fill(DIRECTIONS.candy!.element(icon('gem', 64, 'rare')))).not.toEqual(fill(DIRECTIONS.candy!.element(icon('gem', 64, 'epic'))));
    const apple = DIRECTIONS.candy!.element(icon('apple', 64, 'epic'));
    expect(fill(apple)).toEqual(fill(DIRECTIONS.candy!.element(icon('apple', 64))));
    expect(apple.layers.some((l) => l.style.outerGlow)).toBe(true);
  });

  it('resolve names: their own, aliases, plurals and the game-word catalogue', () => {
    for (const n of PROP_NAMES) expect(resolveProp(n)).toBe(n);
    for (const [k, v] of Object.entries(PROP_ALIASES)) {
      expect(PROPS[v], `${k} → ${v}`).toBeTruthy();
      expect(resolveProp(k), k).toBe(v);
    }
    const cases: Record<string, string | null> = {
      'pet-egg': 'egg', 'mystery-egg': 'mystery-egg', 'Pet Egg': 'egg', 'loot-crate': 'chest', treasure: 'chest', 'flask-conical': 'potion', zap: 'lightning', gems: 'gem', keys: 'key', cookies: 'cookie', swords: 'sword',
      // Through the catalogue (game-icons.json): the concept's best glyph is a prop's.
      heal: 'heart', quests: 'scroll', streak: 'flame', critical: 'lightning', luck: 'clover', spellbook: 'book', casino: 'dice', 'level-up': 'boost', paladin: 'shield',
      settings: null, 'lock-open': null, sparkles: null, x: null, '': null,
    };
    for (const [k, v] of Object.entries(cases)) expect(resolveProp(k), k).toBe(v);
    expect(resolveProp(undefined)).toBeNull();
  });

  it('take every catalogue word whose glyph is a prop', () => {
    const set = glyphSet(join(__dirname, '..', 'resources'))!;
    const cat = JSON.parse(readFileSync(join(__dirname, '..', 'resources', 'ui-glyphs', 'game-icons.json'), 'utf8')) as { categories: Record<string, Record<string, string[]>> };
    const missed: string[] = [];
    let taken = 0;
    for (const group of Object.values(cat.categories))
      for (const word of Object.keys(group)) {
        // The glyph the word draws today (a Lucide name of its own wins over the concept: "space" is the space bar).
        const g = glyphName(set, word);
        if (!g || !(PROPS[g] || PROP_ALIASES[g])) continue;
        taken++;
        if (!resolveProp(word)) missed.push(`${word} → ${g}`);
      }
    expect(missed).toEqual([]);
    expect(taken).toBeGreaterThan(100);
  });

  it('are what icon skins wear: the prop wins over a Lucide glyph of its name, other glyphs stay stickers', () => {
    for (const d of LOOKS) {
      const s = DIRECTIONS[d]!.element(icon('key', 72, 'rare'));
      expect(glyphLayers(s), d).toBe(0);
      expect(s.slice).toBe(false);
      expect(glyphLayers(DIRECTIONS[d]!.element(icon('settings', 72))), d).toBeGreaterThan(0);
    }
    // Pixel art draws props as sprites; a direction without a prop look keeps its own icons.
    const px = DIRECTIONS.pixel!.element(icon('egg', 72));
    expect(px.pixel).toBeTruthy();
    expect(isProp(px, 'egg')).toBe(true);
    expect(isProp(DIRECTIONS.pixel!.element(icon('egg', 32)), 'egg')).toBe(false);
    const plain = withProps({ plain: { ...DIRECTIONS.candy!, id: 'plain', element: () => ({ size: [1, 1], layers: [] }) } });
    expect(plain.plain!.element(icon('egg', 72)).layers).toEqual([]);
    expect(propElement(PROP_LOOKS.candy!, { kind: 'button', size: [100, 40] })).toBeNull();
    // Coins: a currency prop's glyph draws the prop; an emblem glyph keeps the direction's coin.
    for (const g of ['gem', 'cash', 'coins', 'money-bag', 'ticket']) expect(isProp(DIRECTIONS.candy!.element({ kind: 'coin', glyph: g, size: [40, 40] }), g), g).toBe(true);
    expect(isProp(DIRECTIONS.candy!.element({ kind: 'coin', glyph: 'star', size: [40, 40] }), 'star')).toBe(false);
    expect(isProp(DIRECTIONS.neon!.element({ kind: 'coin', glyph: 'cpu', size: [40, 40] }), 'cpu')).toBe(false);
    // States work as on any element: disabled greys it.
    const grey = DIRECTIONS.candy!.element({ ...icon('heart', 72), state: 'disabled' });
    expect(JSON.stringify(grey.layers.map((l) => l.style.fill))).not.toEqual(JSON.stringify(DIRECTIONS.candy!.element(icon('heart', 72)).layers.map((l) => l.style.fill)));
  });

  it('can be drawn by the GPU forge as laid out by the CPU', () => {
    const cut: Cut = (s, x, y, w, h, k) => shapeContours(scaleShape(s, k), x, y, w, h);
    let k = 0;
    for (const n of PROP_NAMES) {
      const d = LOOKS[k++ % LOOKS.length]!;
      const spec = DIRECTIONS[d]!.element(icon(n, 64, VARIANTS[k % VARIANTS.length]));
      expect(unknownInSpec(spec), `${d}:${n}`).toBeNull();
      if (k % 6 === 0) {
        const plan = planForge(spec, cut);
        const { image, ...meta } = forge(spec);
        expect({ width: plan.width * (plan.pixel?.k ?? 1), height: plan.height * (plan.pixel?.k ?? 1), ...plan.meta }).toEqual({ width: image.width, height: image.height, ...meta });
      }
    }
  });
});
