"""
Roblox target for Kiln models (the projects Shuriken Studio exports to Roblox).

Roblox shows plain PBR only (SurfaceAppearance: colour, normal, roughness, metalness and an emissive
mask), lights models with a bright sky and flat ambient light, and adds no ambient occlusion. So a model
judged under a dark studio backdrop with clearcoat, subsurface and soft shadows looks washed out there.
This module gives Kiln three things for that target:

  preview(lighting)  light a render like a Roblox place and strip what Roblox can't show (a context manager)
  check()            what in the scene won't survive the trip: lost shader features, risky values, budgets
  export(out_dir)    the baked copy an exporter uploads: one texture atlas per material with unique UVs,
                     ambient occlusion multiplied into the colour, procedural textures flattened to images
                     (it rewrites meshes and materials: run it on a COPY of the scene, see roblox_export.py)

Colours in a `lighting` dict are Roblox Color3 values as [r, g, b] in 0-1 (sRGB), straight from Studio.
"""

import contextlib
import json
import math
import os
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
PREFIX = "_kiln_rbx_"
UV_NAME = "RobloxUV"
SRC_UV = "KilnSrcUV"
ORCO, OBJCO = "kiln_orco", "kiln_objco"
PROCEDURAL = {"TEX_NOISE", "TEX_VORONOI", "TEX_WAVE", "TEX_MAGIC", "TEX_CHECKER", "TEX_BRICK", "TEX_GRADIENT", "TEX_GABOR", "TEX_MUSGRAVE"}
QR_RULE = 'Roblox removes any image with a QR code as "directing users off-platform", and the removal counts against the uploader\'s account. Repaint it: a contactless-wave icon, a blank reader, or plain panel detail.'
STUD = 0.28  # meters
MAX_PART = 2048  # studs on a side
# Enum.Material: what surface() accepts.
MATERIALS = ("Plastic", "SmoothPlastic", "Neon", "Wood", "WoodPlanks", "Marble", "Basalt", "Slate", "CrackedLava", "Concrete", "Limestone", "Granite",
             "Pavement", "Brick", "Pebble", "Cobblestone", "Rock", "Sandstone", "CorrodedMetal", "DiamondPlate", "Foil", "Metal", "Grass", "LeafyGrass",
             "Sand", "Fabric", "Snow", "Mud", "Ground", "Asphalt", "Salt", "Ice", "Glacier", "Glass", "ForceField", "Cardboard", "Carpet", "CeramicTiles",
             "ClayRoofTiles", "RoofShingles", "Leather", "Plaster", "Rubber")

# A new Roblox place (Baseplate template).
DEFAULT_LIGHTING = {
    "brightness": 3.0,
    "ambient": [0.275, 0.275, 0.275],
    "outdoorAmbient": [0.275, 0.275, 0.275],
    "clockTime": 14.5,
    "latitude": 0.0,
    "envDiffuse": 1.0,
    "envSpecular": 1.0,
    "exposure": 0.0,
    "atmosphere": {"density": 0.3, "offset": 0.25, "haze": 0.0, "glare": 0.0, "color": [0.78, 0.78, 0.78], "decay": [0.416, 0.439, 0.49]},
    "bloom": {"intensity": 1.0, "size": 24, "threshold": 2.0},
    "colorCorrection": None,
}

# Principled inputs Roblox has no equivalent for (label shown in the check).
LOST = (("Coat Weight", "clearcoat"), ("Sheen Weight", "sheen"), ("Subsurface Weight", "subsurface scattering"),
        ("Transmission Weight", "transmission (glass)"), ("Anisotropic", "anisotropy"))


def _s2l(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((np.maximum(c, 0) + 0.055) / 1.055) ** 2.4)


