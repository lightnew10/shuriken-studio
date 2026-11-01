import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import { ModelStore, type ModelMeta } from '../modeling/model-store';
import { waitBudget } from '../roblox/upload-queue';
import { errorOutput, jsonOutput, type ToolRegistry } from './tool-registry';

/** The part of Kiln's client and model links that waiting needs (the whole of it lives in modeling/kiln-modeling.ts). */
export interface KilnWatch {
  linkedProject(root: string, model: string): string | null;
  kiln: { check(force?: boolean): Promise<{ ok: boolean; detail: string }>; get(path: string, timeoutMs?: number): Promise<unknown> };
  /** Shuriken's queue of Kiln builds: a running build knows how far Kiln's copilot is (Kiln 0.8.2 reports its steps). */
  builds?: { list(root?: string): Array<{ kilnProject: string; state: string; step: string | null }> };
}

export interface WaitToolDeps {
  project: () => ProjectContext | null;
  studio: RobloxStudioAdapter;
  /** Parts of this project whose upload to Roblox is running (or waits its turn) right now. */
  uploading: (root: string) => string[];
  /** Kiln, where it can be used (null in tests and where Kiln isn't installed). */
  kiln: () => KilnWatch | null;
}

/** How often a wait looks at what it waits for, and how often it says it is still waiting. */
export const WAIT_FOR = { pollMs: 1500, noteMs: 15_000 };

const nap = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

const list = (names: string[], max = 12) => names.slice(0, max).join(', ') + (names.length > max ? `, … (${names.length} in all)` : '');

/** What became of a part's upload, from its record in the model store. */
function uploadState(m: ModelMeta): 'uploaded' | 'processing' | { failed: string } | 'none' {
  if (ModelStore.assetId(m)) return 'uploaded';
  if (ModelStore.pendingOperation(m)) return 'processing';
  if (m.upload && 'error' in m.upload && m.upload.hash === m.hash) return { failed: m.upload.error };
  return 'none';
}

/**
 * Waiting is a tool, not a shell loop: agents slept in shell loops polling for uploads and for Studio, and a
 * shell sleep of 10 s or more is refused. `wait_for` blocks on the server (with progress notes, so the client
 * doesn't give up) until Studio is free for Edit-mode work, a model's uploads to Roblox are through, or Kiln's
 * copilot has finished its turn on a model.
 */
