import { describe, expect, it } from 'vitest';
import { parseFit, parseManifest, parseModels, type Mat4, type Vec3 } from '../src/core/modeling/kiln-manifest';
import { fromRoblox, mulV, rotationYXZ, socketAttachment, socketFrame, toRoblox, type M3 } from '../src/core/modeling/kiln-layout';

// Kiln 0.8.2 lists a project's models with their sockets (named attachment frames, in the model's own space, Blender
// axes, scene units) and the result of its fit check. Shuriken reads both, and turns a socket into a Roblox Attachment
// through the same conversion chain placements go through (the axis change, studs per unit, the upload turn): two
// mating sockets share one world frame once assembled, so two Attachments lined up exactly must put the child's
// geometry where Kiln's assembly puts it.

// ---- 4x4 helpers for the checks (row-major) -----------------------------------------------------------------------------

type M4 = number[][];
const mul = (A: M4, B: M4): M4 => A.map((_, i) => [0, 1, 2, 3].map((j) => A[i]![0]! * B[0]![j]! + A[i]![1]! * B[1]![j]! + A[i]![2]! * B[2]![j]! + A[i]![3]! * B[3]![j]!));
const apply = (M: M4, v: readonly number[]): Vec3 => [0, 1, 2].map((i) => M[i]![0]! * v[0]! + M[i]![1]! * v[1]! + M[i]![2]! * v[2]! + M[i]![3]!) as Vec3;
/** A rigid transform's inverse (rotation and translation only). */
const inv = (M: M4): M4 => {
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[j]![i]!));
  const t = R.map((row) => -(row[0]! * M[0]![3]! + row[1]! * M[1]![3]! + row[2]! * M[2]![3]!));
  return [...R.map((row, i) => [...row, t[i]!]), [0, 0, 0, 1]];
};
/** A Blender transform: rotation about Z by `deg`, then about X by `tip`, at `at`. */
const blender = (at: Vec3, deg = 0, tip = 0): Mat4 => {
  const [c, s, ct, st] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), Math.cos((tip * Math.PI) / 180), Math.sin((tip * Math.PI) / 180)];
  const Rz = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  const Rx = [[1, 0, 0], [0, ct, -st], [0, st, ct]];
  const R = Rz.map((_, i) => [0, 1, 2].map((j) => Rz[i]![0]! * Rx[0]![j]! + Rz[i]![1]! * Rx[1]![j]! + Rz[i]![2]! * Rx[2]![j]!));
  return [...R.map((row, i) => [...row, at[i]!]), [0, 0, 0, 1]] as Mat4;
};
/** CFrame.new(p) * CFrame.fromOrientation(r) as a 4x4 (Roblox space). */
const cframe = (p: readonly number[], r: readonly number[]): M4 => [...rotationYXZ(r).map((row, i) => [...row, p[i]!]), [0, 0, 0, 1]];
const HALF: M4 = [[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]];
const close = (a: readonly number[], b: readonly number[], tol: number, what: string) => {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!), `${what}: got ${a.map((v) => v.toFixed(4))}, want ${b.map((v) => v.toFixed(4))}`).toBeLessThan(tol);
};

// A kit as Kiln 0.8.2 writes it: a turret base that carries a head on HeadSocket (its top, facing up), and a head whose
// MountSocket is at its bottom, facing up as well ("from the carrying part toward the carried part, on both parts").
const UP = blender([0, 0, 0], 0, 90); // a frame whose +Y points up (+Z)
const MODELS = [
  {
    name: 'Turret_Base',
    objects: ['Turret_Base_Body', 'Turret_Base_Ring'],
    origin: [0, 0, 0],
    origin_at: 'bottom_centre',
    min: [-2, -2, 0],
    max: [2, 2, 1.5],
    size: [4, 4, 1.5],
    ground_gap: 0,
    tris: 420,
    materials: [{ name: 'Steel', color: '#8a8f96', roblox_material: 'Metal' }, { name: 'Paint', color: '#b03020', roblox_material: null }],
    sockets: [{ name: 'HeadSocket', mates: ['MountSocket'], position: [0.5, 0, 1.5], facing: [0, 0, 1], matrix: UP.map((row, i) => (i < 3 ? [row[0], row[1], row[2], [0.5, 0, 1.5][i]] : row)) }],
    rigged: false,
  },
  {
    name: 'Head_Cannon',
    objects: ['Head_Cannon'],
    origin: [8, 0, 0.4],
    origin_at: 'socket:MountSocket',
    min: [6.5, -1, 0.4],
    max: [11, 1, 2.2],
    size: [4.5, 2, 1.8],
    ground_gap: 0.4,
    tris: 1280,
    materials: [{ name: 'Steel', color: '#8a8f96', roblox_material: 'Metal' }],
    sockets: [{ name: 'MountSocket', mates: ['HeadSocket'], position: [0, 0, 0], facing: [0, 0, 1], matrix: UP }],
    rigged: false,
  },
];
const FIT = { ok: true, summary: 'Fit: 1 pairing checked, all fit.', pairs: [{ parent: 'Turret_Base', socket: 'HeadSocket', child: 'Head_Cannon', mate: 'MountSocket', ok: true, gap: 0, buried: 0.04, problem: null }], unpaired: [] };

