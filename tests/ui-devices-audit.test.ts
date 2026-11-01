import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditDevices, auditUi, layoutScreen, UI_DEVICES, type UiNode } from '../src/shared/ui-layout';
import { uiCaptureLuau, uiCapturePageLuau } from '../src/core/roblox/ui-capture';
import { UiStore } from '../src/core/ui/ui-workshop';
import { LuauToolchain } from '../src/core/roblox/luau-toolchain';

// The device matrix ui_audit checks (a portrait phone when the game allows it, a TV with the 10-foot fit and
// its cropped edges) and the Motion check: looping animations still running in UI nobody can see.
let nextId = 1;
const node = (cls: string, name: string, props: Partial<UiNode> = {}, kids: UiNode[] = []): UiNode => ({ id: nextId++, cls, name, kids, ...props });
const box = (screen: UiNode, device: keyof typeof UI_DEVICES, name: string) => layoutScreen(screen, UI_DEVICES[device]).find((b) => b.node.name === name)!;
// What Ui.screen declares on its UIScale.
const uiFit = { ref: [1920, 1080] as [number, number], min: 0.8, max: 1.5, tenFoot: 1.25 };

describe('the device matrix', () => {
  it('audits a landscape phone, a tablet, a desktop and a TV; a portrait phone only when the game allows portrait', () => {
    expect(auditDevices('LandscapeSensor')).toEqual(['phone', 'tablet', 'desktop', 'tv']);
    expect(auditDevices(null)).toEqual(['phone', 'tablet', 'desktop', 'tv']);
    expect(auditDevices('Portrait')).toContain('phonePortrait');
    expect(auditDevices('Sensor')).toContain('phonePortrait');
  });

  it('fits a screen that declares FitTenFoot bigger on a TV than on a desktop of the same size', () => {
    const screen = node('ScreenGui', 'Menu', { fit: uiFit }, [node('Frame', 'Panel', { size: [0, 400, 0, 200] })]);
    const desk = box(screen, 'desktop', 'Panel');
    const tv = box(screen, 'tv', 'Panel');
    expect(desk.w).toBeCloseTo(400 * (1022 / 1080), 1); // 0.946: the area under the top bar
    expect(tv.w).toBeCloseTo(desk.w * 1.25, 1);
    // Without FitTenFoot a TV lays out like a desktop.
    const plain = node('ScreenGui', 'Plain', { fit: { ref: [1920, 1080], min: 0.8, max: 1.5 } }, [node('Frame', 'Panel', { size: [0, 400, 0, 200] })]);
    expect(box(plain, 'tv', 'Panel').w).toBeCloseTo(box(plain, 'desktop', 'Panel').w, 3);
  });

  it('keeps a portrait phone clear of its status bar, the top bar under it and the home bar', () => {
    const full = (insets: UiNode['insets']) => node('ScreenGui', 'S', { insets }, [node('Frame', 'Fill', { size: [1, 0, 1, 0] })]);
    const core = box(full('CoreUISafeInsets'), 'phonePortrait', 'Fill');
    expect([core.y, core.h]).toEqual([47 + 58, 844 - 47 - 58 - 34]);
    const device = box(full('DeviceSafeInsets'), 'phonePortrait', 'Fill');
    expect([device.y, device.h]).toEqual([47, 844 - 47 - 34]);
    const none = box(full('None'), 'phonePortrait', 'Fill');
    expect([none.y, none.h]).toEqual([0, 844]);
    // The landscape phone is unchanged: notch sides, top bar, no home bar.
    const landscape = box(full('CoreUISafeInsets'), 'phone', 'Fill');
    expect([landscape.x, landscape.y, landscape.w, landscape.h]).toEqual([44, 58, 844 - 88, 390 - 58]);
  });

  it("warns about text and buttons within 5% of a TV's edge, only on the TV and only on screens made for one", () => {
    const pieces = () => [
      node('TextButton', 'Corner', { pos: [0, 16, 0, 16], size: [0, 120, 0, 56], text: 'Shop', textSize: 20 }),
      node('TextButton', 'Inside', { pos: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], size: [0, 120, 0, 56], text: 'Play', textSize: 20 }),
    ];
    // What Hud.screen declares: FitTenFoot says the screen is meant for a TV too.
    const hud = node('ScreenGui', 'Hud', { insets: 'DeviceSafeInsets', fit: { ref: [900, 900], min: 0.6, max: 1.4, tenFoot: 1.2 } }, pieces());
    const edge = auditUi([hud], ['desktop', 'tv']).filter((f) => /TV’s edge/.test(f.message));
    expect(edge.map((f) => f.path)).toEqual(['Hud.Corner']);
    expect(edge[0]!.devices).toEqual(['tv']);
    // A screen that never declared a 10-foot fit (a desktop-only HUD) isn't held to TV rules.
    const plain = node('ScreenGui', 'Plain', { insets: 'DeviceSafeInsets' }, pieces());
    expect(auditUi([plain], ['desktop', 'tv']).filter((f) => /TV’s edge/.test(f.message))).toEqual([]);
  });
});

