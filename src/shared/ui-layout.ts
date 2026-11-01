/**
 * Roblox GUI layout, shared by the UI workshop (drawing previews) and the core (ui_audit): where each
 * GuiObject of a captured ScreenGui lands on a screen of a given size, following Roblox's rules for
 * UDim2 Position/Size, AnchorPoint, UIPadding, UIListLayout (flex: HorizontalFlex/VerticalFlex, Wraps,
 * ItemLineAlignment, UIFlexItem), UIGridLayout, UIPageLayout, UIAspectRatioConstraint,
 * UISizeConstraint, UITextSizeConstraint, UIScale (a ScreenGui's too, and fitted per device when a
 * script fits it to the screen), AutomaticSize, ScrollingFrame canvases, ClipsDescendants,
 * ZIndexBehavior, the top bar inset and a 10-foot interface's bigger fit. The rules were measured in Studio (ARCHITECTURE §11). Text
 * metrics come from a measure function (the renderer measures real fonts; the core estimates); rich
 * text and rotation are approximated. Deterministic: the same capture and screen always give the same boxes.
 */

export type UDim = [scale: number, offset: number];
export type UDim2 = [xScale: number, xOffset: number, yScale: number, yOffset: number];
export type RGB = [number, number, number];
export type FlexAlign = 'Fill' | 'SpaceAround' | 'SpaceBetween' | 'SpaceEvenly';
export type ItemAlign = 'Automatic' | 'Start' | 'Center' | 'End' | 'Stretch';

/** One GuiObject (or ScreenGui) as captured from Studio; UI* modifiers are folded into their parent. */
export interface UiNode {
  id: number;
  name: string;
  cls: string;
  kids?: UiNode[];
  visible?: boolean;
  pos?: UDim2;
  size?: UDim2;
  anchor?: [number, number];
  rot?: number;
  z?: number;
  order?: number;
  bg?: RGB;
  bgT?: number;
  border?: number;
  borderColor?: RGB;
  clips?: boolean;
  auto?: 'X' | 'Y' | 'XY';
  text?: string;
  textColor?: RGB;
  textT?: number;
  textSize?: number;
  scaled?: boolean;
  wrapped?: boolean;
  /** TextTruncate is on: text that doesn't fit ends in "…" by design. */
  truncate?: boolean;
  lineHeight?: number;
  font?: string;
  bold?: boolean;
  /** FontFace.Weight (100–900) when known exactly; `bold` is weight ≥ 600. */
  weight?: number;
  italic?: boolean;
  xAlign?: 'Left' | 'Center' | 'Right';
  yAlign?: 'Top' | 'Center' | 'Bottom';
  strokeT?: number;
  strokeColor?: RGB;
  rich?: boolean;
  image?: string;
  imageColor?: RGB;
  imageT?: number;
  scaleType?: 'Stretch' | 'Fit' | 'Crop' | 'Slice' | 'Tile';
  slice?: [number, number, number, number];
  /** ImageLabel.SliceScale: how big the 9-slice edges draw (0.5 for art made at two pixels per point). */
  sliceScale?: number;
  /** ImageLabel.ResampleMode: "Pixelated" keeps pixel art crisp when it is scaled. */
  resample?: 'Pixelated';
  /** ImageRectOffset and ImageRectSize in image pixels: the part of the image shown (a sprite in an atlas). */
  rect?: [x: number, y: number, w: number, h: number];
  /** Wears drawn art (a skin): it draws though its own fill is off, its shadow and glow reaching this many points past its box. */
  skinned?: number;
  /** Drawn art, not content (a worn skin's "Skin" child): layout and overlap checks look past it. */
  decor?: boolean;
  /** Forged UI art the element wears (a skin from ui_forge): drawn under its content, 9-sliced (core/ui/forge/skins.ts). */
  skin?: string;
  canvas?: UDim2;
  /** ScreenGui */
  enabled?: boolean;
  ignoreInset?: boolean;
  insets?: 'None' | 'DeviceSafeInsets' | 'CoreUISafeInsets' | 'TopbarSafeInsets';
  displayOrder?: number;
  /** ZIndexBehavior.Global */
  global?: boolean;
  /** Roblox's own UI the screen hides while it is open, space-separated: chat, playerList, backpack, touch. */
  hides?: string;
  /** Folded modifiers */
  corner?: UDim;
  /** UICorner's per-corner radii: top left, top right, bottom right, bottom left. */
  corners?: [UDim, UDim, UDim, UDim];
  /** The first UIStroke (text: ApplyStrokeMode Contextual, a text outline). */
  stroke?: UiStroke;
  /** Every UIStroke when there are several (drawn by ZIndex, lowest first): layered glows and outlines. */
  strokes?: UiStroke[];
  gradient?: UiGradient;
  /** UIShadow: a native soft shadow; offset 0 in a bright colour is a glow. It follows the box and UICorner, never text. */
  shadow?: { color: RGB; t: number; blur: number; spread?: number; offset?: [number, number] };
  /**
   * A panel shape Roblox has no property for, built from a generated image (ui_icon shapes; 9-sliced): corners cut
   * at 45° (`cut`, points: top left, top right, bottom right, bottom left) and sides leaning in at the top (`slant`,
   * points the top edge sits in from each side; negative leans out). Strokes follow it; UIShadow does not.
   */
  shape?: UiShape;
  /** How it answers the player (a mockup's; the kit's Ui.react builds it): property changes on hover, press, selected, disabled. */
  states?: Partial<Record<UiStateName, UiStatePatch>>;
  /** The state it starts in (the open tab "selected", a button the player can't use yet "disabled"). */
  state?: 'selected' | 'disabled';
  /** UIPadding: top, right, bottom, left */
  padding?: [UDim, UDim, UDim, UDim];
  list?: {
    dir: 'Horizontal' | 'Vertical';
    h: 'Left' | 'Center' | 'Right';
    v: 'Top' | 'Center' | 'Bottom';
    pad: UDim;
    byName?: boolean;
    hFlex?: FlexAlign;
    vFlex?: FlexAlign;
    wraps?: boolean;
    itemAlign?: ItemAlign;
  };
  grid?: { cell: UDim2; pad: UDim2; dir: 'Horizontal' | 'Vertical'; h: 'Left' | 'Center' | 'Right'; v: 'Top' | 'Center' | 'Bottom'; byName?: boolean; max?: number };
  /** UIPageLayout: one page shows at a time (the current page, else the first in order). */
  pages?: { byName?: boolean; current?: string };
  /** UIFlexItem: how this item of a list grows or shrinks along the line, and its alignment across it. */
  flex?: { mode: 'None' | 'Grow' | 'Shrink' | 'Fill' | 'Custom'; grow?: number; shrink?: number; align?: ItemAlign };
  aspect?: { ratio: number; scaleWithParent?: boolean; heightDominant?: boolean };
  sizeMin?: [number, number];
  sizeMax?: [number, number];
  textMin?: number;
  textMax?: number;
  scale?: number;
  /**
   * A UIScale a script fits to the screen, declared by its FitReference (Vector2) and FitRange
   * (NumberRange) attributes: on each device it is clamp(min(w / ref.x, h / ref.y), min, max) of the
   * ScreenGui's area, instead of the value captured on Studio's window; times FitTenFoot (a number) on a
   * 10-foot interface (a console on a TV), when the script declares one.
   */
  fit?: { ref: [number, number]; min: number; max: number; tenFoot?: number };
  /** Looping animations running on it now (the Motion module's MotionLoops attribute). */
  loops?: number;
}

