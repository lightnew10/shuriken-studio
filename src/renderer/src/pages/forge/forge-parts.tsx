import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Loader2, Pipette, Plus, X } from 'lucide-react';
import type { ForgeDirectionInfo, ForgeGenreInfo, ForgePreview, ForgePreviewParams, ForgeSheet } from '@shared/ui-forge';
import { normalizeAccent } from '@shared/ui-forge';
import { cx } from '../../components/ui';
import { rpc } from '../../lib/rpc';
import { inkOn } from '../../lib/forge';

const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'rpc': Error: /, '');

/** This screen's pixels per CSS pixel (1 or 2: pictures are asked for no sharper than that). */
export const screenDpr = (): number => Math.max(1, Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1));

/**
 * A Forge picture: asked for when its params change (after `delay`, so a dragged accent asks once), the last one
 * kept on show while the next is drawn, answers to requests that were replaced ignored.
 */
export function useForgePreview(params: ForgePreviewParams | null, delay = 0): { pic: ForgePreview | null; loading: boolean; error: string | null } {
  const key = params ? JSON.stringify(params) : '';
  const [pic, setPic] = useState<ForgePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!params) return;
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      rpc<ForgePreview>('forge.preview', params)
        .then((r) => {
          if (my !== seq.current) return;
          if (!r.superseded) {
            setPic(r);
            setError(null);
          }
          setLoading(false);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          // Not the picture before it: that would pass for this one.
          setPic(null);
          setError(message(e));
          setLoading(false);
        });
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { pic, loading, error };
}

/** A direction's element sheet (forged at this screen's sharpness). */
export function useForgeSheet(direction: string | null, accent: string | null, delay = 0): { sheet: ForgeSheet | null; loading: boolean; error: string | null } {
  const [sheet, setSheet] = useState<ForgeSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!direction) return;
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      rpc<ForgeSheet>('forge.sheet', { direction, accent, px: screenDpr(), slot: 'sheet' })
        .then((r) => {
          if (my !== seq.current) return;
          if (r.groups.length) {
            setSheet(r);
            setError(null);
          }
          setLoading(false);
        })
        .catch((e) => {
          if (my !== seq.current) return;
          setError(message(e));
          setLoading(false);
        });
    }, delay);
    return () => clearTimeout(t);
  }, [direction, accent, delay]);
  return { sheet, loading, error };
}

/** An element's size in CSS pixels, kept up to date (a callback ref: the element may come and go). */
export function useBoxSize<T extends HTMLElement>(): [(el: T | null) => void, { w: number; h: number }] {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    const measure = () => setSize((s) => (Math.abs(s.w - el.clientWidth) > 1 || Math.abs(s.h - el.clientHeight) > 1 ? { w: el.clientWidth, h: el.clientHeight } : s));
    measure();
    ro.current = new ResizeObserver(measure);
    ro.current.observe(el);
  }, []);
  useEffect(() => () => ro.current?.disconnect(), []);
  return [ref, size];
}

/** Whether an element has come into view (and stays true after): pictures off screen aren't asked for. */
export function useSeen<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [seen, setSeen] = useState(false);
  const io = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    io.current?.disconnect();
    io.current = null;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);
    io.current = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.current?.disconnect();
      }
    }, { rootMargin: '160px' });
    io.current.observe(el);
  }, []);
  useEffect(() => () => io.current?.disconnect(), []);
  return [ref, seen];
}

/** A picture loading: a soft sweep over the surface it will fill. */
export function Shimmer({ className }: { className?: string }) {
  return (
    <div className={cx('relative overflow-hidden bg-surface2', className)}>
      <div className="absolute inset-0 -translate-x-full animate-[forge-sweep_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" />
      <style>{'@keyframes forge-sweep { to { transform: translateX(100%); } }'}</style>
    </div>
  );
}

