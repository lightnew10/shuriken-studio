"""
Shuriken's Roblox export: a Blender scene as Roblox MeshParts, one per material (GLB + mesh JSON in
Roblox space). Used by Shuriken's own bridge (op "roblox") and, when Shuriken models in the user's Kiln
app, loaded into Kiln's Blender through Kiln's "ext" op — the one export for both engines.

Units are studs (1 Blender unit = 1 stud), Z up, a model's front faces Blender -Y; the export turns that
into Y up with the front facing Roblox's forward (-Z).
"""

import hashlib
import json
import os
import re
import struct
import zlib

import bpy
import numpy as np

MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT", "CURVES", "POINTCLOUD", "VOLUME"}


def object_mode():
    """Edits made in Edit Mode only reach the mesh (and the export) after leaving it."""
    try:
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:  # noqa: BLE001
        pass


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


# ---------------------------------------------------------------------------------------------
# Roblox export: one MeshPart per material
# ---------------------------------------------------------------------------------------------

# Enum.Material names, found by their letters in any case ("smooth plastic", "Wood Planks").
RBX_MATERIALS = [
    "Plastic", "SmoothPlastic", "Neon", "Wood", "WoodPlanks", "Marble", "Slate", "Concrete", "Granite", "Brick",
    "Pebble", "Cobblestone", "Rock", "Sandstone", "Basalt", "CrackedLava", "Limestone", "Pavement", "CorrodedMetal",
    "DiamondPlate", "Foil", "Metal", "Grass", "LeafyGrass", "Sand", "Fabric", "Snow", "Mud", "Ground", "Asphalt",
    "Salt", "Ice", "Glacier", "Glass", "ForceField", "Cardboard", "Carpet", "CeramicTiles", "ClayRoofTiles",
    "RoofShingles", "Leather", "Plaster", "Rubber",
]
RBX_BY_KEY = {re.sub(r"[^a-z]", "", m.lower()): m for m in RBX_MATERIALS}


def roblox_look(mat):
    """A Blender material as a MeshPart's Color, Material and Transparency (a "roblox_material" custom
    property on the material wins): emission glows as Neon, metal shines as Metal, see-through is Glass. Kiln's
    baked Roblox materials (roblox.blend) carry their see-through-ness in a custom property "roblox_transparency"
    (0-1), which becomes the part's Transparency (their Alpha is off)."""
    color, material, transparency = "#b8b8b8", "SmoothPlastic", 0.0
    if mat is None:
        return color, material, transparency
    p = principled(mat)
    if p:
        g = lambda k: p.inputs[k].default_value if k in p.inputs else None  # noqa: E731
        base = g("Base Color")
        if base is not None:
            color = linear_to_hex(base)
        es = float(g("Emission Strength") or 0)
        ec = g("Emission Color")
        alpha = float(g("Alpha") if g("Alpha") is not None else 1)
        if es > 0.05 and ec is not None and max(ec[:3]) > 0.02:
            material = "Neon"
            color = linear_to_hex(ec)
        elif float(g("Metallic") or 0) >= 0.5:
            material = "Metal"
        elif alpha < 0.95:
            material = "Glass"
            transparency = round(1 - alpha, 2)
    else:
        color = linear_to_hex(mat.diffuse_color)
    want = mat.get("roblox_material") if hasattr(mat, "get") else None
    if want:
        material = RBX_BY_KEY.get(re.sub(r"[^a-z]", "", str(want).lower()), material)
    see = mat.get("roblox_transparency") if hasattr(mat, "get") else None
    if see is not None:
        try:
            transparency = round(max(0.0, min(1.0, float(see))), 2)
        except (TypeError, ValueError):
            pass
    return color, material, transparency


