"""
Rigs (exposed through `kiln` as kiln.rig): one armature object "Rig" whose bones are the joints.
Rigid parts move with a joint (bind: mechanical legs, armour, props); flesh can bend with several
joints (skin: bodies, tails, cloth). Clips live in kiln.anim. Shuriken Studio reads rigs only through
info() here and kiln.anim.clips() / kiln.anim.sample(), and turns them into Roblox Motor6D or Bone rigs.

Conventions: creatures face -Y (the front view), up is +Z, the character's right is -X. A joint's pivot
is its bone's head. Rotations handed to these helpers are in WORLD-ALIGNED axes (a hinge axis (1, 0, 0)
is the world X axis at rest), whatever the bone's own orientation.
"""

import json
import math
import re

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

RIG = "Rig"
FPS = 30
_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


def _k():
    import kiln
    return kiln


def _rig_coll():
    return _k().collection("_Rig")


def _object_mode():
    try:
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:  # noqa: BLE001
        pass


def armature(create=True):
    """The rig's armature object ("Rig"); made at the origin on first use (scene set to 30 fps)."""
    ob = bpy.data.objects.get(RIG)
    if ob is not None and ob.type == "ARMATURE":
        return ob
    if not create:
        return None
    if ob is not None:
        ob.name = RIG + "_Object"  # a mesh that happened to be called "Rig"
    arm = bpy.data.armatures.new(RIG)
    arm.display_type = "OCTAHEDRAL"
    ob = bpy.data.objects.new(RIG, arm)
    ob.show_in_front = True
    _k().link(ob, _rig_coll())
    sc = bpy.context.scene
    if not sc.get("kiln_fps_set"):
        sc.render.fps, sc.render.fps_base = FPS, 1.0
        sc["kiln_fps_set"] = True
    return ob


class _AtRest:
    """Puts the rig in its rest pose for edits and binds, keeping every attached object where it is."""

    def __enter__(self):
        _object_mode()
        self.rig = armature()
        self.prev = self.rig.data.pose_position
        self.rig.data.pose_position = "REST"
        bpy.context.view_layer.update()
        self.kids = [(o, o.matrix_world.copy()) for o in bpy.data.objects if o.parent == self.rig]
        return self.rig

    def __exit__(self, *exc):
        _object_mode()
        bpy.context.view_layer.update()
        for o, mw in self.kids:
            try:
                _keep_world(o, mw)
            except ReferenceError:  # removed inside the block
                pass
        self.rig.data.pose_position = self.prev
        bpy.context.view_layer.update()


def _bone_parent_matrix(rig, bone_name):
    """World matrix a bone-parented object is relative to (the bone's tail, in the current pose)."""
    pb = rig.pose.bones[bone_name]
    return rig.matrix_world @ pb.matrix @ Matrix.Translation((0, rig.data.bones[bone_name].length, 0))


def _keep_world(o, mw):
    if o.parent_type == "BONE" and o.parent_bone and o.parent and o.parent_bone in o.parent.data.bones:
        o.matrix_parent_inverse = _bone_parent_matrix(o.parent, o.parent_bone).inverted()
    elif o.parent is not None:
        o.matrix_parent_inverse = o.parent.matrix_world.inverted()
    o.matrix_basis = mw


class _Edit(_AtRest):
    """Edit mode on the rig (bones can only be added or moved there)."""

    def __enter__(self):
        rig = super().__enter__()
        vl = bpy.context.view_layer
        self.active = vl.objects.active
        rig.hide_set(False)
        rig.hide_viewport = False
        rig.hide_select = False
        vl.objects.active = rig
        bpy.ops.object.mode_set(mode="EDIT")
        return rig.data.edit_bones

    def __exit__(self, *exc):
        bpy.ops.object.mode_set(mode="OBJECT")
        try:
            bpy.context.view_layer.objects.active = self.active
        except Exception:  # noqa: BLE001
            pass
        super().__exit__(*exc)


def _valid(name):
    if not _NAME_RE.match(name):
        fixed = re.sub(r"[^A-Za-z0-9_]", "_", name)
        if not fixed[:1].isalpha():
            fixed = "J" + fixed
        print(f"kiln.rig: joint {name!r} renamed {fixed!r} (Roblox names: letters, digits, underscore)")
        return fixed
    return name


def _roll(eb, axis):
    """Turns the bone so its local X is the hinge axis (Blender's IK then bends it about that axis)."""
    d = eb.tail - eb.head
    if d.length < 1e-6:
        return
    z = Vector(axis).normalized().cross(d.normalized())
    if z.length > 1e-3:
        eb.align_roll(z)


