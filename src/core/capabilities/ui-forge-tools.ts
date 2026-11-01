import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import { pngContent } from '../ui/ui-pictures';
import { DIRECTIONS, ELEMENT_KINDS, type ElementKind, type ElementRequest, type Variant } from '../ui/forge/directions';
import { forge, type ForgeSpec } from '../ui/forge/forge';
import { skinCacheDir, skinForgeFor } from '../ui/forge/resolve';
import { parseSkin } from '../ui/forge/spec';
import { TEMPLATES } from '../ui/forge/templates';
import { PROP_NAMES } from '../ui/forge/props';
import { genres } from '../ui/forge/genres';
import { canvas, fromImage, over, toImage } from '../ui/forge/canvas';
import type { RgbaImage } from '../modeling/png';
import { errorOutput, type ToolRegistry } from './tool-registry';

export interface UiForgeToolDeps {
  project: () => ProjectContext | null;
}

const VARIANTS = ['primary', 'secondary', 'danger', 'success', 'premium', 'active', 'inactive', 'pressed', 'disabled', 'hover', 'common', 'rare', 'epic', 'legendary', 'mythic'] as const;

/** Pictures in rows on a backdrop that suits the direction (light ones on a dark ground and the other way). */
function sheet(items: RgbaImage[], back: [number, number, number], width = 1400): RgbaImage {
  const half = (src: RgbaImage): RgbaImage => {
    const w = Math.ceil(src.width / 2);
    const h = Math.ceil(src.height / 2);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const k = (Math.min(src.height - 1, y * 2 + dy) * src.width + Math.min(src.width - 1, x * 2 + dx)) * 4;
          const al = src.data[k + 3]! / 255;
          r += src.data[k]! * al;
          g += src.data[k + 1]! * al;
          b += src.data[k + 2]! * al;
          a += al;
        }
        const o = (y * w + x) * 4;
        data[o + 3] = Math.round((a / 4) * 255);
        if (a > 0) {
          data[o] = Math.round(r / a);
          data[o + 1] = Math.round(g / a);
          data[o + 2] = Math.round(b / a);
        }
      }
    return { width: w, height: h, data };
  };
  const shown = items.map(half);
  const placed: Array<{ img: RgbaImage; x: number; y: number }> = [];
  let x = 16, y = 16, row = 0;
  for (const img of shown) {
    if (x + img.width > width - 16 && x > 16) {
      x = 16;
      y += row + 10;
      row = 0;
    }
    placed.push({ img, x, y });
    x += img.width + 10;
    row = Math.max(row, img.height);
  }
  const H = y + row + 16;
  const c = canvas(width, H);
  for (let i = 0; i < width * H; i++) c.px.set([back[0], back[1], back[2], 1], i * 4);
  for (const p of placed) over(c, fromImage(p.img), p.x, p.y);
  return toImage(c);
}

