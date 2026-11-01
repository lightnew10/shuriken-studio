---
name: blender-props
description: "FALLBACK, only when Kiln can't be reached (Kiln builds every model: skill kiln-briefs). Hand-modeling in a headless Blender with blender_python: studs and Z-up, which side is the front, bmesh and modifiers as building blocks, materials that become Roblox colours and materials (Neon glows, Metal, Glass, a roblox_material property for Wood/Slate/…), one MeshPart per material, triangle budgets, the automatic clash check, renders with a Roblox character for scale, headless pitfalls, four verified recipes (crate, barrel, treasure chest, lantern), and gear: weapons players hold and armour they wear (model_gear: Tools and Accessories for R15, verified in a playtest)."
version: 7
tags: [blender, bpy, bmesh, fallback, blender_python]
roblox_systems: [MeshPart]
version_applicability: "Blender 4.2+ (verified on 5.2 LTS); Roblox Studio 0.740+ (Sept 2026)"
required_tools: [blender_python, blender_render, blender_scene, blender_check, blender_undo, model_view, model_list, model_place, model_gear]
---
# Props in headless Blender (the fallback)

**Use this only when Kiln can't be reached** (kiln_request says so, or Kiln failed twice on the model).
Kiln builds every model of the game; you ask it for the result (skill "kiln-briefs"). While Kiln can be
reached, blender_python refuses new models. When you do model by hand, start your result with one plain
line: "Kiln wasn't reachable, so I modeled <name> in Blender myself."

## Purpose
Custom props that look made for the game: the right size next to a player, a clear silhouette, a few
well-chosen colours and materials, and a sensible triangle count. Each model lives in its own headless
Blender (several modelers work at once, each on their own model); every change is saved, can be undone,
and becomes Roblox MeshParts the Models page shows straight away. These tools and helpers are the same
as in Kiln, the user's own Blender copilot.

## Preconditions
- **One model = one asset** (EnderChest, CampfireLog). Its scene is yours for your run; another agent
  asking for the same model is refused, so pick a distinct name.
