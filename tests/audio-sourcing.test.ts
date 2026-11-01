import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Core } from '../src/core/core';
import { LuauToolchain, type LuauCheckResult } from '../src/core/roblox/luau-toolchain';
import { FakeProvider } from './helpers/fake-provider';
import { SoundLibrary, creditsMarkdown, type SoundEntry } from '../src/core/audio/audio-library';
import { OpenverseClient, checkUrl, downloadTrack, formatOf, parseOpenverse, trackFromRecord } from '../src/core/audio/sourcing';
import { probeAudio, sniffFormat } from '../src/core/audio/probe';
import { encodeMp3 } from '../src/core/audio/mp3';
import { parseStoreResults } from '../src/core/roblox/store-search';

// No network in these tests: every fetch below is a fake.

// ─── Audio bytes ────────────────────────────────────────────────────────────

/** An 8-bit mono WAV of silence (small and exact: byte rate = sample rate). */
function wav(sec: number, rate = 8000): Buffer {
  const n = Math.round(sec * rate);
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  return b;
}

function flac(sec: number, rate = 44100): Buffer {
  const b = Buffer.alloc(8 + 34 + 16);
  b.write('fLaC', 0);
  b[4] = 0x80; // last metadata block, STREAMINFO
  b.writeUIntBE(34, 5, 3);
  b.writeUInt16BE(4096, 8);
  b.writeUInt16BE(4096, 10);
  const v = (BigInt(rate) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(Math.round(sec * rate));
  b.writeBigUInt64BE(v, 18);
  return b;
}

function oggPage(type: number, granule: bigint, body: Buffer): Buffer {
  const h = Buffer.alloc(28);
  h.write('OggS', 0);
  h[5] = type;
  h.writeBigInt64LE(granule, 6);
  h[26] = 1;
  h[27] = body.length;
  return Buffer.concat([h, body]);
}

function ogg(sec: number, rate = 44100, codec: 'vorbis' | 'opus' = 'vorbis'): Buffer {
  const id = Buffer.alloc(30);
  if (codec === 'vorbis') {
    id[0] = 1;
    id.write('vorbis', 1);
    id[11] = 2;
    id.writeUInt32LE(rate, 12);
  } else {
    id.write('OpusHead', 0);
    id[9] = 2;
    id.writeUInt32LE(rate, 12);
  }
  return Buffer.concat([oggPage(2, 0n, id), oggPage(4, BigInt(Math.round(sec * rate)), Buffer.alloc(10))]);
}

function mp3(sec: number): Buffer {
  const n = Math.round(sec * 44100);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100);
  return Buffer.from(encodeMp3([pcm]));
}

// ─── Fake web ───────────────────────────────────────────────────────────────

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: string[]; inits: Array<RequestInit | undefined> } {
  const calls: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(String(input));
    inits.push(init);
    return handler(String(input), init);
  }) as typeof fetch;
  return { fetch: f, calls, inits };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const audioRes = (bytes: Buffer, type = 'audio/wav', headers: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type, ...headers } });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rec = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  title: `Track ${n}`,
  foreign_landing_url: `https://freesound.org/people/someone/sounds/${n}`,
  url: `https://cdn.freesound.org/previews/${n}/${n}-hq.mp3`,
  creator: 'Someone',
  creator_url: 'https://freesound.org/people/someone',
  license: 'cc0',
  license_version: '1.0',
  license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  provider: 'freesound',
  source: 'freesound',
  category: 'music',
  filesize: 238038,
  filetype: 'mp3',
  duration: 3000,
  mature: false,
  ...over,
});

