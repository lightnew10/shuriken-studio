import { parentPort, workerData } from 'node:worker_threads';
import { runForgeJob, type ForgeJob, type ForgeResult } from './forge-render';
import { gpuForgeBatch, workerForgeTransport } from './gpu-batch';
import { setForgeBatch } from './resolve';

/**
 * The Forge page's pictures off the core's thread: forge-rpc.ts starts this module as a worker (electron-vite's
 * `?nodeWorker`), sends it jobs and gets PNG bytes back. Jobs run one at a time, in the order they came; their skins
 * are drawn on the GPU when the app has its GPU forge (the CPU forges what it can't).
 */

const pngs = (r: ForgeResult): ArrayBuffer[] => {
  const all = (r.kind === 'screen' ? [r.png] : r.kind === 'worn' ? r.skins.map((s) => s.png) : r.items.map((i) => i.png)).filter((p): p is Uint8Array => !!p);
  return [...new Set(all.map((p) => p.buffer).filter((b): b is ArrayBuffer => b instanceof ArrayBuffer))];
};

const port = parentPort;
const data = workerData as { shurikenForge?: boolean; forgeGpu?: boolean } | null;
if (port && data?.shurikenForge) {
  // Skins drawn on the GPU through the thread that started this worker (it relays to the app's render page).
  if (data.forgeGpu) setForgeBatch(gpuForgeBatch(workerForgeTransport(port)));
  port.on('message', (msg: { id?: number; job?: ForgeJob }) => {
    // Jobs only: the GPU relay's answers are the transport's.
    if (!msg?.job || typeof msg.id !== 'number') return;
    const id = msg.id;
    void runForgeJob(msg.job).then(
      (result) => port.postMessage({ id, result }, pngs(result)),
      (e: unknown) => port.postMessage({ id, error: e instanceof Error ? e.message : String(e) }),
    );
  });
}