- **Units are studs** (1 Blender unit = 1 stud), **Z is up**, the floor is **z = 0**, and the model's
  **front faces −Y** (Blender's Front view looks at it). Put what players should face there: a chest's
  lock, a sign's text, a machine's buttons. Shuriken turns it to face Roblox's forward (−Z).
- **Sizes next to a 5.2-stud Roblox character**: doors 7–8 tall, chests 3–4 wide, crates 3–4, barrels
  3.5–4.5 tall, chairs seat at 1.5–2, tables 2.5–3 high, swords 4–5 long, lanterns 1.5–3, trees 12–30.
- **Every material becomes one Roblox MeshPart** with that material's look: base colour → Color;
  emission → **Neon** (it glows in Roblox); metallic ≥ 0.5 → **Metal**; alpha < 1 → **Glass** with that
  transparency; anything else → SmoothPlastic, unless you set `mat["roblox_material"] = "Wood"` (any
  Enum.Material name: Wood, WoodPlanks, Slate, Brick, Cobblestone, Concrete, Fabric, Grass, Ice, Marble,
  Sand, DiamondPlate, CorrodedMetal, …). Use **2–5 materials**: each is a separate MeshPart and upload.
- **Textures reach Roblox as image maps**: a material painted with images (`kiln.material(name, kind)`,
  `kiln.pbr`, `kiln.textured`) becomes a SurfaceAppearance on its MeshPart: colour, normal (the relief),
  roughness and metalness maps, at up to 1024 px (512 is plenty; Kiln paints 512). The object needs
  UVs (`kiln.uv_box(obj, size=…)`, or `kiln.uv_faces` for one image per face). Procedural shader nodes
  (Noise/Voronoi nodes wired into the shader) don't reach Roblox: paint with the image helpers, which
  make images. Plain `kiln.mat` colours stay plain MeshPart colours (cheapest; fine for stylized).
- **Uploaded meshes keep the facing you modeled.** Roblox's glTF import turns every uploaded part 180°
  about Y around its own centre (glTF's front is +Z, Roblox's −Z); Shuriken uploads a pre-turned copy and
  turns its older uploads back in the Luau it generates, so a part arrives as the Models page and
  model_view show it. Don't add per-part 180° workarounds (a rotated MeshPart, a mirrored model), and
  remove one that a builder written earlier had when its model is re-uploaded.
- **Triangles**: props 300–3,000, hero pieces up to ~8,000 (the export cuts a material over 10,000
  triangles into several MeshParts — Roblox takes 20,000 per part — but every triangle still costs on
  phones). Bevel segments, subdivision and high segment counts multiply triangles: 1–2 bevel segments,
  12–24 segments on round things, Decimate for organic shapes.

## Headless Blender
- No window and no 3D View: operators that need one fail. Use the data API and **bmesh**
  (`bmesh.ops.create_cube / create_cone / create_uvsphere / create_icosphere / create_circle`,
  `extrude_face_region`, `bevel`, `spin`, `bisect_plane`, `inset_region`, `recalc_face_normals`) and
  **modifiers** (BEVEL, SOLIDIFY, ARRAY, MIRROR, BOOLEAN, SCREW, DISPLACE, DECIMATE, WELD, SUBSURF). They
  stay live: renders and the Roblox export see their result. Object-mode operators work on the selected,
  active object (`kiln.select(obj)` first). Curves with a bevel depth are good for pipes, ropes, rails.
- **Never leave two visible surfaces exactly flush** (a band on a box, a lid on a body, a post standing on
  a base): they flicker in Roblox (z-fighting). Leave 0.005–0.02 studs, sink one part slightly into the
  other, or cut the detail in (inset, groove). blender_python reports clashes and floating parts after each
  change: fix them before you finish (or `blender_check` with `fix: true`).
- **Name objects and materials meaningfully**: material names become MeshPart names (Chest_Gold).
- The Python namespace persists between calls until the model is reloaded; `kiln.clear()` empties it.

## kiln helpers (preloaded as `kiln`)
- `kiln.mat(name, base="#rrggbb", roughness=0.5, metallic=0.0, emission=None, strength=1.0, alpha=1.0)` →
  a material (reused if the name exists; hex is sRGB). `kiln.paint(obj, material)`.
- `kiln.mesh_object(name, bm, coll=None)` → an object from a bmesh; `kiln.collection(name)`, `kiln.link(obj, coll)`.
- `kiln.select(obj)`, `kiln.smooth(obj, angle=30)`, `kiln.apply_modifiers(obj)`, `kiln.join(objs, name=None)`.
- `kiln.bounds(objs=None)` → (min, max), `kiln.drop_to_floor(obj, z=0)`, `kiln.clear()`, `kiln.stats()`.
- Image materials: `kiln.material(name, kind, color=None)` (stone, wood, bark, metal, rusted_metal,
  painted_metal, concrete, leather, cloth, dirt, grass, ice, lava, …), `kiln.pbr(name, color, height,
  roughness)`, `kiln.textured(name, kiln.image(name, rows))` for pixel art, with `kiln.uv_box` /
  `kiln.uv_faces` for UVs. They show in Roblox as SurfaceAppearance maps (see Materials above).

## Quality bar (a prop that looks made, not generated)
- **Silhouette first.** It must read as a black shape from the front, the side and the top.
  Exaggerate the one or two features that say what it is (a chest's domed lid and big latch, an ender
  chest's eye, a lantern's cap and ring).
- **Three levels of detail.** Primary forms (the big volumes, blocked out first); secondary forms
  about 1/4 to 1/10 of their size (trims, bands, lids, panels, handles, feet); tertiary details that are
  small and few, where the eye goes (bolts, rivets, runes, cracks, a glowing accent).
- **Bevel every hard edge a little** (BEVEL modifier, width 0.03–0.08 studs, 1–2 segments): razor edges
  look generated, and bevels catch the light in Roblox.
- **No large plain faces.** Break anything bigger than about 2×2 studs with an inset panel, planks, a
  trim band, a groove or a slight taper.
- **Value contrast between parts** (a dark body with light trim, or the reverse) matters more than hue.
  One saturated accent at the focal point, often Neon.
- **Plausible albedo; the lighting does the dark.** Don't darken a colour map (or a base colour) to fake
  mood: Roblox lights the model itself (the place's Lighting), and an albedo that is already dark turns
  muddy in game. Keep surfaces at a believable brightness (organic colours — flesh, hide, skin — about
  0.3–0.5 mean; stone, wood and cloth likewise) and let the scene's lighting make it dark. **Wet or glossy
  means low roughness** (0.05–0.3), not a darker colour; a Principled Coat is folded into the roughness map
  by the export, while Sheen, Subsurface, a Bump with no normal map and an Ambient Occlusion node can't be
  shown in Roblox (blender_python lists them in "Export notes").
- **Style.** For the default cartoony style go chunkier and rounder than reality: thicker trims, bigger
  handles and latches, softer bevels, slightly exaggerated proportions.
- **Judge it at player distance** (the first render view, with the character): details under ~0.2
  studs disappear in game, so make them bigger or leave them out.
- **Variations must differ in silhouette, not only in colour** when you are asked for several takes.

## Workflow
1. **Plan**: the silhouette, the parts, the 2–5 materials, the size in studs next to the character.
2. **Block out** the main volumes in one `blender_python` call: named objects, their materials, at the
   right size and position.
3. **Look** with `blender_render` (default views iso, front, right, top; the first has a Roblox character
   beside the model). Fix proportions and size before adding detail.
4. **Forms and details** in one to three more calls: bevels, insets, trims, glowing accents. Batch related
   work into one call; don't render after every small edit (the report gives you the numbers).
5. **Check** the report: triangles per part, clashes, floating parts. `blender_undo` steps back.
6. **`model_view`** shows it as it will look in Roblox (its parts assembled, in their colours and
   materials) beside a player: the last look before you finish.
7. **Place** only when the task asks: `model_place` with the model's name (e.g. `Chest`) puts all its
   parts in as one Roblox Model, in their arrangement, resting on what is below (or on a wall with
   `on_wall`); `rotation` turns the whole model.

## Gear: weapons players hold, armour they wear
Players are R15 characters; `model_gear` turns a model into what they carry or wear (verified in a
playtest on a default R15):
- **Weapons and tools → `model_gear {model, kind: "tool"}`** (a Roblox Tool). The right hand holds the
  model's **grip point** and carries it **exactly as modeled**: model it **upright** (blade, head or
  barrel up), its **front (−Y) facing where the character will look**, the way it should look held in
  front of you. The grip point: give the model a joint at the grip, bind every part to it and attach
  `Grip` there — `kiln.rig.joint("Handle", grip)`, `kiln.rig.bind([objects…], "Handle")`,
  `kiln.rig.attach("Grip", "Handle", grip)` — or pass `grip_at` (Blender coordinates). Add more points
  the game uses the same way (`Tip` for a blade's end: trails and hitboxes; `Muzzle`).
  Sizes: swords 4–5 studs, daggers 2–2.5, axes and hammers 4–5, staffs 6–7, shields 3–4 across.
- **Armour, hats, capes, backpacks, a shield on the arm → `model_gear {model, kind: "accessory",
  attach_to}`** (a Roblox Accessory). It is worn **where you modeled it around the reference
  character** — the default R15 standing at the origin, facing −Y (the snippet below adds it as grey
  boxes named `_Ref_…`, which never export). `attach_to` picks the body point it follows: HatAttachment
  (top of the head, z 5.456), HairAttachment, FaceFrontAttachment (z 4.866, 0.58 in front),
  NeckAttachment (z 4.29), BodyFrontAttachment / BodyBackAttachment (chest and back, z 3.229, 0.5 in
  front or behind), Left/RightShoulderAttachment (z 4.241, 1.472 to the side), Left/RightCollarAttachment,
  WaistFront/Back/CenterAttachment (z 2.192), Left/RightGripAttachment (the hands, z 2.169, 1.472 to
  the side: a shield or a buckler), Left/RightFootAttachment. One accessory per body point: a helmet on
  HatAttachment, a breastplate on BodyFrontAttachment, pauldrons as two accessories on the shoulders.
  Give armour a little room (0.05–0.1 studs) over the body: avatars differ slightly in size.
- The parts are uploaded, then built into ServerStorage.ShurikenGear (the server gives them out:
  `tool.Parent = player.Backpack`, `humanoid:AddAccessory(item)`), StarterPack for a tool everyone
  spawns with; `world/Gear.luau` rebuilds them. Neon on gear keeps Lighting's Bloom gentle as well.
```python
import bpy, bmesh
coll = bpy.data.collections.get("_Reference") or bpy.data.collections.new("_Reference")
if coll.name not in bpy.context.scene.collection.children:
    bpy.context.scene.collection.children.link(coll)
ghost = bpy.data.materials.get("_RefGhost") or bpy.data.materials.new("_RefGhost")
ghost.diffuse_color = (0.44, 0.53, 0.61, 1.0)
for name, centre, size in [
    ("Head", (0.000, 0.000, 4.866), (1.159, 1.161, 1.182)),
    ("UpperTorso", (0.000, 0.000, 3.441), (1.943, 1.004, 1.698)),
    ("LowerTorso", (0.000, 0.000, 2.392), (1.991, 1.004, 0.401)),
    ("LeftUpperArm", (1.472, 0.000, 3.620), (1.001, 1.002, 1.242)),
    ("LeftLowerArm", (1.472, 0.000, 2.990), (1.001, 1.002, 1.118)),
    ("LeftHand", (1.472, 0.000, 2.327), (0.984, 1.028, 0.316)),
    ("RightUpperArm", (-1.472, 0.000, 3.620), (1.001, 1.002, 1.242)),
    ("RightLowerArm", (-1.472, 0.000, 2.990), (1.001, 1.002, 1.118)),
    ("RightHand", (-1.472, 0.000, 2.327), (0.984, 1.028, 0.316)),
    ("LeftUpperLeg", (0.500, 0.000, 1.721), (0.993, 0.973, 1.363)),
    ("LeftLowerLeg", (0.500, 0.000, 0.859), (0.993, 0.973, 1.301)),
    ("LeftFoot", (0.500, 0.000, 0.156), (1.009, 1.001, 0.312)),
    ("RightUpperLeg", (-0.500, 0.000, 1.721), (0.993, 0.973, 1.363)),
    ("RightLowerLeg", (-0.500, 0.000, 0.859), (0.993, 0.973, 1.301)),
    ("RightFoot", (-0.500, 0.000, 0.156), (1.009, 1.001, 0.312)),
]:
    ob = bpy.data.objects.get("_Ref_" + name)
    if ob is None:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        me = bpy.data.meshes.new("_Ref_" + name)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new("_Ref_" + name, me)
        coll.objects.link(ob)
        me.materials.append(ghost)
    ob.location = centre
    ob.scale = size
bpy.context.view_layer.update()
print("reference R15 at the origin, facing -Y:", len(coll.objects), "parts")

```

## Known pitfalls
- **Operators that need a viewport** (`bpy.ops.mesh.*` in edit mode, most `bpy.ops.transform.*`) fail
  headless: use bmesh or set values directly (`obj.location`, `obj.scale`, `obj.rotation_euler`).
- **Flush faces and exact contact** flicker: see above. The automatic check names the pairs.
- **Boolean modifiers** on meshes with open edges or coplanar faces give holes; prefer `bisect_plane`
  (cut a cylinder in half), insets and solidify for shells.
- **Scale left on objects** is fine (the export applies transforms), but bevel widths are in local units:
  bevel after scaling mesh data, or keep bevels small.
- **Too many materials** make many MeshParts; **too few** make a flat, one-colour prop. Aim for 2–5.
- **Emission alone** (without a dark base) still exports as Neon in the emission colour: that's intended
  for gems, eyes, runes, screens and flames; keep glowing parts small.

## Verification
- The report: no clashes, nothing floating (unless meant to hover), triangles under budget per part.
- `blender_render` at milestones; `model_view` before finishing: right size next to the character, a
  readable silhouette from every angle, the front facing the player.

## Examples

### Wooden crate (≈396 triangles: two parts, WoodPlanks body and Wood frame)
```python
# Wooden crate, 3.5 studs: a bevelled box with frame boards standing proud of every side.
kiln.clear()
wood = kiln.mat("Wood", base="#9a6b3f", roughness=0.8)
wood["roblox_material"] = "WoodPlanks"
trim = kiln.mat("DarkWood", base="#5b3a22", roughness=0.85)
trim["roblox_material"] = "Wood"
S = 3.5


def box(name, size, loc, m, bevel=0.03):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    ob = kiln.mesh_object(name, bm)
    ob.scale = size
    ob.location = loc
    kiln.paint(ob, m)
    b = ob.modifiers.new("Bevel", "BEVEL")
    b.width = bevel
    b.segments = 1
    return ob


box("Body", (S, S, S), (0, 0, S / 2), wood, 0.06)
t, d = 0.45, 0.08  # board width, how far boards stand out (posts 0.01 further, so no faces are flush)
for i, (x, y) in enumerate([(1, 1), (1, -1), (-1, 1), (-1, -1)]):
    box("Post%d" % i, (t, t, S + 0.02), (x * (S / 2 - t / 2 + d + 0.01), y * (S / 2 - t / 2 + d + 0.01), S / 2), trim)
for i, (sx, sy, x, y) in enumerate([(S + 2 * d, t, 0, S / 2 + d / 2), (S + 2 * d, t, 0, -S / 2 - d / 2), (t, S + 2 * d, S / 2 + d / 2, 0), (t, S + 2 * d, -S / 2 - d / 2, 0)]):
    box("Band%d" % i, (sx, sy, t if i < 2 else t - 0.04), (x, y, S / 2), trim)  # the side pair a little lower: no coincident tops
```

### Barrel (≈756 triangles: a spun profile, Wood body and Metal hoops)
```python
# Barrel, 4 studs tall: a lathe-turned bulging body (a profile spun round Z) and two iron hoops.
kiln.clear()
wood = kiln.mat("BarrelWood", base="#8a5a33", roughness=0.8)
wood["roblox_material"] = "Wood"
iron = kiln.mat("Iron", base="#3a3d42", metallic=0.9, roughness=0.45)
H, R, bulge = 4.0, 1.35, 0.22


def radius(z):
    return R - bulge + bulge * 2 * math.sin(math.pi * z / H) * 0.5 + bulge * 0.5


bm = bmesh.new()
profile = [bm.verts.new((radius(H * i / 10), 0, H * i / 10)) for i in range(11)]
for a, b in zip(profile, profile[1:]):
    bm.edges.new((a, b))
bmesh.ops.spin(bm, geom=bm.verts[:] + bm.edges[:], cent=(0, 0, 0), axis=(0, 0, 1), angle=math.radians(360), steps=20, use_duplicate=False)
bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
for z in (0.0, H):  # close the ends
    ring = sorted([v for v in bm.verts if abs(v.co.z - z) < 1e-4], key=lambda v: math.atan2(v.co.y, v.co.x))
    if len(ring) > 2:
        bm.faces.new(ring)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
body = kiln.mesh_object("Body", bm)
kiln.paint(body, wood)
kiln.smooth(body, 40)
for i, z in enumerate((0.7, H - 0.7)):
    bm = bmesh.new()
    r = radius(z) + 0.05
    bmesh.ops.create_cone(bm, cap_ends=False, segments=20, radius1=r, radius2=r, depth=0.2)
    hoop = kiln.mesh_object("Hoop%d" % i, bm)
    hoop.location = (0, 0, z)
    kiln.paint(hoop, iron)
    sol = hoop.modifiers.new("Thick", "SOLIDIFY")
    sol.thickness = 0.06
```

### Treasure chest (≈388 triangles: WoodPlanks, Metal bands, a Neon gem lock on the front)
```python
# Treasure chest, 4 studs wide: a box body, a rounded lid, gold bands and a glowing gem lock on the front (-Y).
kiln.clear()
wood = kiln.mat("ChestWood", base="#7a4a2a", roughness=0.8)
wood["roblox_material"] = "WoodPlanks"
gold = kiln.mat("Gold", base="#d9a441", metallic=0.9, roughness=0.35)
gem_mat = kiln.mat("Gem", base="#3dffc4", emission="#3dffc4", strength=4.0)
W, D, H = 4.0, 2.6, 2.0


def cube(name, size, loc, m):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    ob = kiln.mesh_object(name, bm)
    ob.scale = size
    ob.location = loc
    kiln.paint(ob, m)
    return ob


def half_cylinder(name, radius, length, loc, m, shell=0.0):
    """A cylinder lying along X, cut to its top half (bmesh bisect: no boolean needed)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=shell == 0.0, segments=24, radius1=radius, radius2=radius, depth=length)
    bmesh.ops.rotate(bm, verts=bm.verts[:], cent=(0, 0, 0), matrix=Matrix.Rotation(math.radians(90), 3, "Y"))
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0), plane_no=(0, 0, 1), clear_inner=True)
    if shell == 0.0:  # close the flat bottom
        edges = [e for e in bm.edges if e.is_boundary]
        bmesh.ops.edgeloop_fill(bm, edges=edges)
    ob = kiln.mesh_object(name, bm)
    ob.location = loc
    kiln.paint(ob, m)
    if shell:
        s = ob.modifiers.new("Thick", "SOLIDIFY")
        s.thickness = shell
        s.offset = 1.0
    return ob


body = cube("Body", (W, D, H), (0, 0, H / 2), wood)
bv = body.modifiers.new("Bevel", "BEVEL")
bv.width = 0.05
bv.segments = 1
half_cylinder("Lid", D / 2, W, (0, 0, H + 0.01), wood)  # a hair above the body: no coincident faces
for i, x in enumerate((-W / 2 + 0.55, W / 2 - 0.55)):
    cube("Band%d" % i, (0.3, D + 0.08, H - 0.005), (x, 0, H / 2 + 0.0075), gold)  # just off the floor to just over the rim (never flush)
    half_cylinder("LidBand%d" % i, D / 2 + 0.02, 0.34, (x, 0, H + 0.01), gold, shell=0.06)  # wider than the body band: ends not flush
cube("Lock", (0.7, 0.2, 0.8), (0, -D / 2 - 0.12, H - 0.25), gold)
bm = bmesh.new()
bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.17)
gem = kiln.mesh_object("Gem", bm)
gem.location = (0, -D / 2 - 0.3, H - 0.25)
kiln.paint(gem, gem_mat)
```

### Lantern (≈192 triangles: Metal frame, Glass panes, a Neon flame)
```python
# Lantern, 2.4 studs: an iron frame, glass panes and a glowing flame.
kiln.clear()
iron = kiln.mat("Iron", base="#2f3236", metallic=0.9, roughness=0.5)
glass = kiln.mat("Glass", base="#cfe8ff", alpha=0.35, roughness=0.05)
flame = kiln.mat("Flame", base="#ffb347", emission="#ffb347", strength=5.0)


def box(name, size, loc, m):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    ob = kiln.mesh_object(name, bm)
    ob.scale = size
    ob.location = loc
    kiln.paint(ob, m)
    return ob


box("Base", (1.4, 1.4, 0.2), (0, 0, 0.1), iron)
for i, (x, y) in enumerate([(1, 1), (1, -1), (-1, 1), (-1, -1)]):
    box("Post%d" % i, (0.12, 0.12, 1.32), (x * 0.6, y * 0.6, 0.84), iron)  # sunk 0.02 into the base: no flush faces
box("GlassCore", (1.1, 1.1, 1.26), (0, 0, 0.85), glass)
box("Flame", (0.3, 0.3, 0.5), (0, 0, 0.55), flame)
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=1.05, radius2=0.12, depth=0.6)
roof = kiln.mesh_object("Roof", bm)
roof.rotation_euler = (0, 0, math.radians(45))
roof.location = (0, 0, 1.79)  # resting on the posts
kiln.paint(roof, iron)
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=False, segments=12, radius1=0.22, radius2=0.22, depth=0.06)
ring = kiln.mesh_object("Ring", bm)
ring.rotation_euler = (math.radians(90), 0, 0)
ring.location = (0, 0, 2.31)  # hanging from the roof tip
kiln.paint(ring, iron)
sol = ring.modifiers.new("Thick", "SOLIDIFY")
sol.thickness = 0.05
```