describe('manifest 0.8.2: models and fit', () => {
  it('reads the models with their sockets, and the fit check', () => {
    const { manifest: m, notes } = parseManifest({ version: 2, blend: 'C:/x/roblox.blend', units: 'studs', studs_per_unit: 1, models: MODELS, fit: FIT });
    expect(notes).toEqual([]);
    expect(m.models).toHaveLength(2);
    expect(m.models[0]).toMatchObject({ name: 'Turret_Base', objects: ['Turret_Base_Body', 'Turret_Base_Ring'], origin: [0, 0, 0], originAt: 'bottom_centre', min: [-2, -2, 0], max: [2, 2, 1.5], size: [4, 4, 1.5], groundGap: 0, tris: 420, rigged: false });
    expect(m.models[0]!.materials).toEqual([{ name: 'Steel', color: '#8a8f96', robloxMaterial: 'Metal' }, { name: 'Paint', color: '#b03020', robloxMaterial: null }]);
    expect(m.models[0]!.sockets).toEqual([{ name: 'HeadSocket', mates: ['MountSocket'], position: [0.5, 0, 1.5], facing: [0, 0, 1], matrix: expect.any(Array) }]);
    expect(m.models[1]).toMatchObject({ name: 'Head_Cannon', originAt: 'socket:MountSocket', groundGap: 0.4 });
    expect(m.fit).toEqual({ ok: true, summary: 'Fit: 1 pairing checked, all fit.', pairs: [{ parent: 'Turret_Base', socket: 'HeadSocket', child: 'Head_Cannon', mate: 'MountSocket', ok: true, gap: 0, buried: 0.04, problem: null }], unpaired: [] });
  });

  it('a 0.8.1 manifest has neither: no models, no fit, no note', () => {
    const { manifest: m, notes } = parseManifest({ version: 2, blend: 'C:/x/roblox.blend', units: 'studs', studs_per_unit: 1 });
    expect(m.models).toEqual([]);
    expect(m.fit).toBeNull();
    expect(notes).toEqual([]);
  });

  it('degrades: a bad model or socket is left out and counted, missing fields get defaults', () => {
    const { manifest: m, notes } = parseManifest({
      version: 2,
      blend: 'C:/x/roblox.blend',
      models: [
        { name: 'Ok', sockets: [{ name: 'A', mates: 'B', matrix: blender([1, 2, 3], 90) }, { name: 'NoMatrix' }, { matrix: UP }, 7], materials: [{ name: 'M' }, {}] },
        { objects: ['nameless'] },
        'nonsense',
      ],
      fit: { ok: true, pairs: [{ parent: 'Ok', socket: 'A', child: 'X', mate: 'B', ok: false, gap: 0.3, problem: 'a gap of 0.3' }, 5] },
    });
    expect(m.models).toHaveLength(1);
    expect(m.models[0]).toMatchObject({ name: 'Ok', objects: [], origin: [0, 0, 0], originAt: 'elsewhere', min: null, size: null, groundGap: null, tris: 0, rigged: false, materials: [{ name: 'M', color: null, robloxMaterial: null }] });
    // position and facing come from the matrix when the entry leaves them out; one mate may be a plain string
    const s = m.models[0]!.sockets;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: 'A', mates: ['B'], position: [1, 2, 3] });
    close(s[0]!.facing, [-1, 0, 0], 1e-9, 'facing from the matrix');
    expect(notes.join('\n')).toMatch(/2 models in the manifest could not be read/);
    expect(notes.join('\n')).toMatch(/3 sockets in the manifest could not be read/);
    // a fit whose pairs don't all fit is not ok, whatever its flag says
    expect(m.fit).toMatchObject({ ok: false, summary: '', unpaired: [] });
    expect(m.fit!.pairs).toEqual([{ parent: 'Ok', socket: 'A', child: 'X', mate: 'B', ok: false, gap: 0.3, buried: null, problem: 'a gap of 0.3' }]);
    // the same readers take a turn's delivery.models / GET parts and any junk
    expect(parseModels(MODELS)).toHaveLength(2);
    expect(parseModels(undefined)).toEqual([]);
    expect(parseModels({})).toEqual([]);
    expect(parseFit(null)).toBeNull();
    expect(parseFit('x')).toBeNull();
  });
});

