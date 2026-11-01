import { join } from 'node:path';
import { z } from 'zod';
import { ICON_NAME, ICON_SIZE, type IconView } from '@shared/icon';
import { layoutScreen, strokesOf, UI_DEVICES } from '@shared/ui-layout';
import { currentVersion, resolveVersion, versionLabel } from '@shared/ui-mockup';
import { encodePng } from '../modeling/png';
import { drawGlyph, glyphName, glyphSet, glyphsLike, glyphSheet, searchGlyphs } from '../ui/ui-glyphs';
import { MockupStore } from '../ui/ui-mockups';
import { shapeImages } from '../ui/ui-shapes';
import { pngContent } from '../ui/ui-pictures';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { EventBus } from '../events';
import { captureUi, uiOutline, UiStore } from '../ui/ui-workshop';
import { errorOutput, jsonOutput, type ToolContent, type ToolRegistry } from './tool-registry';
import { registerMockupTools } from './ui-mockup-tools';
import { registerUiLabTools } from './ui-lab-tools';
import { registerUiForgeTools } from './ui-forge-tools';
import { IconLibrary, decalImageLuau, type UiIcon } from '../ui/ui-icons';
import { ModelStore } from '../modeling/model-store';
import { modelGlb } from './model-tools';
import { uploadBlocker } from '../roblox/content-rules';
import { resolveCreator, type OpenCloudAssets } from '../roblox/open-cloud-assets';
import type { CodeSync } from '../roblox/code-sync';

export interface UiToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  lease: PlaytestLease;
  bus: EventBus;
  /** Draws a model as a UI icon (the app's render page); absent where the engine runs without the app. */
  renderIcon?: (parts: Array<{ glb: Buffer; color?: string; material?: string; origin?: [number, number, number] }>, opts: { view: IconView; outline: boolean }) => Promise<string | null>;
  /** Open Cloud uploads for the icons (absent: they stay local and the module lists them as ""). */
  cloud?: OpenCloudAssets;
  uploads?: () => { enabled: boolean; creatorId: string | null };
  rememberCreator?: (id: string) => void;
  sync?: CodeSync;
  /** The app's resources (the glyph set); null where there are none. */
  resourcesDir?: string | null;
  /** Fetches Roblox images' thumbnails into the project's cache before pictures draw them (the real app only). */
  fetchImages?: (root: string, refs: string[]) => Promise<void>;
}

/** How many icons one ui_icon call makes, and how many of their pictures come back in its result. */
export const ICON_LIMITS = { perCall: 24, shown: 8 };

/**
 * The UI workshop for agents: ui_audit reads the game's ScreenGuis from Studio, lays them out on a
 * phone, a tablet and a desktop the way Roblox does, and reports what a player would trip over. Each
 * audit also refreshes the UI panel the user sees.
 */