def joint(name, at, parent=None, kind="hinge", axis=(1, 0, 0), limits=None, tail=None):
    """A joint at `at` (x, y, z): a bone of the rig. parent: the parent joint's name (None for the root).
    kind: "hinge" (rotates about `axis`, a world direction; limits=(min_deg, max_deg)), "ball"
    (limits=((min x, y, z), (max x, y, z)) degrees about the world axes) or "fixed". tail: where the
    bone ends (default: toward its first child, else a short stub); give it for a limb's last joint so
    the bone runs along its segment. Names: letters, digits, underscore (they become Roblox names).
    Returns the joint's name."""
    name = _valid(name)
    at = Vector(at)
    moved = False
    with _Edit() as eb:
        had = eb.get(name)
        was = (had.head.copy(), had.tail.copy(), had.roll) if had is not None else None
        b = had or eb.new(name)
        b.head = at
        auto = tail is None
        p = None
        if parent:
            p = eb.get(parent)
            if p is None:
                raise ValueError("no joint named %r (make the parent joint first)" % parent)
            b.parent = p
            b.use_connect = False
            # A parent with an automatic tail points at its first child.
            if p.get("kiln_auto_tail", True) and not p.get("kiln_has_child") and (at - p.head).length > 1e-4:
                p.tail = at.copy()
                p["kiln_has_child"] = True
                _roll(p, Vector(p.get("kiln_axis_w", (1, 0, 0))))
        if auto:
            if p is not None and (at - p.head).length > 1e-4:
                d = (at - p.head).normalized() * max(0.05, (at - p.head).length * 0.5)
            else:
                d = Vector((0, 0, -0.1)) if p is None else Vector((0, 0, -0.1))
            b.tail = at + d
        else:
            b.tail = Vector(tail)
            if (b.tail - b.head).length < 1e-4:
                b.tail = at + Vector((0, 0, -0.05))
        b["kiln_auto_tail"] = auto
        b["kiln_axis_w"] = list(Vector(axis).normalized())
        _roll(b, axis)
        moved = was is not None and ((b.head - was[0]).length > 1e-4 or (b.tail - was[1]).length > 1e-4 or abs(b.roll - was[2]) > 1e-3)
    if moved:
        _clips_note(name)
    rig = armature()
    bone = rig.data.bones[name]
    bone["kiln_kind"] = kind
    bone["kiln_axis"] = list(Vector(axis).normalized())
    if limits is not None:
        bone["kiln_limits"] = json.dumps(limits)
    elif "kiln_limits" in bone:
        del bone["kiln_limits"]
    pb = rig.pose.bones[name]
    pb.rotation_mode = "QUATERNION"
    pb.lock_ik_x = pb.lock_ik_y = pb.lock_ik_z = False
    if kind == "hinge":
        pb.lock_ik_y = pb.lock_ik_z = True
        if limits is not None:
            pb.use_ik_limit_x = True
            pb.ik_min_x, pb.ik_max_x = sorted(math.radians(v) for v in limits)
    elif kind == "fixed":
        pb.lock_ik_x = pb.lock_ik_y = pb.lock_ik_z = True
    return name


def _clips_note(name):
    """Clips store rotations from the rest pose: moving a joint afterwards changes how every clip plays."""
    try:
        import kiln_anim
        have = kiln_anim.clips()
    except Exception:  # noqa: BLE001
        return
    if not have:
        return
    made = [c["name"] for c in have if c.get("generator")]
    keyed = [c["name"] for c in have if not c.get("generator")]
    print('Note: joint "%s" moved after clips were made. Their keys are rotations from the old rest pose, so they now play differently.%s%s' % (
        name,
        " Make these again with kiln.anim.regenerate: %s." % ", ".join(made[:8]) if made else "",
        " Hand-keyed, look at them again (kiln.anim.check, a contact sheet): %s." % ", ".join(keyed[:8]) if keyed else ""))


def bind(objs, joint_name):
    """Make meshes move rigidly with a joint (they become that joint's segment; world placement kept).
    Use it for mechanical parts, armour, claws, props; use skin() for flesh that should bend."""
    rig = armature(False)
    if rig is None or joint_name not in rig.data.bones:
        raise ValueError("no joint named %r" % joint_name)
    objs = objs if isinstance(objs, (list, tuple)) else [objs]
    with _AtRest() as rig:
        pm = _bone_parent_matrix(rig, joint_name)
        for o in objs:
            if o is None:
                continue
            mw = o.matrix_world.copy()
            for m in [m for m in o.modifiers if m.type == "ARMATURE"]:
                o.modifiers.remove(m)
            o.parent = rig
            o.parent_type = "BONE"
            o.parent_bone = joint_name
            o.matrix_parent_inverse = pm.inverted()
            o.matrix_basis = mw
            o["kiln_segment"] = joint_name
            if "kiln_skinned" in o:
                del o["kiln_skinned"]
    return joint_name


