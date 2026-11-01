import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Eye, Gamepad2, Shirt, Image as ImageIcon, LayoutGrid, Loader2, Monitor, Plus, Send, Smartphone, Sparkles, Tablet, Tv, Wand2 } from 'lucide-react';
import { FORGE_DEVICES, type ForgeDevice, type ForgeDirectionInfo, type ForgeGame, type ForgeGenreInfo, type ForgeMade, type ForgePreviewParams, type ForgeTemplateInfo } from '@shared/ui-forge';
import type { MockupSummary } from '@shared/ui-mockup';
import { Button, Empty, cx, timeAgo } from '../../components/ui';
import { setDockContext } from '../../containers/copilot-chat';
import { DEVICE_ASPECT, FORGE_DEFAULT, SAMPLE_ASPECT, designerMessage, lookFor, pictureWidth, readPick, type ForgePick } from '../../lib/forge';
import { rpc, useRpc } from '../../lib/rpc';
import { AccentPicker, ElementSheet, GenrePicker, LookCard, Overline, ScreenRow, Shimmer, screenDpr, useBoxSize, useForgePreview, useForgeSheet } from './forge-parts';

const PICK_KEY = 'shuriken.ui.forge';
const MADE_KEY = 'shuriken.ui.forge.made';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* a per-viewer convenience */
  }
}

/** Behind each look's element tiles: the light its art is made for. */
const MOOD: Record<string, string> = {
  candy: 'linear-gradient(180deg, #4fb9ff, #a8e6ff)',
  ember: 'radial-gradient(120% 140% at 50% 120%, #4a1a0a, #140b08 70%)',
  neon: 'linear-gradient(180deg, #050b14, #0c1f33)',
  parchment: 'radial-gradient(120% 120% at 50% 20%, #4a2f17, #1f130a 75%)',
  frost: 'linear-gradient(180deg, #c9d6ee, #eef3fb)',
};

const DEVICE_ICON: Record<ForgeDevice, typeof Smartphone> = { phone: Smartphone, tablet: Tablet, desktop: Monitor, tv: Tv };
/** The UI Lab device each preview is drawn on. */
const DEVICE_NOTE: Record<ForgeDevice, string> = { phone: 'iPhone 14 · 844×390 pt', tablet: 'iPad Air · 1180×820 pt', desktop: '1080p desktop · 1920×1080 pt', tv: 'Console on a TV · 1920×1080 pt' };

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'rpc': Error: /, '');

/**
 * The UI page's Forge: the art directions as big live cards (each its sample screen, drawn by the CPU engine), an
 * accent to re-tint the chosen one, its full element sheet, the screen templates previewed on a phone, a tablet, a
 * desktop or a TV in that look, and two ways out: a mockup made here (opened in Mockups), or the pick handed to the
 * UI copilot with the user's words.
 */
