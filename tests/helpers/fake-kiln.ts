import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import type { ModelingBackend, ModelingWorkspace } from '../../src/core/modeling/backend';
import { kilnAtLeast } from '../../src/core/modeling/kiln-version';

/**
 * A fake Kiln for tests: its local API on 127.0.0.1 with a token, projects made on request, briefs that
 * become turns the test finishes (or that finish by themselves after a number of polls), a baked Roblox
 * export with a manifest the test sets, and a transcript that carries a turn's cost like Kiln's does.
 * From version 0.8.2 it also behaves like that Kiln: a brief to a busy project is never refused (`mode`
 * interject / queue / replace), a turn can be "queued" and reports `progress`, style sheets are kept by
 * id, and GET /load shows the GPU gate.
 * Never the user's Kiln: it has its own runtime.json in the test's temp folder.
 */

export interface FakeTurn {
  projectId: string;
  turnId: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | string;
  /** Messages that joined the turn while it ran (0.8.2 mode "interject"). */
  interjections?: string[];
  reply: string;
  clips: string[];
  effort: string | null;
  effortWhy: string | null;
  delivery: Record<string, unknown> | null;
  /** Polls of GET turns/:id left before it finishes by itself (null: only `finish` ends it). */
  pollsLeft: number | null;
  costUsd: number | null;
  body: Record<string, unknown>;
}

export interface FakeKiln {
  port: number;
  token: string;
  runtimeFile: string;
  /** A stand-in Kiln.exe (a file that exists) for the "is it installed" check. */
  exe: string;
  version: string;
  calls: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  /** How many messages arrived ending with the moderation rule (it is taken off what `calls` records). */
  hits(path: RegExp, method?: string): Array<{ method: string; path: string; body: Record<string, unknown> }>;
  projects: Map<string, { title: string; body: Record<string, unknown> }>;
  turns: Map<string, FakeTurn>;
  /** Turns finish by themselves after this many polls (null: the test calls `finish`). */
  autoFinish: number | null;
  /** What a finished turn delivers by default. */
  delivery: Record<string, unknown>;
  /** The manifest POST /roblox answers with for a project (default: just the baked blend). */
  manifest: (projectId: string) => Record<string, unknown>;
  /** A status other than 200 for the next chat POSTs (e.g. 503), with how many times. */
  chatFails: { status: number; times: number; error?: string } | null;
  /** What a turn costs, as Kiln's transcript reports it (null: no usage on the message). */
  costUsd: number | null;
  /** How long a Roblox bake takes (ms), and how many ran at the same moment at most. */
  bakeMs: number;
  bakesAtOnce: number;
  /** 0.8.2: what a running turn reports as its progress. */
  progress: Record<string, unknown> | null;
  /** 0.8.2: the games' style sheets by id, and the sheet a build's copilot saves when its brief names a style that has none. */
  styles: Map<string, Record<string, unknown>>;
  proposes: Record<string, unknown> | null;
  /** 0.8.2: the GPU gate as GET /load shows it. */
  load: { turns: number; open: number; gpu: { slots: number; busy: number; waiting: number; waitedMs: number } };
  /** Projects that are maps: how many placed pieces GET /roblox's check reports for them. */
  placements: Map<string, number>;
  /** Projects GET /app leaves out (Kiln lists only its 48 most recent). */
  unlisted: Set<string>;
  finish(turnId: string, patch?: Partial<FakeTurn>): void;
  /** The turns still running, oldest first. */
  running(): FakeTurn[];
  writeRuntime(): void;
  removeRuntime(): void;
  bakedBlend: string;
  liveScene: string;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        ok(s ? (JSON.parse(s) as Record<string, unknown>) : {});
      } catch {
        ok({});
      }
    });
  });

