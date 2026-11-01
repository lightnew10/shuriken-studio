import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TOPBAR, type UiNode, type UiScreen } from '@shared/ui-layout';

/**
 * The UI lab's devices: phones, tablets, computers and a console on a TV, each the way Roblox lays a ScreenGui out on
 * it, in Roblox UI points (iOS points, Android dp), with its safe area, its input and its pixel density (points per
 * inch, so sizes can be read in millimetres under a thumb).
 *
 * How Roblox reports the safe area (from the scripts in the Studio install, ExtraContent\scripts\CoreScripts):
 * - GuiService:GetGuiInset() is the top bar: TopBar/init.lua:83-99 sets it to (left, ApplyDisplayScale(TopBarHeight),
 *   right, bottom), keeping the engine's left/right/bottom. TopBarHeight is 58 with the current top bar ("Chrome"), and
 *   58 × 1.5 = 87 on a 10-foot interface (TopBar/Constants.lua:21-29: withUIScale).
 * - ScreenGui.ScreenInsets: None is the whole screen; DeviceSafeInsets keeps out of the notch, rounded corners and home
 *   bar; CoreUISafeInsets (a new ScreenGui's default) also keeps below the top bar; TopbarSafeInsets is
 *   GuiService.TopbarInset, the widest free stretch of the top bar row right of Roblox's buttons
 *   (Chrome/ChromeShared/Service/KeepOutAreasHandler.lua:79-121).
 * - IgnoreGuiInset is tied to ScreenInsets: every capture with IgnoreGuiInset = true has ScreenInsets None or
 *   DeviceSafeInsets, never CoreUISafeInsets. A DeviceSafeInsets screen still keeps out of the notch.
 * - GuiService:GetInsetArea(ScreenInsets) gives each one's rectangle (PlayerModule DynamicThumbstick.lua:700).
 * Device safe areas here are the OS's (iOS safeAreaInsets; Android cutouts are not modelled: they inset one side only).
 */

export type LabInput = 'touch' | 'mouse' | 'gamepad';

export interface LabDevice extends UiScreen {
  id: string;
  label: string;
  /** Points per inch on the real screen (for millimetres under a finger). */
  ppi: number;
  input: LabInput;
  orientation: 'landscape' | 'portrait';
  /** The kind of device Roblox's scripts tell apart (small touch screen, tablet, computer, console). */
  form: 'phone' | 'tablet' | 'computer' | 'console';
  /** Where its numbers come from. */
  note: string;
}

/** The top bar on a 10-foot interface: 58 × 1.5 (TopBar/Constants.lua:21-29, withUIScale on TenFootInterface). */
export const TOPBAR_TEN_FOOT = TOPBAR * 1.5;

