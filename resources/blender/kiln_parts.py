"""
Parts that fit together (part of `kiln`): a kit of interchangeable pieces (a mech's legs, torsos, arms and
weapons; modular walls; a gun and its attachments) is held together by sockets, and a game assembles it
by snapping sockets onto each other. This module names the sockets, checks that the parts really fit,
and reports each model the way an exporter needs it.

  socket(name, part, at, facing, mates)   a named attachment frame on a part
  sockets(part=None)                      the sockets in the scene, or on one part
  mount(child, child_socket, parent, parent_socket)  move a part so the two sockets coincide
  fit(child, child_socket, parent, parent_socket)    how well they would fit, without moving anything
  fit_report()                            every declared pairing in the scene, checked
  models()                                each top-level model: origin, size, triangles, materials, sockets
  part(obj, name)                         a piece of a model the game's code moves or finds by name (a door)
  style() / style_mat(name)               the game's shared style sheet and its materials

A socket's facing is the direction from the carrying part toward the carried part, on BOTH parts: a
torso's ArmSocket_L and an arm's ShoulderSocket point the same way once assembled (out of the torso,
along the arm). The game's engine lines the two frames up exactly.
"""

import json
import math
import os

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}


def _k():
    import kiln
    return kiln


def _obj(o):
    return _k().obj(o) if isinstance(o, str) else o


def _valid(name):
    n = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in str(name)).strip("_")
    if not n:
        raise ValueError("a socket needs a name (letters, digits, underscore)")
    return n


def _frame(at, facing, up):
    """A world matrix at `at` whose +Y is `facing` and whose +Z is as close to `up` as it can be."""
    y = Vector(facing).normalized() if Vector(facing).length > 1e-9 else Vector((0, -1, 0))
    z = Vector(up)
    z = z - y * z.dot(y)
    if z.length < 1e-6:
        z = Vector((0, 0, 1)) - y * y.z
        if z.length < 1e-6:
            z = Vector((1, 0, 0))
    z.normalize()
    x = y.cross(z)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = Vector(at)
    return m


def _root(o):
    while o.parent is not None and o.parent.type != "ARMATURE":
        o = o.parent
    return o


def _is_socket(o):
    return o.type == "EMPTY" and bool(o.get("kiln_socket"))


def socket(name, part, at, facing=(0, -1, 0), up=(0, 0, 1), mates=None):
    """A socket on a part: where another part attaches, or where this part attaches to another.
    part: the object (or its name) that carries it; the socket moves with the part.
    at: (x, y, z) in the scene as it stands now. facing: the direction from the carrying part toward the
    carried part (a torso's arm socket points out of the torso; the arm's shoulder socket points along the
    arm, the same way once assembled). up: the frame's second direction (default world up).
    mates: the name of the socket it joins on other parts ("ShoulderSocket"), or a list: kiln.fit_report
    checks every such pairing in the scene. Calling it again with the same name on the same part moves it.
    Put the socket ON the part's surface where the two parts meet. Returns the socket (an empty)."""
    k = _k()
    part = _obj(part)
    if part is None:
        raise ValueError("kiln.socket needs the part that carries the socket")
    name = _valid(name)
    ob = next((c for c in part.children if _is_socket(c) and c["kiln_socket"] == name), None)
    if ob is None:
        ob = bpy.data.objects.new("%s.%s" % (part.name, name), None)
        for c in part.users_collection or [bpy.context.scene.collection]:
            c.objects.link(ob)
    ob.empty_display_type, ob.empty_display_size = "ARROWS", max(0.05, 0.08 * max(part.dimensions) if max(part.dimensions) > 0 else 0.2)
    ob["kiln_socket"] = name
    if mates:
        ob["kiln_mates"] = json.dumps([_valid(m) for m in (mates if isinstance(mates, (list, tuple)) else [mates])])
    elif "kiln_mates" in ob:
        del ob["kiln_mates"]
    bpy.context.view_layer.update()
    ob.parent = part
    ob.matrix_parent_inverse = part.matrix_world.inverted()
    ob.matrix_world = _frame(at, facing, up)
    bpy.context.view_layer.update()
    return ob


