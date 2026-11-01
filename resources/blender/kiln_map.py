"""
Maps as data (part of `kiln`): a map is a layout project (ground, road, one-off buildings) that places
pieces built in their own projects, tags what each part is for in the game, and marks the points and
lines the game's code needs. An exporter reads all of it from kiln.layout() or the Roblox manifest and
clones each piece instead of receiving the same tree a thousand times.

  piece(project)            another Kiln project's model, brought in as something to place
  place(piece, at)          one or many placements of it (instances, not geometry)
  role(objs, role)          what a part is in the game: drivable, ground, barrier, decor, collider
  marker(name, role, at)    a point for the game: spawn, start_grid, checkpoint, camera
  track(name, points)       a line for the game: the road's centre line
  tile(obj, size)           cuts a big mesh into grid tiles
  layout()                  everything above as plain data
"""

import json
import math
import os

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROLES = ("drivable", "ground", "barrier", "decor", "collider")
MARKERS = ("spawn", "start_grid", "checkpoint", "camera")
PIECE = "Piece_"
MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}


def _k():
    import kiln
    return kiln


def _clean(text):
    out = "".join(ch if ch.isalnum() else "_" for ch in str(text)).strip("_")
    while "__" in out:
        out = out.replace("__", "_")
    return out[:40] or "Piece"


def _home():
    """(the folder that holds every Kiln project, this project's id)."""
    d = getattr(_k(), "PROJECT_DIR", None) or (os.path.dirname(bpy.data.filepath) if bpy.data.filepath else None)
    if not d:
        raise RuntimeError("pieces need a saved Kiln project (this scene has no project folder)")
    d = os.path.abspath(d)
    return os.path.dirname(d), os.path.basename(d)


