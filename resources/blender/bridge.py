"""
Shuriken's Blender bridge: runs inside a headless Blender (one per modeling workspace) and serves
requests from Shuriken's core. Ported from Kiln's bridge (same protocol and checks), plus the
export that turns a scene into Roblox MeshParts.

Protocol: one JSON request per stdin line ({"id": n, "op": "...", ...}); one reply per request on
stdout, as a single line starting with "@@SHURIKEN ". Blender prints its own lines to stdout too, so
the core ignores everything without the marker. The Python namespace used by "exec" persists between
requests (like a REPL) until the scene is replaced.

Units are studs (1 Blender unit = 1 stud), Z up, and a model's front faces Blender -Y (the Front view
looks at it). The Roblox export turns that into Y up with the front facing Roblox's forward (-Z).
"""

import contextlib
import hashlib
import io
import json
import math
import os
import re
import struct
import sys
import time
import traceback

import bmesh
import bpy
import mathutils
import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ next to the app's scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kiln  # noqa: E402  (helpers offered to the agents' code, shared with Kiln)

MARK = "@@SHURIKEN "
_out = sys.stdout
NS = {}
MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT", "CURVES", "POINTCLOUD", "VOLUME"}


def reply(obj):
    _out.write(MARK + json.dumps(obj, ensure_ascii=True, default=str) + "\n")
    _out.flush()


def quiet_prefs():
    """No .blend1 backup files next to every save."""
    try:
        bpy.context.preferences.filepaths.save_version = 0
    except Exception:  # noqa: BLE001
        pass


def fresh_namespace():
    NS.clear()
    NS.update({
        "__name__": "__shuriken__",
        "bpy": bpy, "bmesh": bmesh, "mathutils": mathutils, "math": math, "np": np, "kiln": kiln,
        "Vector": mathutils.Vector, "Matrix": mathutils.Matrix, "Euler": mathutils.Euler,
        "Quaternion": mathutils.Quaternion, "radians": math.radians, "degrees": math.degrees,
    })


def object_mode():
    """Edits made in Edit Mode only reach the mesh (and the export) after leaving it."""
    try:
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------------------------
# Scene scan: summary for the agent and a fingerprint to know whether anything changed.
# ---------------------------------------------------------------------------------------------

def principled(mat):
    if not mat or not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def linear_to_hex(rgba):
    def enc(c):
        c = max(0.0, min(1.0, c))
        return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return "#%02x%02x%02x" % tuple(int(round(enc(c) * 255)) for c in rgba[:3])


def material_info(mat):
    p = principled(mat)
    info = {"name": mat.name}
    if p:
        g = lambda k: p.inputs[k].default_value if k in p.inputs else None  # noqa: E731
        base = g("Base Color")
        info["color"] = linear_to_hex(base) if base is not None else None
        info["metallic"] = round(float(g("Metallic") or 0), 2)
        info["roughness"] = round(float(g("Roughness") or 0), 2)
        es = g("Emission Strength")
        if es:
            info["emission"] = round(float(es), 2)
        textured = any(n.type == "TEX_IMAGE" for n in mat.node_tree.nodes)
        procedural = any(n.type.startswith("TEX_") and n.type != "TEX_IMAGE" for n in mat.node_tree.nodes)
        if textured:
            info["image_texture"] = True
        if procedural:
            info["procedural_texture"] = True
    rm = mat.get("roblox_material") if hasattr(mat, "get") else None
    if rm:
        info["roblox_material"] = str(rm)
    return info


