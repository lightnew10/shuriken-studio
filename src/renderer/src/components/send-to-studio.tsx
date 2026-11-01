import { useEffect, useState } from 'react';
import { MonitorUp } from 'lucide-react';
import { rpc } from '../lib/rpc';
import { Button } from './ui';

/**
 * One-click "Send to Studio" for a dock: calls the RPC (which puts the thing into the open place where
 * Studio's camera looks and selects it) and says what happened underneath.
 */
export function SendToStudio({ method, params, label = 'Send to Studio', title }: { method: string; params: Record<string, unknown>; label?: string; title?: string }) {
  const [state, setState] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
  const key = JSON.stringify(params);
  useEffect(() => setState({ busy: false }), [key]);
  const go = async () => {
    setState({ busy: true });
    try {
      const r = (await rpc(method, params)) as { ok?: boolean; error?: string; note?: string; text?: string } | null;
      if (r && r.ok === false) setState({ busy: false, ok: false, text: r.error ?? 'It could not be sent.' });
      else setState({ busy: false, ok: true, text: r?.note ?? r?.text ?? 'Sent.' });
    } catch (e) {
      setState({ busy: false, ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Button size="sm" kind="primary" icon={<MonitorUp size={13} />} disabled={state.busy} onClick={() => void go()} title={title ?? 'Put it in the open Studio place, where Studio’s camera is looking'}>
        {state.busy ? 'Sending…' : label}
      </Button>
      {state.text && <div className={state.ok ? 'max-w-[260px] text-[11.5px] leading-snug text-faint' : 'max-w-[260px] text-[11.5px] leading-snug text-bad'}>{state.text}</div>}
    </div>
  );
}