describe('motion that outlives its screen', () => {
  it('warns once per element where loops run in a disabled screen or under a hidden frame; not where they show', () => {
    const closed = node('ScreenGui', 'Shop', { enabled: false }, [node('Frame', 'Window', {}, [node('TextButton', 'Claim', { size: [0, 200, 0, 56], text: 'Claim', textSize: 20, loops: 1 })])]);
    const open = node('ScreenGui', 'Hud', {}, [
      node('Frame', 'Coins', { size: [0, 200, 0, 56], loops: 2 }),
      node('Frame', 'Menu', { visible: false }, [node('ImageLabel', 'Rays', { size: [0, 300, 0, 300], loops: 1 })]),
    ]);
    const findings = auditUi([closed, open]).filter((f) => /looping animation/.test(f.message));
    expect(findings.map((f) => f.path).sort()).toEqual(['Hud.Menu.Rays', 'Shop.Window.Claim']);
    expect(findings.every((f) => f.severity === 'warning' && f.devices.length === 0)).toBe(true);
  });
});

describe('the capture reads what the checks need', () => {
  it('reads MotionLoops, FitTenFoot and the ScreenOrientation in both the whole and the paged capture', () => {
    for (const code of [uiCaptureLuau({ playerGui: true }), uiCapturePageLuau({ playerGui: true, from: 0, budget: 80_000 })]) {
      expect(code).toContain('GetAttribute("MotionLoops")');
      expect(code).toContain('GetAttribute("FitTenFoot")');
      expect(code).toContain('orientation = orientationOf(root)');
      expect(code).toContain('ScreenOrientation.Name');
    }
  });

  it('a saved snapshot lists the devices it was audited on, with the portrait phone when the game allows it', () => {
    const store = new UiStore(mkdtempSync(join(tmpdir(), 'shuriken-ui-devices-')));
    const screen = node('ScreenGui', 'Menu', {}, [node('TextButton', 'Play', { pos: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], size: [0, 200, 0, 56], text: 'Play', textSize: 20 })]);
    expect(store.save({ source: 'PlayerGui', screens: [screen], count: 2, truncated: false, orientation: 'LandscapeSensor' }).audited).toEqual(['phone', 'tablet', 'desktop', 'tv']);
    const upright = store.save({ source: 'PlayerGui', screens: [screen], count: 2, truncated: false, orientation: 'Sensor' });
    expect(upright.audited).toContain('phonePortrait');
    expect(store.get()?.orientation).toBe('Sensor');
  });

  const selene = join(homedir(), '.local', 'bin', `selene${process.platform === 'win32' ? '.exe' : ''}`);
  it.skipIf(!existsSync(selene))('the capture programs still parse', async () => {
    const lt = new LuauToolchain(mkdtempSync(join(tmpdir(), 'shuriken-types-')));
    expect(await lt.parseErrors(uiCaptureLuau({ playerGui: true }))).toEqual([]);
    expect(await lt.parseErrors(uiCapturePageLuau({ playerGui: false, from: 0, budget: 80_000 }))).toEqual([]);
  });
});