describe('Openverse results', () => {
  it('keeps only tracks a game may use, and says what it left out', () => {
    const { tracks, dropped, total } = parseOpenverse({
      result_count: 12,
      results: [
        rec(1),
        rec(2, { license: 'by-sa', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', filetype: 'wav', url: 'https://upload.wikimedia.org/a/b/Phonk.wav' }),
        rec(3, { license: 'by-nc' }),
        rec(4, { license: 'by-nd' }),
        rec(5, { license: 'sampling+' }),
        rec(6, { license: 'by-nc-sa' }),
        rec(7, { mature: true }),
        rec(8, { url: 'http://cdn.freesound.org/8.mp3' }),
        rec(9, { filesize: 30 * 1024 * 1024 }),
        rec(10, { duration: 8 * 60 * 1000 }),
        rec(11, { url: 'https://cdn.example.com/11.m4a', filetype: 'm4a' }),
        rec(12, { filetype: 'ogx', url: 'https://upload.wikimedia.org/x/Phonk_sample.ogg', creator: null, license: 'pdm', license_version: '1.0' }),
        rec(1),
        null,
      ],
    });
    expect(tracks.map((t) => t.id)).toEqual([uuid(1), uuid(2), uuid(12)]);
    expect(total).toBe(12);
    expect(dropped).toEqual({ license: 4, mature: 1, url: 1, size: 1, duration: 1, format: 1, unreadable: 1 });
    expect(tracks[1]).toMatchObject({ license: 'by-sa', licenseName: 'CC BY-SA 4.0', format: 'wav', durationSec: 3, origin: 'freesound' });
    expect(tracks[1]!.attribution).toBe('"Track 2" by Someone, licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Source: https://freesound.org/people/someone/sounds/2');
    // The file's type comes from its URL (Wikimedia calls an .ogg an "ogx"); no creator is said so.
    expect(tracks[2]).toMatchObject({ format: 'ogg', creator: 'unknown (freesound)', licenseName: 'Public Domain Mark 1.0' });
    expect(tracks[2]!.attribution).toContain('marked Public Domain Mark 1.0');
  });

  it('never lets a license that is not commercial-use through, whatever the case', () => {
    for (const license of ['by-nc', 'by-nd', 'by-nc-nd', 'by-nc-sa', 'nc-sampling+', 'sampling+', 'sa', 'all-rights-reserved', '', 'BY-NC'])
      expect(trackFromRecord(rec(1, { license })), license).toEqual({ dropped: 'license' });
    for (const license of ['cc0', 'pdm', 'by', 'by-sa', 'BY']) expect('track' in trackFromRecord(rec(1, { license })), license).toBe(true);
    expect(formatOf('https://x.org/a/b.OGG')).toBe('ogg');
    expect(formatOf('https://x.org/stream?id=4', 'mp3')).toBe('mp3');
    expect(formatOf('https://x.org/a.zip', 'zip')).toBeNull();
  });

  it('searches with the commercial filters, remembers a search, and reports a refusal in words', async () => {
    const web = fakeFetch(() => json({ result_count: 2, results: [rec(1), rec(3, { license: 'by-nc' })] }));
    const client = new OpenverseClient(web.fetch);
    const r = await client.search('drift phonk', 5);
    expect('tracks' in r && r.tracks.map((t) => t.id)).toEqual([uuid(1)]);
    const url = new URL(web.calls[0]!);
    expect(url.origin + url.pathname).toBe('https://api.openverse.org/v1/audio/');
    expect(url.searchParams.get('q')).toBe('drift phonk');
    expect(url.searchParams.get('license_type')).toBe('commercial');
    expect(url.searchParams.get('license')).toBe('cc0,pdm,by,by-sa');
    expect((web.inits[0]!.headers as Record<string, string>)['user-agent']).toMatch(/Shuriken/);
    await client.search('Drift Phonk ', 5);
    expect(web.calls).toHaveLength(1);

    const limited = await new OpenverseClient(fakeFetch(() => json({ detail: 'throttled' }, 429)).fetch).search('x', 5);
    expect(limited).toMatchObject({ error: expect.stringMatching(/rate-limiting/) });
    const down = await new OpenverseClient(fakeFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))).fetch).search('x', 5);
    expect(down).toMatchObject({ error: expect.stringMatching(/could not be reached.*ENOTFOUND/) });
    const broken = await new OpenverseClient(fakeFetch(() => new Response('<html>', { status: 200 })).fetch).search('x', 5);
    expect(broken).toMatchObject({ error: expect.stringMatching(/unreadable/) });
    const err = await new OpenverseClient(fakeFetch(() => json({}, 503)).fetch).search('x', 5);
    expect(err).toMatchObject({ error: 'Openverse answered HTTP 503' });
  });

  it('looks a track up by id and refuses one whose license or file is not usable', async () => {
    const records = new Map<string, unknown>([
      [uuid(1), rec(1, { license: 'by', license_version: '4.0' })],
      [uuid(2), rec(2, { license: 'by-nc' })],
      [uuid(3), rec(3, { duration: 10 * 60 * 1000 })],
    ]);
    const web = fakeFetch((url) => {
      const id = /\/audio\/([^/]+)\/$/.exec(url)?.[1];
      return id && records.has(id) ? json(records.get(id)) : json({}, 404);
    });
    const client = new OpenverseClient(web.fetch);
    expect(await client.lookup(uuid(1))).toMatchObject({ track: { id: uuid(1), licenseName: 'CC BY 4.0' } });
    expect(web.calls[0]).toBe(`https://api.openverse.org/v1/audio/${uuid(1)}/`);
    expect(await client.lookup(uuid(2))).toMatchObject({ error: expect.stringMatching(/license is not one a game may use/) });
    expect(await client.lookup(uuid(3))).toMatchObject({ error: expect.stringMatching(/longer than 7 minutes/) });
    expect(await client.lookup(uuid(9))).toMatchObject({ error: 'Openverse answered HTTP 404' });
    // Not an id at all: no request is made (a path trick cannot reach another endpoint).
    const before = web.calls.length;
    expect(await client.lookup('../../v1/images')).toMatchObject({ error: expect.stringMatching(/not an Openverse id/) });
    expect(await client.lookup('12345')).toMatchObject({ error: expect.stringMatching(/audio_add/) });
    expect(web.calls).toHaveLength(before);
  });

  it('structures Creator Store results without losing the compact form', () => {
    const raw = JSON.stringify({ results: [{ assetId: '7', name: 'epic   battle', creatorName: 'APM Music', description: 'Audio', isFree: true }, { assetId: '8', name: 'paid', isFree: false }] });
    expect(parseStoreResults(raw, 'Audio', new Set())).toEqual([{ assetId: '7', name: 'epic battle', creator: 'APM Music', description: '' }]);
  });
});

