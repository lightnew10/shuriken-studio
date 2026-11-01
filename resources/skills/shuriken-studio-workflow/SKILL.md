---
name: shuriken-studio-workflow
description: "Operating manual for Roblox Studio work inside Shuriken: code on disk is the source of truth, sync it with roblox_sync_push, build world instances with roblox_run_luau, observe with screenshots, snapshots and the console, and survive playtest transitions; read before any Studio task."
version: 2
tags: [shuriken, studio, workflow, sync, mcp, luau, playtest, build, scriptsync, observe]
roblox_systems: [ServerScriptService, ReplicatedStorage, StarterPlayer, Workspace, HttpService, InstanceFileSyncService, ScriptEditorService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [project_overview, roblox_status, roblox_sync_push, roblox_run_luau, roblox_explore, roblox_inspect, roblox_search, roblox_snapshot, roblox_screenshot, roblox_console, roblox_playtest, roblox_call, luau_check, capabilities_query, task_add_evidence]
---
# Working in Shuriken with Roblox Studio

## Purpose
Shuriken drives Roblox Studio through Studio's built-in MCP server. Three kinds of state exist, each with one owner:
- **Code** lives on disk under the project's sync map and is versioned by git. Disk is the source of truth.
- **The world** (parts, terrain, lighting, UI instances, tags, attributes) lives in the place and is versioned by Roblox (save/publish), not git.
- **Runtime state** exists only during a playtest and is discarded when it stops.

This skill is the operating manual: where code goes, how it reaches Studio, how to build and observe, and how not to break Studio for the next agent.

## Preconditions
- `roblox_status` shows `connection: "connected"`, a bound Studio instance and the play state. If no Studio is connected, or several are open and the project is not bound to one, you cannot fix it yourself: report it or `escalate`.
- `studio_id` is ephemeral (it changes when Studio reconnects or the place reloads). Shuriken resolves and injects it on every call; never pass or remember one.
- `project_overview` returns `syncMode` and `syncMap`:
  - `shuriken`: Shuriken pushes disk to Studio with `roblox_sync_push` and verifies each script by content hash.
  - `script-sync`: Studio's Script Sync mirrors the folders in both directions by itself; `roblox_sync_push` only reports that.
  - `none`: code sync is off; ask before touching scripts.
- Default map: `src/Server` → `ServerScriptService.Server`, `src/Shared` → `ReplicatedStorage.Shared`, `src/Client` → `StarterPlayer.StarterPlayerScripts.Client`.
- "Studio is busy with a verification playtest" means Shuriken holds the Studio lock. Do other work and retry later.

## Workflow
1. **Orient.** Call `project_overview`, then `roblox_status`. Building and syncing need Edit mode (no playtest running). If you are unsure whether a Studio tool exists or what it accepts, `capabilities_query(integration="roblox-studio")` lists live tools, schemas, known limitations and observed reliability.
2. **Write code as files, never through Studio.** The file name decides the instance class:

   | On disk | Instance in Studio |
   |---|---|
   | `X.server.luau` | Script (server) |
   | `X.local.luau` | LocalScript (use this for client entry points) |
   | `X.client.luau` | Shuriken sync: LocalScript. Studio Script Sync: Script with RunContext Client |
   | `X.luau` | ModuleScript |
   | `X/init.luau`, `X/init.server.luau` | the folder itself becomes that script, with the other files as children |
   | directory | Folder |

   Under `src/Client` use `.local.luau`: a Script with RunContext Client inside a Starter container runs twice (the original and the per-player copy).
3. **Check statically** with `luau_check` (selene + luau-lsp against the Roblox API). Fix every error before syncing.
4. **Load code into Studio.**
   - `shuriken` mode: `roblox_sync_push`. Read the report: `created`, `updated`, `unchanged`, `errors`, and `orphans` (scripts under the synced roots with no file on disk). Pass `delete_orphans: true` only when you know those scripts are stale.
   - `script-sync` mode: Studio applies file changes within moments. Confirm with a probe (Verification) before testing.
5. **Build world instances** with `roblox_run_luau` (datamodel `Edit`). Make builders idempotent (destroy and rebuild your own folder), set properties before `Parent`, anchor static parts, use tags and attributes for game logic, and `return HttpService:JSONEncode(summary)`. Keep builder programs on disk under `world/` (e.g. `world/Arena.luau`, outside the sync map), read the file and pass its text as `code`, so the world can always be rebuilt from the repository.
6. **Observe the result.**
   - Structure: `roblox_explore` (children of a dot path such as `Workspace.Map`), `roblox_inspect` (properties, attributes, tags, script source hash), `roblox_search` (by class or name; at most 200 rows, depth 10).
   - Diffs: `roblox_snapshot` with `roots` (dot paths) before and after a change; Edit DataModel only, up to 6000 instances, saved under the project.
   - Visuals: `roblox_screenshot` with `camera` and `look_at` world positions; the image is saved as task evidence automatically.
   - Logs: `roblox_console` returns the tail of Studio's output (`tail_chars` up to 50000).
7. **Playtest when behaviour matters.** `roblox_playtest {action:"run", seconds, luau, client_luau, screenshot}` is the whole check in one call: Play Solo starts (the Studio user joins and spawns), Shuriken waits for the character, lets `seconds` of game time pass, runs your `luau` probe in the Server DataModel (and `client_luau` in the Client), takes a screenshot if asked, collects errors from the output and stops. Use it for every check, and plan the check before you play: Studio has one play mode and every other agent's work waits while you hold it. What takes several moves (press a key, wait, read a value, take a picture) goes in the same call as `steps`, in order: `{action:"run", seconds: 1, steps: [{keys: [{action:"keyPress", key_code:"Space"}]}, {wait: 0.4}, {luau: "return ..."}, {client_luau: "return ..."}, {screenshot: true}]}` (up to 16 steps and 4 pictures; 10-30 s in all). A session by hand (`{action:"start"}`, `roblox_run_luau` with datamodel `Server`/`Client`, `roblox_input`, then **always** `{action:"stop"}`) is only for when the next step depends on what you just saw: it held Studio 35-98 s in a measured build. Every playtest, a `run` too, plays at most 60 s once it is up (Studio loading it into play is not counted) and is then stopped, with no extension; once others wait it is also stopped after 30 s without a Studio call. Both actions wait in line while someone else plays.
8. **Other Studio tools** go through `roblox_call {tool, args, timeout_sec}`; studio_id is added for you. Useful ones: `search_asset`, `insert_asset`, `generate_procedural_model`, `generate_mesh`, `wait_job_finished`, `character_navigation`, `user_keyboard_input`, `user_mouse_input` (the last three need `datamodel_type: "Client"` during play), `get_studio_state`, and `http_get` (allow-listed create.roblox.com docs pages; useful when you have no web tool). `multi_edit` is blocked by Shuriken.
9. **Record evidence** with `task_add_evidence` (kind `test_result`, `console` or `note`), and list every place change in your result's `robloxChanges`. The place is not in git, so the user must save or publish it.

## Known pitfalls
- **Never edit scripts through Studio**: no `multi_edit`, no `script.Source = ...` inside `roblox_run_luau`. It bypasses disk, static checks and git, and under Script Sync the change is written back to disk behind your back.
- **Play mode takes over Studio.** While playing, Edit-DataModel calls are rejected: `roblox_sync_push`, `roblox_snapshot`, `roblox_run_luau` with `Edit`, and `roblox_explore` / `roblox_inspect` / `roblox_search` unless you pass `datamodel: "Server"` or `"Client"`. Anything changed in the Server/Client DataModels is discarded on stop.
- **Transitions are asynchronous.** Never issue stop then start back to back; check `roblox_status` in between. Only one Server and one Client DataModel are addressable.
- **Separate VM during play.** Code run with `roblox_run_luau` in `Server`/`Client` runs beside the game, not inside its scripts. `require(module)` returns a fresh module instance, so module-level state (sessions, caches, tables) is invisible and reads as defaults. Observe instances, attributes, leaderstats and values instead.
- **Stale require cache in Edit.** After a sync, `require` in the Edit DataModel can return the previous module. Require a clone of the tree (Examples).
- **Output caps.** Results are truncated by undocumented limits, and truncated JSON does not parse. Return summaries (counts, first N items), not dumps; stay well under ~100 KB. Studio's own tools cap too: `script_search` 10 hits, `script_grep` 50, `inspect_instance` 20 matches.
- **JSON limits.** `HttpService:JSONEncode` cannot encode Vector3, CFrame, Color3 or Instances. Convert them (`{v.X, v.Y, v.Z}`, `c:ToHex()`, `inst:GetFullName()`), and use pure arrays or string-keyed dictionaries.
- **Unbounded loops freeze Studio** and can drop the MCP connection. Every wait loop needs an `os.clock()` deadline.
- **Never sleep in Studio.** Studio runs one request at a time for every agent, so `task.wait(60)` in `roblox_run_luau` stalls everyone's Studio work; Shuriken refuses fixed waits over 5 s in Edit and 20 s during play. Tools that need Studio wait for it by themselves; game time passes with `roblox_playtest` "run" `seconds`.
- **Script Sync rules.** Never put attributes or tags on scripts (they are not synced and can be lost). Don't delete a synced root directory on disk while it is linked (Studio errors; empty it instead). Empty folders and dot-directories are not synced, a script can't be named `init`, and synced folders should not mix scripts with other instances. Commit before any re-link, because the side you don't keep in a conflict gets overwritten.
- **After a Studio update**, errors such as "Target is not reachable" or "Client proxy is out of date" need the user to restart Studio (and Shuriken's connection). Report them instead of retrying in a loop.
- **Screenshots taken during play** can omit BillboardGuis, the default ProximityPrompt UI and the top bar.
- **Assets and generation.** `insert_asset` parents to Workspace unless you pass `parentPath`; inserted scripts are sandboxed but must still be vetted (roblox-world-building skill). Procedural models are limited to 50 per rolling 24 h.
- `roblox_call` times out after 120 s by default; pass `timeout_sec` (e.g. 620) with `wait_job_finished`, whose own default wait is 600 s.

## Verification
Asserts return a string that starts with `PASS` or `FAIL: reason`.

Scripts landed with the right classes (Edit):
```lua
local function find(path: string): Instance?
	local node: Instance? = game
	for segment in string.gmatch(path, "[^%.]+") do
		node = if node then node:FindFirstChild(segment) else nil
	end
	return node
end
local expected = {
	["ServerScriptService.Server.Main"] = "Script",
	["StarterPlayer.StarterPlayerScripts.Client.Main"] = "LocalScript",
	["ReplicatedStorage.Shared.Net"] = "ModuleScript",
}
for path, className in expected do
	local inst = find(path)
	if not inst then return `FAIL: {path} missing` end
	if inst.ClassName ~= className then return `FAIL: {path} is {inst.ClassName}, expected {className}` end
end
return "PASS"
```

Script Sync is live (Edit, `script-sync` projects):
```lua
local IFS = game:GetService("InstanceFileSyncService")
local roots = { ServerScriptService = "Server", ReplicatedStorage = "Shared" }
for service, name in roots do
	local root = game:GetService(service):FindFirstChild(name)
	if not root then return `FAIL: {service}.{name} missing` end
	local status = IFS:GetStatus(root)
	if status ~= Enum.InstanceFileSyncStatus.SyncedAsRoot then return `FAIL: {root:GetFullName()} sync status {status}` end
end
return "PASS"
```

The code you just wrote is what Studio has (Edit):
```lua
local mod = game:GetService("ReplicatedStorage").Shared.Data.Items
return if string.find(mod.Source, "function Items.stackSize", 1, true) then "PASS" else "FAIL: Items module not updated in Studio"
```

After a playtest, `roblox_console` must show no new lines containing `error`, `Stack Begin`, `attempt to ...` or `Infinite yield possible`.

## Examples
Idempotent builder, run with `roblox_run_luau` (Edit):
```lua
--!strict
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")

local map = workspace:FindFirstChild("Map") or Instance.new("Folder")
map.Name = "Map"
map.Parent = workspace
local old = map:FindFirstChild("SpawnPlatform")
if old then
	old:Destroy()
end

local model = Instance.new("Model")
model.Name = "SpawnPlatform"
local deck = Instance.new("Part")
deck.Name = "Deck"
deck.Anchored = true
deck.Size = Vector3.new(48, 2, 48)
deck.CFrame = CFrame.new(0, 60, 0)
deck.Material = Enum.Material.Slate
deck.Parent = model
CollectionService:AddTag(deck, "SafeZone")
deck:SetAttribute("ZoneName", "Spawn")
model.PrimaryPart = deck
model.Parent = map -- parent last

local p = model:GetPivot().Position
return HttpService:JSONEncode({ built = model:GetFullName(), parts = #model:GetDescendants(), pivot = { p.X, p.Y, p.Z } })
```

Fresh require in Edit (bypasses the stale module cache; never parent the clone into a synced folder). This is a Studio chunk, not a module, so it stays nonstrict: static analysis cannot resolve a require of a runtime clone.
```lua
local fresh = game:GetService("ReplicatedStorage").Shared:Clone()
local ok, result = pcall(function(): number
	local Items = require(fresh.Data.Items)
	local count = 0
	for _ in Items do
		count += 1
	end
	return count
end)
fresh:Destroy()
return if ok then `PASS: {result} items` else `FAIL: {result}`
```

Asset search through `roblox_call`:
```json
{"tool": "search_asset", "args": {"query": "pine tree", "scope": "creator_store", "assetType": "Model", "priceFilter": "free", "verifiedCreatorsOnly": true, "maxResults": 10}}
```

## References
- https://create.roblox.com/docs/studio/mcp
- https://create.roblox.com/docs/ai/coding-harness
- https://create.roblox.com/docs/scripting/sync
- https://create.roblox.com/docs/scripting/locations
- https://create.roblox.com/docs/reference/engine/classes/InstanceFileSyncService
- https://devforum.roblox.com/t/studio-mcp-multi-agent-improvements-and-connected-ai-clients/4820583
- https://devforum.roblox.com/t/4849810 (community: separate VM and fresh `require` in play DataModels)
