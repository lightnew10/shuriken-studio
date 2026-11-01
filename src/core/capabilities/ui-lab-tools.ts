import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { currentVersion, versionLabel, type Mockup, type MockVersion } from '@shared/ui-mockup';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { CodeSync } from '../roblox/code-sync';
import { MockupStore } from '../ui/ui-mockups';
import { UiStore } from '../ui/ui-workshop';
import { gameBackdrop, pngContent, projectImages } from '../ui/ui-pictures';
import { sideBySide, type Backdrop } from '../ui/ui-render';
import { IconLibrary } from '../ui/ui-icons';
import { coreGuiFromSource, type CoreOptions } from '../ui/lab/core-overlays';
import { labDevice, LAB_DEVICES } from '../ui/lab/devices';
import { ADAPTS_PER_DEVICE, gameSubject, labCheck, labMotion, labSheet, labView, mockupSubject, pickDevices, type LabFinding, type LabReport, type LabSubject } from '../ui/lab/lab';
import { uiBuilderModule, uiDataModule } from '../ui/lab/ui-luau';
import { hasSkins, skinCacheDir, skinForgeFor, warmSkins } from '../ui/forge/resolve';
import { shapesAsSkins } from '../ui/forge/shaped';
import { AtlasStore, copyPreviews, forgeForBuild, packAtlases, pointSkins, uploadSkinAtlases } from '../ui/forge/publish';
import { SKIN_DIR } from '../ui/forge/skins';
import { decalImageLuau } from '../ui/ui-icons';
import { uploadBlocker } from '../roblox/content-rules';
import { resolveCreator, type OpenCloudAssets } from '../roblox/open-cloud-assets';
import { errorOutput, type ToolContent, type ToolRegistry } from './tool-registry';

export interface UiLabToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  sync?: CodeSync;
  resourcesDir?: string | null;
  fetchImages?: (root: string, refs: string[]) => Promise<void>;
  /** Open Cloud uploads for forged skins (absent or off: skins build as Studio previews). */
  cloud?: OpenCloudAssets;
  uploads?: () => { enabled: boolean; creatorId: string | null };
  rememberCreator?: (id: string) => void;
}

const DEVICE_IDS = LAB_DEVICES.map((d) => d.id);
const DEVICES = z
  .union([z.enum(['all', 'phones', 'touch']), z.array(z.string()).min(1).max(14)])
  .optional()
  .describe(`"all" (default: every device the game's orientation allows), "phones", "touch", or ids: ${DEVICE_IDS.join(', ')}`);
const TARGET = {
  mockup: z.string().optional().describe('A mockup by name (else the game\'s UI as last read by ui_audit)'),
  version: z.string().optional().describe("Default: the user's pick, else the newest"),
};
const CORE = z
  .object({ chat: z.boolean(), playerList: z.boolean(), backpack: z.boolean(), tools: z.number().int().min(0).max(10), touchControls: z.boolean(), jump: z.boolean() })
  .partial()
  .optional()
  .describe("What the game turns off of Roblox's own UI (default: read from the game's code: SetCoreGuiEnabled, TouchControlsEnabled, Tools)");

/** The game's Luau (its sync folders), for what it turns off of Roblox's UI. */
function gameCode(p: ProjectContext): string[] {
  const out: string[] = [];
  const map = p.extras().syncMap ?? {};
  const roots = Object.keys(map).length ? Object.keys(map) : ['src'];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length > 3000 || !existsSync(dir)) return;
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      const st = statSync(f);
      if (st.isDirectory()) walk(f, depth + 1);
      else if (/\.(luau|lua)$/.test(e) && st.size < 2_000_000) out.push(readFileSync(f, 'utf8'));
    }
  };
  for (const r of roots) walk(join(p.root, r), 0);
  return out;
}

