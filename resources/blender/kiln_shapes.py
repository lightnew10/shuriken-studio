"""
Organic shapes for the copilot (exposed through `kiln`): smooth blended forms, tapered tubes, rocks,
trees and bushes. Headless Blender has no sculpt brushes, so organic work is done the way procedural
artists do it: blend simple volumes into one surface, grow tubes along curves, and push surfaces
around with noise. Everything is plain data API + numpy and returns ordinary mesh objects.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

# ------------------------------------------------------------------------------------------------
# Noise
# ------------------------------------------------------------------------------------------------

_tables = {}


def _table(seed):
    t = _tables.get(seed)
    if t is None:
        rng = np.random.default_rng(seed)
        perm = rng.permutation(256)
        t = (np.concatenate([perm, perm]), rng.random(256) * 2 - 1)
        _tables[seed] = t
    return t


def noise3(points, seed=0):
    """Smooth value noise in -1..1 at (N, 3) points (one unit = one feature)."""
    perm, vals = _table(seed)
    p = np.asarray(points, dtype=np.float64)
    i = np.floor(p).astype(np.int64)
    f = p - i
    w = f * f * (3 - 2 * f)
    i &= 255

    def h(dx, dy, dz):
        return vals[perm[perm[perm[(i[:, 0] + dx) & 255] + ((i[:, 1] + dy) & 255)] + ((i[:, 2] + dz) & 255)]]

    x00 = h(0, 0, 0) * (1 - w[:, 0]) + h(1, 0, 0) * w[:, 0]
    x10 = h(0, 1, 0) * (1 - w[:, 0]) + h(1, 1, 0) * w[:, 0]
    x01 = h(0, 0, 1) * (1 - w[:, 0]) + h(1, 0, 1) * w[:, 0]
    x11 = h(0, 1, 1) * (1 - w[:, 0]) + h(1, 1, 1) * w[:, 0]
    y0 = x00 * (1 - w[:, 1]) + x10 * w[:, 1]
    y1 = x01 * (1 - w[:, 1]) + x11 * w[:, 1]
    return y0 * (1 - w[:, 2]) + y1 * w[:, 2]


def fbm3(points, scale=1.0, octaves=4, seed=0, gain=0.5):
    """Fractal noise (-1..1-ish) at (N, 3) points; `scale` is the size of the largest features in meters."""
    p = np.asarray(points, dtype=np.float64) / max(scale, 1e-6)
    out = np.zeros(len(p))
    amp, total = 1.0, 0.0
    for o in range(octaves):
        out += amp * noise3(p * (2 ** o) + o * 17.13, seed + o)
        total += amp
        amp *= gain
    return out / total


# ------------------------------------------------------------------------------------------------
# Mesh utilities
# ------------------------------------------------------------------------------------------------

def _k():
    import kiln
    return kiln


def _coords(me):
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def _set_coords(me, co):
    me.vertices.foreach_set("co", np.asarray(co, dtype=np.float64).ravel())
    me.update()


def _normals(me):
    n = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", n)
    return n.reshape(-1, 3)


def displace(obj, strength=0.1, scale=1.0, octaves=4, seed=0, axis_scale=(1, 1, 1)):
    """Push every vertex along its normal by fractal noise: lumps, dents, bark, rocky surfaces.
    `scale` is the feature size in meters; `strength` the push in meters. Works on the mesh data."""
    me = obj.data
    co = _coords(me)
    n = _normals(me)
    world = co * np.array(obj.scale) * np.array(axis_scale)
    d = fbm3(world, scale, octaves, seed) * strength
    _set_coords(me, co + n * d[:, None] / np.maximum(np.array(obj.scale), 1e-6))
    return obj


def remesh(obj, voxel=0.05, smooth=True, adaptivity=0.0):
    """Voxel remesh: one clean closed surface with even quads (merges overlapping parts into a single
    shell). Smaller voxels keep more detail and cost more triangles."""
    m = obj.modifiers.new("Remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.adaptivity = adaptivity
    m.use_smooth_shade = smooth
    return _k().apply_modifiers(obj)


def smooth_shape(obj, iterations=10, factor=0.5, keep_volume=True):
    """Relax the surface: softens creases where blended parts meet (Laplacian smoothing)."""
    m = obj.modifiers.new("Smooth", "LAPLACIANSMOOTH" if keep_volume else "SMOOTH")
    if keep_volume:
        m.iterations = iterations
        m.lambda_factor = factor
        m.use_volume_preserve = True
        m.use_normalized = True
    else:
        m.iterations = iterations
        m.factor = factor
    return _k().apply_modifiers(obj)


def decimate(obj, ratio=0.5):
    """Fewer triangles (collapse), keeping the shape: game budgets, low-poly looks."""
    m = obj.modifiers.new("Decimate", "DECIMATE")
    m.ratio = max(0.01, min(1.0, ratio))
    return _k().apply_modifiers(obj)


def _finish(obj, material=None, smooth=True, coll=None):
    k = _k()
    if material is not None:
        k.paint(obj, material)
    if smooth:
        k.smooth(obj, angle=60)
    if coll is not None:
        k.link(obj, coll)
    return obj


# ------------------------------------------------------------------------------------------------
# Blobs: smooth unions of volumes (creatures, mushrooms, clouds, soft props)
# ------------------------------------------------------------------------------------------------

# A metaball's surface sits inside its influence radius; measured for threshold 0.6, stiffness 2.
_MB_SCALE = 1.0 / 0.785


def blob(name, parts, *, blend=1.0, material=None, resolution=None, coll=None, smooth=True):
    """One smooth organic surface from overlapping volumes, blended where they meet (like clay).

    parts: list of dicts, each one of
      {"sphere": (x, y, z), "r": 0.3}
      {"ellipsoid": (x, y, z), "radii": (rx, ry, rz), "rot": (rx_deg, ry_deg, rz_deg)}
      {"capsule": [(x, y, z), (x, y, z)], "r": 0.1}            # a limb segment
      {"chain": [(x, y, z), ...], "r": [0.2, 0.15, 0.08]}       # a tapered limb/tail/neck
      add "subtract": True to carve a volume away (eye sockets, mouths, hollows).
    blend: 0.5 = tight joins, 1 = soft, 2 = very melted. Sizes are the final surface sizes in meters.
    resolution: the mesh detail in meters (None = automatic, about 1/90 of the whole size; 0.02–0.04 for
    a creature a few meters long; smaller is finer and slower, and kiln.decimate trims it afterwards).
    Returns a mesh object. Follow with kiln.displace for skin/bark detail and kiln.smooth_shape if needed.
    """
    mb = bpy.data.metaballs.new(name + "_mb")
    mb.threshold = 0.6
    radii = []
    stiff = 2.0 / max(0.25, blend)

    def add(kind, co, r, sub=False, **kw):
        el = mb.elements.new(type=kind)
        el.co = Vector(co)
        el.radius = r * _MB_SCALE
        el.stiffness = stiff
        el.use_negative = bool(sub)
        for key, v in kw.items():
            setattr(el, key, v)
        radii.append(r)
        return el

    for p in parts:
        sub = p.get("subtract", False)
        if "sphere" in p:
            add("BALL", p["sphere"], p.get("r", 0.2), sub)
        elif "ellipsoid" in p:
            rx, ry, rz = p["radii"]
            r = max(rx, ry, rz)
            rot = p.get("rot", (0, 0, 0))
            q = Matrix.Rotation(math.radians(rot[2]), 4, "Z") @ Matrix.Rotation(math.radians(rot[1]), 4, "Y") @ Matrix.Rotation(math.radians(rot[0]), 4, "X")
            add("ELLIPSOID", p["ellipsoid"], r, sub, size_x=rx / r, size_y=ry / r, size_z=rz / r, rotation=q.to_quaternion())
        elif "capsule" in p or "chain" in p:
            pts = [Vector(v) for v in (p.get("capsule") or p.get("chain"))]
            rs = p.get("r", 0.1)
            rs = list(rs) if isinstance(rs, (list, tuple)) else [rs] * len(pts)
            if len(rs) < len(pts):
                rs = rs + [rs[-1]] * (len(pts) - len(rs))
            # A tapered chain of balls, dense enough to read as one smooth tube.
            for a, b, ra, rb in zip(pts, pts[1:], rs, rs[1:]):
                seg = (b - a).length
                thin = max(min(ra, rb), max(ra, rb) * 0.15, 1e-4)  # a zero or hair-thin end must not ask for thousands of balls
                n = min(400, max(2, int(math.ceil(seg / (thin * 0.5)))))
                for i in range(n + 1):
                    t = i / n
                    add("BALL", a.lerp(b, t), ra + (rb - ra) * t, sub)
    ob = bpy.data.objects.new(name + "_mb", mb)
    bpy.context.scene.collection.objects.link(ob)
    if resolution:
        res = resolution
    else:
        pts = [Vector(e.co) for e in mb.elements]
        extent = max(((a - b).length for a in pts for b in pts[:40]), default=0.0) + 2 * max(radii or [0.1])
        res = max(min(radii or [0.05]) * 0.6, extent / 90, 0.004)
    mb.resolution = res
    mb.render_resolution = res
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.metaballs.remove(mb)
    me.name = name
    out = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(out)
    return _finish(out, material, smooth, coll)


# ------------------------------------------------------------------------------------------------
# Tubes: branches, roots, vines, tentacles, horns, cables, rope
# ------------------------------------------------------------------------------------------------

def _curve_mesh(name, splines, sides=8, smooth_curve=True, caps=True, coll=None, material=None):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 1.0
    cu.bevel_resolution = max(0, (sides - 4) // 2)
    cu.use_fill_caps = caps
    cu.resolution_u = 6 if smooth_curve else 1
    for pts, radii in splines:
        if smooth_curve and len(pts) > 2:
            sp = cu.splines.new("BEZIER")
            sp.bezier_points.add(len(pts) - 1)
            for bp, co, r in zip(sp.bezier_points, pts, radii):
                bp.co = Vector(co)
                bp.handle_left_type = bp.handle_right_type = "AUTO"
                bp.radius = r
        else:
            sp = cu.splines.new("POLY")
            sp.points.add(len(pts) - 1)
            for pt, co, r in zip(sp.points, pts, radii):
                pt.co = (*co, 1.0)
                pt.radius = r
    tmp = bpy.data.objects.new(name + "_curve", cu)
    bpy.context.scene.collection.objects.link(tmp)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.curves.remove(cu)
    me.name = name
    # Weld the caps to the tube and close what's left, so tubes are closed shells (game-ready, no
    # open edges); a curve's filled caps are separate faces otherwise.
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    if caps:
        bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return _finish(ob, material, True, coll)


def tube(name, points, radius=0.05, sides=8, smooth=True, caps=True, material=None, coll=None):
    """A tube through points (list of (x, y, z)), with one radius or one per point (tapering):
    branches, roots, vines, tentacles, horns, tails, pipes, cables. smooth=True curves through the points."""
    pts = [tuple(p) for p in points]
    radii = list(radius) if isinstance(radius, (list, tuple)) else [radius] * len(pts)
    if len(radii) < len(pts):
        radii += [radii[-1]] * (len(pts) - len(radii))
    return _curve_mesh(name, [(pts, radii)], sides, smooth, caps, coll, material)


def rope(name, a, b, sag=0.15, radius=0.015, points=12, material=None, coll=None):
    """A hanging rope/cable/chain line between two points with a natural sag (catenary-like)."""
    a, b = Vector(a), Vector(b)
    pts = []
    for i in range(points + 1):
        t = i / points
        p = a.lerp(b, t)
        p.z -= sag * 4 * t * (1 - t)
        pts.append(tuple(p))
    return tube(name, pts, radius, sides=6, material=material, coll=coll)


# ------------------------------------------------------------------------------------------------
# Rocks
# ------------------------------------------------------------------------------------------------

def rock(name, size=(1.0, 0.8, 0.6), seed=0, style="boulder", detail=3, material=None, coll=None):
    """A rock resting on z = 0 (its base flattened), size in meters (x, y, z).
    style: "boulder" (rounded, noisy), "lowpoly" (faceted, flat-shaded game style), "slab" (flat, layered),
    "cliff" (tall, blocky with strata). Returns the mesh object; place it with kiln.place_on / scatter."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=max(1, min(5, detail)), radius=1.0)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    co = _coords(me)
    rng = np.random.default_rng(seed)
    n = co / np.linalg.norm(co, axis=1, keepdims=True)
    big = fbm3(co * 0.9 + rng.random(3) * 10, 1.0, 3, seed)
    fine = fbm3(co * 3.0 + rng.random(3) * 10, 1.0, 3, seed + 7)
    if style == "slab":
        co[:, 2] *= 0.35
        co += n * (big[:, None] * 0.18 + fine[:, None] * 0.05)
        co[:, 2] += np.round(co[:, 2] * 6) / 6 * 0.15
    elif style == "cliff":
        co += n * (big[:, None] * 0.25)
        co[:, 2] = np.round(co[:, 2] * 5) / 5 * 0.7 + co[:, 2] * 0.3
        co[:, :2] *= 1 + 0.12 * np.sign(np.sin(co[:, 2:3] * 9))
    else:
        co += n * (big[:, None] * 0.28 + fine[:, None] * (0.06 if style == "boulder" else 0.02))
    # Chip a couple of flat facets for a hewn look.
    for _ in range(3 if style != "boulder" else 1):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        cut = 0.55 + rng.random() * 0.3
        dist = co @ d
        over = dist > cut
        co[over] -= np.outer(dist[over] - cut, d)
    co = co * np.array(size) * 0.5
    zmin = co[:, 2].min()
    base = zmin + (co[:, 2].max() - zmin) * 0.12
    co[:, 2] = np.maximum(co[:, 2], base) - base
    _set_coords(me, co)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if material is None:
        k = _k()
        material = bpy.data.materials.get("Rock")  # every rock shares one texture set (it used to be rebuilt per rock)
        if material is None:
            g = k.noise(256, 4, seed=1)
            material = k.pbr("Rock", k.ramp(g, ["#4a4641", "#77716a", "#9a948b"]), height=g, roughness=0.8, bump=3)
        kiln_uv = k.uv_box
        kiln_uv(ob, size=max(size) * 0.7)
    lowpoly = style == "lowpoly"
    _finish(ob, material, not lowpoly, coll)
    if lowpoly:
        for p in ob.data.polygons:
            p.use_smooth = False
    return ob


