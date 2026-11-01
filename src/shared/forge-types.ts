/**
 * The Forge's recipe types, as the GPU forge reads them. They are the CPU engine's own (src/core/ui/forge/: ShapeSpec
 * in shapes.ts, LayerStyle in style.ts, Pattern and Texture in textures.ts, ForgeSpec and Forged in forge.ts),
 * restated here for the renderer (whose typecheck can't load those files: they import node:fs and node:zlib) and the
 * plans (forge-plan.ts); tests/forge-gl.test.ts fails when the two drift apart.
 */

export type Pt = [number, number];

export type Blend = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'softlight' | 'hardlight' | 'lighten' | 'darken' | 'colordodge';

export type Color = string | [number, number, number];
export type Stop = [t: number, color: Color] | [t: number, color: Color, alpha: number];

export interface Gradient {
  type?: 'linear' | 'radial' | 'conic' | 'reflected' | 'diamond';
  angle?: number;
  stops: Stop[];
  center?: [number, number];
  scale?: number;
}

export type Paint = Color | Gradient;

export type TextureKind = 'noise' | 'clouds' | 'wood' | 'brushed' | 'stone' | 'cells' | 'fabric' | 'marble' | 'scratches' | 'rust' | 'camo' | 'carbon' | 'caustics' | 'paper' | 'leather' | 'hammered' | 'speckle' | 'pixels';

export interface Texture {
  kind: TextureKind;
  scale?: number;
  angle?: number;
  seed?: number;
  opacity?: number;
  blend?: Blend;
  color?: Color;
  ramp?: Stop[];
  contrast?: number;
  invert?: boolean;
  density?: number;
  relief?: number;
}

export type PatternKind = 'stripes' | 'dots' | 'checker' | 'grid' | 'hex' | 'diamonds' | 'waves' | 'bricks' | 'scales' | 'bubbles' | 'stars' | 'hearts' | 'chevron' | 'crosshatch' | 'plaid' | 'confetti' | 'studs' | 'scanlines' | 'zigzag' | 'triangles' | 'sparkles';

export interface Pattern {
  kind: PatternKind;
  color: Color;
  opacity?: number;
  size?: number;
  angle?: number;
  blend?: Blend;
  duty?: number;
  seed?: number;
  offset?: [number, number];
}

export interface StrokeStyle {
  width: number;
  paint: Paint;
  position?: 'outside' | 'inside' | 'center';
  opacity?: number;
}

export interface LayerStyle {
  fill: Paint;
  fillOpacity?: number;
  patterns?: Pattern[];
  textures?: Texture[];
  grain?: { amount: number; scale?: number; blend?: Blend };
  overlays?: Array<{ paint: Paint; blend?: Blend; opacity?: number }>;
  extrude?: { depth: number; color: Paint; angle?: number; stroke?: { width: number; color: Color } };
  bevel?: {
    size: number;
    depth?: number;
    angle?: number;
    altitude?: number;
    highlight?: Color;
    highlightOpacity?: number;
    shadow?: Color;
    shadowOpacity?: number;
    style?: 'smooth' | 'chisel' | 'pillow' | 'round';
    specular?: number;
  };
  innerShadow?: { color: Color; opacity?: number; size: number; offset?: [number, number] };
  innerGlow?: { color: Color; opacity?: number; size: number; blend?: Blend };
  wear?: { amount: number; color: Color; width?: number; scale?: number; seed?: number; opacity?: number };
  gloss?: { opacity?: number; height?: number; inset?: number; color?: Color; curve?: number; style?: 'arc' | 'band' | 'spot' | 'glass' };
  sheen?: { opacity?: number; angle?: number; width?: number; at?: number; color?: Color };
  rim?: { width: number; color?: Color; opacity?: number; angle?: number; falloff?: number; shade?: Color; shadeOpacity?: number; hard?: boolean };
  strokes?: StrokeStyle[];
  sparkles?: { count?: number; size?: number; color?: Color; opacity?: number; seed?: number; area?: 'inside' | 'top' | 'edge' | 'around'; glow?: number };
  cutouts?: Pattern[];
  outerGlow?: { color: Color; opacity?: number; size: number; spread?: number };
  dropShadow?: { color: Color; opacity?: number; offset?: [number, number]; blur: number; spread?: number };
  roughen?: { amount: number; scale?: number; seed?: number };
}

