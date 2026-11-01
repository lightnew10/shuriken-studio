"""
Animation (exposed through `kiln` as kiln.anim): clips on the rig (one Blender Action each, 30 fps),
keys, IK reaching, generators (gaits for any number of legs, idle, attacks, hit, death, waves),
secondary motion (physics chains for tails, cables, antennae, slime) and checks over time.

Clips are stored as baked keys on the rig's bones, so what Kiln shows is exactly what exports.
Rotations here are WORLD-ALIGNED and relative to the rest pose: "rotate the knee 40 degrees about the
world X axis", whatever the bone's own orientation. Creatures face -Y, up is +Z, right is -X.
"""

import json
import math
import random

import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

FPS = 30


def _rigmod():
    import kiln_rig
    return kiln_rig


def _rig():
    r = _rigmod().armature(False)
    if r is None:
        raise ValueError("no rig yet: make joints with kiln.rig.joint / kiln.limb(rig=True) / kiln.rig.r15() first")
    return r


def _units():
    return 0.28 if bpy.context.scene.get("kiln_units") == "studs" else 1.0


class _RestPose:
    """Measure meshes in the rig's rest pose, whatever clip or frame is showing."""

    def __init__(self, rig):
        self.rig = rig

    def __enter__(self):
        self.prev = self.rig.data.pose_position
        if self.prev != "REST":
            self.rig.data.pose_position = "REST"
            bpy.context.view_layer.update()
        return self.rig

    def __exit__(self, *exc):
        if self.prev != "REST":
            self.rig.data.pose_position = self.prev
            bpy.context.view_layer.update()


# ------------------------------------------------------------------------------------------------
# Clips
# ------------------------------------------------------------------------------------------------

_MOVES = ("walk", "run", "trot", "gallop", "crawl", "slither", "swim", "fly", "move", "strafe", "sprint", "jog", "climb", "gait")


def _default_priority(name):
    n = name.lower()
    if "idle" in n or "breath" in n:
        return "Idle"
    if any(w in n for w in _MOVES):
        return "Movement"
    return "Action"


def _meta(act):
    try:
        return json.loads(act.get("kiln_clip", "{}"))
    except Exception:  # noqa: BLE001
        return {}


def _set_meta(act, m):
    act["kiln_clip"] = json.dumps(m)


def _action(name):
    act = bpy.data.actions.get(name)
    if act is None or "kiln_clip" not in act:
        raise ValueError("no clip named %r (clips: %s)" % (name, ", ".join(c["name"] for c in clips()) or "none"))
    return act


def _slot(act, rig):
    if len(act.slots):
        return act.slots[0]
    return act.slots.new(id_type="OBJECT", name=rig.name)


def _bag(act, rig):
    from bpy_extras import anim_utils
    return anim_utils.action_ensure_channelbag_for_slot(act, _slot(act, rig))


def clip(name, length=1.0, loop=True, in_place=True, priority=None, speed=None, fade=0.2, keep=False):
    """Start a clip on the rig: a named animation (Walk, Run, Idle, Attack, Hit, Death...), `length` in
    seconds at 30 fps (frames 1 .. 1+30*length). loop: it repeats (the last frame equals the first).
    in_place: the body stays over the origin (the game moves the model; set `speed` for movement clips,
    in units per second, so the game matches it). priority: Roblox's "Idle", "Movement", "Action" or
    "Core" (default from the name). Replaces a clip of the same name unless keep=True."""
    rig = _rig()
    name = name if name.startswith("_") else _rigmod()._valid(name)
    act = bpy.data.actions.get(name)
    if act is not None and not keep:
        bag = _bag(act, rig)
        for fc in list(bag.fcurves):
            bag.fcurves.remove(fc)
        for mk in list(act.pose_markers):
            act.pose_markers.remove(mk)
    if act is None:
        act = bpy.data.actions.new(name)
    sc = bpy.context.scene
    if sc.render.fps != FPS or abs(sc.render.fps_base - 1.0) > 1e-6:
        sc.render.fps, sc.render.fps_base = FPS, 1.0  # clips are 30 fps: an imported scene may not be
    act.use_fake_user = True
    n = max(1, int(round(length * FPS)))
    act.use_frame_range = True
    act.frame_start, act.frame_end = 1, 1 + n
    m = _meta(act) if keep else {}
    m.update(loop=bool(loop), in_place=bool(in_place), priority=priority or m.get("priority") or _default_priority(name), fade=float(fade))
    if speed is not None:
        m["speed"] = round(float(speed), 4)
    _set_meta(act, m)
    _bag(act, rig)
    use(name)
    return act


def use(name):
    """Show a clip on the rig (the viewer, renders and render_motion use the rig's current clip)."""
    rig = _rig()
    act = _action(name)
    rig.animation_data_create()
    rig.animation_data.action = act
    try:
        rig.animation_data.action_slot = _slot(act, rig)
    except Exception:  # noqa: BLE001
        pass
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = int(act.frame_range[0]), int(act.frame_range[1])
    sc.frame_set(sc.frame_start)
    return act


def clips():
    """Every clip: name, frames [start, end], fps, seconds, loop, in_place, priority, speed, fade,
    markers [{name, frame, time}], generator (how it was made)."""
    out = []
    fps = FPS
    for act in bpy.data.actions:
        if "kiln_clip" not in act or act.name.startswith("_"):
            continue
        m = _meta(act)
        s, e = (int(round(v)) for v in act.frame_range)
        out.append({
            "name": act.name, "frames": [s, e], "fps": fps, "length": round((e - s) / fps, 4),
            "loop": m.get("loop", True), "in_place": m.get("in_place", True), "priority": m.get("priority", "Action"),
            "speed": m.get("speed"), "turn": m.get("turn") or 0.0, "fade": m.get("fade", 0.2),
            "markers": sorted(({"name": mk.name, "frame": mk.frame, "time": round((mk.frame - s) / fps, 4)} for mk in act.pose_markers), key=lambda x: x["frame"]),
            "generator": (m.get("generator") or {}).get("name"),
            "params": (m.get("generator") or {}).get("params"),
            "resolved": m.get("resolved"),
        })
    return sorted(out, key=lambda c: c["name"])


def delete(name):
    act = _action(name)
    rig = _rigmod().armature(False)
    if rig is not None and rig.animation_data and rig.animation_data.action == act:
        rig.animation_data.action = None
    bpy.data.actions.remove(act)


def rename(name, new):
    act = _action(name)
    act.name = _rigmod()._valid(new)
    return act.name


def settings(name, **kw):
    """Change a clip's loop, in_place, priority, speed or fade."""
    act = _action(name)
    m = _meta(act)
    for k in ("loop", "in_place", "priority", "speed", "fade"):
        if k in kw:
            m[k] = kw[k]
    _set_meta(act, m)
    return m


def event(name, label, frame=None, time=None):
    """A named moment in a clip for game code: "Hit" (damage lands), "Step_<leg>", "Dead", "Spawn_VFX".
    Give a frame, or a time in seconds from the clip's start. Becomes a Roblox KeyframeMarker."""
    act = _action(name)
    if frame is None:
        frame = act.frame_range[0] + float(time or 0) * FPS
    mk = act.pose_markers.new(label)
    mk.frame = int(round(frame))
    return mk


# ------------------------------------------------------------------------------------------------
# Keys
# ------------------------------------------------------------------------------------------------

_AXES = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1), "-x": (-1, 0, 0), "-y": (0, -1, 0), "-z": (0, 0, -1),
         "right": (-1, 0, 0), "left": (1, 0, 0), "up": (0, 0, 1), "down": (0, 0, -1), "forward": (0, -1, 0), "back": (0, 1, 0)}


def _axis(a):
    """An axis: a vector, or a name ("x", "-y", "z", or "right", "up", "forward"... for a model facing -Y)."""
    if isinstance(a, str):
        key = a.strip().lower()
        if key not in _AXES:
            raise ValueError(f"unknown axis {a!r}: use a vector or one of {', '.join(_AXES)}")
        return Vector(_AXES[key])
    return Vector(a).normalized()


def _q(rot):
    """A rotation from: a Quaternion, (w, x, y, z), euler degrees (x, y, z) about world axes, or
    (axis, degrees) where axis is a vector or a name ("x", "-z", "right", "up", "forward"...)."""
    if rot is None:
        return Quaternion()
    if isinstance(rot, Quaternion):
        return rot.copy()
    if isinstance(rot, Euler):
        return rot.to_quaternion()
    rot = list(rot)
    if len(rot) == 2:
        return Quaternion(_axis(rot[0]), math.radians(float(rot[1])))
    if len(rot) == 4:
        return Quaternion(rot)
    return Euler([math.radians(float(a)) for a in rot], "XYZ").to_quaternion()


def _fcurve(bag, path, index, group):
    fc = bag.fcurves.find(path, index=index)
    if fc is None:
        fc = bag.fcurves.new(path, index=index, group_name=group)
    return fc


def write(name, frames, data, clear=True):
    """Bulk keys: data = {joint: [(rotation, offset) per frame]}, world-aligned and rest-relative
    (offset: a Vector moving the joint's pivot, or None). Replaces those joints' keys in the clip."""
    rig = _rig()
    act = _action(name)
    bag = _bag(act, rig)
    frames = [float(f) for f in frames]
    for j, seq in data.items():
        if j not in rig.data.bones:
            continue
        pb = rig.pose.bones[j]
        pb.rotation_mode = "QUATERNION"
        r0 = rig.data.bones[j].matrix_local.to_quaternion()
        r0i = r0.inverted()
        qs, ls, prev = [], [], None
        any_loc = any(t is not None and Vector(t).length > 1e-7 for _, t in seq)
        for rot, t in seq:
            q = r0i @ _q(rot) @ r0
            if prev is not None and prev.dot(q) < 0:
                q.negate()
            qs.append(q)
            prev = q
            if any_loc:
                ls.append(r0i @ (Vector(t) if t is not None else Vector()))
        path = f'pose.bones["{j}"]'
        channels = [(path + ".rotation_quaternion", i, [q[i] for q in qs]) for i in range(4)]
        if any_loc:
            channels += [(path + ".location", i, [v[i] for v in ls]) for i in range(3)]
        elif clear:
            for i in range(3):
                fc = bag.fcurves.find(path + ".location", index=i)
                if fc is not None:
                    bag.fcurves.remove(fc)
        for p, i, vals in channels:
            fc = _fcurve(bag, p, i, j)
            fc.keyframe_points.clear()
            fc.keyframe_points.add(len(frames))
            co = np.empty(len(frames) * 2)
            co[0::2] = frames
            co[1::2] = vals
            fc.keyframe_points.foreach_set("co", co)
            fc.keyframe_points.foreach_set("interpolation", [1] * len(frames))  # LINEAR: baked every frame
            fc.update()
    return act


def key(name, joint, frame, rot=None, loc=None):
    """One key: `joint` rotated by `rot` (euler degrees about world axes, (axis, degrees), a Quaternion)
    and its pivot moved by `loc` (world offset) at `frame`, relative to rest. Keys in between are
    smoothed (Bezier). For whole poses use pose(); generators write every frame for you."""
    rig = _rig()
    act = _action(name)
    use(name)
    pb = rig.pose.bones[joint]
    pb.rotation_mode = "QUATERNION"
    q, l = _rigmod().world_to_basis(joint, _q(rot), Vector(loc) if loc is not None else None)
    pb.rotation_quaternion = q
    pb.keyframe_insert("rotation_quaternion", frame=frame, group=joint)
    if l is not None:
        pb.location = l
        pb.keyframe_insert("location", frame=frame, group=joint)
    return act


def pose(name, frame, joints, root=None):
    """A key pose: joints = {joint: rotation (euler degrees about world axes, or (axis, degrees))};
    root: (x, y, z) offset of the root joint. Use for hand-made key poses between generator passes."""
    for j, r in joints.items():
        key(name, j, frame, rot=r)
    if root is not None:
        m = _Model()
        key(name, m.root, frame, rot=read_at(name, m.root, frame)[0], loc=root)


def read_at(name, joint, frame):
    """(rotation, offset) of a joint at a frame, world-aligned and rest-relative."""
    rig = _rig()
    act = _action(name)
    bag = _bag(act, rig)
    path = f'pose.bones["{joint}"]'
    q = [1.0, 0.0, 0.0, 0.0]
    loc = [0.0, 0.0, 0.0]
    for i in range(4):
        fc = bag.fcurves.find(path + ".rotation_quaternion", index=i)
        if fc is not None:
            q[i] = fc.evaluate(frame)
    for i in range(3):
        fc = bag.fcurves.find(path + ".location", index=i)
        if fc is not None:
            loc[i] = fc.evaluate(frame)
    r0 = rig.data.bones[joint].matrix_local.to_quaternion()
    qq = Quaternion(q).normalized()
    return r0 @ qq @ r0.inverted(), r0 @ Vector(loc)