def _segment_dist(P, a, b):
    """Distances from points P (n, 3) to the segment a-b."""
    ab = b - a
    L2 = float(ab @ ab) or 1e-12
    t = np.clip(((P - a) @ ab) / L2, 0.0, 1.0)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def skin(obj, joints=None, influences=4, smooth=2, sharpness=4.0):
    """Make a mesh bend with the rig (a flesh body, a tail, a trunk, cloth): every vertex follows up to
    `influences` (max 4, Roblox's limit) nearby joints, blended by distance to each bone and smoothed
    along the surface. joints: the joints it may follow (default: all). The mesh is parented to the rig
    and gets an Armature modifier; its shape stays where it is."""
    rig = armature(False)
    if rig is None:
        raise ValueError("no rig yet: make joints first")
    names = [n for n in (joints or [b.name for b in rig.data.bones]) if n in rig.data.bones]
    if not names:
        raise ValueError("no joints to skin to")
    influences = max(1, min(4, int(influences)))
    with _AtRest() as rig:
        me = obj.data
        n = len(me.vertices)
        co = np.empty(n * 3)
        me.vertices.foreach_get("co", co)
        mw = np.array(obj.matrix_world)
        P = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
        rw = rig.matrix_world
        D = np.empty((n, len(names)))
        for i, bn in enumerate(names):
            b = rig.data.bones[bn]
            D[:, i] = _segment_dist(P, np.array(rw @ b.head_local), np.array(rw @ b.tail_local))
        scale = max(1e-4, float(np.median(D.min(axis=1))) or 0.05)
        W = 1.0 / np.power(D / scale + 0.05, sharpness)
        if smooth:
            e = np.empty(len(me.edges) * 2, dtype=np.int64)
            me.edges.foreach_get("vertices", e)
            e = e.reshape(-1, 2)
            for _ in range(int(smooth)):
                acc = np.zeros_like(W)
                cnt = np.zeros(n)
                np.add.at(acc, e[:, 0], W[e[:, 1]])
                np.add.at(acc, e[:, 1], W[e[:, 0]])
                np.add.at(cnt, e[:, 0], 1)
                np.add.at(cnt, e[:, 1], 1)
                nb = acc / np.maximum(cnt, 1)[:, None]
                W = 0.5 * W / np.maximum(W.sum(1, keepdims=True), 1e-12) + 0.5 * nb / np.maximum(nb.sum(1, keepdims=True), 1e-12)
        # Keep the strongest `influences`, normalized.
        if len(names) > influences:
            cut = np.argpartition(-W, influences - 1, axis=1)[:, :influences]
            keep = np.zeros_like(W, dtype=bool)
            np.put_along_axis(keep, cut, True, axis=1)
            W = np.where(keep, W, 0.0)
        W = W / np.maximum(W.sum(1, keepdims=True), 1e-12)
        for vg in list(obj.vertex_groups):
            if vg.name in rig.data.bones:
                obj.vertex_groups.remove(vg)
        q = np.round(W * 255).astype(int)
        # Each vertex's weights sum to exactly 255/255: the rounding error goes to its strongest joint.
        rows = np.arange(n)
        q[rows, np.argmax(q, axis=1)] += 255 - q.sum(axis=1)
        for i, bn in enumerate(names):
            col = q[:, i]
            if not col.any():
                continue
            vg = obj.vertex_groups.new(name=bn)
            for level in np.unique(col[col > 0]):
                vg.add(np.nonzero(col == level)[0].tolist(), float(level) / 255.0, "REPLACE")
        mods = [m for m in obj.modifiers if m.type == "ARMATURE"]
        mod = mods[0] if mods else obj.modifiers.new("Rig", "ARMATURE")
        mod.object = rig
        mod.use_vertex_groups = True
        mod.use_bone_envelopes = False
        i = obj.modifiers.find(mod.name)
        if i > 0:
            obj.modifiers.move(i, 0)  # deform first, before any other modifier
        mwo = obj.matrix_world.copy()
        obj.parent = rig
        obj.parent_type = "OBJECT"
        obj.matrix_parent_inverse = rig.matrix_world.inverted()
        obj.matrix_basis = mwo
        obj["kiln_skinned"] = True
        if "kiln_segment" in obj:
            del obj["kiln_segment"]
    return obj


def remove(joint_name, meshes=True):
    """Removes a joint and every joint under it. meshes=True also deletes the parts that move with them
    (else they stay where they are, no longer attached). Their keys in every clip, their skin weights,
    legs and IK go too. Returns the removed joint names."""
    rig = armature(False)
    if rig is None or joint_name not in rig.data.bones:
        raise ValueError("no joint named %r" % joint_name)
    names = [joint_name]
    stack = [rig.data.bones[joint_name]]
    while stack:
        b = stack.pop()
        for c in b.children:
            names.append(c.name)
            stack.append(c)
    gone = set(names)

    def drop(o):
        for c in list(o.children):
            drop(c)
        bpy.data.objects.remove(o, do_unlink=True)

    for o in list(bpy.data.objects):
        try:
            if o.parent == rig and o.parent_type == "BONE" and o.parent_bone in gone:
                if meshes or o.get("kiln_attach"):
                    drop(o)
                else:
                    mw = o.matrix_world.copy()
                    o.parent = None
                    o.matrix_world = mw
                    if "kiln_segment" in o:
                        del o["kiln_segment"]
        except ReferenceError:
            continue
    for o in bpy.data.objects:
        if o.type == "MESH" and o.parent == rig:
            for g in [g for g in o.vertex_groups if g.name in gone]:
                o.vertex_groups.remove(g)
    for n in names:
        t = bpy.data.objects.get("IK_" + n)
        if t is not None:
            bpy.data.objects.remove(t, do_unlink=True)
        pt = bpy.data.objects.get("Pole_" + n)
        if pt is not None:
            bpy.data.objects.remove(pt, do_unlink=True)
    with _Edit() as eb:
        for n in reversed(names):
            if n in eb:
                eb.remove(eb[n])
    try:
        import kiln_anim as anim
        for act in bpy.data.actions:
            if "kiln_clip" not in act:
                continue
            bag = anim._bag(act, rig)
            for fc in list(bag.fcurves):
                if any(f'pose.bones["{n}"]' in fc.data_path for n in gone):
                    bag.fcurves.remove(fc)
    except Exception:  # noqa: BLE001
        pass
    data = json.loads(bpy.context.scene.get("kiln_rig", "{}"))
    data["ik"] = [x for x in data.get("ik", []) if x.get("end") not in gone]
    bpy.context.scene["kiln_rig"] = json.dumps(data)
    _clean_legs()
    return names