export function registerUiTools(reg: ToolRegistry, d: UiToolDeps): void {
  reg.register({
    name: 'ui_audit',
    title: 'Audit the game UI',
    description:
      'Reads every ScreenGui (StarterGui in Edit mode; when that is empty because scripts build the UI, a short playtest reads the player\'s PlayerGui — or your own running playtest) and lays it out the way Roblox does on a phone (844×390 with notch insets), a tablet (1180×820), a desktop (1920×1080) and a TV (1920×1080, the 10-foot interface: screens that declare FitTenFoot fit bigger), plus a portrait phone (390×844, status and home bars) when the game allows portrait, under the 58-point top bar unless a ScreenGui ignores the inset. Returns an outline (where each top element lands per device) and findings: elements off the screen, buttons too small to tap or covering each other, text too small, cut off or low in contrast, buttons under Roblox\'s top-bar buttons, text and buttons a TV may crop, looping animations still running in hidden UI. The user sees the same UI and findings in the UI panel. Run it after UI work and fix every "problem".',
    capability: 'roblox.app.inspect',
    permission: 'roblox_read',
    available: () => d.studio.availability(),
    input: {
      source: z.enum(['auto', 'edit', 'playtest']).optional().describe('auto (default): StarterGui, or a playtest when StarterGui has no ScreenGuis; edit: StarterGui only; playtest: the playing client\'s PlayerGui'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller, signal }) => {
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      // A playtest run for the audit belongs to the calling agent (or to the UI panel).
      const owner = caller.runId ?? `${caller.kind}:${caller.role ?? 'user'}`;
      let snap;
      try {
        const cap = await captureUi(d, { source: args.source ?? 'auto', owner, signal });
        snap = new UiStore(p.root).save(cap);
      } catch (e) {
        return errorOutput(`ui_audit could not read the UI: ${(e as Error).message}`);
      }
      d.bus.emit('ui.changed', { screens: snap.screens.length, findings: snap.findings.length });
      const problems = snap.findings.filter((f) => f.severity === 'problem').length;
      const summary = !snap.screens.length
        ? `No ScreenGuis in ${snap.source}: the game has no UI there yet.`
        : snap.findings.length
          ? `${snap.screens.length} screen(s) read from ${snap.source}; ${problems} problem(s) and ${snap.findings.length - problems} warning(s) to look at.`
          : `${snap.screens.length} screen(s) read from ${snap.source}; nothing a player would trip over on phone, tablet or desktop.`;
      return jsonOutput({ source: snap.source, truncated: snap.truncated, outline: uiOutline(snap), findings: snap.findings.slice(0, 40) }, summary);
    },
  });
  /** Uploads an icon's PNG (a Decal) and reads its image id; what happened, in words. */
  const uploadIcon = async (p: ProjectContext, lib: IconLibrary, icon: UiIcon, signal?: AbortSignal): Promise<string> => {
    if (!d.cloud || !d.uploads?.().enabled) return 'not uploaded: uploading is off (Settings) or unavailable';
    const file = join(p.root, icon.file);
    const blocked = uploadBlocker(file);
    if (blocked) {
      lib.update(icon.name, { error: blocked });
      return `NOT uploaded: the picture has ${blocked} (Roblox removes such images)`;
    }
    const who = await resolveCreator(d.studio, d.uploads().creatorId, d.rememberCreator ?? (() => undefined));
    if (!who) return 'not uploaded: uploading needs the Roblox creator (sign in to Studio, or set the creator id in Settings)';
    const r = await d.cloud.upload({ file, type: 'Decal', name: `${icon.name} icon`, description: `UI ${icon.kind === 'shape' ? 'panel shape' : 'icon'} of ${icon.model ?? icon.glyph ?? icon.shape?.of ?? icon.name}, made with Shuriken Studio`, creator: { userId: who } }, signal);
    if (!r.ok || !r.assetId) {
      lib.update(icon.name, { error: r.error ?? 'unknown error' });
      return `not uploaded: ${r.error ?? 'unknown error'}`;
    }
    lib.update(icon.name, { decalId: r.assetId, imageId: undefined, error: undefined });
    return (await readImageId(lib, icon.name, r.assetId, signal)) ?? `uploaded as decal ${r.assetId}; its image id could not be read in Studio yet (moderation, or Studio is busy): ui_icon {list: true} reads it later`;
  };

  /** Reads an uploaded decal's image id in Studio and keeps it; the line to report, or null when it isn't known yet. */
  const readImageId = async (lib: IconLibrary, name: string, decalId: string, signal?: AbortSignal): Promise<string | null> => {
    if (!d.studio.connected) return null;
    const free = await d.studio.waitForLease(15_000);
    if (!free.ok) return null;
    const q = await d.studio.runLuau(decalImageLuau(decalId), 'Edit', 30_000, signal).catch(() => null);
    const imageId = q?.ok ? /(\d{5,})/.exec(q.output)?.[1] : undefined;
    if (!imageId) return null;
    lib.update(name, { imageId, error: undefined });
    return `rbxassetid://${imageId}`;
  };

  reg.register({
    name: 'ui_icon',
    title: 'Make UI icons',
    description:
      "Icons and panel shapes for the game's UI, saved under ui/icons, uploaded to Roblox and listed in the generated module UiIcons (Icons.Coin is \"rbxassetid://…\", or \"\" until its upload is known; shapes also in UiShapes). icons: up to " +
      ICON_LIMITS.perCall +
      ' {name, model} draws one of the game\'s 3D models (view: three-quarter | front | side | top; a dark outline unless outline: false), or {name, glyph} a line-art glyph without Studio or the app (white lines to tint with ImageColor3; outline: true adds a dark outline, color "#rrggbb" bakes a colour, glow "#rrggbb" a soft glow, weight the line width, 2 by default). search: words ("missile", "trade", "energy") finds glyphs and shows them. shapes: [{name, mockup, version?, path}] makes the 9-sliced images of a mockup element\'s shape (a white fill and an outline per stroke). list: true shows them and reads image ids not known yet. In a design turn pictures are saved only. Look at the pictures; never put text, an emoji or a placeholder id where an icon belongs.',
    capability: 'app.mockups',
    permission: 'roblox_write',
    strict: true,
    input: {
      icons: z
        .array(
          z.strictObject({
            name: z.string().regex(ICON_NAME),
            model: z.string().min(1).optional(),
            glyph: z.string().min(1).optional(),
            view: z.enum(['three-quarter', 'front', 'side', 'top']).optional(),
            outline: z.boolean().optional(),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            glow: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            weight: z.number().min(0.5).max(4).optional(),
          }),
        )
        .min(1)
        .max(ICON_LIMITS.perCall)
        .optional(),
      search: z.string().min(1).max(200).optional().describe('Words for a glyph: returns the best matches, drawn'),
      shapes: z
        .array(z.strictObject({ name: z.string().regex(ICON_NAME), mockup: z.string(), version: z.string().optional(), path: z.string().describe('The shaped element ("Hud.Weapon")') }))
        .min(1)
        .max(8)
        .optional(),
      list: z.boolean().optional(),
      upload: z.boolean().optional().describe('false: draw and save only (look first, upload with the next call). Default true.'),
    },
    handler: async ({ args, caller, signal }) => {
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const lib = new IconLibrary(p.root);
      const map = p.extras().syncMap;
      const loc = IconLibrary.moduleLocation(map);
      const set = glyphSet(d.resourcesDir ?? null);
      const view = (i: UiIcon) => ({ name: i.name, ...(i.model ? { model: i.model, view: i.view } : {}), ...(i.glyph ? { glyph: i.glyph } : {}), ...(i.shape ? { shape: i.shape.role === 'fill' ? 'fill' : `outline of ${i.shape.of}` } : {}), file: i.file, image: i.imageId ? `rbxassetid://${i.imageId}` : null, ...(i.error ? { notUploaded: i.error } : {}) });
      /** The modules on disk, and in the game when they changed (a draft turn writes no game code). */
      const publish = async (): Promise<string> => {
        if (caller.drafts) return 'Drafts: the pictures are saved; UiIcons is written when they are put into the game.';
        const m = lib.writeModule(map);
        if (!m.written) return `UiIcons is up to date (${m.file}).`;
        const pushed = d.sync && d.studio.connected ? await d.sync.push(p.root, map, { only: m.files }).catch((e: Error) => ({ errors: [{ path: m.file, error: e.message }] })) : null;
        return `${m.files.join(' and ')} written (require(${m.requirePath}))${pushed ? (pushed.errors.length ? '; sync with roblox_sync_push (Studio was busy)' : ' and synced') : '; sync with roblox_sync_push'}.`;
      };
      if (args.search) {
        if (!set) return errorOutput('The glyph set is not installed with this app (resources/ui-glyphs).');
        const found = searchGlyphs(set, args.search, 24);
        if (!found.length) return errorOutput(`No glyph for "${args.search}": try a plainer word (shield, coin, timer, arrow).`);
        return { content: [{ type: 'text', text: `${found.length} glyph(s) for "${args.search}", best first: ${found.join(', ')}. Use one in a mockup as image "glyph:<name>", or make it an icon with ui_icon {icons: [{name, glyph}]}.` }, pngContent(glyphSheet(set, found))], data: { glyphs: found } };
      }
      if (args.list || (!args.icons?.length && !args.shapes?.length)) {
        const notes: string[] = [];
        if (!caller.drafts) {
          for (const i of lib.all().filter((x) => x.decalId && !x.imageId)) {
            const got = await readImageId(lib, i.name, i.decalId!, signal);
            if (got) notes.push(`${i.name}: ${got}`);
          }
        }
        const text = await publish();
        return jsonOutput({ icons: lib.all().map(view), module: loc, ...(notes.length ? { nowKnown: notes } : {}) }, `${lib.all().length} icon(s). ${text}`);
      }
      const store = new ModelStore(p.root);
      const lines: string[] = [];
      const pictures: ToolContent[] = [];
      let made = 0;
      let done = 0;
      const asked = (args.icons?.length ?? 0) + (args.shapes?.length ?? 0);
      const keep = async (saved: UiIcon, what: string, png: Buffer) => {
        made++;
        if (pictures.length < ICON_LIMITS.shown) pictures.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
        const up = caller.drafts ? 'a draft (not uploaded)' : args.upload === false ? 'saved, not uploaded (upload: false)' : await uploadIcon(p, lib, saved, signal);
        lines.push(`${saved.name} (${what}): ${saved.file}; ${up}`);
      };
      for (const spec of args.icons ?? []) {
        if (signal?.aborted) break;
        if (!!spec.model === !!spec.glyph) {
          lines.push(`${spec.name}: give model (a picture of a 3D model) or glyph (a line-art glyph), one of them.`);
          continue;
        }
        if (spec.glyph) {
          const name = set ? glyphName(set, spec.glyph) : null;
          if (!set || !name) {
            lines.push(`${spec.name}: no glyph "${spec.glyph}"${set ? ` (close: ${glyphsLike(set, spec.glyph).slice(0, 6).join(', ') || 'none'}; ui_icon {search} finds them)` : ''}.`);
            continue;
          }
          const rgb = (h?: string): [number, number, number] | undefined => (h ? [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255] : undefined);
          const png = encodePng(drawGlyph(set.icons[name]!, ICON_SIZE, { ...(spec.weight ? { weight: spec.weight } : {}), ...(spec.color ? { color: rgb(spec.color)! } : {}), ...(spec.glow ? { glow: rgb(spec.glow)! } : {}), outline: spec.outline ? 0.035 : 0 }));
          const saved = lib.save({ name: spec.name, kind: 'glyph', glyph: name, outline: !!spec.outline, ...(spec.color || spec.glow || spec.weight ? { style: { ...(spec.weight ? { weight: spec.weight } : {}), ...(spec.color ? { color: spec.color } : {}), ...(spec.glow ? { glow: spec.glow } : {}) } } : {}) }, png);
          await keep(saved, `glyph ${name}${spec.outline ? ', outlined' : ''}`, png);
          done++;
          continue;
        }
        if (!d.renderIcon) {
          lines.push(`${spec.name}: pictures of models are drawn by the Shuriken app, and this engine is running without it (glyphs work).`);
          continue;
        }
        const model = spec.model!;
        const m = store.get(model);
        const assembly = m?.assembly ?? (store.parts(model).length ? model : null);
        const parts = assembly ? store.parts(assembly) : m ? [m] : [];
        if (!parts.length) {
          lines.push(`${spec.name}: no model or assembly named ${model} (model_list shows what exists; a missing one is a quick Kiln build for the modeler); a glyph can stand in (ui_icon {search}).`);
          continue;
        }
        const meshes = parts.map((x) => ({ meta: x, glb: modelGlb(p.root, x.name) }));
        if (meshes.some((x) => !x.glb)) {
          lines.push(`${spec.name}: ${model} has no mesh yet.`);
          continue;
        }
        const which = { view: (spec.view ?? 'three-quarter') as IconView, outline: spec.outline !== false };
        const url = await d.renderIcon(meshes.map((x) => ({ glb: x.glb!, color: x.meta.color, material: x.meta.material, origin: assembly ? x.meta.origin : undefined })), which).catch(() => null);
        const data = url ? /^data:image\/png;base64,(.+)$/.exec(url) : null;
        if (!data) {
          lines.push(`${spec.name}: the picture could not be drawn this time.`);
          continue;
        }
        const png = Buffer.from(data[1]!, 'base64');
        const saved = lib.save({ name: spec.name, kind: 'model', model, ...which }, png);
        await keep(saved, `${model}, ${which.view}`, png);
        done++;
      }
      for (const spec of args.shapes ?? []) {
        if (signal?.aborted) break;
        const mockups = new MockupStore(p.root);
        const mk = mockups.find(spec.mockup);
        const v = mk ? (spec.version ? mk.versions.find((x) => x.id === spec.version!.trim().toUpperCase()) : currentVersion(mk)) : undefined;
        if (!mk || !v) {
          lines.push(`${spec.name}: no mockup "${spec.mockup}"${mk ? ` version ${spec.version}` : ''}.`);
          continue;
        }
        // The element at its design size (points under its screen's UIScale) on the desktop layout.
        const r = resolveVersion(v, 'desktop');
        const box = r.screens.flatMap((s) => layoutScreen(s, UI_DEVICES.desktop)).find((b) => b.path === spec.path);
        if (!box || !box.node.shape) {
          lines.push(`${spec.name}: ${box ? `${spec.path} has no shape` : `no element ${spec.path} in ${mk.title} ${versionLabel(v)}`}.`);
          continue;
        }
        const k = box.k || 1;
        const img = shapeImages(box.node.shape, box.w / k, box.h / k, strokesOf(box.node));
        const lineNames = img.lines.map((_, i) => `${spec.name}Line${i + 1}`);
        const meta = { source: { mockup: mk.name, version: v.id, path: spec.path }, size: img.size, pad: img.pad, slice: img.slice };
        const fillPng = encodePng(img.fill);
        await keep(lib.save({ name: spec.name, kind: 'shape', outline: false, shape: { role: 'fill', ...meta, lines: lineNames } }, fillPng), `shape of ${spec.path}, ${Math.round(img.size[0])}×${Math.round(img.size[1])} pt`, fillPng);
        for (const [i, l] of img.lines.entries()) {
          const png = encodePng(l.image);
          await keep(lib.save({ name: lineNames[i]!, kind: 'shape', outline: false, shape: { role: 'line', of: spec.name, ...meta } }, png), `outline ${i + 1} of ${spec.name} (${l.stroke.px} pt ${l.stroke.pos ?? 'Outer'})`, png);
        }
        done++;
      }
      const text = made ? await publish() : '';
      if (made) d.bus.emit('ui.changed', { icons: lib.all().length });
      const shown = pictures.length < made ? ` The first ${pictures.length} are shown.` : '';
      const usage = made ? `In UI code: local Icons = require(${loc.requirePath}); image.Image = Icons.<Name>${args.shapes?.length ? '; a shape: Ui.shape(frame, require(<Shared>.UiShapes).<Name>)' : ''}.` : '';
      return { content: [{ type: 'text', text: [`${done} of ${asked} icon(s) made${made > done ? ` (${made} pictures)` : ''}.${shown} ${text}`.trim(), ...lines, usage].filter(Boolean).join('\n') }, ...pictures], ...(made ? {} : { isError: true }) };
    },
  });

  registerMockupTools(reg, d);
  registerUiLabTools(reg, d);
  registerUiForgeTools(reg, d);
}
