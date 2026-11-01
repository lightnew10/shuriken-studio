import { useEffect, useMemo, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useOverlay } from '../lib/overlays';

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  children,
  onClick,
  kind = 'secondary',
  disabled,
  title,
  size = 'md',
  type = 'button',
  className,
  icon,
}: {
  children?: ReactNode;
  onClick?: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit';
  className?: string;
  icon?: ReactNode;
}) {
  const kinds: Record<ButtonKind, string> = {
    primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-[0_6px_18px_-8px_color-mix(in_srgb,var(--color-accent)_80%,transparent)] font-semibold',
    secondary: 'bg-surface3/80 text-text hover:bg-surface3 border border-line2',
    ghost: 'text-dim hover:text-text hover:bg-white/5',
    danger: 'text-bad hover:bg-bad/10 border border-bad/30',
  };
  const sizes = { sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-lg', md: 'h-9 px-3.5 text-[13px] gap-2 rounded-xl', lg: 'h-11 px-5 text-[14px] gap-2 rounded-xl' };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx('no-drag inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all duration-150 disabled:opacity-40 active:scale-[0.98]', kinds[kind], sizes[size], className)}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ children, onClick, title, active, className, disabled }: { children: ReactNode; onClick?: () => void; title: string; active?: boolean; className?: string; disabled?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'no-drag inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        active ? 'bg-accent/15 text-accent' : 'text-dim hover:bg-white/6 hover:text-text',
        className,
      )}
    >
      {children}
    </button>
  );
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-white/6 text-dim',
  accent: 'bg-accent/15 text-accent2',
  ok: 'bg-ok/12 text-ok',
  warn: 'bg-warn/12 text-warn',
  bad: 'bg-bad/12 text-bad',
  info: 'bg-info/12 text-info',
};

export function Pill({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span className="min-w-0">
        <span className="block text-[13px] text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-snug text-faint">{hint}</span>}
      </span>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface3')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

export const inputClass =
  'no-drag w-full rounded-xl border border-line2 bg-bg2 px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-faint focus:border-accent/60';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-dim">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>}
    </label>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 px-6 py-6 text-center text-[12.5px] leading-relaxed text-faint">
      {icon}
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="rounded-xl border border-bad/30 bg-bad/8 px-3 py-2 text-[12.5px] text-bad">{error}</div>;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string), [text]);
  return <div className={cx('md', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Modal({ open, onClose, title, children, width = 640 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  useOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div
            className="card flex max-h-full w-full flex-col overflow-hidden"
            style={{ maxWidth: width }}
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <div className="text-[14px] font-semibold">{title}</div>
              <IconButton title="Close" onClick={onClose}>
                <X size={16} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="no-drag inline-flex rounded-xl bg-bg2 p-0.5 ring-1 ring-line">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx('relative rounded-[10px] px-3 py-1 text-[12px] transition-colors', value === o.value ? 'text-text' : 'text-faint hover:text-dim')}
        >
          {value === o.value && <motion.span layoutId={`seg-${options.map((x) => x.value).join('')}`} className="absolute inset-0 rounded-[10px] bg-surface3" transition={{ duration: 0.2 }} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
