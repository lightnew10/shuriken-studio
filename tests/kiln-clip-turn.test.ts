import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnimationStore } from '../src/core/animation/animation-service';
import { importKilnClips, toAnimationClip, type KilnClipsFile } from '../src/core/animation/kiln-clips';
import { ExportHarness, blender } from './helpers/blender-export';

// Kiln 0.8.1 clips may carry `turn` (degrees per second, positive to the model's left): a turning gait stays in place
// and the game turns the model at that rate while the clip plays. It comes through wherever Shuriken reads clips: the
// export writes it into <Model>.clips.json, and the project's animation keeps it (its source and its description).

const keys = [{ t: 0, poses: { Root: { rot: [0, 0, 0] } } }, { t: 1, poses: { Root: { rot: [0, 10, 0] } } }];
const clip = (name: string, over: Record<string, unknown> = {}) => ({ name, loop: true, in_place: true, priority: 'Movement', speed: null, fade: 0.2, length: 1, generator: 'gait', fp: `fp-${name}`, markers: [], keys, ...over });

function project(clips: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-turn-'));
  mkdirSync(join(root, 'models'), { recursive: true });
  writeFileSync(join(root, 'models', 'Bug.clips.json'), JSON.stringify({ version: 1, model: 'Bug', kind: 'custom', fps: 30, clips } satisfies Omit<KilnClipsFile, 'clips'> & { clips: unknown[] }));
  writeFileSync(join(root, 'models', 'Bug.rig.json'), JSON.stringify({ version: 2, model: 'Bug', source: 'kiln', kind: 'custom', root: 'Root', joints: [{ name: 'Root', parent: null, part: 'Root', pivot: [0, 1, 0], axis: [1, 0, 0], kind: 'ball', limits: null }], legs: [], attachments: [] }));
  return root;
}

describe('a Kiln clip that turns', () => {
  it('keeps its rate in the project animation: the source carries it and the description tells the game code', () => {
    const root = project([clip('Walk', { speed: 7.5 }), clip('TurnLeft', { turn: 90 }), clip('Curve', { speed: 6, turn: -22.5 }), clip('Idle', { turn: 0, generator: 'idle' })]);
    const r = importKilnClips(root, 'Bug');
    expect(r.problems).toEqual([]);
    expect(r.added.sort()).toEqual(['BugCurve', 'BugIdle', 'BugTurnLeft', 'BugWalk']);
    const store = new AnimationStore(root);
    const left = store.get('BugTurnLeft')!;
    expect(left.source).toMatchObject({ kind: 'kiln', model: 'Bug', clip: 'TurnLeft', turn: 90, speed: null, inPlace: true });
    expect(left.clip.description).toBe("Made in Kiln: Bug's TurnLeft (gait); turn the model at 90 degrees/s (positive is to its left) while it plays");
    // a curving walk: a ground speed and a turn to the right
    const curve = store.get('BugCurve')!;
    expect(curve.source).toMatchObject({ speed: 6, turn: -22.5 });
    expect(curve.clip.description).toBe("Made in Kiln: Bug's Curve (gait); move the model at 6 studs/s; turn the model at -22.5 degrees/s (positive is to its left) while it plays");
    // clips that don't turn say nothing about it (an older Kiln, or turn 0)
    expect(store.get('BugWalk')!.source).not.toHaveProperty('turn');
    expect(store.get('BugWalk')!.clip.description).toBe("Made in Kiln: Bug's Walk (gait); move the model at 7.5 studs/s");
    expect(store.get('BugIdle')!.source).not.toHaveProperty('turn');
    expect(toAnimationClip('Bug', 'custom', clip('Old') as never).description).not.toMatch(/turn/);
  });

  it('a clip whose turn changed in Kiln (a new fingerprint) is updated', () => {
    const root = project([clip('TurnLeft', { turn: 90 })]);
    importKilnClips(root, 'Bug');
    writeFileSync(join(root, 'models', 'Bug.clips.json'), JSON.stringify({ version: 1, model: 'Bug', kind: 'custom', fps: 30, clips: [clip('TurnLeft', { turn: 120, fp: 'fp-2' })] }));
    expect(importKilnClips(root, 'Bug').updated).toEqual(['BugTurnLeft']);
    expect(new AnimationStore(root).get('BugTurnLeft')!.source).toMatchObject({ turn: 120 });
  });
});

const harness = blender ? new ExportHarness() : null;
afterAll(() => harness?.stop());

describe.skipIf(!blender)('the export writes a turning gait\'s rate (real Blender, Kiln\'s own animation helpers)', () => {
  it('TurnLeft made with kiln.anim.gait(speed=0, turn=90) comes out with turn 90; a straight walk with none', async () => {
    await harness!.python(`
kiln.clear()
shell = kiln.mat("Shell", base="#3f5a2a", roughness=0.6)
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
body = kiln.mesh_object("Body", bm); body.scale = (1.4, 2.4, 0.7); body.location = (0, 0, 1.3); kiln.paint(body, shell)
kiln.rig.joint("Root", (0, 0, 1.3), kind="ball", limits=((-20, -20, -20), (20, 20, 20)))
kiln.rig.bind([body], "Root")
for side, x in (("L", 0.7), ("R", -0.7)):
    for i, y in enumerate((-0.8, 0.8)):
        kiln.limb("Leg%s%d" % (side, i), [(x, y, 1.1), (x * 1.9, y * 1.1, 0.9), (x * 2.2, y * 1.15, 0.0)], [0.14, 0.1, 0.06], material=shell, rig=True, parent_joint="Root")
kiln.anim.gait("Walk", style="walk")
kiln.anim.gait("TurnLeft", speed=0, turn=90)
kiln.anim.gait("TurnRight", speed=0, turn=-60)
`);
    const r = await harness!.export('Bug');
    expect(r.ok).toBe(true);
    const file = JSON.parse(readFileSync(join(harness!.dir, 'Bug.clips.json'), 'utf8')) as KilnClipsFile;
    const by = Object.fromEntries(file.clips.map((c) => [c.name, c]));
    // Kiln may lower a rate the legs can't follow, never flip it: left is positive, right negative
    expect(by.TurnLeft!.turn).toBeGreaterThan(20);
    expect(by.TurnLeft!.turn).toBeLessThanOrEqual(90);
    expect(by.TurnRight!.turn).toBeLessThan(-20);
    expect(by.TurnRight!.turn).toBeGreaterThanOrEqual(-60);
    expect(by.TurnLeft!.in_place).toBe(true);
    expect(by.Walk!.turn ?? null).toBeNull();
    // and it is what Kiln's own clip list says
    const truth = await harness!.python('import json\nprint("TURNS " + json.dumps({c["name"]: c.get("turn") for c in kiln.anim.clips()}))', false);
    const turns = JSON.parse(/TURNS (.*)/.exec(truth)![1]!) as Record<string, number>;
    expect(by.TurnLeft!.turn).toBeCloseTo(turns.TurnLeft!, 2);
    expect(by.TurnRight!.turn).toBeCloseTo(turns.TurnRight!, 2);
  }, 240_000);
});
