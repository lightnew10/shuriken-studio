import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleDashed, CloudUpload, Loader2, Music2, Play, Plus, Square, Store, Trash2, Wand2 } from 'lucide-react';
import { TopBar } from '../components/topbar';
import { Button, Empty, ErrorNote, Pill, Segmented, cx, inputClass } from '../components/ui';
import { rpc, useRpc } from '../lib/rpc';
import { useOverlaysOpen } from '../lib/overlays';
import { useRoute } from '../lib/nav';
import { CopilotToggle, WithCopilot, setDockContext, useCopilotOpen } from '../containers/copilot-chat';
import { KIND_LABEL, canPlay, checkWords, groupSounds, moveSelection, navAction, soundLength, soundState, type SoundKind } from '../lib/sound-list';
import { soundPlayer, useNowPlaying, usePlayProgress, useStopOnLeave } from '../lib/sound-playback';
import type { PlayableSound } from '../lib/sound-player';

interface Sound {
  name: string;
  kind: SoundKind;
  source: 'generated' | 'imported' | 'store';
  assetId: string | null;
  file?: string;
  /** Imported tracks: who made it, under which license, and where it is from. */
  credit?: { title: string; creator: string; license: string; licenseName: string; licenseUrl?: string; sourceUrl: string; attribution: string };
  variations?: Array<{ file: string; assetId: string | null }>;
  volume: number;
  looped: boolean;
  pitchVariation?: number;
  description?: string;
  preset?: string;
  style?: string;
  durationSec?: number;
  /** The mastering gate's line (generated sounds). */
  check?: string;
  upload?: { error?: string; at: string };
  /** Made here to try out: not in the game until "Add to game". */
  draft?: boolean;
  /** The game's scripts that play it. */
  playedBy?: string[];
  /** Its asset row (the dashboard may open the page on it). */
  asset?: string;
  updatedAt: string;
  peaks: number[] | null;
}

interface AudioList {
  sounds: Sound[];
  presets: string[];
  styles: string[];
  uploads: { key: boolean; enabled: boolean; creatorId: string | null };
  runtime: { file: string; requirePath: string } | null;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const playable = (s: Sound): PlayableSound => ({ name: s.name, looped: s.looped, playable: canPlay(s), version: s.updatedAt });

/** Draws peaks as mirrored bars; the played part in the accent color. */
function Waveform({ peaks, progress, onSeek }: { peaks: number[]; progress: number; onSeek?: (f: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--color-accent').trim() || '#ff7a1a';
    const faint = css.getPropertyValue('--color-line2').trim() || '#3a332d';
    const n = peaks.length;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.02, Math.min(1, peaks[i] ?? 0));
      const bh = v * (h - 4);
      g.fillStyle = progress > 0 && (i + 0.5) / n <= progress ? accent : faint;
      g.fillRect(i * bw + bw * 0.15, (h - bh) / 2, Math.max(1, bw * 0.7), bh);
    }
  }, [peaks, progress]);
  return (
    <canvas
      ref={ref}
      className={cx('h-24 w-full', onSeek && 'cursor-pointer')}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek?.((e.clientX - r.left) / r.width);
      }}
    />
  );
}