def read(name, frames=None):
    """{joint: [(rotation, offset) per frame]} for every joint of the rig (rest where not keyed)."""
    rig = _rig()
    act = _action(name)
    if frames is None:
        s, e = (int(round(v)) for v in act.frame_range)
        frames = list(range(s, e + 1))
    bag = _bag(act, rig)
    out = {}
    for b in rig.data.bones:
        path = f'pose.bones["{b.name}"]'
        qf = [bag.fcurves.find(path + ".rotation_quaternion", index=i) for i in range(4)]
        lf = [bag.fcurves.find(path + ".location", index=i) for i in range(3)]
        r0 = b.matrix_local.to_quaternion()
        r0i = r0.inverted()
        seq = []
        for f in frames:
            q = Quaternion([fc.evaluate(f) if fc else d for fc, d in zip(qf, (1.0, 0.0, 0.0, 0.0))]).normalized()
            loc = Vector([fc.evaluate(f) if fc else 0.0 for fc in lf])
            seq.append((r0 @ q @ r0i, r0 @ loc if any(lf) else None))
        out[b.name] = seq
    return out


def sample(name, fps=30):
    """The clip for export: {joint: [[qw, qx, qy, qz, tx, ty, tz] per sample]} at `fps`, every joint's
    rotation relative to its parent and rest in world-aligned axes at its pivot, and its pivot's offset
    (project units). This is exactly a Roblox Motor6D.Transform after the axis change (Shuriken does it)."""
    act = _action(name)
    s, e = act.frame_range
    scene_fps = bpy.context.scene.render.fps
    n = int(math.floor((e - s) / scene_fps * fps + 1e-6)) + 1
    frames = [s + k * scene_fps / fps for k in range(n)]
    data = read(name, frames)
    out = {}
    for j, seq in data.items():
        rows = []
        prev = None
        for q, t in seq:
            if prev is not None and prev.dot(q) < 0:
                q = -q
            prev = q
            t = t if t is not None else Vector()
            rows.append([round(q.w, 6), round(q.x, 6), round(q.y, 6), round(q.z, 6), round(t.x, 6), round(t.y, 6), round(t.z, 6)])
        out[j] = rows
    return out


# ------------------------------------------------------------------------------------------------
# The rig as a solvable model
# ------------------------------------------------------------------------------------------------

def _frame_rot(a0, b0, a1, b1):
    """The rotation taking the frame (a0, b0) to (a1, b1) (first vectors exactly, second as close as possible)."""
    def basis(a, b):
        e1 = a.normalized()
        e2 = b - e1 * b.dot(e1)
        if e2.length < 1e-9:
            e2 = e1.orthogonal()
        e2.normalize()
        return Matrix((e1, e2, e1.cross(e2))).transposed()
    return (basis(a1, b1) @ basis(a0, b0).transposed()).to_quaternion()


def _signed_angle(a, b, n):
    a = a - n * a.dot(n)
    b = b - n * b.dot(n)
    if a.length < 1e-12 or b.length < 1e-12:
        return 0.0
    return math.atan2(n.dot(a.cross(b)), a.dot(b))


class _Model:
    """The rig in world space at rest, with FK and leg IK."""

    def __init__(self):
        R = _rigmod()
        rig = _rig()
        self.rig = rig
        rw = rig.matrix_world
        bones = rig.data.bones
        self.names = R.joints()
        self.parent = {n: (bones[n].parent.name if bones[n].parent else None) for n in self.names}
        self.children = {n: [c.name for c in bones[n].children] for n in self.names}
        self.h0 = {n: rw @ bones[n].head_local for n in self.names}
        self.t0 = {n: rw @ bones[n].tail_local for n in self.names}
        self.kind = {n: bones[n].get("kiln_kind", "ball") for n in self.names}
        self.axis = {n: Vector(bones[n].get("kiln_axis", (1, 0, 0))).normalized() for n in self.names}
        self.limits = {n: (json.loads(bones[n]["kiln_limits"]) if bones[n].get("kiln_limits") else None) for n in self.names}
        self.fwd = R.forward().normalized()
        self.up = Vector((0, 0, 1))
        self.right = self.fwd.cross(self.up).normalized()
        self.unit = _units()
        self.legs = []
        for lg in R._clean_legs():
            js = [j for j in lg["joints"] if j in self.h0]
            if not js:
                continue
            last = js[-1]
            foot = None
            if len(js) >= 3:
                d = self.t0[last] - self.h0[last]
                if d.length > 1e-6 and abs(d.normalized().z) < 0.6:
                    foot = last
            chain = js[:-1] if foot else js
            tip0 = self.h0[foot] if foot else self.t0[last]
            toe0 = self.t0[last]
            leg = {"name": js[0], "joints": js, "chain": chain, "foot": foot, "tip0": tip0, "toe0": toe0}
            if len(chain) == 2:
                h, k = self.h0[chain[0]], self.h0[chain[1]]
                line = tip0 - h
                off = (k - h) - line.normalized() * (k - h).dot(line.normalized()) if line.length > 1e-9 else Vector()
                if off.length > 0.02 * max(line.length, 1e-6):
                    leg["pole0"] = off.normalized()
                elif abs(line.normalized().z) > 0.7:
                    leg["pole0"] = self.fwd.copy()
                else:
                    leg["pole0"] = self.up.copy()
            self.legs.append(leg)
        pts = [lg["toe0"] for lg in self.legs] + [lg["tip0"] for lg in self.legs]
        with _RestPose(rig):
            mesh_lo, mesh_h = self._mesh_min_z(), self._height()
        # The floor the model stands on: its lowest point at rest (feet meshes), or the leg tips.
        self.ground = min([p.z for p in pts] + [mesh_lo]) if pts else mesh_lo
        hips = [self.h0[lg["joints"][0]].z - self.ground for lg in self.legs]
        self.L = max(1e-3, sum(hips) / len(hips)) if hips else max(1e-3, mesh_h * 0.5)
        roots = [n for n in self.names if self.parent[n] is None]

        def ancestors(n):
            out = []
            while n is not None:
                out.append(n)
                n = self.parent[n]
            return out

        leg_anc = [set(ancestors(lg["joints"][0])) for lg in self.legs]
        self.root = max(roots, key=lambda r: (sum(r in a for a in leg_anc), len(self._desc(r)))) if roots else None
        # A fixed top joint with one child (R15's HumanoidRootPart above LowerTorso) never moves itself:
        # the body's motion goes on that child (in Roblox, the Root Motor6D moves LowerTorso).
        while self.root and self.kind.get(self.root) == "fixed" and len(self.children.get(self.root, [])) == 1:
            self.root = self.children[self.root][0]
        self.leg_joints = {j for lg in self.legs for j in lg["joints"]}
        self.leg_ancestors = set().union(*leg_anc) if leg_anc else set()
        self._warm = {}

    def _desc(self, n):
        out = []
        for c in self.children.get(n, []):
            out.append(c)
            out += self._desc(c)
        return out

    def _meshes(self):
        return [o for o in bpy.context.scene.objects if o.type == "MESH" and (o.parent == self.rig or (o.parent and o.parent.get("kiln_segment")))]

    def _mesh_min_z(self):
        zs = [(o.matrix_world @ Vector(c)).z for o in self._meshes() for c in o.bound_box]
        return min(zs) if zs else 0.0

    def _height(self):
        zs = [(o.matrix_world @ Vector(c)).z for o in self._meshes() for c in o.bound_box]
        return (max(zs) - min(zs)) if zs else 1.0

    def find(self, *words):
        """Joints whose names contain any of the words (case-insensitive), parents first."""
        return [n for n in self.names if any(w in n.lower() for w in words)]

    def fk(self, D, T=None):
        """World motion (4x4, rest-relative) of every joint from local rotations D and pivot offsets T."""
        G = {}
        for n in self.names:
            h = self.h0[n]
            q = D.get(n)
            t = T.get(n) if T else None
            M = Matrix.Translation(h + (t if t is not None else Vector())) @ (q.to_matrix().to_4x4() if q is not None else Matrix.Identity(4)) @ Matrix.Translation(-h)
            p = self.parent[n]
            G[n] = (G[p] @ M) if p else M
        return G

    def chain_fk(self, chain, Gp, D, tip0):
        G = Gp
        tots, pos = {}, []
        for j in chain:
            h = self.h0[j]
            G = G @ Matrix.Translation(h) @ D.get(j, Quaternion()).to_matrix().to_4x4() @ Matrix.Translation(-h)
            pos.append(G @ h)
            tots[j] = G.to_quaternion()
        pos.append(G @ tip0)
        return tots, pos

    def solve_leg(self, leg, G, target, D, foot_rot=None, pole=None):
        """Sets D for the leg's joints so its tip (or ankle, for legs with a foot) reaches `target`. G: world
        motions for the joints above the hip."""
        chain = leg["chain"]
        hip = chain[0]
        p = self.parent[hip]
        Gp = G[p] if p else Matrix.Identity(4)
        Rp = Gp.to_quaternion()
        tip0 = leg["tip0"]
        if len(chain) == 2:
            knee = chain[1]
            p0 = [self.h0[hip], self.h0[knee], tip0]
            a, b = (p0[1] - p0[0]).length, (p0[2] - p0[1]).length
            H = Gp @ p0[0]
            t0, s0 = Rp @ (p0[1] - p0[0]), Rp @ (p0[2] - p0[1])
            nb = t0.cross(s0)
            if nb.length < 1e-6 * max(a * b, 1e-9):
                ax = Rp @ self.axis[knee]
                m0 = ax - t0.normalized() * ax.dot(t0.normalized())
                m0 = m0.normalized() if m0.length > 1e-9 else t0.orthogonal().normalized()
                lim = self.limits.get(knee)
                declared = self.kind[knee] == "hinge" and lim and not isinstance(lim[0], (list, tuple)) and (lim[0] + lim[1]) != 0
                if declared and (lim[0] + lim[1]) < 0:
                    m0 = -m0
                # A knee whose limits say which way it bends sets the pole itself (a guessed pole on the other side twisted the thigh half a turn).
                straight_pole = t0.normalized().cross(m0) if declared else None
            else:
                m0 = nb.normalized()
                straight_pole = None
            pl = Rp @ pole if pole is not None else straight_pole if straight_pole is not None else Rp @ leg.get("pole0", self.up)
            dv = target - H
            d = min(max(dv.length, abs(a - b) + 1e-5), a + b - 1e-5)
            u = dv.normalized() if dv.length > 1e-9 else -self.up
            v = pl - u * pl.dot(u)
            if v.length < 1e-9:
                v = u.orthogonal()
            v.normalize()
            ca = max(-1.0, min(1.0, (a * a + d * d - b * b) / (2 * a * d)))
            K = H + a * (ca * u + math.sqrt(max(0.0, 1 - ca * ca)) * v)
            T = H + u * d
            t, s = K - H, T - K
            # The bend plane comes from the pole (stable even when the leg is almost straight).
            n = v.cross(u).normalized()
            # Keep the bend on the same side as at rest (m0 maps to n, not -n).
            W = _frame_rot(t0, m0, t, n)
            q_hip = W @ Rp
            D[hip] = Rp.inverted() @ q_hip
            beta = _signed_angle(W @ s0, s, n)
            q_knee = Quaternion(n, beta) @ q_hip
            D[knee] = q_hip.inverted() @ q_knee
            last_total = q_knee
        else:
            warm = self._warm.setdefault(leg["name"], {j: Quaternion() for j in chain})
            Dc = {j: Quaternion() for j in chain}
            hinge_ang = {}
            for it in range(24):
                for idx in reversed(range(len(chain))):
                    j = chain[idx]
                    tots, pos = self.chain_fk(chain, Gp, Dc, tip0)
                    e, J = pos[-1], pos[idx]
                    v1, v2 = e - J, target - J
                    if v1.length < 1e-9 or v2.length < 1e-9:
                        continue
                    ptot = tots[chain[idx - 1]] if idx > 0 else Rp
                    if self.kind[j] == "hinge":
                        axw = ptot @ self.axis[j]
                        ang = _signed_angle(v1, v2, axw) * 0.85
                        cur = hinge_ang.get(j)
                        if cur is None:
                            qj = Dc[j]
                            cur = 2 * math.atan2(Vector((qj.x, qj.y, qj.z)).dot(self.axis[j]), qj.w)
                        new = cur + ang
                        lim = self.limits.get(j)
                        if lim and not isinstance(lim[0], (list, tuple)):
                            new = max(math.radians(min(lim)), min(math.radians(max(lim)), new))
                        hinge_ang[j] = new
                        Dc[j] = Quaternion(self.axis[j], new)
                    elif self.kind[j] != "fixed":
                        q = v1.rotation_difference(v2)
                        q = Quaternion().slerp(q, 0.7)
                        Dc[j] = ptot.inverted() @ (q @ tots[j])
                tots, pos = self.chain_fk(chain, Gp, Dc, tip0)
                if (pos[-1] - target).length < 1e-4 * self.L:
                    break
            for j in chain:
                D[j] = Dc[j]
                warm[j] = Dc[j].copy()
            last_total = tots[chain[-1]]
        if leg["foot"]:
            want = foot_rot if foot_rot is not None else Quaternion()
            q = last_total.inverted() @ want
            lim = self.limits.get(leg["foot"])
            if lim and isinstance(lim[0], (list, tuple)):
                e = q.to_euler("XYZ")
                q = Euler([max(math.radians(lim[0][k]), min(math.radians(lim[1][k]), e[k])) for k in range(3)], "XYZ").to_quaternion()
            elif lim and self.kind.get(leg["foot"]) == "hinge":
                ax = self.axis[leg["foot"]]
                a = 2 * math.atan2(Vector((q.x, q.y, q.z)).dot(ax), q.w)
                q = Quaternion(ax, max(math.radians(min(lim)), min(math.radians(max(lim)), a)))
            D[leg["foot"]] = q


