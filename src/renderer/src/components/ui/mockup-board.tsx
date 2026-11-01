import { useEffect, useMemo, useRef, useState } from 'react';
import { Expand } from 'lucide-react';
import { layoutScreen, UI_DEVICES, type UiBox, type UiDevice, type UiNode } from '@shared/ui-layout';
import { motionOf, resolveVersion, type MockAudit, type MockVersion, type ResolvedVersion } from '@shared/ui-mockup';
import { boardLayout, previewPlan } from '../../lib/mockup-board';
import { UiCanvas, measureCss } from './ui-canvas';
import { playPreview } from './mockup-motion';
import { cx } from '../ui';

const CAPTION = 24;
const GAP = 16;

/** A version of a mockup on each device, laid out once per device (screens, boxes) for the canvases, selection and motion. */
export function useResolved(version: MockVersion | undefined, devices: UiDevice[], worn?: Partial<Record<UiDevice, UiNode[]>> | null): Partial<Record<UiDevice, ResolvedVersion & { boxes: UiBox[] }>> {
  return useMemo(() => {
    const out: Partial<Record<UiDevice, ResolvedVersion & { boxes: UiBox[] }>> = {};
    if (!version) return out;
    for (const d of devices) {
      const r = resolveVersion(version, d);
      // With its forged skins worn (forge.worn) when it has them: the same screens, each skin as its "Skin" child.
      const screens = worn?.[d] ?? r.screens;
      out[d] = { ...r, screens, boxes: screens.flatMap((s) => layoutScreen(s, UI_DEVICES[d], { measure: measureCss })) };
    }
    return out;
  }, [version, devices, worn]);
}

/**
 * A mockup version side by side on the chosen devices, each drawn the way Roblox lays it out there (its own
 * layout per form), with the device's findings under it; or one device big. Its motion plays when the
 * version shows and on `play`; its elements answer the pointer in their states (hover, press, selected).
 */
export function MockupBoard({
  version,
  devices,
  resolved,
  images,
  backdrop,
  audit,
  focus,
  onFocus,
  selected,
  onSelect,
  play,
  reduced,
}: {
  version: MockVersion;
  devices: UiDevice[];
  resolved: Partial<Record<UiDevice, ResolvedVersion & { boxes: UiBox[] }>>;
  images: Record<string, string | null>;
  backdrop: string | null | undefined;
  audit: MockAudit;
  focus: UiDevice | null;
  onFocus: (d: UiDevice | null) => void;
  selected: string | null;
  onSelect: (path: string | null, device: UiDevice) => void;
  play: number;
  reduced: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const shown = focus ? [focus] : devices;
  const cells = useMemo(() => {
    if (focus) return [{ key: focus, x: 0, y: 0, w: size.w, h: Math.max(0, size.h - CAPTION) }];
    return boardLayout(
      devices.map((d) => ({ key: d, aspect: UI_DEVICES[d].w / UI_DEVICES[d].h })),
      size.w,
      size.h,
      GAP,
      CAPTION,
    ).cells;
  }, [focus, devices, size.w, size.h]);
  const yOffset = useMemo(() => {
    if (focus || !cells.length) return 0;
    const bottom = Math.max(...cells.map((c) => c.y + c.h + CAPTION));
    return Math.max(0, (size.h - bottom) / 2);
  }, [cells, focus, size.h]);

  // The motion: once every shown canvas has drawn its elements (a frame or two after a change), then on Play.
  const cellHosts = useRef(new Map<UiDevice, HTMLDivElement>());
  const key = shown.join(',');
  useEffect(() => {
    // The version's moves and each element's appear.
    const motion = motionOf(version);
    if (!motion.length) return;
    const stops: Array<() => void> = [];
    const t = window.setTimeout(() => {
      for (const d of shown) {
        const el = cellHosts.current.get(d);
        const r = resolved[d];
        if (!el || !r) continue;
        stops.push(playPreview(el, previewPlan(motion, r.boxes, { reduced }).steps));
      }
    }, 180);
    return () => {
      window.clearTimeout(t);
      for (const s of stops) s();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, key, play, reduced, resolved, size.w > 0]);

  return (
    <div ref={host} className="relative h-full w-full">
      {size.w > 0 &&
        cells.map((c) => {
          const d = c.key;
          const r = resolved[d];
          const dev = UI_DEVICES[d];
          const counts = audit.devices.find((x) => x.device === d);
          const layouts = r ? [...new Set(Object.values(r.layouts).filter(Boolean))] : [];
          const sel = selected && r ? (r.boxes.find((b) => b.path === selected)?.node.id ?? null) : null;
          return (
            <div key={d} className="absolute" style={{ left: c.x, top: c.y + yOffset, width: c.w, height: c.h + CAPTION }}>
              <div
                ref={(el) => {
                  if (el) cellHosts.current.set(d, el);
                  else cellHosts.current.delete(d);
                }}
                className="relative"
                style={{ width: c.w, height: c.h }}
                data-device={d}
              >
                {r && <UiCanvas screens={r.screens as UiNode[]} device={dev} images={images} backdrop={backdrop} selected={sel} onSelect={(b) => onSelect(b?.path ?? null, d)} />}
              </div>
              <div className="flex h-6 items-center gap-1.5 px-1 text-[11px] text-faint">
                <span className="text-dim">{dev.label}</span>
                <span className="tabular-nums">
                  {dev.w}×{dev.h}
                </span>
                {layouts.length > 0 && <span className="rounded bg-accent/12 px-1 text-[10px] text-accent2">{layouts.map((l) => FORM_LABEL[l!]).join(', ')} layout</span>}
                <span className="flex-1" />
                {counts && (counts.problems || counts.warnings) ? (
                  <span className={cx('text-[10.5px]', counts.problems ? 'text-bad' : 'text-warn')}>
                    {counts.problems ? `${counts.problems} to fix` : `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`}
                  </span>
                ) : (
                  counts && <span className="text-[10.5px] text-ok">fits</span>
                )}
                {!focus && (
                  <button onClick={() => onFocus(d)} title={`Only the ${dev.label.toLowerCase()}, big`} className="ml-1 flex h-5 w-5 items-center justify-center rounded text-faint hover:bg-white/6 hover:text-text">
                    <Expand size={11} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}

export const FORM_LABEL: Record<string, string> = { phone: 'phone', phonePortrait: 'upright phone', tablet: 'tablet', desktop: 'desktop', tv: 'TV' };
