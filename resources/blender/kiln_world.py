"""
Map and game-asset building blocks for the copilot (exposed through `kiln`): terrain, placing things on
the ground, scattering, paths, water, a modular building kit (walls with openings, roofs, stairs,
railings, fences, whole houses in one style) and game-readiness checks. Units are meters, Z up,
the ground is z = 0 unless a terrain says otherwise.
"""

import json
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from kiln_shapes import _coords, _set_coords, fbm3


def _k():
    import kiln
    return kiln


def _new_object(name, bm, coll=None, material=None, uv=True):
    k = _k()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if coll is not None:
        k.link(ob, coll)
    if material is not None:
        k.paint(ob, material)
    if uv and not me.uv_layers:
        k.uv_box(ob, size=1.0)
    return ob


def _box(bm, lo, hi):
    lo, hi = Vector(lo), Vector(hi)
    c = (lo + hi) / 2
    s = hi - lo
    m = Matrix.Translation(c) @ Matrix.Diagonal((s.x, s.y, s.z, 1))
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)


# ------------------------------------------------------------------------------------------------
# Terrain and the ground
# ------------------------------------------------------------------------------------------------

def _seg_dist(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    t = np.clip(((px - ax) * abx + (py - ay) * aby) / max(abx * abx + aby * aby, 1e-9), 0, 1)
    return np.hypot(px - (ax + t * abx), py - (ay + t * aby))


def _polyline_dist(px, py, pts):
    d = np.full(px.shape, np.inf)
    for (ax, ay, *_), (bx, by, *_) in zip(pts, pts[1:]):
        d = np.minimum(d, _seg_dist(px, py, ax, ay, bx, by))
    return d


def terrain(name, size=(60, 60), height=4.0, feature=20.0, resolution=0.75, seed=0, island=False,
            flat=(), paths=(), rivers=(), base_color=None, material=None, coll=None, skirt=0.0, skirt_color="#5a4632"):
    """Ground as one mesh centred on the origin, heights from fractal noise.
    size (x, y) meters; height: hills' height; feature: hill size in meters; resolution: vertex spacing.
    island=True sinks the edges below 0 (with water at 0 that makes an island).
    flat: [(x, y, radius, z)] level plots for buildings, plazas, arenas (smoothly blended).
    paths: [([(x, y), ...], width)] gently levelled tracks (roads). rivers: [([(x, y), ...], width, depth)] carved beds.
    skirt > 0 closes the edges down to (lowest point - skirt) with a soil band: a diorama / tabletop base.
    Place things on it with kiln.ground_z / kiln.place_on / kiln.scatter."""
    k = _k()
    sx, sy = size
    nx, ny = max(2, int(sx / resolution) + 1), max(2, int(sy / resolution) + 1)
    xs, ys = np.linspace(-sx / 2, sx / 2, nx), np.linspace(-sy / 2, sy / 2, ny)
    X, Y = np.meshgrid(xs, ys)
    pts = np.stack([X.ravel(), Y.ravel(), np.zeros(X.size)], axis=1)
    h = (fbm3(pts, feature, 5, seed) * 0.5 + 0.5) * height
    Z = h.reshape(X.shape)
    if island:
        r = np.hypot(X / (sx / 2), Y / (sy / 2))
        Z = Z * (1 - np.clip((r - 0.55) / 0.4, 0, 1) ** 1.5) - np.clip((r - 0.7) / 0.3, 0, 1) * height * 0.8
    for (fx, fy, fr, fz) in flat:
        d = np.hypot(X - fx, Y - fy)
        w = 1 - np.clip((d - fr) / max(fr * 0.8, 2.0), 0, 1)
        w = w * w * (3 - 2 * w)
        Z = Z * (1 - w) + fz * w
    for (line, width) in paths:
        d = _polyline_dist(X, Y, line)
        w = 1 - np.clip((d - width / 2) / max(width, 1.5), 0, 1)
        w = w * w * (3 - 2 * w)
        smooth = Z.copy()
        for _ in range(6):
            smooth = (np.roll(smooth, 1, 0) + np.roll(smooth, -1, 0) + np.roll(smooth, 1, 1) + np.roll(smooth, -1, 1) + smooth * 4) / 8
        Z = Z * (1 - w) + smooth * w
    for (line, width, depth) in rivers:
        d = _polyline_dist(X, Y, line)
        w = 1 - np.clip(d / (width * 0.5 + max(width, 2.0)), 0, 1)
        Z = Z - depth * (w * w * (3 - 2 * w))
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, z)) for x, y, z in zip(X.ravel(), Y.ravel(), Z.ravel())]
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            bm.faces.new((verts[a], verts[a + 1], verts[a + nx + 1], verts[a + nx]))
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = (loop.vert.co.x / 4.0, loop.vert.co.y / 4.0)
    if material is None:
        g = k.noise(512, 6, seed=seed)
        cols = base_color or ["#4c6b2f", "#5f8038", "#7a8f45"]  # a list of hex stops, or one '#hex' (spread for you)
        material = k.pbr(name + "_Ground", k.ramp(g, cols), height=g, roughness=0.9, bump=2)
    ob = _new_object(name, bm, coll, material, uv=False)
    k.smooth(ob, angle=50)
    ob["kiln_ground"] = True
    if skirt > 0:
        # Side walls from the terrain's edge down to a flat bottom, in a soil material.
        zb = float(Z.min()) - skirt
        edge = [(i, 0) for i in range(nx)] + [(nx - 1, j) for j in range(1, ny)] + [(i, ny - 1) for i in range(nx - 2, -1, -1)] + [(0, j) for j in range(ny - 2, 0, -1)]
        sb = bmesh.new()
        top = [sb.verts.new((X[j, i], Y[j, i], Z[j, i])) for i, j in edge]
        bot = [sb.verts.new((X[j, i], Y[j, i], zb)) for i, j in edge]
        for a in range(len(edge)):
            b = (a + 1) % len(edge)
            sb.faces.new((top[a], bot[a], bot[b], top[b]))
        sb.faces.new(bot)
        bmesh.ops.recalc_face_normals(sb, faces=sb.faces)
        soil = k.mat(name + "_Soil", skirt_color, roughness=0.95)
        sk = _new_object(name + "_Skirt", sb, coll, soil)
        sk.parent = ob
    return ob


