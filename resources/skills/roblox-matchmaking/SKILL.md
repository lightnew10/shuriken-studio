---
name: roblox-matchmaking
description: "Session-based multiplayer on Roblox with Shuriken's generated ShurikenMatch module: lobby, cross-server queue, private match servers, back to the lobby (1v1/2v2 arenas, team modes, ranked or casual). One place in two roles: public servers are the lobby, reserved servers of the same place are matches; a matchmaker lobby holding a MemoryStore lock forms matches and keeps the match record server-side; in Studio a queue starts a test match in the same server with bots in the empty places. Covers when a game needs it, modes with match_setup (teams, teamSize, ranked windows, maxWaitSec, botsAfterSec, startTimeoutSec, rejoin), writing the match around Match.onStart/onPlayerLeft/onPlayerJoined/finish so the same code runs live and in Studio, lobby UI on Match.state (queue, timer, cancel, found, teleporting, notices, rejoin prompt), parties, ranked Elo kept in the player's save with held losses against leavers, bots and empty places, the match server lifecycle, anti-cheat (server authority, never trust TeleportData), MemoryStore/MessagingService/teleport limits, Studio checks and the live checks only the user can run after publishing."
version: 1
tags: [matchmaking, lobby, queue, match, session, ranked, elo, rating, party, rejoin, bots, teleport, reserved server, memorystore, duel, arena, 1v1, 2v2, team modes, pvp]
roblox_systems: [TeleportService, MemoryStoreService, MessagingService, DataModel, Players, SocialService, DataStoreService]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [match_setup, match_get, roblox_sync_push, roblox_playtest, roblox_run_luau, roblox_console, luau_check, task_add_evidence]
---
# Session-based matches: lobby, queue, match servers (ShurikenMatch)

## Purpose and scope
Players wait in a lobby, queue for a mode, play a match on a private server with only their match's players, and come
back. Shuriken generates the runtime, `ShurikenMatch` (`src/Shared/ShurikenMatch.luau`, required as
`game.ReplicatedStorage.Shared.ShurikenMatch` by a server script at startup and by the client): queue, matchmaker, lock,
reserved servers, teleports, match records, rejoin, Studio's test mode. You write what a match **is** (roblox-engineer), the
lobby UI (ui-engineer), the modes and ranked rules (game designer). **Never write a queue, lock, MemoryStore,
MessagingService or TeleportService code of your own, and never edit the module**: modes change through `match_setup`.
Labels: **[docs]** Creator Hub (read 2026-10-03), **[forum]** DevForum, **[practice]** what games do.

## 1. When a game needs this
- **Yes**: a match has a fixed roster, a start and an end (duels, 2v2/3v3 arenas, mech or tank battles, team objectives,
  anything ranked, co-op runs for one party); joiners mid-match would break it; players should meet their level from every
  server, not only the 20 in theirs.
- **No**: drop-in public servers do the job (free-for-all arenas like the Pit: skill roblox-pvp-combat; simulators, hangouts),
  or rounds inside one server are enough (a 12-player party game).
- Each mode is its own queue and splits the players: launch with 1-3 modes, one casual mode that always starts (bots after a
  short wait), and ranked once there are players to rank (or behind a level gate) [practice].

## 2. How it works (decided: don't redesign it)
- **One place, two roles.** Public servers are the lobby; a reserved server of the same place is a match
  (`game.PrivateServerId ~= "" and game.PrivateServerOwnerId == 0` [docs]). `Match.role` is `"lobby"` or `"match"`; a paid
  private server is a lobby. The place holds the lobby area **and** the arena, and every server runs every script.
- The queue is a MemoryStore sorted map per mode. One lobby server at a time holds a lock and forms matches (oldest first;
  ranked: ratings within a window that widens with the wait), reserves a server, keeps the record (mode, teams by user id)
  in MemoryStore and has each lobby server send its players. The match server reads the record, sends anyone not in it
  back, waits up to `startTimeoutSec`, then fires `Match.onStart(match)`; `Match.finish` sends everyone back together.