def scan(limit=150):
    object_mode()
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    h = hashlib.md5()
    objects, tris_total, verts_total = [], 0, 0
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for ob in sorted(scene.objects, key=lambda o: o.name):
        tris = verts = 0
        visible = ob.visible_get()
        if ob.type in MESHLIKE:
            ev = ob.evaluated_get(dg)
            try:
                me = ev.to_mesh()
            except Exception:  # noqa: BLE001
                me = None
            if me is not None:
                me.calc_loop_triangles()
                tris, verts = len(me.loop_triangles), len(me.vertices)
                if verts:
                    co = np.empty(verts * 3, dtype=np.float32)
                    me.vertices.foreach_get("co", co)
                    h.update(co.tobytes())
                ev.to_mesh_clear()
            if visible:
                for c in ob.bound_box:
                    w = ob.matrix_world @ mathutils.Vector(c)
                    for i in range(3):
                        lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
        tris_total += tris
        verts_total += verts
        mw = [round(x, 4) for row in ob.matrix_world for x in row]
        mats = [s.material.name for s in ob.material_slots if s.material]
        h.update(repr((ob.name, ob.type, mw, tris, verts, mats, visible, ob.parent.name if ob.parent else None,
                       [(m.name, m.type, m.show_viewport) for m in ob.modifiers],
                       # what the Roblox export reads besides geometry: collision roles and collection instances
                       str(ob.get("kiln_role")), str(ob.get("kiln_collides_for")), ob.instance_collection.name if ob.instance_collection else None)).encode())
        if len(objects) < limit:
            e = {
                "name": ob.name, "type": ob.type,
                "location": [round(v, 3) for v in ob.location],
                "dimensions": [round(v, 3) for v in ob.dimensions],
            }
            rot = [round(math.degrees(a), 1) for a in ob.rotation_euler]
            if any(rot):
                e["rotation_deg"] = rot
            if any(abs(s - 1) > 1e-4 for s in ob.scale):
                e["scale"] = [round(v, 3) for v in ob.scale]
            if tris:
                e["tris"] = tris
            if mats:
                e["materials"] = mats
            if ob.modifiers:
                e["modifiers"] = [m.type.lower() for m in ob.modifiers]
            if ob.parent:
                e["parent"] = ob.parent.name
            cols = [c.name for c in ob.users_collection if c != scene.collection]
            if cols:
                e["collection"] = cols[0]
            if not visible:
                e["hidden"] = True
            objects.append(e)
    materials = [material_info(m) for m in bpy.data.materials if m.users]
    for m in materials:
        h.update(repr(sorted(m.items())).encode())
    # Image textures count by their pixels, not their names: a texture retuned under the same name is a
    # change too (it exports to Roblox, and uploads, again).
    try:
        import roblox_export as _rx
        h.update(_rx.maps_fingerprint().encode())
    except Exception:  # noqa: BLE001
        pass
    animated = any(ob.animation_data and ob.animation_data.action for ob in scene.objects)
    h.update(repr((animated, scene.frame_start, scene.frame_end)).encode())
    # A rig's clips (keys, events, settings) are part of the model: a change to one is a change.
    try:
        import kiln_anim
        h.update(kiln_anim.fingerprint().encode())
    except Exception:  # noqa: BLE001
        pass
    summary = {
        "objects": len(scene.objects), "tris": tris_total, "verts": verts_total,
        "list": objects, "truncated": len(scene.objects) > limit, "materials": materials,
        "collections": [c.name for c in bpy.data.collections if c.users],
        "animated": animated,
    }
    if lo[0] != math.inf:
        summary["bounds"] = {"min": [round(v, 3) for v in lo], "max": [round(v, 3) for v in hi],
                             "size": [round(hi[i] - lo[i], 3) for i in range(3)]}
    if animated:
        summary["frames"] = [scene.frame_start, scene.frame_end, scene.render.fps]
    return summary, h.hexdigest()


# ---------------------------------------------------------------------------------------------
# Ops
# ---------------------------------------------------------------------------------------------

def op_ping(req):
    return {"version": bpy.app.version_string, "python": sys.version.split()[0]}


def op_new(req):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    quiet_prefs()
    fresh_namespace()
    summary, fp = scan()
    return {"summary": summary, "fingerprint": fp}


def op_open(req):
    bpy.ops.wm.open_mainfile(filepath=req["path"], load_ui=False)
    fresh_namespace()
    summary, fp = scan()
    return {"summary": summary, "fingerprint": fp}


def format_error(code):
    etype, e, tb = sys.exc_info()
    lines = code.splitlines()
    out = []
    for f in [f for f in traceback.extract_tb(tb) if f.filename == "<run_python>"][-3:]:
        src = lines[f.lineno - 1].strip() if f.lineno and 0 < f.lineno <= len(lines) else ""
        out.append("line %d: %s" % (f.lineno, src))
    out.append("".join(traceback.format_exception_only(etype, e)).strip())
    return "\n".join(out)


