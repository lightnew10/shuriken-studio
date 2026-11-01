import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, ArrowUp, Check, CircleDashed, Gamepad2, LayoutPanelTop, MessageSquarePlus, Paperclip, Send, Sparkles, Square, X } from 'lucide-react';
import type { ChatMessage } from '@shared/domain';
import { suggestionsOf, type Suggestion } from '@shared/suggestions';
import { rpc, useCoreEvent, useRpc } from '../lib/rpc';
import { useCurrentProject } from '../lib/project';
import { navigate, type Page } from '../lib/nav';
import { ShurikenMark } from '../brand/logo';
import { applyMessage } from '../lib/mockup-board';
import { DRAFT_DOCKS, addOutcome, dockIntro, dockItems, draftActions, draftRefs, isDraftDock, standing, standingLine, type DraftDock, type DraftRef } from '../lib/workshop-drafts';
import { IconButton, Markdown, cx } from '../components/ui';
import { isVideoFile, referenceFiles } from '../lib/references';

/** The docks that have a copilot (see core/copilots/copilot-roles.ts); the last three are the Storefront's. */
export type CopilotDock = 'animation' | 'audio' | 'ui' | 'effects' | 'store' | 'copy' | 'thumbnails';

interface CopilotInfo {
  id: CopilotDock;
  channel: string;
  title: string;
  suggestions: Suggestion[];
  busy: boolean;
}

/**
 * What the user is looking at in each dock (the selected move, sound, element…): a page sets it as
 * the selection changes, and the copilot gets it with every message, so "make this snappier" works.
 */
const dockContext = new Map<CopilotDock, { page: string; item?: string; note?: string }>();
export function setDockContext(dock: CopilotDock, item: string | undefined, note?: string): void {
  dockContext.set(dock, { page: dock, item, note });
}

/** Text waiting to be sent, per project and dock (kept across page changes and restarts). */
const draftKey = (projectId: string, dock: CopilotDock) => `shuriken.copilotDraft.${projectId}.${dock}`;
function loadDraft(projectId: string | null, dock: CopilotDock): string {
  if (!projectId) return '';
  try {
    return localStorage.getItem(draftKey(projectId, dock)) ?? '';
  } catch {
    return '';
  }
}
function saveDraft(projectId: string | null, dock: CopilotDock, text: string): void {
  if (!projectId) return;
  try {
    if (text) localStorage.setItem(draftKey(projectId, dock), text);
    else localStorage.removeItem(draftKey(projectId, dock));
  } catch {
    /* storage unavailable */
  }
}
/** Puts text in a copilot's box (another part of the page asks it something, e.g. the UI page's element). */
export function setCopilotDraft(projectId: string, dock: CopilotDock, text: string): void {
  saveDraft(projectId, dock, text);
  window.dispatchEvent(new CustomEvent('shuriken:copilot-draft', { detail: { dock, text } }));
}

/** Docks whose copilot the user closed in this run of the app; every dock's copilot is open otherwise. */
const closedCopilots = new Set<CopilotDock>();

/**
 * Whether a dock's copilot shows beside its page. Open by default, every time the app starts: the copilot is
 * how the dock's work is made. Closing it lasts until the app is closed; a draft it makes opens it again.
 */
export function useCopilotOpen(dock: CopilotDock): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => !closedCopilots.has(dock));
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ dock: CopilotDock }>).detail;
      if (d?.dock === dock) {
        closedCopilots.delete(dock);
        setOpenState(true);
      }
    };
    window.addEventListener('shuriken:copilot-draft', on);
    return () => window.removeEventListener('shuriken:copilot-draft', on);
  }, [dock]);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (v) closedCopilots.delete(dock);
    else closedCopilots.add(dock);
  };
  return [open, setOpen];
}

/** The top bar's button that shows or hides a dock's copilot. */
export function CopilotToggle({ dock, open, onChange }: { dock: CopilotDock; open: boolean; onChange: (open: boolean) => void }) {
  const info = useRpc<CopilotInfo[]>('copilots.info');
  const title = info.data?.find((c) => c.id === dock)?.title ?? 'Copilot';
  return (
    <IconButton title={open ? `Hide the ${title.toLowerCase()}` : `Talk to the ${title.toLowerCase()}`} onClick={() => onChange(!open)} active={open}>
      <Sparkles size={15} />
    </IconButton>
  );
}