export const LAB_DEVICES: readonly LabDevice[] = [
  { id: 'phone-small', label: 'Small phone (iPhone SE)', w: 667, h: 375, ppi: 163, input: 'touch', orientation: 'landscape', form: 'phone', note: 'iPhone SE 2/3: 667×375 pt, 326 ppi @2x, no notch' },
  { id: 'phone-notch', label: 'Notch phone (iPhone 14)', w: 844, h: 390, side: 47, bottom: 21, ppi: 153, input: 'touch', orientation: 'landscape', form: 'phone', note: 'iPhone 12–14: 844×390 pt, 460 ppi @3x; landscape safe area 47 left/right, 21 bottom (ui_audit’s phone used 44, the iPhone X–11 Pro value, and no bottom)' },
  { id: 'phone-island', label: 'Big phone (iPhone 15 Pro Max)', w: 932, h: 430, side: 59, bottom: 21, ppi: 153, input: 'touch', orientation: 'landscape', form: 'phone', note: 'iPhone 14/15 Pro Max: 932×430 pt, 460 ppi @3x; Dynamic Island safe area 59 left/right, 21 bottom' },
  { id: 'android-small', label: 'Small Android', w: 800, h: 360, ppi: 160, input: 'touch', orientation: 'landscape', form: 'phone', note: 'Budget Android (Galaxy A class): 800×360 dp; cutout not modelled' },
  { id: 'android-tall', label: 'Tall Android', w: 915, h: 412, ppi: 160, input: 'touch', orientation: 'landscape', form: 'phone', note: 'Galaxy S Ultra / Pixel Pro class: 915×412 dp; cutout not modelled' },
  { id: 'phone-notch-portrait', label: 'Notch phone portrait (iPhone 14)', w: 390, h: 844, top: 47, bottom: 34, ppi: 153, input: 'touch', orientation: 'portrait', form: 'phone', note: 'iPhone 12–14 portrait: 47 status bar/notch, 34 home bar' },
  { id: 'android-tall-portrait', label: 'Tall Android portrait', w: 412, h: 915, ppi: 160, input: 'touch', orientation: 'portrait', form: 'phone', note: '412×915 dp portrait; cutout not modelled' },
  { id: 'ipad', label: 'iPad (Air 11")', w: 1180, h: 820, bottom: 20, ppi: 132, input: 'touch', orientation: 'landscape', form: 'tablet', note: 'iPad Air / iPad 10th: 1180×820 pt, 264 ppi @2x; home bar 20' },
  { id: 'ipad-mini', label: 'iPad mini', w: 1133, h: 744, bottom: 20, ppi: 163, input: 'touch', orientation: 'landscape', form: 'tablet', note: 'iPad mini 6: 1133×744 pt, 326 ppi @2x; home bar 20' },
  { id: 'android-tablet', label: 'Android tablet', w: 1280, h: 800, ppi: 137, input: 'touch', orientation: 'landscape', form: 'tablet', note: 'Galaxy Tab S 11": 1280×800 dp, 274 ppi @2x' },
  { id: 'laptop', label: 'Laptop 1366×768', w: 1366, h: 768, ppi: 100, input: 'mouse', orientation: 'landscape', form: 'computer', note: '15.6" HD panel at 100% scale' },
  { id: 'desktop', label: 'Desktop 1080p', w: 1920, h: 1080, ppi: 92, input: 'mouse', orientation: 'landscape', form: 'computer', note: '24" 1080p at 100% scale' },
  { id: 'desktop-1440p', label: 'Desktop 1440p', w: 2560, h: 1440, ppi: 109, input: 'mouse', orientation: 'landscape', form: 'computer', note: '27" 1440p at 100% scale' },
  { id: 'console-tv', label: 'Console on a TV', w: 1920, h: 1080, topbar: TOPBAR_TEN_FOOT, tenFoot: true, ppi: 40, input: 'gamepad', orientation: 'landscape', form: 'console', note: '1080p UI on a 55" TV seen from the couch; top bar 87 (58 × 1.5 on a 10-foot interface)' },
];

/** ui_audit's device names (UI_DEVICES) and the lab device each stands for. */
export const LEGACY_DEVICE_IDS: Record<string, string> = {
  phone: 'phone-notch',
  phonePortrait: 'phone-notch-portrait',
  tablet: 'ipad',
  laptop: 'laptop',
  desktop: 'desktop',
  tv: 'console-tv',
};

/** A lab device by its id or ui_audit's name for it (null when there is none). */
export function labDevice(id: string): LabDevice | null {
  const key = LEGACY_DEVICE_IDS[id] ?? id;
  return LAB_DEVICES.find((d) => d.id === key) ?? null;
}

/** The lab devices to check a game on: portrait ones only when it allows portrait (ScreenOrientation Portrait or Sensor). */
export function labDevicesFor(orientation?: string | null): LabDevice[] {
  const portrait = orientation === 'Portrait' || orientation === 'Sensor';
  return LAB_DEVICES.filter((d) => d.orientation === 'landscape' || portrait);
}

/** Points to millimetres on a device's real screen. */
export const pointsToMm = (dev: Pick<LabDevice, 'ppi'>, points: number): number => (points / dev.ppi) * 25.4;

/** Millimetres to points on a device's real screen. */
export const mmToPoints = (dev: Pick<LabDevice, 'ppi'>, mm: number): number => (mm / 25.4) * dev.ppi;

/** The top bar's height on a device (GuiService:GetGuiInset().Y). */
export const topbarOf = (dev: UiScreen): number => dev.topbar ?? TOPBAR;

