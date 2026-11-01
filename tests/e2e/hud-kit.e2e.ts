/**
 * Live check of the HUD kit (skill roblox-game-hud) in a real playtest (no model calls, no uploads):
 *
 *   E2E=hud-kit STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/hud-kit.e2e.ts
 *
 * Puts the Hud module and the skill's example (a health bar, two cooldown slots) plus a kill feed, a
 * a toast and floating text into the scratch place as a LocalScript, plays, and in the playing client
 * compares where Roblox put every HUD element with the audit's layout engine (text widths from each
 * element's TextBounds), then audits the HUD on phone, tablet and desktop: no problems. Refuses a
 * published place. Cleans up.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import { uiCaptureLuau, type UiCapture } from '../../src/core/roblox/ui-capture';
import { auditUi, estimateText, layoutScreen, type Measure } from '../../src/shared/ui-layout';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const md = readFileSync(resolve(__dirname, '..', '..', 'resources', 'skills', 'roblox-game-hud', 'SKILL.md'), 'utf8');
const blocks = [...md.matchAll(/```lua\n([\s\S]*?)```/g)].map((m) => m[1]!);
const KIT = blocks[0]!;
// Kit v4 plays through Motion (skill roblox-ui-motion), required from the same folder.
const MOTION = [...readFileSync(resolve(__dirname, '..', '..', 'resources', 'skills', 'roblox-ui-motion', 'SKILL.md'), 'utf8').matchAll(/```lua\n([\s\S]*?)```/g)][0]![1]!;
const EXAMPLE = `${blocks[blocks.length - 1]!}
-- More of the kit: a feed, a toast, floating text, a cooldown running, damage taken. (The toast slides
-- in from above the screen; where tweens don't run — a playtest whose window isn't drawn — it stays
-- parked there, which the audit calls a warning, not a problem.)
Hud.toast(screen, "Level up! You are now level 5", Hud.theme.good, 30)
local feed = Hud.feed(screen, { position = UDim2.new(1, -16, 0, 16), anchor = Vector2.new(1, 0) })
feed.push("Nova eliminated Kai")
feed.push("Kai picked up the Golden Sword")
Hud.floatingText(Vector3.new(0, 6, -10), "-25", Hud.theme.bad)
slots.Dash.start(20)
health.set(62, 100)
workspace:SetAttribute("HudKitE2EReady", true)`;

const long = (s: string) => {
  if (s.includes(']==]')) throw new Error('source contains ]==]');
  return `[==[${s}]==]`;
};
const SEED = `local RS = game:GetService("ReplicatedStorage")
local shared = RS:FindFirstChild("Shared") or Instance.new("Folder")
shared.Name = "Shared"
shared.Parent = RS
local motion = Instance.new("ModuleScript")
motion.Name = "Motion"
motion.Source = ${long(MOTION)}
motion:SetAttribute("HudKitE2E", true)
motion.Parent = shared
local hud = Instance.new("ModuleScript")
hud.Name = "Hud"
hud.Source = ${long(KIT)}
hud:SetAttribute("HudKitE2E", true)
hud.Parent = shared
local demo = Instance.new("LocalScript")
demo.Name = "HudKitDemo"
demo:SetAttribute("HudKitE2E", true)
demo.Source = ${long(EXAMPLE)}
demo.Parent = game:GetService("StarterPlayer").StarterPlayerScripts
return "seeded"`;
const CLEAN = `for _, d in game:GetDescendants() do
  local ok, v = pcall(function() return d:GetAttribute("HudKitE2E") end)
  if ok and v and d.Parent then d:Destroy() end
end
local sh = game:GetService("ReplicatedStorage"):FindFirstChild("Shared") if sh and #sh:GetChildren() == 0 then sh:Destroy() end
workspace:SetAttribute("HudKitE2EReady", nil)
return "clean"`;

// Every shown GuiObject of the HUD (relative to its ScreenGui) and the width Roblox gave each (not
// TextScaled) text: its own TextBounds, in on-screen pixels.
const MEASURE = `local HttpService = game:GetService("HttpService")
local pg = game:GetService("Players").LocalPlayer:FindFirstChild("PlayerGui")
local gui = pg and pg:FindFirstChild("GameHud")
if not (gui and workspace:GetAttribute("HudKitE2EReady")) then return HttpService:JSONEncode({ error = "not ready" }) end
local origin = gui.AbsolutePosition
local boxes, texts = {}, {}
local function walk(o, path)
  for _, c in o:GetChildren() do
    if c:IsA("GuiObject") and c.Visible then
      local p = path .. "." .. c.Name
      local a = c.AbsolutePosition - origin
      boxes[p] = { a.X, a.Y, c.AbsoluteSize.X, c.AbsoluteSize.Y }
      -- The width Roblox gave this text (on-screen pixels): what it sized the element with.
      if (c:IsA("TextLabel") or c:IsA("TextButton")) and c.Text ~= "" and not c.TextScaled then
        table.insert(texts, { text = c.Text, size = c.TextSize, w = c.TextBounds.X })
      end
      walk(c, p)
    end
  end
end
walk(gui, gui.Name)
return HttpService:JSONEncode({ w = gui.AbsoluteSize.X, h = gui.AbsoluteSize.Y, boxes = boxes, texts = texts })`;

type Measured = { w: number; h: number; boxes: Record<string, [number, number, number, number]>; texts: Array<{ text: string; size: number; w: number }> };

describe.runIf(process.env.E2E === 'hud-kit')('the HUD kit in a playtest (live)', () => {
  it('lays the HUD out where Roblox does, and the audit finds no problems on phone, tablet or desktop', async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-hudkit-e2e-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
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

      // Measured once the HUD's tweens have settled (two reads agree), with the capture from the same moment.
      let measured: Measured | null = null;
      let capture: UiCapture | null = null;
      for (let i = 0; i < 12 && !measured; i++) {
        await sleep(1000);
        const a = await core.studio.runLuau(MEASURE, 'Client', 20_000).catch(() => null);
        const cap = await core.studio.runLuau(uiCaptureLuau({ playerGui: true }), 'Client', 45_000).catch(() => null);
        const b = await core.studio.runLuau(MEASURE, 'Client', 20_000).catch(() => null);
        const strip = (s: string) => s.replace(/"texts":\[.*$/, '');
        if (a?.ok && b?.ok && cap?.ok && !a.output.includes('"error"') && strip(a.output) === strip(b.output)) {
          measured = JSON.parse(b.output.trim()) as Measured;
          capture = JSON.parse(cap.output.trim()) as UiCapture;
        }
      }
      await core.studio.setPlaying(false);
      playing = false;
      if (!measured || !capture) throw new Error('The HUD never settled in the playing client (see Studio output).');

      const hud = capture.screens.find((s) => s.name === 'GameHud')!;
      expect(hud, 'the GameHud screen was captured').toBeTruthy();
      expect(hud.fit).toEqual({ ref: [900, 900], min: 0.6, max: 1.4, tenFoot: 1.2 });
      // Widths as drawn (on-screen pixels), for text at the size it's drawn at; TextScaled text is estimated.
      const widths = new Map(measured.texts.map((t) => [`${t.text}|${t.size}`, t.w]));
      const robloxText: Measure = (s, size, node) => (node.scaled ? undefined : widths.get(`${s}|${node.textSize}`)) ?? estimateText(s, size, node);
      const ours = new Map(layoutScreen(hud, { w: measured.w, h: measured.h, topbar: 0, side: 0 }, { measure: robloxText }).map((b) => [b.path, b]));
      const off: string[] = [];
      let compared = 0;
      for (const [path, [x, y, w, h]] of Object.entries(measured.boxes)) {
        const b = ours.get(path);
        if (!b) {
          off.push(`${path}: not laid out by the engine`);
          continue;
        }
        compared++;
        const d = Math.max(Math.abs(b.x - x), Math.abs(b.y - y), Math.abs(b.w - w), Math.abs(b.h - h));
        if (d > 2) off.push(`${path}: Roblox ${[x, y, w, h].map(Math.round).join(',')} vs engine ${[b.x, b.y, b.w, b.h].map(Math.round).join(',')}`);
      }
      console.log(`HUD ${measured.w}×${measured.h}, UIScale ${hud.scale}; compared ${compared} elements`);
      if (off.length) console.log(off.join('\n'));

      const findings = auditUi([hud]);
      console.log(findings.map((f) => `${f.severity} ${f.devices.join('/')} ${f.path}: ${f.message}`).join('\n') || 'no findings');
      expect(compared).toBeGreaterThan(8);
      expect(off).toEqual([]);
      expect(findings.filter((f) => f.severity === 'problem')).toEqual([]);
    } finally {
      if (playing) await core.studio.setPlaying(false).catch(() => undefined);
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 10 * 60 * 1000);
});