def ground_z(x, y, ground=None, default=0.0, skip=()):
    """Height of the ground at (x, y): the terrain object `ground`, else any object marked as ground,
    else the top of whatever else is under that point (objects in `skip` don't count), else `default`.
    Use it so nothing floats or sinks on uneven ground."""
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    grounds = [ground] if ground is not None else [o for o in scene.objects if o.get("kiln_ground")]
    best = None
    for g in grounds:
        inv = g.matrix_world.inverted()
        o = inv @ Vector((x, y, 10000.0))
        d = (inv.to_3x3() @ Vector((0, 0, -1))).normalized()
        ok, loc, _n, _i = g.ray_cast(o, d)
        if ok:
            z = (g.matrix_world @ loc).z
            best = z if best is None else max(best, z)
    if best is None and ground is None and not grounds:
        # No terrain: stand on whatever is there, but never on the thing being placed (or its parts).
        ignore = set(skip)
        z = 10000.0
        for _ in range(24):
            ok, loc, _n, _i, hit, _m = scene.ray_cast(dg, Vector((x, y, z)), Vector((0, 0, -1)))
            if not ok:
                break
            if hit not in ignore:
                best = loc.z
                break
            z = loc.z - 1e-4
    return default if best is None else best


def place_on(obj, x, y, ground=None, sink=0.02, rotation_z=None):
    """Put an object at (x, y) with its lowest point on the ground (sunk `sink` meters so it sits in)."""
    k = _k()
    obj.location.x, obj.location.y = x, y
    if rotation_z is not None:
        obj.rotation_euler.z = math.radians(rotation_z)
    bpy.context.view_layer.update()
    own = [obj] + list(obj.children_recursive)
    lo, _ = k.bounds([o for o in own if o.type == "MESH"] or [obj])
    z = ground_z(x, y, ground, skip=own)
    obj.location.z += z - lo.z - sink
    return obj


def _over(objs, x, y, margin):
    """Whether (x, y) is over (or within `margin` of) the actual footprint of any of these meshes: a
    winding road keeps only its own ribbon clear, not a circle as wide as the road is long."""
    for o in objs:
        inv = o.matrix_world.inverted()
        d = (inv.to_3x3() @ Vector((0, 0, -1))).normalized()
        for dx, dy in ((0, 0), (margin, 0), (-margin, 0), (0, margin), (0, -margin)):
            try:
                if o.ray_cast(inv @ Vector((x + dx, y + dy, 10000.0)), d)[0]:
                    return True
            except RuntimeError:
                return False
    return False