export async function fakeKiln(tmp: string, opts: { version?: string; token?: string; running?: boolean } = {}): Promise<FakeKiln> {
  const token = opts.token ?? 'fake-token';
  const liveScene = join(tmp, 'live.blend');
  const bakedBlend = join(tmp, 'exports', 'roblox-v1', 'roblox.blend');
  mkdirSync(join(tmp, 'exports', 'roblox-v1'), { recursive: true });
  writeFileSync(liveScene, 'BLENDER-live');
  writeFileSync(bakedBlend, 'BLENDER-baked');
  const exe = join(tmp, 'Kiln.exe');
  writeFileSync(exe, 'not really');
  let seq = 0;
  let baking = 0;
  const k: FakeKiln = {
    port: 0,
    token,
    runtimeFile: join(tmp, 'runtime.json'),
    exe,
    version: opts.version ?? '0.8.1',
    calls: [],
    hits: (path, method) => k.calls.filter((c) => path.test(c.path) && (!method || c.method === method)),
    projects: new Map(),
    turns: new Map(),
    autoFinish: 1,
    delivery: { size: [6, 5, 4], units: 'studs', objects: 3, tris: 4200, joints: 0, clips: [], renders: [] },
    manifest: () => ({ version: 2, blend: bakedBlend, units: 'studs', studs_per_unit: 1, materials: [], markers: [] }),
    chatFails: null,
    costUsd: 1.25,
    bakeMs: 0,
    bakesAtOnce: 0,
    progress: { steps: { done: 1, total: 4 }, current: 'Blocking out the main volumes', tool: 'run_python', tools: 6, lastRender: null, elapsedMs: 60_000, etaMs: 180_000, interjections: 0 },
    styles: new Map(),
    proposes: null,
    load: { turns: 0, open: 0, gpu: { slots: 3, busy: 0, waiting: 0, waitedMs: 0 } },
    placements: new Map(),
    unlisted: new Set(),
    finish: (turnId, patch = {}) => {
      const t = k.turns.get(turnId);
      if (!t) throw new Error(`no turn ${turnId}`);
      Object.assign(t, { state: 'done', reply: t.reply || 'Built it.', delivery: t.delivery ?? k.delivery, pollsLeft: null }, patch);
      // The first build with a style that has no sheet proposes and saves one.
      const style = t.body.style as string | undefined;
      if (t.state === 'done' && style && !k.styles.has(style) && k.proposes) k.styles.set(style, { id: style, ...k.proposes });
      // A turn that waited behind this one starts.
      const next = [...k.turns.values()].find((x) => x.projectId === t.projectId && x.state === 'queued');
      if (next) next.state = 'running';
    },
    running: () => [...k.turns.values()].filter((t) => t.state === 'running'),
    writeRuntime: () => writeFileSync(k.runtimeFile, JSON.stringify({ app: 'kiln', version: k.version, port: k.port, token, pid: process.pid, startedAt: new Date().toISOString() })),
    removeRuntime: () => rmSync(k.runtimeFile, { force: true }),
    bakedBlend,
    liveScene,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
    const body = req.method === 'POST' ? await readBody(req) : {};
    const path = (req.url ?? '').split('?')[0]!;
    k.calls.push({ method: req.method ?? 'GET', path, body });
    const send = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    const id = path.split('/')[4] ?? '';
    if (path === '/api/v1/app') {
      const working = new Set(k.running().map((t) => t.projectId));
      return send({ version: k.version, blender: { path: 'C:/Blender/blender.exe' }, projects: [...k.projects].filter(([pid]) => !k.unlisted.has(pid)).map(([pid, p]) => ({ id: pid, title: p.title, units: 'studs', open: true, working: working.has(pid) })) });
    }
    if (path === '/api/v1/projects' && req.method === 'POST') {
      const pid = `${String(body.title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(++seq).toString(36)}`;
      k.projects.set(pid, { title: String(body.title), body });
      return send({ id: pid, title: body.title, units: body.units });
    }
    if (path === '/api/v1/load') return kilnAtLeast(k.version, '0.8.2') ? send({ ...k.load, turns: k.running().length }) : send({ error: 'not found' }, 404);
    const style = /^\/api\/v1\/styles\/([^/]+)$/.exec(path);
    if (style) {
      const sid = decodeURIComponent(style[1]!);
      if (req.method === 'POST') {
        k.styles.set(sid, { id: sid, ...((body.sheet as Record<string, unknown>) ?? {}) });
        return send(k.styles.get(sid));
      }
      return k.styles.has(sid) ? send(k.styles.get(sid)) : send({ error: 'No such style sheet' }, 404);
    }
    if (path.endsWith('/stop')) {
      for (const x of k.turns.values()) if (x.projectId === id && (x.state === 'running' || x.state === 'queued')) x.state = 'stopped';
      return send({ ok: true });
    }
    if (path.endsWith('/target')) return send({ id, roblox: true, lightingSummary: 'ok' });
    if (path.endsWith('/chat')) {
      if (k.chatFails && k.chatFails.times > 0) {
        k.chatFails.times--;
        return send({ error: k.chatFails.error ?? `Kiln answered ${k.chatFails.status}` }, k.chatFails.status);
      }
      const busy = k.running().find((t) => t.projectId === id);
      const gated = kilnAtLeast(k.version, '0.8.2');
      // One turn per project at a time: Kiln up to 0.8.1 refuses, 0.8.2 does what `mode` says.
      if (busy && !gated) return send({ error: 'The copilot is still working' }, 409);
      const mode = !busy ? 'new' : ((body.mode as string) ?? 'interject');
      if (busy && mode === 'interject') {
        (busy.interjections ??= []).push(String(body.text));
        return send({ ok: true, turnId: busy.turnId, effort: busy.effort, effortWhy: busy.effortWhy, mode });
      }
      if (busy && mode === 'replace') busy.state = 'stopped';
      const turnId = `t${++seq}`;
      k.turns.set(turnId, { projectId: id, turnId, state: busy && mode === 'queue' ? 'queued' : 'running', reply: '', clips: [], effort: (body.effort as string) ?? 'xhigh', effortWhy: body.effort ? null : 'an ordinary new build', delivery: null, pollsLeft: k.autoFinish, costUsd: k.costUsd, body });
      return send({ ok: true, turnId, effort: (body.effort as string) ?? 'xhigh', effortWhy: body.effort ? null : 'an ordinary new build', ...(gated ? { mode } : {}) });
    }
    const turn = /\/turns\/([^/]+)$/.exec(path);
    if (turn) {
      const t = k.turns.get(turn[1]!);
      if (!t) return send({ error: 'no such turn' }, 404);
      if (t.state === 'running' && t.pollsLeft !== null && --t.pollsLeft <= 0) k.finish(t.turnId);
      const live = t.state === 'running' && kilnAtLeast(k.version, '0.8.2') && k.progress ? { progress: { ...k.progress, interjections: t.interjections?.length ?? 0 } } : {};
      return send({ state: t.state, reply: t.reply, clips: t.clips, effort: t.effort, effortWhy: t.effortWhy, ...live, ...(t.delivery && t.state !== 'running' && t.state !== 'queued' ? { delivery: t.delivery } : {}) });
    }
    if (path.endsWith('/state')) {
      const p = k.projects.get(id);
      if (!p) return send({ error: 'no such project' }, 404);
      const messages = [...k.turns.values()].filter((t) => t.projectId === id).map((t) => ({ id: t.turnId, role: 'assistant', blocks: [], createdAt: 0, done: t.state !== 'running', ...(t.costUsd !== null && t.state !== 'running' ? { usage: { costUsd: t.costUsd, turns: 12, durationMs: 1000 } } : {}) }));
      return send({ project: { id, title: p.title, units: 'studs', linked: p.body.linked ?? null }, scene: { version: 1 }, messages, running: k.running().some((t) => t.projectId === id) });
    }
    if (path.endsWith('/lock') || path.endsWith('/close')) return send({});
    if (path.endsWith('/import')) return send({ ok: true });
    if (path.endsWith('/file')) return send({ scene: liveScene, version: 1 });
    if (path.endsWith('/anim')) return k.projects.has(id) ? send({ open: true, working: k.running().some((t) => t.projectId === id), version: 1, anim: null, clips: [], current: null }) : send({ error: 'no such project' }, 404);
    if (path.endsWith('/roblox') && req.method === 'GET') {
      const placed = k.placements.get(id) ?? 0;
      return send({ target: 'roblox', check: { problems: [], notes: [], summary: 'ok', meshes: 3, layout: { pieces: placed ? 2 : 0, placements: placed, markers: 0, paths: 0, roles: 0, colliders: 0 } }, export: null, current: false, version: 1 });
    }
    if (path.endsWith('/roblox') && req.method === 'POST') {
      baking++;
      k.bakesAtOnce = Math.max(k.bakesAtOnce, baking);
      if (k.bakeMs) await new Promise((ok) => setTimeout(ok, k.bakeMs));
      baking--;
      return send({ ok: true, cached: false, manifest: k.manifest(id) });
    }
    if (path.endsWith('/ext')) return send({ ok: true, parts: [], size: [1, 1, 1], tris: 0 });
    if (path.endsWith('/python')) return send({ ok: true, error: null, output: '', added: [], removed: [], summary: null, changed: false, version: 1, issues: null });
    if (path.includes('/clips')) return send({ summary: 'clean', issues: [] });
    res.writeHead(404).end('{}');
  });
  k.port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)));
  if (opts.running !== false) k.writeRuntime();
  return k;
}