def _meta(folder):
    try:
        with open(os.path.join(folder, "project.json"), encoding="utf-8") as f:
            m = json.load(f)
        return m if isinstance(m, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _stamp(folder, meta):
    """(version, fingerprint) of a project's saved scene; projects last saved by an older Kiln have only a file time."""
    fp = meta.get("fingerprint")
    if not fp:
        try:
            fp = "mtime:%d" % int(os.path.getmtime(os.path.join(folder, "scene.blend")))
        except OSError:
            fp = ""
    return int(meta.get("version") or 0), fp


def _find(project):
    root, me = _home()
    pid = str(project).strip()
    folder = os.path.join(root, pid)
    if not pid or os.path.basename(folder) != pid or not os.path.isfile(os.path.join(folder, "scene.blend")):
        # Not an id: a title, then.
        hits = []
        for d in sorted(os.listdir(root)):
            f = os.path.join(root, d)
            if os.path.isfile(os.path.join(f, "scene.blend")) and str(_meta(f).get("title", "")).strip().lower() == pid.lower():
                hits.append(d)
        if len(hits) != 1:
            raise ValueError('no Kiln project "%s"%s: pass the project\'s id (the name of its folder)' % (pid, " (%d projects have that title)" % len(hits) if hits else ""))
        pid, folder = hits[0], os.path.join(root, hits[0])
    if pid == me:
        raise ValueError("a project can't be a piece of itself")
    return pid, folder


def _piece(p):
    if isinstance(p, bpy.types.Collection):
        col = p
    else:
        col = bpy.data.collections.get(str(p)) or bpy.data.collections.get(PIECE + str(p))
        if col is None:
            col = next((c for c in bpy.data.collections if c.get("kiln_piece") == str(p)), None)
    if col is None or not col.get("kiln_piece"):
        have = sorted(c.name[len(PIECE):] for c in bpy.data.collections if c.get("kiln_piece"))
        raise ValueError('no piece "%s" in this scene (pieces: %s). Bring one in with kiln.piece("<project id>").' % (p, ", ".join(have) or "none"))
    return col


def pieces():
    """The pieces in this scene: [{"name", "project", "version", "fingerprint", "tris", "placements"}]."""
    sc = bpy.context.scene
    count = {}
    for ob in sc.objects:
        if ob.instance_type == "COLLECTION" and ob.instance_collection is not None:
            count[ob.instance_collection.name] = count.get(ob.instance_collection.name, 0) + 1
    return [{"name": c.name[len(PIECE):], "project": c["kiln_piece"], "version": int(c.get("kiln_piece_version", 0)), "fingerprint": c.get("kiln_piece_fingerprint", ""),
             "tris": int(c.get("kiln_piece_tris", 0)), "placements": count.get(c.name, 0)}
            for c in sorted(bpy.data.collections, key=lambda c: c.name) if c.get("kiln_piece")]


def piece(project, name=None):
    """Brings another Kiln project's model into this scene as a piece to place: project is that project's
    id (its folder name) or its exact title. Returns the piece (a collection named "Piece_<name>") for
    kiln.place and kiln.scatter. The piece is not in the scene until it is placed, and a placement is an
    instance: a thousand trees cost one tree. Calling it again refreshes the piece from its project (every
    placement follows). A piece can't itself contain placed pieces."""
    pid, folder = _find(project)
    blend = os.path.join(folder, "scene.blend")
    meta = _meta(folder)
    with bpy.data.libraries.load(blend, link=False) as (src, _dst):
        names = list(src.objects)
        nested = [c for c in src.collections if c.startswith(PIECE)]
    if nested:
        raise ValueError('"%s" is itself a layout (it holds pieces: %s). Pieces can\'t nest: place those pieces here directly.' % (pid, ", ".join(n[len(PIECE):] for n in nested[:4])))
    label = _clean(name or meta.get("title") or pid)
    col = bpy.data.collections.get(PIECE + label)
    if col is not None and col.get("kiln_piece") not in (None, pid):
        raise ValueError('the name "%s" is taken by the piece from project %s: pass name="..."' % (label, col.get("kiln_piece")))
    if col is None:
        col = bpy.data.collections.new(PIECE + label)
        col.use_fake_user = True
    else:
        for ob in list(col.all_objects):
            bpy.data.objects.remove(ob, do_unlink=True)
    with bpy.data.libraries.load(blend, link=False) as (src, dst):
        dst.objects = names
    tris = kept = 0
    for ob in dst.objects:
        if ob is None:
            continue
        if ob.type in ("LIGHT", "CAMERA") or ob.name.startswith("_kiln") or ob.hide_render or ob.hide_viewport or (ob.type == "EMPTY" and ob.get("kiln_role")):
            bpy.data.objects.remove(ob, do_unlink=True)
            continue
        col.objects.link(ob)
        kept += 1
        if ob.type == "MESH":
            ob.data.calc_loop_triangles()
            tris += len(ob.data.loop_triangles)
    if not kept:
        bpy.data.collections.remove(col)
        raise ValueError('project "%s" has nothing to place (its scene is empty)' % pid)
    version, fp = _stamp(folder, meta)
    col["kiln_piece"], col["kiln_piece_title"] = pid, str(meta.get("title") or pid)
    col["kiln_piece_version"], col["kiln_piece_fingerprint"], col["kiln_piece_tris"] = version, fp, tris
    return col


def _euler(rotation):
    if hasattr(rotation, "__len__"):
        return Euler([math.radians(float(a)) for a in rotation])
    return Euler((0.0, 0.0, math.radians(float(rotation))))


def _scale3(scale):
    return tuple(float(s) for s in scale) if hasattr(scale, "__len__") else (float(scale),) * 3


def place(piece, at, rotation=0.0, scale=1.0, name=None, role=None, coll="Placed", ground=None):
    """Places a piece (from kiln.piece): at is one spot (x, y, z) or a list of spots; a spot may be (x, y)
    (it lands on the ground), (x, y, z), (x, y, z, turn) or (x, y, z, turn, size) with turn in degrees
    about Z and size a scale factor. rotation and scale apply to spots that don't carry their own:
    rotation is degrees about Z or (rx, ry, rz); scale a number or (sx, sy, sz). Mirroring (a negative
    scale) is refused: a game engine can't mirror a placed piece. Returns the placement, or the list."""
    k = _k()
    col = _piece(piece)
    single = len(at) > 0 and not hasattr(at[0], "__len__")
    spots = [at] if single else list(at)
    base = name or col.name[len(PIECE):]
    taken = {o.name for o in bpy.data.objects}
    n, out = 0, []
    for p in spots:
        p = tuple(float(v) for v in p)
        if len(p) < 2:
            raise ValueError("a spot is (x, y), (x, y, z), (x, y, z, turn) or (x, y, z, turn, size)")
        z = p[2] if len(p) > 2 else k.ground_z(p[0], p[1], ground)
        rot = _euler(p[3]) if len(p) > 3 else _euler(rotation)
        sc = _scale3(p[4]) if len(p) > 4 else _scale3(scale)
        if min(sc) <= 0:
            raise ValueError("a placement's scale must be positive (mirrored pieces can't be placed: build the mirrored piece as its own project)")
        while True:
            n += 1
            nm = "%s_%03d" % (base, n)
            if nm not in taken:
                break
        ob = bpy.data.objects.new(nm, None)
        taken.add(ob.name)
        ob.instance_type, ob.instance_collection = "COLLECTION", col
        ob.empty_display_type, ob.empty_display_size = "PLAIN_AXES", 0.5
        ob.location, ob.rotation_euler, ob.scale = (p[0], p[1], z), rot, sc
        ob["kiln_piece"] = col["kiln_piece"]
        if role:
            ob["kiln_role"] = _role(role)
        k.link(ob, coll)
        out.append(ob)
    return out[0] if single else out


def _role(r, markers=False):
    r = str(r).strip().lower()
    if not markers and r not in ROLES:
        raise ValueError('unknown role "%s": one of %s' % (r, ", ".join(ROLES)))
    return r


def role(objs, role, stands_for=None):
    """Says what parts are in the game, for the exporter: "drivable" (road surface: exact collision),
    "ground" (terrain that isn't road), "barrier" (walls, rails: simple collision), "decor" (no collision),
    "collider" (an unseen simple shape that collides instead of stands_for, e.g. one box for a detailed
    building; it stops rendering). objs: an object, a name, a list, or a collection; children are tagged too."""
    k = _k()
    r = _role(role)
    if isinstance(objs, bpy.types.Collection):
        items = list(objs.all_objects)
    else:
        items = [k.obj(o) if isinstance(o, str) else o for o in (objs if isinstance(objs, (list, tuple)) else [objs])]
    out = []
    for o in items:
        if o is None:
            raise ValueError("kiln.role got None: pass objects, names or a collection")
        for x in [o] + list(o.children_recursive):
            x["kiln_role"] = r
            if r == "collider":
                x.hide_render = True
                x.display_type = "WIRE"
                if stands_for is not None:
                    x["kiln_collides_for"] = stands_for if isinstance(stands_for, str) else stands_for.name
            out.append(x)
    return out


def marker(name, role, at, rotation=0.0, coll="Markers"):
    """A point the game's code needs, as an arrow in the scene: role is "spawn", "start_grid",
    "checkpoint", "camera" or any word the game uses. at is (x, y, z); rotation is degrees about Z or
    (rx, ry, rz): the arrow points along the marker's +Y (the way a spawned car faces)."""
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type, ob.empty_display_size = "SINGLE_ARROW", 1.5
    ob.location = tuple(float(v) for v in at)
    ob.rotation_euler = _euler(rotation)
    ob["kiln_role"] = _role(role, markers=True)
    _k().link(ob, coll)
    return ob


def track(name, points, width=None, role="road_centerline", closed=False, coll="Markers"):
    """A line the game's code needs (a road's centre line for resets, laps and AI): points [(x, y, z), ...]
    in order, width the road's width there. It is data, not geometry: a thin line in the scene that renders
    and exports as nothing. kiln.path roads carry their own centre line already."""
    pts = [tuple(float(v) for v in (p if len(p) > 2 else (p[0], p[1], _k().ground_z(p[0], p[1])))) for p in points]
    if len(pts) < 2:
        raise ValueError("a track needs at least 2 points")
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for q, p in zip(sp.points, pts):
        q.co = (p[0], p[1], p[2], 1.0)
    sp.use_cyclic_u = bool(closed)
    ob = bpy.data.objects.new(name, cu)
    ob.hide_render = True
    ob["kiln_role"] = _role(role, markers=True)
    ob["kiln_path"] = json.dumps({"points": [[round(v, 3) for v in p] for p in pts], "width": None if width is None else float(width), "closed": bool(closed)})
    _k().link(ob, coll)
    return ob


def tile(obj, size, name=None):
    """Cuts a mesh into grid tiles of size (x, y) scene units (a number = square), for ground too big or
    too heavy for one game part. The tiles keep the materials, UVs and role, share one collection with the
    original, and replace it. Returns the tiles."""
    k = _k()
    ob = k.obj(obj) if isinstance(obj, str) else obj
    if ob is None or ob.type != "MESH":
        raise ValueError("kiln.tile needs a mesh object")
    sx, sy = (float(size[0]), float(size[1])) if hasattr(size, "__len__") else (float(size), float(size))
    if sx <= 0 or sy <= 0:
        raise ValueError("tile size must be positive")
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    bm.from_object(ob, dg)
    bm.transform(ob.matrix_world)
    if ob.matrix_world.to_3x3().determinant() < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    xs, ys = [v.co.x for v in bm.verts], [v.co.y for v in bm.verts]
    if not xs:
        bm.free()
        return [ob]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    nx, ny = max(1, math.ceil((x1 - x0) / sx - 1e-6)), max(1, math.ceil((y1 - y0) / sy - 1e-6))
    if nx * ny == 1:
        bm.free()
        return [ob]
    if nx * ny > 4096:
        bm.free()
        raise ValueError("that is %d tiles: use a larger tile size" % (nx * ny))
    for i in range(1, nx):
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(x0 + i * sx, 0, 0), plane_no=(1, 0, 0), dist=1e-6)
    for j in range(1, ny):
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, y0 + j * sy, 0), plane_no=(0, 1, 0), dist=1e-6)
    bm.faces.ensure_lookup_table()
    cells = {}
    for f in bm.faces:
        c = f.calc_center_median()
        key = (min(nx - 1, max(0, int((c.x - x0) / sx))), min(ny - 1, max(0, int((c.y - y0) / sy))))
        cells.setdefault(key, set()).add(f.index)
    base = name or ob.name
    colls = list(ob.users_collection)
    props = {key: ob[key] for key in ob.keys() if key.startswith("kiln_")}
    out = []
    for (i, j), keep in sorted(cells.items()):
        part = bm.copy()
        part.faces.ensure_lookup_table()
        bmesh.ops.delete(part, geom=[f for f in part.faces if f.index not in keep], context="FACES")
        me = bpy.data.meshes.new("%s_%d_%d" % (base, i, j))
        centre = Vector((x0 + (i + 0.5) * sx, y0 + (j + 0.5) * sy, 0.0))
        part.transform(Matrix.Translation(-centre))
        part.to_mesh(me)
        part.free()
        for m in ob.data.materials:
            me.materials.append(m)
        t = bpy.data.objects.new(me.name, me)
        t.location = centre
        for c in colls or [bpy.context.scene.collection]:
            c.objects.link(t)
        for key, v in props.items():
            t[key] = v
        out.append(t)
    bm.free()
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.context.view_layer.update()
    return out