def write_glb(path, positions, normals, indices, color=(0.8, 0.8, 0.8, 1.0), uvs=None, textures=None):
    """A minimal binary glTF: one mesh, one primitive, one material — plain (Studio sets the look), or
    textured: `uvs` (2 per vertex, top-left origin) and `textures` {"color", "normal", "mr"} as PNG
    bytes ("mr": glTF's metallic-roughness map, roughness in G and metalness in B)."""
    n = len(positions) // 3
    xs, ys, zs = positions[0::3], positions[1::3], positions[2::3]
    views, accessors, blobs = [], [], []
    offset = 0

    def add(data, target=None):
        nonlocal offset
        pad = (4 - offset % 4) % 4
        if pad:
            blobs.append(b"\x00" * pad)
            offset += pad
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            view["target"] = target
        blobs.append(data)
        offset += len(data)
        views.append(view)
        return len(views) - 1

    accessors.append({"bufferView": add(struct.pack("<%df" % len(positions), *positions), 34962), "componentType": 5126, "count": n, "type": "VEC3", "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]})
    accessors.append({"bufferView": add(struct.pack("<%df" % len(normals), *normals), 34962), "componentType": 5126, "count": n, "type": "VEC3"})
    accessors.append({"bufferView": add(struct.pack("<%dI" % len(indices), *indices), 34963), "componentType": 5125, "count": len(indices), "type": "SCALAR"})
    attributes = {"POSITION": 0, "NORMAL": 1}
    material = {"pbrMetallicRoughness": {"baseColorFactor": list(color), "metallicFactor": 0, "roughnessFactor": 0.8}}
    gltf = {
        "asset": {"version": "2.0", "generator": "Shuriken Studio (Blender)"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": attributes, "indices": 2, "material": 0}]}],
        "materials": [material],
    }
    if uvs is not None and textures:
        accessors.append({"bufferView": add(struct.pack("<%df" % len(uvs), *uvs), 34962), "componentType": 5126, "count": n, "type": "VEC2"})
        attributes["TEXCOORD_0"] = 3
        images, texs = [], []
        for key in ("color", "normal", "mr", "emission"):
            if textures.get(key):
                images.append({"bufferView": add(textures[key]), "mimeType": "image/png"})
                texs.append({"sampler": 0, "source": len(images) - 1})
                textures[key + "_index"] = len(texs) - 1
        gltf["images"], gltf["textures"] = images, texs
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        pbr = material["pbrMetallicRoughness"]
        if "color_index" in textures:
            pbr["baseColorTexture"] = {"index": textures["color_index"]}
            pbr["baseColorFactor"] = [1.0, 1.0, 1.0, color[3] if len(color) > 3 else 1.0]
        if "mr_index" in textures:
            pbr["metallicRoughnessTexture"] = {"index": textures["mr_index"]}
            pbr["metallicFactor"], pbr["roughnessFactor"] = 1.0, 1.0
        if "normal_index" in textures:
            material["normalTexture"] = {"index": textures["normal_index"]}
        if "emission_index" in textures:
            material["emissiveTexture"] = {"index": textures["emission_index"]}
            material["emissiveFactor"] = [1.0, 1.0, 1.0]
            if textures.get("emission_strength", 1.0) > 1.0:
                material["extensions"] = {"KHR_materials_emissive_strength": {"emissiveStrength": textures["emission_strength"]}}
                gltf["extensionsUsed"] = ["KHR_materials_emissive_strength"]
    buffer = b"".join(blobs)
    gltf["buffers"] = [{"byteLength": len(buffer)}]
    gltf["bufferViews"] = views
    gltf["accessors"] = accessors
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    buffer += b"\x00" * ((4 - len(buffer) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(buffer)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack("<II", len(buffer), 0x004E4942))
        f.write(buffer)


# ---------------------------------------------------------------------------------------------
# Textures: a material's image maps as PNG files (Roblox SurfaceAppearance maps) and in the GLB
# ---------------------------------------------------------------------------------------------

MAX_TEXTURE = 1024  # SurfaceAppearance maps are at most 1024 px on a side
MAX_PART_TRIS = 10000  # a MeshPart takes 20,000 (uploads); temporary meshes up to 12,000; a slab each beyond this
MAX_PART_SIZE = 2000.0  # a part is at most 2048 studs on a side: anything wider is cut into tiles of at most this
THROUGH = {"SEPARATE_COLOR", "SEPRGB", "SEPARATE_RGB", "MIX", "MIX_RGB", "HUE_SAT", "GAMMA", "BRIGHTCONTRAST", "CURVE_RGB", "INVERT", "VALTORGB"}


def _upstream_image(sock, depth=0):
    """The image texture node feeding a shader input, through a few colour nodes (their effect is dropped)."""
    if sock is None or not sock.is_linked or depth > 4:
        return None
    node = sock.links[0].from_node
    if node.type == "TEX_IMAGE":
        img = node.image
        return node if img is not None and img.size[0] > 0 and img.size[1] > 0 else None
    if node.type in THROUGH:
        for inp in node.inputs:
            if inp.is_linked:
                img = _upstream_image(inp, depth + 1)
                if img is not None:
                    return img
    return None


def texture_maps(mat):
    """The image texture nodes a material shows: base colour, normal (through a Normal Map node),
    roughness and metalness — the way kiln.pbr / kiln.material / kiln.textured wire them. {} when none."""
    p = principled(mat)
    if p is None:
        return {}
    out = {}
    color = _upstream_image(p.inputs.get("Base Color"))
    if color is not None:
        out["color"] = color
    ns = p.inputs.get("Normal")
    if ns is not None and ns.is_linked and ns.links[0].from_node.type == "NORMAL_MAP":
        img = _upstream_image(ns.links[0].from_node.inputs.get("Color"))
        if img is not None:
            out["normal"] = img
    for key, sock in (("roughness", "Roughness"), ("metalness", "Metallic")):
        img = _upstream_image(p.inputs.get(sock))
        if img is not None:
            out[key] = img
    # A glowing image (kiln.material "lava" wires its colour image into Emission Color too).
    strength = p.inputs.get("Emission Strength")
    if strength is not None and float(strength.default_value) > 0.05:
        img = _upstream_image(p.inputs.get("Emission Color"))
        if img is not None:
            out["emission"] = img
    return out


def emission_of(mat):
    """How a textured material glows, as SurfaceAppearance takes it: {"strength", "tint"} or None.
    An emission image glows by its brightness (the emissive map); a constant emission colour glows
    everywhere in that colour. A custom property "roblox_emissive_tint" ("#rrggbb") on the material sets
    the tint (EmissiveTint multiplies the glow) instead of the emission colour or white."""
    p = principled(mat)
    if p is None:
        return None
    strength = p.inputs.get("Emission Strength")
    color = p.inputs.get("Emission Color")
    s = float(strength.default_value) if strength is not None else 0.0
    if s <= 0.05 or color is None:
        return None
    custom = str(mat.get("roblox_emissive_tint") or "").strip().lower() if hasattr(mat, "get") else ""
    custom = custom if re.fullmatch(r"#[0-9a-f]{6}", custom) else None
    if color.is_linked:
        return {"strength": round(min(s, 10.0), 3), "tint": custom or "#ffffff"}
    if max(color.default_value[:3]) <= 0.02:
        return None
    return {"strength": round(min(s, 10.0), 3), "tint": custom or linear_to_hex(color.default_value)}


def vertex_color_layer(mat):
    """The colour attribute a material's Base Color reads (a Color Attribute / Attribute node), or None
    ("" for the mesh's active one). Its average becomes the part's colour."""
    p = principled(mat)
    sock = p.inputs.get("Base Color") if p is not None else None
    if sock is None or not sock.is_linked:
        return None
    node = sock.links[0].from_node
    if node.type == "VERTEX_COLOR":
        return getattr(node, "layer_name", "") or ""
    if node.type == "ATTRIBUTE" and getattr(node, "attribute_type", "GEOMETRY") == "GEOMETRY":
        return getattr(node, "attribute_name", "") or ""
    return None


def _num(p, *names):
    """(value, linked) of the first of these Principled BSDF inputs that exists; value is None for a colour."""
    for n in names:
        s = p.inputs.get(n)
        if s is not None:
            try:
                v = float(s.default_value)
            except (TypeError, ValueError):
                v = None
            return v, bool(s.is_linked)
    return None, False


def coat_of(mat):
    """The Principled BSDF's clear coat — the wet look of a creature — as (weight, roughness) when it is on
    and set by numbers (Blender 4's "Coat Weight" / "Coat Roughness", Blender 3's "Clearcoat" /
    "Clearcoat Roughness"), else None. Roblox has no coat: a textured material folds it into its roughness map."""
    p = principled(mat)
    if p is None:
        return None
    w, linked = _num(p, "Coat Weight", "Clearcoat")
    if w is None or linked or w <= 0.001:
        return None
    r, r_linked = _num(p, "Coat Roughness", "Clearcoat Roughness")
    return min(1.0, w), (0.03 if r is None or r_linked else min(1.0, max(0.0, r)))


def material_notes(mat, textured):
    """What a material has that a Roblox part can't show, in words (they go into the export's notes): Coat
    (folded into the roughness map of a textured material, dropped from a plain one), Sheen, Subsurface, a
    Bump node with no normal map and an Ambient Occlusion node."""
    p = principled(mat)
    if p is None:
        return []
    out = []
    cw, c_linked = _num(p, "Coat Weight", "Clearcoat")
    if cw is not None and (c_linked or cw > 0.001):
        coat = coat_of(mat)
        if coat is None:
            out.append("Coat is driven by a node, not a number: it isn't exported")
        elif textured:
            out.append("Coat (weight %.2f, roughness %.2f) is folded into the roughness map: Roblox has no clear coat" % coat)
        else:
            out.append("Coat (weight %.2f) is dropped: a plain part has no roughness, only its colour and Roblox Material (give the material image maps, kiln.pbr or kiln.textured, to carry a wet look)" % coat[0])
    for label, names, why in (
        ("Sheen", ("Sheen Weight", "Sheen"), "Roblox has no sheen"),
        ("Subsurface", ("Subsurface Weight", "Subsurface"), "Roblox has no subsurface scattering (fake the soft look in the colour)"),
    ):
        v, linked = _num(p, *names)
        if v is not None and (linked or v > 0.001):
            out.append("%s (%.2f) isn't exported: %s" % (label, v, why))
    ns = p.inputs.get("Normal")
    if ns is not None and ns.is_linked and ns.links[0].from_node.type == "BUMP":
        out.append("Bump isn't exported without a normal map: build the relief with kiln.pbr(..., height=...), which bakes one")
    if mat.node_tree and any(n.type == "AMBIENT_OCCLUSION" for n in mat.node_tree.nodes):
        out.append("An Ambient Occlusion node isn't exported: Roblox shades the model itself (paint the shade into the colour map if you want it)")
    return out


def _image_digest(img):
    """A hash of an image's pixels (b"" when it has none), so a retuned texture is a different texture."""
    try:
        w, h = img.size
        if w <= 0 or h <= 0:
            return b""
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        return hashlib.md5(px.tobytes()).digest()
    except Exception:  # noqa: BLE001
        return b""


def maps_fingerprint():
    """A hash of everything that decides the textures and look the export writes for the visible meshes'
    materials: the PIXELS of their image textures (not just their names), the numbers that become constant
    maps, the emission, the coat and the look. A scene fingerprint that only sees node names and sizes misses
    a texture retuned under the same name; this one doesn't, so such a change exports (and uploads) again."""
    h = hashlib.md5()
    done = set()
    for ob in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if ob.type not in MESHLIKE or not ob.visible_get() or ob.name.startswith("_"):
            continue
        for slot in ob.material_slots:
            mat = slot.material
            if mat is None or mat.name in done:
                continue
            done.add(mat.name)
            h.update(("%s|%s|%s|%s" % (mat.name, roblox_look(mat), emission_of(mat), coat_of(mat))).encode())
            p = principled(mat)
            if p is not None:
                for k in ("Roughness", "Metallic", "Emission Strength"):
                    s = p.inputs.get(k)
                    if s is not None and not s.is_linked:
                        h.update(("%s=%r" % (k, float(s.default_value))).encode())
            for key, node in sorted(texture_maps(mat).items()):
                img = node.image
                h.update(("%s|%s|%s|%s|" % (key, img.name, tuple(img.size), node.interpolation)).encode())
                h.update(_image_digest(img))
    return h.hexdigest()


def maps_fp():
    """maps_fingerprint() for Kiln's "ext" op (which wants a dict back)."""
    return {"fp": maps_fingerprint()}


def _srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0, None), 1 / 2.4) - 0.055)


def _pixels(node, colour):
    """An image texture as an (h, w, 4) float array, top row first, at most MAX_TEXTURE on a side
    (box-filtered). Colour maps come out sRGB (as a PNG stores them); data maps as they are. Crisp
    pixel art (Closest sampling, which Roblox doesn't have) is enlarged by whole pixels instead."""
    img = node.image
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)[::-1].astype(np.float64)
    if colour and img.is_float:
        a[..., :3] = _srgb(a[..., :3])
    f = int(np.ceil(max(w, h) / MAX_TEXTURE))
    if f > 1:
        hh, ww = (h // f) * f, (w // f) * f
        a = a[:hh, :ww].reshape(hh // f, f, ww // f, f, 4).mean(axis=(1, 3))
    elif node.interpolation == "Closest" and max(w, h) <= MAX_TEXTURE // 2:
        k = MAX_TEXTURE // max(w, h)
        a = np.repeat(np.repeat(a, k, axis=0), k, axis=1)
    return np.clip(a, 0, 1)


def png_bytes(a):
    """PNG bytes of an (h, w, 4) 0-1 array (8-bit RGBA, top row first)."""
    h, w = a.shape[:2]
    rgba = np.ascontiguousarray(np.round(np.clip(a, 0, 1) * 255).astype(np.uint8))
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def _gray(v, size=4):
    a = np.empty((size, size, 4))
    a[..., :3], a[..., 3] = float(v), 1.0
    return a


def write_textures(out_dir, base, mat):
    """A textured material's maps as <base>.<map>.png (color, normal, roughness, metalness — the last two
    as gray images, constant when the material only has a number) plus the GLB's packed maps. Returns
    ({map: file name}, {"color", "normal", "mr": PNG bytes, "average": the colour map's mean '#hex'}) or
    (None, None) for an untextured material."""
    maps = texture_maps(mat)
    if not maps:
        return None, None
    p = principled(mat)
    files, glb = {}, {}
    arrays = {}
    coat = coat_of(mat)
    for key in ("color", "normal", "roughness", "metalness", "emissive"):
        if key == "emissive":
            if "emission" not in maps:
                if emission_of(mat) is None:
                    continue
                a = _gray(1.0)  # one colour glowing everywhere: the tint carries its colour
            else:
                e = _pixels(maps["emission"], colour=True)
                a = np.empty_like(e)
                a[..., 0] = a[..., 1] = a[..., 2] = 0.2126 * e[..., 0] + 0.7152 * e[..., 1] + 0.0722 * e[..., 2]
                a[..., 3] = 1.0
                glb["emission"] = png_bytes(e)
        elif key in maps:
            a = _pixels(maps[key], colour=(key == "color"))
            if key in ("roughness", "metalness"):
                a[..., 0] = a[..., 1] = a[..., 2] = a[..., 0]
                a[..., 3] = 1.0
        else:
            if key in ("color", "normal"):
                continue
            sock = p.inputs.get("Roughness" if key == "roughness" else "Metallic") if p else None
            a = _gray(float(sock.default_value) if sock is not None else (0.5 if key == "roughness" else 0.0))
        if key == "roughness" and coat is not None:
            # A wet look: where the clear coat is, its roughness takes over (Roblox has no coat layer, only roughness).
            a = a.copy()
            a[..., :3] = a[..., :3] + (coat[1] - a[..., :3]) * coat[0]
        arrays[key] = a
        data = png_bytes(a)
        name = "%s.%s.png" % (base, key)
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(data)
        files[key] = name
        if key in ("color", "normal"):
            glb[key] = data
        if key == "color":
            glb["average"] = "#%02x%02x%02x" % tuple(int(round(float(c) * 255)) for c in a[..., :3].reshape(-1, 3).mean(axis=0))
    # glTF packs roughness (G) and metalness (B) into one map, both at the larger of their sizes.
    r, m = arrays["roughness"], arrays["metalness"]
    hh, ww = max(r.shape[0], m.shape[0]), max(r.shape[1], m.shape[1])

    def fit(a):
        return a[(np.arange(hh) * a.shape[0]) // hh][:, (np.arange(ww) * a.shape[1]) // ww]

    mr = np.zeros((hh, ww, 4))
    mr[..., 0], mr[..., 1], mr[..., 2], mr[..., 3] = 1.0, fit(r)[..., 0], fit(m)[..., 0], 1.0
    glb["mr"] = png_bytes(mr)
    return files, glb


# Blender (x, y, z) → Roblox: turned to face Roblox's forward, then Y up: (−x, z, y).
TO_RBX = np.array([[-1.0, 0, 0], [0, 0, 1.0], [0, 1.0, 0]])


def _rig_joints(scene):
    return [o for o in scene.objects if o.get("kiln_joint")]


def _segment_of(ob, root):
    """The joint a mesh moves with: its own tag, else its nearest joint ancestor, else the root."""
    if ob.get("kiln_segment"):
        return str(ob["kiln_segment"])
    p = ob.parent
    while p is not None:
        if p.get("kiln_joint"):
            return str(p["kiln_joint"])
        p = p.parent
    return root


def _write_rig(out_dir, name, joints, scene):
    """<name>.rig.json in Roblox space (studs, Y up): joints with pivots, axes and limits, the
    segment (part group) each one moves, legs and attachment points. See Kiln's docs/INTEGRATION.md."""
    def rbx(v):
        return [round(float(x), 4) for x in (TO_RBX @ np.array(v, dtype=np.float64))]

    out = {"version": 1, "model": name, "root": None, "joints": [], "legs": [], "attachments": []}
    for j in sorted(joints, key=lambda o: o.name):
        parent = j.parent.get("kiln_joint") if j.parent is not None else None
        if parent is None and out["root"] is None:
            out["root"] = str(j["kiln_joint"])
        limits = json.loads(j["kiln_limits"]) if j.get("kiln_limits") else None
        out["joints"].append({
            "name": str(j["kiln_joint"]), "parent": parent, "part": str(j["kiln_joint"]),
            "pivot": rbx(j.matrix_world.translation), "axis": rbx(j.get("kiln_axis", [1, 0, 0])),
            "kind": str(j.get("kiln_kind", "hinge")), "limits": limits,
        })
    try:
        out["legs"] = json.loads(scene.get("kiln_rig", "{}")).get("legs", [])
    except ValueError:
        out["legs"] = []
    for a in scene.objects:
        if a.get("kiln_attach"):
            seg = _segment_of(a, out["root"])
            out["attachments"].append({"name": str(a["kiln_attach"]), "part": seg, "position": rbx(a.matrix_world.translation)})
    with open(os.path.join(out_dir, name + ".rig.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return out


def _kiln_modules():
    """Kiln's rig and animation helpers (Kiln's own in its Blender, Shuriken's copies in its bridge)."""
    try:
        import kiln_rig
        import kiln_anim
        return kiln_rig, kiln_anim
    except Exception:  # noqa: BLE001
        return None, None


def _armature():
    kr, _ = _kiln_modules()
    if kr is None:
        return None
    try:
        return kr.armature(False)
    except Exception:  # noqa: BLE001
        return None


def export(dir, name):
    """The export (see _export_scene), plus "maps_fp": maps_fingerprint() of the scene it exported, which
    the engine keeps to notice a texture retuned later under the same names."""
    result = _export_scene(dir, name)
    if isinstance(result, dict) and result.get("parts"):
        result["maps_fp"] = maps_fingerprint()
    return result


def _export_scene(dir, name):
    """Every visible mesh, grouped by material into Roblox MeshParts. Each part gets a GLB and a mesh
    JSON in Roblox space (Y up, studs, centred on its own box), its centre within the model (Roblox
    space: the model's front, Blender -Y, faces Roblox's forward -Z), size, triangles and look.

    A rigged model is grouped by segment and then material instead, each part knows its "segment", and
    <name>.rig.json describes the joints. Kiln 0.7 rigs (an armature "Rig", read only through
    kiln.rig.info()) are exported at rest, and every clip (kiln.anim.clips / sample) becomes
    <name>.clips.json in Roblox space. Rigs of joint empties (Kiln 0.5-0.6) still export as before: a pose
    test left on the joints is muted for the export."""
    object_mode()
    scene = bpy.context.scene
    arm = _armature()
    if arm is not None:
        return _export_armature(dir, name, scene, arm)
    clips_file = os.path.join(dir, name + ".clips.json")
    if os.path.exists(clips_file):
        os.remove(clips_file)  # the model no longer has a rig of its own
    joints = _rig_joints(scene)
    muted = []
    if joints:
        for j in joints:
            if j.animation_data and j.animation_data.action:
                muted.append((j, j.animation_data.action, tuple(j.rotation_euler)))
                j.animation_data.action = None
                if j.get("kiln_rest") is not None:
                    j.rotation_euler = j["kiln_rest"]
        bpy.context.view_layer.update()
    root = None
    for j in joints:
        if j.parent is None or not j.parent.get("kiln_joint"):
            root = str(j["kiln_joint"])
            break
    try:
        result = _export(dir, name, scene, (lambda ob: _segment_of(ob, root)) if joints else (lambda ob: None), TO_RBX)
        if result.get("parts"):
            if joints:
                result["rig"] = _write_rig(dir, name, joints, scene)
            elif os.path.exists(os.path.join(dir, name + ".rig.json")):
                os.remove(os.path.join(dir, name + ".rig.json"))  # the model no longer has a rig
        return result
    finally:
        for j, action, rot in muted:
            j.animation_data.action = action
            j.rotation_euler = rot
        if muted:
            bpy.context.view_layer.update()


R15_NAMES = {"LowerTorso", "UpperTorso", "Head", "LeftUpperArm", "LeftLowerArm", "LeftHand", "RightUpperArm", "RightLowerArm",
             "RightHand", "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "RightUpperLeg", "RightLowerLeg", "RightFoot"}


def _yaw_to_front(forward):
    """A turn about Z that brings the model's forward (Blender) to -Y, the front the export expects."""
    f = np.array([float(forward[0]), float(forward[1]), 0.0])
    n = np.linalg.norm(f)
    if n < 1e-6:
        return np.eye(3)
    f /= n
    ang = np.arctan2(f[0], -f[1])  # angle from -Y to f, about +Z
    c, s_ = np.cos(-ang), np.sin(-ang)
    return np.array([[c, -s_, 0.0], [s_, c, 0.0], [0.0, 0.0, 1.0]])


def _export_armature(dir, name, scene, arm):
    kr, ka = _kiln_modules()
    prev = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    try:
        info = kr.info()
        to_rbx = TO_RBX @ _yaw_to_front(info.get("forward") or (0, -1, 0))
        joints = info["joints"]
        roots = [j["name"] for j in joints if not j["parent"]]
        root = roots[0] if roots else None
        seg_of = {}
        for jn, meshes in (info.get("segments") or {}).items():
            for m in meshes:
                seg_of[m] = jn
        skin = {s["mesh"]: [j for j in s["joints"]] for s in (info.get("skinned") or [])}

        def segment(ob):
            if ob.name in seg_of:
                return seg_of[ob.name]
            if ob.get("kiln_segment"):
                return str(ob["kiln_segment"])
            p = ob.parent
            while p is not None:
                if p.name in seg_of:
                    return seg_of[p.name]
                if p.get("kiln_segment"):
                    return str(p["kiln_segment"])
                p = p.parent
            return root

        result = _export(dir, name, scene, segment, to_rbx, skin=skin)
        if not result.get("parts"):
            return result
        result["rig"] = _write_rig_armature(dir, name, info, to_rbx, roots)
        if skin:
            result["notes"] = result.get("notes", []) + ["Skinned meshes (%s) were split into rigid pieces, one per joint they mostly follow: they bend at the seams, not smoothly (smooth skinning in Roblox comes later)." % ", ".join(sorted(skin))]
    finally:
        arm.data.pose_position = prev
        bpy.context.view_layer.update()
    result["clips"] = _write_clips(dir, name, arm, ka, to_rbx, result["rig"])
    result["anim_fp"] = _anim_fingerprint(ka)
    return result


def _anim_fingerprint(ka):
    try:
        return ka.fingerprint()
    except Exception:  # noqa: BLE001
        return None


def export_rig_clips(dir, name):
    """Only the rig and its clips (the parts stay as they were exported): what changes while someone
    animates. Returns the joints (a changed set means the parts need a full export too)."""
    object_mode()
    arm = _armature()
    if arm is None:
        return {"rig": None, "clips": [], "anim_fp": None}
    kr, ka = _kiln_modules()
    prev = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    try:
        info = kr.info()
        to_rbx = TO_RBX @ _yaw_to_front(info.get("forward") or (0, -1, 0))
        rig = _write_rig_armature(dir, name, info, to_rbx, [j["name"] for j in info["joints"] if not j["parent"]])
    finally:
        arm.data.pose_position = prev
        bpy.context.view_layer.update()
    clips = _write_clips(dir, name, arm, ka, to_rbx, rig)
    return {"rig": {"joints": [j["name"] for j in rig["joints"]]}, "clips": clips, "anim_fp": _anim_fingerprint(ka)}


def _write_rig_armature(out_dir, name, info, to_rbx, roots):
    """<name>.rig.json from kiln.rig.info() (Blender world space at rest) in Roblox space."""
    def rbx(v):
        return [round(float(x), 4) for x in (to_rbx @ np.array(v, dtype=np.float64))]

    names = [j["name"] for j in info["joints"]]
    r15 = R15_NAMES.issubset(names)
    out = {"version": 2, "model": name, "source": "kiln", "kind": "r15" if r15 else "custom", "root": roots[0] if roots else None, "joints": [], "legs": [], "attachments": []}
    extra_root = None
    if len(roots) > 1:
        # Roblox rigs have one root: the others hang from a still joint at the first root's pivot.
        extra_root = "Root" if "Root" not in names else "RigRoot"
        first = next(j for j in info["joints"] if j["name"] == roots[0])
        out["joints"].append({"name": extra_root, "parent": None, "part": extra_root, "pivot": rbx(first["pivot"]), "axis": [1, 0, 0], "kind": "fixed", "limits": None})
        out["root"] = extra_root
    for j in info["joints"]:
        out["joints"].append({
            "name": j["name"], "parent": j["parent"] or extra_root, "part": j["name"],
            "pivot": rbx(j["pivot"]), "axis": rbx(j.get("axis") or (1, 0, 0)), "tail": rbx(j["tail"]) if j.get("tail") else None,
            "kind": j.get("kind") or "ball", "limits": j.get("limits"),
        })
    out["legs"] = [{"joints": list(l["joints"]), "foot": l.get("foot") or l["joints"][-1]} for l in (info.get("legs") or []) if l.get("joints")]
    for a in info.get("attachments") or []:
        if a.get("joint"):
            out["attachments"].append({"name": str(a["name"]), "part": a["joint"], "position": rbx(a["position"])})
    with open(os.path.join(out_dir, name + ".rig.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return out


def _mat_to_quat(m):
    """Unit quaternion (w, x, y, z) of a 3x3 rotation matrix."""
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def _quat_to_mat(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def _euler_xyz(m):
    """Degrees (x, y, z) with m = Rx(x) Ry(y) Rz(z), i.e. CFrame.Angles(x, y, z)."""
    b = np.arcsin(max(-1.0, min(1.0, m[0, 2])))
    if abs(np.cos(b)) > 1e-6:
        a = np.arctan2(-m[1, 2], m[2, 2])
        c = np.arctan2(-m[0, 1], m[0, 0])
    else:
        a = np.arctan2(m[2, 1], m[1, 1])
        c = 0.0
    return [float(np.degrees(v)) for v in (a, b, c)]


def _nlerp(a, b, f):
    """The quaternion a fraction f of the way from a to b the way Roblox blends Linear keys: a straight
    blend of the two quaternions, renormalized, the shorter way round (not a slerp: 0 to 150 degrees reads 33
    degrees a quarter of the way, not 37.5 — measured in Studio)."""
    if float(np.dot(a, b)) < 0:
        b = -b
    q = a + (b - a) * f
    return q / np.linalg.norm(q)


def _reduce(qs, ts, rot_tol=0.35, pos_tol=0.006):
    """Frames to keep for one joint: the first and last, and every frame the straight blend (nlerp and
    lerp: how Roblox plays Linear keys, which the export writes) between its neighbours can't reproduce
    within tolerance (degrees, studs). Judging them against a slerp would keep too few frames across a big
    turn (Roblox's nlerp lags a slerp by several degrees there)."""
    n = len(qs)
    if n <= 2:
        return list(range(n))
    keep = [0]
    k = 0
    i = 2
    while i < n:
        ok = True
        for m in range(k + 1, i):
            f = (m - k) / (i - k)
            q = _nlerp(qs[k], qs[i], f)
            ang = np.degrees(2 * np.arccos(min(1.0, abs(float(np.dot(q, qs[m]))))))
            if ang > rot_tol or np.linalg.norm(ts[k] + (ts[i] - ts[k]) * f - ts[m]) > pos_tol:
                ok = False
                break
        if not ok:
            keep.append(i - 1)
            k = i - 1
        i += 1
    keep.append(n - 1)
    return keep


def _write_clips(out_dir, name, arm, ka, to_rbx, rig):
    """<name>.clips.json: every clip of the rig in Roblox space (Motor6D.Transform per joint as
    CFrame.Angles degrees + a pivot offset), keys reduced per joint, markers from the clip's events.
    Clips for Kiln's R15 rig are R15 clips (no rig; HumanoidRootPart dropped)."""
    path = os.path.join(out_dir, name + ".clips.json")
    try:
        clips = ka.clips()
    except Exception:  # noqa: BLE001
        clips = []
    try:
        fps_map = ka.clip_fingerprints()
    except Exception:  # noqa: BLE001
        fps_map = {}
    joint_names = [j["name"] for j in rig["joints"]]
    r15 = rig.get("kind") == "r15"
    # The armature's own transform (Kiln leaves it at the origin; an imported project may scale it).
    A = np.array(arm.matrix_world.to_3x3(), dtype=np.float64)
    s = float(np.cbrt(abs(np.linalg.det(A)))) or 1.0
    C = to_rbx @ (A / s)
    out = {"version": 1, "model": name, "kind": "r15" if r15 else "custom", "fps": 30, "clips": []}
    summary = []
    for c in clips:
        try:
            data = ka.sample(c["name"], fps=30)
        except Exception as e:  # noqa: BLE001
            summary.append({"name": c["name"], "error": str(e)[:200]})
            continue
        n = max((len(v) for v in data.values()), default=0)
        if n < 2:
            continue
        times = [round(i / 30.0, 4) for i in range(n)]
        tracks = {}
        # Every joint's motion in Roblox space: rotation matrices and pivot offsets per sample.
        motion = {}
        for j, rows in data.items():
            if j not in joint_names:
                continue
            arr = np.array(rows, dtype=np.float64)
            motion[j] = ([C @ _quat_to_mat(row[:4] / (np.linalg.norm(row[:4]) or 1.0)) @ C.T for row in arr], [s * (C @ row[4:7]) for row in arr])
        if r15 and "HumanoidRootPart" in motion and "LowerTorso" in motion:
            # Roblox moves an R15 body through the Root joint (HumanoidRootPart -> LowerTorso) and never
            # the HumanoidRootPart itself: fold whatever the rig root did into LowerTorso's pose.
            piv = {j["name"]: np.array(j["pivot"], dtype=np.float64) for j in rig["joints"]}
            ph, pl = piv["HumanoidRootPart"], piv["LowerTorso"]
            (rh, th), (rl, tl) = motion["HumanoidRootPart"], motion["LowerTorso"]
            motion["LowerTorso"] = ([rh[i] @ rl[i] for i in range(len(rl))], [ph + th[i] + rh[i] @ (pl + tl[i] - ph) - pl for i in range(len(tl))])
        for j, (mats, offs) in motion.items():
            if r15 and j == "HumanoidRootPart":
                continue
            if all(np.allclose(m, np.eye(3), atol=1e-5) for m in mats) and all(float(np.linalg.norm(t)) < 1e-5 for t in offs):
                continue
            qs = [_mat_to_quat(m) for m in mats]
            ts = list(offs)
            for i in range(1, len(qs)):
                if np.dot(qs[i], qs[i - 1]) < 0:
                    qs[i] = -qs[i]
            keep = _reduce(qs, ts)
            moves_pos = max(float(np.linalg.norm(t)) for t in ts) > 0.002
            if r15 and j != "LowerTorso":
                moves_pos = False  # R15 poses only move the root; the rest are rotations
            tracks[j] = {i: ({"rot": [round(v, 3) for v in _euler_xyz(_quat_to_mat(qs[i]))]} | ({"pos": [round(float(v), 4) for v in ts[i]]} if moves_pos else {})) for i in keep}
        if not tracks:
            tracks = {joint_names[0]: {0: {"rot": [0, 0, 0]}, n - 1: {"rot": [0, 0, 0]}}}
        frames = sorted({i for t in tracks.values() for i in t})
        keys = [{"t": times[i], "poses": {j: t[i] for j, t in tracks.items() if i in t}} for i in frames]
        length = times[-1]
        markers = [{"t": round(min(length, max(0.0, float(mk.get("time", 0)))), 4), "name": str(mk["name"])} for mk in c.get("markers") or []]
        out["clips"].append({
            "name": c["name"], "loop": bool(c.get("loop", True)), "in_place": bool(c.get("in_place", True)), "priority": c.get("priority") or "Action",
            "speed": (round(float(c["speed"]) * s, 4) if c.get("speed") is not None else None), "fade": c.get("fade", 0.2), "length": length,
            # A turning gait (Kiln 0.8.1): degrees per second about the up axis, positive to the model's left. The clip stays in
            # place; the game turns the model at this rate while it plays (the same sign as a yaw in Roblox: the axis change is a rotation).
            "turn": (round(float(c["turn"]), 3) if c.get("turn") else None),
            "generator": c.get("generator"), "fp": fps_map.get(c["name"]), "markers": markers, "keys": keys,
        })
        summary.append({"name": c["name"], "length": length, "keys": len(keys), "joints": len(tracks), "markers": len(markers)})
    if out["clips"]:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, separators=(",", ":"))
    elif os.path.exists(path):
        os.remove(path)
    return summary


def _dominant_segments(ob, me, joints):
    """Per vertex of an evaluated skinned mesh: the joint (vertex group) that moves it most."""
    names = {g.index: g.name for g in ob.vertex_groups if g.name in joints}
    out = []
    fallback = joints[0] if joints else None
    for v in me.vertices:
        best, w = fallback, -1.0
        for g in v.groups:
            if g.group in names and g.weight > w:
                best, w = names[g.group], g.weight
        out.append(best)
    return out


OPEN_FRACTION = 0.15  # a material whose faces have at least this share of boundary edges is a sheet (leaf cards, road strips, flags)
THIN_STUDS = 0.1  # a closed shell thinner than this (twice its volume over its area) shows only its faces' fronts too


def _surface_flags(me, tri_loops, tri_mat, loop_vert, wpos, mirrored=False):
    """What Roblox's front-faces-only drawing means for each material of one evaluated mesh: {material index:
    {"open": share of the material's edges that have a face on one side only (0 = watertight), "thickness":
    twice the volume over the area, "down": a flat, mostly horizontal surface whose faces point down, "extent":
    its box in world space}}. A face is drawn only from its front (the side its normal points to, by the winding):
    an open or paper-thin mesh seen from behind disappears, and a road whose faces point down is invisible from above."""
    out = {}
    nl, npoly, ne = len(me.loops), len(me.polygons), len(me.edges)
    count = loop_mat = loop_edge = None
    try:
        loop_edge = np.empty(nl, dtype=np.int32)
        me.loops.foreach_get("edge_index", loop_edge)
        ls = np.empty(npoly, dtype=np.int32)
        me.polygons.foreach_get("loop_start", ls)
        pmat = np.empty(npoly, dtype=np.int32)
        me.polygons.foreach_get("material_index", pmat)
        count = np.bincount(loop_edge, minlength=ne)
        loop_mat = pmat[np.searchsorted(ls, np.arange(nl), side="right") - 1]
    except Exception:  # noqa: BLE001
        loop_edge = None
    pts = wpos[loop_vert[tri_loops]].reshape(-1, 3, 3)
    cross = np.cross(pts[:, 1] - pts[:, 0], pts[:, 2] - pts[:, 0])
    if mirrored:  # a mirrored object (negative scale) draws its faces the other way round: the winding says the reverse
        cross = -cross
    area2 = np.linalg.norm(cross, axis=1)
    for mi in np.unique(tri_mat):
        sel = tri_mat == mi
        P = pts[sel]
        a = float(area2[sel].sum()) / 2
        vol = float(np.einsum("ij,ij->i", P[:, 0], np.cross(P[:, 1], P[:, 2])).sum()) / 6
        lo, hi = P.reshape(-1, 3).min(axis=0), P.reshape(-1, 3).max(axis=0)
        ext = hi - lo
        horiz = float(max(ext[0], ext[1]))
        flat = horiz >= 2.0 and float(ext[2]) <= max(0.1, 0.02 * horiz)
        mean_z = float(cross[sel][:, 2].sum()) / max(1e-9, float(area2[sel].sum()))
        edges = np.unique(loop_edge[loop_mat == mi]) if loop_edge is not None else None
        out[int(mi)] = {
            "open": float((count[edges] == 1).sum()) / max(1, len(edges)) if edges is not None else 0.0,
            "thickness": 2 * abs(vol) / a if a > 1e-9 else None,
            "area": a,
            "down": bool(flat and mean_z < -0.5),
            "extent": [float(v) for v in ext],
        }
    return out


def _needs_both_sides(f):
    """Whether a material of a mesh has to be drawn from both sides: a sheet (open), a paper-thin shell, or a flat surface facing down."""
    thin = f["open"] == 0.0 and f["thickness"] is not None and f["area"] > 1.0 and f["thickness"] < THIN_STUDS
    return f["open"] >= OPEN_FRACTION or thin or f["down"]


def _faces_down_note(down):
    """The note for flat meshes whose faces point down: {object name: its box in studs}."""
    items = ["'%s' (%d x %d studs)" % (n, round(max(e[0], e[1])), round(min(e[0], e[1]))) for n, e in sorted(down.items())[:8]]
    more = " and %d more" % (len(down) - 8) if len(down) > 8 else ""
    return ("Faces Roblox can't see: %s%s %s. Roblox draws a face only from its front, so seen from above "
            "they are invisible (a road that vanishes). Flip them so they point up (Edit Mode: Mesh > Normals > Flip; bmesh.ops.reverse_faces); "
            "they are marked double-sided, so they still show from both sides until you do." % (", ".join(items), more, "is flat and faces down" if len(down) == 1 else "are flat and face down"))


def _split_tris(T, axis, value):
    """Cuts triangles T (n, 3, D; a corner is position xyz, then normal xyz, then UV when there is one) by the
    plane p[axis] = value. Returns (below, above): whole triangles go to the side they are on, the ones that
    cross the plane are cut along it (a triangle on one side, a quad as two triangles on the other: winding kept,
    normals and UVs interpolated, normals renormalised). A corner exactly on the plane counts as below."""
    c = T[:, :, axis] - value
    k = (c > 0).sum(axis=1)
    cross = (k == 1) | (k == 2)
    below, above = T[k == 0], T[k == 3]
    if not cross.any():
        return below, above
    m, cm, km = T[cross], c[cross], k[cross]
    positive = cm > 0
    lone_is_positive = km == 1  # the corner alone on its side: the one above for k == 1, the one below for k == 2
    lone = np.where(lone_is_positive, positive.argmax(axis=1), (~positive).argmax(axis=1))
    rows = np.arange(len(m))[:, None]
    order = np.stack([lone, (lone + 1) % 3, (lone + 2) % 3], axis=1)
    R, cR = m[rows, order], cm[rows, order]
    P, A, B = R[:, 0], R[:, 1], R[:, 2]
    q1 = P + (A - P) * (cR[:, 0] / (cR[:, 0] - cR[:, 1]))[:, None]
    q2 = P + (B - P) * (cR[:, 0] / (cR[:, 0] - cR[:, 2]))[:, None]
    q1[:, axis] = q2[:, axis] = value
    for q in (q1, q2):
        n = q[:, 3:6]
        q[:, 3:6] = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    lone_tri = np.stack([P, q1, q2], axis=1)
    quad_a, quad_b = np.stack([q1, A, B], axis=1), np.stack([q1, B, q2], axis=1)
    lp = lone_is_positive
    above = np.concatenate([above, lone_tri[lp], quad_a[~lp], quad_b[~lp]])
    below = np.concatenate([below, lone_tri[~lp], quad_a[lp], quad_b[lp]])
    return below, above


def _cut_grid(T, lo, hi, limit):
    """Triangles T cut into grid cells so that no cell is wider than `limit` on any axis (each axis that is
    wider is divided evenly). Returns {(ix, iy, iz): triangles}, in cell order; one cell holding T itself
    (same order, nothing cut) when it already fits."""
    cells = {(): T}
    for axis in range(3):
        extent = float(hi[axis] - lo[axis])
        n = max(1, int(np.ceil(extent / limit - 1e-9)))
        planes = [float(lo[axis]) + extent * k / n for k in range(1, n)]
        nxt = {}
        for key, tris in cells.items():
            rest = tris
            for k, v in enumerate(planes):
                below, rest = _split_tris(rest, axis, v)
                if len(below):
                    nxt[key + (k,)] = below
            if len(rest):
                nxt[key + (n - 1,)] = rest
        cells = nxt
    return dict(sorted(cells.items()))


def _drop_degenerate(T, eps=1e-9):
    """Triangles with no area left (the cut can leave a sliver of zero width) are dropped."""
    a, b, c = T[:, 0, :3], T[:, 1, :3], T[:, 2, :3]
    return T[np.linalg.norm(np.cross(b - a, c - a), axis=1) > eps]


# ---------------------------------------------------------------------------------------------
# Collision roles: what a part is FOR, so the builders set its collision (docs/ARCHITECTURE.md, Kiln 0.8 roles)
# ---------------------------------------------------------------------------------------------

ROLES = ("drivable", "ground", "barrier", "decor", "collider")
# Words (camelCase and snake_case split, lower-cased) that tell a role when an object has no custom property kiln_role.
# The first role whose word is found wins: leaves and tufts are decor even on a road-coloured material, a guard rail is a
# barrier before it is a road.
_ROLE_WORDS = (
    ("decor", {"leaf", "leaves", "foliage", "tuft", "tufts", "haze", "fog", "mist", "smoke", "flower", "flowers", "petal", "petals", "fern", "ferns", "weed", "weeds", "cloud", "clouds"}),
    ("barrier", {"rail", "rails", "guardrail", "guardrails", "barrier", "barriers", "wall", "walls", "fence", "fences", "railing", "railings", "bollard", "bollards"}),
    ("drivable", {"road", "roads", "asphalt", "tarmac", "highway", "street", "lane", "roadway", "racetrack"}),
    ("ground", {"ground", "terrain", "grass", "dirt", "soil", "sand", "mud", "gravel", "snow", "floor", "floors", "pavement", "sidewalk", "earth"}),
)


def _tokens(text):
    """Lower-case words of a name: "GuardRail_03" -> ["guard", "rail"], "roadSection.001" -> ["road", "section"]."""
    return [w.lower() for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+", str(text or ""))]


def _infer_role(*names):
    """A role from the words of a name (an object's, a material's), or None."""
    words = set()
    for n in names:
        words.update(_tokens(n))
    for role, vocabulary in _ROLE_WORDS:
        if words & vocabulary:
            return role
    return None


def _role_prop(owner):
    """The role a custom property kiln_role gives (an object or its mesh data), or None for none / an unknown word."""
    try:
        v = owner.get("kiln_role") if owner is not None and hasattr(owner, "get") else None
    except Exception:  # noqa: BLE001
        return None
    v = str(v).strip().lower() if v is not None else ""
    return v if v in ROLES else None


def _role_of(ob, mat, inferred_ok=True):
    """(role, inferred) of one material of an object: its kiln_role (or the mesh data's), else guessed from the object's
    name, else from the material's name (so a tree's leaves are decor and its trunk is not). (None, False) when unknown."""
    r = _role_prop(ob) or _role_prop(getattr(ob, "data", None))
    if r:
        return r, False
    if getattr(ob, "get", None) and ob.get("kiln_collides_for"):
        return "collider", False
    if not inferred_ok:
        return None, False
    r = _infer_role(ob.name) or (_infer_role(mat.name) if mat is not None else None)
    return r, r is not None


def _collider_targets(scene):
    """Names the colliders of the scene stand for (their custom property kiln_collides_for: a name, a list, or a JSON list)."""
    out = set()
    for ob in scene.objects:
        v = ob.get("kiln_collides_for") if hasattr(ob, "get") else None
        if v is None:
            continue
        if isinstance(v, str):
            try:
                decoded = json.loads(v)
            except ValueError:
                decoded = re.split(r"[,;|]", v)
            v = decoded if isinstance(decoded, list) else [decoded]
        elif not isinstance(v, (list, tuple)):
            try:
                v = list(v)
            except TypeError:
                v = [v]
        out.update(str(x).strip() for x in v if str(x).strip())
    return out


def _is_replaced(ob, targets):
    """Whether a collider stands in for this object: it is named by one (the object, its mesh data, a collection it is
    in, or its parent)."""
    if not targets:
        return False
    names = {ob.name}
    if getattr(ob, "data", None) is not None:
        names.add(ob.data.name)
    names.update(c.name for c in getattr(ob, "users_collection", []))
    if ob.parent is not None:
        names.add(ob.parent.name)
    return bool(names & targets)


def _box_like(vpos):
    """Whether a part's vertices (centred on its box) all sit on the corners of that box, and the box has some thickness
    (every side at least 0.1 stud): Roblox's cheapest collision, CollisionFidelity Box, is exact for it."""
    half = (vpos.max(axis=0) - vpos.min(axis=0)) / 2
    if len(vpos) < 4 or float(half.min()) < 0.05:
        return False
    return bool(np.all(np.abs(np.abs(vpos) - half) <= 1e-3 * max(1.0, float(half.max()))))


def _fill(vpos, indices, box):
    """The share of its box a closed part fills (volume over the box's volume), 0-1; None when it has no volume."""
    tri = vpos[np.asarray(indices, dtype=np.int64).reshape(-1, 3)]
    vol = abs(float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum()) / 6)
    cap = float(np.prod(box))
    return round(min(1.0, vol / cap), 3) if cap > 1e-9 else None


# ---------------------------------------------------------------------------------------------
# Instances: objects that share a mesh (linked duplicates, collection instances) are exported ONCE, with their placements
# ---------------------------------------------------------------------------------------------

MIN_INSTANCE_USES = 4  # a mesh used at least this often (same mesh data, materials and role) becomes one part plus its placements


class _Src:
    """One exportable use of a mesh object: the object (evaluated for its mesh), the world matrix it is placed with, the joint segment
    it moves with (rigged models), and the object that instanced it (a collection instance's empty)."""

    __slots__ = ("ob", "name", "matrix", "segment", "instancer")

    def __init__(self, ob, name, matrix, segment, instancer=None):
        self.ob, self.name, self.matrix, self.segment, self.instancer = ob, name, matrix, segment, instancer


def _sources(scene, dg, segment_of, with_collections):
    """Every visible mesh-like object of the scene, plus (unless the model is rigged) what the collections instanced by visible
    objects bring: each use of such an object is a source with the instance's own world matrix."""
    out = [_Src(ob, ob.name, ob.matrix_world.copy(), segment_of(ob)) for ob in sorted(scene.objects, key=lambda o: o.name) if ob.type in MESHLIKE and ob.visible_get() and not ob.name.startswith("_")]
    if with_collections:
        extra = []
        try:
            for inst in dg.object_instances:
                if not inst.is_instance or inst.object.type not in MESHLIKE or inst.parent is None:
                    continue
                par = inst.parent.original
                if par.name.startswith("_") or not par.visible_get():
                    continue
                inner = inst.object.original
                if inner.name.startswith("_"):
                    continue
                extra.append(_Src(inner, "%s/%s" % (par.name, inner.name), inst.matrix_world.copy(), None, par))
        except Exception:  # noqa: BLE001
            extra = []
        extra.sort(key=lambda x: (x.name, [round(v, 4) for row in x.matrix for v in row]))
        out.extend(extra)
    return out


def _read_mesh(me, ob):
    """The arrays of an evaluated mesh that the export works from, in object space, or None when it has no triangles:
    {"tri_loops": 3 loop indices per triangle, "tri_mat", "loop_vert", "co": vertices, "cn": a normal per loop, "luv": a UV per
    loop (zeros when it has none), "lcol": the vertex colour a material is painted with per loop, or None}."""
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    if not nt:
        return None
    tri_loops = np.empty(nt * 3, dtype=np.int32)
    me.loop_triangles.foreach_get("loops", tri_loops)
    tri_mat = np.empty(nt, dtype=np.int32)
    me.loop_triangles.foreach_get("material_index", tri_mat)
    loop_vert = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", loop_vert)
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    try:
        cn = np.empty(len(me.loops) * 3, dtype=np.float64)
        me.corner_normals.foreach_get("vector", cn)
        cn = cn.reshape(-1, 3)
    except Exception:  # noqa: BLE001  (older Blender: one normal per face)
        pn = np.empty(len(me.polygons) * 3, dtype=np.float64)
        me.polygons.foreach_get("normal", pn)
        pn = pn.reshape(-1, 3)
        poly = np.empty(nt, dtype=np.int32)
        me.loop_triangles.foreach_get("polygon_index", poly)
        cn = np.zeros((len(me.loops), 3))
        cn[tri_loops.reshape(-1, 3)[:, 0]] = pn[poly]
        cn[tri_loops.reshape(-1, 3)[:, 1]] = pn[poly]
        cn[tri_loops.reshape(-1, 3)[:, 2]] = pn[poly]
    # A material painted by vertex colour: that colour attribute per corner (for its part's colour).
    lcol = None
    want = next((vertex_color_layer(s.material) for s in ob.material_slots if s.material is not None and vertex_color_layer(s.material) is not None), None)
    if want is not None and len(me.color_attributes):
        attr = me.color_attributes.get(want) if want else me.color_attributes.active_color
        attr = attr or me.color_attributes[0]
        vals = np.empty(len(attr.data) * 4, dtype=np.float64)
        attr.data.foreach_get("color", vals)
        vals = vals.reshape(-1, 4)
        lcol = vals if attr.domain == "CORNER" else vals[loop_vert]
    uvl = me.uv_layers.get("RobloxUV") or me.uv_layers.active  # Kiln's baked copy has just this one layer
    if uvl is not None and len(me.loops):
        luv = np.empty(len(me.loops) * 2, dtype=np.float64)
        uvl.data.foreach_get("uv", luv)
        luv = luv.reshape(-1, 2)
    else:
        luv = np.zeros((len(me.loops), 2))
    return {"tri_loops": tri_loops, "tri_mat": tri_mat, "loop_vert": loop_vert, "co": co, "cn": cn, "luv": luv, "lcol": lcol}


def _euler_yxz(R):
    """Degrees (x, y, z) with R = Ry(y) Rx(x) Rz(z): what CFrame.fromOrientation(x, y, z) builds and CFrame:ToOrientation() gives back."""
    a = np.arcsin(max(-1.0, min(1.0, -R[1, 2])))
    if abs(np.cos(a)) > 1e-6:
        b = np.arctan2(R[0, 2], R[2, 2])
        c = np.arctan2(R[1, 0], R[1, 1])
    else:  # looking straight up or down: y and z turn the same way, put it all in y
        b = np.arctan2(-R[2, 0], R[0, 0])
        c = 0.0
    return [float(np.degrees(v)) for v in (a, b, c)]


_FLIP_X = np.diag([-1.0, 1.0, 1.0])


def _decompose(A):
    """A 3x3 linear map as a rotation, a positive scale per axis (of the mesh's own axes: a MeshPart's Size) and whether it mirrors
    (negative determinant): (R, S, mirrored) with A = R diag(S), or None when it can't be made of those (shear, or collapsed)."""
    s = np.linalg.norm(A, axis=0)
    if float(s.min()) < 1e-6:
        return None
    R = A / s
    if float(np.abs(R.T @ R - np.eye(3)).max()) > 1e-3:
        return None
    u, _, vt = np.linalg.svd(R)  # the nearest true rotation (or reflection)
    R = u @ vt
    return R, s, bool(np.linalg.det(R) < 0)


def _instance_key(src, targets):
    """What two uses of a mesh must share to be one part with two placements: the mesh data, the materials (slot by slot), the
    modifiers, the role of each material and whether a collider stands in for it. None for what can't be instanced (not a mesh)."""
    ob = src.ob
    if ob.type != "MESH" or ob.data is None:
        return None
    slots = tuple(sl.material.name if sl.material else None for sl in ob.material_slots)
    mods = tuple((m.type, m.name) for m in ob.modifiers if m.show_viewport)
    roles = tuple(_role_of(ob, sl.material)[0] for sl in ob.material_slots) or (_role_of(ob, None)[0],)
    replaced = _is_replaced(ob, targets) or (src.instancer is not None and _is_replaced(src.instancer, targets))
    return (ob.data.name, slots, mods, roles, bool(replaced))


def _plan_instances(sources, to_rbx, dg, targets):
    """The meshes used often enough to be instanced: [{"members", "mirrored", "geo", ...}] — one per mesh and handedness. A use whose
    matrix has shear, or whose size would pass a part's limit, or whose modifiers made another mesh, stays an ordinary object (merged
    by material as before); mirrored uses (negative determinant) are exported as a mesh of their own, mirrored, since a Roblox part
    can't be mirrored; a mirrored set smaller than MIN_INSTANCE_USES is merged."""
    by_key = {}
    for src in sources:
        k = _instance_key(src, targets)
        if k is not None and src.segment is None and _own_part(src.ob) is None:  # a part the code finds by name is never one of many
            by_key.setdefault(k, []).append(src)
    plans = []
    for key, members in by_key.items():
        if len(members) < MIN_INSTANCE_USES:
            continue
        rep = members[0]
        ev = rep.ob.evaluated_get(dg)
        try:
            me = ev.to_mesh()
        except Exception:  # noqa: BLE001
            continue
        if me is None:
            continue
        try:
            data = _read_mesh(me, rep.ob)
            if data is None:
                continue
            nverts, npoly = len(me.vertices), len(me.polygons)
            slot_mats = [sl.material for sl in rep.ob.material_slots]
            M0 = np.array(rep.matrix)
            wpos0 = data["co"] @ M0[:3, :3].T + M0[:3, 3]
            flags = _surface_flags(me, data["tri_loops"], data["tri_mat"], data["loop_vert"], wpos0, float(np.linalg.det(M0[:3, :3])) < 0)
        finally:
            ev.to_mesh_clear()
        per_slot = {int(mi): int((data["tri_mat"] == mi).sum()) for mi in np.unique(data["tri_mat"])}
        if max(per_slot.values()) > MAX_PART_TRIS:
            continue
        # Roblox-space geometry of each material, in the mesh's own frame
        local = {}
        for mi in per_slot:
            sel = data["tri_loops"].reshape(-1, 3)[data["tri_mat"] == mi].ravel()
            local[mi] = {"pos": data["co"][data["loop_vert"][sel]] @ to_rbx.T, "nrm": data["cn"][sel] @ to_rbx.T, "uv": data["luv"][sel], "vcol": data["lcol"][sel] if data["lcol"] is not None else None}
        allpos = np.concatenate([g["pos"] for g in local.values()])
        native = allpos.max(axis=0) - allpos.min(axis=0)
        eligible = {False: [], True: []}
        for m in members:
            if m is not rep and any(md.show_viewport for md in m.ob.modifiers):
                mev = m.ob.evaluated_get(dg)
                same = False
                try:
                    mme = mev.to_mesh()
                    same = mme is not None and len(mme.vertices) == nverts and len(mme.polygons) == npoly
                except Exception:  # noqa: BLE001
                    same = False
                finally:
                    try:
                        mev.to_mesh_clear()
                    except Exception:  # noqa: BLE001
                        pass
                if not same:
                    continue
            M = np.array(m.matrix)
            dec = _decompose(to_rbx @ M[:3, :3] @ to_rbx.T)
            if dec is None:
                continue
            R, S, mirrored = dec
            if float((native * S).max()) > MAX_PART_SIZE:
                continue
            eligible[mirrored].append((m, R, S, to_rbx @ M[:3, 3]))
        for mirrored, uses in eligible.items():
            if len(uses) < MIN_INSTANCE_USES:
                continue
            geo = {}
            for mi, g in local.items():
                pos, nrm, uv, vcol = g["pos"], g["nrm"], g["uv"], g["vcol"]
                if mirrored:  # the mesh itself is mirrored (x), its winding reversed; the uses then turn it like any other
                    order = np.array([0, 2, 1])
                    pos = (pos @ _FLIP_X).reshape(-1, 3, 3)[:, order].reshape(-1, 3)
                    nrm = (nrm @ _FLIP_X).reshape(-1, 3, 3)[:, order].reshape(-1, 3)
                    uv = uv.reshape(-1, 3, 2)[:, order].reshape(-1, 2)
                    vcol = vcol.reshape(-1, 3, 4)[:, order].reshape(-1, 4) if vcol is not None else None
                geo[mi] = {"pos": pos, "nrm": nrm, "uv": uv, "vcol": vcol}
            # A use is a proper rotation Rp, a scale S (a MeshPart's Size, relative to the mesh) and a translation t: A = Rp diag(S) (x flipped
            # first for a mirrored use, whose mesh is mirrored already).
            placed = [((R @ _FLIP_X if mirrored else R), S, t) for _m, R, S, t in uses]
            plans.append({"key": key, "members": [u[0] for u in uses], "mirrored": mirrored, "geo": geo, "per_slot": per_slot, "slot_mats": slot_mats, "flags": flags, "uses": placed, "rep": rep})
    return plans


def _own_part(ob):
    """The name of the part this object is kept as, or None. An object (or one above it) that carries the custom
    property kiln_part is a part the game's code moves or finds by name (a door, a lid, a barrel): it is exported
    as its own MeshPart(s) named <model>_<that name>, never merged into the rest of its material."""
    seen = 0
    while ob is not None and seen < 12:
        v = ob.get("kiln_part")
        if isinstance(v, str) and v.strip():
            return re.sub(r"[^A-Za-z0-9_]", "", v.strip())[:24] or None
        ob, seen = ob.parent, seen + 1
    return None


def _export(dir, name, scene, segment_of, to_rbx, skin=None):
    dg = bpy.context.evaluated_depsgraph_get()
    groups = {}
    targets = _collider_targets(scene)  # what the scene's colliders stand for: those visuals don't collide
    sources = _sources(scene, dg, segment_of, skin is None)
    rigged = skin is not None or any(src.segment is not None for src in sources)
    plans = [] if rigged else _plan_instances(sources, to_rbx, dg, targets)
    consumed = {id(m) for pl in plans for m in pl["members"]}
    for src in sources:
        if id(src) in consumed:
            continue
        ob, segment = src.ob, src.segment
        own = None if rigged else _own_part(ob)
        ev = ob.evaluated_get(dg)
        try:
            me = ev.to_mesh()
        except Exception:  # noqa: BLE001
            continue
        if me is None:
            continue
        d = _read_mesh(me, ob)
        if d is None:
            ev.to_mesh_clear()
            continue
        tri_loops, tri_mat, loop_vert, co, cn, luv, lcol = d["tri_loops"], d["tri_mat"], d["loop_vert"], d["co"], d["cn"], d["luv"], d["lcol"]
        mw = np.array(src.matrix)
        wpos = co @ mw[:3, :3].T + mw[:3, 3]
        nm = np.array(src.matrix.to_3x3().inverted_safe().transposed())
        wn = cn @ nm.T
        wn /= np.maximum(np.linalg.norm(wn, axis=1, keepdims=True), 1e-9)
        slots = [s.material for s in ob.material_slots]
        # A skinned mesh is cut into rigid pieces: each triangle follows the joint most of its corners follow.
        tri_seg = None
        if skin and ob.name in skin:
            vseg = _dominant_segments(ob, me, skin[ob.name])
            corners = loop_vert[tri_loops].reshape(-1, 3)
            tri_seg = []
            for a, b, c in corners:
                sa, sb, sc = vseg[a], vseg[b], vseg[c]
                tri_seg.append(sb if sb == sc and sb != sa else sa)
            tri_seg = np.array(tri_seg, dtype=object)
        # A mirrored object (negative scale) shows its faces the other way round in Blender; Roblox only knows the winding: reverse it.
        mirrored = float(np.linalg.det(mw[:3, :3])) < 0
        flags = _surface_flags(me, tri_loops, tri_mat, loop_vert, wpos, mirrored)
        for mi in np.unique(tri_mat):
            mat = slots[mi] if 0 <= mi < len(slots) else None
            for seg in ([segment] if tri_seg is None else sorted(set(tri_seg[tri_mat == mi]), key=str)):
                mask = (tri_mat == mi) if tri_seg is None else ((tri_mat == mi) & (tri_seg == seg))
                # What the part is for (collision): its role, and whether a collider stands in for it. A rigged model's parts
                # (a segment each) have none: they move with their joints.
                role, inferred = _role_of(ob, mat) if seg is None else (None, False)
                replaced = seg is None and role != "collider" and (_is_replaced(ob, targets) or (src.instancer is not None and _is_replaced(src.instancer, targets)))
                key = (seg, mat.name if mat else "", role, replaced, own)
                sel = tri_loops.reshape(-1, 3)[mask]
                sel = (sel[:, ::-1] if mirrored else sel).ravel()
                g = groups.setdefault(key, {"mat": mat, "pos": [], "nrm": [], "uv": [], "vcol": [], "segment": seg, "double": False, "down": [], "role": role, "replaced": replaced, "inferred": [], "open": 0.0, "own": own})
                if inferred and src.name not in g["inferred"]:
                    g["inferred"].append(src.name)
                f = flags.get(int(mi))
                if f is not None:
                    g["open"] = max(g["open"], f["open"])
                    g["double"] = g["double"] or _needs_both_sides(f)
                    if f["down"] and src.name not in [x[0] for x in g["down"]]:
                        g["down"].append((src.name, f["extent"]))
                g["pos"].append(wpos[loop_vert[sel]])
                g["nrm"].append(wn[sel])
                g["uv"].append(luv[sel])
                if lcol is not None and mat is not None and vertex_color_layer(mat) is not None:
                    g["vcol"].append(lcol[sel])
        ev.to_mesh_clear()
    # The instanced meshes: each material of each is a part of its own, in the mesh's own frame, with the placements.
    for pi_, pl in enumerate(plans):
        for mi, geo in pl["geo"].items():
            mat = pl["slot_mats"][mi] if 0 <= mi < len(pl["slot_mats"]) else None
            rep = pl["rep"]
            role, inferred = _role_of(rep.ob, mat)
            replaced = role != "collider" and pl["key"][4]
            f = pl["flags"].get(int(mi))
            painted = geo["vcol"] is not None and mat is not None and vertex_color_layer(mat) is not None
            groups[("instances", pi_, int(mi))] = {
                "mat": mat, "pos": [geo["pos"]], "nrm": [geo["nrm"]], "uv": [geo["uv"]], "vcol": [geo["vcol"]] if painted else [], "segment": None,
                "double": bool(f and _needs_both_sides(f)), "down": [(rep.name, f["extent"])] if f and f["down"] else [], "role": role, "replaced": replaced,
                "inferred": [rep.name] if inferred else [], "open": f["open"] if f else 0.0,
                "uses": pl["uses"], "mesh": rep.ob.data.name, "mirrored": pl["mirrored"], "slots": len(pl["per_slot"]),
            }
    if not groups:
        return {"parts": [], "tris": 0}
    out_dir = dir
    os.makedirs(out_dir, exist_ok=True)
    per_segment, variants, per_own = {}, {}, {}
    for key in groups:
        if key[0] == "instances":
            continue
        seg, mat_name, _role, _replaced, own_ = key
        if own_ is not None:
            per_own[own_] = per_own.get(own_, 0) + 1
            continue
        per_segment[seg] = per_segment.get(seg, 0) + 1
        variants[(seg, mat_name)] = variants.get((seg, mat_name), 0) + 1
    used, parts, lo_all, hi_all = set(), [], np.full(3, np.inf), np.full(3, -np.inf)
    # A textured material's maps are written once and shared by every part made of it.
    tex_by_mat = {}
    # What the materials have that Roblox can't show, once per material (see material_notes).
    notes, noted = [], set()
    for key, g in sorted(groups.items(), key=lambda kv: -sum(len(p) for p in kv[1]["pos"])):
        instanced = "uses" in g
        pos_all = np.concatenate(g["pos"]) if instanced else np.concatenate(g["pos"]) @ to_rbx.T
        nrm_all = np.concatenate(g["nrm"]) if instanced else np.concatenate(g["nrm"]) @ to_rbx.T
        mat_key = g["mat"].name if g["mat"] else ""
        collider = g["role"] == "collider"  # invisible collision geometry: no look, no maps
        if mat_key not in tex_by_mat and not collider:
            label0 = re.sub(r"[^A-Za-z0-9_]", "", (mat_key or "Base").title().replace(" ", "")) or "Part"
            tex_by_mat[mat_key] = write_textures(dir, "%s__%s" % (name, label0[:24]), g["mat"]) if g["mat"] else (None, None)
        tex_files, tex_glb = (None, None) if collider else tex_by_mat[mat_key]
        if g["mat"] is not None and mat_key not in noted and not collider:
            noted.add(mat_key)
            notes.extend("'%s': %s" % (g["mat"].name, n) for n in material_notes(g["mat"], bool(tex_files)))
        # UVs with a top-left origin (glTF's and Roblox's; Blender's is bottom-left).
        uv_all = np.concatenate(g["uv"]) * np.array([1.0, -1.0]) + np.array([0.0, 1.0]) if tex_files else None
        # Wider than a part can be (2,048 studs): cut into grid tiles of at most MAX_PART_SIZE on each axis (the
        # triangles that cross a tile's edge are cut there, UVs and normals interpolated); then every tile with more
        # triangles than a MeshPart takes is cut into slabs along its longest side. Each piece is its own part (same look).
        # An instanced mesh is never cut (it was chosen because it fits one part).
        T = np.concatenate([pos_all.reshape(-1, 3, 3), nrm_all.reshape(-1, 3, 3)] + ([uv_all.reshape(-1, 3, 2)] if uv_all is not None else []), axis=2)
        cells = {(0, 0, 0): T} if instanced else _cut_grid(T, pos_all.min(axis=0), pos_all.max(axis=0), MAX_PART_SIZE)
        tiled = len(cells) > 1
        pieces = []
        for ckey, cT in cells.items():
            if tiled:
                cT = _drop_degenerate(cT)
            if not len(cT):
                continue
            if len(cT) > MAX_PART_TRIS and not instanced:
                cent = cT[:, :, :3].mean(axis=1)
                axis = int(np.argmax(cent.max(axis=0) - cent.min(axis=0)))
                for sl in np.array_split(np.argsort(cent[:, axis], kind="stable"), int(np.ceil(len(cT) / MAX_PART_TRIS))):
                    pieces.append((ckey, cT[sl]))
            else:
                pieces.append((ckey, cT))
        if instanced:
            seg, mat_name, role, replaced = None, mat_key, g["role"], g["replaced"]
        else:
            seg, mat_name, role, replaced = key[:4]
        own = g.get("own")
        label = re.sub(r"[^A-Za-z0-9_]", "", (mat_name or "Base").title().replace(" ", "")) or "Part"
        if instanced:
            mesh_label = re.sub(r"[^A-Za-z0-9_]", "", g["mesh"]) or "Mesh"
            label = mesh_label[:16] + ("_" + label[:10] if g["slots"] > 1 and mat_name else "") + ("_Mirrored" if g["mirrored"] else "")
            if collider:
                label = mesh_label[:16] + "_Collider"
        elif role == "collider":
            label = (label if mat_name else "") + "Collider"
        elif own is None and variants[(seg, mat_name)] > 1 and (role or replaced):
            label = label[:16] + "_" + (role.title() if role else "") + ("Replaced" if replaced else "")  # one material, several roles: told apart
        if own is not None:
            # A part the code finds by name: <model>_<Name>, or <model>_<Name>_<Material> when it has several materials.
            base = "%s_%s" % (name, own) if per_own[own] == 1 else "%s_%s_%s" % (name, own[:20], label[:16])
        elif seg is not None:
            seg_label = re.sub(r"[^A-Za-z0-9_]", "", seg) or "Segment"
            base = "%s_%s" % (name, seg_label[:24]) if per_segment[seg] == 1 else "%s_%s_%s" % (name, seg_label[:20], label[:16])
        else:
            base = name if len(groups) == 1 else "%s_%s" % (name, label[:24 if not instanced else 36])
        color, material, transparency = roblox_look(g["mat"])
        if collider:
            color, material, transparency = "#808080", "SmoothPlastic", 1.0
        if tex_glb and tex_glb.get("average"):
            color = tex_glb["average"]  # its texture's colour, wherever the texture itself can't show
        elif g["vcol"]:
            color = linear_to_hex(np.concatenate(g["vcol"]).mean(axis=0))  # painted by vertex colour: its average
        glow = emission_of(g["mat"]) if tex_files else None
        if glow and material == "Neon":
            material = "SmoothPlastic"  # a textured glow is the SurfaceAppearance's emissive map, not Neon
        for pi, (ckey, tri) in enumerate(pieces):
            pos, nrm = tri[:, :, :3].reshape(-1, 3), tri[:, :, 3:6].reshape(-1, 3)
            uv = tri[:, :, 6:8].reshape(-1, 2) if uv_all is not None else None
            # Share corners with the same position and normal (and UV when textured): fewer vertices, same look.
            both = np.round(np.hstack([pos * 1e4, nrm * 1e3] + ([uv * 1e4] if uv is not None else []))).astype(np.int64)
            uniq, first, inverse = np.unique(both, axis=0, return_index=True, return_inverse=True)
            vpos, vnrm = pos[first], nrm[first]
            vuv = uv[first] if uv is not None else None
            lo, hi = vpos.min(axis=0), vpos.max(axis=0)
            centre = (lo + hi) / 2
            instances = None
            if instanced:
                # Each use of this part: where its box centre goes, how it is turned (Roblox's YXZ Euler degrees) and its scale.
                instances = []
                for Rp, S, t in g["uses"]:
                    pos_w = Rp @ (S * centre) + t
                    instances.append({"position": [round(float(v), 4) for v in pos_w], "rotation": [round(v, 3) for v in _euler_yxz(Rp)], "scale": [round(float(v), 4) for v in S]})
                    if len(vpos) * len(g["uses"]) <= 2_000_000:  # the exact reach of its vertices (they are few)
                        w = (vpos - centre) * S @ Rp.T + pos_w
                        lo_all, hi_all = np.minimum(lo_all, w.min(axis=0)), np.maximum(hi_all, w.max(axis=0))
                    else:  # a lot of uses of a lot of vertices: the box turned and scaled bounds them
                        reach = np.abs(Rp) @ (S * (hi - lo) / 2)
                        lo_all, hi_all = np.minimum(lo_all, pos_w - reach), np.maximum(hi_all, pos_w + reach)
            else:
                lo_all, hi_all = np.minimum(lo_all, lo), np.maximum(hi_all, hi)
            vpos = vpos - centre
            part = base if len(pieces) == 1 else "%s_%d" % (base, pi + 1)
            while part in used:
                part += "_2"
            used.add(part)
            positions = [round(float(v), 4) for v in vpos.ravel()]
            normals = [round(float(v), 3) for v in vnrm.ravel()]
            indices = [int(i) for i in inverse.ravel()]
            # Collision helpers for barriers and colliders: how much of its box a closed part fills says whether a hull would
            # be a fair stand-in or only a bloated blob, and a part that is exactly a box collides as one (CollisionFidelity Box).
            fill = _fill(vpos, indices, hi - lo) if role in ("barrier", "collider") and g["open"] == 0.0 and len(pieces) == 1 else None
            box = fill is not None and fill >= 0.98 and _box_like(vpos)
            glb, mesh = os.path.join(out_dir, part + ".glb"), os.path.join(out_dir, part + ".mesh.json")
            rgba = (int(color[1:3], 16) / 255, int(color[3:5], 16) / 255, int(color[5:7], 16) / 255, 1.0)
            uvs = [round(float(v), 5) for v in vuv.ravel()] if vuv is not None else None
            write_glb(glb, positions, normals, indices, rgba, uvs=uvs, textures={**{k: v for k, v in tex_glb.items() if k != "average"}, **({"emission_strength": glow["strength"]} if glow else {})} if tex_glb else None)
            with open(mesh, "w", encoding="utf-8") as f:
                json.dump({"v": positions, "n": normals, "t": indices, **({"uv": uvs} if uvs is not None else {})}, f, separators=(",", ":"))
            parts.append({
                "name": part, "blender_material": mat_name or None, **({"segment": seg} if seg is not None else {}), **({"own": own} if own is not None else {}), "color": color, "material": material, "transparency": transparency,
                "origin": instances[0]["position"] if instanced else [round(float(v), 4) for v in centre], "size": [round(float(v), 3) for v in (hi - lo)],
                "triangles": len(indices) // 3, "vertices": len(vpos),
                **({"textures": tex_files} if tex_files else {}),
                **({"emission": glow} if glow else {}),
                **({"piece": [pi + 1, len(pieces)]} if len(pieces) > 1 else {}),
                **({"tile": [int(i) for i in ckey]} if tiled else {}),
                **({"doubleSided": True} if g["double"] else {}),
                **({"facesDown": [d[0] for d in g["down"][:8]]} if g["down"] else {}),
                **({"role": role} if role else {}),
                **({"roleInferred": True} if role and g["inferred"] else {}),
                **({"replaced": True} if replaced else {}),
                **({"box": True} if box else {}),
                **({"fill": fill} if fill is not None else {}),
                **({"instances": instances} if instanced else {}),
            })
    owned = {}
    for part_ in parts:
        if part_.get("own"):
            owned.setdefault(part_["own"], []).append(part_["name"])
    if owned:
        notes.append("Own parts (kiln_part): %s. The game's code finds them by these names inside the model; everything else is merged by material." % "; ".join("%s → %s" % (k, ", ".join(sorted(v))) for k, v in sorted(owned.items())))
    if plans:
        used_by = sum(len(pl["members"]) for pl in plans)
        meshes = sorted({pl["key"][0] for pl in plans})
        notes.append("Instanced: %d objects share %d mesh%s (%s): each is exported once with its placements (position, rotation, scale), so it uploads once and the generated Luau clones it per placement, instead of being merged into one big mesh per material. Uses mirrored by a negative scale get a mirrored mesh of their own." % (used_by, len(meshes), "" if len(meshes) == 1 else "es", ", ".join(meshes[:6]) + (", ..." if len(meshes) > 6 else "")))
    guessed = sorted({(g["role"], n) for g in groups.values() if g["role"] and g["inferred"] for n in g["inferred"]})
    if guessed:
        notes.append("Collision roles guessed from names (no kiln_role property on them): %s%s. The generated Luau sets collision from the role (decor: nothing collides; drivable and ground: precise; barrier: a box or hull when it is chunky; collider: invisible collision for what it stands in for). Set the custom property kiln_role on an object (drivable, ground, barrier, decor or collider) to say otherwise." % (", ".join("%s -> %s" % (n, r) for r, n in guessed[:8]), " and %d more" % (len(guessed) - 8) if len(guessed) > 8 else ""))
    down = {}
    for g in groups.values():
        for oname, ext in g["down"]:
            down[oname] = ext
    if down:
        notes.append(_faces_down_note(down))
    return {
        "parts": parts,
        "tris": sum(p["triangles"] * max(1, len(p.get("instances") or [])) for p in parts),
        "size": [round(float(v), 3) for v in (hi_all - lo_all)],
        **({"notes": notes} if notes else {}),
    }
