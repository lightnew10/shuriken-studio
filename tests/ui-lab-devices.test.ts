import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutScreen, UI_DEVICES, type UiNode } from '../src/shared/ui-layout';
import { findRobloxScripts, LAB_DEVICES, labDevice, labDevicesFor, LEGACY_DEVICE_IDS, normalizeInsets, pointsToMm, readRobloxFlags, userFlag, type LabDevice } from '../src/core/ui/lab/devices';
import { checkCoreScripts, coreGuiFromSource, coreOverlays, drawCoreOverlays, mergeFindings, overlayFindings, renderLab, type CoreRegion } from '../src/core/ui/lab/core-overlays';
import { newRaster } from '../src/core/ui/ui-raster';

// Roblox's own UI on the lab's devices: formulas from the PlayerModule and CoreScripts in the Studio install (file:line
// on every region), checked here at known screen sizes, and the findings they give on small synthetic HUDs.

const dev = (id: string): LabDevice => labDevice(id)!;
const region = (d: LabDevice, id: string, opts = {}): CoreRegion => coreOverlays(d, opts).find((r) => r.id === id)!;
const rect = (r: CoreRegion) => [r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100) / 100);
/** A device in points with nothing but a size (no safe area). */
const plain = (w: number, h: number): LabDevice => ({ id: `t${w}x${h}`, label: 'test', w, h, ppi: 160, input: 'touch', orientation: w >= h ? 'landscape' : 'portrait', form: 'phone', note: '' });

let nid = 1;
const node = (name: string, cls: string, p: Partial<UiNode> = {}, kids: UiNode[] = []): UiNode => ({ id: nid++, name, cls, ...p, ...(kids.length ? { kids } : {}) });
const screen = (name: string, kids: UiNode[], p: Partial<UiNode> = {}): UiNode => node(name, 'ScreenGui', p, kids);
const findingsOn = (d: LabDevice, screens: UiNode[], opts = {}) => {
  const regions = coreOverlays(d, opts);
  return screens.flatMap((s) => overlayFindings(layoutScreen(normalizeInsets(s), d), regions, d, { screens }));
};

describe('lab devices', () => {
  it('cover phones, tablets, computers and a TV with unique ids, and resolve ui_audit’s names', () => {
    const ids = LAB_DEVICES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sizes = LAB_DEVICES.map((d) => `${d.w}x${d.h}`);
    for (const s of ['667x375', '844x390', '932x430', '800x360', '915x412', '390x844', '1180x820', '1133x744', '1280x800', '1366x768', '1920x1080', '2560x1440']) expect(sizes).toContain(s);
    expect(LAB_DEVICES.filter((d) => d.orientation === 'portrait').length).toBeGreaterThanOrEqual(2);
    expect(LAB_DEVICES.find((d) => d.tenFoot)?.input).toBe('gamepad');
    for (const legacy of Object.keys(UI_DEVICES)) expect(labDevice(legacy), legacy).not.toBeNull();
    expect(Object.keys(LEGACY_DEVICE_IDS).sort()).toEqual(Object.keys(UI_DEVICES).sort());
    expect(labDevice('phone')!.w).toBe(844);
    expect(labDevice('nope')).toBeNull();
    // Portrait only for games that allow it.
    expect(labDevicesFor('LandscapeSensor').some((d) => d.orientation === 'portrait')).toBe(false);
    expect(labDevicesFor('Sensor').some((d) => d.orientation === 'portrait')).toBe(true);
    // 44 points on an iPhone 14 (153 pt/in) is 7.3 mm under a thumb.
    expect(pointsToMm(dev('phone-notch'), 44)).toBeCloseTo(7.3, 1);
  });

  it('lay a DeviceSafeInsets screen out of the notch though its IgnoreGuiInset reads true', () => {
    const hud = screen('Hud', [node('Corner', 'Frame', { pos: [0, 0, 0, 0], size: [0, 50, 0, 50] })], { ignoreInset: true, insets: 'DeviceSafeInsets' });
    const d = dev('phone-notch');
    const laid = layoutScreen(hud, d)[0]!;
    expect([laid.x, laid.y]).toEqual([47, 0]); // in the safe area, the top bar not left out
    expect(layoutScreen(normalizeInsets(hud), d)[0]!.x).toBe(47);
    expect(normalizeInsets({ ...hud, insets: 'None' })).toEqual({ ...hud, insets: 'None' });
  });
});

