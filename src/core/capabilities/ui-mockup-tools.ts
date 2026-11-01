import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { UI_DEVICES, type UiDevice, type UiStateName } from '@shared/ui-layout';
import { auditVersion, compareWithGame, currentVersion, MOCK_DEVICES, MOCK_FORMAT, mockOutline, resolveVersion, versionLabel, type MockKnows, type MockNode, type MockVersion, type Mockup } from '@shared/ui-mockup';
import type { ProjectContext } from '../projects/project-service';
import type { EventBus } from '../events';
import { UiStore } from '../ui/ui-workshop';
import { MockupStore, type MockupChange, type ReviseInput, type VersionInput } from '../ui/ui-mockups';
import { IconLibrary } from '../ui/ui-icons';
import { glyphName, glyphSet, glyphsLike } from '../ui/ui-glyphs';
import { deviceLike, gameBackdrop, pngContent, projectImages, readPicture, renderVersion, statefulPaths, statesSheet } from '../ui/ui-pictures';
import { sideBySide, type Backdrop } from '../ui/ui-render';
import { skinCacheDir, skinForgeFor, warmSkins } from '../ui/forge/resolve';
import { matchDirections } from '../ui/forge/match';
import { compareWithReference, samplePalette, themeFrom } from '../ui/ui-reference';
import { FONT_USES, ROBLOX_FONTS, type FontStyle } from '../ui/ui-fonts';
import { errorOutput, jsonOutput, type ToolContent, type ToolOutput, type ToolRegistry } from './tool-registry';

export interface MockupToolDeps {
  project: () => ProjectContext | null;
  bus: EventBus;
  /** The app's resources (the glyph set); null where there are none. */
  resourcesDir?: string | null;
  /** Fetches the thumbnails of Roblox images into the project's cache before they are drawn (the real app only). */
  fetchImages?: (root: string, refs: string[]) => Promise<void>;
}

/** More of the format than a description holds: how the pieces behave, said once (ui_mockup_list {format: true}). */
export const MOCK_GUIDE = `How the pieces behave (all as Roblox draws them; the mockup pictures show it):
- A UIGradient MULTIPLIES the element's colours: for a colour-to-dark fill set bg "#ffffff" and put the colours in the gradient; a transparency-only gradient (transp, no colors) fades an element out (a strip that fades to the right, a list's edges). Keys go from time 0 to 1.
- UIStroke is Outer unless pos says Inner or Center, follows corners and shapes, and several stack by z: a glow is a wide stroke at t 0.7-0.85 under a thin bright one, or a shadow with offset [0,0] in a bright colour (UIShadow: boxes and corners only, never text or shapes, cut out under the element). stroke {text: true} on a text class outlines the letters (the thick dark outline of simulator numbers: px 2-4).
- shape cuts corners at 45° (cut, points) and leans sides (slant: the top edge sits in by that many points; negative leans out): sci-fi trapezoids and chamfered panels. Roblox has no such property, so the game builds it from images made with ui_icon {shapes}: in the game it is an ImageLabel 9-slice (a fill image, and one outline image per stroke), tinted by bg and the strokes' colours.
- badge adds a child named "Badge" over a corner (pill: a count or NEW; dot; ribbon: a tag across the top edge); the kit's Ui.badge builds the same.
- states change bg, bgT, textColor, textT, imageColor, imageT, rot, scale (a UIScale: hover 1.04, press 0.95), stroke, gradient, shadow; the kit's Ui.react plays them (hover for mouse only, press springs, selected for the current tab, disabled). A UIScale on an item of a list moves its neighbours: put states on a child that fills a fixed slot when they must stay put.
- appear makes the element arrive as its screen opens (Motion.enter): a direction, pop or fade, with a delay.
- image: "rbxassetid://<id>" (an uploaded image: its thumbnail is drawn), "icon:<Name>" (an icon made with ui_icon), "glyph:<name>" (a line-art glyph: ui_icon {search} finds them; ui_icon {icons: [{name, glyph}]} makes it an icon when it goes in the game). Tint with imageColor.
- Fonts are Enum.Font names (ui_reference lists them by look); the pictures draw close stand-ins (Segoe UI, Segoe UI Black for the heavy display faces, Bahnschrift for the sci-fi ones…) and say so.
- Sizes are design points: under kit "ui" a 1920x1080 design (834x396 on an iPhone SE, the phone to design for), under kit "hud" 900x900. forms gives each device form its own layout.`;

