import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { SecureChannel, makeGreeting, pairSecret, verifyGreeting } from '../src/core/collaboration/secure-channel';
import { EffectJournal } from '../src/core/collaboration/effect-journal';
import { Store } from '../src/core/db/store';
import { PROJECT_MIGRATIONS } from '../src/core/db/schema';
import { Core } from '../src/core/core';
import { FakeProvider } from './helpers/fake-provider';
import { waitFor } from './helpers/make-core';

it('authenticates the pairing and rejects tampered, replayed and out-of-order payloads', () => {
  const key = pairSecret(), guest = pairSecret(), host = pairSecret(), identity = randomUUID();
  const welcome = makeGreeting(key, 'room', identity, guest, host);
  expect(verifyGreeting(key, 'room', welcome)).toEqual(welcome);
  expect(verifyGreeting(key, 'different-room', welcome)).toBeNull();
  const a = new SecureChannel(key, 'room', guest, host, 'host');
  const b = new SecureChannel(key, 'room', guest, host, 'guest');
  const first = a.seal({ confidential: 'sample Luau' });
  const second = a.seal({ another: 2 });
  expect(first).not.toContain('sample Luau');
  expect(() => b.open(second)).toThrow();
  expect(() => b.open(first.replace(/^(1\.)(.)/, (_s, prefix, ch) => prefix + (ch === 'a' ? 'b' : 'a')))).toThrow();
  expect(b.open(first)).toEqual({ confidential: 'sample Luau' });
  expect(() => b.open(first)).toThrow();
  expect(b.open(second)).toEqual({ another: 2 });
});

it('recovers a confirmed effect and holds an uncertain mutation until the host verifies it', async () => {
  const db = new Store(':memory:', PROJECT_MIGRATIONS);
  try {
    const signal = new AbortController().signal;
    const write = vi.fn(async () => ({ text: 'written', error: false }));
    const journal = new EffectJournal(db);
    await journal.apply('task', 'run1', 'write', { path: 'x', content: 'y' }, signal, write);
    await new EffectJournal(db).apply('task', 'run2', 'write', { content: 'y', path: 'x' }, signal, write);
    expect(write).toHaveBeenCalledTimes(1);
    await expect(journal.apply('task', 'run2', 'unsafe', {}, signal, async () => { throw new Error('disconnected'); })).rejects.toThrow('disconnected');
    expect(await journal.apply('task', 'run3', 'another', {}, signal, write)).toMatchObject({ error: true });
    journal.verify(journal.outstanding()[0]!.id, false);
    await journal.apply('task', 'run3', 'another', {}, signal, write);
    expect(write).toHaveBeenCalledTimes(2);
  } finally { db.close(); }
});

/** Exercise the production Worker against its storage and socket interface without deploying Cloudflare. */
async function relay() {
  const built = await build({
    entryPoints: [resolve('collaboration/relay/src/index.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'worker-fixture', setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class DurableObject { constructor(ctx) { this.ctx = ctx; } }' }));
    } }],
  });
  const exported = { exports: {} as { CollabRoom: new (ctx: unknown) => { webSocketMessage(ws: unknown, data: string): Promise<void>; webSocketClose(ws: unknown): Promise<void> } } };
  new Function('module', 'exports', built.outputFiles[0]!.text)(exported, exported.exports);
  const { CollabRoom } = exported.exports;
  const storage = new Map<string, unknown>();
  const frames: string[] = [];
  const sockets: LocalSocket[] = [];
  const held: Array<() => void> = [];
  let partitioned = false;
  let instance: InstanceType<typeof CollabRoom>;
  const clone = (x: unknown) => structuredClone(x);
  const store = {
    get: async (key: string) => clone(storage.get(key)),
    put: async (key: string, value: unknown) => { storage.set(key, clone(value)); },
    delete: async (key: string | string[]) => { for (const k of typeof key === 'string' ? [key] : key) storage.delete(k); },
    setAlarm: async () => {},
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(store),
  };
  class LocalSocket extends EventTarget {
    static OPEN = 1;
    state = 0;
    get readyState() { return this.state; }
    private attachment: unknown = { role: 'pending' };
    readonly server = {
      deserializeAttachment: () => this.attachment,
      serializeAttachment: (value: unknown) => { this.attachment = value; },
      send: (data: string) => queueMicrotask(() => { if (this.state === 1) this.dispatchEvent(new MessageEvent('message', { data })); }),
      close: (code: number, reason: string) => this.close(code, reason),
    };
    constructor(url: string) {
      super();
      if (!instance) instance = new CollabRoom({ id: { name: new URL(url).pathname.split('/').at(-1) }, storage: store,
        getWebSockets: () => sockets.filter((socket) => socket.state === 1).map((socket) => socket.server) });
      sockets.push(this);
      const open = () => {
        if (this.state !== 0) return;
        this.state = 1;
        this.dispatchEvent(new Event('open'));
      };
      if (partitioned) held.push(open);
      else queueMicrotask(open);
    }
    send(data: string) { frames.push(data); queueMicrotask(() => { void instance.webSocketMessage(this.server, data); }); }
    close(code = 1000, reason = '') {
      if (this.state === 3) return;
      this.state = 3;
      queueMicrotask(() => { this.dispatchEvent(Object.assign(new Event('close'), { code, reason })); void instance.webSocketClose(this.server); });
    }
  }
  return {
    Socket: LocalSocket, sockets, frames, storage,
    partition() {
      partitioned = true;
      sockets.find((socket) => socket.state === 1 && (socket.server.deserializeAttachment() as { role: string }).role === 'guest')!
        .close(1006, 'Fixture connection lost');
    },
    heal() { partitioned = false; for (const open of held.splice(0)) queueMicrotask(open); },
  };
}

