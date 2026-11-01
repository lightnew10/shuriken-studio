"""
Helpers available as `kiln` inside run_python (Kiln) and blender_python (Shuriken Studio, which ships
an identical copy: keep them the same). Everything here is plain bpy data-API code (no viewport context
needed), so it behaves the same in headless Blender as in the app. Units are the scene's: meters in
Kiln projects, studs in Shuriken's (and in Kiln projects Shuriken builds).
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

# This project's folder (the bridge sets it): kiln.piece finds other projects beside it.
PROJECT_DIR = None


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(c):
    """'#rrggbb' or '#rgb' -> (r, g, b) in 0-1 sRGB."""
    h = str(c).strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) < 6:
        raise ValueError("colors are '#rrggbb' hex strings (got %r)" % (c,))
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def color(c):
    """'#rrggbb' (sRGB, like a color picker) or an (r, g, b[, a]) tuple in linear values -> RGBA."""
    if isinstance(c, str):
        r, g, b = hex_rgb(c)
        return (_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), 1.0)
    t = tuple(float(x) for x in c)
    return t if len(t) == 4 else (*t, 1.0)


def mat(name, base=None, roughness=None, metallic=None, emission=None, strength=None, alpha=None):
    """Get or create a Principled BSDF material. A new one starts light grey, roughness 0.5, not metal.
    On an existing one only what you pass is changed, so kiln.mat("Wall") just returns it as it is.
    The viewer shows base color, metal, roughness, emission and alpha (procedural texture nodes only
    show in renders)."""
    m = bpy.data.materials.get(name)
    new = m is None
    if new:
        m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:  # noqa: BLE001  (always on in newer Blender)
        pass
    nodes, links = m.node_tree.nodes, m.node_tree.links
    p = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
    if p is None:
        p = nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None) or nodes.new("ShaderNodeOutputMaterial")
        links.new(p.outputs["BSDF"], out.inputs["Surface"])
    if new or base is not None:
        rgba = color(base if base is not None else "#cccccc")
        p.inputs["Base Color"].default_value = rgba
        m.diffuse_color = rgba
    if new or roughness is not None:
        p.inputs["Roughness"].default_value = 0.5 if roughness is None else roughness
    if new or metallic is not None:
        p.inputs["Metallic"].default_value = 0.0 if metallic is None else metallic
    if emission is not None:
        p.inputs["Emission Color"].default_value = color(emission)
        p.inputs["Emission Strength"].default_value = 1.0 if strength is None else strength
    elif strength is not None:
        p.inputs["Emission Strength"].default_value = strength
    if alpha is not None:
        p.inputs["Alpha"].default_value = alpha
        see_through = alpha < 1
        for attr, val in (("surface_render_method", "BLENDED" if see_through else "DITHERED"), ("blend_method", "BLEND" if see_through else "OPAQUE")):
            try:
                setattr(m, attr, val)
            except Exception:  # noqa: BLE001
                pass
    return m


def world(color_="#33363c", strength=1.0):
    """The scene's background and ambient light: a colour ('#hex') and a strength. A new scene has no
    world at all (bpy.context.scene.world is None): this makes one. Returns the world."""
    sc = bpy.context.scene
    w = sc.world
    if w is None:
        w = bpy.data.worlds.new("World")
        sc.world = w
    try:
        w.use_nodes = True
    except Exception:  # noqa: BLE001
        pass
    bg = next((n for n in w.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg is None:
        bg = w.node_tree.nodes.new("ShaderNodeBackground")
        out = next((n for n in w.node_tree.nodes if n.type == "OUTPUT_WORLD"), None) or w.node_tree.nodes.new("ShaderNodeOutputWorld")
        w.node_tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bg.inputs["Color"].default_value = color(color_)
    bg.inputs["Strength"].default_value = strength
    return w


def obj(name):
    """The object with this name, fetched fresh. Python variables that held objects go stale when a
    script deletes or rebuilds them (and after any reload): get them again by name."""
    o = bpy.data.objects.get(name)
    if o is None:
        near = sorted(n for n in bpy.data.objects.keys() if name.lower() in n.lower())[:8]
        raise KeyError("no object named %r%s" % (name, (" (similar: %s)" % ", ".join(near)) if near else ""))
    return o


def image(name, pixels, data=False):
    """An image texture from pixels, top row first: a numpy array (h, w, 3 or 4) of 0-1 sRGB values,
    or a list of rows of '#rrggbb' strings (pixel art). Packed into the .blend and exported with the
    scene, so it shows in the live viewer. data=True for non-colour maps (roughness, normals)."""

    if isinstance(pixels, (list, tuple)) and pixels and isinstance(pixels[0], (list, tuple)) and pixels[0] and isinstance(pixels[0][0], str):
        rows = [[(*hex_rgb(c), 1.0) for c in row] for row in pixels]
        arr = np.array(rows, dtype=np.float32)
    else:
        arr = np.asarray(pixels, dtype=np.float32)
    if arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise ValueError("pixels must be (height, width, 3|4)")
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones(arr.shape[:2] + (1,), dtype=np.float32)], axis=2)
    h, w = arr.shape[:2]
    # An image of this name is repainted in place, so the materials that show it keep showing it.
    img = bpy.data.images.get(name)
    if img is not None and (img.source != "GENERATED" and img.packed_file is None or img.is_float):
        bpy.data.images.remove(img)
        img = None
    if img is not None and tuple(img.size) != (w, h):
        img.scale(w, h)
    if img is None:
        img = bpy.data.images.new(name, w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color" if data else "sRGB"
    img.pixels.foreach_set(np.ascontiguousarray(arr[::-1], dtype=np.float32).ravel())
    img.update()
    img.pack()
    img["kiln_rev"] = int(img.get("kiln_rev", 0)) + 1  # the scene check sees a repaint through this
    return img


def _value_noise(n, cx, cy, rng):
    grid = rng.random((cy, cx))
    x, y = np.arange(n) * cx / n, np.arange(n) * cy / n
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    x1, y1 = (x0 + 1) % cx, (y0 + 1) % cy
    top = grid[y0[:, None], x0[None, :]] * (1 - fx) + grid[y0[:, None], x1[None, :]] * fx
    bottom = grid[y1[:, None], x0[None, :]] * (1 - fx) + grid[y1[:, None], x1[None, :]] * fx
    return top * (1 - fy[:, None]) + bottom * fy[:, None]


def noise(size=512, scale=6, octaves=4, seed=0, stretch=(1, 1)):
    """Tileable fractal noise: a (size, size) array in 0-1, the base for stone, plaster, dirt, rust,
    wood… stretch=(1, 12) streaks it along x (wood grain, brushed metal). Combine arrays freely
    with numpy (np.abs(n - 0.5) * 2 gives cracks/veins, n ** 3 gives sparse spots)."""
    rng = np.random.default_rng(seed)
    out = np.zeros((size, size))
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cx = max(1, int(round(scale * stretch[1] * 2 ** o)))
        cy = max(1, int(round(scale * stretch[0] * 2 ** o)))
        out += amp * _value_noise(size, min(cx, size), min(cy, size), rng)
        total += amp
        amp *= 0.5
    out /= total
    lo, hi = out.min(), out.max()
    return (out - lo) / ((hi - lo) or 1)


def ramp(values, stops):
    """Colour a 0-1 array: stops are '#hex' colours spread evenly, or (position, '#hex') pairs.
    Returns (h, w, 3) sRGB values for kiln.image / kiln.pbr."""
    if isinstance(stops, str):
        # One color: a gentle dark-to-light spread around it.
        r, g, b = hex_rgb(stops)
        stops = ["#%02x%02x%02x" % tuple(int(max(0, min(1, v * f)) * 255) for v in (r, g, b)) for f in (0.78, 1.0, 1.15)]
    if isinstance(stops[0], str):
        stops = [(i / max(1, len(stops) - 1), c) for i, c in enumerate(stops)]
    pos = [p for p, _ in stops]
    cols = [list(hex_rgb(c)) for _, c in stops]
    v = np.asarray(values, dtype=np.float64)
    return np.stack([np.interp(v, pos, [c[k] for c in cols]) for k in range(3)], axis=-1)


def normal_map(height, strength=3.0):
    """Tangent-space normal map (h, w, 3, 0-1) from a 0-1 height array (wraps at the edges)."""
    h = np.asarray(height, dtype=np.float64)
    gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5 * h.shape[1] / 64
    gy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5 * h.shape[0] / 64
    n = np.stack([-gx * strength, gy * strength, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def pbr(name, color, height=None, roughness=0.6, metallic=0.0, bump=3.0, nearest=False):
    """A realistic textured material that shows in the live viewer and renders alike.
    color: (h, w, 3) sRGB array (e.g. kiln.ramp(kiln.noise(), ['#4a4540', '#8a8278'])) or '#hex'.
    height: optional (h, w) 0-1 array -> normal map with `bump` strength (grooves, grain, pits).
    roughness: a number or an (h, w) 0-1 array. Give the object UVs first (kiln.uv_box(obj, size=…))."""
    m = mat(name, base=color if isinstance(color, str) else "#ffffff",
            roughness=float(roughness) if np.isscalar(roughness) else 0.6, metallic=metallic)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    for n in [n for n in nodes if n.label.startswith("kiln_")]:
        nodes.remove(n)
    p = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    interp = "Closest" if nearest else "Linear"

    def tex(label, img, x):
        t = nodes.new("ShaderNodeTexImage")
        t.label, t.image, t.interpolation, t.location = label, img, interp, (x, 300 - 300 * len([n for n in nodes if n.label.startswith("kiln_")]))
        return t

    if not isinstance(color, str):
        links.new(tex("kiln_color", image(name + "_color", color), -600).outputs["Color"], p.inputs["Base Color"])
    if not np.isscalar(roughness):
        r = np.asarray(roughness, dtype=np.float64)
        t = tex("kiln_rough", image(name + "_rough", np.stack([r, r, r], axis=-1), data=True), -600)
        sep = nodes.new("ShaderNodeSeparateColor")
        sep.label = "kiln_rough_sep"
        links.new(t.outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs["Green"], p.inputs["Roughness"])
    if height is not None:
        t = tex("kiln_normal", image(name + "_normal", normal_map(height, bump), data=True), -600)
        nm = nodes.new("ShaderNodeNormalMap")
        nm.label = "kiln_normal_map"
        links.new(t.outputs["Color"], nm.inputs["Color"])
        links.new(nm.outputs["Normal"], p.inputs["Normal"])
    return m


def textured(name, image=None, roughness=0.6, metallic=0.0, nearest=True, emission=0.0, img=None):
    """A material showing an image texture (nearest = crisp pixels). Give the object UVs first
    (kiln.uv_box / kiln.uv_faces)."""
    img = image if image is not None else img
    if img is None:
        raise ValueError("kiln.textured needs an image: kiln.textured(name, kiln.image(...))")
    m = mat(name, base="#ffffff", roughness=roughness, metallic=metallic)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    p = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    tex = next((n for n in nodes if n.type == "TEX_IMAGE"), None) or nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest" if nearest else "Linear"
    links.new(tex.outputs["Color"], p.inputs["Base Color"])
    if emission:
        links.new(tex.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = emission
    return m


def uv_box(obj, size=1.0):
    """Box-projection UVs in world units: the texture repeats every `size` meters on each face."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.verify()
    sx, sy, sz = obj.scale
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            c = loop.vert.co
            p = (c.x * sx, c.y * sy, c.z * sz)
            u, v = [(p[1], p[2]), (p[0], p[2]), (p[0], p[1])][ax]
            loop[uv].uv = (u / size, v / size)
    bm.to_mesh(me)
    bm.free()
    return obj