# ------------------------------------------------------------------------------------------------
# Trees and bushes
# ------------------------------------------------------------------------------------------------

_TREE = {
    #        trunk h, trunk r, levels, children, spread deg, up bias, len factor, leaves
    "oak": dict(trunk=0.4, r=0.045, levels=3, kids=(4, 3, 3), spread=46, up=0.5, shrink=0.62, leaf=0.15, gnarl=0.16),
    "birch": dict(trunk=0.55, r=0.025, levels=3, kids=(5, 3, 2), spread=30, up=0.7, shrink=0.55, leaf=0.1, gnarl=0.08),
    "pine": dict(trunk=0.95, r=0.03, levels=1, kids=(14,), spread=80, up=-0.15, shrink=0.35, leaf=0.0, gnarl=0.03),
    "dead": dict(trunk=0.45, r=0.04, levels=3, kids=(3, 3, 2), spread=45, up=0.15, shrink=0.6, leaf=0.0, gnarl=0.3),
    "palm": dict(trunk=1.0, r=0.028, levels=0, kids=(), spread=0, up=0.0, shrink=0.0, leaf=0.0, gnarl=0.02),
}


def _perp(v):
    a = Vector((1, 0, 0)) if abs(v.x) < 0.9 else Vector((0, 1, 0))
    return v.cross(a).normalized()


