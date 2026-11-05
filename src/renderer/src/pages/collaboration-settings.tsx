import { useEffect, useState } from 'react';
import { Check, Copy, Globe2, LogOut, MessageSquare, Radio, RefreshCw, Users } from 'lucide-react';
import { Button, ErrorNote, Field, Pill, cx, inputClass } from '../components/ui';
import { rpc, useRpc } from '../lib/rpc';

type Peer = { id: string; name: string; role: 'host' | 'guest' };
type Message = { id: string; from: string; sender: string; text: string; at: string };
type RemoteTask = { id: string; title: string; role: string; status: string; updatedAt: string };
type RemoteDirectorMessage = { id: string; role: 'user' | 'director' | 'system'; kind: string; text: string; createdAt: string };
interface CollaborationStatus {
  connection: 'offline' | 'connecting' | 'connected' | 'reconnecting';
  role: 'host' | 'guest' | null;
  relay: string;
  name: string;
  invitation: string | null;
  peers: Peer[];
  selfId: string | null;
  messages: Message[];
  reconnectSeconds: number | null;
  remoteProject: { name: string; projectId: string | null; taskCount: number } | null;
  remoteTasks: RemoteTask[];
  remoteDirector: RemoteDirectorMessage[];
  hostOnline: boolean;
  error: string | null;
  remoteAgentsEnabled: false;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mb-9 space-y-3">
      <h2 className="text-[17px] font-semibold text-text">{title}</h2>
      {description && <p className="text-[13px] leading-relaxed text-dim">{description}</p>}
      {children}
    </section>
  );
}