def part(obj, name):
    """Marks a piece of a model that the game's code finds or moves by name: a door that opens, a display
    that lights up, a lid, a wheel, a lever. It stays its own object through the export (its own part in
    the game, named after it), together with whatever is parented under it; everything unmarked may be
    merged. obj: the object or its name; name: letters, digits, underscore ("Door"). Give it its origin
    where it pivots (a door: on its hinge line, kiln.set_origin or move the origin there). Returns obj."""
    o = _obj(obj)
    if o is None:
        raise ValueError("kiln.part needs an object")
    o["kiln_part"] = _valid(name)
    return o


def _part_of(o, root):
    """The named part an object belongs to (its own kiln_part, or the nearest one above it), or None."""
    while o is not None:
        if o.get("kiln_part"):
            return o
        if o == root:
            return None
        o = o.parent
    return None


def _mates(ob):
    try:
        return list(json.loads(ob.get("kiln_mates") or "[]"))
    except Exception:  # noqa: BLE001
        return []


def _find(part, name):
    part = _obj(part)
    hit = [c for c in [part] + list(part.children_recursive) if _is_socket(c) and c["kiln_socket"] == name]
    if not hit:
        have = sorted({c["kiln_socket"] for c in [part] + list(part.children_recursive) if _is_socket(c)})
        raise ValueError('"%s" has no socket "%s" (its sockets: %s)' % (part.name, name, ", ".join(have) or "none"))
    return hit[0]


def sockets(part=None):
    """The sockets in the scene (or on one part and its children):
    [{"name", "part", "model", "mates", "position" (world), "facing" (world), "object"}]."""
    bpy.context.view_layer.update()
    pool = bpy.context.scene.objects if part is None else [_obj(part)] + list(_obj(part).children_recursive)
    out = []
    for o in pool:
        if not _is_socket(o) or o.parent is None:
            continue
        mw = o.matrix_world
        out.append({"name": o["kiln_socket"], "part": o.parent.name, "model": _root(o).name, "mates": _mates(o),
                    "position": [round(v, 4) for v in mw.translation], "facing": [round(v, 4) for v in (mw.to_3x3() @ Vector((0, 1, 0))).normalized()], "object": o.name})
    return sorted(out, key=lambda s: (s["model"], s["name"]))


def _meshes(root):
    return [o for o in [root] + list(root.children_recursive) if o.type == "MESH" and o.visible_get() and o.get("kiln_role") != "collider" and len(o.data.polygons)]


def _world_mesh(objs, extra=None):
    """(vertices, triangles) of several objects in world space, optionally moved by `extra`."""
    dg = bpy.context.evaluated_depsgraph_get()
    vs, ts, base = [], [], 0
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        n = len(me.vertices)
        if n and len(me.loop_triangles):
            co = np.empty(n * 3, dtype=np.float32)
            me.vertices.foreach_get("co", co)
            tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
            me.loop_triangles.foreach_get("vertices", tri)
            m = np.array((extra @ o.matrix_world) if extra is not None else o.matrix_world, dtype=np.float64)
            vs.append(co.reshape(-1, 3).astype(np.float64) @ m[:3, :3].T + m[:3, 3])
            ts.append(tri.reshape(-1, 3) + base)
            base += n
        ev.to_mesh_clear()
    if not vs:
        return np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int32)
    return np.concatenate(vs), np.concatenate(ts)


def _delta(child_socket, parent_socket):
    """The world transform that carries the child (with its socket) onto the parent's socket."""
    return parent_socket.matrix_world @ child_socket.matrix_world.inverted()