def _branch_points(start, direction, length, rng, gnarl, segments=4, droop=0.0):
    pts = [Vector(start)]
    d = direction.normalized()
    step = length / segments
    p = Vector(start)
    for i in range(segments):
        jitter = Vector(rng.normal(size=3)) * gnarl
        d = (d + jitter * 0.6 + Vector((0, 0, -droop * (i + 1) / segments))).normalized()
        p = p + d * step
        pts.append(p.copy())
    return pts


def tree(name, height=6.0, style="oak", seed=0, leaves="clusters", leaf_color="#4f7a2e", bark_color="#5b4632", coll=None, join=False, max_tris=None):
    """A tree on the ground at the origin, `height` meters tall.
    style: "oak" (broad, gnarled), "birch" (slim, upright), "pine" (conifer tiers), "dead" (bare, twisty),
    "palm" (curved trunk, fronds). leaves: "clusters" (lumpy stylized clumps: game style),
    "cards" (leaf-textured planes: more natural), or "none".
    Returns the tree: an empty named `name` holding `<name>_Trunk` and its foliage (move/scale/link the
    empty; its children are the meshes). join=True returns ONE mesh object named `name` instead (bark +
    leaf materials, origin at the base): the best source for kiln.scatter. max_tris decimates it to a
    budget (e.g. 1500 for a map tree)."""
    k = _k()
    rng = np.random.default_rng(seed)
    cfg = _TREE.get(style, _TREE["oak"])
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    if coll is not None:
        k.link(root, coll)
    splines = []
    tips = []
    base_r = height * cfg["r"]

    if style == "palm":
        lean = Vector((rng.normal() * 0.3, rng.normal() * 0.3, 1)).normalized()
        pts = []
        for i in range(8):
            t = i / 7
            pts.append(Vector((lean.x * height * 0.35 * t * t, lean.y * height * 0.35 * t * t, height * t)))
        splines.append((pts, [base_r * (1.2 - 0.45 * t) for t in np.linspace(0, 1, len(pts))]))
        top = pts[-1]
        fronds = []
        for j in range(9):
            az = j / 9 * math.tau + rng.random() * 0.3
            out = Vector((math.cos(az), math.sin(az), 0.35))
            fronds.append([top + out * height * 0.22 * s + Vector((0, 0, -height * 0.18 * s * s)) for s in np.linspace(0, 1, 6)])
    else:
        trunk_len = height * cfg["trunk"]
        trunk = _branch_points((0, 0, 0), Vector((rng.normal() * 0.08, rng.normal() * 0.08, 1)), trunk_len, rng, cfg["gnarl"] * 0.5, 5)
        trunk_r = [base_r * (1 - 0.35 * t) for t in np.linspace(0, 1, len(trunk))]
        # Root flare: a few short roots spreading out and down into the ground.
        for j in range(5 if style in ("oak", "dead") else 3):
            az = j / 5 * math.tau + rng.random() * 0.6
            d = Vector((math.cos(az), math.sin(az), -0.25))
            rp = [Vector((0, 0, base_r * 0.8)), Vector((0, 0, base_r * 0.8)) + d * base_r * 2.2, Vector((0, 0, 0)) + d * base_r * 4.5 + Vector((0, 0, -base_r * 0.6))]
            splines.append((rp, [base_r * 0.7, base_r * 0.35, base_r * 0.08]))
        splines.append((trunk, trunk_r))
        if style == "pine":
            tips.append((trunk[-1], height, trunk[0], 1.0))
        else:
            def grow(pts, radius, level, length):
                if level >= cfg["levels"]:
                    tips.append((pts[-1], length, pts[0], 1.0))
                    return
                n = cfg["kids"][min(level, len(cfg["kids"]) - 1)]
                parent_dir = (pts[-1] - pts[-2]).normalized()
                for j in range(n):
                    t = 0.45 + 0.55 * (j + rng.random() * 0.5) / n if level else 0.72 + 0.28 * j / n
                    idx = t * (len(pts) - 1)
                    i0 = int(idx)
                    i1 = min(i0 + 1, len(pts) - 1)
                    start = pts[i0].lerp(pts[i1], idx - i0)
                    az = j * 2.39996 + rng.random() * 0.5
                    side = _perp(parent_dir)
                    side.rotate(Quaternion(parent_dir, az))
                    ang = math.radians(cfg["spread"] * (0.75 + 0.5 * rng.random()))
                    d = (parent_dir * math.cos(ang) + side * math.sin(ang) + Vector((0, 0, cfg["up"]))).normalized()
                    ln = length * cfg["shrink"] * (0.8 + 0.4 * rng.random())
                    bp = _branch_points(start, d, ln, rng, cfg["gnarl"], 4)
                    r0 = radius * (0.72 - 0.1 * t)
                    splines.append((bp, [r0 * (1 - 0.7 * s) + 0.004 for s in np.linspace(0, 1, len(bp))]))
                    grow(bp, r0, level + 1, ln)
            grow(trunk, trunk_r[-1] * 1.15, 0, height - trunk_len if style != "birch" else height * 0.55)

    bark_name = "Kit_Bark_" + str(bark_color).lstrip("#")  # trees of one bark colour share one texture set
    wood = bpy.data.materials.get(bark_name) or k.pbr(bark_name, k.ramp(k.noise(256, 3, seed=1, stretch=(1, 10)), [bark_color, "#2e241b", bark_color]), height=k.noise(256, 4, seed=2, stretch=(1, 8)), roughness=0.85, bump=4)
    trunk_ob = _curve_mesh(name + "_Trunk", splines, sides=8, material=wood)
    k.uv_box(trunk_ob, size=max(0.5, base_r * 8))
    trunk_ob.parent = root

    foliage = None
    if style == "palm":
        leaf = k.mat(name + "_Fronds", leaf_color, roughness=0.6)
        frond_splines = [(f, [height * 0.035] * 2 + [height * 0.03] * 2 + [height * 0.015, 0.004]) for f in fronds]
        foliage = _curve_mesh(name + "_Fronds", frond_splines, sides=4, material=leaf)
    elif leaves != "none" and tips and (cfg["leaf"] or style == "pine"):
        leaf = k.mat(name + "_Leaves", leaf_color, roughness=0.7)
        if style == "pine":
            foliage = _pine_tiers(name + "_Needles", height, rng, leaf)
            _vary_color(foliage, leaf_color, seed)
        elif leaves == "cards":
            foliage = _leaf_cards(name + "_Leaves", tips, height, rng, leaf_color)
        else:
            # Clumps at the branch tips (raised a little so the crown sits on the branches), plus a few
            # inner clumps so the crown reads as one mass without becoming a single blob.
            parts = []
            low = height * 0.42
            for p, ln, origin, w in tips:
                if p.z < low:
                    p = Vector((p.x * 0.8, p.y * 0.8, low + (p.z - low) * 0.2))
                r = height * cfg["leaf"] * (0.7 + 0.5 * rng.random())
                parts.append({"sphere": tuple(p + Vector((0, 0, r * 0.35))), "r": r})
                for _ in range(2):
                    q = p + Vector((rng.normal() * r * 0.8, rng.normal() * r * 0.8, abs(rng.normal()) * r * 0.5))
                    parts.append({"sphere": tuple(q), "r": r * (0.55 + 0.25 * rng.random())})
            foliage = blob(name + "_Canopy", parts, blend=0.55, material=leaf, resolution=height * 0.022)
            displace(foliage, strength=height * 0.03, scale=height * 0.08, octaves=3, seed=seed)
            _vary_color(foliage, leaf_color, seed)
        if foliage is not None:
            k.smooth(foliage, angle=80)
    if foliage is not None:
        foliage.parent = root
    for ob in (trunk_ob, foliage):
        if ob is not None and coll is not None:
            k.link(ob, coll)
    if join:
        parts = [o for o in (trunk_ob, foliage) if o is not None]
        for o in parts:
            o.parent = None
        bpy.data.objects.remove(root, do_unlink=True)
        one = k.join(parts, name=name) if len(parts) > 1 else parts[0]
        one.name = name
        if max_tris:
            me = one.data
            me.calc_loop_triangles()
            n = len(me.loop_triangles)
            if n > max_tris:
                decimate(one, max_tris / n)
        if coll is not None:
            k.link(one, coll)
        return one
    return root


