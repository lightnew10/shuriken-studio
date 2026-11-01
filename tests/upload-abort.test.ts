import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { multipartBody, OpenCloudAssets } from '../src/core/roblox/open-cloud-assets';

/** Unhandled rejections seen while a test runs (the stop of a batch of runs used to leave one per upload). */
function watchRejections() {
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on('unhandledRejection', on);
  return { seen, stop: () => process.off('unhandledRejection', on) };
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('multipart upload bodies', () => {
  it('read back exactly the way a server (undici) reads a form: fields, file name and type, every byte', async () => {
    const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + (i >> 5)) & 0xff);
    // The bytes a naive boundary search would trip on.
    bytes.set(Buffer.from('\r\n--x--\r\n'), 100);
    const { body, contentType } = multipartBody([
      { name: 'request', value: '{"assetType":"Model","displayName":"Ünïcode \\"quoted\\""}' },
      { name: 'fileContent', filename: 'Crate "A"\r\nB.glb', type: 'model/gltf-binary', data: bytes },
    ]);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----ShurikenForm[0-9a-f]{24}$/);
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    expect(JSON.parse(String(form.get('request')))).toEqual({ assetType: 'Model', displayName: 'Ünïcode "quoted"' });
    const file = form.get('fileContent') as File;
    expect(file.type).toBe('model/gltf-binary');
    // Line breaks and quotes in a file name travel escaped (%22, %0D%0A), as browsers send them, and come back as they were.
    expect(file.name).toBe('Crate "A"\r\nB.glb');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });
});

describe('a batch of uploads whose runs are stopped', () => {
  let server: Server;
  let url: string;
  const requests: string[] = [];
  let mode: 'ok' | 'slow' | 'busy' = 'ok';
  const file = join(mkdtempSync(join(tmpdir(), 'shuriken-upload-')), 'part.glb');
  writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 7));

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.on('error', () => {});
      res.on('error', () => {});
      req.resume();
      const answer = () => {
        if (mode === 'busy') {
          res.writeHead(429, { 'retry-after': '30' });
          res.end('slow down');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ path: 'operations/op-1', done: true, response: { assetId: '99' } }));
        }
      };
      if (mode === 'slow') setTimeout(answer, 400);
      else req.on('end', answer);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  /** The Open Cloud client with real fetch, pointed at the local server. */
  const cloud = (onResponse?: () => void) =>
    new OpenCloudAssets(
      async () => 'KEY',
      (async (u: string, init?: RequestInit) => {
        const res = await fetch(u.replace('https://apis.roblox.com/assets/v1', url), init);
        onResponse?.();
        return res;
      }) as typeof fetch,
    );
  const upload = (c: OpenCloudAssets, signal?: AbortSignal) => c.upload({ file, type: 'Model', name: 'Part', creator: { userId: '1' }, waitMs: 2000 }, signal);

  it('sends nothing and leaves no unhandled rejection behind when the signal has already aborted (30 uploads at once)', async () => {
    mode = 'ok';
    requests.length = 0;
    const watch = watchRejections();
    const c = cloud();
    const stopped = AbortSignal.abort();
    const results = await Promise.all(Array.from({ length: 30 }, () => upload(c, stopped)));
    await settle();
    watch.stop();
    expect(results.every((r) => !r.ok && /stopped/.test(r.error ?? ''))).toBe(true);
    expect(requests).toEqual([]);
    expect(watch.seen).toEqual([]);
  });

  it('uploads normally with a live signal', async () => {
    mode = 'ok';
    requests.length = 0;
    const r = await upload(cloud(), new AbortController().signal);
    expect(r).toEqual({ ok: true, assetId: '99' });
    expect(requests).toEqual(['POST /assets']);
  });

  it('stopped while the request is in flight: an error value, no unhandled rejection', async () => {
    mode = 'slow';
    requests.length = 0;
    const watch = watchRejections();
    const ac = new AbortController();
    const pending = upload(cloud(), ac.signal);
    setTimeout(() => ac.abort(), 30);
    const r = await pending;
    await settle(600);
    watch.stop();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Upload failed|stopped/);
    expect(watch.seen).toEqual([]);
  });

  it('stopped while it waits to ask again after a 429: nothing more is sent', async () => {
    mode = 'busy';
    requests.length = 0;
    const watch = watchRejections();
    const ac = new AbortController();
    let answered: () => void = () => undefined;
    const gotAnswer = new Promise<void>((resolve) => (answered = resolve));
    const pending = upload(cloud(() => answered()), ac.signal);
    // The 429 is in; a moment later the upload is waiting out its pause when the run is stopped.
    await gotAnswer;
    await settle(40);
    ac.abort();
    const r = await pending;
    await settle();
    watch.stop();
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/stopped/) });
    expect(requests).toEqual(['POST /assets']);
    expect(watch.seen).toEqual([]);
  });
});
