/**
 * The reference pipeline in a real Electron, with no Claude, no Studio and no Kiln: the real Core (a stub provider
 * writes a canned study), the real hidden media page (Chromium decodes) and the real renderer (the References page
 * is photographed). For checking decoding, the measurements and the page on any machine without spending usage.
 *
 *   npx electron-vite build
 *   node_modules/.bin/esbuild scripts/references-selftest.ts --bundle --platform=node --format=esm --packages=external --external:electron --alias:@shared=./src/shared --alias:@core=./src/core --outfile=out/selftest/references-selftest.mjs
 *   set SELFTEST_OUT=C:\temp\refs-selftest   (a new, empty folder: data, project, report.json, *.png)
 *   set SELFTEST_FILE=C:\clips\combat.mp4    (optional, several separated by ";": real files instead of the generated clip)
 *   set CONTAINER=webm                       (optional: record the generated clip as WebM instead of MP4)
 *   node_modules\.bin\electron out\selftest\references-selftest.mjs
 *
 * report.json has each reference's record (status, frames, cuts, tempo, loud hits) and the pictures the analyst
 * would have been shown; references-<n>.png are the page. Its data stays in SELFTEST_OUT.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaHost, registerMediaScheme } from '../src/main/media-decoder';
import { Core } from '../src/core/core';
import { createRouter } from '../src/core/rpc/router';
import type { AgentEvent, AgentRunHandle, AgentRunRequest, IAgentProvider } from '../src/core/providers/types';
import { AsyncQueue } from '../src/core/util/async';

const OUT = process.env.SELFTEST_OUT;
const ROOT = process.env.WORKTREE ?? process.cwd();
if (!OUT) {
  console.error('Set SELFTEST_OUT to a new, empty folder.');
  process.exit(2);
}
process.env.SHURIKEN_NO_KILN = '1';
process.env.SHURIKEN_NO_STUDIO = '1';
process.env.SHURIKEN_NO_LINK = '1';
app.setPath('userData', join(OUT, 'userdata'));
// As the smoke runs do: an off-screen window keeps painting.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
registerMediaScheme();

const shown: Array<{ role: string; captions: string[]; brief: string }> = [];
/** Writes a canned study (and nothing else): the run that would cost usage. */
const stub: IAgentProvider = {
  id: 'stub',
  displayName: 'Stub',
  adapterVersion: 'selftest',
  testedVersions: ['selftest'],
  async detect() {
    return { installed: true, version: '1', executable: null, detail: 'stub' };
  },
  async auth() {
    return { authenticated: true, method: 'stub', account: 'stub', plan: null, detail: 'ok' };
  },
  declaredCapabilities() {
    return { toolUse: true, mcp: true, mcpHttp: true, subagents: false, parallelAgents: true, fileEditing: false, terminal: false, streaming: true, backgroundExecution: false, contextCompaction: false, longRunningSessions: false, structuredOutput: true, approvalWorkflow: true, sessionPersistence: false, imageInput: true, imageOutput: false, interruption: true, webResearch: false, costReporting: true, rateLimitReporting: false };
  },
  diagnostics() {
    return { quickChecks: async () => [], deepChecks: async () => [] };
  },
  modelForTier: (t) => `stub-${t}`,
  run(req: AgentRunRequest): AgentRunHandle {
    const q = new AsyncQueue<AgentEvent>();
    const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const study = 'takeaways' in props;
    if (study) shown.push({ role: req.role, captions: (req.images ?? []).map((i) => i.caption ?? ''), brief: req.prompt });
    q.push({ type: 'started', providerSessionId: 's', model: 'stub', providerVersion: '1', tools: [], toolServers: [], authSource: 'stub' });
    q.push({
      type: 'completed',
      ok: true,
      resultText: 'done',
      structured: study ? { summary: 'A canned study from the self-test (no model ran).', takeaways: ['Look at the frames and the sound panel: they are real; this text is not.'], tags: ['pacing'], study: '## What it is\nThe self-test writes no real study: no model ran.' } : null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 1,
      durationMs: 1,
      stopReason: 'end_turn',
      error: null,
      errorKind: null,
    });
    q.close();
    return { events: q, interrupt: async () => q.close() };
  },
};