def scatter(sources, count=20, area=(-10, -10, 10, 10), ground=None, min_dist=1.0, scale=(0.8, 1.2),
            rotate=True, max_slope=35.0, avoid=(), seed=0, sink=0.03, coll=None, name=None):
    """Scatter linked copies of `sources` (an object, a piece from kiln.piece, or a list of variants) over
    area (xmin, ymin, xmax, ymax) on the ground, at least min_dist apart, skipping slopes steeper than
    max_slope and anything in `avoid` (objects, or (x, y, radius) circles: roads, buildings, plazas).
    The sources are hidden (kept as templates). Returns the new objects."""
    k = _k()
    rng = np.random.default_rng(seed)
    srcs = list(sources) if isinstance(sources, (list, tuple)) else [sources]
    coll = coll if coll is not None else k.collection(name or (srcs[0].name + "_Scatter"))
    circles, solids = [], []
    for a in avoid if isinstance(avoid, (list, tuple)) and not (len(avoid) == 3 and all(isinstance(v, (int, float)) for v in avoid)) else [avoid]:
        if isinstance(a, bpy.types.Object):
            solids += [o for o in [a] + list(a.children_recursive) if o.type == "MESH"]
        else:
            circles.append(tuple(a))
    # Things made or moved earlier in the same script must be where the script put them.
    bpy.context.view_layer.update()
    bpy.context.evaluated_depsgraph_get()
    grounds = [ground] if ground is not None else [o for o in bpy.context.scene.objects if o.get("kiln_ground")]
    placed, out = [], []
    x0, y0, x1, y1 = area
    tries = 0
    while len(out) < count and tries < count * 40:
        tries += 1
        x, y = x0 + rng.random() * (x1 - x0), y0 + rng.random() * (y1 - y0)
        if any(math.hypot(x - px, y - py) < min_dist for px, py in placed):
            continue
        if any(math.hypot(x - cx, y - cy) < cr for cx, cy, cr in circles):
            continue
        if solids and _over(solids, x, y, min_dist * 0.5):
            continue
        z, nz = 0.0, 1.0
        if grounds:
            hit = False
            for g in grounds:
                inv = g.matrix_world.inverted()
                ok, loc, nrm, _i = g.ray_cast(inv @ Vector((x, y, 10000.0)), (inv.to_3x3() @ Vector((0, 0, -1))).normalized())
                if ok:
                    z = (g.matrix_world @ loc).z
                    nz = (g.matrix_world.to_3x3() @ nrm).normalized().z
                    hit = True
                    break
            if not hit:
                continue
        if math.degrees(math.acos(max(-1, min(1, nz)))) > max_slope:
            continue
        src = srcs[int(rng.integers(len(srcs)))]
        s = scale[0] + (scale[1] - scale[0]) * rng.random()
        if isinstance(src, bpy.types.Collection):  # a piece (kiln.piece): a placement, not a copy
            ob = k.place(src, (x, y, z - sink * s), scale=s, coll=coll)
        else:
            ob = _copy_hierarchy(src, coll)
            ob.scale = (src.scale.x * s, src.scale.y * s, src.scale.z * s)
            ob.location = (x, y, z - sink * s)
            ob.hide_viewport = ob.hide_render = False
        if rotate:
            ob.rotation_euler.z = rng.random() * math.tau
        placed.append((x, y))
        out.append(ob)
    for s in srcs:
        if not isinstance(s, bpy.types.Collection):
            _hide(s)
    if len(out) < count:
        print("scatter: placed %d of %d (the rest found no free spot: area, min_dist, max_slope or avoid are too tight)" % (len(out), count))
    return out


def _hide(ob):
    ob.hide_viewport = ob.hide_render = True
    for c in ob.children_recursive:
        c.hide_viewport = c.hide_render = True


def _copy_hierarchy(src, coll):
    """A linked copy of an object with everything parented under it (a bush's flowers, a body's spikes)."""
    k = _k()
    root = src.copy()
    k.link(root, coll)

    def kids(a, b):
        for c in a.children:
            cc = c.copy()
            k.link(cc, coll)
            cc.parent = b
            cc.matrix_parent_inverse = c.matrix_parent_inverse.copy()
            cc.hide_viewport = cc.hide_render = False
            kids(c, cc)

    kids(src, root)
    return root


def path(name, points, width=2.0, ground=None, lift=0.03, material=None, coll=None, edge=0.0):
    """A road/footpath ribbon following points [(x, y), ...] over the ground (terrain-conforming), with
    UVs along its length. edge > 0 adds raised curbs/borders of that height."""
    k = _k()
    pts = [Vector((p[0], p[1], 0)) for p in points]
    dense = []
    for a, b in zip(pts, pts[1:]):
        n = max(1, int((b - a).length / 0.5))
        for i in range(n):
            dense.append(a.lerp(b, i / n))
    dense.append(pts[-1])
    bm = bmesh.new()
    uv = bm.loops.layers.uv.verify()
    left, right, dist = [], [], [0.0]
    for i, p in enumerate(dense):
        d = (dense[min(i + 1, len(dense) - 1)] - dense[max(i - 1, 0)])
        d.z = 0
        d.normalize()
        side = Vector((-d.y, d.x, 0)) * width / 2
        for lst, q in ((left, p + side), (right, p - side)):
            z = ground_z(q.x, q.y, ground) + lift
            lst.append(bm.verts.new((q.x, q.y, z)))
        if i:
            dist.append(dist[-1] + (dense[i] - dense[i - 1]).length)
    for i in range(len(dense) - 1):
        f = bm.faces.new((left[i], right[i], right[i + 1], left[i + 1]))
        for loop, (u, v) in zip(f.loops, ((0, dist[i]), (1, dist[i]), (1, dist[i + 1]), (0, dist[i + 1]))):
            loop[uv].uv = (u * width / 2, v / 2)
    if edge > 0:
        for side_verts in (left, right):
            geom = bmesh.ops.extrude_edge_only(bm, edges=[bm.edges.get((side_verts[i], side_verts[i + 1])) for i in range(len(side_verts) - 1)])
            for v in (e for e in geom["geom"] if isinstance(e, bmesh.types.BMVert)):
                v.co.z += edge
    if material is None:
        material = bpy.data.materials.get("Kit_Path")  # one texture set for every path, not one each
        if material is None:
            g = k.noise(256, 8, seed=3)
            material = k.pbr("Kit_Path", k.ramp(g, ["#6e6152", "#8a7a66", "#9d8c75"]), height=g, roughness=0.95, bump=2)
    # The centre line travels with the road: the game's code needs it (resets, laps, AI), see kiln.layout().
    step = max(1, len(dense) // 1500)
    keep = list(range(0, len(dense), step))
    if keep[-1] != len(dense) - 1:
        keep.append(len(dense) - 1)
    centre = [[round(dense[i].x, 3), round(dense[i].y, 3), round((left[i].co.z + right[i].co.z) / 2 - lift, 3)] for i in keep]
    ob = _new_object(name, bm, coll, material)
    ob["kiln_path"] = json.dumps({"points": centre, "width": float(width), "closed": False})
    return ob


def water(name, size=(100, 100), level=0.0, color="#2d5f73", coll=None):
    """A water surface at z = level (glossy, slightly see-through, gentle ripples via a normal map)."""
    k = _k()
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5, matrix=Matrix.Diagonal((size[0], size[1], 1, 1)))
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        for loop in f.loops:
            loop[uv].uv = (loop.vert.co.x / 6.0, loop.vert.co.y / 6.0)
    ripples = k.noise(256, 10, seed=5, stretch=(1, 2))
    mat = k.pbr(name + "_Water", color, height=ripples, roughness=0.08, bump=1.5)
    p = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    p.inputs["Alpha"].default_value = 0.82
    for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(mat, attr, val)
        except Exception:  # noqa: BLE001
            pass
    ob = _new_object(name, bm, coll, mat)
    ob.location.z = level
    return ob