describe('Roblox’s touch controls (PlayerModule)', () => {
  it('put the jump button where TouchJump.lua does: 70 points at (1, −95, 1, −90) of the touch frame, 120 at (1, −170, 1, −210) on a big screen', () => {
    // Small screens: the touch frame (below the 58-point top bar, inside the safe area) is ≤ 500 on its short side.
    expect(rect(region(dev('phone-small'), 'jump'))).toEqual([667 - 95, 375 - 90, 70, 70]);
    expect(rect(region(dev('phone-notch'), 'jump'))).toEqual([844 - 47 - 95, 390 - 21 - 90, 70, 70]);
    expect(rect(region(dev('phone-notch-portrait'), 'jump'))).toEqual([390 - 95, 844 - 34 - 90, 70, 70]);
    // Big screens: 120 points, higher up.
    expect(rect(region(dev('ipad'), 'jump'))).toEqual([1180 - 170, 820 - 20 - 210, 120, 120]);
    // The switch is the frame's shorter side: 558 − 58 = 500 is still small, 560 − 58 = 502 is big.
    expect(region(plain(1000, 558), 'jump').w).toBe(70);
    expect(rect(region(plain(1000, 560), 'jump'))).toEqual([1000 - 170, 58 + 502 - 210, 120, 120]);
    // The Avatar Abilities layout (not the default): 72 points inset 64.
    expect(rect(region(dev('phone-small'), 'jump', { abilities: true }))).toEqual([667 - 72 - 64, 375 - 72 - 64, 72, 72]);
    // No jump without touch, with jumping off, or with Scriptable movement.
    expect(region(dev('laptop'), 'jump')).toBeUndefined();
    expect(region(dev('phone-small'), 'jump', { jump: false })).toBeUndefined();
    expect(coreOverlays(dev('phone-small'), { movement: 'Scriptable' }).filter((r) => r.id === 'jump' || r.id.startsWith('thumbstick'))).toEqual([]);
    expect(region(dev('phone-small'), 'jump').source).toMatch(/TouchJump\.lua:/);
  });

  it('give the dynamic thumbstick its touch area and resting ring as DynamicThumbstick.lua does', () => {
    const d = dev('phone-notch'); // touch frame 47..797 × 58..369
    const zone = region(d, 'thumbstick-zone');
    // (0.4, 100, 2/3, 100) at (0, −100, 1/3, 0), clipped to the screen.
    expect(rect(zone)).toEqual([0, 58 + 311 / 3, 47 + 0.4 * 750, 390 - (58 + 311 / 3)].map((v) => Math.round(v * 100) / 100));
    // Ring 74 centred ring×3.3 = 66 in from the frame and ring×2.8 = 56 up from its bottom.
    const ring = region(d, 'thumbstick-ring');
    expect([ring.x + ring.w / 2, ring.y + ring.h / 2, ring.w]).toEqual([47 + 66, 390 - 21 - 56, 74]);
    // Big screens double it.
    const big = region(dev('ipad'), 'thumbstick-ring');
    expect([big.x + big.w / 2, big.y + big.h / 2, big.w]).toEqual([132, 820 - 20 - 112, 148]);
    // Portrait: the bottom 40% of the frame, the whole width.
    const p = region(dev('phone-notch-portrait'), 'thumbstick-zone');
    expect(rect(p)).toEqual([0, 105 + 0.6 * 705, 390, 844 - (105 + 0.6 * 705)].map((v) => Math.round(v * 100) / 100));
    // The classic stick instead when the game asks for it.
    expect(rect(region(dev('phone-small'), 'thumbstick', { movement: 'Thumbstick' }))).toEqual([25, 375 - 90, 70, 70]);
  });
});