def leg(joints, foot=None):
    """Record a leg: its joints from hip to ankle (hip first) and the foot joint. Gaits plant the tip of
    the last joint's bone (its tail) on the ground. Recording a leg again from the same hip replaces it."""
    _clean_legs({"joints": list(joints), "foot": foot or joints[-1]})


def _clean_legs(add=None):
    """The recorded legs without stale ones (joints deleted, or recorded again from the same hip)."""
    sc = bpy.context.scene
    data = json.loads(sc.get("kiln_rig", "{}"))
    legs = data.get("legs", []) + ([add] if add else [])
    names = set(joints())
    kept = {}
    for lg in legs:
        if lg.get("joints") and all(n in names for n in lg["joints"]):
            kept[lg["joints"][0]] = lg
    data["legs"] = list(kept.values())
    sc["kiln_rig"] = json.dumps(data)
    return data["legs"]


def attach(name, joint_name, at):
    """An attachment point on a joint: a hitbox centre, a weapon grip, a stinger tip, a VFX socket
    (becomes a Roblox Attachment)."""
    rig = armature(False)
    if rig is None or joint_name not in rig.data.bones:
        raise ValueError("no joint named %r" % joint_name)
    ob = bpy.data.objects.get("A_" + name) or bpy.data.objects.new("A_" + name, None)
    if ob.name not in _rig_coll().objects:
        _k().link(ob, _rig_coll())
    ob.empty_display_type = "PLAIN_AXES"
    ob.empty_display_size = 0.04
    ob["kiln_attach"] = name
    with _AtRest() as rig:
        pm = _bone_parent_matrix(rig, joint_name)
        ob.parent = rig
        ob.parent_type = "BONE"
        ob.parent_bone = joint_name
        ob.matrix_parent_inverse = pm.inverted()
        ob.matrix_basis = Matrix.Translation(Vector(at))
    return ob


def joints():
    """The joint names (the rig's bones), parents before children."""
    rig = armature(False)
    if rig is None:
        return []
    out, seen = [], set()

    def walk(b):
        if b.name not in seen:
            seen.add(b.name)
            out.append(b.name)
            for c in b.children:
                walk(c)

    for b in rig.data.bones:
        if b.parent is None:
            walk(b)
    return out