def op_exec(req):
    code = req["code"]
    names_before = {o.name for o in bpy.context.scene.objects}
    buf = io.StringIO()
    error = None
    try:
        compiled = compile(code, "<run_python>", "exec")
    except SyntaxError as e:
        src = (e.text or "").rstrip()
        return {"ok": False, "error": "SyntaxError: %s (line %s)\n  %s" % (e.msg, e.lineno, src), "output": ""}
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            exec(compiled, NS)
    except Exception:  # noqa: BLE001
        error = format_error(code)
    try:
        bpy.context.view_layer.update()
    except Exception:  # noqa: BLE001
        pass
    summary, fp = scan()
    names_after = {o.name for o in bpy.context.scene.objects}
    output = buf.getvalue()
    if len(output) > 8000:
        output = output[:3500] + "\n… (%d characters cut) …\n" % (len(output) - 7000) + output[-3500:]
    issues = None
    # A quick look for clashing surfaces and floating parts after every change (small scenes only).
    if req.get("check") and fp != req.get("previous") and summary["tris"] <= 80000:
        try:
            c = check_scene(max_faces=80000)
            issues = {"zfight": c["zfight"][:8], "zfight_pairs": c["zfight_pairs"], "floating": c["floating"][:8], "below_ground": c["below_ground"][:8]}
        except Exception:  # noqa: BLE001
            issues = None
    return {
        "ok": error is None, "error": error, "output": output, "summary": summary, "fingerprint": fp,
        "added": sorted(names_after - names_before), "removed": sorted(names_before - names_after), "issues": issues,
    }


def check_scene(tol=0.0005, fix=False, nudge=0.002, max_faces=300000):
    """Coincident surfaces from different objects (z-fighting in the viewer) and objects floating in the air.
    With fix, the smaller object of each clashing pair moves `nudge` studs along its own clashing faces'
    normal, so the renderer can tell which surface is in front."""
    object_mode()
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    buckets = {}
    faces = 0
    boxes = {}
    for ob in scene.objects:
        if ob.type not in MESHLIKE or not ob.visible_get():
            continue
        ev = ob.evaluated_get(dg)
        try:
            me = ev.to_mesh()
        except Exception:  # noqa: BLE001
            continue
        if me is None:
            continue
        mw = ob.matrix_world
        nm = mw.to_3x3().inverted_safe().transposed()
        co = [mw @ v.co for v in me.vertices]
        if co:
            boxes[ob.name] = ([min(c[i] for c in co) for i in range(3)], [max(c[i] for c in co) for i in range(3)])
        for p in me.polygons:
            faces += 1
            if faces > max_faces:
                break
            n = (nm @ p.normal)
            if n.length < 1e-9:
                continue
            n.normalize()
            pts = [co[i] for i in p.vertices]
            # Canonical plane: the normal's first large component positive, so back-to-back faces share a key.
            s = 1.0
            for comp in n:
                if abs(comp) > 1e-6:
                    s = 1.0 if comp > 0 else -1.0
                    break
            cn = n * s
            d = cn.dot(pts[0])
            key = (round(cn.x * 60), round(cn.y * 60), round(cn.z * 60))
            lo = [min(q[i] for q in pts) for i in range(3)]
            hi = [max(q[i] for q in pts) for i in range(3)]
            buckets.setdefault(key, []).append((d, ob.name, lo, hi, tuple(n), p.area))
        ev.to_mesh_clear()
    pairs = {}
    for items in buckets.values():
        if len(items) < 2:
            continue
        items.sort(key=lambda x: x[0])
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                if b[0] - a[0] > tol:
                    break
                if a[1] == b[1]:
                    continue
                ov = [min(a[3][k], b[3][k]) - max(a[2][k], b[2][k]) for k in range(3)]
                if min(ov) < -tol or sorted(ov)[1] <= 1e-4:
                    continue  # they don't overlap with any area
                k = tuple(sorted((a[1], b[1])))
                e = pairs.setdefault(k, {"faces": 0, "where": [(a[2][j] + a[3][j]) / 2 for j in range(3)], "normals": {}})
                e["faces"] += 1
                for name, nrm in ((a[1], a[4]), (b[1], b[4])):
                    acc = e["normals"].setdefault(name, [0.0, 0.0, 0.0])
                    for j in range(3):
                        acc[j] += nrm[j]
    zfight = sorted(({"a": k[0], "b": k[1], "faces": v["faces"], "where": [round(x, 3) for x in v["where"]]} for k, v in pairs.items()), key=lambda x: -x["faces"])
    moved = []
    if fix and pairs:
        vol = lambda n: (lambda b: max(1e-9, (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]) * (b[1][2] - b[0][2])))(boxes.get(n, ([0, 0, 0], [1, 1, 1])))  # noqa: E731
        done = set()
        for k, v in sorted(pairs.items(), key=lambda kv: -kv[1]["faces"]):
            small = min(k, key=vol)
            if small in done:
                continue
            n = mathutils.Vector(v["normals"].get(small, (0, 0, 1)))
            if n.length < 1e-6:
                n = mathutils.Vector((0, 0, 1))
            n.normalize()
            ob = bpy.data.objects[small]
            ob.matrix_world.translation += n * nudge
            done.add(small)
            moved.append({"object": small, "by_studs": round(nudge, 4), "direction": [round(x, 2) for x in n]})
        bpy.context.view_layer.update()
    floating, below = [], []
    for name, (lo, hi) in boxes.items():
        if lo[2] < -0.01:
            below.append({"object": name, "lowest_z": round(lo[2], 3)})
        if lo[2] <= 0.02:
            continue
        touching = False
        for other, (lo2, hi2) in boxes.items():
            if other == name:
                continue
            if all(min(hi[i], hi2[i]) - max(lo[i], lo2[i]) >= -0.002 for i in range(3)):
                touching = True
                break
        if not touching:
            floating.append({"object": name, "gap_below": round(lo[2], 3)})
    return {"zfight": zfight[:40], "zfight_pairs": len(zfight), "floating": floating[:30], "below_ground": below[:30], "moved": moved, "faces_checked": min(faces, max_faces)}