/** The selected sound's waveform, Play/Stop and its takes (a take button plays that take). */
function Player({ sound }: { sound: Sound }) {
  const now = useNowPlaying();
  const on = now.name === sound.name && now.status !== 'idle';
  const take = now.name === sound.name ? now.take : 0;
  const progress = usePlayProgress(sound.name, take);
  const can = canPlay(sound);
  const takes = 1 + (sound.variations?.length ?? 0);
  return (
    <div className="rounded-2xl border border-line bg-bg2 p-4">
      {sound.peaks ? (
        <Waveform peaks={sound.peaks} progress={progress} onSeek={can ? (f) => (now.status === 'playing' && on ? soundPlayer.seek(f) : void soundPlayer.play(playable(sound), take, f)) : undefined} />
      ) : (
        <div className="flex h-24 flex-col items-center justify-center gap-1 text-[12.5px] text-faint">
          {sound.source === 'store' ? (
            <>
              <span>A Creator Store sound: it plays in Studio and in the game.</span>
              {sound.assetId && (
                <button className="text-accent2 hover:underline" onClick={() => void window.shuriken.openExternal(`https://create.roblox.com/store/asset/${sound.assetId}`)}>
                  Listen on the Creator Store
                </button>
              )}
            </>
          ) : (
            'No waveform yet.'
          )}
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button kind="primary" icon={now.status === 'loading' && on ? <Loader2 size={14} className="animate-spin" /> : on ? <Square size={13} /> : <Play size={14} />} onClick={() => void soundPlayer.toggle(playable(sound))} disabled={!can}>
          {on ? 'Stop' : 'Play'}
        </Button>
        {takes > 1 && (
          <div className="flex items-center gap-1">
            {Array.from({ length: takes }, (_, i) => (
              <button
                key={i}
                onClick={() => void soundPlayer.toggle(playable(sound), i)}
                className={cx('h-7 min-w-7 rounded-lg px-2 text-[11.5px] tabular-nums transition-colors', on && take === i ? 'bg-accent/15 text-accent2' : 'text-faint hover:bg-white/6 hover:text-dim')}
                title={i ? `Play variation ${i}` : 'Play the main take'}
              >
                {i + 1}
              </button>
            ))}
            <span className="ml-1 text-[11px] text-faint">takes, played at random in game</span>
          </div>
        )}
        {sound.durationSec !== undefined && <span className="ml-auto text-[12px] text-faint tabular-nums">{soundLength(sound.durationSec)}</span>}
      </div>
      {now.name === sound.name && now.error && (
        <div className="mt-3">
          <ErrorNote error={now.error} />
        </div>
      )}
    </div>
  );
}

/** One sound in the list: click plays it (or stops it when it's the one playing). */
function SoundRow({ s, selected, now, onPick, rowRef }: { s: Sound; selected: boolean; now: { name: string | null; status: string }; onPick: () => void; rowRef: (el: HTMLDivElement | null) => void }) {
  const st = soundState(s);
  const on = now.name === s.name && now.status !== 'idle';
  const can = canPlay(s);
  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onPick}
      title={can ? (on ? 'Click to stop' : 'Click to play') : 'A Creator Store sound: it plays in Studio and in the game'}
      className={cx(
        'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/70',
        selected ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text',
      )}
    >
      <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full', on ? 'bg-accent/20 text-accent2' : can ? (selected ? 'text-accent2' : 'text-faint') : 'text-info')}>
        {on && now.status === 'loading' ? <Loader2 size={12} className="animate-spin" /> : on ? <Square size={10} fill="currentColor" /> : can ? <Play size={12} /> : <Store size={12} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.name}</span>
      <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{soundLength(s.durationSec)}</span>
      <span className={cx('w-[66px] shrink-0 text-right text-[10.5px]', st.tone)} title={st.title}>
        {st.label}
      </span>
    </div>
  );
}

/** "Play it from game code", the numbers and Remove: what most visits don't need. */
function SoundDetails({ s, runtime, busy, onRemove }: { s: Sound; runtime: AudioList['runtime']; busy: boolean; onRemove: () => void }) {
  const measured = checkWords(s.check);
  const rows: Array<[string, string]> = [
    ...(!s.draft ? [['Roblox asset', s.assetId ?? 'not uploaded'] as [string, string]] : []),
    ['Volume', String(s.volume)],
    ['Loops', s.looped ? 'yes' : 'no'],
    ...(s.pitchVariation ? [['Pitch variation', `±${Math.round(s.pitchVariation * 100)}%`] as [string, string]] : []),
    ...(s.playedBy?.length ? [['Played by', s.playedBy.join(', ')] as [string, string]] : []),
    ...(measured ? [['Measured', measured] as [string, string]] : []),
  ];
  return (
    <div className="mt-2 space-y-3 rounded-xl border border-line bg-bg2/60 px-4 py-3">
      <div className="space-y-1.5 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <span className="shrink-0 text-faint">{k}</span>
            <span className="min-w-0 text-right break-words text-dim tabular-nums">{v}</span>
          </div>
        ))}
      </div>
      {runtime && !s.draft && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Play it from game code</div>
          <pre className="rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-dim">
            {`local Audio = require(${runtime.requirePath})\n${s.kind === 'music' ? `Audio.music("${s.name}")` : `Audio.play("${s.name}", position) -- or no position for 2D`}`}
          </pre>
        </div>
      )}
      <Button size="sm" kind="danger" icon={<Trash2 size={13} />} disabled={busy} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

