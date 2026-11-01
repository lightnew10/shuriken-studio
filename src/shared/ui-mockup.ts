import { auditUi, estimateText, layoutScreen, TOPBAR, UI_DEVICES, UI_STATES, type Measure, type RGB, type UiBox, type UiDevice, type UiFinding, type UiGradient, type UiNode, type UiScreen, type UiStateName, type UiStatePatch, type UiStroke } from './ui-layout';

/**
 * UI mockups: designs tried out in Shuriken before anything goes into the game. A mockup's screens are
 * GuiObjects in the layout engine's own terms (UiNode: UDim2 size and position, AnchorPoint, ZIndex, fonts,
 * UICorner/UIStroke/UIGradient/UIPadding, list/grid/page layouts, flex, size constraints, UIScale), so the
 * UI page draws it and the audit checks it exactly as ui_audit lays out the real game, and the kits (skills
 * roblox-ui-design and roblox-game-hud) can build the same screen without a redesign. Colours may be hex or
 * theme tokens ("$accent"). A ScreenGui made by a kit says so (`kit`), and its UIScale and insets are the
 * kit's. A screen may have its own layout per device form, the forms the kits' Ui.onDevice/Hud.onDevice
 * build for (phone, a portrait phone, tablet, desktop, TV). Versions (A, B, C…) keep every try; motion names
 * the Motion module's moves (skill roblox-ui-motion), and the preview plays the ones it can.
 */

/** The layouts a screen can have: the kits' device forms, and a portrait phone. */
export type MockForm = 'phone' | 'phonePortrait' | 'tablet' | 'desktop' | 'tv';
export const MOCK_FORMS: MockForm[] = ['phone', 'phonePortrait', 'tablet', 'desktop', 'tv'];
/** Where a form without its own layout looks next (then the screen's default children). */
const FORM_FALLBACK: Record<MockForm, MockForm[]> = { phone: ['phone'], phonePortrait: ['phonePortrait', 'phone'], tablet: ['tablet'], desktop: ['desktop'], tv: ['tv', 'desktop'] };

/** The devices a mockup is shown and audited on: a phone both ways up, a tablet, a desktop and a TV. */
export const MOCK_DEVICES: UiDevice[] = ['phone', 'phonePortrait', 'tablet', 'desktop', 'tv'];

/** [r, g, b] (0-255), "#rrggbb", or a theme token ("$accent"). */
export type MockColor = RGB | string;

type ColorKey = 'bg' | 'borderColor' | 'textColor' | 'strokeColor' | 'imageColor';
export interface MockGradient {
  rot?: number;
  colors?: Array<[number, number, number, number] | [number, MockColor]>;
  transp?: Array<[number, number]>;
  offset?: [number, number];
  type?: 'Linear' | 'Radial' | 'Conical';
}
export interface MockStroke {
  color: MockColor;
  t?: number;
  px?: number;
  text?: boolean;
  pos?: 'Outer' | 'Center' | 'Inner';
  z?: number;
  gradient?: MockGradient;
}
export interface MockShadow {
  color?: MockColor;
  t?: number;
  blur?: number;
  spread?: number;
  offset?: [number, number];
}
/** A notification badge or ribbon on an element: built as a child named "Badge" (the kit's Ui.badge makes the same). */
export interface MockBadge {
  text?: string;
  style?: 'pill' | 'ribbon' | 'dot';
  color?: MockColor;
  textColor?: MockColor;
  at?: 'tr' | 'tl' | 'br' | 'bl' | 'top';
  size?: number;
}
export type MockStatePatch = { skin?: string; bg?: MockColor; bgT?: number; textColor?: MockColor; textT?: number; imageColor?: MockColor; imageT?: number; rot?: number; scale?: number; stroke?: MockStroke | MockStroke[]; gradient?: MockGradient; shadow?: MockShadow };
/** How an element arrives when its screen opens: a direction (Motion.enter), or that with a delay. */
export type MockAppear = 'up' | 'down' | 'left' | 'right' | 'pop' | 'fade' | { from?: 'up' | 'down' | 'left' | 'right' | 'pop' | 'fade'; delay?: number; amount?: number };

/** One GuiObject (or the ScreenGui) of a mockup: a UiNode whose ids are optional and whose colours may be hex or tokens. */
export type MockNode = Omit<UiNode, 'id' | 'cls' | 'kids' | 'loops' | ColorKey | 'stroke' | 'strokes' | 'gradient' | 'shadow' | 'states'> & {
  /** The class (Frame, TextLabel…); a top-level screen is a ScreenGui and may leave it out. */
  cls?: string;
  id?: number;
  kids?: MockNode[];
  bg?: MockColor;
  borderColor?: MockColor;
  textColor?: MockColor;
  strokeColor?: MockColor;
  imageColor?: MockColor;
  /** One UIStroke, or several (layered by z). */
  stroke?: MockStroke | MockStroke[];
  gradient?: MockGradient;
  shadow?: MockShadow;
  badge?: MockBadge;
  states?: Partial<Record<UiStateName, MockStatePatch>>;
  appear?: MockAppear;
  /** ScreenGui: made by a kit (Ui.screen or Hud.screen), whose UIScale fit and insets it gets. */
  kit?: 'ui' | 'hud';
  /** ScreenGui: a layout per device form, replacing (kids) or patching (set) the default children. */
  forms?: Partial<Record<MockForm, MockFormLayout>>;
  /** What the element is for (where its data comes from, what a script does with it). */
  note?: string;
};

/** Changes to an element: properties to merge in (one level deep into objects such as list or stroke). */
export type MockPatch = Record<string, unknown>;

/** A screen's layout on one device form: its own children, or changes to the default ones (paths below the screen, e.g. "Window.Grid"; null removes). */
export interface MockFormLayout {
  kids?: MockNode[];
  set?: Record<string, MockPatch | null>;
}

export const MOTION_KINDS = ['open', 'close', 'enter', 'pulse', 'float', 'spin', 'shimmer', 'punch', 'shake', 'count', 'transition', 'swap', 'fly', 'flipbook', 'keyframes'] as const;
export type MotionKind = (typeof MOTION_KINDS)[number];
/** The moves the preview plays; the others are described but only play in the game. */
export const PREVIEWED_MOTION: ReadonlySet<MotionKind> = new Set<MotionKind>(['open', 'close', 'enter', 'pulse', 'float', 'spin', 'shimmer', 'punch', 'shake', 'count', 'transition']);

/** A move of the Motion module on an element (or the whole screen, for a transition). */
export interface MockMotion {
  play: MotionKind;
  /** The element ("Shop.Window"); for enter on a container with a list or grid, its children enter one after another. */
  target?: string;
  /** When it plays: "open" (as the screen opens: the default), "loop" (ambient), or the game's moment ("coins change", "press"). */
  when?: string;
  /** enter: "up" (default), "down", "left", "right", "pop", "fade"; count: the number it starts from. */
  from?: string | number;
  /** count: the number it ends on; fly: the element the icons fly into. */
  to?: string | number;
  delay?: number;
  /** enter: seconds between items (default 0.035). */
  gap?: number;
  /** Duration (count, transition each way), cycle (pulse, float), seconds per turn (spin), pause between sweeps (shimmer). */
  seconds?: number;
  /** pulse: scale gain (0.06); float: pixels (6); punch: scale (0.12); shake: degrees (5); enter: pixels a slide travels (24). */
  amount?: number;
  /** transition: "fade" (default), "wipe", "iris". */
  style?: string;
  note?: string;
}

export interface MockVersion {
  /** "A", "B", … in the order they were made. */
  id: string;
  /** A short name ("Bottom sheet"). */
  label?: string;
  /** What this version tries, in a sentence. */
  note: string;
  /** The version it was made from. */
  from?: string;
  /** Colour tokens the screens use as "$name" (the kit's Ui.theme / Hud.theme names read best). */
  theme?: Record<string, MockColor>;
  screens: MockNode[];
  motion?: MockMotion[];
  createdAt: string;
  /** Who made it: the UI copilot, an agent role, or the user. */
  by?: string;
  /** Its revision: a fix made in place keeps the letter and counts up (absent: 1). */
  rev?: number;
  revisedAt?: string;
  /** Superseded: kept, but out of the way (the UI page hides it unless asked; lists say so). */
  retired?: boolean;
  /** Earlier revisions of this letter, newest last (a few, to go back to). */
  history?: Array<{ rev: number; note: string; at: string; theme?: Record<string, MockColor>; screens: MockNode[]; motion?: MockMotion[] }>;
}

