/**
 * Shuriken Link: a Studio plugin that runs Shuriken's Luau with a plugin's rights.
 *
 * Why. On 2026-10-01 Roblox took five script capabilities from code run through Studio's MCP server (the Assistant's
 * thread): it can't create scripts, require game modules or fire events any more (roblox/probe-bridge.ts has the
 * measurements and the workarounds). A plugin is Roblox's own extension point and is not on that path. Measured in a
 * scratch place the same evening with a local plugin:
 *   - Edit: no capability missing; creates scripts with their Source, requires game modules, fires events, has
 *     loadstring; a call takes 3-20 ms (the MCP path takes hundreds).
 *   - A playtest's server: the plugin runs there too with no capability missing, but without loadstring; code set
 *     as the Source of a ModuleScript and required by the plugin's thread runs with the plugin's rights (7-17 ms).
 *   - A playtest's client: the plugin runs but "Http requests can only be executed by game server", so the server
 *     instance relays its commands through a RemoteFunction (about 60 ms).
 *   - HTTP to 127.0.0.1 needs no prompt for a local plugin; simulated input is refused (RobloxScript), so key
 *     presses stay with Studio's MCP tools.
 *
 * How it talks. The plugin calls Shuriken (HTTP, loopback only); nothing calls the plugin. In Edit it asks each port
 * of LINK_PORTS whether a Shuriken project has this place; the core whose project is bound to the place claims it.
 * Both sides then prove they hold the key the plugin file was written with, without sending it (SHA-256 over the
 * key, both nonces and the port, so a process squatting another port can't relay a proof), and every later request
 * carries a key derived for that session. The plugin long-polls for commands, runs each in its own thread and posts
 * the result. A place nobody claims is left alone: the plugin runs no code there, ever.
 *
 * A playtest's DataModels are copies and know neither their place's name nor their Studio window, so the Edit
 * instance leaves "port|studio id" as the attribute ShurikenLink on ServerStorage; the server instance reads it.
 */

/** The ports a core listens on (the first free one); the plugin asks each. */
export const LINK_PORTS = Array.from({ length: 12 }, (_, i) => 47811 + i);
/** The plugin's protocol version: a core refuses a plugin that speaks another (the file is rewritten on start). */
export const LINK_VERSION = 1;
export const LINK_PLUGIN_FILE = 'ShurikenLink.rbxmx';
/** The attribute on ServerStorage that tells a playtest's plugin instance where its Edit instance is linked. */
export const LINK_ATTRIBUTE = 'ShurikenLink';
export const LINK_RELAY = 'ShurikenLinkRelay';
/** The most characters of a result the plugin posts (Studio's MCP cuts at about 100,000). */
export const LINK_MAX_RESULT = 900_000;

