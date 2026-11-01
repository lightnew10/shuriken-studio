import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, ArrowUp, BookOpen, CheckCircle2, CircleDashed, CircleX, Clock3, PartyPopper, RefreshCw, Sparkles } from 'lucide-react';
import type { ChatMessage, Task } from '@shared/domain';
import { suggestionsOf, type Suggestion } from '@shared/suggestions';
import { rpc, useCoreEvent, useRpc } from '../lib/rpc';
import { useCurrentProject, useOrchestrator, useTasks } from '../lib/project';
import { navigate, type Page } from '../lib/nav';
import { useRoleLabels } from '../lib/roles';
import { ShurikenMark } from '../brand/logo';
import { Markdown, Modal, cx, timeAgo } from '../components/ui';
import { referenceFiles } from '../lib/references';


/**
 * Unsent text per project. The panel unmounts whenever another page opens, so a draft kept only in
 * component state was lost on the way to the Animation page and back; it lives here (and in local
 * storage, across restarts) until it is sent.
 */
const drafts = new Map<string, string>();
const draftStorageKey = (projectId: string) => `shuriken.chatDraft.${projectId}`;
function loadDraft(projectId: string): string {
  if (drafts.has(projectId)) return drafts.get(projectId)!;
  try {
    return localStorage.getItem(draftStorageKey(projectId)) ?? '';
  } catch {
    return '';
  }
}
/** Puts text in the director chat's box for a project (another page's "ask the team" goes through here). */
export function setChatDraft(projectId: string, text: string): void {
  saveDraft(projectId, text);
}

function saveDraft(projectId: string, text: string): void {
  drafts.set(projectId, text);
  try {
    if (text) localStorage.setItem(draftStorageKey(projectId), text);
    else localStorage.removeItem(draftStorageKey(projectId));
  } catch {
    /* storage unavailable: the in-memory draft still survives page changes */
  }
}

/** The conversation with the director: requests in, plans, questions and milestones out. */
/** Messages a long build keeps in the chat window (older ones stay in the project; housekeeping archives old status lines). */
const CHAT_KEEP = 400;

