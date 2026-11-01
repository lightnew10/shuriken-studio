---
name: kiln-briefs
description: "Get every 3D model of the game from Kiln: props, vehicles, characters, creatures, weapons, map pieces and set dressing are asked of Kiln's own copilot with kiln_request as a result (what it is, what it is for, how it is seen, the must-haves), never as a method. Worked briefs; families of parts that must fit together (one Kiln project, sockets as names and constraints, fitted against an earlier family); several builds queued and waited for in one call; checking the delivery against what the game needs; fix briefs with Studio screenshots; bringing the result into the game (model_place, rig_build, model_gear)."
version: 3
tags: [3d, model, models, modeling, mesh, meshpart, prop, props, asset, kiln, brief, family, socket, sockets, fits, weapon, weapons, sword, gun, armour, armor, gear, vehicle, car, character, creature, monster, boss, mech, robot, building, crane, furniture, crate, barrel, statue, tree, rock, set, dressing, map, piece, rig, rigged, torso, legs, arms]
roblox_systems: [MeshPart, Attachment]
version_applicability: "Kiln 0.7.3+ (families and sockets checked against 0.8.1; Kiln 0.8.2 takes sockets, style and budgets as brief fields); Roblox Studio 0.740+ (Sept 2026)"
required_tools: [kiln_request, kiln_builds, kiln_status, kiln_import, model_view, model_list, model_place, model_gear, rig_build]
---
# Models from Kiln

## Purpose
Kiln, the user's Blender app, has its own copilot that researches, models, textures, rigs and animates,
and knows the Roblox rules (plain PBR, budgets, studs, this place's lighting). It builds every model of
the game. You are its client: you say what the game needs, read what it delivered, check it in the
game, and send it back with screenshots when it is wrong. You never tell it how.

## A brief: short and loose
`kiln_request {model, kind: "new", detail, text, size?, style?}`. Kiln is a senior artist: it does its
best and fastest work from a sentence or two. Every exact requirement (a triangle count, a size to hit,
a must-have list, "detailed") costs it a loop of measuring and reworking: a 2,900-character brief for a
low-poly forge took 37 minutes; two sentences take a few.

`detail` says how much the build is worth, and sets the effort Kiln spends and how long the text may be:

| detail | for | text at most | about |
|---|---|---|---|
| `quick` (default) | props, dressing, anything simple, blocky or low-poly | 280 characters | minutes |
| `standard` | what the gameplay centres on; a family that must fit; a rigged creature | 600 | 10-20 min |
| `hero` | the game's one or two centrepieces | 1,200 | longer |

The text says what it IS, in the game's look, plus clip names and which loop, and event markers (Strike,
Hit). `size` is about how big; close is fine. A part the game's code finds or moves by name goes in
`parts: ["Door", "Lid"]`: it stays its own part in the game, named `<Model>_<Name>` (`Vending_Door`);
everything not named there is merged into one part per material, so a door you didn't name can't open.

Only the prose counts toward the limit, and nothing is said twice: size, sockets, parts, a family's
models and the style have their own fields, and the game's premise ("for a PvP mining dungeon game")
isn't repeated in every brief. Kiln's best quick build came from 178 characters. Don't write moderation
rules into a brief ("no logos, no text, no QR codes"): Kiln has its own.

Leave out: part lists, measurements, colours, materials, triangle counts, must-have lists, how it will
be seen, the mood in a paragraph, "detailed" on a simple prop, joint angles, gait parameters, steps.
Your task's text is intent, not a spec to pass on: cut it down.

Good (quick): `{model: "SmithyForge", detail: "quick", size: [9, 10, 6], text: "A blocky Minecraft-style
blacksmith's forge: stone furnace with glowing coals, chimney, anvil, tool rack.", parts: ["Glow"]}`

Good (hero): "Maze Runner Griever (2014 film) as the maze's hunter: wet slug flesh on tall mechanical
legs. Clips Idle, Walk, Run (loops; tell me ground speeds), Lunge (Strike and Hit markers), Roar." with
`references: "the Griever from The Maze Runner films"`.

Variants: when a prop's look matters, don't write a longer brief: ask for two or three quick builds of
it at once (the same text for `Forge_A`, `Forge_B`, `Forge_C`, each with `wait: false`, then
`kiln_builds`), compare them with `model_view`, place the best under the name the game uses
(`model_place {name: "Forge_B", instance_name: "Forge"}`) and `model_remove` the others. A quick build
is about a minute; three cost less than one careful build.

