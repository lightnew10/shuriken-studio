import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ClipboardCopy, CloudUpload, Crown, Download, Gamepad2, ImageIcon, PackagePlus, Pencil, Settings2, Store, Type, X } from 'lucide-react';
import { TopBar } from '../components/topbar';
import { Button, Empty, ErrorNote, Pill, Segmented, cx, inputClass, timeAgo } from '../components/ui';
import { CopilotToggle, WithCopilot, setDockContext, useCopilotOpen } from '../containers/copilot-chat';
import { navigate } from '../lib/nav';
import { rpc, useRpc } from '../lib/rpc';
import { STATUS, STYLE, TAB_COPILOT, countLine, kindLabel, pushLine, storefrontTabs, thumbStandings, type ArtEntry, type StoreItemView, type StorefrontTab, type StorefrontView } from '../lib/storefront';

const EVENTS = ['storefront.changed'];

/**
 * A Storefront picture ("thumbs/A.png", "items/VIP.png"…) as a data URL, fetched again only when `version` (when it
 * was drawn, its content's hash) says it changed: not every picture on every change of the Storefront.
 */
function useArt(file: string | null | undefined, version = ''): string | null {
  const img = useRpc<string | null>(file ? 'storefront.image' : null, { file, v: version }, [], [file, version]);
  return img.data ?? null;
}

/** Saves a copy of a picture where the user picks (a save dialog in Downloads). */
async function savePng(file: string, name: string): Promise<string | null> {
  const path = await rpc<string>('storefront.path', { file });
  return window.shuriken.saveFileAs(path, name);
}

/**
 * The Storefront: what the game sells (game passes and developer products, built into the game and tested with
 * Studio's test purchases, on Roblox only when the user pushes them), the pictures that sell it (thumbnails the
 * judge narrowed to one, the game's icon, the store's icons as a set) and its words (title, description). Each tab
 * has its own copilot beside it. The pictures and the words the user uploads by hand; Push to Roblox puts the store
 * up, and nothing else here publishes anything.
 */
