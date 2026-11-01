import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ForgeDirectionInfo, ForgeGame, ForgeMade, ForgePreview, ForgeSheet, ForgeStatus, ForgeTemplateInfo, ForgeWorn } from '@shared/ui-forge';
import type { UiNode } from '@shared/ui-layout';
import { previewScales } from '@shared/ui-forge';
import { checkVersion } from '@shared/ui-mockup';
import { forgeRpc } from '../src/core/ui/forge/forge-rpc';
import { sampleScreens } from '../src/core/ui/forge/forge-sample';
import { DIRECTIONS } from '../src/core/ui/forge/directions';
import { MockupStore } from '../src/core/ui/ui-mockups';
import { UiStore } from '../src/core/ui/ui-workshop';
import type { UiCapture } from '../src/core/roblox/ui-capture';
import gameCapture from './fixtures/ui-game-capture.json';

// The UI page's Forge as the page calls it: directions with accents, previews drawn small and fast and cached,
// waiting requests replaced by newer ones in their slot, the element sheet, and mockups made in the project.

function harness() {
  const base = mkdtempSync(join(tmpdir(), 'shuriken-forge-'));
  const root = join(base, 'project');
  mkdirSync(join(root, '.shuriken'), { recursive: true });
  const changed: string[] = [];
  const rpc = forgeRpc({ dataDir: join(base, 'data'), resourcesDir: join(process.cwd(), 'resources'), appVersion: 'test', project: () => ({ root, dir: join(root, '.shuriken') }), mockupsChanged: (n) => changed.push(n) });
  const call = <T,>(m: string, p?: unknown) => Promise.resolve().then(() => rpc[m]!(p)) as Promise<T>;
  return { root, changed, call };
}

