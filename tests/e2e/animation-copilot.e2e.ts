/**
 * Live check of the animation copilot with the real model (two turns, costs a little usage):
 *
 *   E2E=animation-copilot STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/animation-copilot.e2e.ts
 *
 * In a throwaway project bound to the scratch place, asks the animation copilot for a sword slash that
 * plays while running, on left click, with the hit timed by the server (skill roblox-animation-runtime).
 * Expects a DRAFT upper-body clip (no leg or hip keys) with a Hit marker, nothing built into Studio and no
 * code written: the wiring is handed to the director. Then "add it": the clip is built into Studio, and
 * the copilot still wrote no game code and ran no playtest. Refuses a published place. Removes what it built.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { AnimationStore } from '../../src/core/animation/animation-service';
import { LOWER_BODY } from '../../src/shared/animation';

const log = (...args: unknown[]) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
const ROLE = 'copilot-animation';

function files(dir: string, root = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) files(f, root, out);
    else if (/\.luau$/.test(n)) out.push(relative(root, f).replaceAll('\\', '/'));
  }
  return out;
}

const CLEAN = `for _, p in { {"ReplicatedStorage", "Shared"}, {"ServerScriptService", "Server"}, {"StarterPlayer", "StarterPlayerScripts", "Client"}, {"ReplicatedStorage", "Remotes"}, {"ReplicatedStorage", "ShurikenAnimations"}, {"StarterPack"} } do
  local inst = game:GetService(p[1])
  for i = 2, #p do inst = inst and inst:FindFirstChild(p[i]) end
  if inst and inst ~= game:GetService(p[1]) then inst:Destroy() end
end
for _, t in game:GetService("StarterPack"):GetChildren() do t:Destroy() end
game:GetService("ServerStorage"):SetAttribute("ShurikenSync", nil)
return "clean"`;

describe.runIf(process.env.E2E === 'animation-copilot')('the animation copilot with the real model (live)', () => {
  it('makes an upper-body slash as a draft, hands the wiring off, and builds it into Studio only when told to', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-animcopilot-e2e-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-animcopilot-project-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    core.prefs.set({ uploadAssets: false });
    await core.studio.start();
    try {
      const summary = core.createProject({ name: 'Animation Copilot E2E', rootPath: projectDir });
      const ctx = core.openProject(summary.id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');
      core.orchestrator.pause();

      const chat = core.copilots.chat('animation')!;
      const replies = () => chat.list().filter((m) => m.role === 'copilot');
      const t0 = Date.now();
      core.copilots.send(
        'animation',
        'I want a sword slash I can do while running: the legs keep running. Play it on left click and time the hit on the server (other players within 6 studs in front take 20 damage). Just make it.',
        { page: 'animation' },
      );
      const wait = async (n: number) => {
        const t = Date.now();
        while (replies().length < n) {
          if (Date.now() - t > 20 * 60_000) throw new Error('No copilot reply within 20 minutes');
          await new Promise((r) => setTimeout(r, 3000));
        }
      };
      await wait(1);
      const reply = replies()[0]!;
      log('reply after', Math.round((Date.now() - t0) / 1000), 's:', reply.text, JSON.stringify(reply.data));
      // The message asks for a move and for game code: the move is a draft, the code is the team's (handed off).
      expect(reply.data?.mode).toBe('draft');
      expect(String(reply.data?.handoff ?? '')).not.toBe('');
      const runs = core.runner.listRuns(ctx, { limit: 5 }).filter((r) => r.role === 'copilot-animation');
      log('runs:', JSON.stringify(runs.map((r) => ({ status: r.status, cost: (r as { costUsd?: number }).costUsd }))));
      expect(runs.every((r) => r.status === 'completed')).toBe(true);

      // An upper-body clip with a Hit marker: no hip or leg keys, so the run's legs carry on.
      const anims = new AnimationStore(projectDir).all();
      log('animations:', anims.map((a) => `${a.clip.name} (${a.clip.priority}, ${a.clip.keys.length} keys, markers ${(a.clip.markers ?? []).map((m) => m.name).join('/')})`).join('; '));
      const slash = anims.find((a) => (a.clip.markers ?? []).some((m) => m.name === 'Hit') && !a.clip.loop);
      expect(slash, 'a slash with a Hit marker').toBeTruthy();
      expect(slash!.draft, 'a draft until the user adds it').toBe(true);
      const keyed = new Set(slash!.clip.keys.flatMap((k) => Object.keys(k.poses)));
      log('slash joints:', [...keyed].join(', '));
      expect(LOWER_BODY.some((j) => keyed.has(j))).toBe(false);
      expect(['Action', 'Action2', 'Action3', 'Action4']).toContain(slash!.clip.priority);

      // A draft: no game code written, nothing in Studio.
      expect(files(join(projectDir, 'src'))).toEqual([]);
      const inStudio = async () => (await core.studio.runLuau(`local a = game:GetService("ReplicatedStorage"):FindFirstChild("ShurikenAnimations") local s = a and a:FindFirstChild("Sequences") return s and s:FindFirstChild(${JSON.stringify(slash!.clip.name)}) and "built" or "missing"`, 'Edit')).output.trim();
      expect(await inStudio()).toBe('missing');

      // "Add it": built into Studio with the runtime module, and still no game code of the copilot's.
      core.copilots.send('animation', 'Add it to the game.');
      await wait(2);
      log('import turn:', replies()[1]!.text);
      expect(replies()[1]!.data?.mode).toBe('import');
      expect(new AnimationStore(projectDir).get(slash!.clip.name)?.draft).toBeUndefined();
      expect(await inStudio()).toBe('built');
      const code = files(join(projectDir, 'src'));
      log('files:', code.join(', '));
      expect(code.filter((f) => !/ShurikenAnimations\.luau$/.test(f))).toEqual([]);
      const called = (ctx.store.all<{ tool: string }>("SELECT tool FROM tool_calls WHERE role = ?", [ROLE]) ?? []).map((r) => r.tool.replace(/^mcp__shuriken__/, ''));
      log('tools called:', [...new Set(called)].join(', '));
      for (const never of ['roblox_playtest', 'roblox_run_luau', 'roblox_sync_push', 'roblox_call', 'Write', 'Edit', 'Bash']) expect(called, `the copilot stays in its field: ${never}`).not.toContain(never);
    } finally {
      await core.studio.setPlaying(false).catch(() => undefined);
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 30 * 60 * 1000);
});