def uv_faces(obj):
    """Each face gets the whole texture (0–1), oriented upright: good for pixel-art faces on boxes."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        pts = [(l.vert.co[(ax + 1) % 3], l.vert.co[(ax + 2) % 3]) for l in f.loops]
        if ax == 1:
            pts = [(l.vert.co.x, l.vert.co.z) for l in f.loops]
        elif ax == 0:
            pts = [(l.vert.co.y, l.vert.co.z) for l in f.loops]
        lo_u, hi_u = min(p[0] for p in pts), max(p[0] for p in pts)
        lo_v, hi_v = min(p[1] for p in pts), max(p[1] for p in pts)
        flip = (n[ax] < 0) != (ax == 1)
        for l, (u, v) in zip(f.loops, pts):
            uu = (u - lo_u) / ((hi_u - lo_u) or 1)
            vv = (v - lo_v) / ((hi_v - lo_v) or 1)
            l[uv].uv = (1 - uu if flip else uu, vv)
    bm.to_mesh(me)
    bm.free()
    return obj


def paint(obj, material):
    """Give an object a single material (replacing its slots)."""
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def collection(name, parent=None):
    """Get or create a collection linked under `parent` (default: the scene)."""
    c = bpy.data.collections.get(name)
    fresh = c is None
    if fresh:
        c = bpy.data.collections.new(name)
    if isinstance(parent, str):
        parent = collection(parent)
    root = bpy.context.scene.collection
    host = parent or root
    # An existing collection asked for without a parent stays where it is (not linked a second time under the scene).
    if fresh or parent is not None:
        if c.name not in host.children:
            host.children.link(c)
        if host is not root and c.name in root.children:
            root.children.unlink(c)
    return c


def link(obj, coll=None):
    """Put an object (or a list of objects) in a collection (by object or name), unlinking it from others."""
    if isinstance(coll, str):
        coll = collection(coll)
    coll = coll or bpy.context.scene.collection
    if isinstance(obj, (list, tuple)):
        for o in obj:
            if o is not None:
                link(o, coll)
        return obj
    if obj is None:
        raise ValueError("kiln.link got None instead of an object (a helper that returned nothing, or a name that doesn't exist)")
    for c in list(obj.users_collection):
        if c != coll:
            c.objects.unlink(obj)
    if obj.name not in coll.objects:
        coll.objects.link(obj)
    return obj


def mesh_object(name, bm, coll=None):
    """Turn a bmesh into a new object (frees the bmesh)."""
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    return link(ob, coll)


def select(obj):
    """Make `obj` (or a list of objects: the first becomes active) the only selection, as many bpy.ops expect."""
    objs = [o for o in obj if o is not None] if isinstance(obj, (list, tuple)) else [obj]
    if not objs or objs[0] is None:
        raise ValueError("kiln.select got None instead of an object (was it deleted or joined into another? get it again with kiln.obj(name))")
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    return obj


def smooth(obj, angle=30):
    """Smooth shading with edges sharper than `angle` degrees kept crisp."""
    me = obj.data
    try:
        me.shade_smooth()
        me.set_sharpness_by_angle(angle=math.radians(angle))
    except AttributeError:
        for p in me.polygons:
            p.use_smooth = True
    return obj


def apply_modifiers(obj):
    """Bake the modifier stack into the mesh."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return obj