const pngSize = (url: string) => {
  // [width, height] from the header.
  const b = Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64');
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe('the Forge RPCs', () => {
  it('lists every art direction with its palette and accents that suit it', async () => {
    const { call } = harness();
    const dirs = await call<ForgeDirectionInfo[]>('forge.directions');
    expect(dirs.map((d) => d.id)).toEqual(Object.keys(DIRECTIONS));
    const candy = dirs.find((d) => d.id === 'candy')!;
    expect(candy.name).toBe('Candy');
    expect(candy.tagline).toMatch(/glossy/);
    expect(candy.sampleTitle).toBe('PET SHOP');
    for (const d of dirs) {
      expect(d.swatches.length).toBeGreaterThanOrEqual(6);
      for (const s of d.swatches) expect(s).toMatch(/^#[0-9a-f]{6}$/);
      expect(d.palette.length).toBeGreaterThan(3);
    }
    // Its own accent comes first.
    expect(dirs.find((d) => d.id === 'neon')!.swatches[0]).toBe('#3fe6ff');
    const templates = await call<ForgeTemplateInfo[]>('forge.templates');
    expect(templates.some((t) => t.id === 'shop')).toBe(true);
    expect(templates.find((t) => t.id === 'shop')!.looks).toContain('candy');
  });

  it('has a sample screen per direction that is a valid mockup', () => {
    for (const id of Object.keys(DIRECTIONS)) {
      const screens = sampleScreens(id, '#3fa9ff');
      expect(checkVersion({ screens }).errors, id).toEqual([]);
      expect(JSON.stringify(screens)).toContain(`"${id}:button:primary#3fa9ff"`);
    }
  });

  it('draws previews at the size asked, from the cache the second time', async () => {
    const { call } = harness();
    const a = await call<ForgePreview>('forge.preview', { what: 'sample', direction: 'frost', width: 240, roblox: false });
    expect(a.errors).toEqual([]);
    expect(a.cached).toBe(false);
    const [w, h] = pngSize(a.png);
    expect([w, h]).toEqual([a.w, a.h]);
    expect(Math.abs(w! - 240)).toBeLessThan(8);
    const again = await call<ForgePreview>('forge.preview', { what: 'sample', direction: 'frost', width: 240, roblox: false });
    expect(again.cached).toBe(true);
    expect(again.png).toBe(a.png);
    const tinted = await call<ForgePreview>('forge.preview', { what: 'sample', direction: 'frost', accent: '#FF4D6D', width: 240, roblox: false });
    expect(tinted.cached).toBe(false);
    expect(tinted.png).not.toBe(a.png);
    const tpl = await call<ForgePreview>('forge.preview', { what: 'template', template: 'shop', direction: 'neon', device: 'phone', width: 220 });
    expect(tpl.errors).toEqual([]);
    expect(pngSize(tpl.png)[0]).toBeGreaterThan(200);
    await expect(call('forge.preview', { what: 'template', template: 'nope', direction: 'neon' })).rejects.toThrow(/No screen template "nope"/);
    expect((await call<ForgeStatus>('forge.status')).engine).toBe('thread');
  }, 60_000);

  it('replaces waiting requests in the same slot with the newest', async () => {
    const { call } = harness();
    const ask = (accent: string) => call<ForgePreview>('forge.preview', { what: 'sample', direction: 'frost', accent, width: 200, roblox: false, slot: 'stage' });
    const [one, two, three] = await Promise.all([ask('#111111'), ask('#222222'), ask('#333333')]);
    expect(one!.superseded).toBe(true);
    expect(two!.superseded).toBe(true);
    expect(three!.superseded).toBeUndefined();
    expect(three!.png).toMatch(/^data:image\/png;base64,/);
  }, 60_000);

  it('forges the element sheet with the skin spec of every element', async () => {
    const { call } = harness();
    const s = await call<ForgeSheet>('forge.sheet', { direction: 'candy', accent: '#9b5cff' });
    const items = s.groups.flatMap((g) => g.items);
    expect(items.length).toBeGreaterThan(30);
    expect(items.filter((i) => i.error)).toEqual([]);
    expect(items.map((i) => i.spec)).toContain('candy:button:primary#9b5cff');
    expect(items.map((i) => i.spec)).toContain('candy:title:PET SHOP#9b5cff');
    for (const i of items) expect(pngSize(i.png!)).toEqual([i.w, i.h]);
  }, 60_000);

  it('makes a mockup in the project, and a version of it in another look', async () => {
    const { call, root, changed } = harness();
    const made = await call<ForgeMade>('forge.make', { template: 'shop', direction: 'ember', accent: '#3fa9ff' });
    expect(made.version).toBe('A');
    expect(made.title).toBe('Shop (Ember)');
    expect(changed).toEqual([made.name]);
    const more = await call<ForgeMade>('forge.make', { template: 'shop', direction: 'candy', into: made.name });
    expect(more).toMatchObject({ name: made.name, version: 'B' });
    const m = new MockupStore(root).get(made.name)!;
    expect(m.versions.map((v) => v.label)).toEqual(['Ember #3fa9ff', 'Candy']);
    expect(JSON.stringify(m.versions[0]!.screens)).toContain('ember:');
    const sample = await call<ForgeMade>('forge.make', { template: 'sample', direction: 'neon' });
    expect(sample.title).toBe('HANGAR sample (Neon)');
    // Any mockup version drawn with its skins worn, for the Mockups view.
    const pic = await call<ForgePreview>('forge.mockup', { name: made.name, version: 'A', device: 'phone', width: 240 });
    expect(pic.errors).toEqual([]);
    expect(pngSize(pic.png)).toEqual([pic.w, pic.h]);
    await expect(call('forge.mockup', { name: made.name, version: 'Q' })).rejects.toThrow(/has no version Q/);
  }, 60_000);

  it('gives the Mockups view a version worn, its art sent once, a pressed state wearing its own art', async () => {
    const { call, root } = harness();
    // A scale-sized panel (its art 9-slices) holding a button at its own size (its art is exact) whose press wears the pressed art.
    const r = new MockupStore(root).create({
      title: 'Press',
      versions: [
        {
          note: 'a pressed button',
          screens: [
            {
              name: 'Hud',
              kids: [
                {
                  cls: 'Frame',
                  name: 'Panel',
                  pos: [0.5, 0, 0.5, 0],
                  anchor: [0.5, 0.5],
                  size: [0.4, 0, 0.4, 0],
                  skin: 'candy:window',
                  kids: [{ cls: 'TextButton', name: 'Play', pos: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], size: [0, 220, 0, 64], text: 'PLAY', textSize: 28, skin: 'candy:button:primary', states: { press: { skin: 'candy:button:pressed', scale: 0.96 } } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(r.errors).toEqual([]);
    const w = await call<ForgeWorn>('forge.worn', { name: r.mockup!.name, devices: ['desktop', 'nope'] });
    expect(w.skinned).toBe(true);
    expect(Object.keys(w.screens)).toEqual(['desktop']);
    const panel = w.screens.desktop![0]!.kids![0]!;
    const play = panel.kids!.find((k) => k.name === 'Play')!;
    expect(panel.skin).toBeUndefined();
    // The panel's art 9-slices (a narrow centre that only stretches), inside its picture, at 1/scale.
    const art = panel.kids![0]!;
    expect(art).toMatchObject({ name: 'Skin', cls: 'ImageLabel', scaleType: 'Slice' });
    // At the game's 2 px per point, or less where Roblox would otherwise shrink it past 1024 px.
    expect(art.sliceScale).toBeGreaterThanOrEqual(0.5);
    expect(art.sliceScale).toBeLessThanOrEqual(1);
    expect(art.image).toMatch(/^skin:candy:window@.*~9$/);
    const pic = w.images[art.image!]!;
    expect(pngSize(pic.url)).toEqual([pic.w, pic.h]);
    expect(art.slice![2]).toBeLessThanOrEqual(pic.w);
    expect(art.slice![2] - art.slice![0]).toBeLessThanOrEqual(10);
    // The button's art is forged at its size and stretched; its text is in a Label over it.
    expect(play.kids!.map((k) => k.name)).toEqual(['Skin', 'Label']);
    expect(play.kids![0]).toMatchObject({ scaleType: 'Stretch', image: 'skin:candy:button:primary@220x64' });
    expect(play.states!.press!.skinArt!.image).toBe('skin:candy:button:pressed@220x64');
    for (const ref of [art.image!, play.kids![0]!.image!, play.states!.press!.skinArt!.image]) expect(w.images[ref], ref).toBeTruthy();
    // Sent once.
    const again = await call<ForgeWorn>('forge.worn', { name: r.mockup!.name, devices: ['desktop'], have: Object.keys(w.images) });
    expect(again.images).toEqual({});
    expect(again.screens).toEqual(w.screens);
    const plain = await call<ForgeMade>('forge.make', { template: 'shop', direction: 'neon' });
    expect((await call<ForgeWorn>('forge.worn', { name: plain.name, devices: [] })).skinned).toBe(true);
  }, 60_000);

  it("dresses the game's UI in a look: a preview, a mockup, a version more in the same look", async () => {
    const { call, root, changed } = harness();
    expect(await call<ForgeGame | null>('forge.game')).toBeNull();
    await expect(call('forge.dress', { direction: 'candy' })).rejects.toThrow(/hasn't been read yet/);
    new UiStore(root).save(gameCapture as unknown as UiCapture);
    const g = (await call<ForgeGame>('forge.game'))!;
    expect(g.screens).toEqual(['ShopGui', 'Hud']);
    expect(g.source).toBe('StarterGui');
    const pic = await call<ForgePreview>('forge.preview', { what: 'game', direction: 'candy', device: 'desktop', width: 240, roblox: false });
    expect(pic.errors).toEqual([]);
    expect(pngSize(pic.png)).toEqual([pic.w, pic.h]);
    const made = await call<ForgeMade>('forge.dress', { direction: 'candy', accent: '#9b5cff' });
    expect(made.title).toBe('Game UI in Candy');
    expect(made.version).toBe('A');
    expect(changed).toContain(made.name);
    const m = new MockupStore(root).get(made.name)!;
    expect(m.versions[0]).toMatchObject({ from: 'game', label: 'Candy #9b5cff' });
    const json = JSON.stringify(m.versions[0]!.screens);
    // Its windows, buttons, tabs and close wear the look's skins, tinted.
    expect(json).toMatch(/"skin":"candy:window[^"]*#9b5cff"/);
    expect(json).toMatch(/"skin":"candy:button[^"]*#9b5cff"/);
    expect(json).toMatch(/"skin":"candy:close/);
    // The same look again: a version of the same mockup. Through forge.make too.
    const again = await call<ForgeMade>('forge.make', { template: 'game', direction: 'candy' });
    expect(again).toMatchObject({ name: made.name, version: 'B' });
    const other = await call<ForgeMade>('forge.dress', { direction: 'ember', screen: 'Hud' });
    expect(other.title).toBe('Game UI in Ember');
    expect(new MockupStore(root).get(other.name)!.versions[0]!.from).toBe('game:Hud');
  }, 60_000);

  it('draws previews sharper than they are shown, never bigger than the game does', () => {
    expect(previewScales(574, 1366)).toEqual({ scale: 0.42, forgeScale: 0.5 });
    expect(previewScales(1100, 844)).toEqual({ scale: 1.3, forgeScale: 1.5 });
    expect(previewScales(5000, 390).forgeScale).toBe(2);
    expect(previewScales(0, 1920).scale).toBeGreaterThan(0);
  });
});