def mount(child, child_socket, parent, parent_socket):
    """Moves `child` (its whole model) so that its socket sits exactly on the parent's socket, frames
    aligned: how the game will assemble them. Returns the child's root object."""
    bpy.context.view_layer.update()
    cs, ps = _find(child, child_socket), _find(parent, parent_socket)
    root = _root(_obj(child))
    root.matrix_world = _delta(cs, ps) @ root.matrix_world
    bpy.context.view_layer.update()
    return root


def fit(child, child_socket, parent, parent_socket):
    """How the two parts would fit if the child's socket were snapped onto the parent's (nothing moves):
    {"ok", "gap" (the open distance between the two surfaces near the joint; 0 when they touch or
    overlap), "buried" (the share of the child's joint area sunk inside the parent), "child_socket_off"
    and "parent_socket_off" (how far each socket sits from its own part's surface), "problem"}.
    A good joint has no gap, the sockets on their surfaces, and the child not swallowed by the parent."""
    bpy.context.view_layer.update()
    cs, ps = _find(child, child_socket), _find(parent, parent_socket)
    croot, proot = _root(_obj(child)), _root(_obj(parent))
    d = _delta(cs, ps)
    pv, pt = _world_mesh(_meshes(proot))
    cv, ct = _world_mesh(_meshes(croot), d)
    cv0, ct0 = _world_mesh(_meshes(croot))
    if not len(pv) or not len(cv):
        return {"ok": False, "problem": "one of the parts has no visible mesh", "gap": None, "buried": None}
    ptree = BVHTree.FromPolygons(pv.tolist(), pt.tolist())
    ctree0 = BVHTree.FromPolygons(cv0.tolist(), ct0.tolist())
    at = np.array(ps.matrix_world.translation)
    size = float(min(np.linalg.norm(pv.max(0) - pv.min(0)), np.linalg.norm(cv.max(0) - cv.min(0))))
    tol = max(0.02, 0.02 * size)
    # The joint area: the child's vertices nearest the socket (a quarter of its size around it, at least 24 of them).
    dist = np.linalg.norm(cv - at, axis=1)
    near = cv[dist <= max(0.25 * size, np.sort(dist)[min(len(dist) - 1, 23)])]
    near = near[:: max(1, len(near) // 240)]
    gap, inside = 1e18, 0
    for p in near:
        v = Vector(p)
        hit = ptree.find_nearest(v)
        if hit[0] is not None:
            gap = min(gap, hit[3])
        # Inside the parent: a ray in any direction crosses its surface an odd number of times.
        crossings, o, direction = 0, v.copy(), Vector((0.3, 0.2, 0.93)).normalized()
        for _ in range(32):
            h = ptree.ray_cast(o, direction)
            if h[0] is None:
                break
            crossings += 1
            o = h[0] + direction * 1e-4
        inside += crossings % 2
    buried = inside / max(1, len(near))
    gap = 0.0 if buried > 0 else float(gap)
    p_off = float(ptree.find_nearest(ps.matrix_world.translation)[3] or 0.0)
    c_off = float(ctree0.find_nearest(cs.matrix_world.translation)[3] or 0.0)
    problems = []
    if gap > tol:
        problems.append("a gap of %.3g between the parts at the joint" % gap)
    if buried > 0.85:
        problems.append("the joint end of %s is swallowed by %s (%d%% inside)" % (croot.name, proot.name, round(buried * 100)))
    if p_off > 3 * tol:
        problems.append("%s.%s sits %.3g off its part's surface" % (proot.name, parent_socket, p_off))
    if c_off > 3 * tol:
        problems.append("%s.%s sits %.3g off its part's surface" % (croot.name, child_socket, c_off))
    return {"ok": not problems, "gap": round(gap, 4), "buried": round(buried, 3), "parent_socket_off": round(p_off, 4), "child_socket_off": round(c_off, 4),
            "tolerance": round(tol, 4), "problem": "; ".join(problems) or None}


def fit_report():
    """Every pairing the sockets declare (a socket with mates="X" against every other model's socket X),
    checked with kiln.fit: {"ok", "pairs": [{"parent", "socket", "child", "mate", "ok", "gap", "buried",
    "problem"}], "summary"}. Run it when a kit's parts are built, and fix what it lists."""
    all_s = sockets()
    pairs, seen = [], set()
    for a in all_s:
        for mate in a["mates"]:
            for b in all_s:
                if b["name"] != mate or b["model"] == a["model"]:
                    continue
                key = tuple(sorted(((a["model"], a["name"]), (b["model"], b["name"]))))
                if key in seen:
                    continue
                seen.add(key)
                r = fit(b["part"], b["name"], a["part"], a["name"])
                pairs.append({"parent": a["model"], "socket": a["name"], "child": b["model"], "mate": b["name"], "ok": r["ok"], "gap": r.get("gap"), "buried": r.get("buried"), "problem": r.get("problem")})
    bad = [p for p in pairs if not p["ok"]]
    lonely = sorted({"%s.%s" % (s["model"], s["name"]) for s in all_s if s["mates"] and not any(p for p in pairs if (p["parent"], p["socket"]) == (s["model"], s["name"]) or (p["child"], p["mate"]) == (s["model"], s["name"]))})
    summary = "Fit: %d pairing%s checked, %s." % (len(pairs), "" if len(pairs) == 1 else "s", "all fit" if not bad else "%d don't fit" % len(bad))
    if bad:
        summary += " " + "; ".join("%s.%s <- %s.%s: %s" % (p["parent"], p["socket"], p["child"], p["mate"], p["problem"]) for p in bad[:8])
    if lonely:
        summary += " No partner in this scene for: %s." % ", ".join(lonely[:8])
    return {"ok": not bad, "pairs": pairs, "unpaired": lonely, "summary": summary}


def _hex(c):
    def enc(x):
        x = max(0.0, min(1.0, float(x)))
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
    return "#%02x%02x%02x" % tuple(int(round(enc(v) * 255)) for v in c[:3])


def models():
    """Each top-level model in the scene as an exporter needs it: [{"name", "objects" (its meshes),
    "origin" (world), "origin_at" ("bottom_centre", "centre", "socket:<name>" or "elsewhere"), "min",
    "max", "size", "ground_gap" (how far its lowest point is above z = 0; negative = sunk), "tris",
    "parts": [{"name", "object", "parent" (the named part it sits under, or None), "objects" (its meshes), "pivot" (its origin in the model's space)}] for
    the pieces marked with kiln.part,
    "materials": [{"name", "color", "roblox_material"}], "sockets": [{"name", "mates", "position" and
    "facing" in the model's own space (relative to its origin), "matrix" (4x4 row-major, same space)}]}].
    A model is a top-level object with everything parented under it (the rig, for a rigged model).
    Variants of one thing (three torsos) are separate models: give each its own top-level object."""
    bpy.context.view_layer.update()
    sc = bpy.context.scene
    out = []
    roots = []
    for o in sc.objects:
        if o.parent is not None or o.name.startswith("_kiln") or not o.visible_get() and o.type != "EMPTY":
            continue
        if o.type in ("LIGHT", "CAMERA") or _is_socket(o) or (o.instance_type == "COLLECTION" and o.instance_collection is not None):
            continue
        if o.type == "CURVE" and o.get("kiln_path"):
            continue
        if o.type == "EMPTY" and o.get("kiln_role") and not o.children:
            continue  # a marker
        roots.append(o)
    for root in sorted(roots, key=lambda o: o.name):
        meshes = _meshes(root)
        if not meshes:
            continue
        v, t = _world_mesh(meshes)
        if not len(v):
            continue
        lo, hi = v.min(0), v.max(0)
        origin = np.array(root.matrix_world.translation)
        size = hi - lo
        tol = max(0.02, 0.03 * float(np.linalg.norm(size)))
        socks = []
        inv = root.matrix_world.inverted()
        for s in [c for c in root.children_recursive if _is_socket(c)]:
            local = inv @ s.matrix_world
            socks.append({"name": s["kiln_socket"], "mates": _mates(s), "position": [round(x, 4) for x in local.translation],
                          "facing": [round(x, 4) for x in (local.to_3x3() @ Vector((0, 1, 0))).normalized()], "matrix": [[round(x, 5) for x in row] for row in local]})
        where = "elsewhere"
        if np.linalg.norm(origin - np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])) <= tol:
            where = "bottom_centre"
        elif np.linalg.norm(origin - (lo + hi) / 2) <= tol:
            where = "centre"
        else:
            for s in [c for c in root.children_recursive if _is_socket(c)]:
                if (s.matrix_world.translation - root.matrix_world.translation).length <= tol:
                    where = "socket:" + s["kiln_socket"]
                    break
        mats = {}
        for o in meshes:
            for sl in o.material_slots:
                m = sl.material
                if m is None or m.name in mats:
                    continue
                p = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m.node_tree else None
                col = _hex(p.inputs["Base Color"].default_value) if p is not None and not p.inputs["Base Color"].is_linked else None
                mats[m.name] = {"name": m.name, "color": col, "roblox_material": m.get("roblox_material") or None}
        named = {}
        for o in meshes:
            p = _part_of(o, root)
            if p is not None:
                above = _part_of(p.parent, root) if p != root and p.parent is not None else None
                e = named.setdefault(p.name, {"name": p["kiln_part"], "object": p.name, "parent": above["kiln_part"] if above is not None else None, "objects": [],
                                              "pivot": [round(float(x), 4) for x in (inv @ p.matrix_world).translation]})
                e["objects"].append(o.name)
        out.append({
            "name": root.name, "objects": [o.name for o in meshes], "parts": sorted(named.values(), key=lambda e: e["name"]), "origin": [round(float(x), 4) for x in origin], "origin_at": where,
            "min": [round(float(x), 4) for x in lo], "max": [round(float(x), 4) for x in hi], "size": [round(float(x), 4) for x in size],
            "ground_gap": round(float(lo[2]), 4), "tris": int(len(t)), "materials": list(mats.values()), "sockets": sorted(socks, key=lambda s: s["name"]),
            "rigged": root.type == "ARMATURE",
        })
    return out


