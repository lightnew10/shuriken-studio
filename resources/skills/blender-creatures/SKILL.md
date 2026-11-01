---
name: blender-creatures
description: "FALLBACK, only when Kiln can't be reached (Kiln builds and rigs every creature: skill kiln-briefs). Hand-building anything rigged in headless Blender with blender_python and Kiln's kits: bodies from blobs, limbs (organic, mech, insect), segmented tails and tentacles, spikes and plates; rig them with kiln.rig (an armature: joints, segments, legs, attachment points) and animate them with kiln.anim (gaits for any number of legs, idle, lunge/sting/bite/slam/swipe attacks, hit, death, waves, secondary motion, events) so Shuriken builds a Roblox rig (rig_build) and the clips become the game's animations. Conventions, pose testing, naming, budgets and a verified 8-legged recipe."
version: 5
tags: [blender, bpy, fallback, blender_python, kiln_clip]
roblox_systems: [MeshPart, Motor6D, AnimationController, Animator, Attachment]
version_applicability: "Blender 4.2+ (verified on 5.2 LTS) with Kiln 0.7.1 helpers; Roblox Studio 0.740+ (Sept 2026)"
required_tools: [blender_python, blender_render, model_view, rig_build, kiln_clip, animation_view, animation_check]
---
# Creatures in headless Blender (the fallback)

**Use this only when Kiln can't be reached** (kiln_request says so, or Kiln failed twice on the model).
Kiln models, rigs and animates every creature and character; you ask it for the result (skill
"kiln-briefs"). When you do build one by hand, start your result with one plain line: "Kiln wasn't
reachable, so I modeled <name> in Blender myself."

## Purpose
A creature that looks right AND moves: its parts split at the joints so each can turn, its joints
where a real one would bend, its legs recorded so gaits plant its feet, and named points (a sting, a
bite, a hitbox, a grip) that gameplay code aims at. Everything in skill "blender-props" still applies
(studs, Z up, front faces −Y, a Roblox character for scale, one MeshPart per material, no flush
surfaces, the quality bar); this skill adds the moving parts.

## How it flows
1. **Model** in blender_python with the creature kit (below): one mesh per moving segment.
2. **Rig** with `kiln.rig`: one armature "Rig" whose bones are the joints — a joint at each pivot,
   each segment bound to its joint, legs recorded, attachment points added. `kiln.limb(..., rig=True)`
   and `kiln.tentacle(..., rig=True)` do all of that for their pieces. `kiln.rig.check()` reports rig
   problems (unbound meshes, bad names, several roots); `kiln.rig.upgrade()` turns an old rig of joint
   empties (Kiln 0.5-0.6) into the armature.
3. **Pose test** (`kiln.rig.pose_test()`, `blender_render frames=[1, 7, 13, 19]`, `kiln.rig.pose_clear()`)
   to see every joint at rest, its minimum and its maximum: parts must not fly apart, gaps must not open,
   nothing may pass through the body.
4. **The export does the rest**, at rest whatever clip is showing: parts grouped by segment then
   material (`<Model>_<Segment>` or `<Model>_<Segment>_<Material>`), `models/<Model>.rig.json` (joints,
   pivots, axes, limits, legs, attachments in Roblox space) and every clip as the game's animation
   `<Model><Clip>` (GrieverWalk). `animation_presets {rig: "<Model>"}` lists what Shuriken read.
