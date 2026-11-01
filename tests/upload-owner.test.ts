import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCloudAssets } from '../src/core/roblox/open-cloud-assets';
import { OPEN_CLOUD_KEY } from '../src/core/roblox/open-cloud-luau';
import { communityId, ownerKey, ownerLine, parseGameOwner, resolveUploadOwner } from '../src/core/roblox/upload-owner';

afterEach(() => vi.unstubAllGlobals());

describe('who owns what Shuriken uploads (communities first)', () => {
  const owner = (o: { project?: string | null; game?: { type: 'Group' | 'User'; id: string } | null; fallback?: string | null }) =>
    resolveUploadOwner({ projectGroup: () => o.project ?? null, gameOwner: async () => o.game ?? null, defaultGroup: () => o.fallback ?? null });

  it('this project\'s community, then the published game\'s owner, then the default community, then the person', async () => {
    expect(await owner({ project: '11', game: { type: 'Group', id: '22' }, fallback: '33' })).toEqual({ kind: 'group', id: '11', source: 'project' });
    expect(await owner({ game: { type: 'Group', id: '22' }, fallback: '33' })).toEqual({ kind: 'group', id: '22', source: 'game' });
    // A game published under a person uploads to that person: a community's animation won't play in it.
    expect(await owner({ game: { type: 'User', id: '42' }, fallback: '33' })).toEqual({ kind: 'user', source: 'game' });
    expect(await owner({ fallback: '33' })).toEqual({ kind: 'group', id: '33', source: 'default' });
    expect(await owner({})).toEqual({ kind: 'user', source: 'user' });
    expect(await resolveUploadOwner({ projectGroup: () => null, gameOwner: async () => Promise.reject(new Error('Studio busy')), defaultGroup: () => '33' })).toMatchObject({ kind: 'group', id: '33' });
  });

  it('reads the published game\'s owner from Studio, and an unpublished place as no owner', () => {
    expect(parseGameOwner('Group|35771234')).toEqual({ type: 'Group', id: '35771234' });
    expect(parseGameOwner('"User|42"')).toEqual({ type: 'User', id: '42' });
    expect(parseGameOwner('User|0')).toBeNull();
    expect(parseGameOwner('error')).toBeNull();
    expect(communityId(' 123 ')).toBe('123');
    expect(communityId('0')).toBeNull();
    expect(communityId('abc')).toBeNull();
    expect(ownerKey({ kind: 'group', id: '7', source: 'default' })).toBe('g:7');
    expect(ownerKey({ kind: 'user', source: 'user' })).toBe('u');
    expect(ownerLine({ kind: 'group', id: '7', source: 'game' })).toBe('community 7 (the published game belongs to it)');
  });

  it('uploads to the community named by the owner rule, records it, and says what a refused community upload needs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-owner-'));
    const file = join(dir, 'Hit.ogg');
    writeFileSync(file, 'x');
    const bodies: string[] = [];
    let status = 200;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(Buffer.from(init?.body as Uint8Array).toString('utf8'));
        return status === 200 ? new Response(JSON.stringify({ done: true, response: { assetId: '555' } }), { status: 200 }) : new Response('{"message":"Forbidden"}', { status });
      }),
    );
    const cloud = new OpenCloudAssets(async (k) => (k === OPEN_CLOUD_KEY ? 'key' : null));
    cloud.setOwner(async () => ({ kind: 'group', id: '777', source: 'default' }));
    const r = await cloud.upload({ file, type: 'Audio', name: 'Hit', creator: { userId: '42' } });
    expect(r).toMatchObject({ ok: true, assetId: '555', owner: 'g:777' });
    expect(bodies[0]).toContain('"creationContext":{"creator":{"groupId":"777"}}');
    status = 403;
    const refused = await cloud.upload({ file, type: 'Audio', name: 'Hit', creator: { userId: '42' } });
    expect(refused).toMatchObject({ ok: false, needsUser: true });
    expect(refused.error).toMatch(/community 777.*community's keys/s);
    // No rule set: the person the caller found, as before.
    status = 200;
    const plain = new OpenCloudAssets(async () => 'key');
    const plainResult = await plain.upload({ file, type: 'Audio', name: 'Hit', creator: { userId: '42' } });
    expect(plainResult).toMatchObject({ ok: true });
    expect(plainResult.owner).toBeUndefined();
    expect(bodies.at(-1)).toContain('"creator":{"userId":"42"}');
  });
});
