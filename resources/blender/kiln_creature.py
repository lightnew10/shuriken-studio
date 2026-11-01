"""
Creature kit and material presets (exposed through `kiln`): rig-ready limbs (organic or mechanical),
spikes, armour plates, tentacles, pistons, one-call surface materials, and baking a dense model's
detail into a normal map on a lighter one. Built only from Blender's own tools (blended volumes, tubes,
noise, Cycles baking), so it works in headless Blender with no extra dependencies.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector


def _k():
    import kiln
    return kiln


# ------------------------------------------------------------------------------------------------
# Material presets
# ------------------------------------------------------------------------------------------------

_PRESETS = {
    #  kind:           (colors dark→light,                          roughness, metallic, bump, noise scale, stretch)
    "flesh": (["#5a1f22", "#8c3b3b", "#b9645a"], 0.45, 0.0, 2.5, 5, (1, 1)),
    "slime": (["#1f3a1c", "#3f6b2a", "#7fae3c"], 0.12, 0.0, 1.5, 4, (1, 1)),
    "chitin": (["#15120f", "#2e2620", "#5a4a3a"], 0.3, 0.0, 3.0, 7, (1, 3)),
    "scales": (["#1d3024", "#35553a", "#5f8052"], 0.45, 0.0, 4.0, 14, (1, 1)),
    "bone": (["#8d8270", "#c8bda5", "#e8e0cc"], 0.6, 0.0, 2.0, 6, (1, 4)),
    "fur": (["#5a3a1e", "#8a5a30", "#b98450"], 0.85, 0.0, 3.0, 10, (1, 14)),
    "leather": (["#2e1d12", "#4f3322", "#6e4a32"], 0.55, 0.0, 2.0, 9, (1, 1)),
    "cloth": (["#2c3a4f", "#3d5068", "#566d88"], 0.9, 0.0, 1.5, 20, (1, 1)),
    "metal": (["#4b4f55", "#7a8088", "#a9afb7"], 0.35, 1.0, 1.0, 6, (1, 10)),
    # Paint and rust are not metal to a renderer (metalness is all or nothing): they hide it.
    "painted_metal": (["#3b4a3d", "#566b58", "#6f8a70"], 0.5, 0.0, 1.5, 6, (1, 1)),
    "rusted_metal": (["#3a1c0e", "#7a3b17", "#a8612b"], 0.8, 0.0, 3.0, 5, (1, 1)),
    "stone": (["#46423d", "#6f6a62", "#98928a"], 0.85, 0.0, 3.0, 5, (1, 1)),
    "concrete": (["#5c5d5c", "#7c7d7b", "#9c9d9a"], 0.9, 0.0, 1.5, 8, (1, 1)),
    "wood": (["#4a2f1a", "#6e4a2c", "#8e6640"], 0.7, 0.0, 2.5, 4, (1, 12)),
    "bark": (["#2b2016", "#4a3a2a", "#665240"], 0.9, 0.0, 5.0, 5, (1, 8)),
    "dirt": (["#3a2c20", "#5a4632", "#7a6048"], 0.95, 0.0, 2.0, 6, (1, 1)),
    "grass": (["#2f4a1e", "#4c7028", "#6f9438"], 0.9, 0.0, 1.5, 10, (1, 1)),
    "ice": (["#8fb4c9", "#bcd8e6", "#e6f4fb"], 0.08, 0.0, 1.0, 5, (1, 1)),
    "lava": (["#1a0a06", "#3a120a", "#ff5a1a"], 0.6, 0.0, 3.0, 5, (1, 1)),
}


def material(name, kind="stone", color=None, seed=0, size=512):
    """A finished surface material in one call (textured colour, roughness variation and relief, the
    same in the viewer and in renders). kind: flesh, slime, chitin, scales, bone, fur, leather, cloth,
    metal, painted_metal, rusted_metal, stone, concrete, wood, bark, dirt, grass, ice, lava.
    color: an optional '#hex' to tint it (keeps the pattern). Give objects UVs (kiln.uv_box(obj, size=…)).
    Reused by name: call it once per look and paint every part that shares it."""
    k = _k()
    if kind not in _PRESETS:
        raise ValueError("kiln.material: no kind %r. Kinds: %s. (For anything else build it with kiln.pbr or kiln.mat.)" % (kind, ", ".join(sorted(_PRESETS))))
    recipe = "%s|%s|%s|%s" % (kind, color, seed, size)
    have = bpy.data.materials.get(name)
    if have is not None and have.get("kiln_recipe", recipe) == recipe:
        return have  # the same look asked for again: reuse it (a different kind, colour or seed rebuilds it)
    cols, rough, metal, bump, scale, stretch = _PRESETS[kind]
    if color:
        r, g, b = k.hex_rgb(color)
        cols = ["#%02x%02x%02x" % tuple(int(max(0, min(1, v * f)) * 255) for v in (r, g, b)) for f in (0.6, 1.0, 1.3)]
    n = k.noise(size, scale, seed=seed, stretch=stretch)
    fine = k.noise(size, scale * 4, seed=seed + 11, octaves=3)
    height = n * 0.7 + fine * 0.3
    if kind == "scales":
        yy, xx = np.mgrid[0:size, 0:size] / size * 16
        cell = np.abs(np.sin(xx * math.pi + (np.floor(yy) % 2) * math.pi / 2)) * np.abs(np.sin(yy * math.pi))
        height = height * 0.4 + cell * 0.6
    if kind in ("rusted_metal", "painted_metal"):
        chips = (k.noise(size, 9, seed=seed + 5) > 0.68).astype(float)
        height = height * 0.6 + chips * 0.4
    if kind == "lava":
        cracks = 1 - np.clip(np.abs(k.noise(size, 4, seed=seed + 3) - 0.5) * 10, 0, 1)
        colour = k.ramp(np.clip(n * 0.5 + cracks * 0.8, 0, 1), cols)
        m = k.pbr(name, colour, height=height, roughness=0.5 + 0.4 * (1 - cracks), bump=bump)
        p = next(x for x in m.node_tree.nodes if x.type == "BSDF_PRINCIPLED")
        tex = next(x for x in m.node_tree.nodes if x.label == "kiln_color")
        m.node_tree.links.new(tex.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = 2.5
        m["kiln_recipe"] = recipe
        return m
    colour = k.ramp(n * 0.8 + fine * 0.2, cols)
    roughness = np.clip(rough + (fine - 0.5) * 0.25, 0.02, 1.0)
    m = k.pbr(name, colour, height=height, roughness=roughness, metallic=metal, bump=bump)
    if kind == "slime":
        p = next(x for x in m.node_tree.nodes if x.type == "BSDF_PRINCIPLED")
        for key, val in (("Coat Weight", 0.8), ("Coat Roughness", 0.05)):
            if key in p.inputs:
                p.inputs[key].default_value = val
    m["kiln_recipe"] = recipe
    return m


# ------------------------------------------------------------------------------------------------
# Limbs, tentacles, pistons
# ------------------------------------------------------------------------------------------------

def limb(name, points, radii, style="organic", material=None, rig=False, parent_joint=None, kind="hinge", axis=(0, 1, 0), limits=(-45, 45), hip="ball"):
    """A limb through points (hip → knee → ankle → foot tip), one segment per span, radius per point.
    style "organic": smooth tapered flesh (blended), "mech": struts with joint caps, "insect": thin
    chitin segments with knobbly joints. rig=True also makes a kiln.rig joint at each point (named
    f"{name}_{i}", the first under parent_joint) and binds every segment to the joint it hangs from, so
    the limb is ready to animate: the first joint is a `hip` ("ball" or "hinge"), the rest `kind` about
    `axis` within `limits` (degrees), and the limb is recorded as a leg. Joint i is named f"{name}_{i}",
    like the segment it moves. Returns the segments (hip first)."""
    k = _k()
    pts = [Vector(p) for p in points]
    rs = list(radii) if isinstance(radii, (list, tuple)) else [radii] * len(pts)
    segs = []
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        ra, rb = rs[i], rs[min(i + 1, len(rs) - 1)]
        seg_name = f"{name}_{i}"
        if style == "organic":
            ob = k.blob(seg_name, [{"chain": [tuple(a), tuple(b)], "r": [ra, rb]}, {"sphere": tuple(a), "r": ra * 1.05}], blend=0.7, material=material)
        elif style == "insect":
            ob = k.tube(seg_name, [tuple(a), tuple(a.lerp(b, 0.5)), tuple(b)], [ra * 0.7, ra * 0.85, rb * 0.7], sides=10, material=material)
            bm = bmesh.new()
            bmesh.ops.create_icosphere(bm, subdivisions=2, radius=ra, matrix=Matrix.Translation(a))
            knob = k.mesh_object(seg_name + "_Knob", bm)
            if material:
                k.paint(knob, material)
            ob = k.join([ob, knob], seg_name)
        else:
            d = b - a
            ln = d.length
            bm = bmesh.new()
            # A strut (beveled box) along the span, a cylinder cap at the joint.
            m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Diagonal((ra * 1.4, ra * 0.9, ln, 1))
            bmesh.ops.create_cube(bm, size=1.0, matrix=m)
            cap = Matrix.Translation(a) @ Vector(axis).to_track_quat("Z", "Y").to_matrix().to_4x4()
            bmesh.ops.create_cone(bm, segments=16, radius1=ra * 1.1, radius2=ra * 1.1, depth=ra * 1.9, cap_ends=True, matrix=cap)
            ob = k.mesh_object(seg_name, bm)
            bev = ob.modifiers.new("Bevel", "BEVEL")
            bev.width = ra * 0.15
            bev.segments = 2
            bev.limit_method = "ANGLE"
            if material:
                k.paint(ob, material)
        segs.append(ob)
    if style != "organic":
        # The last point gets a foot/claw tip.
        bm = bmesh.new()
        tip = pts[-1]
        # The claw's point ends exactly at the limb's end point (where a gait plants it).
        bmesh.ops.create_cone(bm, segments=10, radius1=rs[-1] * 1.2, radius2=0.0, depth=rs[-1] * 3, cap_ends=True, matrix=Matrix.Translation(tip + Vector((0, 0, rs[-1] * 1.5))) @ Matrix.Rotation(math.pi, 4, "X"))
        foot = k.mesh_object(f"{name}_Tip", bm)
        if material:
            k.paint(foot, material)
        segs[-1] = k.join([segs[-1], foot], segs[-1].name)
    if rig:
        prev = parent_joint
        for i, p in enumerate(pts[:-1]):
            jn = f"{name}_{i}"
            first = i == 0 and hip == "ball"
            k.rig.joint(jn, tuple(p), parent=prev, kind="ball" if first else kind, axis=axis,
                        limits=((-60, -40, -60), (60, 40, 60)) if first else limits, tail=tuple(pts[i + 1]))
            k.rig.bind([segs[i]], jn)
            prev = jn
        k.rig.leg([f"{name}_{i}" for i in range(len(pts) - 1)], foot=f"{name}_{len(pts) - 2}")
    for s in segs:
        k.smooth(s, angle=40)
        k.uv_box(s, size=0.5)
    return segs


def _resample(pts, count):
    """count points evenly spaced along the polyline pts (by length)."""
    pts = [Vector(p) for p in pts]
    lens = [0.0]
    for a, b in zip(pts, pts[1:]):
        lens.append(lens[-1] + (b - a).length)
    out = []
    for i in range(count):
        d = lens[-1] * i / (count - 1)
        j = max(0, min(len(pts) - 2, next((k for k in range(len(lens) - 1) if lens[k + 1] >= d), len(pts) - 2)))
        seg = (lens[j + 1] - lens[j]) or 1.0
        out.append(pts[j].lerp(pts[j + 1], (d - lens[j]) / seg))
    return out


def _tentacle_piece(name, pts, radii, suckers, material, sucker_material, first, last):
    k = _k()
    ob = k.tube(name, [tuple(p) for p in pts], radii, sides=12, material=material)
    if suckers:
        bm = bmesh.new()
        lo = 1 if first else 0
        hi = len(pts) - 1 if last else len(pts) - 2
        for i in range(lo, hi):
            a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
            d = (b - a).normalized()
            down = Vector((0, 0, -1)) - d * d.dot(Vector((0, 0, -1)))
            down = down.normalized() if down.length > 1e-3 else (Vector((0, -1, 0)) - d * d.y).normalized()
            r = radii[i] * 0.42
            m = Matrix.Translation(pts[i] + down * radii[i] * 0.92) @ down.to_track_quat("Z", "Y").to_matrix().to_4x4()
            bmesh.ops.create_cone(bm, segments=10, radius1=r, radius2=r * 0.7, depth=r * 0.6, cap_ends=True, matrix=m)
        if bm.verts:
            cups = k.mesh_object(name + "_Suckers", bm)
            k.paint(cups, sucker_material or k.mat("Tentacle_SuckerMat", "#d9a6a0", roughness=0.4))
            k.smooth(cups, angle=40)
            world = cups.matrix_world.copy()
            cups.parent = ob
            cups.matrix_world = world
        else:
            bm.free()
    k.uv_box(ob, size=0.5)
    return ob


def tentacle(name, points, base_radius=0.12, tip_radius=0.01, suckers=True, material=None, sucker_material=None,
             segments=1, rig=False, parent_joint=None, limits=((-35, -35, -35), (35, 35, 35))):
    """A tapering tentacle (or tail, trunk, neck) through points, with optional sucker discs along its
    underside. segments>1 cuts it into that many closed pieces that overlap at the cuts (for animation);
    rig=True also makes a ball joint f"{name}_{i}" at the start of each piece (the first under
    parent_joint) and binds each piece to it. Returns the first piece (one piece: the tentacle)."""
    k = _k()
    segments = max(1, int(segments))
    per = 4
    pts = _resample(points, segments * per + 1) if segments > 1 else [Vector(p) for p in points]
    n = len(pts)
    radii = [base_radius + (tip_radius - base_radius) * (i / max(1, n - 1)) ** 0.8 for i in range(n)]
    if segments == 1:
        pieces = [_tentacle_piece(name, pts, radii, suckers, material, sucker_material, True, True)]
    else:
        pieces = []
        for s in range(segments):
            a, b = s * per, min(n - 1, (s + 1) * per + 1)  # one point of overlap into the next piece
            pieces.append(_tentacle_piece(f"{name}_{s}", pts[a:b + 1], radii[a:b + 1], suckers, material, sucker_material, s == 0, s == segments - 1))
    if rig:
        prev = parent_joint
        for s, piece in enumerate(pieces):
            jn = f"{name}_{s}"
            end = pts[min(n - 1, (s + 1) * per)] if segments > 1 else pts[-1]
            k.rig.joint(jn, tuple(pts[s * per] if segments > 1 else pts[0]), parent=prev, kind="ball", limits=limits, tail=tuple(end))
            k.rig.bind([piece], jn)
            prev = jn
    return pieces[0]


def seal(obj, weld=1e-4):
    """Close a mesh into a solid shell: welds seams (vertices closer than `weld` m) and fills every
    hole left open (cut ends, open tube tips), so kiln.game_ready stops reporting open edges."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld)
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    left = sum(1 for e in bm.edges if not e.is_manifold)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return left