def _l2s(c):
    c = np.clip(np.asarray(c, dtype=np.float64), 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def _lerp(a, b, t):
    return np.asarray(a, dtype=np.float64) * (1 - t) + np.asarray(b, dtype=np.float64) * t


def _smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def lighting(l=None):
    """A place's Lighting with Roblox's defaults filled in for whatever is missing."""
    out = json.loads(json.dumps(DEFAULT_LIGHTING))
    for k, v in (l or {}).items():
        if k not in out:
            continue
        if isinstance(out[k], dict) or k in ("atmosphere", "bloom", "colorCorrection"):
            if v is None:
                out[k] = None
            elif isinstance(v, dict):
                base = out[k] if isinstance(out[k], dict) else {}
                out[k] = {**base, **{a: b for a, b in v.items() if b is not None}}
        elif v is not None:
            out[k] = v
    return out


def look(l=None):
    """The numbers both previews are built from (Blender renders here, the live viewer in
    src/renderer/app/viewer/roblox.ts: keep the two in step). Colours are linear RGB."""
    L = lighting(l)
    hour = math.radians((float(L["clockTime"]) - 12.0) * 15.0)
    lat = math.radians(float(L["latitude"]))
    sin_e = math.cos(lat) * math.cos(hour)  # the sun's height at the equinox
    night = sin_e <= 0.0
    elev = math.asin(max(0.02, min(1.0, abs(sin_e))))
    k = _smooth(math.degrees(elev) / 20.0)  # 0 at the horizon, 1 from 20 degrees up
    b = float(L["brightness"])
    if night:
        sun_color, sun_strength, day = np.array([0.55, 0.65, 1.0]), 0.12 * b, 0.04
    else:
        sun_color, sun_strength, day = _lerp([1.0, 0.62, 0.36], [1.0, 0.96, 0.9], k), 1.05 * b * (0.25 + 0.75 * k), 0.35 + 0.65 * k
    atmo = L["atmosphere"] or {}
    haze = max(0.0, min(1.0, float(atmo.get("haze", 0.0)) / 2.5))
    density = float(atmo.get("density", 0.0))
    atmo_color = _s2l(atmo.get("color", [0.78, 0.78, 0.78]))
    es = float(L["envSpecular"])
    zenith = np.array([0.12, 0.22, 0.48]) * day * es
    horizon = _lerp(np.array([0.55, 0.62, 0.72]), atmo_color * (0.9 + 0.5 * haze), 0.35 + 0.65 * haze) * day * es
    ground = np.array([0.10, 0.095, 0.09]) * day * es
    ambient = _s2l(L["outdoorAmbient"])
    return {
        "elevation": elev, "night": night, "sun_color": [float(x) for x in sun_color], "sun_strength": float(sun_strength),
        "ambient": [float(x) for x in ambient], "zenith": [float(x) for x in zenith], "horizon": [float(x) for x in horizon],
        "ground": [float(x) for x in ground], "exposure": float(L["exposure"]), "haze": haze,
        # Distance haze: thin at preview distances, but it lifts the darks of anything far away.
        "fog_color": [float(x) for x in _lerp(horizon, ambient, 0.25)], "fog_density": 0.0016 * density * (1.0 + 1.5 * haze),
    }


def describe(l=None):
    """One line about a place's lighting, for people (and the copilot)."""
    L, lk = lighting(l), look(l)
    deg = math.degrees(lk["elevation"])
    sun = "night (moonlight)" if lk["night"] else ("a low warm sun (%d° up)" % deg if deg < 20 else "sun %d° up" % deg)
    amb = float(np.mean(L["outdoorAmbient"]))
    atmo = L["atmosphere"] or {}
    haze = float(atmo.get("haze", 0.0))
    bits = ["brightness %.1f" % float(L["brightness"]), sun,
            "%s ambient light" % ("bright" if amb > 0.42 else "moderate" if amb > 0.2 else "dim"),
            "%s haze" % ("heavy" if haze > 1.2 else "some" if haze > 0.3 else "no")]
    if float(L["envSpecular"]) >= 0.7:
        bits.append("full sky reflections")
    return ", ".join(bits)


# ---------------------------------------------------------------------------------------------------
# Preview


def _output(m):
    nodes = m.node_tree.nodes
    return next((n for n in nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None) or next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)


def _principled(m):
    """The Principled BSDF that reaches the material's output (a material can hold spare ones)."""
    if m is None or m.node_tree is None:
        return None
    out = _output(m)
    if out is not None and out.inputs["Surface"].is_linked:
        first = out.inputs["Surface"].links[0].from_node
        if first.type == "BSDF_PRINCIPLED":
            return first
        hit = _upstream(out.inputs["Surface"], "BSDF_PRINCIPLED")
        if hit is not None:
            return hit
    return next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def _plain(m):
    """What Roblox would show of a material: no coat, sheen, subsurface, transmission or alpha, single-sided."""
    nt = m.node_tree
    for n in nt.nodes:
        if n.type != "BSDF_PRINCIPLED":
            continue
        coat = n.inputs.get("Coat Weight")
        coat_w = float(coat.default_value) if coat is not None and not coat.is_linked else (0.5 if coat is not None else 0.0)
        for key, _ in LOST:
            s = n.inputs.get(key)
            if s is None:
                continue
            for link in list(s.links):
                nt.links.remove(link)
            s.default_value = 0.0
        a = n.inputs.get("Alpha")
        if a is not None:
            for link in list(a.links):
                nt.links.remove(link)
            a.default_value = 1.0
        for key, val in (("Specular IOR Level", 0.5), ("IOR", 1.5)):
            s = n.inputs.get(key)
            if s is not None and not s.is_linked:
                s.default_value = val
        # A coat reads as extra gloss: the export folds it into roughness the same way.
        r = n.inputs.get("Roughness")
        if coat_w > 0.02 and r is not None and not r.is_linked:
            r.default_value = float(r.default_value) * (1.0 - 0.3 * min(1.0, coat_w))
    m.use_backface_culling = True
    for attr, val in (("surface_render_method", "DITHERED"), ("blend_method", "OPAQUE")):
        try:
            setattr(m, attr, val)
        except Exception:  # noqa: BLE001
            pass


def _world(lk):
    w = bpy.data.worlds.new(PREFIX + "world")
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = -1.0, 1.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    stops = [(0.0, lk["ground"]), (0.49, lk["ground"]), (0.505, lk["horizon"]), (0.66, _lerp(lk["horizon"], lk["zenith"], 0.6)), (1.0, lk["zenith"])]
    while len(cr.elements) < len(stops):
        cr.elements.new(0.5)
    for el, (pos, col) in zip(cr.elements, stops):
        el.position = pos
        el.color = (float(col[0]), float(col[1]), float(col[2]), 1.0)
    add = nt.nodes.new("ShaderNodeMixRGB")
    add.blend_type = "ADD"
    add.inputs["Fac"].default_value = 1.0
    add.inputs["Color2"].default_value = (*lk["ambient"], 1.0)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 1.0
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], add.inputs["Color1"])
    nt.links.new(add.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return w


@contextlib.contextmanager
def preview(l=None, honest=True):
    """Lights the scene like a Roblox place for a render: a sun at the place's time of day, its sky and
    flat ambient light, no ambient occlusion, the scene's own lights off (Roblox doesn't import them).
    honest=True also shows materials as Roblox would (see _plain). Everything is put back afterwards."""
    sc = bpy.context.scene
    lk = look(l)
    vs = sc.view_settings
    saved = {"world": sc.world, "view": (vs.view_transform, vs.look, vs.exposure, vs.gamma), "eevee": {}, "lights": []}
    temp_objects, temp_data, swaps, copies = [], [], [], {}
    try:
        for o in sc.objects:
            if o.type == "LIGHT" and not o.hide_render:
                saved["lights"].append(o)
                o.hide_render = True
        world = _world(lk)
        temp_data.append(world)
        sc.world = world
        sun_data = bpy.data.lights.new(PREFIX + "sun", "SUN")
        sun_data.energy = lk["sun_strength"]
        sun_data.color = lk["sun_color"]
        sun_data.angle = math.radians(3.0)
        sun = bpy.data.objects.new(PREFIX + "sun", sun_data)
        ce = math.cos(lk["elevation"])
        d = Vector((0.55 * ce, -0.835 * ce, math.sin(lk["elevation"]))).normalized()  # from the front right
        sun.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
        sc.collection.objects.link(sun)
        temp_objects.append(sun)
        temp_data.append(sun_data)
        for key, val in (("view_transform", "AgX"), ("look", "None"), ("exposure", lk["exposure"]), ("gamma", 1.0)):
            try:
                setattr(vs, key, val)
            except Exception:  # noqa: BLE001
                pass
        # Roblox reflects its sky only and has no contact occlusion: no screen-space tracing or fast GI.
        for key, val in (("use_raytracing", False), ("use_fast_gi", False)):
            if hasattr(sc.eevee, key):
                saved["eevee"][key] = getattr(sc.eevee, key)
                try:
                    setattr(sc.eevee, key, val)
                except Exception:  # noqa: BLE001
                    pass
        if honest:
            for ob in sc.objects:
                if ob.type not in MESHLIKE:
                    continue
                for i, slot in enumerate(ob.material_slots):
                    m = slot.material
                    if m is None or m.node_tree is None or m.name.startswith(PREFIX):
                        continue
                    c = copies.get(m.name)
                    if c is None:
                        c = m.copy()
                        c.name = PREFIX + m.name
                        _plain(c)
                        copies[m.name] = c
                    swaps.append((ob, i, m))
                    slot.material = c
        yield lk
    finally:
        for ob, i, m in swaps:
            try:
                ob.material_slots[i].material = m
            except Exception:  # noqa: BLE001
                pass
        for c in copies.values():
            try:
                bpy.data.materials.remove(c)
            except Exception:  # noqa: BLE001
                pass
        for o in saved["lights"]:
            o.hide_render = False
        for key, val in saved["eevee"].items():
            try:
                setattr(sc.eevee, key, val)
            except Exception:  # noqa: BLE001
                pass
        for key, val in zip(("view_transform", "look", "exposure", "gamma"), saved["view"]):
            try:
                setattr(vs, key, val)
            except Exception:  # noqa: BLE001
                pass
        sc.world = saved["world"]
        for ob in temp_objects:
            bpy.data.objects.remove(ob, do_unlink=True)
        for d in temp_data:
            try:
                (bpy.data.worlds if isinstance(d, bpy.types.World) else bpy.data.lights).remove(d)
            except Exception:  # noqa: BLE001
                pass


# ---------------------------------------------------------------------------------------------------
# Check


def _image_mean(img):
    """Average value of an image as the shader sees it: linear RGB for colour, raw for data."""
    if img is None or not img.size[0] or not img.size[1]:
        return None
    n = img.size[0] * img.size[1] * 4
    px = np.empty(n, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    if len(px) > 65536:
        px = px[:: len(px) // 65536]
    rgb = px[:, :3].astype(np.float64)
    data = img.colorspace_settings.name in ("Non-Color", "Raw", "Linear Rec.709", "Linear") or img.is_float
    return (rgb if data else _s2l(rgb)).mean(0)


def _upstream(sock, kind, depth=0, seen=None):
    """The first node of a type feeding a socket, or None."""
    seen = seen if seen is not None else set()
    for link in sock.links:
        n = link.from_node
        if n.name in seen or depth > 12:
            continue
        seen.add(n.name)
        if n.type == kind:
            return n
        for i in n.inputs:
            if i.is_linked:
                hit = _upstream(i, kind, depth + 1, seen)
                if hit is not None:
                    return hit
    return None


def _mean(sock):
    """(mean value as an array, source) of a Principled input; source is "value", "image" or "procedural"."""
    if sock is None:
        return None, "none"
    if not sock.is_linked:
        v = sock.default_value
        return (np.array(v[:3], dtype=np.float64) if hasattr(v, "__len__") else np.array([float(v)] * 3)), "value"
    tex = _upstream(sock, "TEX_IMAGE")
    if tex is not None and tex.image is not None:
        return _image_mean(tex.image), "image"
    try:
        from viewer_export import _as_color, _value  # Kiln's own approximation of procedural nodes
        c = _as_color(_value(sock, 0))
        if c is not None:
            return np.array(c[:3], dtype=np.float64), "procedural"
    except Exception:  # noqa: BLE001
        pass
    return None, "procedural"


def _lum(c):
    return float(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])


def _rig():
    r = bpy.data.objects.get("Rig")
    return r if r is not None and r.type == "ARMATURE" else None


def _segment(ob, rig):
    """The joint a mesh moves with: its bone parent, "skinned" for flesh, or None without a rig."""
    if rig is None:
        return None
    if any(md.type == "ARMATURE" for md in ob.modifiers):
        return "(skinned)"
    o = ob
    while o is not None:  # a part parented to a bound part moves with that joint too
        if o.parent == rig and o.parent_type == "BONE" and o.parent_bone:
            return o.parent_bone
        o = o.parent
    return "(not on the rig)"


def surface(material, roblox_material):
    """Leaves a material to one of Roblox's own (Asphalt, Grass, Rock, Concrete, Sand ...): the export
    gives that name and the colour instead of a texture. Roblox's materials tile crisply at any size and
    cost no uploads, which is what kilometres of ground and road need; keep textures for hero pieces.
    None takes the hint off. In Kiln the material looks as it did (its colour is what Roblox tints)."""
    import kiln
    m = kiln.mat(material) if isinstance(material, str) else material
    if roblox_material is None:
        if "roblox_material" in m:
            del m["roblox_material"]
        return m
    hit = next((n for n in MATERIALS if n.lower() == str(roblox_material).strip().lower().replace(" ", "")), None)
    if hit is None:
        raise ValueError('"%s" is not a Roblox material. One of: %s' % (roblox_material, ", ".join(MATERIALS)))
    m["roblox_material"] = hit
    return m


def check(tris_per_part=20000, max_texture=1024, max_joints=50, max_materials=6, units="studs"):
    """What won't survive the trip to Roblox. Returns {"problems": [...], "notes": [...], "summary": str}:
    problems change how the model looks or works in Roblox and are worth fixing; notes are for information."""
    sc = bpy.context.scene
    rig = _rig()
    dg = bpy.context.evaluated_depsgraph_get()
    problems, notes = [], []
    used, parts, skinned, no_uv, big = {}, {}, [], [], []
    per_data, shared, mirrored = {}, {}, []
    scanned = set()
    studs = 1.0 if units == "studs" else 1.0 / STUD
    for ob in sc.objects:
        if ob.type != "MESH" or not ob.visible_get() or ob.name.startswith("_kiln") or ob.get("kiln_role") == "collider":
            continue
        plain_copy = not len(ob.modifiers)
        key = ob.data.name if plain_copy else None
        if key is not None and key in per_data:
            tri_mat = per_data[key]
        else:
            me = ob.evaluated_get(dg).data
            if not len(me.polygons):
                continue
            me.calc_loop_triangles()
            tri_mat = np.empty(len(me.loop_triangles), dtype=np.int32)
            me.loop_triangles.foreach_get("material_index", tri_mat)
            if key is not None:
                per_data[key] = tri_mat
        if plain_copy:
            shared[key] = shared.get(key, 0) + 1
            if ob.data.users > 1 and ob.matrix_world.to_3x3().determinant() < 0:
                mirrored.append(ob.name)
        if max(ob.dimensions) * studs > MAX_PART:
            big.append("%s (%s studs)" % (ob.name, f"{max(ob.dimensions) * studs:,.0f}"))
        seg = _segment(ob, rig)
        if seg == "(skinned)":
            skinned.append(ob.name)
        slots = [s.material for s in ob.material_slots] or [None]
        textured = False
        for i, m in enumerate(slots):
            count = int((tri_mat == i).sum()) if len(slots) > 1 else len(tri_mat)
            if not count:
                continue
            name = m.name if m is not None else "(no material)"
            used.setdefault(name, {"material": m, "tris": 0, "objects": 0})
            used[name]["tris"] += count
            used[name]["objects"] += 1
            key2 = (seg if rig is not None else ob.name, name)
            parts[key2] = parts.get(key2, 0) + count
            p = _principled(m)
            # Only an image needs UVs: a procedural texture reads the shape itself.
            textured = textured or (p is not None and any(s.is_linked and _upstream(s, "TEX_IMAGE") is not None for s in p.inputs))
        if textured and not len(ob.data.uv_layers):
            no_uv.append(ob.name)

    for name, u in sorted(used.items()):
        m = u["material"]
        p = _principled(m)
        if m is None or p is None:
            problems.append('"%s" has no Principled material: Roblox gets a plain grey part. Give it one (kiln.mat / kiln.material).' % name)
            continue
        own = m.get("roblox_material")
        if own:
            notes.append('Material "%s" is left to Roblox\'s own %s (tinted with its colour): no texture is baked or uploaded for it.' % (name, own))
        lost = []
        for key, label in LOST:
            s = p.inputs.get(key)
            if s is not None and (s.is_linked or float(s.default_value) > 0.02):
                lost.append(label)
        if lost and not own:
            problems.append('Material "%s" uses %s: Roblox shows none of it. Get the look from base colour, roughness and the normal map instead.' % (name, ", ".join(lost)))
        a = p.inputs.get("Alpha")
        if a is not None and (a.is_linked or float(a.default_value) < 0.995):
            if _is_plain(m) and not a.is_linked:
                notes.append('Material "%s" is see-through: it exports as a transparent part of one colour (Roblox can\'t texture a see-through part).' % name)
            else:
                problems.append('Material "%s" is see-through (alpha): Roblox parts with textures are opaque. Make it opaque, or keep see-through pieces as their own untextured parts.' % name)
        glows, _strength, _linked = _glow(p)
        metal, _ = _mean(p.inputs.get("Metallic"))
        rough, rsrc = _mean(p.inputs.get("Roughness"))
        base, bsrc = _mean(p.inputs.get("Base Color"))
        mt = float(metal[0]) if metal is not None else 0.0
        if own:
            continue
        if 0.15 < mt < 0.85:
            problems.append('Material "%s" has metalness %.2f: Roblox metal is all or nothing. Use 1 for bare metal (with a light base colour) or 0 for painted, dirty or rusted metal.' % (name, mt))
        if rough is not None and float(rough[0]) < 0.22:
            problems.append('Material "%s" is very glossy (roughness %.2f): it mirrors Roblox\'s bright sky and turns milky. Keep roughness at 0.3 or more; use lower only on small wet or polished details.' % (name, float(rough[0])))
        if base is not None:
            lum = _lum(base)
            if mt >= 0.85 and lum < 0.06:
                problems.append('Material "%s" is metal with a dark base colour (%s): in Roblox that reads as black plastic. Bare metal needs a light base colour (#aaa to #eee); for dark metal use metalness 0 with roughness 0.5 to 0.8.' % (name, _hex(base)))
            elif mt >= 0.85 and lum < 0.18:
                notes.append('Material "%s" is a dark metal (%s): it will look duller in Roblox than here. A lighter base colour gives more metallic sheen.' % (name, _hex(base)))
            elif mt < 0.85 and lum < 0.012 and not glows:
                notes.append('Material "%s" is nearly black (%s): Roblox\'s ambient light and haze lift blacks to grey; a dark colour with some value variation holds up better.' % (name, _hex(base)))
        if "procedural" in (bsrc, rsrc):
            notes.append('Material "%s" is procedural: the Roblox export bakes it to images (it stays flat in the live viewer).' % name)
        for n in m.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image is not None and max(n.image.size) > max_texture:
                notes.append('Image "%s" is %d px: Roblox keeps at most %d.' % (n.image.name, max(n.image.size), max_texture))
            if n.type == "TEX_IMAGE" and n.image is not None and n.image.name not in scanned:
                scanned.add(n.image.name)
                try:
                    import kiln_content
                    for hit in kiln_content.scan_image(n.image):
                        problems.append('Image "%s" (material "%s") holds %s. %s' % (n.image.name, name, hit, QR_RULE))
                except Exception:  # noqa: BLE001
                    pass
        if glows:
            notes.append('Material "%s" glows: it is exported as an emissive mask (keep glowing parts in their own material).' % name)

    over = sorted(((k, v) for k, v in parts.items() if v > tris_per_part), key=lambda kv: -kv[1])
    if over:
        problems.append("Too many triangles for one Roblox part (%s at most per object or joint, and material): %s. Split the part (kiln.tile cuts ground into tiles), or kiln.decimate / kiln.bake it." % (
            f"{tris_per_part:,}", ", ".join("%s / %s: %s" % (seg, mat, f"{n:,}") for (seg, mat), n in over[:6])))
    if big:
        problems.append("Too big for one Roblox part (%s studs at most on a side): %s. kiln.tile(obj, size) cuts it into tiles." % (f"{MAX_PART:,}", _names(big, 6)))
    if skinned:
        problems.append("Skinned meshes (%s): Roblox parts are rigid, so flesh can't bend there. Build the body from overlapping pieces, each bound to one joint (kiln.rig.bind)." % _names(skinned))
    if rig is not None:
        loose = sorted({ob.name for ob in sc.objects if ob.type == "MESH" and ob.visible_get() and ob.get("kiln_role") != "collider" and _segment(ob, rig) == "(not on the rig)"})
        if loose:
            problems.append("Not bound to any joint (%s): they stay behind when the rig moves. kiln.rig.bind them." % _names(loose))
        joints = len(rig.data.bones)
        if joints > max_joints:
            problems.append("%d joints: keep a Roblox rig at %d or fewer." % (joints, max_joints))
    if no_uv:
        problems.append("Textured without UVs (%s): give them UVs (kiln.uv_box)." % _names(no_uv))
    if len(used) > max_materials:
        notes.append("%d materials: each one is extra Roblox parts and texture uploads; %d or fewer is better." % (len(used), max_materials))
    copies = sum(n for n in shared.values() if n > 1)
    if copies:
        notes.append("%d objects are copies of %d shared meshes: each mesh is uploaded once and cloned." % (copies, sum(1 for n in shared.values() if n > 1)))
    if mirrored:
        notes.append("Mirrored copies (%s): Roblox can't mirror a part, so each becomes its own mesh." % _names(mirrored, 5))
    layout = None
    try:
        import kiln_map
        layout = kiln_map.layout()
    except Exception:  # noqa: BLE001
        layout = None
    if layout is not None:
        if layout["placements"]:
            notes.append("%d placements of %d pieces: they export as data (which piece, where), not as geometry." % (len(layout["placements"]), sum(1 for p in layout["pieces"].values() if p["placements"])))
        stale = sorted(n for n, p in layout["pieces"].items() if p["stale"] and p["placements"])
        if stale:
            notes.append("Pieces whose own project has changed since they were brought in (%s): kiln.piece(\"<project id>\") again refreshes them." % _names(stale, 6))
        if layout["mirrored"]:
            problems.append("Mirrored placements (%s): a placed piece can't be mirrored. Give them a positive scale, or build the mirrored piece as its own project." % _names(layout["mirrored"], 6))
        layout = {"pieces": layout["pieces"], "placements": len(layout["placements"]), "markers": len(layout["markers"]), "paths": len(layout["paths"]),
                  "roles": len(layout["roles"]), "colliders": len(layout["colliders"])}
    total = sum(u["tris"] for u in used.values())
    summary = ("Roblox check: %d problem%s%s." % (len(problems), "" if len(problems) == 1 else "s", ", %d note%s" % (len(notes), "" if len(notes) == 1 else "s") if notes else "")
               if problems or notes else "Roblox check: ready (plain PBR materials, within budgets).")
    return {"problems": problems, "notes": notes, "summary": summary, "materials": len(used), "tris": total,
            "parts": len(parts), "meshes": len(shared), "joints": len(rig.data.bones) if rig is not None else 0, "layout": layout}


def _names(names, limit=8):
    return ", ".join(names[:limit]) + (" and %d more" % (len(names) - limit) if len(names) > limit else "")


def _hex(c):
    s = _l2s(np.asarray(c[:3], dtype=np.float64))
    return "#%02x%02x%02x" % tuple(int(round(max(0.0, min(1.0, float(x))) * 255)) for x in s)


# ---------------------------------------------------------------------------------------------------
# Export


def _cycles(samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    try:
        sc.cycles.use_denoising = False
    except Exception:  # noqa: BLE001
        pass
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
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


def _select(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def _object_mode():
    if bpy.context.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:  # noqa: BLE001
            pass


def _own_coords(me):
    """Stores each vertex's Generated and Object texture coordinates on the mesh. The bake joins every
    part into one stand-in, which would give procedural textures the stand-in's coordinates instead."""
    n = len(me.vertices)
    if not n:
        return
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    lo, hi = co.min(0), co.max(0)
    span = np.where(hi - lo > 1e-9, hi - lo, 1.0)
    for name, data in ((ORCO, (co - lo) / span), (OBJCO, co)):
        a = me.attributes.get(name) or me.attributes.new(name, "FLOAT_VECTOR", "POINT")
        a.data.foreach_set("vector", np.ascontiguousarray(data, dtype=np.float32).ravel())


def _pin_coords(materials):
    """Points every use of Generated or Object coordinates (named, or implied by a procedural texture with
    nothing plugged into its Vector) at the coordinates _own_coords stored. Returns how many it rewired."""
    done, changed = set(), [0]

    def walk(nt):
        if nt is None or nt.as_pointer() in done:
            return
        done.add(nt.as_pointer())
        made = {}

        def source(attr):
            if attr not in made:
                a = nt.nodes.new("ShaderNodeAttribute")
                a.attribute_type, a.attribute_name, a.name = "GEOMETRY", attr, PREFIX + attr
                made[attr] = a
            return made[attr].outputs["Vector"]

        for n in list(nt.nodes):
            if n.type == "GROUP":
                walk(n.node_tree)
            elif n.type == "TEX_COORD" and getattr(n, "object", None) is None:
                for out_name, attr in (("Generated", ORCO), ("Object", OBJCO)):
                    o = n.outputs.get(out_name)
                    for link in list(o.links) if o is not None else []:
                        to = link.to_socket
                        nt.links.remove(link)
                        nt.links.new(source(attr), to)
                        changed[0] += 1
            elif n.type in PROCEDURAL:
                v = n.inputs.get("Vector")
                if v is not None and not v.is_linked:
                    nt.links.new(source(ORCO), v)
                    changed[0] += 1

    for m in materials:
        walk(m.node_tree)
    return changed[0]


def _final_meshes(sc, log):
    """Every visible piece of geometry as a plain mesh object: curves and text converted, modifiers
    (all but the rig's) applied, object scale moved into the mesh. Objects that share one mesh keep
    sharing it (and keep their scale): an exporter uploads that mesh once. Hidden objects are removed.
    Returns (meshes to bake, colliders)."""
    _object_mode()
    for ob in list(sc.objects):
        if ob.type not in MESHLIKE:
            continue
        collider = ob.get("kiln_role") == "collider"
        if ob.name.startswith("_kiln") or ob.hide_viewport or not ob.visible_get() or (ob.hide_render and not collider):
            bpy.data.objects.remove(ob, do_unlink=True)
    others = [o for o in sc.objects if o.type in MESHLIKE and o.type != "MESH"]
    if others:
        _select(others)
        try:
            bpy.ops.object.convert(target="MESH")
        except Exception as e:  # noqa: BLE001
            log("could not convert %d curve/text objects: %s" % (len(others), e))
    found = [o for o in sc.objects if o.type == "MESH"]
    users = {}
    for ob in found:
        users[ob.data.name] = users.get(ob.data.name, 0) + 1
    kept = []
    for ob in found:
        arm = [md for md in ob.modifiers if md.type == "ARMATURE"]
        shared = users[ob.data.name] > 1
        mirrored = ob.matrix_world.to_3x3().determinant() < 0
        # Its own mesh: when modifiers shape it, when it is a mirrored copy (a game engine can't mirror a
        # part), or when the only other users are outside the scene.
        if len(ob.modifiers) > len(arm) or (shared and mirrored) or (not shared and ob.data.users > 1):
            shown = [(md, md.show_viewport) for md in arm]
            for md in arm:
                md.show_viewport = False
            dg = bpy.context.evaluated_depsgraph_get()
            me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            for md, s in shown:
                md.show_viewport = s
            for md in [md for md in ob.modifiers if md.type != "ARMATURE"]:
                ob.modifiers.remove(md)
            me.name = ob.data.name
            ob.data = me
        if len(ob.data.polygons):
            kept.append(ob)
        else:
            bpy.data.objects.remove(ob, do_unlink=True)
    users = {}
    for ob in kept:
        users[ob.data.name] = users.get(ob.data.name, 0) + 1
    datas = {ob.data.name: ob.data for ob in kept}
    for me in datas.values():
        _own_coords(me)
    # Scale into the mesh (parents first), so texel density follows real size and mirrored parts bake right.
    world = {o.name: o.matrix_world.copy() for o in sc.objects}
    names = {o.name for o in kept}

    def depth(o):
        n = 0
        while o.parent is not None:
            o, n = o.parent, n + 1
        return n

    for ob in sorted(sc.objects, key=depth):
        w = world[ob.name]
        if ob.type == "MESH" and ob.name in names and users[ob.data.name] == 1:
            loc, rot, scale = w.decompose()
            if max(abs(abs(s) - 1.0) for s in scale) > 1e-4 or min(scale) < 0:
                ob.data.transform(Matrix.Diagonal((scale.x, scale.y, scale.z, 1.0)))
                if scale.x * scale.y * scale.z < 0:
                    ob.data.flip_normals()
                w = Matrix.LocRotScale(loc, rot, (1.0, 1.0, 1.0))
        ob.matrix_world = w
        bpy.context.view_layer.update()
    colliders = [o for o in kept if o.get("kiln_role") == "collider"]
    return [o for o in kept if o.get("kiln_role") != "collider"], colliders


def _reps(meshes):
    """One object per mesh (the largest copy of a shared one) with its area factor: [(object, factor)]."""
    best = {}
    for ob in meshes:
        s = ob.matrix_world.to_scale()
        f = abs(s.x * s.y * s.z) ** (2.0 / 3.0)
        if ob.data.name not in best or f > best[ob.data.name][0]:
            best[ob.data.name] = (f, ob)
    return [(ob, f) for f, ob in best.values()]


def _select_faces(meshes, m):
    """In multi-object edit mode: selects exactly the faces that use material m. Returns whether there are any."""
    found = False
    for ob in meshes:
        idx = {i for i, s in enumerate(ob.material_slots) if s.material == m}
        bm = bmesh.from_edit_mesh(ob.data)
        for f in bm.faces:
            f.hide = False
            f.select = f.material_index in idx
            found = found or f.select
        bm.select_flush_mode()
        bmesh.update_edit_mesh(ob.data, loop_triangles=False, destructive=False)
    return found


def _unwrap(meshes, materials, sizes, log):
    """Unique UVs: every face of a material gets its own place in that material's atlas.
    Charts are cut on a smoothed copy of each shape: on the real surface, lumps, displacement and decimated
    triangles shatter Smart UV Project into hundreds of slivers; smoothed, a blob unwraps into a few big
    charts (boxes and cylinders, which smoothing only shrinks, unwrap as before). The smoothed shape is
    stretched back to the real one's size first, so charts keep their true scale.
    The mesh's own UV layers stay during the bake (materials may name them); the one textures read by
    default is copied to a layer every mesh shares, so the joined stand-in reads the right one."""
    rest = {}
    for ob in meshes:
        me = ob.data
        if UV_NAME in me.uv_layers:
            me.uv_layers.remove(me.uv_layers[UV_NAME])
        if not len(me.uv_layers):
            me.uv_layers.new(name="UVMap")
        src = (next((l for l in me.uv_layers if l.active_render), None) or me.uv_layers[0]).name
        while len(me.uv_layers) > 6:
            me.uv_layers.remove(me.uv_layers[next(l.name for l in reversed(list(me.uv_layers)) if l.name not in (src, SRC_UV))])
        if src != SRC_UV:
            uv = np.empty(len(me.loops) * 2, dtype=np.float32)
            me.uv_layers[src].uv.foreach_get("vector", uv)
            me.uv_layers.new(name=SRC_UV, do_init=False)
            me.uv_layers[SRC_UV].uv.foreach_set("vector", uv)
        me.uv_layers.new(name=UV_NAME)
        me.uv_layers.active = me.uv_layers[UV_NAME]  # bake target; textures keep reading the source layer (render-active)
        me.uv_layers[SRC_UV].active_render = True
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        rest[ob.name] = co
        bm = bmesh.new()
        bm.from_mesh(me)
        for _ in range(8):
            bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        soft = np.array([v.co[:] for v in bm.verts], dtype=np.float32).reshape(-1, 3)
        bm.free()
        real = co.reshape(-1, 3)
        lo, hi, slo, shi = real.min(0), real.max(0), soft.min(0), soft.max(0)
        span = shi - slo
        scale = np.where(span > 1e-6, (hi - lo) / np.maximum(span, 1e-6), 1.0)
        soft = (soft - (slo + shi) / 2) * scale + (lo + hi) / 2
        me.vertices.foreach_set("co", np.ascontiguousarray(soft, dtype=np.float32).ravel())
        me.update()
    for m in materials:
        # Only the meshes that wear this material go into edit mode (a map has hundreds of each).
        using = [ob for ob in meshes if any(s.material == m for s in ob.material_slots)]
        if not using:
            continue
        _select(using)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_mode(type="FACE")
        if _select_faces(using, m):
            # Charts 3 px apart: the bake pads each by 1 px, and every chart in an atlas is the same material,
            # so a little bleed between neighbours at small mip levels doesn't show.
            bpy.ops.uv.smart_project(angle_limit=math.radians(70), island_margin=3.0 / sizes[m.name], margin_method="FRACTION",
                                     area_weight=0.0, correct_aspect=False, scale_to_bounds=False)  # correct_aspect would squash charts by the source image's shape
        bpy.ops.object.mode_set(mode="OBJECT")
    for ob in meshes:
        ob.data.vertices.foreach_set("co", rest[ob.name])
        ob.data.update()


def _uv_area(meshes, m):
    """How much of its atlas a material's charts cover (0-1)."""
    total = 0.0
    for ob in meshes:
        me = ob.data
        idx = [i for i, s in enumerate(ob.material_slots) if s.material == m]
        if not idx:
            continue
        me.calc_loop_triangles()
        n = len(me.loop_triangles)
        loops = np.empty(n * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("loops", loops)
        mi = np.empty(n, dtype=np.int32)
        me.loop_triangles.foreach_get("material_index", mi)
        uv = np.empty(len(me.loops) * 2, dtype=np.float32)
        me.uv_layers[UV_NAME].uv.foreach_get("vector", uv)
        tri = uv.reshape(-1, 2)[loops].reshape(-1, 3, 2)[np.isin(mi, idx)]
        e1, e2 = tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
        total += float(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum() * 0.5)
    return total


def _area(reps, materials):
    """Surface area of each material at its real size (a shared mesh counts once, at its largest copy)."""
    out = {m.name: 0.0 for m in materials}
    for ob, f in reps:
        me = ob.data
        n = len(me.polygons)
        area = np.empty(n, dtype=np.float32)
        mi = np.empty(n, dtype=np.int32)
        me.polygons.foreach_get("area", area)
        me.polygons.foreach_get("material_index", mi)
        for i, s in enumerate(ob.material_slots):
            if s.material is not None and s.material.name in out:
                out[s.material.name] += float(area[mi == i].sum()) * f
    return out


def _tris(meshes):
    """({material: triangles}, {material: objects}, {mesh: triangles}), counting every placed copy."""
    per_data, tris, objs, mesh_tris = {}, {}, {}, {}
    for ob in meshes:
        me = ob.data
        if me.name not in per_data:
            n = len(me.polygons)
            lt = np.empty(n, dtype=np.int32)
            mi = np.empty(n, dtype=np.int32)
            me.polygons.foreach_get("loop_total", lt)
            me.polygons.foreach_get("material_index", mi)
            per_data[me.name] = np.bincount(mi, weights=lt - 2, minlength=max(1, len(ob.material_slots)))
            mesh_tris[me.name] = int((lt - 2).sum())
        counts = per_data[me.name]
        seen = set()
        for i, s in enumerate(ob.material_slots):
            if s.material is None or i >= len(counts) or not counts[i]:
                continue
            nm = s.material.name
            tris[nm] = tris.get(nm, 0) + int(counts[i])
            if nm not in seen:
                objs[nm] = objs.get(nm, 0) + 1
                seen.add(nm)
    return tris, objs, mesh_tris


def _fill(px, mask):
    """Fills the empty pixels of an (h, w, c) image from the nearest filled ones (push-pull through an image
    pyramid), so mipmaps don't pull black in at chart edges. Sizes are powers of two."""
    if mask.all():
        return px
    if not mask.any():
        return px
    levels = []
    c = np.where(mask[..., None], px, 0).astype(np.float32)
    a = mask
    while True:
        levels.append((c, a))
        h, w = a.shape
        if h < 2 or w < 2:
            break
        cs = c.reshape(h // 2, 2, w // 2, 2, -1).sum((1, 3))
        n = a.reshape(h // 2, 2, w // 2, 2).sum((1, 3))
        a = n > 0
        c = cs / np.maximum(n, 1)[..., None]
    cur = levels[-1][0]
    for c, a in reversed(levels[:-1]):
        up = np.repeat(np.repeat(cur, 2, 0), 2, 1)
        cur = np.where(a[..., None], c, up)
    return cur


def _pixels(img):
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def _set_pixels(img, px):
    img.pixels.foreach_set(np.ascontiguousarray(px, dtype=np.float32).ravel())
    img.update()


def _pow2(n, lo, hi):
    p = lo
    while p < n and p < hi:
        p *= 2
    return p


def _is_plain(m):
    """One flat colour: nothing plugged into the inputs Roblox reads."""
    p = _principled(m)
    if p is None:
        return True
    return not any(p.inputs[k].is_linked for k in ("Base Color", "Roughness", "Metallic", "Normal", "Emission Color", "Emission Strength") if k in p.inputs)


def _glow(p):
    """(glows, strength, strength is plugged in) of a Principled node."""
    es, ec = p.inputs.get("Emission Strength"), p.inputs.get("Emission Color")
    glows = es is not None and ec is not None and (es.is_linked or float(es.default_value) > 0.0) and (ec.is_linked or _lum(ec.default_value) > 0.001)
    if es is None:
        return glows, 1.0, False
    if es.is_linked:
        v, _ = _mean(es)
        return glows, max(1.0, float(v[0])) if v is not None else 1.0, True
    return glows, float(es.default_value), False


def export(out_dir, name="roblox", max_size=1024, density=None, ao=True, ao_strength=0.8, ao_samples=48, units="studs", source_version=None, plain=False, log=print):
    """Rewrites the open scene into its Roblox form and saves it as <out_dir>/<name>.blend with a manifest:
    every mesh final (modifiers applied), one image atlas per material (colour with ambient occlusion,
    normal, roughness, metalness and emissive where the material has them) on unique UVs, wired as plain
    image textures into a Principled BSDF. The rig and its clips are kept as they are.
    Objects that share a mesh keep sharing it; placed pieces, markers, tracks and roles (kiln.place,
    kiln.marker, kiln.track, kiln.role) go into the manifest as data.
    plain: one-colour materials stay untextured (the manifest gives their colour). A material with a
    "roblox_material" hint (surface()) is always left to Roblox's own material.
    density: texels per scene unit (default 48 per stud, 170 per meter); max_size caps each atlas (Roblox keeps 1024)."""
    t0 = time.time()
    sc = bpy.context.scene
    os.makedirs(out_dir, exist_ok=True)
    rig = _rig()
    if rig is not None:
        rig.data.pose_position = "REST"
    sc.frame_set(sc.frame_start)
    lay = None
    try:
        import kiln_map
        lay = kiln_map.layout()
    except Exception as e:  # noqa: BLE001
        log("no layout data: %s" % e)
    parts, fits = [], None
    try:
        import kiln_parts
        parts = kiln_parts.models()
        if any(s["mates"] for m in parts for s in m["sockets"]):
            fits = kiln_parts.fit_report()
    except Exception as e:  # noqa: BLE001
        log("no model data: %s" % e)
    meshes, colliders = _final_meshes(sc, log)
    log("prepared %d meshes in %.1fs" % (len(meshes), time.time() - t0))
    if not meshes:
        raise RuntimeError("nothing to export: the scene has no visible meshes")
    default = None
    for ob in meshes:
        if not len(ob.material_slots):
            ob.data.materials.append(None)
        for s in ob.material_slots:
            if s.material is None or _principled(s.material) is None:
                if default is None:
                    default = bpy.data.materials.new("Default")
                    default.use_nodes = True
                s.material = default
    materials = []
    for ob in meshes:
        for s in ob.material_slots:
            if s.material not in materials:
                materials.append(s.material)
    reps = _reps(meshes)
    rep_objs = [ob for ob, _ in reps]
    flat = {m.name: bool(m.get("roblox_material")) or (bool(plain) and _is_plain(m)) for m in materials}
    baked = [m for m in materials if not flat[m.name]]
    density = float(density or (48.0 if units == "studs" else 170.0))
    areas = _area(reps, materials)
    tri_count, obj_count, mesh_tris = _tris(meshes)
    sizes = {m.name: _pow2(math.sqrt(max(areas[m.name], 1e-6) / 0.6) * density, 64, int(max_size)) for m in baked}
    cover, info, device = {}, {}, None
    proxy = dummy = None
    temp = []
    if baked:
        t1 = time.time()
        pinned = _pin_coords(materials)
        _unwrap(rep_objs, baked, sizes, log)
        cover = {m.name: _uv_area(rep_objs, m) for m in baked}
        # The real fill is known now: size each atlas for the texel density asked for.
        for m in baked:
            sizes[m.name] = _pow2(math.sqrt(max(areas[m.name], 1e-6) / max(cover[m.name], 0.05)) * density, 64, int(max_size))
        log("unwrapped %d materials on %d meshes in %.1fs (atlas use %s)%s" % (
            len(baked), len(rep_objs), time.time() - t1, ", ".join("%s %d%%" % (k, round(v * 100)) for k, v in list(cover.items())[:12]),
            "; %d procedural coordinate links pinned" % pinned if pinned else ""))
        t1 = time.time()

        # One stand-in mesh for the bakes (baking 200 objects one by one takes minutes; one object takes seconds).
        # A shared mesh goes in once: its copies get the same texture.
        copies = []
        for ob in rep_objs:
            c = ob.copy()
            c.data = ob.data.copy()
            c.modifiers.clear()
            c.parent = None
            c.matrix_world = ob.matrix_world.copy()
            sc.collection.objects.link(c)
            copies.append(c)
        bpy.context.view_layer.update()
        _select(copies)
        if len(copies) > 1:
            bpy.ops.object.join()
        proxy = bpy.context.view_layer.objects.active
        proxy.name = PREFIX + "bake"
        proxy.data.uv_layers.active = proxy.data.uv_layers[UV_NAME]
        proxy.data.uv_layers[SRC_UV].active_render = True
        for ob in meshes + colliders:
            ob.hide_render = True
        for o in sc.objects:
            if o.type == "LIGHT":
                o.hide_render = True
        _select([proxy])
        log("joined the bake stand-in in %.1fs" % (time.time() - t1))
        device = _cycles(1)
        sc.render.bake.margin = 1
        sc.render.bake.use_clear = False
        try:
            sc.render.bake.margin_type = "EXTEND"
        except Exception:  # noqa: BLE001
            pass
        dummy = bpy.data.images.new(PREFIX + "dummy", 8, 8, alpha=True)
        for m in materials:
            nt = m.node_tree
            target = nt.nodes.new("ShaderNodeTexImage")
            target.name = PREFIX + "target"
            target.image = dummy
            nt.nodes.active = target
            if flat[m.name]:
                temp.append((nt, target))  # the bake wants an image in every material on the stand-in
                continue
            p = _principled(m)
            out = _output(m)
            surface = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].links else p.outputs[0]
            emit = nt.nodes.new("ShaderNodeEmission")
            emit.name = PREFIX + "emit"
            glows, strength, strength_linked = _glow(p)
            coat = p.inputs.get("Coat Weight")
            coat_w = 0.0 if coat is None else (0.5 if coat.is_linked else float(coat.default_value))
            alpha = p.inputs.get("Alpha")
            info[m.name] = {
                "material": m, "p": p, "target": target, "out": out, "surface": surface, "emit": emit, "size": sizes[m.name], "images": {},
                "glows": glows, "strength": strength, "strength_linked": strength_linked, "coat": max(0.0, min(1.0, coat_w)),
                "normal": p.inputs["Normal"].is_linked, "rough_map": p.inputs["Roughness"].is_linked, "metal_map": p.inputs["Metallic"].is_linked,
                "roughness": float(p.inputs["Roughness"].default_value), "metallic": float(p.inputs["Metallic"].default_value),
                "alpha": 1.0 if alpha is None or alpha.is_linked else float(alpha.default_value),
                "tint": None,
            }

    def bake(kind, colorspace, which, socket=None, **kw):
        """Bakes one map for the materials `which` selects; socket: bake that Principled input (through an
        emission shader, which records its value exactly) instead of a Cycles pass."""
        todo = [i for i in info.values() if which(i)]
        if not todo:
            return
        for i in info.values():
            nt = i["material"].node_tree
            nt.nodes.active = i["target"]
            if i in todo:
                img = bpy.data.images.new("%s_%s" % (i["material"].name, kind), i["size"], i["size"], alpha=True)
                img.colorspace_settings.name = colorspace
                px = np.zeros((i["size"], i["size"], 4), dtype=np.float32)
                _set_pixels(img, px)
                i["images"][kind] = img
                i["target"].image = img
            else:
                i["target"].image = dummy
            if socket is not None:
                s = i["p"].inputs.get(socket)
                e = i["emit"]
                for sock in (e.inputs["Color"], e.inputs["Strength"]):
                    for link in list(sock.links):
                        nt.links.remove(link)
                if s is not None and s.is_linked:
                    nt.links.new(s.links[0].from_socket, e.inputs["Color"])
                elif s is not None:
                    v = s.default_value
                    e.inputs["Color"].default_value = (v[0], v[1], v[2], 1.0) if hasattr(v, "__len__") else (float(v), float(v), float(v), 1.0)
                e.inputs["Strength"].default_value = 1.0
                # A glow whose strength is painted (a mask, a pattern): the image keeps colour x strength.
                if kind == "emissive" and i["strength_linked"]:
                    nt.links.new(i["p"].inputs["Emission Strength"].links[0].from_socket, e.inputs["Strength"])
                nt.links.new(e.outputs["Emission"], i["out"].inputs["Surface"])
            else:
                nt.links.new(i["surface"], i["out"].inputs["Surface"])
        t = time.time()
        bpy.ops.object.bake(type="EMIT" if socket is not None else kind.upper(), **kw)
        log("baked %s for %d material(s) in %.1fs" % (kind, len(todo), time.time() - t))
        if os.environ.get("KILN_ROBLOX_DEBUG"):
            for i in todo:
                px = _pixels(i["images"][kind])
                log("  %s %s: coverage %.3f mean %s dirty %s" % (i["material"].name, kind, float((px[..., 3] > 0.5).mean()), px[..., :3].mean((0, 1)).round(3).tolist(), i["images"][kind].is_dirty))

    if baked:
        sc.cycles.samples = 1
        bake("normal", "Non-Color", lambda i: i["normal"], normal_space="TANGENT")
        bake("color", "sRGB", lambda i: True, socket="Base Color")
        bake("roughness", "Non-Color", lambda i: i["rough_map"], socket="Roughness")
        bake("metalness", "Non-Color", lambda i: i["metal_map"], socket="Metallic")
        bake("emissive", "sRGB", lambda i: i["glows"], socket="Emission Color")
        if ao:
            lo = np.array([min((proxy.matrix_world @ Vector(c))[k] for c in proxy.bound_box) for k in range(3)])
            hi = np.array([max((proxy.matrix_world @ Vector(c))[k] for c in proxy.bound_box) for k in range(3)])
            if sc.world is None:
                sc.world = bpy.data.worlds.new(PREFIX + "world")
            sc.world.light_settings.distance = float(max(1e-3, np.linalg.norm(hi - lo) * 0.04))
            sc.cycles.samples = int(ao_samples)
            bake("ao", "Non-Color", lambda i: True)
            sc.cycles.samples = 1

    # Finish the maps: occlusion into the colour, coat into the roughness, padding around the islands.
    t1 = time.time()
    entries = {}
    for mname, i in info.items():
        m, size = i["material"], i["size"]
        maps = {}
        col = _pixels(i["images"]["color"])
        mask = col[..., 3] > 0.5
        if not mask.any():
            mask = np.ones(mask.shape, dtype=bool)
        rgb = col[..., :3].astype(np.float64)
        if ao and "ao" in i["images"]:
            occ = _pixels(i["images"]["ao"])[..., :1].astype(np.float64)
            occ = np.clip(occ, 0.0, 1.0)
            rgb = _l2s(_s2l(rgb) * (1.0 - ao_strength + ao_strength * occ))
            bpy.data.images.remove(i["images"].pop("ao"))
        col[..., :3] = _fill(rgb.astype(np.float32), mask)
        col[..., 3] = 1.0
        _set_pixels(i["images"]["color"], col)
        for kind in ("normal", "roughness", "metalness", "emissive"):
            img = i["images"].get(kind)
            if img is None:
                continue
            px = _pixels(img)
            v = px[..., :3]
            if kind == "roughness" and i["coat"] > 0.02:
                v = v * (1.0 - 0.3 * i["coat"])
            if kind == "normal":
                v = np.where(mask[..., None], v, np.array([0.5, 0.5, 1.0], dtype=np.float32))
            if kind == "emissive":
                lit = v[mask]
                peak = lit.max() if lit.size else 0.0
                if peak > 1e-4:
                    bright = lit[lit.max(1) > peak * 0.5]
                    tint = _s2l(bright.mean(0))
                    tint = tint / max(tint.max(), 1e-6)
                    i["tint"] = _hex(tint)
            px[..., :3] = _fill(np.ascontiguousarray(v, dtype=np.float32), mask)
            px[..., 3] = 1.0
            _set_pixels(img, px)
        if not i["rough_map"] and i["coat"] > 0.02:
            i["roughness"] *= 1.0 - 0.3 * i["coat"]

        # The material Roblox gets: image textures straight into a Principled BSDF, nothing else.
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        out.location = (400, 0)
        p = nt.nodes.new("ShaderNodeBsdfPrincipled")
        p.location = (0, 0)
        nt.links.new(p.outputs["BSDF"], out.inputs["Surface"])
        p.inputs["Roughness"].default_value = max(0.0, min(1.0, i["roughness"]))
        p.inputs["Metallic"].default_value = max(0.0, min(1.0, i["metallic"]))

        def tex(kind, y):
            img = i["images"][kind]
            path = os.path.join(out_dir, "%s.%s.png" % (_safe(mname), kind))
            img.filepath_raw = path
            img.file_format = "PNG"
            img.save()
            img.pack()
            maps[kind] = path
            n = nt.nodes.new("ShaderNodeTexImage")
            n.image, n.label, n.location = img, "kiln_%s" % kind, (-520, y)
            return n

        nt.links.new(tex("color", 300).outputs["Color"], p.inputs["Base Color"])
        if "roughness" in i["images"]:
            nt.links.new(tex("roughness", 20).outputs["Color"], p.inputs["Roughness"])
        if "metalness" in i["images"]:
            nt.links.new(tex("metalness", -260).outputs["Color"], p.inputs["Metallic"])
        if "normal" in i["images"]:
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.location = (-220, -540)
            nt.links.new(tex("normal", -540).outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
        if "emissive" in i["images"]:
            nt.links.new(tex("emissive", -820).outputs["Color"], p.inputs["Emission Color"])
            p.inputs["Emission Strength"].default_value = i["strength"]
            if i["tint"]:
                m["roblox_emissive_tint"] = i["tint"]
        if i["alpha"] < 0.995:
            m["roblox_transparency"] = round(1.0 - i["alpha"], 3)
        m.use_backface_culling = True
        for attr, val in (("surface_render_method", "DITHERED"), ("blend_method", "OPAQUE")):
            try:
                setattr(m, attr, val)
            except Exception:  # noqa: BLE001
                pass
        entries[mname] = {
            "name": mname, "plain": False, "roblox_material": None, "color": None, "size": size, "maps": maps, "roughness": None if "roughness" in maps else round(i["roughness"], 3),
            "metallic": None if "metalness" in maps else round(i["metallic"], 3), "emissive_strength": i["strength"] if "emissive" in maps else 0.0,
            "emissive_tint": i["tint"], "transparency": round(1.0 - i["alpha"], 3), "area": round(areas[mname], 3),
            "texels_per_unit": round(size * math.sqrt(max(cover[mname], 1e-6) / max(areas[mname], 1e-6)), 1), "atlas_use": round(cover[mname], 3),
            "tris": tri_count.get(mname, 0), "objects": obj_count.get(mname, 0),
        }

    # Untextured materials: the exporter colours the part (and may use one of Roblox's own materials).
    for nt, target in temp:
        nt.nodes.remove(target)
    for m in materials:
        if not flat[m.name]:
            continue
        p = _principled(m)
        base, _src = _mean(p.inputs.get("Base Color"))
        rough, _src = _mean(p.inputs.get("Roughness"))
        metal, _src = _mean(p.inputs.get("Metallic"))
        glows, strength, _linked = _glow(p)
        glow_col, _src = _mean(p.inputs.get("Emission Color")) if glows else (None, None)
        alpha = p.inputs.get("Alpha")
        a = 1.0 if alpha is None or alpha.is_linked else float(alpha.default_value)
        color = _hex(base) if base is not None else "#808080"
        m["roblox_color"] = color
        if a < 0.995:
            m["roblox_transparency"] = round(1.0 - a, 3)
        entries[m.name] = {
            "name": m.name, "plain": True, "roblox_material": m.get("roblox_material") or None, "color": color, "size": 0, "maps": {},
            "roughness": round(float(rough[0]), 3) if rough is not None else 0.5, "metallic": round(float(metal[0]), 3) if metal is not None else 0.0,
            "emissive_strength": strength if glows else 0.0, "emissive_tint": _hex(glow_col) if glow_col is not None else None,
            "transparency": round(1.0 - a, 3), "area": round(areas[m.name], 3), "texels_per_unit": 0, "atlas_use": 0,
            "tris": tri_count.get(m.name, 0), "objects": obj_count.get(m.name, 0),
        }
    manifest_mats = [entries[m.name] for m in materials]

    # What moderation would remove, looked for in the images as they will be uploaded.
    content = []
    try:
        import kiln_content
        for mname, i in info.items():
            for kind in ("color", "emissive"):
                img = i["images"].get(kind)
                for hit in (kiln_content.scan_image(img) if img is not None else []):
                    content.append({"material": mname, "map": kind, "problem": "%s. %s" % (hit, QR_RULE)})
    except Exception as e:  # noqa: BLE001
        log("content scan failed: %s" % e)
    for c in content:
        log("CONTENT: %s %s: %s" % (c["material"], c["map"], c["problem"]))
    log("finished and saved the maps in %.1fs" % (time.time() - t1))
    if proxy is not None:
        bpy.data.objects.remove(proxy, do_unlink=True)
    if dummy is not None:
        bpy.data.images.remove(dummy)
    for ob in meshes:
        ob.hide_render = False
    for ob in rep_objs:
        me = ob.data
        if UV_NAME in me.uv_layers:
            me.uv_layers[UV_NAME].active_render = True
            me.uv_layers.active = me.uv_layers[UV_NAME]
            for nm in [l.name for l in me.uv_layers if l.name != UV_NAME]:
                me.uv_layers.remove(me.uv_layers[nm])
        for nm in (ORCO, OBJCO):
            a = me.attributes.get(nm)
            if a is not None:
                me.attributes.remove(a)
    if rig is not None:
        rig.data.pose_position = "POSE"
    for o in sc.objects:
        if o.type == "LIGHT":
            o.hide_render = False
    blend = os.path.join(out_dir, "%s.blend" % name)
    bpy.ops.wm.save_as_mainfile(filepath=blend, check_existing=False, compress=True)
    clips = []
    try:
        import kiln_anim
        clips = [{"name": c["name"], "length": c.get("length"), "loop": c.get("loop"), "speed": c.get("speed")} for c in kiln_anim.clips()]
    except Exception:  # noqa: BLE001
        pass
    mesh_objects = {}
    for ob in meshes:
        mesh_objects.setdefault(ob.data.name, []).append(ob.name)
    kept = {ob.name for ob in meshes}
    lay = lay or {}
    manifest = {
        "version": 2, "plain": bool(plain), "blend": blend, "units": units, "studs_per_unit": 1.0 if units == "studs" else round(1.0 / STUD, 4),
        "source_version": source_version, "uv": UV_NAME, "ao": bool(ao),
        "materials": manifest_mats, "objects": len(meshes), "tris": sum(mm["tris"] for mm in manifest_mats),
        # Objects that share an entry here share one mesh in the .blend: upload it once and clone it.
        "meshes": {k: {"objects": v, "tris": mesh_tris.get(k, 0)} for k, v in sorted(mesh_objects.items())},
        "roles": {k: v for k, v in (lay.get("roles") or {}).items() if k in kept},
        "colliders": [c for c in (lay.get("colliders") or []) if c["name"] in {o.name for o in colliders}],
        "pieces": lay.get("pieces") or {}, "placements": lay.get("placements") or [], "mirrored_placements": lay.get("mirrored") or [],
        "markers": lay.get("markers") or [], "paths": lay.get("paths") or [],
        # Each top-level model (a variant, a part of a kit) with its origin, size, sockets and the meshes that make it up.
        "models": parts, "fit": fits,
        # Images Roblox moderation would remove (a QR code): do not upload these maps as they are.
        "content_problems": content,
        "joints": len(rig.data.bones) if rig is not None else 0, "clips": clips, "device": device, "seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(out_dir, "%s.json" % name), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    return manifest


def _safe(name):
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in name)