/** One art direction as a big live card: its sample screen drawn by the engine, its name and what it suits. */
export function LookCard({ d, accent, selected, width, cardWidth, onPick }: { d: ForgeDirectionInfo; accent: string | null; selected: boolean; width: number; /** CSS pixels. */ cardWidth: number; onPick: () => void }) {
  const [seenRef, seen] = useSeen<HTMLButtonElement>();
  const { pic, loading } = useForgePreview(width > 0 && seen ? { what: 'sample', direction: d.id, accent, width, roblox: false, priority: 'low', slot: `card:${d.id}` } : null, 260);
  return (
    <button
      ref={seenRef}
      onClick={onPick}
      title={d.for}
      data-look={d.id}
      style={{ width: cardWidth }}
      className={cx(
        'group relative flex flex-none snap-start flex-col overflow-hidden rounded-xl text-left ring-1 transition-all duration-200',
        selected ? 'bg-surface2 ring-2 ring-accent shadow-[0_10px_30px_-14px_color-mix(in_srgb,var(--color-accent)_70%,transparent)]' : 'bg-surface ring-line hover:-translate-y-0.5 hover:ring-line2',
      )}
    >
      <div className="relative aspect-[1366/768] w-full overflow-hidden bg-surface2">
        {pic ? <img src={pic.png} alt={`${d.name} sample`} draggable={false} className={cx('h-full w-full object-cover transition-[opacity,transform] duration-300 group-hover:scale-[1.03]', loading && 'opacity-70')} /> : <Shimmer className="absolute inset-0" />}
        {loading && pic && <Loader2 size={13} className="absolute top-2 right-2 animate-spin text-white/80 drop-shadow" />}
        {selected && (
          <span className="absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-on-accent shadow">
            <Check size={12} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2 px-3 pt-2 pb-2.5">
        <span className="font-display text-[15px] leading-tight text-text">{d.name}</span>
        <span className="min-w-0 truncate text-[11px] text-faint">{d.tagline}</span>
      </div>
    </button>
  );
}

/** The accent picker: the look's own colours, swatches that suit it, any colour, or none (the look as designed). */
/**
 * A game genre for the templates: picking one sets the look and accent that suit it and fills the screens with its
 * currencies, items and tabs. A search finds one of the sixty; the first few show as chips.
 */
export function GenrePicker({ genres, genre, onPick }: { genres: ForgeGenreInfo[]; genre: string | null; onPick: (g: ForgeGenreInfo | null) => void }) {
  const [q, setQ] = useState('');
  const chosen = genres.find((g) => g.id === genre) ?? null;
  const words = q.trim().toLowerCase();
  const shown = (words ? genres.filter((g) => g.label.toLowerCase().includes(words) || g.id.includes(words)) : genres.filter((g) => g.id !== genre)).slice(0, words ? 14 : 8);
  return (
    <div>
      {chosen && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[12px] text-accent2 ring-1 ring-accent/30">
          <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/10" style={{ background: chosen.accent ?? 'transparent' }} />
          <span className="min-w-0 flex-1 truncate">{chosen.label}</span>
          <button onClick={() => onPick(null)} title="Back to the look's own sample content" className="text-faint transition-colors hover:text-text">
            <X size={13} />
          </button>
        </div>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Find a genre: tycoon, horror, racing…"
        spellCheck={false}
        className="w-full rounded-lg bg-bg px-2.5 py-1.5 text-[12px] text-text ring-1 ring-line placeholder:text-faint focus:outline-none focus:ring-accent/50"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {shown.map((g) => (
          <button
            key={g.id}
            onClick={() => {
              onPick(g);
              setQ('');
            }}
            className={cx('rounded-md px-2 py-0.5 text-[11.5px] ring-1 transition-colors', g.id === genre ? 'bg-accent/12 text-accent2 ring-accent/35' : 'text-dim ring-line hover:text-text hover:ring-line2')}
          >
            {g.label}
          </button>
        ))}
        {words && !shown.length && <span className="text-[11.5px] text-faint">No genre like that.</span>}
      </div>
    </div>
  );
}

export function AccentPicker({ d, accent, onChange }: { d: ForgeDirectionInfo; accent: string | null; onChange: (a: string | null) => void }) {
  const [text, setText] = useState(accent ?? '');
  useEffect(() => setText(accent ?? ''), [accent]);
  const own = d.palette.slice(0, 4).map((p) => p.hex);
  const custom = accent && !d.swatches.includes(accent) ? accent : null;
  const ring = (on: boolean) => cx('relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110', on ? 'ring-2 ring-text ring-offset-2 ring-offset-bg' : 'ring-1 ring-white/10');
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => onChange(null)} title="The look's own colours" className={ring(accent === null)} style={{ background: `conic-gradient(${own.map((c, i) => `${c} ${(i / own.length) * 100}% ${((i + 1) / own.length) * 100}%`).join(', ')})` }}>
          {accent === null && <Check size={13} strokeWidth={3} className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.7)]" />}
        </button>
        <span className="h-5 w-px bg-line2" />
        {d.swatches.map((s) => (
          <button key={s} onClick={() => onChange(s)} title={s} className={ring(accent === s)} style={{ background: s }}>
            {accent === s && <Check size={13} strokeWidth={3} style={{ color: inkOn(s) }} />}
          </button>
        ))}
        <label title="Any colour" className={cx(ring(!!custom), 'cursor-pointer overflow-hidden')} style={custom ? { background: custom } : { background: 'conic-gradient(#ff4d6d, #ffc93c, #36d96a, #3fa9ff, #9b5cff, #ff4d6d)' }}>
          {custom ? <Pipette size={12} style={{ color: inkOn(custom) }} /> : <Plus size={13} strokeWidth={3} className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.7)]" />}
          <input type="color" value={accent ?? d.swatches[0] ?? '#ff7a1a'} onChange={(e) => onChange(normalizeAccent(e.target.value))} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="h-4 w-4 shrink-0 rounded-[5px] ring-1 ring-white/10" style={{ background: accent ?? `conic-gradient(${own.join(', ')})` }} />
        <input
          value={text}
          placeholder="Its own colours"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            const n = normalizeAccent(e.target.value);
            if (n) onChange(n);
            else if (!e.target.value.trim()) onChange(null);
          }}
          className="no-drag w-28 rounded-lg border border-line2 bg-bg2 px-2 py-1 font-mono text-[11.5px] text-text outline-none placeholder:font-sans placeholder:text-faint focus:border-accent/60"
        />
        <span className="text-[11px] leading-snug text-faint">{accent ? 'Re-tints buttons, frames and glows' : 'The look as designed'}</span>
      </div>
    </div>
  );
}

