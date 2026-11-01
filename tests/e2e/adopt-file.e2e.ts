/**
 * Live check of plugging in a game from a PLACE FILE (Studio opens it; no model calls — a scripted
 * analyst stands in):
 *
 *   E2E=adopt-file npx vitest run -c vitest.e2e.config.ts tests/e2e/adopt-file.e2e.ts
 *
 * Writes a small place file with a script into a temp folder, plugs it in through Core.adoptGame
 * {file}: Studio opens it in a new window, the project keeps the file where it is (absolute placeFile)
 * with a copy of the original, the script comes in as a file, the study is saved. Closes that Studio
 * window at the end (a throwaway file).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { placePath } from '../../src/core/projects/project-service';
import { sandboxPlaceXml } from '../../src/core/roblox/place-template';
import { FakeProvider } from '../helpers/fake-provider';

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

describe.runIf(process.env.E2E === 'adopt-file')('plugging in a place file (live Studio)', () => {
  it('opens the file in Studio, keeps it where it is, pulls its scripts and studies it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-adopt-file-'));
    const file = join(dir, 'adopt-file-e2e.rbxlx');
    const script = `<Item class="ServerScriptService" referent="RBX90"><Properties><string name="Name">ServerScriptService</string></Properties>
<Item class="Script" referent="RBX91"><Properties><string name="Name">Main</string><ProtectedString name="Source"><![CDATA[print("hello from the file")
]]></ProtectedString></Properties></Item></Item>
</roblox>`;
    writeFileSync(file, sandboxPlaceXml('Adopt file E2E').replace('</roblox>', script), 'utf8');
    process.env.SHURIKEN_PROJECTS_DIR = mkdtempSync(join(tmpdir(), 'shuriken-adopt-file-projects-'));
    const provider = new FakeProvider({
      respond: async (req) => {
        const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
        if ('gameSummary' in props) return { gameSummary: 'A tiny test place.', systems: [{ name: 'Main', purpose: 'Prints hello.', files: ['src/ServerScriptService/Main.server.luau'] }], conventions: [], risks: [], suggestions: [], chips: [], greeting: 'I read it: one script that says hello.' };
        return null;
      },
    });
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-adopt-file-data-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', providers: [provider], integrations: false });
    await core.studio.start();
    try {
      const t0 = Date.now();
      const summary = await core.adoptGame({ file });
      const ctx = core.project!;
      expect(ctx.summary.id).toBe(summary.id);
      expect(summary.name).toBe('adopt file e2e');
      // (The app opens Studio itself; with integrations off the test does it.)
      await core.openStudioFor(ctx, file);
      const chat = core.director.chat()!;
      while (!chat.list().some((m) => m.role === 'director' && (m.data?.study === true || m.kind === 'error'))) {
        if (Date.now() - t0 > 5 * 60_000) throw new Error(`No greeting: ${JSON.stringify(chat.list().map((m) => m.text))}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      log('plugged in in', Math.round((Date.now() - t0) / 1000), 's:', chat.list().map((m) => `[${m.role}] ${m.text}`).join(' | '));
      expect(ctx.extras().placeFile).toBe(resolve(file));
      expect(placePath(ctx)).toBe(resolve(file));
      expect(ctx.extras().adopted).toMatchObject({ from: 'file', place: resolve(file) });
      expect(existsSync(join(ctx.dir, 'backups', 'original-adopt-file-e2e.rbxlx'))).toBe(true);
      expect(readFileSync(join(ctx.root, 'src', 'ServerScriptService', 'Main.server.luau'), 'utf8')).toBe('print("hello from the file")\n');
      expect(existsSync(join(ctx.dir, 'dossier.md'))).toBe(true);
    } finally {
      await core.shutdown().catch(() => undefined);
      try {
        execSync(`powershell -NoProfile -Command "Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*adopt-file-e2e.rbxlx*' } | Stop-Process -Force"`, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
  }, 10 * 60 * 1000);
});