/** C1: explicit self-hosting, invitation, session presence and human discussion. */
export function CollaborationSettings() {
  const session = useRpc<CollaborationStatus>('collaboration.status', undefined, ['collaboration.changed']);
  const [relay, setRelay] = useState('');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (session.data) setRelay(session.data.relay); }, [session.data?.relay]);
  useEffect(() => { if (session.data) setName(session.data.name); }, [session.data?.name]);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await work(); session.reload(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const connected = session.data?.connection === 'connected';
  const active = !!session.data?.role;
  const hostname = session.data?.role === 'host';
  const online = session.data?.connection === 'connected' &&
    (session.data.role === 'host' || session.data.hostOnline);
  const label = online ? 'Connected' : session.data?.connection === 'reconnecting' ? 'Reconnecting' :
    session.data?.connection === 'connecting' ? 'Connecting' : 'Offline';
  const invitation = session.data?.invitation ?? '';

  async function saveAndHost(): Promise<void> {
    await rpc('collaboration.configure', { relay, name });
    await rpc('collaboration.host');
  }
  async function join(): Promise<void> {
    // The invitation itself chooses the host's relay, so guests do not need their own Cloudflare account.
    const origin = new URL(invite.trim()).origin;
    await rpc('collaboration.configure', { relay: origin, name });
    await rpc('collaboration.join', { invitation: invite.trim() });
  }
  const send = () => void run(async () => {
    await rpc('collaboration.sendChat', { text: message });
    setMessage('');
  });
  const copy = () => void run(async () => {
    await navigator.clipboard.writeText(invitation);
    setCopied(true);
  });

  return (
    <>
      <Section title="Collaboration" description="Host one private session or join a friend's Shuriken over the Internet. Both PCs keep their own AI credentials. This first milestone synchronizes human messages and presence; shared AI execution, project files and Roblox Studio control are not yet enabled.">
        <div className="card space-y-4 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] text-text">
              <Radio size={16} className={online ? 'text-ok' : 'text-faint'} />
              {label}
            </div>
            {active && <Pill tone={connected ? 'ok' : 'neutral'}>{hostname ? 'Host' : 'Guest'}</Pill>}
          </div>
          {session.data?.role === 'guest' && !session.data.hostOnline && session.data.connection === 'connected' && (
            <p className="text-[12px] text-warn">The host is offline. You are still in the room, but new messages and agent operations must wait for reconnection.</p>
          )}
          {session.data?.connection === 'reconnecting' && (
            <p className="text-[12px] text-warn">The relay connection was lost. Reconnecting for up to 10 minutes. Remote work is unavailable until connected.</p>
          )}
          {session.data?.error && <p role="status" className="text-[12px] text-warn">{session.data.error}</p>}
          <p className="text-[11.5px] text-warn">Session messages and visible Director/task text currently transit over TLS, but are not yet end-to-end encrypted: the relay operator could inspect them. Never include secrets or private account information.</p>
          <Field label="Your display name">
            <input className={inputClass} placeholder="Displayed to collaborators" value={name} maxLength={48} disabled={active || busy} onChange={(e) => setName(e.target.value)} />
          </Field>
          {!active && (
            <>
              <Field label="Your Cloudflare relay URL (hosts only)" hint="Deploy the optional relay to your Cloudflare account once. Guests only need the invitation.">
                <input className={inputClass} placeholder="https://shuriken-collaboration-relay.example.workers.dev" value={relay} disabled={busy} onChange={(e) => setRelay(e.target.value)} />
              </Field>
              <Button kind="primary" disabled={busy || !relay.trim() || !name.trim()} icon={<Globe2 size={14} />}
                onClick={() => void run(saveAndHost)}>Host a session</Button>
              <div className="border-t border-line pt-4">
                <Field label="Join an existing session" hint="Paste a private invite link from another Shuriken. Do not share the link publicly.">
                  <input className={inputClass} placeholder="https://.../room/...#join=..." value={invite} disabled={busy} onChange={(e) => setInvite(e.target.value)} />
                </Field>
                <div className="mt-3">
                  <Button disabled={busy || !name.trim() || !invite.trim()} icon={<Users size={14} />}
                    onClick={() => void run(join)}>Join session</Button>
                </div>
              </div>
            </>
          )}
          {active && (
            <>
              {hostname && (
                <div className="space-y-2">
                  <Field label="Private invitation link" hint="Share only with people you trust. Anyone holding this link can join until you end the session.">
                    <input className={inputClass} value={invitation} readOnly onFocus={(e) => e.target.select()} />
                  </Field>
                  <Button size="sm" kind="ghost" disabled={busy || !invitation} icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy}>
                    {copied ? 'Copied' : 'Copy invitation'}
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[13px] text-text"><Users size={15} /> Participants ({session.data?.peers.length ?? 0})</div>
                {(session.data?.peers ?? []).map((peer) => (
                  <div key={peer.id} className="flex items-center justify-between border-b border-line/40 py-1.5 text-[12.5px]">
                    <span className="truncate text-dim">{peer.name}{peer.id === session.data?.selfId ? ' (you)' : ''}</span>
                    <span className="text-faint">{peer.role}</span>
                  </div>
                ))}
                {!session.data?.peers.length && <p className="text-[12px] text-faint">Waiting for the relay connection.</p>}
              </div>
              {session.data?.remoteProject && (
                <p className="text-[12px] text-dim">Host project: {session.data.remoteProject.name} · {session.data.remoteProject.taskCount} tasks</p>
              )}
              <Button kind="ghost" icon={<LogOut size={14} />} onClick={() => void run(() => rpc('collaboration.leave'))}>
                {hostname ? 'End session for everyone' : 'Leave session immediately'}
              </Button>
            </>
          )}
          <ErrorNote error={error || session.error} />
        </div>
      </Section>
      {active && (
        <Section title="Shared session chat" description="These are human-to-human messages, not prompts sent to the Director. ChatGPT / Claude quotas are not consumed by this chat. The host retains a bounded in-memory history; Cloudflare does not store the messages.">
          <div className="card space-y-3 px-4 py-4">
            <div className="max-h-80 min-h-32 space-y-2 overflow-y-auto">
              {!session.data?.messages.length && <p className="py-4 text-center text-[12px] text-faint">No messages yet. Participants can chat when connected.</p>}
              {(session.data?.messages ?? []).map((m) => (
                <div key={m.id} className="rounded-md bg-surface2 px-3 py-2">
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className={cx('font-semibold', m.from === session.data?.selfId ? 'text-accent2' : 'text-text')}>{m.sender}</span>
                    <span className="text-faint">{new Date(m.at).toLocaleTimeString()}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-[13px] text-dim">{m.text}</div>
                </div>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <textarea rows={2} className={cx(inputClass, 'min-w-0 flex-1')} maxLength={2000} placeholder="Message to participants..." value={message}
                disabled={!online || busy} onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (online && message.trim()) send(); } }} />
              <Button kind="primary" icon={<MessageSquare size={14} />} disabled={!online || busy || !message.trim()} onClick={send}>Send</Button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-faint">10-minute recovery window · voluntary leave is immediate</span>
              <Button kind="ghost" size="sm" icon={<RefreshCw size={12} />} onClick={() => session.reload()}>Refresh</Button>
            </div>
          </div>
        </Section>
      )}
      {session.data?.role === 'guest' && (
        <Section title="Host project activity (read-only)" description="The host shares its visible Director messages and task statuses. You cannot modify the host's game or execute remote agents in this milestone.">
          <div className="card space-y-4 px-4 py-4">
            <div>
              <div className="mb-2 text-[12px] font-semibold text-text">Recent Director messages</div>
              <div className="max-h-60 space-y-2 overflow-y-auto">
                {(session.data.remoteDirector ?? []).slice(-30).map((msg) => (
                  <div key={msg.id} className="rounded-md bg-surface2 px-3 py-2">
                    <div className="text-[11px] font-semibold text-accent2">{msg.role === 'user' ? 'Host' : msg.role}</div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-dim">{msg.text}</div>
                  </div>
                ))}
                {!session.data.remoteDirector?.length && <p className="text-[12px] text-faint">Waiting for the host's project snapshot.</p>}
              </div>
            </div>
            <div className="border-t border-line pt-3">
              <div className="mb-2 text-[12px] font-semibold text-text">Shared task statuses ({session.data.remoteTasks?.length ?? 0} shown)</div>
              <div className="max-h-60 space-y-1 overflow-y-auto">
                {(session.data.remoteTasks ?? []).slice(-40).map((task) => (
                  <div key={task.id} className="flex items-center gap-2 border-b border-line/30 py-1.5 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-dim" title={task.title}>{task.title}</span>
                    <span className="shrink-0 text-faint">{task.role}</span>
                    <span className="shrink-0 text-accent2">{task.status}</span>
                  </div>
                ))}
                {!session.data.remoteTasks?.length && <p className="text-[12px] text-faint">No task state received yet.</p>}
              </div>
            </div>
          </div>
        </Section>
      )}
      <Section title="Distributed AI and shared project" description="Planned next: shared Director history, host-approved file patches, guest workers, owner-controlled Claude/Codex execution and guarded quota routing. None of these permissions is granted by joining a C1 session.">
        <div className="card px-4 py-4 text-[12px] leading-relaxed text-dim">
          Invitations permit guests to read shared human chat and read-only Director/task updates; do not include secrets in that conversation. Each ChatGPT or Claude sign-in stays on its owner's PC. The host never receives account tokens. Automatic delegation of personal subscriptions to other users is not enabled; provider account terms and explicit consent must be addressed first.
          <p className="mt-3 text-faint">Deployment instructions: collaboration/relay/README.md · Plan: docs/COLLABORATION_PLAN.md</p>
        </div>
      </Section>
    </>
  );
}