def piston(name, a, b, radius=0.05, material=None, rod_material=None):
    """A hydraulic piston from a to b: a housing on the first 55% and a thinner rod on the rest."""
    k = _k()
    a, b = Vector(a), Vector(b)
    d = b - a
    q = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, segments=16, radius1=radius, radius2=radius, depth=d.length * 0.55, cap_ends=True, matrix=Matrix.Translation(a + d * 0.275) @ q)
    housing = k.mesh_object(name + "_Housing", bm)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, segments=12, radius1=radius * 0.45, radius2=radius * 0.45, depth=d.length * 0.5, cap_ends=True, matrix=Matrix.Translation(a + d * 0.75) @ q)
    rod = k.mesh_object(name + "_Rod", bm)
    # Every piston shares the kit's housing and rod materials (a texture set per piston bloated every save and export).
    k.paint(housing, material or k.material("Kit_PistonMetal", "painted_metal"))
    k.paint(rod, rod_material or bpy.data.materials.get("Kit_Chrome") or k.mat("Kit_Chrome", "#c9ccd1", roughness=0.3, metallic=1.0))
    k.uv_box(housing, size=0.5)
    rod.parent = housing
    return housing


# ------------------------------------------------------------------------------------------------
# Surface details: spikes and plates
# ------------------------------------------------------------------------------------------------