describe('Roblox’s top bar, player list, chat and hotbar (CoreScripts)', () => {
  it('place the menu button and the unibar as the Chrome top bar does', () => {
    expect(rect(region(dev('desktop'), 'topbar-menu'))).toEqual([16, 12, 44, 44]);
    expect(rect(region(dev('desktop'), 'topbar-unibar'))).toEqual([68, 12, 8 + 2 * 44, 44]);
    // Inside the device safe area (TopBarApp's ScreenGui has IgnoreGuiInset).
    expect(rect(region(dev('phone-notch'), 'topbar-menu'))).toEqual([63, 12, 44, 44]);
    expect(region(dev('phone-notch-portrait'), 'topbar-menu').y).toBe(47 + 12);
    // Voice adds the mic, no chat removes its icon; the side-sheet layout drops the menu button.
    expect(region(dev('desktop'), 'topbar-unibar', { voice: true }).w).toBe(8 + 3 * 44);
    expect(region(dev('desktop'), 'topbar-unibar', { chat: false }).w).toBe(8 + 44);
    expect(region(dev('desktop'), 'topbar-menu', { sideSheet: true })).toBeUndefined();
    // A 10-foot interface scales the top bar 1.5×: an 87-point bar, 66-point buttons.
    expect(rect(region(dev('console-tv'), 'topbar-menu'))).toEqual([24, 18, 66, 66]);
    expect(region(dev('console-tv'), 'topbar-unibar').x).toBe(102);
    expect(dev('console-tv').topbar).toBe(87);
  });

  it('show the player list and chat at start only off small touch screens, and the hotbar only with tools', () => {
    expect(region(dev('phone-notch'), 'player-list')).toBeUndefined();
    expect(region(dev('phone-notch'), 'chat')).toBeUndefined();
    expect(region(dev('phone-notch'), 'chat', { opened: true })).toBeDefined();
    expect(region(dev('ipad'), 'player-list').estimated).toBe(true);
    expect(region(dev('desktop'), 'player-list', { playerList: false })).toBeUndefined();
    expect(region(dev('desktop'), 'hotbar')).toBeUndefined();
    // 3 slots below 1024 on touch (60 + 5 buffers), 10 elsewhere; slots shown per tool, centred at the bottom.
    const hot = region(dev('phone-notch'), 'hotbar', { tools: 2 });
    expect(rect(hot)).toEqual([844 / 2 - 62.5, 390 - 21 - 70 + 5, 125, 60]);
    expect(region(dev('desktop'), 'hotbar', { tools: 12 }).detail?.slots).toBe(10);
    expect(region(dev('desktop'), 'hotbar', { tools: 2, backpack: false })).toBeUndefined();
  });
});

