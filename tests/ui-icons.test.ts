import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { Core } from '../src/core/core';
import { ModelStore } from '../src/core/modeling/model-store';
import { ROLES, WORKSHOP_TOOLS } from '../src/core/agents/roles';
import { IconLibrary } from '../src/core/ui/ui-icons';
import { ICON_SIZE, alphaBounds, iconFit, outlinePx } from '../src/shared/icon';
import type { RenderRequest } from '../src/shared/render';
import { FakeProvider } from './helpers/fake-provider';
import { attachSim } from './helpers/studio-sim';

/**
 * UI icons from the game's own models. The UIs the user holds up as the bar run on rendered item and currency art
 * in every card, counter, tab and rail button; Shuriken's UI agents could make no image at all, so their shops
 * showed text, emoji or rbxassetid://0.
 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const agent = { kind: 'agent' as const, runId: 'run_ui', taskId: null, role: 'ui-engineer', providerId: null, allowedTools: null };

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown().catch(() => {});
});

async function setup(opts: { draws?: boolean } = {}) {
  const asked: Array<Extract<RenderRequest, { kind: 'icon' }>> = [];
  const core = await Core.create({
    dataDir: mkdtempSync(join(tmpdir(), 'shuriken-data-')),
    resourcesDir: resolve(__dirname, '..', 'resources'),
    appVersion: 'test',
    providers: [new FakeProvider({ respond: async () => null })],
    integrations: false,
    logToDisk: false,
    render: async (req) => {
      if (req.kind !== 'icon') return null;
      asked.push(req);
      return opts.draws === false ? null : `data:image/png;base64,${PNG.toString('base64')}`;
    },
  });
  cores.push(core);
  const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
  const ctx = core.openProject(core.createProject({ name: 'Icon Game', rootPath: root }).id);
  core.orchestrator.pause();
  const sim = attachSim(core);
  sim.answer = (code) => (code.includes('GetUserId') ? '4242' : code.includes('InsertService') ? 'rbxassetid://987654321' : 'PASS');
  const uploads: Array<{ file: string; type: string; name: string }> = [];
  (core as unknown as { assetUploads: { upload: (i: { file: string; type: string; name: string }) => Promise<unknown> } }).assetUploads.upload = async (i) => {
    uploads.push({ file: i.file, type: i.type, name: i.name });
    return { ok: true, assetId: '111222333' };
  };
  const store = new ModelStore(root);
  for (const name of ['Coin', 'IronSword']) {
    store.save({ name, hash: 'h', size: [1, 1, 1], triangles: 12, vertices: 8, volume: 1, faces: 6, solids: 1, valid: true, tolerance: null, placements: [], color: '#ffcc33', material: 'Metal' });
    writeFileSync(store.paths(name).glb, Buffer.from('glTF'));
  }
  return { core, ctx, root, sim, asked, uploads };
}

describe('ui_icon: icons drawn from the game\'s own models', () => {
  it('draws, saves, uploads and lists them in the UiIcons module the UI code requires', async () => {
    const { core, root, asked, uploads } = await setup();
    const r = await core.tools.invoke('ui_icon', { icons: [{ name: 'Coin', model: 'Coin' }, { name: 'Sword', model: 'IronSword', view: 'side', outline: false }] }, agent);
    const out = text(r);
    expect(r.isError, out).toBeFalsy();
    expect(out).toMatch(/^2 of 2 icon\(s\) made\./);
    expect(out).toMatch(/Coin \(Coin, three-quarter\): ui\/icons\/Coin\.png; rbxassetid:\/\/987654321/);
    expect(out).toMatch(/Sword \(IronSword, side\): ui\/icons\/Sword\.png; rbxassetid:\/\/987654321/);
    expect(out).toMatch(/local Icons = require\(game\.ReplicatedStorage\.Shared\.UiIcons\)/);
    // The pictures come back to be looked at.
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(2);
    // What the app's render page was asked: the model alone, from the asked angle.
    expect(asked.map((a) => [a.view, a.outline, a.parts.length])).toEqual([['three-quarter', true, 1], ['side', false, 1]]);
    expect(readFileSync(join(root, 'ui/icons/Coin.png')).equals(PNG)).toBe(true);
    expect(uploads).toEqual([
      { file: join(root, 'ui/icons/Coin.png'), type: 'Decal', name: 'Coin icon' },
      { file: join(root, 'ui/icons/Sword.png'), type: 'Decal', name: 'Sword icon' },
    ]);
    const module = readFileSync(join(root, 'src/Shared/UiIcons.luau'), 'utf8');
    expect(module).toContain('\tCoin = "rbxassetid://987654321", -- Coin');
    expect(module).toContain('\tSword = "rbxassetid://987654321", -- IronSword');
    expect(module).toMatch(/^--!strict\n/);
    expect(new IconLibrary(root).all().map((i) => [i.name, i.model, i.view, i.imageId])).toEqual([['Coin', 'Coin', 'three-quarter', '987654321'], ['Sword', 'IronSword', 'side', '987654321']]);
  });

  it('says which model is missing and whom to ask, and still makes the others', async () => {
    const { core, root } = await setup();
    const r = await core.tools.invoke('ui_icon', { icons: [{ name: 'Gem', model: 'Gem' }, { name: 'Coin', model: 'Coin' }] }, agent);
    const out = text(r);
    expect(out).toMatch(/^1 of 2 icon\(s\) made\./);
    expect(out).toMatch(/Gem: no model or assembly named Gem \(model_list shows what exists; a missing one is a quick Kiln build for the modeler\)/);
    expect(existsSync(join(root, 'ui/icons/Gem.png'))).toBe(false);
    const none = await core.tools.invoke('ui_icon', { icons: [{ name: 'Gem', model: 'Gem' }] }, agent);
    expect(none.isError).toBe(true);
  });

  it('an icon whose upload is not known yet is "" in the module, and list reads its image id later', async () => {
    const { core, root, sim, uploads } = await setup();
    // Drawn and saved only.
    const local = await core.tools.invoke('ui_icon', { icons: [{ name: 'Coin', model: 'Coin' }], upload: false }, agent);
    expect(text(local)).toMatch(/saved, not uploaded \(upload: false\)/);
    expect(uploads).toEqual([]);
    expect(readFileSync(join(root, 'src/Shared/UiIcons.luau'), 'utf8')).toContain('\tCoin = "", -- Coin (not uploaded yet)');
    // Uploaded, but Studio can't say its image id yet (moderation).
    sim.answer = (code) => (code.includes('GetUserId') ? '4242' : code.includes('InsertService') ? 'error: asset is not approved' : 'PASS');
    const pending = await core.tools.invoke('ui_icon', { icons: [{ name: 'Coin', model: 'Coin' }] }, agent);
    expect(text(pending)).toMatch(/uploaded as decal 111222333; its image id could not be read in Studio yet/);
    expect(new IconLibrary(root).get('Coin')).toMatchObject({ decalId: '111222333' });
    expect(new IconLibrary(root).get('Coin')!.imageId).toBeUndefined();
    sim.answer = (code) => (code.includes('InsertService') ? 'rbxassetid://555666777' : 'PASS');
    const listed = await core.tools.invoke('ui_icon', { list: true }, agent);
    expect(text(listed)).toMatch(/Coin: rbxassetid:\/\/555666777/);
    expect(readFileSync(join(root, 'src/Shared/UiIcons.luau'), 'utf8')).toContain('\tCoin = "rbxassetid://555666777", -- Coin');
  });

  it("a copilot's draft turn uploads nothing and writes no game code", async () => {
    const { core, root, uploads } = await setup();
    const r = await core.tools.invoke('ui_icon', { icons: [{ name: 'Coin', model: 'Coin' }] }, { ...agent, drafts: true });
    expect(text(r)).toMatch(/a draft \(not uploaded\)/);
    expect(uploads).toEqual([]);
    expect(existsSync(join(root, 'src/Shared/UiIcons.luau'))).toBe(false);
    expect(existsSync(join(root, 'ui/icons/Coin.png'))).toBe(true);
  });

  it('is the UI designer\'s tool, and the designer is told that icons belong in every slot', () => {
    expect(WORKSHOP_TOOLS.ui).toContain('ui_icon');
    const ui = ROLES['ui-engineer']!.instructions;
    expect(ui).toMatch(/art in every slot/);
    expect(ui).toMatch(/ui_icon \{icons: \[\{name, model\}\]\}/);
    expect(ui).toMatch(/a level of craft, not a template/);
    const skill = readFileSync(resolve(__dirname, '..', 'resources', 'skills', 'roblox-ui-references', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/## The bar: what the user's reference games have in common/);
  });
});

describe('fitting what was drawn into the icon', () => {
  it('finds the box of drawn pixels', () => {
    const w = 8;
    const h = 6;
    const data = new Uint8Array(w * h * 4);
    for (const [x, y] of [[2, 1], [5, 4], [3, 3]]) data[(y! * w + x!) * 4 + 3] = 255;
    expect(alphaBounds(data, w, h)).toEqual({ x: 2, y: 1, w: 4, h: 4 });
    expect(alphaBounds(new Uint8Array(w * h * 4), w, h)).toBeNull();
    // A faint fringe (anti-aliasing at the edge of nothing) doesn't count.
    data[3] = 5;
    expect(alphaBounds(data, w, h)).toEqual({ x: 2, y: 1, w: 4, h: 4 });
  });

  it('fills the square, centred, keeping the proportions and room for the outline', () => {
    const stroke = outlinePx(ICON_SIZE, true);
    expect(stroke).toBe(11);
    expect(outlinePx(ICON_SIZE, false)).toBe(0);
    // A tall sword: its height fills the room, its width is centred.
    const tall = iconFit({ x: 300, y: 40, w: 100, h: 400 }, ICON_SIZE, stroke);
    expect(tall.h).toBeCloseTo(ICON_SIZE - 2 * (20 + stroke), 5);
    expect(tall.w).toBeCloseTo(tall.h / 4, 5);
    expect(tall.x + tall.w / 2).toBeCloseTo(ICON_SIZE / 2, 5);
    expect(tall.y).toBeCloseTo(20 + stroke, 5);
    // Nothing is drawn where the outline would be cut off.
    expect(tall.y - stroke).toBeGreaterThanOrEqual(20);
    const wide = iconFit({ x: 0, y: 0, w: 600, h: 150 }, ICON_SIZE, 0);
    expect(wide.w).toBeCloseTo(ICON_SIZE - 40, 5);
    expect(wide.y + wide.h / 2).toBeCloseTo(ICON_SIZE / 2, 5);
  });
});
