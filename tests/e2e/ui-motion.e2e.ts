/**
 * Live check of the Motion module and the showpiece screens (skills roblox-ui-motion, roblox-ui-showpieces) in a
 * real playtest (no model calls, no uploads):
 *
 *   E2E=ui-motion STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-motion.e2e.ts
 *
 * Seeds Motion and the Ui kit into ReplicatedStorage.Shared, the loading screen's server installer (it copies the
 * screen into ReplicatedFirst), the title screen, and a client probe that, once the loading screen has handed
 * over, checks Motion's behaviour (springs settle and the frame step disconnects when idle, Reduce Motion lands
 * tweens and stops loops, scopes stop and restore loops when their screen is disabled and clear MotionLoops,
 * keyframes, curves, paths, flipbooks, entrances, count-ups, flights, transitions) and opens the reward reveal and
 * the round-end screen. Then the playing client's UI is captured and audited on phone, tablet, desktop and TV: no
 * problems. Needs the Studio window drawn (tweens only run while it renders). Refuses a published place; cleans up.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { uiCaptureLuau, type UiCapture } from '../../src/core/roblox/ui-capture';
import { auditDevices, auditUi } from '../../src/shared/ui-layout';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blocksOf = (skill: string) => [...readFileSync(resolve(__dirname, '..', '..', 'resources', 'skills', skill, 'SKILL.md'), 'utf8').matchAll(/```lua\n([\s\S]*?)```/g)].map((m) => m[1]!);
const MOTION = blocksOf('roblox-ui-motion')[0]!;
const UI = blocksOf('roblox-ui-design')[0]!;
const SHOW = blocksOf('roblox-ui-showpieces');
const [INSTALL, LOADING, TITLE, REVEAL, ROUND_END] = [SHOW[0]!, SHOW[1]!, SHOW[2]!, SHOW[3]!, SHOW[4]!];

const long = (s: string) => {
  if (s.includes(']==]')) throw new Error('source contains ]==]');
  return `[==[${s}]==]`;
};

// The probe: each check records ok + what it saw; the results land on the local player's attribute MotionE2E.
const PROBE = `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local HttpService = game:GetService("HttpService")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Motion = require(Shared:WaitForChild("Motion"))
local Ui = require(Shared:WaitForChild("Ui"))
local player = Players.LocalPlayer
local pg = player:WaitForChild("PlayerGui")
local results = {}
local function check(name, ok, saw)
  table.insert(results, { name = name, ok = ok and true or false, saw = tostring(saw) })
end
local function near(a, b, e) return math.abs(a - b) <= (e or 0.01) end

-- The loading screen hands over first.
local t0 = os.clock()
while not player:GetAttribute("LoadingScreenDone") and os.clock() - t0 < 40 do task.wait(0.1) end
check("loading screen handed over", player:GetAttribute("LoadingScreenDone") == true, os.clock() - t0)
task.wait(1)
check("loading screen gone after the handoff", pg:FindFirstChild("Loading") == nil, pg:FindFirstChild("Loading"))
check("the title screen is up", pg:FindFirstChild("Title") ~= nil, pg:FindFirstChild("Title"))

local gui = Instance.new("ScreenGui")
gui.Name = "MotionProbe"
gui.ResetOnSpawn = false
gui.Parent = pg
local function frame(name, parent)
  local f = Instance.new("Frame")
  f.Name = name
  f.Size = UDim2.fromOffset(100, 60)
  f.BackgroundTransparency = 0.2
  f.Parent = parent or gui
  return f
end

task.wait(2) -- the title intro's springs settle
check("idle: no frame step", Motion.stats().stepping == false, HttpService:JSONEncode(Motion.stats()))

-- Springs settle on their goal and the frame step goes away.
local a = frame("Spring")
local scale = Instance.new("UIScale")
scale.Parent = a
Motion.spring(scale, { Scale = 0.5 }, 8, 1)
check("a spring connects the frame step", Motion.stats().stepping == true, HttpService:JSONEncode(Motion.stats()))
task.wait(1.5)
check("the spring settles on its goal", near(scale.Scale, 0.5, 0.001), scale.Scale)
check("settled: no springs, no frame step", Motion.stats().springs == 0 and not Motion.stats().stepping, HttpService:JSONEncode(Motion.stats()))
Motion.punch(a, 0.2)
local peak, since = 0, os.clock()
while os.clock() - since < 0.3 do
  peak = math.max(peak, scale.Scale)
  task.wait()
end
task.wait(1.5)
check("a punch swings out and comes back", peak > 0.55 and near(scale.Scale, 0.5, 0.001), string.format("%.3f then %.3f", peak, scale.Scale))

-- Reduce Motion: tweens land at once; the game's switch overrides.
Motion.setReduced(true)
local b = frame("Reduced")
Motion.tween(b, TweenInfo.new(5), { BackgroundTransparency = 0.7 })
check("reduced: a tween lands at once", near(b.BackgroundTransparency, 0.7), b.BackgroundTransparency)
check("reduced: Motion.reduced()", Motion.reduced() == true, Motion.reduced())
Motion.setReduced(nil)

-- Numbers.
local label = Instance.new("TextLabel")
label.Parent = gui
Motion.count(label, 0, 1234567, { seconds = 0.3 })
task.wait(0.7)
check("count-up ends on the value", label.Text == "1,234,567", label.Text)
check("short numbers", Motion.short(1234567) == "1.2M" and Motion.short(999999) == "999.9K" and Motion.short(950) == "950", Motion.short(1234567) .. " " .. Motion.short(999999) .. " " .. Motion.short(950))
check("commas", Motion.commas(-1234.4) == "-1,234" and Motion.commas(1e12) == "1,000,000,000,000", Motion.commas(-1234.4) .. " " .. Motion.commas(1e12))

-- Scopes: loops run natively, mark their element, stop and restore when the screen is disabled.
local loopsGui = Instance.new("ScreenGui")
loopsGui.Name = "LoopProbe"
loopsGui.Parent = pg
local c = frame("Pulse", loopsGui)
local d = frame("Spin", loopsGui)
local fx = Motion.scope(loopsGui)
local before = Motion.stats().loops -- the title screen's own (its camera drift and Play's glow)
fx:pulse(c, 0.1, 0.6)
fx:spin(d, 2)
task.wait(0.4)
check("loops counted", Motion.stats().loops == before + 2, Motion.stats().loops - before)
check("loops mark their element", c:GetAttribute("MotionLoops") == 1 and d:GetAttribute("MotionLoops") == 1, tostring(c:GetAttribute("MotionLoops")) .. "/" .. tostring(d:GetAttribute("MotionLoops")))
check("loops don't use the frame step", Motion.stats().stepping == false, HttpService:JSONEncode(Motion.stats()))
loopsGui.Enabled = false
task.wait(0.1)
local pulseScale = c:FindFirstChildOfClass("UIScale")
check("a disabled screen stops its loops", Motion.stats().loops == before, Motion.stats().loops - before)
check("stopped loops are put back and unmarked", pulseScale ~= nil and near(pulseScale.Scale, 1) and near(d.Rotation, 0) and c:GetAttribute("MotionLoops") == nil, string.format("%s %.2f", tostring(pulseScale and pulseScale.Scale), d.Rotation))
loopsGui.Enabled = true
fx:pulse(c)
Motion.setReduced(true)
check("Reduce Motion turning on stops loops", Motion.stats().loops == 0, Motion.stats().loops)
Motion.setReduced(nil)

-- Keyframes, curves and paths.
local e = frame("Keys")
local keysDone = false
fx:keyframes(e, { Rotation = { { at = 0, value = 0 }, { at = 0.3, value = 45 } } }, { onDone = function() keysDone = true end })
local f = frame("Curve")
local curveDone = false
Motion.curve(f, 0.3, { BackgroundTransparency = 0.6 }, Motion.bezier(0.2, 0.8, 0.2, 1), function() curveDone = true end)
local g = frame("Path")
Motion.path(g, { UDim2.fromOffset(0, 0), UDim2.fromOffset(200, 50), UDim2.fromOffset(300, 300) }, 0.3)
task.wait(0.8)
check("keyframes end on the last key and call onDone", keysDone and near(e.Rotation, 45, 0.5), string.format("%s %.1f", tostring(keysDone), e.Rotation))
check("a curve lands on its goal", curveDone and near(f.BackgroundTransparency, 0.6), f.BackgroundTransparency)
check("a path ends on its last point", g.Position == UDim2.fromOffset(300, 300), tostring(g.Position))
check("curves done: no frame step", Motion.stats().curves == 0 and not Motion.stats().stepping, HttpService:JSONEncode(Motion.stats()))

-- A one-shot flipbook: 4 frames of 64 in 2 columns at 20 fps ends on the last frame.
local img = Instance.new("ImageLabel")
img.Size = UDim2.fromOffset(64, 64)
img.Parent = gui
local bookDone = false
fx:flipbook(img, { frame = Vector2.new(64, 64), count = 4, columns = 2, fps = 20, loop = false }, function() bookDone = true end)
task.wait(0.6)
check("a flipbook steps its frames and ends on the last", bookDone and img.ImageRectOffset == Vector2.new(64, 64) and img.ImageRectSize == Vector2.new(64, 64), tostring(img.ImageRectOffset))

-- Entrances: layout children fade from invisible back to their designed transparency.
local list = frame("List")
list.Size = UDim2.fromOffset(300, 300)
local layout = Instance.new("UIListLayout")
layout.Parent = list
local rows = { frame("Row1", list), frame("Row2", list), frame("Row3", list) }
Motion.enter(rows, { gap = 0.03 })
check("an entrance starts invisible", rows[3].BackgroundTransparency == 1, rows[3].BackgroundTransparency)
task.wait(0.7)
check("an entrance lands on the design", near(rows[1].BackgroundTransparency, 0.2) and near(rows[3].BackgroundTransparency, 0.2), rows[3].BackgroundTransparency)

-- A flight and a transition.
local from = frame("From")
from.Position = UDim2.fromOffset(400, 300)
local to = frame("To")
to.Position = UDim2.fromOffset(40, 40)
local arrived, flown = 0, false
Motion.fly({ from = from, to = to, image = "", count = 3, onEach = function() arrived += 1 end, onDone = function() flown = true end })
local swapped = false
Motion.transition(function() swapped = true end, { style = "wipe", seconds = 0.2 })
task.wait(1.6)
local layer = pg:FindFirstChild("MotionLayer")
check("a flight lands every icon", arrived == 3 and flown, arrived)
check("flights clean up", layer ~= nil and #layer:GetChildren() == 0, layer and #layer:GetChildren())
check("a transition swaps under its cover and goes", swapped and pg:FindFirstChild("MotionTransition") == nil, swapped)
task.wait(1.5)
check("all done: no frame step", Motion.stats().stepping == false, HttpService:JSONEncode(Motion.stats()))

-- The showpieces, for the audit.
local Reveal = require(script:WaitForChild("RewardReveal"))
local RoundEnd = require(script:WaitForChild("RoundEnd"))
gui:Destroy()
loopsGui:Destroy()
Reveal.show(Ui.screen("Reward", 20, pg), { name = "Golden Sword", icon = "rbxassetid://0", tier = "Legendary", coins = 250, isNew = true })
RoundEnd.show(Ui.screen("Results", 21, pg), { won = true, reason = "Kill limit reached", top = { { name = "Nova", score = 12 }, { name = "Kai", score = 9 }, { name = "A_Very_Long_Player_Name_1", score = 4 } }, stats = { { label = "Kills", value = 7 }, { label = "Scrap", value = 340 } }, xp = { level = 4, from = 250, gained = 400 } })
task.wait(4)
player:SetAttribute("MotionE2E", HttpService:JSONEncode(results))`;

const SEED = `local RS = game:GetService("ReplicatedStorage")
local shared = RS:FindFirstChild("Shared") or Instance.new("Folder")
shared.Name = "Shared"
shared.Parent = RS
local function module(name, source, parent)
  local m = Instance.new("ModuleScript")
  m.Name = name
  m.Source = source
  m:SetAttribute("MotionE2E", true)
  m.Parent = parent
  return m
end
module("Motion", ${long(MOTION)}, shared)
module("Ui", ${long(UI)}, shared)
local install = Instance.new("Script")
install.Name = "LoadingScreen"
install.Source = ${long(INSTALL)}
install:SetAttribute("MotionE2E", true)
local screen = Instance.new("LocalScript")
screen.Name = "Screen"
screen.Source = ${long(LOADING)}
screen.Parent = install
install.Parent = game:GetService("ServerScriptService")
local sps = game:GetService("StarterPlayer").StarterPlayerScripts
local title = Instance.new("LocalScript")
title.Name = "MotionE2ETitle"
title.Source = ${long(TITLE)}
title:SetAttribute("MotionE2E", true)
title.Parent = sps
local probe = Instance.new("LocalScript")
probe.Name = "MotionE2EProbe"
probe.Source = ${long(PROBE)}
probe:SetAttribute("MotionE2E", true)
module("RewardReveal", ${long(REVEAL)}, probe)
module("RoundEnd", ${long(ROUND_END)}, probe)
probe.Parent = sps
return "seeded"`;

const CLEAN = `for _, d in game:GetDescendants() do
  local ok, v = pcall(function() return d:GetAttribute("MotionE2E") end)
  if ok and v and d.Parent then d:Destroy() end
end
local sh = game:GetService("ReplicatedStorage"):FindFirstChild("Shared") if sh and #sh:GetChildren() == 0 then sh:Destroy() end
return "clean"`;

const READ = `local p = game:GetService("Players").LocalPlayer
return p and p:GetAttribute("MotionE2E") or ""`;

type Check = { name: string; ok: boolean; saw: string };

describe.runIf(process.env.E2E === 'ui-motion')('Motion and the showpieces in a playtest (live)', () => {
  it('Motion behaves as documented, and the loading, title, reward and round-end screens fit every device', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-motion-e2e-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    core.studio.bind(match);
    let playing = false;
    try {
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');
      expect((await core.studio.runLuau(SEED, 'Edit')).output).toContain('seeded');
      await core.studio.setPlaying(true);
      playing = true;

      // The probe takes about 25 s after the loading screen hands over.
      let raw = '';
      for (let i = 0; i < 90 && !raw; i++) {
        await sleep(1000);
        const r = await core.studio.runLuau(READ, 'Client', 20_000).catch(() => null);
        if (r?.ok && r.output.trim().startsWith('[')) raw = r.output.trim();
      }
      if (!raw) throw new Error('The probe never reported (is the Studio window drawn? Tweens only run while it renders).');
      const capture = JSON.parse((await core.studio.runLuau(uiCaptureLuau({ playerGui: true }), 'Client', 45_000)).output.trim()) as UiCapture;
      await core.studio.setPlaying(false);
      playing = false;

      const checks = JSON.parse(raw) as Check[];
      for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name} (saw ${c.saw})`);
      expect(checks.length).toBeGreaterThan(25);
      expect(checks.filter((c) => !c.ok)).toEqual([]);

      const screens = capture.screens.filter((s) => ['Title', 'Reward', 'Results'].includes(s.name));
      expect(screens.map((s) => s.name).sort()).toEqual(['Results', 'Reward', 'Title']);
      const findings = auditUi(screens, auditDevices(capture.orientation));
      console.log(findings.map((f) => `${f.severity} ${f.devices.join('/')} ${f.path}: ${f.message}`).join('\n') || 'no findings');
      expect(findings.filter((f) => f.severity === 'problem')).toEqual([]);
    } finally {
      if (playing) await core.studio.setPlaying(false).catch(() => undefined);
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 10 * 60 * 1000);
});