# ------------------------------------------------------------------------------------------------
# Modular building kit
# ------------------------------------------------------------------------------------------------

def _boolean_cut(ob, cutters):
    k = _k()
    for c in cutters:
        m = ob.modifiers.new("Cut", "BOOLEAN")
        m.operation = "DIFFERENCE"
        m.solver = "EXACT"
        m.object = c
    k.apply_modifiers(ob)
    for c in cutters:
        me = c.data
        bpy.data.objects.remove(c, do_unlink=True)
        if me.users == 0:
            bpy.data.meshes.remove(me)
    return ob


def wall(name, length=4.0, height=3.0, thickness=0.2, openings=(), material=None, coll=None, bevel=0.0):
    """A straight wall along +X from the origin (on the ground, centred on y = 0).
    openings: [{"x": 1.5, "w": 1.0, "h": 2.1, "sill": 0.0}] (doors: sill 0; windows: sill ~0.9);
    x is the opening's centre along the wall. Cut cleanly (one closed mesh)."""
    k = _k()
    bm = bmesh.new()
    _box(bm, (0, -thickness / 2, 0), (length, thickness / 2, height))
    ob = _new_object(name, bm, coll, material)
    cutters = []
    for i, o in enumerate(openings):
        cb = bmesh.new()
        x, w, h, sill = o["x"], o.get("w", 1.0), o.get("h", 2.1), o.get("sill", 0.0)
        bottom = sill if sill > 0 else -0.05
        _box(cb, (x - w / 2, -thickness, bottom), (x + w / 2, thickness, sill + h))
        cutters.append(_new_object(f"{name}_cut{i}", cb))
    if cutters:
        _boolean_cut(ob, cutters)
    if bevel > 0:
        m = ob.modifiers.new("Bevel", "BEVEL")
        m.width = bevel
        m.segments = 2
        m.limit_method = "ANGLE"
    if coll is not None:
        k.link(ob, coll)
    return ob


def frame(name, w=1.0, h=2.1, depth=0.3, trim=0.08, sill=0.0, material=None, coll=None, bottom=True):
    """A door/window frame (trim around an opening) centred at x = 0, facing ±Y, bottom at z = sill."""
    bm = bmesh.new()
    _box(bm, (-w / 2 - trim, -depth / 2, sill), (-w / 2, depth / 2, sill + h + trim))
    _box(bm, (w / 2, -depth / 2, sill), (w / 2 + trim, depth / 2, sill + h + trim))
    _box(bm, (-w / 2, -depth / 2, sill + h), (w / 2, depth / 2, sill + h + trim))
    if bottom and sill > 0:
        _box(bm, (-w / 2 - trim, -depth / 2, sill - trim), (w / 2 + trim, depth / 2, sill))
        # A proud ledge in front, clear of the wall faces.
        _box(bm, (-w / 2 - trim * 1.5, -depth / 2 - 0.05, sill - trim * 0.6), (w / 2 + trim * 1.5, -depth / 2 - 0.004, sill))
    return _new_object(name, bm, coll, material)