- **Studio has no teleports** [docs]: `Match.role` is always `"lobby"`, `Match.queue` starts a test match in the same server
  about 2 s later (`match.test = true`, empty places in `match.bots`), and `Match.finish` fires `Match.returned(players,
  results)` there instead of teleporting.
- So: register match handlers in **every** role (Studio's test match runs inside the lobby server); start lobby-only systems
  when `Match.role == "lobby"`. Bootstrap: `PlayerData.start(); Arena.start(); if Match.role == "lobby" then Lobby.start() end`.
  Arena spawn points are plain Parts (`Workspace.Arena.Spawns.Team1`, ...): the lobby's SpawnLocation is the only one. On a
  match server players wait for `onStart` where it puts them: hide queue pads and shops there when `Match.role == "match"`.

## 3. Modes: `match_setup`
Read `match_get` before changing anything. A mech arena with a ranked duel and a casual 2v2:
```text
match_setup {modes: [
  {key: "Duel", name: "Ranked Duel", teams: 2, teamSize: 1, ranked: true, ratingWindow: 100, ratingWidenPerSec: 5, maxWaitSec: 120},
  {key: "Brawl", name: "2v2 Brawl", teams: 2, teamSize: 2, botsAfterSec: 40}],
 startTimeoutSec: 40, rejoin: true}
```
| Field | Meaning | Advice |
|---|---|---|
| `key` | PascalCase, 2-24 letters and digits | stable forever: saves keep ratings under it |
| `name` | shown to players, up to 40 characters | "Ranked Duel", "2v2 Brawl" |
| `teams`, `teamSize` | 1-12 each, at most 50 players a match | free-for-all = N teams of 1; co-op = 1 team; the place's max players must fit the biggest match and the lobby |
| `ranked` | close ratings meet (`Match.useRating`) | one main competitive mode |
| `ratingWindow`, `ratingWidenPerSec` | ranked: allowed gap at first, growth per second waited (100, 5) | +-400 after a minute |
| `maxWaitSec` | after this, ratings are ignored (10-900, default 90) | ranked 120-180 |
| `botsAfterSec` | after this, start with whoever is queued, empty places are bots (5-900; absent = full matches only) | casual 30-60; absent on ranked |
| `startTimeoutSec` | the match server waits this long, then starts with who came (10-120, default 30) | 40: phones load slowly |
| `rejoin` | a dropped player is offered their unfinished match from the lobby (default true) | on for matches over 2 minutes |

## 4. The match: one code path, live and in Studio
`match = {id, mode, ranked, teams = {{Player}}, players = {Player}, bots, test}` (type `Match.MatchInfo`). The module keeps
`teams` and `players` to the players **still here**: a leaver is removed before `Match.onPlayerLeft(match, player)`, a
rejoiner added before `Match.onPlayerJoined(match, player)`; snapshot the roster at start. `Match.current()` is the running match.
```lua
--!strict
-- src/Server/Arena.luau: the match, on a live match server and in Studio's test match alike.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")
local Match = require(ReplicatedStorage.Shared.ShurikenMatch)
local Elo = require(ReplicatedStorage.Shared.Elo)
local PlayerData = require(script.Parent.PlayerData) -- session-locked saves (skill roblox-data-persistence)
local Bots = require(script.Parent.Bots) -- your AI for the empty places (skill roblox-creature-ai)

local SCORE_TO_WIN, MAX_SECONDS, RESULTS_SECONDS, REJOIN_GRACE, K = 5, 300, 6, 45, 32
local spawns = Workspace:WaitForChild("Arena"):WaitForChild("Spawns")
type Game = { score: { number }, roster: { { number } }, before: { [number]: number }?, over: boolean }
local games: { [string]: Game } = {}
local Arena = {}

local function dataOf(userId: number): any
	local player = Players:GetPlayerByUserId(userId)
	return if player then PlayerData.get(player) else nil
end

-- Ranked: before + change into each loaded save (only `team`'s when given). Returns the changes by user id.
local function rate(mode: string, g: Game, scores: { number }, team: number?): { [string]: number }
	local before = g.before :: { [number]: number }
	local ratings: { { number } }, changes: { [string]: number } = {}, {}
	for t, ids in g.roster do
		ratings[t] = {}
		for _, id in ids do
			table.insert(ratings[t], before[id])
		end
	end
	local deltas = Elo.teamDeltas(ratings, scores, K)
	for t, ids in g.roster do
		for _, id in ids do
			changes[tostring(id)] = deltas[t]
			local data = dataOf(id) -- nil once they left: the loss held since the start stands
			if data and (team == nil or team == t) then
				data.ratings[mode] = before[id] + deltas[t]
			end
		end
	end
	return changes
end

function Arena.finish(match: Match.MatchInfo)
	local g = games[match.id]
	if not g or g.over then
		return
	end
	g.over = true
	local winner, best = 0, -1 -- 0: a draw
	for t, s in g.score do
		if s > best then
			winner, best = t, s
		elseif s == best then
			winner = 0
		end
	end
	local changes: { [string]: number } = if g.before then rate(match.mode, g, g.score) else {}
	for t, ids in g.roster do -- into the saves BEFORE finish (each profile is saved as its player leaves)
		for _, id in ids do
			local data = dataOf(id)
			if data then
				data.lastMatch = { mode = match.mode, won = t == winner, change = changes[tostring(id)] or 0, at = os.time() }
			end
		end
	end
	Workspace:SetAttribute("Winner", winner)
	Workspace:SetAttribute("MatchPhase", "results")
	task.wait(RESULTS_SECONDS)
	Match.finish(match, { winner = winner, score = g.score, ratings = changes })
	Workspace:SetAttribute("MatchPhase", nil) -- Studio: this server carries on as the lobby
	Bots.clear()
	games[match.id] = nil
end

local function begin(match: Match.MatchInfo)
	local g: Game = { score = table.create(#match.teams, 0), roster = {}, over = false }
	games[match.id] = g
	local before: { [number]: number } = {}
	local rated = match.ranked and match.bots == 0 -- never rated against bots
	for t, team in match.teams do
		g.roster[t] = {}
		for _, p in team do
			table.insert(g.roster[t], p.UserId)
			p:SetAttribute("Team", t)
			task.spawn(p.LoadCharacterAsync, p)
			local deadline = os.clock() + 15 -- the profile may still be on its way from the lobby server
			while not PlayerData.get(p) and p.Parent == Players and os.clock() < deadline do
				task.wait(0.25)
			end
			local data = PlayerData.get(p)
			if data then
				before[p.UserId] = data.ratings[match.mode] or 1000
			else
				rated = false
			end
		end
	end
	Bots.fill(match) -- the empty places: AI with a Team attribute, or nothing to play short
	if rated then
		g.before = before
		for t in g.roster do -- each save holds a loss until the result replaces it: leaving can't dodge it
			local lost = table.create(#g.roster, 1)
			lost[t] = 0
			rate(match.mode, g, lost, t)
		end
	end
	Workspace:SetAttribute("MatchPhase", "countdown") -- the match HUD follows MatchPhase, Score<n>, Winner
	task.wait(3)
	Workspace:SetAttribute("MatchPhase", "fight")
	task.delay(MAX_SECONDS, Arena.finish, match)
end

-- Your one damage entry point calls this on a kill (skill roblox-pvp-combat); bots carry a Team attribute too.
function Arena.scored(team: number)
	local match = Match.current()
	local g = if match then games[match.id] else nil
	if not match or not g or g.over or not g.score[team] or Workspace:GetAttribute("MatchPhase") ~= "fight" then
		return
	end
	g.score[team] += 1
	Workspace:SetAttribute(`Score{team}`, g.score[team])
	if g.score[team] >= SCORE_TO_WIN then
		Arena.finish(match)
	end
end

function Arena.start()
	local function watch(p: Player) -- every (re)spawn of a player with a Team goes to that team's spawn point
		p.CharacterAdded:Connect(function(character: Model)
			local point = spawns:FindFirstChild(`Team{p:GetAttribute("Team")}`)
			if point and point:IsA("BasePart") then
				character:WaitForChild("HumanoidRootPart", 5)
				character:PivotTo(point.CFrame + Vector3.new(0, 4, 0))
			end
		end)
	end
	Players.PlayerAdded:Connect(watch)
	for _, p in Players:GetPlayers() do
		watch(p)
	end
	Match.onStart(begin)
	Match.onPlayerLeft(function(match: Match.MatchInfo, _player: Player)
		task.delay(REJOIN_GRACE, function() -- a dropped player may come back first
			local g, standing: { number } = games[match.id], {}
			if not g or g.over then
				return
			end
			for t, team in match.teams do
				if #team > 0 then
					table.insert(standing, t)
				end
			end
			local forfeit = #standing == 1 and match.bots == 0 -- the last team with players wins
			if forfeit then
				g.score[standing[1]] = SCORE_TO_WIN
			end
			if forfeit or #standing == 0 then -- otherwise play on short-handed
				Arena.finish(match)
			end
		end)
	end)
	Match.onPlayerJoined(function(match: Match.MatchInfo, player: Player) -- back through rejoin
		for t, team in match.teams do
			if table.find(team, player) then
				player:SetAttribute("Team", t)
				task.spawn(player.LoadCharacterAsync, player)
			end
		end
	end)
end

return Arena
```
Lifecycle: arrive (client state `"match"`, HUD "Waiting for players" until `MatchPhase`) -> `onStart` (spawn, bots, held
losses, countdown) -> play -> someone leaves (grace, then forfeit or short-handed) -> results into the saves -> results
screen -> `Match.finish`. Every match ends: score, time cap or forfeit. On a shutdown mid-match the module sends everyone
back; give held losses back in a `game:BindToClose` that sets each `before` rating (instant, no yields). Update a live game
with a server restart delayed longer than a match (1-60 min bleed-off) [docs].

## 5. The lobby: parties, ratings, Studio's way back
The client's `Match.queue(modeKey)` queues that player alone. For a party (Roblox Parties: `Player.PartyId`,
`SocialService:GetPlayersByPartyId` [docs]; or your own invites) the button fires your remote and the server queues the
party in this server with `Match.queue(players, modeKey)`: one entry, one team. The module refuses parties over `teamSize`
and players already queued or in a match (its reason comes back as the second value); your code adds the ranked rules.
```lua
--!strict
-- src/Server/Lobby.luau
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local SocialService = game:GetService("SocialService")
local Match = require(ReplicatedStorage.Shared.ShurikenMatch)
local PlayerData = require(script.Parent.PlayerData)

local remotes = ReplicatedStorage:WaitForChild("Remotes")
local PartyPlay = remotes:WaitForChild("PartyPlay") :: RemoteEvent -- client -> server: a mode key
local Notice = remotes:WaitForChild("Notice") :: RemoteEvent -- server -> client: why not
local MAX_SPREAD = 400
local lastAsk: { [Player]: number } = {}
local Lobby = {}

local function rating(player: Player, modeKey: string): number
	local data = PlayerData.get(player)
	return if data then data.ratings[modeKey] or 1000 else 1000
end

local function queueParty(player: Player, modeKey: unknown)
	local mode = if type(modeKey) == "string" then Match.modes[modeKey] else nil
	if not mode or os.clock() - (lastAsk[player] or 0) < 1 then
		return
	end
	lastAsk[player] = os.clock()
	local party: { Player } = if player.PartyId ~= "" then SocialService:GetPlayersByPartyId(player.PartyId) else { player }
	local low, high = math.huge, -math.huge
	for _, member in party do
		low, high = math.min(low, rating(member, mode.key)), math.max(high, rating(member, mode.key))
	end
	local ok: boolean, err: string? = false, "Your party's ratings are too far apart for ranked."
	if not mode.ranked or high - low <= MAX_SPREAD then
		ok, err = Match.queue(party, mode.key)
	end
	if not ok then
		Notice:FireClient(player, err or "Couldn't join the queue.")
	end
end

function Lobby.start()
	Match.useRating(rating) -- ranked windows use the game's saved ratings
	PartyPlay.OnServerEvent:Connect(queueParty)
	Players.PlayerRemoving:Connect(function(player: Player)
		lastAsk[player] = nil
	end)
	Match.returned:Connect(function(players: { Player }, _results: any) -- Studio: the test match ended in this server
		for _, p in players do
			p:SetAttribute("Team", nil)
			task.spawn(p.LoadCharacterAsync, p) -- back on the lobby's SpawnLocation
		end
	end)
end

return Lobby
```
Live, players come back as fresh joins of a lobby server; show `data.lastMatch` as a card. Also on the server:
`Match.status(player)` (`{mode, since}` while queued), `Match.leave(player)`, `Match.rejoin(player)`; events `Match.queued(player,
mode)`, `Match.left(player)`, `Match.found(players, info)` (just before they go), `Match.rejoinable(player, matchId)`.

