import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from './ui';
import { labelledStops, nearestStop, stopForKey, stopFraction, stopOf } from '../lib/step-slider';

/**
 * A setting chosen along a scale: a track with a dot for every stop, a handle that snaps to the nearest dot as it is
 * dragged or clicked, and the stops' names under their dots. It moves freely and saves when let go (or on a key), so a
 * drag is one change. Keyboard: arrows, Page Up/Down, Home and End.
 */
export function StepSlider<T extends string | number>({
  label,
  value,
  stops,
  onChange,
  note,
  maxLabels = 10,
  labels,
}: {
  label: string;
  value: T;
  /** The stops in order, each with its name. */
  stops: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
  note?: ReactNode;
  /** More stops than this show only some of their names (the ends and evenly between). */
  maxLabels?: number;
  /** Which stops are named under their dots (indexes), when the even spacing doesn't read well. */
  labels?: number[];
}) {
  const values = stops.map(([v]) => v);
  const saved = stopOf(value, values);
  const [at, setAt] = useState(saved);
  const dragging = useRef(false);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dragging.current) setAt(saved);
  }, [saved]);

  const count = stops.length;
  const commit = (i: number) => {
    setAt(i);
    const v = stops[i]?.[0];
    if (v !== undefined && v !== value) onChange(v);
  };
  const fromPointer = (clientX: number): number => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return at;
    return nearestStop((clientX - r.left) / r.width, count);
  };
  const shown = labels ?? labelledStops(count, maxLabels);
  const pct = (i: number) => `${stopFraction(i, count) * 100}%`;

  return (
    <div className="py-3">
      <div className="mb-3 flex items-baseline justify-between gap-3 text-[13px] text-text">
        <span id={`${label}-label`}>{label}</span>
        <span className="tabular-nums text-accent2">{stops[at]?.[1]}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-labelledby={`${label}-label`}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={at}
        aria-valuetext={stops[at]?.[1]}
        className="no-drag group relative mx-2 h-6 max-w-md cursor-pointer touch-none select-none outline-none"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          setAt(fromPointer(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging.current) setAt(fromPointer(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          commit(fromPointer(e.clientX));
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setAt(saved);
        }}
        onKeyDown={(e) => {
          const next = stopForKey(e.key, at, count);
          if (next === null) return;
          e.preventDefault();
          commit(next);
        }}
      >
        <div ref={track} className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line2">
          <div className="absolute inset-y-0 left-0 rounded-full bg-accent/70" style={{ width: pct(at) }} />
          {stops.map(([v], i) => (
            <span
              key={String(v)}
              className={cx('absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors', i <= at ? 'bg-accent2' : 'bg-faint/60')}
              style={{ left: pct(i) }}
            />
          ))}
          <span
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent2 shadow ring-2 ring-bg transition-[left] duration-75 group-focus-visible:ring-accent"
            style={{ left: pct(at) }}
          />
        </div>
      </div>
      <div className="relative mx-2 mt-1 h-4 max-w-md text-[11px] text-faint">
        {shown.map((i) => (
          <button
            key={String(stops[i]![0])}
            type="button"
            tabIndex={-1}
            onClick={() => commit(i)}
            className={cx('absolute -translate-x-1/2 whitespace-nowrap hover:text-text', i === 0 && 'translate-x-0', i === count - 1 && count > 1 && '-translate-x-full', i === at && 'text-accent2')}
            style={{ left: pct(i) }}
          >
            {stops[i]![1]}
          </button>
        ))}
      </div>
      {note && <div className="mt-2 max-w-2xl text-[12px] leading-snug text-faint">{note}</div>}
    </div>
  );
}