const SOURCE = String.raw`-- Shuriken Link __VERSION__ (Shuriken Studio). Runs Luau that Shuriken sends for the place a Shuriken project is
-- linked to, and nothing anywhere else. It only ever talks to this PC (127.0.0.1) and checks that the other end
-- holds this file's key before it runs anything. Remove it in Shuriken: Settings > Roblox > Studio plugin (off).
local VERSION = __VERSION__
local PORTS = { __PORTS__ }
local KEY = "__KEY__"
local ATTR = "__ATTR__"
local RELAY = "__RELAY__"
local MAX_RESULT = __MAX_RESULT__

local RunService = game:GetService("RunService")
local HttpService = game:GetService("HttpService")
local where = if not RunService:IsRunning() then "Edit" elseif RunService:IsClient() and not RunService:IsServer() then "Client" else "Server"

-- ── Running code with this plugin's rights ───────────────────────────────────────────────────────────────────
local function text(v)
	local t = typeof(v)
	local s
	if t == "string" then
		s = v
	elseif t == "table" then
		local ok, encoded = pcall(HttpService.JSONEncode, HttpService, v)
		s = if ok then encoded else tostring(v)
	else
		s = tostring(v)
	end
	if #s > MAX_RESULT then s = string.sub(s, 1, MAX_RESULT) .. "\n[cut: the result had " .. #s .. " characters]" end
	return s
end

local canLoadstring = pcall(function() return loadstring("return 1")() end)

-- Edit has loadstring. A playtest has none: there the code becomes a module this thread requires.
local function exec(code)
	if canLoadstring then
		local fn, err = loadstring(code)
		if not fn then return false, "Failed to parse command code: " .. tostring(err) end
		local ok, res = pcall(fn)
		return ok, text(res)
	end
	local m = Instance.new("ModuleScript")
	m.Name = "ShurikenLinkJob"
	local okSource, errSource = pcall(function() m.Source = "local __ok, __res = pcall(function() " .. code .. "\nend)\nreturn { __ok, __res }" end)
	if not okSource then return false, "Shuriken Link could not run this: " .. tostring(errSource) end
	local loaded, r = pcall(require, m)
	m:Destroy()
	if not loaded then return false, "Failed to parse command code (it did not compile: see Studio's output)" end
	return r[1], text(r[2])
end

-- ── The client of a playtest: no HTTP there, so its commands come through the server instance ───────────────
if where == "Client" then
	local relay = game:GetService("ReplicatedStorage"):WaitForChild(RELAY, 20)
	if relay and relay:IsA("RemoteFunction") then
		relay.OnClientInvoke = function(code)
			if code == nil then return true, "ready" end
			return exec(code)
		end
	end
	return
end

-- ── SHA-256 (for the two proofs; Luau has no hash of its own) ───────────────────────────────────────────────
local band, bxor, bnot, rshift, rrotate = bit32.band, bit32.bxor, bit32.bnot, bit32.rshift, bit32.rrotate
local K = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local M = 4294967296
local function sha256(msg)
	local h0, h1, h2, h3, h4, h5, h6, h7 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	local len = #msg
	local padded = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. string.pack(">I4I4", 0, len * 8)
	local w = table.create(64, 0)
	for chunk = 1, #padded, 64 do
		for i = 0, 15 do
			w[i + 1] = string.unpack(">I4", padded, chunk + i * 4)
		end
		for i = 17, 64 do
			local x, y = w[i - 15], w[i - 2]
			local s0 = bxor(rrotate(x, 7), rrotate(x, 18), rshift(x, 3))
			local s1 = bxor(rrotate(y, 17), rrotate(y, 19), rshift(y, 10))
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) % M
		end
		local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
		for i = 1, 64 do
			local S1 = bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
			local ch = bxor(band(e, f), band(bnot(e), g))
			local t1 = (h + S1 + ch + K[i] + w[i]) % M
			local S0 = bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
			local maj = bxor(band(a, b), band(a, c), band(b, c))
			local t2 = (S0 + maj) % M
			h, g, f, e, d, c, b, a = g, f, e, (d + t1) % M, c, b, a, (t1 + t2) % M
		end
		h0, h1, h2, h3 = (h0 + a) % M, (h1 + b) % M, (h2 + c) % M, (h3 + d) % M
		h4, h5, h6, h7 = (h4 + e) % M, (h5 + f) % M, (h6 + g) % M, (h7 + h) % M
	end
	return string.format("%08x%08x%08x%08x%08x%08x%08x%08x", h0, h1, h2, h3, h4, h5, h6, h7)
end

-- ── Talking to Shuriken ──────────────────────────────────────────────────────────────────────────────────────
local function post(port, path, body, bearer)
	local headers = { ["Content-Type"] = "application/json" }
	if bearer then headers.Authorization = "Bearer " .. bearer end
	local ok, res = pcall(function()
		return HttpService:RequestAsync({ Url = "http://127.0.0.1:" .. port .. path, Method = "POST", Headers = headers, Body = HttpService:JSONEncode(body) })
	end)
	if not ok then return nil, tostring(res) end
	local decoded = nil
	if res.StatusCode == 200 then
		local okJson, data = pcall(HttpService.JSONDecode, HttpService, res.Body)
		if okJson then decoded = data end
	end
	return res.StatusCode, decoded
end

-- Asks one port whether a Shuriken project has this place, and proves both ends hold the key. Nothing is run and no
-- key-derived value is sent before the other end's proof (which covers the port asked) has been checked.
local function handshake(port, hello)
	local nonce = HttpService:GenerateGUID(false)
	hello.v = VERSION
	hello.nonce = nonce
	local status, r = post(port, "/link/hello", hello)
	if status ~= 200 or type(r) ~= "table" or not r.claimed then return nil end
	if type(r.nonce) ~= "string" or type(r.session) ~= "string" or type(r.proof) ~= "string" then return nil end
	if r.proof ~= sha256(KEY .. "|server|" .. nonce .. "|" .. r.nonce .. "|" .. port) then
		warn("Shuriken Link: port " .. port .. " answered without this plugin's key; ignored")
		return nil
	end
	return { port = port, id = r.session, key = sha256(KEY .. "|client|" .. nonce .. "|" .. r.nonce .. "|" .. r.session) }
end

-- Fetches commands for one session until Shuriken lets go of it; each command runs in its own thread and posts
-- its own result, so a long one never holds up the next.
local function serve(session, run, beat)
	local threads = {}
	local fails = 0
	while true do
		local body = { session = session.id }
		if beat then beat(body) end
		local status, data = post(session.port, "/link/poll", body, session.key)
		if status == 200 and data then
			fails = 0
			for _, id in data.cancel or {} do
				if threads[id] then
					pcall(task.cancel, threads[id])
					threads[id] = nil
				end
			end
			for _, cmd in data.commands or {} do
				threads[cmd.id] = task.spawn(function()
					local ok, out = run(cmd.code)
					threads[cmd.id] = nil
					for attempt = 1, 3 do
						if post(session.port, "/link/result", { session = session.id, id = cmd.id, ok = ok and true or false, text = out }, session.key) == 200 then break end
						task.wait(0.3 * attempt)
					end
				end)
			end
			if data.bye then break end
		elseif status == 401 or status == 403 or status == 404 or status == 410 then
			break
		else
			fails += 1
			if fails >= 4 then break end
			task.wait(fails)
		end
	end
	for _, t in threads do pcall(task.cancel, t) end
end

local ServerStorage = game:GetService("ServerStorage")

-- ── The server of a playtest: linked when its Edit instance is ──────────────────────────────────────────────
if where == "Server" then
	local mark = ServerStorage:GetAttribute(ATTR)
	local port, studio = string.match(if type(mark) == "string" then mark else "", "^(%d+)|([%w%-]+)$")
	port = tonumber(port)
	if not port or not table.find(PORTS, port) then return end
	local session = handshake(port, { dm = "Server", studio = studio })
	if not session then return end
	local relay = Instance.new("RemoteFunction")
	relay.Name = RELAY
	relay.Parent = game:GetService("ReplicatedStorage")
	task.spawn(function()
		local Players = game:GetService("Players")
		local player = Players:GetPlayers()[1] or Players.PlayerAdded:Wait()
		-- The client's instance answers once it has found the relay.
		local ready = false
		for _ = 1, 40 do
			local thread = task.spawn(function()
				local ok, a = pcall(function() return relay:InvokeClient(player) end)
				if ok and a == true then ready = true end
			end)
			local t0 = os.clock()
			while not ready and os.clock() - t0 < 1.5 do task.wait(0.1) end
			if ready then break end
			pcall(task.cancel, thread)
		end
		if not ready then return end
		local client = handshake(port, { dm = "Client", studio = studio })
		if not client then return end
		serve(client, function(code)
			local ok, a, b = pcall(function() return relay:InvokeClient(player, code) end)
			if not ok then return false, "The playtest's client did not answer: " .. tostring(a) end
			return a, b
		end)
	end)
	serve(session, exec)
	return
end

-- ── Edit: find the Shuriken project that has this place, stay linked to it, look again when it lets go ──────
local studio = HttpService:GenerateGUID(false)
local function identity(into)
	into.place = game.Name
	into.placeId = game.PlaceId
	into.gameId = game.GameId
	return into
end
local function previous()
	local mark = ServerStorage:GetAttribute(ATTR)
	return if type(mark) == "string" then string.match(mark, "^%d+|([%w%-]+)$") else nil
end

local tries = 0
while true do
	local session = nil
	for _, port in PORTS do
		session = handshake(port, identity({ dm = "Edit", studio = studio, prev = previous() }))
		if session then break end
	end
	if session then
		tries = 0
		local mark = session.port .. "|" .. studio
		if ServerStorage:GetAttribute(ATTR) ~= mark then ServerStorage:SetAttribute(ATTR, mark) end
		serve(session, exec, identity)
	end
	tries += 1
	-- Nobody has this place (or Shuriken isn't running): look again, less often as time passes.
	task.wait(if tries <= 20 then 6 else 30)
end
`;

