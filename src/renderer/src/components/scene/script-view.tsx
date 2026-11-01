import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useRpc } from '../../lib/rpc';
import { luauLines, type TokKind } from '../../lib/luau-highlight';

/** Studio's default dark script editor colors. */
const COLOR: Record<TokKind, string> = {
  kw: '#f86d7c',
  lit: '#ffc600',
  num: '#ffc600',
  str: '#adf195',
  com: '#666666',
  glob: '#84d6f7',
  call: '#fdfbac',
  prop: '#61a1f1',
  txt: '#cccccc',
};

// ─── The script editor tab (read-only) ─────────────────────────────────────────────────────────

const LINE_H = 18;
/** Rows drawn above and below the visible ones (long generated modules run to thousands of lines). */
const OVERSCAN = 30;

/** A project script, read-only, as Studio's script editor shows it. `jump` scrolls to a line. */
export function ScriptView({ file, jump }: { file: string; jump?: { line: number; seq: number } | null }) {
  const src = useRpc<string>('code.read', { file }, ['roblox.changed']);
  const lines = useMemo(() => (src.data == null ? [] : luauLines(src.data)), [src.data]);
  const widest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.reduce((w, t) => w + t.s.replace(/\t/g, '    ').length, 0)), 0), [lines]);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const [mark, setMark] = useState<number | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    lines.forEach((l, i) => {
      if (l.map((t) => t.s).join('').toLowerCase().includes(q)) out.push(i + 1);
    });
    return out;
  }, [lines, query]);

  const scrollTo = (line: number) => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = Math.max(0, (line - 1) * LINE_H - el.clientHeight / 3);
    setMark(line);
  };
  // Apply each jump once, when its lines are there (a reload after an agent edit must not scroll back).
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (!jump || !lines.length || applied.current === jump.seq) return;
    applied.current = jump.seq;
    scrollTo(jump.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.seq, lines.length]);
  useEffect(() => {
    if (hit >= matches.length) setHit(matches.length ? matches.length - 1 : 0);
  }, [matches.length, hit]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(view.top / LINE_H) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((view.top + view.height) / LINE_H) + OVERSCAN);
  const gutter = String(lines.length).length;
  const next = (dir: 1 | -1) => {
    if (!matches.length) return;
    const i = (hit + dir + matches.length) % matches.length;
    setHit(i);
    scrollTo(matches[i]!);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#252525]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/40 px-3 text-[11.5px] text-[#9a9a9a]">
        <span className="min-w-0 flex-1 truncate font-mono">{file}</span>
        {src.error ? <span className="text-bad">{src.error}</span> : <span className="tabular-nums">{lines.length.toLocaleString()} lines · read-only</span>}
        <label className="flex h-6 items-center gap-1 rounded bg-black/30 px-1.5">
          <Search size={11} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHit(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (matches.length && mark !== matches[hit]) scrollTo(matches[hit]!);
                else next(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Find"
            className="w-28 bg-transparent text-[11.5px] text-[#cccccc] outline-none placeholder:text-[#777]"
          />
          {query.trim() && <span className="tabular-nums">{matches.length ? `${hit + 1}/${matches.length}` : '0'}</span>}
        </label>
      </div>
      <div
        ref={box}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        className="min-h-0 flex-1 overflow-auto font-mono text-[12px]"
        style={{ tabSize: 4 }}
      >
        <div style={{ height: lines.length * LINE_H, minWidth: `calc(${widest}ch + ${gutter + 4}ch)`, position: 'relative' }}>
          {lines.slice(first, last).map((l, k) => {
            const no = first + k + 1;
            const found = matches.length > 0 && matches[hit] === no;
            return (
              <div
                key={no}
                className="absolute right-0 left-0 flex whitespace-pre"
                style={{ top: (no - 1) * LINE_H, height: LINE_H, lineHeight: `${LINE_H}px`, background: mark === no || found ? 'rgba(255,198,0,0.10)' : undefined }}
              >
                <span className="sticky left-0 shrink-0 bg-[#252525] pr-3 pl-2 text-right text-[#6e6e6e] select-none" style={{ width: `${gutter + 3}ch` }}>
                  {no}
                </span>
                <span>
                  {l.map((t, j) => (
                    <span key={j} style={{ color: COLOR[t.k] }}>
                      {t.s}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
