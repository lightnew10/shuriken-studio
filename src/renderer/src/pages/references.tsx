import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { AudioLines, Film, ImageIcon, Info, Loader2, RotateCcw, Sparkles, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { REFERENCE_BUSY, clock, riseWords, type AudioEvent, type ReferenceRecord } from '@shared/references';
import { TopBar } from '../components/topbar';
import { Button, Empty, Markdown, Modal, Pill, cx, timeAgo } from '../components/ui';
import { rpc, useAction, useAutoSelect, useRpc } from '../lib/rpc';
import { referenceFiles, referenceStatus, sizeLabel, type ReferenceTone } from '../lib/references';

/** One reference as the page reads it: the record, its study's text, its level graph and loud hits. */
type Detail = ReferenceRecord & { studyText: string | null; levels: { step: number; db: number[] } | null; events: AudioEvent[] };
type Pictures = { frames: Array<{ t: number; why: string; url: string | null }>; spectrograms: Array<{ t0: number; t1: number; url: string | null }>; image: string | null };

const TONE: Record<ReferenceTone, 'neutral' | 'accent' | 'ok' | 'warn' | 'bad'> = { busy: 'accent', ready: 'ok', measured: 'warn', failed: 'bad', waiting: 'neutral' };

/**
 * References: gameplay footage and pictures the user wants the game to feel or look like. Files are added
 * with the button or by dropping them anywhere on the page; each shows how its analysis stands, its frames,
 * what its sound measured and its study, and says plainly what the analysis can't see or hear.
 */
export function ReferencesPage({ selectedId }: { selectedId?: string }) {
  const list = useRpc<ReferenceRecord[]>('references.list', {}, ['references.changed']);
  const refs = useMemo(() => [...(list.data ?? [])].reverse(), [list.data]);
  const [sel, setSel] = useState<string | null>(selectedId ?? null);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useAutoSelect(refs, sel, (r) => setSel(r.id));
  useEffect(() => {
    if (selectedId) setSel(selectedId);
  }, [selectedId]);
  // The newest is selected when nothing is, or when the selected one was removed; a reference just added (or one
  // the page was opened on) stays selected while the list catches up with it.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!list.data) return;
    const ids = new Set(refs.map((r) => r.id));
    if (!sel || (seen.current.has(sel) && !ids.has(sel))) setSel(refs[0]?.id ?? null);
    for (const id of ids) seen.current.add(id);
  }, [list.data, refs, sel]);

  const add = useAction(async (files: File[]) => {
    const { paths, skipped } = referenceFiles(files, (f) => window.shuriken.pathForFile(f));
    if (!paths.length) {
      setNote(skipped.length ? `Not a video or a picture: ${skipped.join(', ')}` : null);
      return;
    }
    const out = await rpc<{ added: ReferenceRecord[]; refused: Array<{ file: string; why: string }> }>('references.add', { paths, from: 'page' });
    const problems = [...out.refused.map((r) => r.why), ...(skipped.length ? [`Not a video or a picture: ${skipped.join(', ')}`] : [])];
    setNote(problems.length ? problems.join(' ') : null);
    if (out.added[0]) setSel(out.added[out.added.length - 1]!.id);
    list.reload();
  });

  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void add.run([...e.dataTransfer.files]);
  };

  return (
    <div
      className="relative flex h-full flex-col bg-bg"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <TopBar title="References" back>
        <Button size="sm" kind="primary" icon={<Upload size={13} />} onClick={() => input.current?.click()} disabled={add.busy}>
          Add footage or pictures
        </Button>
      </TopBar>
      <input
        ref={input}
        type="file"
        multiple
        accept="video/*,image/*,.mkv,.mov"
        className="hidden"
        onChange={(e) => {
          void add.run([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-line px-2 py-3">
          <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">For this game</div>
          {refs.length === 0 && <div className="px-2 text-[12px] leading-snug text-faint">None yet. Add a clip or a picture, or drop one here.</div>}
          {refs.map((r) => {
            const st = referenceStatus(r);
            return (
              <button key={r.id} onClick={() => setSel(r.id)} className={cx('flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel === r.id ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}>
                {st.tone === 'busy' ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent2" /> : r.kind === 'video' ? <Film size={13} className="mt-0.5 shrink-0 text-accent2" /> : <ImageIcon size={13} className="mt-0.5 shrink-0 text-accent2" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{r.name}</span>
                  <span className={cx('block truncate text-[10.5px]', st.tone === 'failed' ? 'text-bad' : 'text-faint')}>{st.label}</span>
                </span>
                {r.kind === 'video' && r.duration ? <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{clock(r.duration)}</span> : null}
              </button>
            );
          })}
          {note && <div className="mx-2 mt-3 rounded-lg border border-warn/30 bg-warn/8 px-2.5 py-2 text-[11.5px] leading-snug text-warn">{note}</div>}
          {add.error && <div className="mx-2 mt-3 rounded-lg border border-bad/30 bg-bad/8 px-2.5 py-2 text-[11.5px] leading-snug text-bad">{add.error}</div>}
        </aside>
        <main className="min-h-0 overflow-y-auto">{sel ? <ReferenceDetail key={sel} id={sel} /> : <Welcome onAdd={() => input.current?.click()} />}</main>
      </div>
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg/70 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent/60 px-10 py-8 text-center text-[14px] text-text">Drop videos or pictures to add them as references</div>
        </div>
      )}
    </div>
  );
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <Empty icon={<Film size={22} />}>
        <div className="text-[14px] text-text">Show the team what you mean</div>
        <div className="mt-2">
          A clip of a game whose combat or movement you like, a UI screenshot, concept art. Shuriken samples the frames, measures the sound and writes a study; the planner, the specialists and the
          docks build from it.
        </div>
        <Button className="mt-4" kind="primary" icon={<Upload size={14} />} onClick={onAdd}>
          Add footage or pictures
        </Button>
        <div className="mt-3 text-[11.5px]">Videos up to 4 GB (MP4, MOV, WebM, MKV), pictures up to 20 MB. You can also drop them here or in the director's chat.</div>
      </Empty>
    </div>
  );
}

function Section({ title, icon, children, right }: { title: string; icon: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-t border-line px-6 py-4">
      <div className="mb-2.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.06em] text-dim uppercase">
        {icon}
        <span className="flex-1">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

function ReferenceDetail({ id }: { id: string }) {
  const detail = useRpc<Detail | null>('references.get', { id }, ['references.changed']);
  const r = detail.data ?? null;
  // Pictures are read again only when there are new ones (status lines change much more often).
  const picKey = r ? `${r.video?.frames.length ?? 0}|${r.video?.detail?.length ?? 0}|${r.spectrograms?.length ?? 0}|${r.image?.preview ?? ''}|${r.addedAt}` : '';
  const pics = useRpc<Pictures | null>(r ? 'references.pictures' : null, { id }, [], [picKey]);
  const [big, setBig] = useState<{ url: string; label: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const act = useAction(async (method: string) => {
    await rpc(method, { id });
    detail.reload();
  });
  if (!r) return <div className="p-6 text-[12.5px] text-faint">{detail.loading ? 'Loading…' : 'That reference is gone.'}</div>;
  const st = referenceStatus(r);
  const busy = REFERENCE_BUSY.includes(r.status);
  const canStudy = !busy && (r.kind === 'video' ? !!r.video?.frames.length : !!r.image);
  return (
    <div className="pb-10">
      <div className="flex items-start gap-3 px-6 pt-5 pb-4">
        <div className="mt-0.5 rounded-xl bg-accent/12 p-2 text-accent2">{r.kind === 'video' ? <Film size={18} /> : <ImageIcon size={18} />}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold text-text">{r.name}</div>
          <div className="mt-0.5 text-[12px] text-faint">
            {r.kind === 'video' ? `Video${r.duration ? ` · ${clock(r.duration)}` : ''}` : 'Picture'}
            {r.width ? ` · ${r.width}×${r.height}` : ''} · {sizeLabel(r.bytes)} · {r.source} · added {timeAgo(r.addedAt)}
          </div>
        </div>
        <Pill tone={TONE[st.tone]}>
          {st.tone === 'busy' && <Loader2 size={11} className="animate-spin" />}
          {st.label}
        </Pill>
        <div className="flex shrink-0 gap-1.5">
          {canStudy && (
            <Button size="sm" icon={<Sparkles size={13} />} onClick={() => void act.run('references.restudy')} disabled={act.busy} title="One agent run reads the frames and the sound's numbers again and writes a new study">
              {r.study ? 'Study again' : 'Write the study'}
            </Button>
          )}
          {!busy && (
            <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => void act.run('references.analyze')} disabled={act.busy} title="Read the file again from the start: frames, sound, then the study">
              Analyze again
            </Button>
          )}
          <Button size="sm" kind="danger" icon={<Trash2 size={13} />} onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </div>
      </div>
      {(r.stage || r.error) && (
        <div className={cx('mx-6 mb-3 rounded-xl px-3 py-2 text-[12.5px] leading-snug', r.status === 'failed' ? 'border border-bad/30 bg-bad/8 text-bad' : busy ? 'bg-accent/8 text-accent2' : 'border border-warn/30 bg-warn/8 text-warn')}>
          {busy && r.stage ? r.stage : r.error}
        </div>
      )}
      {act.error && <div className="mx-6 mb-3 text-[12px] text-bad">{act.error}</div>}
      <Limits r={r} />

      {r.study && (
        <Section title="Study" icon={<Sparkles size={13} />} right={<span className="text-[11px] font-normal tracking-normal text-faint normal-case">{r.study.costUsd !== null ? `one agent run · $${r.study.costUsd.toFixed(2)} · ` : ''}{r.study.imagesShown} pictures shown</span>}>
          {r.studyText ? <Markdown text={r.studyText.replace(/^# .*\n/, '')} className="text-[13px]" /> : <div className="text-[12.5px] text-dim">{r.study.summary}</div>}
        </Section>
      )}

      {r.kind === 'image' && (
        <Section title="Picture" icon={<ImageIcon size={13} />}>
          {pics.data?.image ? <img src={pics.data.image} alt={r.name} className="max-h-[520px] max-w-full rounded-xl ring-1 ring-line" /> : <div className="text-[12.5px] text-faint">{busy ? 'Reading the picture…' : 'No copy of the picture was made.'}</div>}
          <Palette colours={r.image?.palette ?? []} />
        </Section>
      )}

      {r.kind === 'video' && (
        <Section title={`Frames${r.video ? ` · ${r.video.frames.length + (r.video.detail?.length ?? 0)}` : ''}`} icon={<Film size={13} />}>
          {r.video ? (
            <>
              <div className="mb-2.5 text-[12px] leading-snug text-faint">{r.video.coverage}</div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {(pics.data?.frames ?? []).map((f) => (
                  <button key={`${f.t}-${f.why}`} onClick={() => f.url && setBig({ url: f.url, label: `${f.t.toFixed(2)} s` })} className="group relative overflow-hidden rounded-lg bg-bg2 ring-1 ring-line hover:ring-accent/50">
                    {f.url ? <img src={f.url} alt={`${f.t.toFixed(2)} s`} className="aspect-video w-full object-cover" /> : <div className="aspect-video" />}
                    <span className="absolute bottom-1 left-1 rounded bg-black/65 px-1.5 py-0.5 text-[10.5px] text-white tabular-nums">{f.t.toFixed(2)} s</span>
                    {f.why !== 'even' && <span className={cx('absolute top-1 right-1 rounded px-1.5 py-0.5 text-[10px] font-medium', f.why === 'sound' ? 'bg-warn/85 text-black' : f.why === 'scene' ? 'bg-info/85 text-black' : 'bg-white/80 text-black')}>{f.why === 'sound' ? 'loud hit' : f.why === 'scene' ? 'after a cut' : 'detail'}</span>}
                  </button>
                ))}
              </div>
              <Palette colours={r.video.palette} />
            </>
          ) : (
            <div className="text-[12.5px] text-faint">{busy ? 'The frames appear here once the video is read.' : 'No frames were taken.'}</div>
          )}
        </Section>
      )}

      {r.kind === 'video' && (r.audio || r.audioNote) && <Sound r={r} pics={pics.data ?? null} />}

      <Modal open={!!big} onClose={() => setBig(null)} title={big?.label ?? ''} width={980}>
        {big && <img src={big.url} alt={big.label} className="w-full rounded-lg" />}
      </Modal>
      <Modal open={removing} onClose={() => setRemoving(false)} title={`Remove "${r.name}"?`} width={460}>
        <div className="text-[13px] leading-relaxed text-dim">Its copy, frames, sound measurements and study are deleted from the project. Your own file stays where it is.</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setRemoving(false)}>Keep it</Button>
          <Button
            kind="danger"
            icon={<Trash2 size={13} />}
            onClick={() => {
              setRemoving(false);
              void rpc('references.remove', { id });
            }}
          >
            Remove
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** What the analysis can't do, said where the results are. */
function Limits({ r }: { r: ReferenceRecord }) {
  return (
    <div className="mx-6 mb-4 flex gap-2 rounded-xl bg-white/3 px-3 py-2.5 text-[11.5px] leading-relaxed text-faint ring-1 ring-line">
      <Info size={13} className="mt-0.5 shrink-0" />
      <div>
        {r.kind === 'video'
          ? 'Frames are samples (about one a second, plus right after cuts and at loud hits): what happens between them isn\'t seen. The sound is measured, not heard (loudness, hits, tempo, tone), and speech is not transcribed. '
          : 'The study reads the picture: layout, palette and style. '}
        The study is one agent run on your account{r.study?.costUsd != null ? ` (this one cost $${r.study.costUsd.toFixed(2)})` : ', usually a minute or two'}; agents take the feel and the timings, never another game's names, logos or art.
      </div>
    </div>
  );
}

function Palette({ colours }: { colours: Array<{ hex: string; share: number }> }) {
  if (!colours.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] text-faint">Palette</span>
      {colours.map((c) => (
        <span key={c.hex} title={`${c.hex} · ${Math.round(c.share * 100)}%`} className="flex items-center gap-1 rounded-md bg-bg2 px-1.5 py-0.5 text-[10.5px] text-dim ring-1 ring-line">
          <span className="h-3 w-3 rounded-[3px] ring-1 ring-white/15" style={{ background: c.hex }} />
          {c.hex} {Math.round(c.share * 100)}%
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-bg2 px-3 py-2 ring-1 ring-line" title={hint}>
      <div className="text-[10.5px] tracking-[0.06em] text-faint uppercase">{label}</div>
      <div className="mt-0.5 text-[14px] text-text tabular-nums">{value}</div>
    </div>
  );
}

function Sound({ r, pics }: { r: Detail; pics: Pictures | null }) {
  const a = r.audio;
  return (
    <Section title="Sound" icon={<AudioLines size={13} />} right={<span className="text-[11px] font-normal tracking-normal text-faint normal-case">measured, not heard · speech not transcribed</span>}>
      {!a ? (
        <div className="flex items-center gap-2 text-[12.5px] text-faint">
          <TriangleAlert size={13} /> {r.audioNote}
        </div>
      ) : (
        <>
          {r.audioNote && <div className="mb-2 text-[12px] text-warn">{r.audioNote}</div>}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
            <Stat label="Loudness" value={a.integratedLufs === null ? '—' : `${a.integratedLufs} LUFS`} hint="Integrated loudness (BS.1770): games' mixes sit around -18 to -12" />
            <Stat label="Peak" value={`${a.peakDb} dBFS`} />
            <Stat label="Range" value={`${a.rangeDb} dB`} hint="How far the 3-second loudness moves (silence left out)" />
            <Stat label="Silence" value={`${Math.round(a.silenceRatio * 100)}%`} hint="Share of the time under -50 dBFS" />
            <Stat label="Tempo" value={a.tempo ? `≈${Math.round(a.tempo.bpm)} bpm` : 'no beat'} hint={a.tempo ? `Confidence ${a.tempo.confidence}; it can be half or double` : 'No steady beat was found'} />
            <Stat label="Hits a minute" value={`${a.onsetsPerMinute}`} hint={`${a.onsets} onsets (hits, steps, notes)`} />
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11.5px] text-faint">
            <span className="shrink-0 whitespace-nowrap">Bass · mid · high</span>
            <div className="flex h-2.5 flex-1 overflow-hidden rounded-full ring-1 ring-line">
              <div className="bg-[#7c3aed]" style={{ width: `${a.balance.bass * 100}%` }} title={`Bass (under 250 Hz) ${Math.round(a.balance.bass * 100)}%`} />
              <div className="bg-[#f59e0b]" style={{ width: `${a.balance.mid * 100}%` }} title={`Mid ${Math.round(a.balance.mid * 100)}%`} />
              <div className="bg-[#38bdf8]" style={{ width: `${a.balance.high * 100}%` }} title={`High (over 4 kHz) ${Math.round(a.balance.high * 100)}%`} />
            </div>
            <span className="w-28 shrink-0 text-right tabular-nums">
              {Math.round(a.balance.bass * 100)} · {Math.round(a.balance.mid * 100)} · {Math.round(a.balance.high * 100)}%
            </span>
          </div>
          {r.levels && <LevelGraph levels={r.levels} events={r.events} duration={a.analyzedSeconds} />}
          {r.events.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[11.5px] text-faint">Loudest hits, with the frame nearest each</div>
              <div className="flex flex-wrap gap-2">
                {r.events.slice(0, 16).map((e) => {
                  const frame = e.frame ? pics?.frames.find((f) => Math.abs(f.t - e.frame!.t) < 0.005) : null;
                  return (
                    <div key={e.t} className="w-[132px] overflow-hidden rounded-lg bg-bg2 ring-1 ring-line" title={`${e.peakDb} dBFS, ${riseWords(e.riseDb)} over the moment before, ${e.decayMs} ms to fall 12 dB`}>
                      {frame?.url ? <img src={frame.url} alt="" className="aspect-video w-full object-cover" /> : <div className="aspect-video bg-bg" />}
                      <div className="px-2 py-1 text-[10.5px] leading-tight">
                        <div className="text-text tabular-nums">{e.t.toFixed(2)} s</div>
                        <div className="text-faint">
                          {e.character === 'low' ? 'low, booming' : e.character === 'bright' ? 'bright, sharp' : 'mid, punchy'} · {e.peakDb} dB
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(pics?.spectrograms.length ?? 0) > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-[11.5px] text-faint">Spectrogram (time left to right, low notes at the bottom; the grey lane is the level; orange marks the loudest hits)</div>
              <div className="space-y-2">
                {pics!.spectrograms.map((s) =>
                  s.url ? (
                    <div key={s.t0}>
                      <div className="text-[10.5px] text-faint tabular-nums">
                        {clock(s.t0)}–{clock(s.t1)}
                      </div>
                      <img src={s.url} alt={`Spectrogram ${s.t0}–${s.t1} s`} className="max-w-full rounded-md ring-1 ring-line [image-rendering:pixelated]" />
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** The level over the clip (100 ms steps, squeezed to the width), with the loudest hits marked. */
function LevelGraph({ levels, events, duration }: { levels: { step: number; db: number[] }; events: AudioEvent[]; duration: number }) {
  const w = 600;
  const h = 64;
  const y = (db: number) => h - Math.max(0, Math.min(1, (db + 60) / 60)) * h;
  const points = levels.db.map((d, i) => `${((i / Math.max(1, levels.db.length - 1)) * w).toFixed(1)},${y(d).toFixed(1)}`).join(' ');
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-16 w-full rounded-lg bg-bg2 ring-1 ring-line">
        <polyline points={`0,${h} ${points} ${w},${h}`} fill="color-mix(in srgb, var(--color-accent) 25%, transparent)" stroke="var(--color-accent)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="0" x2={w} y1={y(-50)} y2={y(-50)} stroke="rgba(255,120,120,0.35)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        {events.map((e) => (
          <line key={e.t} x1={(e.t / Math.max(0.01, duration)) * w} x2={(e.t / Math.max(0.01, duration)) * w} y1={0} y2={h} stroke="rgba(251,146,60,0.7)" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mt-0.5 flex justify-between text-[10px] text-faint tabular-nums">
        <span>0:00</span>
        <span>level (-60 to 0 dBFS); dashed: silence</span>
        <span>{clock(duration)}</span>
      </div>
    </div>
  );
}
