import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROLES } from '../src/core/agents/roles';
import { SoundLibrary } from '../src/core/audio/audio-library';
import { kilnDirectorLine, modelingEnvironment } from '../src/core/context/environment';
import { KilnModeling } from '../src/core/modeling/kiln-modeling';
import { coreHarness, waitFor } from './helpers/make-core';

const ready = { ready: true, detail: 'headless Blender 4.2', max: 4 };

describe('the modeling environment line (pure)', () => {
  it('says Kiln builds every model, not only creatures, and that each model or family runs in parallel', () => {
    const [line] = modelingEnvironment(ready, { available: true, detail: 'Kiln 0.5.0' });
    expect(line).toMatch(/^3D modeling: ready \(headless Blender 4\.2\)\./);
    expect(line).toMatch(/Kiln's copilot is AVAILABLE: Kiln builds EVERY model of the game \(props, vehicles, characters, creatures, weapons, map pieces, set dressing\)/);
    expect(line).toMatch(/asks for the result with kiln_request/);
    expect(line).toMatch(/nobody hand-models in Blender while Kiln can be reached/);
    expect(line).toMatch(/Every model, and every family of parts that must fit together, is its own Kiln project, so they build in parallel \(up to 4 at once; the rest queue; one request per project at a time\)/);
    expect(line).toMatch(/separate tasks that don't wait for each other, except a family that is fitted against another one/);
    // The line that kept 15 mech parts out of Kiln (run of 2026-10-01): Kiln was "for creatures, characters, specific existing subjects".
    expect(line).not.toMatch(/creatures, characters, specific existing subjects/);
  });

  it('says plainly when Kiln cannot be reached: Blender is the fallback, and tasks stay requests for a result', () => {
    const [line] = modelingEnvironment(ready, { available: false, detail: 'Kiln is not running' });
    expect(line).toMatch(/Kiln can't be reached \(Kiln is not running\)/);
    expect(line).toMatch(/kiln_request fails until the user starts Kiln/);
    expect(line).toMatch(/for now modelers build in Blender themselves \(the fallback: skills blender-props and blender-creatures\) and say so/);
    expect(line).toMatch(/Still plan model tasks as requests for a result/);
    expect(line).toMatch(/Every model has its own Blender, so modelers for different models run in parallel \(up to 4 at once\)/);
  });

  it('plans for Kiln when it is installed but not running: Shuriken starts it with the first request', () => {
    const [line] = modelingEnvironment(ready, { available: false, startable: true, detail: 'Kiln is not running', buildsAtOnce: 8 });
    expect(line).toMatch(/Kiln isn't running \(Kiln is not running\) and Shuriken starts it with the first kiln_request: Kiln builds EVERY model/);
    expect(line).toMatch(/up to 8 at once; the rest queue/);
    expect(line).not.toMatch(/modelers build in Blender themselves/);
    expect(kilnDirectorLine({ available: false, startable: true, detail: 'Kiln is not running' })).toMatch(/Shuriken starts it in the background when the team needs a model/);
  });

  it('covers a setup without Kiln and without modeling', () => {
    const [none] = modelingEnvironment(ready, null);
    expect(none).toMatch(/Kiln's copilot is not available in this setup/);
    expect(none).toMatch(/run in parallel/);
    const [off] = modelingEnvironment({ ready: false, detail: 'Blender not found', max: 4 }, { available: true, detail: 'Kiln 0.5.0' });
    expect(off).toBe('3D modeling: NOT available on this PC (Blender not found) — plan no modeling work; use Creator Store models instead.');
  });

  it('gives the director its own line about Kiln', () => {
    expect(kilnDirectorLine({ available: true, detail: 'Kiln 0.5.0' })).toMatch(/running — its copilot builds every model for the team/);
    expect(kilnDirectorLine({ available: false, detail: 'Kiln is not running' })).toMatch(/NOT running \(Kiln is not running\)[^.]*the user starts it from the Kiln page/);
    expect(kilnDirectorLine(null)).toMatch(/not available in this setup/);
  });
});

describe('the planner brief about Kiln', () => {
  const planner = ROLES.executive!.instructions;
  it('sends every model to Kiln as a request for a result, never "in Blender"', () => {
    const t = planner.replace(/\s+/g, ' ');
    expect(t).toMatch(/modeler → Kiln \(kiln_request\)/);
    expect(t).toMatch(/builds EVERY model of the game \(props, vehicles, characters, creatures, weapons, map pieces, set dressing\)/);
    expect(t).toMatch(/Never a design/);
    expect(t).toMatch(/never "in Blender", "blender_python", "bpy" or a blender-\* skill/);
    expect(t).toMatch(/A model task is SHORT and LOOSE/);
    expect(t).toMatch(/Name a film, game or real subject only when it must match one/);
    expect(t).toMatch(/Only when your Capabilities say Kiln can't be reached does the modeler build in Blender itself/);
    // What made the planner write "Model … in Blender (skill blender-props)" for every mech part.
    expect(t).not.toMatch(/modeler → Blender/);
    expect(t).not.toMatch(/the modeler models them \(skill "blender-props"/);
  });
});

// A fake Kiln that answers its app endpoint (a running Kiln with Blender), like tests/kiln-modeling.test.ts.
const tmp = mkdtempSync(join(tmpdir(), 'kiln-env-'));
const runtimeFile = join(tmp, 'runtime.json');
const server: Server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer env-token') return void res.writeHead(401).end();
  const send = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if ((req.url ?? '').split('?')[0] === '/api/v1/app') return send({ version: '0.5.0', blender: { path: 'C:/Blender/blender.exe' }, projects: [] });
  res.writeHead(404).end('{}');
});
const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)));
writeFileSync(runtimeFile, JSON.stringify({ app: 'kiln', version: '0.5.0', port, token: 'env-token', pid: process.pid }));
afterAll(() => void server.close());

const makeCore = coreHarness();

describe('what agents and the director are told', () => {
  it('puts the modeling line in every agent’s context (no Kiln in the test setup)', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    const pkg = core.compiler.compile(ctx, { runId: 'run_env', role: ROLES.executive!, task: null, directive: 'Plan it.' });
    expect(pkg.text).toMatch(/3D modeling: (ready|NOT available)/);
    if (/3D modeling: ready/.test(pkg.text)) expect(pkg.text).toMatch(/Kiln's copilot is not available in this setup/);
  });

  it('lists the game’s sounds, effects and models by name for the roles that build, not for the reviewer', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    new SoundLibrary(ctx.root).save({ name: 'SwordHit', kind: 'sfx', source: 'generated', assetId: '9', volume: 0.6, looped: false });
    const text = (role: string) => core.compiler.compile(ctx, { runId: `run_${role}`, role: ROLES[role]!, task: null, directive: 'x' }).text;
    expect(text('roblox-engineer')).toMatch(/## Game content from the workshops \(use these names in code\)[\s\S]*SwordHit/);
    // The reviewer reads names with audio_list, vfx_list and the like when it needs them: the list was loaded into about 150 reviews a build.
    expect(text('critic')).not.toMatch(/Game content from the workshops/);
    expect(ROLES.critic!.appTools).toEqual(expect.arrayContaining(['audio_list', 'vfx_list', 'animation_list', 'model_list']));
  });

  it('gives a model task the Kiln skill, not the hand-modeling one (the run of 2026-10-01 carried 180 lines of bpy how-to)', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    // The mech-legs task of that run, as its planner wrote it.
    const objective =
      'Model the three leg units of Scrapyard Titans in Blender (skill blender-props; three separate models, one Blender project each): Legs_Biped "Strider" (sturdy forward-knee walker, hip height ≈8 studs, wide armoured feet), Legs_ReverseJoint "Hopper" (digitigrade, backward knee, springy pistons), Legs_Treads "Crawler" (two tank tread units, road wheels, mud flaps). Style: industrial salvage, mismatched painted plates, rust, bolts, hydraulic pistons, cables, one small glowing amber accent.';
    const task = ctx.tasks.create({ parentId: null, kind: 'implement', title: 'Model 3 mech legs (biped, reverse-joint, treads) segmented for IK', objective, role: 'modeler', status: 'ready', createdBy: 'test' });
    const text = core.compiler.compile(ctx, { runId: 'run_skill', role: ROLES.modeler!, task, directive: '' }).text;
    expect(text).toContain('### Skill: kiln-briefs');
    expect(text).not.toContain('### Skill: blender-props');
    expect(text).not.toContain('### Skill: blender-creatures');
    // Where the hand-modeling skills are still named, they say what they are for.
    for (const m of text.matchAll(/blender-(props|creatures) — ([^;]{0,60})/g)) expect(m[2]).toMatch(/^FALLBACK, only when Kiln can't be reached/);
  });

  it('tells the planner and the director that Kiln’s copilot is available while Kiln runs, and that it is not once it stops', async () => {
    const saved = { no: process.env.SHURIKEN_NO_KILN, rt: process.env.KILN_RUNTIME };
    delete process.env.SHURIKEN_NO_KILN;
    process.env.KILN_RUNTIME = runtimeFile;
    try {
      let directorPrompt = '';
      const { core, ctx } = await makeCore({
        respond: async (req) => {
          const props = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
          if (!('intent' in props)) return null;
          directorPrompt = String(req.prompt ?? '');
          return { intent: 'chat', reply: 'Kiln is up.' };
        },
      });
      const kiln = (core.modeling as KilnModeling).kiln;
      await waitFor(() => kiln.health.ok);
      const compile = () => core.compiler.compile(ctx, { runId: 'run_env', role: ROLES.executive!, task: null, directive: 'Plan a Griever with Kiln.' }).text;
      expect(compile()).toMatch(/Kiln's copilot is AVAILABLE: Kiln builds EVERY model of the game/);
      core.orchestrator.pause();
      core.director.send('have Kiln make a Griever');
      await waitFor(() => directorPrompt);
      expect(directorPrompt).toMatch(/Kiln \(the user's Blender copilot app\): running — its copilot builds every model for the team/);
      // Kiln goes away: the next check says so, and so does every context after it.
      await new Promise<void>((ok) => server.close(() => ok()));
      await kiln.check(true);
      expect(kiln.health.ok).toBe(false);
      expect(compile()).toMatch(/Kiln (can't be reached|isn't running) \(Kiln is not running\)/);
    } finally {
      if (saved.no === undefined) delete process.env.SHURIKEN_NO_KILN;
      else process.env.SHURIKEN_NO_KILN = saved.no;
      if (saved.rt === undefined) delete process.env.KILN_RUNTIME;
      else process.env.KILN_RUNTIME = saved.rt;
    }
  });
});
