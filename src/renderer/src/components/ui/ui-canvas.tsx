import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { isText, layoutScreen, plainText, shapePolygon, strokesOf, TOPBAR, withState, type Measure, type RGB, type UiBox, type UiNode, type UiScreen, type UiStateName } from '@shared/ui-layout';
import { rpc } from '../../lib/rpc';
import { canvasSize, childrenInState, isSkinRef, pngSize, sliceCss, slicePlan } from '../../lib/skin-css';

/** A CSS font close to a Roblox font (Enum.Font name or FontFace family); the preview has no Roblox fonts. */
export function cssFont(n: UiNode): { family: string; weight: number; style: string } {
  const f = (n.font ?? 'SourceSans').toLowerCase();
  const display = /luckiest|fredoka|bangers|titan|creepster|cartoon|comic|denk|permanent/.test(f);
  const weight = /black|heavy/.test(f) ? 900 : n.bold || display || /bold/.test(f) ? 700 : /medium|semi/.test(f) ? 600 : 400;
  const family = /mono|code/.test(f)
    ? 'Consolas, "Cascadia Mono", monospace'
    : /arcade|pixel|press/.test(f)
      ? '"Lucida Console", Consolas, monospace'
      : /garamond|merriweather|antique|sarpanch|fantasy|bodoni|playfair/.test(f)
        ? 'Georgia, "Times New Roman", serif'
        : display
          ? '"Segoe UI Black", "Arial Black", "Segoe UI", sans-serif'
          : '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
  return { family, weight, style: n.italic ? 'italic' : 'normal' };
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Text widths in the fonts the preview draws with, for the shared layout (TextScaled, audits). */
export const measureCss: Measure = (text, size, node) => {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * size * 0.52;
  const f = cssFont(node);
  measureCtx.font = `${f.style} ${f.weight} ${size}px ${f.family}`;
  return measureCtx.measureText(text).width;
};

const rgba = (c: RGB | undefined, a: number) => (c ? `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})` : 'transparent');
const isWhite = (c?: RGB) => !c || (c[0] > 250 && c[1] > 250 && c[2] > 250);

/** UIGradient as CSS: its colours multiply the element's, its transparency fades it; 0° runs left to right. */
function gradientCss(n: Pick<UiNode, 'gradient'>, base: RGB, alpha: number): string | undefined {
  const g = n.gradient;
  if (!g) return undefined;
  const times = [...new Set([...g.colors.map((c) => c[0]), ...(g.transp ?? []).map((t) => t[0])])].sort((a, b) => a - b);
  const at = <T extends number[]>(seq: T[], t: number, pick: (k: T) => number[]): number[] => {
    if (!seq.length) return [];
    let i = 0;
    while (i < seq.length - 1 && seq[i + 1]![0]! <= t) i++;
    const a = seq[i]!;
    const b = seq[Math.min(i + 1, seq.length - 1)]!;
    const span = b[0]! - a[0]!;
    const f = span > 0 ? Math.max(0, Math.min(1, (t - a[0]!) / span)) : 0;
    return pick(a).map((v, j) => v + (pick(b)[j]! - v) * f);
  };
  const stops = times.map((t) => {
    const [r, gg, b] = g.colors.length ? at(g.colors, t, (k) => [k[1], k[2], k[3]]) : [255, 255, 255];
    const tr = g.transp?.length ? at(g.transp, t, (k) => [k[1]])[0]! : 0;
    const c: RGB = [(base[0] * r!) / 255, (base[1] * gg!) / 255, (base[2] * b!) / 255];
    return `${rgba(c.map(Math.round) as RGB, alpha * (1 - tr))} ${(t * 100).toFixed(1)}%`;
  });
  if (g.type === 'Radial') return `radial-gradient(closest-side, ${stops.join(', ')})`;
  if (g.type === 'Conical') return `conic-gradient(from ${90 + g.rot}deg, ${stops.join(', ')})`;
  return `linear-gradient(${90 + g.rot}deg, ${stops.join(', ')})`;
}

/** A shaped panel as SVG: its fill (with its gradient) and its strokes, Outer ones outside it and Inner ones inside. */
function ShapeSvg({ n, b }: { n: UiNode; b: UiBox }) {
  const strokes = strokesOf(n).filter((s) => !s.text && s.t < 1);
  const pad = Math.max(0, ...strokes.map((s) => s.px * b.k));
  const pts = shapePolygon(n.shape!, b.w, b.h, b.k);
  const poly = pts.map(([x, y]) => `${x + pad},${y + pad}`).join(' ');
  const id = `s${n.id}`;
  const bgA = n.bg ? 1 - (n.bgT ?? 0) : 0;
  const grad = (key: string, g: UiNode['gradient'], base: RGB, alpha: number) => {
    if (!g) return null;
    const css = gradientCss({ gradient: g }, base, alpha);
    // SVG gradients from the CSS stops: rotation as gradientTransform about the middle.
    const stops = [...(css ?? '').matchAll(/(rgba\([^)]*\)) ([\d.]+)%/g)].map((m, i) => <stop key={i} offset={`${m[2]}%`} stopColor={m[1]} />);
    return g.type === 'Radial' ? (
      <radialGradient id={key} cx="50%" cy="50%" r="50%">
        {stops}
      </radialGradient>
    ) : (
      <linearGradient id={key} gradientTransform={`rotate(${g.rot} 0.5 0.5)`}>
        {stops}
      </linearGradient>
    );
  };
  return (
    <svg className="pointer-events-none absolute overflow-visible" style={{ left: -pad, top: -pad, width: b.w + 2 * pad, height: b.h + 2 * pad }}>
      <defs>
        <clipPath id={`${id}-in`}>
          <polygon points={poly} />
        </clipPath>
        <mask id={`${id}-out`}>
          <rect x={-1} y={-1} width={b.w + 2 * pad + 2} height={b.h + 2 * pad + 2} fill="white" />
          <polygon points={poly} fill="black" />
        </mask>
        {bgA > 0 && n.bg && grad(`${id}-fill`, n.gradient, n.bg, bgA)}
        {strokes.map((s, i) => grad(`${id}-st${i}`, s.gradient, s.color, 1 - s.t))}
      </defs>
      {bgA > 0 && n.bg && <polygon points={poly} fill={n.gradient ? `url(#${id}-fill)` : rgba(n.bg, bgA)} />}
      {strokes.map((s, i) => {
        const pos = s.pos ?? 'Outer';
        const paint = s.gradient ? `url(#${id}-st${i})` : rgba(s.color, 1 - s.t);
        const width = pos === 'Center' ? s.px * b.k : 2 * s.px * b.k;
        return <polygon key={i} points={poly} fill="none" stroke={paint} strokeWidth={width} strokeLinejoin="round" {...(pos === 'Inner' ? { clipPath: `url(#${id}-in)` } : pos === 'Outer' ? { mask: `url(#${id}-out)` } : {})} />;
      })}
    </svg>
  );
}

