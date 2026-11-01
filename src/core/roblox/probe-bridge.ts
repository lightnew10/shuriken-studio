/**
 * Probes that need what Studio no longer gives MCP code.
 *
 * On 2026-10-01 Studio (0.741.19, no update that day: a flag) began running execute_luau without four script
 * capabilities ("LoadUnownedAsset (and 3 more)"). Measured in a scratch place that evening, in Edit and in a
 * playtest's Server and Client:
 *   - refused: parenting a Script/LocalScript/ModuleScript anywhere (new, cloned, or inside a model), moving one,
 *     `require` of a game module, firing a BindableEvent or RemoteEvent;
 *   - still fine: parts and other instances, properties and attributes, an existing script's Source and name,
 *     destroying a script, Studio's own script tool (multi_edit) creating scripts;
 *   - the game's own scripts run with everything, as always.
 * A third of the Luau agents ran in that day's builds used `require` or fired an event (488 of 1,455 calls), so
 * playtest checks could prove almost nothing.
 *
 * The bridge: before a playtest starts, a small script is put on the server and on the client (through the script
 * tool, in Edit). In the playtest it is a game script like any other. A probe that needs game rights writes its
 * code into the host's `Job` module (writing Source is allowed), bumps an attribute, and the host requires a copy
 * of the module — the probe's code now runs as the game does — and leaves the answer as a StringValue. The hosts
 * are removed when the playtest stops, and do nothing outside Studio.
 *
 * A probe that runs through the host is a game script: it can't read Script.Source or use plugin-only APIs. Only
 * probes that name what the MCP thread is refused go through it (NEEDS_GAME_RIGHTS); the rest run as before.
 */

export const HOST_NAME = 'ShurikenProbeHost';
/** The host's answer when no host is in this playtest (started by hand, or before the bridge was there). */
export const NO_HOST = '__SHURIKEN_NO_PROBE_HOST__';
/** Code longer than this runs directly (a script's Source takes 200,000 characters). */
export const BRIDGE_MAX_CODE = 180_000;

