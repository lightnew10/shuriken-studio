import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MockColor, MockNode } from '@shared/ui-mockup';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { CodeSync } from '../roblox/code-sync';
import type { EventBus } from '../events';
import { nowIso } from '@shared/ids';
import { decodeImage } from '../look/look-analysis';
import { encodePng, shrinkImage, type RgbaImage } from '../modeling/png';
import { ModelStore } from '../modeling/model-store';
import { modelGlb } from './model-tools';
import { ScreenshotUnavailableError } from '../roblox/studio-adapter';
import { STORE_LIMITS, STORE_STYLES, Storefront, checkCatalog, checkCopy, itemStatus, type StoreCatalog, type StoreItem } from '../storefront/storefront';
import { ART_SIZES, SHOT_DIR, THUMB_CANDIDATES, artImages, compose, fillTemplate, iconFromTemplate, judgePrompt, templateHasSubject, type ThumbRuling } from '../storefront/store-art';
import { errorOutput, jsonOutput, textOutput, type ToolContent, type ToolRegistry } from './tool-registry';

/**
 * The Storefront's tools (storefront/storefront.ts), one set per expert, never mixed: the store designer's catalog
 * (store_catalog), the copywriter's words (copy_write, copy_get), the thumbnail artist's pictures (thumb_shot,
 * thumb_compose, thumb_pick, store_icons); store_list for all three. None of them puts anything on Roblox: items are
 * pushed by the user (the Storefront page's button, or asking the director), the rest the user uploads.
 */

export interface StorefrontToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  bus: EventBus;
  /** The app's Storefront switches (Settings): monetization (the catalog, its icons) and copy (the words). */
  prefs: () => { monetization: boolean; copy: boolean };
  resourcesDir: string | null;
  sync?: CodeSync;
  /** Draws one of the game's 3D models as a picture (the app's renderer; absent in tests and the headless engine). */
  renderIcon?: (parts: Array<{ glb: Buffer; color?: string; material?: string; origin?: [number, number, number] }>, o: { view: 'three-quarter' | 'front' | 'side' | 'top'; outline: boolean }) => Promise<string | null>;
  /** The thumbnail judge: a model that looks at the candidates and eliminates them one by one. */
  judge?: (prompt: string, images: Array<{ mediaType: 'image/png'; data: string }>) => Promise<ThumbRuling | null>;
  /** Puts the store as designed in the game: the module written from the catalog and synced (StorePush.apply). */
  apply?: (p: ProjectContext) => Promise<{ file: string; synced: boolean; note: string }>;
}

/** What the Storefront keeps about its pictures (art.json). */
export interface ArtState {
  thumbs: Array<{ name: string; file: string; note: string; at: string; by: string }>;
  pick?: { winner: string; rounds: Array<{ out: string; why: string }>; why: string; at: string; byUser?: boolean; among: string[] };
  icons: Array<{ name: string; file: string; note: string; at: string; by: string }>;
  /** The game's icon: one of `icons`. */
  gameIcon?: string;
  /** The set's template for pass and product icons (shared frame and light): screens with "{subject}" and "{text}". */
  template?: { screens: MockNode[]; theme?: Record<string, MockColor>; at: string };
}

export function readArt(root: string): ArtState {
  try {
    const f = join(new Storefront(root).dir(), 'art.json');
    if (existsSync(f)) return { thumbs: [], icons: [], ...(JSON.parse(readFileSync(f, 'utf8')) as Partial<ArtState>) };
  } catch {
    /* fresh */
  }
  return { thumbs: [], icons: [] };
}
export function writeArt(root: string, a: ArtState): void {
  const dir = new Storefront(root).dir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'art.json'), `${JSON.stringify(a, null, 2)}\n`, 'utf8');
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const png = (img: RgbaImage): ToolContent => ({ type: 'image', data: encodePng(img).toString('base64'), mimeType: 'image/png' });
const by = (caller: { role: string | null }) => caller.role ?? 'user';