describe('a socket as a Roblox frame', () => {
  it('by hand: at (1, 2, 3) turned 90 degrees about Z, in studs and in meters', () => {
    const M = blender([1, 2, 3], 90); // its +Y (facing) points along Blender -X, its +Z stays up
    const f = socketFrame(M, 1);
    expect(f.position).toEqual([-1, 3, 2]); // (x, y, z) -> (-x, z, y)
    close(f.facing, toRoblox([-1, 0, 0]), 1e-9, 'facing'); // Blender -X is Roblox +X
    close(f.facing, [1, 0, 0], 1e-9, 'facing');
    // the frame's axes are the socket's own, renamed as all geometry is: +Z is the facing, +Y the socket's up, +X its -X
    const R = rotationYXZ(f.rotation);
    close([R[0][2], R[1][2], R[2][2]], [1, 0, 0], 1e-9, '+Z is the facing');
    close([R[0][1], R[1][1], R[2][1]], [0, 1, 0], 1e-9, '+Y is the socket up');
    close([R[0][0], R[1][0], R[2][0]], toRoblox([0, -1, 0]), 1e-9, '+X is the socket -X'); // the socket's X is Blender +Y here
    expect(f.rotation.map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 90, 0]);
    // meters: only the position scales
    const m = socketFrame(M, 3.5714);
    close(m.position, [-3.5714, 10.7142, 7.1428], 1e-9, 'meters');
    expect(m.rotation).toEqual(f.rotation);
    // a point given in the socket's own axes lands where Kiln's matrix puts it
    const p: Vec3 = [0.3, 0.7, -0.2];
    const local = toRoblox(p); // the same point in the frame's own (Roblox) axes
    const got = mulV(R, local).map((v, i) => v + f.position[i]!);
    close(fromRoblox(got), apply(M, p), 1e-9, 'a point of the socket frame');
  });

  it('a socket whose matrix carries a scale, or is mirrored, is read by its rotation (or as unturned)', () => {
    const scaled = blender([0, 0, 2], 45).map((row, i) => (i < 3 ? [row[0]! * 2, row[1]! * 2, row[2]! * 2, row[3]!] : row)) as Mat4;
    expect(socketFrame(scaled, 1).rotation.map((v) => Math.round(v * 1e4) / 1e4 + 0)).toEqual([0, 45, 0]);
    const mirrored: Mat4 = [[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    expect(socketFrame(mirrored, 1).rotation).toEqual([0, 0, 0]);
  });
});

describe('Attachments that line up put the child where Kiln assembled it', () => {
  // Kiln: the child is assembled by placing its socket on the parent's, so both sockets share one world frame:
  // childWorld = parentWorld * Sp * Sc^-1 (Sp, Sc the sockets in their models' own space).
  const Sp = MODELS[0]!.sockets[0]!.matrix as Mat4;
  const Sc = blender([0.2, -0.1, 0.3], 30, 80); // a child socket off its origin and tilted, to make it worth checking
  // A vertex of the child with nothing symmetric about it (its own space, Blender), and the child's part: a box whose
  // centre is off the model's origin (the part's `origin`, Roblox space).
  const V: Vec3 = [1.5, -0.4, 0.9];
  const childOrigin = toRoblox([1, 0.2, 0.5]);
  const parentOrigin = toRoblox([0, 0, 0.75]);
  /** A mesh-local point as the MeshPart holds it: relative to the box centre; a legacy upload arrives turned about Y. */
  const delivered = (q: Vec3, origin: Vec3, legacy: boolean): Vec3 => {
    const v: Vec3 = [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]];
    return legacy ? [-v[0], v[1], -v[2]] : v;
  };

  for (const k of [1, 3.5714]) {
    for (const [parentLegacy, childLegacy] of [[false, false], [true, false], [false, true], [true, true]] as Array<[boolean, boolean]>) {
      it(`studs per unit ${k}, parent ${parentLegacy ? 'legacy' : 'marked'} upload, child ${childLegacy ? 'legacy' : 'marked'} upload`, () => {
        // The parent model stands somewhere in the game, turned: its pivot G, its part at G * origin (* the half turn of a legacy upload).
        const G = cframe([120, 8, -45], [0, 37, 0]);
        const pOrigin = parentOrigin.map((v) => v * k);
        const cOrigin = childOrigin.map((v) => v * k);
        const parentPart = mul(mul(G, cframe(pOrigin, [0, 0, 0])), parentLegacy ? HALF : cframe([0, 0, 0], [0, 0, 0]));
        const a0 = socketAttachment(Sp, k, { origin: pOrigin, legacy: parentLegacy });
        const a1 = socketAttachment(Sc, k, { origin: cOrigin, legacy: childLegacy });
        // Lined up exactly: child.CFrame = a0.WorldCFrame * a1.CFrame:Inverse()
        const childPart = mul(mul(parentPart, cframe(a0.position, a0.rotation)), inv(cframe(a1.position, a1.rotation)));
        // The child's vertex as its MeshPart holds it, drawn by Studio at that CFrame
        const got = apply(childPart, delivered(toRoblox(V, k), cOrigin as Vec3, childLegacy));
        // Kiln's assembly, in the parent model's own space, then into the game through the parent's pivot
        const assembled = apply(mul(Sp, inv(Sc)), V);
        const want = apply(G, toRoblox(assembled, k));
        close(got, want, 1e-6, 'the child vertex');
        // and the two attachments are one world frame (what "mating sockets share one world frame" means)
        const w0 = mul(parentPart, cframe(a0.position, a0.rotation));
        const w1 = mul(childPart, cframe(a1.position, a1.rotation));
        for (let i = 0; i < 3; i++) close(w0[i]!, w1[i]!, 1e-9, `world frame row ${i}`);
        // the attachment's world frame is the socket's, in the parent model's space
        const f = socketFrame(Sp, k);
        close(apply(w0, [0, 0, 0]), apply(G, f.position), 1e-9, 'the attachment sits on the socket');
        close(mulV(w0.slice(0, 3).map((r) => r.slice(0, 3)) as M3, [0, 0, 1]), mulV(G.slice(0, 3).map((r) => r.slice(0, 3)) as M3, f.facing), 1e-9, 'its +Z is the facing');
      });
    }
  }

  it('without the legacy turn a legacy part would be wrong (the check has teeth)', () => {
    const cOrigin = childOrigin;
    const right = socketAttachment(Sc, 1, { origin: cOrigin, legacy: true });
    const wrong = socketAttachment(Sc, 1, { origin: cOrigin });
    expect(Math.hypot(right.position[0] - wrong.position[0], right.position[2] - wrong.position[2])).toBeGreaterThan(0.5);
    // a part at the model's pivot, marked upload: the attachment is the socket frame itself
    const f = socketFrame(Sc, 1);
    expect(socketAttachment(Sc, 1, { origin: [0, 0, 0] })).toEqual({ position: f.position, rotation: f.rotation });
  });

  it("a model that does not sit at the scene's origin: take its origin off the part's exported origin first", () => {
    // Head_Cannon's root is at Blender (8, 0, 0.4); its part's box centre in the export's frame is at Blender (8.75, 0, 1.3).
    const model = parseModels(MODELS)[1]!;
    const exported = toRoblox([8.75, 0, 1.3]);
    const pivot = toRoblox(model.origin);
    const rel: Vec3 = [exported[0] - pivot[0], exported[1] - pivot[1], exported[2] - pivot[2]];
    expect(fromRoblox(rel).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.75, 0, 0.9]);
    const a = socketAttachment(model.sockets[0]!.matrix, 1, { origin: rel });
    // MountSocket is at the model's origin, facing up: 0.9 below the part's centre and 0.75 behind it along Blender X
    close(fromRoblox(a.position), [-0.75, 0, -0.9], 1e-9, 'the mount on its part');
    const R = rotationYXZ(a.rotation);
    close([R[0][2], R[1][2], R[2][2]], [0, 1, 0], 1e-9, 'facing up');
  });
});