export function StorefrontPage({ tab: asked }: { tab?: string }) {
  const data = useRpc<StorefrontView>('storefront.get', {}, EVENTS);
  const tabs = storefrontTabs(data.data?.prefs);
  const [tab, setTab] = useState<StorefrontTab>('store');
  useEffect(() => {
    if (!tabs.length) return;
    if (asked && (tabs as string[]).includes(asked)) setTab(asked as StorefrontTab);
    else if (!tabs.includes(tab)) setTab(tabs[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, tabs.join()]);
  // Every tab's copilot keeps its own open state (the hooks run for all three, the tab picks one).
  const docks = { store: useCopilotOpen('store'), thumbnails: useCopilotOpen('thumbnails'), copy: useCopilotOpen('copy') };
  const dock = TAB_COPILOT[tab];
  const [open, setOpen] = docks[dock];
  useEffect(() => setDockContext(dock, undefined, `the Storefront's ${tab === 'pictures' ? 'Pictures' : tab === 'store' ? 'Store' : 'Copy'} tab`), [dock, tab]);
  const view = data.data;

  if (view && !tabs.length)
    return (
      <div className="flex h-full flex-col bg-bg">
        <TopBar title="Storefront" back />
        <Empty icon={<Store size={20} />}>
          The Storefront is off: monetization and copy are both switched off in Settings, so games are built without a store, thumbnails or copy.
          <div className="mt-3">
            <Button size="sm" icon={<Settings2 size={13} />} onClick={() => navigate('settings', 'storefront')}>
              Storefront settings
            </Button>
          </div>
        </Empty>
      </div>
    );

  return (
    <div className="flex h-full flex-col bg-bg">
      <TopBar title="Storefront" back>
        {tabs.length > 1 && (
          <Segmented
            value={tab}
            onChange={setTab}
            options={tabs.map((t) => ({ value: t, label: t === 'store' ? 'Store' : t === 'pictures' ? 'Pictures' : 'Copy' }))}
          />
        )}
        <CopilotToggle dock={dock} open={open} onChange={setOpen} />
      </TopBar>
      <WithCopilot key={dock} dock={dock} open={open} onClose={() => setOpen(false)}>
        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto max-w-4xl">
            {!view ? (
              <div className="text-[12.5px] text-faint">{data.error ?? 'Loading…'}</div>
            ) : tab === 'store' ? (
              <StoreTab view={view} reload={data.reload} />
            ) : tab === 'pictures' ? (
              <PicturesTab view={view} />
            ) : (
              <CopyTab view={view} />
            )}
          </div>
        </main>
      </WithCopilot>
    </div>
  );
}

function Heading({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        {children && <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-dim">{children}</p>}
      </div>
      {aside}
    </div>
  );
}

// ─── Store ───────────────────────────────────────────────────────────────────

function StoreTab({ view, reload }: { view: StorefrontView; reload: () => void }) {
  const c = view.catalog;
  const items = c?.items ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const pending = view.pending ?? [];

  const apply = async () => {
    setBusy('apply');
    setNote(null);
    try {
      const r = await rpc<{ note: string }>('storefront.apply');
      setNote({ ok: true, text: r.note });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      reload();
    }
  };
  const push = async () => {
    setConfirm(false);
    setBusy('push');
    setNote(null);
    try {
      // Exactly what the confirm list showed: an item changed since (an agent, a copilot) is left for another look.
      const r = await rpc<{ ok: boolean; summary: string; needsUser?: string }>('storefront.push', { confirmed: sending.map((i) => ({ key: i.key, hash: i.hash ?? '' })) });
      setNote({ ok: r.ok, text: [r.summary, r.needsUser].filter(Boolean).join(' ') });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      reload();
    }
  };

  if (!items.length)
    return (
      <Empty icon={<Store size={20} />}>
        Nothing for sale yet. A new game’s plan designs its store for the genre (cosmetics and status only for a competitive game), and the team builds it in with Studio test purchases. Or ask the store copilot beside this page.
      </Empty>
    );

  const sending = items.filter((i) => pending.includes(i.key));
  return (
    <>
      <Heading title="What the game sells" aside={c ? <Pill tone="accent" title={STYLE[c.style].hint}>{STYLE[c.style].label}</Pill> : null}>
        {c?.why || STYLE[c?.style ?? 'fair'].hint}
      </Heading>

      {view.behind && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-bg2 px-4 py-2.5 text-[12.5px] leading-relaxed text-dim">
          <span className="min-w-0 flex-1">The game still has the earlier store: these changes are a draft until they go into its store module ({view.module}).</span>
          <Button size="sm" icon={<PackagePlus size={13} />} disabled={!!busy} onClick={() => void apply()} title="Write the game's ShurikenStore module from this design and sync it to Studio (nothing goes to Roblox)">
            {busy === 'apply' ? 'Putting it in…' : 'Put it in the game'}
          </Button>
        </div>
      )}

      <div className="mb-4 rounded-xl border border-line bg-bg2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <CloudUpload size={16} className={cx('shrink-0', sending.length ? 'text-accent2' : 'text-ok')} />
          <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-dim">{pushLine(items, pending)}</span>
          {sending.length > 0 && !confirm && (
            <Button size="sm" kind="primary" icon={<CloudUpload size={13} />} disabled={!!busy} onClick={() => setConfirm(true)}>
              {busy === 'push' ? 'Pushing…' : 'Push to Roblox…'}
            </Button>
          )}
        </div>
        {confirm && (
          <div className="mt-3 border-t border-line pt-3 text-[12.5px] leading-relaxed text-dim">
            <div className="mb-1.5 text-text">Put these on Roblox, on sale at these prices?</div>
            <ul className="mb-2 space-y-0.5">
              {sending.map((i) => (
                <li key={i.key} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {i.name} <span className="text-faint">· {kindLabel(i.kind)}{i.status === 'changed' ? ' · update' : ''}</span>
                  </span>
                  <span className="tabular-nums text-text">R$ {i.price.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <div className="mb-2.5 text-[11.5px] text-faint">The game must be published, and your Open Cloud key needs the Game Passes and Developer Products APIs (write) for it. Their ids go into the game’s store module. Nothing else is published.</div>
            <div className="flex gap-2">
              <Button size="sm" kind="primary" icon={<Check size={13} />} onClick={() => void push()}>
                Push {sending.length}
              </Button>
              <Button size="sm" kind="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {note && <div className={cx('mt-2 text-[12px] leading-snug', note.ok ? 'text-ok' : 'text-warn')}>{note.text}</div>}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {items.map((i) => (
          <ItemCard key={i.key} item={i} limits={view.limits} onSaved={reload} />
        ))}
      </div>
    </>
  );
}

function ItemIcon({ file, version, size = 56 }: { file?: string; version?: string; size?: number }) {
  const src = useArt(file, version);
  // Roblox shows pass and product icons as circles.
  return (
    <div className="shrink-0 overflow-hidden rounded-full bg-surface3 ring-1 ring-line" style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full w-full items-center justify-center text-faint"><Gamepad2 size={size / 2.6} /></div>}
    </div>
  );
}

function ItemCard({ item: i, limits, onSaved }: { item: StoreItemView; limits: StorefrontView['limits']; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(i.name);
  const [price, setPrice] = useState(String(i.price));
  const [description, setDescription] = useState(i.description);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (editing) return;
    setName(i.name);
    setPrice(String(i.price));
    setDescription(i.description);
  }, [i.name, i.price, i.description, editing]);
  const st = STATUS[i.status];
  const save = async () => {
    setError(null);
    try {
      await rpc('storefront.edit', { key: i.key, item: { name, description, price: Number(price) } });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method 'rpc': Error: /, ''));
    }
  };
  return (
    <div className="card flex gap-3 p-3.5">
      <ItemIcon file={i.icon?.file} version={i.icon?.sha} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-2">
            <input className={inputClass} value={name} maxLength={limits?.name ?? 50} onChange={(e) => setName(e.target.value)} aria-label="Shown name" />
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-dim">R$</span>
              <input className={cx(inputClass, 'w-28')} type="number" min={limits?.priceMin ?? 1} value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price in Robux" />
            </div>
            <textarea className={cx(inputClass, 'min-h-20 resize-y')} value={description} maxLength={limits?.description ?? 1000} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
            {error && <ErrorNote error={error} />}
            <div className="flex gap-2">
              <Button size="sm" kind="primary" icon={<Check size={13} />} onClick={() => void save()}>
                Save
              </Button>
              <Button size="sm" kind="ghost" icon={<X size={13} />} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-[13.5px] font-medium text-text" title={i.key}>
                {i.name}
              </span>
              <span className="text-[13px] tabular-nums text-accent2">R$ {i.price.toLocaleString()}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Pill>{kindLabel(i.kind)}</Pill>
              <Pill tone={st.tone} title={st.hint}>
                {st.label}
              </Pill>
            </div>
            <div className="mt-1.5 text-[12px] leading-snug text-dim">{i.benefit}</div>
            <div className={cx('mt-1 line-clamp-3 text-[12px] leading-snug', i.description ? 'text-faint' : 'text-faint/70 italic')}>{i.description || 'No description yet'}</div>
          </>
        )}
      </div>
      {!editing && (
        <button title="Change its name, price or description" onClick={() => setEditing(true)} className="no-drag self-start rounded-lg p-1.5 text-faint hover:bg-white/5 hover:text-text">
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}

// ─── Pictures ────────────────────────────────────────────────────────────────

function PicturesTab({ view }: { view: StorefrontView }) {
  const art = view.art ?? { thumbs: [], icons: [] };
  const standings = useMemo(() => thumbStandings(art.thumbs, art.pick), [art.thumbs, art.pick]);
  const [saved, setSaved] = useState<string | null>(null);
  const save = async (file: string, name: string) => {
    const at = await savePng(file, name).catch(() => null);
    if (at) setSaved(`Saved ${at}`);
  };
  const winner = standings[0]?.place === 1 ? standings[0] : null;
  const pickName = (n: string) => void rpc('storefront.pick', { name: n });
  const items = (view.catalog?.items ?? []).filter((i) => i.icon?.file);
  const game = (view.copy?.title || 'thumbnail').replace(/[^\w -]+/g, '').trim() || 'thumbnail';

  return (
    <div className="space-y-8">
      <section>
        <Heading title="Thumbnails">
          1920×1080 pictures for the game’s page. The judge eliminates them one by one down to the best; you can pick another. Save one and upload it on the game’s page in the Creator Dashboard.
        </Heading>
        {!standings.length ? (
          <Empty icon={<ImageIcon size={20} />}>No thumbnails yet. Near the end of a build the thumbnail artist stages the game’s best moments and makes five; or ask the thumbnail copilot.</Empty>
        ) : (
          <>
            {winner && (
              <div className="card mb-4 overflow-hidden">
                <ArtImage file={winner.file} version={winner.at} className="aspect-video w-full" />
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Crown size={16} className="shrink-0 text-accent2" />
                  <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
                    <span className="font-medium text-text">{winner.name}</span>
                    <span className="text-dim"> · {art.pick?.byUser ? 'your pick' : 'the judge’s pick'}</span>
                    {winner.why && <div className="mt-0.5 text-dim">{winner.why}</div>}
                  </div>
                  <Button size="sm" kind="primary" icon={<Download size={13} />} onClick={() => void save(winner.file, `${game} thumbnail.png`)}>
                    Save PNG
                  </Button>
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {standings
                .filter((t) => t !== winner)
                .map((t) => (
                  <div key={t.name} className="card overflow-hidden">
                    <ArtImage file={t.file} version={t.at} className="aspect-video w-full" />
                    <div className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text" title={t.note || t.name}>
                          {t.name}
                        </span>
                        {t.place && <Pill title="Where it finished in the judge's eliminations">#{t.place}</Pill>}
                      </div>
                      <div className="mt-1 line-clamp-3 text-[11.5px] leading-snug text-faint">{t.why ? `Out: ${t.why}` : t.note || 'Not judged yet'}</div>
                      <div className="mt-2 flex gap-1.5">
                        <Button size="sm" kind="ghost" icon={<Crown size={12} />} onClick={() => pickName(t.name)} title="Make this the pick">
                          Pick
                        </Button>
                        <Button size="sm" kind="ghost" icon={<Download size={12} />} onClick={() => void save(t.file, `${game} ${t.name}.png`)}>
                          Save PNG
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </section>

      <section>
        <Heading title="Game icon">512×512, shown small in lists and search: one bold subject that reads at a glance.</Heading>
        {!art.icons.length ? (
          <div className="text-[12.5px] text-faint">No icon yet.</div>
        ) : (
          <div className="flex flex-wrap gap-4">
            {[...art.icons].sort((a, b) => Number(b.name === art.gameIcon) - Number(a.name === art.gameIcon)).map((ic) => (
              <IconTile key={ic.name} entry={ic} chosen={ic.name === art.gameIcon} onSave={() => void save(ic.file, `${game} icon.png`)} />
            ))}
          </div>
        )}
      </section>

      {view.prefs.monetization && (
        <section>
          <Heading title="Store icons">One set from one template, so every pass and product looks like it belongs. They go to Roblox with the items when you push the store.</Heading>
          {!items.length ? (
            <div className="text-[12.5px] text-faint">Not drawn yet.</div>
          ) : (
            <div className="flex flex-wrap gap-5">
              {items.map((i) => (
                <div key={i.key} className="flex w-24 flex-col items-center gap-1.5 text-center">
                  <ItemIcon file={i.icon?.file} version={i.icon?.sha} size={88} />
                  <span className="line-clamp-2 text-[11.5px] leading-tight text-dim">{i.name}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {saved && <div className="text-[12px] text-ok">{saved}</div>}
    </div>
  );
}

function ArtImage({ file, version, className }: { file: string; version?: string; className?: string }) {
  const src = useArt(file, version);
  return <div className={cx('bg-surface3', className)}>{src && <img src={src} alt="" className="h-full w-full object-cover" />}</div>;
}

function IconTile({ entry, chosen, onSave }: { entry: ArtEntry; chosen: boolean; onSave: () => void }) {
  return (
    <div className={cx('card w-40 overflow-hidden p-2', chosen && 'ring-1 ring-accent/50')}>
      <ArtImage file={entry.file} version={entry.at} className="aspect-square w-full overflow-hidden rounded-xl" />
      <div className="mt-2 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-text" title={entry.note || entry.name}>
          {entry.name}
        </span>
        {chosen && <Pill tone="accent">the icon</Pill>}
      </div>
      <Button size="sm" kind="ghost" icon={<Download size={12} />} onClick={onSave} className="mt-1.5 w-full">
        Save PNG
      </Button>
    </div>
  );
}

// ─── Copy ────────────────────────────────────────────────────────────────────

function CopyTab({ view }: { view: StorefrontView }) {
  const copy = view.copy ?? { title: '', description: '', history: [], updatedAt: '' };
  const limits = view.limits;
  const items = view.prefs.monetization ? (view.catalog?.items ?? []) : [];
  return (
    <div className="space-y-8">
      <CopyField field="title" label="Title" text={copy.title} max={limits?.title ?? 50} history={copy.history.filter((h) => h.field === 'title')} />
      <CopyField field="description" label="Description" text={copy.description} max={limits?.gameDescription ?? 1000} history={copy.history.filter((h) => h.field === 'description')} long />
      {items.length > 0 && (
        <section>
          <Heading title="The store’s texts">Each pass’s and product’s shown name and description. They go to Roblox with the items when you push the store; change them on the Store tab or ask the copy copilot.</Heading>
          <div className="card divide-y divide-line">
            {items.map((i) => (
              <div key={i.key} className="px-4 py-2.5">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span className="font-medium text-text">{i.name}</span>
                  <span className="text-faint">· {kindLabel(i.kind)}</span>
                </div>
                <div className={cx('mt-0.5 text-[12px] leading-snug whitespace-pre-wrap', i.description ? 'text-dim' : 'text-faint italic')}>{i.description || 'No description yet'}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function CopyField({ field, label, text, max, history, long }: { field: 'title' | 'description'; label: string; text: string; max: number; history: Array<{ text: string; at: string; by: string }>; long?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!editing) setValue(text);
  }, [text, editing]);
  const count = countLine(editing ? value : text, max);
  const save = async (next: string) => {
    setError(null);
    try {
      await rpc('storefront.edit', { copy: { [field]: next } });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method 'rpc': Error: /, ''));
    }
  };
  const copyIt = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the text stays selectable */
    }
  };
  return (
    <section>
      <Heading
        title={label}
        aside={
          <div className="flex items-center gap-2">
            <span className={cx('text-[11.5px] tabular-nums', count.tone === 'bad' ? 'text-bad' : count.tone === 'warn' ? 'text-warn' : 'text-faint')}>{count.text}</span>
            {!editing && text && (
              <Button size="sm" kind="ghost" icon={copied ? <Check size={12} /> : <ClipboardCopy size={12} />} onClick={() => void copyIt()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
            {!editing && (
              <Button size="sm" kind="ghost" icon={<Pencil size={12} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </div>
        }
      />
      {editing ? (
        <div className="space-y-2">
          {long ? <textarea className={cx(inputClass, 'min-h-56 resize-y leading-relaxed')} value={value} onChange={(e) => setValue(e.target.value)} aria-label={label} /> : <input className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} aria-label={label} />}
          {error && <ErrorNote error={error} />}
          <div className="flex gap-2">
            <Button size="sm" kind="primary" icon={<Check size={13} />} onClick={() => void save(value.trim())}>
              Save
            </Button>
            <Button size="sm" kind="ghost" icon={<X size={13} />} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : text ? (
        <div className={cx('card px-4 py-3 select-text', long ? 'text-[13px] leading-relaxed whitespace-pre-wrap text-dim' : 'font-display text-[20px] text-text')}>{text}</div>
      ) : (
        <div className="flex items-center gap-2 text-[12.5px] text-faint">
          <Type size={14} />
          Not written yet: the copywriter writes it during a build, or ask the copy copilot.
        </div>
      )}
      {history.length > 0 && !editing && (
        <details className="mt-2 text-[12px] text-faint">
          <summary className="cursor-pointer hover:text-dim">Earlier versions ({history.length})</summary>
          <div className="mt-1.5 space-y-1.5">
            {history.map((h) => (
              <div key={h.at + h.text.slice(0, 20)} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 line-clamp-2 text-dim">{h.text}</span>
                <span className="shrink-0">{timeAgo(h.at)}</span>
                <button className="shrink-0 text-accent2 hover:underline" onClick={() => void save(h.text)}>
                  Put back
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
