import { useEffect, useRef, useState } from 'react';
import { ArrowUp, CircleDot, MessageSquare, Settings2, ShieldCheck, Users, Workflow } from 'lucide-react';
import type { CollabChatEntry, CollabDirectorSummary, CollabPendingRequest, CollabPeer, CollabProjectSummary, CollabRunActivity, CollabRunSummary, CollabTaskSummary } from '@shared/collaboration';
import { TopBar } from '../components/topbar';
import { Button, cx } from '../components/ui';
import { navigate } from '../lib/nav';
import { rpc, useRpc } from '../lib/rpc';
import type { ChatMessage } from '@shared/domain';

interface Session {
  role: 'host' | 'guest' | null;
  connection: 'offline' | 'connecting' | 'connected' | 'reconnecting';
  selfId: string | null;
  peers: CollabPeer[];
  hostOnline: boolean;
  guestRequestsEnabled: boolean;
  messages: CollabChatEntry[];
  remoteProject: CollabProjectSummary | null;
  remoteDirector: CollabDirectorSummary[];
  remoteTasks: CollabTaskSummary[];
  remoteRuns: CollabRunSummary[];
  remoteActivity: CollabRunActivity[];
  directorTyping: boolean;
  requests: CollabPendingRequest[];
  error: string | null;
}

/**
 * Guest workspace: a remote view of the host project. There is no local Roblox Studio or
 * writable mirror; guests issue instructions through the host Director's authenticated queue.
 */