export interface LinkPluginOptions {
  /** The shared key (hex): never sent, only proven. */
  key: string;
  ports?: readonly number[];
}

/** The plugin's Luau. */
export function linkPluginSource(o: LinkPluginOptions): string {
  if (!/^[0-9a-f]{32,128}$/.test(o.key)) throw new Error('The link key must be hex');
  return SOURCE.replaceAll('__VERSION__', String(LINK_VERSION))
    .replace('__PORTS__', (o.ports ?? LINK_PORTS).join(', '))
    .replace('__KEY__', o.key)
    .replace('__ATTR__', LINK_ATTRIBUTE)
    .replace('__RELAY__', LINK_RELAY)
    .replace('__MAX_RESULT__', String(LINK_MAX_RESULT));
}

/** The plugin as a model file Studio loads from its Plugins folder: one Script. */
export function linkPluginFile(o: LinkPluginOptions): string {
  const source = linkPluginSource(o);
  if (source.includes(']]>')) throw new Error('The plugin source cannot contain "]]>"');
  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
  <Item class="Script" referent="RBX0">
    <Properties>
      <string name="Name">ShurikenLink</string>
      <ProtectedString name="Source"><![CDATA[${source}]]></ProtectedString>
    </Properties>
  </Item>
</roblox>
`;
}