// Loose, so a field in the wrong place reaches makeVersion, which names it and says where it belongs.
const versionShape = z.looseObject({
  label: z.string().optional().describe('A short name ("Bottom sheet")'),
  note: z.string().describe('What this version tries, in a sentence'),
  from: z.string().optional().describe('Start from an earlier version ("B"), or the game\'s UI as last read ("game", or "game:HUD" for one screen); then give set (and theme, motion) for what changes'),
  theme: z.record(z.string(), z.unknown()).optional().describe('Colour tokens the screens use as "$name": {"accent": "#ffb020", …} (merges over the version it starts from)'),
  screens: z.array(z.record(z.string(), z.unknown())).optional().describe('The ScreenGuis (whole), unless from is given. The element format is in the tool description; nothing outside it is accepted.'),
  set: z.record(z.string(), z.unknown()).optional().describe('Changes by path: {"Shop.Window.Grid": {"grid": {...}}, "phone:Shop.Window": {...}, "Shop.Hint": null}; a new path with a cls adds an element'),
  motion: z.array(z.record(z.string(), z.unknown())).optional(),
  template: z
    .object({ id: z.string(), direction: z.string().optional(), genre: z.string().optional().describe('A genre (ui_forge {action: "genres"}): its look, accent and believable content'), accent: z.string().optional(), content: z.record(z.string(), z.unknown()).optional() })
    .optional()
    .describe('Start from a Forge screen template in an art direction, filled with the game content (ui_forge {action: "templates"} lists them and what content each reads); then set changes what you want different'),
  reskin: z
    .object({ direction: z.string(), accent: z.string().optional() })
    .optional()
    .describe('Dress the screens in a Forge art direction in one step (with from: "game:Shop" the game\'s own UI): windows, headers, titles, buttons by their colour\'s role, tabs, close buttons, cards, bars, pills and slots get their skins and state art; set then fixes what it read wrong'),
});

const reviseShape = z.looseObject({
  version: z.string().describe('The version to fix in place ("C")'),
  note: z.string().optional().describe('What the fix does (the version keeps its note unless given)'),
  label: z.string().optional(),
  theme: z.record(z.string(), z.unknown()).optional(),
  screens: z.array(z.record(z.string(), z.unknown())).optional(),
  set: z.record(z.string(), z.unknown()).optional().describe('Changes by path, as for a new version'),
  motion: z.array(z.record(z.string(), z.unknown())).optional(),
});

const DEVICE = z.enum(['phone', 'phonePortrait', 'tablet', 'laptop', 'desktop', 'tv']);
const RENDER = z.union([z.array(DEVICE).max(5), z.literal(false)]).optional().describe('Devices to return pictures of (default: phone and desktop for one or two versions, the phone for more); false for none');
const BACKDROP = z.enum(['dark', 'bright', 'game']).optional().describe('Behind the UI: dark (default), bright (a daylight scene: does it read over a sunny game?), game (the project\'s latest viewer picture)');

/** One version's check, short enough for an agent's turn: per device, the findings that matter, and where the top elements land. */
function report(m: Mockup, v: MockVersion) {
  const audit = auditVersion(v);
  return {
    version: versionLabel(v),
    ...(v.label ? { label: v.label } : {}),
    devices: audit.devices.map((d) => ({ device: d.device, form: d.form, ...(Object.values(d.layouts).some(Boolean) ? { layouts: d.layouts } : {}), problems: d.problems, warnings: d.warnings })),
    findings: audit.findings.slice(0, 14).map((f) => ({ severity: f.severity, path: f.path, message: f.message, devices: f.devices, ...(f.whenShown ? { whenShown: true } : {}) })),
    outline: mockOutline(v, ['phone', 'desktop'], 1, 30),
    show: { page: 'ui', item: `mockup:${m.name}@${v.id}` },
  };
}

const verdict = (v: MockVersion): string => {
  const a = auditVersion(v);
  const problems = a.findings.filter((f) => f.severity === 'problem');
  if (!a.findings.length) return `${versionLabel(v)}: nothing to fix on any device`;
  const where = [...new Set(problems.flatMap((f) => f.devices))];
  return `${versionLabel(v)}: ${problems.length} problem(s)${where.length ? ` (${where.join(', ')})` : ''}, ${a.findings.length - problems.length} warning(s)`;
};

/** Refused input, said with the format so the next call can be right. */
const refused = (errors: string[]): ToolOutput => errorOutput(`Nothing saved. Fix these and call again:\n- ${errors.slice(0, 25).join('\n- ')}${errors.length > 25 ? `\n- …and ${errors.length - 25} more` : ''}\n\n${MOCK_FORMAT}`);