const itemShape = z.strictObject({
  key: z.string().describe('Its code name (Store.items.<key>): letters and digits, kept when the shown name changes'),
  kind: z.enum(['pass', 'product']).optional().describe('pass: bought once, kept forever (VIP, a skin). product: bought again and again (currency, a revive). Needed for a new item'),
  name: z.string().max(STORE_LIMITS.name).optional(),
  description: z.string().max(STORE_LIMITS.description).optional(),
  price: z.number().int().min(STORE_LIMITS.priceMin).max(STORE_LIMITS.priceMax).optional().describe('Robux'),
  benefit: z.string().max(600).optional().describe('Exactly what the game grants (the engineers build this; the copywriter sells it)'),
  icon: z.string().max(80).optional().describe('The icon\'s subject for store_icons: "model:<Name>" (one of the game\'s models) or "glyph:<name>"'),
  order: z.number().int().min(0).max(999).optional(),
  category: z.string().max(24).optional().describe('The shop\'s category: "Passes", "Currency", "Boosts", "Cosmetics", "Gifts"…'),
  offer: z.string().max(240).optional().describe('Where and when the game offers it: the moment of need, never a nag'),
  hue: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('The icon\'s hue, one per category ("#FFC83D")'),
  random: z.boolean().optional().describe('A paid random item (egg, crate, spin): odds shown before buying'),
});

/** Luau (Edit) before a thumbnail shot: hides the game's UI, sets the camera's field of view, outlines the subjects; returns what to put back. */
export function shotSetup(fov: number | undefined, outline: string[], color: string): string {
  const paths = outline.map((p) => `{${p.split(/[./]/).filter(Boolean).map((s) => JSON.stringify(s.trim())).join(', ')}}`);
  return `local HttpService = game:GetService("HttpService")
local sg = game:GetService("StarterGui")
local out = { ui = sg.ShowDevelopmentGui, missing = {} }
sg.ShowDevelopmentGui = false
local cam = workspace.CurrentCamera
${fov !== undefined ? `if cam then
	out.fov = cam.FieldOfView
	cam.FieldOfView = ${Number(fov)}
end` : ''}
for _, old in workspace:GetDescendants() do
	if old:IsA("Highlight") and old.Name == "ShurikenThumbOutline" then
		old:Destroy()
	end
end
for _, path in { ${paths.join(', ')} } do
	local at: Instance? = game
	for i, name in path do
		if not at then break end
		at = if i == 1 and (name == "Workspace" or name == "workspace") then workspace else at:FindFirstChild(name)
	end
	if at and at ~= game then
		local h = Instance.new("Highlight")
		h.Name = "ShurikenThumbOutline"
		h.FillTransparency = 1
		h.OutlineTransparency = 0
		h.OutlineColor = Color3.fromHex("${color.slice(1)}")
		h.DepthMode = Enum.HighlightDepthMode.Occluded
		h.Adornee = at
		h.Parent = at
	else
		table.insert(out.missing, table.concat(path, "/"))
	end
end
return HttpService:JSONEncode(out)`;
}

/** Luau (Edit) after a thumbnail shot: the game's UI, the camera and the place as they were. */
export function shotTeardown(before: { ui?: boolean; fov?: number }): string {
  return `for _, h in workspace:GetDescendants() do
	if h:IsA("Highlight") and h.Name == "ShurikenThumbOutline" then
		h:Destroy()
	end
end
${before.ui !== false ? 'game:GetService("StarterGui").ShowDevelopmentGui = true' : ''}
${typeof before.fov === 'number' ? `if workspace.CurrentCamera then
	workspace.CurrentCamera.FieldOfView = ${before.fov}
end` : ''}
return "ok"`;
}