export function ChatPanel({ className }: { className?: string }) {
  const history = useRpc<ChatMessage[]>('chat.list', { limit: 300 }, ['project.changed']);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const project = useCurrentProject();
  const projectId = project.data?.id ?? null;
  const [text, setTextState] = useState(() => (projectId ? loadDraft(projectId) : ''));
  const draftFor = useRef<string | null>(projectId);
  const setText = (t: string) => {
    setTextState(t);
    if (draftFor.current) saveDraft(draftFor.current, t);
  };
  // The project becomes known (or changes): show its draft, keeping anything typed before it loaded.
  useEffect(() => {
    if (!projectId || draftFor.current === projectId) return;
    const first = draftFor.current === null;
    draftFor.current = projectId;
    setTextState((typed) => {
      // Text typed before the project loaded belongs to it; another project's draft does not.
      if (first && typed) {
        saveDraft(projectId, typed);
        return typed;
      }
      return loadDraft(projectId);
    });
  }, [projectId]);
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const tasks = useTasks();
  // The conversation follows new messages only while the user is at its end: scrolled up to read, it stays put.
  const atEnd = useRef(true);
  const lastTop = useRef(0);
  const toEnd = useCallback((smooth: boolean) => {
    const el = list.current;
    if (!el) return;
    // A glide for a message or two; a long way (the history arriving) is a jump.
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 1.5;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !far ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => setMessages(history.data ?? []), [history.data]);
  useCoreEvent(['chat.message'], (_c, p) => {
    const m = p as ChatMessage;
    // The copilots' conversations are theirs (their docks show them).
    if ((m.channel ?? 'director') !== 'director') return;
    setMessages((cur) => {
      const i = cur.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        const next = cur.slice();
        next[i] = m;
        return next;
      }
      // At most the newest CHAT_KEEP in the window on a long build (the history loads the newest 300 to begin with).
      return [...cur, m].slice(-CHAT_KEEP);
    });
  });
  useCoreEvent(['chat.typing'], (_c, p) => {
    const e = p as { typing: boolean; channel?: string };
    if (!e.channel || e.channel === 'director') setTyping(e.typing);
  });

  useEffect(() => {
    if (atEnd.current) toEnd(true);
  }, [messages.length, typing, toEnd]);
  // At the end it stays at the end while the panel or its messages change size (a narrower window, a message
  // growing in place).
  useEffect(() => {
    const el = list.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (atEnd.current) toEnd(false);
    });
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [toEnd]);
  // A game plugged in (not built here): no "describe your game" prompts, and its study to read.
  const game = useRpc<{ adopted: { place: string; studiedAt?: string | null } | null; studying: boolean; brief: string | null } | null>('games.dossier', {}, ['project.changed']);
  const adopted = !!game.data?.adopted;
  const [readStudy, setReadStudy] = useState(false);

  const placeholder = adopted ? 'Ask for a change to your game, or ask about it…' : tasks.data?.some((t) => t.kind === 'objective') === false ? 'Tell me about the game you want to make…' : "Ask for a change, or ask how it's going…";
  // The box fits its text, or its placeholder while empty, and again whenever its width changes (a narrow window
  // wraps the placeholder onto a second line).
  const fitBox = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '0px';
    let h = el.scrollHeight;
    if (!el.value && el.placeholder) {
      el.value = el.placeholder;
      h = Math.max(h, el.scrollHeight);
      el.value = '';
    }
    el.style.height = `${Math.min(160, Math.max(40, h))}px`;
  }, []);
  useLayoutEffect(fitBox, [text, placeholder, fitBox]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitBox();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitBox]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setText('');
    // What the user just said, and the answer to it, come into view.
    atEnd.current = true;
    try {
      await rpc('chat.send', { text: t });
    } catch (e) {
      setText(t);
      window.shuriken.journal('error', { message: `chat.send failed: ${(e as Error).message}` });
    } finally {
      setSending(false);
    }
  };

  const byObjective = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks.data ?? []) {
      if (!t.parentId || t.kind === 'plan' || t.status === 'proposed') continue;
      const arr = m.get(t.parentId) ?? [];
      arr.push(t);
      m.set(t.parentId, arr);
    }
    return m;
  }, [tasks.data]);

  return (
    <div
      className={cx('flex h-full min-h-0 flex-col', className)}
      // A video or a picture dropped here becomes a reference (studied, then read by the team); the core says so in the chat.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const { paths } = referenceFiles([...e.dataTransfer.files], (f) => window.shuriken.pathForFile(f));
        if (paths.length) void rpc('references.add', { paths, from: 'chat' }).catch(() => undefined);
      }}
    >
      {adopted && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-[12px] text-dim">
          <BookOpen size={13} className="shrink-0 text-accent2" />
          <span className="min-w-0 flex-1 truncate">
            {game.data?.studying ? 'Reading your game…' : game.data?.adopted?.studiedAt ? `Your game, as the team understands it · studied ${timeAgo(game.data.adopted.studiedAt)}` : 'Your game hasn’t been studied yet'}
          </span>
          {game.data?.brief && (
            <button onClick={() => setReadStudy(true)} className="no-drag rounded-md px-1.5 py-0.5 text-accent2 hover:bg-accent/10">
              Read
            </button>
          )}
          <button
            onClick={() => void rpc('games.study').then(() => game.reload())}
            disabled={game.data?.studying}
            title="Read the game again (after changes made in Studio)"
            className="no-drag flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-white/5 hover:text-text disabled:opacity-40"
          >
            <RefreshCw size={11} /> Study again
          </button>
        </div>
      )}
      {/* The dashboard's grid moves its containers with transforms: the dialog lives on the page itself. */}
      {createPortal(
        <Modal open={readStudy} onClose={() => setReadStudy(false)} title="Your game, as the team understands it" width={760}>
          <Markdown text={game.data?.brief ?? ''} className="text-[13px] leading-relaxed text-text" />
        </Modal>,
        document.body,
      )}
      <div
        ref={list}
        onScroll={(e) => {
          // Only the user scrolls up (following glides down): that is what stops the following.
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) atEnd.current = true;
          else if (el.scrollTop < lastTop.current) atEnd.current = false;
          lastTop.current = el.scrollTop;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div ref={content} className="space-y-3">
          {messages.length === 0 && !typing && <div className="pt-8 text-center text-[12.5px] text-faint">Tell the director what to build or change.</div>}
          {messages.map((m) => (
            <Message key={m.id} m={m} tasks={byObjective.get(String(m.data?.objectiveId ?? '')) ?? []} />
          ))}
          <AnimatePresence>
            {typing && (
              <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2 text-[12px] text-faint">
                <ShurikenMark size={16} active /> Director is thinking…
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div className="border-t border-line p-3">
        <ChatSuggestions
          tasks={tasks.data ?? []}
          messages={messages}
          adopted={adopted}
          onPick={(s) => {
            setText(s.prompt);
            window.shuriken.journal('chat.suggestion', { label: s.label });
            requestAnimationFrame(() => {
              const el = box.current;
              if (!el) return;
              el.focus();
              el.setSelectionRange(el.value.length, el.value.length);
            });
          }}
        />
        <div className="flex items-end gap-2 rounded-2xl bg-bg2 p-1.5 ring-1 ring-line2 transition-shadow focus-within:ring-accent/50">
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="no-drag min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2.5 text-[13.5px] leading-snug text-text outline-none placeholder:text-faint"
          />
          <button
            onClick={() => void send()}
            disabled={!text.trim() || sending}
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

/** The director chat's bubbles: what they show, and the fuller request each puts in the box. */
const ASK = {
  goodWeak: {
    label: 'What is this game good at, and what is weak?',
    prompt: "Read through this game and tell me honestly what it's good at and what's weak: gameplay, code quality, UI, performance and polish. Finish with the three improvements that would matter most and how big each one is.",
  },
  exploits: {
    label: 'Find bugs and exploits in the code',
    prompt: "Go through this game's scripts and find bugs and exploits: remotes the client can abuse, missing server checks, race conditions, leaks and errors in the output. List each one with where it is and how bad it is before changing anything.",
  },
  feel: {
    label: 'Make it feel better to play',
    prompt: 'Make this game feel better to play without changing how it works: tighter controls and camera, feedback on every action (sounds, effects, UI), smoother transitions, and fixes for anything that feels clunky.',
  },
  kinds: {
    label: 'What kinds of games can you make?',
    prompt: "What kinds of Roblox games can you make? Give me a few examples across genres, what you're strongest at, and what a first version would include.",
  },
  shape: {
    label: 'Help me shape my game idea',
    prompt: "Help me shape my game idea: ask me a few quick questions about the genre, the core loop, the style and who it's for, then propose a clear first version.",
  },
  obby: {
    label: 'A cartoony obby with a speedrun timer',
    prompt: 'Make a cartoony obby: 20 colourful stages that ramp up in difficulty (jumps, moving platforms, spinners, conveyor belts), a checkpoint on every stage, a speedrun timer with a personal best, a stage counter on the HUD and a celebration at the finish.',
  },
  wrong: {
    label: 'What went wrong, and do I need to do anything?',
    prompt: 'What went wrong? For each failed, stuck or blocked task: what happened, the likely cause, whether the team is already fixing it, and whether anything needs me (a decision, something in Studio, a setting). Keep it short.',
  },
  resume: { label: 'Resume the work', prompt: 'Resume the work.' },
  agents: {
    label: 'What is each agent doing right now?',
    prompt: "What is each agent doing right now? One line per agent: its task, what it's doing at this moment, how far along it is, and what comes next.",
  },
  changed: {
    label: 'What changed in the last 5 minutes?',
    prompt: 'What changed in the last 5 minutes? What was built, added or fixed and where it is in the game, what finished, and anything that failed.',
  },
  estimate: {
    label: 'Estimate the time to a minimum viable game',
    prompt: "How long until a minimum viable game? List what's still missing for a playable first version, roughly how long each part takes with the agents running now, and what could slow it down.",
  },
  plan: {
    label: 'Walk me through the plan',
    prompt: "Walk me through the plan: the goal, the tasks in order with who does each and why, what waits on what, and what I'll be able to play at each milestone.",
  },
  map: {
    label: 'How does the map look right now?',
    prompt: 'How does the map look right now? Look at it in Studio and tell me honestly: the layout, the style and lighting, what looks finished, and what still looks rough, empty or out of place.',
  },
  polish: {
    label: 'Make the map more polished and detailed',
    prompt: 'Polish the map: add detail and set dressing where it looks empty or blocky, vary shapes and materials so nothing repeats, improve the lighting and atmosphere, and keep the part count low so it runs well on phones.',
  },
  gameFeel: {
    label: 'Add more game feel',
    prompt: 'Add more game feel: an effect and a sound on every hit, pickup and important action, screen shake and hit-stop on heavy impacts, UI that pops when numbers change, footsteps and landing dust, all tuned to feel satisfying without getting noisy.',
  },
  next: {
    label: 'What should we add next?',
    prompt: 'What should we add next? Suggest the three changes that would make the game most fun or keep players coming back, why each one matters, and roughly how long each takes.',
  },
} satisfies Record<string, Suggestion>;

/**
 * Suggested questions and requests above the composer, picked from what is going on (problems first,
 * then what the team is doing, then ideas for the next step). Clicking one fills the box; it is never
 * sent on its own.
 */
function ChatSuggestions({ tasks, messages, onPick, adopted }: { tasks: Task[]; messages: ChatMessage[]; onPick: (s: Suggestion) => void; adopted?: boolean }) {
  const orch = useOrchestrator();
  // Ideas written for this game (its names, what it has, what the user has been asking for).
  const live = useRpc<Suggestion[] | null>('suggestions.live', { scope: 'director' }, ['suggestions.changed', 'project.changed']);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 150_000);
    return () => window.clearInterval(t);
  }, []);
  const picks = useMemo(() => {
    const work = tasks.filter((t) => t.kind !== 'objective' && t.kind !== 'plan' && t.kind !== 'research');
    const done = work.filter((t) => t.status === 'done').length;
    const trouble = work.some((t) => t.status === 'failed' || t.status === 'escalated') || messages.some((m) => m.kind === 'question' && !m.data?.resolved);
    const state = orch.data;
    // What the user sent already (a bubble counts as sent when its label or its prompt was).
    const sentBy = (last?: number) => {
      const texts = messages.filter((m) => m.role === 'user').map((m) => m.text.trim().toLowerCase());
      const set = new Set(last ? texts.slice(-last) : texts);
      return (s: Suggestion) => !set.has(s.label.toLowerCase()) && !set.has(s.prompt.toLowerCase());
    };
    // About this game: the director's last reply's follow-ups, then the ones written for the game.
    const lastReply = [...messages].reverse().find((m) => m.role === 'director' && m.kind === 'text');
    const seenLabels = new Set<string>();
    const ideas = [...suggestionsOf(lastReply?.data?.suggestions, 3), ...(live.data ?? [])].filter((s) => {
      const k = s.label.toLowerCase();
      return seenLabels.has(k) ? false : (seenLabels.add(k), true);
    });
    // A plugged-in game with nothing asked yet: what its study suggested, or ways into it.
    if (adopted && !tasks.some((t) => t.kind === 'objective')) {
      const study = [...messages].reverse().find((m) => m.role === 'director' && m.data?.study === true);
      return [...suggestionsOf(study?.data?.suggestions, 4), ...ideas, ASK.goodWeak, ASK.exploits, ASK.feel].filter(sentBy()).slice(0, 3);
    }
    // Nothing started yet (a project opened blank): ideas for starting, not questions about progress.
    if (!tasks.some((t) => t.kind === 'objective')) return (ideas.length ? ideas : [ASK.kinds, ASK.shape, ASK.obby]).filter(sentBy()).slice(0, 3);
    const primary: Suggestion[] = [];
    if (trouble) primary.push(ASK.wrong);
    if (state?.paused) primary.push(ASK.resume);
    if ((state?.activeRuns ?? 0) > 0) primary.push(ASK.agents);
    const rest: Suggestion[] = [ASK.changed, ASK.estimate];
    if (work.length > 0 && done === 0) rest.push(ASK.plan);
    if (done > 0) rest.push(ASK.map, ASK.polish, ASK.gameFeel, ASK.next);
    if (work.length > 0 && done === work.length) rest.unshift(ASK.next);
    const fresh = sentBy(4);
    const out = primary.filter(fresh).slice(0, 2);
    // Ideas about this game come first; the general questions only fill in when there are none.
    for (const s of ideas.filter(fresh)) if (out.length < 3) out.push(s);
    const pool = [...new Set(rest)].filter((s) => fresh(s) && !out.includes(s));
    const offset = pool.length ? (tick + messages.length) % pool.length : 0;
    for (let i = 0; out.length < 3 && i < pool.length; i++) out.push(pool[(offset + i) % pool.length]!);
    return out;
  }, [tasks, messages, orch.data, tick, adopted, live.data]);
  if (!picks.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      <AnimatePresence initial={false} mode="popLayout">
        {picks.map((s) => (
          <motion.button
            key={s.label}
            layout
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => onPick(s)}
            title={`${s.prompt}\n\n(Put in the box: you can edit it before sending)`}
            className="no-drag flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-dim ring-1 ring-line transition-colors hover:bg-accent/10 hover:text-text hover:ring-accent/40"
          >
            <Sparkles size={11} className="text-accent2" />
            {s.label}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

const Message = memo(function Message({ m, tasks }: { m: ChatMessage; tasks: Task[] }) {
  if (m.role === 'user') {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-accent/16 px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-text ring-1 ring-accent/25">{m.text}</div>
      </motion.div>
    );
  }
  if (m.data?.digest === true) return <ProgressDigest m={m} />;
  if (m.kind === 'status' || m.role === 'system') {
    // What a look read, and the technical words behind a plain line, are folded away: the line is what is said.
    const detail = m.data?.look ? (Array.isArray(m.data.trail) && m.data.trail.length ? (m.data.trail as string[]).join('\n') : null) : typeof m.data?.technical === 'string' ? m.data.technical : null;
    return (
      <div className={cx('text-center text-[11.5px]', m.kind === 'error' ? 'text-bad' : 'text-faint')}>
        {m.text}
        {detail && <FoldedDetail label={m.data?.look ? 'What I looked at' : 'Details'} text={detail} />}
      </div>
    );
  }
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5">
      <div className="mt-0.5 shrink-0">
        <ShurikenMark size={20} active={m.kind === 'plan' && m.data?.status === 'planning'} />
      </div>
      <div className="min-w-0 flex-1">
        {m.kind === 'plan' ? (
          <PlanCard m={m} tasks={tasks} />
        ) : m.kind === 'question' ? (
          <QuestionCard m={m} />
        ) : m.kind === 'done' ? (
          Number(m.data?.failing ?? 0) > 0 ? (
            // Built, but with checks set aside as still failing: not a celebration.
            <div className="rounded-2xl bg-warn/8 px-3.5 py-3 ring-1 ring-warn/30">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-warn">
                <CircleX size={14} /> Built, with checks still failing
              </div>
              <Markdown text={m.text} className="text-[13.5px] text-text" />
            </div>
          ) : (
            <div className="rounded-2xl bg-ok/8 px-3.5 py-3 ring-1 ring-ok/25">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-ok">
                <PartyPopper size={14} /> Milestone complete
              </div>
              <Markdown text={m.text} className="text-[13.5px] text-text" />
            </div>
          )
        ) : (
          <div className={cx('text-[13.5px] leading-relaxed', m.kind === 'error' ? 'text-bad' : 'text-text')}>
            <Markdown text={m.text} />
            {m.kind === 'error' && typeof m.data?.technical === 'string' && <FoldedDetail label="Details" text={m.data.technical} />}
            {Array.isArray(m.data?.links) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(m.data.links as Array<{ page: Page; item?: string; label: string }>).map((l, i) => (
                  <button
                    key={i}
                    onClick={() => navigate(l.page, l.item)}
                    className="flex items-center gap-1 rounded-full bg-accent/12 px-2.5 py-1 text-[12px] font-medium text-accent2 ring-1 ring-accent/25 hover:bg-accent/20"
                  >
                    {l.label} <ArrowRight size={12} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
});

/** A folded technical detail under a plain line: there for whoever wants it, out of the way otherwise. */
function FoldedDetail({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-0.5">
      <button onClick={() => setOpen((o) => !o)} className="no-drag text-[11px] text-faint underline decoration-dotted underline-offset-2 hover:text-dim">
        {open ? `Hide ${label.toLowerCase()}` : label}
      </button>
      {open && <div className="mx-auto mt-1 max-w-[92%] text-left text-[11px] leading-snug whitespace-pre-wrap text-dim">{text}</div>}
    </div>
  );
}

const DIGEST_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-ok" />,
  again: <RefreshCw size={12} className="mt-0.5 shrink-0 text-warn" />,
  triage: <CircleDashed size={12} className="mt-0.5 shrink-0 text-faint" />,
};

/** Finished tasks, send-backs and triage outcomes of a few minutes, as one compact message updated in place. */
function ProgressDigest({ m }: { m: ChatMessage }) {
  const items = (Array.isArray(m.data?.items) ? m.data.items : []) as Array<{ kind: string; text: string; taskId?: string }>;
  const done = items.filter((i) => i.kind === 'done').length;
  return (
    <div className="mx-auto max-w-[92%] rounded-xl bg-white/[0.02] px-3 py-2 ring-1 ring-line">
      <div className="mb-1 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">
        Progress{done ? ` · ${done} done` : ''}
      </div>
      <div className="space-y-0.5">
        {items.map((i, n) => (
          <button key={`${i.taskId ?? 'x'}-${n}`} disabled={!i.taskId} onClick={() => i.taskId && navigate('agents', `task:${i.taskId}`)} className="no-drag flex w-full items-start gap-1.5 text-left text-[11.5px] leading-snug text-dim enabled:hover:text-text">
            {DIGEST_ICON[i.kind] ?? DIGEST_ICON.triage}
            <span className="min-w-0 flex-1">{i.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 size={14} className="text-ok" />,
  verified: <CheckCircle2 size={14} className="text-ok" />,
  failed: <CircleX size={14} className="text-bad" />,
  escalated: <CircleX size={14} className="text-warn" />,
  blocked: <CircleX size={14} className="text-warn" />,
  cancelled: <CircleX size={14} className="text-faint" />,
  ready: <CircleDashed size={14} className="text-faint" />,
};

/** The heading of a plan card for each way its planning run can stand. */
const PLAN_HEADING: Record<string, string> = { planning: 'Planning', paused: 'Planning paused', failed: 'Planning stopped', cancelled: 'Plan update cancelled', ended: 'Planning ended' };

function PlanCard({ m, tasks }: { m: ChatMessage; tasks: Task[] }) {
  const roleLabel = useRoleLabels();
  const status = String(m.data?.status ?? '');
  const planning = status === 'planning';
  // A card shows its own planning run's tasks: the ones it added, or (while it plans) the goal's tasks made since it
  // started. It used to show every task of the goal, plans asked for hours later included.
  const own = Array.isArray(m.data?.taskIds) ? new Set(m.data.taskIds as string[]) : null;
  const mine = own ? tasks.filter((t) => own.has(t.id)) : planning && m.data?.planTaskId ? tasks.filter((t) => t.createdAt >= m.createdAt) : PLAN_HEADING[status] && !m.data?.iteration ? [] : tasks;
  const visible = mine.filter((t) => t.status !== 'cancelled');
  const done = visible.filter((t) => t.status === 'done' || t.status === 'verified').length;
  return (
    <div className="card overflow-hidden">
      <div className="px-3.5 pt-3 pb-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold tracking-[0.12em] text-accent2 uppercase">{PLAN_HEADING[status] ?? (m.data?.iteration ? 'Quick change' : 'The plan')}</span>
          {visible.length > 0 && (
            <span className="tabular text-[11px] text-faint">
              {done}/{visible.length} done
            </span>
          )}
        </div>
        <Markdown text={m.text} className="text-[13px] text-dim" />
      </div>
      {visible.length > 0 && (
        <div className="h-1 bg-bg2">
          <motion.div className="h-full bg-gradient-to-r from-accent to-accent2" initial={false} animate={{ width: `${(done / Math.max(1, visible.length)) * 100}%` }} transition={{ duration: 0.6 }} />
        </div>
      )}
      <div className="divide-y divide-line/60">
        {visible.map((t) => {
          const working = ['running', 'implemented', 'verifying', 'reviewing'].includes(t.status);
          return (
            <button key={t.id} onClick={() => navigate('agents', `task:${t.id}`)} className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-white/3">
              <span className="flex w-4 justify-center">{working ? <ShurikenMark size={14} active /> : (STATUS_ICON[t.status] ?? <Clock3 size={14} className="text-faint" />)}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">{t.title}</span>
              <span className="shrink-0 text-[11px] text-faint">{roleLabel(t.role)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function QuestionCard({ m }: { m: ChatMessage }) {
  const resolved = !!m.data?.resolved;
  const dismissed = !!m.data?.dismissed;
  const options = (m.data?.options as string[] | undefined) ?? [];
  // The buttons say what happens in plain words; the answer sent is still the option itself.
  const labels = Array.isArray(m.data?.labels) && m.data.labels.length === options.length ? (m.data.labels as string[]) : options;
  const technical = typeof m.data?.technical === 'string' ? m.data.technical : null;
  const [busy, setBusy] = useState<string | null>(null);
  // Every card can be cleared, a card with no buttons too (it could never be answered before 1.15.8).
  const dismiss = async () => {
    setBusy('dismiss');
    try {
      await rpc('escalations.resolve', { id: m.data?.escalationId, status: 'dismissed' });
    } finally {
      setBusy(null);
    }
  };
  const answer = async (o: string) => {
    setBusy(o);
    try {
      await rpc('chat.answer', { escalationId: m.data?.escalationId, response: o });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={cx('rounded-2xl px-3.5 py-3 ring-1', resolved ? 'bg-surface2 ring-line' : 'bg-warn/8 ring-warn/30')}>
      <div className="mb-1 text-[11px] font-semibold tracking-[0.12em] text-warn uppercase">{dismissed ? 'Closed' : resolved ? 'Answered' : 'Needs you'}</div>
      <Markdown text={m.text} className="text-[13px] text-text" />
      {!resolved && options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {options.map((o, i) => (
            <button key={o} disabled={!!busy} onClick={() => void answer(o)} className="rounded-lg bg-surface3 px-3 py-1.5 text-[12.5px] text-text ring-1 ring-line2 transition-colors hover:bg-accent/15 hover:ring-accent/40 disabled:opacity-50">
              {busy === o ? '…' : labels[i]}
            </button>
          ))}
        </div>
      )}
      {!resolved && (
        <div className="mt-2 flex justify-end">
          <button disabled={!!busy} onClick={() => void dismiss()} title="Close this card without answering it" className="rounded-lg px-2 py-1 text-[11.5px] text-faint transition-colors hover:bg-white/5 hover:text-dim disabled:opacity-50">
            {busy === 'dismiss' ? '…' : 'Dismiss'}
          </button>
        </div>
      )}
      {resolved && m.data?.response ? <div className="mt-1.5 text-[12px] text-faint">{dismissed ? String(m.data.response) : <>You chose “{String(labels[options.indexOf(String(m.data.response))] ?? m.data.response)}”.</>}</div> : null}
      {technical && (
        <div className="text-left">
          <FoldedDetail label="Details for the team" text={technical} />
        </div>
      )}
    </div>
  );
}