def _surface_points(obj, count, seed, where=None):
    """Area-weighted random points on a mesh's faces (world space) with their normals."""
    me = obj.data
    me.calc_loop_triangles()
    mw = obj.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()
    tris = [(t, [mw @ me.vertices[v].co for v in t.vertices]) for t in me.loop_triangles]
    if where:
        tris = [(t, vs) for t, vs in tris if where(sum(vs, Vector()) / 3, (nm @ t.normal).normalized())]
    if not tris:
        return []
    areas = np.array([(v[1] - v[0]).cross(v[2] - v[0]).length / 2 for _, v in tris])
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(tris), size=count, p=areas / areas.sum())
    out = []
    for i in idx:
        t, (a, b, c) = tris[i]
        u, v = rng.random(2)
        if u + v > 1:
            u, v = 1 - u, 1 - v
        out.append((a + (b - a) * u + (c - a) * v, (nm @ t.normal).normalized()))
    return out


def spikes(obj, count=30, length=0.2, radius=0.03, seed=0, where=None, material=None, lean=None, name=None):
    """Spikes/thorns/quills grown out of obj's surface along its normals, as one mesh parented to obj.
    where: an optional filter f(point, normal) -> bool in world space (lambda p, n: n.z > 0.3 for the back).
    lean: an optional world direction they sweep towards, e.g. (-1, 0, 0) swept back on a creature
    facing +X (0.5–1 long vectors lean more)."""
    k = _k()
    rng = np.random.default_rng(seed)
    bm = bmesh.new()
    for p, n in _surface_points(obj, count, seed, where):
        ln = length * (0.6 + 0.8 * rng.random())
        d = (n + (Vector(lean) if lean else Vector()) + Vector(rng.normal(0, 0.12, 3))).normalized()
        m = Matrix.Translation(p + d * ln * 0.45) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        bmesh.ops.create_cone(bm, segments=8, radius1=radius * (0.7 + 0.6 * rng.random()), radius2=0.0, depth=ln, cap_ends=True, matrix=m)
    ob = k.mesh_object(name or obj.name + "_Spikes", bm)
    k.paint(ob, material or k.material("Spike_Bone", "bone"))
    k.smooth(ob, angle=30)
    k.uv_box(ob, size=0.5)
    world = ob.matrix_world.copy()
    ob.parent = obj
    ob.matrix_world = world
    return ob