Bad: "A DETAILED forge… It must include… What it is for… How it is seen… Must-haves: … about 9 wide,
10.5 tall, 6 deep; depth at or under 6.5… at most 8000 triangles" (a spec: forty minutes for a prop).

`references`: the subject to research, in a few words ("the Griever from The Maze Runner films").
`images`: pictures you have (project files, https URLs). `style`: the game's shared look in one or two
sentences (at most 400 characters); it is kept for the whole game, so separate Kiln projects match.

## Families: parts that must fit together or match
A mech's torsos, its leg sets, its arms, its weapons; modular wall pieces; a set of crates. Parts built
in one scene against the same sockets fit; parts built in separate projects drift. So a family is ONE
Kiln project and ONE request, and each model in it is still its own model in the game:

```
kiln_request {
  family: "MechTorsos",
  models: [{name: "Torso_Light", what: "compact scout frame"}, "Torso_Medium", "Torso_Heavy"],
  sockets: [
    {name: "LegSocket", joins: "the top centre of every leg set", where: "bottom centre of every torso; the same position on all three"},
    {name: "ArmSocket_L", joins: "the left arm", where: "shoulder height"},
    {name: "ArmSocket_R", joins: "the right arm", where: "shoulder height"}],
  style: "Industrial salvage: mismatched painted plates, rust, one amber glow.",
  tris: 6000,
  text: "The three torso frames of Scrapyard Titans, a mech arena; seen at 20-80 studs from behind the shoulder; silhouettes must differ clearly; a glowing cockpit as the focal point."
}
```

- **Sockets are names and constraints, never coordinates.** Kiln places them. Their positions come
  back in the result, in the spec section "Model sizes and sockets" and in the generated
  `ShurikenSockets` module (`Sockets.Torso_Light.sockets.LegSocket` is a CFrame in the model's own
  space, from its pivot at the bottom centre). Game code attaches parts through that module; nobody
  types socket numbers.
- **Order by what attaches to what.** The family everything attaches to first (torsos); then the ones
  that fit it, with `fits: ["MechTorsos"]` (legs, arms); then what fits those (weapons, `fits:
  ["MechArms"]`). `fits` hands Kiln the earlier project so its copilot brings a part in to fit against;
  the earlier family has to be built already.
- A change to one member goes to the family: `kiln_request {model: "Torso_Heavy", kind: "fix", …}`
  reaches the family's project, and every member comes into the game again.
- A rigged or animated model (a creature, a character) is never a family member: it is its own
  request, and its sockets are the rig's attachment points.

One model with sockets works the same way: `kiln_request {model: "ScrapTowerCrane", sockets: [{name:
"HookPoint", joins: "the load the crane lifts"}], size: [14, 80, 14], grounded: true, text: …}`.

## Several builds at once
Builds run in Shuriken's queue: several at the same time, the rest first in, first out. Queue all of
yours, then wait once:

```
kiln_request {model: "ScrapTowerCrane", text: …, wait: false}
kiln_request {model: "ScrapGantryCrane", text: …, wait: false}
kiln_request {family: "ScrapCrates", models: ["Crate_Small", "Crate_Long"], text: …, wait: false}
kiln_builds {wait: true}
```

`kiln_builds` returns each build's result. If the wait runs out, the builds carry on and come into the
game by themselves: call `kiln_builds` again, or do other work meanwhile. Never sleep or poll.

A build that is still running can be talked to (Kiln 0.8.2), with `mode` on kiln_request:
- `"interject"`: a correction or a requirement you forgot. It joins the running build, which reads it at
  its next step and re-plans without restarting; one build, one result.
- `"queue"` (the default): follow-on work ("add a third head") as a build of its own, after the running one.
- `"replace"`: the running build is aimed at the wrong thing; it is stopped and this one starts.

## Read the delivery, then check it
The result carries Kiln's reply, the effort it used and why, the delivery (size, triangles, joints,
clips with lengths, loops, speeds and markers) and what came into the game. Read facts there instead
of guessing: the engineer moves a creature at the clip's speed, times a hit on its marker.

