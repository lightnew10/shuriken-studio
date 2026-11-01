import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { EffectSpec } from '@shared/effects';
import { useRpc } from '../lib/rpc';
import { navigate } from '../lib/nav';
import { EffectsView } from '../components/anim/effects-view';
import { SendToStudio } from '../components/send-to-studio';
import { AddToGame } from '../components/add-to-game';
import { CopilotPanel, setDockContext } from './copilot-chat';
import { cx, timeAgo } from '../components/ui';
import { useCalmDashboard } from '../lib/appearance';

/** An effect as `effects.list` gives it: its spec, the preset it came from, when it last changed (missing in a file an agent wrote by hand). */
type EffectRow = EffectSpec & { preset: string | null; updatedAt?: string; draft?: boolean; draftOf?: string };
interface EffectsList {
  effects: EffectRow[];
  presets: Array<{ id: string; category: string; kind: EffectSpec['kind']; description: string; colors: [string, string] }>;
}

const KIND_LABEL: Record<EffectSpec['kind'], string> = { burst: 'burst', persistent: 'stays on', trail: 'trail', beam: 'beam' };

/** A few of an effect's colours, for its row. */
const colorsOf = (e: EffectSpec): string[] => [...(e.emitters ?? []).flatMap((m) => m.color), ...(e.trail?.color ?? []), ...(e.beam?.color ?? [])].filter((c, i, all) => all.indexOf(c) === i).slice(0, 3);

/** The Animation page on its Effects tab (where the effects copilot and the preset library are). */
export const openEffects = (name?: string) => navigate('animation', name ?? 'effects');

/** The particle preview: bursts fire again by themselves, trails swing, beams flicker. */
function FxPreview({ spec, interactive = false, still = false }: { spec: EffectSpec | null; interactive?: boolean; still?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EffectsView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const v = new EffectsView(host.current, { interactive, fps: interactive ? undefined : 30 });
    view.current = v;
    return () => {
      v.dispose();
      view.current = null;
    };
  }, [interactive]);
  useEffect(() => view.current?.setEffect(spec), [spec]);
  useEffect(() => view.current?.setStill(still), [still, interactive]);
  return <div ref={host} className="absolute inset-0" />;
}

/**
 * The game's visual effects and the dock's drafts: the newest one playing in a Roblox-like particle preview,
 * the list to pick another, the title opening the Effects workshop. Expanded, it is a small workshop of its
 * own: the list, a bigger preview to turn, Play in Studio (a draft: Add to game), and the effects copilot
 * beside it, whose drafts play here until the user adds them. With no effects yet it plays a preset, like
 * the Animation container.
 */
