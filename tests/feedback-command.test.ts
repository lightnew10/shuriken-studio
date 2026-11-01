import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Core } from '@core/core';
import { createRouter } from '@core/rpc/router';
import { FakeProvider } from './helpers/fake-provider';

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown();
});

describe('/feedback', () => {
  it('goes straight to the developers’ log and the chat, and no agent runs', async () => {
    const provider = new FakeProvider({ respond: async () => ({ intent: 'chat', reply: 'should never be asked' }) });
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-fb-'));
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [provider], integrations: false, logToDisk: false });
    cores.push(core);
    core.openProject(core.createProject({ name: 'Drift', rootPath: mkdtempSync(join(tmpdir(), 'shuriken-fbp-')) }).id);
    core.orchestrator.pause();
    const rpc = createRouter(core) as unknown as Record<string, (a: unknown) => unknown>;
    rpc['chat.send']!({ text: '/feedback add a /feedback command that reaches the creator directly' });
    const chat = core.director.chat()!.list();
    expect(chat.map((m) => [m.role, m.text])).toEqual([
      ['user', '/feedback add a /feedback command that reaches the creator directly'],
      ['system', 'Sent to the creator. No agent was involved.'],
    ]);
    expect(readFileSync(join(dataDir, 'feedback.md'), 'utf8')).toMatch(/· Drift\n\nadd a \/feedback command that reaches the creator directly/);
    // In a dock too, and an empty note is only explained.
    rpc['chat.send']!({ text: '/feedback', channel: 'copilot:audio' });
    expect(core.copilots.chat('audio')!.list().at(-1)!.text).toMatch(/Write your note after \/feedback/);
    await new Promise((r) => setTimeout(r, 300));
    expect(provider.runs).toHaveLength(0);
  });
});
