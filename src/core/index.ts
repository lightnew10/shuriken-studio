/**
 * utilityProcess entry. Receives configuration from the Electron main process, starts the Core,
 * serves RPC requests and forwards core events. Contains no business logic.
 */
import type { RenderRequest } from '@shared/render';
import type { ForgeGLRequest, ForgeGLResponse } from '@shared/forge-plan';
import type { MediaRequest, MediaResult } from '@shared/references';
import { Core } from './core';
import { createRouter } from './rpc/router';
import { errorMessage } from './log';
import { BurstReporter, isClosedStreamWrite } from './util/rejections';
import { Session } from 'node:inspector/promises';
import { writeFileSync } from 'node:fs';

// SHURIKEN_CORE_PROFILE=<file> (smoke --smoke-profile): a CPU profile of this core from its start to its shutdown.
const profiler = process.env.SHURIKEN_CORE_PROFILE
  ? (async () => {
      const s = new Session();
      s.connect();
      await s.post('Profiler.enable');
      await s.post('Profiler.setSamplingInterval', { interval: 500 });
      await s.post('Profiler.start');
      return s;
    })().catch(() => null)
  : null;
const saveProfile = async (): Promise<void> => {
  const s = await profiler;
  if (!s) return;
  try {
    const { profile } = await s.post('Profiler.stop');
    writeFileSync(process.env.SHURIKEN_CORE_PROFILE!, JSON.stringify(profile));
  } catch {
    // A profile is a measurement; the shutdown goes on without it.
  }
};

interface InitMessage {
  type: 'init';
  dataDir: string;
  resourcesDir: string | null;
  appVersion: string;
  safeMode?: boolean;
  openProject?: string | null | 'last';
  /** Restarted after a crash mid-build: the project carries on instead of opening on hold. */
  resume?: boolean;
}

interface RpcRequest {
  type: 'rpc';
  id: number;
  method: string;
  params: unknown;
}

type Incoming =
  | InitMessage
  | RpcRequest
  | { type: 'shutdown' }
  | { type: 'secret-value'; id: number; value: string | null }
  | { type: 'share'; count: number; elsewhere?: number }
  | { type: 'render-result'; id: number; image: string | null; error?: string }
  | { type: 'forge-result'; id: number; result: ForgeGLResponse | null; error?: string }
  | { type: 'media-result'; id: number; result: MediaResult | null; error?: string };

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: Incoming }) => void): void;
}
// Electron augments `process` with `parentPort` inside a utilityProcess; core stays free of electron types.
const port = (process as unknown as { parentPort: ParentPort }).parentPort;
let core: Core | null = null;
let elsewhere = 0;
let router: ReturnType<typeof createRouter> | null = null;
const pending: RpcRequest[] = [];
const secretWaiters = new Map<number, (v: string | null) => void>();
let secretSeq = 1;

/** Ask the main process for a secret; it decrypts with the OS key store. Values never touch disk here. */
function requestSecret(key: string): Promise<string | null> {
  const id = secretSeq++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      secretWaiters.delete(id);
      resolve(null);
    }, 10000);
    secretWaiters.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    send({ type: 'secret-get', id, key });
  });
}

const renderWaiters = new Map<number, (v: string | null) => void>();
let renderSeq = 1;

/** Ask the main process for a picture (a JPEG data: URL), or null when it can't draw one. */
function requestRender(req: RenderRequest): Promise<string | null> {
  const id = renderSeq++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      renderWaiters.delete(id);
      resolve(null);
    }, 60_000);
    renderWaiters.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    send({ type: 'render', id, req });
  });
}

const forgeWaiters = new Map<number, (v: ForgeGLResponse | null) => void>();
let forgeSeq = 1;

/** Ask the main process to draw forge plans on the GPU (its hidden render page); null when it can't. */
function requestForge(req: ForgeGLRequest): Promise<ForgeGLResponse | null> {
  const id = forgeSeq++;
  return new Promise((resolve) => {
    // The first request waits for the page to start and its shaders to compile.
    const timer = setTimeout(() => {
      forgeWaiters.delete(id);
      resolve(null);
    }, 120_000);
    forgeWaiters.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    send({ type: 'forge', id, req });
  });
}

const mediaWaiters = new Map<number, { resolve: (v: MediaResult) => void; reject: (e: Error) => void }>();
let mediaSeq = 1;