/** UIGradient: colours multiply what the element draws, transparency fades it; Linear runs left to right at rot 0. */
export interface UiGradient {
  rot: number;
  colors: Array<[t: number, r: number, g: number, b: number]>;
  transp?: Array<[t: number, v: number]>;
  offset?: [number, number];
  type?: 'Linear' | 'Radial' | 'Conical';
}

/** UIStroke: a border (or, with text, an outline round the letters), Outer by default as Roblox draws it. */
export interface UiStroke {
  color: RGB;
  t: number;
  px: number;
  text: boolean;
  pos?: 'Outer' | 'Center' | 'Inner';
  /** ZIndex among the element's strokes (several stack: a thin bright line over a wide faint glow). */
  z?: number;
  /** A UIGradient under the UIStroke: colours and fades the stroke alone. */
  gradient?: UiGradient;
}

export interface UiShape {
  cut?: [number, number, number, number];
  slant?: [number, number];
}

export type UiStateName = 'hover' | 'press' | 'selected' | 'disabled';
export const UI_STATES: UiStateName[] = ['hover', 'press', 'selected', 'disabled'];
/** A worn skin's art (its "Skin" child): what a state swaps when it shows other art. */
export interface SkinArt {
  image: string;
  scaleType: 'Slice' | 'Stretch';
  slice?: [number, number, number, number];
  sliceScale?: number;
  rect?: [number, number, number, number];
  pos: UDim2;
  size: UDim2;
}
/**
 * What changes in a state: visual properties, and `scale` (a UIScale on the element: 0.95 for a press). `skin`: other
 * forged art for the state (a pressed or disabled button, an active tab), worn as `skinArt` on the "Skin" child.
 */
export type UiStatePatch = Partial<Pick<UiNode, 'bg' | 'bgT' | 'textColor' | 'textT' | 'imageColor' | 'imageT' | 'rot' | 'stroke' | 'strokes' | 'gradient' | 'shadow'>> & { scale?: number; skin?: string; skinArt?: SkinArt; label?: LabelPatch };
/** A skinned element's text lives in its "Label" child: what a state changes there (a pressed face moves it down). */
export type LabelPatch = Partial<Pick<UiNode, 'pos' | 'size' | 'textColor' | 'textT' | 'stroke' | 'strokes'>>;

/** Screens as they start: every element with a starting `state` in it (its states stay, to change later). */
export function withStartStates(screens: UiNode[]): UiNode[] {
  const walk = (n: UiNode): UiNode => {
    let out = n.state && n.states?.[n.state] ? { ...withState(n, n.state), states: n.states } : n;
    if (out.kids?.length) out = { ...out, kids: out.kids.map(walk) };
    return out;
  };
  return screens.map(walk);
}

/** A node with a state's changes applied (a press's scale is a UIScale on it, so the layout shrinks it about its anchor). */
export function withState(n: UiNode, state: UiStateName): UiNode {
  const p = n.states?.[state];
  if (!p) return n;
  const { scale, stroke, strokes, skin: _skin, skinArt, label, ...rest } = p;
  const out: UiNode = { ...n, ...rest };
  // The art and text a skin wears (in its "Art" folder when the element lays its children out).
  const swap = (k: UiNode): UiNode =>
    k.cls === 'Folder' && k.name === 'Art' && k.kids ? { ...k, kids: k.kids.map(swap) } : skinArt && k.name === 'Skin' && k.cls === 'ImageLabel' ? { ...k, ...skinArt } : label && k.name === 'Label' && k.cls === 'TextLabel' ? { ...k, ...label } : k;
  if ((skinArt || label) && out.kids) out.kids = out.kids.map(swap);
  if (stroke || strokes) {
    out.stroke = stroke ?? strokes?.[0];
    out.strokes = strokes ?? (stroke ? [stroke] : undefined);
  }
  if (scale !== undefined) out.scale = (n.scale ?? 1) * scale;
  return out;
}

/** A node's strokes, lowest ZIndex first. */
export const strokesOf = (n: Pick<UiNode, 'stroke' | 'strokes'>): UiStroke[] => [...(n.strokes ?? (n.stroke ? [n.stroke] : []))].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

/** The outline of a shaped box, in its own points (x right, y down): a polygon, clockwise. `k` scales the shape's points (UIScale). */
export function shapePolygon(shape: UiShape, w: number, h: number, k = 1): Array<[number, number]> {
  const lim = (v: number, max: number) => Math.max(-max, Math.min(max, v));
  const [sl, sr] = (shape.slant ?? [0, 0]).map((v) => lim(v * k, w / 2)) as [number, number];
  // Left side: from (x at top) down to (x at bottom); a positive slant sits the top edge in.
  const lt = Math.max(0, sl);
  const lb = Math.max(0, -sl);
  const rt = w - Math.max(0, sr);
  const rb = w - Math.max(0, -sr);
  const [ctl, ctr, cbr, cbl] = (shape.cut ?? [0, 0, 0, 0]).map((v) => Math.max(0, Math.min(v * k, w / 2, h / 2))) as [number, number, number, number];
  const pts: Array<[number, number]> = [];
  const add = (x: number, y: number) => {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last[0] - x) > 1e-6 || Math.abs(last[1] - y) > 1e-6) pts.push([x, y]);
  };
  // Where a side passes at height y (straight from its top to its bottom).
  const leftAt = (y: number) => lt + ((lb - lt) * y) / Math.max(h, 1e-6);
  const rightAt = (y: number) => rt + ((rb - rt) * y) / Math.max(h, 1e-6);
  add(leftAt(ctl), ctl);
  add(lt + ctl, 0);
  add(rt - ctr, 0);
  add(rightAt(ctr), ctr);
  add(rightAt(h - cbr), h - cbr);
  add(rb - cbr, h);
  add(lb + cbl, h);
  add(leftAt(h - cbl), h - cbl);
  if (pts.length > 1 && Math.abs(pts[0]![0] - pts[pts.length - 1]![0]) < 1e-6 && Math.abs(pts[0]![1] - pts[pts.length - 1]![1]) < 1e-6) pts.pop();
  return pts;
}