export interface Mockup {
  /** Its id in files and links: lower-case words joined by dashes ("sword-shop"). */
  name: string;
  title: string;
  /** What it is for. */
  brief?: string;
  versions: MockVersion[];
  /** The version the user picked. */
  chosen?: string;
  /** The version that was built into the game, and when (with its revision, when it had been fixed). */
  applied?: { version: string; at: string; rev?: number; files?: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface MockupSummary {
  name: string;
  title: string;
  brief?: string;
  versions: Array<{ id: string; label?: string; note: string; createdAt: string; by?: string; rev?: number; retired?: boolean }>;
  chosen?: string;
  applied?: Mockup['applied'];
  updatedAt: string;
}

export const summarizeMockup = (m: Mockup): MockupSummary => ({
  name: m.name,
  title: m.title,
  ...(m.brief ? { brief: m.brief } : {}),
  versions: m.versions.map((v) => ({ id: v.id, ...(v.label ? { label: v.label } : {}), note: v.note, createdAt: v.createdAt, ...(v.by ? { by: v.by } : {}), ...(v.rev && v.rev > 1 ? { rev: v.rev } : {}), ...(v.retired ? { retired: true } : {}) })),
  ...(m.chosen ? { chosen: m.chosen } : {}),
  ...(m.applied ? { applied: m.applied } : {}),
  updatedAt: m.updatedAt,
});

/** The version to show: the one the user picked, else the newest that isn't retired (else the newest). */
export function currentVersion(m: Mockup): MockVersion | undefined {
  return m.versions.find((v) => v.id === m.chosen) ?? [...m.versions].reverse().find((v) => !v.retired) ?? m.versions[m.versions.length - 1];
}

/** "C" or "C·2" (its second revision). */
export const versionLabel = (v: { id: string; rev?: number }): string => (v.rev && v.rev > 1 ? `${v.id}·${v.rev}` : v.id);

/** A, B, … Z, AA, AB, …: the next id after the ones in use. */
export function nextVersionId(ids: readonly string[]): string {
  const num = (id: string) => [...id].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  const top = Math.max(0, ...ids.filter((id) => /^[A-Z]+$/.test(id)).map(num));
  let n = top + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A mockup's name from its title: lower-case words joined by dashes. */
export const mockupName = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'mockup';

// ─── The format ───────────────────────────────────────────────────────────────────────────────────

/**
 * The whole mockup format in a few lines: the tools carry it in their descriptions (which an MCP client may cut
 * at 2,048 characters, so it stays this short) and say it again with every refusal. Nothing outside it is saved.
 */
export const MOCK_FORMAT = `FORMAT (else is refused). colour [r,g,b]|"#rrggbb"|"$token"; UDim [scale,offset]; UDim2 [xs,xo,ys,yo]; *T transparency 0-1; sizes in points.
Screen {name, kit ui|hud, displayOrder, insets, ignoreInset, enabled, global, hides "chat playerList touch", fit, scale, kids, forms {phone|phonePortrait|tablet|desktop|tv: {kids}|{set {"Path.Below.Screen": props|null}}}}
Element {name, cls Frame|TextLabel|TextButton|TextBox|ImageLabel|ImageButton|ScrollingFrame|CanvasGroup, note, kids, size, pos, anchor [x,y], rot, z, order, visible, clips, auto X|Y|XY, canvas, bg, bgT, border, borderColor, corner UDim, corners [tl,tr,br,bl], padding [t,r,b,l]|px, gradient G, stroke S|[S], shadow {color,t,blur,spread,offset}, shape {cut [tl,tr,br,bl], slant [l,r]}, badge {text,style pill|ribbon|dot,color,at tr|tl|br|bl|top,size}, skin "dir:kind:var", state selected|disabled (start), states {hover|press|selected|disabled: {skin,bg,bgT,textColor,textT,imageColor,imageT,rot,scale,stroke,gradient,shadow}}, appear up|down|left|right|pop|fade|{from,delay,amount}}
Text only: text, textColor, textT, textSize, font, bold, italic, xAlign, yAlign, scaled, wrapped, truncate, rich, lineHeight, textMin, textMax, strokeColor, strokeT. Image only: image "rbxassetid://id"|"icon:Name"|"glyph:name", imageColor, imageT, scaleType, slice.
G {type Linear|Radial|Conical, rot, colors [[0,c]..[1,c]], transp [[0,t]..[1,t]], offset}. S {color, t, px, text, pos Outer|Center|Inner, z, gradient G}.
list {dir, h, v, pad, hFlex, vFlex, wraps, itemAlign, byName}, grid {cell, pad, dir, h, v, max, byName}, pages {current, byName}, flex {mode, grow, shrink, align}, aspect {ratio, scaleWithParent, heightDominant}, sizeMin, sizeMax, scale.
motion [{play open|close|enter|pulse|float|spin|shimmer|punch|shake|count|transition|swap|fly|flipbook|keyframes, target, when, from, to, delay, gap, seconds, amount, style, note}]`;

// ─── Checking what the copilot wrote ──────────────────────────────────────────────────────────────

const CLASSES = new Set(['Frame', 'TextLabel', 'TextButton', 'TextBox', 'ImageLabel', 'ImageButton', 'ScrollingFrame', 'CanvasGroup', 'ViewportFrame', 'VideoFrame']);
const TEXT_CLASSES = new Set(['TextLabel', 'TextButton', 'TextBox']);
const IMAGE_CLASSES = new Set(['ImageLabel', 'ImageButton']);

type Spec = 'num' | 'unit' | 'pos' | 'bool' | 'str' | 'udim2' | 'udim' | 'vec2' | 'num4' | 'color' | 'padding' | 'corners' | 'stops' | 'tstops' | 'image' | 'strokes' | 'states' | 'appear' | readonly string[] | { obj: Record<string, Spec>; need?: string[] };
const ALIGN_H = ['Left', 'Center', 'Right'] as const;
const ALIGN_V = ['Top', 'Center', 'Bottom'] as const;
const ITEM_ALIGN = ['Automatic', 'Start', 'Center', 'End', 'Stretch'] as const;
const FLEX = ['Fill', 'SpaceAround', 'SpaceBetween', 'SpaceEvenly'] as const;
const DIRECTIONS = ['up', 'down', 'left', 'right', 'pop', 'fade'] as const;
const GRADIENT: Spec = { obj: { type: ['Linear', 'Radial', 'Conical'], rot: 'num', colors: 'stops', transp: 'tstops', offset: 'vec2' } };
const STROKE: Spec = { obj: { color: 'color', t: 'unit', px: 'pos', text: 'bool', pos: ['Outer', 'Center', 'Inner'], z: 'num', gradient: GRADIENT }, need: ['color'] };
const SHADOW: Spec = { obj: { color: 'color', t: 'unit', blur: 'pos', spread: 'num', offset: 'vec2' } };
/** What a state may change (a UIScale's scale, and what the element draws). */
const STATE_PATCH: Record<string, Spec> = { skin: 'str', bg: 'color', bgT: 'unit', textColor: 'color', textT: 'unit', imageColor: 'color', imageT: 'unit', rot: 'num', scale: 'pos', stroke: 'strokes', gradient: GRADIENT, shadow: SHADOW };
/** Every property a mockup node may have, and its shape (the layout engine's names: see UiNode). */
const NODE_SPEC: Record<string, Spec> = {
  name: 'str',
  cls: 'str',
  note: 'str',
  visible: 'bool',
  pos: 'udim2',
  size: 'udim2',
  anchor: 'vec2',
  rot: 'num',
  z: 'num',
  order: 'num',
  bg: 'color',
  bgT: 'unit',
  border: 'num',
  borderColor: 'color',
  clips: 'bool',
  auto: ['X', 'Y', 'XY'],
  text: 'str',
  textColor: 'color',
  textT: 'unit',
  textSize: 'pos',
  scaled: 'bool',
  wrapped: 'bool',
  truncate: 'bool',
  lineHeight: 'pos',
  font: 'str',
  bold: 'bool',
  italic: 'bool',
  xAlign: ALIGN_H,
  yAlign: ALIGN_V,
  strokeT: 'unit',
  strokeColor: 'color',
  rich: 'bool',
  image: 'image',
  imageColor: 'color',
  imageT: 'unit',
  scaleType: ['Stretch', 'Fit', 'Crop', 'Slice', 'Tile'],
  slice: 'num4',
  canvas: 'udim2',
  enabled: 'bool',
  ignoreInset: 'bool',
  insets: ['None', 'DeviceSafeInsets', 'CoreUISafeInsets', 'TopbarSafeInsets'],
  displayOrder: 'num',
  global: 'bool',
  hides: 'str',
  corner: 'udim',
  corners: 'corners',
  stroke: 'strokes',
  gradient: GRADIENT,
  shadow: SHADOW,
  shape: { obj: { cut: 'num4', slant: 'vec2' } },
  skin: 'str',
  badge: { obj: { text: 'str', style: ['pill', 'ribbon', 'dot'], color: 'color', textColor: 'color', at: ['tr', 'tl', 'br', 'bl', 'top'], size: 'pos' } },
  states: 'states',
  state: ['selected', 'disabled'],
  appear: 'appear',
  padding: 'padding',
  list: { obj: { dir: ['Horizontal', 'Vertical'], h: ALIGN_H, v: ALIGN_V, pad: 'udim', byName: 'bool', hFlex: FLEX, vFlex: FLEX, wraps: 'bool', itemAlign: ITEM_ALIGN } },
  grid: { obj: { cell: 'udim2', pad: 'udim2', dir: ['Horizontal', 'Vertical'], h: ALIGN_H, v: ALIGN_V, byName: 'bool', max: 'num' } },
  pages: { obj: { byName: 'bool', current: 'str' } },
  flex: { obj: { mode: ['None', 'Grow', 'Shrink', 'Fill', 'Custom'], grow: 'num', shrink: 'num', align: ITEM_ALIGN } },
  aspect: { obj: { ratio: 'pos', scaleWithParent: 'bool', heightDominant: 'bool' } },
  sizeMin: 'vec2',
  sizeMax: 'vec2',
  textMin: 'pos',
  textMax: 'pos',
  scale: 'pos',
  fit: { obj: { ref: 'vec2', min: 'pos', max: 'pos', tenFoot: 'pos' } },
};
/** The node properties the format knows (tests hold the format text to them). */
export const MOCK_NODE_KEYS = [...Object.keys(NODE_SPEC), 'kit', 'forms'];
/** Only on the ScreenGui. */
const SCREEN_ONLY = new Set(['enabled', 'ignoreInset', 'insets', 'displayOrder', 'global', 'fit']);
const TEXT_KEYS = ['text', 'textColor', 'textT', 'textSize', 'scaled', 'wrapped', 'truncate', 'lineHeight', 'font', 'bold', 'italic', 'xAlign', 'yAlign', 'rich', 'textMin', 'textMax', 'strokeColor', 'strokeT'];
const IMAGE_KEYS = ['image', 'imageColor', 'imageT', 'scaleType', 'slice'];
/** Properties written the way Roblox names them, mapped to the mockup's names (for a helpful error). */
const ROBLOX_NAMES: Record<string, string> = {
  Size: 'size', Position: 'pos', AnchorPoint: 'anchor', ZIndex: 'z', LayoutOrder: 'order', BackgroundColor3: 'bg', BackgroundTransparency: 'bgT', BorderSizePixel: 'border', BorderColor3: 'borderColor', Text: 'text', TextColor3: 'textColor', TextTransparency: 'textT', TextSize: 'textSize', TextScaled: 'scaled', TextWrapped: 'wrapped', Font: 'font', FontFace: 'font', Image: 'image', ImageColor3: 'imageColor', ImageTransparency: 'imageT', SliceCenter: 'slice', Visible: 'visible', Rotation: 'rot', ClipsDescendants: 'clips', AutomaticSize: 'auto', ClassName: 'cls', class: 'cls', className: 'cls', type: 'cls', Name: 'name', children: 'kids', Children: 'kids', UICorner: 'corner', CornerRadius: 'corner', UIStroke: 'stroke', strokes: 'stroke', UIGradient: 'gradient', UIShadow: 'shadow', glow: 'shadow (a glow is a shadow with offset [0, 0]) or a wide faint stroke', UIPadding: 'padding', UIListLayout: 'list', UIGridLayout: 'grid', UIPageLayout: 'pages', UIFlexItem: 'flex', UIAspectRatioConstraint: 'aspect', UISizeConstraint: 'sizeMin / sizeMax', UITextSizeConstraint: 'textMin / textMax', UIScale: 'scale', DisplayOrder: 'displayOrder', ScreenInsets: 'insets', IgnoreGuiInset: 'ignoreInset', CanvasSize: 'canvas', TextXAlignment: 'xAlign', TextYAlignment: 'yAlign', RichText: 'rich', ScaleType: 'scaleType', TextTruncate: 'truncate', LineHeight: 'lineHeight', TextStrokeColor3: 'strokeColor', TextStrokeTransparency: 'strokeT', children_: 'kids', hover: 'states: {hover: {...}}', press: 'states: {press: {...}}', pressed: 'states: {press: {...}}', selected: 'states: {selected: {...}}', disabled: 'states: {disabled: {...}}', layout: 'list or grid', transparency: 'bgT, textT or imageT', color: 'bg, textColor or imageColor (stroke, shadow and badge have their own color)', opacity: 'bgT (transparency: 0 opaque, 1 invisible)', icon: 'image: "icon:<Name>" or "glyph:<name>"', layouts: 'forms (on the ScreenGui)', motion: 'the version\'s motion list', animation: 'the version\'s motion list, or appear',
};
/** Fields that belong inside one of a node's objects, written on the node itself. */
const BELONGS: Record<string, string> = {
  dir: 'list or grid', h: 'list or grid', v: 'list or grid', pad: 'list or grid', hFlex: 'list', vFlex: 'list', wraps: 'list', itemAlign: 'list', cell: 'grid', max: 'grid', current: 'pages', mode: 'flex', grow: 'flex', shrink: 'flex', align: 'flex', ratio: 'aspect', colors: 'gradient', transp: 'gradient', px: 'stroke', blur: 'shadow', spread: 'shadow', offset: 'shadow or gradient', cut: 'shape', slant: 'shape', ref: 'fit', style: 'badge', at: 'badge',
};

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const nums = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every(isNum);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const HEX = /^#[0-9a-f]{6}$/i;
const TOKEN = /^\$[A-Za-z_][\w-]*$/;
/** An image a mockup may show: an uploaded image, a built-in texture, an icon made with ui_icon, or a line-art glyph (made into an icon when it is built). */
const IMAGE_REF = /^(?:rbxassetid:\/\/\d+|rbxasset:\/\/\S+|rbxthumb:\/\/\S+|https?:\/\/(?:www\.)?roblox\.com\/asset\/?\?id=\d+\S*|icon:[A-Za-z][A-Za-z0-9_]{0,31}|glyph:[a-z0-9-]+)$/;

export interface MockCheck {
  /** What must change before the mockup is saved. */
  errors: string[];
  /** What is saved but worth knowing (a move on an element only one layout has, …). */
  warnings: string[];
}

/** What the project has, for the references a mockup makes (icons it made, glyphs that exist); absent: not checked. */
export interface MockKnows {
  icon?: (name: string) => boolean;
  glyph?: (name: string) => boolean;
  /** Close glyph names, for an error that helps. */
  glyphsLike?: (name: string) => string[];
  /** Images only the caller can draw (the Storefront's "shot:<name>" and "art:<file>"): accepted as image refs. */
  localImage?: (ref: string) => boolean;
}

interface CheckCtx {
  theme: Record<string, MockColor> | undefined;
  out: MockCheck;
  knows: MockKnows;
}

function checkStops(v: unknown, at: string, ctx: CheckCtx, colors: boolean): void {
  const bad = (what: string): void => void ctx.out.errors.push(`${at}: ${what}`);
  if (!Array.isArray(v) || !v.length) return bad(colors ? 'a list of colour keys: [time, "#rrggbb"] or [time, r, g, b]' : 'a list of [time, transparency]');
  const times: number[] = [];
  v.forEach((s, i) => {
    if (colors) {
      if (Array.isArray(s) && s.length === 4 && s.every(isNum)) times.push(s[0] as number);
      else if (Array.isArray(s) && s.length === 2 && isNum(s[0])) {
        times.push(s[0]);
        checkColor(s[1], `${at}[${i}]`, ctx);
      } else bad(`key ${i} is not [time, "#rrggbb"] or [time, r, g, b]`);
    } else if (nums(s, 2)) {
      times.push((s as number[])[0]!);
      const t = (s as number[])[1]!;
      if (t < 0 || t > 1) bad(`key ${i}: transparency ${t} is outside 0 (opaque) to 1 (invisible)`);
    } else bad(`key ${i} is not [time, transparency]`);
  });
  if (times.length !== v.length) return;
  // Roblox's ColorSequence and NumberSequence refuse anything else.
  if (times[0] !== 0 || times[times.length - 1] !== 1) bad('keys start at time 0 and end at time 1 (Roblox refuses other sequences)');
  else if (times.some((t, i) => i > 0 && t < times[i - 1]!)) bad('key times go up from 0 to 1');
  if (v.length > 20) bad(`${v.length} keys: Roblox takes at most 20`);
}

const isEnum = (s: Spec): s is readonly string[] => Array.isArray(s);

function checkValue(spec: Spec, v: unknown, at: string, ctx: CheckCtx): void {
  const bad = (what: string): void => void ctx.out.errors.push(`${at}: ${what}`);
  if (isEnum(spec)) {
    if (typeof v !== 'string' || !spec.includes(v)) bad(`one of ${spec.join(', ')}${typeof v === 'string' ? ` (not "${v}")` : ''}`);
    return;
  }
  if (typeof spec === 'object') {
    if (!isObj(v)) return bad('an object');
    for (const [k, x] of Object.entries(v)) {
      const sub = spec.obj[k];
      if (!sub) bad(`unknown field "${k}" (fields: ${Object.keys(spec.obj).join(', ')})`);
      else if (x !== undefined && x !== null) checkValue(sub, x, `${at}.${k}`, ctx);
    }
    for (const k of spec.need ?? []) if (v[k] === undefined || v[k] === null) bad(`needs ${k}`);
    return;
  }
  switch (spec) {
    case 'num':
      if (!isNum(v)) bad('a number');
      return;
    case 'unit':
      if (!isNum(v)) bad('a number from 0 (opaque) to 1 (invisible)');
      else if (v < 0 || v > 1) bad(`${v} is outside 0 (opaque) to 1 (invisible)`);
      return;
    case 'pos':
      if (!isNum(v) || v < 0) bad('a number, 0 or more');
      return;
    case 'bool':
      if (typeof v !== 'boolean') bad('true or false');
      return;
    case 'str':
      if (typeof v !== 'string') bad('a string');
      return;
    case 'udim2':
      if (!nums(v, 4)) bad('[xScale, xOffset, yScale, yOffset]');
      return;
    case 'udim':
      if (!nums(v, 2)) bad('[scale, offset]');
      return;
    case 'vec2':
      if (!nums(v, 2)) bad('[x, y]');
      return;
    case 'num4':
      if (!nums(v, 4)) bad('four numbers');
      return;
    case 'padding':
      if (!Array.isArray(v) || v.length !== 4 || !v.every((p) => nums(p, 2))) bad('[top, right, bottom, left], each [scale, offset]');
      return;
    case 'corners':
      if (!Array.isArray(v) || v.length !== 4 || !v.every((p) => nums(p, 2))) bad('[topLeft, topRight, bottomRight, bottomLeft], each [scale, offset]');
      return;
    case 'color':
      checkColor(v, at, ctx);
      return;
    case 'stops':
      checkStops(v, at, ctx, true);
      return;
    case 'tstops':
      checkStops(v, at, ctx, false);
      return;
    case 'image': {
      if (typeof v !== 'string') return bad('a string');
      if (v === '') return;
      if (!IMAGE_REF.test(v) && !ctx.knows.localImage?.(v)) return bad(`"${v}" is not an image: "rbxassetid://<id>" (an uploaded image you know), "icon:<Name>" (made with ui_icon) or "glyph:<name>" (a line-art glyph, ui_icon {search})`);
      const icon = /^icon:(.+)$/.exec(v)?.[1];
      if (icon && ctx.knows.icon && !ctx.knows.icon(icon)) bad(`no icon "${icon}" in the project yet: make it first with ui_icon ({name: "${icon}", glyph} or {name, model}), or show a glyph ("glyph:<name>")`);
      const glyph = /^glyph:(.+)$/.exec(v)?.[1];
      if (glyph && ctx.knows.glyph && !ctx.knows.glyph(glyph)) {
        const like = ctx.knows.glyphsLike?.(glyph) ?? [];
        bad(`no glyph "${glyph}"${like.length ? ` (close: ${like.slice(0, 6).join(', ')})` : ''}: ui_icon {search} finds them`);
      }
      return;
    }
    case 'strokes': {
      const list = Array.isArray(v) ? v : [v];
      if (!list.length) return bad('a stroke {color, px, …} or a list of them');
      list.forEach((s, i) => checkValue(STROKE, s, Array.isArray(v) ? `${at}[${i}]` : at, ctx));
      if (list.filter((s) => isObj(s) && s.text === true).length > 1 && !list.every((s) => isObj(s) && isNum(s.z))) bad('several text strokes need a z each (which draws on top)');
      return;
    }
    case 'states': {
      if (!isObj(v)) return bad(`an object: {hover, press, selected, disabled}`);
      for (const [state, patch] of Object.entries(v)) {
        if (!(UI_STATES as string[]).includes(state)) {
          bad(`unknown state "${state}" (states: ${UI_STATES.join(', ')})`);
          continue;
        }
        if (!isObj(patch)) {
          bad(`${state}: an object of what changes`);
          continue;
        }
        for (const [k, x] of Object.entries(patch)) {
          const sub = STATE_PATCH[k];
          if (!sub) bad(`${state}: "${k}" can't change in a state (it may: ${Object.keys(STATE_PATCH).join(', ')}; layout stays put so nothing jumps)`);
          else if (x !== undefined && x !== null) checkValue(sub, x, `${at}.${state}.${k}`, ctx);
        }
      }
      return;
    }
    case 'appear': {
      if (typeof v === 'string') {
        if (!(DIRECTIONS as readonly string[]).includes(v)) bad(`one of ${DIRECTIONS.join(', ')}, or {from, delay, amount}`);
        return;
      }
      checkValue({ obj: { from: DIRECTIONS, delay: 'pos', amount: 'pos' } }, v, at, ctx);
      return;
    }
  }
}

function checkColor(v: unknown, at: string, ctx: Pick<CheckCtx, 'theme' | 'out'>): void {
  if (Array.isArray(v) && v.length === 3 && v.every((c) => isNum(c) && c >= 0 && c <= 255)) return;
  if (typeof v === 'string' && HEX.test(v)) return;
  if (typeof v === 'string' && TOKEN.test(v)) {
    if (!ctx.theme || !(v.slice(1) in ctx.theme)) ctx.out.errors.push(`${at}: the colour token ${v} is not in the version's theme${ctx.theme ? ` (tokens: ${Object.keys(ctx.theme).join(', ')})` : ''}`);
    return;
  }
  ctx.out.errors.push(`${at}: a colour: [r, g, b], "#rrggbb" or a theme token like "$accent"${typeof v === 'string' ? ` (not "${v}")` : ''}`);
}

function checkNode(n: unknown, path: string, screen: MockNode | null, ctx: CheckCtx): void {
  const out = ctx.out;
  if (!isObj(n)) {
    out.errors.push(`${path}: not an element object`);
    return;
  }
  const top = screen === null;
  const name = typeof n.name === 'string' && n.name.trim() ? n.name : null;
  const here = name ? path : `${path}(unnamed)`;
  if (!name) out.errors.push(`${here}: every element needs a name (paths, audits and the game comparison use names)`);
  else if (/[.@:]/.test(name)) out.errors.push(`${here}: a name can't contain ".", "@" or ":"`);
  const cls = n.cls ?? (top ? 'ScreenGui' : undefined);
  if (top && cls !== 'ScreenGui') out.errors.push(`${here}: a top-level screen is a ScreenGui (cls "ScreenGui")`);
  if (!top && (typeof cls !== 'string' || !CLASSES.has(cls))) out.errors.push(`${here}: cls must be one of ${[...CLASSES].join(', ')}${cls === 'ScreenGui' ? ' (a ScreenGui only at the top)' : ''}`);
  for (const [k, v] of Object.entries(n)) {
    if (v === undefined || v === null || k === 'id') continue;
    if (k === 'kids') continue;
    if (k === 'kit') {
      if (!top) out.errors.push(`${here}.kit: only a ScreenGui has a kit`);
      else if (v !== 'ui' && v !== 'hud') out.errors.push(`${here}.kit: "ui" (Ui.screen) or "hud" (Hud.screen)`);
      continue;
    }
    if (k === 'forms') {
      if (!top) out.errors.push(`${here}.forms: only a ScreenGui has layouts per device form (put forms on the screen, its set paths below it)`);
      else checkForms(v, here, n as MockNode, ctx);
      continue;
    }
    const spec = NODE_SPEC[k];
    if (!spec) {
      const hint = ROBLOX_NAMES[k] ? `a mockup calls it "${ROBLOX_NAMES[k]}"` : BELONGS[k] ? `it belongs inside ${BELONGS[k]} {…}` : null;
      out.errors.push(`${here}: unknown property "${k}"${hint ? ` (${hint})` : ''}`);
      continue;
    }
    if (!top && SCREEN_ONLY.has(k)) {
      out.errors.push(`${here}.${k}: a ScreenGui property; on a ${String(cls)} it does nothing (put it on the screen)`);
      continue;
    }
    checkValue(spec, v, `${here}.${k}`, ctx);
  }
  if (typeof cls === 'string' && !top) {
    const textKeys = TEXT_KEYS.filter((k) => n[k] !== undefined);
    if (textKeys.length && !TEXT_CLASSES.has(cls)) out.errors.push(`${here}: ${textKeys.join(', ')} on a ${cls} draws nothing: text is on a TextLabel, TextButton or TextBox (a child TextLabel, or change cls)`);
    const imageKeys = IMAGE_KEYS.filter((k) => n[k] !== undefined);
    if (imageKeys.length && !IMAGE_CLASSES.has(cls)) out.errors.push(`${here}: ${imageKeys.join(', ')} on a ${cls} draws nothing: images are on an ImageLabel or ImageButton (a child ImageLabel, or change cls)`);
    if (TEXT_CLASSES.has(cls) && n.text === undefined) out.warnings.push(`${here}: a ${cls} with no text`);
    if (n.shadow !== undefined && n.shape !== undefined) out.warnings.push(`${here}: UIShadow follows the box, not the shape: a glow round a shape is a wide, faint stroke`);
    if (n.badge !== undefined && Array.isArray(n.kids) && n.kids.some((c) => isObj(c) && c.name === 'Badge')) out.errors.push(`${here}: badge makes a child named "Badge", and it already has one`);
    if (n.shape !== undefined && (n.corner !== undefined || n.corners !== undefined)) out.errors.push(`${here}: a shape has its own corners (cut): leave corner/corners out`);
    if (n.shape !== undefined && (cls === 'ScrollingFrame' || cls === 'CanvasGroup' || cls === 'TextBox' || (TEXT_CLASSES.has(cls) && typeof n.text === 'string' && n.text !== '') || (IMAGE_CLASSES.has(cls) && typeof n.image === 'string' && n.image !== '')))
      out.errors.push(`${here}: a shape is built from images under the element, which would cover its own ${TEXT_CLASSES.has(cls) ? 'text' : IMAGE_CLASSES.has(cls) ? 'image' : 'content'}: put the shape on a Frame (or a button with no text or image) and the text or image in a child`);
  }
  if (top) {
    const drawn = [...TEXT_KEYS, ...IMAGE_KEYS, 'bg', 'stroke', 'gradient', 'shadow', 'shape', 'badge', 'states', 'corner', 'corners', 'size', 'pos'].filter((k) => n[k] !== undefined);
    if (drawn.length) out.errors.push(`${here}: ${drawn.join(', ')} on a ScreenGui does nothing: a screen only holds its elements (put them on a Frame inside it)`);
  }
  if (n.kids !== undefined) {
    if (!Array.isArray(n.kids)) out.errors.push(`${here}.kids: a list of elements`);
    else checkKids(n.kids, here, top ? (n as MockNode) : screen, ctx);
  }
}

function checkKids(kids: unknown[], path: string, screen: MockNode | null, ctx: CheckCtx): void {
  const seen = new Set<string>();
  for (const k of kids) {
    const name = isObj(k) && typeof k.name === 'string' ? k.name : null;
    if (name && seen.has(name)) ctx.out.errors.push(`${path}.${name}: two children share this name (paths must be unique)`);
    if (name) seen.add(name);
    checkNode(k, `${path}.${name ?? ''}`, screen ?? ({ name: path } as MockNode), ctx);
  }
}

function checkForms(v: unknown, path: string, screen: MockNode, ctx: CheckCtx): void {
  const out = ctx.out;
  if (!isObj(v)) {
    out.errors.push(`${path}.forms: an object keyed by form (${MOCK_FORMS.join(', ')})`);
    return;
  }
  for (const [form, layout] of Object.entries(v)) {
    const at = `${path}[${form}]`;
    if (!(MOCK_FORMS as string[]).includes(form)) {
      out.errors.push(`${path}.forms: unknown form "${form}" (forms: ${MOCK_FORMS.join(', ')})`);
      continue;
    }
    if (!isObj(layout)) {
      out.errors.push(`${at}: { kids } or { set }`);
      continue;
    }
    for (const k of Object.keys(layout)) if (k !== 'kids' && k !== 'set') out.errors.push(`${at}: unknown field "${k}" (a form layout has kids: its own children, or set: {"Path.Below.Screen": props})`);
    if (layout.kids !== undefined && !Array.isArray(layout.kids)) {
      out.errors.push(`${at}.kids: a list of elements`);
      continue;
    }
    if (layout.set !== undefined && !isObj(layout.set)) {
      out.errors.push(`${at}.set: an object of path → properties (or null to remove)`);
      continue;
    }
    // The children this form really gets: its own, or the default ones with its changes. Every change must land.
    let kids = (layout.kids ?? screen.kids ?? []) as MockNode[];
    if (isObj(layout.set)) {
      const set: Record<string, MockPatch | null> = {};
      for (const [key, change] of Object.entries(layout.set)) {
        if (key === screen.name || key.startsWith(`${screen.name}.`)) {
          out.errors.push(`${at}.set "${key}": paths in a form's set start below the screen: "${key.slice(screen.name.length + 1) || '(the screen itself can\'t change per form)'}"`);
          continue;
        }
        if (/^\w+:/.test(key)) {
          out.errors.push(`${at}.set "${key}": no form prefix inside forms (that is the version's set)`);
          continue;
        }
        set[key] = change as MockPatch | null;
      }
      const errs: string[] = [];
      kids = applySet(kids, set, screen.name, errs);
      out.errors.push(...errs.map((e) => `${at}.${e}`));
    }
    checkKids(kids, at, screen, ctx);
  }
}

/** Checks a version's screens (and motion) before they are saved: errors stop the save, warnings are reported. */
/**
 * Pixel shorthands read as offsets, where they can mean only one thing: padding as one number or four (top, right,
 * bottom, left), a corner radius as one number, four corners as four numbers, a list's pad as one number, a grid's
 * cell or pad as two ([x, y]). The UI copilot's first mockup in 1.14 wrote its paddings this way and had to send the
 * whole version again. Returns a copy; anything else is left for the check to judge.
 */
export function readShorthands<T>(screens: T): T {
  const off = (n: number): [number, number] => [0, n];
  const fix = (n: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...n };
    if (isNum(o.padding)) o.padding = [off(o.padding), off(o.padding), off(o.padding), off(o.padding)];
    else if (nums(o.padding, 4)) o.padding = (o.padding as number[]).map(off);
    if (isNum(o.corner)) o.corner = off(o.corner);
    // Roblox's own words for a value.
    if (o.truncate === 'AtEnd' || o.truncate === 'SplitWord') o.truncate = true;
    else if (o.truncate === 'None') o.truncate = false;
    if (Array.isArray(o.hides)) o.hides = o.hides.join(' ');
    if (nums(o.corners, 4)) o.corners = (o.corners as number[]).map(off);
    if (isObj(o.list) && isNum(o.list.pad)) o.list = { ...o.list, pad: off(o.list.pad) };
    if (isObj(o.grid)) {
      const g = { ...o.grid };
      for (const k of ['cell', 'pad']) if (nums(g[k], 2)) g[k] = [0, (g[k] as number[])[0], 0, (g[k] as number[])[1]];
      o.grid = g;
    }
    if (Array.isArray(o.kids)) o.kids = o.kids.map((k) => (isObj(k) ? fix(k) : k));
    if (isObj(o.states)) o.states = Object.fromEntries(Object.entries(o.states).map(([s, p]) => [s, isObj(p) ? fix(p) : p]));
    if (isObj(o.forms))
      o.forms = Object.fromEntries(
        Object.entries(o.forms).map(([f, l]) => {
          if (!isObj(l)) return [f, l];
          const lay: Record<string, unknown> = { ...l };
          if (Array.isArray(lay.kids)) lay.kids = lay.kids.map((k) => (isObj(k) ? fix(k) : k));
          if (isObj(lay.set)) lay.set = Object.fromEntries(Object.entries(lay.set).map(([path, p]) => [path, isObj(p) ? fix(p) : p]));
          return [f, lay];
        }),
      );
    return o;
  };
  return (Array.isArray(screens) ? screens.map((s) => (isObj(s) ? fix(s) : s)) : screens) as T;
}

export function checkVersion(v: { screens: unknown; theme?: unknown; motion?: unknown }, knows: MockKnows = {}): MockCheck {
  const out: MockCheck = { errors: [], warnings: [] };
  let theme: Record<string, MockColor> | undefined;
  if (v.theme !== undefined) {
    if (!isObj(v.theme)) out.errors.push('theme: an object of token → colour');
    else {
      theme = v.theme as Record<string, MockColor>;
      for (const [k, c] of Object.entries(v.theme)) checkColor(c, `theme.${k}`, { theme: undefined, out });
    }
  }
  const ctx: CheckCtx = { theme, out, knows };
  if (!Array.isArray(v.screens) || !v.screens.length) out.errors.push('screens: at least one ScreenGui');
  else {
    const seen = new Set<string>();
    for (const s of v.screens) {
      const name = isObj(s) && typeof s.name === 'string' ? s.name : '';
      if (name && seen.has(name)) out.errors.push(`${name}: two screens share this name`);
      seen.add(name);
      checkNode(s, name || '(screen)', null, ctx);
    }
  }
  if (v.motion !== undefined) {
    if (!Array.isArray(v.motion)) out.errors.push('motion: a list of moves');
    else
      v.motion.forEach((m, i) => {
        const at = `motion[${i}]`;
        if (!isObj(m)) return void out.errors.push(`${at}: a move object`);
        if (!(MOTION_KINDS as readonly string[]).includes(String(m.play))) out.errors.push(`${at}.play: one of ${MOTION_KINDS.join(', ')}`);
        for (const k of Object.keys(m)) if (!['play', 'target', 'when', 'from', 'to', 'delay', 'gap', 'seconds', 'amount', 'style', 'note'].includes(k)) out.errors.push(`${at}: unknown field "${k}" (fields: play, target, when, from, to, delay, gap, seconds, amount, style, note)`);
        if (m.play !== 'transition' && typeof m.target !== 'string') out.errors.push(`${at}.target: the element's path ("Screen.Element")`);
        if (m.play === 'transition' && m.style !== undefined && !['fade', 'wipe', 'iris'].includes(String(m.style))) out.errors.push(`${at}.style: fade, wipe or iris`);
        if (m.play === 'enter' && m.from !== undefined && !(DIRECTIONS as readonly string[]).includes(String(m.from))) out.errors.push(`${at}.from: up, down, left, right, pop or fade`);
        if (m.play === 'count' && (!isNum(m.from) || !isNum(m.to))) out.errors.push(`${at}: count needs numbers from and to`);
        for (const k of ['delay', 'gap', 'seconds', 'amount']) if (m[k] !== undefined && !isNum(m[k])) out.errors.push(`${at}.${k}: a number`);
      });
  }
  if (!out.errors.length && Array.isArray(v.motion)) {
    // A move must have its element in some layout of the screens: a typo would play nothing.
    const paths = new Set<string>();
    for (const s of v.screens as MockNode[]) for (const form of [null, ...MOCK_FORMS]) for (const p of pathsOf(s, form)) paths.add(p);
    (v.motion as MockMotion[]).forEach((m, i) => {
      if (m.target && !paths.has(m.target)) {
        const near = [...paths].filter((p) => p.split('.').pop() === m.target!.split('.').pop() || p.startsWith(m.target!.split('.')[0] ?? '\0')).slice(0, 6);
        out.errors.push(`motion[${i}].target: no element "${m.target}" in any layout (paths start with the screen${near.length ? `; e.g. ${near.join(', ')}` : ''})`);
      }
    });
  }
  return out;
}

function pathsOf(screen: MockNode, form: MockForm | null): string[] {
  const out: string[] = [screen.name];
  let kids: MockNode[] = screen.kids ?? [];
  if (form) kids = screen.forms?.[form] ? formKids(screen, form, []) : [];
  const walk = (n: MockNode, path: string) => {
    out.push(path);
    for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`);
    if (n.badge) out.push(`${path}.Badge`);
  };
  for (const c of kids) walk(c, `${screen.name}.${c.name}`);
  return out;
}

// ─── Changing a version: set patches ──────────────────────────────────────────────────────────────

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * Applies changes to a tree of children by path below `base` ("Window.Grid"): an object merges into the
 * element (one level deep into objects like list or stroke; kids replaces its children), null removes it,
 * and a path that doesn't exist yet adds the element there when it gives a cls.
 */
export function applySet(kids: MockNode[], set: Record<string, MockPatch | null>, base: string, errors: string[]): MockNode[] {
  const root: MockNode = { name: base, cls: 'Frame', kids: clone(kids) };
  for (const [rel, change] of Object.entries(set)) {
    const parts = rel.split('.').filter(Boolean);
    if (!parts.length) {
      errors.push(`set: an empty path under ${base}`);
      continue;
    }
    let parent: MockNode | undefined = root;
    let walked = base;
    for (const p of parts.slice(0, -1)) {
      const next: MockNode | undefined = parent?.kids?.find((k) => k.name === p);
      if (!next) {
        errors.push(`set: no element ${walked}.${p} (${walked} has ${parent?.kids?.length ? parent.kids.map((k) => k.name).join(', ') : 'no children'})`);
        parent = undefined;
        break;
      }
      parent = next;
      walked = `${walked}.${p}`;
    }
    const last = parts[parts.length - 1]!;
    if (!parent) continue;
    const kids2 = (parent.kids ??= []);
    const i = kids2.findIndex((k) => k.name === last);
    const has = () => (kids2.length ? kids2.map((k) => k.name).join(', ') : 'no children');
    if (change === null) {
      if (i < 0) errors.push(`set: no element ${base}.${rel} to remove (${walked} has ${has()})`);
      else kids2.splice(i, 1);
      continue;
    }
    if (!isObj(change)) {
      errors.push(`set ${base}.${rel}: an object of properties, or null to remove it`);
      continue;
    }
    if (i < 0) {
      if (typeof change.cls !== 'string') errors.push(`set: no element ${base}.${rel} (${walked} has ${has()}; to add one there, give its cls)`);
      else kids2.push({ ...clone(change), name: last } as MockNode);
      continue;
    }
    const cur = kids2[i]! as Record<string, unknown>;
    for (const [k, x] of Object.entries(clone(change))) {
      if (x === null) delete cur[k];
      else if (isObj(x) && isObj(cur[k])) cur[k] = { ...(cur[k] as object), ...x };
      else cur[k] = x;
    }
  }
  return root.kids ?? [];
}

/** A screen's children on a form: the form's own, else the default ones, with the form's changes applied. */
function formKids(screen: MockNode, form: MockForm, errors: string[]): MockNode[] {
  const layout = screen.forms?.[form];
  const kids = layout?.kids ?? screen.kids ?? [];
  return layout?.set ? applySet(kids, layout.set, screen.name, errors) : kids;
}

/**
 * Changes to a whole version (a revision): paths start with the screen ("Shop.Window.Grid"); a "<form>:"
 * prefix ("phone:Shop.Window") changes that form's layout (its own children, or its changes when it has none).
 */
export function applyVersionSet(screens: MockNode[], set: Record<string, MockPatch | null>, errors: string[]): MockNode[] {
  const out = clone(screens);
  // Group by screen and form so each tree is patched once, in the order given.
  for (const [key, change] of Object.entries(set)) {
    const m = /^(?:(\w+):)?([^.]+)(?:\.(.+))?$/.exec(key);
    if (!m) {
      errors.push(`set: "${key}" is not a path ("Screen.Element", or "phone:Screen.Element")`);
      continue;
    }
    const [, form, screenName, rel] = m;
    if (form && !(MOCK_FORMS as string[]).includes(form)) {
      errors.push(`set: unknown form "${form}" in "${key}" (forms: ${MOCK_FORMS.join(', ')})`);
      continue;
    }
    const screen = out.find((s) => s.name === screenName);
    if (!screen) {
      errors.push(`set: no screen "${screenName}"`);
      continue;
    }
    if (!rel) {
      // The screen itself.
      if (change === null) out.splice(out.indexOf(screen), 1);
      else if (isObj(change)) for (const [k, x] of Object.entries(clone(change))) (screen as Record<string, unknown>)[k] = x === null ? undefined : x;
      continue;
    }
    if (!form) {
      screen.kids = applySet(screen.kids ?? [], { [rel]: change }, screen.name, errors);
      continue;
    }
    const f = form as MockForm;
    const layout = ((screen.forms ??= {})[f] ??= {});
    if (layout.kids) layout.kids = applySet(layout.kids, { [rel]: change }, screen.name, errors);
    else layout.set = { ...(layout.set ?? {}), [rel]: change };
  }
  return out;
}

/** A captured screen (UiNode from Studio) as mockup screens: ids and capture-only fields dropped. */
export function fromCapture(n: UiNode): MockNode {
  const { id: _id, loops: _loops, kids, stroke, strokes, ...rest } = n;
  const all = strokes && strokes.length > 1 ? strokes : stroke ? [stroke] : [];
  return { ...rest, ...(all.length > 1 ? { stroke: all } : all.length ? { stroke: all[0] } : {}), ...(kids?.length ? { kids: kids.map(fromCapture) } : {}) } as MockNode;
}

// ─── Laying out a version on a device ─────────────────────────────────────────────────────────────

/** What Ui.screen and Hud.screen declare on their UIScale, and the insets they use. */
export const KIT_SCREENS = {
  ui: { fit: { ref: [1920, 1080] as [number, number], min: 0.8, max: 1.5, tenFoot: 1.25 }, insets: 'CoreUISafeInsets' as const },
  hud: { fit: { ref: [900, 900] as [number, number], min: 0.6, max: 1.4, tenFoot: 1.2 }, insets: 'DeviceSafeInsets' as const },
};

/**
 * The form the kits' Ui.device/Hud.device report on a device: "tv" on a 10-foot interface, "phone" when the
 * shorter side inside the safe area is under 500 points (phonePortrait when it is taller than wide), "tablet"
 * when the longer side is under 1300, "desktop" above.
 */
export function formOf(device: UiDevice): MockForm {
  const d: UiScreen = UI_DEVICES[device];
  if (d.tenFoot) return 'tv';
  const w = d.w - 2 * (d.side ?? 0);
  const h = d.h - (d.top ?? 0) - (d.bottom ?? 0) - (d.topbar ?? TOPBAR);
  if (Math.min(w, h) < 500) return h > w ? 'phonePortrait' : 'phone';
  return Math.max(w, h) < 1300 ? 'tablet' : 'desktop';
}

/** The layout a screen uses on a form: the first of the form's fallbacks it has, else null (its default children). */
export function layoutOf(screen: MockNode, form: MockForm): MockForm | null {
  return FORM_FALLBACK[form].find((f) => screen.forms?.[f]) ?? null;
}

function color(c: MockColor | undefined, theme: Record<string, MockColor> | undefined, depth = 0): RGB | undefined {
  if (c === undefined) return undefined;
  if (Array.isArray(c)) return [c[0], c[1], c[2]];
  if (HEX.test(c)) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  if (TOKEN.test(c) && theme && depth < 4) return color(theme[c.slice(1)], theme, depth + 1);
  return undefined;
}

export interface ResolvedVersion {
  /** The ScreenGuis as the layout engine takes them (ids numbered in order). */
  screens: UiNode[];
  form: MockForm;
  /** Per screen, the form layout it uses on this device (null: its default children). */
  layouts: Record<string, MockForm | null>;
}

/** The red of notification badges. */
export const BADGE_RED = '#e53935';

/**
 * A badge as the element it builds: a child named "Badge" drawn over the corner (a pill with a count or a word, a
 * dot, or a ribbon tag across the top edge or a corner). The kit's Ui.badge makes exactly this.
 */
export function badgeNode(b: MockBadge): MockNode {
  const style = b.style ?? 'pill';
  const s = b.size ?? (style === 'dot' ? 12 : 22);
  const at = b.at ?? (style === 'ribbon' ? 'top' : 'tr');
  const inset = Math.round(s * 0.2);
  const pos: Record<NonNullable<MockBadge['at']>, [number, number, number, number]> = { tr: [1, -inset, 0, inset], tl: [0, inset, 0, inset], br: [1, -inset, 1, -inset], bl: [0, inset, 1, -inset], top: [0.5, 0, 0, 0] };
  const fill = b.color ?? BADGE_RED;
  const base: MockNode = { name: 'Badge', anchor: [0.5, 0.5], pos: pos[at], z: 10, bg: fill };
  if (style === 'dot') return { ...base, cls: 'Frame', size: [0, s, 0, s], corner: [0.5, 0], stroke: { color: '#ffffff', px: 2 } };
  const text: MockNode = { ...base, cls: 'TextLabel', text: b.text ?? '', textColor: b.textColor ?? '#ffffff', textSize: Math.round(s * 0.62), font: 'BuilderSansExtraBold', bold: true, auto: 'X', size: [0, s, 0, s] };
  const sideways = Math.round(s * (style === 'ribbon' ? 0.45 : 0.3));
  const padding: MockNode['padding'] = [
    [0, 0],
    [0, sideways],
    [0, 0],
    [0, sideways],
  ];
  if (style === 'ribbon')
    return { ...text, padding, rot: at === 'tr' || at === 'br' ? 30 : at === 'tl' || at === 'bl' ? -30 : -4, corner: [0, 3], stroke: [{ color: '#000000', t: 0.35, px: 2, z: 0 }, { color: '#000000', t: 0.3, px: 1.5, text: true, z: 1 }] };
  return { ...text, padding, corner: [0.5, 0], stroke: { color: '#ffffff', px: 2 } };
}

/** The moves a version plays: its motion list, and each element's appear as a Motion.enter. */
export function motionOf(v: Pick<MockVersion, 'screens' | 'motion'>): MockMotion[] {
  const out = [...(v.motion ?? [])];
  const seen = new Set<string>();
  const walk = (n: MockNode, path: string) => {
    if (n.appear && !seen.has(path)) {
      seen.add(path);
      const a = typeof n.appear === 'string' ? { from: n.appear } : n.appear;
      out.push({ play: 'enter', target: path, from: a.from ?? 'up', ...(a.delay !== undefined ? { delay: a.delay } : {}), ...(a.amount !== undefined ? { amount: a.amount } : {}), when: 'open' });
    }
    for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`);
  };
  for (const s of v.screens) {
    for (const c of s.kids ?? []) walk(c, `${s.name}.${c.name}`);
    for (const f of MOCK_FORMS) if (s.forms?.[f]) for (const c of formKids(s, f, [])) walk(c, `${s.name}.${c.name}`);
  }
  return out;
}

/** A gradient with its colours resolved. */
function gradientOf(g: MockGradient, theme: Record<string, MockColor> | undefined): UiGradient {
  return {
    rot: g.rot ?? 0,
    colors: (g.colors ?? []).map((s) => (s.length === 4 ? s : ([s[0], ...(color(s[1], theme) ?? [255, 255, 255])] as [number, number, number, number]))),
    ...(g.transp ? { transp: g.transp } : {}),
    ...(g.offset ? { offset: g.offset } : {}),
    ...(g.type && g.type !== 'Linear' ? { type: g.type } : {}),
  };
}

/** Strokes with their colours resolved (Outer, 1 px, opaque unless said). */
function strokesFrom(s: MockStroke | MockStroke[], theme: Record<string, MockColor> | undefined): UiStroke[] {
  return (Array.isArray(s) ? s : [s]).map((x) => ({
    color: color(x.color, theme) ?? [0, 0, 0],
    t: x.t ?? 0,
    px: x.px ?? 1,
    text: x.text ?? false,
    ...(x.pos && x.pos !== 'Outer' ? { pos: x.pos } : {}),
    ...(x.z !== undefined ? { z: x.z } : {}),
    ...(x.gradient ? { gradient: gradientOf(x.gradient, theme) } : {}),
  }));
}

/** A version's screens on one device: the layout for its form, theme colours, the kits' screen setup. */
export function resolveVersion(v: Pick<MockVersion, 'screens' | 'theme'>, device: UiDevice): ResolvedVersion {
  const form = formOf(device);
  let id = 1;
  const layouts: Record<string, MockForm | null> = {};
  const theme = v.theme;
  const node = (m: MockNode): UiNode => {
    const { kids, kit: _kit, forms: _forms, note: _note, id: _id, appear: _appear, badge, bg, borderColor, textColor, strokeColor, imageColor, stroke, gradient, shadow, states, ...rest } = m;
    const out: UiNode = { ...(rest as Omit<UiNode, 'id' | 'cls'>), cls: m.cls ?? 'Frame', id: id++ };
    const set = (k: ColorKey, c: MockColor | undefined) => {
      const rgb = color(c, theme);
      if (rgb) out[k] = rgb;
    };
    set('bg', bg);
    set('borderColor', borderColor);
    set('textColor', textColor);
    set('strokeColor', strokeColor);
    set('imageColor', imageColor);
    if (stroke) {
      const all = strokesFrom(stroke, theme);
      out.stroke = all[0];
      if (all.length > 1) out.strokes = all;
    }
    if (gradient) out.gradient = gradientOf(gradient, theme);
    if (shadow) out.shadow = { color: color(shadow.color, theme) ?? [0, 0, 0], t: shadow.t ?? 0.5, blur: shadow.blur ?? 8, ...(shadow.spread ? { spread: shadow.spread } : {}), ...(shadow.offset ? { offset: shadow.offset } : {}) };
    if (states) {
      const resolved: NonNullable<UiNode['states']> = {};
      for (const [name, p] of Object.entries(states) as Array<[UiStateName, MockStatePatch]>) {
        if (!p) continue;
        const { bg: pbg, textColor: ptc, imageColor: pic, stroke: ps, gradient: pg, shadow: psh, ...plain } = p;
        const patch: UiStatePatch = { ...plain };
        if (pbg !== undefined) patch.bg = color(pbg, theme);
        if (ptc !== undefined) patch.textColor = color(ptc, theme);
        if (pic !== undefined) patch.imageColor = color(pic, theme);
        if (ps) {
          const all = strokesFrom(ps, theme);
          patch.stroke = all[0];
          patch.strokes = all;
        }
        if (pg) patch.gradient = gradientOf(pg, theme);
        if (psh) patch.shadow = { color: color(psh.color, theme) ?? [0, 0, 0], t: psh.t ?? 0.5, blur: psh.blur ?? 8, ...(psh.spread ? { spread: psh.spread } : {}), ...(psh.offset ? { offset: psh.offset } : {}) };
        resolved[name] = patch;
      }
      out.states = resolved;
    }
    const children = [...(kids ?? []), ...(badge ? [badgeNode(badge)] : [])];
    if (children.length) out.kids = children.map(node);
    return out;
  };
  const screens = v.screens.map((s) => {
    const layout = layoutOf(s, form);
    layouts[s.name] = layout;
    const kids = layout ? formKids(s, layout, []) : (s.kids ?? []);
    const kit = s.kit ? KIT_SCREENS[s.kit] : null;
    const screen = node({ ...s, cls: 'ScreenGui', kids });
    if (kit && !s.fit && s.scale === undefined) screen.fit = { ...kit.fit, ref: [...kit.fit.ref] };
    if (kit && !s.insets && !s.ignoreInset) screen.insets = kit.insets;
    return screen;
  });
  return { screens, form, layouts };
}

// ─── Audits ───────────────────────────────────────────────────────────────────────────────────────

export interface MockAudit {
  findings: UiFinding[];
  devices: Array<{ device: UiDevice; form: MockForm; layouts: Record<string, MockForm | null>; problems: number; warnings: number }>;
}

const findingKey = (f: UiFinding) => `${f.path}|${f.message.replace(/\d+(\.\d+)?/g, '#')}`;

/**
 * ui_audit's checks on a mockup, device by device: devices that share a layout are audited together (as the
 * game is), and the findings merged with the devices they happen on.
 */
export function auditVersion(v: Pick<MockVersion, 'screens' | 'theme'>, devices: UiDevice[] = MOCK_DEVICES, measure: Measure = estimateText): MockAudit {
  const groups = new Map<string, { devices: UiDevice[]; screens: UiNode[] }>();
  const per: MockAudit['devices'] = [];
  for (const d of devices) {
    const r = resolveVersion(v, d);
    const key = JSON.stringify(r.layouts);
    const g = groups.get(key);
    if (g) g.devices.push(d);
    else groups.set(key, { devices: [d], screens: r.screens });
    per.push({ device: d, form: r.form, layouts: r.layouts, problems: 0, warnings: 0 });
  }
  const found = new Map<string, UiFinding>();
  for (const g of groups.values()) {
    for (const f of auditUi(g.screens, g.devices, measure)) {
      // "Off the screen on every device" means every device of this layout; across layouts it is a real slip.
      const finding = g.devices.length < devices.length && f.message.startsWith('Off the screen on every device') ? { ...f, severity: 'problem' as const, message: '100% off the screen' } : f;
      const key = findingKey(finding);
      const prev = found.get(key);
      if (!prev) found.set(key, { ...finding, devices: [...finding.devices] });
      else {
        for (const d of finding.devices) if (!prev.devices.includes(d)) prev.devices.push(d);
        if (finding.severity === 'problem') prev.severity = 'problem';
      }
    }
  }
  const findings = [...found.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1) || Number(!!a.whenShown) - Number(!!b.whenShown));
  for (const p of per)
    for (const f of findings)
      if (!f.devices.length || f.devices.includes(p.device)) {
        if (f.severity === 'problem') p.problems++;
        else p.warnings++;
      }
  return { findings, devices: per };
}