export function CollaborationWorkspacePage() {
  const session = useRpc<Session>('collaboration.status', undefined, ['collaboration.changed']);
  const isHost = session.data?.role === 'host';
  const hostHistory = useRpc<ChatMessage[]>(isHost ? 'chat.list' : null, { limit: 60 }, ['chat.message']);
  const [prompt, setPrompt] = useState('');
  const [chat, setChat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const data = session.data;
  const online = data?.connection === 'connected' && (data.role === 'host' || data.hostOnline);
  const canSubmit = online && (isHost || data?.guestRequestsEnabled);
  const director = isHost
    ? (hostHistory.data ?? []).filter((m) => m.channel === 'director' && (m.role === 'director' || m.role === 'system' || m.role === 'user'))
      .map((m) => ({ id: m.id, role: m.role as CollabDirectorSummary['role'], kind: m.kind,
        text: m.text, createdAt: m.createdAt,
        sender: (m.data?.collaboration as { sender?: string } | undefined)?.sender }))
    : data?.remoteDirector ?? [];

  useEffect(() => {
    const element = scroll.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 180)
      element.scrollTop = element.scrollHeight;
  }, [director.length]);

  const submit = async (method: string, value: string, clear: () => void): Promise<void> => {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await rpc(method, { text: value.trim() });
      clear();
      session.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <TopBar title="Collaboration" back />
      {!data?.role ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Users size={30} className="text-faint" strokeWidth={1.5} />
          <div className="text-[16px] font-semibold text-text">No active collaborative session</div>
          <p className="max-w-md text-[12.5px] leading-relaxed text-dim">
            Host a session or join one from Settings. A guest does not need Roblox Studio or a local copy of the host's game.
          </p>
          <Button kind="primary" icon={<Settings2 size={14} />} onClick={() => navigate('settings', 'collaboration')}>Open collaboration settings</Button>
        </div>
      ) : (
        <div className="mx-auto grid min-h-0 w-full max-w-[1500px] flex-1 grid-cols-1 gap-4 overflow-y-auto px-5 py-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="flex min-h-[440px] min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface2/30">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-text">
                  {data.remoteProject?.name ?? (isHost ? 'Host Director' : 'Shared Director')}
                </div>
                <div className="mt-0.5 text-[11px] text-faint">
                  {isHost ? 'Your Director · local project and Roblox Studio' : 'Host Director · read-only state from the host'}
                </div>
              </div>
              <span className={cx('flex shrink-0 items-center gap-1.5 text-[11px]', online ? 'text-ok' : 'text-warn')}>
                <span className={cx('h-1.5 w-1.5 rounded-full', online ? 'bg-ok' : 'bg-warn')} />
                {online ? 'Connected' : data.connection === 'reconnecting' ? 'Reconnecting' : 'Host unavailable'}
              </span>
            </div>
            <div ref={scroll} className="min-h-[250px] flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
              {director.length === 0 && <p className="py-8 text-center text-[12px] text-faint">No Director messages in this project yet.</p>}
              {director.map((message) => (
                <div key={message.id} className={cx('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cx('max-w-[90%] rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed',
                    message.role === 'user' ? 'bg-accent/12 text-text ring-1 ring-accent/20' : 'bg-surface3/60 text-dim')}>
                    <div className="mb-1 flex items-center gap-2 text-[10.5px] font-semibold text-accent2">
                      <span>{message.role === 'user' ? (message.sender ?? 'Host') : message.role === 'director' ? 'Director' : 'System'}</span>
                      <span className="font-normal text-faint">{new Date(message.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="whitespace-pre-wrap break-words">{message.text}</div>
                  </div>
                </div>
              ))}
              {!isHost && data.directorTyping && <div className="text-[11px] text-accent2">Director is responding…</div>}
            </div>
            {(
              <div className="shrink-0 border-t border-line px-3 py-3">
                <div className="mb-2 flex items-center justify-between text-[11px] text-faint">
                  <span>Requests execute on the host PC</span>
                  {!isHost && !data.guestRequestsEnabled && <span className="text-warn">Waiting for host permission</span>}
                </div>
                <div className="flex items-end gap-2">
                  <textarea
                    rows={2} maxLength={2000} value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (canSubmit && prompt.trim() && !busy)
                          void submit('collaboration.submitTask', prompt, () => setPrompt(''));
                      }
                    }}
                    disabled={!canSubmit || busy}
                    placeholder={canSubmit ? 'Describe a change to make in the shared project…' : 'Waiting for host admission'}
                    className="no-drag min-h-12 min-w-0 flex-1 resize-none rounded-lg border border-line2 bg-surface2 px-3 py-2.5 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-accent/45 disabled:opacity-50"
                  />
                  <button
                    className="no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-40"
                    title="Submit shared task"
                    disabled={!canSubmit || !prompt.trim() || busy}
                    onClick={() => void submit('collaboration.submitTask', prompt, () => setPrompt(''))}
                  ><ArrowUp size={16} /></button>
                </div>
                {data.requests.slice(-3).reverse().map((req) => (
                  <div key={req.id} className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px]">
                    <span className="max-w-[80%] truncate text-faint">{req.text}</span>
                    <span className={req.status === 'rejected' ? 'text-bad' : req.status === 'accepted' ? 'text-ok' : 'text-warn'} title={req.reason}>{req.status}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <aside className="flex min-h-0 flex-col gap-3">
            <section className="rounded-xl border border-line bg-surface2/30 px-3.5 py-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-text"><Users size={14} className="text-accent2" /> Participants ({data.peers.length})</div>
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {data.peers.map((peer) => (
                  <div key={peer.id} className="flex items-center gap-2 py-1 text-[11.5px]">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-[11px] text-accent2">{peer.name.slice(0, 1).toUpperCase()}</span>
                    <span className="min-w-0 flex-1 truncate text-text">{peer.name}{peer.id === data.selfId ? ' (you)' : ''}</span>
                    <span className="text-faint">{peer.role}</span>
                  </div>
                ))}
              </div>
              <button className="mt-2 flex items-center gap-1.5 text-[11px] text-accent2 hover:text-text" onClick={() => navigate('settings', 'collaboration')}>
                <Settings2 size={12} /> Session settings
              </button>
            </section>
            <section className="rounded-xl border border-line bg-surface2/30 px-3.5 py-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-text"><Workflow size={14} className="text-accent2" /> Live tasks</div>
              {data.remoteProject?.waiting && <p className="mb-2 text-[11px] text-warn">{data.remoteProject.waiting}</p>}
              <div className="max-h-44 space-y-1.5 overflow-y-auto">
                {(data.remoteTasks ?? []).slice(-12).reverse().map((task) => (
                  <div key={task.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-dim" title={task.title}>{task.title}</span>
                    <span className="shrink-0 text-accent2">{task.status}</span>
                    {task.result && <p className="col-span-2 whitespace-pre-wrap break-words text-faint">{task.result}</p>}
                    {task.blocker && <p className="col-span-2 whitespace-pre-wrap break-words text-warn">{task.blocker}</p>}
                    {task.evidence?.map((item, index) => (
                      <p key={index} className="col-span-2 break-words text-faint">
                        {item.passed === true ? 'Passed' : item.passed === false ? 'Failed' : 'Evidence'} · {item.title}
                      </p>
                    ))}
                  </div>
                ))}
                {!data.remoteTasks?.length && <p className="text-[11px] text-faint">Task state appears here during a shared build.</p>}
              </div>
            </section>
            <section className="rounded-xl border border-line bg-surface2/30 px-3.5 py-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-text"><CircleDot size={14} className="text-accent2" /> Agent activity</div>
              <div className="max-h-32 space-y-1.5 overflow-y-auto">
                {(data.remoteRuns ?? []).slice(-10).reverse().map((run) => (
                  <div key={run.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-dim" title={[run.role, run.provider, run.model].filter(Boolean).join(' · ')}>
                      {[run.role, run.provider, run.model].filter(Boolean).join(' · ')}
                    </span>
                    <span className={run.status === 'failed' ? 'text-bad' : run.status === 'completed' ? 'text-ok' : 'text-faint'}>
                      {run.status === 'running' ? data.remoteActivity.find((a) => a.runId === run.id)?.kind ?? 'running' : run.status}
                    </span>
                  </div>
                ))}
                {!data.remoteRuns?.length && <p className="text-[11px] text-faint">No live agent runs yet.</p>}
              </div>
            </section>
            <section className="flex min-h-[190px] flex-1 flex-col rounded-xl border border-line bg-surface2/30 px-3.5 py-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-text"><MessageSquare size={14} className="text-accent2" /> Session chat</div>
              <div className="max-h-32 min-h-12 flex-1 space-y-2 overflow-y-auto">
                {data.messages.slice(-30).map((m) => (
                  <div key={m.id} className="text-[11.5px]">
                    <span className="mr-2 font-semibold text-accent2">{m.sender}</span>
                    <span className="break-words text-dim">{m.text}</span>
                    {canSubmit && /^\[(Claude|Codex) contribution\] /.test(m.text) && <Button size="sm" disabled={busy} onClick={() => setPrompt(m.text)}>Use as task brief</Button>}
                  </div>
                ))}
                {!data.messages.length && <p className="text-[11px] text-faint">Discuss with the participants.</p>}
              </div>
              <div className="mt-2 flex items-end gap-1.5">
                <input className="no-drag min-w-0 flex-1 rounded-lg border border-line2 bg-surface2 px-2 py-1.5 text-[11.5px] text-text outline-none focus:border-accent/45"
                  maxLength={2000} value={chat} placeholder="Message to participants"
                  disabled={!online || busy} onChange={(e) => setChat(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && chat.trim() && online && !busy)
                    void submit('collaboration.sendChat', chat, () => setChat('')); }} />
                <button className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent disabled:opacity-40"
                  disabled={!online || !chat.trim() || busy} title="Send session message"
                  onClick={() => void submit('collaboration.sendChat', chat, () => setChat(''))}><ArrowUp size={13} /></button>
              </div>
            </section>
            {error && <p role="alert" className="text-[11px] text-bad">{error}</p>}
            {data.error && <p className="text-[11px] text-warn">{data.error}</p>}
            <div className="flex items-start gap-1.5 px-1 text-[10.5px] leading-relaxed text-faint">
              <ShieldCheck size={13} className="mt-0.5 shrink-0" />
              Host-only Studio and file changes. No guest credentials are sent through the session chat.
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