Then judge it against what the game needs:
1. The result's `problems` and `failedChecks`: what the brief stated as data (`tris`, `size`,
   `grounded`, `sockets`) Kiln checks itself when the build ends, together with the fit of every
   socket pairing; a model or a socket it left out is listed too. They go back as one fix request.
2. `model_view`: it stands beside a 5.2-stud player. Size, silhouette and front must read right.
3. The names the code relies on (parts, clips, attachment points).
4. In Studio, in its real place, from the player's camera: `roblox_screenshot`. A model that reads
   well in a render can vanish at 60 studs.

## When it is wrong: a fix brief
`kiln_request {model (or family), kind: "fix", images: [the Studio screenshots], text: one sentence on
what is wrong}`. `roblox_screenshot` saves its pictures under `.shuriken/evidence`: pass those files.
Kiln changes only what is needed. Never change or retune a Kiln model or its clips yourself
(`blender_python` and `kiln_clip` refuse it).

## Into the game
- A placement: `model_place {name, position}` puts the model in as one Roblox Model (it uploads the
  meshes). Only when your task asks for a placement.
- A rigged model: `rig_build {model}` builds ReplicatedStorage.ShurikenRigs.<Model>; its clips are the
  game's animations <Model><Clip>.
- Gear players hold or wear (players stay R15): ask Kiln for a weapon upright, its front where the
  character looks, a Grip attachment at the hand; for armour, built around the reference character.
  Then `model_gear` makes the Tool or Accessory in ServerStorage.ShurikenGear.
- A whole map (a Kiln layout project that places pieces built in their own projects):
  `kiln_layout_import {model}`, never its pieces one by one.

## Map pieces: Kiln builds them one by one, your team assembles them
The map players see is Kiln's, never Roblox parts, stock materials or Terrain, and never ONE request: each
building, each kit and each prop is its own build, placed by builder code on the level designer's graybox.

A piece's brief stays as short and loose as any other: what it is, in a sentence or two. **Kiln designs
it.** You add only the few facts the ASSEMBLY depends on, because Kiln can't know them:

- **`footprint: [width, depth]`** (whole grid units) for a piece that must snap: Shuriken adds one line for
  it (with the front facing -Y). Kiln builds on the bottom centre at ground level by itself: don't say it. Read the delivered size
  before you place the piece (`size` is only checked within 20%).
- **Openings that must meet**: a door or a kit's opening as one size from the spec's map rules ("door
  opening 6 x 8"), and a socket only where another piece attaches. Each socket costs build time.
- **Names the code uses**: `parts: ["Door", "Roof"]`.
- **Players walk inside**, when they do: that one phrase (Kiln then leaves room for the camera).

What you group, not what you dictate:
- **One piece first**, with `style`, so the style sheet is saved from a real model; then queue the rest
  (`wait: false`, then `kiln_builds`). 8 builds run side by side.
- **What must match closely is one family** (the walls of a kit, house variants, a tunnel set: straight,
  bend, T, cross, dead end, ramp, shaft, chambers, entrance), at most 10 models; a tunnel set is "seen
  from inside". A building with its interior is one request, detail "standard".
- **Ground** is tiling pieces (16 or 32 studs, a few variants and edges; "tiles repeat without a seam") or
  flat-coloured meshes for hills and cliffs (128 to 256 studs; a texture stays sharp over about 21).
  Until Kiln's own ground rule changes, add "no Roblox materials: flat colour".
- **Props that repeat** (crates, lamps, counters, rubble, crystals) once each, on their own.

Leave out, as in every brief: surroundings ("on a grassy hill", a base plate: Kiln builds the scenery),
where the piece goes in the map, lighting, a film's or game's name (that starts research), part lists,
materials, measurements beyond the footprint and the opening, and "detailed", "realistic", "polished".

Good: `{model: "Bank", footprint: [32, 24], detail: "standard", parts: ["Door", "Roof"], text: "The
hub's bank: a squat vault house players walk inside. Door opening 6 x 8."}`

## When Kiln can't be reached
`kiln_request` starts a Kiln that is installed but not running. If it says Kiln can't be reached, or
Kiln failed twice on a model, build that model yourself with `blender_python` (skill "blender-props",
or "blender-creatures" for anything rigged) and start your result with one plain line: "Kiln wasn't
reachable, so I modeled <name> in Blender myself." While Kiln can be reached, `blender_python` refuses
new models.