/** Where each top element of a version lands on each device ("Shop.Window (Frame): phone 22,10 800×360 · desktop …"). */
export function mockOutline(v: Pick<MockVersion, 'screens' | 'theme'>, devices: UiDevice[] = ['phone', 'desktop'], depth = 1, limit = 40): string[] {
  const r = Math.round;
  const laid = devices.map((d) => {
    const res = resolveVersion(v, d);
    return { d, res, boxes: new Map(res.screens.flatMap((s) => layoutScreen(s, UI_DEVICES[d])).map((b) => [b.path, b])) };
  });
  const lines: string[] = [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const l of laid)
    for (const [path, b] of l.boxes)
      if (b.depth <= depth && !seen.has(path)) {
        seen.add(path);
        order.push(path);
      }
  for (const s of v.screens) {
    const forms = laid.map((l) => (l.res.layouts[s.name] ? `${UI_DEVICES[l.d].label.toLowerCase()}: ${l.res.layouts[s.name]} layout` : null)).filter(Boolean);
    lines.push(`${s.name}${s.kit ? ` (${s.kit === 'ui' ? 'Ui.screen' : 'Hud.screen'})` : ''}${forms.length ? ` — ${forms.join(', ')}` : ''}`);
    for (const path of order.filter((p) => p.startsWith(`${s.name}.`))) {
      const parts = laid.map((l) => {
        const b = l.boxes.get(path);
        return b ? `${UI_DEVICES[l.d].label.toLowerCase()} ${r(b.x)},${r(b.y)} ${r(b.w)}×${r(b.h)}` : `${UI_DEVICES[l.d].label.toLowerCase()} —`;
      });
      const any = laid.map((l) => l.boxes.get(path)).find(Boolean)!;
      lines.push(`  ${'  '.repeat(any.depth)}${path} (${any.node.cls}${any.node.visible === false ? ', hidden' : ''}): ${parts.join(' · ')}`);
      if (lines.length >= limit) return [...lines, '  …'];
    }
  }
  return lines;
}