/** Where one GuiObject lands on the screen. */
export interface UiBox {
  node: UiNode;
  /** Names from the ScreenGui down, dot-separated ("HUD.Coins.Label"). */
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  /** What its drawing is clipped to (a ClipsDescendants ancestor or a ScrollingFrame), if anything. */
  clip: [x: number, y: number, w: number, h: number] | null;
  /** Draw order within its ScreenGui: higher is on top. */
  order: number;
  /** The text size it renders at (TextScaled, constraints and UIScale applied). */
  fontSize: number;
  depth: number;
  /** UIScale accumulated from its ancestors and itself. */
  k: number;
}

/** A screen to lay out on, in Roblox UI points. */
export interface UiScreen {
  w: number;
  h: number;
  /** Roblox's top bar, left out of ScreenGuis that respect the inset (58 points today). */
  topbar?: number;
  /** Safe-area sides (a phone's notch in landscape). */
  side?: number;
  /** Safe-area top and bottom (a phone's status bar and home bar in portrait); Roblox's top bar sits below the top. */
  top?: number;
  bottom?: number;
  /** A 10-foot interface (a console on a TV): scripts that declare FitTenFoot fit bigger; the edges may be cropped. */
  tenFoot?: boolean;
}

export const UI_DEVICES = {
  phone: { label: 'Phone', w: 844, h: 390, side: 44 },
  // Only for games that allow portrait (StarterGui.ScreenOrientation Portrait or Sensor): 47 pt status bar, 34 pt home bar.
  phonePortrait: { label: 'Phone portrait', w: 390, h: 844, top: 47, bottom: 34 },
  tablet: { label: 'Tablet', w: 1180, h: 820 },
  laptop: { label: 'Laptop', w: 1366, h: 768 },
  desktop: { label: 'Desktop', w: 1920, h: 1080 },
  tv: { label: 'TV', w: 1920, h: 1080, tenFoot: true },
} as const satisfies Record<string, UiScreen & { label: string }>;
export type UiDevice = keyof typeof UI_DEVICES;

/** The devices ui_audit checks: a landscape phone, a tablet, a desktop and a TV, plus a portrait phone when the game allows portrait. */
export function auditDevices(orientation?: string | null): UiDevice[] {
  const portrait = orientation === 'Portrait' || orientation === 'Sensor';
  return portrait ? ['phone', 'phonePortrait', 'tablet', 'desktop', 'tv'] : ['phone', 'tablet', 'desktop', 'tv'];
}
export const TOPBAR = 58;

/** Width of a run of text at a size (the renderer measures real fonts; the default estimates). */
export type Measure = (text: string, size: number, node: UiNode) => number;

// Advance widths (em) by character shape, fitted to Roblox's TextBounds for BuilderSans, its UI font
// (within about 8% on names, prices and sentences; Arial and Gotham land close).
const NARROW = new Set([...`iljI.,:;'!|`, ' ']);
const SEMI = new Set([...'frt()[]{}-"/\\*']);
const WIDE = new Set([...'mwMW@%']);
export const estimateText: Measure = (text, size, node) => {
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.26;
    else if (SEMI.has(ch)) em += 0.36;
    else if (WIDE.has(ch)) em += 0.8;
    else if (ch >= 'A' && ch <= 'Z') em += 0.64;
    else if (ch >= '0' && ch <= '9') em += 0.56;
    else em += 0.52;
  }
  return em * size * (node.bold ? 0.9 : 0.88);
};

/** Rich text as it reads (tags dropped, entities decoded), for measuring and audits. */
export function plainText(n: UiNode): string {
  const t = n.text ?? '';
  return n.rich ? t.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : t;
}