/** A screen to start from: its thumbnail in the chosen look, its name and what it is for. */
export function ScreenRow({ id, label, sub, selected, thumb, missing, onPick }: { id: string; label: string; sub: string; selected: boolean; thumb: ForgePreviewParams | null; /** Not drawn in this look yet: what it is drawn in. */ missing?: string; onPick: () => void }) {
  const [seenRef, seen] = useSeen<HTMLButtonElement>();
  const { pic, error } = useForgePreview(seen && !missing ? thumb : null, 420);
  if (missing)
    return (
      <div ref={seenRef as unknown as React.Ref<HTMLDivElement>} title={`${sub}\n\nNot drawn in this look yet. ${missing}`} className="flex w-full items-center gap-3 rounded-xl p-1.5 text-left opacity-55">
        <div className="relative flex aspect-video w-[104px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface2 px-2 text-center text-[10px] leading-tight text-faint ring-1 ring-white/5">Not in this look yet</div>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] text-dim">{label}</span>
          <span className="line-clamp-2 text-[11px] leading-snug text-faint">{missing}</span>
        </span>
      </div>
    );
  return (
    <button ref={seenRef} onClick={onPick} title={error ? `${sub}

Couldn't draw it: ${error}` : sub} className={cx('flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition-colors', selected ? 'bg-accent/12 ring-1 ring-accent/40' : 'hover:bg-white/4')}>
      <div className="relative aspect-video w-[104px] shrink-0 overflow-hidden rounded-lg bg-surface2 ring-1 ring-white/5">
        {pic ? <img src={pic.png} alt="" draggable={false} className="h-full w-full object-cover" /> : error ? <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] leading-tight text-bad">Couldn’t draw it</span> : <Shimmer className="absolute inset-0" />}
      </div>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] text-text">
          {label}
          {selected && <Check size={12} className="text-accent2" />}
        </span>
        <span className="line-clamp-2 text-[11px] leading-snug text-faint" data-screen={id}>
          {sub}
        </span>
      </span>
    </button>
  );
}

/** A direction's whole kit, tile by tile; a tile copies the skin spec that wears it. */
export function ElementSheet({ sheet, mood }: { sheet: ForgeSheet; mood: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (spec: string) => {
    void navigator.clipboard?.writeText(spec).catch(() => {});
    setCopied(spec);
    setTimeout(() => setCopied((c) => (c === spec ? null : c)), 1400);
  };
  return (
    <div className="space-y-5">
      {sheet.groups.map((g) => (
        <section key={g.id}>
          <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">{g.label}</div>
          <div className="flex flex-wrap gap-2.5">
            {g.items.map((it) => {
              const cssW = it.w / it.scale;
              return (
                <button key={it.spec} onClick={() => copy(it.spec)} title={`${it.spec}\nClick to copy the skin spec`} className="group flex flex-col overflow-hidden rounded-xl bg-surface text-left ring-1 ring-line transition-colors hover:ring-line2">
                  <div className="flex min-h-[84px] flex-1 items-center justify-center px-3 py-3" style={{ background: mood, minWidth: Math.min(460, Math.max(120, cssW + 24)) }}>
                    {it.png ? <img src={it.png} alt={it.label} draggable={false} style={{ width: Math.min(436, cssW), height: 'auto', maxWidth: '100%' }} /> : <span className="text-[11px] text-bad">{it.error ?? 'not forged'}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 border-t border-line px-2.5 py-1.5" style={{ maxWidth: Math.min(460, Math.max(120, cssW + 24)) }}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] text-text">{it.label}</span>
                      <span className="block truncate font-mono text-[10px] text-faint">
                        {it.size[0]}×{it.size[1]} · {it.spec.split(':').slice(1).join(':')}
                      </span>
                    </span>
                    {copied === it.spec ? <Check size={12} className="shrink-0 text-ok" /> : <Copy size={11} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A small heading in the side panel. */
export function Overline({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
      <span className="flex-1">{children}</span>
      {right}
    </div>
  );
}