/** Roblox rich text as React elements: the formatting tags Roblox supports, everything else as plain text. */
function richText(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const stack: CSSProperties[] = [{}];
  const style = () => Object.assign({}, ...stack) as CSSProperties;
  const re = /<\s*(\/?)\s*([a-z]+)([^>]*)>/gi;
  let last = 0;
  let key = 0;
  const push = (text: string) => {
    const t = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    if (t) out.push(<span key={key++} style={style()}>{t}</span>);
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    push(src.slice(last, m.index));
    last = re.lastIndex;
    const [, close, tag, attrs] = m;
    const name = tag!.toLowerCase();
    if (name === 'br') {
      out.push(<br key={key++} />);
      continue;
    }
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attr = (a: string) => new RegExp(`${a}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs ?? '')?.[1];
    const s: CSSProperties = {};
    if (name === 'b') s.fontWeight = 700;
    else if (name === 'i') s.fontStyle = 'italic';
    else if (name === 'u') s.textDecoration = 'underline';
    else if (name === 's') s.textDecoration = 'line-through';
    else if (name === 'uc' || name === 'uppercase') s.textTransform = 'uppercase';
    else if (name === 'sc' || name === 'smallcaps') s.fontVariant = 'small-caps';
    else if (name === 'font') {
      const color = attr('color');
      if (color && /^(#[0-9a-f]{3,8}|rgb\([\d\s,]+\))$/i.test(color)) s.color = color;
      const size = Number(attr('size'));
      if (size > 0 && size < 400) s.fontSize = size;
      const w = attr('weight');
      if (w) s.fontWeight = /bold|heavy|black/i.test(w) ? 700 : /medium|semi/i.test(w) ? 600 : Number(w) || 400;
    } else if (name === 'mark') {
      const color = attr('color');
      if (color && /^#[0-9a-f]{3,8}$/i.test(color)) s.backgroundColor = color;
    }
    stack.push(s);
  }
  push(src.slice(last));
  return out;
}

/** A state's scale on an element or an ancestor: the element and everything in it scale about that element's AnchorPoint. */
export interface StateScale {
  scale: number;
  /** The scaled element's AnchorPoint, in this element's own pixels from its top left. */
  ox: number;
  oy: number;
}

const decoded = new Map<string, HTMLImageElement>();
/** A data URL as a decoded image, shared by every canvas that draws it. */
function imageOf(url: string): HTMLImageElement {
  let img = decoded.get(url);
  if (!img) {
    if (decoded.size > 600) decoded.delete(decoded.keys().next().value!);
    img = new Image();
    img.src = url;
    decoded.set(url, img);
  }
  return img;
}

/** Forged 9-slice art in one canvas bitmap at the board's pixel density: Roblox's slicing, without seams. */
function SliceArt({ url, w, h, n, b, zoom, opacity }: { url: string; w: number; h: number; n: UiNode; b: UiBox; zoom: number; opacity: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = canvasSize(b.w, b.h, Math.round(zoom * 100) / 100);
  const plan = JSON.stringify(slicePlan({ w, h, slice: n.slice!, sliceScale: n.sliceScale, k: b.k, ...size }));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const img = imageOf(url);
    const draw = () => {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      for (const [sx, sy, sw, sh, dx, dy, dw, dh] of JSON.parse(plan) as number[][]) ctx.drawImage(img, sx!, sy!, sw!, sh!, dx!, dy!, dw!, dh!);
    };
    if (img.complete && img.naturalWidth) draw();
    else {
      img.addEventListener('load', draw);
      return () => img.removeEventListener('load', draw);
    }
  }, [url, plan, size.cw, size.ch]);
  return <canvas ref={ref} width={size.cw} height={size.ch} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity }} />;
}

/** A spring's overshoot, as the kit's press and hover feel. */
const STATE_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

function Element({ b, image, state, group, zoom = 0 }: { b: UiBox; image: string | null | undefined; state?: UiStateName | null; group?: StateScale | null; /** Screen pixels per point (the board's scale times the display's): sliced art is drawn at it. */ zoom?: number }) {
  // The element as it looks in its state (hover, press, selected): the state's colours, strokes and fills; its
  // scale is the group transform, so the layout doesn't move under the pointer.
  const n = state ? { ...withState(b.node, state), scale: b.node.scale } : b.node;
  if (b.w <= 0 || b.h <= 0) return null;
  const style: CSSProperties = { position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h };
  // Scaled about the anchor (moved there from the centre and back), then turned about the centre.
  const parts: string[] = [];
  if (group && group.scale !== 1) {
    const dx = group.ox - b.w / 2;
    const dy = group.oy - b.h / 2;
    parts.push(`translate(${dx}px, ${dy}px) scale(${group.scale}) translate(${-dx}px, ${-dy}px)`);
  }
  if (b.rot) parts.push(`rotate(${b.rot}deg)`);
  if (parts.length) style.transform = parts.join(' ');
  if (group) style.transition = `transform 160ms ${STATE_EASE}, background-color 100ms, box-shadow 100ms, color 100ms, opacity 100ms`;
  if (b.clip) {
    const [cx, cy, cw, ch] = b.clip;
    if (cw <= 0 || ch <= 0) return null;
    const top = Math.max(0, cy - b.y);
    const left = Math.max(0, cx - b.x);
    const right = Math.max(0, b.x + b.w - (cx + cw));
    const bottom = Math.max(0, b.y + b.h - (cy + ch));
    if (left >= b.w || top >= b.h || right >= b.w || bottom >= b.h) return null;
    if (top || left || right || bottom) style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
  }
  const bgA = n.bg ? 1 - (n.bgT ?? 0) : 0;
  const shaped = !!(n.shape && (n.shape.cut || n.shape.slant));
  const shadows: string[] = [];
  if (bgA > 0 && n.bg && !shaped) {
    style.backgroundColor = rgba(n.bg, bgA);
    const g = gradientCss(n, n.bg, bgA);
    if (g) {
      style.backgroundColor = 'transparent';
      style.backgroundImage = g;
    }
    if (n.border && n.border > 0) shadows.push(`0 0 0 ${n.border}px ${rgba(n.borderColor ?? [27, 42, 53], bgA)}`);
  }
  const radius = (u: [number, number] | undefined) => Math.max(0, u ? u[0] * Math.min(b.w, b.h) + u[1] * b.k : 0);
  if (n.corners) style.borderRadius = n.corners.map((c) => `${radius(c)}px`).join(' ');
  else if (n.corner) style.borderRadius = radius(n.corner);
  // UIStrokes round the box (highest ZIndex on top, as box-shadow lists them first): Outer outside, Inner inside, Center across the edge.
  if (!shaped)
    for (const s of [...strokesOf(n)].reverse()) {
      if (s.text && isText(n)) continue;
      if (s.t >= 1) continue;
      // A stroke's own gradient is shown by its first colour (the picture the tools return draws it whole).
      const c = s.gradient?.colors.length ? ([s.gradient.colors[0]![1], s.gradient.colors[0]![2], s.gradient.colors[0]![3]] as RGB).map((v, i) => (v * s.color[i]!) / 255) : s.color;
      const col = rgba(c as RGB, 1 - s.t);
      const px = s.px * b.k;
      const pos = s.pos ?? 'Outer';
      if (pos === 'Inner') shadows.unshift(`inset 0 0 0 ${px}px ${col}`);
      else if (pos === 'Center') shadows.push(`0 0 0 ${px / 2}px ${col}`, `inset 0 0 0 ${px / 2}px ${col}`);
      else shadows.push(`0 0 0 ${px}px ${col}`);
    }
  // UIShadow: a soft shadow (or, offset 0, a glow) round the box, never under it.
  if (n.shadow && n.shadow.t < 1) shadows.push(`${(n.shadow.offset?.[0] ?? 0) * b.k}px ${(n.shadow.offset?.[1] ?? 0) * b.k}px ${n.shadow.blur * b.k}px ${(n.shadow.spread ?? 0) * b.k}px ${rgba(n.shadow.color, 1 - n.shadow.t)}`);
  if (shadows.length) style.boxShadow = shadows.join(', ');

  let content: ReactNode = null;
  if (isText(n)) {
    const f = cssFont(n);
    const textA = 1 - (n.textT ?? 0);
    const t: CSSProperties = {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: n.yAlign === 'Top' ? 'flex-start' : n.yAlign === 'Bottom' ? 'flex-end' : 'center',
      textAlign: n.xAlign === 'Left' ? 'left' : n.xAlign === 'Right' ? 'right' : 'center',
      color: rgba(n.textColor ?? [0, 0, 0], textA),
      fontFamily: f.family,
      fontWeight: f.weight,
      fontStyle: f.style,
      fontSize: b.fontSize,
      lineHeight: 1,
      whiteSpace: n.wrapped || n.scaled ? 'pre-wrap' : 'pre',
      overflowWrap: 'break-word',
    };
    // The widest outline round the letters (CSS draws one; the tools' pictures draw them all).
    const textStroke = strokesOf(n)
      .filter((s) => s.text && s.t < 1)
      .sort((a, c) => c.px - a.px)[0];
    if (textStroke) {
      t.WebkitTextStroke = `${textStroke.px * 2 * b.k}px ${rgba(textStroke.color, 1 - textStroke.t)}`;
      t.paintOrder = 'stroke fill';
    } else if ((n.strokeT ?? 1) < 1) {
      t.WebkitTextStroke = `${Math.max(1, b.fontSize / 14)}px ${rgba(n.strokeColor ?? [0, 0, 0], 1 - (n.strokeT ?? 1))}`;
      t.paintOrder = 'stroke fill';
    }
    // A gradient on text with no background colours the letters.
    if (n.gradient && bgA <= 0) {
      t.backgroundImage = gradientCss(n, n.textColor ?? [255, 255, 255], textA);
      t.WebkitBackgroundClip = 'text';
      t.color = 'transparent';
    }
    content = <div style={t}>{n.rich ? <span>{richText(n.text ?? '')}</span> : plainText(n)}</div>;
  } else if (isSkinRef(n.image)) {
    // Forged skin art: 9-sliced as Roblox does it (CSS border-image), or stretched; nothing until it has arrived.
    const imgA = 1 - (n.imageT ?? 0);
    const sz = image ? pngSize(image) : null;
    if (image && sz && n.scaleType === 'Slice' && n.slice)
      content = zoom > 0 ? <SliceArt url={image} w={sz.w} h={sz.h} n={n} b={b} zoom={zoom} opacity={imgA} /> : <div style={{ position: 'absolute', inset: 0, opacity: imgA, ...sliceCss({ url: image, w: sz.w, h: sz.h, slice: n.slice, sliceScale: n.sliceScale, k: b.k }) }} />;
    else if (image) content = <img src={image} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', opacity: imgA }} />;
  } else if (n.image !== undefined && n.image !== '') {
    const fit = n.scaleType === 'Fit' ? 'contain' : n.scaleType === 'Crop' ? 'cover' : 'fill';
    const imgA = 1 - (n.imageT ?? 0);
    content = image ? (
      <>
        <img src={image} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit, opacity: imgA, borderRadius: style.borderRadius }} />
        {!isWhite(n.imageColor) && (
          // ImageColor3 multiplies the image: a tinted copy confined to the image's own pixels.
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: rgba(n.imageColor, imgA),
              mixBlendMode: 'multiply',
              maskImage: `url(${image})`,
              maskSize: fit === 'fill' ? '100% 100%' : fit,
              maskRepeat: 'no-repeat',
              maskPosition: 'center',
            }}
          />
        )}
      </>
    ) : (
      // The image itself isn't available here (a built-in texture, or offline): show where it goes.
      <div style={{ position: 'absolute', inset: 0, borderRadius: style.borderRadius, background: `repeating-linear-gradient(45deg, ${rgba(n.imageColor ?? [255, 255, 255], 0.16 * imgA)} 0 6px, transparent 6px 12px)`, outline: `1px dashed ${rgba(n.imageColor ?? [255, 255, 255], 0.35 * imgA)}`, outlineOffset: -1 }} />
    );
  }
  return (
    <div data-ui-id={n.id} style={style}>
      {shaped && <ShapeSvg n={n} b={b} />}
      {content}
    </div>
  );
}

export interface UiCanvasProps {
  screens: UiNode[];
  device: UiScreen;
  /** Elements to draw even though they are hidden (Visible = false), to preview menus scripts open. */
  show?: ReadonlySet<number>;
  images?: Record<string, string | null>;
  backdrop?: string | null;
  selected?: number | null;
  onSelect?: (b: UiBox | null) => void;
  /** Draw Roblox's top bar and the phone's notch areas. */
  guides?: boolean;
  className?: string;
}

/**
 * The game's UI as a player sees it on one device: the ScreenGuis laid out by the shared Roblox layout
 * and drawn with CSS, scaled to fit. Click an element to select it (the topmost under the pointer).
 */
export function UiCanvas({ screens, device, show, images = {}, backdrop, selected, onSelect, guides = true, className }: UiCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  const [hover, setHover] = useState<UiBox | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setFit(Math.min((el.clientWidth - 24) / device.w, (el.clientHeight - 24) / device.h));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [device.w, device.h]);
  const laid = useMemo(
    () =>
      [...screens]
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map((s) => ({ screen: s, boxes: layoutScreen(s, device, { measure: measureCss, show }) })),
    [screens, device, show],
  );
  const all = useMemo(() => laid.flatMap((l) => l.boxes), [laid]);
  const byPath = useMemo(() => new Map(all.map((b) => [b.path, b])), [all]);
  /** A worn skin's art and label stand for their element: pointing at them picks the element. */
  const lift = (b: UiBox): UiBox => {
    if (b.node.name !== 'Skin' && b.node.name !== 'Label') return b;
    const parent = byPath.get(b.path.slice(0, b.path.lastIndexOf('.')));
    return parent && parent.node.kids?.some((k) => k.name === 'Skin' && isSkinRef(k.image)) ? parent : b;
  };
  const pick = (e: MouseEvent<HTMLDivElement>): UiBox | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / fit;
    const y = (e.clientY - r.top) / fit;
    for (let i = all.length - 1; i >= 0; i--) {
      const b = all[i]!;
      const inClip = !b.clip || (x >= b.clip[0] && y >= b.clip[1] && x <= b.clip[0] + b.clip[2] && y <= b.clip[1] + b.clip[3]);
      const drawn = (b.node.bg && (b.node.bgT ?? 0) < 1) || isText(b.node) || b.node.image;
      if (drawn && inClip && x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h) return lift(b);
    }
    return null;
  };
  const sel = selected != null ? all.find((b) => b.node.id === selected) : null;
  // Elements that answer the player (a mockup's states): the pointer over one hovers it, holding the button
  // presses it, selecting it in the board shows its selected state. Everything inside follows its scale.
  const [pressed, setPressed] = useState<number | null>(null);
  const owners = useMemo(() => {
    const stateful = new Map(all.filter((b) => b.node.states && Object.keys(b.node.states).length).map((b) => [b.path, b]));
    const owner = new Map<number, UiBox>();
    if (!stateful.size) return owner;
    for (const b of all) {
      for (let p = b.path; p; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') {
        const s = stateful.get(p);
        if (s) {
          owner.set(b.node.id, s);
          break;
        }
      }
    }
    return owner;
  }, [all]);
  const hoverOwner = hover ? owners.get(hover.node.id) : undefined;
  // A disabled element stays so; otherwise the pointer's state, else the state it starts in (the open tab "selected").
  const start = (s: UiBox): UiStateName | null => (s.node.state && s.node.states?.[s.node.state] ? s.node.state : null);
  const stateOf = (s: UiBox): UiStateName | null =>
    s.node.state === 'disabled'
      ? start(s)
      : pressed === s.node.id && s.node.states?.press
        ? 'press'
        : hoverOwner === s && s.node.states?.hover
          ? 'hover'
          : selected === s.node.id && s.node.states?.selected
            ? 'selected'
            : start(s);
  const groupOf = (b: UiBox): StateScale | null | undefined => {
    const s = owners.get(b.node.id);
    if (!s) return undefined;
    const st = stateOf(s);
    const scale = st ? (s.node.states?.[st]?.scale ?? 1) : 1;
    const a = s.node.anchor ?? [0, 0];
    return { scale, ox: s.x + a[0] * s.w - b.x, oy: s.y + a[1] * s.h - b.y };
  };
  // A state that wears other art (a pressed button's own art, an active tab) moves its Skin and Label children:
  // the element's screen is laid out again in that state (as the core's renderer does), its children drawn from it.
  const stateKey = [...new Set(owners.values())]
    .map((s) => {
      const st = stateOf(s);
      const p = st ? s.node.states?.[st] : undefined;
      return p && (p.skinArt || p.label) ? `${s.path}|${st}` : '';
    })
    .filter(Boolean)
    .join(',');
  const restyled = useMemo(() => {
    const out = new Map<number, UiBox>();
    if (!stateKey) return out;
    const wanted = new Map(stateKey.split(',').map((x) => x.split('|') as [string, UiStateName]));
    for (const { screen } of laid) for (const [id, b] of childrenInState(screen, wanted, device, measureCss, show)) out.set(id, b);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, laid, device, show]);
  const zoom = fit * (typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1);
  const outline = (b: UiBox, color: string, dashed = false) => (
    <div className="pointer-events-none absolute" style={{ left: b.x - 1, top: b.y - 1, width: b.w + 2, height: b.h + 2, outline: `${2 / Math.max(fit, 0.2)}px ${dashed ? 'dashed' : 'solid'} ${color}`, transform: b.rot ? `rotate(${b.rot}deg)` : undefined }} />
  );
  return (
    <div ref={host} className={`relative h-full w-full overflow-hidden ${className ?? ''}`}>
      {fit > 0 && (
        <div
          data-ui-device
          className="absolute top-1/2 left-1/2 overflow-hidden rounded-[10px] shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/10"
          style={{ width: device.w, height: device.h, transform: `translate(-50%, -50%) scale(${fit})` }}
          onClick={onSelect ? (e) => onSelect(pick(e)) : undefined}
          onMouseMove={onSelect ? (e) => setHover(pick(e)) : undefined}
          onMouseDown={
            onSelect
              ? (e) => {
                  const b = pick(e);
                  setPressed(b ? (owners.get(b.node.id)?.node.id ?? null) : null);
                }
              : undefined
          }
          onMouseUp={() => setPressed(null)}
          onMouseLeave={() => {
            setHover(null);
            setPressed(null);
          }}
        >
          {backdrop ? <img src={backdrop} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-80" /> : <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,#3c4a5c,#161b22_70%)]" />}
          {guides && (
            <>
              {/* An upright phone's status bar above Roblox's top bar, and its home bar at the bottom. */}
              {device.top ? <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/30" style={{ height: device.top }} /> : null}
              {device.bottom ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center bg-black/30" style={{ height: device.bottom }}>
                  <span className="h-[5px] w-[134px] rounded-full bg-white/50" />
                </div>
              ) : null}
              {/* A TV may crop its edges: text and buttons belong inside the middle 90%. */}
              {device.tenFoot ? <div className="pointer-events-none absolute inset-[5%] rounded-sm border border-dashed border-white/25" /> : null}
              {/* Roblox's top bar: its menu and chat buttons at the left, more at the right. */}
              <div className="pointer-events-none absolute inset-x-0 border-b border-dashed border-white/20" style={{ top: device.top ?? 0, height: device.topbar ?? TOPBAR }}>
                <div className="absolute top-[11px] left-4 flex gap-2">
                  <span className="h-9 w-9 rounded-full bg-black/45" />
                  <span className="h-9 w-9 rounded-full bg-black/45" />
                </div>
                <span className="absolute top-[11px] right-4 h-9 w-9 rounded-full bg-black/45" />
              </div>
              {device.side ? (
                <>
                  <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/25" style={{ width: device.side }} />
                  <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/25" style={{ width: device.side }} />
                </>
              ) : null}
            </>
          )}
          {laid.map(({ screen, boxes }) => (
            <div key={screen.id} className="pointer-events-none absolute inset-0">
              {boxes.map((b0) => {
                const owner = owners.get(b0.node.id);
                const b = restyled.get(b0.node.id) ?? b0;
                return <Element key={b.node.id} b={b} image={b.node.image ? images[b.node.image] : null} state={owner === b0 ? stateOf(b0) : null} group={groupOf(b)} zoom={zoom} />;
              })}
            </div>
          ))}
          {hover && hover !== sel && outline(hover, 'rgba(255,255,255,0.55)', true)}
          {sel && outline(sel, 'var(--color-accent)')}
        </div>
      )}
    </div>
  );
}

/** The Roblox images the screens use, as data: URLs (fetched and cached by the core; null when unavailable). */
export function useUiImages(screens: UiNode[] | undefined): Record<string, string | null> {
  const [images, setImages] = useState<Record<string, string | null>>({});
  const refs = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: UiNode) => {
      // Forged skin art comes with the worn screens (forge.worn), not from here.
      if (n.image && !isSkinRef(n.image)) out.add(n.image);
      n.kids?.forEach(walk);
    };
    screens?.forEach(walk);
    return [...out].sort();
  }, [screens]);
  const key = refs.join('|');
  useEffect(() => {
    if (!refs.length) return;
    let live = true;
    void rpc<Record<string, string | null>>('ui.images', { refs })
      .then((r) => live && setImages(r))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return images;
}