/** Lines the text breaks into in a box width (words kept whole where they fit, newlines kept). */
export function wrapText(text: string, size: number, width: number, node: UiNode, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, size, node) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** TextScaled: the largest size (up to 100) at which the text fits its box, wrapping as it goes. */
function fitText(text: string, w: number, h: number, node: UiNode, measure: Measure): number {
  if (!text || w <= 0 || h <= 0) return Math.max(1, Math.min(100, Math.floor(h)));
  let lo = 1;
  let hi = Math.max(1, Math.min(100, Math.floor(h)));
  const fits = (s: number) => {
    const lines = wrapText(text, s, w, node, measure);
    return lines.length * s <= h + 0.5 && lines.every((l) => measure(l, s, node) <= w + 0.5);
  };
  if (fits(hi)) return hi;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const TEXT = new Set(['TextLabel', 'TextButton', 'TextBox']);
export const isText = (n: UiNode) => TEXT.has(n.cls);
export const isButton = (n: UiNode) => n.cls === 'TextButton' || n.cls === 'ImageButton' || n.cls === 'TextBox';

const sortKids = (kids: UiNode[], byName?: boolean) => [...kids].sort((a, b) => (byName ? a.name.localeCompare(b.name) : (a.order ?? 0) - (b.order ?? 0)) || a.id - b.id);

/** The page a UIPageLayout shows: one being checked as if shown, else its current page, else the first in order. */
export function pageShown(parent: UiNode, show?: ReadonlySet<number>): UiNode | null {
  const kids = parent.kids ?? [];
  const forced = show ? kids.find((k) => show.has(k.id)) : undefined;
  if (forced) return forced;
  const sorted = sortKids(
    kids.filter((k) => k.visible !== false),
    parent.pages?.byName,
  );
  const current = parent.pages?.current;
  return (current ? sorted.find((k) => k.name === current) : undefined) ?? sorted[0] ?? null;
}

type Area = { x: number; y: number; w: number; h: number };
type Placed = Area & { own: number };

/** Lays out one ScreenGui (its GuiObjects) on a screen; boxes come out in draw order. */
export function layoutScreen(screen: UiNode, dev: UiScreen, opts: { measure?: Measure; show?: ReadonlySet<number> } = {}): UiBox[] {
  const measure = opts.measure ?? estimateText;
  const shown = (n: UiNode) => n.visible !== false || !!opts.show?.has(n.id);
  // ScreenInsets decides when it is read (DeviceSafeInsets keeps out of a notch even with IgnoreGuiInset on); older captures have IgnoreGuiInset only.
  const full = screen.insets ? screen.insets === 'None' : !!screen.ignoreInset;
  const top = full ? 0 : (dev.top ?? 0) + (screen.insets === 'DeviceSafeInsets' ? 0 : (dev.topbar ?? TOPBAR));
  const bottom = full ? 0 : (dev.bottom ?? 0);
  const side = full ? 0 : (dev.side ?? 0);
  const root: Area = { x: side, y: top, w: dev.w - 2 * side, h: dev.h - top - bottom };
  const out: UiBox[] = [];
  let seq = 0;

  const u = (d: UDim | undefined, len: number, k: number) => (d ? d[0] * len + d[1] * k : 0);
  // A UIScale's factor: fitted to this screen when a script fits it to the screen, else as captured.
  const ownScale = (n: UiNode): number => {
    if (n.fit && n.fit.ref[0] > 0 && n.fit.ref[1] > 0) {
      const k = Math.min(n.fit.max, Math.max(n.fit.min, Math.min(root.w / n.fit.ref[0], root.h / n.fit.ref[1])));
      return dev.tenFoot && n.fit.tenFoot && n.fit.tenFoot > 0 ? k * n.fit.tenFoot : k;
    }
    return n.scale && n.scale > 0 ? n.scale : 1;
  };

  // Offsets count k times (the UIScales above); so do size constraints, which Roblox applies before
  // the element's own UIScale. A UIScale scales its element about the AnchorPoint.
  const sizeOf = (n: UiNode, area: Area, k: number): { w: number; h: number; own: number } => {
    const s = n.size ?? [0, 100, 0, 100];
    let w = s[0] * area.w + s[1] * k;
    let h = s[2] * area.h + s[3] * k;
    if (n.aspect && n.aspect.ratio > 0) {
      const r = n.aspect.ratio;
      if (n.aspect.scaleWithParent) {
        if (n.aspect.heightDominant) w = h * r;
        else h = w / r;
      } else if (w / Math.max(h, 1e-6) > r) w = h * r;
      else h = w / r;
    }
    if (n.sizeMin) {
      w = Math.max(w, n.sizeMin[0] * k);
      h = Math.max(h, n.sizeMin[1] * k);
    }
    if (n.sizeMax) {
      w = Math.min(w, n.sizeMax[0] * k);
      h = Math.min(h, n.sizeMax[1] * k);
    }
    const own = ownScale(n);
    return { w: Math.max(0, w * own), h: Math.max(0, h * own), own };
  };

  const fontFor = (n: UiNode, w: number, h: number, k: number): number => {
    if (!isText(n)) return 0;
    // TextSize stops at 100 (a bigger one draws at 100: measured in Studio, a 250 watermark came out at 100); UIScale
    // scales what it draws.
    let s = n.scaled ? fitText(plainText(n), w, h, n, measure) : Math.min(100, n.textSize ?? 14) * k;
    if (n.textMin) s = Math.max(s, n.textMin * k);
    if (n.textMax) s = Math.min(s, n.textMax * k);
    return s;
  };

  // AutomaticSize: grows (never shrinks) to fit its text and its children, UIPadding included.
  const grown = (c: UiNode, w: number, h: number, k: number): { w: number; h: number } => {
    if (!c.auto) return { w, h };
    const p = c.padding;
    const [pt, pr, pb, pl] = p ? [u(p[0], h, k), u(p[1], w, k), u(p[2], h, k), u(p[3], w, k)] : [0, 0, 0, 0];
    let needW = 0;
    let needH = 0;
    if (isText(c) && !c.scaled) {
      const font = fontFor(c, w, h, k);
      const text = plainText(c);
      const lines = c.wrapped && c.auto === 'Y' ? wrapText(text, font, Math.max(1, w - pl - pr), c, measure) : text.split('\n');
      needW = pl + Math.max(0, ...lines.map((l) => measure(l, font, c))) + pr;
      needH = pt + lines.length * font * (c.lineHeight ?? 1) + pb;
    }
    for (const b of place(c, { x: 0, y: 0, w, h }, k).values()) {
      needW = Math.max(needW, b.x + b.w + pr);
      needH = Math.max(needH, b.y + b.h + pb);
    }
    return { w: c.auto === 'Y' ? w : Math.max(w, needW), h: c.auto === 'X' ? h : Math.max(h, needH) };
  };

  // A UIListLayout: lines (one, or as many as Wraps takes), grown or shrunk along the line (the
  // layout's Fill flex or each item's UIFlexItem), spread by the flex alignment or the padding, and
  // aligned across the line (Stretch: as thick as the line's thickest item).
  const placeList = (l: NonNullable<UiNode['list']>, kids: UiNode[], area: Area, k: number, measured: (c: UiNode) => { w: number; h: number; own: number }, placed: Map<UiNode, Placed>) => {
    const vertical = l.dir !== 'Horizontal';
    const main = vertical ? area.h : area.w;
    const across = vertical ? area.w : area.h;
    const gap = u(l.pad, main, k);
    const spread = vertical ? l.vFlex : l.hFlex;
    const mainAlign = vertical ? l.v : l.h;
    const crossAlign = vertical ? l.h : l.v;
    const items = sortKids(kids, l.byName).map((c) => {
      const s = measured(c);
      const mode = c.flex?.mode ?? (spread === 'Fill' ? 'Fill' : 'None');
      const grow = mode === 'Grow' || mode === 'Fill' ? 1 : mode === 'Custom' ? Math.max(0, c.flex?.grow ?? 0) : 0;
      const shrink = mode === 'Shrink' || mode === 'Fill' ? 1 : mode === 'Custom' ? Math.max(0, c.flex?.shrink ?? 0) : 0;
      const align: ItemAlign = c.flex?.align && c.flex.align !== 'Automatic' ? c.flex.align : (l.itemAlign ?? 'Automatic');
      return { c, m: vertical ? s.h : s.w, x: vertical ? s.w : s.h, own: s.own, grow, shrink, align };
    });
    const lines: (typeof items)[] = [];
    let line: typeof items = [];
    let used = 0;
    for (const it of items) {
      if (l.wraps && line.length && used + gap + it.m > main + 0.01) {
        lines.push(line);
        line = [];
        used = 0;
      }
      used += (line.length ? gap : 0) + it.m;
      line.push(it);
    }
    if (line.length) lines.push(line);
    const thick = lines.map((ln) => Math.max(0, ...ln.map((i) => i.x)));
    const block = thick.reduce((t, x) => t + x, 0) + gap * Math.max(0, lines.length - 1);
    let crossAt = crossAlign === 'Center' ? (across - block) / 2 : crossAlign === 'Right' || crossAlign === 'Bottom' ? across - block : 0;
    lines.forEach((ln, li) => {
      const free = main - ln.reduce((t, i) => t + i.m, 0) - gap * (ln.length - 1);
      const grows = ln.reduce((t, i) => t + i.grow, 0);
      const shrinks = ln.reduce((t, i) => t + i.shrink, 0);
      if (free > 0 && grows > 0) for (const i of ln) i.m += (free * i.grow) / grows;
      else if (free < 0 && shrinks > 0) for (const i of ln) i.m = Math.max(0, i.m + (free * i.shrink) / shrinks);
      // SpaceBetween/Around/Evenly share out what the items leave (the padding doesn't count).
      const spare = main - ln.reduce((t, i) => t + i.m, 0);
      const n = ln.length;
      let at: number;
      let step: number;
      if (spread === 'SpaceBetween' && spare > 0 && n > 1) [at, step] = [0, spare / (n - 1)];
      else if (spread === 'SpaceAround' && spare > 0) [at, step] = [spare / n / 2, spare / n];
      else if (spread === 'SpaceEvenly' && spare > 0) [at, step] = [spare / (n + 1), spare / (n + 1)];
      else {
        const total = main - spare + gap * (n - 1);
        [at, step] = [mainAlign === 'Center' ? (main - total) / 2 : mainAlign === 'Right' || mainAlign === 'Bottom' ? main - total : 0, gap];
      }
      const lt = thick[li]!;
      for (const i of ln) {
        const x = i.align === 'Stretch' ? lt : i.x;
        const a = i.align === 'Automatic' ? crossAlign : i.align;
        const off = a === 'Center' ? (lt - x) / 2 : a === 'End' || a === 'Right' || a === 'Bottom' ? lt - x : 0;
        placed.set(i.c, vertical ? { x: area.x + crossAt + off, y: area.y + at, w: x, h: i.m, own: i.own } : { x: area.x + at, y: area.y + crossAt + off, w: i.m, h: x, own: i.own });
        at += i.m + step;
      }
      crossAt += lt + gap;
    });
  };

  /** Where each shown child of `parent` lands in its box (not yet emitted). */
  const place = (parent: UiNode, box: Area, k: number): Map<UiNode, Placed> => {
    const placed = new Map<UiNode, Placed>();
    let kids = (parent.kids ?? []).filter(shown);
    // A Folder's GUI objects draw in the parent's (padded) area, outside its list or grid (measured in Studio).
    const flat = (list: UiNode[]): UiNode[] => list.flatMap((c) => (c.cls === 'Folder' ? flat((c.kids ?? []).filter(shown)) : [c]));
    const loose = flat(kids.filter((c) => c.cls === 'Folder'));
    kids = kids.filter((c) => c.cls !== 'Folder');
    if (parent.pages) {
      const page = pageShown(parent, opts.show);
      kids = page ? [page] : [];
    }
    if (!kids.length && !loose.length) return placed;
    // UIPadding shrinks the area children are placed in; a ScrollingFrame's children live on its canvas.
    const pad = parent.padding;
    let area: Area = pad
      ? {
          x: box.x + u(pad[3], box.w, k),
          y: box.y + u(pad[0], box.h, k),
          w: Math.max(0, box.w - u(pad[3], box.w, k) - u(pad[1], box.w, k)),
          h: Math.max(0, box.h - u(pad[0], box.h, k) - u(pad[2], box.h, k)),
        }
      : box;
    if (parent.cls === 'ScrollingFrame' && parent.canvas) {
      const c = parent.canvas;
      area = { ...area, w: Math.max(area.w, c[0] * box.w + c[1] * k), h: Math.max(area.h, c[2] * box.h + c[3] * k) };
    }
    const measured = (c: UiNode) => {
      const s = sizeOf(c, area, k);
      return { ...grown(c, s.w, s.h, k * s.own), own: s.own };
    };
    if (parent.pages) {
      // The page on show sits at the start; the others wait off to the side.
      const c = kids[0]!;
      placed.set(c, { ...measured(c), x: area.x, y: area.y });
    } else if (parent.grid) {
      const g = parent.grid;
      const ordered = sortKids(kids, g.byName);
      const cw = u([g.cell[0], g.cell[1]], area.w, k);
      const ch = u([g.cell[2], g.cell[3]], area.h, k);
      const px = u([g.pad[0], g.pad[1]], area.w, k);
      const py = u([g.pad[2], g.pad[3]], area.h, k);
      const horizontal = g.dir !== 'Vertical';
      const fit = Math.max(1, Math.floor(horizontal ? (area.w + px) / Math.max(1, cw + px) : (area.h + py) / Math.max(1, ch + py)));
      const per = g.max && g.max > 0 ? Math.min(g.max, fit) : fit;
      const n = ordered.length;
      const lines = Math.ceil(n / per);
      const cols = horizontal ? Math.min(n, per) : lines;
      const rows = horizontal ? lines : Math.min(n, per);
      const gw = cols * cw + Math.max(0, cols - 1) * px;
      const gh = rows * ch + Math.max(0, rows - 1) * py;
      const ox = area.x + (g.h === 'Center' ? (area.w - gw) / 2 : g.h === 'Right' ? area.w - gw : 0);
      const oy = area.y + (g.v === 'Center' ? (area.h - gh) / 2 : g.v === 'Bottom' ? area.h - gh : 0);
      ordered.forEach((c, i) => {
        const col = horizontal ? i % per : Math.floor(i / per);
        const row = horizontal ? Math.floor(i / per) : i % per;
        placed.set(c, { w: cw, h: ch, own: 1, x: ox + col * (cw + px), y: oy + row * (ch + py) });
      });
    } else if (parent.list) {
      placeList(parent.list, kids, area, k, measured, placed);
    } else {
      loose.unshift(...kids);
    }
    {
      for (const c of loose) {
        const s = measured(c);
        const p = c.pos ?? [0, 0, 0, 0];
        const a = c.anchor ?? [0, 0];
        placed.set(c, { ...s, x: area.x + p[0] * area.w + p[1] * k - a[0] * s.w, y: area.y + p[2] * area.h + p[3] * k - a[1] * s.h });
      }
    }
    return placed;
  };

  const lay = (parent: UiNode, box: Area, clip: UiBox['clip'], depth: number, k: number, path: string) => {
    const placed = place(parent, box, k);
    // Siblings draw by ZIndex (then in order); children over their parent.
    const drawOrder = [...placed.keys()].sort((a, b) => (a.z ?? 1) - (b.z ?? 1) || a.id - b.id);
    for (const c of drawOrder) {
      const s = placed.get(c)!;
      const kk = k * s.own;
      const b: UiBox = { node: c, path: `${path}.${c.name}`, x: s.x, y: s.y, w: s.w, h: s.h, rot: c.rot ?? 0, clip, order: seq++, fontSize: fontFor(c, s.w, s.h, kk), depth, k: kk };
      out.push(b);
      const clipsKids = (c.clips || c.cls === 'ScrollingFrame') && !b.rot;
      lay(c, { x: b.x, y: b.y, w: b.w, h: b.h }, clipsKids ? intersect(clip, [b.x, b.y, b.w, b.h]) : clip, depth + 1, kk, b.path);
    }
  };

  lay(screen, root, null, 0, ownScale(screen), screen.name);
  // ZIndexBehavior.Global: one ZIndex order across the whole ScreenGui.
  if (screen.global) {
    out.sort((a, b) => (a.node.z ?? 1) - (b.node.z ?? 1) || a.order - b.order);
    out.forEach((b, i) => (b.order = i));
  }
  return out;
}

function intersect(a: UiBox['clip'], b: [number, number, number, number]): [number, number, number, number] {
  if (!a) return b;
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const r = Math.min(a[0] + a[2], b[0] + b[2]);
  const btm = Math.min(a[1] + a[3], b[1] + b[3]);
  return [x, y, Math.max(0, r - x), Math.max(0, btm - y)];
}

// ─── Audit ────────────────────────────────────────────────────────────────────────────────────────

/** A screen the audit can check besides the named devices (the UI Lab's device matrix): its id names it in findings. */
export type AuditScreen = UiScreen & { id: string; phone?: boolean };

export interface UiFinding {
  severity: 'problem' | 'warning';
  /** The devices it happens on (empty: not about a screen size, e.g. contrast); an AuditScreen's id for those. */
  devices: UiDevice[];
  path: string;
  message: string;
  /** Found in a screen or menu that scripts show later (checked as if shown). */
  whenShown?: boolean;
}

const lum = ([r, g, b]: RGB) => {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/**
 * What a player would trip over, per device: things off the screen, buttons too small to tap on a
 * phone, text too small to read, cut off or hard to read against its background, buttons on top of
 * each other, and buttons under Roblox's own top bar buttons. Screens that scripts enable later, and
 * hidden menus (Visible = false under a shown parent), are checked as if shown, each on its own.
 */
export function auditUi(screens: UiNode[], devices: Array<UiDevice | AuditScreen> = ['phone', 'tablet', 'desktop'], measure: Measure = estimateText, opts: { /** The measure is Roblox's own (UI Lab): judge text against its padded box without the estimate's slack. */ exactText?: boolean } = {}): UiFinding[] {
  const idOf = (d: UiDevice | AuditScreen): UiDevice => (typeof d === 'string' ? d : (d.id as UiDevice));
  // A game whose scripts build its UI when a player joins has none in StarterGui: say so rather than "no UI".
  if (!screens.length) return [{ severity: 'warning', devices: [], path: 'StarterGui', message: 'No ScreenGuis here, so no UI yet unless scripts build it when a player joins (read it from a playtest to see that UI).' }];
  const found = new Map<string, UiFinding>();
  const add = (f: Omit<UiFinding, 'devices'>, device: UiDevice | null) => {
    const key = `${f.path}|${f.message.replace(/\d+(\.\d+)?/g, '#')}`;
    const prev = found.get(key);
    if (!prev) found.set(key, { ...f, devices: device ? [device] : [] });
    else {
      if (device && !prev.devices.includes(device)) prev.devices.push(device);
      if (f.severity === 'problem') prev.severity = 'problem';
    }
  };

  // Checks one screen as laid out with `show` forced visible, within `scope` (a subtree path) if given.
  const check = (screen: UiNode, target: UiDevice | AuditScreen, show: ReadonlySet<number>, scope: string | null, whenShown: boolean) => {
    const device = idOf(target);
    const dev: UiScreen = typeof target === 'string' ? UI_DEVICES[target] : target;
    const phone = typeof target === 'string' ? target === 'phone' || target === 'phonePortrait' : !!target.phone;
    const extra = whenShown ? { whenShown: true } : {};
    const boxes = layoutScreen(screen, dev, { measure, show }).filter((b) => !scope || b.path === scope || b.path.startsWith(`${scope}.`));
    const all = scope ? layoutScreen(screen, dev, { measure, show }) : boxes;
    const buttons: UiBox[] = [];
    for (const b of boxes) {
      const n = b.node;
      if (b.w < 1 || b.h < 1) continue;
      // Outside the screen (unless inside a scrolling list, which can bring it into view).
      const inScroll = !!b.clip && all.some((p) => p.node.cls === 'ScrollingFrame' && b.path.startsWith(`${p.path}.`));
      const vx = Math.max(0, Math.min(b.x + b.w, dev.w) - Math.max(b.x, 0));
      const vy = Math.max(0, Math.min(b.y + b.h, dev.h) - Math.max(b.y, 0));
      const visibleShare = (vx * vy) / (b.w * b.h);
      const matters = isButton(n) || (isText(n) && !!plainText(n).trim()) || b.depth === 0;
      if (matters && !inScroll && visibleShare < 0.7) add({ severity: visibleShare < 0.3 ? 'problem' : 'warning', path: b.path, message: `${Math.round((1 - visibleShare) * 100)}% off the screen`, ...extra }, device);
      // A button over most of the screen is a modal's backdrop (it catches clicks outside the window), not a target.
      if (isButton(n) && b.w * b.h < 0.5 * dev.w * dev.h) {
        buttons.push(b);
        if (phone && Math.min(b.w, b.h) < 36) add({ severity: 'warning', path: b.path, message: `Small to tap on a phone: ${Math.round(b.w)}×${Math.round(b.h)} points (aim for 44+)`, ...extra }, device);
        // Roblox's own buttons sit at the top left and right of the top bar.
        // A screen that covers the top bar (IgnoreGuiInset, or ScreenInsets None / DeviceSafeInsets).
        const coversTopbar = screen.ignoreInset || screen.insets === 'None' || screen.insets === 'DeviceSafeInsets';
        if (coversTopbar && b.y < (dev.top ?? 0) + TOPBAR && (b.x < 180 || b.x + b.w > dev.w - 120))
          add({ severity: 'warning', path: b.path, message: 'Sits under Roblox’s top bar buttons (its ScreenGui covers the top bar: move it down, or use ScreenInsets CoreUISafeInsets)', ...extra }, device);
      }
      // Some TVs crop the picture's edges: buttons and text keep inside the middle 90% [practice]. Only on
      // screens made for a TV (they declare FitTenFoot, as both kits do): a desktop-only screen isn't nagged.
      const tv = !!dev.tenFoot && !!screen.fit?.tenFoot;
      if (tv && !inScroll && (isButton(n) || (isText(n) && !!plainText(n).trim())) && b.w * b.h < 0.5 * dev.w * dev.h) {
        const mx = dev.w * 0.05;
        const my = dev.h * 0.05;
        if (b.x < mx - 1 || b.y < my - 1 || b.x + b.w > dev.w - mx + 1 || b.y + b.h > dev.h - my + 1)
          add({ severity: 'warning', path: b.path, message: 'Within 5% of a TV’s edge, which some TVs crop: keep text and buttons inside the middle 90% on a TV', ...extra }, device);
      }
      if (isText(n) && !n.scaled && (n.textSize ?? 0) > 100)
        add({ severity: 'warning', path: b.path, message: `TextSize ${n.textSize}: Roblox draws text at most 100 points (it shows at 100). For bigger type use TextScaled in a box that tall, a UIScale, or forged title art`, ...extra }, null);
      if (n.cls === 'ScrollingFrame' && n.auto && !n.sizeMax && (n.kids ?? []).length)
        add({ severity: 'warning', path: b.path, message: `AutomaticSize ${n.auto} on a ScrollingFrame grows the frame itself, not what scrolls: it never scrolls and pushes past its parent. Give it a size (scale, or a UISizeConstraint max) and set its canvas to the content's height`, ...extra }, null);
      if (isText(n) && plainText(n).trim()) {
        // Blind judges called 11- and 12.8-point labels "tiny" on an iPhone SE and passed 14: words a player reads
        // (not a 1-2 character count or number on a badge) want 13+, 14+ reads well.
        const words = plainText(n).trim().length > 2;
        if (phone && b.fontSize > 0 && (b.fontSize < 11 || (words && b.fontSize < 13))) add({ severity: 'warning', path: b.path, message: `Text is ${Math.round(b.fontSize * 10) / 10} points on a phone: reads tiny in a player's hand (14+ reads well)`, ...extra }, device);
        if (!n.scaled && !n.wrapped && !n.auto && !n.truncate && b.fontSize > 0) {
          const tw = Math.max(...plainText(n).split('\n').map((l) => measure(l, b.fontSize, n)));
          if (opts.exactText) {
            const pad = n.padding ? (n.padding[1][0] + n.padding[3][0]) * b.w + (n.padding[1][1] + n.padding[3][1]) * b.k : 0;
            const room = b.w - pad;
            if (tw > room + 1) add({ severity: 'warning', path: b.path, message: `Text runs out of its box: ${Math.round(tw)} points wide in ${Math.round(room)} (Roblox's own font)`, ...extra }, device);
          } else if (tw > b.w * 1.08 + 4) add({ severity: 'warning', path: b.path, message: `Text is cut off: about ${Math.round(tw)} points wide in a ${Math.round(b.w)}-point box`, ...extra }, device);
        }
        // TextTruncate ends what doesn't fit in "…" by design, but a line that loses a good part of itself on a
        // small screen loses what it says ("+1.5 s boost · M…").
        if (n.truncate && !n.scaled && !n.wrapped && !n.auto && b.fontSize > 0) {
          const tw = Math.max(...plainText(n).split('\n').map((l) => measure(l, b.fontSize, n)));
          const pad = n.padding ? (n.padding[1][0] + n.padding[3][0]) * b.w + (n.padding[1][1] + n.padding[3][1]) * b.k : 0;
          const room = b.w - pad;
          // Even a point too wide drops the last word for "…" ("MAX" shows as "M…").
          if (opts.exactText ? tw > room + 1 : tw > room * 1.1 + 4) add({ severity: 'warning', path: b.path, message: `Text ends in "…" here: ${Math.round(tw)} points wide in ${Math.round(room)}, so its end doesn't show (shorten it, or give it room on this screen)`, ...extra }, device);
        }
        const bg = n.bg && (n.bgT ?? 0) < 0.35 ? n.bg : null;
        if (bg && n.textColor && (n.textT ?? 0) < 0.5 && (n.strokeT ?? 1) > 0.6 && !strokesOf(n).some((s) => s.text && s.t < 0.6) && contrast(n.textColor, bg) < 3)
          add({ severity: 'warning', path: b.path, message: `Low contrast: text against its background is ${contrast(n.textColor, bg).toFixed(1)}:1 (4.5:1 reads well; a text stroke helps)`, ...extra }, null);
      }
    }
    // Top-level pieces running into each other (what each draws, children included): a HUD that a
    // small screen squeezes together. Backdrops and full-screen menus are left out.
    if (!scope) {
      const draws = (b: UiBox) => (!!b.node.bg && (b.node.bgT ?? 0) < 0.9) || (isText(b.node) && !!plainText(b.node).trim()) || !!b.node.image;
      const extents: Array<{ path: string; r: [number, number, number, number] }> = [];
      for (const t of boxes.filter((b) => b.depth === 0)) {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const b of boxes) {
          if ((b !== t && !b.path.startsWith(`${t.path}.`)) || !draws(b) || b.w <= 0 || b.h <= 0) continue;
          const [cx, cy, cw, ch] = b.clip ? intersect(b.clip, [b.x, b.y, b.w, b.h]) : [b.x, b.y, b.w, b.h];
          if (cw <= 0 || ch <= 0) continue;
          x0 = Math.min(x0, cx);
          y0 = Math.min(y0, cy);
          x1 = Math.max(x1, cx + cw);
          y1 = Math.max(y1, cy + ch);
        }
        if (x1 > x0 && y1 > y0 && (x1 - x0) * (y1 - y0) < 0.5 * dev.w * dev.h) extents.push({ path: t.path, r: [x0, y0, x1 - x0, y1 - y0] });
      }
      for (let i = 0; i < extents.length; i++)
        for (let j = i + 1; j < extents.length; j++) {
          const a = extents[i]!.r;
          const c = extents[j]!.r;
          const ox = Math.max(0, Math.min(a[0] + a[2], c[0] + c[2]) - Math.max(a[0], c[0]));
          const oy = Math.max(0, Math.min(a[1] + a[3], c[1] + c[3]) - Math.max(a[1], c[1]));
          const share = (ox * oy) / Math.max(1, Math.min(a[2] * a[3], c[2] * c[3]));
          if (share > 0.08) add({ severity: share > 0.3 ? 'problem' : 'warning', path: extents[i]!.path, message: `Runs into ${extents[j]!.path}: ${Math.round(share * 100)}% of the smaller one is covered`, ...extra }, device);
        }
    }
    // Content spilling out of the panel it sits in (a list taller than its window on a phone draws its rows below the
    // window's frame): nearly all of it past the bottom or right edge of the nearest drawn panel at least three times its
    // size. A sticker hanging off a card's corner, a title plate or tabs over a window's top, or a dropdown under a
    // button isn't one.
    {
      const byPath = new Map(all.map((b) => [b.path, b]));
      const panelOf = (b: UiBox): UiBox | null => {
        for (let p = b.path.lastIndexOf('.'); p > 0; p = b.path.lastIndexOf('.', p - 1)) {
          const a = byPath.get(b.path.slice(0, p));
          if (a && (a.node.skinned !== undefined || (!!a.node.bg && (a.node.bgT ?? 0) < 0.5)) && Math.min(a.w, a.h) >= 24 && a.w * a.h < 0.9 * dev.w * dev.h && a.w * a.h >= 3 * b.w * b.h) return a;
        }
        return null;
      };
      const spilled: string[] = [];
      for (const c of boxes) {
        if (c.node.decor || c.w < 4 || c.h < 4 || spilled.some((p) => c.path.startsWith(`${p}.`))) continue;
        const shows = (isText(c.node) && !!plainText(c.node).trim()) || !!c.node.image || isButton(c.node) || c.node.skinned !== undefined || (!!c.node.bg && (c.node.bgT ?? 0) < 0.5);
        if (!shows) continue;
        const p = panelOf(c);
        if (!p) continue;
        const [cx, cy, cw, ch] = c.clip ? intersect(c.clip, [c.x, c.y, c.w, c.h]) : [c.x, c.y, c.w, c.h];
        if (cw <= 1 || ch <= 1) continue;
        const ox = Math.max(0, Math.min(cx + cw, p.x + p.w) - Math.max(cx, p.x));
        const oy = Math.max(0, Math.min(cy + ch, p.y + p.h) - Math.max(cy, p.y));
        const outside = 1 - (ox * oy) / (cw * ch);
        const below = cy + ch - (p.y + p.h);
        const right = cx + cw - (p.x + p.w);
        if (outside > 0.85 && Math.max(below, right) > 12) {
          spilled.push(c.path);
          const edge = below >= right ? 'bottom' : 'right';
          add({ severity: outside > 0.95 ? 'problem' : 'warning', path: c.path, message: `Spills out of ${p.path}: ${Math.round(outside * 100)}% of it is drawn past the panel's ${edge} edge (fit it inside, or clip it in a ScrollingFrame no bigger than the panel)`, ...extra }, device);
        }
      }
    }
    // Small content drawn under a button that covers it (a level pip under a price button a small screen pushed
    // over it): not the button's own content, nor a shadow or plate the size of the button behind it.
    for (const bt of buttons) {
      for (const c of boxes) {
        if (c.order >= bt.order || c.node.decor || c.w < 2 || c.h < 2) continue;
        if (c.path.startsWith(`${bt.path}.`) || bt.path.startsWith(`${c.path}.`)) continue;
        const shows = (isText(c.node) && !!plainText(c.node).trim()) || !!c.node.image || c.node.skinned !== undefined || (!!c.node.bg && (c.node.bgT ?? 0) < 0.5);
        if (!shows || c.w * c.h > 0.6 * bt.w * bt.h) continue;
        const [cx, cy, cw, ch] = c.clip ? intersect(c.clip, [c.x, c.y, c.w, c.h]) : [c.x, c.y, c.w, c.h];
        if (cw <= 1 || ch <= 1) continue;
        // A skinned button's art (its outline, 3D side and shadow) reaches past its box.
        const e = Math.min(10, (bt.node.skinned ?? 0) * 0.6) * bt.k;
        const ox = Math.max(0, Math.min(cx + cw, bt.x + bt.w + e) - Math.max(cx, bt.x - e));
        const oy = Math.max(0, Math.min(cy + ch, bt.y + bt.h + e) - Math.max(cy, bt.y - e));
        const share = (ox * oy) / (cw * ch);
        if (share > 0.3) add({ severity: share > 0.6 ? 'problem' : 'warning', path: c.path, message: `Hidden under ${bt.path}: ${Math.round(share * 100)}% of it is covered by the button`, ...extra }, device);
      }
    }
    // Buttons covering each other (not one inside the other).
    for (let i = 0; i < buttons.length; i++)
      for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i]!;
        const c = buttons[j]!;
        if (a.path.startsWith(`${c.path}.`) || c.path.startsWith(`${a.path}.`)) continue;
        const ox = Math.max(0, Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x));
        const oy = Math.max(0, Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y));
        const share = (ox * oy) / Math.max(1, Math.min(a.w * a.h, c.w * c.h));
        if (share > 0.25) add({ severity: 'problem', path: a.path, message: `Overlaps ${c.path}: ${Math.round(share * 100)}% of the smaller button is covered`, ...extra }, device);
      }
  };

  // The hidden elements a script may show: the top-most Visible = false ones under shown parents,
  // and the pages of a UIPageLayout other than the one on show.
  const hiddenRoots = (screen: UiNode): Array<{ node: UiNode; path: string }> => {
    const out: Array<{ node: UiNode; path: string }> = [];
    const walk = (n: UiNode, path: string) => {
      const page = n.pages ? pageShown(n) : null;
      for (const c of n.kids ?? []) {
        const p = `${path}.${c.name}`;
        if (c.visible === false || (page && c !== page)) out.push({ node: c, path: p });
        else walk(c, p);
      }
    };
    walk(screen, screen.name);
    return out;
  };
  const none = new Set<number>();
  // A UIScale a script sets for the screen, captured on Studio's window: every device gets that value.
  for (const screen of screens)
    if (screen.scale !== undefined && screen.scale !== 1 && !screen.fit)
      add({ severity: 'warning', path: screen.name, message: `Its UIScale (${screen.scale}) was laid out at that value on every device: if a script fits it to the screen, give the UIScale FitReference (Vector2) and FitRange (NumberRange) attributes matching the script so the audit fits it per device (skill roblox-ui-design)` }, null);
  for (const device of devices)
    for (const screen of screens) {
      const later = screen.enabled === false;
      check(screen, device, none, null, later);
      for (const h of hiddenRoots(screen)) check(screen, device, new Set([h.node.id]), h.path, true);
    }
  // Looping animations (Motion's MotionLoops) still running where nothing shows them: a screen that closed
  // without stopping its motion scope keeps tweening every frame (and leaks when the screen is rebuilt).
  for (const screen of screens) {
    const walk = (n: UiNode, path: string, hidden: boolean) => {
      const off = hidden || n.visible === false;
      if (off && n.loops && n.loops > 0)
        add({ severity: 'warning', path, message: `${n.loops} looping animation${n.loops === 1 ? '' : 's'} still running while it is hidden: stop them when the screen closes (a Motion scope tied to the screen or window does it)` }, null);
      for (const c of n.kids ?? []) walk(c, `${path}.${c.name}`, off);
    };
    walk(screen, screen.name, screen.enabled === false);
  }
  // Wholly off every screen is parked, not misplaced: a toast or menu waiting above or beside the
  // screen for a script to slide it in (a real layout slip shows on some screens and not others).
  for (const f of found.values())
    if (f.message === '100% off the screen' && devices.every((d) => f.devices.includes(idOf(d)))) {
      f.severity = 'warning';
      f.message = 'Off the screen on every device: parked for a script to slide it in? Then check it where it ends up (read the UI again while it is shown)';
    }
  return [...found.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1) || Number(!!a.whenShown) - Number(!!b.whenShown));
}

/** A UI read from Studio: its ScreenGuis, where they came from, and what the audit found. */
export interface UiSnapshot {
  /** StarterGui in Edit, or a playing client's PlayerGui (UI that scripts build). */
  source: 'StarterGui' | 'PlayerGui';
  screens: UiNode[];
  count: number;
  truncated: boolean;
  capturedAt: string;
  findings: UiFinding[];
  /** The devices the findings were checked on (older snapshots: phone, tablet, desktop). */
  audited?: UiDevice[];
  /** StarterGui.ScreenOrientation (or the playing client's PlayerGui.ScreenOrientation) when it was read. */
  orientation?: string | null;
}

/** Every node of a capture, depth first. */
export function* walkUi(n: UiNode): Generator<UiNode> {
  yield n;
  for (const c of n.kids ?? []) yield* walkUi(c);
}