def op_check(req):
    r = check_scene(tol=float(req.get("tolerance", 0.0005)), fix=bool(req.get("fix")), nudge=float(req.get("nudge", 0.002)))
    if r["moved"]:
        summary, fp = scan()
        r["summary"], r["fingerprint"] = summary, fp
    return r


def op_scene(req):
    summary, fp = scan(limit=int(req.get("limit", 150)))
    return {"summary": summary, "fingerprint": fp}


def op_save(req):
    object_mode()
    bpy.ops.wm.save_as_mainfile(filepath=req["path"], copy=True, check_existing=False, compress=False)
    return {}


def op_export(req):
    object_mode()
    fmt, path = req["format"], req["path"]
    if fmt == "glb":
        animated = any(o.animation_data and o.animation_data.action for o in bpy.context.scene.objects)
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True,
                                  use_visible=True, export_cameras=False, export_lights=False,
                                  export_animations=animated)
    elif fmt == "fbx":
        bpy.ops.export_scene.fbx(filepath=path, use_mesh_modifiers=True, path_mode="COPY", embed_textures=True)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=path, apply_modifiers=True, export_materials=True)
    elif fmt == "blend":
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, check_existing=False)
    else:
        return {"ok": False, "error": "unknown format %s" % fmt}
    return {"path": path}


# ---------------------------------------------------------------------------------------------
# Roblox export: one MeshPart per material (roblox_export.py, shared with Kiln's bridge)
# ---------------------------------------------------------------------------------------------

from roblox_export import RBX_BY_KEY, RBX_MATERIALS, roblox_look, write_glb  # noqa: E402,F401
from roblox_export import export as roblox_export  # noqa: E402


def op_roblox(req):
    """Every visible mesh, grouped by material into Roblox MeshParts (see roblox_export.export)."""
    return roblox_export(req["dir"], req["name"])


# ---------------------------------------------------------------------------------------------
# Renders (Kiln's contact sheets, plus an optional Roblox character for scale)
# ---------------------------------------------------------------------------------------------