def plates(obj, count=20, size=0.25, thickness=0.03, seed=0, where=None, material=None, gap=0.004, align=(1, 0, 0), name=None):
    """Armour plates/scutes lying on obj's surface (a 4 mm gap so they never flicker), as one mesh
    parented to obj, their long side along `align` (world; the body's length) so they read as
    designed armour, not debris. where: an optional filter f(point, normal) -> bool."""
    k = _k()
    rng = np.random.default_rng(seed)
    bm = bmesh.new()
    for p, n in _surface_points(obj, count, seed, where):
        s = size * (0.7 + 0.6 * rng.random())
        along = Vector(align) - n * n.dot(Vector(align))
        if along.length < 1e-3:
            along = n.orthogonal()
        along = (Matrix.Rotation(rng.normal(0, 0.12), 3, n) @ along).normalized()
        basis = Matrix((along, n.cross(along), n)).transposed().to_4x4()
        m = Matrix.Translation(p + n * (thickness / 2 + gap)) @ basis @ Matrix.Diagonal((s, s * 0.7, thickness, 1))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    ob = k.mesh_object(name or obj.name + "_Plates", bm)
    bev = ob.modifiers.new("Bevel", "BEVEL")
    bev.width = thickness * 0.35
    bev.segments = 2
    k.paint(ob, material or k.material("Plate_Metal", "painted_metal"))
    k.uv_box(ob, size=1.0)
    world = ob.matrix_world.copy()
    ob.parent = obj
    ob.matrix_world = world
    return ob