## 6. Lobby UI (ui-engineer)
`Match.state:Connect(fn(state, info))` drives the panel, `Match.currentState()` is the state now, `Match.notice:Connect(fn(text))`
says why the server refused (the state stays). The client only asks: `Match.queue(key)`, `Match.leave()`, `Match.rejoin()`.
| State (info) | Show | Controls |
|---|---|---|
| `idle` (`why`?) | mode cards (name, "2v2", Ranked badge with tier and rating), last-match card; `why` in one line | Play per mode |
| `queued` (`mode`, `since`) | the mode and elapsed m:ss (no invented ETA); the player keeps walking the lobby | Cancel, in thumb reach |
| `found` (`mode`) | "Match found!" with a sting, about 1 s | none |
| `teleporting` (`mode`; `results` after a match) | a full-screen fade: "Joining the match..." / "Back to the lobby..." | none |
| `match` (`id`, `mode`) | lobby UI off; the match HUD (waiting, countdown, score, results) | the game's |
| `rejoinable` (`mode`) | "Your match is still on" + Rejoin + Not now; ranked: "Leaving counts as a loss" | `Match.rejoin()` |
```lua
--!strict
-- src/Client/PlayPanel.client.luau: the lobby's play panel follows Match.state; the server decides everything.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Match = require(ReplicatedStorage.Shared.ShurikenMatch)

local gui = Players.LocalPlayer:WaitForChild("PlayerGui"):WaitForChild("PlayPanel") :: ScreenGui
local play = gui:WaitForChild("Play") :: TextButton -- one per mode in a real lobby
local cancel = gui:WaitForChild("Cancel") :: TextButton
local rejoin = gui:WaitForChild("Rejoin") :: TextButton
local status = gui:WaitForChild("Status") :: TextLabel
local TEXT: { [string]: string } = { found = "Match found!", teleporting = "Joining the match...", rejoinable = "Your match is still on." }
local state, queuedAt = Match.currentState(), os.clock()

local function show(newState: string, info: { [string]: any })
	state, queuedAt = newState, os.clock()
	play.Visible = state == "idle" or state == "rejoinable"
	cancel.Visible = state == "queued"
	rejoin.Visible = state == "rejoinable"
	gui.Enabled = state ~= "match" -- the match HUD takes over (Studio's test match too)
	status.Text = if type(info.why) == "string" then info.why -- a party member left, the server couldn't be reached
		elseif state == "teleporting" and info.results ~= nil then "Back to the lobby..."
		else TEXT[state] or ""
end

show(state, {})
Match.state:Connect(function(newState: string, info: any)
	show(newState, if type(info) == "table" then info else {})
end)
Match.notice:Connect(function(text: string) -- already queued, party too big...
	status.Text = text
end)
play.Activated:Connect(function() -- a party: fire your PartyPlay remote instead
	Match.queue("Duel")
end)
cancel.Activated:Connect(function()
	Match.leave()
end)
rejoin.Activated:Connect(function()
	Match.rejoin()
end)
while true do
	task.wait(0.5)
	if state == "queued" then
		local t = math.floor(os.clock() - queuedAt)
		status.Text = string.format("In queue %d:%02d", t // 60, t % 60)
	end
end
```
Phone layout, tap sizes and motion: skills roblox-ui-design and roblox-game-hud. No purchase offers on found or teleporting.

