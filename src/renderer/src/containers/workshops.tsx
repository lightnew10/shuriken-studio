import { ArrowUpRight, Flame, LayoutPanelTop, Loader2, Music2, Play, Rows3, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AnimationClip } from '@shared/animation';
import type { AnimationSummary } from '@shared/domain';
import { rpc, useRpc } from '../lib/rpc';
import { MannequinView } from '../components/anim/mannequin';
import { RigPlayer } from '../components/anim/rig-player';
import { useRigModel, type RigPartRow } from '../components/anim/rig-model';
import type { RigSpec } from '@shared/rig';
import { ModelView } from '../components/models/model-view';
import { navigate, type Page } from '../lib/nav';
import { cx, timeAgo } from '../components/ui';
import { UiCanvas, useUiImages } from '../components/ui/ui-canvas';
import { UI_DEVICES, type UiSnapshot } from '@shared/ui-layout';
import { resolveVersion, versionLabel, type Mockup, type MockupSummary } from '@shared/ui-mockup';
import { kilnBuildsDetail, type KilnBuildsInfo } from '../components/kiln-builds';
import { kilnBuildLine } from '../lib/kiln-line';
import { canPlay, moveSelection, navAction, soundState, type SoundKind } from '../lib/sound-list';
import { soundPlayer, useNowPlaying, useStopOnLeave } from '../lib/sound-playback';
import { useCalmDashboard } from '../lib/appearance';

interface AssetRow {
  id: string;
  name: string;
  kind: string;
  source: string;
  updatedAt: string;
}