describe('download checks', () => {
  it('allows only public https hosts', () => {
    expect(checkUrl('https://cdn.freesound.org/previews/1/1-hq.mp3').ok).toBe(true);
    for (const bad of [
      'http://cdn.freesound.org/a.mp3',
      'ftp://example.com/a.mp3',
      'file:///C:/Windows/a.mp3',
      'https://localhost/a.mp3',
      'https://a.localhost/a.mp3',
      'https://intranet/a.mp3',
      'https://printer.local/a.mp3',
      'https://127.0.0.1/a.mp3',
      'https://10.1.2.3/a.mp3',
      'https://192.168.0.5/a.mp3',
      'https://172.16.0.1/a.mp3',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/a.mp3',
      'https://[fd00::1]/a.mp3',
      'https://user:pass@cdn.freesound.org/a.mp3',
      'https://cdn.freesound.org:8443/a.mp3',
      'not a url',
    ])
      expect(checkUrl(bad).ok, bad).toBe(false);
  });

  it('reads what a file is and how long it plays from its bytes', () => {
    expect(probeAudio(wav(2))).toMatchObject({ ok: true, format: 'wav', durationSec: 2, sampleRate: 8000, channels: 1 });
    expect(probeAudio(flac(3.5))).toMatchObject({ ok: true, format: 'flac', durationSec: 3.5, sampleRate: 44100, channels: 2 });
    expect(probeAudio(ogg(4))).toMatchObject({ ok: true, format: 'ogg', durationSec: 4, sampleRate: 44100, channels: 2 });
    const m = probeAudio(mp3(2));
    expect(m.ok && m.format).toBe('mp3');
    expect(m.ok && Math.abs(m.durationSec - 2)).toBeLessThan(0.2);
    // An ID3 tag in front is skipped.
    const tag = Buffer.alloc(10 + 300);
    tag.write('ID3', 0);
    tag[3] = 3;
    tag[8] = 2; // size 300 as a syncsafe integer: 2 * 128 + 44
    tag[9] = 44;
    const tagged = probeAudio(Buffer.concat([tag, mp3(1)]));
    expect(tagged.ok && tagged.format).toBe('mp3');
    // Not audio, or not audio Roblox takes.
    expect(probeAudio(Buffer.from('<!doctype html><html><body>Download</body></html>'))).toMatchObject({ ok: false, error: expect.stringMatching(/not an MP3/) });
    expect(probeAudio(ogg(2, 48000, 'opus'))).toMatchObject({ ok: false, error: expect.stringMatching(/Opus/) });
    const adpcm = wav(1);
    adpcm.writeUInt16LE(2, 20);
    expect(probeAudio(adpcm)).toMatchObject({ ok: false, error: expect.stringMatching(/compressed/) });
    expect(sniffFormat(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff'))).toBeNull();
    // A WAV whose header promises more than the file holds counts what is there.
    const cut = wav(2);
    cut.writeUInt32LE(0xffffffff, 40);
    expect(probeAudio(cut)).toMatchObject({ ok: true, durationSec: 2 });
  });

  it('downloads a good track', async () => {
    const web = fakeFetch(() => audioRes(wav(2)));
    const got = await downloadTrack('https://cdn.freesound.org/a.wav', web.fetch);
    expect(got).toMatchObject({ ok: true, format: 'wav', durationSec: 2, finalUrl: 'https://cdn.freesound.org/a.wav' });
    expect(web.calls).toEqual(['https://cdn.freesound.org/a.wav']);
    expect((web.inits[0] as RequestInit).redirect).toBe('manual');
  });

  it('refuses what is too big, too long, not audio or not https, before saving anything', async () => {
    const run = (h: Handler, url = 'https://cdn.freesound.org/a.wav', o = {}) => downloadTrack(url, fakeFetch(h).fetch, o);
    const err = async (p: ReturnType<typeof run>) => {
      const r = await p;
      return r.ok ? 'ok' : r.error;
    };
    // The size is declared too big: the body is never read.
    expect(await err(run(() => audioRes(wav(1), 'audio/wav', { 'content-length': String(30 * 1024 * 1024) })))).toMatch(/Too large: 30\.0 MB/);
    // No size declared: it is cut off as it grows past the limit.
    expect(await err(run(() => audioRes(wav(1)), 'https://cdn.freesound.org/a.wav', { maxBytes: 4000 }))).toMatch(/Too large: over/);
    // Longer than 7 minutes (7:30 of 8 kHz 8-bit audio is 3.6 MB).
    expect(await err(run(() => audioRes(wav(450))))).toMatch(/Too long: 7:30/);
    expect(await err(run(() => audioRes(wav(3)), 'https://cdn.freesound.org/a.wav', { maxSeconds: 2 }))).toMatch(/Too long: 0:03/);
    // A web page, a renamed file, a failed request.
    expect(await err(run(() => new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })))).toMatch(/web page/);
    expect(await err(run(() => audioRes(Buffer.from('hello, this is not audio at all'), 'audio/mpeg')))).toMatch(/not an MP3, Ogg Vorbis, WAV or FLAC/);
    expect(await err(run(() => new Response('', { status: 404 })))).toMatch(/HTTP 404/);
    // Not https, or a private host: refused without a request.
    const web = fakeFetch(() => audioRes(wav(1)));
    for (const url of ['http://cdn.freesound.org/a.wav', 'https://127.0.0.1/a.wav', 'https://localhost/a.wav']) {
      const r = await downloadTrack(url, web.fetch);
      expect(r.ok, url).toBe(false);
    }
    expect(web.calls).toHaveLength(0);
  });

  it('follows redirects only to places it would have fetched anyway', async () => {
    const hop = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    const chain = fakeFetch((url) => (url.endsWith('/start') ? hop('/moved.wav') : url.endsWith('/moved.wav') ? hop('https://files.example.org/real.wav') : audioRes(wav(1))));
    expect(await downloadTrack('https://cdn.freesound.org/start', chain.fetch)).toMatchObject({ ok: true, finalUrl: 'https://files.example.org/real.wav' });
    expect(chain.calls).toEqual(['https://cdn.freesound.org/start', 'https://cdn.freesound.org/moved.wav', 'https://files.example.org/real.wav']);
    for (const target of ['http://cdn.freesound.org/a.wav', 'https://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data']) {
      const web = fakeFetch((url) => (url === 'https://cdn.freesound.org/start' ? hop(target) : audioRes(wav(1))));
      const r = await downloadTrack('https://cdn.freesound.org/start', web.fetch);
      expect(r.ok, target).toBe(false);
      expect(web.calls, target).toEqual(['https://cdn.freesound.org/start']);
    }
    const loop = await downloadTrack('https://cdn.freesound.org/loop', fakeFetch(() => hop('https://cdn.freesound.org/loop')).fetch);
    expect(loop).toMatchObject({ ok: false, error: expect.stringMatching(/Too many redirects/) });
  });

  it('gives up on a download that stalls', async () => {
    const stalled: Handler = (_url, init) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
      });
    const r = await downloadTrack('https://cdn.freesound.org/a.wav', fakeFetch(stalled).fetch, { stallMs: 40 });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/stalled/) });
    // A slow server is fine while bytes keep coming; only silence or the overall limit stops it.
    const trickle: Handler = () => {
      const bytes = wav(1);
      let at = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            await new Promise((r) => setTimeout(r, 15));
            if (at >= bytes.length) return c.close();
            c.enqueue(new Uint8Array(bytes.subarray(at, (at += 2000))));
          },
        }),
        { headers: { 'content-type': 'audio/wav' } },
      );
    };
    const seen: number[] = [];
    const slow = await downloadTrack('https://cdn.freesound.org/a.wav', fakeFetch(trickle).fetch, { stallMs: 100, onProgress: (n) => seen.push(n) });
    expect(slow).toMatchObject({ ok: true, durationSec: 1 });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)).toBe(8044);
    expect(await downloadTrack('https://cdn.freesound.org/a.wav', fakeFetch(trickle).fetch, { stallMs: 100, timeoutMs: 30 })).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) });
  });
});