## 7. Ranked ratings (the game's, in the save)
- Save fields (skill roblox-data-persistence: template and migration): `ratings: { [string]: number }` (by mode key, start
  1000) and `lastMatch: { [string]: any }?`. The lobby passes ratings with `Match.useRating`; the match server reads them
  from the profile **it** loaded, never from the record or the client.
- **Elo** [practice]: `E = 1 / (1 + 10^((Ropp - R) / 400))`, `R' = R + K * (S - E)`, `S` = 1 win, 0.5 draw, 0 loss. A team
  uses its average and each member gets the team's change; more than two teams average the pairwise results. K = 32 (48 for
  the first 10 ranked matches). 1000 beats 1200: +24 / -24; 1200 beats 1000: +8 / -8.
- **Held loss**: from the start each rated save holds a loss that the result replaces, so leaving or crashing out can't dodge
  it; a shutdown gives it back. No rating with bots.
- Show tiers and the change after each match (Bronze < 900, Silver < 1100, Gold < 1300, Platinum < 1500, Diamond). Top games
  add [practice]: a party spread limit (RIVALS: 800 across 4 tiers), a 5-15 minute lockout after abandoning (save
  `rankedLockUntil`), placement matches, decay at the top, and gates against alts: level or matches played,
  `Player.AccountAge`, `Player:IsVerified()` [docs: always false in Studio].