describe('findings: game UI under Roblox’s UI', () => {
  const d = dev('phone-notch');

  it('reports a button over the jump button, and not a decorative full-screen frame', () => {
    const hud = screen('Hud', [
      node('Vignette', 'ImageLabel', { size: [1, 0, 1, 0], image: 'rbxassetid://1' }),
      node('Holder', 'Frame', { size: [1, 0, 1, 0] }, [node('Shop', 'TextButton', { anchor: [1, 1], pos: [1, -20, 1, -25], size: [0, 70, 0, 70], text: 'Shop', bg: [255, 200, 0] })]),
    ]);
    const fs = findingsOn(d, [hud]);
    expect(fs.map((f) => [f.severity, f.region, f.path])).toEqual([['problem', 'jump', 'Hud.Holder.Shop']]);
    expect(fs[0]!.message).toMatch(/jump button.*both have DisplayOrder 0/);
  });

  it('warns about a button in the thumbstick area, and reports one at its resting ring', () => {
    const mid = screen('Hud', [node('Emote', 'ImageButton', { pos: [0, 200, 0, 200], size: [0, 60, 0, 60], image: 'rbxassetid://1' })], { displayOrder: 2 });
    const fs = findingsOn(d, [mid]);
    expect(fs.map((f) => [f.severity, f.region])).toEqual([['warning', 'thumbstick-zone']]);
    expect(fs[0]!.message).toMatch(/draws above the touch controls/);
    const atRing = screen('Hud', [node('Map', 'ImageButton', { pos: [0, 43, 0, 222], size: [0, 70, 0, 70], image: 'rbxassetid://1' })]);
    expect(findingsOn(d, [atRing]).map((f) => [f.severity, f.region])).toEqual([['problem', 'thumbstick-ring']]);
  });

  it('leaves a game’s own jump button, and a menu drawn above the controls, alone', () => {
    const own = screen('Controls', [node('JumpButton', 'ImageButton', { anchor: [1, 1], pos: [1, -20, 1, -25], size: [0, 70, 0, 70], image: 'rbxassetid://1' })]);
    expect(findingsOn(d, [own])).toEqual([]);
    const shop = screen('Shop', [node('Window', 'Frame', { anchor: [0.5, 0.5], pos: [0.5, 0, 0.5, 0], size: [0.9, 0, 0.9, 0], bg: [20, 20, 30] }, [node('Buy', 'TextButton', { anchor: [1, 1], pos: [1, 0, 1, 0], size: [0, 120, 0, 60], text: 'Buy' })])], { displayOrder: 10 });
    expect(findingsOn(d, [shop]).filter((f) => f.region === 'jump')).toEqual([]);
    // The same window below the touch controls can't be pressed there.
    const low = findingsOn(d, [{ ...shop, displayOrder: -1 }]).filter((f) => f.region === 'jump');
    expect(low.map((f) => f.severity)).toEqual(['problem']);
    expect(low[0]!.message).toMatch(/can’t be pressed/);
  });

  it('reports a button under the top bar only when its screen covers the top bar', () => {
    const btn = (p: Partial<UiNode>) => screen('Top', [node('Settings', 'TextButton', { pos: [0, 4, 0, 6], size: [0, 50, 0, 44], text: 'Settings' })], p);
    const under = findingsOn(dev('desktop'), [btn({ ignoreInset: true, insets: 'None' })]);
    expect(under.map((f) => [f.severity, f.region])).toEqual([['problem', 'topbar-menu']]);
    expect(findingsOn(dev('desktop'), [btn({})]).filter((f) => f.region.startsWith('topbar'))).toEqual([]);
    // The free part of the bar (right of the unibar) is the place for it.
    const free = screen('Top', [node('Gear', 'TextButton', { anchor: [1, 0], pos: [1, -16, 0, 12], size: [0, 44, 0, 44], text: 'G' })], { ignoreInset: true, insets: 'None' });
    expect(findingsOn(dev('desktop'), [free])).toEqual([]);
  });

  it('reports a HUD under the hotbar when the player holds tools, and groups the player list’s by element', () => {
    const bar = screen('Hud', [node('Slots', 'Frame', { anchor: [0.5, 1], pos: [0.5, 0, 1, -8], size: [0, 300, 0, 60], bg: [0, 0, 0] }, [node('Slot1', 'TextButton', { pos: [0, 120, 0, 0], size: [0, 60, 0, 60], text: '1' })])]);
    expect(findingsOn(dev('desktop'), [bar], { tools: 3 }).map((f) => [f.severity, f.region, f.path])).toEqual([['problem', 'hotbar', 'Hud.Slots.Slot1']]);
    expect(findingsOn(dev('desktop'), [bar])).toEqual([]);
    const corner = screen('Hud', [node('Stats', 'Frame', { anchor: [1, 0], pos: [1, -10, 0, 10], size: [0, 150, 0, 80] }, [node('Coins', 'TextLabel', { size: [1, 0, 0.5, 0], text: '100 coins' }), node('Gems', 'TextLabel', { pos: [0, 0, 0.5, 0], size: [1, 0, 0.5, 0], text: '5 gems' })])]);
    const pl = findingsOn(dev('desktop'), [corner]).filter((f) => f.region === 'player-list');
    expect(pl.map((f) => [f.severity, f.path])).toEqual([['warning', 'Hud.Stats']]);
    expect(pl[0]!.message).toMatch(/^2 of its buttons and texts/);
  });

  it('merges one finding over several devices', () => {
    const hud = screen('Hud', [node('Shop', 'TextButton', { anchor: [1, 1], pos: [1, -20, 1, -25], size: [0, 70, 0, 70], text: 'Shop' })]);
    const merged = mergeFindings(['phone-small', 'android-small'].map((id) => findingsOn(dev(id), [hud])));
    expect(merged.length).toBe(1);
    expect(merged[0]!.devices).toEqual(['phone-small', 'android-small']);
  });
});

