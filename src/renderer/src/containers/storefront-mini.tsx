import { CloudUpload, ImageIcon, Store, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import { navigate } from '../lib/nav';
import { useRpc } from '../lib/rpc';
import type { StorefrontView } from '../lib/storefront';
import { cx } from '../components/ui';

function Line({ icon, label, text, tone, onClick }: { icon: ReactNode; label: string; text: string; tone?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={`${label}: ${text}`} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] hover:bg-white/4">
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="w-14 shrink-0 text-faint">{label}</span>
      <span className={cx('min-w-0 flex-1 truncate', tone ?? 'text-dim')}>{text}</span>
    </button>
  );
}

/**
 * The Storefront at a glance: what the store has and what isn't on Roblox yet, the thumbnails and the pick, the
 * title. Each line opens its tab of the Storefront page. Hidden from the dashboard when monetization and copy are off.
 */
export function StorefrontMini({ expanded = false }: { expanded?: boolean }) {
  const sf = useRpc<StorefrontView>('storefront.get', {}, ['storefront.changed']);
  const v = sf.data;
  if (!v) return <div className="flex h-full items-center justify-center text-[12px] text-faint">{sf.error ?? 'Loading…'}</div>;
  const items = v.catalog?.items ?? [];
  const thumbs = v.art?.thumbs.length ?? 0;
  return (
    <div className={cx('h-full space-y-0.5 overflow-y-auto px-2.5 py-2', expanded && 'mx-auto max-w-xl px-6 py-5')}>
      {v.prefs.monetization && (
        <Line
          icon={v.pending.length ? <CloudUpload size={12} /> : <Store size={12} />}
          label="Store"
          text={items.length ? `${items.length} item${items.length === 1 ? '' : 's'}${v.pending.length ? ` · ${v.pending.length} not on Roblox` : ' · all on Roblox'}` : 'Nothing designed yet'}
          tone={items.length && !v.pending.length ? 'text-ok' : undefined}
          onClick={() => navigate('storefront', 'store')}
        />
      )}
      <Line icon={<ImageIcon size={12} />} label="Pictures" text={thumbs ? `${thumbs} thumbnail${thumbs === 1 ? '' : 's'}${v.art?.pick ? ` · pick: ${v.art.pick.winner}` : ''}` : 'None yet'} onClick={() => navigate('storefront', 'pictures')} />
      {v.prefs.copy && <Line icon={<Type size={12} />} label="Title" text={v.copy?.title || 'Not written yet'} tone={v.copy?.title ? 'text-text' : undefined} onClick={() => navigate('storefront', 'copy')} />}
    </div>
  );
}