it('joins two cores, runs a contributed key on its owner, and resumes a write after the owner disconnects', async () => {
  const transport = await relay();
  const originalFetch = fetch;
  let remoteTurns = 0, localTurns = 0;
  const remoteModel = 'fixture/remote:free', localModel = 'openai/gpt-oss-20b';
  const remoteKey = 'fixture-guest-key-private', localKey = 'fixture-host-key-private';
  const request = 'Create the co-op fixture on the host';
  const token = 'COOP_EFFECT_ONCE';
  let drop = false;
  const write = { type: 'function', function: { name: 'workspace_write_file', arguments: JSON.stringify({ path: 'coop-fixture.txt', content: token, expectedSha256: 'absent' }) } };
  const response = (model: string, message: object) => Response.json({ model, choices: [{ message }] });
  vi.stubGlobal('WebSocket', transport.Socket);
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], opts?: RequestInit) => {
    const address = String(url);
    const guest = address.startsWith('https://openrouter.ai/');
    if (!guest && !address.startsWith('https://api.groq.com/')) return originalFetch(url, opts);
    expect((opts?.headers as Record<string, string>).Authorization).toBe('Bearer ' + (guest ? remoteKey : localKey));
    if (address.endsWith('/key')) return Response.json({ data: { is_management_key: false } });
    if (address.endsWith('/models')) return Response.json({ data: guest ? [{ id: remoteModel, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] : [{ id: localModel }] });
    const body = JSON.parse(String(opts?.body));
    if (JSON.stringify(body.messages[0]).includes('"verdict"')) return response(guest ? remoteModel : localModel, { content: '{"verdict":"pass","summary":"Verified","criteria":[],"defects":[]}' });
    if (JSON.stringify(body.messages).includes('HOST_POOL_FIXTURE')) {
      expect(guest).toBe(false);
      return response(localModel, { content: '{"status":"implemented","summary":"Host used the next eligible key"}' });
    }
    if (guest) {
      remoteTurns++;
      if (remoteTurns === 1) return response(remoteModel, { tool_calls: [{ id: 'one', ...write }] });
      if (!drop) {
        drop = true;
        transport.partition();
        return new Promise<Response>((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true }));
      }
    }
    if (++localTurns === 1) return response(localModel, { tool_calls: [{ id: 'retry', ...write }] });
    expect(body.messages.at(-1).content).not.toContain('File changed since');
    return response(localModel, { content: '{"status":"implemented","summary":"Co-op result","filesChanged":["coop-fixture.txt"]}' });
  });
  const root = mkdtempSync(join(tmpdir(), 'shuriken-coop-test-'));
  const pairings = new Map<string, string>();
  const create = (name: string, secret: string) => Core.create({
    dataDir: join(root, name), resourcesDir: resolve('resources'), providers: [new FakeProvider({ respond: async () => { throw new Error('Subscription must not run shared work'); } })],
    secrets: async (key) => key.startsWith('coop-session:') ? pairings.get(name + key) ?? null : secret,
    saveCoopSecret: async (key, value) => {
      if (value === null) pairings.delete(name + key);
      else pairings.set(name + key, value);
      return true;
    },
    integrations: false, logToDisk: false, appVersion: 'coop-test',
  });
  let host: Core | undefined, guest: Core | undefined;
  try {
    host = await create('host', localKey);
    guest = await create('guest', remoteKey);
    host.orchestrator.pause();
    const p = host.openProject(host.createProject({ name: 'Host fixture', rootPath: join(root, 'project') }).id);
    p.updateExtras({ syncMode: 'none' });
    p.updateSettings({ freeApiProviders: ['groq', 'openrouter'], autoQa: false });
    host.collaboration.configure({ relay: 'http://localhost:8787', name: 'Host' });
    guest.collaboration.configure({ relay: 'http://localhost:8787', name: 'Guest' });
    const invitation = (await host.collaboration.host()).invitation!;
    const auth = transport.storage.get('coop-auth') as { expires: number };
    transport.storage.set('coop-auth', { ...auth, expires: Date.now() - 1 });
    await expect(guest.collaboration.join(invitation)).rejects.toThrow('expired');
    guest.collaboration.leave();
    transport.storage.set('coop-auth', auth);
    await guest.collaboration.join(invitation);
    await waitFor(() => host!.collaboration.status().pendingAdmission, 3000);
    expect(guest.collaboration.status().remoteProject).toBeNull();
    host.collaboration.admit();
    await waitFor(() => guest!.collaboration.status().guestRequestsEnabled, 3000);
    expect(host.collaboration.status().invitation).toBeNull();
    const outsider = await create('outsider', 'unused');
    try {
      outsider.collaboration.configure({ relay: 'http://localhost:8787', name: 'Outsider' });
      await expect(outsider.collaboration.join(invitation)).rejects.toThrow('already used');
    } finally { await outsider.shutdown(); }
    const a = randomUUID(), b = randomUUID();
    await host.freeApi.add(a, 'groq', 'Host key', true);
    await guest.freeApi.add(b, 'openrouter', 'Guest key', false);
    await host.freeApi.check(a);
    await guest.freeApi.check(b);
    for (const tier of ['fast', 'balanced', 'deep'] as const) {
      host.freeApi.setModel('groq', tier, localModel);
      guest.freeApi.setModel('openrouter', tier, remoteModel);
    }
    host.coop.share(a, 15);
    guest.coop.share(b, 2);
    await expect(guest.freeApi.contributedInference(b, { id: remoteModel, tools: true, images: false }, {
      model: remoteModel, messages: [{ role: 'user', content: 'Synthetic' }], tools: [{ type: 'web_search' }],
    }, new AbortController().signal, () => true)).rejects.toMatchObject({ status: 400 });
    const remote = await waitFor(() => host!.coop.status().offers.find((offer) => offer.owner === 'peer'), 3000);
    p.updateSettings({ coopPriority: [remote.id] });
    host.orchestrator.resume();
    const receipt = guest.collaboration.requestDirector(request);
    const task = await waitFor(() => p.store.get<{ task_id: string }>('SELECT task_id FROM coop_requests WHERE id=?', [receipt.id]), 8000);
    await waitFor(() => p.store.get("SELECT id FROM runs WHERE task_id=? AND provider_id='groq' AND role='roblox-engineer' AND status='completed'", [task.task_id]), 12_000)
      .catch(() => {
        throw new Error(JSON.stringify({ remoteTurns, localTurns, task: p.tasks.get(task.task_id),
          runs: p.store.all('SELECT provider_id,role,status,error FROM runs WHERE task_id=?', [task.task_id]) }));
      });
    expect(remoteTurns).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(p.root, 'coop-fixture.txt'), 'utf8')).toBe(token);
    expect(p.audit.toolCalls({ taskId: task.task_id }).filter((call) => call.tool === 'workspace_write_file' && call.status === 'ok')).toHaveLength(1);
    expect(transport.frames.join('\n')).not.toMatch(new RegExp(`${request}|${token}|${remoteKey}|${localKey}`));
    expect(transport.frames.join('\n')).not.toContain(new URLSearchParams(new URL(invitation).hash.slice(1)).get('pair'));
    transport.heal();
    await waitFor(() => guest!.collaboration.ready(), 4000);
    await guest.shutdown();
    guest = await create('guest', remoteKey);
    await guest.collaboration.restore('guest');
    await waitFor(() => guest!.collaboration.ready(), 4000);
    expect(p.store.all('SELECT id FROM coop_requests WHERE id=?', [receipt.id])).toHaveLength(1);
    expect(guest.coop.status().offers.find((offer) => offer.owner === 'local')?.used).toBe(2);
    const exhausted = await waitFor(() => host!.coop.status().offers.find((offer) => offer.owner === 'peer' && offer.used === offer.maximum), 3000);
    expect(exhausted.retryAt).toBeGreaterThan(Date.now());
    const ownTask = host.submitCoopTask(randomUUID(), 'HOST_POOL_FIXTURE', 'Host');
    await waitFor(() => p.store.get("SELECT id FROM runs WHERE task_id=? AND provider_id='groq' AND role='roblox-engineer' AND status='completed'", [ownTask]), 8000);
    expect(remoteTurns).toBe(2);
    host.collaboration.leave();
    await waitFor(() => guest!.collaboration.status().role === null, 3000);
  } finally {
    await guest?.shutdown();
    await host?.shutdown();
    vi.unstubAllGlobals();
  }
}, 38_000);
