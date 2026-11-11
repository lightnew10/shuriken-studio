import { useState } from 'react';
import { Button, ErrorNote, Field, Toggle, inputClass } from '../components/ui';
import { rpc, useRpc } from '../lib/rpc';

type Provider = 'groq' | 'openrouter';
type Key = { id: string; label: string; provider: Provider; ready: boolean; maximum: number | null };
type Offer = Key & { owner: 'local' | 'peer'; maximum: number; used: number; retryAt: number | null; models: Record<string, { id: string } | null> };
type Pool = { localKeys: Key[]; offers: Offer[]; allowed: Provider[]; effects: Array<{ id: string; tool: string; task_id: string; state: string }> };
const names = { groq: 'Groq', openrouter: 'OpenRouter' };

export function CollaborationPool({ host }: { host: boolean }) {
  const pool = useRpc<Pool>('collaboration.pool', undefined, ['collaboration.changed', 'run.updated']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'Claude' | 'Codex'>('Claude');
  const [contribution, setContribution] = useState('');
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await action(); pool.reload(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <section className="card space-y-4 px-4 py-4">
    <h2 className="text-[17px] font-semibold text-text">Shared API pool</h2>
    <p className="text-xs text-dim">The owner's app uses the key and its daily allowance. Both participants use the host's priority order.</p>
    {host && (['groq', 'openrouter'] as const).map((provider) => <Toggle key={provider} label={`Allow ${names[provider]} to receive project context`}
      checked={pool.data?.allowed.includes(provider) === true} disabled={busy}
      onChange={(allowed) => void act(async () => { await rpc('providers.free.setConsent', { provider, allowed }); })} />)}
    {pool.data?.localKeys.map((key) => <form key={`${key.id}:${key.maximum}`} className="flex flex-wrap items-center gap-2 border-t border-line pt-2" onSubmit={(event) => {
      event.preventDefault();
      const maximum = Number(new FormData(event.currentTarget).get('maximum'));
      void act(() => rpc('collaboration.shareKey', { keyId: key.id, maximum }));
    }}>
      <span className="flex-1 text-sm">{key.label} · {names[key.provider]}</span>
      <input className={`${inputClass} max-w-32`} aria-label={`Daily shared requests for ${key.label}`} name="maximum" type="number" min={1} max={10000} required defaultValue={key.maximum ?? 10} />
      <Button type="submit" size="sm" disabled={busy || !key.ready}>{key.maximum ? 'Update limit' : 'Contribute key'}</Button>
      {key.maximum && <Button size="sm" disabled={busy} onClick={() => void act(() => rpc('collaboration.shareKey', { keyId: key.id, maximum: null }))}>Withdraw</Button>}
    </form>)}
    {!pool.data?.localKeys.length && <p className="text-xs text-dim">Add and verify a key and choose its models in AI accounts.</p>}
    {pool.data?.offers.map((offer, index, offers) => <div key={offer.id} className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{offer.label} · {offer.owner === 'local' ? 'You' : 'Collaborator'} · {offer.used}/{offer.maximum} requests</div>
        <div className="text-xs text-dim">{Object.values(offer.models).flatMap((model) => model ? [model.id] : []).filter((model, i, all) => all.indexOf(model) === i).join(' · ') || 'No model selected'}</div>
        <div className="text-xs text-dim">{offer.retryAt ? `Retry at ${new Date(offer.retryAt).toLocaleTimeString()}` : offer.ready ? 'Available' : 'Unavailable'}</div>
      </div>
      {host && <>
        <Button size="sm" disabled={busy || index === 0} onClick={() => void act(() => rpc('collaboration.moveKey', { id: offer.id, direction: -1 }))}>Move up</Button>
        <Button size="sm" disabled={busy || index === offers.length - 1} onClick={() => void act(() => rpc('collaboration.moveKey', { id: offer.id, direction: 1 }))}>Move down</Button>
      </>}
    </div>)}
    {host && pool.data?.effects.map((effect) => <div key={effect.id} className="space-y-2 rounded-lg border border-warn/50 p-3">
      <p className="text-sm">Verify the previous {effect.tool} effect in the project before continuing.</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void act(() => rpc('collaboration.verifyEffect', { id: effect.id, applied: true }))}>Confirmed applied</Button>
        <Button size="sm" disabled={busy} onClick={() => void act(() => rpc('collaboration.verifyEffect', { id: effect.id, applied: false }))}>Confirmed absent</Button>
      </div>
    </div>)}
    <form className="space-y-2 border-t border-line pt-3" onSubmit={(event) => {
      event.preventDefault();
      void act(async () => { await rpc('collaboration.shareContribution', { source, text: contribution }); setContribution(''); });
    }}>
      <Field label="Share a contribution from your own client">
        <select aria-label="Contribution source" className={inputClass} value={source} onChange={(event) => setSource(event.target.value as 'Claude' | 'Codex')}>
          <option>Claude</option><option>Codex</option>
        </select>
      </Field>
      <textarea aria-label="Contribution" placeholder="Paste the result you chose to share" className={inputClass} value={contribution} maxLength={1850} onChange={(event) => setContribution(event.target.value)} />
      <Button type="submit" size="sm" disabled={busy || !contribution.trim()}>Share contribution</Button>
    </form>
    <ErrorNote error={error ?? pool.error} />
  </section>;
}
