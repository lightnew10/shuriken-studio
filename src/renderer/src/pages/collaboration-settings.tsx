import { useEffect, useState } from 'react';
import { Check, Copy, Globe2, LogOut, MessageSquare, Radio, RefreshCw, Users } from 'lucide-react';
import { Button, ErrorNote, Field, Pill, cx, inputClass } from '../components/ui';
import { rpc, useRpc } from '../lib/rpc';

type Peer = { id: string; name: string; role: 'host' | 'guest' };
type Message = { id: string; from: string; sender: string; text: string; at: string };
type RemoteTask = { id: string; title: string; role: string; status: string; updatedAt: string };
type RemoteDirectorMessage = { id: string; role: 'user' | 'director' | 'system'; kind: string; text: string; createdAt: string; sender?: string };
type RemoteRun = { id: string; taskId: string | null; role: string; status: string; startedAt: string; endedAt: string | null };
type RemoteActivity = { runId: string; taskId: string | null; kind: string; at: string };
type GuestRequest = { id: string; text: string; status: 'pending' | 'accepted' | 'rejected'; at: string; reason?: string };
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
  remoteRuns: RemoteRun[];
  remoteActivity: RemoteActivity[];
  directorTyping: boolean;
  requests: GuestRequest[];
  guestRequestsEnabled: boolean;
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
  const [requestText, setRequestText] = useState('');
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
  const requestDirector = () => void run(async () => {
    await rpc('collaboration.requestDirector', { text: requestText });
    setRequestText('');
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
              {hostname && (
                <div className="space-y-2 rounded-lg border border-line bg-surface2/45 px-3 py-3">
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent"
                      checked={session.data?.guestRequestsEnabled === true}
                      disabled={busy}
                      onChange={(e) => void run(() => rpc('collaboration.setGuestRequests', { enabled: e.target.checked }))}
                    />
                    <span className="text-[12px] text-text">Allow trusted guests to ask the Director to modify this project</span>
                  </label>
                  <p className="text-[11.5px] leading-relaxed text-faint">
                    Off by default. Enabling lets invited participants start host-side agents automatically;
                    existing host permissions still apply. Do not enable for untrusted invitees:
                    they can initiate AI work, consume the host's authorized quota and influence game files.
                    This permission can be switched off at any time.
                  </p>
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
        <Section title="Ask the host Director" description="The host's agents execute permitted Roblox, Luau, GUI, VFX and 3D work on the host PC. You only send the instruction; live results appear below.">
          <div className="card space-y-3 px-4 py-4">
            {!session.data.guestRequestsEnabled && (
              <p className="text-[12px] text-warn">
                Guest requests are disabled. The host must enable them once in Settings → Collaboration.
              </p>
            )}
            <textarea rows={3} className={cx(inputClass, 'w-full')} maxLength={2000}
              placeholder="What should the Director create or modify in the host's Roblox game?"
              value={requestText}
              disabled={!online || !session.data.guestRequestsEnabled || busy}
              onChange={(e) => setRequestText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (online && session.data?.guestRequestsEnabled && requestText.trim() && !busy) requestDirector();
              } }} />
            <Button kind="primary" disabled={!online || !session.data.guestRequestsEnabled || !requestText.trim() || busy}
              onClick={requestDirector}>Send to host Director</Button>
            {(session.data.requests ?? []).length > 0 && (
              <div className="space-y-1 border-t border-line pt-2">
                <div className="text-[11px] font-semibold text-faint">Your latest requests</div>
                {session.data.requests.slice(-6).reverse().map((request) => (
                  <div key={request.id} className="flex items-start justify-between gap-3 text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate text-dim" title={request.text}>{request.text}</span>
                    <span className={request.status === 'rejected' ? 'text-bad' : request.status === 'accepted' ? 'text-ok' : 'text-warn'}
                      title={request.reason ?? request.status}>{request.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}
      {session.data?.role === 'guest' && (
        <Section title="Host Director and agent activity" description="Authoritative updates from the host project. Guest requests are executed by host agents, never by accessing Roblox Studio directly from your PC.">
          <div className="card space-y-4 px-4 py-4">
            <div>
              <div className="mb-2 text-[12px] font-semibold text-text">Recent Director messages</div>
              <div className="max-h-60 space-y-2 overflow-y-auto">
                {(session.data.remoteDirector ?? []).slice(-30).map((msg) => (
                  <div key={msg.id} className="rounded-md bg-surface2 px-3 py-2">
                    <div className="text-[11px] font-semibold text-accent2">{msg.role === 'user' ? (msg.sender ?? 'Host') : msg.role}</div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-dim">{msg.text}</div>
                  </div>
                ))}
                {session.data.directorTyping && <p className="text-[12px] text-accent2">Director is responding…</p>}
                {!session.data.remoteDirector?.length && !session.data.directorTyping && <p className="text-[12px] text-faint">Waiting for the host's project snapshot.</p>}
              </div>
            </div>
            <div className="border-t border-line pt-3">
              <div className="mb-2 text-[12px] font-semibold text-text">Agent runs ({session.data.remoteRuns?.length ?? 0})</div>
              <div className="max-h-36 space-y-1 overflow-y-auto">
                {(session.data.remoteRuns ?? []).slice(-20).reverse().map((run) => (
                  <div key={run.id} className="flex items-center justify-between gap-2 py-1 text-[12px]">
                    <span className="truncate text-dim">{run.role}
                      {run.status === 'running' && session.data?.remoteActivity?.find((activity) => activity.runId === run.id) &&
                        <span className="ml-2 text-[10.5px] text-faint">· {session.data.remoteActivity.find((activity) => activity.runId === run.id)?.kind.replace(/-/g, ' ')}</span>}
                    </span>
                    <span className={run.status === 'failed' ? 'text-bad' : run.status === 'completed' ? 'text-ok' : 'text-faint'}>{run.status}</span>
                  </div>
                ))}
                {!session.data.remoteRuns?.length && <p className="text-[11.5px] text-faint">No agent runs yet.</p>}
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
      <Section title="Host-side collaboration and AI providers" description="Trusted guest requests now enter the host Director, and host task/agent states synchronize back to guests. Host-only Roblox execution does not require a second Studio. Provider account pooling and production-level permissions remain separate implementation milestones.">
        <div className="card px-4 py-4 text-[12px] leading-relaxed text-dim">
          Trusted guest instructions now reach the host Director when the host authorizes the session; only the host's local tools can change Roblox Studio. Existing host-side permission policies still govern tool execution, so invite only trusted collaborators. Models generated on the host require no transfer.  Option B is the target: agents and Roblox edits run on the host PC. The account catalog will accept owner-authorized subscriptions and API keys from host or guests, where each provider supports the execution model. OpenAI now documents an official open-source Sign in with ChatGPT flow for eligible plan-powered requests; Claude's consumer login has different, stricter integration rules. No guest credential pooling is enabled yet. Never paste API keys or login tokens into the session chat. The owner must explicitly approve any credential provisioning onto the host machine, which may be able to access those credentials.
          <p className="mt-3 text-faint">Deployment instructions: collaboration/relay/README.md · Plan: docs/COLLABORATION_PLAN.md</p>
        </div>
      </Section>
    </>
  );
}
