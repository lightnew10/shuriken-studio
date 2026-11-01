import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isButton, isText, plainText, type UiBox, type UiFinding, type UiNode, type UiScreen } from '@shared/ui-layout';
import { circle, fillMask, paint, pixelText, roundedRect, strokeOutline, wound, type Pt, type Raster, type Rect } from '../ui-raster';
import { drawLabel, renderUi, type UiRender, type UiRenderOptions } from '../ui-render';
import { normalizeInsets, topbarOf, type LabDevice } from './devices';

/**
 * Roblox's own UI on a device, where the player's thumbs and eyes meet it: the touch controls (dynamic thumbstick and
 * jump button), the top bar's buttons, the player list, the chat window and the tool hotbar, each placed by the formula
 * in Roblox's scripts (ExtraContent\scripts in the Studio install; file and line on every region and in CORE_SOURCES,
 * which checkCoreScripts re-reads so a Roblox update that moves a control is noticed). Game UI that sits under them is
 * reported (overlayFindings) and they are drawn the way they look in play, or as tinted zones (drawCoreOverlays).
 *
 * Defaults are what Studio's flags pick today (ClientSettings\StudioAppSettings.json): the current PlayerModule
 * (PlayerScripts.rbxp maps StarterPlayer\PlayerModule; OldPlayerScripts.rbxp is the legacy one), the dynamic thumbstick
 * (ControlModule/init.lua:91), the classic touch-control sheet (the Avatar Abilities controls need
 * FFlagUserPlayerScriptsCCLIntegrationD, which is place-filtered: `abilities` gives that layout), the "Chrome" top bar
 * with its unibar on the left (ChromeService.lua:284). The player list's and the chat window's layouts live in packages
 * compiled into Roblox (PlayerList, ExpChat), not on disk: those two are estimates and only ever warn.
 */

export interface CoreRegion {
  /** jump, thumbstick-zone, thumbstick-ring, thumbstick, topbar-menu, topbar-unibar, topbar-free, player-list, chat, hotbar, backpack-open */
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its look; a GuiButton (kind button) still takes touches on its whole rectangle. */
  shape: 'rect' | 'circle';
  /** button: Roblox's own control; zone: where touches start something (no picture); panel: a window over the game. */
  kind: 'button' | 'zone' | 'panel';
  /** Touches on it go to Roblox, not to game UI under it. */
  blocksTaps: boolean;
  /** Where the formula is (file:line under ExtraContent\scripts). */
  source: string;
  /** Not from scripts on disk: an estimate (warnings only). */
  estimated?: boolean;
  /** Drawing details: icons in the unibar, slots in the hotbar, rows in the player list, the knob's size. */
  detail?: { icons?: string[]; slots?: number; rows?: number; knob?: number; style?: 'classic' | 'abilities' };
}

export interface CoreOptions {
  /** Roblox's touch controls (TouchGui): on for touch devices unless a script sets GuiService.TouchControlsEnabled false. */
  touchControls?: boolean;
  /** StarterPlayer.DevTouchMovementMode (UserChoice and DynamicThumbstick give the dynamic thumbstick). */
  movement?: 'DynamicThumbstick' | 'Thumbstick' | 'ClickToMove' | 'Scriptable';
  /** False when the character can't jump (JumpPower/JumpHeight 0 or the Jumping state off): no jump button. */
  jump?: boolean;
  /** The Avatar Abilities control layout (FFlagUserPlayerScriptsCCLIntegrationD; off for most games). */
  abilities?: boolean;
  /** SetCore("TopbarEnabled", false) hides the top bar. */
  topbar?: boolean;
  /** CoreGuiType.Chat (also the chat icon in the unibar). */
  chat?: boolean;
  /** CoreGuiType.PlayerList. */
  playerList?: boolean;
  /** CoreGuiType.Backpack. */
  backpack?: boolean;
  /** Tools the player holds: the hotbar shows one slot each (0: no hotbar). */
  tools?: number;
  /** Voice chat on: a mic button in the unibar. */
  voice?: boolean;
  /** The side-sheet menu experiment: the Roblox button moves into the unibar. */
  sideSheet?: boolean;
  /** Rows and stat columns in the player list (its size is estimated from them). */
  players?: number;
  leaderstats?: number;
  /** Also the windows the player opens on a phone (chat, player list): by default only what shows at spawn. */
  opened?: boolean;
}

export type OverlayFinding = Omit<UiFinding, 'devices'> & {
  /** Lab device ids. */
  devices: string[];
  /** The CoreRegion id it collides with. */
  region: string;
};

const P = 'PlayerScripts/StarterPlayer/PlayerModule/ControlModule';
const C = 'CoreScripts/Modules';

const round = (v: number) => Math.round(v);
const smallTouch = (dev: LabDevice) => dev.input === 'touch' && (dev.h < 500 || dev.w < 700);

/** The rectangle of TouchGui's TouchControlFrame: a default ScreenGui (CoreUISafeInsets), so below the top bar and inside the safe area. */
function touchFrame(dev: LabDevice) {
  const side = dev.side ?? 0;
  const y = (dev.top ?? 0) + topbarOf(dev);
  return { x: side, y, w: dev.w - 2 * side, h: dev.h - y - (dev.bottom ?? 0) };
}

