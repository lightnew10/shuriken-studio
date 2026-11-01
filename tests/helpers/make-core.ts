import { afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core, type CoreOptions } from '../../src/core/core';
import { LuauToolchain, type LuauCheckResult } from '../../src/core/roblox/luau-toolchain';
import { FakeProvider, type FakeScript } from './fake-provider';

/** Toolchain stub: static analysis passes without binaries or network. */
class StubLuau extends LuauToolchain {
  constructor() {
    super(tmpdir());
  }
  override async check(): Promise<LuauCheckResult> {
    return { ok: true, problems: [], toolErrors: [], durationMs: 1 };
  }
}

/**
 * A real Core on a temp data dir and project with a scripted fake provider (the same setup as
 * tests/integration.test.ts), closed after each test of the calling file. Call it at module scope:
 *
 *   const makeCore = coreHarness();
 *
 * `extra` adds Core options (a fake web fetch for the audio tools, say).
 */
export function coreHarness(extra: Partial<CoreOptions> = {}): (script: FakeScript) => Promise<{ core: Core; provider: FakeProvider; ctx: ReturnType<Core['openProject']>; root: string; dataDir: string }> {
  const cores: Core[] = [];
  afterEach(async () => {
    for (const c of cores.splice(0)) await c.shutdown().catch(() => {});
  });
  return async (script) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-data-'));
    const provider = new FakeProvider(script);
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: 'test', providers: [provider], integrations: false, logToDisk: false, luau: new StubLuau(), ...extra });
    cores.push(core);
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const summary = core.createProject({ name: 'Test Game', rootPath: root });
    const ctx = core.openProject(summary.id);
    ctx.updateExtras({ syncMode: 'none' });
    ctx.updateSettings({ maxConcurrentAgents: 2, autonomy: 'supervised' });
    return { core, provider, ctx, root, dataDir };
  };
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 45000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A plan_add_task argument set for a task of the given role (the rest is filler the tool requires). */
export function planArgs(key: string, role: string, dependsOn: string[] = [], title = `Task ${key}`) {
  return {
    key,
    title,
    role,
    kind: 'implement' as const,
    objective: 'Implement this piece of the plan completely, with real content and checks.',
    acceptanceCriteria: ['It works'],
    verification: [{ kind: 'critic' }],
    dependsOn,
  };
}