def join(objs, name=None):
    """Join mesh objects into the first one (modifiers are applied first). Every face keeps its
    material; the same material on several parts becomes one slot."""
    objs = [o for o in objs if o.type == "MESH"]
    if not objs:
        return None
    # World matrices of parented parts are only current after an update (else joined parts shift).
    bpy.context.view_layer.update()
    for o in objs:
        if o.modifiers:
            apply_modifiers(o)
    target = objs[0]
    bm = bmesh.new()
    inv = target.matrix_world.inverted()
    mats, indices = [], []
    for o in objs:
        tmp = o.data.copy()
        rel = inv @ o.matrix_world
        tmp.transform(rel)
        if rel.determinant() < 0:
            tmp.flip_normals()  # a mirrored part (negative scale) would come out inside-out
        remap = []
        for slot in o.material_slots:
            m = slot.material
            if m in mats:
                remap.append(mats.index(m))
            else:
                mats.append(m)
                remap.append(len(mats) - 1)
        mi = np.zeros(len(tmp.polygons), dtype=np.int32)
        tmp.polygons.foreach_get("material_index", mi)
        if remap:
            mi = np.asarray(remap, dtype=np.int32)[np.clip(mi, 0, len(remap) - 1)]
        indices.append(mi)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    bm.to_mesh(target.data)
    bm.free()
    target.data.materials.clear()
    for m in mats:
        target.data.materials.append(m)
    if indices:
        target.data.polygons.foreach_set("material_index", np.concatenate(indices))
        target.data.update()
    for o in objs[1:]:
        for child in list(o.children):  # what hung on a joined part now hangs on the result, where it was
            w = child.matrix_world.copy()
            child.parent = target
            child.matrix_world = w
        bpy.data.objects.remove(o, do_unlink=True)
    if name:
        target.name = name
    return target


