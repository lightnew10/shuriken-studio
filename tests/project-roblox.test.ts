import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Core } from '@core/core';
import { createRouter } from '@core/rpc/router';
import { OpenCloudAssets } from '@core/roblox/open-cloud-assets';
import { keySource, projectSecrets } from '@core/roblox/project-keys';
import { ownerKey, ownerLine, resolveUploadOwner } from '@core/roblox/upload-owner';
import { OPEN_CLOUD_KEY, choiceSettings, projectOpenCloudKey } from '@shared/roblox-keys';
import { FakeProvider } from './helpers/fake-provider';

const cores: Core[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of cores.splice(0)) await c.shutdown();
});

const vault = (entries: Record<string, string>) => async (k: string) => entries[k] ?? null;

describe("a project's own Roblox ids and Open Cloud key", () => {
  it("uses the open project's own key, else the default, and passes other secrets through", async () => {
    const store: Record<string, string> = { [OPEN_CLOUD_KEY]: 'personal', other: 'x', [projectOpenCloudKey('proj_a')]: 'community' };
    let open: string | null = 'proj_a';
    const keyed = projectSecrets(vault(store), () => open);
    expect(await keyed(OPEN_CLOUD_KEY)).toBe('community');
    expect(await keySource(vault(store), 'proj_a')).toBe('project');
    open = 'proj_b';
    expect(await keyed(OPEN_CLOUD_KEY)).toBe('personal');
    expect(await keySource(vault(store), 'proj_b')).toBe('default');
    open = null;
    expect(await keyed(OPEN_CLOUD_KEY)).toBe('personal');
    expect(await keyed('other')).toBe('x');
    expect(await keySource(vault({}), 'proj_b')).toBe('none');
    // A project key that can't be read falls back to the default instead of failing the call.
    const broken = projectSecrets(async (k) => (k === OPEN_CLOUD_KEY ? 'personal' : Promise.reject(new Error('locked'))), () => 'proj_a');
    expect(await broken(OPEN_CLOUD_KEY)).toBe('personal');
  });

  it('a choice made before a project starts sets its community or its account, never both', () => {
    expect(choiceSettings({ groupId: '30000001' })).toEqual({ robloxGroupId: '30000001', robloxUserId: null });
    expect(choiceSettings({ userId: ' 42 ' })).toEqual({ robloxGroupId: null, robloxUserId: '42' });
    expect(choiceSettings({ groupId: '7', userId: '42' })).toEqual({ robloxGroupId: '7', robloxUserId: null });
    expect(choiceSettings({ groupId: 'abc', userId: '0' })).toBeNull();
    expect(choiceSettings(undefined)).toBeNull();
  });

  it("a project's account: its community still wins, its own default account needs no id, another account is recorded", async () => {
    const owner = (o: { group?: string; user?: string; me?: string; game?: { type: 'Group' | 'User'; id: string } }) =>
      resolveUploadOwner({ projectGroup: () => o.group ?? null, projectUser: () => o.user ?? null, defaultUser: () => o.me ?? null, gameOwner: async () => o.game ?? null, defaultGroup: () => '33' });
    expect(await owner({ group: '11', user: '99', me: '42' })).toEqual({ kind: 'group', id: '11', source: 'project' });
    // A project set to an account wins over the published game's community and the default community.
    expect(await owner({ user: '99', me: '42', game: { type: 'Group', id: '22' } })).toEqual({ kind: 'user', id: '99', source: 'project' });
    expect(await owner({ user: '42', me: '42' })).toEqual({ kind: 'user', source: 'project' });
    expect(await owner({ me: '42' })).toEqual({ kind: 'group', id: '33', source: 'default' });
    expect(ownerKey({ kind: 'user', id: '99', source: 'project' })).toBe('u:99');
    expect(ownerKey({ kind: 'user', source: 'project' })).toBe('u');
    expect(ownerLine({ kind: 'user', id: '99', source: 'project' })).toBe('account 99 (set for this project)');
  });

  it("uploads for a project's other account go to that account and are recorded as its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-acct-'));
    const file = join(dir, 'Hit.ogg');
    writeFileSync(file, 'x');
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(Buffer.from(init?.body as Uint8Array).toString('utf8'));
        return new Response(JSON.stringify({ done: true, response: { assetId: '555' } }), { status: 200 });
      }),
    );
    const cloud = new OpenCloudAssets(async () => 'key');
    cloud.setOwner(async () => ({ kind: 'user', id: '99', source: 'project' }));
    const r = await cloud.upload({ file, type: 'Audio', name: 'Hit', creator: { userId: '42' } });
    expect(r).toMatchObject({ ok: true, assetId: '555', owner: 'u:99' });
    expect(bodies[0]).toContain('"creationContext":{"creator":{"userId":"99"}}');
  });

  it("the core calls Roblox with the open project's key and account, and says which key it uses", async () => {
    // Stubbed before the core is made: its uploader keeps the fetch it was made with (no call leaves the PC).
    const keys: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        // Only the uploads: the core makes other calls of its own while it starts.
        if (String(url).endsWith('/assets/v1/assets')) keys.push(String((init?.headers as Record<string, string>)['x-api-key']));
        return new Response(JSON.stringify({ done: true, response: { assetId: '1' } }), { status: 200 });
      }),
    );
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-prk-'));
    const store: Record<string, string> = { [OPEN_CLOUD_KEY]: 'personal-key' };
    const core = await Core.create({ dataDir, resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => ({}) })], integrations: false, logToDisk: false, secrets: vault(store) });
    cores.push(core);
    const project = core.createProject({ name: 'Pit', rootPath: mkdtempSync(join(tmpdir(), 'shuriken-prkp-')) });
    core.openProject(project.id);
    core.orchestrator.pause();
    core.prefs.set({ robloxCreatorId: '42' });
    const rpc = createRouter(core) as unknown as Record<string, (a?: unknown) => Promise<unknown> | unknown>;

    const before = (await rpc['uploads.owner']!()) as { key: string; projectKey: string; line: string };
    expect(before).toMatchObject({ key: 'default', projectKey: projectOpenCloudKey(project.id), line: 'your account' });

    const file = join(mkdtempSync(join(tmpdir(), 'shuriken-prkf-')), 'Hit.ogg');
    writeFileSync(file, 'x');
    await core.assetUploads.upload({ file, type: 'Audio', name: 'Hit', creator: { userId: '42' } });
    store[projectOpenCloudKey(project.id)] = 'community-key';
    await rpc['project.settings.update']!({ settings: { robloxGroupId: '30000001' } });
    await core.assetUploads.upload({ file, type: 'Audio', name: 'Hit', creator: { userId: '42' } });
    expect(keys).toEqual(['personal-key', 'community-key']);
    expect(await rpc['uploads.owner']!()).toMatchObject({ key: 'project', line: 'community 30000001 (set for this project)' });

    await rpc['project.settings.update']!({ settings: { robloxGroupId: null, robloxUserId: '99' } });
    expect(core.uploadsNow()).toEqual({ enabled: true, creatorId: '99' });
    expect(await core.uploadOwner()).toEqual({ kind: 'user', id: '99', source: 'project' });
    await rpc['project.settings.update']!({ settings: { robloxUserId: null } });
    expect(core.uploadsNow().creatorId).toBe('42');
  });
});
