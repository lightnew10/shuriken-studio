import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleDashed, Clapperboard, Copy, Flame, Pause, Play, Plus, ScanSearch, Sparkles, Sword, Trash2 } from 'lucide-react';
import { LOWER_BODY, type AnimationClip, type ClipMetrics } from '@shared/animation';
import type { RigClipMetrics, RigSpec } from '@shared/rig';
import type { EffectSpec } from '@shared/effects';
import type { AnimationSummary } from '@shared/domain';
import { TopBar } from '../components/topbar';
import { Button, Empty, ErrorNote, IconButton, Pill, Segmented, cx, inputClass, timeAgo } from '../components/ui';
import { rpc, useRpc } from '../lib/rpc';
import { MannequinView } from '../components/anim/mannequin';
import { RigPlayer } from '../components/anim/rig-player';
import { useRigModel, type RigModel, type RigPartRow } from '../components/anim/rig-model';
import type { ModelPart } from '../components/models/model-view';
import { EffectsView } from '../components/anim/effects-view';
import { CopilotToggle, WithCopilot, setDockContext, useCopilotOpen } from '../containers/copilot-chat';
import { SendToStudio } from '../components/send-to-studio';
import { AddToGame } from '../components/add-to-game';

interface PresetInfo {
  id: string;
  category: 'combat' | 'unarmed' | 'reaction' | 'movement';
  description: string;
  loop: boolean;
  duration: number;
  markers: string[];
}

interface ListResult {
  animations: AnimationSummary[];
  broken: Array<{ name: string; problems: string[] }>;
  runtime: { file: string; requirePath: string } | null;
}

type Selection = { kind: 'game'; name: string } | { kind: 'preset'; id: string };

const CATEGORY: Record<PresetInfo['category'], string> = { combat: 'Sword combat', unarmed: 'Unarmed combat', reaction: 'Reactions', movement: 'Movement' };
/** Preset combos, in order (the game's own combos are found by numbered names: M1_1, M1_2 …). */
const PRESET_COMBOS = [
  ['SwordSlash1', 'SwordSlash2', 'SwordSlash3'],
  ['PunchJab', 'PunchCross', 'PunchHook', 'PunchUppercut'],
];

/** The combo a move belongs to: numbered siblings in the game ("Slash1", "Slash2" …) or a preset combo. */
function comboOf(sel: { kind: 'game'; name: string } | { kind: 'preset'; id: string }, game: string[]): string[] | null {
  if (sel.kind === 'preset') return PRESET_COMBOS.find((c) => c.includes(sel.id)) ?? null;
  const m = /^(.*?)(\d+)$/.exec(sel.name);
  if (!m) return null;
  const members = game
    .map((n) => ({ n, m: /^(.*?)(\d+)$/.exec(n) }))
    .filter((x) => x.m && x.m[1] === m[1])
    .sort((a, b) => Number(a.m![2]) - Number(b.m![2]))
    .map((x) => x.n);
  return members.length >= 2 ? members : null;
}

/** Clips played back to back as one clip (a short settle between them), for previewing a combo. */
function chainClips(clips: AnimationClip[], gap = 0.04): AnimationClip {
  let offset = 0;
  const keys: AnimationClip['keys'] = [];
  const markers: NonNullable<AnimationClip['markers']> = [];
  const r = (v: number) => Math.round(v * 1000) / 1000;
  for (const c of clips) {
    const d = Math.max(...c.keys.map((k) => k.t));
    for (const k of c.keys) keys.push({ ...k, t: r(k.t + offset) });
    for (const m of c.markers ?? []) markers.push({ ...m, t: r(m.t + offset) });
    offset += d + gap;
  }
  return { name: clips.map((c) => c.name).join(' → '), description: 'Combo preview', loop: false, priority: 'Action', keys, markers };
}

/** What the stage drives: the R15 mannequin, or a rigged model for a custom rig's clips. */
interface Player {
  time: number;
  playing: boolean;
  speed: number;
  onTime: ((t: number) => void) | null;
  setClip(clip: AnimationClip | null, opts?: { sword?: false | 'left' | 'right'; under?: AnimationClip | null }): void;
  seek(t: number): void;
  snapshots(times: number[]): string[];
  dispose(): void;
  whenReady?: () => Promise<unknown>;
}

const isCombat = (name: string, preset?: string | null) => /^Sword/.test(preset ?? '') || /sword|slash|parry|block|guard|thrust|strike/i.test(name);

