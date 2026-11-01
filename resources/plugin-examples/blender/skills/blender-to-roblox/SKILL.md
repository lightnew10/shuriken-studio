---
name: blender-to-roblox
description: "Moving geometry from Blender into Roblox: scale, orientation, export format and validation."
version: 1
tags: [blender, mesh, export, assets]
roblox_systems: [MeshPart]
version_applicability: "Blender 4.x, Roblox Studio 0.740+"
required_tools: [external_call, roblox_call]
---
# Blender → Roblox

## Purpose
Create or modify a mesh in Blender through the plugin's MCP server and bring it into Roblox as a MeshPart.

## Workflow
1. `external_tools` to discover the Blender server's tools and schemas.
2. Model at real Roblox scale (1 stud ≈ 0.28 m; export with scale so the object has the intended stud size).
3. Apply transforms, triangulate, keep faces under Roblox's MeshPart triangle limit (20k), one material slot per surface you want to recolor.
4. Export FBX/OBJ into the project's `assets/` folder so it is versioned.
5. Upload/import through Studio (Asset Manager or `roblox_call` import tools when available), then verify with `roblox_inspect` (MeshId, Size, CollisionFidelity).

## Known pitfalls
- Y-up vs Z-up axis mismatch rotates the model 90°.
- Unapplied scale causes wrong sizes and broken collision.
- Very thin geometry needs CollisionFidelity = Box or Hull to avoid physics cost.

## Verification
Screenshot the imported model with `roblox_screenshot` and check triangle count/size with `roblox_inspect`.