def ik(end, chain=2, target=None, pole=None):
    """Blender IK on a limb, for poses you want to place by the tip: `end` is the last joint of the chain,
    `chain` how many joints bend. Adds a target empty "IK_<end>" at the chain's tip (or at `target`) and,
    with pole=(x, y, z), a pole empty the middle joint bends toward. Move or key the empties, then bake
    the clip (kiln.anim.bake) so it exports as ordinary keys. Hinge joints only bend about their axis."""
    rig = armature(False)
    if rig is None or end not in rig.data.bones:
        raise ValueError("no joint named %r" % end)
    pb = rig.pose.bones[end]
    for c in [c for c in pb.constraints if c.type == "IK"]:
        pb.constraints.remove(c)
    tip = rig.matrix_world @ rig.data.bones[end].tail_local
    t = bpy.data.objects.get("IK_" + end) or bpy.data.objects.new("IK_" + end, None)
    if t.name not in _rig_coll().objects:
        _k().link(t, _rig_coll())
    t.empty_display_type = "SPHERE"
    t.empty_display_size = 0.06
    t.location = Vector(target) if target is not None else tip
    c = pb.constraints.new("IK")
    c.target = t
    c.chain_count = int(chain)
    c.use_tail = True
    if pole is not None:
        pt = bpy.data.objects.get("Pole_" + end) or bpy.data.objects.new("Pole_" + end, None)
        if pt.name not in _rig_coll().objects:
            _k().link(pt, _rig_coll())
        pt.empty_display_type = "CONE"
        pt.empty_display_size = 0.05
        pt.location = Vector(pole)
        c.pole_target = pt
        # Pick the pole angle that bends the middle joint toward the pole.
        bones = [pb]
        while len(bones) < int(chain) and bones[-1].parent is not None:
            bones.append(bones[-1].parent)
        mid = bones[(len(bones) - 1) // 2]
        best = None
        for ang in (-90, 90, 0, 180):
            c.pole_angle = math.radians(ang)
            bpy.context.view_layer.update()
            knee = rig.matrix_world @ mid.head
            d = (knee - Vector(pole)).length
            if best is None or d < best[0]:
                best = (d, ang)
        c.pole_angle = math.radians(best[1])
    data = json.loads(bpy.context.scene.get("kiln_rig", "{}"))
    data["ik"] = [x for x in data.get("ik", []) if x.get("end") != end] + [{"end": end, "chain": int(chain), "target": t.name, "pole": ("Pole_" + end) if pole is not None else None}]
    bpy.context.scene["kiln_rig"] = json.dumps(data)
    return t


def set_forward(direction=(0, -1, 0)):
    """Which way the creature faces (default -Y, the front view; Roblox's forward after export)."""
    data = json.loads(bpy.context.scene.get("kiln_rig", "{}"))
    data["forward"] = list(Vector(direction).normalized())
    bpy.context.scene["kiln_rig"] = json.dumps(data)


def forward():
    return Vector(json.loads(bpy.context.scene.get("kiln_rig", "{}")).get("forward", (0, -1, 0)))


def _r4(m):
    return [[round(v, 5) for v in row] for row in m]


def info():
    """The rig as data (Blender world space, the project's units): joints with pivots, rest matrices,
    kinds, axes and limits; rigid segments per joint; skinned meshes; legs; IK chains; attachments."""
    rig = armature(False)
    if rig is None:
        return {"rig": None, "joints": [], "segments": {}, "skinned": [], "legs": [], "ik": [], "attachments": [], "forward": list(forward())}
    rw = rig.matrix_world
    js = []
    for n in joints():
        b = rig.data.bones[n]
        js.append({
            "name": n,
            "parent": b.parent.name if b.parent else None,
            "kind": b.get("kiln_kind", "ball"),
            "axis": [round(v, 4) for v in b.get("kiln_axis", (1, 0, 0))],
            "limits": json.loads(b["kiln_limits"]) if b.get("kiln_limits") else None,
            "pivot": [round(v, 5) for v in rw @ b.head_local],
            "tail": [round(v, 5) for v in rw @ b.tail_local],
            "rest": _r4(rw @ b.matrix_local),
        })
    segs, skinned = {}, []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or o.parent != rig:
            continue
        if o.parent_type == "BONE" and o.parent_bone:
            segs.setdefault(o.parent_bone, []).append(o.name)
        elif any(m.type == "ARMATURE" for m in o.modifiers):
            skinned.append({"mesh": o.name, "joints": [g.name for g in o.vertex_groups if g.name in rig.data.bones]})
    # Meshes bound under another bound mesh (spikes on a body) move with that segment.
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and o.parent and o.parent != rig and o.parent.get("kiln_segment"):
            segs.setdefault(o.parent["kiln_segment"], []).append(o.name)
    data = json.loads(bpy.context.scene.get("kiln_rig", "{}"))
    return {
        "rig": rig.name,
        "joints": js,
        "segments": segs,
        "skinned": skinned,
        "legs": _clean_legs(),
        "ik": data.get("ik", []),
        "attachments": [{"name": o["kiln_attach"], "joint": o.parent_bone if o.parent == rig else None, "position": [round(v, 5) for v in o.matrix_world.translation]}
                        for o in bpy.data.objects if o.get("kiln_attach")],
        "forward": list(forward()),
    }


def world_to_basis(joint_name, rot=None, loc=None):
    """Converts a world-aligned rotation (Quaternion) / offset (Vector) of a joint relative to its rest
    into its bone's pose values (rotation_quaternion, location)."""
    rig = armature(False)
    r0 = rig.data.bones[joint_name].matrix_local.to_quaternion()
    q = (r0.inverted() @ rot @ r0) if rot is not None else None
    l = (r0.inverted() @ Vector(loc)) if loc is not None else None
    return q, l


def _limits(bone):
    lim = json.loads(bone["kiln_limits"]) if bone.get("kiln_limits") else None
    kind = bone.get("kiln_kind", "ball")
    if kind == "hinge":
        return (lim or (-30, 30)), kind
    if kind == "ball":
        return (lim or ((-20, -20, -20), (20, 20, 20))), kind
    return None, kind


def pose_test(step=6):
    """A temporary clip that swings every joint to its limits: rest, minimum, maximum, rest (frames 1,
    1+step, 1+2*step, 1+3*step). Render those frames (render_view frames=[...], or render_motion) to catch
    parts passing through each other or tearing apart, then kiln.rig.pose_clear()."""
    import kiln_anim as anim
    rig = armature(False)
    if rig is None:
        raise ValueError("no rig yet")
    _clean_legs()
    frames = [1, 1 + step, 1 + 2 * step, 1 + 3 * step]
    prev = rig.animation_data.action.name if rig.animation_data and rig.animation_data.action else None
    bpy.context.scene["kiln_pose_prev"] = json.dumps({"action": prev, "range": [bpy.context.scene.frame_start, bpy.context.scene.frame_end]})
    anim.clip("_PoseTest", length=(frames[-1] - 1) / FPS, loop=True)
    for bn in joints():
        b = rig.data.bones[bn]
        lim, kind = _limits(b)
        if lim is None:
            continue
        if kind == "hinge":
            ax = Vector(b.get("kiln_axis", (1, 0, 0)))
            poses = [Quaternion(ax, math.radians(lim[0])), Quaternion(ax, math.radians(lim[1]))]
        else:
            from mathutils import Euler
            poses = [Euler([math.radians(a) for a in lim[0]]).to_quaternion(), Euler([math.radians(a) for a in lim[1]]).to_quaternion()]
        for f, q in zip(frames, [Quaternion(), poses[0], poses[1], Quaternion()]):
            anim.key("_PoseTest", bn, f, rot=q)
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = frames[0], frames[-1]
    return frames


def pose_clear():
    """Removes the pose test clip and puts the rig back as it was."""
    rig = armature(False)
    act = bpy.data.actions.get("_PoseTest")
    if act is not None:
        bpy.data.actions.remove(act)
    sc = bpy.context.scene
    prev = json.loads(sc.get("kiln_pose_prev", "{}"))
    if rig is not None and prev.get("action") and bpy.data.actions.get(prev["action"]):
        import kiln_anim as anim
        anim.use(prev["action"])
    if prev.get("range"):
        sc.frame_start, sc.frame_end = prev["range"]
    if "kiln_pose_prev" in sc:
        del sc["kiln_pose_prev"]
    if rig is not None:
        for pb in rig.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
    sc.frame_set(sc.frame_start)


def check():
    """Problems that would break animation or the Roblox export: invalid names, meshes not attached to
    the rig (they would hang in place while it moves), hinges whose axis doesn't suit their limb, skinned
    meshes over 4 influences, a moved or scaled rig, very many joints."""
    rig = armature(False)
    if rig is None:
        return {"ok": True, "issues": [], "joints": 0}
    issues = []
    names = joints()
    for n in names:
        if not _NAME_RE.match(n):
            issues.append(f"joint {n}: not a valid Roblox name (letters, digits, underscore)")
    if len(names) > 50:
        issues.append(f"{len(names)} joints: over ~50 makes heavy Roblox animations; merge small joints")
    if rig.matrix_world != Matrix.Identity(4):
        issues.append("the Rig object is moved, rotated or scaled: keep it at the origin (move the root joint instead)")
    loose = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or o.name.startswith("_") or not o.visible_get():
            continue
        p = o
        attached = False
        while p is not None:
            if p == rig or p.get("kiln_segment") or p.get("kiln_skinned"):
                attached = True
                break
            p = p.parent
        if not attached and not o.get("kiln_static"):
            loose.append(o.name)
    if loose:
        issues.append(f"{len(loose)} mesh(es) not attached to the rig (they stay behind when it moves; bind or skin them, or mark scenery with obj['kiln_static'] = True): {', '.join(loose[:12])}")
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and o.parent == rig and any(m.type == "ARMATURE" for m in o.modifiers):
            groups = {g.index for g in o.vertex_groups if g.name in rig.data.bones}
            over = sum(1 for v in o.data.vertices if sum(1 for g in v.groups if g.group in groups and g.weight > 0) > 4)
            if over:
                issues.append(f"{o.name}: {over} vertices follow more than 4 joints (Roblox allows 4; re-run kiln.rig.skin)")
    for n in names:
        b = rig.data.bones[n]
        if b.get("kiln_kind") != "hinge":
            continue
        ax = Vector(b.get("kiln_axis", (1, 0, 0)))
        d = (b.tail_local - b.head_local)
        if d.length > 1e-6 and abs(ax.dot(d.normalized())) > 0.5:
            issues.append(f"hinge {n}: its axis runs along the limb, so it would twist instead of bend (use an axis across the limb)")
        # Limits should allow bending further the way the limb is already bent at rest.
        lim = json.loads(b["kiln_limits"]) if b.get("kiln_limits") else None
        if b.parent is not None and lim and not isinstance(lim[0], (list, tuple)) and d.length > 1e-6:
            dp = b.head_local - b.parent.head_local
            bend = dp.normalized().cross(d.normalized()) if dp.length > 1e-6 else Vector()
            if bend.length > 0.15:
                sgn = 1 if bend.dot(ax) > 0 else -1
                lo, hi = min(lim), max(lim)
                if (sgn > 0 and hi < 15) or (sgn < 0 and lo > -15):
                    issues.append(f"hinge {n}: bent the other way at rest than its limits {list(lim)} allow (flip the limits' signs, or the axis)")
    return {"ok": not issues, "issues": issues, "joints": len(names)}


# ------------------------------------------------------------------------------------------------
# R15 (Roblox's standard character rig), for player animations
# ------------------------------------------------------------------------------------------------

_R15 = [
    # name, pivot (studs, Blender: facing -Y, right at -X, feet at z=0), parent, kind, axis, limits
    ("HumanoidRootPart", (0, 0, 3.192), None, "fixed", (1, 0, 0), None),
    ("LowerTorso", (0, 0, 2.192), "HumanoidRootPart", "ball", (1, 0, 0), ((-40, -20, -45), (40, 20, 45))),
    ("UpperTorso", (0, 0, 2.592), "LowerTorso", "ball", (1, 0, 0), ((-35, -25, -40), (35, 25, 40))),
    ("Head", (0, 0, 4.29), "UpperTorso", "ball", (1, 0, 0), ((-40, -30, -70), (40, 30, 70))),
    ("RightUpperArm", (-0.972, 0, 4.039), "UpperTorso", "ball", (1, 0, 0), ((-170, -80, -90), (80, 80, 170))),
    ("RightLowerArm", (-1.473, 0, 3.265), "RightUpperArm", "hinge", (1, 0, 0), (-150, 0)),
    ("RightHand", (-1.473, 0, 2.458), "RightLowerArm", "ball", (1, 0, 0), ((-60, -30, -40), (60, 30, 40))),
    ("LeftUpperArm", (0.972, 0, 4.039), "UpperTorso", "ball", (1, 0, 0), ((-170, -80, -170), (80, 80, 90))),
    ("LeftLowerArm", (1.473, 0, 3.265), "LeftUpperArm", "hinge", (1, 0, 0), (-150, 0)),
    ("LeftHand", (1.473, 0, 2.458), "LeftLowerArm", "ball", (1, 0, 0), ((-60, -30, -40), (60, 30, 40))),
    ("RightUpperLeg", (-0.5, 0, 2.192), "LowerTorso", "ball", (1, 0, 0), ((-110, -30, -45), (45, 30, 20))),
    ("RightLowerLeg", (-0.5, 0, 1.272), "RightUpperLeg", "hinge", (1, 0, 0), (0, 150)),
    ("RightFoot", (-0.5, 0, 0.263), "RightLowerLeg", "ball", (1, 0, 0), ((-45, -15, -20), (45, 15, 20))),
    ("LeftUpperLeg", (0.5, 0, 2.192), "LowerTorso", "ball", (1, 0, 0), ((-110, -30, -20), (45, 30, 45))),
    ("LeftLowerLeg", (0.5, 0, 1.272), "LeftUpperLeg", "hinge", (1, 0, 0), (0, 150)),
    ("LeftFoot", (0.5, 0, 0.263), "LeftLowerLeg", "ball", (1, 0, 0), ((-45, -15, -20), (45, 15, 20))),
]
# R15 part boxes as measured on a default R15 in Roblox Studio (studs, Blender axes: front -Y, the
# character's right at -X, ground at z = 0): name -> (size x, y, z), centre.
_R15_PARTS = {
    "Head": ((1.159, 1.161, 1.182), (0, 0, 4.866)),
    "UpperTorso": ((1.943, 1.004, 1.698), (0, 0, 3.441)),
    "LowerTorso": ((1.991, 1.004, 0.401), (0, 0, 2.392)),
    "LeftUpperArm": ((1.001, 1.002, 1.242), (1.472, 0, 3.62)), "RightUpperArm": ((1.001, 1.002, 1.242), (-1.472, 0, 3.62)),
    "LeftLowerArm": ((1.001, 1.002, 1.118), (1.472, 0, 2.99)), "RightLowerArm": ((1.001, 1.002, 1.118), (-1.472, 0, 2.99)),
    "LeftHand": ((0.984, 1.028, 0.316), (1.472, 0, 2.327)), "RightHand": ((0.984, 1.028, 0.316), (-1.472, 0, 2.327)),
    "LeftUpperLeg": ((0.993, 0.973, 1.363), (0.5, 0, 1.721)), "RightUpperLeg": ((0.993, 0.973, 1.363), (-0.5, 0, 1.721)),
    "LeftLowerLeg": ((0.993, 0.973, 1.301), (0.5, 0, 0.859)), "RightLowerLeg": ((0.993, 0.973, 1.301), (-0.5, 0, 0.859)),
    "LeftFoot": ((1.009, 1.001, 0.312), (0.5, 0, 0.156)), "RightFoot": ((1.009, 1.001, 0.312), (-0.5, 0, 0.156)),
}


def r15(parts=True, units=None):
    """Roblox's standard R15 character rig (joint names, pivots and parents of the default avatar),
    facing -Y, for player animations (combos, emotes, abilities): Shuriken exports its clips as R15
    animations. parts=True adds plain blocky parts so you can see the poses. units: "studs" (projects
    linked to Roblox are in studs) or "m" (scaled by 0.28); default: the project's units."""
    u = units or bpy.context.scene.get("kiln_units", "m")
    s = 1.0 if u == "studs" else 0.28
    tails = {"Head": (0, 0, 5.3), "RightHand": (-1.473, 0, 2.05), "LeftHand": (1.473, 0, 2.05),
             "RightFoot": (-0.5, -0.75, 0.0), "LeftFoot": (0.5, -0.75, 0.0), "HumanoidRootPart": (0, -0.5, 3.192)}
    for name, piv, parent, kind, axis, lim in _R15:
        t = tails.get(name)
        joint(name, tuple(v * s for v in piv), parent=parent, kind=kind, axis=axis, limits=lim,
              tail=tuple(v * s for v in t) if t else None)
    leg(["RightUpperLeg", "RightLowerLeg", "RightFoot"], foot="RightFoot")
    leg(["LeftUpperLeg", "LeftLowerLeg", "LeftFoot"], foot="LeftFoot")
    set_forward((0, -1, 0))
    if parts:
        import bmesh
        mat = _k().mat("R15_Grey", "#a3a2a5", roughness=0.6)
        for name, (size, centre) in _R15_PARTS.items():
            bm = bmesh.new()
            bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(Vector(centre) * s) @ Matrix.Diagonal((*[v * s for v in size], 1)))
            ob = _k().mesh_object(name + "_Part", bm)
            _k().paint(ob, mat)
            bind([ob], name)
    return joints()


