import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUp, ChevronDown, Gamepad2, RefreshCw, Settings2, Sparkles, Users } from 'lucide-react';
import { FlowBackground } from '../brand/flow-background';
import { ShurikenMark } from '../brand/logo';
import { rpc, useRpc } from '../lib/rpc';
import { navigate } from '../lib/nav';
import { useCurrentProject, useOrchestrator } from '../lib/project';
import { cx } from '../components/ui';
import { openGameDialog } from '../components/open-game';
import { ThemeSwitch } from '../components/theme-switch';
import { EMPTY_ROBLOX, RobloxChoiceFields, robloxChoice, robloxSummary, saveProjectKey, type RobloxDraft } from '../components/roblox-choice';
import type { Suggestion } from '@shared/suggestions';

const HEADLINE = 'What can I make for you today?';

/**
 * The idea being typed survives a visit to Settings (the page unmounts) and a restart. In memory first, so a
 * window without storage keeps it too.
 */
const DRAFT_KEY = 'shuriken.startDraft';
let draftNow: string | null = null;
function readDraft(): string {
  if (draftNow !== null) return draftNow;
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}
function keepDraft(text: string): void {
  draftNow = text;
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: the in-memory draft still survives page changes */
  }
}

/**
 * The first thing you see: a slow, flowing field in the theme's colour, one question, one box. Suggestion bubbles
 * fill the box (you can edit before sending). Sending creates the project and glides into the dashboard.
 */