const clipToScreen = (r: { x: number; y: number; w: number; h: number }, dev: UiScreen) => {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(dev.w, r.x + r.w);
  const y1 = Math.min(dev.h, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
};

/**
 * Roblox's own UI on a device as it is at spawn (or also what the player opens, with `opened`). Everything but the touch
 * controls is CoreGui, drawn above every game ScreenGui; the touch controls are TouchGui in PlayerGui (DisplayOrder 0).
 */
/** The options with what the shown screens hide while they are open (a screen's `hides`). */
export function coreWhileShown(core: CoreOptions | undefined, screens: Array<{ name: string; enabled?: boolean; hides?: string }>, show: string[] = []): CoreOptions {
  const out: CoreOptions = { ...(core ?? {}) };
  for (const s of screens) {
    if (!s.hides || (s.enabled === false && !show.some((p) => p === s.name || p.startsWith(`${s.name}.`)))) continue;
    for (const w of s.hides.split(/[\s,]+/)) {
      if (w === 'chat') out.chat = false;
      else if (w === 'playerList') out.playerList = false;
      else if (w === 'backpack') out.backpack = false;
      else if (w === 'touch') out.touchControls = false;
    }
  }
  return out;
}

export function coreOverlays(dev: LabDevice, opts: CoreOptions = {}): CoreRegion[] {
  const out: CoreRegion[] = [];
  const touch = opts.touchControls ?? dev.input === 'touch';
  const movement = opts.movement ?? 'DynamicThumbstick';
  const abilities = !!opts.abilities;

  // ─── Touch controls (PlayerModule) ───
  if (touch && movement !== 'Scriptable') {
    const f = touchFrame(dev);
    // TouchJump.lua:234-235 / DynamicThumbstick.lua:595 / ClassicThumbstick.lua:188-189: the parent frame's shorter side.
    const small = Math.min(f.w, f.h) <= 500;
    if (movement === 'DynamicThumbstick') {
      const portrait = dev.w < dev.h; // DynamicThumbstick.lua:655-658 (camera ViewportSize)
      const inset = 100; // SAFE_AREA_INSET_MAX, :29
      // :451-459: landscape (0.4, 100, 2/3, 100) at (0, -100, 1/3, 0); portrait (1, 100, 0.4, 100) at (0, -100, 0.6, 0).
      const zone = portrait ? { x: f.x - inset, y: f.y + 0.6 * f.h, w: f.w + inset, h: 0.4 * f.h + inset } : { x: f.x - inset, y: f.y + f.h / 3, w: 0.4 * f.w + inset, h: (2 / 3) * f.h + inset };
      out.push({ id: 'thumbstick-zone', label: 'Roblox’s thumbstick area', ...clipToScreen(zone, dev), shape: 'rect', kind: 'zone', blocksTaps: true, source: `${P}/DynamicThumbstick.lua:451-459,472-481 (frame and its full-size UIModifier button, bound at :126)` });
      let cx: number;
      let cy: number;
      let outer: number;
      let knob: number;
      if (abilities) {
        // :606-627 with FFlagUserAllowAbilityControlsBonus: a 120-point ring on big screens, insets 64/64 or 100/112.
        outer = small ? 74 : 120;
        const ix = small ? 64 : 100;
        const iy = small ? 64 : 112;
        cx = f.x + outer / 2 + ix;
        cy = f.y + f.h - outer / 2 - iy;
        knob = (small ? 45 : 45 * (120 / 74)) * 0.6;
      } else {
        // :597-605, :629-630: ring = 20 × scale, outer 74 × scale (scale 2 on a big screen), centred ring×3.3 in and ring×2.8 up.
        const scale = small ? 1 : 2;
        const ring = 20 * scale;
        outer = 74 * scale;
        cx = f.x + ring * 3.3;
        cy = f.y + f.h - ring * 2.8;
        knob = 45 * scale * 0.8; // :638
      }
      out.push({
        id: 'thumbstick-ring',
        label: 'Roblox’s thumbstick (at rest)',
        x: cx - outer / 2,
        y: cy - outer / 2,
        w: outer,
        h: outer,
        shape: 'circle',
        kind: 'zone',
        blocksTaps: true,
        source: abilities ? `${P}/DynamicThumbstick.lua:606-627` : `${P}/DynamicThumbstick.lua:597-605,629-630`,
        detail: { knob, style: abilities ? 'abilities' : 'classic' },
      });
    } else if (movement === 'Thumbstick') {
      // ClassicThumbstick.lua:196-206.
      let size: number;
      let x: number;
      let y: number;
      if (abilities) {
        size = small ? 72 : 120;
        x = f.x + (small ? 64 : 100);
        y = f.y + f.h - size - (small ? 64 : 112);
      } else {
        size = small ? 70 : 120;
        x = f.x + (small ? size / 2 - 10 : size / 2);
        y = f.y + f.h - (small ? size + 20 : size * 1.75);
      }
      out.push({ id: 'thumbstick', label: 'Roblox’s thumbstick', x, y, w: size, h: size, shape: 'circle', kind: 'button', blocksTaps: true, source: `${P}/ClassicThumbstick.lua:187-206`, detail: { knob: size / 2 } });
    }
    if (opts.jump !== false) {
      // TouchJump.lua:233-258 (shown with every touch movement mode but Scriptable: ControlModule/init.lua:416-433).
      let size: number;
      let x: number;
      let y: number;
      if (abilities) {
        size = small ? 72 : 120;
        x = f.x + f.w - size - (small ? 64 : 100);
        y = f.y + f.h - size - (small ? 64 : 112);
      } else {
        size = small ? 70 : 120;
        x = f.x + f.w - (size * 1.5 - 10);
        y = f.y + f.h - (small ? size + 20 : size * 1.75);
      }
      out.push({ id: 'jump', label: 'Roblox’s jump button', x, y, w: size, h: size, shape: 'circle', kind: 'button', blocksTaps: true, source: abilities ? `${P}/TouchJump.lua:237-249` : `${P}/TouchJump.lua:233-235,250-258`, detail: { style: abilities ? 'abilities' : 'classic' } });
    }
  }

  // ─── The top bar (CoreGui, drawn over every game ScreenGui) ───
  if (opts.topbar !== false) {
    // TopBarApp's ScreenGui has IgnoreGuiInset (TopBarApp.lua:791): it keeps inside the device safe area.
    const k = dev.tenFoot ? 1.5 : 1; // Constants.lua:21-24 and UIBlox Tokens/init.lua:28-30 (console tokens × 1.5)
    const x0 = dev.side ?? 0;
    const y0 = dev.top ?? 0;
    const btn = 44 * k; // TopBarButtonHeight = Size_1100 (Constants.lua:30)
    const sideOff = 16 * k; // ScreenSideOffset = Gap.Large (Constants.lua:46)
    const pad = 8 * k; // TopBarPadding = Padding.Small (Constants.lua:47)
    const top = 12 * k; // TopBarTopMargin 10 + UnibarFrame.PaddingTop 2, or Gap.Medium 12 with the refactor (Constants.lua:75,82)
    if (!opts.sideSheet)
      out.push({ id: 'topbar-menu', label: 'Roblox’s menu button', x: x0 + sideOff, y: y0 + top, w: btn, h: btn, shape: 'circle', kind: 'button', blocksTaps: true, source: `${C}/TopBar/Components/TopBarApp.lua:855-864; Presentation/IconButton.lua:148-167` });
    const icons = ['menu', ...(opts.chat !== false ? ['chat'] : []), ...(opts.voice ? ['mic'] : [])];
    // UnibarFrame.PaddingLeft (Constants.lua:84) from a frame starting one ScreenSideOffset left of the screen (TopBarApp.lua:1019-1045).
    const ux = x0 - sideOff + sideOff + pad + (opts.sideSheet ? 0 : topbarOf(dev)) + 2 * k;
    const uw = 2 * 4 * k + icons.length * 44 * k; // UnibarMenu.lua:534,545: end padding XSmall ×2 + ICON_CELL_WIDTH per icon
    out.push({ id: 'topbar-unibar', label: 'Roblox’s unibar (menu, chat)', x: ux, y: y0 + top, w: uw, h: btn, shape: 'rect', kind: 'button', blocksTaps: true, source: `${C}/Chrome/ChromeShared/Unibar/UnibarMenu.lua:429-432,534,545; Chrome/ConfigureChrome.lua:40`, detail: { icons } });
    // GuiService.TopbarInset: the widest free stretch of the row (KeepOutAreasHandler.lua:79-115).
    const free = ux + uw;
    out.push({ id: 'topbar-free', label: 'Free top bar (TopbarInset)', x: free, y: y0, w: Math.max(0, dev.w - x0 - free), h: topbarOf(dev), shape: 'rect', kind: 'zone', blocksTaps: false, source: `${C}/Chrome/ChromeShared/Service/KeepOutAreasHandler.lua:79-121` });
  }

  // ─── Player list (CoreGuiType.PlayerList): at the top right; hidden at start on a small touch screen and a console ───
  const plAtStart = !smallTouch(dev) && dev.form !== 'console'; // PlayerListInitialVisibleState.lua:41-72 (a console counts as small: it starts hidden too); Settings/Utility.lua:252-255
  if (opts.playerList !== false && (plAtStart || opts.opened)) {
    const stats = Math.max(0, opts.leaderstats ?? 0);
    const rows = Math.max(1, opts.players ?? 4) + (stats ? 1 : 0);
    const w = 166 + 76 * stats;
    const avail = dev.h - (dev.top ?? 0) - topbarOf(dev) - (dev.bottom ?? 0);
    const h = Math.min(avail * 0.5, rows * 40);
    out.push({ id: 'player-list', label: 'Roblox’s player list', x: dev.w - (dev.side ?? 0) - 4 - w, y: (dev.top ?? 0) + topbarOf(dev) + 4, w, h, shape: 'rect', kind: 'panel', blocksTaps: true, estimated: true, source: `${C}/PlayerList/Components/Presentation/PlayerListApp.lua:121-163 (layout values compiled into the PlayerList package: size estimated)`, detail: { rows } });
  }

  // ─── Chat window (CoreGuiType.Chat): at the top left; hidden at start on a small touch screen ───
  const chatAtStart = !smallTouch(dev) && dev.form !== 'console'; // ChatChromeIntegration.lua:84-87
  if (opts.chat !== false && (chatAtStart || opts.opened)) {
    const f = touchFrame(dev);
    // The legacy chat's defaults (ChatSettings.lua:59-62, by width ChatWindow.lua:13-14,133-141); TextChatService's window is in ExpChat (compiled in).
    const [sx, sy] = f.w <= 640 ? [0.5, 0.5] : f.w <= 1024 ? [0.4, 0.3] : [0.3, 0.25];
    out.push({ id: 'chat', label: 'Roblox’s chat window', x: f.x, y: f.y, w: sx * f.w, h: sy * f.h + 24, shape: 'rect', kind: 'panel', blocksTaps: true, estimated: true, source: `${C}/Server/ClientChat/DefaultClientChatModules/ChatSettings.lua:59-62 (legacy chat; TextChatService's window is compiled in: estimated)` });
  }

  // ─── Tool hotbar (CoreGuiType.Backpack): one slot per tool at the bottom centre ───
  const tools = Math.max(0, Math.floor(opts.tools ?? 0));
  if (opts.backpack !== false && tools > 0) {
    const phone = dev.input === 'touch' && dev.w < 1024; // BackpackScript.lua:150-152,189
    const n = phone ? 3 : 10; // :84-87
    const icon = dev.tenFoot ? 100 : 60; // :55, :141
    const buf = 5; // :57
    const frameW = buf + n * (icon + buf);
    const frameH = icon + 2 * buf;
    const bottom = dev.h - (dev.bottom ?? 0);
    const fx = dev.w / 2 - frameW / 2; // :295-296
    const fy = bottom - frameH;
    const t = Math.min(tools, n);
    // Visible slots centred (:386-393): slot i at centre − icon/2 + (icon + buf)(i − (t/2 + 0.5)).
    const first = fx + frameW / 2 - icon / 2 + (icon + buf) * (1 - (t / 2 + 0.5));
    out.push({ id: 'hotbar', label: 'Roblox’s tool hotbar', x: first, y: fy + buf, w: t * icon + (t - 1) * buf, h: icon, shape: 'rect', kind: 'button', blocksTaps: true, source: `${C}/BackpackScript.lua:55-57,84-87,150-152,295-296,386-393`, detail: { slots: t } });
    out.push({ id: 'backpack-open', label: 'Roblox’s backpack button', x: dev.w / 2 - 15, y: bottom - 110, w: 30, h: 30, shape: 'rect', kind: 'button', blocksTaps: true, source: `${C}/BackpackScript.lua:274,1458-1460` });
  }
  return out;
}

// ─── Findings ──────────────────────────────────────────────────────────────────────────────────────

type R = { x: number; y: number; w: number; h: number };
const area = (r: R) => Math.max(0, r.w) * Math.max(0, r.h);
const rectOverlap = (a: R, b: R) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** How much of a rectangle a circle covers (numerically, 64 strips). */
function circleOverlap(c: R, r: R): number {
  const rad = c.w / 2;
  const cx = c.x + rad;
  const cy = c.y + rad;
  const x0 = Math.max(r.x, cx - rad);
  const x1 = Math.min(r.x + r.w, cx + rad);
  if (x1 <= x0) return 0;
  const n = 64;
  const dx = (x1 - x0) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = x0 + (i + 0.5) * dx;
    const hh = Math.sqrt(Math.max(0, rad * rad - (x - cx) * (x - cx)));
    sum += Math.max(0, Math.min(r.y + r.h, cy + hh) - Math.max(r.y, cy - hh)) * dx;
  }
  return sum;
}