# ------------------------------------------------------------------------------------------------
# Upgrading rigs made of joint empties (Kiln 0.5-0.6) to the armature
# ------------------------------------------------------------------------------------------------

def upgrade():
    """Converts a rig of joint empties (J_<name>, from Kiln 0.5-0.6) into the armature, keeping joint names,
    segments, legs and attachments. Their animation becomes clips: one per timeline marker range (named
    after the markers), else one clip "Legacy". Returns the clip names."""
    import kiln_anim as anim
    empties = [o for o in bpy.data.objects if o.type == "EMPTY" and o.get("kiln_joint")]
    if not empties:
        return []
    sc = bpy.context.scene
    by = {o["kiln_joint"]: o for o in empties}
    animated = [o for o in empties if o.animation_data and o.animation_data.action]
    # Rest: rotations zero, locations as keyed at the scene start (the empties' own values).
    f0, f1 = sc.frame_start, sc.frame_end
    samples = {}
    if animated:
        for f in range(f0, f1 + 1):
            sc.frame_set(f)
            samples[f] = {n: o.matrix_world.copy() for n, o in by.items()}
        sc.frame_set(f0)  # unkeyed values (the root's location) as at the start
    acts = {o.name: o.animation_data.action for o in animated}
    for o in animated:
        o.animation_data.action = None
    for o in empties:
        o.rotation_mode = "XYZ"
        o.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    rest = {n: o.matrix_world.copy() for n, o in by.items()}
    order, seen = [], set()

    def walk(n):
        if n in seen:
            return
        o = by[n]
        pn = o.parent.get("kiln_joint") if o.parent else None
        if pn in by:
            walk(pn)
        seen.add(n)
        order.append(n)

    for n in by:
        walk(n)
    kids = {n: [m for m in by if by[m].parent is by[n]] for n in by}
    attached = {n: [o for o in bpy.data.objects if o.parent is by[n] and not o.get("kiln_joint")] for n in by}
    for n in order:
        o = by[n]
        pn = o.parent.get("kiln_joint") if o.parent else None
        head = rest[n].translation
        tail = None
        if len(kids[n]) == 1:
            tail = rest[kids[n][0]].translation
        elif not kids[n]:
            meshes = [m for m in attached[n] if m.type == "MESH"]
            if meshes:
                pts = [m.matrix_world @ Vector(c) for m in meshes for c in m.bound_box]
                far = max(pts, key=lambda p: (p - head).length)
                tail = head + (far - head) * 0.9
        lim = json.loads(o["kiln_limits"]) if o.get("kiln_limits") else None
        joint(n, tuple(head), parent=pn if pn in by else None, kind=o.get("kiln_kind", "ball"),
              axis=tuple(o.get("kiln_axis", (1, 0, 0))), limits=lim, tail=tuple(tail) if tail is not None and (tail - head).length > 1e-4 else None)
    for n in order:
        rest_objs = [m for m in attached[n] if not m.get("kiln_attach")]
        for m in [m for m in attached[n] if m.get("kiln_attach")]:
            label, at = m["kiln_attach"], m.matrix_world.translation.copy()
            bpy.data.objects.remove(m, do_unlink=True)
            attach(label, n, at)
        if rest_objs:
            bind(rest_objs, n)
    clips = []
    if animated and samples:
        markers = sorted(((m.frame, m.name) for m in sc.timeline_markers if f0 <= m.frame <= f1), key=lambda x: x[0])
        ranges = []
        if markers:
            for i, (fr, nm) in enumerate(markers):
                end = markers[i + 1][0] - 1 if i + 1 < len(markers) else f1
                if end > fr:
                    ranges.append((_valid(nm), fr, end))
        else:
            ranges.append(("Legacy", f0, f1))
        R0 = {n: Matrix.Identity(4) for n in by}
        for name, a, b in ranges:
            anim.clip(name, length=(b - a) / FPS, loop=True)
            frames = list(range(a, b + 1))
            data = {}
            for n in order:
                o = by[n]
                pn = o.parent.get("kiln_joint") if o.parent else None
                seq = []
                for f in frames:
                    G = samples[f][n] @ rest[n].inverted()
                    Gp = (samples[f][pn] @ rest[pn].inverted()) if pn in by else Matrix.Identity(4)
                    rel = Gp.inverted() @ G
                    h = rest[n].translation
                    seq.append((rel.to_quaternion(), rel @ h - h))
                data[n] = seq
            anim.write(name, [f - a + 1 for f in frames], data)
            clips.append(name)
        for o in animated:
            o.animation_data_clear()
        for act in acts.values():
            if act and act.users == 0:
                bpy.data.actions.remove(act)
    for o in empties:
        bpy.data.objects.remove(o, do_unlink=True)
    _clean_legs()
    if clips:
        anim.use(clips[0])
    return clips