VIEWS = {
    "iso": (1.0, -1.0, 0.8), "iso_back": (-1.0, 1.0, 0.8), "hero": (0.75, -1.0, 0.3),
    "front": (0.0, -1.0, 0.12), "back": (0.0, 1.0, 0.12), "left": (-1.0, 0.0, 0.12),
    "right": (1.0, 0.0, 0.12), "top": (0.0, -0.001, 1.0), "bottom": (0.0, 0.001, -1.0),
}

# A blocky default Roblox character (5.2 studs), for scale: (name, size xyz, centre xyz) with feet at z = 0.
PLAYER = [
    ("_player_leg_l", (0.96, 1, 2), (-0.5, 0, 1)), ("_player_leg_r", (0.96, 1, 2), (0.5, 0, 1)),
    ("_player_torso", (2, 1, 2), (0, 0, 3)), ("_player_arm_l", (0.96, 1, 2), (-1.5, 0, 3)),
    ("_player_arm_r", (0.96, 1, 2), (1.5, 0, 3)), ("_player_head", (1.2, 1.2, 1.18), (0, 0, 4.61)),
]


def op_render(req):
    object_mode()
    scene = bpy.context.scene
    views = [v for v in (req.get("views") or ["iso"]) if v in VIEWS][:6] or ["iso"]
    pretty = req.get("quality") == "pretty"
    width = max(256, min(1600, int(req.get("size", 768))))
    height = int(width * 0.75)
    focus = [bpy.data.objects[n] for n in (req.get("focus") or []) if n in bpy.data.objects]
    targets = focus or [o for o in scene.objects if o.type in MESHLIKE and o.visible_get()]
    if not targets:
        return {"ok": False, "error": "Nothing visible to render (the scene has no visible geometry)."}
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for ob in targets:
        for c in ob.bound_box:
            w = ob.matrix_world @ mathutils.Vector(c)
            for i in range(3):
                lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])

    r = scene.render
    saved = {"camera": scene.camera, "engine": r.engine, "x": r.resolution_x, "y": r.resolution_y,
             "pct": r.resolution_percentage, "path": r.filepath, "fmt": r.image_settings.file_format,
             "transparent": r.film_transparent, "world": scene.world}
    temp_objects, temp_data, synced = [], [], []
    tiles = []
    player = []
    model_box = (list(lo), list(hi))
    try:
        if req.get("player"):
            # A Roblox character beside the model for scale, feet on the model's floor: to the right of
            # the first view's camera at the model's depth (never in front of it), turned to face it.
            first = mathutils.Vector(VIEWS[views[0]])
            flat = mathutils.Vector((first.x, first.y, 0))
            if flat.length < 1e-3:
                flat = mathutils.Vector((0, -1, 0))
            flat.normalize()
            right = mathutils.Vector((-flat.y, flat.x, 0)) * -1  # the camera's right, on the floor
            hx, hy = (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2
            across = abs(right.x) * hx + abs(right.y) * hy
            mid = mathutils.Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]))
            root = bpy.data.objects.new("_player", None)
            root.location = mid + right * (across + 1.0 + 2.1)
            root.rotation_euler = (0, 0, math.atan2(flat.x, -flat.y))  # its front (-Y) toward the camera
            scene.collection.objects.link(root)
            temp_objects.append(root)
            pm = kiln.mat("_player", base="#71869c", roughness=0.75)
            temp_data.append(pm)
            for nm, size, c in PLAYER:
                bm = bmesh.new()
                bmesh.ops.create_cube(bm, size=1.0)
                me = bpy.data.meshes.new(nm)
                bm.to_mesh(me)
                bm.free()
                ob = bpy.data.objects.new(nm, me)
                ob.scale = size
                ob.location = c
                ob.parent = root
                me.materials.append(pm)
                scene.collection.objects.link(ob)
                temp_objects.append(ob)
                temp_data.append(me)
                player.append(ob)
            bpy.context.view_layer.update()
            for ob in player:
                for c in ob.bound_box:
                    w = ob.matrix_world @ mathutils.Vector(c)
                    for i in range(3):
                        lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])
        with_player = (list(lo), list(hi))
        center = mathutils.Vector([(lo[i] + hi[i]) / 2 for i in range(3)])
        radius = max(0.05, (mathutils.Vector(hi) - mathutils.Vector(lo)).length / 2)

        cam_data = bpy.data.cameras.new("_cam")
        cam_data.lens = 50
        cam = bpy.data.objects.new("_cam", cam_data)
        scene.collection.objects.link(cam)
        temp_objects.append(cam)
        temp_data.append(cam_data)
        scene.camera = cam
        r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, 100
        r.image_settings.file_format = "PNG"
        r.film_transparent = False
        if scene.world is None:
            world = bpy.data.worlds.new("_world")
            temp_data.append(world)
            scene.world = world
        if pretty:
            engine_set = False
            for name in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
                try:
                    r.engine = name
                    engine_set = True
                    break
                except TypeError:
                    continue
            if not engine_set:
                r.engine = "CYCLES"
            try:
                scene.eevee.taa_render_samples = 24
            except Exception:  # noqa: BLE001
                pass
            if not any(o.type == "LIGHT" for o in scene.objects):
                sun_data = bpy.data.lights.new("_sun", "SUN")
                sun_data.energy = 3.5
                sun_data.angle = math.radians(8)
                sun = bpy.data.objects.new("_sun", sun_data)
                sun.rotation_euler = (math.radians(48), math.radians(8), math.radians(35))
                scene.collection.objects.link(sun)
                temp_objects.append(sun)
                temp_data.append(sun_data)
                if scene.world.name == "_world":
                    scene.world.color = (0.35, 0.37, 0.4)
            floor_me = bpy.data.meshes.new("_floor")
            s = radius * 6
            floor_me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
            floor_mat = bpy.data.materials.new("_floor")
            floor_mat.diffuse_color = (0.3, 0.31, 0.33, 1)
            try:
                p = principled(floor_mat) or None
                if p:
                    p.inputs["Base Color"].default_value = (0.3, 0.31, 0.33, 1)
                    p.inputs["Roughness"].default_value = 0.9
            except Exception:  # noqa: BLE001
                pass
            floor_me.materials.append(floor_mat)
            floor = bpy.data.objects.new("_floor", floor_me)
            floor.location = (center.x, center.y, lo[2] - 0.001)
            scene.collection.objects.link(floor)
            temp_objects.append(floor)
            temp_data.extend([floor_me, floor_mat])
        else:
            r.engine = "BLENDER_WORKBENCH"
            sh = scene.display.shading
            sh.light, sh.color_type = "STUDIO", "MATERIAL"
            sh.show_shadows, sh.show_cavity, sh.show_object_outline = True, True, True
            if scene.world.name == "_world":
                scene.world.color = (0.2, 0.21, 0.23)
            # Workbench shows a material's viewport color, not its node color: sync them for the render.
            for m in bpy.data.materials:
                p = principled(m)
                if p and "Base Color" in p.inputs:
                    synced.append((m, tuple(m.diffuse_color), m.metallic, m.roughness))
                    base = p.inputs["Base Color"].default_value
                    es = p.inputs["Emission Strength"].default_value if "Emission Strength" in p.inputs else 0
                    if es and es > 0.05 and "Emission Color" in p.inputs:
                        base = p.inputs["Emission Color"].default_value
                    m.diffuse_color = tuple(base)
                    m.metallic = float(p.inputs["Metallic"].default_value)
                    m.roughness = float(p.inputs["Roughness"].default_value)

        vfov = 2 * math.atan(math.tan(cam_data.angle / 2) * height / width)

        def framing(box):
            c = mathutils.Vector([(box[0][i] + box[1][i]) / 2 for i in range(3)])
            rad = max(0.05, (mathutils.Vector(box[1]) - mathutils.Vector(box[0])).length / 2)
            return c, rad, rad / math.sin(min(cam_data.angle, vfov) / 2) * 0.94

        center, radius, dist = framing(with_player)
        cam_data.clip_start = max(0.001, dist - radius * 2) * 0.5
        cam_data.clip_end = dist + radius * 4
        base = os.path.splitext(req["path"])[0]
        frames = [int(f) for f in (req.get("frames") or [])][:6]
        shots = [(f, v) for f in frames for v in views][:6] if frames else [(None, v) for v in views]
        saved_frame = scene.frame_current
        for i, (f, v) in enumerate(shots):
            if f is not None:
                scene.frame_set(f)
            # The character stands beside the model in the first view only (it would hide the model in others).
            if player:
                for ob in player:
                    ob.hide_render = i != 0
                center, radius, dist = framing(with_player if i == 0 else model_box)
            d = mathutils.Vector(VIEWS[v]).normalized()
            cam.location = center + d * dist
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
            tile = "%s_t%d.png" % (base, i) if len(shots) > 1 else req["path"]
            r.filepath = tile
            bpy.ops.render.render(write_still=True)
            tiles.append(tile)
        if frames:
            scene.frame_set(saved_frame)
        if len(shots) > 1:
            contact_sheet(tiles, req["path"], width, height)
        views = ["frame %d %s" % (f, v) if f is not None else v for f, v in shots]
    finally:
        for m, dc, me, ro in synced:
            m.diffuse_color, m.metallic, m.roughness = dc, me, ro
        scene.camera = saved["camera"]
        r.engine, r.resolution_x, r.resolution_y = saved["engine"], saved["x"], saved["y"]
        r.resolution_percentage, r.filepath = saved["pct"], saved["path"]
        r.image_settings.file_format, r.film_transparent = saved["fmt"], saved["transparent"]
        scene.world = saved["world"]
        for ob in temp_objects:
            bpy.data.objects.remove(ob, do_unlink=True)
        for d in temp_data:
            try:
                if isinstance(d, bpy.types.Camera):
                    bpy.data.cameras.remove(d)
                elif isinstance(d, bpy.types.Light):
                    bpy.data.lights.remove(d)
                elif isinstance(d, bpy.types.World):
                    bpy.data.worlds.remove(d)
                elif isinstance(d, bpy.types.Mesh):
                    bpy.data.meshes.remove(d)
                elif isinstance(d, bpy.types.Material):
                    bpy.data.materials.remove(d)
            except Exception:  # noqa: BLE001
                pass
        if len(tiles) > 1:
            for t in tiles:
                try:
                    os.remove(t)
                except OSError:
                    pass
    return {"path": req["path"], "views": views, "engine": "eevee" if pretty else "workbench"}