def roof(name, width=6.0, depth=5.0, pitch=35.0, overhang=0.35, thickness=0.14, style="gable", material=None, coll=None):
    """A roof over a width (X) × depth (Y) footprint centred on the origin, starting at z = 0 (move it up
    to the wall top). style: "gable" (ridge along X), "hip" (slopes on all four sides), "shed" (one slope),
    "flat" (with a parapet). Returns the roof and, for gable/shed, the gable-end infill walls object."""
    k = _k()
    w, d = width / 2 + overhang, depth / 2 + overhang
    rise = math.tan(math.radians(pitch)) * (depth / 2)
    bm = bmesh.new()
    gables = None
    if style == "hip":
        ridge = max(0.0, w - d)
        top = [(-ridge, 0, rise), (ridge, 0, rise)]
        base = [(-w, -d, 0), (w, -d, 0), (w, d, 0), (-w, d, 0)]
        vs = [bm.verts.new(v) for v in base]
        t0, t1 = bm.verts.new(top[0]), bm.verts.new(top[1])
        bm.faces.new((vs[0], vs[1], t1, t0))
        bm.faces.new((vs[1], vs[2], t1))
        bm.faces.new((vs[2], vs[3], t0, t1))
        bm.faces.new((vs[3], vs[0], t0))
        bm.faces.new(tuple(reversed(vs)))
        ob = _new_object(name, bm, coll, material)
        m = ob.modifiers.new("Thick", "SOLIDIFY")
        m.thickness = thickness
        k.apply_modifiers(ob)
        return ob, None
    if style == "flat":
        _box(bm, (-w, -d, 0), (w, d, thickness))
        for lo, hi in (((-w, -d, 0), (w, -d + 0.2, 0.5)), ((-w, d - 0.2, 0), (w, d, 0.5)), ((-w, -d, 0), (-w + 0.2, d, 0.5)), ((w - 0.2, -d, 0), (w, d, 0.5))):
            _box(bm, lo, hi)
        return _new_object(name, bm, coll, material), None
    # The underside passes through z = 0 at the wall line (y = ±depth/2), so the eave hangs a little below
    # it and no slot is left between the wall top and the roof.
    slope = math.tan(math.radians(pitch))
    drop = slope * overhang
    if style == "shed":
        slabs = [((-w, -d, -drop), (w, d, slope * depth + drop))]
    else:
        slabs = [((-w, -d, -drop), (w, 0, rise)), ((-w, d, -drop), (w, 0, rise))]
    for (x0, y0, z0), (x1, y1, z1) in slabs:
        # A slab of `thickness` between the eave (y0, z0) and the ridge (y1, z1).
        vy, vz = y1 - y0, z1 - z0
        ln = math.hypot(vy, vz)
        ny, nz = -vz / ln, vy / ln
        if nz < 0:
            ny, nz = -ny, -nz
        pts = [(y0, z0), (y1, z1), (y1 + ny * thickness, z1 + nz * thickness), (y0 + ny * thickness, z0 + nz * thickness)]
        vs0 = [bm.verts.new((x0, py, pz)) for py, pz in pts]
        vs1 = [bm.verts.new((x1, py, pz)) for py, pz in pts]
        bm.faces.new(vs0[::-1])
        bm.faces.new(vs1)
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((vs0[i], vs0[j], vs1[j], vs1[i]))
    ob = _new_object(name, bm, coll, material)
    bmesh_fix_normals(ob)
    # Gable ends: triangles filling the wall under the roof at both X ends.
    gb = bmesh.new()
    iw, idp = width / 2, depth / 2
    rise_in = math.tan(math.radians(pitch)) * (idp if style != "shed" else depth)
    for x in (-iw + 0.1, iw - 0.1):  # 0.2 thick, flush with the footprint's outer face
        if style == "shed":
            tri = [(x, -idp, 0), (x, idp, 0), (x, idp, rise_in)]
        else:
            tri = [(x, -idp, 0), (x, idp, 0), (x, 0, rise_in)]
        vs = [gb.verts.new(v) for v in tri]
        gb.faces.new(vs)
    if style == "shed":  # the wall under the high edge
        vs = [gb.verts.new(v) for v in ((-iw + 0.2, idp - 0.1, 0), (iw - 0.2, idp - 0.1, 0), (iw - 0.2, idp - 0.1, rise_in), (-iw + 0.2, idp - 0.1, rise_in))]
        gb.faces.new(vs)
    gables = _new_object(name + "_Gables", gb, coll)
    m = gables.modifiers.new("Thick", "SOLIDIFY")
    m.thickness = 0.2
    m.offset = 0
    k.apply_modifiers(gables)
    return ob, gables