/** Roblox's UI as the game leaves it: its own SetCoreGuiEnabled calls, and a hotbar when it gives Tools. */
export function gameCore(code: string[]): { core: CoreOptions; notes: string[]; adaptive: boolean } {
  const { options, notes } = coreGuiFromSource(code);
  // No character, no touch controls: Roblox shows its thumbstick and jump button for a character only.
  const noCharacter = code.some((c) => /CharacterAutoLoads\s*=\s*false/.test(c));
  if (noCharacter) {
    notes.push('CharacterAutoLoads is false: no character, so no touch thumbstick or jump button');
    options.touchControls = false;
  }
  const tools = code.some((c) => /Instance\.new\(\s*["']Tool["']\s*\)|StarterPack|:Clone\(\)[^\n]*Backpack|\.Backpack\b/.test(c));
  return { core: { ...(tools && options.backpack !== false ? { tools: 3 } : {}), ...options }, notes, adaptive: code.some((c) => ADAPTS_PER_DEVICE.test(c)) };
}

const pick = (m: Mockup, v?: string): MockVersion | null => (v ? (m.versions.find((x) => x.id === v.trim().toUpperCase()) ?? null) : (currentVersion(m) ?? null));

/** One finding in a line an agent can act on. */
const line = (f: LabFinding): string => `${f.severity === 'problem' ? 'PROBLEM' : f.severity === 'warning' ? 'warning' : 'note'} [${f.category}] ${f.path}: ${f.message}${f.devices.length ? ` (${f.devices.length === 1 ? f.devices[0] : `${f.devices.length} devices: ${f.devices.slice(0, 4).join(', ')}${f.devices.length > 4 ? '…' : ''}`})` : ''}${f.whenShown ? ' [when shown]' : ''}`;

export function verdictOf(r: LabReport): string {
  const problems = r.findings.filter((f) => f.severity === 'problem').length;
  const warnings = r.findings.filter((f) => f.severity === 'warning').length;
  const cats = Object.entries(r.counts)
    .filter(([, c]) => c.problems || c.warnings)
    .map(([k, c]) => `${k} ${c.problems}/${c.warnings}`)
    .join(', ');
  return `${r.title}: ${problems ? `${problems} problem${problems === 1 ? '' : 's'}` : 'no problems'}, ${warnings} warning${warnings === 1 ? '' : 's'} on ${r.devices.length} devices in ${r.ms} ms${cats ? ` (problems/warnings: ${cats})` : ''}${r.exactText ? '' : ' — text by estimate (no Studio install)'}`;
}

export function registerUiLabTools(reg: ToolRegistry, d: UiLabToolDeps): void {
  /** Uploads the skin atlases not yet on Roblox (as decals, their image ids read in Studio); what happened, in short lines. */
  /** Uploads the skin atlases not yet on Roblox (as decals, their image ids read in Studio); what happened, in short lines. */
  const uploadAtlases = async (p: ProjectContext, hashes: string[], signal?: AbortSignal): Promise<string[]> => {
    const cloud = d.cloud;
    if (!cloud || !d.uploads?.().enabled) return [];
    return uploadSkinAtlases(p.root, hashes, {
      creator: () => resolveCreator(d.studio, d.uploads!().creatorId, d.rememberCreator ?? (() => undefined)),
      upload: (file, name, description, userId) => cloud.upload({ file, type: 'Decal', name, description, creator: { userId } }, signal),
      blocked: (file) => uploadBlocker(file),
      imageId: async (decalId) => {
        const q = d.studio.connected && (await d.studio.waitForLease(15_000)).ok ? await d.studio.runLuau(decalImageLuau(decalId), 'Edit', 30_000, signal).catch(() => null) : null;
        return q?.ok ? /(\d{5,})/.exec(q.output)?.[1] : undefined;
      },
    });
  };

  /** The subject a call is about: a mockup version, or the game's UI as last read. */
  const subjectOf = async (args: { mockup?: string; version?: string; core?: CoreOptions }): Promise<{ p: ProjectContext; subject: LabSubject; images: ReturnType<typeof projectImages>; notes: string[] } | string> => {
    const p = d.project();
    if (!p) return 'No project is open in Shuriken';
    const detected = gameCore(gameCode(p));
    const core = { ...detected.core, ...args.core };
    const images = projectImages(p.root, d.resourcesDir ?? null);
    if (args.mockup) {
      const m = new MockupStore(p.root).find(args.mockup);
      if (!m) return `No mockup "${args.mockup}"`;
      const v = pick(m, args.version);
      if (!v) return `"${m.title}" has no version ${args.version} (versions: ${m.versions.map((x) => x.id).join(', ')})`;
      if (d.fetchImages) {
        const refs = new Set<string>();
        const walk = (n: { image?: unknown; kids?: unknown[] }) => {
          if (typeof n.image === 'string' && /rbxassetid:\/\/\d+/.test(n.image)) refs.add(n.image);
          for (const c of (n.kids ?? []) as Array<{ image?: unknown; kids?: unknown[] }>) walk(c);
        };
        for (const s of v.screens) walk(s as { image?: unknown; kids?: unknown[] });
        if (refs.size) await d.fetchImages(p.root, [...refs].slice(0, 120)).catch(() => undefined);
      }
      const subject = { ...mockupSubject(m, v, core), title: `${m.title} ${versionLabel(v)}` };
      // Its forged skins in batches (the GPU when the app has one), before the Lab wears them.
      await warmSkins(LAB_DEVICES.flatMap((dev) => subject.screensOn(dev)), skinForgeFor(skinCacheDir(p.root))).catch(() => undefined);
      return { p, subject, images, notes: detected.notes };
    }
    const snap = new UiStore(p.root).get();
    if (!snap) return "The game's UI hasn't been read yet: run ui_audit once (or give a mockup)";
    return { p, subject: gameSubject(`the game's UI (read ${snap.capturedAt})`, snap.screens, { orientation: snap.orientation, core, adaptive: detected.adaptive }), images, notes: detected.notes };
  };
  const backdropOf = (p: ProjectContext, b?: 'dark' | 'bright' | 'game'): Backdrop => (b === 'game' ? (gameBackdrop(p.dir) ?? 'dark') : (b ?? 'dark'));

  reg.register({
    name: 'ui_lab_check',
    title: 'Check UI in the UI Lab',
    description:
      "Checks a mockup version or the game's UI (as last read) on up to 14 real devices (small/notch/big phones, Androids, portrait phones when allowed, iPads, an Android tablet, laptop, 1080p and 1440p desktops, a console on a TV) the way Roblox shows it, with no Studio: Roblox's own fonts and text metrics (TextBounds within ~1 pt), the layout engine, and Roblox's own UI over the game's from its scripts — the touch jump button and thumbstick (bigger on tablets), top bar, hotbar, player list, chat. Findings by category: roblox-ui (covered by Roblox's controls), layout, text (runs out of its box, small, contrast, fits by a hair), touch, gamepad, stress, design, motion (feel of the version's moves). Returns the small phone (iPhone SE) and the notch phone big first, at 1 px per point with what to fix outlined in red (phones are where layouts break), then every other device in one picture, and the worst device big. Fix every PROBLEM, then check again; use ui_lab_view to look closer (inHand: a phone at 2 px per point).",
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: { ...TARGET, devices: DEVICES, core: CORE, backdrop: z.enum(['dark', 'bright', 'game']).optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const s = await subjectOf(args);
      if (typeof s === 'string') return errorOutput(s);
      const report = labCheck(s.subject, { devices: args.devices, images: s.images, skins: skinForgeFor(skinCacheDir(s.p.root)) });
      const devices = pickDevices(s.subject, args.devices);
      const backdrop = backdropOf(s.p, args.backdrop);
      const content: ToolContent[] = [];
      const shown = report.findings.filter((f) => f.severity !== 'note').slice(0, 30);
      const notes = report.findings.filter((f) => f.severity === 'note').slice(0, 6);
      const text = [verdictOf(report), ...shown.map(line), ...(notes.length ? ['Notes:', ...notes.map(line)] : []), ...(Object.keys(report.design).length ? [`Design score (0-100, from defects: spacing, alignment, type, colour, hierarchy, legibility, density): ${Object.entries(report.design).map(([k, v]) => `${k} ${v}`).join(', ')}`] : []),
        ...(report.motion ? ['Motion:', report.motion] : []), ...s.notes.map((n) => `Game code: ${n}`), ...report.notes];
      content.push({ type: 'text', text: text.join('\n') });
      // The phones first and big (at the 0.43 px per point of a sheet, 14-pt text is 6 px tall and a designer can't
      // judge it): the iPhone SE and the notch phone side by side, problems and warnings outlined.
      const skins = skinForgeFor(skinCacheDir(s.p.root));
      const big = ['phone-small', 'phone-notch'].map((id) => devices.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => !!d);
      if (big.length) {
        const pics = big.map((d) => {
          const own = report.findings.filter((f) => f.severity !== 'note' && f.devices.includes(d.id));
          const mark = [...new Set(own.map((f) => f.path))].slice(0, 20);
          return { image: labView(s.subject, d, { mark, images: s.images, skins, backdrop, scale: 1, caption: false }).image, label: `${d.label}${own.length ? ` · ${own.length} to look at` : ''}` };
        });
        content.push(pngContent(sideBySide(pics)));
      }
      const rest = devices.filter((d) => !big.includes(d));
      if (rest.length) content.push(pngContent(labSheet(s.subject, rest, report, { images: s.images, skins, backdrop, width: 300 })));
      const worst = [...devices].filter((d) => !big.includes(d)).sort((a, b) => report.findings.filter((f) => f.severity === 'problem' && f.devices.includes(b.id)).length - report.findings.filter((f) => f.severity === 'problem' && f.devices.includes(a.id)).length)[0];
      if (worst && report.findings.some((f) => f.severity === 'problem' && f.devices.includes(worst.id))) {
        const mark = [...new Set(report.findings.filter((f) => f.severity === 'problem' && f.devices.includes(worst.id)).map((f) => f.path))];
        content.push(pngContent(labView(s.subject, worst, { mark, images: s.images, skins: skinForgeFor(skinCacheDir(s.p.root)), backdrop, scale: worst.w > 1400 ? 0.6 : 1 }).image));
      }
      return { content, data: { verdict: verdictOf(report), counts: report.counts, design: report.design, devices: report.devices, findings: report.findings.slice(0, 80), motion: report.motion, exactText: report.exactText } };
    },
  });

  reg.register({
    name: 'ui_lab_view',
    title: 'Look at UI on a device',
    description:
      "One device big, as a player sees it: the mockup version or the game's UI in Roblox's own fonts, with Roblox's controls drawn over it (roblox: controls, zones to see their touch areas, both, or none). focus: an element's path, drawn big. show: hidden elements or screens to draw as shown. states: {path: hover|press|selected|disabled}. mark: paths outlined in red. backdrop: dark, bright (a sunny scene: does it read?) or game.",
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: {
      ...TARGET,
      device: z.string().describe(`A device id: ${DEVICE_IDS.join(', ')}`),
      roblox: z.enum(['controls', 'zones', 'both', 'none']).optional(),
      focus: z.string().optional(),
      show: z.array(z.string()).max(12).optional(),
      states: z.record(z.string(), z.enum(['hover', 'press', 'selected', 'disabled'])).optional(),
      mark: z.array(z.string()).max(20).optional(),
      backdrop: z.enum(['dark', 'bright', 'game']).optional(),
      inHand: z.boolean().optional().describe('A phone at 2 px per point, as sharp as the phone shows it: judge text size and crowding the way a player does'),
      core: CORE,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const s = await subjectOf(args);
      if (typeof s === 'string') return errorOutput(s);
      const dev = labDevice(args.device);
      if (!dev) return errorOutput(`No device "${args.device}" (devices: ${DEVICE_IDS.join(', ')})`);
      const v = labView(s.subject, dev, { roblox: args.roblox, focus: args.focus, show: args.show, states: args.states, mark: args.mark, images: s.images, skins: skinForgeFor(skinCacheDir(s.p.root)), backdrop: backdropOf(s.p, args.backdrop), ...(args.inHand && !args.focus ? { scale: Math.min(2, 1800 / dev.w) } : dev.w > 1400 && !args.focus ? { scale: 0.75 } : {}) });
      return { content: [{ type: 'text', text: `${s.subject.title} on ${dev.label} (${dev.w}×${dev.h} pt, ${dev.input})${v.notes.length ? `. ${v.notes.join('; ')}` : ''}` }, pngContent(v.image)], data: { device: dev.id, regions: v.regions.map((r) => ({ id: r.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })) } };
    },
  });

  reg.register({
    name: 'ui_lab_motion',
    title: 'Watch a mockup move',
    description:
      "A mockup version's motion as Roblox's Motion module plays it (exact easings, springs, staggers, flights, transitions), drawn as a filmstrip of its key moments with a speed graph per move, and a feel report (durations, overshoot, settle, stagger, readability, against the rules of good UI motion). reduced: true plays it with Reduce Motion on. device: default a notch phone.",
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: { ...TARGET, mockup: z.string(), device: z.string().optional(), reduced: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      const s = await subjectOf(args);
      if (typeof s === 'string') return errorOutput(s);
      const dev = labDevice(args.device ?? 'phone-notch');
      if (!dev) return errorOutput(`No device "${args.device}"`);
      const m = labMotion(s.subject, dev, { reduced: args.reduced, images: s.images, skins: skinForgeFor(skinCacheDir(s.p.root)) });
      if (!m) return errorOutput(`${s.subject.title} has no motion: give the version motion (or appear on elements) first`);
      return { content: [{ type: 'text', text: m.report }, pngContent(m.image)], data: { report: m.report } };
    },
  });

  reg.register({
    name: 'ui_lab_build',
    title: 'Build a mockup into the game exactly',
    description:
      "Puts a mockup version into the game's code exactly as designed (no hand translation): writes the interpreter module ShurikenUi and a data module UiDesign_<Name> beside the game's shared modules, then syncs. A client builds a screen with local Ui = require(<ShurikenUi>); local ui = Ui.screen(require(<UiDesign_Name>), \"Shop\", player.PlayerGui) and wires behaviour by path: ui.by[\"Shop.Window.Buy\"].Activated:Connect(…). States (hover, press) play by themselves; ui.setState(path, \"selected\"|\"disabled\"|nil). A fitted UIScale refits as the screen resizes. Lists filled by code: clone a designed item (ui.by[path]:Clone()). Forged skins come along: their art is saved under ui/skins and uploaded when uploads are on (else it shows in Studio on this PC only); a skinned element's text lives in its child Label (ui.by[path .. \".Label\"].Text). Elements start in their `state`; a screen's `hides` turns Roblox's chat, player list and touch controls off while it is open. Check with ui_lab_check first.",
    capability: 'app.mockups',
    permission: 'roblox_write',
    strict: true,
    input: { mockup: z.string(), version: z.string().optional() },
    handler: async ({ args, caller, signal }) => {
      if (caller.drafts) return errorOutput('A design turn saves drafts only: the version is built into the game when it is put into the game.');
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const m = new MockupStore(p.root).find(args.mockup);
      if (!m) return errorOutput(`No mockup "${args.mockup}"`);
      const v = pick(m, args.version);
      if (!v) return errorOutput(`"${m.title}" has no version ${args.version}`);
      const map = p.extras().syncMap;
      const loc = IconLibrary.moduleLocation(map);
      const dir = loc.file.replace(/\/UiIcons\.luau$/, '');
      const base = loc.requirePath.replace(/\.UiIcons$/, '');
      const name = `UiDesign_${m.name.replace(/[^A-Za-z0-9]+(.)?/g, (_x, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase())}`;
      // Every form layout's screens, so the game builds the one for the device it runs on.
      const forms = { phone: mockupSubject(m, v).screensOn(labDevice('phone-notch')!), phonePortrait: mockupSubject(m, v).screensOn(labDevice('phone-notch-portrait')!), tablet: mockupSubject(m, v).screensOn(labDevice('ipad')!), desktop: mockupSubject(m, v).screensOn(labDevice('desktop')!), tv: mockupSubject(m, v).screensOn(labDevice('console-tv')!) };
      // Panel shapes (cut corners, leaning sides) have no Roblox property: each wears its look as forged art
      // (measured in Studio: the cuts and slants then show as designed).
      const sf = skinForgeFor(skinCacheDir(p.root));
      let shapedArt = 0;
      for (const f of Object.keys(forms) as Array<keyof typeof forms>) {
        const s = shapesAsSkins(forms[f], sf);
        forms[f] = s.screens;
        shapedArt = Math.max(shapedArt, s.made);
      }
      // Forged skins: packed into atlases under ui/skins (one upload each when uploads are on), else a Studio preview on this PC.
      let skinNote = '';
      if (Object.values(forms).some(hasSkins)) {
        await warmSkins(Object.values(forms).flat(), sf).catch(() => undefined);
        const built = forgeForBuild(forms, sf);
        const packed = packAtlases([...built.art].map(([key, f]) => ({ key, image: f.image })));
        new AtlasStore(p.root).save(packed);
        const hashes = packed.atlases.map((x) => x.hash);
        const lines = await uploadAtlases(p, hashes, signal);
        const pointed = pointSkins(built.worn, packed.placements, new AtlasStore(p.root).all());
        Object.assign(forms, pointed.forms);
        const previewDir = pointed.previews.length ? copyPreviews(p.root, pointed.previews) : null;
        skinNote = `\nSkins: ${built.art.size} piece(s) of art in ${hashes.length} atlas${hashes.length === 1 ? '' : 'es'} under ${SKIN_DIR}${lines.length ? ` (${lines.join('; ')})` : ''}.${pointed.previews.length ? ` ${pointed.previews.length} atlas${pointed.previews.length === 1 ? ' is' : 'es are'} not on Roblox yet: the art shows in Studio on this PC only${previewDir ? '' : ' (Studio was not found: it shows nowhere)'}, players see nothing until it is uploaded (turn uploads on in Settings, then build again).` : ''}${built.errors.length ? ` Problems: ${built.errors.join('; ')}` : ''}`;
      }
      const shapeNote = shapedArt ? `\nShapes: ${shapedArt} panel(s) with cut corners or leaning sides wear them as forged art (in the atlases).` : '';
      const same = Object.values(forms).every((f) => JSON.stringify(f) === JSON.stringify(forms.desktop));
      const files: string[] = [];
      const put = (rel: string, text: string) => {
        const abs = join(p.root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text, 'utf8');
        files.push(rel);
      };
      put(`${dir}/ShurikenUi.luau`, uiBuilderModule());
      if (same) put(`${dir}/${name}.luau`, uiDataModule(forms.desktop));
      else for (const [form, screens] of Object.entries(forms)) put(`${dir}/${name}_${form}.luau`, uiDataModule(screens));
      new MockupStore(p.root).markApplied(m.name, v.id, files);
      const pushed = d.sync && d.studio.connected ? await d.sync.push(p.root, map, { only: files }).catch((e: Error) => ({ errors: [{ path: files[0]!, error: e.message }] })) : null;
      const usage = same
        ? `local Ui = require(${base}.ShurikenUi)\nlocal ui = Ui.screen(require(${base}.${name}), "${v.screens[0]?.name ?? 'Screen'}", player:WaitForChild("PlayerGui"))`
        : `-- one data module per device form (${Object.keys(forms).join(', ')}): pick by the screen's size and input, as the kit's Ui.onDevice does\nlocal Ui = require(${base}.ShurikenUi)\nlocal ui = Ui.screen(require(${base}.${name}_phone), "${v.screens[0]?.name ?? 'Screen'}", player:WaitForChild("PlayerGui"))`;
      return { content: [{ type: 'text', text: `${m.title} ${versionLabel(v)} written: ${files.join(', ')}${pushed ? (pushed.errors.length ? ' (sync with roblox_sync_push: Studio was busy)' : ', synced') : ' (sync with roblox_sync_push)'}.${skinNote}${shapeNote}\n${usage}` }], data: { files, usage, ...(shapedArt ? { shapedAsArt: shapedArt } : {}) } };
    },
  });
}