def _turn_ok(m, j, axis, phi, tol=2.0):
    """Whether joint j may rotate by phi (radians) about the world axis `axis`, within its limits."""
    kind = m.kind.get(j)
    lim = m.limits.get(j)
    if kind == "fixed":
        return abs(phi) < 1e-6
    if kind == "hinge":
        c = m.axis[j].dot(axis)
        if abs(c) < 0.7:
            return abs(phi) < math.radians(4)  # a hinge can't bend this way
        if lim is None or isinstance(lim[0], (list, tuple)):
            return abs(phi) <= math.radians(150)
        ang = math.degrees(phi * c)
        return min(lim) - tol <= ang <= max(lim) + tol
    if lim is None or not isinstance(lim[0], (list, tuple)):
        return abs(phi) <= math.radians(60)
    e = Quaternion(axis, phi).to_euler("XYZ")
    return all(lim[0][i] - tol <= math.degrees(e[i]) <= lim[1][i] + tol for i in range(3))


def _leg_within(m, lg, D, tol=6.0):
    """True when every joint of the leg is within its limits in the local rotations D."""
    for j in lg["joints"]:
        q = D.get(j)
        lim = m.limits.get(j)
        if q is None or not lim:
            continue
        if m.kind.get(j) == "hinge" and not isinstance(lim[0], (list, tuple)):
            a = math.degrees(2 * math.atan2(Vector((q.x, q.y, q.z)).dot(m.axis[j]), q.w))
            if not (min(lim) - tol <= a <= max(lim) + tol):
                return False
        elif isinstance(lim[0], (list, tuple)):
            e = q.to_euler("XYZ")
            if any(not (lim[0][k] - tol <= math.degrees(e[k]) <= lim[1][k] + tol) for k in range(3)):
                return False
    return True


def _legs_by_side(m):
    left, right = [], []
    for lg in m.legs:
        h = m.h0[lg["joints"][0]]
        (right if h.dot(m.right) > 0 else left).append(lg)
    key = lambda lg: -m.h0[lg["joints"][0]].dot(m.fwd)  # front first
    return sorted(left, key=key), sorted(right, key=key)


def _phases(m, pattern):
    L, R = _legs_by_side(m)
    n = len(L) + len(R)
    ph = {}
    if n == 1:
        ph[m.legs[0]["name"]] = 0.0
    elif n == 2:
        a = (L + R)
        ph[a[0]["name"]], ph[a[1]["name"]] = 0.0, 0.5
    elif n == 4 and len(L) == 2 and len(R) == 2:
        LF, LH, RF, RH = L[0]["name"], L[1]["name"], R[0]["name"], R[1]["name"]
        table = {
            "walk": {LH: 0.0, LF: 0.25, RH: 0.5, RF: 0.75},
            "trot": {LF: 0.0, RH: 0.0, RF: 0.5, LH: 0.5},
            "pace": {LF: 0.0, LH: 0.0, RF: 0.5, RH: 0.5},
            "gallop": {LH: 0.0, RH: 0.1, LF: 0.5, RF: 0.6},
            "bound": {LH: 0.0, RH: 0.0, LF: 0.5, RF: 0.5},
        }
        ph = table.get(pattern, table["walk"])
    elif pattern == "sequence" or (pattern in ("auto", "tripod") and n % 2 == 1):
        # One leg at a time, going round the body: what a three- or five-legged walker needs (alternating
        # "diagonals" would lift two of three legs together).
        c = sum((lg["tip0"] for lg in m.legs), Vector()) / n
        around = sorted(m.legs, key=lambda lg: math.atan2((lg["tip0"] - c).dot(m.right), (lg["tip0"] - c).dot(m.fwd)))
        for i, lg in enumerate(around):
            ph[lg["name"]] = i / n
    elif pattern == "wave" and len(L) == len(R):
        k = len(L)
        for i, lg in enumerate(reversed(L)):
            ph[lg["name"]] = (i / k) * 0.5
        for i, lg in enumerate(reversed(R)):
            ph[lg["name"]] = 0.5 + (i / k) * 0.5
    else:  # tripod / tetrapod: alternating diagonals
        for i, lg in enumerate(L):
            ph[lg["name"]] = 0.5 * (i % 2)
        for i, lg in enumerate(R):
            ph[lg["name"]] = 0.5 * ((i + 1) % 2)
    return ph


def _smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _stabilize_joint(m):
    for n in m.names:
        low = n.lower()
        if ("neck" in low or "head" in low) and n not in m.leg_joints:
            return n
    return None