export const PART = { blender_material: 'Paint', color: '#7a4a2a', material: 'SmoothPlastic', transparency: 0, origin: [0, 1, 0], size: [4, 2, 2.6], triangles: 12, vertices: 8 };

/** Shuriken's own Blender stand-in: records what the baked export ran on, and what its hand-modeling was asked. */
export function fakeBlender(opts: { prepared?: (name: string, prepare: string) => string; max?: number } = {}) {
  const exported: Array<{ blend: string; dir: string; name: string; prepare?: string }> = [];
  const execs: Array<{ name: string; code: string }> = [];
  const backend = {
    status: () => ({ ready: true, exe: 'blender.exe', version: '5.2', max: opts.max ?? 4, running: 0, detail: 'Blender 5.2' }),
    workspace: (_r: string, name: string) =>
      ({
        name,
        by: null,
        version: 0,
        parts: [],
        exec: async (code: string) => {
          execs.push({ name, code });
          return { ok: true, error: null, output: '', added: [], removed: [], summary: null, issues: null, changed: true, version: 1, parts: [], size: null, ms: 1 };
        },
      }) as unknown as ModelingWorkspace,
    list: () => [],
    releaseRun: () => undefined,
    stop: () => undefined,
    exportBaked: async (blend: string, dir: string, name: string, prepare?: string) => {
      exported.push({ blend, dir, name, ...(prepare ? { prepare } : {}) });
      mkdirSync(dir, { recursive: true });
      const prepared = prepare && opts.prepared ? opts.prepared(name, prepare) : null;
      // Like the real export: a member that isn't in the scene exports nothing.
      if (prepared !== null && /"found": ?false/.test(prepared)) return { ok: false, error: `KILN_MEMBER_MISSING: no object named ${name} in the scene`, prepared };
      return { ok: true, parts: [{ ...PART, name }], size: [4, 2, 2.6], tris: 12, ...(prepared !== null ? { prepared } : {}) };
    },
  } as unknown as ModelingBackend;
  return { backend, exported, execs };
}