/**
 * UI mockups for agents: designs laid out and audited like the game's UI but kept in Shuriken (the UI page
 * shows them) until someone asks for them in the game. The UI copilot designs with them by default; the
 * UI designer agent may sketch with them before it builds. Every change comes back with pictures of it.
 */
export function registerMockupTools(reg: ToolRegistry, d: MockupToolDeps): void {
  const knowsFor = (root: string): MockKnows => {
    const set = glyphSet(d.resourcesDir ?? null);
    const icons = new IconLibrary(root);
    return {
      icon: (name) => !!icons.get(name),
      ...(set ? { glyph: (name: string) => !!glyphName(set, name), glyphsLike: (name: string) => glyphsLike(set, name) } : {}),
    };
  };
  const store = () => {
    const p = d.project();
    if (!p) throw new Error('No project is open in Shuriken');
    return { p, mockups: new MockupStore(p.root, knowsFor(p.root)), game: new UiStore(p.root).get()?.screens ?? null };
  };
  const by = (caller: { role: string | null; kind: string }) => caller.role ?? caller.kind;
  const backdropOf = (p: ProjectContext, b: 'dark' | 'bright' | 'game' | undefined): Backdrop => (b === 'game' ? (gameBackdrop(p.dir) ?? 'dark') : (b ?? 'dark'));

  /** Brings the thumbnails of the uploaded images versions show into the cache, so pictures draw them. */
  const fetchFor = async (p: ProjectContext, versions: MockVersion[]): Promise<void> => {
    // Their forged skins in batches (the GPU when the app has one), before the pictures wear them.
    if (versions.length) await warmSkins(versions.flatMap((v) => MOCK_DEVICES.flatMap((dev) => resolveVersion(v, dev).screens)), skinForgeFor(skinCacheDir(p.root))).catch(() => undefined);
    if (!d.fetchImages || !versions.length) return;
    const refs = new Set<string>();
    const walk = (n: MockNode) => {
      if (typeof n.image === 'string' && /(?:rbxassetid:\/\/|[?&]id=)\d+/i.test(n.image)) refs.add(n.image);
      for (const c of n.kids ?? []) walk(c);
    };
    for (const v of versions)
      for (const sc of v.screens) {
        walk(sc);
        for (const f of Object.values(sc.forms ?? {})) for (const c of f?.kids ?? []) walk(c);
      }
    if (refs.size) await d.fetchImages(p.root, [...refs].slice(0, 120)).catch(() => undefined);
  };

  /** Pictures of versions on devices, and a line for each. */
  const pictures = (p: ProjectContext, m: Mockup, versions: MockVersion[], render: UiDevice[] | false | undefined, backdrop?: Backdrop): { images: ToolContent[]; lines: string[] } => {
    if (render === false || !versions.length) return { images: [], lines: [] };
    const images = projectImages(p.root, d.resourcesDir ?? null);
    const images2: ToolContent[] = [];
    const lines: string[] = [];
    const notes = new Set<string>();
    versions.forEach((v, i) => {
      const devices = render ?? (versions.length <= 2 || i === 0 ? ['phone', 'desktop'] : ['phone']);
      for (const dev of devices) {
        const pic = renderVersion(m, v, dev as UiDevice, { images, skins: skinForgeFor(skinCacheDir(p.root)), ...(backdrop ? { backdrop } : {}) });
        images2.push(pngContent(pic.image));
        lines.push(`Picture: ${pic.caption} (${pic.image.width}×${pic.image.height} px, ${pic.scale} px per point; the rulers count points from the screen's top left).`);
        for (const n of pic.notes) notes.add(n);
      }
    });
    if (notes.size) lines.push(`Drawn: ${[...notes].slice(0, 6).join('; ')}.`);
    return { images: images2, lines };
  };

  const changed = (p: ProjectContext, res: MockupChange, what: string, render: UiDevice[] | false | undefined): ToolOutput => {
    if (!res.mockup) return refused(res.errors);
    const m = res.mockup;
    if (!res.dryRun) d.bus.emit('ui.mockups', { name: m.name });
    const touched = [...res.added, ...(res.revised ?? [])];
    const pics = pictures(p, m, touched, render);
    const status = res.dryRun ? 'Checked (nothing saved: call again without check to keep it)' : what;
    const out = jsonOutput(
      {
        name: m.name,
        title: m.title,
        versions: m.versions.map((v) => `${versionLabel(v)}${v.retired ? ' (retired)' : ''}`),
        chosen: m.chosen ?? null,
        made: res.added.map((v) => report(m, v)),
        ...(res.revised?.length ? { fixed: res.revised.map((v) => report(m, v)) } : {}),
        ...(res.warnings.length ? { warnings: res.warnings.slice(0, 20) } : {}),
        ...(res.dryRun ? { saved: false } : {}),
      },
      `${status} "${m.title}" (${m.name}): ${[...touched.map(verdict), ...(m.chosen ? [`${m.chosen} is the user's pick`] : []), ...(m.applied ? [`${m.applied.version} is recorded as in the game`] : [])].join('; ')}. ${res.dryRun ? '' : `The user sees it on the UI page (show button: page "ui", item "mockup:${m.name}")${touched.length ? '; nothing in the game changed' : ''}.`}${pics.lines.length ? `\n${pics.lines.join('\n')}\nLook at the pictures: fix what reads badly (crowding, text running out of its box, weak contrast, a missing glow) before you show it.` : ''}`,
    );
    return { ...out, content: [...out.content, ...pics.images] };
  };

  reg.register({
    name: 'ui_mockup_create',
    title: 'Make a UI mockup',
    description: `A UI mockup on every device, in Shuriken (NOT the game): 1-4 versions that really differ (or a template). Returns audits and pictures; check: true saves nothing.\n${MOCK_FORMAT}`,
    capability: 'app.mockups',
    permission: 'write_project',
    strict: true,
    input: {
      title: z.string().optional().describe('What it is ("Sword shop", "Combat HUD"; default: from name)'),
      name: z.string().optional().describe('Its id in links (default: from the title)'),
      brief: z.string().optional().describe('What it is for and what the user asked'),
      versions: z.array(versionShape).min(1).max(4),
      render: RENDER,
      check: z.boolean().optional().describe('Check and draw only: nothing is saved'),
    },
    handler: async ({ args, caller }) => {
      try {
        const { p, mockups, game } = store();
        const res = mockups.create({ title: args.title ?? (args.name ? args.name.replace(/[-_]+/g, ' ') : 'Mockup'), ...(args.name ? { name: args.name } : {}), ...(args.brief ? { brief: args.brief } : {}), versions: args.versions as VersionInput[], by: by(caller), game, dryRun: !!args.check });
        if (args.render !== false) await fetchFor(p, res.added);
        return changed(p, res, 'Made', args.render as UiDevice[] | false | undefined);
      } catch (e) {
        return errorOutput((e as Error).message);
      }
    },
  });

  reg.register({
    name: 'ui_mockup_update',
    title: 'Change a UI mockup',
    description:
      'Changes a mockup without touching the game, and returns pictures of what changed. revise: fix versions IN PLACE ([{version: "C", set: {"Shop.Window.Grid": {...}}, note}]: C keeps its letter, its revision counts up, the one before is kept). versions: new ideas (1-4), each whole screens or from an earlier one ("B", "game:HUD") with set (paths start with the screen; "phone:Shop.Window" changes the phone layout; null removes; a new path with a cls adds; theme merges). Fix a version that missed with revise, not a new letter. retire: superseded versions to hide (kept; restore brings them back). check: true checks and draws without saving. choose: the version the user picked ("" for none). applied: {version, files} once you have built it into the game, in a turn that puts it in. Same format as ui_mockup_create.',
    capability: 'app.mockups',
    permission: 'write_project',
    strict: true,
    input: {
      name: z.string().optional().describe('The mockup (its name or title)'),
      mockup: z.string().optional().describe('Same as name'),
      versions: z.array(versionShape).min(1).max(4).optional(),
      revise: z.array(reviseShape).min(1).max(4).optional(),
      retire: z.array(z.string()).optional().describe('Versions to retire (hide from the UI page; kept)'),
      restore: z.array(z.string()).optional().describe('Retired versions to show again'),
      choose: z.string().optional(),
      applied: z.strictObject({ version: z.string(), files: z.array(z.string()).optional().describe('The code files that build it') }).optional(),
      render: RENDER,
      check: z.boolean().optional().describe('Check and draw only: nothing is saved'),
    },
    handler: async ({ args, caller }) => {
      try {
        const { p, mockups, game } = store();
        const which = args.name ?? args.mockup ?? '';
        const m = mockups.find(which);
        if (!m) return errorOutput(`No mockup "${which}". Mockups: ${mockups.summaries().map((s) => `${s.name} (${s.title})`).join(', ') || 'none yet (ui_mockup_create makes one)'}`);
        // A design turn changes nothing in the game, so it has nothing to record as built.
        if (args.applied && caller.drafts) return errorOutput('applied records a version you built into the game, and this turn designs only: nothing went into the game. It is recorded in the turn that puts it in.');
        if (args.check && (args.retire || args.restore || args.choose !== undefined || args.applied)) return errorOutput('check only checks versions and fixes: leave retire, restore, choose and applied for the call that saves.');
        let res: MockupChange = { mockup: m, added: [], errors: [], warnings: [] };
        if (args.revise?.length) {
          res = mockups.revise(m.name, args.revise as ReviseInput[], by(caller), !!args.check);
          if (!res.mockup) return refused(res.errors);
        }
        if (args.versions?.length) {
          const next = mockups.addVersions(m.name, args.versions as VersionInput[], by(caller), game, !!args.check);
          if (!next.mockup) return refused(next.errors);
          res = { ...next, revised: res.revised ?? [], warnings: [...res.warnings, ...next.warnings] };
        }
        if (!res.mockup) return refused(res.errors);
        for (const [ids, on] of [
          [args.retire, true],
          [args.restore, false],
        ] as const) {
          if (!ids?.length) continue;
          const r = mockups.retire(m.name, [...ids], on);
          if (!r.mockup) return errorOutput(`Not ${on ? 'retired' : 'restored'}: ${r.errors.join('; ')}`);
          res.mockup = r.mockup;
        }
        if (args.choose !== undefined) res.mockup = mockups.choose(m.name, args.choose.trim() ? args.choose.trim().toUpperCase() : null) ?? res.mockup;
        if (args.applied) res.mockup = mockups.markApplied(m.name, args.applied.version.trim().toUpperCase(), args.applied.files ?? []) ?? res.mockup;
        if (args.render !== false) await fetchFor(p, [...res.added, ...(res.revised ?? [])]);
        return changed(p, res, 'Changed', args.render as UiDevice[] | false | undefined);
      } catch (e) {
        return errorOutput((e as Error).message);
      }
    },
  });

  reg.register({
    name: 'ui_mockup_list',
    title: 'The UI mockups',
    description:
      "The project's UI mockups (title, versions with their revisions, retired ones, the user's pick, what is in the game) and the game's screens as last read from Studio. With name: that mockup's full description (version: which one; default the user's pick, else the newest), to revise it or to build it into the game. format: true returns the whole mockup format and how its pieces behave.",
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: { name: z.string().optional(), version: z.string().optional(), format: z.boolean().optional() },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      try {
        if (args.format) return jsonOutput({ format: MOCK_FORMAT, guide: MOCK_GUIDE }, `${MOCK_FORMAT}\n\n${MOCK_GUIDE}`);
        const { p, mockups } = store();
        if (!args.name) {
          const all = mockups.summaries();
          const snap = new UiStore(p.root).get();
          return jsonOutput(
            {
              mockups: all.map((m) => ({ name: m.name, title: m.title, brief: m.brief, versions: m.versions.map((v) => `${versionLabel(v)}${v.label ? ` ${v.label}` : ''}${v.retired ? ' (retired)' : ''}: ${v.note}`), chosen: m.chosen ?? null, inGame: m.applied ? `${m.applied.version}, ${m.applied.at}` : null })),
              game: snap ? { read: snap.capturedAt, from: snap.source, screens: snap.screens.map((s) => s.name) } : null,
            },
            all.length ? `${all.length} mockup(s): ${all.map((m) => `${m.title} (${m.versions.filter((v) => !v.retired).length} version(s)${m.versions.some((v) => v.retired) ? ` and ${m.versions.filter((v) => v.retired).length} retired` : ''}${m.chosen ? `, ${m.chosen} picked` : ''}${m.applied ? `, ${m.applied.version} in the game` : ''})`).join('; ')}.` : 'No mockups yet.',
          );
        }
        const m = mockups.find(args.name);
        if (!m) return errorOutput(`No mockup "${args.name}". Mockups: ${mockups.summaries().map((s) => s.name).join(', ') || 'none yet'}`);
        const v = args.version ? m.versions.find((x) => x.id === args.version!.trim().toUpperCase()) : currentVersion(m);
        if (!v) return errorOutput(`"${m.title}" has no version ${args.version} (versions: ${m.versions.map((x) => x.id).join(', ')})`);
        const { history, ...shown } = v;
        return jsonOutput(
          { name: m.name, title: m.title, brief: m.brief, versions: m.versions.map((x) => ({ id: x.id, ...(x.rev && x.rev > 1 ? { rev: x.rev } : {}), label: x.label, note: x.note, from: x.from, ...(x.retired ? { retired: true } : {}) })), chosen: m.chosen ?? null, applied: m.applied ?? null, version: shown, ...(history?.length ? { earlierRevisions: history.map((h) => `${h.rev}: ${h.note} (${h.at})`) } : {}) },
          `"${m.title}" version ${versionLabel(v)}${v.label ? ` (${v.label})` : ''}${m.chosen === v.id ? ', the one the user picked' : ''}${m.applied?.version === v.id ? `, in the game${m.applied.rev !== v.rev && (v.rev ?? 1) > 1 ? ' (fixed since it was built: build it again)' : ''}` : ''}${v.retired ? ', retired' : ''}.`,
        );
      } catch (e) {
        return errorOutput((e as Error).message);
      }
    },
  });

  reg.register({
    name: 'ui_mockup_audit',
    title: 'Check a UI mockup on every device',
    description:
      "Lays a mockup version out the way Roblox would on a phone (landscape and portrait), a tablet, a desktop and a TV (ui_audit's layout engine and checks) and returns the findings with the devices they happen on, and where its elements land. compare: true compares it with the game's UI as last read from Studio, element by element by path: after you build a mockup into the game (with the mockup's names) and run ui_audit, the game should match it within 4 points on every device.",
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: {
      name: z.string(),
      version: z.string().optional().describe("Default: the user's pick, else the newest"),
      devices: z.array(DEVICE).optional(),
      compare: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      try {
        const { p, mockups } = store();
        const m = mockups.find(args.name);
        if (!m) return errorOutput(`No mockup "${args.name}"`);
        const v = args.version ? m.versions.find((x) => x.id === args.version!.trim().toUpperCase()) : currentVersion(m);
        if (!v) return errorOutput(`"${m.title}" has no version ${args.version}`);
        const devices = (args.devices?.length ? args.devices : MOCK_DEVICES) as UiDevice[];
        const audit = auditVersion(v, devices);
        const out: Record<string, unknown> = {
          name: m.name,
          version: versionLabel(v),
          devices: audit.devices,
          findings: audit.findings.slice(0, 40),
          outline: mockOutline(v, devices.length > 3 ? ['phone', 'desktop'] : devices, 2, 60),
        };
        let summary = verdict(v);
        if (args.compare) {
          const snap = new UiStore(p.root).get();
          if (!snap?.screens.length) return errorOutput("The game's UI hasn't been read from Studio yet: run ui_audit (in a turn that may use Studio) first, then compare.");
          const cmp = compareWithGame(v, snap.screens, devices);
          out.compare = { read: snap.capturedAt, ...cmp };
          const missing = cmp.screens.filter((s) => !s.inGame).map((s) => s.name);
          summary += `; against the game read ${new Date(snap.capturedAt).toLocaleTimeString()}: ${cmp.matched} of ${cmp.checked} element placements match${missing.length ? `, screens not in the game: ${missing.join(', ')}` : ''}${cmp.differences.length ? `, ${cmp.differences.length} difference(s)` : ''}`;
        }
        return jsonOutput(out, `"${m.title}" ${summary}.`);
      } catch (e) {
        return errorOutput((e as Error).message);
      }
    },
  });

  reg.register({
    name: 'ui_mockup_render',
    title: 'Look at a UI mockup',
    description:
      "Pictures of a mockup version drawn the way Roblox lays it out (the audit's engine), with gradients, transparency, strokes, glows, shapes, images, glyphs and outlined text, Roblox's top bar, the notch and a TV's safe area, and rulers in points. devices: which (default phone). focus: an element's path, drawn big (check an icon, a stroke, a badge). states: true draws each element that has states (or one path) in each state side by side. show: hidden elements or screens to draw as shown. backdrop: dark, bright or game. Look before you show a version to the user.",
    capability: 'app.mockups',
    permission: 'read',
    strict: true,
    input: {
      name: z.string(),
      version: z.string().optional().describe("Default: the user's pick, else the newest"),
      devices: z.array(DEVICE).min(1).max(5).optional(),
      device: DEVICE.optional().describe('One device (the same as devices: [device])'),
      focus: z.string().optional().describe('An element path ("Hud.Ammo"): that element, big'),
      states: z.union([z.boolean(), z.string()]).optional().describe('true: every element with states (up to 4), or one element path'),
      show: z.array(z.string()).max(12).optional().describe('Paths of hidden elements or screens to draw as shown'),
      backdrop: BACKDROP,
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      try {
        const { p, mockups } = store();
        const m = mockups.find(args.name);
        if (!m) return errorOutput(`No mockup "${args.name}"`);
        const v = args.version ? m.versions.find((x) => x.id === args.version!.trim().toUpperCase()) : currentVersion(m);
        if (!v) return errorOutput(`"${m.title}" has no version ${args.version} (versions: ${m.versions.map((x) => x.id).join(', ')})`);
        await fetchFor(p, [v]);
        const images = projectImages(p.root, d.resourcesDir ?? null);
        const backdrop = backdropOf(p, args.backdrop);
        // "device" (as ui_lab_view takes it) was dropped unread and the phone drawn instead: designers asked for the
        // upright phone and saw the landscape one.
        const devices = (args.devices?.length ? args.devices : args.device ? [args.device] : ['phone']) as UiDevice[];
        const content: ToolContent[] = [];
        const lines: string[] = [];
        const notes = new Set<string>();
        if (args.states) {
          const paths = typeof args.states === 'string' ? [args.states] : statefulPaths(v, devices[0]!).slice(0, 4);
          if (!paths.length) return errorOutput(`No element of ${versionLabel(v)} has states (states: {hover, press, selected, disabled} on an element).`);
          for (const path of paths) {
            const sheet = statesSheet(m, v, devices[0]!, path, images, backdrop);
            if (!sheet) {
              lines.push(`No element ${path} on the ${UI_DEVICES[devices[0]!].label.toLowerCase()}.`);
              continue;
            }
            content.push(pngContent(sheet.image));
            lines.push(`Picture: ${path} on the ${UI_DEVICES[devices[0]!].label.toLowerCase()}, normal then ${sheet.states.join(', ') || '(no states)'}.`);
          }
        } else {
          for (const dev of devices) {
            const pic = renderVersion(m, v, dev, { images, backdrop, skins: skinForgeFor(skinCacheDir(p.root)), ...(args.focus ? { focus: args.focus } : {}), ...(args.show?.length ? { show: args.show } : {}) });
            if (pic.unknown.length) return errorOutput(`No element ${pic.unknown.join(', ')} in ${versionLabel(v)} on the ${UI_DEVICES[dev].label.toLowerCase()} (paths start with the screen: "${v.screens[0]?.name ?? 'Screen'}.Element").`);
            content.push(pngContent(pic.image));
            lines.push(`Picture: ${pic.caption} (${pic.image.width}×${pic.image.height} px, ${Math.round(pic.scale * 100) / 100} px per point; rulers in points${args.focus ? ` from ${pic.region.x},${pic.region.y}` : ''}).`);
            for (const n of pic.notes) notes.add(n);
          }
        }
        if (notes.size) lines.push(`Drawn: ${[...notes].slice(0, 8).join('; ')}.`);
        return { content: [{ type: 'text', text: lines.join('\n') }, ...content], data: { name: m.name, version: versionLabel(v), pictures: content.length } };
      } catch (e) {
        return errorOutput((e as Error).message);
      }
    },
  });

  reg.register({
    name: 'ui_reference',
    title: 'Read a reference picture',
    description:
      "A picture the user holds up as the look they want (attached in the dock: .shuriken/attachments/…, or latest: the newest attachment): its colours (the main ones by area, the loud accents), a theme to start from, and the Roblox fonts by look (Enum.Font names a mockup can use). With mockup: that version drawn on the device nearest the picture's shape, beside the reference, and where they differ (colours the mockup lacks, lighter or darker, greyer or louder, busier or emptier, region by region). Numbers to steer by: look at both pictures and decide what to take from it.",
    capability: 'app.mockups',
    permission: 'read',
    input: {
      file: z.string().optional().describe('The picture, relative to the project folder (".shuriken/attachments/ui-….png")'),
      latest: z.boolean().optional().describe('The newest picture attached in the dock'),
      mockup: z.string().optional().describe('A mockup to compare with it'),
      version: z.string().optional(),
      device: DEVICE.optional().describe('Default: the device nearest the picture\'s shape'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args }) => {
      try {
        const { p, mockups } = store();
        let path: string | null = null;
        if (args.file) {
          const full = resolve(p.root, args.file);
          const rel = relative(p.root, full);
          if (rel.startsWith('..') || isAbsolute(rel)) return errorOutput(`${args.file} is outside the project folder`);
          path = full;
        } else if (args.latest) {
          const dir = join(p.dir, 'attachments');
          const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)) : [];
          const newest = files.map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
          if (!newest) return errorOutput('No picture is attached in this project yet (the user attaches one in the dock).');
          path = join(dir, newest.f);
        } else return errorOutput('Give file (the attachment\'s path) or latest: true.');
        if (!existsSync(path)) return errorOutput(`No file ${args.file ?? path}`);
        let ref;
        try {
          ref = readPicture(path);
        } catch (e) {
          return errorOutput(`Can't read the picture (${(e as Error).message}): PNG or baseline JPEG.`);
        }
        const palette = samplePalette(ref);
        const theme = themeFrom(palette);
        const fonts = Object.fromEntries((Object.keys(ROBLOX_FONTS) as FontStyle[]).map((k) => [k, { use: FONT_USES[k], fonts: ROBLOX_FONTS[k] }]));
        const forge = matchDirections(palette).slice(0, 3);
        const out: Record<string, unknown> = { picture: { file: relative(p.root, path).replace(/\\/g, '/'), size: [ref.width, ref.height] }, palette, theme, fonts, forge };
        const lines = [
          `Reference ${ref.width}×${ref.height}: main colours ${palette.main.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(', ')}${palette.accents.length ? `; accents ${palette.accents.map((c) => c.hex).join(', ')}` : ''}.`,
          `A theme to start from: ${Object.entries(theme).map(([k, v]) => `${k} ${v}`).join(', ')} (the area behind a game's UI is often its 3D world: keep what is the UI's).`,
          `Fonts by look (Enum.Font): ${(Object.keys(ROBLOX_FONTS) as FontStyle[]).map((k) => `${k}: ${ROBLOX_FONTS[k].slice(0, 6).join(', ')}`).join('; ')}.`,
          `Forge art directions nearest its colours: ${forge.map((m) => `${m.id} (${Math.round(m.fit * 100)}%${m.accent ? `, accent ${m.accent}: skin "${m.id}:button:primary${m.accent}"` : ''})`).join(', ')} — look at one with ui_forge {action: "sheet", direction, accent}.`,
        ];
        const content: ToolContent[] = [];
        if (args.mockup) {
          const m = mockups.find(args.mockup);
          if (!m) return errorOutput(`No mockup "${args.mockup}"`);
          const v = args.version ? m.versions.find((x) => x.id === args.version!.trim().toUpperCase()) : currentVersion(m);
          if (!v) return errorOutput(`"${m.title}" has no version ${args.version}`);
          const device = (args.device as UiDevice | undefined) ?? deviceLike(ref.width, ref.height);
          await fetchFor(p, [v]);
          // The mockup without rulers or caption, beside the reference at the same height.
          const pic = renderVersion(m, v, device, { images: projectImages(p.root, d.resourcesDir ?? null), backdrop: gameBackdrop(p.dir) ?? 'dark', scale: Math.min(1, 720 / UI_DEVICES[device].w), bare: true, skins: skinForgeFor(skinCacheDir(p.root)) });
          const cmp = compareWithReference(ref, pic.image);
          const height = Math.min(480, pic.image.height);
          content.push(pngContent(sideBySide([{ label: 'reference', image: fitHeight(ref, height) }, { label: `${m.title} ${versionLabel(v)} on the ${UI_DEVICES[device].label.toLowerCase()}`, image: fitHeight(pic.image, height) }])));
          out.compare = { mockup: m.name, version: versionLabel(v), device, ...cmp };
          lines.push(`Against ${m.title} ${versionLabel(v)} on the ${UI_DEVICES[device].label.toLowerCase()} (${pic.caption}): ${cmp.differences.length ? cmp.differences.join('; ') : 'no big difference in colour, lightness or busyness'}.`);
        }
        const res = jsonOutput(out, lines.join('\n'));
        return { ...res, content: [...res.content, ...content] };
      } catch (e) {
        return errorOutput((e as Error).message);
      }
    },
  });
}

/** A picture scaled to a height (box-filtered down). */
function fitHeight(img: { width: number; height: number; data: Uint8Array }, h: number): { width: number; height: number; data: Uint8Array } {
  const w = Math.max(1, Math.round((img.width * h) / img.height));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * img.width + xx) * 4;
          for (let k = 0; k < 4; k++) acc[k]! += img.data[o + k]!;
          n++;
        }
      out.set(acc.map((a) => Math.round(a / n)), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}