```lua
--!strict
-- src/Shared/Elo.luau: each team's change from its players' ratings and the teams' scores (higher wins).
local Elo = {}

function Elo.teamDeltas(ratings: { { number } }, scores: { number }, k: number): { number }
	local avg: { number }, deltas: { number }, n = {}, {}, #ratings
	for t, team in ratings do
		local sum = 0
		for _, r in team do
			sum += r
		end
		avg[t] = sum / math.max(#team, 1)
	end
	for i = 1, n do
		local change = 0
		for j = 1, n do -- every other team, once; averaged over them
			local actual = if scores[i] > scores[j] then 1 elseif scores[i] == scores[j] then 0.5 else 0
			local expected = 1 / (1 + 10 ^ ((avg[j] - avg[i]) / 400))
			if j ~= i then
				change += k * (actual - expected) / (n - 1)
			end
		end
		deltas[i] = math.round(change)
	end
	return deltas
end

return Elo
```

## 8. Bots and empty places
`match.bots` counts empty places: `botsAfterSec` matches, no-shows after `startTimeoutSec`, every Studio test match (a Duel
tested alone has 1). Per team: `Match.modes[match.mode].teamSize - #match.teams[t]`. Fill them with AI using the same
loadout, a little below an average player and labelled as bots (never passed off as people), or play short with a handicap
for the smaller team. Bots score through `Arena.scored(team)`. Ranked: no `botsAfterSec`, no rating when `match.bots > 0`.

