import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import type { ExternalCallResult } from '../src/core/mcp/mcp-client';
import { LINK_TIMING, LinkServer, serverProof, sessionKey, type LinkPlace } from '../src/core/roblox/link/link-server';
import { LINK_PLUGIN_FILE, LINK_PORTS, LINK_VERSION, linkPluginFile, linkPluginSource } from '../src/core/roblox/link/plugin';
import { STALE_PLUGIN, StudioLink, linkDisplayName, linkKey, unstamped } from '../src/core/roblox/link/studio-link';
import { LuauToolchain } from '../src/core/roblox/luau-toolchain';
import { LINK_PLAY_WAIT, RobloxStudioAdapter } from '../src/core/roblox/studio-adapter';
import { FakePlugin } from './helpers/fake-link-plugin';

/**
 * Shuriken Link: a Studio plugin runs Shuriken's Luau with a plugin's rights (roblox/link/plugin.ts). Roblox took
 * script capabilities from Studio's MCP path on 2026-10-01; a plugin is not on that path. The plugin's Luau is
 * proven against real Studio (tests/e2e/link.e2e.ts); here the core's end is driven by the same requests.
 */

const KEY = 'a'.repeat(64);
const dirs: string[] = [];
const servers: LinkServer[] = [];
const links: StudioLink[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const l of links.splice(0)) await l.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `shuriken-${name}-`));
  dirs.push(d);
  return d;
};
const log = new Logger(null, null, 'error').scope('link');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function server(claims: (p: LinkPlace, prev: string | null) => boolean = (p) => p.place === 'arena.rbxlx', extra: Partial<ConstructorParameters<typeof LinkServer>[0]> = {}) {
  const s = new LinkServer({ key: () => KEY, claims, ports: [0], ...extra });
  servers.push(s);
  expect(await s.start()).toBe(true);
  return s;
}
const arena = (p: LinkPlace) => p.place === 'arena.rbxlx';

describe('the plugin file', () => {
  it('is one Script in a model file, carries its key, ports and version, and nothing that ends the CDATA', () => {
    const file = linkPluginFile({ key: KEY });
    expect(file).toMatch(/^<roblox [^>]*version="4">\s*<Item class="Script"/);
    expect(file).toContain('<string name="Name">ShurikenLink</string>');
    expect(file.match(/\]\]>/g)).toHaveLength(1);
    const src = linkPluginSource({ key: KEY });
    expect(src).toContain(`local VERSION = ${LINK_VERSION}\n`);
    expect(src).toContain(`local PORTS = { ${LINK_PORTS.join(', ')} }`);
    expect(src).toContain(`local KEY = "${KEY}"`);
    expect(src).not.toMatch(/__[A-Z_]+__/);
    // It talks to this PC only, proves before it runs, and runs nothing in a place nobody claimed.
    expect(src.match(/http:\/\/[^"]+/g)).toEqual(['http://127.0.0.1:']);
    expect(src).toContain('if r.proof ~= sha256(KEY .. "|server|" .. nonce .. "|" .. r.nonce .. "|" .. port) then');
    expect(() => linkPluginSource({ key: 'not hex' })).toThrow();
  });

  it.skipIf(!existsSync(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'selene.exe' : 'selene')))('is valid Luau', async () => {
    expect(await new LuauToolchain(tmpdir()).parseErrors(linkPluginSource({ key: KEY }))).toEqual([]);
  }, 60_000);

  it('is written to the Plugins folder once, rewritten when the key or version differs, and removed when switched off', async () => {
    const data = tmp('link-data');
    const plugins = join(tmp('link-plugins'), 'Plugins');
    let enabled = true;
    const link = new StudioLink({ dataDir: data, pluginsDir: plugins, enabled: () => enabled, binding: () => 'arena.rbxlx', log, ports: [0] });
    links.push(link);
    await link.start();
    const file = join(plugins, LINK_PLUGIN_FILE);
    const key = linkKey(data);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(linkKey(data)).toBe(key);
    expect(readFileSync(file, 'utf8')).toBe(linkPluginFile({ key, ports: [0] }));
    expect(link.status()).toMatchObject({ enabled: true, installed: true, pluginFile: file, linked: [], version: LINK_VERSION });
    expect(link.status().port).toBeGreaterThan(0);
    // Someone else's file in its place (an older key): rewritten.
    writeFileSync(file, linkPluginFile({ key: 'b'.repeat(64) }), 'utf8');
    expect(link.install()).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain(key);
    enabled = false;
    await link.apply();
    expect(existsSync(file)).toBe(false);
    expect(link.status()).toMatchObject({ enabled: false, installed: false, port: null });
    // Nowhere to write (not Windows, tests): it still listens, and says so.
    const none = new StudioLink({ dataDir: data, pluginsDir: null, enabled: () => true, binding: () => null, log, ports: [0] });
    links.push(none);
    await none.start();
    expect(none.status()).toMatchObject({ installed: false, pluginFile: null });
  });
});