def _pine_tiers(name, height, rng, material):
    """Stacked drooping cones with jagged rims: a conifer that reads well from any distance."""
    bm = bmesh.new()
    tiers = 6
    for i in range(tiers):
        t = i / tiers
        z0 = height * (0.16 + 0.74 * t)
        r = height * 0.26 * (1 - t * 0.82) + height * 0.03
        h = r * 1.25
        seg = 16
        ring = []
        for j in range(seg):
            a = j / seg * math.tau + i * 0.4
            rr = r * (1.0 if j % 2 == 0 else 0.78) * (0.92 + 0.16 * rng.random())
            droop = -r * 0.18 * (1.0 if j % 2 == 0 else 0.5)
            ring.append(bm.verts.new((math.cos(a) * rr, math.sin(a) * rr, z0 + droop)))
        inner = [bm.verts.new((math.cos(j / seg * math.tau + i * 0.4) * r * 0.35, math.sin(j / seg * math.tau + i * 0.4) * r * 0.35, z0 + h * 0.05)) for j in range(seg)]
        tip = bm.verts.new((0, 0, z0 + h))
        for j in range(seg):
            k2 = (j + 1) % seg
            bm.faces.new((ring[j], ring[k2], tip))
            bm.faces.new((inner[k2], ring[k2], ring[j], inner[j]))
        bm.faces.new(list(reversed(inner)))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    _k().paint(ob, material)
    displace(ob, strength=height * 0.01, scale=height * 0.05, seed=int(rng.integers(1000)))
    return ob


