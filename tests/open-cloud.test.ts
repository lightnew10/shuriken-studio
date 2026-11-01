import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCloudLuau, OPEN_CLOUD_KEY } from '../src/core/roblox/open-cloud-luau';
import { Logger } from '../src/core/log';

const log = new Logger(null, null).scope('test');

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Open Cloud Luau execution', () => {
  it('reports not configured without an API key', async () => {
    const oc = new OpenCloudLuau(async () => null, log);
    const r = await oc.run({ universeId: '1', placeId: '2', script: 'return 1' });
    expect(r.state).toBe('NOT_CONFIGURED');
  });

  it('creates a task, polls through QUEUED/PROCESSING to COMPLETE, and reads logs', async () => {
    const calls: string[] = [];
    const states = ['QUEUED', 'PROCESSING', 'COMPLETE'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        expect((init?.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toEqual({ script: 'return "PASS"', timeout: '30s' });
          return json({ path: 'universes/1/places/2/versions/9/luau-execution-sessions/s/tasks/t', state: 'QUEUED' });
        }
        if (url.includes('/logs')) return json({ luauExecutionSessionTaskLogs: [{ messages: ['hello', 'world'] }] });
        const state = states.shift() ?? 'COMPLETE';
        return json({ state, output: state === 'COMPLETE' ? { results: ['PASS'] } : undefined });
      }),
    );
    const oc = new OpenCloudLuau(async (k) => (k === OPEN_CLOUD_KEY ? 'secret-key' : null), log);
    const r = await oc.run({ universeId: '1', placeId: '2', script: 'return "PASS"', timeoutSec: 30 });
    expect(r.ok).toBe(true);
    expect(r.results).toEqual(['PASS']);
    expect(r.logs).toEqual(['hello', 'world']);
    expect(calls[0]).toBe('POST https://apis.roblox.com/cloud/v2/universes/1/places/2/luau-execution-session-tasks');
    expect(calls.some((c) => c.includes('/logs'))).toBe(true);
  }, 20000);

  it('surfaces rate limiting with retry-after', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Luau task creation rate limit exceeded' }, 429, { 'retry-after': '1800' })));
    const oc = new OpenCloudLuau(async () => 'k', log);
    const r = await oc.run({ universeId: '1', placeId: '2', script: 'return 1' });
    expect(r.state).toBe('RATE_LIMITED');
    expect(r.retryAfterSec).toBe(1800);
  });
});

describe('upload creator', () => {
  it('asks the play-solo player when a playtest holds Studio (Edit unavailable) and remembers it', async () => {
    const { resolveCreator } = await import('../src/core/roblox/open-cloud-assets');
    const calls: string[] = [];
    const studio = {
      connected: true,
      runLuau: async (_code: string, dm: 'Edit' | 'Server') => {
        calls.push(dm);
        return dm === 'Edit' ? { ok: false, output: 'Edit is not available during a playtest' } : { ok: true, output: '1000000001' };
      },
    };
    let remembered = '';
    expect(await resolveCreator(studio, null, (id) => (remembered = id))).toBe('1000000001');
    expect(calls).toEqual(['Edit', 'Server']);
    expect(remembered).toBe('1000000001');
    expect(await resolveCreator(studio, '42', () => undefined)).toBe('42');
  });
});