# ---------------------------------------------------------------------------------------------------
# The game's style sheet (one per game; Kiln puts it in the project folder when a brief names it)

def style():
    """The game's shared style sheet as a dict, or None when this build has none: {"palette": [hex],
    "materials": [{"name", "color", "roughness", "metallic", "roblox_material", "use"}], "bevel",
    "texel_density", "budgets": {"hero", "prop", "dressing"}, "wear", "notes"}. Every model of the game
    follows the same sheet, so they match."""
    d = getattr(_k(), "PROJECT_DIR", None)
    if not d:
        return None
    try:
        with open(os.path.join(d, "style.json"), encoding="utf-8") as f:
            s = json.load(f)
        return s if isinstance(s, dict) else None
    except Exception:  # noqa: BLE001
        return None


def style_mat(name):
    """A material of the style sheet, made exactly as the sheet says (so the same name is the same
    material in every model of the game). Raises when the sheet has no material of that name."""
    k = _k()
    s = style()
    if not s:
        raise ValueError("this build has no style sheet (kiln.style() is None): use kiln.mat")
    e = next((m for m in s.get("materials") or [] if str(m.get("name", "")).lower() == str(name).lower()), None)
    if e is None:
        raise ValueError('the style sheet has no material "%s" (it has: %s)' % (name, ", ".join(str(m.get("name")) for m in s.get("materials") or []) or "none"))
    m = k.mat(e["name"], e.get("color") or "#808080", roughness=float(e.get("roughness", 0.6)), metallic=float(e.get("metallic", 0.0)))
    if e.get("emission"):
        k.mat(e["name"], emission=e["emission"], strength=float(e.get("strength", 2.0)))
    if e.get("roblox_material") and k.roblox is not None:
        try:
            k.roblox.surface(m, e["roblox_material"])
        except ValueError:
            pass
    return m