export interface GameComparison {
  /** Mockup screens with a ScreenGui of the same name in the game's UI. */
  screens: Array<{ name: string; inGame: boolean }>;
  /** Elements checked (per device) and how many landed where the mockup puts them. */
  checked: number;
  matched: number;
  differences: Array<{ path: string; devices: UiDevice[]; issue: string }>;
}

/**
 * The game's UI (as last read from Studio) against a mockup version, device by device, matched by path:
 * elements the game lacks, and elements more than `tolerance` points away from the mockup's place or size.
 */
export function compareWithGame(v: Pick<MockVersion, 'screens' | 'theme'>, game: UiNode[], devices: UiDevice[] = MOCK_DEVICES, tolerance = 4): GameComparison {
  const r = Math.round;
  const diffs = new Map<string, { path: string; devices: UiDevice[]; issue: string }>();
  const add = (path: string, issue: string, d: UiDevice) => {
    const key = `${path}|${issue.replace(/\d+/g, '#')}`;
    const prev = diffs.get(key);
    if (prev) {
      if (!prev.devices.includes(d)) prev.devices.push(d);
    } else diffs.set(key, { path, devices: [d], issue });
  };
  let checked = 0;
  let matched = 0;
  const screens = v.screens.map((s) => ({ name: s.name, inGame: game.some((g) => g.name === s.name) }));
  for (const d of devices) {
    const dev = UI_DEVICES[d];
    const mock = resolveVersion(v, d);
    for (const s of mock.screens) {
      const g = game.find((x) => x.name === s.name);
      if (!g) continue;
      const theirs = new Map<string, UiBox>(layoutScreen(g, dev).map((b) => [b.path, b]));
      for (const b of layoutScreen(s, dev)) {
        checked++;
        const t = theirs.get(b.path);
        if (!t) {
          add(b.path, 'not in the game', d);
          continue;
        }
        const off = Math.max(Math.abs(t.x - b.x), Math.abs(t.y - b.y), Math.abs(t.w - b.w), Math.abs(t.h - b.h));
        if (off <= tolerance) matched++;
        else add(b.path, `in the game at ${r(t.x)},${r(t.y)} ${r(t.w)}×${r(t.h)}; the mockup has ${r(b.x)},${r(b.y)} ${r(b.w)}×${r(b.h)}`, d);
      }
    }
  }
  return { screens, checked, matched, differences: [...diffs.values()].slice(0, 60) };
}