/** The area a region covers of a box: a GuiButton takes touches on its whole rectangle; the thumbstick's ring is round. */
function overlapWith(region: CoreRegion, box: R): { overlap: number; regionArea: number } {
  const isRound = region.shape === 'circle' && region.kind !== 'button';
  return isRound ?{ overlap: circleOverlap(region, box), regionArea: Math.PI * (region.w / 2) ** 2 } : { overlap: rectOverlap(region, box), regionArea: area(region) };
}

/**
 * A drawn element that only decorates where it meets Roblox's control: not text, and either named as an effect
 * (vignette, scrim, mask, glow...) or much bigger than the control (a strip or panel running past it), so Roblox's
 * control drawn over it hides nothing a player needs.
 */
const decorative = (b: UiBox, r: R, regionArea: number) =>
  !(isText(b.node) && plainText(b.node).trim()) && (b.path.split('.').some((seg) => /vignette|scrim|mask|shade|dim$|backdrop|overlay|glow|shadow|fx(_|$)|gradient|bg$|background/i.test(seg)) || area(r) > 3 * regionArea);

/** What a box draws (a fill, text or an image), as auditUi's "draws". */
const draws = (n: UiNode) => (!!n.bg && (n.bgT ?? 0) < 0.9) || (isText(n) && !!plainText(n).trim()) || ((n.cls === 'ImageLabel' || n.cls === 'ImageButton') && !!n.image && (n.imageT ?? 0) < 0.9);

/** The part of a box on show (its clip applied). */
function shownRect(b: UiBox): R | null {
  let r: R = { x: b.x, y: b.y, w: b.w, h: b.h };
  if (b.clip) {
    const [cx, cy, cw, ch] = b.clip;
    const x0 = Math.max(r.x, cx);
    const y0 = Math.max(r.y, cy);
    r = { x: x0, y: y0, w: Math.min(r.x + r.w, cx + cw) - x0, h: Math.min(r.y + r.h, cy + ch) - y0 };
  }
  return r.w >= 1 && r.h >= 1 ? r : null;
}

/** Per region: [share for a problem, share for a warning] for buttons, and the share at which a drawn element is a warning. */
const RULES: Record<string, { press?: [number, number]; inside?: number; seen?: number; text?: number }> = {
  jump: { press: [0.25, 0.06], seen: 0.25 },
  thumbstick: { press: [0.25, 0.06], seen: 0.25 },
  'thumbstick-ring': { press: [0.2, 0.06], seen: 0.3 },
  'thumbstick-zone': { inside: 0.5 },
  // A brush with the round menu button isn't a clash (graded by eye): a third of it covered is.
  'topbar-menu': { press: [0.35, 0.15], seen: 0.25 },
  'topbar-unibar': { press: [0.35, 0.15], seen: 0.25 },
  'player-list': { inside: 0.3, text: 0.3 },
  chat: { inside: 0.3, text: 0.3 },
  hotbar: { press: [0.2, 0.08], seen: 0.25 },
  'backpack-open': { press: [0.25, 0.1], seen: 0.4 },
};

const at = (r: CoreRegion) => (r.shape === 'circle' ? `${round(r.w)}-point circle centred at ${round(r.x + r.w / 2)}, ${round(r.y + r.h / 2)}` : `${round(r.w)}×${round(r.h)} at ${round(r.x)}, ${round(r.y)}`);

/** Which of a game ScreenGui and Roblox's TouchGui (DisplayOrder 0, ControlModule/init.lua:884-906) gets a touch first. */
type Layer = 'above' | 'below' | 'tie';
const layerOf = (order: number): Layer => (order > 0 ? 'above' : order < 0 ? 'below' : 'tie');
const touchWho: Record<Layer, (what: string) => string> = {
  above: (what) => `its ScreenGui draws above the touch controls, so a thumb going for the ${what} presses this instead`,
  below: (what) => `the touch controls draw above its ScreenGui, so the ${what} takes the touch and this can’t be pressed there`,
  tie: (what) => `its ScreenGui and the touch controls both have DisplayOrder 0, so whether the ${what} or this gets the thumb is undecided`,
};