export function registerStorefrontTools(reg: ToolRegistry, d: StorefrontToolDeps): void {
  const project = () => d.project();
  const monetization = () => (d.prefs().monetization ? { ok: true } : { ok: false, reason: 'Monetization is off (Settings → Storefront)' });
  const copyOn = () => (d.prefs().copy ? { ok: true } : { ok: false, reason: 'Copy is off (Settings → Storefront)' });
  const anyOn = () => (d.prefs().monetization || d.prefs().copy ? { ok: true } : { ok: false, reason: 'The Storefront is off (Settings → Storefront)' });
  const studioOn = () => (anyOn().ok ? d.studio.availability() : anyOn());

  /** The catalog in a few lines: each item, its price, its status and its icon. */
  const catalogLines = (c: StoreCatalog): string[] => [
    `Style: ${c.style}${c.why ? ` (${c.why})` : ''}. ${c.items.length} item(s):`,
    ...c.items.map(
      (i) =>
        `- ${i.key} (${i.kind}, R$${i.price}, ${itemStatus(i)}${i.roblox ? `, id ${i.roblox.id}` : ''}${i.category ? `, ${i.category}` : ''}${i.hue ? `, hue ${i.hue}` : ''}${i.random ? ', paid random' : ''}): "${i.name}"${i.icon?.file ? ', icon drawn' : i.icon?.subject ? `, icon ${i.icon.subject} not drawn yet` : ', no icon'} — ${i.benefit}${i.offer ? ` | offered: ${i.offer}` : ''}`,
    ),
  ];

  reg.register({
    name: 'store_catalog',
    title: 'Plan what the game sells',
    description: `The game's store: its game passes (bought once, kept) and developer products (bought again and again), each with a code key, a shown name, a description, a price in Robux and the benefit the game grants. style: "cosmetic" (looks and status only, never an advantage: a skill-based competitive game), "fair" (convenience that never decides a match), "aggressive" (the genre's strong sellers). set adds or changes items (by key), remove drops keys (only drafts: an item on Roblox is taken off sale by the user). Every change writes the game's ShurikenStore module (src/Shared/ShurikenStore.luau: Store.items, Store.owns, Store.onPass, Store.onProduct, Store.prompt; test purchases in Studio until pushed), except in a copilot's draft turn, where only the design changes (on the Storefront page) until it is put in the game. Nothing goes to Roblox here. Limits: name ${STORE_LIMITS.name} characters, description ${STORE_LIMITS.description}, price ${STORE_LIMITS.priceMin}+ Robux.`,
    capability: 'storefront.catalog',
    permission: 'write_project',
    available: monetization,
    input: {
      style: z.enum(STORE_STYLES as [string, ...string[]]).optional(),
      why: z.string().max(400).optional().describe('Why this style and these items, in a sentence or two'),
      set: z.array(itemShape).max(30).optional(),
      remove: z.array(z.string()).max(30).optional(),
    },
    handler: async ({ args, caller }) => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const sf = new Storefront(p.root);
      const now = sf.catalog();
      const items = new Map(now.items.map((i) => [i.key, { ...i }]));
      const notes: string[] = [];
      for (const k of args.remove ?? []) {
        const i = items.get(k);
        if (!i) notes.push(`${k}: no such item`);
        else if (i.roblox) notes.push(`${k}: it is on Roblox (id ${i.roblox.id}); passes and products can't be deleted there, so it stays: the user takes it off sale`);
        else items.delete(k);
      }
      for (const s of args.set ?? []) {
        const before = items.get(s.key);
        if (!before && !s.kind) return errorOutput(`${s.key}: a new item needs kind ("pass" or "product")`);
        if (before && s.kind && before.roblox && s.kind !== before.kind) return errorOutput(`${s.key}: it is on Roblox as a ${before.kind}; a new key is needed for a ${s.kind}`);
        const next: StoreItem = {
          ...(before ?? { key: s.key, kind: s.kind!, name: s.key, description: '', price: 0, benefit: '' }),
          ...(s.kind ? { kind: s.kind } : {}),
          ...(s.name !== undefined ? { name: s.name.trim() } : {}),
          ...(s.description !== undefined ? { description: s.description.trim() } : {}),
          ...(s.price !== undefined ? { price: s.price } : {}),
          ...(s.benefit !== undefined ? { benefit: s.benefit.trim() } : {}),
          ...(s.order !== undefined ? { order: s.order } : {}),
          ...(s.icon !== undefined ? { icon: { ...(before?.icon ?? {}), subject: s.icon } } : {}),
          ...(s.category !== undefined ? { category: s.category.trim() } : {}),
          ...(s.offer !== undefined ? { offer: s.offer.trim() } : {}),
          ...(s.hue !== undefined ? { hue: s.hue } : {}),
          ...(s.random !== undefined ? { random: s.random } : {}),
        };
        items.set(s.key, next);
      }
      const next: StoreCatalog = { style: (args.style as StoreCatalog['style'] | undefined) ?? now.style, why: args.why ?? now.why, items: [...items.values()], updatedAt: now.updatedAt };
      const check = checkCatalog(next);
      if (check.errors.length) return errorOutput(`Nothing saved. Fix these and call again:\n- ${check.errors.join('\n- ')}`);
      const touched = [...(args.set ?? []).map((x) => x.key), ...(args.remove ?? [])];
      const mod = sf.saveCatalog(next, p.extras().syncMap, { apply: caller.drafts ? [] : touched });
      d.bus.emit('storefront.changed', { part: 'catalog' });
      p.audit.event({ kind: 'storefront.catalog', title: `Store: ${next.items.length} item(s), ${next.style}`, runId: caller.runId, taskId: caller.taskId, role: caller.role, detail: { keys: next.items.map((i) => i.key) } });
      return jsonOutput(
        { style: next.style, items: next.items.map((i) => ({ key: i.key, kind: i.kind, name: i.name, price: i.price, status: itemStatus(i) })), module: mod.file },
        [
          ...catalogLines(next),
          ...(check.warnings.length ? ['Look again:', ...check.warnings.map((w) => `- ${w}`)] : []),
          ...notes,
          mod.written
            ? `${mod.file} written (require it from the server at startup and from the client); sync with roblox_sync_push. Nothing is on Roblox until the user pushes it.`
            : `A draft: the Storefront page shows it; the game's ${mod.file} keeps the store it had until it is put in the game. Nothing is on Roblox until the user pushes it.`,
        ].join('\n'),
      );
    },
  });

  reg.register({
    name: 'store_module',
    title: 'Put the store in the game',
    description: "Writes the game's ShurikenStore module from the store as designed (its items, prices and Roblox ids) and syncs that one file to Studio. Only when the user asked for the store in the game. Granting each item in the game's code is the engineers' work: hand it off.",
    capability: 'storefront.catalog',
    permission: 'roblox_write',
    available: monetization,
    input: {},
    handler: async ({ caller }) => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      if (!d.apply) return errorOutput('Not available in this engine.');
      const r = await d.apply(p);
      p.audit.event({ kind: 'storefront.apply', title: 'Store module written by an agent', runId: caller.runId, role: caller.role, detail: r });
      return textOutput(r.note, { file: r.file, synced: r.synced });
    },
  });

  reg.register({
    name: 'store_list',
    title: 'The Storefront as it is',
    description: "The game's store (each item: kind, price, status draft | live | changed | offsale, its icon), its title and description, and its pictures (thumbnails, the pick, the icon, the item icon template).",
    capability: 'storefront.read',
    permission: 'read',
    available: anyOn,
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const sf = new Storefront(p.root);
      const c = sf.catalog();
      const copy = sf.copy();
      const art = readArt(p.root);
      return jsonOutput(
        { catalog: c, copy: { title: copy.title, description: copy.description }, art: { thumbs: art.thumbs.map((t) => t.name), pick: art.pick?.winner ?? null, icons: art.icons.map((i) => i.name), gameIcon: art.gameIcon ?? null, template: !!art.template } },
        [
          ...(d.prefs().monetization ? catalogLines(c) : ['Monetization is off.']),
          `Title: ${copy.title || '(none yet)'}`,
          `Description: ${copy.description ? `${copy.description.length} characters` : '(none yet)'}`,
          `Thumbnails: ${art.thumbs.length}${art.pick ? `, picked ${art.pick.winner}` : ''}; game icon: ${art.gameIcon ?? 'none'}; item icon template: ${art.template ? 'set' : 'none'}`,
        ].join('\n'),
      );
    },
  });

  reg.register({
    name: 'copy_write',
    title: "Write the game's copy",
    description: `The words that sell the game: its title (at most ${STORE_LIMITS.title} characters), its description (at most ${STORE_LIMITS.gameDescription}) and the shown name and description of each item in the store (items: [{key, name, description}]). Each change is checked (limits, nothing pointing off Roblox) and the earlier version kept to go back to. The user puts the title and description on Roblox; item texts go with the items when they are pushed.`,
    capability: 'storefront.copy',
    permission: 'write_project',
    available: copyOn,
    input: {
      title: z.string().max(STORE_LIMITS.title).optional(),
      description: z.string().max(STORE_LIMITS.gameDescription).optional(),
      items: z.array(z.strictObject({ key: z.string(), name: z.string().max(STORE_LIMITS.name).optional(), description: z.string().max(STORE_LIMITS.description).optional() })).max(40).optional(),
    },
    handler: async ({ args, caller }) => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const sf = new Storefront(p.root);
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const f of ['title', 'description'] as const) {
        const v = args[f];
        if (v === undefined) continue;
        const c = checkCopy(f, v);
        errors.push(...c.errors);
        warnings.push(...c.warnings);
      }
      let catalog: StoreCatalog | null = null;
      if (args.items?.length) {
        if (!d.prefs().monetization) return errorOutput('Monetization is off (Settings → Storefront): there are no items to write.');
        catalog = sf.catalog();
        for (const t of args.items) {
          const i = catalog.items.find((x) => x.key === t.key);
          if (!i) {
            errors.push(`${t.key}: no such item (store_list shows the keys)`);
            continue;
          }
          if (t.name !== undefined) i.name = t.name.trim();
          if (t.description !== undefined) i.description = t.description.trim();
        }
        const check = checkCatalog(catalog);
        errors.push(...check.errors);
      }
      if (errors.length) return errorOutput(`Nothing saved. Fix these and call again:\n- ${errors.join('\n- ')}`);
      const copy = args.title !== undefined || args.description !== undefined ? sf.saveCopy({ ...(args.title !== undefined ? { title: args.title.trim() } : {}), ...(args.description !== undefined ? { description: args.description.trim() } : {}) }, by(caller)) : sf.copy();
      if (catalog) sf.saveCatalog(catalog, p.extras().syncMap, { apply: caller.drafts ? [] : args.items!.map((t) => t.key) });
      d.bus.emit('storefront.changed', { part: 'copy' });
      return textOutput(
        [
          `Title (${copy.title.length}/${STORE_LIMITS.title}): ${copy.title || '(none)'}`,
          `Description: ${copy.description.length}/${STORE_LIMITS.gameDescription} characters`,
          ...(catalog ? [`Items written: ${args.items!.map((t) => t.key).join(', ')}`] : []),
          ...(warnings.length ? ['Look again:', ...warnings.map((w) => `- ${w}`)] : []),
        ].join('\n'),
      );
    },
  });

  reg.register({
    name: 'copy_get',
    title: "The game's copy",
    description: "The game's title and description as they are, the versions before them, and each store item's shown name and description with its benefit.",
    capability: 'storefront.read',
    permission: 'read',
    available: copyOn,
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const sf = new Storefront(p.root);
      const copy = sf.copy();
      const c = sf.catalog();
      return jsonOutput({ title: copy.title, description: copy.description, history: copy.history, items: c.items.map((i) => ({ key: i.key, kind: i.kind, name: i.name, description: i.description, price: i.price, benefit: i.benefit })) });
    },
  });

  reg.register({
    name: 'thumb_shot',
    title: 'Stage a shot for a thumbnail',
    description:
      'Captures the place in Studio from a camera you set (Edit view, the game\'s UI hidden), saved as "shot:<name>" for thumb_compose to build on. fov: the camera\'s field of view (30-45 for a hero or a close-up, 50-70 for a world). outline: the subjects to set apart with an outline (instance paths such as "Workspace/Arena/Mech"; a Highlight on each for the picture only, white unless outline_color). Stage it first (the game\'s best-looking spot, its hero model or creature in frame, the light right): the shot is only as good as the scene. A wide Studio window gives a sharper shot.',
    capability: 'storefront.art',
    permission: 'roblox_read',
    available: studioOn,
    input: {
      name: z.string().regex(NAME).describe('Its name ("arena-wide", "mech-hero")'),
      camera: z.array(z.number()).length(3),
      look_at: z.array(z.number()).length(3),
      fov: z.number().min(10).max(110).optional(),
      outline: z.array(z.string().regex(/^[\w .\-/]+$/).max(200)).max(8).optional(),
      outline_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    },
    handler: async ({ args }) => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      // The UI hidden, the field of view and the outlines exist only within this shot's own turn in Studio (a wait in
      // line can be minutes: other agents' playtests and pictures must not meet a staged scene), put back before it ends.
      let before: { ui?: boolean; fov?: number; missing?: string[] } = {};
      let shot: Awaited<ReturnType<typeof d.studio.screenshot>> = null;
      try {
        shot = await d.studio.inEditTurn(async () => {
          const was = await d.studio.runLuau(shotSetup(args.fov, args.outline ?? [], args.outline_color ?? '#FFFFFF'), 'Edit', 15_000).catch(() => null);
          try {
            if (was?.ok) before = JSON.parse(was.output.trim() || '{}') as typeof before;
          } catch {
            /* put back what a shot always changes */
          }
          try {
            return await d.studio.screenshot({ camera: args.camera as [number, number, number], lookAt: args.look_at as [number, number, number] });
          } finally {
            await d.studio.runLuau(shotTeardown(before), 'Edit', 15_000).catch(() => null);
          }
        });
      } catch (e) {
        if (e instanceof ScreenshotUnavailableError) return textOutput(e.message, { visualCheck: 'unavailable' });
        throw e;
      }
      if (!shot) return errorOutput('Studio returned no picture');
      const img = decodeImage(Buffer.from(shot.data, 'base64'));
      mkdirSync(SHOT_DIR(p.root), { recursive: true });
      writeFileSync(join(SHOT_DIR(p.root), `${args.name}.png`), encodePng(img));
      const missing = before.missing?.length ? ` Not found, so not outlined: ${before.missing.join(', ')}.` : '';
      return { content: [png(shrinkImage(img, 960)), { type: 'text', text: `Saved as "shot:${args.name}" (${img.width}x${img.height}). Use it as an ImageLabel's image in thumb_compose (scaleType "Crop" fills the frame).${missing}` }] };
    },
  });

  reg.register({
    name: 'thumb_compose',
    title: 'Compose a thumbnail or icon',
    description: `Draws a thumbnail (${ART_SIZES.thumbnail.w}x${ART_SIZES.thumbnail.h}) or the game's icon (${ART_SIZES.icon.w}x${ART_SIZES.icon.h}) from screens in the UI mockup format, exactly as Roblox UI would draw them: an ImageLabel with a shot ("shot:<name>", scaleType "Crop") as the backdrop, then text with strokes (outlined, chunky), gradients and fades (transparency sequences), glows and shadows, cut or slanted shapes, the game's icons ("icon:<Name>") and line-art glyphs ("glyph:<name>"). Lay it out in points on a 1920x1080 canvas (an icon uses the top-left 512x512). Returns the picture: look at it at the size players see it (about 300 px wide for a thumbnail, 150 px for the icon) and fix what doesn't read. size "thumbnail" adds a candidate (make ${THUMB_CANDIDATES} that really differ, then thumb_pick); size "icon" saves an icon candidate (gameIcon: true makes it the game's icon). Format: the same elements, properties and limits ui_mockup_create takes (cls, size, pos, anchor, bg, bgT, gradient, stroke, shadow, shape, text, textColor, textSize, font, image, scaleType, kids…).`,
    capability: 'storefront.art',
    permission: 'write_project',
    available: anyOn,
    input: {
      name: z.string().regex(NAME),
      size: z.enum(['thumbnail', 'icon']),
      screens: z.array(z.any()).min(1).max(4).describe('ScreenGuis in the mockup format'),
      theme: z.record(z.string(), z.any()).optional(),
      note: z.string().max(300).optional().describe('What this one tries, in a sentence'),
      gameIcon: z.boolean().optional(),
    },
    handler: async ({ args, caller }) => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const out = compose(args.screens as MockNode[], args.size, artImages(p.root, d.resourcesDir), args.theme as Record<string, MockColor> | undefined);
      if (out.errors.length) return errorOutput(`Not drawn. Fix these and call again:\n- ${out.errors.join('\n- ')}`);
      const sub = args.size === 'thumbnail' ? 'thumbs' : 'icons';
      const dir = join(new Storefront(p.root).artDir(), sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${args.name}.png`), encodePng(out.image));
      const art = readArt(p.root);
      const list = args.size === 'thumbnail' ? art.thumbs : art.icons;
      const entry = { name: args.name, file: `${sub}/${args.name}.png`, note: args.note ?? '', at: nowIso(), by: by(caller) };
      const at = list.findIndex((x) => x.name === args.name);
      if (at >= 0) list[at] = entry;
      else list.push(entry);
      if (args.size === 'icon' && args.gameIcon) art.gameIcon = args.name;
      writeArt(p.root, art);
      d.bus.emit('storefront.changed', { part: 'art' });
      const small = shrinkImage(out.image, args.size === 'thumbnail' ? 320 : 160);
      return {
        content: [
          png(shrinkImage(out.image, 960)),
          png(small),
          { type: 'text', text: [`Saved ${entry.file}. The second picture is the size players see it at.`, ...out.warnings.map((w) => `Look again: ${w}`), ...out.notes].join('\n') },
        ],
      };
    },
  });

  reg.register({
    name: 'thumb_pick',
    title: 'Pick the best thumbnail',
    description: `A judge who didn't make them looks at the thumbnail candidates (the latest ${THUMB_CANDIDATES}, or the ones named) and eliminates one per round, the weakest of those left, until one remains: the winner, with why each one fell. The user downloads the winner on the Storefront page (and can pick another).`,
    capability: 'storefront.art',
    permission: 'read',
    available: anyOn,
    input: { candidates: z.array(z.string().regex(NAME)).min(2).max(8).optional() },
    handler: async ({ args }) => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      if (!d.judge) return errorOutput('No judge is available in this engine (the app runs one).');
      const art = readArt(p.root);
      const pool = args.candidates?.length ? art.thumbs.filter((t) => args.candidates!.includes(t.name)) : art.thumbs.slice(-THUMB_CANDIDATES);
      if (pool.length < 2) return errorOutput(`Make at least 2 thumbnails first (thumb_compose size "thumbnail"); ${THUMB_CANDIDATES} that really differ is the aim.`);
      const letters = pool.map((_, i) => String.fromCharCode(65 + i));
      const images = pool.map((t) => {
        const img = decodeImage(readFileSync(join(new Storefront(p.root).artDir(), t.file)));
        return { mediaType: 'image/png' as const, data: encodePng(shrinkImage(img, 768)).toString('base64') };
      });
      const game = `Game: ${p.summary.name}${p.summary.description ? ` — ${p.summary.description.slice(0, 400)}` : ''}\n${pool.map((t, i) => `${letters[i]}: ${t.name}${t.note ? ` (${t.note})` : ''}`).join('\n')}`;
      const ruling = await d.judge(judgePrompt(game, letters), images);
      if (!ruling) return errorOutput('The judge gave no ruling this time; try again.');
      const nameOf = (l: string) => pool[l.trim().toUpperCase().charCodeAt(0) - 65]?.name ?? l;
      const pick = { winner: nameOf(ruling.winner), rounds: ruling.rounds.map((r) => ({ out: nameOf(r.out), why: r.why })), why: ruling.why, at: nowIso(), among: pool.map((t) => t.name) };
      const now = readArt(p.root);
      now.pick = pick;
      writeArt(p.root, now);
      d.bus.emit('storefront.changed', { part: 'art' });
      return textOutput([`Winner: ${pick.winner}. ${pick.why}`, 'Fell out, in order:', ...pick.rounds.map((r, i) => `${i + 1}. ${r.out}: ${r.why}`)].join('\n'), { pick });
    },
  });

  reg.register({
    name: 'store_icons',
    title: 'Draw the store\'s icons as one set',
    description:
      'Draws the icons of what the game sells as ONE consistent set (512x512, seen as circles on Roblox: keep the subject inside the middle circle): every icon is the set\'s template (screens in the mockup format with an ImageLabel whose image is "{subject}", optionally a TextLabel with "{text}" and colours "{hue}": the item\'s hue from the catalog, or given here) with the item\'s subject in it, so the frame, background, light and type are the same across passes. template: set or change it (kept for later icons); items: [{key, subject, text?}] with subject "model:<Name>" (the game\'s model, drawn with an outline: view three-quarter unless "model:<Name>@front|side|top"), "glyph:<name>" or "icon:<Name>". The item\'s icon file goes with it when it is pushed.',
    capability: 'storefront.art',
    permission: 'write_project',
    available: monetization,
    input: {
      template: z.array(z.any()).min(1).max(2).optional().describe('ScreenGuis in the mockup format; one ImageLabel with image "{subject}"'),
      theme: z.record(z.string(), z.any()).optional(),
      items: z.array(z.strictObject({ key: z.string(), subject: z.string().max(80).optional(), text: z.string().max(24).optional(), hue: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() })).min(1).max(20),
    },
    handler: async ({ args, signal }) => {
      const p = project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const art = readArt(p.root);
      const template = args.template ? { screens: args.template as MockNode[], ...(args.theme ? { theme: args.theme as Record<string, MockColor> } : {}), at: nowIso() } : art.template;
      if (args.template && !templateHasSubject(args.template as MockNode[])) return errorOutput('The template needs an ImageLabel whose image is "{subject}": that is where each item\'s subject goes.');
      if (!template) return errorOutput('Give the set a template first (template: screens with an ImageLabel "{subject}").');
      const sf = new Storefront(p.root);
      const catalog = sf.catalog();
      const dir = join(sf.artDir(), 'items');
      const subjectsDir = join(sf.artDir(), 'subjects');
      mkdirSync(dir, { recursive: true });
      const images = artImages(p.root, d.resourcesDir);
      const lines: string[] = [];
      const pics: ToolContent[] = [];
      const store = new ModelStore(p.root);
      const drawn = new Map<string, { icon: { subject: string; file: string; sha: string }; hue?: string }>();
      for (const it of args.items) {
        if (signal?.aborted) break;
        const item = catalog.items.find((x) => x.key === it.key);
        if (!item) {
          lines.push(`${it.key}: no such item`);
          continue;
        }
        const subject = it.subject ?? item.icon?.subject;
        if (!subject) {
          lines.push(`${it.key}: no subject (model:<Name>, glyph:<name> or icon:<Name>)`);
          continue;
        }
        let ref = subject;
        const model = /^model:([A-Za-z0-9_]+)(?:@(three-quarter|front|side|top))?$/.exec(subject);
        if (model) {
          if (!d.renderIcon) {
            lines.push(`${it.key}: models are drawn by the Shuriken app (this engine runs without it); a glyph works`);
            continue;
          }
          const name = model[1]!;
          const m = store.get(name);
          const assembly = m?.assembly ?? (store.parts(name).length ? name : null);
          const parts = assembly ? store.parts(assembly) : m ? [m] : [];
          const meshes = parts.map((x) => ({ meta: x, glb: modelGlb(p.root, x.name) }));
          if (!parts.length || meshes.some((x) => !x.glb)) {
            lines.push(`${it.key}: no model ${name} with a mesh (model_list shows them)`);
            continue;
          }
          const url = await d.renderIcon(meshes.map((x) => ({ glb: x.glb!, color: x.meta.color, material: x.meta.material, origin: assembly ? x.meta.origin : undefined })), { view: (model[2] ?? 'three-quarter') as 'three-quarter', outline: true }).catch(() => null);
          const data = url ? /^data:image\/png;base64,(.+)$/.exec(url)?.[1] : null;
          if (!data) {
            lines.push(`${it.key}: ${name} could not be drawn this time`);
            continue;
          }
          mkdirSync(subjectsDir, { recursive: true });
          writeFileSync(join(subjectsDir, `${name}.png`), Buffer.from(data, 'base64'));
          ref = `art:subjects/${name}.png`;
        }
        const hue = it.hue ?? item.hue ?? '#808080';
        const out = compose(iconFromTemplate(template.screens, ref, it.text ?? '', hue), 'icon', images, template.theme ? (fillTemplate(template.theme, ref, '', hue) as Record<string, MockColor>) : undefined);
        if (out.errors.length) return errorOutput(`The template doesn't draw:\n- ${out.errors.join('\n- ')}`);
        const file = `items/${it.key}.png`;
        const bytes = encodePng(out.image);
        writeFileSync(join(sf.artDir(), file), bytes);
        // Its content's hash: a redrawn icon is a change to push, though the file keeps its name.
        drawn.set(it.key, { icon: { subject, file, sha: createHash('sha1').update(bytes).digest('hex').slice(0, 12) }, ...(it.hue ? { hue: it.hue } : {}) });
        if (pics.length < 8) pics.push(png(shrinkImage(out.image, 256)));
        lines.push(`${it.key}: ${file}${out.notes.length ? ` (${out.notes.join('; ')})` : ''}`);
      }
      // Into the catalog and art.json as they are now (a push or an edit may have saved meanwhile): only what this drew.
      if (args.template) {
        const nowArt = readArt(p.root);
        nowArt.template = template;
        writeArt(p.root, nowArt);
      }
      if (drawn.size) {
        const fresh = sf.catalog();
        for (const [key, v] of drawn) {
          const now = fresh.items.find((x) => x.key === key);
          if (!now) continue;
          now.icon = v.icon;
          if (v.hue && !now.hue) now.hue = v.hue;
        }
        // Icons are not in the game's module: nothing of the game changes here.
        sf.saveCatalog(fresh, p.extras().syncMap, { apply: [] });
      }
      d.bus.emit('storefront.changed', { part: 'art' });
      return { content: [...pics, { type: 'text', text: [...lines, 'Look at them side by side: one family, each subject clear inside the circle.'].join('\n') }] };
    },
  });
}
