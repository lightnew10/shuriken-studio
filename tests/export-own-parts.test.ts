import { afterAll, describe, expect, it } from 'vitest';
import { ExportHarness, blender } from './helpers/blender-export';

// Parts the game's code finds by name. Kiln built vending machines with separate Door, Display and Product objects,
// and the export merged every object of a model into one MeshPart per material: the game had no door to open. An
// object with the custom property kiln_part (or under one that has it) is exported as its own part.

const harness = blender ? new ExportHarness() : null;
afterAll(() => harness?.stop());

describe.skipIf(!blender)('Roblox export: parts the code finds by name', () => {
  const SCENE = `
import bmesh
kiln.clear()
def cube(name, loc, scale, mat, parent=None, **props):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    o = kiln.mesh_object(name, bm); o.location = loc; o.scale = scale
    kiln.paint(o, mat)
    if parent is not None:
        o.parent = parent
    for k, v in props.items():
        o[k] = v
    return o
body = kiln.mat("Body", base="#b02020")
glass = kiln.mat("Glass", base="#88ccee")
cube("Cabinet", (0, 0, 3), (3, 2, 6), body)
cube("Trim", (0, -1.05, 5.8), (3, 0.1, 0.3), body)                               # same material as the cabinet: merged with it
door = cube("Door", (0, -1.1, 3), (2.6, 0.2, 5), body, kiln_part="Door")          # same material, but its own part
cube("DoorWindow", (0, -1.25, 4), (2, 0.05, 2), glass, parent=door)               # a child of the door: part of the door
cube("Display", (0, 1.05, 4.5), (2, 0.1, 1), glass, kiln_part="Display")
for i in range(6):                                                                 # six buttons sharing one mesh would be instanced
    cube("Button%d" % i, (-1 + i * 0.4, -1.3, 1.5), (0.2, 0.05, 0.2), body)
`;

  it('keeps each as its own part named <model>_<name>, with its children, and merges the rest as before', async () => {
    await harness!.python(SCENE);
    const r = await harness!.export('Vending');
    const names = r.parts.map((p) => p.name).sort();
    const own = r.parts.filter((p) => (p as { own?: string }).own);
    // The door has two materials (its panel and its window): two parts, both the door's.
    expect(own.filter((p) => (p as { own?: string }).own === 'Door').map((p) => p.name).sort()).toEqual(['Vending_Door_Body', 'Vending_Door_Glass']);
    // The display has one: named for it alone.
    expect(own.filter((p) => (p as { own?: string }).own === 'Display').map((p) => p.name)).toEqual(['Vending_Display']);
    // The cabinet and its trim are still one part of the Body material, and it is not the door's.
    const rest = r.parts.filter((p) => !(p as { own?: string }).own && p.blender_material === 'Body' && !(p as { instances?: unknown[] }).instances);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.size[1]).toBeGreaterThan(5.5); // the cabinet's height: the door panel (5 tall) is not what made it
    expect(new Set(names).size).toBe(names.length);
    // The export says which parts the code can find.
    expect((r.notes ?? []).some((n) => /^Own parts \(kiln_part\): Display → Vending_Display; Door → Vending_Door_Body, Vending_Door_Glass/.test(n))).toBe(true);
  }, 240_000);
});