function message(r: CoreRegion, press: boolean, sev: 'problem' | 'warning', layer: Layer): string {
  const where = at(r);
  switch (r.id) {
    case 'jump':
      return press
        ? sev === 'problem'
          ? `On Roblox’s jump button (${where}): ${touchWho[layer]('jump button')}. Keep buttons out of that corner on touch screens`
          : `Touches Roblox’s jump button (${where}): easy to press one for the other`
        : `Drawn where Roblox’s jump button is (${where}): one hides the other`;
    case 'thumbstick':
      return press ? `On Roblox’s thumbstick (${where}): ${touchWho[layer]('thumbstick')}` : `Drawn where Roblox’s thumbstick is (${where})`;
    case 'thumbstick-ring':
      return press
        ? sev === 'problem'
          ? `Where Roblox’s thumbstick rests (${where}): ${touchWho[layer]('thumbstick')}`
          : `Touches where Roblox’s thumbstick rests (${where}): the left thumb can land on this instead of moving`
        : `Under Roblox’s thumbstick ring (${where}): the stick and this draw over each other`;
    case 'thumbstick-zone':
      return `In Roblox’s thumbstick area (x ${round(r.x)}–${round(r.x + r.w)}, y ${round(r.y)}–${round(r.y + r.h)}, where a touch starts the stick): ${touchWho[layer]('thumbstick')}`;
    case 'topbar-menu':
      return press ? `Under Roblox’s menu button (${where}): the top bar is drawn over every game UI, so this can’t be tapped there` : `Hidden under Roblox’s menu button (${where})`;
    case 'topbar-unibar':
      return press ? `Under Roblox’s unibar (${where}): the top bar is drawn over every game UI, so this can’t be tapped there` : `Hidden under Roblox’s unibar (${where})`;
    case 'player-list':
      return `Under Roblox’s player list (about ${where}, shown at start on tablets and computers): turn it off (SetCoreGuiEnabled PlayerList) or keep this clear of the top right`;
    case 'chat':
      return `Under Roblox’s chat window (about ${where}, shown at start on tablets and computers): keep this clear of the top left or turn chat off`;
    case 'hotbar':
      return press ? `Under Roblox’s tool hotbar (${where}): it is drawn over game UI and takes the taps` : `Hidden under Roblox’s tool hotbar (${where})`;
    case 'backpack-open':
      return press ? `Under Roblox’s backpack button (${where})` : `Hidden under Roblox’s backpack button (${where})`;
    default:
      return `Under ${r.label} (${where})`;
  }
}

export interface OverlayContext {
  /** The ScreenGuis the boxes come from: their DisplayOrder, and the "…Dim"/"…Backdrop" screens that mark menus. */
  screens?: UiNode[];
  /** Report only elements at or under this path; the other boxes still tell windows and backdrops apart. */
  scope?: string;
  /** Found in a screen or element that scripts show later. */
  whenShown?: boolean;
  /** The game turns Roblox's touch controls off while its menus are open (GuiService.TouchControlsEnabled = false). */
  menusHideControls?: boolean;
}

const TOUCH = new Set(['jump', 'thumbstick', 'thumbstick-ring', 'thumbstick-zone']);
const DIM = /dim|backdrop|blur|shade/i;

/**
 * Whether a box is part of a menu rather than the HUD: under a backdrop (an ancestor filling ≥ 45% of the screen with
 * colour, or a click-catcher button over half of it), in a window (a top-level element filling ≥ 30%), or in a screen
 * that has its own dimming screen ("ShopDim" for "Shop", or a full-screen "…Backdrop" just below it).
 */
function inMenu(b: UiBox, byPath: Map<string, UiBox>, screen: UiNode | undefined, screens: UiNode[], dev: LabDevice): boolean {
  const full = dev.w * dev.h;
  const parts = b.path.split('.');
  for (let i = 2; i < parts.length; i++) {
    const a = byPath.get(parts.slice(0, i).join('.'));
    if (!a) continue;
    const ar = a.w * a.h;
    if ((draws(a.node) && ar >= 0.45 * full) || (isButton(a.node) && ar >= 0.5 * full)) return true;
    if (i === 2 && draws(a.node) && ar >= 0.3 * full) return true;
  }
  if (!screen) return false;
  const order = screen.displayOrder ?? 0;
  return screens.some((d) => {
    if (d === screen || !DIM.test(d.name)) return false;
    const stem = d.name.replace(DIM, '').toLowerCase();
    if (stem && (screen.name.toLowerCase() === stem || screen.name.toLowerCase().startsWith(stem) || stem.startsWith(screen.name.toLowerCase()))) return true;
    return order - (d.displayOrder ?? 0) === 1 && (d.ignoreInset || d.insets === 'None');
  });
}

/**
 * Game UI that Roblox's own UI covers on a device: buttons under the jump button or where the thumbstick rests
 * (problems), buttons inside the thumbstick's touch area (warnings: a touch starting there goes to one or the other),
 * buttons and drawn elements under the top bar's buttons and the hotbar, and buttons and text under the player list and
 * chat (estimated: warnings). Only what a player meets counts: buttons, text, images and filled frames; transparent
 * containers and anything over half the screen (backdrops, modal catchers) never do. An element inside one already
 * reported for the same region isn't reported again. Against the touch controls, a menu doesn't count when it draws
 * above them (DisplayOrder > 0; TouchGui has 0) or when the game hides them for its menus, and a game's own jump button
 * or stick placed over Roblox's (named "Jump", "Thumbstick"...) is a replacement, not a clash.
 */
export function overlayFindings(boxes: UiBox[], regions: CoreRegion[], dev: LabDevice, ctx: OverlayContext = {}): OverlayFinding[] {
  const out: Array<OverlayFinding & { drawn?: boolean }> = [];
  const big = 0.5 * dev.w * dev.h;
  const byPath = new Map(boxes.map((b) => [b.path, b]));
  const screens = ctx.screens ?? [];
  const screenOf = (path: string) => screens.find((s) => path === s.name || path.startsWith(`${s.name}.`));
  const inScope = (path: string) => !ctx.scope || path === ctx.scope || path.startsWith(`${ctx.scope}.`);
  const cand = boxes
    .filter((b) => inScope(b.path))
    .map((b) => ({ b, r: shownRect(b), press: isButton(b.node) }))
    .filter((c): c is { b: UiBox; r: R; press: boolean } => !!c.r && area(c.r) < big && (c.press || draws(c.b.node)))
    .sort((a, b) => a.b.depth - b.b.depth || a.b.order - b.b.order);
  const menu = new Map<string, boolean>();
  const menuAboveControls = (b: UiBox) => {
    if (!menu.has(b.path)) {
      const s = screenOf(b.path);
      menu.set(b.path, ((s?.displayOrder ?? 0) > 0 || !!ctx.menusHideControls) && inMenu(b, byPath, s, screens, dev));
    }
    return menu.get(b.path)!;
  };
  const replaces = (region: CoreRegion, b: UiBox) => {
    const re = region.id === 'jump' ? /jump/i : /thumbstick|joystick|stick|dpad|movepad|^move/i;
    return b.path.split('.').slice(1).some((seg) => re.test(seg));
  };
  const under = (path: string, of: string) => path.startsWith(`${of}.`);
  // The thumbstick's area last: a button already reported at the ring or the jump button isn't repeated for it.
  const ordered = [...regions].sort((a, b) => Number(a.id === 'thumbstick-zone') - Number(b.id === 'thumbstick-zone'));
  for (const region of ordered) {
    const rule = RULES[region.id];
    if (!rule) continue;
    const flagged: Array<{ path: string; press: boolean }> = [];
    // Buttons first, then what only draws (skipped inside a flagged element, or around a flagged button).
    for (const pass of [true, false])
      for (const { b, r, press } of cand) {
        if (press !== pass) continue;
        if (flagged.some((f) => under(b.path, f.path) || (!pass && f.press && under(f.path, b.path)))) continue;
        const { overlap, regionArea } = overlapWith(region, r);
        if (overlap <= 0) continue;
        if (TOUCH.has(region.id) && (replaces(region, b) || menuAboveControls(b))) continue;
        const share = overlap / Math.max(1, Math.min(area(r), regionArea));
        const inside = overlap / Math.max(1, area(r));
        let sev: 'problem' | 'warning' | null = null;
        if (press && rule.press) sev = share >= rule.press[0] ? 'problem' : share >= rule.press[1] ? 'warning' : null;
        else if (press && rule.inside !== undefined) sev = inside >= rule.inside ? 'warning' : null;
        else if (!press && rule.seen !== undefined) sev = share >= rule.seen && !decorative(b, r, regionArea) ? 'warning' : null;
        else if (!press && rule.text !== undefined && isText(b.node) && plainText(b.node).trim()) sev = inside >= rule.text ? 'warning' : null;
        if (!sev) continue;
        if (region.estimated) sev = 'warning';
        if (region.id === 'thumbstick-zone' && out.some((f) => (f.region === 'thumbstick-ring' || f.region === 'jump') && f.path === b.path)) continue;
        flagged.push({ path: b.path, press });
        out.push({ severity: sev, devices: [dev.id], path: b.path, region: region.id, message: message(region, press, sev, layerOf(screenOf(b.path)?.displayOrder ?? 0)), ...(ctx.whenShown ? { whenShown: true } : {}), ...(press ? {} : { drawn: true }) });
      }
  }
  return group(out);
}