def contact_sheet(tiles, path, w, h, gap=6):
    cols = 1 if len(tiles) == 1 else 2 if len(tiles) <= 4 else 3
    rows = (len(tiles) + cols - 1) // cols
    W, H = cols * w + (cols - 1) * gap, rows * h + (rows - 1) * gap
    sheet = np.empty((H, W, 4), dtype=np.float32)
    sheet[:] = (0.07, 0.075, 0.085, 1.0)
    for i, t in enumerate(tiles):
        img = bpy.data.images.load(t)
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        row, col = divmod(i, cols)
        y0 = (rows - 1 - row) * (h + gap)  # Blender images start at the bottom row
        x0 = col * (w + gap)
        sheet[y0:y0 + h, x0:x0 + w] = px.reshape(h, w, 4)
    out = bpy.data.images.new("_sheet", W, H, alpha=False)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)


OPS = {"ping": op_ping, "new": op_new, "open": op_open, "exec": op_exec, "scene": op_scene,
       "save": op_save, "export": op_export, "render": op_render, "check": op_check, "roblox": op_roblox}


def main():
    quiet_prefs()
    fresh_namespace()
    reply({"event": "ready", "version": bpy.app.version_string, "python": sys.version.split()[0]})
    while True:
        line = sys.stdin.readline()
        if not line:
            break  # the core closed the pipe: quit Blender
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t0 = time.time()
        try:
            fn = OPS.get(req.get("op"))
            res = fn(req) if fn else {"ok": False, "error": "unknown op %r" % req.get("op")}
        except Exception:  # noqa: BLE001
            res = {"ok": False, "error": traceback.format_exc(limit=4)[-2500:]}
        res.setdefault("ok", True)
        res["id"] = req.get("id")
        res["ms"] = int((time.time() - t0) * 1000)
        reply(res)


main()