/** Tool names the copilots use, in words for the "working" line. */
const DOING: Array<[RegExp, string]> = [
  [/store_catalog/, 'Designing the store'],
  [/store_module/, 'Putting the store in the game'],
  [/store_icons/, 'Drawing the store’s icons'],
  [/store_list|copy_get/, 'Reading the Storefront'],
  [/copy_write/, 'Writing'],
  [/thumb_shot/, 'Staging a shot in Studio'],
  [/thumb_compose/, 'Composing a picture'],
  [/thumb_pick/, 'The judge is picking a thumbnail'],
  [/animation_view/, 'Looking at the animation'],
  [/animation_check/, 'Measuring it in Studio'],
  [/animation_(create|build)/, 'Making the animation'],
  [/animation_upload|audio_upload/, 'Uploading to Roblox'],
  [/animation_(presets|list)/, 'Reading the animations'],
  [/rig_build/, 'Building the rig in Studio'],
  [/kiln_request/, 'Kiln’s copilot is working on it (follow along on the Kiln page)'],
  [/kiln_clip/, 'Animating with Kiln'],
  [/kiln_(import|clips|status)/, 'Bringing in Kiln’s clips'],
  [/animation_import/, 'Bringing in the game’s animation'],
  [/audio_music/, 'Composing'],
  [/audio_sfx/, 'Designing a sound'],
  [/audio_(add|list)|store_search/, 'Looking for sounds'],
  [/(vfx|animation|audio)_use/, 'Putting it in the game'],
  [/vfx_play/, 'Playing the effect in Studio'],
  [/vfx_/, 'Making the effect'],
  [/ui_mockup_(create|update)/, 'Mocking it up'],
  [/ui_mockup_audit/, 'Checking the mockup on every device'],
  [/ui_mockup_list/, 'Reading the mockups'],
  [/ui_audit/, 'Checking the UI on every device'],
  [/roblox_playtest/, 'Testing in a playtest'],
  [/roblox_screenshot/, 'Taking a look in Studio'],
  [/roblox_sync_push/, 'Syncing code to Studio'],
  [/roblox_(run_luau|inspect|explore|search)|code_query/, 'Reading the game'],
  [/^(Edit|Write|MultiEdit)/, 'Editing code'],
  [/^(Read|Glob|Grep)/, 'Reading code'],
];
const doing = (text: string) => {
  const tool = text.replace(/^mcp__shuriken__/, '').split(' ')[0] ?? '';
  return DOING.find(([re]) => re.test(tool))?.[1] ?? 'Working';
};

/**
 * A dock's copilot: its own conversation with the user (not the director's), with a live line of
 * what it's doing, Stop, New conversation, and "Hand to the director" for work outside its field.
 * What a reply made is shown under it as a draft with Open and Add to game (a UI mockup: Put it in
 * the game): a copilot's work stays in its dock until the user puts it in.
 */