function Mini({ kinds, page, icon, empty }: { kinds: string[]; page: Page; icon: ReactNode; empty: string }) {
  const assets = useRpc<AssetRow[]>('assets.list', {}, ['assets.changed']);
  const items = (assets.data ?? []).filter((a) => kinds.includes(a.kind)).slice(0, 4);
  if (items.length === 0) {
    return (
      <button onClick={() => navigate(page)} className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-[12px] leading-snug text-faint hover:text-dim">
        <span className="opacity-60">{icon}</span>
        {empty}
      </button>
    );
  }
  return (
    <div className="h-full overflow-y-auto px-3 py-2">
      {items.map((a) => (
        <button key={a.id} onClick={() => navigate(page, a.id)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-white/4">
          <span className="text-accent2">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">{a.name}</span>
          <span className="shrink-0 text-[10.5px] text-faint">{timeAgo(a.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

/** The newest finished model, whole (every part of a multi-part model in place), on a slow turntable. */
export function ModelsMini() {
  const calm = useCalmDashboard();
  type Row = { name: string; triangles: number; updatedAt: string; assembly?: string; origin?: [number, number, number]; color?: string; material?: string; instances?: Array<{ position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }> };
  const list = useRpc<{ models: Row[] }>('models.list', {}, ['assets.changed', 'project.changed']);
  // Whole models: the parts of a multi-part model shown together, by the model's name.
  const groups = new Map<string, Row[]>();
  for (const m of list.data?.models ?? []) groups.set(m.assembly ?? m.name, [...(groups.get(m.assembly ?? m.name) ?? []), m]);
  const newest = [...groups.entries()]
    .map(([name, parts]) => ({ name, parts, updatedAt: parts.map((q) => q.updatedAt).sort().at(-1) ?? '', triangles: parts.reduce((n, q) => n + q.triangles, 0) }))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
  const kilnBuilds = useRpc<KilnBuildsInfo>('kiln.builds', {}, ['kiln.builds', 'project.changed']).data;
  const kiln = kilnBuildLine(kilnBuilds);
  // Models in their own Blender right now (a model Kiln builds is on the Kiln line instead).
  const inKiln = new Set((kilnBuilds?.builds ?? []).filter((b) => b.state === 'running' || b.state === 'queued').map((b) => b.name));
  const building = (useRpc<Array<{ name: string; by: string }>>('models.building', {}, ['models.building', 'assets.changed']).data ?? []).filter((b) => !inKiln.has(b.name));
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<ModelView | null>(null);
  useEffect(() => {
    if (!host.current || !newest) return;
    // A calm dashboard shows the model still, from the side a turntable starts on.
    const v = new ModelView(host.current, { turntable: !calm });
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, [!!newest, calm]);
  const partsKey = newest ? `${newest.name}:${newest.updatedAt}:${newest.parts.length}:${calm}` : '';
  useEffect(() => {
    if (!newest) return;
    let cancelled = false;
    const whole = newest.parts.length > 1;
    void Promise.all(newest.parts.map((q) => rpc<string>('models.glb', { name: q.name }).then((url) => ({ url, color: q.color, material: q.material, origin: whole ? q.origin : undefined, instances: q.instances }))))
      .then((ps) => {
        if (!cancelled) void view.current?.loadParts(ps);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partsKey]);
  // One line each, top left: what Kiln builds now (opens the Kiln page on it), and models in their own Blender.
  const notes = (kiln || building.length > 0) && (
    <div className="absolute top-2 left-2 z-10 flex max-w-[92%] flex-col items-start gap-1">
      {kiln && (
        <button
          onClick={() => navigate('kiln', kiln.project ?? undefined)}
          title={`${kilnBuildsDetail(kilnBuilds!, Date.now())}\n\nOpen the Kiln page`}
          className="flex max-w-full items-center gap-1.5 rounded-md bg-surface/85 px-2 py-1 text-[11px] text-dim ring-1 ring-line backdrop-blur transition-colors hover:text-text"
        >
          <Flame size={11} className="shrink-0 text-accent2" />
          <span className="truncate">{kiln.text}</span>
        </button>
      )}
      {building.length > 0 && (
        <div className="pointer-events-none flex max-w-full items-center gap-1.5 rounded-md bg-surface/80 px-2 py-1 text-[11px] text-dim backdrop-blur">
          <Loader2 size={11} className="shrink-0 animate-spin text-accent2" />
          <span className="truncate">Building {building.map((b) => b.name).join(', ')}</span>
        </div>
      )}
    </div>
  );
  if (!newest)
    return (
      <div className="relative h-full">
        <Mini kinds={['mesh', 'model']} page="models" icon={<Rows3 size={16} />} empty="3D models built for this game appear here." />
        {notes}
      </div>
    );
  return (
    <div className="relative h-full w-full">
      <button onClick={() => navigate('models', newest.name)} className="absolute inset-0 block text-left" title="Open the models workshop">
        <div ref={host} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-surface/90 to-transparent px-3 pt-6 pb-2">
          <span className="min-w-0 truncate text-[12px] text-text">{newest.name}</span>
          <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
            {newest.parts.length > 1 ? `${newest.parts.length} parts · ` : ''}
            {newest.triangles.toLocaleString()} triangles
          </span>
        </div>
      </button>
      {notes}
    </div>
  );
}

type MiniSound = { name: string; kind: SoundKind; assetId: string | null; source: string; file?: string; looped: boolean; updatedAt: string; draft?: boolean; playedBy?: string[] };

/**
 * The game's sounds, newest first, with where each one stands (draft, in game, unused, not uploaded).
 * A click plays one (again: stops it), ↑/↓ move and play, Space plays/stops, Enter or the arrow opens
 * it on the Audio page (the container's title opens the page).
 */
export function AudioMini() {
  const list = useRpc<{ sounds: MiniSound[] }>('audio.list', {}, ['assets.changed', 'project.changed']);
  const sounds = useMemo(() => [...(list.data?.sounds ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6), [list.data]);
  const now = useNowPlaying();
  const [sel, setSel] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  useStopOnLeave();
  if (!sounds.length) return <Mini kinds={['audio']} page="audio" icon={<Music2 size={16} />} empty="Music and sound effects appear here as the sound designer works." />;
  const focused = sel && sounds.some((s) => s.name === sel) ? sel : sounds[0]!.name;
  const playable = (s: MiniSound) => ({ name: s.name, looped: s.looped, playable: canPlay(s), version: s.updatedAt });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return navigate('audio', focused);
    }
    const action = navAction(e, { tag: (e.target as HTMLElement).tagName, editable: false, inSounds: true });
    // One list here: Left and Right stay with the dashboard.
    if (!action || action === 'left' || action === 'right') return;
    e.preventDefault();
    const next = moveSelection([{ kind: 'sfx', sounds }], focused, action);
    const s = sounds.find((x) => x.name === next);
    if (!s) return;
    if (action === 'toggle') return void soundPlayer.toggle(playable(s));
    const el = rows.current.get(s.name);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
    if (s.name === focused) return;
    setSel(s.name);
    if (!e.repeat) void soundPlayer.play(playable(s));
  };
  return (
    <div role="listbox" aria-label="The game's sounds" onKeyDown={onKey} className="h-full overflow-y-auto px-3 py-2">
      {sounds.map((s) => {
        const on = now.name === s.name && now.status !== 'idle';
        const st = soundState(s);
        return (
          <div
            key={s.name}
            ref={(el) => {
              if (el) rows.current.set(s.name, el);
              else rows.current.delete(s.name);
            }}
            role="option"
            aria-selected={focused === s.name}
            tabIndex={focused === s.name ? 0 : -1}
            onClick={() => {
              setSel(s.name);
              void soundPlayer.toggle(playable(s));
            }}
            title={canPlay(s) ? (on ? 'Click to stop' : 'Click to play') : 'A Creator Store sound: it plays in Studio and in the game'}
            className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left outline-none hover:bg-white/4 focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <span className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', on ? 'bg-accent/20 text-accent2' : s.kind === 'music' ? 'text-accent2' : 'text-faint')}>
              {on && now.status === 'loading' ? (
                <Loader2 size={11} className="animate-spin" />
              ) : on ? (
                <Square size={9} fill="currentColor" />
              ) : (
                <>
                  <Music2 size={13} className={cx(canPlay(s) && 'group-hover:hidden')} />
                  {canPlay(s) && <Play size={12} className="hidden text-accent2 group-hover:block" />}
                </>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">{s.name}</span>
            <span className={cx('shrink-0 text-[10.5px]', st.tone)} title={st.title}>
              {st.label}
            </span>
            <button
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                navigate('audio', s.name);
              }}
              title="Open on the Audio page"
              aria-label={`Open ${s.name} on the Audio page`}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-text"
            >
              <ArrowUpRight size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
/** The game's animations playing on a small mannequin, one after another (a preset while there are none). */
export function AnimationMini() {
  const calm = useCalmDashboard();
  const list = useRpc<{ animations: AnimationSummary[] }>('animations.list', {}, ['animations.changed', 'project.changed']);
  const items = [...(list.data?.animations ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [i, setI] = useState(0);
  const current = items.length ? items[i % items.length] : undefined;
  const clipQ = useRpc<{ clip: AnimationClip }>(current ? 'animations.get' : 'animations.preset', current ? { name: current.name } : { id: 'SwordIdle' }, ['animations.changed'], [current?.name]);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<MannequinView | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const v = new MannequinView(host.current, { compact: true });
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, []);

  const clip = clipQ.data?.clip ?? null;
  const rigClip = !!clip?.rig;
  useEffect(() => {
    const combat = !!clip && !clip.rig && /sword|slash|parry|block|guard|thrust|strike/i.test(`${clip.name} ${current?.preset ?? ''}`);
    // A creature's clip plays on the creature (below); the mannequin rests meanwhile.
    view.current?.setClip(clip && !clip.rig ? clip : null, { sword: combat });
    // A calm dashboard holds one pose of the newest move.
    if (calm) view.current?.setStill(true);
    if (!clip || items.length < 2 || calm) return;
    // Show each animation a couple of times, then the next.
    const d = Math.max(...clip.keys.map((k) => k.t));
    const ms = Math.max(3500, (d + 0.7) * 2 * 1000);
    const t = setTimeout(() => setI((x) => x + 1), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, calm]);

  return (
    <button onClick={() => navigate('animation', current?.name)} className="group relative block h-full w-full text-left" title="Open the animation workshop">
      <div ref={host} className={rigClip ? 'invisible absolute inset-0' : 'absolute inset-0'} />
      {rigClip && current && <RigMini name={current.name} still={calm} />}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-surface/90 to-transparent px-3 pt-6 pb-2">
        <span className="min-w-0 truncate text-[12px] text-text">
          {current ? current.name : <span className="text-faint">Presets ready · the animator adds the game's moves here</span>}
        </span>
        {items.length > 0 && (
          <span className="shrink-0 text-[10.5px] text-faint">
            {current?.draft ? 'draft · ' : ''}
            {items.filter((a) => !a.draft).length} in the game
          </span>
        )}
      </div>
    </button>
  );
}

/** A creature's clip on the creature itself (its rigged model), for the dashboard's animation viewer. */
function RigMini({ name, still }: { name: string; still: boolean }) {
  const q = useRpc<{ clip: AnimationClip; rig?: RigSpec | null; rigParts?: RigPartRow[] }>('animations.get', { name }, ['animations.changed'], [name]);
  const model = useRigModel(q.data?.rig ?? null, q.data?.rigParts);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !model || !q.data?.clip) return;
    const player = new RigPlayer(host.current, model.spec, model.parts, { interactive: false });
    player.setClip(q.data.clip);
    if (still) player.setStill(true);
    return () => player.dispose();
  }, [model, q.data?.clip, still]);
  return <div ref={host} className="absolute inset-0" />;
}

/**
 * The UI: the newest mockup the UI copilot made (designs tried in Shuriken, not in the game) when it is newer
 * than the game's UI as last read, else the game's UI as a laptop player sees it; the mockups listed under it.
 */
export function UiMini() {
  const snap = useRpc<UiSnapshot | null>('ui.get', undefined, ['ui.changed']);
  const mockups = useRpc<MockupSummary[]>('ui.mockups', undefined, ['ui.mockups', 'project.changed']);
  const list = mockups.data ?? [];
  const newest = list[0];
  const showMockup = !!newest && (!snap.data?.screens.length || newest.updatedAt > snap.data.capturedAt);
  const full = useRpc<Mockup | null>(showMockup ? 'ui.mockup' : null, { name: newest?.name }, ['ui.mockups'], [newest?.name]);
  // The newest version that isn't retired.
  const version = full.data ? ([...full.data.versions].reverse().find((v) => !v.retired) ?? full.data.versions[full.data.versions.length - 1]) : undefined;
  const mockScreens = useMemo(() => (version ? resolveVersion(version, 'laptop').screens : []), [version]);
  const backdrop = useRpc<string | null>('project.thumbnail', undefined, []);
  // The enabled screens; when every screen is one a script shows later (menus, results), all of them rather than none.
  const allScreens = snap.data?.screens ?? [];
  const enabledScreens = allScreens.filter((s) => s.enabled !== false);
  const gameScreens = enabledScreens.length ? enabledScreens : allScreens;
  const screens = showMockup ? mockScreens : gameScreens;
  const images = useUiImages(screens);
  const problems = snap.data?.findings.filter((f) => f.severity === 'problem').length ?? 0;
  const chips = list.length > 0 && (
    <div className="absolute inset-x-1.5 bottom-1.5 flex items-center gap-1 overflow-hidden">
      {list.slice(0, 3).map((m) => (
        <button
          key={m.name}
          onClick={() => navigate('ui', `mockup:${m.name}`)}
          title={`${m.title}: ${m.versions.length} version${m.versions.length === 1 ? '' : 's'}${m.applied ? `, ${m.applied.version} in the game` : ', not in the game'}`}
          className="min-w-0 shrink truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white/85 backdrop-blur hover:bg-black/70 hover:text-white"
        >
          {m.title} <span className="text-white/50">{(() => { const last = [...m.versions].reverse().find((v) => !v.retired) ?? m.versions[m.versions.length - 1]; return last ? versionLabel(last) : null; })()}</span>
        </button>
      ))}
      {list.length > 3 && <span className="shrink-0 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white/60">+{list.length - 3}</span>}
    </div>
  );
  if (!screens.length) {
    return (
      <div className="relative h-full w-full">
        <button onClick={() => navigate('ui')} className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 pb-6 text-center text-[12px] leading-snug text-faint hover:text-dim">
          <LayoutPanelTop size={18} className="opacity-60" />
          {snap.data ? 'No screens yet. Ask the UI copilot for a design: it is mocked up here first.' : 'The game’s UI appears here once it’s read from Studio; the UI copilot’s mockups too.'}
        </button>
        {chips}
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <button onClick={() => navigate('ui', showMockup && newest ? `mockup:${newest.name}${version ? `@${version.id}` : ''}` : undefined)} className="relative block h-full w-full" title={showMockup ? 'Open the mockup on the UI page' : 'Open the UI page'}>
        <UiCanvas screens={screens} device={UI_DEVICES.laptop} images={images} backdrop={backdrop.data} guides={false} className="pointer-events-none" />
        <span className="absolute top-1.5 left-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] text-white/85 backdrop-blur">
          {showMockup && full.data && version
            ? `Mockup · ${full.data.title} ${version.id} · not in the game`
            : `In the game · ${snap.data?.screens.length ?? 0} screen${snap.data?.screens.length === 1 ? '' : 's'}${problems ? ` · ${problems} to fix` : ''}`}
        </span>
      </button>
      {chips}
    </div>
  );
}