export function registerWaitTools(reg: ToolRegistry, d: WaitToolDeps): void {
  reg.register({
    name: 'wait_for',
    waits: true,
    title: 'Wait for Studio, uploads or Kiln',
    description:
      'Waits on the server until something is ready, then returns. Use it instead of sleeping or polling in the shell (a shell sleep of 10 s or more is refused). what "studio_edit": Studio is free for Edit-mode work (no other agent\'s playtest holds it; a playtest is stopped after a few minutes, so this ends); "upload": the Roblox uploads of this game\'s models that are under way have finished (give model for one model\'s parts; the result lists each part: uploaded, still processing at Roblox, or failed); "kiln_turn": Kiln\'s copilot has finished its turn on a model\'s Kiln project (give model, or kiln_project) — kiln_request {turn} or kiln_import then bring the result in. timeout_sec (default 240, at most what your client allows) is the most it waits; ready false means the time ran out and the thing is still going: do other work and call again. It reports progress while it waits.',
    capability: 'app.wait',
    permission: 'read',
    input: {
      what: z.enum(['studio_edit', 'upload', 'kiln_turn']),
      model: z.string().optional().describe('upload / kiln_turn: one model of this game (default for upload: all of them)'),
      kiln_project: z.string().optional().describe('kiln_turn: a Kiln project id (from kiln_status) instead of model'),
      timeout_sec: z.number().int().min(1).max(600).optional(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ args, caller, signal, progress }) => {
      // An MCP client without progress notes gives up on a quiet call after about five minutes: stay under that.
      const budget = waitBudget(caller.kind, !!progress);
      const limitMs = Math.min((args.timeout_sec ?? 240) * 1000, budget);
      const t0 = Date.now();
      const deadline = t0 + limitMs;
      const waitedSec = () => Math.round((Date.now() - t0) / 1000);
      let lastNote = 0;
      const tell = (message: string) => {
        if (Date.now() - lastNote < WAIT_FOR.noteMs && lastNote) return;
        lastNote = Date.now();
        try {
          progress?.({ message });
        } catch {
          /* progress is a courtesy */
        }
      };

      if (args.what === 'studio_edit') {
        const avail = d.studio.availability();
        if (!avail.ok) return errorOutput(`Studio isn't available: ${avail.reason ?? 'not connected'}.`);
        const w = await d.studio.waitForEdit(limitMs);
        return jsonOutput(w.ok ? { ready: true, waitedSec: waitedSec() } : { ready: false, waitedSec: waitedSec(), why: w.message });
      }

      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');

      if (args.what === 'upload') {
        const store = new ModelStore(p.root);
        const names = args.model ? new Set([args.model, ...store.parts(args.model).map((m) => m.name)]) : null;
        const running = () => d.uploading(p.root).filter((n) => !names || names.has(n));
        while (running().length && Date.now() < deadline && !signal.aborted) {
          tell(`Waiting for ${running().length} part upload${running().length === 1 ? '' : 's'} to Roblox: ${list(running(), 6)}`);
          await nap(Math.min(WAIT_FOR.pollMs, Math.max(0, deadline - Date.now())), signal);
        }
        const still = running();
        const parts = store.all().filter((m) => !names || names.has(m.name));
        const states = parts.map((m) => [m.name, uploadState(m)] as const);
        const processing = states.filter(([, s]) => s === 'processing').map(([n]) => n);
        const failed = states.flatMap(([n, s]) => (typeof s === 'object' ? [{ part: n, why: s.failed }] : []));
        return jsonOutput({
          ready: still.length === 0,
          waitedSec: waitedSec(),
          stillUploading: still,
          uploaded: states.filter(([, s]) => s === 'uploaded').length,
          processingAtRoblox: processing,
          failed: failed.slice(0, 20),
          notUploaded: states.filter(([, s]) => s === 'none').length,
          note: still.length
            ? `Still uploading after ${waitedSec()} s: the uploads carry on by themselves; call wait_for again, or do other work.`
            : processing.length
              ? `Roblox is still processing ${processing.length} upload${processing.length === 1 ? '' : 's'} (${list(processing, 6)}): the next model_place / rig_build / model_gear call asks Roblox about them (nothing is sent twice).`
              : failed.length
                ? 'Some uploads failed (see failed): model_place says why, and sends them again.'
                : 'No uploads are running.',
        });
      }

      // kiln_turn
      const k = d.kiln();
      if (!k || process.env.SHURIKEN_NO_KILN === '1') return errorOutput('Kiln is not available in this setup.');
      const id = args.kiln_project ?? (args.model ? k.linkedProject(p.root, args.model) : null);
      if (!id) return errorOutput(args.model ? `${args.model} has no Kiln project yet (kiln_request makes one).` : 'Give model (a model of this game) or kiln_project (an id from kiln_status).');
      for (;;) {
        const health = await k.kiln.check().catch(() => null);
        if (!health?.ok) return errorOutput(`Kiln isn't running (${health?.detail ?? 'no answer'}). The user can start it from the Kiln page.`);
        const app = (await k.kiln.get('/api/v1/app', 8000).catch(() => null)) as { projects?: Array<{ id: string; title?: string; working?: boolean }> } | null;
        let proj = app?.projects?.find((x) => x.id === id);
        if (app && !proj) {
          // Kiln lists only its 48 most recent projects: one it didn't list is asked about directly (from memory: it opens nothing).
          const a = (await k.kiln.get(`/api/v1/projects/${id}/anim`, 5000).catch(() => null)) as { open?: boolean; working?: boolean } | null;
          if (!a) return errorOutput(`Kiln has no project ${id} (kiln_status lists them).`);
          proj = { id, working: !!a.open && !!a.working };
        }
        if (proj && !proj.working) return jsonOutput({ ready: true, kilnProject: id, waitedSec: waitedSec(), next: 'kiln_request {turn} follows the turn and brings the result in; kiln_import brings in what Kiln has now.' });
        if (Date.now() >= deadline || signal.aborted) return jsonOutput({ ready: false, kilnProject: id, waitedSec: waitedSec(), why: signal.aborted ? 'The call was cancelled.' : "Kiln's copilot is still working on it: call wait_for again, or do other work." });
        const step = k.builds?.list(p.root).find((b) => b.kilnProject === id && b.state === 'running')?.step;
        tell(`Waiting for Kiln's copilot to finish its turn on ${proj?.title ?? id} (${waitedSec()} s so far)${step ? `: ${step}` : ''}`);
        await nap(Math.min(WAIT_FOR.pollMs * 2, Math.max(0, deadline - Date.now())), signal);
      }
    },
  });
}