app.whenReady().then(async () => {
  const report: Record<string, unknown> = {};
  const prefs = { preload: join(ROOT, 'out', 'preload', 'index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false };
  const host = new MediaHost({
    webPreferences: () => prefs,
    load: (win) => void win.loadFile(join(ROOT, 'out', 'renderer', 'index.html'), { search: 'media', hash: 'media' }),
    guard: () => {},
    alive: () => true,
    log: (l, m, d) => console.log(l, m, JSON.stringify(d)),
  });
  try {
    mkdirSync(join(OUT, 'data'), { recursive: true });
    const core = await Core.create({ dataDir: join(OUT, 'data'), resourcesDir: join(ROOT, 'resources'), appVersion: 'selftest', providers: [stub], integrations: false, logToDisk: false, media: (req) => host.run(req) });
    const summary = core.createProject({ name: 'Reference self-test', rootPath: join(OUT, 'project') });
    core.openProject(summary.id);
    core.orchestrator.pause();
    // Never reach the user's Studio from here: its MCP client would connect on demand otherwise.
    const conn = core.studio.conn as unknown as { connect: () => Promise<void>; call: () => Promise<unknown> };
    conn.connect = async () => {
      throw new Error('Studio is off in the self-test');
    };
    conn.call = async () => ({ ok: false, content: [], error: 'Studio is off in the self-test', durationMs: 0 });
    const router = createRouter(core);
    ipcMain.handle('rpc', async (_e, method: string, params: unknown) => {
      if (/^(viewer|roblox|studio|kiln|ui\.capture)/.test(method)) throw new Error(`${method} is off in the self-test`);
      const fn = router[method];
      if (!fn) throw new Error(`Unknown method ${method}`);
      return (await fn(params ?? {})) ?? null;
    });
    ipcMain.handle('core:status', () => ({ state: 'ready' }));
    const t0 = Date.now();
    const files = (process.env.SELFTEST_FILE ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    if (files.length) {
      const out = await core.references.add(files, 'page');
      report.refused = out.refused;
      await core.references.idle();
    } else {
      const container = process.env.CONTAINER === 'webm' ? 'webm' : process.env.CONTAINER === 'mp4' ? 'mp4' : undefined;
      const out = await core.references.selftest({ seconds: 8, ...(container ? { container } : {}) });
      report.clip = out.clip;
    }
    report.ms = Date.now() - t0;
    const refs = core.references.list();
    report.references = refs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      error: r.error,
      duration: r.duration,
      size: [r.width, r.height],
      frames: r.video?.frames.length,
      coverage: r.video?.coverage,
      cuts: r.video?.cuts,
      palette: (r.video?.palette ?? r.image?.palette ?? []).map((c) => `${c.hex} ${Math.round(c.share * 100)}%`),
      audioNote: r.audioNote,
      sound: r.audio ? { lufs: r.audio.integratedLufs, tempo: r.audio.tempo, silence: r.audio.silenceRatio, balance: r.audio.balance, onsets: r.audio.onsets, hits: r.audio.events.map((e) => `${e.t.toFixed(2)} s ${e.peakDb} dBFS ${e.character} → frame ${e.frame?.t.toFixed(2) ?? '—'}`) } : null,
      spectrograms: r.spectrograms?.length ?? 0,
    }));
    report.analyst = shown.map((s) => ({ role: s.role, pictures: s.captions.length, captions: s.captions }));
    shown.forEach((s, i) => writeFileSync(join(OUT, `brief-${i + 1}.txt`), s.brief));
    // The page, for each reference.
    const win = new BrowserWindow({ x: -3000, y: 0, width: 1500, height: 1000, show: false, webPreferences: { ...prefs, backgroundThrottling: false } });
    core.bus.onAny((channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send('core:event', channel, payload);
    });
    win.showInactive();
    await win.loadFile(join(ROOT, 'out', 'renderer', 'index.html'), { search: 'tab&smoke' });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await wait(3000);
    for (const [i, r] of refs.entries()) {
      await win.webContents.executeJavaScript(`window.__shurikenSetView(${JSON.stringify(`references@${r.id}`)})`);
      await wait(3500);
      win.webContents.invalidate();
      await wait(300);
      writeFileSync(join(OUT, `references-${i + 1}.png`), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.querySelectorAll('main').forEach((m) => (m.scrollTop = 99999))`);
      await wait(800);
      win.webContents.invalidate();
      await wait(300);
      writeFileSync(join(OUT, `references-${i + 1}-end.png`), (await win.webContents.capturePage()).toPNG());
    }
    report.rendererErrors = await win.webContents.executeJavaScript('window.__shurikenErrors ?? []');
    await core.shutdown();
  } catch (e) {
    report.error = (e as Error).stack ?? String(e);
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  host.close();
  app.exit(0);
});