describe('credits file', () => {
  it('lists every imported sound with title, creator, license and URL', () => {
    const credit = (license: string, over: Record<string, unknown> = {}) => ({ title: 'Phonk Bell', creator: 'Johnnie', license, licenseName: license === 'by' ? 'CC BY 4.0' : 'CC0 1.0', licenseUrl: 'https://creativecommons.org/licenses/x/', sourceUrl: 'https://freesound.org/s/1', downloadUrl: 'https://cdn.freesound.org/1.mp3', attribution: '"Phonk Bell" by Johnnie', importedAt: '', ...over });
    const sounds = [
      { name: 'Bell', kind: 'sfx', source: 'imported', assetId: null, volume: 0.6, looped: false, credit: credit('cc0'), durationSec: 3, updatedAt: '' },
      { name: 'Theme', kind: 'music', source: 'imported', assetId: null, volume: 0.45, looped: true, draft: true, credit: credit('by', { title: 'Night Drive', creator: 'Ana' }), durationSec: 151, updatedAt: '' },
      { name: 'Jump', kind: 'sfx', source: 'generated', assetId: null, volume: 0.6, looped: false, updatedAt: '' },
    ] as SoundEntry[];
    const md = creditsMarkdown(sounds);
    expect(md).toContain('## Bell (sfx, 0:03)');
    expect(md).toContain('## Theme (music, 2:31) - a draft, not in the game yet');
    expect(md).toContain('- Creator: Ana');
    expect(md).toContain('- License: CC BY 4.0 (https://creativecommons.org/licenses/x/) - credit required');
    expect(md).toContain('- License: CC0 1.0 (https://creativecommons.org/licenses/x/) - no credit required');
    expect(md).toContain('- Source: https://freesound.org/s/1');
    expect(md).not.toContain('Jump');
    expect(creditsMarkdown([sounds[2]!])).toBe('');
  });
});