/** Where a ScreenGui's content goes on a device for each ScreenInsets value (x, y, w, h in points). */
export function insetArea(dev: UiScreen, insets: 'None' | 'DeviceSafeInsets' | 'CoreUISafeInsets'): { x: number; y: number; w: number; h: number } {
  if (insets === 'None') return { x: 0, y: 0, w: dev.w, h: dev.h };
  const side = dev.side ?? 0;
  const top = (dev.top ?? 0) + (insets === 'CoreUISafeInsets' ? topbarOf(dev) : 0);
  return { x: side, y: top, w: dev.w - 2 * side, h: dev.h - top - (dev.bottom ?? 0) };
}

/**
 * A captured ScreenGui as Roblox lays it out: a DeviceSafeInsets screen keeps out of the notch and home bar even though
 * its IgnoreGuiInset reads true (layoutScreen treats IgnoreGuiInset as the whole screen, so such a HUD would sit under
 * the notch on a phone). Other screens are returned as they are.
 */
export function normalizeInsets(screen: UiNode): UiNode {
  return screen.insets === 'DeviceSafeInsets' && screen.ignoreInset ? { ...screen, ignoreInset: false } : screen;
}

// ─── The Studio install (read only) ─────────────────────────────────────────────────────────────────

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Roblox's Lua scripts (ExtraContent\scripts: PlayerScripts and CoreScripts): `SHURIKEN_ROBLOX_SCRIPTS` (that folder or a
 * version folder) first, else the newest `%LOCALAPPDATA%\Roblox\Versions\version-*` with RobloxStudioBeta.exe. Null
 * when there is none.
 */
export function findRobloxScripts(env: NodeJS.ProcessEnv = process.env): { dir: string; version: string | null } | null {
  const at = (dir: string, version: string | null) => (isDir(join(dir, 'PlayerScripts')) && isDir(join(dir, 'CoreScripts')) ? { dir, version } : null);
  const override = env.SHURIKEN_ROBLOX_SCRIPTS;
  if (override) return at(override, null) ?? at(join(override, 'ExtraContent', 'scripts'), basename(override).startsWith('version-') ? basename(override) : null);
  if (!env.LOCALAPPDATA) return null;
  const versions = join(env.LOCALAPPDATA, 'Roblox', 'Versions');
  let best: { t: number; dir: string; name: string } | null = null;
  try {
    for (const name of readdirSync(versions)) {
      if (!name.startsWith('version-')) continue;
      const dir = join(versions, name);
      const exe = join(dir, 'RobloxStudioBeta.exe');
      if (!existsSync(exe) || !isDir(join(dir, 'ExtraContent', 'scripts'))) continue;
      const t = statSync(exe).mtimeMs;
      if (!best || t > best.t) best = { t, dir, name };
    }
  } catch {
    return null;
  }
  return best ? at(join(best.dir, 'ExtraContent', 'scripts'), best.name) : null;
}

/**
 * The fast flags Studio last fetched (`%LOCALAPPDATA%\Roblox\ClientSettings\StudioAppSettings.json`, or
 * `SHURIKEN_ROBLOX_FLAGS`): name → value as written ("True", "False", "True;123;456" for a place filter). Empty when
 * there is no such file.
 */
export function readRobloxFlags(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = env.SHURIKEN_ROBLOX_FLAGS ?? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Roblox', 'ClientSettings', 'StudioAppSettings.json') : null);
  if (!file) return {};
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

/**
 * A user flag as the PlayerModule's FlagUtil.getUserFlag reads it (UserSettings():IsUserFeatureEnabled): true or false
 * when Studio's flags name it (FFlag/SFFlag/DFFlag), null when they don't. Only a place filter ("_PlaceFilter",
 * "_UniverseFilter") means it is off for other games.
 */
export function userFlag(flags: Record<string, string>, name: string): boolean | null {
  for (const p of ['FFlag', 'SFFlag', 'DFFlag']) {
    const v = flags[p + name];
    if (v !== undefined) return v.toLowerCase() === 'true';
  }
  for (const p of ['FFlag', 'SFFlag', 'DFFlag']) if (flags[`${p}${name}_PlaceFilter`] !== undefined || flags[`${p}${name}_UniverseFilter`] !== undefined) return false;
  return null;
}
