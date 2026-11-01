import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreHarness } from './helpers/make-core';
import { encodeMp3 } from '../src/core/audio/mp3';
import { SoundLibrary } from '../src/core/audio/audio-library';
import { createRouter } from '../src/core/rpc/router';
import type { CallerContext } from '../src/core/capabilities/tool-registry';

// No network: Openverse and the file download are a fake fetch. The sample is an MP3 made here (a decaying C#5).

const SR = 44100;
const cowbellMp3 = encodeMp3([Float32Array.from({ length: Math.round(0.5 * SR) }, (_, i) => 0.7 * Math.exp(-i / SR / 0.08) * (Math.sin((2 * Math.PI * 554.37 * i) / SR) + 0.4 * Math.sin((2 * Math.PI * 821 * i) / SR)))]);

const record = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  title: 'POiZONE 808 COWBELL',
  creator: 'poizone',
  license: 'cc0',
  license_version: '1.0',
  license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  url: `https://cdn.freesound.org/previews/${id.slice(0, 3)}/x-hq.mp3`,
  foreign_landing_url: 'https://freesound.org/people/poizone/sounds/274246',
  filetype: 'mp3',
  duration: 500,
  filesize: cowbellMp3.length,
  source: 'freesound',
  tags: [{ name: 'cowbell' }, { name: 'phonk' }, { name: '808' }],
  ...o,
});

const IDS = {
  cow: '11111111-1111-4111-8111-111111111111',
  ogg: '22222222-2222-4222-8222-222222222222',
  rain: '33333333-3333-4333-8333-333333333333',
  by: '44444444-4444-4444-8444-444444444444',
};

const asked: string[] = [];
const webFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url = String(input);
  asked.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.openverse.org/v1/audio/?')) {
    return json({
      result_count: 4,
      results: [
        record(IDS.cow),
        record(IDS.ogg, { title: 'cowbell take', url: 'https://upload.wikimedia.org/c.ogg', filetype: 'ogg' }),
        record(IDS.rain, { title: 'rain on a tin roof', duration: 30000 }),
        record(IDS.by, { title: 'cowbell by', license: 'by' }),
      ],
    });
  }
  const one = /audio\/([0-9a-f-]{36})\/$/.exec(url);
  if (one) return json(one[1] === IDS.by ? record(IDS.by, { license: 'by', title: 'cowbell by' }) : record(one[1]!));
  if (url.startsWith('https://cdn.freesound.org/')) return new Response(new Uint8Array(cowbellMp3), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(cowbellMp3.length) } });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const makeCore = coreHarness({ webFetch });
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');
const json = <T>(r: { content: Array<{ type: string; text?: string }>; isError?: boolean }): T => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r)) as T;
};
const copilot: CallerContext = { kind: 'agent', runId: 'run_copilot', taskId: null, role: 'copilot-audio', providerId: null, allowedTools: null, drafts: true };

describe('finding and adding samples', () => {
  it('lists only CC0 and public-domain sounds it can decode, of the length asked for', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const r = await core.invokeTool('audio_sample_find', { queries: ['808 cowbell'], kind: 'oneshot' }, 'agent');
    expect(r.isError, text(r)).toBeFalsy();
    const out = text(r);
    expect(out).toContain(IDS.cow);
    expect(out).toMatch(/tags: cowbell, phonk, 808/);
    expect(out).not.toContain(IDS.ogg);
    expect(out).toMatch(/1 Ogg file left out/);
    expect(out).not.toContain(IDS.rain); // 30 s is not a one-shot
    expect(out).not.toContain(IDS.by); // CC BY is not a sample license
    expect(asked.some((u) => /license=cc0%2Cpdm/.test(u))).toBe(true);
  });

  it('adds a CC0 sample: downloads, decodes, measures its pitch, keeps its source; refuses CC BY; corrects its root', async () => {
    const { core, dataDir } = await makeCore({ respond: async () => null });
    const added = json<{ added: { id: string; kind: string; role: string; root: string; source: string; energy: string } }>(await core.invokeTool('audio_sample_add', { id: IDS.cow, name: '808 cowbell' }, 'agent'));
    expect(added.added).toMatchObject({ id: '808-cowbell', kind: 'oneshot', role: 'cowbell' });
    expect(added.added.root).toMatch(/^C#5/);
    expect(added.added.source).toMatch(/^CC0 1\.0, "POiZONE 808 COWBELL" by poizone, https:\/\/freesound\.org/);
    expect(existsSync(join(dataDir, 'samples', 'web', '808-cowbell.wav'))).toBe(true);
    const by = await core.invokeTool('audio_sample_add', { id: IDS.by }, 'agent');
    expect(by.isError).toBe(true);
    expect(text(by)).toMatch(/samples take only CC0 or public domain/);
    const fixed = json<{ updated: { root: string } }>(await core.invokeTool('audio_sample_add', { sample: '808-cowbell', root: 'D5' }, 'agent'));
    expect(fixed.updated.root).toBe('D5');
    const both = await core.invokeTool('audio_sample_add', { id: IDS.cow, sample: '808-cowbell' }, 'agent');
    expect(text(both)).toMatch(/either id .* or sample/);
    const list = json<{ samples: Array<{ id: string }>; folders: { yours: string } }>(await core.invokeTool('audio_samples', {}, 'agent'));
    expect(list.samples.map((s) => s.id)).toEqual(expect.arrayContaining(['808-cowbell', 'tr808-cowbell', 'tr808-kick', 'vinyl-crackle']));
    expect(list.folders.yours).toBe(join(dataDir, 'samples', 'My samples'));
    // The Audio page can list and play them.
    const rpc = createRouter(core) as unknown as Record<string, (a?: unknown) => Promise<unknown> | unknown>;
    expect(((await rpc['audio.samples']!({ role: 'cowbell' })) as { ok: boolean; text: string }).text).toContain('808-cowbell');
    expect(String(await rpc['audio.sampleFile']!({ id: '808-cowbell' }))).toMatch(/^data:audio\/wav;base64,UklGR/);
    expect(String(await rpc['audio.sampleFile']!({ id: 'tr808-clap' }))).toMatch(/^data:audio\/wav;base64,/);
  });
});