def _matrix(m):
    return [[round(float(v), 5) for v in row] for row in m]


def layout():
    """The map as data, in scene units and Blender axes (Z up): {"pieces": {name: {project, version,
    fingerprint, tris, placements, stale}}, "placements": [{name, piece, project, matrix, role?}],
    "markers": [{name, role, matrix}], "paths": [{name, role, points, width, closed}],
    "roles": {object: role}, "colliders": [{name, stands_for}], "mirrored": [placement names]}.
    A matrix is 4x4, row-major (the placement's world transform); stale marks a piece whose project has
    changed since it was brought in (kiln.piece again refreshes it)."""
    sc = bpy.context.scene
    out = {"pieces": {}, "placements": [], "markers": [], "paths": [], "roles": {}, "colliders": [], "mirrored": []}
    try:
        root = _home()[0]
    except Exception:  # noqa: BLE001
        root = None
    for p in pieces():
        stale = False
        if root is not None:
            folder = os.path.join(root, p["project"])
            if os.path.isdir(folder):
                stale = _stamp(folder, _meta(folder)) != (p["version"], p["fingerprint"])
        out["pieces"][p["name"]] = {"project": p["project"], "version": p["version"], "fingerprint": p["fingerprint"], "tris": p["tris"], "placements": 0, "stale": stale}
    for ob in sorted(sc.objects, key=lambda o: o.name):
        r = ob.get("kiln_role")
        col = ob.instance_collection if ob.instance_type == "COLLECTION" else None
        if col is not None and col.get("kiln_piece"):
            if not ob.visible_get():
                continue
            e = {"name": ob.name, "piece": col.name[len(PIECE):], "project": col["kiln_piece"], "matrix": _matrix(ob.matrix_world)}
            if r:
                e["role"] = r
            out["placements"].append(e)
            out["pieces"][e["piece"]]["placements"] += 1
            if ob.matrix_world.to_3x3().determinant() < 0:
                out["mirrored"].append(ob.name)
            continue
        if ob.get("kiln_path"):
            try:
                d = json.loads(ob["kiln_path"])
                mw = ob.matrix_world
                d["points"] = [[round(v, 3) for v in (mw @ Vector(p))] for p in d.get("points", [])]
                out["paths"].append({"name": ob.name, "role": r if ob.type == "CURVE" and r else "road_centerline", **d})
            except Exception:  # noqa: BLE001
                pass
        if ob.type == "EMPTY" and r:
            out["markers"].append({"name": ob.name, "role": r, "matrix": _matrix(ob.matrix_world)})
        elif ob.type in MESHLIKE and r and not (ob.type == "CURVE" and ob.get("kiln_path")):
            if r == "collider":
                out["colliders"].append({"name": ob.name, "stands_for": ob.get("kiln_collides_for")})
            elif ob.visible_get():
                out["roles"][ob.name] = r
    return out