/**
 * Ask the main process to decode a reference video or picture on its hidden media page. A long clip's frames
 * take minutes to read, so the wait is long; the main process answers with an error when it can't.
 */
function requestMedia(req: MediaRequest): Promise<MediaResult> {
  const id = mediaSeq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mediaWaiters.delete(id);
      reject(new Error('The media page did not answer in 30 minutes.'));
    }, 30 * 60_000);
    mediaWaiters.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    send({ type: 'media', id, req });
  });
}

function send(msg: unknown): void {
  try {
    port.postMessage(msg);
  } catch {
    /* parent gone */
  }
}

async function handleRpc(req: RpcRequest): Promise<void> {
  if (!router) {
    pending.push(req);
    return;
  }
  const fn = router[req.method];
  if (!fn) {
    send({ type: 'rpc-result', id: req.id, error: `Unknown method ${req.method}` });
    return;
  }
  try {
    const result = await fn(req.params ?? {});
    send({ type: 'rpc-result', id: req.id, result: result === undefined ? null : result });
  } catch (e) {
    core?.log.warn(`RPC ${req.method} failed`, errorMessage(e));
    send({ type: 'rpc-result', id: req.id, error: errorMessage(e) });
  }
}

port.on('message', async (e: { data: Incoming }) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      core = await Core.create({ dataDir: msg.dataDir, resourcesDir: msg.resourcesDir, appVersion: msg.appVersion, integrations: true, secrets: requestSecret, render: requestRender, forgeGpu: requestForge, media: requestMedia, safeMode: msg.safeMode === true, openProject: msg.openProject, resumeBuild: msg.resume === true });
      core.setAgentsElsewhere(elsewhere);
      router = createRouter(core);
      core.bus.onAny((channel, payload) => send({ type: 'event', channel, payload }));
      send({ type: 'ready', mcpUrl: core.mcp.url });
      // A project opened while starting (a window restored at launch, "last", "blank") announced itself
      // before anyone was listening: say again which project this is and how its work stands.
      if (core.project) {
        send({ type: 'event', channel: 'project.changed', payload: { projectId: core.project.summary.id } });
        send({ type: 'event', channel: 'orchestrator.state', payload: core.orchestrator.state() });
      }
      for (const r of pending.splice(0)) void handleRpc(r);
    } catch (err) {
      send({ type: 'fatal', error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined });
    }
  } else if (msg.type === 'rpc') {
    void handleRpc(msg);
  } else if (msg.type === 'share') {
    elsewhere = Math.max(0, msg.elsewhere ?? 0);
    core?.setAgentsElsewhere(elsewhere);
  } else if (msg.type === 'render-result') {
    renderWaiters.get(msg.id)?.(msg.image);
    renderWaiters.delete(msg.id);
  } else if (msg.type === 'forge-result') {
    forgeWaiters.get(msg.id)?.(msg.result);
    forgeWaiters.delete(msg.id);
  } else if (msg.type === 'media-result') {
    const w = mediaWaiters.get(msg.id);
    mediaWaiters.delete(msg.id);
    if (msg.result && !msg.error) w?.resolve(msg.result);
    else w?.reject(new Error(msg.error || 'The media page could not read the file.'));
  } else if (msg.type === 'secret-value') {
    secretWaiters.get(msg.id)?.(msg.value);
    secretWaiters.delete(msg.id);
  } else if (msg.type === 'shutdown') {
    try {
      await saveProfile();
      await core?.shutdown();
    } finally {
      process.exit(0);
    }
  }
});

process.on('uncaughtException', (err) => {
  core?.log.error('Uncaught exception in core', err);
  send({ type: 'core-error', error: errorMessage(err) });
});
const closedWrites = new BurstReporter(10_000);
process.on('unhandledRejection', (err) => {
  // A write that lost the race with its stream closing is how an aborted request reports itself (stopping a
  // batch of runs once made thirty of them): nothing to fix, so one line for the burst, not an error each.
  if (isClosedStreamWrite(err)) {
    const n = closedWrites.hit();
    if (n) core?.log.info(`Ignored ${n} write${n === 1 ? '' : 's'} to a request stream that was already closed (an aborted request)`);
    return;
  }
  core?.log.error('Unhandled rejection in core', err);
});