export function StartPage() {
  const [text, setTextState] = useState(readDraft);
  const setText = (t: string) => {
    setTextState(t);
    keepDraft(t);
  };
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The new game's community or account and its own key (closed: your defaults from Settings).
  const [roblox, setRoblox] = useState<RobloxDraft>(EMPTY_ROBLOX);
  const [showRoblox, setShowRoblox] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // Game ideas written for this user (core director/start-ideas.ts), six at a time.
  const suggestions = useRpc<Suggestion[]>('suggestions.get', { count: 6 }, ['start.ideas']);

  useEffect(() => {
    const t = window.setTimeout(() => box.current?.focus(), 350);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(220, Math.max(56, el.scrollHeight))}px`;
  }, [text]);

  // A project still open in this window ("New game" from it) whose agents are working: starting here stops them, so ask.
  const current = useCurrentProject();
  const orch = useOrchestrator(!!current.data);
  const working = current.data ? (orch.data?.activeRuns ?? 0) : 0;
  const [asking, setAsking] = useState(false);

  const send = async (confirmed = false) => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    const picked = robloxChoice(roblox);
    if (picked.problem) {
      setShowRoblox(true);
      return setError(picked.problem);
    }
    if (working > 0 && !confirmed) return setAsking(true);
    setSending(true);
    setError(null);
    window.shuriken.journal('start.send', { prompt, roblox: roblox.mode, ownKey: !!roblox.key.trim() });
    try {
      const created = await rpc<{ id: string }>('projects.createFromPrompt', { prompt, ...(picked.choice ? { roblox: picked.choice } : {}) });
      // Saved before the team uploads anything (minutes away). If the PC can't encrypt it, Settings shows the default key in use.
      await saveProjectKey(created?.id, roblox.key).catch(() => undefined);
      setRoblox(EMPTY_ROBLOX);
      keepDraft('');
      navigate('dashboard');
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method 'rpc': Error: /, ''));
      setSending(false);
      setAsking(false);
    }
  };

  const pick = (s: Suggestion) => {
    setText(s.prompt);
    window.shuriken.journal('start.suggestion', { label: s.label });
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-black text-white">
      <FlowBackground className="absolute inset-0" />
      {/* Draggable top area (the Projects menu is at the far left of the bar above), settings at right. */}
      <div className="drag overlay-pad absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-end gap-3 pl-4">
        <ThemeSwitch className="rounded-full bg-black/20 px-1.5 py-1 ring-1 ring-white/10 backdrop-blur-md" />
        <button
          onClick={() => navigate('settings')}
          title="Settings"
          className="no-drag flex h-9 w-9 items-center justify-center rounded-xl bg-black/20 text-white/75 ring-1 ring-white/10 backdrop-blur-md transition-colors hover:bg-black/35 hover:text-white"
        >
          <Settings2 size={16} />
        </button>
      </div>

      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 pb-[6vh]">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} className="mb-9 flex items-center gap-2.5 text-white/70">
          <ShurikenMark size={22} />
          <span className="text-[13px] font-medium tracking-[0.18em] uppercase">Shuriken Studio</span>
        </motion.div>

        <h1 className="font-display mb-10 max-w-[18ch] text-center text-[clamp(38px,6.2vw,76px)] leading-[1.02] font-light tracking-[-0.02em] text-balance text-white" aria-label={HEADLINE}>
          <AnimatedHeadline text={HEADLINE} />
        </h1>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[720px]"
        >
          <div className={cx('rounded-[22px] bg-black/35 p-2 ring-1 ring-white/14 backdrop-blur-xl transition-shadow', 'shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)] focus-within:ring-white/30')}>
            <div className="flex items-end gap-2">
              <textarea
                ref={box}
                value={text}
                disabled={sending}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Describe the game you want…"
                className="no-drag min-h-14 flex-1 resize-none bg-transparent px-4 py-4 text-[16px] leading-relaxed text-white outline-none placeholder:text-white/45"
              />
              <button
                onClick={() => void send()}
                disabled={!text.trim() || sending}
                title="Build it"
                className="no-drag mb-1.5 mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-on-accent shadow-[0_8px_24px_-6px_color-mix(in_srgb,var(--color-accent)_90%,transparent)] transition-all hover:scale-105 hover:bg-accent-hover disabled:scale-100 disabled:opacity-35 disabled:shadow-none"
              >
                {sending ? <ShurikenMark size={22} active /> : <ArrowUp size={20} strokeWidth={2.4} />}
              </button>
            </div>
          </div>
          <div className="mt-3 flex justify-center">
            <button
              onClick={() => setShowRoblox((v) => !v)}
              aria-expanded={showRoblox}
              title="Where this game's uploads and store go on Roblox, and its own Open Cloud key"
              className="no-drag flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-white/55 transition-colors hover:bg-white/8 hover:text-white"
            >
              <Users size={13} /> {robloxSummary(roblox)} <ChevronDown size={12} className={cx('transition-transform', showRoblox && 'rotate-180')} />
            </button>
          </div>
          {showRoblox && (
            <div className="mx-auto mt-2 max-w-[600px] rounded-2xl bg-black/45 px-4 py-3 ring-1 ring-white/14 backdrop-blur-xl">
              <RobloxChoiceFields tone="dark" value={roblox} onChange={setRoblox} disabled={sending} />
            </div>
          )}
          {asking && working > 0 && current.data && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-black/45 px-4 py-3 text-[13px] leading-snug text-white/85 ring-1 ring-white/14 backdrop-blur-xl">
              <span className="min-w-[240px] flex-1">
                {sending ? 'Stopping the agents, then starting…' : `${working === 1 ? 'An agent is' : `${working} agents are`} working on “${current.data.name}” in this window. Starting a new game here stops ${working === 1 ? 'it' : 'them'}; the work picks up where it left off when you open “${current.data.name}” again.`}
              </span>
              {!sending && (
                <div className="flex gap-2">
                  <button onClick={() => void send(true)} className="no-drag rounded-xl bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent hover:bg-accent-hover">
                    Start here
                  </button>
                  <button onClick={() => setAsking(false)} className="no-drag rounded-xl bg-white/10 px-3 py-1.5 text-[12.5px] text-white/90 hover:bg-white/15">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
          {error && <div className="mt-3 text-center text-[13px] text-[#ffb4a8]">{error}</div>}

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
            {(suggestions.data ?? []).map((s, i) => (
              <motion.button
                key={s.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.45 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}
                onClick={() => pick(s)}
                title={s.prompt}
                className="no-drag flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-2 text-[13px] text-white/85 ring-1 ring-white/12 backdrop-blur-md transition-all hover:-translate-y-0.5 hover:bg-white/18 hover:text-white"
                style={{ animation: `float-soft ${5 + (i % 3)}s ease-in-out ${i * 0.6}s infinite` }}
              >
                <Sparkles size={13} className="text-accent2" />
                {s.label}
              </motion.button>
            ))}
            {(suggestions.data?.length ?? 0) > 0 && (
              <button
                onClick={() => {
                  window.shuriken.journal('start.moreIdeas', {});
                  void rpc('suggestions.more', { count: 6 }).then(() => suggestions.reload());
                }}
                title="More game ideas"
                className="no-drag flex h-9 w-9 items-center justify-center rounded-full text-white/55 ring-1 ring-white/10 transition-colors hover:bg-white/10 hover:text-white"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.9 }} className="mt-7 flex justify-center">
            <button
              onClick={() => openGameDialog()}
              title="Plug in a game Shuriken didn't build: a place open in Roblox Studio, or a place file"
              className="no-drag flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] text-white/60 transition-colors hover:bg-white/8 hover:text-white"
            >
              <Gamepad2 size={14} /> Or open a game you already have…
            </button>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

/** Letters breathe in weight and softness, staggered — a slow shimmer rather than a flicker. */
function AnimatedHeadline({ text }: { text: string }) {
  return (
    <span className="inline">
      {text.split(' ').map((word, wi) => (
        <span key={wi} className="inline-block whitespace-nowrap">
          {word.split('').map((ch, ci) => (
            <motion.span
              key={ci}
              className="inline-block"
              initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.9, delay: 0.1 + (wi * 4 + ci) * 0.028, ease: [0.22, 1, 0.36, 1] }}
              style={{ animation: `headline-breathe 7s ease-in-out ${(wi * 5 + ci) * 0.18}s infinite` }}
            >
              {ch}
            </motion.span>
          ))}
          {wi < text.split(' ').length - 1 && <span className="inline-block w-[0.28em]" />}
        </span>
      ))}
    </span>
  );
}
