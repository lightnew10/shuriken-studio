import { memo } from 'react';
import { markMotion } from '../lib/working-mark';

/**
 * The Shuriken Studio mark: a four-blade pinwheel shuriken drawn on a 12×12 pixel grid, with a hollow
 * core. Idle it sits still; `active` is the app-wide "working" signal: the mark turns, a quarter turn at a
 * time (it has four-fold symmetry, so each turn lands where it began).
 * One transform animation on the svg element, run by the compositor; the pixel-by-pixel fall is kept for one big
 * mark at a time (lib/working-mark.ts says why, with the measurements).
 */

const N = 12;
// Up blade (tip at the top right of the core); the others are 90° rotations: (r, c) -> (c, N-1-r).
const UP: Array<[number, number]> = [
  [0, 7],
  [1, 6], [1, 7],
  [2, 5], [2, 6], [2, 7],
  [3, 4], [3, 5], [3, 6], [3, 7],
];
const rot = ([r, c]: [number, number]): [number, number] => [c, N - 1 - r];
const RIGHT = UP.map(rot);
const DOWN = RIGHT.map(rot);
const LEFT = DOWN.map(rot);
const CORE: Array<[number, number]> = [];
for (let r = 4; r <= 7; r++) for (let c = 4; c <= 7; c++) if (!((r === 5 || r === 6) && (c === 5 || c === 6))) CORE.push([r, c]);

interface Px {
  r: number;
  c: number;
  /** 0..1 along the diagonal, for the amber → orange gradient. */
  t: number;
  edge: boolean;
}

// The long edge of each blade (the row/column touching the core) reads as a highlight.
const PIXELS: Px[] = [...UP, ...RIGHT, ...DOWN, ...LEFT, ...CORE].map(([r, c]) => ({
  r,
  c,
  t: (r + c) / (2 * (N - 1)),
  edge: (r === 3 && c >= 4 && c <= 7) || (c === 8 && r >= 4 && r <= 7) || (r === 8 && c >= 4 && c <= 7) || (c === 3 && r >= 4 && r <= 7),
}));

// Deterministic pseudo-random stagger so the fall looks organic but never jitters between renders.
const delay = (r: number, c: number) => ((r * 73 + c * 151 + r * c * 7) % 17) * 95;
const drift = (r: number, c: number) => (((r * 31 + c * 17) % 5) - 2) * 0.35;

export const ShurikenMark = memo(function ShurikenMark({ size = 24, active = false, muted = false, title, rich }: { size?: number; active?: boolean; muted?: boolean; title?: string; rich?: boolean }) {
  const id = `g${size}${active ? 'a' : ''}${muted ? 'm' : ''}`;
  const motion = markMotion(size, active, rich);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-0.5 -0.5 ${N + 1} ${N + 1}`}
      className={motion === 'fall' ? 'px-active' : motion === 'spin' ? 'px-spin' : undefined}
      role="img"
      aria-label={title ?? (active ? 'Working' : 'Shuriken Studio')}
      shapeRendering="crispEdges"
      style={{ overflow: 'visible', flex: 'none' }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: muted ? '#8a7f76' : 'var(--color-mark-hi)' }} />
          <stop offset="55%" style={{ stopColor: muted ? '#6f655d' : 'var(--color-accent)' }} />
          <stop offset="100%" style={{ stopColor: muted ? '#5a524c' : 'var(--color-ember)' }} />
        </linearGradient>
      </defs>
      {PIXELS.map((p) => (
        <rect
          key={`${p.r}-${p.c}`}
          x={p.c + 0.04}
          y={p.r + 0.04}
          width={0.92}
          height={0.92}
          rx={0.12}
          fill={p.edge ? (muted ? '#9a8f86' : 'var(--color-mark-edge)') : `url(#${id})`}
          fillOpacity={p.edge ? 0.95 : 1}
          style={motion === 'fall' ? ({ ['--d' as string]: `${delay(p.r, p.c)}ms`, ['--dx' as string]: `${drift(p.r, p.c)}px`, ['--dy' as string]: `${2.2 + ((p.r + p.c) % 3) * 0.6}px` } as React.CSSProperties) : undefined}
        />
      ))}
    </svg>
  );
});

export function Wordmark({ size = 15 }: { size?: number }) {
  return (
    <span style={{ fontSize: size, letterSpacing: '-0.01em' }} className="font-semibold text-text">
      Shuriken <span className="font-display font-medium italic text-accent2">Studio</span>
    </span>
  );
}