## 9. Anti-cheat basics
- The server decides; the client asks. The module validates and rate-limits its requests; your remotes check types,
  rate-limit and re-check (mode exists, party is real, ratings from the save).
- Teams, mode and roster come only from `Match.onStart` (the server-side record), never from `TeleportData`,
  `GetJoinData`, client attributes or remotes: teleport data is visible to and sent by the client [docs]. Put nothing in it.
- Kills, scores, winners and ratings are computed on the match server (skills roblox-pvp-combat, roblox-networking-security);
  no "I won" remote; players without a `Team` attribute take no part. Held losses, a leaver lockout, a party spread limit
  and ranked gates stop dodging, boosting and alts.

## 10. Limits to respect [docs unless marked]
| Limit | Value | So |
|---|---|---|
| MemoryStore | 1000 + 120 x concurrent users requests per minute (whole experience); 32 KB values; memory 64 KB + 1.2 KB x users | the module spends it: never poll MemoryStore yourself; keep `results` small |
| MessagingService | 1 kB messages; 600 + 240 x players sent per server per minute; best effort, usually 1-2 s | the module's channel; add no chatter of your own |
| Teleports | server only; at most 50 players a call; none in Studio | a match fits 50 and the place's max players |
| `BindToClose` | 30 s; no teleports in moderation shutdowns | close handlers stay instant |
| Regions [forum] | no choice; a reserved server usually starts near the first player to arrive | few players online: some matches cross continents |
| Saves | the lobby releases a profile as the player leaves; the match server waits for it | wait for data in `onStart` (15 s) |

