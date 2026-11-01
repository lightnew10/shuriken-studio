import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { findRobloxFonts } from '../src/core/ui/lab/roblox-fonts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/core/modeling/png';
import { MockupStore } from '../src/core/ui/ui-mockups';
import { IconLibrary } from '../src/core/ui/ui-icons';
import { coreHarness } from './helpers/make-core';
import { scifiVersion } from './fixtures/ui-mockup-scifi';

// The mockup tools as an agent calls them: every change comes back with pictures it can look at, versions are
// fixed in place and retired, a reference picture is read and compared, and icons are made without Studio.

const makeCore = coreHarness();
const agent = (drafts = true) => ({ kind: 'agent' as const, runId: 'run_ui', taskId: null, role: 'copilot-ui', providerId: null, allowedTools: null, ...(drafts ? { drafts: true } : {}) });
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('\n');
const pictures = (r: { content: Array<{ type: string; mimeType?: string; data?: string }> }) => r.content.filter((c) => c.type === 'image');
const sci = () => {
  const v = scifiVersion();
  return { note: v.note, theme: v.theme, screens: v.screens, motion: v.motion };
};

describe('the mockup tools with pictures', () => {
  it('return pictures of what they made, check without saving, fix in place and retire', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const dry = await core.tools.invoke('ui_mockup_create', { title: 'Combat HUD', versions: [sci()], check: true }, agent());
    expect(dry.isError, text(dry)).toBeFalsy();
    expect(text(dry)).toMatch(/^Checked \(nothing saved/);
    expect(pictures(dry)).toHaveLength(2);
    expect(new MockupStore(root).all()).toEqual([]);

    const made = await core.tools.invoke('ui_mockup_create', { title: 'Combat HUD', versions: [sci(), { ...sci(), note: 'calmer', label: 'Calm' }, { ...sci(), note: 'third' }] }, agent());
    expect(made.isError, text(made)).toBeFalsy();
    // Three versions: the phone of each, the desktop of the first.
    expect(pictures(made)).toHaveLength(4);
    const png = Buffer.from(pictures(made)[0]!.data!, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(text(made)).toMatch(/Picture: Combat HUD A · Phone 844×390 pt/);
    // Roblox's own fonts where Studio is installed; stand-ins (and the picture says so) where it isn't.
    if (!findRobloxFonts()) expect(text(made)).toMatch(/text in Segoe UI|blocks/);

    const fixed = await core.tools.invoke('ui_mockup_update', { name: 'combat-hud', revise: [{ version: 'B', set: { 'Combat.Weapon.Ammo': { text: '30' } }, note: 'a full magazine' }], retire: ['C'], render: ['tablet'] }, agent());
    expect(fixed.isError, text(fixed)).toBeFalsy();
    expect(fixed.data).toMatchObject({ versions: ['A', 'B·2', 'C (retired)'], fixed: [{ version: 'B·2' }] });
    expect(pictures(fixed)).toHaveLength(1);
    expect(text(fixed)).toMatch(/Tablet 1180×820/);

    const bad = await core.tools.invoke('ui_mockup_update', { name: 'combat-hud', versions: [{ from: 'A', note: 'x', changes: {} }] }, agent());
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/unknown field "changes" \(set/);
    expect(text(bad)).toMatch(/FORMAT \(else is refused\)/);

    const list = await core.tools.invoke('ui_mockup_list', {}, agent());
    expect(text(list)).toMatch(/Combat HUD \(2 version\(s\) and 1 retired\)/);
    const format = await core.tools.invoke('ui_mockup_list', { format: true }, agent());
    expect(text(format)).toMatch(/A UIGradient MULTIPLIES/);
  });

  it('look at an element big, a button in its states, and hidden screens shown', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    await core.tools.invoke('ui_mockup_create', { title: 'Combat HUD', versions: [sci()], render: false }, agent());
    const big = await core.tools.invoke('ui_mockup_render', { name: 'combat-hud', devices: ['desktop'], focus: 'Combat.Weapon' }, agent());
    expect(big.isError, text(big)).toBeFalsy();
    expect(text(big)).toMatch(/Combat\.Weapon .* px per point/);
    const states = await core.tools.invoke('ui_mockup_render', { name: 'combat-hud', states: true }, agent());
    expect(pictures(states)).toHaveLength(4);
    expect(text(states)).toMatch(/Menu\.Row\.Inventory on the phone, normal then hover, press, selected/);
    const missing = await core.tools.invoke('ui_mockup_render', { name: 'combat-hud', focus: 'Combat.Nope' }, agent());
    expect(text(missing)).toMatch(/No element Combat\.Nope/);
  });

  it('reads a reference picture the user attached and draws a mockup beside it', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const w = 320;
    const h = 180;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(i % w > 200 ? [60, 220, 255, 255] : [12, 24, 34, 255], i * 4);
    mkdirSync(join(ctx.dir, 'attachments'), { recursive: true });
    writeFileSync(join(ctx.dir, 'attachments', 'ui-ref-1.png'), encodePng({ width: w, height: h, data }));
    const alone = await core.tools.invoke('ui_reference', { latest: true }, agent());
    expect(alone.isError, text(alone)).toBeFalsy();
    expect(text(alone)).toMatch(/Reference 320×180: main colours #0c1822/);
    expect(alone.data).toMatchObject({ theme: { bg: '#0c1822' }, fonts: { display: { fonts: expect.arrayContaining(['FredokaOne']) } } });
    await core.tools.invoke('ui_mockup_create', { title: 'Combat HUD', versions: [sci()], render: false }, agent());
    const cmp = await core.tools.invoke('ui_reference', { file: '.shuriken/attachments/ui-ref-1.png', mockup: 'combat-hud' }, agent());
    expect(cmp.isError, text(cmp)).toBeFalsy();
    expect(pictures(cmp)).toHaveLength(1);
    // 16:9 is a desktop's shape.
    expect(cmp.data).toMatchObject({ compare: { device: 'desktop', colours: expect.any(Array) } });
    expect((await core.tools.invoke('ui_reference', { file: '../outside.png' }, agent())).isError).toBe(true);
  });

  it('makes glyph icons and shape images without Studio: pictures only in a design turn, modules when they go in', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const found = await core.tools.invoke('ui_icon', { search: 'missile' }, agent());
    expect(found.data).toMatchObject({ glyphs: expect.arrayContaining(['rocket']) });
    expect(pictures(found)).toHaveLength(1);
    const draft = await core.tools.invoke('ui_icon', { icons: [{ name: 'Ammo', glyph: 'rocket', outline: true }, { name: 'Oops', glyph: 'rockkket' }] }, agent());
    expect(text(draft)).toMatch(/1 of 2 icon\(s\) made\./);
    expect(text(draft)).toMatch(/Ammo \(glyph rocket, outlined\): ui\/icons\/Ammo\.png; a draft \(not uploaded\)/);
    expect(text(draft)).toMatch(/Oops: no glyph "rockkket" \(close: rocket/);
    expect(existsSync(join(root, 'ui/icons/Ammo.png'))).toBe(true);
    expect(existsSync(join(root, 'src/Shared/UiIcons.luau'))).toBe(false);
    // A mockup may now show it as an icon.
    const withIcon = await core.tools.invoke('ui_mockup_create', { title: 'Ammo', versions: [{ note: 'x', screens: [{ name: 'Hud', kids: [{ name: 'Pic', cls: 'ImageLabel', image: 'icon:Ammo', size: [0, 64, 0, 64] }, { name: 'Gone', cls: 'ImageLabel', image: 'icon:Nope', size: [0, 64, 0, 64] }] }] }], render: false }, agent());
    expect(text(withIcon)).toMatch(/no icon "Nope" in the project yet/);
    // Shapes of a mockup element: a fill and an outline per stroke, and the modules once they go into the game.
    await core.tools.invoke('ui_mockup_create', { title: 'Combat HUD', versions: [sci()], render: false }, agent());
    const shapes = await core.tools.invoke('ui_icon', { shapes: [{ name: 'WeaponPanel', mockup: 'combat-hud', path: 'Combat.Weapon' }], upload: false }, agent(false));
    expect(shapes.isError, text(shapes)).toBeFalsy();
    expect(text(shapes)).toMatch(/1 of 1 icon\(s\) made \(3 pictures\)/);
    expect(text(shapes)).toMatch(/WeaponPanel \(shape of Combat\.Weapon, 330×120 pt\)/);
    const lib = new IconLibrary(root);
    expect(lib.get('WeaponPanel')!.shape).toMatchObject({ role: 'fill', lines: ['WeaponPanelLine1', 'WeaponPanelLine2'], size: [330, 120], pad: 7 });
    const shapesModule = readFileSync(join(root, 'src/Shared/UiShapes.luau'), 'utf8');
    expect(shapesModule).toMatch(/WeaponPanel = \{ fill = Icons\.WeaponPanel, lines = \{ Icons\.WeaponPanelLine1, Icons\.WeaponPanelLine2 \}, slice = Rect\.new\(/);
    expect(readFileSync(join(root, 'src/Shared/UiIcons.luau'), 'utf8')).toMatch(/Ammo = "", -- glyph rocket \(not uploaded yet\)/);
  });
});