5. **rig_build {model}** uploads the parts (they keep the facing you modeled: the pipeline compensates
   Roblox's glTF import turn — never add per-part 180° workarounds) and builds `ReplicatedStorage.ShurikenRigs.<Model>`: a
   HumanoidRootPart, one invisible part per segment at its pivot, Motor6Ds named like the joints, the
   meshes welded on, the attachment points as Attachments, an AnimationController with an Animator.
   `place: {position}` also puts a copy in Workspace to look at.
6. **Animate** with `kiln.anim` (in blender_python, or the animator's `kiln_clip` tool): generators
   write every frame with the feet planted by IK, loops that close and events for game code (below).
   `kiln.anim.check(clip)` checks a clip frame by frame. See skill "roblox-creature-ai" for using the
   clips in the game.

## The creature kit (preloaded in `kiln`)
- `kiln.blob(name, parts, blend=0.6, material=m)` — smooth bodies from blended volumes:
  `{"sphere": (x, y, z), "r": r}`, `{"chain": [(x, y, z), …], "r": [r0, r1, …]}` (a tapering capsule
  through points: thorax, abdomen, neck). The best way to make a body, head or belly.
- `kiln.limb(name, points, radii, style="organic" | "mech" | "insect", material=m, rig=True,
  parent_joint="Body", kind="hinge", axis=(0, 1, 0), limits=(-45, 45), hip="ball")` — a limb through
  points (hip → knee → ankle → foot tip), one segment per span. With `rig=True`: joints `name_0`,
  `name_1`, … at the points (the first under `parent_joint`, a ball hip, then hinges about `axis`
  within `limits` degrees), each segment bound to its joint, and the limb recorded as a leg.
- `kiln.tentacle(name, points, base_radius, tip_radius, suckers=False, material=m, segments=6,
  rig=True, parent_joint="Body")` — tails, tentacles, necks, trunks: `segments` closed pieces that
  overlap at the cuts, a ball joint `name_i` at the start of each.
- `kiln.tube(name, points, radius, material=m)` — stingers, horns, antennae, pipes.
- `kiln.spikes(obj, count, length, ...)`, `kiln.plates(obj, count, size, ...)` — armour and quills
  grown on a surface (parented to it, so they move with its segment).
- `kiln.piston(name, a, b, radius)` — mech actuators. `kiln.seal(obj)` — close a mesh (fills holes).
- Materials: `kiln.material(name, kind, color=None)` (flesh, slime, chitin, scales, bone, fur, leather,
  metal, …) paints image maps that reach Roblox as a SurfaceAppearance on each part (colour, normal
  relief, roughness, metalness): give the meshes UVs (`kiln.uv_box(obj, size=…)`) before exporting.
  `kiln.mat(name, base="#hex", roughness, metallic, emission)` stays a plain colour (emission glows as
  Neon); procedural shader nodes don't reach Roblox.

## Colour and wetness (what reads well in Roblox)
- **Keep a plausible albedo: the mood comes from the scene's lighting.** Don't darken colour maps to fake
  "dark and menacing" — Roblox lights the model again (the place's Lighting, ClockTime, Atmosphere and
  lamps), and an albedo that is already murky turns to mud there. Flesh, hide and skin read at a mean
  brightness of about 0.3–0.5 (a mid-tone, never near black); darker values belong to details (the mouth,
  crevices, claws, eyes), not to the whole body. If it should feel menacing in the game, that is the
  lighting's job (a dim, cold scene), not the pixels'.
- **Wet means low roughness, not a dark colour.** Slime, saliva, wet flesh and fresh blood are glossy:
  roughness 0.05–0.3 where it is wet (a roughness map, `kiln.pbr(..., roughness=<array>)`), dry hide
  0.6–0.85. A Principled **Coat** (Coat Weight 0.8, Coat Roughness 0.05) is folded into the roughness map
  by the export (Roblox has no coat layer); Sheen, Subsurface, a Bump with no normal map and an Ambient
  Occlusion node can't be shown at all. blender_python lists all of that in "Export notes" the first time
  it applies. A glowing texture takes a tint from `mat["roblox_emissive_tint"] = "#ff6a10"`.

## Rigging by hand (`kiln.rig`)
- `kiln.rig.joint(name, at, parent=None, kind="hinge" | "ball" | "fixed", axis=(1, 0, 0), limits=...)`
  — a joint at its pivot. Exactly **one root** (no parent): the body. Hinges: `limits=(min, max)`
  degrees about `axis`; balls: `limits=((min x, y, z), (max x, y, z))`.
- `kiln.rig.bind(objs, "Joint")` — those meshes move with that joint (its segment).
- `kiln.rig.leg(["Hip", "Knee", "Ankle"], foot="Foot")` — hip to ankle, and the segment that touches
  the ground. Gaits plant it; without legs a rig can only slither (or be keyed by hand).
- `kiln.rig.attach("Stinger_Tip", "Tail_5", at)` — a named point on a segment.
- `kiln.rig.skin(obj, joints=None, influences=4)` — flesh that bends with several joints (a body, a
  one-piece tail). In Roblox it is cut into rigid pieces, one per joint most of each triangle follows
  (smooth skinning comes later), so it bends at seams: for anything that bends a lot, prefer separate
  overlapping segments bound with `bind` (limbs and tentacles do that).
- `kiln.rig.joint(..., tail=(x, y, z))` — where the bone ends: give it for a limb's last joint so the
  gait plants the right point (the foot's tip).
- `kiln.rig.remove(joint)` — a joint and everything under it (parts, keys, legs). `kiln.rig.ik(end,
  chain)` — Blender IK for posing by the tip (bake it into the clip with `kiln.anim.bake(clip)`).
  `kiln.rig.set_forward(dir)` if the creature doesn't face −Y.
- `kiln.rig.info()` — the rig as data; `kiln.rig.pose_test()` / `kiln.rig.pose_clear()`.
- **Axes are Blender's.** The creature faces −Y, so its own right side is −X and its left is +X (in
  Blender's Front view it faces you: its right is on your left). A leg sticking out sideways (spider) bends about the front-back axis
  `(0, 1, 0)`; a leg under the body (dog, biped) bends about the side axis `(1, 0, 0)`. Knees that only
  bend one way get one-sided limits: `(-110, 0)` or `(0, 110)` — pose test tells which.

## Animating (`kiln.anim`)
Clips are Blender actions on the rig at 30 fps; rotations are world-aligned and relative to rest
("the knee 40° about world X"). Generators (all take `name`, and keep feet planted with IK):
- `kiln.anim.gait("Walk", style="walk" | "trot" | "run" | "sneak", speed=None, cycle=None, duty=None,
  pattern="auto", step_height=None, bob=None, sway=None, lean=None, stride=None, in_place=True)` — any
  number of legs; natural defaults from the leg length; records the ground `speed` the game must move
  it at; `Step_<leg>` events at each touchdown.
- `kiln.anim.idle("Idle", length=4.0, breathe=None, sway=None, look=True)` — breathing, sway, the head
  looking around.
- `kiln.anim.attack("Sting", kind="lunge" | "sting" | "bite" | "slam" | "swipe", reach=None,
  windup=0.35, strike=0.14, hold=0.08, recover=0.5, target=None, chain=None)` — anticipation, a fast
  strike and recovery; `Strike` and `Hit` events at the moment of impact.
- `kiln.anim.hit("Hit", direction=(0, 1, 0), strength=1.0)` (`Impact` event), `kiln.anim.death("Death",
  side=1)` (collapses, ends held; `Dead` event).
- Layers: `kiln.anim.wave(clip, joints, amplitude, wavelength, frequency)` (a tail swish, a slither),
  `kiln.anim.secondary(clip, joints)` (physics follow-through on tails, antennae, cables),
  `kiln.anim.reach(clip, end, {frame: target})` (IK a claw to a point).
- By hand: `kiln.anim.clip(name, length, loop, in_place, priority, speed)`, `kiln.anim.pose(clip, frame,
  {joint: (axis, degrees)})`, `kiln.anim.key(...)`, `kiln.anim.event(clip, "Hit", time=0.4)`.
- Change: `kiln.anim.regenerate(clip, **params)`, `kiln.anim.settings(clip, speed=..., loop=...)`,
  `kiln.anim.rename`, `kiln.anim.delete`. Check: `kiln.anim.check(clip)["summary"]` (feet sliding,
  ground, parts passing through each other, limits, jitter, loop seams) — fix what it reports.
Every clip becomes the game's animation `<Model><Clip>` on the next export (a deleted clip goes too).

## Rules that make it animate well
- **Split at the joints.** A mesh that spans a joint can't bend there. Each segment is its own mesh,
  and neighbours **overlap a little** at the joint (a knuckle, a ball, a flange) so no gap opens when it
  turns. The kit's limbs and tentacles already do this.
- **Pivots where it would really bend**: the centre of the knuckle, the base of the tail, the shoulder,
  not the middle of a segment.
- **Model the rest pose it will stand in**: feet on the floor (z = 0), legs slightly bent (straight
  legs can't lower the body; gaits and slams need some bend), tail and head in a natural carry.
- **Limits like the animal's**: they keep generated motion believable (a knee 0…120°, a hip ±35°, a
  tail joint ±40°, a jaw 0…40°). Unlimited joints read as rubbery.
- **Name attachment points for their use**; gameplay and the generators look for them:
  `Stinger_Tip` / `Sting` / `Barb` (the sting motion strikes with it), `Bite_Point`, `Claw_L`,
  `Hitbox_Body`, `Hitbox_Head`, `TailSwipe_Tip`, `Grip_R` (where a weapon goes), `VFX_Mouth`.
- **Budget**: every segment × material is one MeshPart and one upload. Keep to 1–2 materials per
  segment and roughly 10–40 segments; 3,000–10,000 triangles in all for a mob, up to ~20,000 for a boss.
- **Legs are recorded hip first**; record a leg again from the same hip to replace it.

## Verified recipe: an 8-legged scorpion-spider ("Skitter", 33 joints, 34 parts)
Built and exported like this in headless Blender with the Kiln 0.7.1 helpers (rig check clean, every
clip below checks clean); its rig played in Studio exactly as Shuriken predicts, and the seven clips
generate in about 1.5 s.
```python
k = kiln
chit = k.mat('Chitin', base='#4a3226', roughness=0.45)
leg_mat = k.mat('LegChitin', base='#2e211b', roughness=0.5)
glow = k.mat('Venom', base='#ff6a1f', emission='#ff6a1f', strength=3)
body = k.blob('Body', [{'chain': [(0, -1.3, 2.2), (0, 0.1, 2.35), (0, 1.5, 2.4)], 'r': [0.75, 1.0, 0.85]}], blend=0.6, material=chit)
k.rig.joint('Body', (0, 0, 2.2), kind='ball', limits=((-25, -25, -25), (25, 25, 25)))
k.rig.bind([body], 'Body')
for side, sx in (('R', -1), ('L', 1)):          # the creature faces -Y, so its left side is +X
    for i in range(4):
        y = -1.1 + i * 0.75
        pts = [(sx * 0.75, y, 2.2), (sx * 2.0, y - 0.1, 3.0), (sx * 3.0, y, 1.3), (sx * 3.4, y, 0.0)]
        k.limb('Leg%s%d' % (side, i), pts, [0.16, 0.13, 0.09, 0.04], style='insect', material=leg_mat,
               rig=True, parent_joint='Body', axis=(0, 1, 0), limits=(-45, 45))
k.tentacle('Tail', [(0, 1.6, 2.4), (0, 2.4, 3.0), (0, 2.8, 3.9), (0, 2.6, 4.8), (0, 1.9, 5.3), (0, 1.2, 5.2)],
           base_radius=0.35, tip_radius=0.14, suckers=False, material=chit, segments=6, rig=True, parent_joint='Body')
sting = k.tube('Stinger', [(0, 1.25, 5.2), (0, 0.85, 4.85), (0, 0.7, 4.35)], radius=0.11, material=glow)
k.rig.bind([sting], 'Tail_5')
k.rig.attach('Stinger_Tip', 'Tail_5', (0, 0.7, 4.35))
for side, sx in (('R', -1), ('L', 1)):
    m = k.tube('Mandible_' + side, [(sx * 0.3, -1.6, 2.0), (sx * 0.22, -2.3, 1.85)], radius=0.09, material=leg_mat)
    k.rig.joint('Mandible_' + side, (sx * 0.3, -1.6, 2.0), parent='Body', kind='hinge', axis=(0, 0, 1), limits=(-30, 30))
    k.rig.bind([m], 'Mandible_' + side)
k.rig.attach('Bite_Point', 'Body', (0, -2.3, 1.85))
print(k.rig.check(), len(k.rig.joints()))
k.anim.gait('Walk', style='walk'); k.anim.gait('Run', style='run'); k.anim.idle('Idle')
k.anim.attack('Sting', kind='sting'); k.anim.attack('Bite', kind='bite'); k.anim.hit('Hit'); k.anim.death('Death')
print([(c['name'], c['length'], c['speed'], [m['name'] for m in c['markers']][:3]) for c in k.anim.clips()])
print(k.anim.check('Sting')['summary'])   # "no problems found": check every clip; fix what it reports
```
Then: `blender_render` (look), `kiln.rig.pose_test()` + `blender_render frames=[1, 7, 13, 19]` +
`kiln.rig.pose_clear()`, `model_view`, `rig_build {model: "Skitter"}`; the clips are SkitterWalk,
SkitterRun, SkitterIdle, SkitterSting, SkitterBite, SkitterHit and SkitterDeath (walk 1.75 studs/s,
run 4.0).

## Pitfalls
- Binding a mesh to the wrong joint (it swings with the wrong segment): check `kiln.rig.info()` segments.
- A leg recorded with its joints out of order (ankle first): gaits fail to plant it. Hip first.
- Two roots (a joint made with no parent by mistake): the export refuses the rig; give it a parent.
- Joints inside a segment's middle, or no overlap at a joint: gaps and kinks when it moves.
- Textured presets for Roblox colour: use `kiln.mat` with the colour you want to see in game.
- Renaming a joint after clips were made: the clips key the old name; regenerate them.