def bounds(objs=None):
    """World-space (min, max) corners of the given (default: all visible) objects."""
    objs = objs or [o for o in bpy.context.scene.objects if o.visible_get() and o.type == "MESH"]
    bpy.context.view_layer.update()  # positions set earlier in the same script count
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
    return Vector(lo), Vector(hi)


def drop_to_floor(obj, z=0.0):
    """Move an object so its lowest point rests at height z."""
    lo, _ = bounds([obj] + [c for c in obj.children_recursive if c.type == "MESH"])
    if lo.z == math.inf:
        return obj
    w = obj.matrix_world.copy()
    w.translation.z += z - lo.z
    obj.matrix_world = w  # in world space, so it also works for parented parts
    return obj


def clear():
    """Delete every object, collection, animation clip and orphaned datablock: an empty scene."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    sc = bpy.context.scene
    for key in ("kiln_rig", "kiln_pose_prev"):
        if key in sc:
            del sc[key]
    for mk in list(sc.timeline_markers):
        sc.timeline_markers.remove(mk)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    try:
        bpy.data.orphans_purge(do_recursive=True)
    except Exception:  # noqa: BLE001
        pass


def stats():
    """Object count and evaluated triangle count of the scene."""
    dg = bpy.context.evaluated_depsgraph_get()
    tris = 0
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            me.calc_loop_triangles()
            tris += len(me.loop_triangles)
            ev.to_mesh_clear()
    return {"objects": len(bpy.context.scene.objects), "tris": tris}


def flat(objs, color_, roughness=0.6, palette="Palette"):
    """Flat colour without a material per colour: every object painted with kiln.flat shares ONE material
    (`palette`) whose small image holds each colour as a swatch; the object's UVs point at its swatch.
    A low-poly model in 15 colours is then one material and one texture (one Roblox part per piece, one
    upload). color_: '#hex'. For glow, metal or see-through parts use kiln.mat as usual."""
    # 16 x 16 swatches of 16 px each: a flat block keeps its colour through mipmaps and texture
    # compression (one-pixel swatches bled into their neighbours and turned grey).
    size, cell = 16, 16
    dim = size * cell
    m = bpy.data.materials.get(palette)
    img = bpy.data.images.get(palette + "_color")
    rimg = bpy.data.images.get(palette + "_rough")
    if m is None or img is None or rimg is None or "kiln_swatches" not in m:
        img = image(palette + "_color", np.zeros((dim, dim, 3), dtype=np.float32))
        rimg = image(palette + "_rough", np.full((dim, dim, 3), 0.6, dtype=np.float32), data=True)
        m = mat(palette, base="#ffffff")
        nodes, links = m.node_tree.nodes, m.node_tree.links
        for n in [n for n in nodes if n.label.startswith("kiln_")]:
            nodes.remove(n)
        p = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
        ct = nodes.new("ShaderNodeTexImage")
        ct.label, ct.image, ct.interpolation, ct.location = "kiln_color", img, "Closest", (-600, 300)
        links.new(ct.outputs["Color"], p.inputs["Base Color"])
        rt = nodes.new("ShaderNodeTexImage")
        rt.label, rt.image, rt.interpolation, rt.location = "kiln_rough", rimg, "Closest", (-600, 0)
        sep = nodes.new("ShaderNodeSeparateColor")
        sep.label = "kiln_rough_sep"
        links.new(rt.outputs["Color"], sep.inputs["Color"])
        links.new(sep.outputs["Green"], p.inputs["Roughness"])
        m["kiln_swatches"] = "[]"
    import json as _json
    swatches = _json.loads(m["kiln_swatches"])
    key = [str(color_).lower(), round(float(roughness), 2)]
    fresh = key not in swatches
    if fresh:
        if len(swatches) >= size * size:
            raise ValueError("the palette %r is full (%d colours): start another with palette=" % (palette, size * size))
        swatches.append(key)
        m["kiln_swatches"] = _json.dumps(swatches)
    if fresh or tuple(img.size) != (dim, dim) or tuple(rimg.size) != (dim, dim):
        # Repainted whole (it is small): this also brings a palette made with one-pixel swatches up to size.
        col = np.zeros((dim, dim, 4), dtype=np.float32)
        rough = np.full((dim, dim, 4), 0.6, dtype=np.float32)
        col[..., 3] = rough[..., 3] = 1.0
        for i, (c, r) in enumerate(swatches):
            y, x = (i // size) * cell, (i % size) * cell
            col[y:y + cell, x:x + cell, :3] = hex_rgb(c)
            rough[y:y + cell, x:x + cell, :3] = float(r)
        for im, px in ((img, col), (rimg, rough)):
            if tuple(im.size) != (dim, dim):
                im.scale(dim, dim)
            im.pixels.foreach_set(px.ravel())
            im.update()
            im.pack()
            im["kiln_rev"] = int(im.get("kiln_rev", 0)) + 1
    i = swatches.index(key)
    u, v = (i % size + 0.5) / size, (i // size + 0.5) / size
    for o in objs if isinstance(objs, (list, tuple)) else [objs]:
        me = o.data
        if not len(me.uv_layers):
            me.uv_layers.new(name="UVMap")
        uv = np.empty(len(me.loops) * 2, dtype=np.float32)
        uv[0::2], uv[1::2] = u, v
        me.uv_layers.active.uv.foreach_set("vector", uv)
        paint(o, m)
        me.update()
    return m


# Organic shapes and the map/game-asset kit live in their own modules; they are part of `kiln`.
from kiln_shapes import blob, bush, decimate, displace, fbm3, noise3, remesh, rock, rope, shell, smooth_shape, tree, tube  # noqa: E402,F401
from kiln_world import (  # noqa: E402,F401
    DEFAULT_STYLE, apply_transform, fence, frame, game_ready, ground_z, house, path, place_on, railing, roof,
    scatter, set_origin, snap, stairs, terrain, wall, water,
)

# Maps as data: pieces from other projects, placements, roles, markers and tracks for the game.
try:
    from kiln_map import layout, marker, piece, pieces, place, role, tile, track  # noqa: E402,F401
except ImportError:  # another app's copy of these helpers may not ship it
    pass

# Parts that fit together: sockets, fit checks, per-model facts, the game's style sheet.
try:
    from kiln_parts import fit, fit_report, models, mount, part, socket, sockets, style, style_mat  # noqa: E402,F401
except ImportError:  # another app's copy of these helpers may not ship it
    pass

# Rig-ready models: joints, segments, legs and attachment points for a game engine to animate.
import kiln_rig as rig  # noqa: E402,F401  (armature rigs: joint / bind / skin / leg / ik / attach / info / r15 / upgrade / check)
import kiln_anim as anim  # noqa: E402,F401  (clips, keys, IK, gaits, idle, attacks, physics chains, checks)

# Creature kit and material presets: limbs, tentacles, pistons, spikes, plates, one-call materials, bakes.
from kiln_creature import auto_uv, bake, limb, material, piston, plates, seal, spikes, tentacle  # noqa: E402,F401
try:
    import kiln_roblox as roblox  # noqa: E402,F401  (Roblox target: roblox.check(), roblox.preview(), roblox.export())
except ImportError:  # another app's copy of these helpers may not ship it
    roblox = None