/** A section that opens on a click (Details). */
function Disclosure({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button onClick={onToggle} aria-expanded={open} className="flex items-center gap-1 rounded-md py-1 text-[12px] font-medium text-dim outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent/70">
      <ChevronRight size={14} className={cx('transition-transform', open && 'rotate-90')} />
      {label}
    </button>
  );
}

/**
 * Audio workshop: the game's music, sound effects and ambience as one list to listen through (a click
 * plays a sound, the arrow keys move and play, Space plays/stops), the selected sound with its waveform
 * and where it stands (draft → Add to game, in game, unused, not uploaded), and the Music & sound copilot
 * beside it, open whenever the page opens: it composes, designs and finds sounds (drafts stay here until
 * the user adds them). Numbers, code and Remove sit under Details.
 */
export function AudioPage({ selectedId }: { selectedId?: string }) {
  const list = useRpc<AudioList>('audio.list', {}, ['assets.changed', 'project.changed']);
  const sounds = useMemo(() => list.data?.sounds ?? [], [list.data]);
  const groups = useMemo(() => groupSounds(sounds), [sounds]);
  const [sel, setSel] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useCopilotOpen('audio');
  useEffect(() => setDockContext('audio', sel ?? undefined), [sel]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const now = useNowPlaying();
  const overlays = useOverlaysOpen();
  const rows = useRef(new Map<string, HTMLDivElement>());
  const held = useRef<ReturnType<typeof setTimeout> | null>(null);
  useStopOnLeave();

  // Opened on a sound (the dashboard, a copilot's link): select it; nothing plays until the user asks.
  useEffect(() => {
    if (selectedId && sounds.some((s) => s.name === selectedId)) setSel(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, sounds.length]);

  useEffect(() => {
    if (sel && sounds.some((s) => s.name === sel)) return;
    const byAsset = selectedId ? sounds.find((s) => s.name === selectedId || s.asset === selectedId) : undefined;
    setSel(byAsset?.name ?? groups[0]?.sounds[0]?.name ?? null);
  }, [sounds, groups, sel, selectedId]);

  useEffect(() => {
    if (sel) rows.current.get(sel)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  // A sound link clicked while the page is open (the copilot's "Play Music_Phonk") plays it; opening the page doesn't.
  const route = useRoute();
  const openedAt = useRef(route.seq);
  useEffect(() => {
    if (route.seq === openedAt.current || route.page !== 'audio' || !route.id) return;
    const s = sounds.find((x) => x.name === route.id || x.asset === route.id);
    if (!s) return;
    setSel(s.name);
    void soundPlayer.play(playable(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.seq]);

  // The list's keys (lib/sound-list.ts navAction): never while typing, in the copilot, or under a menu or dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const action = navAction(
        e,
        { tag: t?.tagName ?? 'BODY', editable: !!t?.isContentEditable || /^(textbox|slider|spinbutton|combobox)$/.test(t?.getAttribute('role') ?? ''), inSounds: !!t?.closest('[data-sound-keys]') },
        overlays,
      );
      if (!action) return;
      const next = moveSelection(groups, sel, action);
      const s = next ? sounds.find((x) => x.name === next) : undefined;
      if (!s) return;
      e.preventDefault();
      if (action === 'toggle') return void soundPlayer.toggle(playable(s));
      rows.current.get(s.name)?.focus({ preventScroll: true });
      if (s.name === sel) return;
      setSel(s.name);
      if (held.current) clearTimeout(held.current);
      // A held arrow runs through the list: the sound it stops on plays.
      if (e.repeat) {
        soundPlayer.stop();
        held.current = setTimeout(() => void soundPlayer.play(playable(s)), 180);
      } else void soundPlayer.play(playable(s));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (held.current) clearTimeout(held.current);
    };
  }, [groups, sounds, sel, overlays]);

  const current = sounds.find((s) => s.name === sel) ?? null;
  const uploads = list.data?.uploads;
  const pending = sounds.filter((s) => s.source !== 'store' && !s.draft && !s.assetId).length;

  const pick = (s: Sound) => {
    setSel(s.name);
    void soundPlayer.toggle(playable(s));
  };

  const run = async (label: string, method: string, params: unknown, then?: (made: string | null) => void) => {
    setBusy(label);
    setNote(null);
    try {
      const r = await rpc<{ ok: boolean; text: string }>(method, params);
      if (!r.ok) setNote(r.text.slice(0, 600));
      // The name it was saved under (a draft gets the next free name when the game has one like it).
      let made: string | null = null;
      try {
        made = (JSON.parse(r.text) as { name?: string }).name ?? null;
      } catch {
        /* not JSON */
      }
      then?.(made);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
      list.reload();
    }
  };

  const st = current ? soundState(current) : null;
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Audio" back>
        <CopilotToggle dock="audio" open={copilotOpen} onChange={setCopilotOpen} />
      </TopBar>
      <WithCopilot dock="audio" open={copilotOpen} onClose={() => setCopilotOpen(false)}>
        <div className="@container flex min-h-0 flex-1 flex-col" data-sound-keys>
          {uploads && !uploads.key && sounds.some((s) => s.source !== 'store' && !s.draft) ? (
            <div className="shrink-0 border-b border-warn/20 bg-warn/8 px-5 py-2 text-[12px] leading-relaxed text-dim">
              Sounds made here play in Roblox once they're uploaded: add an Open Cloud API key with the <b className="text-text">Assets</b> read/write permission in Settings and Shuriken uploads them (free).
            </div>
          ) : pending > 0 && uploads?.key ? (
            <div className="flex shrink-0 items-center gap-3 border-b border-line bg-bg2 px-5 py-2 text-[12px] text-dim">
              <span className="min-w-0 flex-1">
                {pending} sound{pending === 1 ? ' is' : 's are'} in the game but silent until uploaded.
              </span>
              <Button size="sm" icon={<CloudUpload size={13} />} disabled={!!busy} onClick={() => void run('upload', 'audio.upload', {})}>
                {busy === 'upload' ? 'Uploading…' : 'Upload'}
              </Button>
            </div>
          ) : null}
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] @xl:grid-cols-[minmax(230px,300px)_minmax(0,1fr)] @xl:grid-rows-1">
            <div className="flex min-h-0 flex-col border-b border-line @xl:border-r @xl:border-b-0">
              {sounds.length > 0 && <div className="shrink-0 border-b border-line px-4 py-2 text-[11px] leading-snug text-faint">Click to play · ↑↓←→ move · Space play/stop</div>}
              <div role="listbox" aria-label="The game's sounds" className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-8">
                {sounds.length === 0 && <div className="px-2 text-[12px] leading-snug text-faint">{list.data ? 'No sounds yet. Ask the copilot beside the list for music, ambience or sound effects: it composes them, designs them or finds cleared recordings, and they wait here as drafts until you add them.' : 'Loading…'}</div>}
                {groups.map((g) => (
                  <div key={g.kind} role="group" aria-label={KIND_LABEL[g.kind]} className="mb-4">
                    <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
                      {KIND_LABEL[g.kind]} <span className="font-normal tracking-normal">{g.sounds.length}</span>
                    </div>
                    {g.sounds.map((s) => (
                      <SoundRow
                        key={s.name}
                        s={s}
                        selected={sel === s.name}
                        now={now}
                        onPick={() => pick(s)}
                        rowRef={(el) => {
                          if (el) rows.current.set(s.name, el);
                          else rows.current.delete(s.name);
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <main className="min-h-0 overflow-y-auto px-6 py-5">
              <div className="mx-auto max-w-2xl">
                {current && st ? (
                  <>
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <h1 className="font-display text-[26px] leading-tight break-all text-text">{current.name}</h1>
                      <Pill>{KIND_LABEL[current.kind]}</Pill>
                      {current.source === 'store' ? <Pill tone="info">Creator Store</Pill> : current.source === 'imported' ? <Pill tone="info">{current.credit ? `Imported · ${current.credit.licenseName}` : 'Imported'}</Pill> : <Pill tone="accent">{current.preset ? `made from ${current.preset}` : current.style ? `${current.style} track` : 'made here'}</Pill>}
                    </div>
                    {current.description && <p className="mt-1 text-[13px] text-dim">{current.description}</p>}
                    {current.credit && (
                      <p className="mt-1 text-[12px] leading-snug text-faint" title={current.credit.attribution}>
                        “{current.credit.title}” by {current.credit.creator} · {current.credit.licenseName}
                        {current.credit.license === 'by' || current.credit.license === 'by-sa' ? ' · needs a credit in your game (audio/CREDITS.md)' : ' · no credit needed'}
                        {current.credit.sourceUrl.startsWith('https://') && (
                          <>
                            {' · '}
                            <button className="text-accent2 hover:underline" onClick={() => void window.shuriken.openExternal(current.credit!.sourceUrl)}>
                              source
                            </button>
                          </>
                        )}
                      </p>
                    )}
                    {current.draft && (
                      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-bg2 px-4 py-3 text-[12.5px] leading-relaxed text-dim">
                        <CircleDashed size={15} className="shrink-0 text-faint" />
                        <span className="min-w-0 flex-1">A draft to try out: it's only here in Shuriken, not in your game, until you add it.</span>
                        <Button size="sm" kind="primary" icon={<Plus size={13} />} disabled={!!busy} onClick={() => void run('use', 'audio.use', { name: current.name })} title="Upload it (when an Open Cloud key allows) and put it in the game's sounds, so its code can play it">
                          {busy === 'use' ? 'Adding…' : 'Add to game'}
                        </Button>
                      </div>
                    )}
                    <div className="mt-4">
                      <Player sound={current} />
                    </div>
                    {!current.draft && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] leading-snug">
                        <span className={cx('font-medium', st.tone)}>{titleCase(st.label)}</span>
                        <span className="min-w-0 flex-1 text-dim">
                          {st.label === 'in game'
                            ? `Played by ${current.playedBy!.map((f) => f.split('/').pop()).join(', ')}`
                            : st.label === 'unused'
                              ? "In the game's sounds; no script plays it yet."
                              : 'In the game, but silent until it is uploaded to Roblox.'}
                        </span>
                        {current.source !== 'store' && !current.assetId && (
                          <Button size="sm" icon={<CloudUpload size={13} />} disabled={!!busy || !uploads?.key} onClick={() => void run('upload', 'audio.upload', { name: current.name })} title={uploads?.key ? 'Upload to Roblox (free)' : 'Needs an Open Cloud key in Settings'}>
                            {busy === 'upload' ? 'Uploading…' : 'Upload'}
                          </Button>
                        )}
                        {current.upload?.error && !current.assetId && <div className="w-full text-[11.5px] text-warn">{current.upload.error}</div>}
                      </div>
                    )}
                    <div className="mt-4">
                      <Disclosure open={details} onToggle={() => setDetails((d) => !d)} label="Details" />
                      {details && (
                        <SoundDetails
                          s={current}
                          runtime={list.data?.runtime ?? null}
                          busy={!!busy}
                          onRemove={() => {
                            const name = current.name;
                            if (soundPlayer.isOn(name)) soundPlayer.stop();
                            soundPlayer.forget(name);
                            void run('remove', 'audio.remove', { name }, () => setSel(null));
                          }}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  sounds.length > 0 && <Empty icon={<Music2 size={20} />}>Pick a sound to hear it.</Empty>
                )}
                {note && (
                  <div className="mt-3">
                    <ErrorNote error={note} />
                  </div>
                )}
              </div>
            </main>
          </div>
        </div>
      </WithCopilot>
    </div>
  );
}