def _vary_color(obj, hex_color, seed):
    """Per-vertex light/dark variation baked into a second material slot mix (via color attribute)."""
    me = obj.data
    try:
        attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    except Exception:  # noqa: BLE001
        return
    k = _k()
    base = np.array(k.color(hex_color)[:3])
    co = _coords(me)
    v = fbm3(co, 1.2, 3, seed + 3)
    up = _normals(me)[:, 2]
    shade = 0.75 + 0.35 * v + 0.15 * up
    cols = np.clip(base[None, :] * shade[:, None], 0, 1)
    rgba = np.concatenate([cols, np.ones((len(cols), 1))], axis=1)
    attr.data.foreach_set("color", rgba.ravel())
    mat = obj.data.materials[0] if obj.data.materials else None
    if mat is not None and mat.node_tree:
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        p = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if p is not None and not p.inputs["Base Color"].is_linked:
            a = nodes.new("ShaderNodeVertexColor")
            a.layer_name = "Col"
            links.new(a.outputs["Color"], p.inputs["Base Color"])


def _leaf_texture(name, hex_color, seed, size=256):
    k = _k()
    rng = np.random.default_rng(seed)
    img = np.zeros((size, size, 4))
    base = np.array(k.hex_rgb(hex_color))
    yy, xx = np.mgrid[0:size, 0:size] / size
    for _ in range(38):
        cx, cy = rng.random(2) * 0.8 + 0.1
        ang = rng.random() * math.pi
        a, b = 0.07 + rng.random() * 0.05, 0.03 + rng.random() * 0.015
        dx, dy = xx - cx, yy - cy
        u = dx * math.cos(ang) + dy * math.sin(ang)
        v = -dx * math.sin(ang) + dy * math.cos(ang)
        inside = (u / a) ** 2 + (v / b) ** 2 < 1
        shade = 0.75 + rng.random() * 0.5
        img[inside, :3] = np.clip(base * shade, 0, 1)
        img[inside, 3] = 1
    return k.image(name, img)


