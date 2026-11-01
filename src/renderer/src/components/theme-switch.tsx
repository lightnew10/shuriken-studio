import { THEMES, setTheme, useTheme } from '../lib/appearance';
import { cx } from './ui';

/** The colour themes as two small swatches; the choice applies to every window at once. */
export function ThemeSwitch({ className, labels = false }: { className?: string; labels?: boolean }) {
  const theme = useTheme();
  return (
    <div role="radiogroup" aria-label="Colour theme" className={cx('flex items-center gap-1.5', className)}>
      {THEMES.map((t) => {
        const on = t.id === theme;
        return (
          <button
            key={t.id}
            role="radio"
            aria-checked={on}
            onClick={() => {
              setTheme(t.id);
              window.shuriken.journal('theme.set', { theme: t.id });
            }}
            title={`${t.label} theme`}
            className={cx('no-drag flex items-center gap-2 rounded-full transition-all', labels ? 'px-2.5 py-1.5 ring-1' : 'p-0.5', labels && (on ? 'bg-white/8 ring-white/30' : 'ring-transparent hover:bg-white/5'))}
          >
            <span
              className={cx('block h-[18px] w-[18px] rounded-full ring-2 transition-transform', on ? 'scale-110 ring-white/80' : 'ring-white/15 hover:scale-105')}
              style={{ background: `linear-gradient(135deg, ${t.swatch[0]}, ${t.swatch[1]})` }}
            />
            {labels && <span className={cx('text-[12.5px]', on ? 'text-text' : 'text-dim')}>{t.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