describe('composing with samples and editing the score', () => {
  it('puts a sample on a part, keeps a copy in the project, lists it in the credits, and edits the score', async () => {
    const { core, root } = await makeCore({ respond: async () => null });
    json(await core.invokeTool('audio_sample_add', { id: IDS.cow, name: '808 cowbell' }, 'agent'));
    const made = json<{ name: string; draft: boolean; parts: string[]; edit: string; check: { ok: boolean; summary: string }; analysis: { heard: string; sections: string[]; improve: string[]; next: string } }>(
      await core.invokeTool('audio_music', { name: 'Drift', style: 'phonk', bars: 12, seed: 3, samples: { cowbell: '808-cowbell' } }, 'ui'),
    );
    expect(made.draft).toBe(true);
    // The song is listened to, like a sound effect: what it measures as, and what to change.
    expect(made.analysis.heard).toMatch(/cowbell \d+\/\d+%/);
    expect(made.analysis.sections).toHaveLength(4);
    expect(Array.isArray(made.analysis.improve)).toBe(true);
    expect(made.check.ok, made.check.summary).toBe(true);
    expect(made.parts[0]).toBe('0 cowbell (sample 808-cowbell)');
    expect(made.edit).toMatch(/audio_music_edit/);
    expect(existsSync(join(root, 'assets', 'audio', 'samples', '808-cowbell.wav'))).toBe(true);
    expect(new SoundLibrary(root).get('Drift')!.samples).toEqual([expect.objectContaining({ id: '808-cowbell', source: 'web', license: 'cc0', creator: 'poizone' })]);
    expect(readFileSync(join(root, 'audio', 'CREDITS.md'), 'utf8')).toMatch(/## Samples in composed songs[\s\S]*808 cowbell \(808-cowbell\): poizone, CC0 1\.0, https:\/\/freesound\.org/);

    const score = json<{ sections: string[]; tracks: Array<{ track: number; name: string; sample?: string }> }>(await core.invokeTool('audio_score', { name: 'Drift' }, 'ui'));
    expect(score.sections).toEqual(['Intro 1-2', 'Drop 3-6', 'Breakdown 7-8', 'Drop 2 9-12']);
    expect(score.tracks[0]).toMatchObject({ name: 'cowbell', sample: '808-cowbell' });

    const edited = json<{ name: string; changes: string[]; check: { ok: boolean; summary: string }; draft: boolean }>(
      await core.invokeTool(
        'audio_music_edit',
        { name: 'Drift', ops: [{ op: 'thin', track: 'hat', keep: 'beats', section: 'Breakdown' }, { op: 'set', track: 'pad', sample: 'vinyl-crackle', instrument: 'texture' }, { op: 'riser', at: 9 }, { op: 'song', tape: { wow: 0.3 } }] },
        'ui',
      ),
    );
    expect(edited.name).toBe('Drift'); // a draft is edited in place
    expect(edited.draft).toBe(true);
    expect(edited.changes).toHaveLength(4);
    expect(edited.check.ok, edited.check.summary).toBe(true);
    const song = JSON.parse(readFileSync(join(root, 'assets', 'audio', 'music', 'drift.song.json'), 'utf8'));
    expect(song.seed).toBe(3);
    expect(song.tape).toEqual({ wow: 0.3 });
  }, 120_000);

  it('refuses a malformed edit with a clear error, and an edit from the dock of a game song makes a new draft', async () => {
    const { core } = await makeCore({ respond: async () => null });
    json(await core.invokeTool('audio_music', { name: 'Theme', style: 'lofi', bars: 4, seed: 2, why: 'user_asked', upload: false }, 'agent'));
    const typo = await core.invokeTool('audio_music_edit', { name: 'Theme', ops: [{ op: 'set', track: 'bass', volum: 0.5 }] }, 'agent');
    expect(typo.isError).toBe(true);
    expect(text(typo)).toMatch(/volum/);
    const noTrack = await core.invokeTool('audio_music_edit', { name: 'Theme', ops: [{ op: 'clear', track: 'tuba' }] }, 'agent');
    expect(text(noTrack)).toMatch(/ops\[0\] \(clear\): No track "tuba"/);
    const missing = await core.invokeTool('audio_music_edit', { name: 'Theme', ops: [{ op: 'set', track: 'bass', sample: 'nope' }] }, 'agent');
    expect(text(missing)).toMatch(/Not in the sample library: nope/);
    const notASong = await core.invokeTool('audio_score', { name: 'Nothing' }, 'agent');
    expect(text(notASong)).toMatch(/No sound named Nothing/);
    const draft = json<{ name: string; draft: boolean; editedFrom: string }>(await core.tools.invoke('audio_music_edit', { name: 'Theme', ops: [{ op: 'velocity', track: 'all', scale: 0.8 }] }, copilot));
    expect(draft).toMatchObject({ name: 'Theme2', draft: true, editedFrom: 'Theme' });
  }, 120_000);
});
