import { useEffect, useState, type FormEvent } from 'react';
import { Button, ErrorNote, Field, Toggle, inputClass } from '../components/ui';
import { useCurrentProject } from '../lib/project';
import { rpc, useRpc } from '../lib/rpc';

type Service = 'groq' | 'openrouter';
type Tier = 'fast' | 'balanced' | 'deep';
type Key = { id: string; provider: Service; label: string; enabled: boolean; state: string; retryAt: number | null; models: Array<{ id: string; tools: boolean; images: boolean }> };
type FreeStatus = { enabled: boolean; keys: Key[]; models: Record<Service, Record<Tier, string>> };
type Quota = { provider: 'claude' | 'codex'; model: string; maximum: number | null; used: number; resetAt: number };
const services: Service[] = ['groq', 'openrouter'];
const tiers: Tier[] = ['fast', 'balanced', 'deep'];
const label = { groq: 'Groq', openrouter: 'OpenRouter' };

export function AiRoutingSettings() {
  const project = useCurrentProject();
  const quotas = useRpc<Quota[]>('providers.modelQuotas', undefined, ['run.updated', 'accounts.changed']);
  const status = useRpc<FreeStatus>('providers.free.status', undefined, ['run.updated']);
  const consent = useRpc<{ settings: { freeApiProviders?: Service[] } }>(project.data ? 'project.settings' : null, undefined, [], [project.data?.id]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [service, setService] = useState<Service>('openrouter');
  const refreshQuotas = quotas.reload;
  const refreshStatus = status.reload;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      refreshQuotas();
      refreshStatus();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshQuotas, refreshStatus]);
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); status.reload(); quotas.reload(); consent.reload(); }
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const key = String(fields.get('key') ?? '').trim();
    const name = String(fields.get('label') ?? '').trim();
    const id = crypto.randomUUID();
    void act(async () => {
      if (!key || key.length > 4096) throw new Error('Enter a valid API key');
      await window.shuriken.secrets.set(`ai-free:${id}`, key);
      try { await rpc('providers.free.add', { id, provider: service, label: name, freeDeclared: fields.get('free') === 'on' }); }
      catch (e) { await window.shuriken.secrets.delete(`ai-free:${id}`); throw e; }
      form.reset();
    });
  };

  return (
    <>
      <section className="card space-y-3 px-4 py-4">
        <h3 className="font-medium text-text">Daily model quotas</h3>
        <p className="text-xs text-dim">Counts launches and resumptions across projects and accounts on this PC. Resets at local midnight. Leave the limit blank for unlimited launches.</p>
        {quotas.data?.map((quota) => (
          <form key={`${quota.provider}:${quota.model}:${quota.maximum}`} className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get('maximum');
            void act(() => rpc('providers.setModelQuota', { provider: quota.provider, model: quota.model, maximum: value === '' ? null : Number(value) }));
          }}>
            <div className="min-w-44 flex-1">
              <div className="text-sm text-text">{quota.provider === 'claude' ? 'Claude' : 'Codex'} · {quota.model}</div>
              <div className="text-xs text-dim">{quota.used} used today · resets {new Date(quota.resetAt).toLocaleString()}</div>
            </div>
            <input aria-label={`Daily launch limit for ${quota.model}`} name="maximum" type="number" min={0} step={1} defaultValue={quota.maximum ?? ''} placeholder="Unlimited" className={`${inputClass} max-w-28`} />
            <Button type="submit" size="sm" disabled={busy}>Save</Button>
          </form>
        ))}
        <ErrorNote error={quotas.error} />
      </section>

      <section className="card space-y-3 px-4 py-4">
        <h3 className="font-medium text-text">Free API fallback</h3>
        <Toggle label="Switch from a subscription to free APIs" checked={status.data?.enabled === true} disabled={busy || !status.data} onChange={(enabled) => void act(() => rpc('providers.free.setFallback', { enabled }))} />
        {project.data && services.map((provider) => (
          <Toggle key={provider} label={`Allow ${label[provider]} for this project`} checked={consent.data?.settings.freeApiProviders?.includes(provider) === true} disabled={busy || !consent.data}
            hint="This provider can receive project context, files and tool results during a fallback."
            onChange={(allowed) => void act(() => rpc('providers.free.setConsent', { provider, allowed }))} />
        ))}
        {!project.data && <p className="text-xs text-dim">Open a project to choose which services may receive its context.</p>}

        <form className="space-y-2 border-t border-line pt-3" onSubmit={add}>
          <Field label="Service">
            <select aria-label="API service" className={inputClass} value={service} onChange={(event) => setService(event.target.value as Service)}>
              {services.map((id) => <option key={id} value={id}>{label[id]}</option>)}
            </select>
          </Field>
          <Field label="Key name"><input aria-label="Key name" name="label" maxLength={80} required className={inputClass} /></Field>
          <Field label="API key"><input aria-label="API key" name="key" type="password" autoComplete="off" maxLength={4096} required className={inputClass} /></Field>
          {service === 'groq' && <label className="flex gap-2 text-xs text-dim"><input type="checkbox" name="free" required /> I confirm this Groq key is on the Free Tier.</label>}
          <Button type="submit" size="sm" disabled={busy}>Add encrypted key</Button>
        </form>

        {status.data?.keys.map((key, index, keys) => (
          <form key={`${key.id}:${key.label}`} className="space-y-2 border-t border-line pt-3" onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get('label') ?? '');
            void act(() => rpc('providers.free.update', { id: key.id, patch: { label: name } }));
          }}>
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label={`Name of ${key.label}`} name="label" className={`${inputClass} max-w-52`} maxLength={80} required defaultValue={key.label} />
              <span className="text-xs text-dim">{label[key.provider]} · {key.state}{key.provider === 'groq' && ' · Free Tier declared by user'}</span>
              {key.retryAt && <span className="text-xs text-dim">Next try {new Date(key.retryAt).toLocaleString()}</span>}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button type="submit" size="sm" disabled={busy}>Rename</Button>
              <Button size="sm" disabled={busy} onClick={() => void act(() => rpc('providers.free.check', { id: key.id }))}>Verify key</Button>
              <Button size="sm" disabled={busy} onClick={() => void act(() => rpc('providers.free.update', { id: key.id, patch: { enabled: !key.enabled } }))}>{key.enabled ? 'Disable' : 'Enable'}</Button>
              <Button size="sm" disabled={busy || index === 0} onClick={() => void act(() => rpc('providers.free.update', { id: key.id, patch: { move: -1 } }))}>Move up</Button>
              <Button size="sm" disabled={busy || index === keys.length - 1} onClick={() => void act(() => rpc('providers.free.update', { id: key.id, patch: { move: 1 } }))}>Move down</Button>
              <Button size="sm" disabled={busy} onClick={() => void act(async () => {
                await window.shuriken.secrets.delete(`ai-free:${key.id}`);
                await rpc('providers.free.remove', { id: key.id });
              })}>Remove</Button>
            </div>
          </form>
        ))}
        {services.map((provider) => {
          const models = new Map(status.data?.keys.filter((key) => key.provider === provider && key.state === 'ready').flatMap((key) => key.models.map((model) => [model.id, model] as const)));
          return models.size > 0 && <div key={provider} className="grid gap-2 sm:grid-cols-3">
            {tiers.map((tier) => {
              const selected = status.data?.models[provider][tier] ?? '';
              return <Field key={tier} label={`${label[provider]} · ${tier}`}>
                <select className={inputClass} aria-label={`${label[provider]} ${tier} model`} disabled={busy} value={selected}
                  onChange={(event) => { const model = event.target.value; void act(() => rpc('providers.free.setModel', { provider, tier, model })); }}>
                  <option value="">Select a model</option>
                  {selected && !models.has(selected) && <option value={selected} disabled>{selected} · unavailable</option>}
                  {[...models.values()].map((model) => <option key={model.id} value={model.id}>{model.id}{model.images ? ' · images' : ''}</option>)}
                </select>
              </Field>;
            })}
          </div>;
        })}
        <ErrorNote error={error ?? status.error ?? consent.error} />
      </section>
    </>
  );
}