export type ShapeSpec =
  | { kind: 'rect'; radius?: number | [number, number, number, number] }
  | { kind: 'pill' }
  | { kind: 'ellipse' }
  | { kind: 'cut'; cut: number | [number, number, number, number]; slant?: [number, number] }
  | { kind: 'shield'; radius?: number; point?: number }
  | { kind: 'hex'; point?: number }
  | { kind: 'burst'; points?: number; inner?: number; round?: number }
  | { kind: 'ribbon'; notch?: number; fold?: number }
  | { kind: 'tab'; radius?: number }
  | { kind: 'bubble'; radius?: number; tail?: [number, number, number] }
  | { kind: 'scallop'; radius?: number; scallop?: number; side?: 'bottom' | 'top' }
  | { kind: 'cross'; thickness?: number; radius?: number }
  | { kind: 'glyph'; name: string; weight?: number; solid?: boolean }
  | { kind: 'brackets'; length?: number; thickness?: number; inset?: number }
  | { kind: 'rivets'; radius?: number; inset?: number; spacing?: number }
  | { kind: 'gem' }
  | { kind: 'frame'; thickness: number; radius?: number }
  | { kind: 'star'; points?: number; inner?: number; round?: number }
  | { kind: 'sparkle'; points?: 4 | 8; pinch?: number }
  | { kind: 'heart' }
  | { kind: 'polygon'; points: Array<[number, number]>; round?: number }
  | { kind: 'puffy'; bump?: number; radius?: number }
  | { kind: 'torn'; rough?: number; seed?: number; radius?: number; detail?: number }
  | { kind: 'drip'; drips?: number; length?: number; seed?: number; radius?: number }
  | { kind: 'wave'; amplitude?: number; period?: number; side?: 'top' | 'bottom' | 'both'; radius?: number }
  | { kind: 'studs'; cols?: number; rows?: number; radius?: number }
  | { kind: 'leaf'; angle?: number }
  | { kind: 'ring'; thickness: number }
  | { kind: 'stairs'; step: number; steps?: number }
  | { kind: 'arrow'; dir?: 'right' | 'left' | 'up' | 'down'; head?: number; shaft?: number }
  | { kind: 'text'; text: string; font?: string; weight?: number; italic?: boolean; size?: number; tracking?: number; snap?: number };

export interface ForgeLayer {
  shape: ShapeSpec;
  style: LayerStyle;
  at?: [x: number, y: number, w: number, h: number];
}

export interface PixelArt {
  size: number;
  levels?: number;
  dither?: boolean;
  threshold?: number;
}

export interface ForgeSpec {
  size: [number, number];
  layers: ForgeLayer[];
  scale?: number;
  slice?: boolean;
  pixel?: number | PixelArt;
  content?: [x: number, y: number, w: number, h: number];
}

/** Straight-alpha 8-bit RGBA, rows top first (the core's RgbaImage). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** What `forge` returns (the CPU engine's Forged). */
export interface Forged {
  image: RgbaImage;
  size: [number, number];
  margin: number;
  scale: number;
  slice: [number, number, number, number] | null;
  drawn?: [number, number];
  content?: [number, number, number, number];
}

/** Contours packed for transfer: x, y pairs, and how many points each closed contour has. */
export interface PackedContours {
  points: Float32Array;
  counts: Uint32Array;
}

/** A coverage bitmap (0..1 floats, or 0..255 bytes), rows top first. */
export interface CoverageBitmap {
  coverage: Float32Array | Uint8Array;
  width: number;
  height: number;
}