## 11. Testing: Studio, then live
**In Studio** (Shuriken's playtests have one player): `luau_check`, `roblox_sync_push`, `roblox_playtest`, then this Server
probe (`roblox_run_luau`); record the PASS with `task_add_evidence`. Then play it: Play in the UI shows idle -> queued ->
found -> match -> idle; Cancel; a second Play while queued gives a notice. `Elo.teamDeltas({{1000}, {1200}}, {1, 0}, 32)`
is `{24, -24}`. Parties and leavers need Server & Clients (2-8 clients) with the Party Simulator [docs]: the user's step.
```lua
-- Server probe during a playtest: a queue starts a test match here, and its finish brings the player back.
local Players, Workspace = game:GetService("Players"), game:GetService("Workspace")
local Match = require(game:GetService("ReplicatedStorage").Shared.ShurikenMatch)
local Arena = require(game:GetService("ServerScriptService").Server.Arena)
local player = Players:GetPlayers()[1]
if not player or Match.role ~= "lobby" then
	return "FAIL: no player, or not the lobby in Studio"
end
local ok, err = Match.queue(player, "Duel")
if not ok then
	return `FAIL: queue refused: {err}`
end
task.wait(7) -- the test match starts about 2 s after the queue, then the 3 s countdown
local match, phase, team = Match.current(), Workspace:GetAttribute("MatchPhase"), player:GetAttribute("Team")
if not match or not match.test or match.bots ~= 1 or team ~= 1 and team ~= 2 or phase ~= "fight" then
	return `FAIL: match {match ~= nil}, bots {match and match.bots}, team {team}, phase {phase}`
end
Arena.finish(match) -- about RESULTS_SECONDS
task.wait(1) -- Match.returned runs deferred
if Match.current() ~= nil or player:GetAttribute("Team") ~= nil then
	return "FAIL: still in the match after finish"
end
return "PASS"
```
**Only live** (Shuriken never publishes; hand the user this list for after they publish, with a second account or a
friend): players from two lobby servers meet in one match server on the right teams; a no-show starts the match after
`startTimeoutSec` with a bot; finish brings everyone back together; a disconnected player is offered the rejoin; ranked
ratings are saved and shown in the lobby; ping and region of match servers; a server restart mid-match; the MemoryStore
observability dashboard shows no throttling. MemoryStore and teleports only work in a published place [docs].

## Checklist
- [ ] The game is match-based; 1-3 modes at launch; casual has `botsAfterSec`, ranked doesn't; keys final.
- [ ] The place's max players fit the biggest match and the lobby; arena spawn points are Parts.
- [ ] Match handlers in every role, lobby systems only when `Match.role == "lobby"`; no queue, lock, MemoryStore,
  MessagingService or teleport code of the game's own; nothing read from teleport data.
- [ ] `onStart` spawns teams, fills bots, holds ranked losses; every match ends (score, time cap, forfeit); results go into
  the saves before `Match.finish`; leavers, rejoiners and Studio's `Match.returned` handled; held losses undone on close.
- [ ] Lobby UI covers every state, notices and the rejoin prompt, on phones too.
- [ ] Studio probe PASS recorded; the live checklist handed to the user.