# ------------------------------------------------------------------------------------------------
# Baking detail into a normal map
# ------------------------------------------------------------------------------------------------

def _cycles():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 16
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type == kind for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == kind
                    sc.cycles.device = "GPU"
                    return kind
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass
    sc.cycles.device = "CPU"
    return "CPU"


def auto_uv(obj, margin=0.02):
    """Unwrap obj without overlaps (Smart UV Project): needed before baking textures onto it."""
    k = _k()
    k.select(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def bake(high, low, size=1024, color=True, ao=True, extrusion=0.03, name=None):
    """Bakes a dense model's detail onto a light one with the same shape (make low with kiln.decimate on
    a duplicate, or build it simpler): a normal map of high's lumps, grooves, scales and rivets, and
    (color=True) high's colours with ambient occlusion (ao=True) darkening its creases, into textures on
    low. Low gets clean UVs and its own material, so it looks detailed at a fraction of the triangles.
    high: one mesh or a list. Hides high. Takes seconds on the GPU, up to a minute or two on the CPU
    (more at size=2048): do it once, at the end. Returns low."""
    k = _k()
    highs = [o for o in (high if isinstance(high, (list, tuple)) else [high]) if o.type == "MESH"]
    sc = bpy.context.scene
    engine = sc.render.engine
    device = _cycles()
    auto_uv(low)
    base = name or low.name
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for h in highs:
        h.hide_set(False)
        h.hide_render = False
        h.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    # Low's material is its own (baked textures on a shared material would land on other objects too).
    out = bpy.data.materials.new(base + "_Baked")
    out.use_nodes = True
    before = list(low.data.materials)
    src = before[0] if before else None
    low.data.materials.clear()
    low.data.materials.append(out)
    made = []
    nodes, links = out.node_tree.nodes, out.node_tree.links
    p = next(x for x in nodes if x.type == "BSDF_PRINCIPLED")
    if src is not None and src.node_tree is not None:
        sp = next((x for x in src.node_tree.nodes if x.type == "BSDF_PRINCIPLED"), None)
        if sp is not None:
            for key in ("Roughness", "Metallic"):
                p.inputs[key].default_value = sp.inputs[key].default_value
    target = nodes.new("ShaderNodeTexImage")
    nodes.active = target

    def run(kind, colorspace, **kw):
        img = bpy.data.images.new(f"{base}_{kind.lower()}", size, size, alpha=False)
        made.append(img)
        img.colorspace_settings.name = colorspace
        target.image = img
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=extrusion, margin=8, **kw)
        return img

    t0 = __import__("time").time()
    samples = sc.cycles.samples
    try:
        normal = run("NORMAL", "Non-Color")
        col = None
        if color:
            col = run("DIFFUSE", "sRGB", pass_filter={"COLOR"})
            if ao:
                sc.cycles.samples = 32
                occ = run("AO", "Non-Color")
                px = np.array(col.pixels[:]).reshape(-1, 4)
                a = np.array(occ.pixels[:]).reshape(-1, 4)[:, :1]
                px[:, :3] *= 0.35 + 0.65 * a
                col.pixels.foreach_set(px.astype(np.float32).ravel())
                bpy.data.images.remove(occ)
    except Exception as e:  # noqa: BLE001
        # Nothing half-baked stays behind: low gets its materials back, the new images and material go.
        low.data.materials.clear()
        for m in before:
            low.data.materials.append(m)
        for img in made:
            try:
                bpy.data.images.remove(img)
            except Exception:  # noqa: BLE001
                pass
        bpy.data.materials.remove(out)
        sc.cycles.samples = samples
        sc.render.engine = engine
        raise RuntimeError("kiln.bake failed (%s). The low model has its old materials back. Check that high and low overlap (same place, same shape) and that low has faces." % " ".join(str(e).split())[:200]) from None
    sc.cycles.samples = samples
    nodes.remove(target)
    for img in (normal, col):
        if img is not None:
            img.pack()
    nt = nodes.new("ShaderNodeTexImage")
    nt.image, nt.label, nt.location = normal, "kiln_normal", (-600, -300)
    nm = nodes.new("ShaderNodeNormalMap")
    nm.label = "kiln_normal_map"
    links.new(nt.outputs["Color"], nm.inputs["Color"])
    links.new(nm.outputs["Normal"], p.inputs["Normal"])
    if col is not None:
        ct = nodes.new("ShaderNodeTexImage")
        ct.image, ct.label, ct.location = col, "kiln_color", (-600, 300)
        links.new(ct.outputs["Color"], p.inputs["Base Color"])
    for h in highs:
        h.hide_set(True)
        h.hide_render = True
    sc.render.engine = engine
    print(f"baked {base} ({size}px, {'normal' + (' + color' if color else '') + (' + AO' if color and ao else '')}) on {device} in {__import__('time').time() - t0:.1f}s")
    return low