/** What the capability-restricted MCP thread is refused: requiring modules, firing or invoking, script instances. */
export const NEEDS_GAME_RIGHTS = /\brequire\s*\(|:\s*Fire(?:Server|Client|AllClients)?\s*\(|:\s*Invoke(?:Server|Client)?\s*\(|:\s*Clone\s*\(|Instance\.new\(\s*["'](?:Script|LocalScript|ModuleScript)["']/;

/** Studio's refusal, in any of its forms (reparent, require, fire, start, write). */
export const CAPABILITY_ERROR = /additional values for the Capabilities property|lacking capability/i;

/**
 * What agents are told about the rights their Studio Luau has right now (one line of their Capabilities, or none).
 * `linked`: Shuriken Link's plugin serves the place (roblox/link). `restricted`: Studio's MCP path was asked and
 * refuses scripts (null: not asked yet).
 */
export function studioRightsLine(linked: boolean, restricted: boolean | null): string {
  if (linked)
    return "Studio code runs through Shuriken's Studio plugin: roblox_run_luau and playtest probes may create, copy and move scripts, require modules and fire events, in Edit and in a playtest's server and client, and may read Script.Source there. Edit-mode work does not wait for playtests: your code sync, roblox_run_luau in Edit and the builders go on while another agent plays (their running game keeps the copy made when it started; the next playtest has your changes). Only playtests, screenshots and Studio's own search and insert tools take turns. Game code still goes into files and roblox_sync_push; key presses and clicks go through roblox_input.";
  if (restricted)
    return 'Studio runs your Luau without script capabilities (Roblox, since 2026-10-01: "cannot reparent \u2026 Capabilities property"): in Edit you can\u2019t create, copy or move scripts or require modules from roblox_run_luau (code goes into files and roblox_sync_push, which still works), and restarting Studio changes nothing, so don\u2019t ask for it; in a playtest a probe that requires a module or fires an event is run inside the game for you (it then can\u2019t read Script.Source: read sources in a separate probe).';
  return '';
}

/** The host script (the same on the server and the client). */
export const HOST_SOURCE = `-- Shuriken Studio: runs playtest probes with the game's own rights while Studio's MCP code has fewer.
-- Added when a playtest starts, removed when it stops. Does nothing outside Studio.
if not game:GetService("RunService"):IsStudio() then return end
local HttpService = game:GetService("HttpService")
local job = script:WaitForChild("Job")
local function text(v)
	local t = typeof(v)
	if t == "string" then return v end
	if t == "table" then
		local ok, s = pcall(HttpService.JSONEncode, HttpService, v)
		return if ok then s else tostring(v)
	end
	return tostring(v)
end
local function run(n)
	local m = job:Clone()
	m.Name = "Run" .. n
	m.Parent = script
	local loaded, res = pcall(require, m)
	m:Destroy()
	local out = Instance.new("StringValue")
	out.Name = "Result" .. n
	if not loaded then
		out.Value = "0Failed to parse command code (the probe did not compile: see Studio's output)"
	elseif res[1] then
		out.Value = "1" .. text(res[2])
	else
		out.Value = "0" .. text(res[2])
	end
	out.Parent = script
end
script:GetAttributeChangedSignal("Run"):Connect(function()
	task.spawn(run, script:GetAttribute("Run"))
end)
script:SetAttribute("Ready", true)
`;

export const JOB_SOURCE = 'return { true, nil }\n';

/** A Luau long string that can hold any code. */
function longString(s: string): string {
  let eq = '';
  while (s.includes(`]${eq}]`)) eq += '=';
  // A long string drops a first newline: keep the code's own.
  return `[${eq}[\n${s}]${eq}]`;
}

/** The program the MCP thread runs to have `code` run by the host in this DataModel. */
export function bridgedProgram(code: string, datamodel: 'Server' | 'Client', timeoutSec: number): string {
  // The probe starts on the wrapper's first line, so its own line numbers hold.
  const job = `local __ok, __res = pcall(function() ${code}\nend)\nreturn { __ok, __res }`;
  const find =
    datamodel === 'Server'
      ? `game:GetService("ServerScriptService"):FindFirstChild("${HOST_NAME}")`
      : `(function() local p = game:GetService("Players").LocalPlayer local ps = p and p:FindFirstChild("PlayerScripts") return ps and ps:FindFirstChild("${HOST_NAME}") end)()`;
  return `local host
local t0 = os.clock()
repeat
	host = ${find}
	if host and host:GetAttribute("Ready") and host:FindFirstChild("Job") then break end
	host = nil
	task.wait(0.05)
until os.clock() - t0 > ${datamodel === 'Client' ? 6 : 3}
if not host then return "${NO_HOST}" end
host.Job.Source = ${longString(job)}
local n = (host:GetAttribute("Run") or 0) + 1
host:SetAttribute("Run", n)
local r
local deadline = os.clock() + ${Math.max(5, Math.round(timeoutSec))}
repeat
	r = host:FindFirstChild("Result" .. n)
	if not r then task.wait(0.03) end
until r or os.clock() > deadline
if not r then error("The probe did not finish within ${Math.max(5, Math.round(timeoutSec))} s (it ran inside the game, through ${HOST_NAME})", 0) end
local v = r.Value
r:Destroy()
if string.sub(v, 1, 1) ~= "1" then error(string.sub(v, 2), 0) end
return string.sub(v, 2)`;
}

/** Luau (Edit): is the MCP thread refused when it parents a script? "restricted" or "free". */
export const RESTRICTED_PROBE = `local ok = pcall(function()
	local m = Instance.new("ModuleScript")
	m.Name = "__ShurikenCapabilityProbe"
	m.Parent = game:GetService("ServerStorage")
	m:Destroy()
end)
return ok and "free" or "restricted"`;

const HOSTS = [`game:GetService("ServerScriptService")`, `game:GetService("StarterPlayer"):FindFirstChildOfClass("StarterPlayerScripts")`];
/** The hosts' DataModel paths, for Studio's script tool (dot notation) and their classes. */
export const HOST_SCRIPTS = [
  { path: `game.ServerScriptService.${HOST_NAME}`, className: 'Script' },
  { path: `game.ServerScriptService.${HOST_NAME}.Job`, className: 'ModuleScript' },
  { path: `game.StarterPlayer.StarterPlayerScripts.${HOST_NAME}`, className: 'LocalScript' },
  { path: `game.StarterPlayer.StarterPlayerScripts.${HOST_NAME}.Job`, className: 'ModuleScript' },
];

/** Luau (Edit): which of HOST_SCRIPTS exist, as a JSON array of booleans in that order. */
export const HOSTS_PRESENT = `local out = {}
for _, parent in { ${HOSTS.join(', ')} } do
	local h = parent and parent:FindFirstChild("${HOST_NAME}")
	table.insert(out, h ~= nil)
	table.insert(out, h ~= nil and h:FindFirstChild("Job") ~= nil)
end
return game:GetService("HttpService"):JSONEncode(out)`;

/** Luau (Edit): writes the hosts' sources (they exist). */
export const HOSTS_WRITE = `for _, parent in { ${HOSTS.join(', ')} } do
	local h = parent:FindFirstChild("${HOST_NAME}")
	h.Source = ${longString(HOST_SOURCE)}
	h:SetAttribute("Ready", nil)
	h:SetAttribute("Run", nil)
	h.Job.Source = ${JSON.stringify(JOB_SOURCE)}
	for _, c in h:GetChildren() do if c.Name ~= "Job" then c:Destroy() end end
end
return "ok"`;

/** Luau (Edit): removes the hosts. */
export const HOSTS_REMOVE = `for _, parent in { ${HOSTS.join(', ')} } do
	local h = parent and parent:FindFirstChild("${HOST_NAME}")
	if h then h:Destroy() end
end
return "ok"`;