def _leaf_cards(name, tips, height, rng, hex_color):
    k = _k()
    tex = _leaf_texture(name + "_tex", hex_color, int(rng.integers(1e6)))
    mat = k.textured(name, tex, roughness=0.7, nearest=False)
    try:
        mat.blend_method = "CLIP"
    except Exception:  # noqa: BLE001
        pass
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    p = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    t = next(n for n in nodes if n.type == "TEX_IMAGE")
    links.new(t.outputs["Alpha"], p.inputs["Alpha"])
    bm = bmesh.new()
    uv = bm.loops.layers.uv.verify()
    for p0, ln, origin, w in tips:
        for _ in range(7):
            s = height * 0.16 * (0.7 + 0.6 * rng.random())
            c = Vector(p0) + Vector(rng.normal(size=3)) * height * 0.07
            q = Quaternion(Vector(rng.normal(size=3)).normalized(), rng.random() * math.pi)
            corners = [c + q @ Vector((x * s, 0, y * s)) for x, y in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5))]
            vs = [bm.verts.new(v) for v in corners]
            f = bm.faces.new(vs)
            for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                loop[uv].uv = (u, v)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    k.paint(ob, mat)
    return ob


def bush(name, radius=0.6, seed=0, color="#4d7a33", flowers=None, coll=None):
    """A rounded shrub sitting on the ground (lumpy blended clumps with color variation).
    flowers: an optional '#hex' for small blossom dots scattered on it."""
    k = _k()
    rng = np.random.default_rng(seed)
    parts = []
    for _ in range(7):
        d = Vector((rng.normal(), rng.normal(), abs(rng.normal()) * 0.6)).normalized() * radius * 0.55
        parts.append({"sphere": (d.x, d.y, radius * 0.55 + d.z), "r": radius * (0.45 + 0.2 * rng.random())})
    ob = blob(name, parts, blend=0.9, material=k.mat(name + "_Leaves", color, roughness=0.75), resolution=radius * 0.08, coll=coll)
    displace(ob, strength=radius * 0.08, scale=radius * 0.35, seed=seed)
    _vary_color(ob, color, seed)
    co = _coords(ob.data)
    co[:, 2] -= co[:, 2].min() + radius * 0.05
    _set_coords(ob.data, co)
    if flowers:
        fm = k.mat(name + "_Flowers", flowers, roughness=0.5)
        bm = bmesh.new()
        nrm = _normals(ob.data)
        idx = rng.choice(len(co), size=min(len(co), 40), replace=False)
        for i in idx:
            if nrm[i][2] < 0.1:
                continue
            m = Matrix.Translation(Vector(co[i]) + Vector(nrm[i]) * radius * 0.02)
            bmesh.ops.create_icosphere(bm, subdivisions=1, radius=radius * 0.045, matrix=m)
        me = bpy.data.meshes.new(name + "_Flowers")
        bm.to_mesh(me)
        bm.free()
        fl = bpy.data.objects.new(name + "_Flowers", me)
        bpy.context.scene.collection.objects.link(fl)
        k.paint(fl, fm)
        fl.parent = ob
        if coll is not None:
            k.link(fl, coll)
    return ob