/** The backdrop a direction's previews read well on (0..1). */
const backOf = (dir: string): [number, number, number] => {
  const c = DIRECTIONS[dir]?.backdrop;
  if (!c) return [0.06, 0.07, 0.09];
  if (Array.isArray(c)) return [c[0] / 255, c[1] / 255, c[2] / 255];
  const v = parseInt(c.replace('#', '').slice(0, 6), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

/** Every kind of element of a direction, in its usual sizes and variants. */
function sampleRequests(): ElementRequest[] {
  return [
    { kind: 'title', size: [300, 70], text: 'TITLE' },
    { kind: 'button', variant: 'primary', size: [180, 56] },
    { kind: 'button', variant: 'secondary', size: [180, 56] },
    { kind: 'button', variant: 'danger', size: [120, 56] },
    { kind: 'button', variant: 'premium', size: [120, 56] },
    { kind: 'button', variant: 'pressed', size: [120, 56] },
    { kind: 'tab', variant: 'active', size: [120, 46] },
    { kind: 'tab', variant: 'inactive', size: [120, 46] },
    ...(['common', 'rare', 'epic', 'legendary', 'mythic'] as Variant[]).map((v) => ({ kind: 'card' as ElementKind, variant: v, size: [110, 140] as [number, number] })),
    { kind: 'icon', glyph: 'sword', size: [64, 64] },
    { kind: 'icon', glyph: 'heart', variant: 'danger', size: [64, 64] },
    // Objects (filled, shaded art where the game has such a thing).
    { kind: 'icon', glyph: 'egg', variant: 'legendary', size: [64, 64] },
    { kind: 'icon', glyph: 'chest', variant: 'epic', size: [64, 64] },
    { kind: 'icon', glyph: 'potion', variant: 'rare', size: [64, 64] },
    { kind: 'icon', glyph: 'gem', variant: 'mythic', size: [64, 64] },
    { kind: 'coin', size: [48, 48] },
    { kind: 'badge', size: [48, 48] },
    { kind: 'close', size: [50, 50] },
    { kind: 'iconFrame', size: [64, 64] },
    { kind: 'pill', size: [170, 44] },
    { kind: 'slot', variant: 'rare', size: [80, 80] },
    { kind: 'barTrack', size: [220, 24] },
    { kind: 'barFill', size: [150, 24] },
    { kind: 'ribbon', size: [160, 38] },
    { kind: 'header', size: [420, 72] },
    { kind: 'window', size: [420, 220] },
  ];
}

export function registerUiForgeTools(reg: ToolRegistry, d: UiForgeToolDeps): void {
  reg.register({
    name: 'ui_forge',
    title: 'Forge UI art',
    description:
      'The UI Forge: game UI art drawn like a pro UI artist (bevels, gloss, 3D bases, glows, textures, stacked outlines, title type in Roblox fonts), 9-sliced so any size keeps its corners. Any element in a mockup wears it with skin: "<direction>:<kind>[:<variant>[:<state>]]" (icon/coin: ":<glyph>[:<variant>]", title: ":<TEXT>", accent: "#rrggbb" at the end); its states wear their own art: states: {press: {skin: "candy:button:primary:pressed"}, selected: {skin: "candy:tab:active"}, disabled: {skin: "…:disabled"}} (the text sinks with a pressed face); the art is forged at the element\'s size, drawn under its content, and the element\'s own fill turns off (text goes over it). action: directions (the art directions, their fonts and what they suit), sheet {direction, accent?} (every element of a direction: look before you pick), element {direction, element: {kind, variant?, glyph?, text?, size?}, accent?} (one piece and its skin spec), custom {name, spec} (your own layered recipe, worn as skin "custom:<name>"), templates (whole screens: shop, inventory, HUDs, rewards… to start a mockup version from), genres (the look and content of a game genre, for a template). Kinds: ' +
      ELEMENT_KINDS.join(', ') +
      '. Variants: ' +
      VARIANTS.join(', ') +
      '. Glyphs: any Lucide icon name or game word (ui_icon {search} finds them); game objects (egg, chest, potion, gem, crown, trophy, gift… — directions lists all) draw as filled, shaded art. Light for any direction: skin "fx:<glow|rays|halo|sparkles|shine|vignette|spotlight>#rrggbb" (a round glow behind a hero item: Roblox draws radial UIGradients as linear). Text over skins: the direction\'s fonts and text colours (directions lists them).',
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: {
      action: z.enum(['directions', 'sheet', 'element', 'custom', 'templates', 'genres']),
      direction: z.string().optional(),
      accent: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      element: z.object({ kind: z.enum(ELEMENT_KINDS), variant: z.enum(VARIANTS).optional(), glyph: z.string().optional(), text: z.string().max(40).optional(), size: z.tuple([z.number().min(4).max(1600), z.number().min(4).max(1200)]).optional() }).optional(),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,40}$/).optional(),
      spec: z.record(z.string(), z.unknown()).optional().describe('A ForgeSpec, every length in design points: {size: [w, h], layers: [{shape: {kind, ...}, style: {fill, patterns, textures, strokes, bevel, gloss, rim, sheen, extrude, innerShadow, innerGlow, outerGlow, dropShadow, sparkles, wear, ...}, at?: [x, y, w, h]}], slice?: false}'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const accent = args.accent ? (args.accent.startsWith('#') ? args.accent : `#${args.accent}`) : undefined;
      if (args.action === 'directions') {
        const list = Object.values(DIRECTIONS).map((x) => ({ id: x.id, label: x.label, for: x.for, fonts: x.fonts, text: x.text, palette: x.palette }));
        return { content: [{ type: 'text', text: list.map((x) => `${x.id}: ${x.label} — ${x.for}. Fonts ${x.fonts.display} / ${x.fonts.body}.`).join('\n') + '\nLook at one with ui_forge {action: "sheet", direction}. Frames (window, header, tabs, title) wear the direction\'s own colour until you give your game\'s brand colour as #accent (candy is purple, ember orange…): players should see your game, not the direction. Rarities, coins and roles keep theirs.\nIcon glyphs drawn as filled, shaded objects ("dir:icon:<name>[:<rarity>]"): ' + PROP_NAMES.join(', ') + '.' }], data: { directions: list, kinds: ELEMENT_KINDS, variants: VARIANTS } };
      }
      if (args.action === 'genres') {
        const all = Object.entries(genres());
        if (!all.length) return errorOutput('No genre catalogue in this build.');
        return { content: [{ type: 'text', text: all.map(([id, g]) => `${id}: ${g.label} — ${g.direction}${g.alt ? ` (or ${g.alt})` : ''}${g.accent ? ` ${g.accent}` : ''}; ${g.currencies.map((c) => c.name).join(' + ')}; screens ${g.screens.join(', ')}`).join('\n') + '\nStart a version from one: {note, template: {id: "shop", genre: "<id>"}} (its look, accent, currencies, items and tabs; your content goes over it).' }], data: { genres: Object.fromEntries(all) } };
      }
      if (args.action === 'templates') {
        const list = Object.values(TEMPLATES).map((t) => ({ id: t.id, label: t.label, for: t.for, content: t.contentShape }));
        return { content: [{ type: 'text', text: list.map((t) => `${t.id}: ${t.label} — ${t.for}. content: ${t.content}`).join('\n') + '\nUse one as a mockup version: ui_mockup_create {versions: [{note, template: {id, direction, accent?, content}}]}, then set what should differ.' }], data: { templates: list } };
      }
      const dir = args.direction ?? '';
      if (args.action === 'sheet') {
        const x = DIRECTIONS[dir];
        if (!x) return errorOutput(`No art direction "${dir}" (directions: ${Object.keys(DIRECTIONS).join(', ')})`);
        const imgs = sampleRequests().map((r) => forge(x.element(r, accent)).image);
        return { content: [{ type: 'text', text: `${x.label}${accent ? ` tinted ${accent}` : ''}: title, buttons (primary, secondary, danger, premium, pressed), tabs, cards by rarity, icons, coin, badge, close, icon frame, pill, slot, bar, ribbon, header, window. Skin specs: "${dir}:<kind>[:<variant>]".` }, pngContent(sheet(imgs, backOf(dir)))] };
      }
      if (args.action === 'element') {
        if (!args.element) return errorOutput('element: {kind, variant?, glyph?, text?, size?}');
        const e = args.element;
        const spec = `${dir}:${e.kind}${e.kind === 'title' ? `:${e.text ?? ''}` : e.kind === 'icon' || e.kind === 'coin' ? `${e.glyph ? `:${e.glyph}` : ''}${e.variant ? `:${e.variant}` : ''}` : e.variant ? `:${e.variant}` : ''}${accent ? accent : ''}`;
        const parsed = parseSkin(spec);
        if ('error' in parsed) return errorOutput(parsed.error);
        const p = d.project();
        const sf = skinForgeFor(p ? skinCacheDir(p.root) : null);
        const got = sf.get(spec, e.size ?? [e.kind === 'icon' ? 96 : 200, e.kind === 'icon' ? 96 : 60]);
        if ('error' in got) return errorOutput(got.error);
        const f = got.forged;
        return { content: [{ type: 'text', text: `skin: "${spec}" — ${f.size[0]}×${f.size[1]} points${f.slice ? ', 9-sliced (stretches to any size, corners kept)' : ' (drawn at this size: size the element to it)'}; effects reach ${f.margin} points outside the box.` }, pngContent(sheet([f.image], backOf(dir), Math.max(200, Math.ceil(f.image.width / 2) + 32)))], data: { skin: spec, size: f.size, margin: f.margin, sliced: !!f.slice } };
      }
      // custom
      if (!args.name || !args.spec) return errorOutput('custom: {name, spec: {size, layers: [{shape, style, at?}], slice?}}');
      let f;
      try {
        f = forge(args.spec as unknown as ForgeSpec);
      } catch (err) {
        return errorOutput(`The recipe didn't forge: ${err instanceof Error ? err.message : String(err)}`);
      }
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      skinForgeFor(skinCacheDir(p.root)).saveCustom(args.name, f, args.spec);
      return { content: [{ type: 'text', text: `Saved: wear it with skin: "custom:${args.name}" (${f.size[0]}×${f.size[1]} points${f.slice ? ', 9-sliced' : ''}).` }, pngContent(sheet([f.image], [0.06, 0.07, 0.09], Math.max(200, Math.ceil(f.image.width / 2) + 32)))] };
    },
  });
}