export function CopilotPanel({ dock, className, onClose }: { dock: CopilotDock; className?: string; onClose?: () => void }) {
  const channel = `copilot:${dock}`;
  const info = useRpc<CopilotInfo[]>('copilots.info');
  const me = info.data?.find((c) => c.id === dock);
  const title = me?.title ?? 'Copilot';
  const project = useCurrentProject();
  const projectId = project.data?.id ?? null;
  const history = useRpc<ChatMessage[]>('chat.list', { limit: 200, channel }, ['project.changed']);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [work, setWork] = useState<{ typing: boolean; runId?: string; action?: string }>({ typing: false });
  const [text, setTextState] = useState(() => loadDraft(projectId, dock));
  const [sending, setSending] = useState(false);
  const [handed, setHanded] = useState<Set<string>>(new Set());
  // Pictures to send with the next message (pasted, dropped or picked), already downsized.
  const [pics, setPics] = useState<Picture[]>([]);
  const [picNote, setPicNote] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const addPictures = async (files: File[]) => {
    // A video can't be attached to a message: it becomes a reference, studied once and read by every agent.
    const videos = files.filter(isVideoFile);
    if (videos.length) {
      const { paths } = referenceFiles(videos, (f) => window.shuriken.pathForFile(f));
      if (paths.length) void rpc('references.add', { paths, from: 'chat' }).catch(() => undefined);
      setPicNote(`${videos.length === 1 ? 'The video is' : 'The videos are'} added as references: Shuriken samples the frames and measures the sound, then the study is on the References page.`);
      files = files.filter((f) => !isVideoFile(f));
      if (!files.length) return;
    }
    const images = files.filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    setPicNote(images.length < files.length ? 'Only PNG, JPEG, WebP or GIF pictures can be attached.' : null);
    if (!images.length) return;
    const room = MAX_PICTURES - pics.length;
    if (room <= 0) return setPicNote(`At most ${MAX_PICTURES} pictures per message.`);
    const made = await Promise.all(images.slice(0, room).map((f) => shrinkPicture(f).catch(() => null)));
    setPics((cur) => [...cur, ...made.filter((x): x is Picture => !!x)].slice(0, MAX_PICTURES));
    if (images.length > room) setPicNote(`At most ${MAX_PICTURES} pictures per message.`);
  };
  // Bubbles written for this game's dock (else the dock's starters), and the copilot's follow-ups after it answers.
  const live = useRpc<Suggestion[] | null>('suggestions.live', { scope: dock }, ['suggestions.changed', 'project.changed'], [dock]);
  // What the dock holds now, so a reply's drafts show where they stand (still a draft, or in the game since).
  const held = useRpc<unknown>(isDraftDock(dock) ? DRAFT_DOCKS[dock].list : null, {}, isDraftDock(dock) ? DRAFT_DOCKS[dock].events : [], [dock]);
  const items = isDraftDock(dock) ? dockItems(dock, held.data) : null;
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const setText = (t: string) => {
    setTextState(t);
    saveDraft(projectId, dock, t);
  };

  useEffect(() => setTextState(loadDraft(projectId, dock)), [projectId, dock]);
  useEffect(() => setMessages(history.data ?? []), [history.data]);
  useEffect(() => {
    if (me?.busy) setWork((w) => (w.typing ? w : { typing: true }));
  }, [me?.busy]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ dock: CopilotDock; text: string }>).detail;
      if (d?.dock !== dock) return;
      setTextState(d.text);
      requestAnimationFrame(() => box.current?.focus());
    };
    window.addEventListener('shuriken:copilot-draft', on);
    return () => window.removeEventListener('shuriken:copilot-draft', on);
  }, [dock]);
  useCoreEvent(['chat.message'], (_c, p) => {
    const m = p as ChatMessage;
    if (m.channel !== channel) return;
    setMessages((cur) => {
      const i = cur.findIndex((x) => x.id === m.id);
      if (i < 0) return [...cur, m];
      const next = cur.slice();
      next[i] = m;
      return next;
    });
  });
  useCoreEvent(['chat.typing'], (_c, p) => {
    const e = p as { typing: boolean; channel?: string; runId?: string };
    if (e.channel !== channel) return;
    setWork((w) => (e.typing ? { typing: true, runId: e.runId ?? w.runId, action: w.action } : { typing: false }));
  });
  useCoreEvent(['run.stream'], (_c, p) => {
    const e = p as { runId: string; kind: string; text: string };
    setWork((w) => (w.typing && w.runId === e.runId && e.kind === 'tool_use' ? { ...w, action: doing(e.text) } : w));
  });

  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, work.typing]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(140, Math.max(40, el.scrollHeight))}px`;
  }, [text]);

  const send = async (override?: string) => {
    const t = (override ?? text).trim();
    const sendPics = override ? [] : pics;
    if ((!t && !sendPics.length) || sending) return;
    setSending(true);
    if (!override) {
      setText('');
      setPics([]);
      setPicNote(null);
    }
    try {
      await rpc('chat.send', { channel, text: t, context: dockContext.get(dock), ...(sendPics.length ? { images: sendPics } : {}) });
    } catch (e) {
      if (!override) {
        setText(t);
        setPics(sendPics);
      }
      window.shuriken.journal('error', { message: `copilot send failed: ${(e as Error).message}` });
    } finally {
      setSending(false);
    }
  };
  const handToDirector = async (m: ChatMessage) => {
    const req = String(m.data?.handoff ?? '').trim();
    if (!req) return;
    await rpc('chat.send', { text: `From the ${title.toLowerCase()}: ${req}` });
    setHanded((s) => new Set(s).add(m.id));
  };
  const talking = messages.filter((m) => m.role !== 'system' || m.kind !== 'status' || !m.data?.reset);

  return (
    <div
      className={cx('flex min-h-0 flex-col bg-bg', className)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void addPictures([...e.dataTransfer.files]);
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3.5 py-2.5">
        <Sparkles size={14} className="text-accent2" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{title}</span>
        {work.typing && (
          <IconButton title="Stop (what it changed so far stays)" onClick={() => void rpc('copilots.stop', { channel })}>
            <Square size={13} />
          </IconButton>
        )}
        <IconButton title="New conversation" onClick={() => void rpc('copilots.reset', { channel })} disabled={work.typing}>
          <MessageSquarePlus size={15} />
        </IconButton>
        {onClose && (
          <IconButton title="Hide" onClick={onClose}>
            <X size={15} />
          </IconButton>
        )}
      </div>
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3.5">
        {talking.length === 0 && !work.typing && (
          <div className="pt-6 text-center text-[12.5px] leading-relaxed text-faint">
            {dockIntro(dock)}
            <div className="mt-3 flex flex-col items-center gap-1.5">
              {(live.data?.length ? live.data.slice(0, 3) : (me?.suggestions ?? [])).map((s) => (
                <button
                  key={s.label}
                  onClick={() => setText(s.prompt)}
                  title={`${s.prompt}\n\n(Put in the box: you can edit it before sending)`}
                  className="no-drag flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-dim ring-1 ring-line transition-colors hover:bg-accent/10 hover:text-text hover:ring-accent/40"
                >
                  <Sparkles size={11} className="text-accent2" />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <motion.div key={m.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
              <div className="max-w-[90%] rounded-2xl rounded-br-md bg-accent/16 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-text ring-1 ring-accent/25">
                {Array.isArray(m.data?.images) && (
                  <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                    {(m.data.images as Array<{ file: string; name: string }>).map((a) => (
                      <AttachmentThumb key={a.file} file={a.file} name={a.name} />
                    ))}
                  </div>
                )}
                {m.text}
              </div>
            </motion.div>
          ) : m.role === 'system' ? (
            <div key={m.id} className="flex items-center gap-2 text-[11px] text-faint">
              <div className="h-px flex-1 bg-line" />
              {m.text}
              <div className="h-px flex-1 bg-line" />
            </div>
          ) : (
            <motion.div key={m.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={cx('text-[13px] leading-relaxed', m.kind === 'error' ? 'text-bad' : 'text-text')}>
              <Markdown text={m.text} />
              {Array.isArray(m.data?.links) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(m.data.links as Array<{ page: Page; item?: string; label: string }>).map((l, i) => (
                    <button key={i} onClick={() => navigate(l.page, l.item)} className="flex items-center gap-1 rounded-full bg-accent/12 px-2.5 py-1 text-[12px] font-medium text-accent2 ring-1 ring-accent/25 hover:bg-accent/20">
                      {l.label} <ArrowRight size={12} />
                    </button>
                  ))}
                </div>
              )}
              {isMockupRef(m.data?.mockup) && <MockupCard mockup={m.data.mockup} channel={channel} />}
              {isDraftDock(dock) && draftRefs(m.data?.drafts).map((r) => <DraftCard key={r.name} dock={dock} draft={r} items={items} />)}
              {typeof m.data?.handoff === 'string' && m.data.handoff && (
                <div className="mt-2 rounded-xl bg-white/[0.03] px-3 py-2 ring-1 ring-line">
                  <div className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">For the director</div>
                  <div className="mt-0.5 text-[12px] text-dim">{String(m.data.handoff)}</div>
                  <button
                    disabled={handed.has(m.id)}
                    onClick={() => void handToDirector(m)}
                    className="mt-1.5 flex items-center gap-1 rounded-lg bg-surface3 px-2.5 py-1 text-[12px] text-text ring-1 ring-line2 transition-colors hover:bg-accent/15 hover:ring-accent/40 disabled:opacity-60"
                  >
                    {handed.has(m.id) ? (
                      <>
                        <Check size={12} /> Sent to the director
                      </>
                    ) : (
                      <>
                        <Send size={12} /> Hand to the director
                      </>
                    )}
                  </button>
                </div>
              )}
            </motion.div>
          ),
        )}
        <AnimatePresence>
          {work.typing && (
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2 text-[12px] text-faint">
              <ShurikenMark size={16} active /> {work.action ? `${work.action}…` : 'Thinking…'}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="shrink-0 border-t border-line p-2.5">
        <FollowUps messages={messages} busy={work.typing} onPick={(s) => setText(s.prompt)} />
        {pics.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pics.map((pic, i) => (
              <div key={i} className="group relative h-14 w-14 overflow-hidden rounded-lg ring-1 ring-line2" title={pic.name}>
                <img src={pic.dataUrl} alt={pic.name} className="h-full w-full object-cover" />
                <button
                  onClick={() => setPics((cur) => cur.filter((_, j) => j !== i))}
                  title="Remove"
                  className="absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {picNote && <div className="mb-1.5 text-[11px] text-warn">{picNote}</div>}
        <div className="flex items-end gap-2 rounded-2xl bg-bg2 p-1.5 ring-1 ring-line2 transition-shadow focus-within:ring-accent/50">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              void addPictures([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => picker.current?.click()}
            title="Attach pictures (or paste or drop them here): references, screenshots, concept art"
            className="no-drag mb-0.5 flex h-9 w-8 shrink-0 items-center justify-center rounded-xl text-faint transition-colors hover:bg-white/6 hover:text-text"
          >
            <Paperclip size={15} />
          </button>
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
              if (!files.length) return;
              e.preventDefault();
              void addPictures(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={`Ask the ${title.toLowerCase()}…`}
            className="no-drag min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2.5 text-[13px] leading-snug text-text outline-none placeholder:text-faint"
          />
          <button
            onClick={() => void send()}
            disabled={(!text.trim() && !pics.length) || sending}
            title="Send"
            className="no-drag mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent transition-all hover:bg-accent-hover disabled:opacity-30"
          >
            {sending ? <ShurikenMark size={16} active /> : <ArrowUp size={17} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Picture {
  name: string;
  dataUrl: string;
}

const MAX_PICTURES = 6;
/** The long side a picture is sent at (the model sees about this much detail anyway). */
const PICTURE_SIDE = 1568;

/** A picture downsized for sending: JPEG unless it has transparency (PNG, WebP and GIF keep it as PNG). */
async function shrinkPicture(file: File): Promise<Picture> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, PICTURE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d')!;
    g.drawImage(img, 0, 0, w, h);
    // PNG keeps transparency; a big PNG (a photo, a busy screenshot) goes as JPEG instead.
    const png = file.type !== 'image/jpeg' ? canvas.toDataURL('image/png') : null;
    return { name: file.name || 'pasted picture', dataUrl: png && png.length < 3_500_000 ? png : canvas.toDataURL('image/jpeg', 0.9) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A picture attached to a sent message (loaded from the project). */
function AttachmentThumb({ file, name }: { file: string; name: string }) {
  const q = useRpc<string>('chat.attachment', { file });
  if (!q.data) return <div className="h-16 w-16 rounded-lg bg-white/5" title={name} />;
  return (
    <div title={name} className="h-16 w-16 overflow-hidden rounded-lg ring-1 ring-accent/30">
      <img src={q.data} alt={name} className="h-full w-full object-cover" />
    </div>
  );
}

interface MockupRef {
  name: string;
  title: string;
  version: string;
  versions?: string[];
  applied?: boolean;
}
const isMockupRef = (x: unknown): x is MockupRef => !!x && typeof x === 'object' && typeof (x as MockupRef).name === 'string' && typeof (x as MockupRef).version === 'string';

/** The mockup a UI copilot reply made or changed: open it on the UI page, or have the copilot put it in the game. */
function MockupCard({ mockup, channel }: { mockup: MockupRef; channel: string }) {
  const [sent, setSent] = useState(false);
  const versions = mockup.versions?.length ? mockup.versions : [mockup.version];
  const putIn = async () => {
    setSent(true);
    window.shuriken.journal('ui.mockup.apply', { name: mockup.name, version: mockup.version, from: 'chat' });
    await rpc('chat.send', { channel, text: applyMessage(mockup.title, mockup.version), context: { page: 'ui', item: `mockup:${mockup.name}@${mockup.version}` } }).catch(() => setSent(false));
  };
  return (
    <div className="mt-2 flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 ring-1 ring-line">
      <LayoutPanelTop size={14} className="shrink-0 text-accent2" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-text">{mockup.title}</div>
        <div className="text-[11px] text-faint">
          {mockup.applied ? `Version ${mockup.version} is in the game` : `Mockup · version${versions.length === 1 ? '' : 's'} ${versions.join(', ')} · not in the game`}
        </div>
      </div>
      <button onClick={() => navigate('ui', `mockup:${mockup.name}@${mockup.version}`)} className="shrink-0 rounded-lg bg-accent/12 px-2.5 py-1 text-[12px] font-medium text-accent2 ring-1 ring-accent/25 hover:bg-accent/20">
        Open
      </button>
      {!mockup.applied && (
        <button
          disabled={sent}
          onClick={() => void putIn()}
          title={`Build version ${mockup.version} into your game for real`}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-surface3 px-2.5 py-1 text-[12px] text-text ring-1 ring-line2 transition-colors hover:bg-accent/15 hover:ring-accent/40 disabled:opacity-60"
        >
          {sent ? <Check size={12} /> : <Gamepad2 size={12} />} {sent ? 'Asked' : `Put ${mockup.version} in the game`}
        </button>
      )}
    </div>
  );
}

/**
 * Something a copilot's reply made in its dock: open it there, or — while it is a draft — put it in the game
 * (the same call as the page's Add to game; a new take of a game item can replace it).
 */
function DraftCard({ dock, draft, items }: { dock: DraftDock; draft: DraftRef; items: Map<string, { draft: boolean }> | null }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const state = standing(draft, items);
  const add = async (params: { name: string; as?: string }) => {
    setBusy(true);
    setSaid(null);
    window.shuriken.journal('draft.add', { dock, name: params.name, as: params.as ?? null, from: 'chat' });
    try {
      const out = addOutcome(await rpc<{ ok: boolean; text: string; data?: unknown }>(DRAFT_DOCKS[dock].use, params));
      if (out.note) setSaid({ ok: out.ok, text: out.note });
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 rounded-xl bg-white/[0.03] px-3 py-2 ring-1 ring-line">
      <div className="flex items-center gap-2">
        {state === 'in-game' ? <Gamepad2 size={14} className="shrink-0 text-ok" /> : <CircleDashed size={14} className="shrink-0 text-accent2" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] text-text">{draft.name}</div>
          <div className="text-[11px] text-faint">{standingLine(dock, draft, state)}</div>
        </div>
        {state !== 'gone' && (
          <button onClick={() => navigate(dock === 'audio' ? 'audio' : 'animation', draft.name)} className="shrink-0 rounded-lg bg-accent/12 px-2.5 py-1 text-[12px] font-medium text-accent2 ring-1 ring-accent/25 hover:bg-accent/20">
            Open
          </button>
        )}
      </div>
      {state === 'draft' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {draftActions(dock, draft, (n) => items?.get(n)?.draft === false).map((a) => (
            <button
              key={a.label}
              disabled={busy}
              onClick={() => void add(a.params)}
              title={a.title}
              className="flex items-center gap-1 rounded-lg bg-surface3 px-2.5 py-1 text-[12px] text-text ring-1 ring-line2 transition-colors hover:bg-accent/15 hover:ring-accent/40 disabled:opacity-60"
            >
              <Gamepad2 size={12} /> {a.label}
            </button>
          ))}
        </div>
      )}
      {said && <div className={cx('mt-1.5 text-[11px] leading-snug', said.ok ? 'text-faint' : 'text-bad')}>{said.text}</div>}
    </div>
  );
}

/** A dock page with its copilot as a column on the right (when open). */
export function WithCopilot({ dock, open, onClose, children }: { dock: CopilotDock; open: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {open && <CopilotPanel dock={dock} onClose={onClose} className="w-[360px] shrink-0 border-l border-line" />}
    </div>
  );
}

/** The copilot's follow-ups to its last answer, above the box (a click fills the box; nothing is sent). */
function FollowUps({ messages, busy, onPick }: { messages: ChatMessage[]; busy: boolean; onPick: (s: Suggestion) => void }) {
  const last = messages[messages.length - 1];
  const ideas = !busy && last?.role === 'copilot' ? suggestionsOf(last.data?.suggestions, 3) : [];
  if (!ideas.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {ideas.map((s) => (
        <button
          key={s.label}
          onClick={() => onPick(s)}
          title={`${s.prompt}\n\n(Put in the box: you can edit it before sending)`}
          className="no-drag flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-dim ring-1 ring-line transition-colors hover:bg-accent/10 hover:text-text hover:ring-accent/40"
        >
          <Sparkles size={11} className="text-accent2" />
          {s.label}
        </button>
      ))}
    </div>
  );
}