// ─── The tools ──────────────────────────────────────────────────────────────

class StubLuau extends LuauToolchain {
  constructor() {
    super(tmpdir());
  }
  override async check(): Promise<LuauCheckResult> {
    return { ok: true, problems: [], toolErrors: [], durationMs: 1 };
  }
}

describe('audio_find and audio_import', () => {
  let core: Core;
  let root: string;
  beforeAll(async () => {
    core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-data-')), resourcesDir: resolve(__dirname, '..', 'resources'), appVersion: 'test', providers: [new FakeProvider({ respond: async () => null })], integrations: false, logToDisk: false, luau: new StubLuau() });
    root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const ctx = core.openProject(core.createProject({ name: 'Audio Sourcing', rootPath: root }).id);
    ctx.updateExtras({ syncMode: 'none' });
  });
  afterAll(async () => {
    await core.shutdown().catch(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? '').join('');
  const lib = () => new SoundLibrary(root);

  /** A web where Openverse knows a few tracks and each has a file at its URL. */
  function web(extra?: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) {
    const records = new Map<string, Record<string, unknown>>([
      [uuid(1), rec(1, { title: 'Night Drive', creator: 'Ana', license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', url: 'https://cdn.freesound.org/previews/1/1-hq.wav', filetype: 'wav' })],
      [uuid(2), rec(2, { title: 'Bell', creator: 'Bo', url: 'https://cdn.freesound.org/previews/2/2-hq.wav', filetype: 'wav' })],
      [uuid(3), rec(3, { license: 'by-nc', url: 'https://cdn.freesound.org/previews/3/3-hq.wav', filetype: 'wav' })],
      [uuid(4), rec(4, { url: 'https://cdn.freesound.org/previews/4/4-hq.wav', filetype: 'wav' })],
    ]);
    const f = fakeFetch(async (url, init) => {
      const extraRes = extra && (await extra(url, init));
      if (extraRes) return extraRes;
      if (url.startsWith('https://api.openverse.org/v1/audio/?')) return json({ result_count: 4, results: [...records.values()] });
      const id = /\/v1\/audio\/([^/?]+)\/$/.exec(url)?.[1];
      if (id) return records.has(id) ? json(records.get(id)) : json({}, 404);
      if (url.endsWith('/1-hq.wav')) return audioRes(wav(3));
      if (url.endsWith('/2-hq.wav')) return audioRes(wav(1));
      if (url.endsWith('/4-hq.wav')) return new Response('<html>Please log in</html>', { headers: { 'content-type': 'text/html' } });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', f.fetch);
    return f;
  }

  it('audio_find lists Creator Store hits (licensed libraries first) and licensed Openverse tracks', async () => {
    const w = web();
    vi.spyOn(core.studio, 'connected', 'get').mockReturnValue(true);
    const call = vi.spyOn(core.studio, 'call').mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: JSON.stringify({ results: [{ assetId: '555', name: 'Some user track', creatorName: 'randomguy', isFree: true }, { assetId: '777', name: 'Epic Battle', creatorName: 'APM Music', isFree: true }] }) }],
    } as Awaited<ReturnType<typeof core.studio.call>>);
    const r = await core.invokeTool('audio_find', { queries: ['epic battle music'] }, 'agent');
    expect(r.isError, text(r)).toBeFalsy();
    const out = text(r);
    expect(call.mock.calls[0]![1]).toMatchObject({ query: 'epic battle music', scope: 'creator_store', assetType: 'Audio', priceFilter: 'free' });
    expect(out.indexOf('777 | Epic Battle | APM Music (licensed library, cleared)')).toBeGreaterThan(-1);
    expect(out.indexOf('777 |')).toBeLessThan(out.indexOf('555 |'));
    expect(out).toContain(`${uuid(1)} | "Night Drive" | Ana | 0:03 | CC BY 4.0 (credit required) | wav`);
    expect(out).toContain('page https://freesound.org/people/someone/sounds/1 | file https://cdn.freesound.org/previews/1/1-hq.wav');
    // The non-commercial one is not offered.
    expect(out).not.toContain(uuid(3));
    expect(out).toMatch(/Openverse: left out 1 license/);
    // The same search again does not use the web a second time.
    const again = await core.invokeTool('audio_find', { queries: ['epic battle music'], sources: ['openverse'] }, 'agent');
    expect(again.isError).toBeFalsy();
    expect(w.calls.filter((u) => u.includes('/v1/audio/?'))).toHaveLength(1);
  });

  it('audio_find still answers when Studio is away or Openverse refuses', async () => {
    web((url) => (url.includes('/v1/audio/?') ? json({}, 429) : undefined));
    const r = await core.invokeTool('audio_find', { queries: ['rain loop'] }, 'agent');
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/Studio is not connected/);
    expect(text(r)).toMatch(/rate-limiting/);
    expect(text(r)).toMatch(/Nothing found/);
  });

  it('audio_find gets past a query the firewall refuses and one that matches nothing, and asks the other queries anyway', async () => {
    // Openverse as measured: a challenge page for any query with "outdoor" in it, nothing for long queries.
    const challenge = () => new Response('<!DOCTYPE html><title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' } });
    const w = web((url) => {
      if (!url.includes('/v1/audio/?')) return undefined;
      const q = new URL(url).searchParams.get('q')!;
      if (/outdoor|forbidden/.test(q)) return challenge();
      if (q.split(' ').length > 2) return json({ result_count: 0, results: [] });
      return undefined;
    });
    const r = await core.invokeTool('audio_find', { queries: ['distant machinery outdoor ambience loop', 'forbidden', 'bell'], sources: ['openverse'] }, 'agent');
    expect(r.isError, text(r)).toBeFalsy();
    const out = text(r);
    const asked = w.calls.filter((u) => u.includes('/v1/audio/?')).map((u) => new URL(u).searchParams.get('q'));
    // "outdoor" is never sent; the long query is shortened until something matches; the one-word refusal is reported and the search goes on.
    expect(asked).toEqual(['distant machinery outside ambience loop', 'distant machinery outside', 'distant machinery', 'forbidden', 'bell']);
    expect(out).toMatch(/firewall refuses the word "outdoor"|Nothing on Openverse matches every word of "distant machinery outdoor ambience loop": these match "distant machinery"/);
    expect(out).toMatch(/firewall refused this search \(HTTP 403, a Cloudflare challenge page/);
    expect(out).toContain(`${uuid(1)} | "Night Drive"`);
    // A refusal that is not about the words (the quota) still ends the search at once.
    const quota = web((url) => (url.includes('/v1/audio/?') ? json({}, 429) : undefined));
    await core.invokeTool('audio_find', { queries: ['one thing', 'another thing'], sources: ['openverse'] }, 'agent');
    expect(quota.calls.filter((u) => u.includes('/v1/audio/?'))).toHaveLength(1);
  });

  it('audio_import brings a CC BY track in: file, entry with its credit, CREDITS.md, builder', async () => {
    const w = web();
    const r = await core.invokeTool('audio_import', { name: 'NightDrive', kind: 'music', id: `openverse:${uuid(1)}` }, 'agent');
    expect(r.isError, text(r)).toBeFalsy();
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ name: 'NightDrive', kind: 'music', file: 'assets/audio/imported/nightdrive.wav', durationSec: 3, format: 'wav', credit: { title: 'Night Drive', creator: 'Ana', license: 'CC BY 4.0', creditRequired: true, file: 'audio/CREDITS.md' } });
    expect(out.mention).toMatch(/Night Drive.*Ana.*CC BY 4\.0.*needs a credit line/);
    // The license was looked up again, then the file fetched from the URL Openverse gave.
    expect(w.calls).toEqual([`https://api.openverse.org/v1/audio/${uuid(1)}/`, 'https://cdn.freesound.org/previews/1/1-hq.wav']);
    expect(existsSync(join(root, 'assets/audio/imported/nightdrive.wav'))).toBe(true);
    const e = lib().get('NightDrive')!;
    expect(e).toMatchObject({ source: 'imported', kind: 'music', looped: true, volume: 0.45, file: 'assets/audio/imported/nightdrive.wav', credit: { license: 'by', licenseName: 'CC BY 4.0', creator: 'Ana', sourceUrl: 'https://freesound.org/people/someone/sounds/1', downloadUrl: 'https://cdn.freesound.org/previews/1/1-hq.wav' } });
    expect(e.draft).toBeUndefined();
    expect(e.check).toMatch(/imported wav, 0:03/);
    const credits = readFileSync(join(root, 'audio/CREDITS.md'), 'utf8');
    expect(credits).toContain('## NightDrive (music, 0:03)');
    expect(credits).toContain('- Creator: Ana');
    expect(credits).toContain('credit required');
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).toContain('name="NightDrive"');
    // It is in the library's listing with its license.
    const list = JSON.parse(text(await core.invokeTool('audio_list', {}, 'agent')));
    expect(list.sounds.find((s: { name: string }) => s.name === 'NightDrive')).toMatchObject({ source: 'imported', license: 'CC BY 4.0', creator: 'Ana', creditRequired: true });
  }, 30000);

  it('audio_import from the dock is a draft, listed in the credits as one, and audio_use puts it in the game', async () => {
    web();
    const r = await core.invokeTool('audio_import', { name: 'Bell', kind: 'sfx', id: uuid(2) }, 'ui');
    expect(r.isError, text(r)).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ name: 'Bell', draft: true, credit: { license: 'CC0 1.0', creditRequired: false } });
    expect(lib().get('Bell')).toMatchObject({ draft: true, looped: false, volume: 0.6, source: 'imported' });
    expect(readFileSync(join(root, 'audio/CREDITS.md'), 'utf8')).toContain('## Bell (sfx, 0:01) - a draft, not in the game yet');
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).not.toContain('name="Bell"');
    const used = await core.invokeTool('audio_use', { name: 'Bell' }, 'ui');
    expect(used.isError, text(used)).toBeFalsy();
    expect(lib().get('Bell')!.draft).toBeUndefined();
    expect(readFileSync(join(root, 'world/Audio.luau'), 'utf8')).toContain('name="Bell"');
    expect(readFileSync(join(root, 'audio/CREDITS.md'), 'utf8')).not.toContain('a draft');
    // Taking the sound out takes its credit out; the file stays like any generated one.
    await core.invokeTool('audio_remove', { name: 'Bell' }, 'ui');
    expect(readFileSync(join(root, 'audio/CREDITS.md'), 'utf8')).not.toContain('Bell');
  }, 30000);

  it('audio_import refuses without a clear commercial-use license, and saves nothing', async () => {
    const w = web();
    const before = lib().names();
    const refuse = async (args: Record<string, unknown>) => {
      const r = await core.invokeTool('audio_import', { kind: 'sfx', ...args }, 'agent');
      expect(r.isError, JSON.stringify(args)).toBe(true);
      return text(r);
    };
    // Openverse says non-commercial: no download is even attempted.
    expect(await refuse({ name: 'NcTrack', id: uuid(3) })).toMatch(/license is not one a game may use/);
    expect(w.calls.some((u) => u.endsWith('/3-hq.wav'))).toBe(false);
    // The file at the URL is a web page.
    expect(await refuse({ name: 'Page', id: uuid(4) })).toMatch(/web page/);
    // A Creator Store id, an unknown id, neither or both of id and url.
    expect(await refuse({ name: 'Store', id: '123456789' })).toMatch(/audio_add/);
    expect(await refuse({ name: 'Nope', id: uuid(9) })).toMatch(/HTTP 404/);
    expect(await refuse({ name: 'Nothing' })).toMatch(/either id/);
    expect(await refuse({ name: 'Both', id: uuid(1), url: 'https://cdn.freesound.org/a.wav' })).toMatch(/either id/);
    // A bare url needs its license, creator, title and page; the license is one of four.
    expect(await refuse({ name: 'Bare', url: 'https://cdn.freesound.org/previews/2/2-hq.wav' })).toMatch(/license, title, creator, source_url are required/);
    expect(await refuse({ name: 'Nc', url: 'https://cdn.freesound.org/previews/2/2-hq.wav', license: 'by-nc', title: 'x', creator: 'y', source_url: 'https://freesound.org/s/2' })).toMatch(/license|Invalid|expected/i);
    expect(await refuse({ name: 'Plain', url: 'http://cdn.freesound.org/previews/2/2-hq.wav', license: 'cc0', title: 'x', creator: 'y', source_url: 'https://freesound.org/s/2' })).toMatch(/only https/);
    expect(await refuse({ name: 'Local', url: 'https://127.0.0.1/a.wav', license: 'cc0', title: 'x', creator: 'y', source_url: 'https://freesound.org/s/2' })).toMatch(/private or reserved/);
    expect(lib().names()).toEqual(before);
  }, 30000);

  it('audio_import takes a direct https link when the page states a license', async () => {
    web();
    const r = await core.invokeTool('audio_import', { name: 'Direct', kind: 'sfx', url: 'https://cdn.freesound.org/previews/2/2-hq.wav', license: 'by-sa', license_version: '4.0', title: 'Door slam', creator: 'Cy', source_url: 'https://freesound.org/s/2' }, 'ui');
    expect(r.isError, text(r)).toBeFalsy();
    expect(lib().get('Direct')!.credit).toMatchObject({ title: 'Door slam', creator: 'Cy', license: 'by-sa', licenseName: 'CC BY-SA 4.0', sourceUrl: 'https://freesound.org/s/2', origin: 'cdn.freesound.org' });
    expect(readFileSync(join(root, 'audio/CREDITS.md'), 'utf8')).toContain('adaptations of the sound must stay CC BY-SA');
  }, 30000);
});