/** The live mannequin (or, for a custom rig's clip, the rigged model) plus its timeline. Keyed by rig. */
function Stage({ clip, sword, markers, rig, under }: { clip: AnimationClip | null; sword: false | 'left' | 'right'; markers: Array<{ name: string; t: number }>; rig?: RigModel | null; under?: AnimationClip | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<Player | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<'0.25' | '0.5' | '1'>('1');
  const duration = clip ? Math.max(...clip.keys.map((k) => k.t), ...(clip.markers ?? []).map((m) => m.t)) : 0;

  useEffect(() => {
    if (!host.current) return;
    const v: Player = rig ? new RigPlayer(host.current, rig.spec, rig.parts) : new MannequinView(host.current, { interactive: true });
    let last = 0;
    v.onTime = (x) => {
      const now = performance.now();
      if (now - last > 40 || x === 0) {
        last = now;
        setT(x);
      }
    };
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, []);

  // Key poses at a glance: evenly spaced stills plus every marker moment.
  const [strip, setStrip] = useState<Array<{ t: number; url: string; marker?: string }>>([]);
  useEffect(() => {
    view.current?.setClip(clip, { sword, under });
    if (view.current) view.current.playing = true;
    setPlaying(true);
    if (!clip || !view.current || duration <= 0) {
      setStrip([]);
      return;
    }
    const times: Array<{ t: number; marker?: string }> = [];
    const n = 6;
    for (let i = 0; i <= n; i++) times.push({ t: Math.round(((duration * i) / n) * 1000) / 1000 });
    for (const m of clip.markers ?? []) {
      const near = times.findIndex((x) => Math.abs(x.t - m.t) < duration / (n * 2));
      if (near >= 0) times[near] = { t: m.t, marker: m.name };
      else times.push({ t: m.t, marker: m.name });
    }
    times.sort((a, b) => a.t - b.t);
    // Let the stage lay out (and a rigged model load) first so the stills use its final size.
    let cancelled = false;
    const id = window.setTimeout(() => {
      void (view.current?.whenReady?.() ?? Promise.resolve()).then(() => {
        if (cancelled) return;
        const urls = view.current?.snapshots(times.map((x) => x.t)) ?? [];
        setStrip(times.map((x, i) => ({ ...x, url: urls[i] ?? '' })));
      });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, sword]);

  useEffect(() => {
    if (view.current) view.current.speed = Number(speed);
  }, [speed]);

  const toggle = () => {
    const v = view.current;
    if (!v) return;
    if (!v.playing && v.time >= duration - 1e-3) v.seek(0);
    v.playing = !v.playing;
    setPlaying(v.playing);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={host} className="relative min-h-0 flex-1" />
      {strip.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-line bg-bg2/60 px-3 py-2">
          {strip.map((f) => (
            <button
              key={`${f.t}${f.marker ?? ''}`}
              onClick={() => {
                const v = view.current;
                if (!v) return;
                v.playing = false;
                setPlaying(false);
                v.seek(f.t);
              }}
              title={f.marker ? `${f.marker} at ${f.t}s` : `${f.t}s`}
              className={cx('relative shrink-0 overflow-hidden rounded-lg ring-1 transition-colors hover:ring-accent/60', f.marker ? 'ring-accent/50' : 'ring-line')}
            >
              <img src={f.url} alt="" className="h-[88px] w-[70px] object-cover" draggable={false} />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-px text-center font-mono text-[9.5px] text-white/80 tabular-nums">
                {f.marker ? `${f.marker} ` : ''}
                {f.t.toFixed(2)}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3">
        <IconButton title={playing ? 'Pause' : 'Play'} onClick={toggle} active>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </IconButton>
        <span className="shrink-0 font-mono text-[12px] whitespace-nowrap tabular-nums text-dim">
          {t.toFixed(2)} / {duration.toFixed(2)}s
        </span>
        <div className="relative min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.005}
            value={t}
            disabled={!clip}
            onChange={(e) => {
              const v = view.current;
              if (!v) return;
              v.playing = false;
              setPlaying(false);
              v.seek(Number(e.target.value));
            }}
            className="no-drag w-full accent-[var(--color-accent)]"
            aria-label="Scrub the animation"
          />
          {duration > 0 &&
            markers.map((m) => (
              <span
                key={`${m.name}${m.t}`}
                title={`${m.name} at ${m.t}s`}
                className="pointer-events-none absolute -top-3.5 -translate-x-1/2 text-[9.5px] font-semibold tracking-wide text-accent2"
                style={{ left: `${(m.t / duration) * 100}%` }}
              >
                {m.name}
              </span>
            ))}
        </div>
        <Segmented
          value={speed}
          onChange={setSpeed}
          options={[
            { value: '0.25', label: '¼×' },
            { value: '0.5', label: '½×' },
            { value: '1', label: '1×' },
          ]}
        />
      </div>
    </div>
  );
}

/** Paste the Roblox id of an animation uploaded from Studio ("Save to Roblox"). */
function AssetIdInput({ name, current }: { name: string; current: string | null }) {
  const [value, setValue] = useState(current ?? '');
  const [state, setState] = useState<string | null>(null);
  useEffect(() => setValue(current ?? ''), [current, name]);
  return (
    <div className="mt-2 flex gap-2">
      <input value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Roblox animation id" className={cx(inputClass, 'tabular-nums')} aria-label="Uploaded animation id" />
      <Button
        size="sm"
        disabled={!value || value === current}
        onClick={() =>
          void rpc<{ note: string }>('animations.setAsset', { name, assetId: value })
            .then((r) => setState(r.note))
            .catch((e) => setState((e as Error).message))
        }
      >
        Save
      </Button>
      {state && <span className="self-center text-[11px] text-faint">{state}</span>}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="text-faint">{label}</span>
      <span className="text-right tabular-nums text-text">{children}</span>
    </div>
  );
}

const LIMB: Record<ClipMetrics['reach']['limb'], string> = { RightHand: 'Right hand', LeftHand: 'Left hand', RightFoot: 'Right foot', LeftFoot: 'Left foot' };

const v3 = (v: [number, number, number]) => `${v[2] >= 0 ? `${v[2].toFixed(1)} fwd` : `${(-v[2]).toFixed(1)} back`}, ${v[1] >= 0 ? `${v[1].toFixed(1)} up` : `${(-v[1]).toFixed(1)} down`}, ${v[0] >= 0 ? `${v[0].toFixed(1)} right` : `${(-v[0]).toFixed(1)} left`}`;

function Metrics({ m }: { m: ClipMetrics | undefined }) {
  if (!m) return null;
  const sink = m.footSink < -0.08;
  return (
    <div className="mt-4">
      <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Measured on the rig</div>
      <Stat label="Feet">
        {sink ? <span className="text-warn">{Math.abs(m.footSink).toFixed(2)} studs into the floor</span> : m.footLift > 0.3 ? `leave the ground (${m.footLift.toFixed(2)})` : 'on the ground'}
      </Stat>
      <Stat label="Reach">
        {LIMB[m.reach.limb]} {m.reach.forward.toFixed(1)} studs forward
      </Stat>
      {m.markers.map((x) => (
        <Stat key={`${x.name}${x.t}`} label={`At ${x.name} (${x.t}s)`}>
          <span className="text-[11.5px]">
            {LIMB[x.strike.limb].toLowerCase()} {v3(x.strike.at)}
          </span>
        </Stat>
      ))}
    </div>
  );
}

/** A custom rig's clip measured on its rig: ground, planted feet, reach at markers, and what looks wrong. */
function RigMetrics({ c }: { c: { metrics: RigClipMetrics; findings: string[] } }) {
  const m = c.metrics;
  const slide = Math.max(0, ...m.feet.map((f) => f.slide));
  return (
    <div className="mt-4">
      <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Measured on the rig</div>
      {m.groundSpeed !== null && <Stat label="Moves at">{m.groundSpeed.toFixed(2)} studs/s</Stat>}
      <Stat label="Ground">{m.sink && m.sink.depth > 0.1 ? <span className="text-warn">{m.sink.segment} {m.sink.depth.toFixed(2)} studs in at {m.sink.t}s</span> : 'stays on top'}</Stat>
      {m.feet.length > 0 && (
        <Stat label="Feet">
          {Math.round((m.feet.reduce((a, f) => a + f.contact, 0) / m.feet.length) * 100)}% planted{slide > 0.3 ? <span className="text-warn"> · slide {slide.toFixed(2)} studs/s</span> : ''}
        </Stat>
      )}
      {m.markers.map((x) => (
        <Stat key={`${x.name}${x.t}`} label={`At ${x.name} (${x.t}s)`}>
          <span className="text-[11.5px]">{x.reach > 0.05 ? `reaches ${x.reach.toFixed(1)} studs past its front` : 'within its body'}</span>
        </Stat>
      ))}
      {c.findings.map((f) => (
        <div key={f} className="mt-1.5 rounded-lg bg-warn/8 px-2 py-1.5 text-[11.5px] leading-snug text-warn">
          {f}
        </div>
      ))}
    </div>
  );
}

function CopyCode({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group relative mt-2 rounded-xl border border-line bg-bg2">
      <pre className="px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-dim">{code}</pre>
      <button
        className="absolute top-1.5 right-1.5 rounded-lg p-1.5 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/6 hover:text-text"
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        }}
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

/**
 * Animation workshop: the game's animations, the dock's drafts and the preset library, played on a live
 * R15 mannequin (the same kinematics Roblox uses), with markers, measurements and the code that plays
 * them. Presets can be tuned and added to the game from here; agents add and tune the rest; what the
 * copilot makes is a draft that plays here until the user adds it to the game (Add to game).
 */
export function AnimationPage({ selectedId }: { selectedId?: string }) {
  const fx = useRpc<{ effects: Array<{ name: string }> }>('effects.list', {}, ['effects.changed', 'animations.changed', 'project.changed']);
  const [tab, setTab] = useState<'moves' | 'effects'>('moves');
  // Opened from an effect (dashboard/asset link) or on "effects" (the dashboard's Effects container): start on the Effects tab.
  useEffect(() => {
    if (selectedId && (selectedId === 'effects' || fx.data?.effects.some((e) => e.name === selectedId))) setTab('effects');
  }, [selectedId, fx.data]);
  const dock = tab === 'moves' ? 'animation' : 'effects';
  const [animOpen, setAnimOpen] = useCopilotOpen('animation');
  const [fxOpen, setFxOpen] = useCopilotOpen('effects');
  const open = tab === 'moves' ? animOpen : fxOpen;
  const setOpen = tab === 'moves' ? setAnimOpen : setFxOpen;
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Animation" back>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'moves', label: 'Moves' },
            { value: 'effects', label: 'Effects' },
          ]}
        />
        <CopilotToggle dock={dock} open={open} onChange={setOpen} />
      </TopBar>
      <WithCopilot dock={dock} open={open} onClose={() => setOpen(false)}>
        {tab === 'moves' ? <MovesWorkshop selectedId={selectedId} /> : <EffectsWorkshop selectedId={selectedId} />}
      </WithCopilot>
    </div>
  );
}

function MovesWorkshop({ selectedId }: { selectedId?: string }) {
  const list = useRpc<ListResult>('animations.list', {}, ['animations.changed', 'project.changed']);
  const presets = useRpc<PresetInfo[]>('animations.presets');
  const game = list.data?.animations ?? [];
  // Kiln's clips by model (custom animation authored in Kiln), and everything else.
  const fromKiln = useMemo(() => {
    const g = new Map<string, AnimationSummary[]>();
    for (const a of game) if (a.kiln) g.set(a.kiln.model, [...(g.get(a.kiln.model) ?? []), a]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [game]);
  const own = useMemo(() => game.filter((a) => !a.kiln && !a.draft), [game]);
  // Made in the dock to try out: they play here and are not in the game until added.
  const drafts = useMemo(() => game.filter((a) => a.draft), [game]);
  const [sel, setSel] = useState<Selection | null>(null);
  const [params, setParams] = useState({ intensity: 1, speed: 1, hand: 'right' as 'left' | 'right', body_part: 'full' as 'full' | 'upper' });
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [combo, setCombo] = useState<AnimationClip | null>(null);

  // Opened on a specific animation (again): select it.
  useEffect(() => {
    if (selectedId && game.some((a) => a.name === selectedId)) setSel({ kind: 'game', name: selectedId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, game.length]);

  // Default selection: the asset opened from the dashboard, the newest game animation, or a preset.
  useEffect(() => {
    if (sel) return;
    if (selectedId && game.some((a) => a.name === selectedId)) setSel({ kind: 'game', name: selectedId });
    else if (game[0]) setSel({ kind: 'game', name: [...game].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!.name });
    else if (presets.data?.length) setSel({ kind: 'preset', id: 'SwordSlash1' });
  }, [sel, selectedId, game, presets.data]);

  const clipQuery = useRpc<{
    clip: AnimationClip;
    metrics?: ClipMetrics;
    summary?: AnimationSummary;
    preset?: string;
    params?: { hand?: string };
    rig?: RigSpec | null;
    rigParts?: RigPartRow[];
    rigCheck?: { metrics: RigClipMetrics; findings: string[] } | null;
  }>(
    sel ? (sel.kind === 'game' ? 'animations.get' : 'animations.preset') : null,
    sel?.kind === 'game' ? { name: sel.name } : sel ? { id: sel.id, ...params } : undefined,
    ['animations.changed'],
  );
  const clip = clipQuery.data?.clip ?? null;
  // An R15 move that leaves the hips and legs alone plays over the character's movement in the game:
  // preview it over a run.
  const overRun = !!clip && !clip.rig && !clip.loop && clip.keys.some((k) => Object.keys(k.poses).length) && !clip.keys.some((k) => Object.keys(k.poses).some((j) => (LOWER_BODY as readonly string[]).includes(j)));
  const runClip = useRpc<{ clip: AnimationClip }>(overRun ? 'animations.preset' : null, { id: 'Run' });
  const rigName = clip?.rig ?? null;
  const rigModel = useRigModel(clipQuery.data?.rig ?? null, clipQuery.data?.rigParts);
  const presetInfo = sel?.kind === 'preset' ? presets.data?.find((p) => p.id === sel.id) : undefined;
  const summary = sel?.kind === 'game' ? game.find((a) => a.name === sel.name) : undefined;
  const isDraft = !!summary?.draft;
  const name = sel?.kind === 'game' ? sel.name : (sel?.id ?? '');
  const leftHanded = sel?.kind === 'preset' ? params.hand === 'left' : clipQuery.data?.params?.hand === 'left';
  const sword: false | 'left' | 'right' = sel && !rigName && isCombat(name, sel.kind === 'preset' ? sel.id : summary?.preset) ? (leftHanded ? 'left' : 'right') : false;
  const markers = clip?.markers ?? [];

  useEffect(() => {
    setNote(null);
    setCombo(null);
    if (sel?.kind === 'preset') setNewName(sel.id);
  }, [sel]);
  useEffect(() => {
    if (!sel) setDockContext('animation', undefined);
    else if (sel.kind === 'preset') setDockContext('animation', sel.id, 'a preset template, not in the game yet');
    else setDockContext('animation', sel.name, isDraft ? 'a draft, not in the game yet' : rigName ? `the game's animation for the ${rigName} rig` : "the game's animation");
  }, [sel, rigName, isDraft]);

  const comboNames = sel ? comboOf(sel, game.map((a) => a.name)) : null;
  const playCombo = async () => {
    if (!sel || !comboNames) return;
    const clips = await Promise.all(
      comboNames.map((n) =>
        sel.kind === 'game'
          ? rpc<{ clip: AnimationClip }>('animations.get', { name: n }).then((r) => r.clip)
          : rpc<{ clip: AnimationClip }>('animations.preset', { id: n, ...params }).then((r) => r.clip),
      ),
    );
    setCombo(chainClips(clips));
  };

  const grouped = useMemo(() => {
    const g: Record<string, PresetInfo[]> = {};
    for (const p of presets.data ?? []) (g[p.category] ??= []).push(p);
    return g;
  }, [presets.data]);

  const act = async (label: string, fn: () => Promise<{ ok: boolean; text: string; data?: unknown }>, after?: () => void) => {
    setBusy(label);
    setNote(null);
    try {
      const r = await fn();
      setNote({ ok: r.ok, text: r.ok ? '' : r.text.slice(0, 600) });
      if (r.ok) after?.();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const usage = list.data?.runtime && sel?.kind === 'game'
    ? `local Anims = require(${list.data.runtime.requirePath})\n${rigName ? `local creature = game.ReplicatedStorage.ShurikenRigs.${rigName}:Clone()\ncreature.Parent = workspace\n` : ''}local track = Anims.play(${rigName ? 'creature' : 'character'}, "${sel.name}")${markers[0] ? `\nAnims.onMarker(track, "${markers[0].name}", function()\n  -- gameplay at this moment\nend)` : ''}`
    : '';

  return (
      <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_300px]">
        {/* Library */}
        <aside className="min-h-0 overflow-y-auto border-r border-line px-2 py-3">
          {fromKiln.map(([model, clips]) => (
            <div key={model} className="mb-3">
              <div className="flex items-center gap-1.5 px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase" title={`Made in Kiln on ${model}'s rig: each Kiln export updates them`}>
                <Flame size={11} className="text-accent2" /> {model} · from Kiln
              </div>
              {clips.map((a) => (
                <button
                  key={a.name}
                  onClick={() => setSel({ kind: 'game', name: a.name })}
                  className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel?.kind === 'game' && sel.name === a.name ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
                >
                  <Clapperboard size={13} className="shrink-0 text-accent2" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{a.kiln!.clip}</span>
                  <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{a.loop ? 'loop' : `${a.duration.toFixed(2)}s`}</span>
                </button>
              ))}
            </div>
          ))}
          {drafts.length > 0 && (
            <div className="mb-3">
              <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase" title="Made here to try out: not in your game until you add them">
                Drafts
              </div>
              {drafts.map((a) => (
                <button
                  key={a.name}
                  onClick={() => setSel({ kind: 'game', name: a.name })}
                  className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel?.kind === 'game' && sel.name === a.name ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
                >
                  <CircleDashed size={13} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{a.name}</span>
                  <span className="shrink-0 text-[10.5px] text-faint">draft</span>
                </button>
              ))}
            </div>
          )}
          <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">In this game</div>
          {own.length === 0 && <div className="px-2 pb-3 text-[12px] leading-snug text-faint">{fromKiln.length ? 'Nothing else yet.' : 'None yet. The animator adds them as it works, add a preset below, or animate a model in Kiln.'}</div>}
          {own.map((a) => (
            <button
              key={a.name}
              onClick={() => setSel({ kind: 'game', name: a.name })}
              className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel?.kind === 'game' && sel.name === a.name ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
            >
              <Clapperboard size={13} className="shrink-0 text-accent2" />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{a.name}</span>
              <span className="shrink-0 text-[10.5px] text-faint tabular-nums">{a.duration.toFixed(2)}s</span>
            </button>
          ))}
          {(list.data?.broken ?? []).map((b) => (
            <div key={b.name} className="mx-2 mt-1 rounded-lg bg-bad/8 px-2 py-1.5 text-[11.5px] text-bad" title={b.problems.join('\n')}>
              {b.name}: {b.problems[0]}
            </div>
          ))}
          {Object.entries(grouped).map(([cat, items]) => (
            <div key={cat} className="mt-4">
              <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">{CATEGORY[cat as PresetInfo['category']]}</div>
              {items.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSel({ kind: 'preset', id: p.id })}
                  className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel?.kind === 'preset' && sel.id === p.id ? 'bg-white/8 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.id}</span>
                  <span className="shrink-0 text-[10.5px] text-faint">{p.loop ? 'loop' : `${p.duration.toFixed(2)}s`}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* Stage */}
        <main className="relative flex min-h-0 flex-col">
          {combo && (
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-accent/8 px-4 py-2 text-[12px] text-dim">
              <span className="font-semibold text-accent2">Combo</span>
              <span className="min-w-0 flex-1 truncate">{combo.name}</span>
              <button className="text-faint hover:text-text" onClick={() => setCombo(null)}>
                Back to {name}
              </button>
            </div>
          )}
          {sel && rigName && !rigModel ? (
            <Empty icon={<Clapperboard size={20} />}>{clipQuery.data && !clipQuery.data.rig ? `${rigName} has no rig any more (models/${rigName}.rig.json).` : `Loading ${rigName}…`}</Empty>
          ) : sel ? (
            <>
              <Stage key={rigModel ? `rig:${rigModel.spec.model}` : 'r15'} clip={combo ?? clip} sword={sword} markers={combo?.markers ?? markers} rig={rigName ? rigModel : null} under={overRun ? runClip.data?.clip ?? null : null} />
              {overRun && runClip.data && <div className="pointer-events-none absolute top-3 left-3 rounded-md bg-black/40 px-2 py-1 text-[11.5px] text-dim">Shown over a run: it only moves the upper body, so in the game the legs keep running</div>}
            </>
          ) : (
            <Empty icon={<Clapperboard size={20} />}>Pick an animation or a preset.</Empty>
          )}
        </main>

        {/* Details */}
        <aside className="min-h-0 overflow-y-auto border-l border-line px-4 py-4">
          {sel && (
            <>
              <div className="font-display text-[22px] leading-tight text-text">{name}</div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-dim">{clip?.description ?? presetInfo?.description ?? ''}</div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Pill>{clip?.loop ? 'loops' : 'one-shot'}</Pill>
                {clip && <Pill>{clip.priority}</Pill>}
                {clip && <Pill>{clip.keys.length} keys</Pill>}
                {markers.map((m) => (
                  <Pill key={`${m.name}${m.t}`} tone="accent">
                    {m.name} {m.t}s
                  </Pill>
                ))}
                {sel.kind === 'preset' && <Pill tone="info">preset</Pill>}
                {summary?.preset && <Pill tone="info">from {summary.preset}</Pill>}
                {rigName && <Pill tone="info">{rigName} rig</Pill>}
                {summary?.kiln && <Pill tone="accent">made in Kiln</Pill>}
                {summary?.kiln?.speed ? <Pill tone="info">moves at {summary.kiln.speed.toFixed(2)} studs/s</Pill> : null}
                {summary?.kiln && !summary.kiln.inPlace && <Pill tone="info">moves the body (not in place)</Pill>}
                {isDraft && <Pill tone="warn">draft · not in the game</Pill>}
              </div>
              {comboNames && (
                <div className="mt-3">
                  <Button size="sm" icon={<Play size={13} />} onClick={() => void playCombo()} title={comboNames.join(' → ')}>
                    Play the {comboNames.length}-hit combo
                  </Button>
                </div>
              )}

              {sel.kind === 'preset' && (
                <div className="mt-5 space-y-3">
                  <label className="block">
                    <span className="flex justify-between text-[12px] text-dim">
                      Intensity <span className="tabular-nums text-faint">{params.intensity.toFixed(2)}</span>
                    </span>
                    <input type="range" min={0.5} max={1.5} step={0.05} value={params.intensity} onChange={(e) => setParams({ ...params, intensity: Number(e.target.value) })} className="no-drag w-full accent-[var(--color-accent)]" />
                  </label>
                  <label className="block">
                    <span className="flex justify-between text-[12px] text-dim">
                      Speed <span className="tabular-nums text-faint">{params.speed.toFixed(2)}×</span>
                    </span>
                    <input type="range" min={0.5} max={2} step={0.05} value={params.speed} onChange={(e) => setParams({ ...params, speed: Number(e.target.value) })} className="no-drag w-full accent-[var(--color-accent)]" />
                  </label>
                  <div className="flex items-center justify-between text-[12px] text-dim">
                    Hand
                    <Segmented
                      value={params.hand}
                      onChange={(hand) => setParams({ ...params, hand })}
                      options={[
                        { value: 'right', label: 'Right' },
                        { value: 'left', label: 'Left' },
                      ]}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[12px] text-dim" title="Upper body: only the torso, head and arms move, so it plays over walking and running (attack on the move)">
                    Body
                    <Segmented
                      value={params.body_part}
                      onChange={(body_part) => setParams({ ...params, body_part })}
                      options={[
                        { value: 'full', label: 'Whole' },
                        { value: 'upper', label: 'Upper' },
                      ]}
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <input value={newName} onChange={(e) => setNewName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} className={inputClass} placeholder="Name in the game" aria-label="Animation name" />
                    <Button
                      kind="primary"
                      icon={<Plus size={14} />}
                      disabled={!!busy || !newName || !list.data?.runtime}
                      title={list.data?.runtime ? 'Save it to the game and build it into Studio' : 'Open a project first'}
                      onClick={() =>
                        void act('add', () => rpc('animations.create', { name: newName, preset: sel.id, ...params }), () => setSel({ kind: 'game', name: newName }))
                      }
                    >
                      {busy === 'add' ? 'Adding…' : 'Add'}
                    </Button>
                  </div>
                </div>
              )}

              {sel.kind === 'game' && isDraft && (
                <>
                  <AddToGame dock="animation" name={sel.name} of={summary?.draftOf} inGame={(n) => game.some((a) => a.name === n && !a.draft)} onAdded={(n) => setSel({ kind: 'game', name: n })} className="mt-5" />
                  <div className="mt-3">
                    <Button size="sm" kind="danger" icon={<Trash2 size={13} />} disabled={!!busy} onClick={() => void act('remove', () => rpc('animations.remove', { name: sel.name }), () => setSel(null))}>
                      Remove the draft
                    </Button>
                  </div>
                </>
              )}
              {sel.kind === 'game' && !isDraft && (
                <div className="mt-5 flex flex-wrap items-start gap-2">
                  <SendToStudio method="animations.sendToStudio" params={{ name: sel.name }} title={rigName ? `Put a ${rigName} playing it in front of Studio's camera (press Run to see it)` : "Put a character playing it in front of Studio's camera (press Run to see it)"} />
                  <Button size="sm" icon={<ScanSearch size={13} />} disabled={!!busy} onClick={() => void act('check', () => rpc('animations.check', { name: sel.name }))} title="Play it on a real rig in Studio and measure it">
                    {busy === 'check' ? 'Checking…' : 'Check in Studio'}
                  </Button>
                  <Button size="sm" kind="danger" icon={<Trash2 size={13} />} disabled={!!busy} onClick={() => void act('remove', () => rpc('animations.remove', { name: sel.name }), () => setSel(null))}>
                    Remove
                  </Button>
                </div>
              )}
              {note && !note.ok && (
                <div className="mt-3">
                  <ErrorNote error={note.text} />
                </div>
              )}

              {clipQuery.data?.rigCheck ? <RigMetrics c={clipQuery.data.rigCheck} /> : <Metrics m={clipQuery.data?.metrics} />}

              {sel.kind === 'game' && !isDraft && (
                <div className="mt-5">
                  <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Play it from game code</div>
                  <CopyCode code={usage} />
                  <div className="mt-2 text-[11.5px] leading-snug text-faint">
                    {summary?.uploaded
                      ? `Uploaded as ${summary.uploaded}: plays in the published game too.`
                      : 'Plays in Studio straight away. For the published game it needs uploading once: with your Open Cloud key, press Upload; or in Studio right-click ReplicatedStorage › ShurikenAnimations › Sequences › ' + sel.name + ' › Save to Roblox and paste the id here.'}
                    {summary && ` Updated ${timeAgo(summary.updatedAt)}.`}
                  </div>
                  {!summary?.uploaded && (
                    <Button
                      size="sm"
                      className="mt-2"
                      disabled={!!busy}
                      onClick={() => void act('upload', () => rpc('animations.upload', { name: sel.name }))}
                      title="Upload to Roblox as an Animation asset (free; needs an Open Cloud key with the Assets permission)"
                    >
                      {busy === 'upload' ? 'Uploading…' : 'Upload to Roblox'}
                    </Button>
                  )}
                  <AssetIdInput name={sel.name} current={summary?.uploaded ?? null} />
                </div>
              )}
              {sword && (
                <div className="mt-4 flex items-center gap-1.5 text-[11.5px] text-faint">
                  <Sword size={12} /> Previewed with a sword in the {sword} hand.
                </div>
              )}
            </>
          )}
        </aside>
      </div>
  );
}

interface EffectRow {
  name: string;
  /** A draft made in the dock: it plays here and is not in the game until it is added. */
  draft?: boolean;
  draftOf?: string;
  description?: string;
  kind: 'burst' | 'persistent' | 'trail' | 'beam';
  emitters?: Array<{ name: string; color: string[]; emit?: number; rate?: number; texture: string }>;
  preset: string | null;
  updatedAt: string;
}

interface EffectPreset {
  id: string;
  category: string;
  kind: EffectRow['kind'];
  description: string;
  colors: [string, string];
}

type FxSel = { kind: 'game'; name: string } | { kind: 'preset'; id: string };

const KIND_LABEL: Record<EffectRow['kind'], string> = { burst: 'burst', persistent: 'stays on', trail: 'trail', beam: 'beam' };

function FxStage({ spec }: { spec: EffectSpec | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EffectsView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const v = new EffectsView(host.current, { interactive: true });
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, []);
  const [strip, setStrip] = useState<Array<{ t: number; url: string }>>([]);
  useEffect(() => {
    view.current?.setEffect(spec);
    setStrip([]);
    if (spec?.kind !== 'burst') return;
    // A filmstrip of the burst: more frames early, where most of the action is.
    const id = window.setTimeout(() => {
      const v = view.current;
      if (!v) return;
      const len = v.burstLength();
      const times = [0.04, 0.12, 0.24, 0.4, 0.6, 0.85].map((f) => Math.round(len * f * 1000) / 1000);
      const urls = v.snapshots(times);
      setStrip(times.map((t, i) => ({ t, url: urls[i] ?? '' })));
    }, 150);
    return () => window.clearTimeout(id);
  }, [spec]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" />
        {spec?.kind === 'burst' && (
          <button onClick={() => view.current?.fire()} className="absolute top-3 right-3 flex h-8 items-center gap-1.5 rounded-lg bg-surface/70 px-2.5 text-[12px] text-dim backdrop-blur hover:text-text">
            <Play size={13} /> Burst
          </button>
        )}
      </div>
      {strip.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-line bg-bg2/60 px-3 py-2">
          {strip.map((f) => (
            <div key={f.t} title={`${f.t}s after it starts`} className="relative shrink-0 overflow-hidden rounded-lg ring-1 ring-line">
              <img src={f.url} alt="" className="h-[70px] w-[89px] object-cover" draggable={false} />
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-px text-center font-mono text-[9.5px] text-white/80 tabular-nums">{f.t.toFixed(2)}s</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Swatches({ colors }: { colors: string[] }) {
  return (
    <span className="inline-flex gap-0.5">
      {colors.map((c, i) => (
        <span key={i} className="h-3 w-3 rounded-[4px] ring-1 ring-white/10" style={{ background: c }} />
      ))}
    </span>
  );
}

/** Effects: the game's effects and the preset library, previewed with a Roblox-like particle sim. */
function EffectsWorkshop({ selectedId }: { selectedId?: string }) {
  const list = useRpc<{ effects: EffectRow[]; presets: EffectPreset[] }>('effects.list', {}, ['effects.changed', 'animations.changed', 'project.changed']);
  const effects = list.data?.effects ?? [];
  const presets = list.data?.presets ?? [];
  const [sel, setSel] = useState<FxSel | null>(null);
  const [params, setParams] = useState<{ color?: string; color2?: string; scale: number; intensity: number }>({ scale: 1, intensity: 1 });
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const runtime = useRpc<ListResult>('animations.list', {}, ['project.changed']);

  useEffect(() => {
    if (selectedId && effects.some((e) => e.name === selectedId)) setSel({ kind: 'game', name: selectedId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, effects.length]);

  useEffect(() => {
    if (sel) return;
    if (selectedId && effects.some((e) => e.name === selectedId)) setSel({ kind: 'game', name: selectedId });
    // An effect file an agent wrote by hand has no updatedAt.
    else if (effects[0]) setSel({ kind: 'game', name: [...effects].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]!.name });
    else if (presets.length) setSel({ kind: 'preset', id: 'HitSpark' });
  }, [sel, selectedId, effects, presets]);

  const presetInfo = sel?.kind === 'preset' ? presets.find((p) => p.id === sel.id) : undefined;
  useEffect(() => {
    setNote(null);
    if (sel?.kind === 'preset') {
      setNewName(sel.id);
      const info = presets.find((p) => p.id === sel.id);
      setParams({ color: info?.colors[0], color2: info?.colors[1], scale: 1, intensity: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const presetSpec = useRpc<EffectSpec>(sel?.kind === 'preset' ? 'effects.preset' : null, sel?.kind === 'preset' ? { id: sel.id, ...params } : undefined);
  const gameSpec = sel?.kind === 'game' ? (effects.find((e) => e.name === sel.name) as unknown as EffectSpec | undefined) : undefined;
  const spec = sel?.kind === 'preset' ? (presetSpec.data ?? null) : (gameSpec ?? null);
  const current = sel?.kind === 'game' ? effects.find((e) => e.name === sel.name) : undefined;
  // The effects copilot knows what is on screen ("make this bigger", "add it").
  useEffect(() => {
    if (!sel) setDockContext('effects', undefined);
    else if (sel.kind === 'preset') setDockContext('effects', sel.id, 'a preset template, not in the game yet');
    else setDockContext('effects', sel.name, current?.draft ? 'a draft, not in the game yet' : "the game's effect");
  }, [sel, current?.draft]);
  const requirePath = runtime.data?.runtime?.requirePath.replace('ShurikenAnimations', 'ShurikenEffects');
  const call = !spec
    ? ''
    : spec.kind === 'burst'
      ? `Effects.burst("${spec.name}", position)`
      : spec.kind === 'persistent'
        ? `local fx = Effects.attach("${spec.name}", part) -- fx.stop() later`
        : spec.kind === 'trail'
          ? `local trail = Effects.trail("${spec.name}", bladePart)`
          : `Effects.beam("${spec.name}", attachmentA, attachmentB)`;
  const particles = (spec?.emitters ?? []).reduce((n, e) => n + (e.emit ?? 0), 0);

  const add = async () => {
    if (sel?.kind !== 'preset') return;
    setBusy(true);
    setNote(null);
    try {
      const r = await rpc<{ ok: boolean; text: string }>('effects.create', { name: newName, preset: sel.id, ...params });
      if (!r.ok) setNote(r.text.slice(0, 600));
      else setSel({ kind: 'game', name: newName });
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      list.reload();
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_300px]">
      <aside className="min-h-0 overflow-y-auto border-r border-line px-2 py-3">
        {effects.some((e) => e.draft) && (
          <div className="mb-3">
            <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase" title="Made here to try out: not in your game until you add them">
              Drafts
            </div>
            {effects
              .filter((e) => e.draft)
              .map((e) => (
                <button
                  key={e.name}
                  onClick={() => setSel({ kind: 'game', name: e.name })}
                  className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel?.kind === 'game' && sel.name === e.name ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
                >
                  <CircleDashed size={13} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.name}</span>
                  <span className="shrink-0 text-[10.5px] text-faint">draft</span>
                </button>
              ))}
          </div>
        )}
        <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">In this game</div>
        {effects.every((e) => e.draft) && <div className="px-2 pb-3 text-[12px] leading-snug text-faint">None yet. The VFX artist adds them as it works, the copilot's drafts come in when you add them, or add a preset below.</div>}
        {effects.filter((e) => !e.draft).map((e) => (
          <button
            key={e.name}
            onClick={() => setSel({ kind: 'game', name: e.name })}
            className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel?.kind === 'game' && sel.name === e.name ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
          >
            <Sparkles size={13} className="shrink-0 text-accent2" />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{e.name}</span>
            <span className="shrink-0 text-[10.5px] text-faint">{KIND_LABEL[e.kind]}</span>
          </button>
        ))}
        <div className="mt-4 px-2 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Presets</div>
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => setSel({ kind: 'preset', id: p.id })}
            className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', sel?.kind === 'preset' && sel.id === p.id ? 'bg-white/8 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
          >
            <Swatches colors={p.colors} />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.id}</span>
            <span className="shrink-0 text-[10.5px] text-faint">{KIND_LABEL[p.kind]}</span>
          </button>
        ))}
      </aside>

      <main className="flex min-h-0 flex-col">{sel ? <FxStage spec={spec} /> : <Empty icon={<Sparkles size={20} />}>Pick an effect or a preset.</Empty>}</main>

      <aside className="min-h-0 overflow-y-auto border-l border-line px-4 py-4">
        {sel && spec && (
          <>
            <div className="font-display text-[22px] leading-tight text-text">{sel.kind === 'game' ? sel.name : sel.id}</div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-dim">{spec.description ?? presetInfo?.description ?? ''}</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill>{KIND_LABEL[spec.kind]}</Pill>
              {particles > 0 && <Pill>{particles} particles per burst</Pill>}
              {sel.kind === 'preset' && <Pill tone="info">preset</Pill>}
              {current?.preset && <Pill tone="info">from {current.preset}</Pill>}
              {current?.draft && <Pill tone="warn">draft · not in the game</Pill>}
            </div>
            {current?.draft && <AddToGame dock="effects" name={current.name} of={current.draftOf} inGame={(n) => effects.some((e) => e.name === n && !e.draft)} onAdded={(n) => setSel({ kind: 'game', name: n })} className="mt-4" />}
            {(spec.emitters ?? []).length > 0 && (
              <div className="mt-4 space-y-1.5">
                {spec.emitters!.map((e) => (
                  <div key={e.name} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="text-dim">{e.name}</span>
                    <Swatches colors={e.color} />
                  </div>
                ))}
              </div>
            )}

            {sel.kind === 'preset' && (
              <div className="mt-5 space-y-3">
                <div className="flex items-center justify-between text-[12px] text-dim">
                  Colors
                  <span className="flex gap-2">
                    <input type="color" value={params.color ?? '#ffffff'} onChange={(e) => setParams({ ...params, color: e.target.value })} className="h-7 w-9 cursor-pointer rounded bg-transparent" aria-label="Main color" />
                    <input type="color" value={params.color2 ?? '#ffffff'} onChange={(e) => setParams({ ...params, color2: e.target.value })} className="h-7 w-9 cursor-pointer rounded bg-transparent" aria-label="Second color" />
                  </span>
                </div>
                <label className="block">
                  <span className="flex justify-between text-[12px] text-dim">
                    Size <span className="tabular-nums text-faint">{params.scale.toFixed(2)}×</span>
                  </span>
                  <input type="range" min={0.25} max={3} step={0.05} value={params.scale} onChange={(e) => setParams({ ...params, scale: Number(e.target.value) })} className="no-drag w-full accent-[var(--color-accent)]" />
                </label>
                <label className="block">
                  <span className="flex justify-between text-[12px] text-dim">
                    Amount <span className="tabular-nums text-faint">{params.intensity.toFixed(2)}×</span>
                  </span>
                  <input type="range" min={0.25} max={3} step={0.05} value={params.intensity} onChange={(e) => setParams({ ...params, intensity: Number(e.target.value) })} className="no-drag w-full accent-[var(--color-accent)]" />
                </label>
                <div className="flex gap-2 pt-1">
                  <input value={newName} onChange={(e) => setNewName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} className={inputClass} placeholder="Name in the game" aria-label="Effect name" />
                  <Button kind="primary" icon={<Plus size={14} />} disabled={busy || !newName || !runtime.data?.runtime} onClick={() => void add()}>
                    {busy ? 'Adding…' : 'Add'}
                  </Button>
                </div>
              </div>
            )}
            {note && (
              <div className="mt-3">
                <ErrorNote error={note} />
              </div>
            )}
            {sel.kind === 'game' && !current?.draft && (
              <div className="mt-5">
                <SendToStudio method="effects.play" params={{ name: sel.name }} label="Play in Studio" title="Play it in the open place, where Studio's camera is looking" />
              </div>
            )}
            {sel.kind === 'game' && !current?.draft && requirePath && (
              <div className="mt-5">
                <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">Play it from game code</div>
                <CopyCode code={`local Effects = require(${requirePath})\n${call}`} />
                <div className="mt-2 text-[11.5px] leading-snug text-faint">Uses textures built into Roblox, so it works in the published game without uploading. The preview here approximates Roblox's particles.</div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