export function ForgeView({ link, mockups, onOpenMockup, onAskCopilot }: { link: Partial<ForgePick> | null; mockups: MockupSummary[]; onOpenMockup: (name: string) => void; onAskCopilot: () => void }) {
  const dirs = useRpc<ForgeDirectionInfo[]>('forge.directions');
  const templates = useRpc<ForgeTemplateInfo[]>('forge.templates');
  const genres = useRpc<ForgeGenreInfo[]>('forge.genres');
  const thumb = useRpc<string | null>('project.thumbnail', undefined, []);
  const [pick, setPickState] = useState<ForgePick>(() => ({ ...readPick(readJson(PICK_KEY, FORGE_DEFAULT)), ...(link ?? {}) }));
  const linkKey = JSON.stringify(link ?? null);
  useEffect(() => {
    if (link) setPickState((p) => ({ ...p, ...link }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey]);
  const setPick = (patch: Partial<ForgePick>) =>
    setPickState((p) => {
      const next = { ...p, ...patch };
      writeJson(PICK_KEY, next);
      return next;
    });

  const all = dirs.data ?? [];
  const d = all.find((x) => x.id === pick.direction) ?? all[0];
  const nameOf = (id: string) => all.find((x) => x.id === id)?.name ?? id;
  /** A template drawn in this look (one that isn't yet stays listed, greyed, with the looks it is in). */
  const inLook = (t: ForgeTemplateInfo) => !d || !t.looks?.length || t.looks.includes(d.id);
  const tpl = templates.data?.find((t) => t.id === pick.screen && inLook(t));
  // The game's own UI (as last read from Studio), dressed in the look: a screen like the templates.
  const gameUi = useRpc<ForgeGame | null>('forge.game', undefined, ['ui.changed']);
  const game = gameUi.data ?? null;
  const screen = pick.screen === 'game' && game ? 'game' : tpl ? tpl.id : 'sample';
  const screenLabel = screen === 'game' ? 'Your game’s UI' : tpl ? tpl.label : `${d?.sampleTitle ?? 'Shop'} sample`;
  const backdrop = pick.backdrop === 'game' && thumb.data ? 'game' : 'look';
  const dpr = screenDpr();

  // The looks strip: five cards across, each asking for a picture its own size.
  // The looks strip: big cards (about five and a half across, so more is plainly there), scrolled sideways.
  const [stripRef, strip] = useBoxSize<HTMLDivElement>();
  const stripEl = useRef<HTMLDivElement | null>(null);
  const cardCss = Math.round(Math.max(184, Math.min(272, (strip.w - 5 * 12) / 5.4)));
  const cardWidth = strip.w > 0 ? pictureWidth({ w: cardCss, h: 10_000 }, 1, dpr) : 0;
  const [edges, setEdges] = useState({ left: false, right: false });
  const readEdges = () => {
    const el = stripEl.current;
    if (el) setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(readEdges, [strip.w, all.length]);
  const slide = (dir: 1 | -1) => stripEl.current?.scrollBy({ left: dir * (cardCss + 12) * 3, behavior: 'smooth' });
  // The chosen look in view (a link or the stored pick may name one far along).
  useEffect(() => {
    stripEl.current?.querySelector<HTMLElement>(`[data-look="${pick.direction}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [pick.direction, all.length]);

  // The stage: the pick drawn to fit.
  const [stageRef, stage] = useBoxSize<HTMLDivElement>();
  const aspect = screen === 'sample' ? SAMPLE_ASPECT : DEVICE_ASPECT[pick.device];
  const box = { w: Math.max(0, stage.w - 48), h: Math.max(0, stage.h - 72) };
  const width = stage.w > 0 ? pictureWidth(box, aspect, dpr) : 0;
  const stageParams: ForgePreviewParams | null =
    d && width && pick.stage === 'preview'
      ? screen === 'sample'
        ? { what: 'sample', direction: d.id, accent: pick.accent, width, roblox: pick.roblox, backdrop, priority: 'high', slot: 'stage' }
        : screen === 'game'
          ? { what: 'game', direction: d.id, accent: pick.accent, device: pick.device, width, roblox: pick.roblox, backdrop, priority: 'high', slot: 'stage' }
          : { what: 'template', template: screen, direction: d.id, accent: pick.accent, genre: pick.genre, device: pick.device, width, roblox: pick.roblox, backdrop, priority: 'high', slot: 'stage' }
      : null;
  const shown = useForgePreview(stageParams, 140);
  const sheet = useForgeSheet(pick.stage === 'sheet' && d ? d.id : null, pick.accent, 140);
  const picAspect = shown.pic ? shown.pic.w / Math.max(1, shown.pic.h) : aspect;
  const fitW = Math.min(box.w, box.h * picAspect);

  // What the UI copilot hears the user is looking at.
  const said = d ? designerMessage({ direction: d.id, name: d.name, tagline: d.tagline, accent: pick.accent, screen, screenLabel, device: pick.device, text: '' }) : null;
  useEffect(() => {
    if (said) setDockContext('ui', said.item, said.note);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [said?.item, said?.note]);

  // Making a mockup, and adding versions to the one made last.
  const [made, setMade] = useState<{ name: string; title: string } | null>(() => readJson(MADE_KEY, null));
  const lastMade = made && mockups.some((m) => m.name === made.name) ? made : null;
  const [busy, setBusy] = useState<'make' | 'add' | 'ask' | 'dress' | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const make = async (into?: string) => {
    if (!d || busy) return;
    setBusy(into ? 'add' : 'make');
    setNote(null);
    try {
      const r = await rpc<ForgeMade>('forge.make', { template: screen, direction: d.id, accent: pick.accent, ...(pick.genre ? { genre: pick.genre } : {}), ...(into ? { into } : {}) });
      window.shuriken.journal('ui.forge.make', { template: screen, direction: d.id, accent: pick.accent, into: into ?? null, name: r.name, version: r.version });
      const m = { name: r.name, title: r.title };
      setMade(m);
      writeJson(MADE_KEY, m);
      onOpenMockup(r.name);
    } catch (e) {
      setNote({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };
  /** "Dress my game's UI in <Look>": a mockup of the game's own screens wearing the look (again in the same look: a version more). */
  const dress = async () => {
    if (!d || busy || !game) return;
    setBusy('dress');
    setNote(null);
    try {
      const r = await rpc<ForgeMade>('forge.dress', { direction: d.id, accent: pick.accent });
      window.shuriken.journal('ui.forge.dress', { direction: d.id, accent: pick.accent, name: r.name, version: r.version });
      const m = { name: r.name, title: r.title };
      setMade(m);
      writeJson(MADE_KEY, m);
      onOpenMockup(r.name);
    } catch (e) {
      setNote({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };
  const [ask, setAsk] = useState('');
  const send = async () => {
    if (!d || busy) return;
    const msg = designerMessage({ direction: d.id, name: d.name, tagline: d.tagline, accent: pick.accent, screen, screenLabel, device: pick.device, text: ask });
    setBusy('ask');
    setNote(null);
    onAskCopilot();
    try {
      await rpc('chat.send', { channel: 'copilot:ui', text: msg.text, context: { page: 'ui', item: msg.item, note: msg.note }, images: shown.pic?.png && pick.stage === 'preview' ? [{ name: msg.picture, dataUrl: shown.pic.png }] : [] });
      window.shuriken.journal('ui.forge.ask', { direction: d.id, screen, accent: pick.accent });
      setAsk('');
      setNote({ tone: 'ok', text: 'Sent to the UI designer, with this picture.' });
    } catch (e) {
      setNote({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const thumbWidth = pictureWidth({ w: 104, h: 59 }, 16 / 9, dpr);
  const screens = useMemo(() => templates.data ?? [], [templates.data]);

  if (dirs.error) return <Empty icon={<Sparkles size={20} />}>The Forge couldn’t list its looks: {dirs.error}</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      {/* The looks, big and live. */}
      <div className="border-b border-line px-4 pt-3 pb-3.5">
        <Overline right={<span className="tracking-normal normal-case">{all.length ? `${all.length} looks, drawn live by the Forge` : 'Drawn live by the Forge'}{pick.accent ? `, tinted ${pick.accent}` : ''}</span>}>Art direction</Overline>
        <div className="relative">
          <div
            ref={(el) => {
              stripRef(el);
              stripEl.current = el;
            }}
            onScroll={readEdges}
            onWheel={(e) => {
              // A mouse wheel scrolls the strip sideways.
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && stripEl.current) stripEl.current.scrollLeft += e.deltaY;
            }}
            className="flex snap-x gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {all.length
              ? all.map((x) => <LookCard key={x.id} d={x} accent={pick.accent} selected={x.id === d?.id} width={cardWidth} cardWidth={cardCss} onPick={() => setPick({ direction: x.id })} />)
              : Array.from({ length: 6 }, (_, i) => <div key={i} className="flex-none" style={{ width: cardCss }}><Shimmer className="aspect-[1366/810] w-full rounded-xl" /></div>)}
          </div>
          {edges.left && (
            <button onClick={() => slide(-1)} title="More looks" className="absolute inset-y-0 left-0 flex w-12 items-center justify-start bg-gradient-to-r from-bg via-bg/80 to-transparent pl-1 text-dim hover:text-text">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface3/90 shadow ring-1 ring-line2">
                <ChevronLeft size={16} />
              </span>
            </button>
          )}
          {edges.right && (
            <button onClick={() => slide(1)} title="More looks" className="absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-bg via-bg/80 to-transparent pr-1 text-dim hover:text-text">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface3/90 shadow ring-1 ring-line2">
                <ChevronRight size={16} />
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_304px]">
        {/* The stage. */}
        <main className="flex min-h-0 min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
            <div className="flex rounded-lg bg-surface2 p-0.5 ring-1 ring-line">
              {(
                [
                  ['preview', 'Preview', Eye],
                  ['sheet', 'Elements', LayoutGrid],
                ] as const
              ).map(([k, label, Icon]) => (
                <button key={k} onClick={() => setPick({ stage: k })} className={cx('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors', pick.stage === k ? 'bg-accent/20 text-accent2' : 'text-dim hover:text-text')}>
                  <Icon size={12} />
                  {label}
                </button>
              ))}
            </div>
            {pick.stage === 'preview' &&
              (screen === 'sample' ? (
                <span className="rounded-lg px-2 py-1 text-[11.5px] text-faint ring-1 ring-line" title="The sample is laid out for a laptop; templates adapt to every device">
                  Laptop 1366×768
                </span>
              ) : (
                <div className="flex rounded-lg bg-surface2 p-0.5 ring-1 ring-line">
                  {FORGE_DEVICES.map((x) => {
                    const Icon = DEVICE_ICON[x.id];
                    return (
                      <button key={x.id} onClick={() => setPick({ device: x.id })} title={x.label} className={cx('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors', pick.device === x.id ? 'bg-accent/20 text-accent2' : 'text-dim hover:text-text')}>
                        <Icon size={12} />
                        {x.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            <span className="flex-1" />
            {pick.stage === 'preview' && (
              <>
                <Toggle on={pick.roblox} onClick={() => setPick({ roblox: !pick.roblox })} icon={<Gamepad2 size={12} />} title="Roblox's own top bar and touch controls over the game">
                  Roblox UI
                </Toggle>
                {thumb.data && (
                  <Toggle on={backdrop === 'game'} onClick={() => setPick({ backdrop: backdrop === 'game' ? 'look' : 'game' })} icon={<ImageIcon size={12} />} title="Over the game's latest picture instead of a scene in the look's mood">
                    Over your game
                  </Toggle>
                )}
              </>
            )}
            <StageStatus loading={pick.stage === 'preview' ? shown.loading : sheet.loading} ms={pick.stage === 'preview' ? shown.pic?.ms : sheet.sheet?.ms} cached={pick.stage === 'preview' ? shown.pic?.cached : sheet.sheet?.cached} />
          </div>

          {pick.stage === 'preview' ? (
            <div ref={stageRef} className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-6 py-5" style={{ background: 'radial-gradient(90% 80% at 50% 40%, color-mix(in srgb, var(--color-surface2) 70%, transparent), transparent)' }}>
              {fitW > 0 &&
                (shown.pic ? (
                  <img
                    src={shown.pic.png}
                    alt={`${screenLabel} in ${d?.name ?? ''}`}
                    draggable={false}
                    className={cx('rounded-[10px] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)] ring-1 ring-white/8 transition-opacity duration-200', shown.loading && 'opacity-60')}
                    style={{ width: fitW, height: fitW / picAspect }}
                  />
                ) : (
                  <div style={{ width: fitW, height: fitW / aspect }}>
                    <Shimmer className="h-full w-full rounded-[10px]" />
                  </div>
                ))}
              {fitW > 0 && d && (
                <div className="mt-3 flex items-center gap-2 text-[11px] text-faint" style={{ width: fitW }}>
                  <span className="text-dim">{screenLabel}</span>
                  <span>·</span>
                  <span>
                    {d.name}
                    {pick.accent ? ` ${pick.accent}` : ''}
                  </span>
                  <span className="flex-1" />
                  <span className="tabular-nums">{screen === 'sample' ? 'Laptop · 1366×768 pt' : DEVICE_NOTE[pick.device]}</span>
                </div>
              )}
              {shown.error && <div className="absolute inset-x-6 bottom-4 rounded-xl border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">{shown.error}</div>}
              {!shown.error && shown.pic && shown.pic.errors.length > 0 && <div className="absolute inset-x-6 bottom-4 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] leading-snug text-warn">Not forged: {shown.pic.errors.slice(0, 3).join(' · ')}</div>}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {sheet.sheet && d ? (
                <div className={cx('transition-opacity duration-200', sheet.loading && 'opacity-60')}>
                  <div className="mb-4 text-[12px] leading-relaxed text-faint">
                    Every element of the {d.name} look{pick.accent ? ` tinted ${pick.accent}` : ''}, forged by the engine at its design size. A design wears one with its skin spec (click a tile to copy it): the art goes under the element’s content and 9-slices to any size.
                  </div>
                  <ElementSheet sheet={sheet.sheet} mood={MOOD[d.id] ?? MOOD.candy!} />
                </div>
              ) : sheet.error ? (
                <Empty>{sheet.error}</Empty>
              ) : (
                <div className="flex flex-wrap gap-2.5">
                  {Array.from({ length: 14 }, (_, i) => (
                    <Shimmer key={i} className="h-[120px] w-[180px] rounded-xl" />
                  ))}
                </div>
              )}
            </div>
          )}
        </main>

        {/* The pick and what to do with it. */}
        <aside className="flex min-h-0 flex-col border-l border-line">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-3">
            {d ? (
              <>
                <Overline>Look</Overline>
                <div className="font-display text-[22px] leading-tight text-text">{d.name}</div>
                <div className="text-[12px] text-dim">{d.tagline}</div>
                <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
                  <span className="text-dim">{lookFor(d.for).games}</span> {lookFor(d.for).looks}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] text-dim" title="Titles and numbers">
                    {d.fonts.display}
                  </span>
                  {d.fonts.body !== d.fonts.display && (
                    <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] text-dim" title="Labels">
                      {d.fonts.body}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="flex -space-x-1">
                    {d.palette.slice(0, 8).map((p) => (
                      <span key={p.name} title={`${p.name} ${p.hex}`} className="h-3.5 w-3.5 rounded-full ring-2 ring-bg" style={{ background: p.hex }} />
                    ))}
                  </span>
                </div>

                {!!genres.data?.length && (
                  <div className="mt-5">
                    <Overline right={<span className="tracking-normal normal-case">{genres.data.length}</span>}>Genre</Overline>
                    <GenrePicker genres={genres.data} genre={pick.genre} onPick={(g) => setPick(g ? { genre: g.id, direction: g.direction, accent: g.accent, ...(pick.screen === 'sample' ? { screen: 'shop' } : {}) } : { genre: null })} />
                  </div>
                )}

                <div className="mt-5">
                  <Overline>Accent</Overline>
                  <AccentPicker d={d} accent={pick.accent} onChange={(accent) => setPick({ accent })} />
                </div>

                <div className="mt-5">
                  <Overline right={<span className="tracking-normal normal-case">{screens.length + 1 + (game ? 1 : 0)}</span>}>Screen</Overline>
                  <div className="-mx-1.5 space-y-1">
                    {game && (
                      <ScreenRow
                        id="game"
                        label="Your game’s UI"
                        sub={`${game.screens.length} screen${game.screens.length === 1 ? '' : 's'} read from ${game.source === 'PlayerGui' ? 'a playtest' : 'Studio'} ${timeAgo(game.capturedAt)} (${game.screens.slice(0, 4).join(', ')}${game.screens.length > 4 ? '…' : ''}), dressed in ${d.name}.`}
                        selected={screen === 'game'}
                        thumb={{ what: 'game', direction: d.id, accent: pick.accent, device: 'desktop', width: thumbWidth, roblox: false, priority: 'low', slot: 'thumb:game' }}
                        onPick={() => setPick({ screen: 'game', stage: 'preview' })}
                      />
                    )}
                    <ScreenRow
                      id="sample"
                      label={`${d.sampleTitle || 'Shop'} · sample`}
                      sub="The look’s own showcase: a shop window on a laptop."
                      selected={screen === 'sample'}
                      thumb={{ what: 'sample', direction: d.id, accent: pick.accent, width: thumbWidth, roblox: false, priority: 'low', slot: 'thumb:sample' }}
                      onPick={() => setPick({ screen: 'sample', stage: 'preview' })}
                    />
                    {[...screens.filter(inLook), ...screens.filter((t) => !inLook(t))].map((t) => (
                      <ScreenRow
                        key={t.id}
                        id={t.id}
                        label={t.label}
                        sub={t.for}
                        {...(inLook(t) ? {} : { missing: `Drawn in ${t.looks.map(nameOf).join(', ')}.` })}
                        selected={screen === t.id}
                        thumb={{ what: 'template', template: t.id, direction: d.id, accent: pick.accent, genre: pick.genre, device: 'desktop', width: thumbWidth, roblox: false, priority: 'low', slot: `thumb:${t.id}` }}
                        onPick={() => setPick({ screen: t.id, stage: 'preview' })}
                      />
                    ))}
                    {templates.data && !screens.length && <div className="px-2 py-1 text-[11.5px] text-faint">More screen templates arrive as they are made.</div>}
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <Shimmer className="h-6 w-32 rounded-md" />
                <Shimmer className="h-16 w-full rounded-md" />
              </div>
            )}
          </div>

          <div className="space-y-2.5 border-t border-line bg-bg2/70 px-4 pt-3 pb-3.5">
            <Button kind="primary" className="w-full" disabled={!d || !!busy} icon={busy === 'make' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} onClick={() => void make()} title={d ? `Makes “${screenLabel} (${d.name})” in this project’s mockups and opens it there` : undefined}>
              Make a mockup
            </Button>
            {d && (
              <div title={game ? `Your game’s own screens (${game.screens.join(', ')}), every window, button, tab, card, bar and pill wearing ${d.name}: a mockup, opened in Mockups` : 'Read the game’s UI on the UI page first (In the game: Read from Studio)'}>
                <Button className="w-full" disabled={!game || !!busy} icon={busy === 'dress' ? <Loader2 size={14} className="animate-spin" /> : <Shirt size={14} />} onClick={() => void dress()}>
                  <span className="truncate">Dress my game’s UI in {d.name}</span>
                </Button>
                {!game && <div className="mt-1 text-center text-[10.5px] text-faint">Read the game’s UI on the UI page first</div>}
              </div>
            )}
            {lastMade && d && (
              <button disabled={!!busy} onClick={() => void make(lastMade.name)} className="flex w-full items-center justify-center gap-1.5 text-[11.5px] text-dim transition-colors hover:text-text disabled:opacity-50" title={`A new version of “${lastMade.title}”, to compare looks side by side`}>
                {busy === 'add' ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                <span className="truncate">Add to “{lastMade.title}” as a version</span>
              </button>
            )}
            <div className="rounded-xl bg-bg ring-1 ring-line transition-shadow focus-within:ring-accent/50">
              <textarea
                value={ask}
                rows={2}
                onChange={(e) => setAsk(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
                }}
                placeholder={d ? `Ask the UI designer for a screen in ${d.name}…` : ''}
                className="no-drag block w-full resize-none bg-transparent px-3 pt-2 text-[12.5px] leading-snug text-text outline-none placeholder:text-faint"
              />
              <div className="flex items-center gap-2 px-2 pt-0.5 pb-1.5">
                <span className="min-w-0 flex-1 truncate pl-1 text-[10.5px] text-faint" title="The copilot gets your words with this look, accent, screen and the picture on the stage">
                  With this pick and picture
                </span>
                <Button size="sm" disabled={!d || !!busy} icon={busy === 'ask' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} onClick={() => void send()}>
                  Ask the designer
                </Button>
              </div>
            </div>
            {note && (
              <div className={cx('flex items-start gap-1.5 text-[11.5px] leading-snug', note.tone === 'ok' ? 'text-ok' : 'text-bad')}>
                {note.tone === 'ok' && <Check size={12} className="mt-0.5 shrink-0" />}
                {note.text}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Toggle({ on, onClick, icon, title, children }: { on: boolean; onClick: () => void; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className={cx('flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] ring-1 transition-colors', on ? 'bg-accent/12 text-accent2 ring-accent/35' : 'text-dim ring-line hover:text-text')}>
      {icon}
      {children}
    </button>
  );
}

function StageStatus({ loading, ms, cached }: { loading: boolean; ms?: number; cached?: boolean }) {
  if (loading)
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-accent2">
        <Loader2 size={12} className="animate-spin" />
        Forging…
      </span>
    );
  if (ms === undefined) return null;
  return <span className="text-[11px] text-faint tabular-nums">{cached ? 'From the cache' : `Forged in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`}</span>;
}
