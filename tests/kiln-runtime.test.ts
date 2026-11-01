import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KilnClient } from '../src/core/modeling/kiln-modeling';

// Kiln 0.8: runtime.json is removed when Kiln quits, and a newer Kiln makes the running one step aside (finish, quit, the new one
// starts): its port and token change. A call that fails re-reads runtime.json; a missing file is "Kiln is not running".

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function fakeKiln(token: string): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token }));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server }));
  });
}

describe('KilnClient and runtime.json', () => {
  it('re-reads runtime.json when the connection fails, and goes on with the new port and token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiln-rt-'));
    const file = join(dir, 'runtime.json');
    const a = await fakeKiln('tokA');
    writeFileSync(file, JSON.stringify({ port: a.port, token: 'tokA', version: '0.8.0', pid: 1 }));
    const k = new KilnClient(() => file);
    expect(await k.get('/x')).toMatchObject({ token: 'tokA' });
    // the newer Kiln takes over: the old one quits, the new one listens elsewhere with another token
    await new Promise((r) => a.server.close(r));
    const b = await fakeKiln('tokB');
    writeFileSync(file, JSON.stringify({ port: b.port, token: 'tokB', version: '0.8.1', pid: 2 }));
    expect(await k.get('/x')).toMatchObject({ token: 'tokB' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a rejected token with a changed runtime.json is retried once; a missing file is "Kiln is not running"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiln-rt-'));
    const file = join(dir, 'runtime.json');
    const a = await fakeKiln('tokA');
    writeFileSync(file, JSON.stringify({ port: a.port, token: 'old', version: '0.8.0', pid: 1 }));
    const k = new KilnClient(() => file);
    await expect(k.get('/x')).rejects.toThrow(/bad token/); // the file still says the old token: nothing newer to try
    writeFileSync(file, JSON.stringify({ port: a.port, token: 'tokA', version: '0.8.0', pid: 1 }));
    expect(await k.get('/x')).toMatchObject({ token: 'tokA' });
    // Kiln quits: the file is removed
    await new Promise((r) => a.server.close(r));
    rmSync(file);
    await expect(k.get('/x')).rejects.toThrow(/Kiln is not running/);
    expect((await k.check(true)).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