describe('a Studio window that runs an older copy of the plugin', () => {
  it('is given the plugin file again, stamped, after its Edit session twice fails the handshake for the project\'s place', async () => {
    // Seen 2026-10-03: Studio kept a test's plugin (another key) in the open Edit session after the file was put back,
    // and every code sync of a 20-agent build waited for every playtest for half an hour.
    const data = tmp('stale-data');
    const plugins = join(tmp('stale-plugins'), 'Plugins');
    const lines: string[] = [];
    const quiet = new Logger(null, null, 'error').scope('link');
    const spy = Object.assign(Object.create(quiet), { warn: (m: string) => lines.push(m), info: () => undefined });
    const link = new StudioLink({ dataDir: data, pluginsDir: plugins, enabled: () => true, binding: () => 'arena.rbxlx', log: spy, ports: [0] });
    links.push(link);
    await link.start();
    const file = join(plugins, LINK_PLUGIN_FILE);
    const clean = readFileSync(file, 'utf8');
    const port = link.status().port!;
    const pending = LINK_TIMING.pendingMs;
    LINK_TIMING.pendingMs = -1;
    const reap = () => (link.server as unknown as { reap(): void }).reap();
    try {
      const stale = () => new FakePlugin({ port, key: 'c'.repeat(64), dm: 'Edit', studio: 'studio-aaaa-1' }).hello().catch(() => false);
      // Another game's window with an old copy is none of this core's business.
      await new FakePlugin({ port, key: 'c'.repeat(64), dm: 'Edit', studio: 'studio-zzzz-9', place: 'other.rbxlx' }).hello().catch(() => false);
      await stale();
      reap();
      expect(readFileSync(file, 'utf8')).toBe(clean);
      await stale();
      reap();
      const now = readFileSync(file, 'utf8');
      expect(now).not.toBe(clean);
      expect(now).toMatch(/<!\[CDATA\[-- written \d{4}-/);
      expect(unstamped(now)).toBe(clean);
      expect(lines.join()).toMatch(/runs a plugin with another key/);
      // The stamped file is this version's: not rewritten at the next start, and not again within everyMs.
      expect(link.install()).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(now);
      for (let i = 0; i < STALE_PLUGIN.times; i++) {
        await stale();
        reap();
      }
      expect(readFileSync(file, 'utf8')).toBe(now);
      // A plugin that proves itself is never counted.
      const good = new FakePlugin({ port, key: linkKey(data), dm: 'Edit', studio: 'studio-bbbb-2' });
      expect(await good.start()).toBe(true);
      good.stop();
    } finally {
      LINK_TIMING.pendingMs = pending;
    }
  });
});

describe('the handshake', () => {
  it('claims only a place the core works on, and both ends prove the key without sending it', async () => {
    const s = await server();
    const other = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-other-1', place: 'someone-elses-game.rbxlx' });
    expect(await other.hello()).toBe(false);
    const p = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1' });
    expect(await p.hello()).toBe(true);
    // A hello alone links nothing: the session is live with its first authenticated poll.
    expect(s.has(arena, 'Edit')).toBe(false);
    void p.poll().catch(() => undefined);
    await sleep(30);
    expect(s.has(arena, 'Edit')).toBe(true);
    expect(s.list()).toMatchObject([{ dm: 'Edit', place: { place: 'arena.rbxlx', studio: 'studio-aaaa-1' } }]);
    p.stop();
    // The proof covers the port: one obtained from this port is not the proof of another.
    expect(serverProof(KEY, 'n1', 'n2', 47811)).not.toBe(serverProof(KEY, 'n1', 'n2', 47812));
    expect(sessionKey(KEY, 'n1', 'n2', 's1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses whoever does not hold the key, a browser page, another host name, and anything but POST', async () => {
    const s = await server();
    const base = `http://127.0.0.1:${s.port}`;
    // A process without the key gets a session id but can never poll it, and never becomes the place's session.
    const thief = new FakePlugin({ port: s.port!, key: 'c'.repeat(64), dm: 'Edit', studio: 'studio-thief-1' });
    await expect(thief.hello()).rejects.toThrow(/did not prove/);
    const hello = (await (await fetch(`${base}/link/hello`, { method: 'POST', body: JSON.stringify({ v: LINK_VERSION, dm: 'Edit', studio: 'studio-thief-2', nonce: 'nonce-1234', place: 'arena.rbxlx' }) })).json()) as { session: string };
    for (const auth of [undefined, 'Bearer nope', `Bearer ${'0'.repeat(64)}`]) {
      const r = await fetch(`${base}/link/poll`, { method: 'POST', headers: auth ? { authorization: auth } : {}, body: JSON.stringify({ session: hello.session }) });
      expect(r.status).toBe(401);
    }
    expect(s.has(arena, 'Edit')).toBe(false);
    expect((await fetch(`${base}/link/hello`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/link/hello`, { method: 'GET' })).status).toBe(403);
    // A DNS name rebound to this PC arrives with its own Host.
    const rebound = await new Promise<number>((done) => {
      const r = request({ host: '127.0.0.1', port: s.port!, path: '/link/hello', method: 'POST', headers: { host: 'evil.example' } }, (res) => done(res.statusCode ?? 0));
      r.on('error', () => done(0));
      r.end('{}');
    });
    expect(rebound).toBe(403);
    // Another protocol version is not claimed (the core rewrites the plugin file when it starts).
    const old = (await (await fetch(`${base}/link/hello`, { method: 'POST', body: JSON.stringify({ v: LINK_VERSION + 1, dm: 'Edit', studio: 'studio-old-1', nonce: 'nonce-1234', place: 'arena.rbxlx' }) })).json()) as { claimed: boolean };
    expect(old.claimed).toBe(false);
  });

  it("links a playtest's server and client only through their window's Edit session", async () => {
    const s = await server();
    const lonely = new FakePlugin({ port: s.port!, key: KEY, dm: 'Server', studio: 'studio-aaaa-1' });
    expect(await lonely.hello()).toBe(false);
    const edit = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1' });
    expect(await edit.start()).toBe(true);
    const play = new FakePlugin({ port: s.port!, key: KEY, dm: 'Server', studio: 'studio-aaaa-1' });
    const client = new FakePlugin({ port: s.port!, key: KEY, dm: 'Client', studio: 'studio-aaaa-1' });
    expect(await play.start()).toBe(true);
    expect(await client.start()).toBe(true);
    expect([s.has(arena, 'Server'), s.has(arena, 'Client')]).toEqual([true, true]);
    // Another window's playtest is not this one's.
    expect(await new FakePlugin({ port: s.port!, key: KEY, dm: 'Server', studio: 'studio-bbbb-2' }).hello()).toBe(false);
    for (const p of [edit, play, client]) p.stop();
  });
});

describe('running Luau through the plugin', () => {
  it('runs in the DataModel asked for, in order within one, side by side across them, and says null when none serves it', async () => {
    const s = await server();
    expect(s.run(arena, 'Edit', 'return 1', 5000)).toBeNull();
    const order: string[] = [];
    const slow = async (code: string) => {
      order.push(`start ${code}`);
      await sleep(code.includes('slow') ? 80 : 5);
      order.push(`end ${code}`);
      return { ok: !code.includes('error'), text: code.includes('error') ? 'boom (line 1)' : `done ${code}` };
    };
    const edit = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1', exec: slow });
    const play = new FakePlugin({ port: s.port!, key: KEY, dm: 'Server', studio: 'studio-aaaa-1', exec: slow });
    await edit.start();
    await play.start();
    const [a, b, c, d] = await Promise.all([s.run(arena, 'Edit', 'slow A', 5000)!, s.run(arena, 'Edit', 'B', 5000)!, s.run(arena, 'Server', 'S', 5000)!, s.run(arena, 'Edit', 'error C', 5000)!]);
    expect(a).toMatchObject({ ok: true, text: 'done slow A' });
    expect(b).toMatchObject({ ok: true, text: 'done B' });
    expect(c).toMatchObject({ ok: true, text: 'done S' });
    expect(d).toMatchObject({ ok: false, text: 'boom (line 1)' });
    expect(edit.ran).toEqual(['slow A', 'B', 'error C']);
    expect(play.ran).toEqual(['S']);
    // Edit's run one after another; the server's ran while Edit's first was still going.
    expect(order.indexOf('end slow A')).toBeLessThan(order.indexOf('start B'));
    expect(order.indexOf('start S')).toBeLessThan(order.indexOf('end slow A'));
    expect(a.durationMs).toBeGreaterThanOrEqual(70);
    edit.stop();
    play.stop();
  });

  it('gives up on a command that takes too long or is cancelled, has its thread stopped, and carries on with the next', async () => {
    const s = await server();
    const edit = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1', exec: async (code) => (code === 'hang' ? new Promise(() => undefined) : { ok: true, text: code }) });
    await edit.start();
    const hung = await s.run(arena, 'Edit', 'hang', 1000)!;
    expect(hung).toMatchObject({ ok: false, text: 'execute_luau timed out after 1 s (through Shuriken Link)' });
    expect((await s.run(arena, 'Edit', 'next', 2000)!).text).toBe('next');
    expect(edit.cancelled).toHaveLength(1);
    const ctl = new AbortController();
    const aborted = s.run(arena, 'Edit', 'hang', 60_000, ctl.signal)!;
    await sleep(40);
    ctl.abort();
    expect(await aborted).toMatchObject({ ok: false, text: 'The call was cancelled.' });
    expect((await s.run(arena, 'Edit', 'after', 2000)!).text).toBe('after');
    edit.stop();
  });

  // A heavy project's world builder runs for two minutes without yielding: the plugin cannot ask again meanwhile.
  // The session was dropped after 40 s of that silence, the build answered "Studio stopped answering" and everything
  // queued behind it failed too; the plugin linked again when the build was done.
  it('a session that is silent because it is running a command is busy, not dead: the command comes back', async () => {
    let clock = Date.now();
    const s = await server(undefined, { now: () => clock });
    const reap = () => (s as unknown as { reap(): void }).reap();
    const plugin = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1' });
    expect(await plugin.hello()).toBe(true);
    const first = plugin.poll();
    await sleep(60);
    const build = s.run(arena, 'Edit', 'build the map', 600_000)!;
    const queued = s.run(arena, 'Edit', 'after the build', 600_000)!;
    const handed = await first;
    expect(handed.commands.map((c) => c.code)).toEqual(['build the map']);
    // Studio builds: no poll for three minutes.
    clock += 3 * 60_000;
    reap();
    expect(s.has(arena, 'Edit')).toBe(true);
    // The build is done: its result arrives, and the next command goes out with the next poll.
    expect(await plugin.result(handed.commands[0]!.id, true, 'built 4,200 parts')).toBe(200);
    expect(await build).toMatchObject({ ok: true, text: 'built 4,200 parts' });
    const next = await plugin.poll();
    expect(next.commands.map((c) => c.code)).toEqual(['after the build']);
    expect(await plugin.result(next.commands[0]!.id, true, 'ok')).toBe(200);
    expect((await queued).text).toBe('ok');
    // Silent with nothing to run: that is a Studio that went away.
    clock += LINK_TIMING.deadMs + 1000;
    reap();
    expect(s.has(arena, 'Edit')).toBe(false);
  });

  it('a command that outlasts its own timeout still ends, and the silent session goes after it', async () => {
    let clock = Date.now();
    const s = await server(undefined, { now: () => clock });
    const reap = () => (s as unknown as { reap(): void }).reap();
    const plugin = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1' });
    expect(await plugin.hello()).toBe(true);
    const first = plugin.poll();
    await sleep(60);
    const stuck = s.run(arena, 'Edit', 'never comes back', 1000)!;
    await first;
    clock += LINK_TIMING.deadMs + 1000;
    reap();
    expect(s.has(arena, 'Edit')).toBe(true);
    expect(await stuck).toMatchObject({ ok: false, text: 'execute_luau timed out after 1 s (through Shuriken Link)' });
    reap();
    expect(s.has(arena, 'Edit')).toBe(false);
  });

  it("ends a playtest's sessions when it stops, with what was running answered, and notices a Studio that went away", async () => {
    LINK_TIMING.goneMs = 60;
    try {
      const s = await server();
      const edit = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1' });
      const play = new FakePlugin({ port: s.port!, key: KEY, dm: 'Server', studio: 'studio-aaaa-1', exec: () => new Promise(() => undefined) });
      await edit.start();
      await play.start();
      const running = s.run(arena, 'Server', 'watch the round', 60_000)!;
      await sleep(40);
      s.endPlay(arena);
      expect(await running).toMatchObject({ ok: false, text: "The playtest ended while this ran, so there's no result." });
      expect(s.has(arena, 'Server')).toBe(false);
      expect(s.has(arena, 'Edit')).toBe(true);
      // Studio closes: the held poll is dropped, and a moment later the session is gone.
      edit.stop();
      await sleep(150);
      expect(s.has(arena, 'Edit')).toBe(false);
      expect(s.run(arena, 'Edit', 'return 1', 1000)).toBeNull();
    } finally {
      LINK_TIMING.goneMs = 2500;
    }
  });
});

describe('a place that comes back under another name', () => {
  it('is followed when it carries the mark of the window that was the project\'s place, and that window is gone', async () => {
    LINK_TIMING.goneMs = 40;
    try {
      let binding: string | null = 'simple-drift-game.rbxlx';
      const followed: Array<{ display: string; placeId: number; before: string | undefined }> = [];
      const link = new StudioLink({
        dataDir: tmp('link-data'),
        pluginsDir: null,
        enabled: () => true,
        binding: () => binding,
        renamed: (display, now, before) => {
          followed.push({ display, placeId: now.placeId, before: before?.place });
          binding = display;
        },
        log,
        ports: [0],
      });
      links.push(link);
      await link.start();
      const port = link.status().port!;
      const key = linkKey((link as unknown as { d: { dataDir: string } }).d.dataDir);
      const file = new FakePlugin({ port, key, dm: 'Edit', studio: 'studio-file-1', place: 'simple-drift-game.rbxlx' });
      expect(await file.start()).toBe(true);
      expect(link.has('Edit')).toBe(true);
      // A copy of the place open in another window while the first is still there: not followed.
      const copy = new FakePlugin({ port, key, dm: 'Edit', studio: 'studio-copy-2', place: 'Untitled 13', placeId: 120000000000001, prev: 'studio-file-1' });
      expect(await copy.hello()).toBe(false);
      // The user publishes: Studio reloads the place as "Untitled 13". Its old session ends, the new instance
      // says hello with the mark the old one left.
      file.stop();
      await sleep(120);
      expect(link.has('Edit')).toBe(false);
      expect(link.lostWithin(5000)).toBe(true);
      const published = new FakePlugin({ port, key, dm: 'Edit', studio: 'studio-pub-3', place: 'Untitled 13', placeId: 120000000000001, gameId: 7000000002, prev: 'studio-file-1' });
      expect(await published.start()).toBe(true);
      expect(followed).toEqual([{ display: 'Untitled 13 (placeId: 120000000000001)', placeId: 120000000000001, before: 'simple-drift-game.rbxlx' }]);
      expect(link.has('Edit')).toBe(true);
      expect(link.place()).toMatchObject({ place: 'Untitled 13', placeId: 120000000000001 });
      // Someone else's place with an unknown mark, and the old file reopened later, are not this project's.
      expect(await new FakePlugin({ port, key, dm: 'Edit', studio: 'studio-x-4', place: 'Other game', prev: 'studio-zzzz-9' }).hello()).toBe(false);
      expect(await new FakePlugin({ port, key, dm: 'Edit', studio: 'studio-file-5', place: 'simple-drift-game.rbxlx', prev: 'studio-file-1' }).hello()).toBe(false);
      published.stop();
    } finally {
      LINK_TIMING.goneMs = 2500;
    }
  });

  it('is followed when the same window reports a new name between polls', async () => {
    const renamed: string[] = [];
    const s = await server((p) => p.place === 'arena.rbxlx', { renamed: (before, now) => void renamed.push(`${before.place} -> ${linkDisplayName(now)}`) });
    const edit = new FakePlugin({ port: s.port!, key: KEY, dm: 'Edit', studio: 'studio-aaaa-1' });
    expect(await edit.hello()).toBe(true);
    void edit.poll().catch(() => undefined);
    await sleep(30);
    edit.place = 'Arena Deluxe';
    edit.placeId = 42;
    void edit.poll().catch(() => undefined);
    await sleep(30);
    expect(renamed).toEqual(['arena.rbxlx -> Arena Deluxe (placeId: 42)']);
    edit.stop();
  });
});

describe('the Studio adapter with a linked plugin', () => {
  const text = (t: string): ExternalCallResult => ({ ok: true, content: [{ type: 'text', text: t }], durationMs: 1 });

  class Mcp extends RobloxStudioAdapter {
    mcp: Array<{ tool: string; dm?: string }> = [];
    constructor() {
      super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
    }
    protected override async callMcp(tool: string, args: Record<string, unknown>): Promise<ExternalCallResult> {
      this.mcp.push({ tool, dm: args.datamodel_type as string | undefined });
      return text('through MCP');
    }
  }

  it('runs Luau through the plugin where a DataModel is linked and through MCP where none is, and counts it', async () => {
    Object.assign(LINK_PLAY_WAIT, { windowMs: 0 });
    try {
      const link = new StudioLink({ dataDir: tmp('link-data'), pluginsDir: null, enabled: () => true, binding: () => 'arena.rbxlx', log, ports: [0] });
      links.push(link);
      await link.start();
      const key = linkKey((link as unknown as { d: { dataDir: string } }).d.dataDir);
      const studio = new Mcp();
      studio.link = link;
      // Nothing linked yet: MCP.
      expect((await studio.runLuau('return 1', 'Edit')).output).toBe('through MCP');
      const edit = new FakePlugin({ port: link.status().port!, key, dm: 'Edit', studio: 'studio-aaaa-1', exec: (code) => (code.includes('boom') ? { ok: false, text: 'boom (line 1)' } : { ok: true, text: `plugin ran: ${code}` }) });
      await edit.start();
      expect(await studio.runLuau('return require(game.ReplicatedStorage.Lib).v', 'Edit')).toMatchObject({ ok: true, output: 'plugin ran: return require(game.ReplicatedStorage.Lib).v' });
      expect(await studio.runLuau('error("boom")', 'Edit')).toMatchObject({ ok: false, output: 'boom (line 1)' });
      expect(studio.linkStats).toEqual({ calls: 2, failed: 1 });
      // The server of a playtest isn't linked (and none started just now): MCP, without waiting.
      const t0 = Date.now();
      expect((await studio.runLuau('return 2', 'Server')).output).toBe('through MCP');
      expect(Date.now() - t0).toBeLessThan(400);
      expect(studio.mcp.map((c) => c.dm)).toEqual(['Edit', 'Server']);
      expect(link.status()).toMatchObject({ linked: ['Edit'], places: ['arena.rbxlx'] });
      edit.stop();
    } finally {
      Object.assign(LINK_PLAY_WAIT, { windowMs: 15_000 });
    }
  });
});