def bmesh_fix_normals(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def stairs(name, width=1.2, rise=0.18, run=0.28, steps=10, material=None, coll=None, solid=True):
    """Straight stairs going up along +Y from the origin (real proportions: rise 0.15–0.19, run 0.25–0.32)."""
    bm = bmesh.new()
    for i in range(steps):
        z0 = 0 if solid else i * rise
        _box(bm, (-width / 2, i * run, z0), (width / 2, (i + 1) * run, (i + 1) * rise))
    ob = _new_object(name, bm, coll, material)
    return ob


def railing(name, points, height=1.0, post_every=1.2, post=0.07, rail=0.05, balusters=0.0, material=None, coll=None):
    """A railing/fence along points [(x, y, z), ...]: posts, a top rail, a mid rail, optional balusters
    every `balusters` meters. Use on balconies, bridges, stairs, fences."""
    bm = bmesh.new()
    pts = [Vector(p if len(p) == 3 else (p[0], p[1], 0)) for p in points]
    for si, (a, b) in enumerate(zip(pts, pts[1:])):
        seg = b - a
        if seg.length < 1e-6:
            continue
        n = max(1, int(round(seg.length / post_every)))
        for i in range(0 if si == 0 else 1, n + 1):  # a segment's first post is the last one's final post
            p = a.lerp(b, i / n)
            _box(bm, (p.x - post / 2, p.y - post / 2, p.z), (p.x + post / 2, p.y + post / 2, p.z + height))
        # Rails run along the segment in 3D: on stairs and slopes they climb with it.
        tilt = seg.to_track_quat("X", "Z").to_matrix().to_4x4()
        for zf, r in ((1.0, rail), (0.5, rail * 0.7)):
            mid = (a + b) / 2
            m = Matrix.Translation((mid.x, mid.y, mid.z + height * zf - r / 2)) @ tilt @ Matrix.Diagonal((seg.length + post, r, r, 1))
            bmesh.ops.create_cube(bm, size=1.0, matrix=m)
        if balusters > 0:
            nb = max(1, int(seg.length / balusters))
            for i in range(1, nb):
                p = a.lerp(b, i / nb)
                _box(bm, (p.x - 0.015, p.y - 0.015, p.z), (p.x + 0.015, p.y + 0.015, p.z + height))
    return _new_object(name, bm, coll, material)


def fence(name, points, height=1.1, style="picket", material=None, coll=None, ground=None):
    """A fence along ground points [(x, y), ...], following the terrain. style: "picket" (pointed boards),
    "rail" (posts and two rails), "stone" (a low dry-stone wall)."""
    k = _k()
    pts = [Vector((p[0], p[1], ground_z(p[0], p[1], ground))) for p in points]
    if style == "rail":
        return railing(name, [tuple(p) for p in pts], height=height, post_every=2.0, post=0.12, rail=0.08, material=material, coll=coll)
    if style == "stone":
        parts = []
        for a, b in zip(pts, pts[1:]):
            n = max(1, int((b - a).length / 0.45))
            for i in range(n):
                p = a.lerp(b, (i + 0.5) / n)
                parts.append({"ellipsoid": (p.x, p.y, p.z + height * 0.25), "radii": (0.3, 0.28, height * 0.32)})
        return k.blob(name, parts, blend=0.5, material=material or k.mat(name + "_Stone", "#8a8479", roughness=0.9), resolution=0.09, coll=coll)
    bm = bmesh.new()
    for a, b in zip(pts, pts[1:]):
        seg = b - a
        d = seg.normalized()
        ang = math.atan2(d.y, d.x)
        n = max(1, int(seg.length / 0.16))
        for i in range(n):
            p = a.lerp(b, (i + 0.5) / n)
            p.z = ground_z(p.x, p.y, ground, default=p.z)
            m = Matrix.Translation(p) @ Matrix.Rotation(ang, 4, "Z")
            vs = [(-0.05, -0.012, -0.1), (0.05, -0.012, -0.1), (0.05, -0.012, height * 0.92), (0, -0.012, height), (-0.05, -0.012, height * 0.92)]
            front = [bm.verts.new(m @ Vector(v)) for v in vs]
            back = [bm.verts.new(m @ Vector((v[0], 0.012, v[2]))) for v in vs]
            bm.faces.new(front)
            bm.faces.new(back[::-1])
            for j in range(5):
                jj = (j + 1) % 5
                bm.faces.new((front[j], back[j], back[jj], front[jj]))
        tilt = seg.to_track_quat("X", "Z").to_matrix().to_4x4()
        for zf in (0.3, 0.72):
            mid = (a + b) / 2
            mm = Matrix.Translation((mid.x, mid.y, mid.z + height * zf)) @ tilt @ Matrix.Translation((0, 0.03, 0)) @ Matrix.Diagonal((seg.length, 0.04, 0.08, 1))
            bmesh.ops.create_cube(bm, size=1.0, matrix=mm)
    ob = _new_object(name, bm, coll, material or k.mat(name + "_Wood", "#e8e2d2", roughness=0.7))
    bmesh_fix_normals(ob)
    return ob


DEFAULT_STYLE = {
    "wall": "#d9cbb0", "trim": "#5a4330", "roof": "#8c3b2e", "door": "#6b4a2f", "glass": "#9ec4d6",
    "foundation": "#7d776d", "bevel": 0.02, "roof_style": "gable", "pitch": 38, "trim_width": 0.1,
}


def house(name, width=6.0, depth=5.0, floors=1, floor_h=2.8, style=None, door_side="front", windows_per_side=2, chimney=True, coll=None, seed=0):
    """A whole small building in one call, from the kit, centred on the origin with its floor at z = 0 and
    its front facing -Y (the viewer's front). `style` is a dict of colors and roof settings; pass the same
    style to every building of a set so they match (see kiln.DEFAULT_STYLE for the keys). Returns an empty
    that parents all parts (move/rotate the empty; kiln.place_on(empty, x, y) seats it on terrain)."""
    k = _k()
    st = dict(DEFAULT_STYLE, **(style or {}))
    rng = np.random.default_rng(seed)
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    c = coll if coll is not None else k.collection(name)
    k.link(root, c)
    tag = lambda key: str(st[key]).lstrip("#")  # noqa: E731  (same colour = same material across houses)
    glow = st.get("window_glow")
    m_wall = k.mat(f"{name}_Wall" if st.get("unique") else f"Kit_Wall_{tag('wall')}", st["wall"], roughness=0.85)
    m_trim = k.mat(f"Kit_Trim_{tag('trim')}", st["trim"], roughness=0.7)
    m_roof = k.mat(f"Kit_Roof_{tag('roof')}", st["roof"], roughness=0.8)
    m_door = k.mat(f"Kit_Door_{tag('door')}", st["door"], roughness=0.65)
    m_glass = k.mat(f"Kit_Glass_{tag('glass')}" + ("_Lit" if glow else ""), st["glass"], roughness=0.1, emission=glow, strength=st.get("glow_strength", 2.0) if glow else None)
    m_found = k.mat(f"Kit_Foundation_{tag('foundation')}", st["foundation"], roughness=0.9)
    t = 0.22
    H = floors * floor_h
    parts = []
    fb = bmesh.new()
    _box(fb, (-width / 2 - 0.15, -depth / 2 - 0.15, -0.4), (width / 2 + 0.15, depth / 2 + 0.15, 0.25))
    parts.append(_new_object(name + "_Foundation", fb, c, m_found))
    # Front and back walls run the full width; the side walls fit between them, so no two walls share
    # a volume (overlapping walls leave coincident faces that flicker).
    sides = {
        "front": (Vector((-width / 2, -depth / 2 + t / 2, 0.25)), 0.0, width),
        "right": (Vector((width / 2 - t / 2, -depth / 2 + t, 0.25)), 90.0, depth - 2 * t),
        "back": (Vector((width / 2, depth / 2 - t / 2, 0.25)), 180.0, width),
        "left": (Vector((-width / 2 + t / 2, depth / 2 - t, 0.25)), 270.0, depth - 2 * t),
    }
    for side, (origin, rot, length) in sides.items():
        openings, frames = [], []
        tw = st["trim_width"]
        for fl in range(floors):
            n = windows_per_side if length > 3 else 1
            if n == 0 and side == door_side and fl == 0:
                n = 1  # no windows still leaves the door
            xs = [length * (i + 1) / (n + 1) for i in range(n)]
            for i, x in enumerate(xs):
                # The hole is cut a trim wider than the opening so the frame fills that band exactly:
                # frame and wall then only touch back to back (a frame lying on the hole's own faces flickers).
                if side == door_side and fl == 0 and i == len(xs) // 2:
                    openings.append({"x": x, "w": 1.0 + 2 * tw, "h": 2.1 + tw, "sill": 0.0})
                    frames.append(("door", x, 1.0, 2.1, 0.0))
                else:
                    sill = fl * floor_h + 0.95
                    openings.append({"x": x, "w": 0.9 + 2 * tw, "h": 1.1 + 2 * tw, "sill": sill - tw})
                    frames.append(("window", x, 0.9, 1.1, sill))
        w_ob = wall(f"{name}_Wall_{side}", length, H - 0.005, t, openings, m_wall, c)  # from the foundation top (0.25) to just under the roof (H + 0.25)
        w_ob.location = origin
        w_ob.rotation_euler.z = math.radians(rot)
        parts.append(w_ob)
        for kind, x, fw, fh, sill in frames:
            f_ob = frame(f"{name}_{kind.title()}Frame_{side}", fw, fh, t + 0.06, st["trim_width"], sill, m_trim, c)
            local = Matrix.Translation(origin) @ Matrix.Rotation(math.radians(rot), 4, "Z") @ Matrix.Translation((x, 0, 0))
            f_ob.matrix_world = local
            parts.append(f_ob)
            if kind == "door":
                db = bmesh.new()
                _box(db, (-fw / 2, -0.03, 0.0), (fw / 2, 0.03, fh))
                d_ob = _new_object(f"{name}_Door", db, c, m_door)
                d_ob.matrix_world = local @ Matrix.Translation((0, 0.02, 0))
                parts.append(d_ob)
            else:
                gb = bmesh.new()
                _box(gb, (-fw / 2, -0.01, sill), (fw / 2, 0.01, sill + fh))
                _box(gb, (-0.025, -0.03, sill), (0.025, 0.03, sill + fh))
                _box(gb, (-fw / 2, -0.03, sill + fh / 2 - 0.025), (fw / 2, 0.03, sill + fh / 2 + 0.025))
                g_ob = _new_object(f"{name}_Window_{side}_{int(x * 10)}", gb, c, m_glass)
                g_ob.matrix_world = local
                parts.append(g_ob)
    # Corner trims (clean edges where the walls meet).
    cb = bmesh.new()
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * (width / 2), sy * (depth / 2)
            _box(cb, (x - 0.13, y - 0.13, 0.24), (x + 0.13, y + 0.13, H + 0.25))  # 1 cm into the foundation: no shared bottom plane with the walls
    parts.append(_new_object(name + "_Corners", cb, c, m_trim))
    r_ob, g_ob = roof(name + "_Roof", width, depth, st["pitch"], 0.35, 0.14, st["roof_style"], m_roof, c)
    r_ob.location.z = H + 0.25
    parts.append(r_ob)
    if g_ob is not None:
        k.paint(g_ob, m_wall)
        g_ob.location.z = H + 0.25
        parts.append(g_ob)
    if chimney and st["roof_style"] in ("gable", "hip"):
        ch = bmesh.new()
        cx = width * (0.25 if rng.random() < 0.5 else -0.25)
        rise = math.tan(math.radians(st["pitch"])) * depth / 2
        _box(ch, (cx - 0.3, depth * 0.12, H), (cx + 0.3, depth * 0.12 + 0.6, H + 0.25 + rise + 0.9))
        _box(ch, (cx - 0.36, depth * 0.12 - 0.06, H + 0.25 + rise + 0.8), (cx + 0.36, depth * 0.12 + 0.66, H + 0.25 + rise + 0.95))
        parts.append(_new_object(name + "_Chimney", ch, c, m_found))
    for p in parts:
        p.parent = root
        p.matrix_parent_inverse = Matrix.Identity(4)
    if st.get("bevel", 0) > 0:
        for p in parts:
            if p.type == "MESH" and "Wall_" not in p.name and "Window" not in p.name:
                m = p.modifiers.new("Bevel", "BEVEL")
                m.width = st["bevel"]
                m.segments = 1
                m.limit_method = "ANGLE"
    return root


# ------------------------------------------------------------------------------------------------
# Game readiness
# ------------------------------------------------------------------------------------------------

def set_origin(obj, where="bottom"):
    """Move the object's origin to its bottom centre ("bottom", the usual pivot for props placed on the
    ground) or its bounds centre ("center"), without moving the geometry in the world."""
    if obj is None or obj.type != "MESH":
        return obj
    me = obj.data
    if me.users > 1:  # a linked copy: give it its own mesh, or every copy would shift
        me = obj.data = me.copy()
    co = _coords(me)
    if not len(co):
        return obj
    lo, hi = co.min(0), co.max(0)
    c = (lo + hi) / 2
    if where == "bottom":
        c[2] = lo[2]
    bpy.context.view_layer.update()  # the position set earlier in the same script counts
    _set_coords(me, co - c)
    # The mesh moved by -c in the object's own space; the object moves by +c in that space (right for parented, rotated and scaled objects).
    obj.matrix_world = obj.matrix_world @ Matrix.Translation(Vector(c))
    return obj


def apply_transform(obj):
    """Bake rotation and scale into the mesh (scale 1, rotation 0): what engines expect on import."""
    if obj is None or obj.type != "MESH":
        return obj
    me = obj.data
    if me.users > 1:  # a linked copy keeps its own baked mesh; the others are left alone
        me = obj.data = me.copy()
    m = Matrix.LocRotScale(None, obj.rotation_euler, obj.scale)
    me.transform(m)
    if m.determinant() < 0:
        me.flip_normals()  # a mirrored part would come out inside-out
    obj.rotation_euler = (0, 0, 0)
    obj.scale = (1, 1, 1)
    me.update()
    return obj


def snap(objs, step=0.5):
    """Snap object locations to a grid (modular kits line up without gaps or overlaps)."""
    for o in objs if isinstance(objs, (list, tuple)) else [objs]:
        o.location = [round(v / step) * step for v in o.location]
    return objs


def game_ready(objs=None, budget=None):
    """A report for game export: per object triangles, scale/rotation not applied, origin far from the
    base, missing UVs, open (non-manifold) edges, loose vertices, material count. budget: max triangles
    per object to flag. Returns text; fix what it lists (kiln.apply_transform, kiln.set_origin, …)."""
    dg = bpy.context.evaluated_depsgraph_get()
    obs = objs or [o for o in bpy.context.scene.objects if o.type == "MESH" and o.visible_get()]
    lines, total = [], 0
    for o in obs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        tris = len(me.loop_triangles)
        total += tris
        issues = []
        if any(abs(s - 1) > 1e-3 for s in o.scale) and o.parent is None and o.data.users == 1:
            issues.append("scale not applied")  # linked copies (scatter) keep their scale: applying it would give each its own mesh
        if not me.uv_layers:
            issues.append("no UVs")
        bm = bmesh.new()
        bm.from_mesh(me)
        open_edges = sum(1 for e in bm.edges if not e.is_manifold and not e.is_boundary) + sum(1 for e in bm.edges if e.is_boundary)
        loose = sum(1 for v in bm.verts if not v.link_edges)
        faces = len(bm.faces)
        bm.free()
        ev.to_mesh_clear()  # `me` is gone from here on
        if open_edges and not o.get("kiln_ground") and faces > 2:
            issues.append(f"{open_edges} open edges (fine for ground, paths, water and leaf cards; kiln.seal(obj) closes real holes in a solid)")
        if loose:
            issues.append(f"{loose} loose verts")
        if len(o.material_slots) > 4:
            issues.append(f"{len(o.material_slots)} materials")
        if budget and tris > budget:
            issues.append(f"over budget ({tris} > {budget})")
        if o.parent is None:
            lo, hi = _k().bounds([o])
            base = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
            if (o.matrix_world.translation - base).length > max((hi - lo).length * 0.25, 0.05):
                issues.append("origin far from base")
        lines.append(f"{o.name}: {tris} tris" + (f" — {', '.join(issues)}" if issues else " — ok"))
    return f"{len(obs)} objects, {total} triangles\n" + "\n".join(lines)
