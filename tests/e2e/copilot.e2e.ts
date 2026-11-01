/**
 * Live check of a dock copilot with the real model (two short turns, costs a little usage):
 *
 *   E2E=copilot STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/copilot.e2e.ts
 *
 * The Music & sound copilot composes lobby music in a throwaway project bound to the scratch place,
 * answers in its own channel with a digest for the director, then continues its session for a change.
 * Refuses a published place. Removes what it built in the place.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { SoundLibrary } from '../../src/core/audio/audio-library';

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

describe.runIf(process.env.E2E === 'copilot')('a dock copilot with the real model (live)', () => {
  it('composes in its dock, reports to the director, and continues its session', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-copilot-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-copilot-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    core.prefs.set({ uploadAssets: false });
    await core.studio.start();
    try {
      const summary = core.createProject({ name: 'Copilot E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      core.orchestrator.pause();
      const chat = core.copilots.chat('audio')!;
      const replies = () => chat.list().filter((m) => m.role === 'copilot');
      const wait = async (n: number) => {
        const t0 = Date.now();
        while (replies().length < n) {
          if (Date.now() - t0 > 10 * 60_000) throw new Error('No copilot reply within 10 minutes');
          await new Promise((r) => setTimeout(r, 2000));
        }
      };
      let t0 = Date.now();
      core.copilots.send('audio', 'Calm lofi music for the lobby, about 16 bars. Keep it short, just make it.', { page: 'audio' });
      await wait(1);
      const first = replies()[0]!;
      log('turn 1', Math.round((Date.now() - t0) / 1000), 's:', first.kind, first.text, JSON.stringify(first.data));
      expect(first.kind).toBe('text');
      const sounds = new SoundLibrary(projectDir).all();
      log('sounds:', sounds.map((s) => `${s.name} (${s.kind}${s.style ? `, ${s.style}` : ''})`).join('; '));
      expect(sounds.some((s) => s.kind === 'music')).toBe(true);
      // A draft to listen to in the dock: not in the game until the user adds it.
      expect(sounds.every((s) => s.draft)).toBe(true);
      expect(first.data?.mode).toBe('draft');
      expect(String(first.data?.digest ?? '')).not.toBe('');

      t0 = Date.now();
      core.copilots.send('audio', 'Now make that a little faster and brighter.');
      await wait(2);
      const second = replies()[1]!;
      log('turn 2', Math.round((Date.now() - t0) / 1000), 's:', second.kind, second.text, JSON.stringify(second.data));
      const runs = core.runner.listRuns(ctx, { limit: 10 }).filter((r) => r.role === 'copilot-audio');
      log('runs:', JSON.stringify(runs.map((r) => ({ status: r.status, cost: (r as { costUsd?: number }).costUsd, session: (r as { continuesRunId?: string | null }).continuesRunId ?? null }))));
      expect(runs.every((r) => r.status === 'completed')).toBe(true);
    } finally {
      await core.studio
        .runLuau(`local a = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenAudio") if a then a:Destroy() end local s = game:GetService("ReplicatedStorage"):FindFirstChild("Shared") if s then for _, m in s:GetChildren() do if m.Name:match("^Shuriken") then m:Destroy() end end if #s:GetChildren() == 0 then s:Destroy() end end return "ok"`, 'Edit')
        .catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 30 * 60 * 1000);
});