def gait(name="Walk", style="walk", speed=None, cycle=None, duty=None, pattern="auto", step_height=None,
         bob=None, sway=None, lean=None, stride=None, in_place=True, secondary_motion=True, stabilize=0.6, loops=1, turn=0.0):
    """A locomotion cycle for any number of recorded legs (2, 4, 6, 8...), feet planted with IK.
    style: "walk", "trot" (quadrupeds), "run" or "sneak" sets natural defaults from the leg length (real
    animals' speeds and stride lengths scale with it). pattern: "auto", "walk"/"trot"/"pace"/"gallop"/
    "bound" (4 legs), "tripod" (alternating, 6-8 legs) or "wave" (a ripple front to back).
    speed (units/s), cycle (s per stride), duty (fraction of the stride a foot is down), step_height,
    bob, sway (units), lean (degrees), stride (units per cycle) override the defaults.
    in_place=True keeps the body over the origin (the game moves it at `speed`, recorded on the clip).
    secondary_motion: tails, antennae and cables swing with physics. stabilize: the head keeps level.
    An odd number of legs (3, 5) steps one leg at a time ("sequence", also available for any count).
    Pointed feet (a spike or peg pointing down) are planted as points; only real feet roll heel to toe.
    turn: degrees per second, positive to the walker's left. The feet step round the curve the body
    takes; with speed=0 it turns on the spot ("TurnLeft": gait("TurnLeft", speed=0, turn=90)). The clip
    stays in place and records the rate: the game turns the model at `turn` while it plays."""
    asked = dict(locals())  # what the caller chose; None means "work it out" (regenerate re-derives those)
    if speed is not None and (speed < 0 or (speed == 0 and not turn)):
        raise ValueError("gait speed must be above 0 (units per second). A clip can't walk backwards; play it in reverse in the game. To step on the spot, give a turn (speed=0, turn=90), or use idle().")
    if turn and not in_place:
        raise ValueError("a turning gait stays in place (in_place=True): the game moves and turns the model")
    if abs(turn) > 720:
        raise ValueError("turn is in degrees per second: at most 720")
    if duty is not None and not 0.05 < duty < 0.95:
        raise ValueError("duty is the share of a stride a foot is on the ground: between 0.05 and 0.95")
    if cycle is not None and not 0.1 <= cycle <= 10:
        raise ValueError("cycle is the length of one stride in seconds: between 0.1 and 10")
    m = _Model()
    if not m.legs:
        raise ValueError("the rig has no legs: record them (kiln.rig.leg, or kiln.limb(..., rig=True))")
    n = len(m.legs)
    arthropod = n >= 6
    biped = n == 2
    odd = n % 2 == 1 and n > 1
    g = 9.81 / m.unit
    L = m.L
    fr = {"sneak": 0.08, "walk": 0.22, "trot": 0.8, "run": 2.2}.get(style, 0.22)
    if duty is None:
        duty = {"sneak": 0.75, "walk": 0.62 if biped else (0.55 if arthropod else 0.72), "trot": 0.5, "run": 0.36 if biped else 0.42}.get(style, 0.6)
        if odd:
            duty = max(duty, 1.0 - 0.8 / n)  # one leg in the air at a time
    if pattern == "auto":
        pattern = "sequence" if odd else "walk" if n == 4 and style in ("walk", "sneak") else "trot" if n == 4 else "tripod"
    v_nat = math.sqrt(fr * g * L) * (0.8 if arthropod else 1.0)
    v = speed if speed is not None else v_nat
    rel = (1.1 * fr ** 0.25) if arthropod else (2.3 * fr ** 0.3)
    if stride is not None:
        rel = stride / L
    T = cycle if cycle is not None else min(4.0, max(0.2, rel * L / max(v if v > 1e-9 else v_nat, 1e-6)))
    # Turning: the ground passes under the body along a curve about this point.
    w = math.radians(turn)
    pivot = m.h0[m.root].copy() if m.root else Vector((0.0, 0.0, 0.0))
    left = m.up.cross(m.fwd)
    rmax = max(((lg["tip0"] - pivot) - m.up * (lg["tip0"] - pivot).dot(m.up)).length for lg in m.legs)
    # A foot can only sweep so far under its hip, and neighbouring feet must stay clear of each other:
    # shorten the stride (quicker steps at the same speed) when needed.
    reach = min((m.h0[lg["chain"][0]] - lg["tip0"]).length for lg in m.legs)
    max_sweep = 1.3 * reach if not arthropod else 0.9 * reach
    if n >= 4:
        for side in _legs_by_side(m):
            ys = [lg["tip0"].dot(m.fwd) for lg in side]
            gaps = [abs(a - b) for a, b in zip(ys, ys[1:])]
            if gaps:
                max_sweep = min(max_sweep, (0.6 if arthropod else 0.75) * min(gaps))
    notes = []
    # How far the outermost foot travels over the ground while planted (forward speed plus the turn's arc).
    travel = (v + abs(w) * rmax) * duty * T
    if travel > max_sweep:
        if cycle is None:
            T = max_sweep / ((v + abs(w) * rmax) * duty)
        else:
            k = max_sweep / travel
            v, w = v * k, w * k
            notes.append(f"{'speed lowered to %.3g/s' % v if v else 'turn lowered to %.3g deg/s' % math.degrees(w)}: at a {T:.2f} s stride the legs can't reach further (give a shorter cycle for more)")
    # A foot planted through a big turn ends up twisted under the body (and into the other leg): quicker, smaller steps.
    swing_angle = abs(w) * duty * T
    max_angle = math.radians(24.0 if biped else 30.0)
    if swing_angle > max_angle:
        if cycle is None:
            T = max(0.2, max_angle / (abs(w) * duty))
        else:
            w *= max_angle / swing_angle
            notes.append(f"turn lowered to {math.degrees(w):.3g} deg/s: at a {T:.2f} s stride a planted foot would twist too far (give a shorter cycle for more)")
    sweep = v * duty * T
    N = max(8, int(round(T * FPS)))
    if pattern == "sequence":
        N = n * max(3, int(round(N / n)))  # each leg's turn starts on a whole frame
    # Footfalls and lift-offs land on whole frames: between frames a foot is half planted, which reads as a slide.
    duty = min(N - 1, max(1, int(round(duty * N)))) / N
    T = N / FPS
    v = sweep / (duty * T)
    if step_height is None:
        step_height = L * ({"sneak": 0.08, "walk": 0.12, "trot": 0.16, "run": 0.2}.get(style, 0.12) * (1.6 if arthropod else 1.0))
    if bob is None:
        bob = L * ({"sneak": 0.01, "walk": 0.025, "trot": 0.035, "run": 0.06}.get(style, 0.025) * (0.4 if arthropod else 1.0 if biped else 0.6))
    if sway is None:
        sway = L * (0.03 if biped and style != "run" else 0.0)
    if lean is None:
        lean = {"run": 8.0, "trot": 3.0}.get(style, 0.0) * (1.0 if biped else 0.4)
    phases = _phases(m, pattern)

    # Feet with a foot bone roll heel to toe: the heel strikes first, the heel lifts before the toe
    # pushes off. That gives a long stride without crouching.
    roll = {}
    for lg in m.legs:
        if lg["foot"]:
            ank, toe = lg["tip0"], lg["toe0"]
            flen = (toe - ank).length
            along = abs((toe - ank).dot(m.fwd))
            if flen < 1e-6 or along < 0.5 * flen:
                continue  # a spike, peg or hoof pointing down: nothing to roll over (rolling it snapped the ankle)
            heel = Vector((ank.x, ank.y, toe.z)) - m.fwd * (0.12 * flen)
            with _RestPose(m.rig):
                vs = [o.matrix_world @ Vector(c) for o in m._meshes() if o.parent_type == "BONE" and o.parent_bone == lg["foot"] for c in o.bound_box]
            low = [p for p in vs if p.z < toe.z + 0.15 * flen]
            if low:
                back = max(low, key=lambda p: -p.dot(m.fwd))
                heel = Vector((ank.x, ank.y, toe.z)) + m.fwd * (back - ank).dot(m.fwd)
            roll[lg["name"]] = (heel, toe)
    TOE_OFF, HEEL_ON = math.radians(28), math.radians(14)

    def rot_about(pivot, point, ang):
        return pivot + Quaternion(m.right, ang) @ (point - pivot)

    stance = duty * T  # seconds a foot stays down

    def ground(p, t):
        """Where a point of the ground that is at p in mid-stance sits in the body's frame t seconds
        from then: the body moves on at v and turns at w, so the ground slides back along a curve."""
        if abs(w) < 1e-9:
            return p - m.fwd * (v * t)
        c = m.fwd * (v * math.sin(w * t) / w) + left * (v * (1 - math.cos(w * t)) / w)
        return pivot + Quaternion(m.up, -w * t) @ (p - pivot - c)

    def yawed(t, q):
        return Quaternion(m.up, -w * t) @ q if abs(w) > 1e-9 else q

    def foot(lg, u):
        """(target for the IK, the foot's world rotation or None) at gait phase u of this leg."""
        base0 = lg["tip0"]
        if u < duty:
            q = u / duty
            t = (q - 0.5) * stance
            if lg["name"] not in roll:
                return ground(base0, t), None
            heel, toe = roll[lg["name"]]
            if q > 0.7:  # heel off: the foot turns about its planted toe
                a = -TOE_OFF * _smooth((q - 0.7) / 0.3)
                return ground(rot_about(toe, base0, a), t), yawed(t, Quaternion(m.right, a))
            if q < 0.15:  # heel strike: the foot flattens about its heel
                a = HEEL_ON * (1 - _smooth(q / 0.15))
                return ground(rot_about(heel, base0, a), t), yawed(t, Quaternion(m.right, a))
            return ground(base0, t), yawed(t, Quaternion())
        sw = (u - duty) / (1 - duty)
        # Leave and land partly matching the ground's speed (no velocity jump), swing through in
        # between on a Hermite curve, and touch down softly (no vertical speed at either end).
        # The swing runs the stance's path backwards in time: from where the foot left to where it lands.
        tan = 0.35 * (1 - duty) * T
        w2, w3 = sw * sw, sw * sw * sw
        t = (2 * w3 - 3 * w2 + 1) * (stance / 2) + (w3 - 2 * w2 + sw) * tan + (-2 * w3 + 3 * w2) * (-stance / 2) + (w3 - w2) * tan
        h = step_height * 16 * w2 * (1 - sw) ** 2 * (1.0 + 0.35 * (0.5 - sw))
        if lg["name"] not in roll:
            return ground(base0, t) + m.up * h, None
        heel, toe = roll[lg["name"]]
        d_off = rot_about(toe, base0, -TOE_OFF) - base0
        d_on = rot_about(heel, base0, HEEL_ON) - base0
        k = _smooth(sw)
        a = -TOE_OFF + (HEEL_ON + TOE_OFF) * k + math.radians(8) * math.sin(math.pi * sw)
        return ground(base0 + d_off.lerp(d_on, k), t) + m.up * h, yawed(t, Quaternion(m.right, a))

    # How far the body must be lowered on each frame so every planted leg still reaches its foot with a
    # slightly bent knee (standing rigs often have straight legs): a walker dips at double support and
    # rises over a straight leg. Smoothed so it reads as weight, not as a mechanism.
    lens = {}
    for lg in m.legs:
        pts = [m.h0[j] for j in lg["chain"]] + [lg["tip0"]]
        lens[lg["name"]] = sum((b - a).length for a, b in zip(pts, pts[1:]))
    need = []
    for k in range(N):
        tk = k / N
        dk = 0.0
        for lg in m.legs:
            u = (tk + phases.get(lg["name"], 0.0)) % 1.0
            if u >= duty and not arthropod:
                continue
            tgt, _ = foot(lg, u)
            rel = tgt - m.h0[lg["chain"][0]]
            horiz = Vector((rel.x, rel.y, 0)).length
            dk = max(dk, -rel.z - math.sqrt(max(0.0, (0.975 * lens[lg["name"]]) ** 2 - horiz ** 2)))
        need.append(max(0.0, dk))
    # Dilate, then average: never less than needed, and no sudden changes in body height.
    win = max(1, N // 8)
    dil = [max(need[(k + d) % N] for d in range(-win, win + 1)) for k in range(N)]
    drops = [sum(dil[(k + d) % N] for d in range(-win, win + 1)) / (2 * win + 1) for k in range(N)]
    drops = [min(max(a, b), 0.3 * L) for a, b in zip(drops, need)]
    drop = max(drops) if drops else 0.0

    # Bipeds swing their arms against their legs and twist the chest against the hips.
    arms, chest = [], None
    if biped:
        legs_side = {}
        for lg in m.legs:
            legs_side[1 if m.h0[lg["joints"][0]].dot(m.right) > 0 else -1] = lg["name"]
        for j in m.names:
            low = j.lower()
            if j in m.leg_joints:
                continue
            if ("upperarm" in low or "shoulder" in low or low.endswith("arm")) and "lower" not in low and "fore" not in low:
                side = 1 if m.h0[j].dot(m.right) > 0 else -1
                elbow = next((c for c in m.children.get(j, []) if any(w in c.lower() for w in ("lowerarm", "forearm", "elbow"))), None)
                arms.append((j, elbow, legs_side.get(side)))
        chest = next((j for j in m.names if any(w in j.lower() for w in ("uppertorso", "chest", "spine")) and j not in m.leg_joints), None)
    swing_amp = math.radians({"sneak": 8, "walk": 18, "trot": 25, "run": 38}.get(style, 18))

    total = N * max(1, int(loops))
    clip(name, length=total / FPS, loop=True, in_place=in_place, speed=v, priority="Movement")
    act = _action(name)
    frames = list(range(1, total + 2))
    head = _stabilize_joint(m) if stabilize else None
    # Legs with 3+ joints use an iterative solver that starts from the previous frame: a first pass
    # warms it up over the whole cycle so the kept pass starts where it ends (a seamless loop).
    passes = 2 if any(len(lg["chain"]) >= 3 for lg in m.legs) else 1
    for _pass in range(passes):
      data = {j: [] for j in m.names}
      steps = []
      for i, f in enumerate(frames):
          t = (i % N) / N if i < total else 0.0
          tt = i / FPS
          D, Toff = {}, {}
          # Body: bob (lowest when feet land), sway toward the supporting side, a forward lean.
          if biped:
              if style == "run":
                  z = -bob * math.cos(4 * math.pi * (t - duty / 2))
              else:
                  z = -bob * math.cos(4 * math.pi * t)
              x = sway * math.sin(2 * math.pi * t)
              pitch = math.radians(lean) + math.radians(1.5) * math.sin(4 * math.pi * t)
              rl = math.radians(2.0) * math.sin(2 * math.pi * t) * (1 if style != "run" else 0.5)
              yaw = math.radians(4.0 if style != "sneak" else 2.0) * math.sin(2 * math.pi * t)
          else:
              z = -bob * math.cos(4 * math.pi * t)
              x = 0.0
              pitch = math.radians(lean) + math.radians(0.8 if arthropod else 1.5) * math.sin(4 * math.pi * t + 0.6)
              rl = math.radians(0.6 if arthropod else 1.5) * math.sin(2 * math.pi * t)
              yaw = math.radians(0.8 if arthropod else 1.5) * math.sin(2 * math.pi * t + 1.2)
          fwd_off = 0.0 if in_place else v * tt
          root_q = Quaternion(m.up, yaw) @ Quaternion(m.right, -pitch) @ Quaternion(m.fwd, rl)
          if m.root:
              D[m.root] = root_q
              Toff[m.root] = m.up * ((z * (0.5 if biped else 1.0)) - drops[i % N]) + m.right * x + m.fwd * fwd_off
          if chest:
              D[chest] = Quaternion(m.up, -1.8 * yaw)
          for arm, elbow, legname in arms:
              ph = phases.get(legname, 0.0) if legname else 0.0
              ang = -swing_amp * math.cos(2 * math.pi * (t - ph))
              D[arm] = Quaternion(m.right, ang)
              if elbow:
                  lim = m.limits.get(elbow)
                  sgn = -1 if (lim and not isinstance(lim[0], (list, tuple)) and max(lim) <= 0) else 1
                  bend = math.radians(70 if style == "run" else 12 + 14 * max(0.0, math.sin(ang)))
                  D[elbow] = Quaternion(m.axis[elbow], sgn * bend)
          G = m.fk(D, Toff)
          if head:
              p = m.parent[head]
              D[head] = Quaternion().slerp(G[p].to_quaternion().inverted() if p else root_q.inverted(), stabilize)
          for lg in m.legs:
              u = (t + phases.get(lg["name"], 0.0)) % 1.0
              if i < total and ((i % N) / N + phases.get(lg["name"], 0.0)) % 1.0 < 1.0 / N:
                  steps.append((f, lg["name"]))
              target, frot = foot(lg, u)
              target = target + m.fwd * fwd_off
              m.solve_leg(lg, G, target, D, foot_rot=frot)
          for j in m.names:
              data[j].append((D.get(j, Quaternion()), Toff.get(j)))
    write(name, frames, data)
    for f, legname in steps:
        event(name, "Step_" + legname, frame=f)
    meta = _meta(act)
    meta["generator"] = {"name": "gait", "params": {k: asked[k] for k in ("style", "speed", "cycle", "duty", "pattern", "step_height", "bob", "sway", "lean", "stride",
                                                                        "in_place", "secondary_motion", "stabilize", "loops", "turn")}}
    meta["speed"] = round(v, 4)
    meta["turn"] = round(math.degrees(w), 3)
    meta["resolved"] = {"speed": round(v, 4), "cycle": round(T, 4), "duty": round(duty, 3), "step_height": round(step_height, 4), "bob": round(bob, 4),
                        "sway": round(sway, 4), "lean": round(lean, 2), "style": style, "pattern": pattern, "leg_length": round(L, 4), "turn": round(math.degrees(w), 3)}
    _set_meta(act, meta)
    if secondary_motion:
        secondary(name, exclude=[a for a, _, _ in arms] + [e for _, e, _ in arms if e] + ([chest] if chest else []))
    out = {"clip": name, "speed": round(v, 4), "cycle_s": round(T, 3), "frames": total + 1, "duty": round(duty, 3), "crouch": round(drop, 4),
           "stride": round(v * T, 4), "step_height": round(step_height, 4), "pattern": pattern, "legs": n}
    if w:
        out["turn_deg_s"] = round(math.degrees(w), 3)
    if notes:
        out["notes"] = notes
    return out


def _planted(m, G, D):
    for lg in m.legs:
        m.solve_leg(lg, G, lg["tip0"], D)


def idle(name="Idle", length=4.0, breathe=None, sway=None, look=True, secondary_motion=True, seed=0):
    """A calm loop: breathing (the body rises and settles), a slight sway, the head looking around, feet
    planted with IK, tails and cables swaying."""
    asked = dict(locals())
    m = _Model()
    L = m.L
    breathe = L * 0.012 if breathe is None else breathe
    sway = 1.2 if sway is None else sway
    clip(name, length=length, loop=True, in_place=True, priority="Idle")
    N = int(round(length * FPS))
    frames = list(range(1, N + 2))
    head = _stabilize_joint(m)
    rnd = random.Random(seed)
    looks = [(rnd.uniform(-1, 1), rnd.uniform(-0.4, 0.4)) for _ in range(3)]
    passes = 2 if any(len(lg["chain"]) >= 3 for lg in m.legs) else 1
    for _pass in range(passes):
      data = {j: [] for j in m.names}
      for i, f in enumerate(frames):
          t = (i % N) / N
          D, Toff = {}, {}
          br = math.sin(2 * math.pi * 2 * t)
          if m.root:
              D[m.root] = Quaternion(m.right, math.radians(sway * 0.4) * br) @ Quaternion(m.fwd, math.radians(sway * 0.3) * math.sin(2 * math.pi * t))
              Toff[m.root] = m.up * (breathe * br)
          if head and look:
              k = len(looks)
              seg = t * k
              a, b = looks[int(seg) % k], looks[(int(seg) + 1) % k]
              w = _smooth((seg % 1.0 - 0.3) / 0.4)
              yaw = math.radians(25) * (a[0] + (b[0] - a[0]) * w)
              pit = math.radians(12) * (a[1] + (b[1] - a[1]) * w)
              D[head] = Quaternion(m.up, yaw) @ Quaternion(m.right, pit)
          G = m.fk(D, Toff)
          _planted(m, G, D)
          for j in m.names:
              data[j].append((D.get(j, Quaternion()), Toff.get(j)))
    write(name, frames, data)
    act = _action(name)
    meta = _meta(act)
    meta["generator"] = {"name": "idle", "params": {k: asked[k] for k in ("length", "breathe", "sway", "look", "secondary_motion", "seed")}}
    meta["resolved"] = {"length": length, "breathe": round(breathe, 4), "sway": sway, "leg_length": round(L, 4)}
    _set_meta(act, meta)
    if secondary_motion:
        secondary(name)
    return {"clip": name, "frames": N + 1}


def _chain_from(m, start):
    out = [start]
    while len(m.children.get(out[-1], [])) == 1:
        out.append(m.children[out[-1]][0])
    return out


def _tail_chain(m):
    """The tail: joints named tail/sting, else the longest chain leaving the body backward."""
    named = [n for n in m.find("tail", "sting") if n not in m.leg_joints]
    if named:
        first = [n for n in named if m.parent[n] not in named][0]
        return _chain_from(m, first)
    best = None
    for n in m.names:
        if n in m.leg_joints or n == m.root or m.parent[n] in (None,) or m.parent[n] in m.leg_joints:
            continue
        if m.parent[n] != m.root:
            continue
        ch = _chain_from(m, n)
        d = (m.t0[ch[-1]] - m.h0[ch[0]])
        if d.dot(m.fwd) < 0 and (best is None or len(ch) > len(best)):
            best = ch
    return best or []


def _ease_pose(t, keys):
    """Piecewise interpolation between key poses [(time 0-1, value, easing)] -> value (floats or tuples)."""
    for (t0, v0, _), (t1, v1, e) in zip(keys, keys[1:]):
        if t <= t1:
            w = (t - t0) / max(1e-9, t1 - t0)
            w = {"in": w * w, "out": 1 - (1 - w) ** 2, "snap": w ** 3, "smooth": _smooth(w), "linear": w}.get(e, _smooth(w))
            if isinstance(v0, (tuple, list)):
                return tuple(a + (b - a) * w for a, b in zip(v0, v1))
            return v0 + (v1 - v0) * w
    return keys[-1][1]


def attack(name="Attack", kind="lunge", reach=None, windup=0.35, strike=0.14, hold=0.08, recover=0.5, target=None, chain=None, secondary_motion=True):
    """An attack with anticipation, a fast strike and recovery, feet planted. kind: "lunge" (the body
    thrusts forward), "sting" (the tail curls back then whips toward `target`), "bite" (the head pulls
    back then snaps forward, the jaw opens and shuts), "slam" (the front legs rise and crash down),
    "swipe" (a limb or `chain` swings across). reach: how far it thrusts (units). Adds a "Hit" event at
    the moment of impact. Times in seconds."""
    asked = dict(locals())
    m = _Model()
    L = m.L
    reach = reach if reach is not None else L * 0.45
    total = windup + strike + hold + recover
    clip(name, length=total, loop=False, in_place=True, priority="Action")
    N = int(round(total * FPS))
    frames = list(range(1, N + 2))
    tw, ts, th = windup / total, (windup + strike) / total, (windup + strike + hold) / total
    head = _stabilize_joint(m)
    jaw = next((n for n in m.find("jaw", "mouth", "mandible") if n not in m.leg_joints), None)
    tail = _tail_chain(m) if kind == "sting" else []
    swing = _chain_from(m, chain) if chain else []
    front = sorted(m.legs, key=lambda lg: -m.h0[lg["joints"][0]].dot(m.fwd))[:2] if kind == "slam" else []
    if kind == "sting" and chain:
        tail = _chain_from(m, chain)
    if kind == "sting" and not tail:
        raise ValueError("no tail found for a sting: name its joints Tail_... or pass chain=")
    if target is None:
        if kind == "sting":
            # Just in front of the head on the body's midline, about head height: where a scorpion's
            # sting lands on prey.
            caps = [c for c in _segment_capsules(m) if c["joint"] not in m.leg_joints and c["joint"] not in tail]
            if caps:
                fp = max((c[e] + m.fwd * c["r"] for c in caps for e in ("a", "b")), key=lambda q: q.dot(m.fwd))
            else:
                body_js = [n for n in m.names if n not in m.leg_joints and n not in tail] or [m.root]
                fp = m.h0[max(body_js, key=lambda n: m.h0[n].dot(m.fwd))]
            target = fp + m.fwd * (0.3 * L)
            base = m.h0[m.root] if m.root else Vector()
            target = target - m.right * (target - base).dot(m.right)
            target.z = max(fp.z, m.ground + 0.55 * L)
        else:
            top = max(m.h0[n].z for n in m.names)
            target = (m.h0[m.root] if m.root else Vector()) + m.fwd * (L * 1.2 + reach) + m.up * (top - m.ground) * 0.35
    target = Vector(target)
    curl_best = 0.0
    wts, mean_w = [], 1.0
    if tail:
        # How the tail curls forward over the body so its tip lands on the target without passing
        # through the body: a search over the total curl and how much of it the base takes (a
        # scorpion keeps its tail base up and curls the end over).
        n_t = len(tail)
        all_caps = _segment_capsules(m)
        body_caps = [c for c in all_caps if c["joint"] not in tail and c["joint"] not in m.leg_joints]
        tail_idx = {j: k for k, j in enumerate(tail)}
        tail_caps = [c for c in all_caps if c["joint"] in tail_idx]
        max_bend = math.radians(38)
        tip_j, tip0 = tail[-1], m.t0[tail[-1]]
        with _RestPose(m.rig):
            atts = [(tail_idx[o.parent_bone], o.parent_bone, o.matrix_world.translation.copy()) for o in bpy.data.objects
                    if o.get("kiln_attach") and o.parent == m.rig and o.parent_bone in tail_idx]
        if atts:
            _, tip_j, tip0 = max(atts, key=lambda a: a[0])
        else:
            last = [c for c in tail_caps if c["joint"] == tail[-1]]
            if last:
                h = m.h0[tail[-1]]
                tip0 = max((c[e] for c in last for e in ("a", "b")), key=lambda q: (q - h).length)

        def profile(beta):
            w = [(1 - beta) * ((k + 1) / n_t) ** 2 + beta for k in range(n_t)]
            mw = sum(w) / len(w)
            return w, mw

        def pose_pts(alpha, w, mw):
            Dt = {j: Quaternion(m.right, -alpha * wk / mw) for j, wk in zip(tail, w)}
            G = m.fk(Dt)
            pts = [G[j] @ m.h0[j] for j in tail[1:]] + [G[tail[-1]] @ ((m.h0[tail[-1]] + m.t0[tail[-1]]) / 2), G[tail[-1]] @ m.t0[tail[-1]]]
            return pts

        def tail_clash(G):
            """How deep the tail's own parts pass into each other (non-neighbouring segments)."""
            pen = 0.0
            for x in range(len(tail_caps)):
                for y in range(x + 1, len(tail_caps)):
                    A, B = tail_caps[x], tail_caps[y]
                    if abs(tail_idx[A["joint"]] - tail_idx[B["joint"]]) < 2:
                        continue
                    d = _cap_dist(G[A["joint"]] @ A["a"], G[A["joint"]] @ A["b"], G[B["joint"]] @ B["a"], G[B["joint"]] @ B["b"])
                    pen += max(0.0, 0.9 * (A["r"] + B["r"]) - d)
            return pen

        def clash(G):
            """How deep the tail's parts (a stinger included) go into the body or the ground."""
            pen = 0.0
            for tc in tail_caps:
                a, b = G[tc["joint"]] @ tc["a"], G[tc["joint"]] @ tc["b"]
                pen += max(0.0, m.ground + 0.02 * L - (min(a.z, b.z) - tc["r"]))
                for bc in body_caps:
                    d = _cap_dist(a, b, bc["a"], bc["b"])
                    pen += max(0.0, 0.95 * (tc["r"] + bc["r"]) + 0.02 * L - d)
            if not tail_caps:
                for j in tail:
                    pen += max(0.0, m.ground + 0.02 * L - (G[j] @ m.t0[j]).z)
            return pen + tail_clash(G)

        def cost(alpha, beta):
            w, mw = profile(beta)
            if abs(alpha) * max(w) / mw > max_bend:
                return float("inf")
            for j, wk in zip(tail, w):
                for k in (1.0, 1.06):  # the strike, and its overshoot
                    if not _turn_ok(m, j, m.right, -alpha * k * wk / mw):
                        return float("inf")
            G = m.fk({j: Quaternion(m.right, -alpha * wk / mw) for j, wk in zip(tail, w)})
            Go = m.fk({j: Quaternion(m.right, -1.06 * alpha * wk / mw) for j, wk in zip(tail, w)})
            return (G[tip_j] @ tip0 - target).length + 6.0 * (clash(G) + clash(Go))

        best = (cost(0.0, 0.45), 0.0, 0.45)
        for beta in (0.0, 0.2, 0.45, 0.7):
            for step in range(-10, 61):
                a = math.radians(4 * step)
                cst = cost(a, beta)
                if cst < best[0]:
                    best = (cst, a, beta)
        _, a0, b0 = best
        for step in range(-20, 21):
            a = a0 + math.radians(0.2 * step)
            cst = cost(a, b0)
            if cst < best[0]:
                best = (cst, a, b0)
        curl_best = best[1]
        wts, mean_w = profile(best[2])
        # The cock-back before the strike: as far as 30% of the strike's curl, but never into the ground
        # or into itself.
        cock = 0.0
        for frac in (0.3, 0.22, 0.15, 0.08):
            Dt = {j: Quaternion(m.right, frac * curl_best * wk / mean_w) for j, wk in zip(tail, wts)}
            G = m.fk(Dt)
            if (clash(G) < 0.02 * L and frac * abs(curl_best) * max(wts) / mean_w <= max_bend
                    and all(_turn_ok(m, j, m.right, frac * curl_best * wk / mean_w) for j, wk in zip(tail, wts))):
                cock = frac
                break
    body = [(0, (0, 0, 0, 0), "smooth"), (tw, (-0.35, -0.25, 1.0, 0), "smooth"), (ts, (1.0, 0.35, -0.6, 1), "snap"),
            (ts + (th - ts) * 0.5, (1.08, 0.38, -0.66, 1), "out"), (th, (1.0, 0.35, -0.6, 1), "smooth"), (1.0, (0, 0, 0, 0), "smooth")]
    data = {j: [] for j in m.names}
    tail_rest = None
    for i, f in enumerate(frames):
        t = i / N
        fwd, down, pitch, strike_w = _ease_pose(t, body)
        if kind in ("sting", "swipe"):
            fwd, down, pitch = fwd * 0.3, down * 0.3, pitch * 0.5
        if kind == "slam":
            fwd, down, pitch = fwd * 0.2, -abs(down) * 0.2, pitch * 1.5
        D, Toff = {}, {}
        if m.root:
            D[m.root] = Quaternion(m.right, math.radians(8) * pitch)
            Toff[m.root] = m.fwd * (reach * fwd) - m.up * (L * 0.12 * down)
        if head and kind in ("bite", "lunge"):
            D[head] = Quaternion(m.right, math.radians(-14) * pitch)
        if jaw:
            open_ = _ease_pose(t, [(0, 0.0, "smooth"), (tw, 1.0, "smooth"), (ts - 0.02, 1.0, "linear"), (ts, 0.0, "snap"), (1.0, 0.0, "smooth")])
            D[jaw] = Quaternion(m.right, math.radians(-35) * open_)
        if swing:
            ax = m.up
            ang = _ease_pose(t, [(0, 0.0, "smooth"), (tw, -70.0, "smooth"), (ts, 55.0, "snap"), (th, 55.0, "linear"), (1.0, 0.0, "smooth")])
            D[swing[0]] = Quaternion(ax, math.radians(ang))
        G = m.fk(D, Toff)
        if tail:
            # Cock the tail back (anticipation), whip it forward over the body onto the target with a
            # little overshoot, hold, recover.
            a = _ease_pose(t, [(0, 0.0, "smooth"), (tw, -cock, "smooth"), (ts, 1.0, "snap"), (ts + (th - ts) * 0.5, 1.06, "out"), (th, 1.0, "smooth"), (1.0, 0.0, "smooth")])
            for j, w in zip(tail, wts):
                D[j] = Quaternion(m.right, -a * curl_best * w / mean_w)
            G = m.fk(D, Toff)
        for lg in m.legs:
            if lg in front:
                lift = _ease_pose(t, [(0, 0.0, "smooth"), (tw, 1.0, "smooth"), (ts, -0.05, "snap"), (th, 0.0, "linear"), (1.0, 0.0, "smooth")])
                tgt = lg["tip0"] + m.up * (L * 0.7 * max(0.0, lift)) + m.fwd * (L * 0.35 * _smooth(t / ts) if t < ts else L * 0.35 * (1 - _smooth((t - th) / (1 - th))) if t > th else L * 0.35)
                m.solve_leg(lg, G, tgt, D)
            else:
                m.solve_leg(lg, G, lg["tip0"], D)
        for j in m.names:
            data[j].append((D.get(j, Quaternion()), Toff.get(j)))
    write(name, frames, data)
    event(name, "Strike", frame=frames[0] + int(round(tw * N)))
    event(name, "Hit", frame=frames[0] + int(round(ts * N)))
    act = _action(name)
    meta = _meta(act)
    meta["generator"] = {"name": "attack", "params": {"kind": kind, "reach": asked["reach"], "windup": windup, "strike": strike, "hold": hold, "recover": recover,
                                                    "target": list(asked["target"]) if asked["target"] is not None else None, "chain": chain, "secondary_motion": secondary_motion}}
    meta["resolved"] = {"kind": kind, "reach": round(reach, 4), "windup": windup, "strike": strike, "hold": hold, "recover": recover, "leg_length": round(L, 4)}
    _set_meta(act, meta)
    if secondary_motion:
        secondary(name, exclude=tail + swing)
    return {"clip": name, "frames": N + 1, "hit_frame": frames[0] + int(round(ts * N))}


def hit(name="Hit", direction=(0, 1, 0), strength=1.0, length=0.6, secondary_motion=True):
    """A hit reaction: the body is shoved along `direction` (where the blow pushes it; default: backward
    for a creature facing -Y) and springs back, feet planted."""
    m = _Model()
    L = m.L
    clip(name, length=length, loop=False, in_place=True, priority="Action")
    N = int(round(length * FPS))
    frames = list(range(1, N + 2))
    d = Vector(direction).normalized()
    axis = m.up.cross(d).normalized() if abs(d.dot(m.up)) < 0.95 else m.right
    data = {j: [] for j in m.names}
    head = _stabilize_joint(m)
    for i, f in enumerate(frames):
        tt = i / FPS
        w = 7.0 / max(length, 0.2)
        x = strength * math.exp(-4.5 * tt / max(length, 0.2) * 1.4) * math.sin(w * tt) if tt > 0 else 0.0
        D, Toff = {}, {}
        if m.root:
            D[m.root] = Quaternion(axis, math.radians(9) * x)
            Toff[m.root] = d * (L * 0.12 * x) - m.up * (L * 0.04 * abs(x))
        if head:
            D[head] = Quaternion(axis, math.radians(12) * x)
        G = m.fk(D, Toff)
        _planted(m, G, D)
        for j in m.names:
            data[j].append((D.get(j, Quaternion()), Toff.get(j)))
    write(name, frames, data)
    act = _action(name)
    meta = _meta(act)
    event(name, "Impact", frame=frames[0])
    meta["generator"] = {"name": "hit", "params": {"direction": list(d), "strength": strength, "length": length, "secondary_motion": secondary_motion}}
    meta["resolved"] = {"strength": strength, "length": length}
    _set_meta(act, meta)
    if secondary_motion:
        secondary(name)
    return {"clip": name, "frames": N + 1}


def death(name="Death", length=1.6, side=1.0, secondary_motion=True):
    """The creature collapses: legs buckle and splay, the body drops to the ground with a small bounce and
    rolls a little to `side` (1 right, -1 left), the head and tail slump. Ends held; a "Dead" event marks
    the landing."""
    m = _Model()
    L = m.L
    clip(name, length=length, loop=False, in_place=True, priority="Action")
    N = int(round(length * FPS))
    frames = list(range(1, N + 2))
    body_h = 0.0
    if m.root:
        with _RestPose(m.rig):
            meshes = [o for o in m._meshes() if o.parent_type != "BONE" or o.parent_bone == m.root]
            zs = [(o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box]
        body_h = (min(zs) - m.ground) if zs else L * 0.5
    drop = max(0.0, body_h - 0.02 * L)
    land = 0.55
    head = _stabilize_joint(m)
    tail = _tail_chain(m)
    body_caps = [c for c in _segment_capsules(m) if c["joint"] not in m.leg_joints]
    tries = [(k, 0.0) for k in (1.0, 0.7, 0.4, 0.15, 0.0)] + [(0.0, u) for u in (0.15, 0.3, 0.45, 0.6)]

    def leg_goal(lg, splay, k, up):
        h = m.h0[lg["joints"][0]]
        out = (lg["tip0"] - h)
        out.z = 0
        out = out.normalized() if out.length > 1e-6 else m.right
        return lg["tip0"] + out * (L * 0.35 * splay * k) + m.up * (L * up * splay)

    # Sink only as far as every leg can fold within its limits (tall legs hold the body up).
    for f in (1.0, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0.0):
        Dq = {m.root: Quaternion(m.fwd, math.radians(12) * side)} if m.root else {}
        Tq = {m.root: -m.up * (drop * f)} if m.root else {}
        Gq = m.fk(Dq, Tq)
        feasible = True
        for lg in m.legs:
            if not any(_leg_within(m, lg, (lambda Dl: (m.solve_leg(lg, Gq, leg_goal(lg, 1.0, k, up), Dl), Dl)[1])(dict(Dq))) for k, up in tries):
                feasible = False
                break
        if feasible:
            drop *= f
            break
    else:
        drop = 0.0
    # How far the tail folds back and down to lie on the ground behind the fallen body.
    tail_fold = 0.0
    if tail:
        Dl = {m.root: Quaternion(m.fwd, math.radians(12) * side)} if m.root else {}
        Tl = {m.root: -m.up * drop} if m.root else {}
        best = (float("inf"), 0.0)
        for step in range(0, 76):
            a = math.radians(2 * step)
            Dt = dict(Dl)
            ok = True
            for k, j in enumerate(tail):
                ang = a * (0.6 + 0.8 * k / max(1, len(tail) - 1)) / len(tail)
                ok = ok and _turn_ok(m, j, m.right, ang)
                Dt[j] = Quaternion(m.right, ang)
            if not ok:
                continue
            G = m.fk(Dt, Tl)
            pts = [G[j] @ m.h0[j] for j in tail[1:]] + [G[tail[-1]] @ m.t0[tail[-1]]]
            c = abs(pts[-1].z - (m.ground + 0.04 * L)) + 4 * sum(max(0.0, m.ground + 0.02 * L - q.z) for q in pts)
            if c < best[0]:
                best = (c, a)
        tail_fold = best[1]
    data = {j: [] for j in m.names}
    for i, f in enumerate(frames):
        t = i / N
        fall = _ease_pose(t, [(0, 0.0, "smooth"), (0.12, -0.04, "smooth"), (land, 1.0, "in"), (land + 0.1, 0.94, "out"), (land + 0.2, 1.0, "in"), (1.0, 1.0, "linear")])
        roll = _ease_pose(t, [(0, 0.0, "smooth"), (land, 0.6, "in"), (1.0, 1.0, "smooth")])
        D, Toff = {}, {}
        if m.root:
            D[m.root] = Quaternion(m.fwd, math.radians(12) * roll * side) @ Quaternion(m.right, math.radians(-4) * fall)
            Toff[m.root] = -m.up * (drop * fall)
        if head:
            D[head] = Quaternion(m.right, math.radians(-30) * _smooth((t - 0.3) / 0.5))
        fold = _ease_pose(t, [(0, 0.0, "smooth"), (0.08, -0.06, "smooth"), (0.2, 0.0, "smooth"), (land + 0.05, 1.0, "in"), (land + 0.14, 0.93, "out"), (land + 0.24, 1.0, "in"), (1.0, 1.0, "linear")])
        for k, j in enumerate(tail):
            D[j] = Quaternion(m.right, fold * tail_fold * (0.6 + 0.8 * k / max(1, len(tail) - 1)) / len(tail))
        G = m.fk(D, Toff)
        # Nothing of the body may sink into the floor (a jaw full of teeth, a heavy belly): lift it.
        solid = [c for c in body_caps if c["joint"] not in tail]
        if solid and m.root:
            low = min(min((G[c["joint"]] @ c["a"]).z, (G[c["joint"]] @ c["b"]).z) - c["r"] for c in solid)
            if low < m.ground:
                Toff[m.root] = Toff[m.root] + m.up * (m.ground - low)
                G = m.fk(D, Toff)
        for lg in m.legs:
            h = m.h0[lg["joints"][0]]
            out = (lg["tip0"] - h)
            out.z = 0
            out = out.normalized() if out.length > 1e-6 else m.right
            splay = _smooth(t / land)
            lift = m.up * (L * 0.05 * math.sin(math.pi * min(1, t / land)))
            for k, up in tries:
                Dl = dict(D)
                m.solve_leg(lg, G, leg_goal(lg, splay, k, up) + lift, Dl)
                if _leg_within(m, lg, Dl):
                    break
            for j in lg["joints"]:
                if j in Dl:
                    D[j] = Dl[j]
        for j in m.names:
            data[j].append((D.get(j, Quaternion()), Toff.get(j)))
    write(name, frames, data)
    event(name, "Dead", frame=frames[0] + int(round(land * N)))
    act = _action(name)
    meta = _meta(act)
    meta["generator"] = {"name": "death", "params": {"length": length, "side": side, "secondary_motion": secondary_motion}}
    meta["resolved"] = {"length": length, "side": side}
    _set_meta(act, meta)
    if secondary_motion:
        secondary(name, gravity=1.6, stiffness=0.12, exclude=tail)
    return {"clip": name, "frames": N + 1, "land_frame": frames[0] + int(round(land * N)), "tail_fold_deg": round(math.degrees(tail_fold), 1)}


def wave(name, joints=None, amplitude=18.0, wavelength=4.0, frequency=1.0, axis="side", length=None, add=True):
    """A travelling wave down a chain: a tail swish, a slither, a tentacle curl, a swimming body. joints:
    the chain (a list, or the first joint's name; default the tail). amplitude in degrees per joint,
    wavelength in joints, frequency in waves per second, axis "side" (left-right) or "up" (up-down).
    add=True layers it on the clip's existing motion (else it creates a looping clip of `length` s)."""
    m = _Model()
    ch = joints if isinstance(joints, (list, tuple)) else (_chain_from(m, joints) if joints else _tail_chain(m))
    if not ch:
        raise ValueError("no chain for the wave: pass joints=")
    exists = bpy.data.actions.get(name) is not None and "kiln_clip" in bpy.data.actions[name]
    if not exists or not add:
        per = 1.0 / max(frequency, 1e-3)
        length = length or per * max(1, round(2.0 / per))
        clip(name, length=length, loop=True, in_place=True)
    act = _action(name)
    s, e = (int(round(v)) for v in act.frame_range)
    frames = list(range(s, e + 1))
    cur = read(name, frames)
    ax = m.up if axis == "side" else m.right
    data = {}
    span = (e - s) / FPS
    freq = round(frequency * span) / span if span > 0 else frequency  # whole waves: seamless loop
    for k, j in enumerate(ch):
        seq = []
        for i, f in enumerate(frames):
            tt = (f - s) / FPS
            ang = math.radians(amplitude) * math.sin(2 * math.pi * (freq * tt - k / max(wavelength, 1e-3)))
            q0, t0 = cur[j][i]
            seq.append((q0 @ Quaternion(ax, ang), t0))
        data[j] = seq
    write(name, frames, data)
    return {"clip": name, "joints": ch}


def _chains(m, only=None, exclude=()):
    """Chains that move by physics: joints hanging off the body that no leg or generator drives."""
    ex = set(exclude) | m.leg_joints | m.leg_ancestors
    if m.root:
        ex.add(m.root)
    head = _stabilize_joint(m)
    if head:
        ex.add(head)
    cands = [n for n in (only or m.names) if n not in ex]
    out = []
    for n in cands:
        if m.parent[n] in cands:
            continue
        ch = [n]
        while True:
            kids = [c for c in m.children.get(ch[-1], []) if c in cands]
            if len(kids) != 1:
                break
            ch.append(kids[0])
        out.append(ch)
    return out


def secondary(name, joints=None, stiffness=0.25, damping=0.1, gravity=1.0, exclude=(), cycles=3):
    """Physics follow-through for chains hanging off the body (tails, antennae, cables, slime strands,
    tentacles, ears): they lag, swing and settle as the body moves, with gravity, and never pass below
    the ground. joints: limit to these; stiffness 0-1 (how firmly they hold their shape), damping 0-1.
    Runs on the clip as it is, so call it after the main motion. Loops stay seamless."""
    m = _Model()
    chains = _chains(m, only=joints, exclude=exclude)
    if not chains:
        return []
    act = _action(name)
    s, e = (int(round(v)) for v in act.frame_range)
    frames = list(range(s, e + 1))
    cur = read(name, frames)
    if joints is None:
        # A chain the clip itself moves (a keyed jaw snap, hand-posed arms, a generator's tail whip) keeps
        # its keys: physics would soften and delay them. Name it in `joints` to simulate it anyway.
        def driven(ch):
            return any(q.angle > math.radians(1.5) for j in ch for q, _t in cur[j])
        chains = [ch for ch in chains if not driven(ch)]
        if not chains:
            return []
    loop = _meta(act).get("loop", True)
    Nf = len(frames)
    Gs = [m.fk({j: cur[j][i][0] for j in cur}, {j: cur[j][i][1] for j in cur if cur[j][i][1] is not None}) for i in range(Nf)]
    g = 9.81 / m.unit * gravity
    dt = 1.0 / FPS
    sub = 4
    reps = cycles if loop else 1
    out_data = {}
    for ch in chains:
        pts0 = [m.h0[j] for j in ch] + [m.t0[ch[-1]]]
        seg = [(pts0[k + 1] - pts0[k]).length for k in range(len(ch))]
        radius = 0.02 * m.L
        x = [Gs[0][ch[min(k, len(ch) - 1)]] @ p for k, p in enumerate(pts0)]
        xp = [v.copy() for v in x]
        hist = []
        for rep in range(reps):
            for i in range(Nf):
                G = Gs[i]
                rig_pts = [G[ch[min(k, len(ch) - 1)]] @ p for k, p in enumerate(pts0)]
                prev_base = x[0].copy()
                for sstep in range(sub):
                    w = (sstep + 1) / sub
                    x[0] = prev_base.lerp(rig_pts[0], w)
                    xp[0] = x[0].copy()
                    for k in range(1, len(x)):
                        vel = (x[k] - xp[k]) * (1.0 - damping)
                        xp[k] = x[k].copy()
                        x[k] = x[k] + vel + Vector((0, 0, -g)) * (dt / sub) ** 2
                        x[k] = x[k] + (rig_pts[k] - x[k]) * (stiffness / sub)
                    for _ in range(3):
                        for k in range(len(x) - 1):
                            d = x[k + 1] - x[k]
                            ln = d.length or 1e-9
                            corr = d * (1 - seg[k] / ln)
                            if k == 0:
                                x[k + 1] = x[k + 1] - corr
                            else:
                                x[k] = x[k] + corr * 0.5
                                x[k + 1] = x[k + 1] - corr * 0.5
                        for k in range(1, len(x)):
                            if x[k].z < m.ground + radius:
                                x[k].z = m.ground + radius
                if rep == reps - 1:
                    hist.append([v.copy() for v in x])
        seqs = {j: [] for j in ch}
        for i in range(Nf):
            G = Gs[i]
            p = m.parent[ch[0]]
            tot = G[p].to_quaternion() if p else Quaternion()
            for k, j in enumerate(ch):
                base = tot @ cur[j][i][0]
                d_rest = base @ (pts0[k + 1] - pts0[k])
                d_sim = hist[i][k + 1] - hist[i][k]
                W = d_rest.rotation_difference(d_sim) if d_rest.length > 1e-9 and d_sim.length > 1e-9 else Quaternion()
                new = W @ base
                seqs[j].append((tot.inverted() @ new, cur[j][i][1]))
                tot = new
        if loop and Nf > 4:
            nb = max(2, int(Nf * 0.25))
            for j in ch:
                first = seqs[j][0][0]
                for kk in range(nb):
                    i = Nf - nb + kk
                    w = _smooth((kk + 1) / nb)
                    q, t = seqs[j][i]
                    seqs[j][i] = (q.slerp(first, w), t)
        out_data.update(seqs)
    write(name, frames, out_data)
    return [c for c in chains]


def reach(name, end, targets, chain=2, pole=None):
    """IK in a clip: move joint chain ending at `end` (the last `chain` joints) so its tip reaches the
    targets. targets: {frame: (x, y, z)} (in between they move in straight lines; hold a target still
    to pin a foot to a wall or a claw to a ledge). Writes keys on every frame from the first to the last
    target frame, on top of the clip's motion."""
    m = _Model()
    ch = [end]
    while len(ch) < chain and m.parent[ch[0]] is not None:
        ch.insert(0, m.parent[ch[0]])
    fake = {"name": "_reach_" + end, "chain": ch, "tip0": m.t0[end], "foot": None}
    if len(ch) == 2:
        h, k = m.h0[ch[0]], m.h0[ch[1]]
        line = m.t0[end] - h
        off = (k - h) - line.normalized() * (k - h).dot(line.normalized())
        fake["pole0"] = off.normalized() if off.length > 1e-6 else m.up
    keys = sorted((float(f), Vector(p)) for f, p in targets.items())
    first, last = int(keys[0][0]), int(keys[-1][0])
    act = _action(name)
    s, e = (int(round(v)) for v in act.frame_range)
    ease = 3  # frames to blend into and out of the reach, so the limb doesn't snap
    fs = list(range(s, e + 1))  # the whole clip is rewritten for these joints: frames outside the reach keep their motion
    cur = read(name, fs)
    data = {j: [] for j in ch}
    for i, f in enumerate(fs):
        w = 1.0 if first <= f <= last else max(0.0, 1.0 - (first - f) / (ease + 1.0)) if f < first else max(0.0, 1.0 - (f - last) / (ease + 1.0))
        if w <= 0.0:
            for j in ch:
                data[j].append(cur[j][i])
            continue
        tgt = keys[0][1] if f < first else keys[-1][1]
        for (f0, p0), (f1, p1) in zip(keys, keys[1:]):
            if f0 <= f <= f1:
                tgt = p0.lerp(p1, (f - f0) / max(1e-9, f1 - f0))
                break
        D = {j: cur[j][i][0] for j in cur}
        Toff = {j: cur[j][i][1] for j in cur if cur[j][i][1] is not None}
        G = m.fk(D, Toff)
        m.solve_leg(fake, G, tgt, D, pole=Vector(pole) if pole is not None else None)
        for j in ch:
            data[j].append((cur[j][i][0].slerp(D[j], w), cur[j][i][1]))
    write(name, fs, data)
    return {"clip": name, "joints": ch, "frames": [first, last]}


def bake(name):
    """Turns what Blender's IK constraints (kiln.rig.ik) and any other constraints show into plain keys on
    every frame of the clip, then switches those constraints off, so the clip exports as it looks."""
    rig = _rig()
    act = _action(name)
    use(name)
    s, e = (int(round(v)) for v in act.frame_range)
    frames = list(range(s, e + 1))
    sc = bpy.context.scene
    here = sc.frame_current
    for pb in rig.pose.bones:
        for c in pb.constraints:
            c.mute = False  # an earlier bake switched them off: this clip needs them to be read
    names = [b.name for b in rig.data.bones]
    mats = {n: [] for n in names}
    for f in frames:
        sc.frame_set(f)
        for n in names:
            pb = rig.pose.bones[n]
            mats[n].append(rig.convert_space(pose_bone=pb, matrix=pb.matrix, from_space="POSE", to_space="LOCAL").copy())
    data = {}
    for n in names:
        r0 = rig.data.bones[n].matrix_local.to_quaternion()
        seq = []
        for mm in mats[n]:
            loc, q, _ = mm.decompose()
            seq.append((r0 @ q @ r0.inverted(), r0 @ loc))
        data[n] = seq
    for pb in rig.pose.bones:
        for c in pb.constraints:
            c.mute = True
    write(name, frames, data)
    sc.frame_set(here)
    return {"clip": name, "frames": len(frames)}


def regenerate(name, **params):
    """Re-runs the generator that made a clip, with some parameters changed (the Animate panel's sliders)."""
    act = _action(name)
    gen = _meta(act).get("generator") or {}
    fn = {"gait": gait, "idle": idle, "attack": attack, "hit": hit, "death": death}.get(gen.get("name"))
    if fn is None:
        raise ValueError(f"clip {name} wasn't made by a generator")
    p = dict(gen.get("params") or {})
    p.update(params)
    keep = {k: v for k, v in _meta(act).items() if k in ("priority", "fade")}
    events = [(mk.name, mk.frame) for mk in act.pose_markers if not (mk.name.startswith("Step_") or mk.name in ("Hit", "Dead", "Strike", "Impact"))]
    r = fn(name=name, **{k: v for k, v in p.items() if k != "target" or v is not None})
    act = _action(name)
    m = _meta(act)
    m.update(keep)
    _set_meta(act, m)
    for label, fr in events:
        event(name, label, frame=fr)
    return r


# ------------------------------------------------------------------------------------------------
# Checks over time
# ------------------------------------------------------------------------------------------------

def _segment_capsules(m):
    """A capsule (joint, a, b, radius) at rest around each joint's rigid parts."""
    with _RestPose(m.rig):
        return _segment_capsules_rest(m)


def _segment_capsules_rest(m):
    caps = []
    rig = m.rig
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or o.parent != rig or o.parent_type != "BONE" or not o.parent_bone:
            continue
        j = o.parent_bone
        me = o.data
        n = len(me.vertices)
        if n == 0:
            continue
        co = np.empty(n * 3)
        me.vertices.foreach_get("co", co)
        mw = np.array(o.matrix_world)
        P = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
        c = P.mean(axis=0)
        U, S, Vt = np.linalg.svd(P - c, full_matrices=False)
        ax = Vt[0]
        proj = (P - c) @ ax
        a, b = c + ax * np.percentile(proj, 8), c + ax * np.percentile(proj, 92)
        ab = b - a
        L2 = float(ab @ ab) or 1e-12
        tt = np.clip(((P - a) @ ab) / L2, 0, 1)
        r = 0.8 * float(np.percentile(np.linalg.norm(P - (a + tt[:, None] * ab), axis=1), 50))
        low = P[np.argsort(P[:, 2])[: min(64, n)]]
        caps.append({"joint": j, "a": Vector(a), "b": Vector(b), "r": max(r, 1e-4), "low": [Vector(p) for p in low], "mesh": o.name})
    return caps


def _cap_dist(p1, q1, p2, q2):
    """Closest distance between segments p1-q1 and p2-q2."""
    d1, d2, r = q1 - p1, q2 - p2, p1 - p2
    a, e, f = d1.dot(d1), d2.dot(d2), d2.dot(r)
    if a <= 1e-12 and e <= 1e-12:
        return (p1 - p2).length
    if a <= 1e-12:
        s, t = 0.0, max(0.0, min(1.0, f / e))
    else:
        c = d1.dot(r)
        if e <= 1e-12:
            t, s = 0.0, max(0.0, min(1.0, -c / a))
        else:
            b = d1.dot(d2)
            den = a * e - b * b
            s = max(0.0, min(1.0, (b * f - c * e) / den)) if den > 1e-12 else 0.0
            t = (b * s + f) / e
            if t < 0:
                t, s = 0.0, max(0.0, min(1.0, -c / a))
            elif t > 1:
                t, s = 1.0, max(0.0, min(1.0, (b - c) / a))
    return ((p1 + d1 * s) - (p2 + d2 * t)).length


def check(name):
    """Checks a clip over every frame: feet sliding while planted, parts dipping under the ground, rigid
    parts passing through each other, joints beyond their limits, jitter, and for loops a visible seam.
    Returns a report dict with a plain-language `summary` and the worst frames."""
    m = _Model()
    act = _action(name)
    meta = _meta(act)
    s, e = (int(round(v)) for v in act.frame_range)
    frames = list(range(s, e + 1))
    cur = read(name, frames)
    Gs = [m.fk({j: cur[j][i][0] for j in cur}, {j: cur[j][i][1] for j in cur if cur[j][i][1] is not None}) for i in range(len(frames))]
    L = m.L
    issues, report = [], {"clip": name, "frames": [s, e]}
    # Feet
    v = meta.get("speed") or 0.0
    turn_w = math.radians(meta.get("turn") or 0.0)
    turn_pivot = m.h0[m.root] if m.root else Vector((0.0, 0.0, 0.0))
    in_place = meta.get("in_place", True)
    gen = (meta.get("generator") or {}).get("name")
    feet = {}
    for lg in m.legs:
        last = lg["joints"][-1]
        tips = [G[last] @ lg["toe0"] for G in Gs]
        contact_eps = 0.04 * L
        worst, wf = 0.0, None
        contacts = 0
        rest_z = lg["toe0"].z
        low = [tp.z - rest_z < contact_eps for tp in tips]
        n_t = len(tips)
        looping = meta.get("loop", True) and n_t > 3
        # A loop's last frame is its first: neighbours wrap around (skipping the duplicate frame).
        at = (lambda k: low[k % (n_t - 1)]) if looping else (lambda k: low[k] if 0 <= k < n_t else True)
        zs = [tp.z for tp in tips]
        zat = (lambda k: zs[k % (n_t - 1)]) if looping else (lambda k: zs[min(max(k, 0), n_t - 1)])
        still = 0.004 * L  # a planted foot doesn't rise or sink: a slow, long step starts and ends low but is already moving

        def level(k):
            return abs(zat(k) - zat(k - 1)) < still

        for i in range(1, n_t):
            # Planted: low and level on this frame and its neighbours (not a foot skimming in or out of a step).
            if gen == "death":
                break
            if low[i] and low[i - 1] and at(i + 1) and at(i - 2) and level(i) and level(i + 1) and level(i - 1):
                contacts += 1
                prev = tips[i - 1]
                if in_place and turn_w:  # the ground turns under a turning walker
                    prev = turn_pivot + Quaternion(m.up, -turn_w / FPS) @ (prev - turn_pivot)
                d = tips[i] - prev
                if in_place and v:
                    d = d + m.fwd * (v / FPS)
                d.z = 0
                slide = d.length * FPS  # units per second
                if slide > worst:
                    worst, wf = slide, frames[i]
        feet[lg["name"]] = {"slide_speed": round(worst, 4), "worst_frame": wf, "contact_frames": contacts}
        if worst > 0.25 * L and contacts:
            issues.append(f"foot of {lg['name']} slides at {worst:.2f} units/s while planted (frame {wf})")
    report["feet"] = feet
    # Ground and self-intersection
    caps = _segment_capsules(m)
    below, bf, bw = 0.0, None, None
    hits = {}
    for i, G in enumerate(Gs):
        for c in caps:
            Gj = G[c["joint"]]
            z = min((Gj @ p).z for p in c["low"]) if c["low"] else 0.0
            if m.ground - z > below:
                below, bf, bw = m.ground - z, frames[i], c["mesh"]
        if i % 2:
            continue
        for x in range(len(caps)):
            for y in range(x + 1, len(caps)):
                A, B = caps[x], caps[y]
                ja, jb = A["joint"], B["joint"]
                if ja == jb or m.parent.get(ja) == jb or m.parent.get(jb) == ja or m.parent.get(ja) == m.parent.get(jb) == None:
                    continue
                if m.parent.get(m.parent.get(ja) or "") == jb or m.parent.get(m.parent.get(jb) or "") == ja:
                    continue  # two joints apart in one limb (thigh and foot): the joint between them decides
                d = _cap_dist(G[ja] @ A["a"], G[ja] @ A["b"], G[jb] @ B["a"], G[jb] @ B["b"])
                d0 = _cap_dist(A["a"], A["b"], B["a"], B["b"])
                pen = (A["r"] + B["r"]) - d
                pen0 = (A["r"] + B["r"]) - d0
                if pen > 0.35 * (A["r"] + B["r"]) and pen > pen0 + 0.15 * (A["r"] + B["r"]):
                    key = (A["mesh"], B["mesh"])
                    if key not in hits or pen > hits[key][0]:
                        hits[key] = (pen, frames[i])
    if below > 0.03 * L:
        issues.append(f"{bw} dips {below:.3f} units under the ground (frame {bf})")
    report["ground"] = {"deepest": round(below, 4), "frame": bf, "part": bw}
    worst_hits = sorted(hits.items(), key=lambda kv: -kv[1][0])[:6]
    for (a, b), (pen, f) in worst_hits:
        issues.append(f"{a} passes into {b} (frame {f}, {pen:.3f} deep)")
    report["collisions"] = [{"a": a, "b": b, "depth": round(pen, 4), "frame": f} for (a, b), (pen, f) in worst_hits]
    # Limits and jitter (a strike's snap at an event such as "Hit" is intended)
    over = []
    jit = []
    near_event = {mk.frame + d for mk in act.pose_markers if not mk.name.startswith("Step_") for d in range(-3, 4)}
    for j in m.names:
        seq = cur[j]
        lim = m.limits.get(j)
        kind = m.kind.get(j)
        angs = []
        for i, (q, _) in enumerate(seq):
            if kind == "hinge":
                ax = m.axis[j]
                a = 2 * math.atan2(Vector((q.x, q.y, q.z)).dot(ax), q.w)
                angs.append(math.degrees(a))
                if lim and not isinstance(lim[0], (list, tuple)):
                    lo, hi = min(lim), max(lim)
                    dev = max(lo - math.degrees(a), math.degrees(a) - hi)
                    if dev > 8:
                        over.append((dev, j, frames[i]))
            else:
                angs.append(math.degrees(q.angle))
                if kind == "ball" and lim and isinstance(lim[0], (list, tuple)):
                    eul = q.to_euler("XYZ")
                    dev = max(max(lim[0][k] - math.degrees(eul[k]), math.degrees(eul[k]) - lim[1][k]) for k in range(3))
                    if dev > 8:
                        over.append((dev, j, frames[i]))
        if len(angs) > 4:
            a = np.unwrap(np.radians(np.array(angs)))
            acc = np.abs(np.diff(np.degrees(a), 2))
            med = float(np.median(acc)) + 0.2
            p90 = float(np.percentile(acc, 90)) if len(acc) >= 5 else 0.0
            for k in np.argsort(-acc)[:3]:
                k = int(k)
                if frames[k + 1] in near_event:
                    continue
                if acc[k] > max(15.0, 8 * med, 2.5 * p90):
                    jit.append((float(acc[k]), j, frames[k + 1]))
                break
    for dev, j, f in sorted(over, reverse=True)[:4]:
        issues.append(f"{j} bends {dev:.0f} degrees past its limit (frame {f})")
    for a, j, f in sorted(jit, reverse=True)[:4]:
        issues.append(f"{j} jerks at frame {f} (a sudden {a:.0f} degree/frame^2 change)")
    # Loop seam
    if meta.get("loop", True) and len(frames) > 2:
        worst, wj = 0.0, None
        for j in m.names:
            q0, q1 = cur[j][0][0], cur[j][-1][0]
            d = math.degrees(q0.rotation_difference(q1).angle)
            if d > worst:
                worst, wj = d, j
        if worst > 3:
            issues.append(f"the loop has a seam: {wj} is {worst:.0f} degrees off between the last and first frame")
        report["loop_seam_deg"] = round(worst, 2)
        if meta.get("in_place", True):
            gap, gj = 0.0, None
            for j in m.names:
                t0_, t1_ = cur[j][0][1], cur[j][-1][1]
                d = ((t1_ or Vector()) - (t0_ or Vector())).length
                if d > gap:
                    gap, gj = d, j
            if gap > 0.02 * m.L:
                issues.append(f"the loop has a seam: {gj} ends {gap:.3g} units from where it starts")
    report["issues"] = issues
    report["ok"] = not issues
    report["summary"] = ("Clip %s (frames %d-%d): " % (name, s, e)) + ("no problems found." if not issues else "; ".join(issues) + ".")
    return report


# ------------------------------------------------------------------------------------------------
# Export for the viewer (and a fingerprint so it's only redone when clips change)
# ------------------------------------------------------------------------------------------------

def clip_fingerprints():
    """{clip: a short hash that changes whenever that clip's keys, range, settings or events change}."""
    import hashlib
    rig = _rigmod().armature(False)
    out = {}
    if rig is None:
        return out
    for act in sorted((a for a in bpy.data.actions if "kiln_clip" in a and not a.name.startswith("_")), key=lambda a: a.name):
        h = hashlib.md5()
        h.update(repr((tuple(act.frame_range), act.get("kiln_clip", ""), sorted((m.name, m.frame) for m in act.pose_markers))).encode())
        try:
            bag = _bag(act, rig)
            for fc in bag.fcurves:
                n = len(fc.keyframe_points)
                h.update(fc.data_path.encode() + bytes([fc.array_index % 256]))
                if n:
                    co = np.empty(n * 2, dtype=np.float32)
                    fc.keyframe_points.foreach_get("co", co)
                    h.update(co.tobytes())
        except Exception:  # noqa: BLE001
            pass
        out[act.name] = h.hexdigest()[:12]
    return out


def fingerprint():
    """Changes whenever any clip, or the rig's joints, change."""
    import hashlib
    rig = _rigmod().armature(False)
    if rig is None:
        return ""
    rest = ";".join(f"{b.name}{tuple(round(v, 5) for v in b.head_local)}{tuple(round(v, 4) for v in b.tail_local)}{round(b.matrix_local.to_euler().y, 4)}{b.parent.name if b.parent else ''}" for b in rig.data.bones)
    return hashlib.md5((repr(sorted(clip_fingerprints().items())) + "#" + rest).encode()).hexdigest()[:16]


def export_json(path, fps=30):
    """All clips sampled for the live viewer (and anyone else): joints with rest pivots, and per clip the
    moving joints' [qw, qx, qy, qz, tx, ty, tz] rows (Blender world-aligned axes, see sample())."""
    rig = _rig()
    js = []
    for n in _rigmod().joints():
        b = rig.data.bones[n]
        js.append({"name": n, "parent": b.parent.name if b.parent else None, "head": [round(v, 5) for v in rig.matrix_world @ b.head_local]})
    out = {"version": 1, "fps": fps, "units": bpy.context.scene.get("kiln_units", "m"), "forward": list(_rigmod().forward()), "joints": js, "clips": []}
    for c in clips():
        data = sample(c["name"], fps=fps)
        tracks = {}
        for j, rows in data.items():
            arr = np.array(rows)
            if np.allclose(arr, [1, 0, 0, 0, 0, 0, 0], atol=1e-5):
                continue
            tracks[j] = [round(float(v), 5) for v in arr.ravel()]
        c = dict(c)
        c["samples"] = len(next(iter(data.values()))) if data else 0
        c["tracks"] = tracks
        out["clips"].append(c)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    return {"path": path, "clips": len(out["clips"])}