describe('reading a game’s code', () => {
  it('turns off what SetCoreGuiEnabled turns off for good, not what a cutscene hides for a while', () => {
    expect(coreGuiFromSource('StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.PlayerList, false)').options).toEqual({ playerList: false });
    expect(coreGuiFromSource('pcall(StarterGui.SetCoreGuiEnabled, StarterGui, Enum.CoreGuiType.Backpack, false)').options).toEqual({ backpack: false });
    const loop = 'local OFF = { Enum.CoreGuiType.Backpack, Enum.CoreGuiType.Chat }\nfor _, kind in OFF do StarterGui:SetCoreGuiEnabled(kind, false) end';
    expect(coreGuiFromSource(loop).options).toEqual({ backpack: false, chat: false });
    const cutscene = 'local T = { Enum.CoreGuiType.PlayerList }\nfor _, t in T do StarterGui:SetCoreGuiEnabled(t, false) end\nfor _, t in T do StarterGui:SetCoreGuiEnabled(t, true) end';
    expect(coreGuiFromSource([cutscene, loop]).options).toEqual({ backpack: false, chat: false });
    expect(coreGuiFromSource('StarterPlayer.DevTouchMovementMode = Enum.DevTouchMovementMode.Thumbstick').options.movement).toBe('Thumbstick');
  });

  it('reads Studio’s fast flags as the PlayerModule’s FlagUtil does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flags-'));
    const file = join(dir, 'StudioAppSettings.json');
    writeFileSync(file, JSON.stringify({ FFlagUserA: 'True', SFFlagUserB: 'False', FFlagUserC_PlaceFilter: 'True;123' }));
    const flags = readRobloxFlags({ SHURIKEN_ROBLOX_FLAGS: file });
    expect([userFlag(flags, 'UserA'), userFlag(flags, 'UserB'), userFlag(flags, 'UserC'), userFlag(flags, 'UserD')]).toEqual([true, false, false, null]);
    expect(readRobloxFlags({ SHURIKEN_ROBLOX_FLAGS: join(dir, 'missing.json') })).toEqual({});
  });
});

describe('drawing Roblox’s UI', () => {
  it('draws the controls as in play and tints them as zones', () => {
    const d = dev('phone-small');
    const regions = coreOverlays(d);
    const jump = regions.find((r) => r.id === 'jump')!;
    const px = (c: ReturnType<typeof newRaster>, x: number, y: number) => [0, 1, 2].map((k) => c.rgb[(Math.round(y) * c.w + Math.round(x)) * 3 + k]!);
    const c = newRaster(d.w, d.h, [0.5, 0.5, 0.5]);
    drawCoreOverlays(c, regions, [1, 0, 0, 1, 0, 0], 1, 'controls');
    // The jump button's white ring brightens its edge; its middle is darkened.
    const edge = px(c, jump.x + jump.w / 2, jump.y + 1);
    expect(edge[0]!).toBeGreaterThan(0.75);
    expect(px(c, jump.x + 10, jump.y + jump.h / 2 + 12)[0]!).toBeLessThan(0.5);
    const z = newRaster(d.w, d.h, [0.5, 0.5, 0.5]);
    drawCoreOverlays(z, regions, [1, 0, 0, 1, 0, 0], 1, 'zones');
    const zone = regions.find((r) => r.id === 'thumbstick-zone')!;
    const tint = px(z, zone.x + zone.w - 20, zone.y + 30);
    expect(tint[2]!).toBeGreaterThan(tint[0]!); // blue
  });

  it('renders a game on a lab device at its own size with Roblox’s UI over it', () => {
    const d = dev('phone-notch');
    const hud = screen('Hud', [node('Panel', 'Frame', { pos: [0, 0, 0, 0], size: [0, 100, 0, 40], bg: [255, 0, 0] })], { ignoreInset: true, insets: 'DeviceSafeInsets' });
    const pic = renderLab([hud], d, { scale: 1, rulers: false });
    expect([pic.image.width, pic.image.height]).toEqual([844, 390]);
    const at = (x: number, y: number) => [0, 1, 2].map((k) => pic.image.data[(y * pic.image.width + x) * 4 + k]!);
    // The panel starts after the notch (DeviceSafeInsets), under the top bar's menu button area.
    expect(at(100, 5)).toEqual([255, 0, 0]);
    expect(at(30, 5)).not.toEqual([255, 0, 0]);
    expect(pic.regions.some((r) => r.id === 'jump')).toBe(true);
  });
});

// The formulas against the scripts in the Studio install (skipped where Studio isn't installed).
const scripts = findRobloxScripts();
describe.skipIf(!scripts)('Roblox’s scripts in the Studio install', () => {
  it('still say what the overlays were built from', () => {
    const checks = checkCoreScripts(scripts!.dir);
    expect(checks.filter((c) => c.status === 'changed' || c.status === 'missing')).toEqual([]);
  });
});