# ------------------------------------------------------------------------------------------------
# Hard surfaces
# ------------------------------------------------------------------------------------------------

def _inside(q, loop):
    hit = False
    for a, b in zip(loop, loop[1:] + loop[:1]):
        if (a.y > q.y) != (b.y > q.y) and q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x:
            hit = not hit
    return hit


def _edge_dist(q, loop):
    best = 1e18
    for a, b in zip(loop, loop[1:] + loop[:1]):
        ab = b - a
        t = max(0.0, min(1.0, (q - a).dot(ab) / max(ab.length_squared, 1e-18)))
        best = min(best, (q - (a + ab * t)).length)
    return best


def shell(name, outline, depth=0.2, bevel=0.02, segments=3, soften=0, taper=1.0, crown=0.0, mirror=False,
          plane="xy", material=None, coll=None):
    """A hard-surface body from its outline: game controllers, remotes, phones, appliances, car bodies,
    panels, signs, tool housings. Manufactured things are an outline with thickness and softened edges,
    not blended blobs: draw the outline as points going round once, and this fills it, gives it `depth`
    and rounds its edges.
    outline: [(u, v), ...] in the plane named by `plane`: "xy" (seen from above; depth goes up from
    z = 0), "xz" (seen from the front; depth along y, centred on y = 0) or "yz" (seen from the side;
    depth along x, centred on x = 0: a car body's side profile).
    mirror=True: give only the half on u >= 0, from the centre line round to the centre line; the other
    half is its mirror image (symmetric products).
    soften: 1-3 turns the outline's corners into curves (each step cuts every corner once).
    bevel: the radius of the rounded edges (0 = sharp), segments: how round. taper: the far face's size
    relative to the near one (0.8 narrows it; (su, sv) per axis). crown: how far the far face domes up
    in its middle (a controller's top, a car's roof). Returns the mesh object, smooth-shaded with crisp
    edges, box UVs. Add buttons, ports and panel lines as separate small parts 1-2 mm proud or sunk."""
    import mathutils.geometry as geo
    k = _k()
    pts = [Vector((float(p[0]), float(p[1]))) for p in outline]
    if mirror:
        pts = pts + [Vector((-p.x, p.y)) for p in reversed(pts) if abs(p.x) > 1e-6]
    clean = []
    for p in pts:
        if not clean or (p - clean[-1]).length > 1e-6:
            clean.append(p)
    if len(clean) > 1 and (clean[0] - clean[-1]).length <= 1e-6:
        clean.pop()
    pts = clean
    if len(pts) < 3:
        raise ValueError("kiln.shell needs an outline of at least 3 points going round once")
    if plane not in ("xy", "xz", "yz"):
        raise ValueError('plane is "xy", "xz" or "yz"')
    if sum(a.x * b.y - b.x * a.y for a, b in zip(pts, pts[1:] + pts[:1])) < 0:
        pts.reverse()
    for _ in range(max(0, min(4, int(soften)))):
        cut = []
        for a, b in zip(pts, pts[1:] + pts[:1]):
            cut += [a.lerp(b, 0.25), a.lerp(b, 0.75)]
        pts = cut
    n = len(pts)
    c = sum(pts, Vector((0.0, 0.0))) / n
    su, sv = (float(taper[0]), float(taper[1])) if hasattr(taper, "__len__") else (float(taper), float(taper))
    depth = float(depth)
    if depth <= 0:
        raise ValueError("depth must be positive")
    far2 = [Vector((c.x + (p.x - c.x) * su, c.y + (p.y - c.y) * sv)) for p in pts]
    span = min(max(p.x for p in pts) - min(p.x for p in pts), max(p.y for p in pts) - min(p.y for p in pts))
    bevel = max(0.0, min(float(bevel), 0.45 * depth, 0.2 * span))
    bm = bmesh.new()
    near = [bm.verts.new((p.x, p.y, 0.0)) for p in pts]
    far = [bm.verts.new((p.x, p.y, depth)) for p in far2]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((near[i], near[j], far[j], far[i]))
    # A face: one polygon, or (domed) a triangulation with points inside it to lift. A body centred on
    # its plane ("xz", "yz") domes on both faces; one standing on the ground ("xy") only on top.
    inner = {}

    def face(ring, loop, z, sign):
        if not crown or not sign:
            bm.faces.new(ring if sign >= 0 and z > 0 else list(reversed(ring)))
            return
        step = max(span / 12.0, 1e-4)
        lo_x, hi_x = min(p.x for p in loop), max(p.x for p in loop)
        lo_y, hi_y = min(p.y for p in loop), max(p.y for p in loop)
        grid = []
        y = lo_y + step / 2
        while y < hi_y:
            x = lo_x + step / 2
            while x < hi_x:
                q = Vector((x, y))
                if _inside(q, loop) and _edge_dist(q, loop) > max(1.6 * bevel, 0.6 * step):
                    grid.append(q)
                x += step
            y += step
        res = geo.delaunay_2d_cdt(loop + grid, [], [list(range(n))], 1, 1e-7)
        made = []
        for i, co in enumerate(res[0]):
            src = [s for s in res[3][i] if s < n]
            if src:
                made.append(ring[src[0]])
            else:
                v = bm.verts.new((co.x, co.y, z))
                inner[v] = (Vector((co.x, co.y)), loop, sign)
                made.append(v)
        for f in res[2]:
            try:
                bm.faces.new([made[i] for i in f])
            except ValueError:
                pass

    face(near, pts, 0.0, -1 if plane != "xy" else 0)
    face(far, far2, depth, 1)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    if bevel > 1e-6:
        # Hard corners of the outline first (their radius is limited by the sides that meet there)...
        seg = [(pts[(i + 1) % n] - pts[i]).length for i in range(n)]
        upright, reach = [], bevel
        for i in range(n):
            a, b = pts[i] - pts[i - 1], pts[(i + 1) % n] - pts[i]
            if a.length < 1e-9 or b.length < 1e-9 or a.angle(b) < math.radians(28):
                continue
            e = bm.edges.get((near[i], far[i]))
            if e is not None:
                upright.append(e)
                reach = min(reach, 0.4 * min(seg[i - 1], seg[i]))
        if upright and reach > 1e-5:
            bmesh.ops.bevel(bm, geom=upright, offset=reach, segments=max(1, int(segments)), profile=0.5, affect="EDGES", clamp_overlap=True)
            bm.normal_update()
        # ...then the two rims, all the way round.
        rims = [e for e in bm.edges if len(e.link_faces) == 2 and (abs(e.link_faces[0].normal.z) > 0.9) != (abs(e.link_faces[1].normal.z) > 0.9)]
        if rims:
            bmesh.ops.bevel(bm, geom=rims, offset=bevel, segments=max(1, int(segments)), profile=0.5, affect="EDGES", clamp_overlap=True)
    if inner:
        dist = {v: (_edge_dist(q, loop), sign) for v, (q, loop, sign) in inner.items() if v.is_valid}
        top = max((d for d, _ in dist.values()), default=0.0)
        for v, (d, sign) in dist.items():
            v.co.z += sign * float(crown) * math.sin(math.pi / 2 * min(1.0, d / max(top, 1e-9)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if plane == "xz":      # seen from the front: u = x, v = z, thickness along y
        bm.transform(Matrix(((1, 0, 0, 0), (0, 0, 1, -depth / 2), (0, 1, 0, 0), (0, 0, 0, 1))))
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    elif plane == "yz":    # seen from the side: u = y, v = z, thickness along x
        bm.transform(Matrix(((0, 0, 1, -depth / 2), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    ob = k.mesh_object(name, bm, coll)
    if material is not None:
        k.paint(ob, material)
    k.smooth(ob, 35)
    k.uv_box(ob, 1.0)
    return ob