/**
 * One finding where one would do: what the player list or chat covers, per top-level element ("Hud.Stats: 4 of its
 * buttons and texts…"), and drawn-only elements under a control, per parent (five ammo pips are one finding).
 */
function group(list: Array<OverlayFinding & { drawn?: boolean }>): OverlayFinding[] {
  const out: OverlayFinding[] = [];
  const groups = new Map<string, OverlayFinding[]>();
  for (const { drawn, ...f } of list) {
    const panel = f.region === 'player-list' || f.region === 'chat';
    if (!panel && !drawn) {
      out.push(f);
      continue;
    }
    const parts = f.path.split('.');
    const top = panel ? parts.slice(0, 2).join('.') : parts.slice(0, -1).join('.') || f.path;
    const key = `${f.region}|${f.severity}|${top}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const [key, fs] of groups) {
    const top = key.split('|').slice(2).join('|');
    const first = fs[0]!;
    const panel = first.region === 'player-list' || first.region === 'chat';
    // A panel's finding is always its top-level element's (the same one on every device, so they merge).
    if (fs.length === 1 && (!panel || first.path === top)) {
      out.push(first);
      continue;
    }
    const names = fs.map((f) => f.path.slice(top.length + 1) || f.path);
    const what = panel ? 'buttons and texts' : 'elements';
    out.push({ ...first, path: top, message: `${fs.length} of its ${what} (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}): ${first.message.charAt(0).toLowerCase()}${first.message.slice(1)}` });
  }
  return out;
}

/** Findings from several devices as one list: the same path, region and message (numbers aside) on several devices is one finding. */
export function mergeFindings(lists: OverlayFinding[][]): OverlayFinding[] {
  const found = new Map<string, OverlayFinding>();
  for (const list of lists)
    for (const f of list) {
      const key = `${f.path}|${f.region}|${f.message.replace(/\([^)]*\)/g, '()').replace(/\d+(\.\d+)?/g, '#')}|${f.whenShown ? 1 : 0}`;
      const prev = found.get(key);
      if (!prev) found.set(key, { ...f, devices: [...f.devices] });
      else {
        for (const d of f.devices) if (!prev.devices.includes(d)) prev.devices.push(d);
        if (f.severity === 'problem') prev.severity = 'problem';
      }
    }
  return [...found.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1) || Number(!!a.whenShown) - Number(!!b.whenShown));
}

/**
 * What a game's code does to Roblox's UI, read from its source files: SetCoreGuiEnabled(Enum.CoreGuiType.X, false)
 * (also through pcall, or with a variable that a file only ever sets false, looping over a list of types) turns that
 * part off, while a file that sets the same variable back to true (a cutscene hiding the UI for a while) doesn't; tools
 * (Instance.new("Tool")) mean a hotbar; TouchControlsEnabled = false is reported, not applied (games flip it for
 * menus); DevTouchMovementMode set in code picks the movement mode.
 */
export function coreGuiFromSource(code: string | string[]): { options: CoreOptions; notes: string[] } {
  const files = typeof code === 'string' ? [code] : code;
  const options: CoreOptions = {};
  const notes: string[] = [];
  const off = (t: string) => {
    if (t === 'All') {
      Object.assign(options, { chat: false, playerList: false, backpack: false });
      if (!notes.includes('SetCoreGuiEnabled(All, false)')) notes.push('SetCoreGuiEnabled(All, false)');
    } else if (t === 'Chat') options.chat = false;
    else if (t === 'PlayerList') options.playerList = false;
    else if (t === 'Backpack') options.backpack = false;
  };
  for (const f of files) {
    for (const m of f.matchAll(/SetCoreGuiEnabled\s*(?:\(|,\s*\w+\s*,)\s*Enum\.CoreGuiType\.(\w+)\s*,\s*false\s*\)/g)) off(m[1]!);
    for (const m of f.matchAll(/SetCoreGuiEnabled\(\s*([A-Za-z_]\w*)\s*,\s*false\s*\)/g)) {
      const v = m[1]!;
      if (new RegExp(`SetCoreGuiEnabled\\(\\s*${v}\\s*,(?!\\s*false\\b)`).test(f)) continue;
      for (const t of f.matchAll(/Enum\.CoreGuiType\.(\w+)/g)) off(t[1]!);
    }
  }
  const all = files.join('\n');
  if (/SetCore\(\s*["']TopbarEnabled["']\s*,\s*false\s*\)/.test(all)) {
    options.topbar = false;
    notes.push('SetCore("TopbarEnabled", false)');
  }
  if (/Instance\.new\(\s*["']Tool["']/.test(all)) notes.push('creates Tools');
  if (/TouchControlsEnabled\s*=\s*false/.test(all)) notes.push('sets GuiService.TouchControlsEnabled = false somewhere (kept on: often only for menus)');
  const mode = /DevTouchMovementMode\s*=\s*Enum\.DevTouchMovementMode\.(\w+)/.exec(all)?.[1];
  if (mode === 'Thumbstick' || mode === 'ClickToMove' || mode === 'Scriptable' || mode === 'DynamicThumbstick') options.movement = mode;
  return { options, notes };
}

// ─── Drawing ───────────────────────────────────────────────────────────────────────────────────────

export type Mat = [number, number, number, number, number, number];
const ap = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
type RGB01 = [number, number, number];

/**
 * Draws Roblox's UI over a picture of the screen: `view` maps points to pixels (as ui-render's), `scale` is pixels per
 * point. 'controls' draws them as a player sees them (the thumbstick ring and knob, the jump button, the top bar's round
 * button and pill, translucent player list and chat, hotbar slots); 'zones' tints each region by kind (touch areas
 * blue, Roblox's buttons orange, windows violet) with its name. `clip` keeps the drawing inside the screen's part of
 * the picture.
 */
export function drawCoreOverlays(c: Raster, regions: CoreRegion[], view: Mat, scale: number, mode: 'controls' | 'zones' = 'controls', clip?: Rect): void {
  const bounds: Rect = clip ?? { x: 0, y: 0, w: c.w, h: c.h };
  const poly = (pts: Pt[], col: [number, number, number, number]) => {
    const m = fillMask([wound(pts.map(([x, y]) => ap(view, x, y)), 1)], bounds);
    if (m) paint(c, m, col);
  };
  const line = (pts: Pt[], width: number, col: [number, number, number, number], closed = false) => {
    const m = fillMask(strokeOutline([pts.map(([x, y]) => ap(view, x, y))], (width * scale) / 2, closed), bounds);
    if (m) paint(c, m, col);
  };
  const disc = (cx: number, cy: number, r: number, col: [number, number, number, number]) => {
    const [px, py] = ap(view, cx, cy);
    const m = fillMask([circle(px, py, r * scale)], bounds);
    if (m) paint(c, m, col);
  };
  const ring = (cx: number, cy: number, r: number, width: number, col: [number, number, number, number]) => {
    const [px, py] = ap(view, cx, cy);
    const m = fillMask([circle(px, py, (r + width / 2) * scale, 1), circle(px, py, Math.max(0, r - width / 2) * scale, -1)], bounds);
    if (m) paint(c, m, col);
  };
  const rrect = (x: number, y: number, w: number, h: number, rad: number, col: [number, number, number, number]) => poly(roundedRect(x, y, w, h, [rad, rad, rad, rad]), col);

  if (mode === 'zones') {
    const tint: Record<CoreRegion['kind'], RGB01> = { zone: [0.25, 0.6, 1], button: [1, 0.55, 0.12], panel: [0.72, 0.45, 1] };
    for (const r of regions) {
      if (r.w <= 0 || r.h <= 0) continue;
      const col = tint[r.kind];
      const fillA = r.kind === 'zone' ? (r.blocksTaps ? 0.18 : 0.08) : r.kind === 'panel' ? 0.22 : 0.38;
      if (r.shape === 'circle') {
        disc(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, [...col, fillA]);
        ring(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, 1.5 / scale, [...col, 0.9]);
      } else {
        poly(roundedRect(r.x, r.y, r.w, r.h), [...col, fillA]);
        line(roundedRect(r.x, r.y, r.w, r.h), 1.5 / scale, [...col, 0.9], true);
      }
      const [lx, ly] = ap(view, r.x + 3, r.y + 2);
      const size = Math.max(10, Math.min(13, 11 * scale));
      if (r.w * scale > 40 && r.h * scale > size + 2) drawLabel(c, `${r.label.replace(/^Roblox’s /, '')}${r.estimated ? ' (est.)' : ''}`, Math.max(bounds.x, lx), Math.max(bounds.y, ly), size, [1, 1, 1], { maxWidth: r.w * scale - 6 });
    }
    return;
  }

  const ink: [number, number, number, number] = [1, 1, 1, 0.92];
  for (const r of regions) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rad = r.w / 2;
    switch (r.id) {
      case 'thumbstick-ring':
      case 'thumbstick': {
        // The touch-control sheet's ring (ImageColor3 black at rest) and its knob.
        disc(cx, cy, rad, [0, 0, 0, 0.28]);
        ring(cx, cy, rad - Math.max(1.5, rad * 0.06), Math.max(2, rad * 0.1), [1, 1, 1, 0.55]);
        disc(cx, cy, (r.detail?.knob ?? rad) / 2, [0.85, 0.85, 0.88, 0.85]);
        break;
      }
      case 'jump': {
        disc(cx, cy, rad, [0, 0, 0, 0.3]);
        ring(cx, cy, rad - Math.max(1.5, rad * 0.05), Math.max(2, rad * 0.07), [1, 1, 1, 0.85]);
        const a = rad * 0.38;
        line(
          [
            [cx - a, cy + a * 0.45],
            [cx, cy - a * 0.55],
            [cx + a, cy + a * 0.45],
          ],
          Math.max(2.5, rad * 0.12),
          ink,
        );
        break;
      }
      case 'topbar-menu': {
        disc(cx, cy, rad, [0.07, 0.07, 0.08, 0.62]);
        // The tilted Roblox block: a square turned 15° with a square hole.
        const s = r.w * (24 / 44) * 0.62;
        const t = (15 * Math.PI) / 180;
        const sq = (half: number): Pt[] =>
          [
            [-half, -half],
            [half, -half],
            [half, half],
            [-half, half],
          ].map(([x, y]) => [cx + x! * Math.cos(t) - y! * Math.sin(t), cy + x! * Math.sin(t) + y! * Math.cos(t)] as Pt);
        const outer = sq(s / 2).map(([x, y]) => ap(view, x, y));
        const hole = sq(s / 7).map(([x, y]) => ap(view, x, y));
        const m = fillMask([wound(outer, 1), wound(hole, -1)], bounds);
        if (m) paint(c, m, ink);
        break;
      }
      case 'topbar-unibar': {
        rrect(r.x, r.y, r.w, r.h, r.h / 2, [0.07, 0.07, 0.08, 0.62]);
        const cell = r.h; // ICON_CELL_WIDTH = the bar's height
        const k = r.h / 44;
        (r.detail?.icons ?? []).forEach((icon, i) => {
          const ix = r.x + 4 * k + cell * i + cell / 2;
          if (icon === 'menu')
            for (const dy of [-6, 0, 6]) rrect(ix - 9 * k, cy + dy * k - 1.1 * k, 18 * k, 2.2 * k, 1.1 * k, ink);
          else if (icon === 'chat') {
            line(roundedRect(ix - 9 * k, cy - 7 * k, 18 * k, 13 * k, [4 * k, 4 * k, 4 * k, 4 * k]), 2 * k, ink, true);
            poly(
              [
                [ix - 5 * k, cy + 5 * k],
                [ix - 7 * k, cy + 10 * k],
                [ix - 1 * k, cy + 5.5 * k],
              ],
              ink,
            );
          } else if (icon === 'mic') {
            rrect(ix - 3.5 * k, cy - 9 * k, 7 * k, 12 * k, 3.5 * k, ink);
            line(
              [
                [ix - 7 * k, cy - 1 * k],
                [ix - 6 * k, cy + 4 * k],
                [ix, cy + 6.5 * k],
                [ix + 6 * k, cy + 4 * k],
                [ix + 7 * k, cy - 1 * k],
              ],
              1.8 * k,
              ink,
            );
          }
        });
        break;
      }
      case 'player-list': {
        rrect(r.x, r.y, r.w, r.h, 8, [0.07, 0.07, 0.08, 0.55]);
        const rows = Math.max(1, Math.floor(r.h / 40));
        for (let i = 0; i < rows; i++) {
          const ry = r.y + i * 40 + 20;
          disc(r.x + 22, ry, 11, [0.6, 0.62, 0.66, 0.7]);
          rrect(r.x + 42, ry - 4, Math.min(110, r.w - 60) * (0.55 + 0.4 * ((i * 37) % 10) / 10), 8, 4, [0.85, 0.86, 0.9, 0.55]);
        }
        break;
      }
      case 'chat': {
        rrect(r.x + 4, r.y + 4, r.w - 8, r.h - 8, 8, [0.07, 0.07, 0.08, 0.35]);
        const lines = Math.max(1, Math.floor((r.h - 50) / 22));
        for (let i = 0; i < lines; i++) rrect(r.x + 16, r.y + 16 + i * 22, (r.w - 32) * (0.4 + 0.5 * (((i * 53) % 10) / 10)), 9, 4.5, [0.9, 0.9, 0.92, 0.45]);
        rrect(r.x + 10, r.y + r.h - 38, r.w - 20, 28, 8, [0.95, 0.95, 0.97, 0.28]);
        break;
      }
      case 'hotbar': {
        const slots = r.detail?.slots ?? 1;
        const icon = (r.w - (slots - 1) * 5) / slots;
        for (let i = 0; i < slots; i++) {
          const sx = r.x + i * (icon + 5);
          poly(roundedRect(sx, r.y, icon, icon), [31 / 255, 31 / 255, 31 / 255, 0.5]);
          const [px, py] = ap(view, sx + 4, r.y + 4);
          pixelText(c, String((i + 1) % 10), Math.round(px), Math.round(py), [1, 1, 1], Math.max(1, Math.round(scale * 1.5)));
        }
        break;
      }
      case 'backpack-open': {
        line(
          [
            [cx - 8, cy + 3],
            [cx, cy - 5],
            [cx + 8, cy + 3],
          ],
          2.5,
          ink,
        );
        break;
      }
      default:
        break;
    }
  }
}

/** A notched phone's notch and unsafe sides, a status bar and a home bar, faintly, as the player sees the device. */
export function drawDeviceFrame(c: Raster, dev: LabDevice, view: Mat, clip?: Rect): void {
  const bounds: Rect = clip ?? { x: 0, y: 0, w: c.w, h: c.h };
  const rect = (x: number, y: number, w: number, h: number, col: [number, number, number, number]) => {
    const m = fillMask([wound([ap(view, x, y), ap(view, x + w, y), ap(view, x + w, y + h), ap(view, x, y + h)], 1)], bounds);
    if (m) paint(c, m, col);
  };
  if (dev.side) {
    rect(0, 0, dev.side, dev.h, [0, 0, 0, 0.22]);
    rect(dev.w - dev.side, 0, dev.side, dev.h, [0, 0, 0, 0.22]);
    // The notch on the left in landscape.
    const m = fillMask([wound(roundedRect(0, dev.h / 2 - 80, 30, 160, [0, 15, 15, 0]).map(([x, y]) => ap(view, x, y)), 1)], bounds);
    if (m) paint(c, m, [0, 0, 0, 0.9]);
  }
  if (dev.top) rect(0, 0, dev.w, dev.top, [0, 0, 0, 0.3]);
  if (dev.bottom) {
    rect(0, dev.h - dev.bottom, dev.w, dev.bottom, [0, 0, 0, 0.18]);
    const pill = roundedRect(dev.w / 2 - 67, dev.h - dev.bottom / 2 - 2.5, 134, 5, [2.5, 2.5, 2.5, 2.5]).map(([x, y]) => ap(view, x, y));
    const m = fillMask([wound(pill, 1)], bounds);
    if (m) paint(c, m, [1, 1, 1, 0.6]);
  }
}

export interface LabRenderOptions extends Omit<UiRenderOptions, 'guides' | 'overlay'> {
  /** Roblox's UI to draw: regions given, or coreOverlays(device, core). */
  regions?: CoreRegion[];
  core?: CoreOptions;
  /** How to draw Roblox's UI (default controls: as in play). */
  roblox?: 'controls' | 'zones' | 'both' | 'none';
  /** Rectangles (points) outlined on top: the elements a finding names. */
  marks?: Array<{ x: number; y: number; w: number; h: number; color?: [number, number, number] }>;
}

/**
 * The game's screens on a lab device with Roblox's UI over them (renderUi with the device's own size and safe area;
 * DeviceSafeInsets screens laid out inside the safe area, see normalizeInsets), the notch and home bar shaded, and
 * the marked elements outlined in red.
 */
export function renderLab(screens: UiNode[], dev: LabDevice, o: LabRenderOptions = {}): UiRender & { unknown: string[]; regions: CoreRegion[] } {
  const regions = o.regions ?? coreOverlays(dev, o.core);
  const mode = o.roblox ?? 'controls';
  const { regions: _r, core: _c, roblox: _m, marks, ...rest } = o;
  const pic = renderUi(screens.map(normalizeInsets), dev, {
    ...rest,
    guides: false,
    overlay: (c, view, s, clip) => {
      drawDeviceFrame(c, dev, view, clip);
      if (mode === 'controls' || mode === 'both') drawCoreOverlays(c, regions, view, s, 'controls', clip);
      if (mode === 'zones' || mode === 'both') drawCoreOverlays(c, regions, view, s, 'zones', clip);
      for (const m of marks ?? []) {
        const pts = roundedRect(m.x, m.y, m.w, m.h).map(([x, y]) => ap(view, x, y));
        const band = fillMask(strokeOutline([pts], 1.25), clip);
        if (band) paint(c, band, [...(m.color ?? [1, 0.2, 0.25]), 1]);
      }
    },
  });
  return { ...pic, regions };
}

// ─── Keeping the formulas honest ───────────────────────────────────────────────────────────────────

/** Lines in Roblox's scripts the formulas above come from (relative to ExtraContent\scripts; the tokens file is under ExtraContent). */
export const CORE_SOURCES: ReadonlyArray<{ file: string; line: number; text: string; what: string }> = [
  { file: `${P}/TouchJump.lua`, line: 234, text: 'local minAxis = math.min(self.parentUIFrame.AbsoluteSize.x, self.parentUIFrame.AbsoluteSize.y)', what: 'jump: small screen is the touch frame’s shorter side' },
  { file: `${P}/TouchJump.lua`, line: 235, text: 'local isSmallScreen = minAxis <= 500', what: 'jump: small screen ≤ 500' },
  { file: `${P}/TouchJump.lua`, line: 251, text: 'local jumpButtonSize = isSmallScreen and 70 or 120', what: 'jump size' },
  { file: `${P}/TouchJump.lua`, line: 257, text: 'UDim2.new(1, -(jumpButtonSize*1.5-10), 1, -jumpButtonSize - 20)', what: 'jump position, small screen' },
  { file: `${P}/TouchJump.lua`, line: 258, text: 'UDim2.new(1, -(jumpButtonSize*1.5-10), 1, -jumpButtonSize * 1.75)', what: 'jump position, big screen' },
  { file: `${P}/DynamicThumbstick.lua`, line: 29, text: 'local SAFE_AREA_INSET_MAX = 100', what: 'thumbstick frame overhang' },
  { file: `${P}/DynamicThumbstick.lua`, line: 453, text: 'self.thumbstickFrame.Size = UDim2.new(1, safeInset, 0.4, safeInset)', what: 'thumbstick area, portrait' },
  { file: `${P}/DynamicThumbstick.lua`, line: 454, text: 'self.thumbstickFrame.Position = UDim2.new(0, -safeInset, 0.6, 0)', what: 'thumbstick area, portrait' },
  { file: `${P}/DynamicThumbstick.lua`, line: 456, text: 'self.thumbstickFrame.Size = UDim2.new(0.4, safeInset, 2/3, safeInset)', what: 'thumbstick area, landscape' },
  { file: `${P}/DynamicThumbstick.lua`, line: 457, text: 'self.thumbstickFrame.Position = UDim2.new(0, -safeInset, 1/3, 0)', what: 'thumbstick area, landscape' },
  { file: `${P}/DynamicThumbstick.lua`, line: 477, text: 'self.thumbstickButton.Size = UDim2.new(1, 0, 1, 0)', what: 'the stick’s touch button fills the area' },
  { file: `${P}/DynamicThumbstick.lua`, line: 126, text: 'touchBinding.UIModifier = self.thumbstickButton', what: 'touches reach the stick through that button' },
  { file: `${P}/DynamicThumbstick.lua`, line: 595, text: 'local isBigScreen = math.min(screenSize.X, screenSize.Y) > 500', what: 'thumbstick: big screen > 500' },
  { file: `${P}/DynamicThumbstick.lua`, line: 598, text: 'local DEFAULT_RING_SIZE = 20', what: 'ring size' },
  { file: `${P}/DynamicThumbstick.lua`, line: 599, text: 'local DEFAULT_OUTER_RING_SIZE = 74', what: 'outer ring' },
  { file: `${P}/DynamicThumbstick.lua`, line: 605, text: 'local scaleFactor = isBigScreen and 2 or 1', what: 'scale on big screens' },
  { file: `${P}/DynamicThumbstick.lua`, line: 629, text: 'self.startImage.Position = UDim2.new(0, self.thumbstickRingSize * 3.3 + safeInset, 1, -self.thumbstickRingSize * 2.8 - safeInset)', what: 'resting ring position' },
  { file: `${P}/DynamicThumbstick.lua`, line: 657, text: 'local portraitMode = size.X < size.Y', what: 'portrait from the viewport' },
  { file: `${P}/ClassicThumbstick.lua`, line: 200, text: 'self.thumbstickSize = isSmallScreen and 70 or 120', what: 'classic thumbstick size' },
  { file: `${P}/ClassicThumbstick.lua`, line: 201, text: 'UDim2.new(0, (self.thumbstickSize/2) - 10, 1, -self.thumbstickSize - 20)', what: 'classic thumbstick position' },
  { file: `${P}/init.lua`, line: 91, text: '[Enum.TouchMovementMode.Default] = DynamicThumbstick,', what: 'default touch movement' },
  { file: `${P}/init.lua`, line: 811, text: 'GuiService.TouchControlsEnabled', what: 'TouchGui shown with TouchControlsEnabled and touch input' },
  { file: `${P}/init.lua`, line: 900, text: 'self.touchGui.ClipToDeviceSafeArea = false', what: 'TouchGui not clipped' },
  { file: `${P}/init.lua`, line: 904, text: 'self.touchControlFrame.Size = UDim2.new(1, 0, 1, 0)', what: 'touch frame fills TouchGui' },
  { file: `${C}/TopBar/Constants.lua`, line: 22, text: 'local scale = if TenFootInterface:IsEnabled() then 1.5 else 1', what: 'top bar ×1.5 on a 10-foot interface' },
  { file: `${C}/TopBar/Constants.lua`, line: 29, text: 'local DEFAULT_CHROME_TOPBAR_HEIGHT = if ChromeEnabled() then withUIScale(58) else 58', what: 'top bar height' },
  { file: `${C}/TopBar/Constants.lua`, line: 30, text: 'StyleTokens.Size.Size_1100', what: 'top bar button height' },
  { file: `${C}/TopBar/Constants.lua`, line: 46, text: 'local screenSideOffset = if ChromeEnabled() then StyleTokens.Gap.Large else 16', what: 'top bar side offset' },
  { file: `${C}/TopBar/Constants.lua`, line: 47, text: 'local topBarPadding = if ChromeEnabled() then StyleTokens.Padding.Small else 12', what: 'top bar padding' },
  { file: `${C}/TopBar/Constants.lua`, line: 84, text: 'PaddingLeft = screenSideOffset + topBarPadding + (if isSideSheetEnabled then 0 else topbarHeight)', what: 'unibar left padding' },
  { file: `${C}/TopBar/init.lua`, line: 88, text: 'Constants.ApplyDisplayScale(Constants.TopBarHeight),', what: 'GuiInset top = top bar height' },
  { file: `${C}/TopBar/Components/TopBarApp.lua`, line: 791, text: 'IgnoreGuiInset = true,', what: 'top bar ScreenGui' },
  { file: `${C}/TopBar/Components/TopBarApp.lua`, line: 855, text: 'MenuIconHolder = if not isSideSheetEnabled', what: 'menu button at the top left' },
  { file: `${C}/TopBar/Components/Presentation/IconButton.lua`, line: 153, text: 'Size = UDim2.fromOffset(backgroundSize, backgroundSize),', what: 'round button 44' },
  { file: `${C}/Chrome/ChromeShared/Unibar/Constants.lua`, line: 40, text: 'ICON_CELL_WIDTH = StyleTokens.Size.Size_1100,', what: 'unibar icon cell' },
  { file: `${C}/Chrome/ChromeShared/Unibar/Constants.lua`, line: 50, text: 'UNIBAR_END_PADDING = StyleTokens.Padding.XSmall,', what: 'unibar end padding' },
  { file: `${C}/Chrome/ChromeShared/Unibar/UnibarMenu.lua`, line: 545, text: 'expandSize = unibarEndPadding * 2 + xOffset', what: 'unibar width' },
  { file: `${C}/Chrome/ConfigureChrome.lua`, line: 40, text: 'local v4Ordering = { "nine_dot", "chat", "toggle_mic_mute" }', what: 'unibar items' },
  { file: `${C}/Chrome/ChromeShared/Service/ChromeService.lua`, line: 284, text: 'ObservableValue.new(Enum.HorizontalAlignment.Left)', what: 'unibar on the left' },
  { file: `${C}/Chrome/ChromeShared/Service/KeepOutAreasHandler.lua`, line: 120, text: 'GuiService:SetTopbarInset(topbarInset)', what: 'TopbarInset' },
  { file: `${C}/PlayerList/PlayerListInitialVisibleState.lua`, line: 63, text: 'return not isSmallTouchScreen(input)', what: 'player list hidden at start on small touch screens' },
  { file: `${C}/Settings/Utility.lua`, line: 254, text: 'return UserInputService.TouchEnabled and (viewportSize.Y < 500 or viewportSize.X < 700)', what: 'small touch screen' },
  { file: `${C}/Chrome/Integrations/ExpChat/ChatChromeIntegration.lua`, line: 85, text: 'isSmallTouchScreen is applied later', what: 'chat hidden at start on small touch screens' },
  { file: `${C}/Server/ClientChat/DefaultClientChatModules/ChatSettings.lua`, line: 62, text: 'module.DefaultWindowSizeDesktop = UDim2.new(0.3, 0, 0.25, extraOffset)', what: 'legacy chat size' },
  { file: `${C}/BackpackScript.lua`, line: 55, text: 'local ICON_SIZE = 60', what: 'hotbar slot' },
  { file: `${C}/BackpackScript.lua`, line: 86, text: 'local HOTBAR_SLOTS_MINI = 3', what: 'phone hotbar slots' },
  { file: `${C}/BackpackScript.lua`, line: 87, text: 'local HOTBAR_SLOTS_WIDTH_CUTOFF = 1024', what: 'phone hotbar below 1024' },
  { file: `${C}/BackpackScript.lua`, line: 296, text: 'HotbarFrame.Position = UDim2.new(0.5, -HotbarFrame.Size.X.Offset / 2, 1, -HotbarFrame.Size.Y.Offset)', what: 'hotbar at the bottom centre' },
  { file: `${C}/BackpackScript.lua`, line: 274, text: 'OpenInventoryButton.Position = UDim2.new(0.5, -15, 1, hotbarIsVisible and -110 or -50)', what: 'backpack button' },
  { file: '../LuaPackages/Packages/_Index/RbxDesignFoundations-31ab8d40-4.0.11/RbxDesignFoundations/Default/Dark.lua', line: 1599, text: 'Size_1100 = 44 * scale,', what: 'token Size_1100 = 44' },
  { file: '../LuaPackages/Packages/_Index/RbxDesignFoundations-31ab8d40-4.0.11/RbxDesignFoundations/Default/Dark.lua', line: 1022, text: 'Large = 16 * scale,', what: 'token Gap.Large = 16' },
  { file: '../LuaPackages/Packages/_Index/RbxDesignFoundations-31ab8d40-4.0.11/RbxDesignFoundations/Default/Dark.lua', line: 1379, text: 'Small = 8 * scale,', what: 'token Padding.Small = 8' },
];

/**
 * Re-reads CORE_SOURCES in a Studio install's scripts folder: ok (the line says it), moved (found elsewhere in the
 * file: the citation's line number is stale) or changed (gone: Roblox changed the formula; the overlays may be wrong).
 */
export function checkCoreScripts(scriptsDir: string): Array<{ file: string; line: number; what: string; status: 'ok' | 'moved' | 'changed' | 'missing'; foundAt?: number }> {
  const cache = new Map<string, string[] | null>();
  return CORE_SOURCES.map((s) => {
    if (!cache.has(s.file)) {
      try {
        cache.set(s.file, readFileSync(join(scriptsDir, s.file), 'utf8').split(/\r?\n/));
      } catch {
        cache.set(s.file, null);
      }
    }
    const lines = cache.get(s.file);
    if (!lines) return { file: s.file, line: s.line, what: s.what, status: 'missing' as const };
    if (lines[s.line - 1]?.includes(s.text)) return { file: s.file, line: s.line, what: s.what, status: 'ok' as const };
    const i = lines.findIndex((l) => l.includes(s.text));
    return i >= 0 ? { file: s.file, line: s.line, what: s.what, status: 'moved' as const, foundAt: i + 1 } : { file: s.file, line: s.line, what: s.what, status: 'changed' as const };
  });
}