export function EffectsMini({ expanded = false }: { expanded?: boolean }) {
  const list = useRpc<EffectsList>('effects.list', {}, ['effects.changed', 'animations.changed', 'assets.changed', 'project.changed']);
  const effects = useMemo(() => [...(list.data?.effects ?? [])].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')), [list.data]);
  const inGame = effects.filter((e) => !e.draft).length;
  const [sel, setSel] = useState<string | null>(null);
  // Until the user picks one, the small container shows each effect in turn (like the Animation container);
  // a calm dashboard holds the newest still.
  const calm = useCalmDashboard() && !expanded;
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (expanded || calm || sel || effects.length < 2) return;
    const t = setTimeout(() => setTurn((n) => n + 1), 4500);
    return () => clearTimeout(t);
  }, [expanded, calm, sel, effects.length, turn]);
  const current = effects.find((e) => e.name === sel) ?? effects[expanded ? 0 : turn % Math.max(1, effects.length)] ?? null;
  const preset = !current ? (list.data?.presets.find((p) => p.kind === 'burst') ?? list.data?.presets[0]) : undefined;
  const presetSpec = useRpc<EffectSpec>(preset ? 'effects.preset' : null, preset ? { id: preset.id } : undefined, [], [preset?.id]);
  const spec: EffectSpec | null = current ?? presetSpec.data ?? null;
  useEffect(() => {
    if (expanded) setDockContext('effects', current?.name);
  }, [expanded, current?.name]);

  const rows = (
    <div className="min-h-0 overflow-y-auto px-2 py-1.5">
      {effects.map((e) => (
        <button
          key={e.name}
          onClick={() => setSel(e.name)}
          onDoubleClick={() => openEffects(e.name)}
          title={`${e.description ?? e.name}\n\nDouble-click to open it in the Effects workshop`}
          className={cx('flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors', current?.name === e.name ? 'bg-accent/12 text-text' : 'text-dim hover:bg-white/4 hover:text-text')}
        >
          <span className="inline-flex shrink-0 gap-0.5">
            {colorsOf(e).map((c, i) => (
              <span key={i} className="h-2.5 w-2.5 rounded-[3px] ring-1 ring-white/10" style={{ background: c }} />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px]">{e.name}</span>
          <span className="shrink-0 text-[10.5px] text-faint" title={e.draft ? 'A draft: only here in Shuriken, not in your game, until you add it' : undefined}>
            {e.draft ? 'draft' : expanded && e.updatedAt ? `${KIND_LABEL[e.kind]} · ${timeAgo(e.updatedAt)}` : KIND_LABEL[e.kind]}
          </span>
        </button>
      ))}
    </div>
  );
  const caption = (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-surface/90 to-transparent px-3 pt-6 pb-2">
      <span className="min-w-0 truncate text-[12px] text-text">{current ? current.name : <span className="text-faint">{preset ? `Preset ${preset.id} · the VFX artist adds the game's effects here` : 'Effects appear here'}</span>}</span>
      {current && <span className="shrink-0 text-[10.5px] text-faint">{current.draft ? `draft · ${KIND_LABEL[current.kind]}` : KIND_LABEL[current.kind]}</span>}
    </div>
  );

  if (expanded)
    return (
      <div className="grid h-full min-h-0 grid-cols-[minmax(180px,240px)_minmax(0,1fr)_minmax(300px,360px)]">
        <div className="flex min-h-0 flex-col border-r border-line">
          <div className="shrink-0 px-3.5 pt-3 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
            Effects{' '}
            <span className="font-normal tracking-normal normal-case">
              {inGame} in the game{effects.length > inGame ? ` · ${effects.length - inGame} draft${effects.length - inGame === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          {effects.length ? rows : <div className="px-3.5 text-[12px] leading-snug text-faint">None yet. Ask the effects copilot, or pick a preset in the Effects workshop.</div>}
          <button onClick={() => openEffects(current?.name)} className="mt-auto shrink-0 border-t border-line px-3.5 py-2.5 text-left text-[12px] text-accent2 hover:bg-white/4">
            Open the Effects workshop
          </button>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="relative min-h-0 flex-1">
            <FxPreview spec={spec} interactive />
            {caption}
          </div>
          {current && (
            <div className="flex shrink-0 items-start gap-3 border-t border-line px-4 py-2.5">
              <p className="min-w-0 flex-1 text-[12px] leading-snug text-dim">{current.description ?? 'Drag to turn the preview.'}</p>
              {current.draft ? (
                <AddToGame dock="effects" name={current.name} of={current.draftOf} inGame={(n) => effects.some((e) => e.name === n && !e.draft)} onAdded={setSel} className="max-w-[320px] shrink-0" />
              ) : (
                <SendToStudio method="effects.play" params={{ name: current.name }} label="Play in Studio" title="Play it in the open place, where Studio's camera is looking" />
              )}
            </div>
          )}
        </div>
        <CopilotPanel dock="effects" className="border-l border-line" />
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <button onClick={() => openEffects(current?.name)} className="relative block min-h-[96px] flex-[3] text-left" title="Open the Effects workshop">
        <FxPreview spec={spec} still={calm} />
        {caption}
      </button>
      {effects.length > 1 && <div className="flex min-h-0 flex-[2] flex-col border-t border-line">{rows}</div>}
      {!effects.length && list.data && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-2 text-[11.5px] leading-snug text-faint">
          <Sparkles size={12} className="shrink-0 text-accent2" />
          Expand to ask the effects copilot for one.
        </div>
      )}
    </div>
  );
}
