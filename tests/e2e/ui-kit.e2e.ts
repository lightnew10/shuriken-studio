/**
 * Live check of the UI copilot's kit and the UI audit (no model calls, no uploads, no playtest):
 *
 *   E2E=ui-kit STUDIO_MATCH=<an open scratch place file> npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-kit.e2e.ts
 *
 * Builds skill roblox-ui-design's shop example with its Ui kit into the scratch place's StarterGui (in
 * Edit, so Studio lays it out on its own viewport), plus a settings window with tabs and a confirm
 * dialog on their own screens, all open. Then compares where Roblox put every element
 * (AbsolutePosition/Size) with where the audit's layout engine puts it on the same screen — text
 * widths taken from Roblox (each element's TextBounds), so this checks the layout rules — and runs ui_audit on them (phone,
 * tablet, desktop, with its own text estimate): no problems. Refuses a published place. Cleans up.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Core } from '../../src/core/core';
import type { CallerContext } from '../../src/core/capabilities/tool-registry';
import { uiCaptureLuau, type UiCapture } from '../../src/core/roblox/ui-capture';
import { estimateText, layoutScreen, type Measure, type UiFinding } from '../../src/shared/ui-layout';

const text = (o: { content: Array<{ type: string; text?: string }> }) => o.content.map((c) => c.text ?? '').join('');
const agent: CallerContext = { kind: 'agent', runId: 'run_uikit', taskId: null, role: 'ui-engineer', providerId: null, allowedTools: null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const skill = readFileSync(resolve(__dirname, '..', '..', 'resources', 'skills', 'roblox-ui-design', 'SKILL.md'), 'utf8');
const blocks = [...skill.matchAll(/```lua\n([\s\S]*?)```/g)].map((m) => m[1]!);
const KIT = blocks[0]!;
// Kit v3 plays through Motion (skill roblox-ui-motion), required from the same folder.
const MOTION = [...readFileSync(resolve(__dirname, '..', '..', 'resources', 'skills', 'roblox-ui-motion', 'SKILL.md'), 'utf8').matchAll(/```lua\n([\s\S]*?)```/g)][0]![1]!;
// The example as a client builds it, pointed at StarterGui (no player in Edit) and opened.
const swap = (s: string, from: string, to: string) => {
  if (!s.includes(from)) throw new Error(`The example no longer contains: ${from}`);
  return s.replace(from, to);
};
let EXAMPLE = swap(blocks[1]!, 'Ui.screen("Shop", 10, player:WaitForChild("PlayerGui"))', 'Ui.screen("Shop", 10, game:GetService("StarterGui"))');
EXAMPLE = swap(EXAMPLE, 'ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("Buy") :: RemoteFunction', 'Instance.new("RemoteFunction")');
// A settings window with tabs, and a confirm dialog, each on its own screen. Tweens don't run in Edit:
// every window is put where its open tween ends.
EXAMPLE = `${EXAMPLE}
pcall(window.open)
local SG = game:GetService("StarterGui")
local settingsScreen = Ui.screen("Settings", 10, SG)
local settings = Ui.window(settingsScreen, "Settings", Vector2.new(720, 520))
Ui.tabs(settings.body, { "General", "Audio", "Controls" }, function(_: number) end)
local reset = Ui.button(settings.body, "Reset to defaults", "danger")
reset.AnchorPoint = Vector2.new(0, 1)
reset.Position = UDim2.fromScale(0, 1)
pcall(settings.open)
local dialogs = Ui.screen("Dialogs", 20, SG)
pcall(Ui.confirm, dialogs, "Buy Golden Sword for 900 coins?", function(_: boolean) end)
for _, s in { "Shop", "Settings", "Dialogs" } do
  for _, d in SG[s]:GetDescendants() do
    if d:IsA("UIScale") and d.Parent and d.Parent:IsA("Frame") then d.Scale = 1 end
  end
end
return "built"`;
const long = (s: string) => {
  if (s.includes(']==]')) throw new Error('source contains ]==]');
  return `[==[${s}]==]`;
};

const SCREENS = ['Shop', 'Settings', 'Dialogs'];

const SEED = `local RS = game:GetService("ReplicatedStorage")
local shared = RS:FindFirstChild("Shared") or Instance.new("Folder")
shared.Name = "Shared"
shared.Parent = RS
local motion = Instance.new("ModuleScript")
motion.Name = "Motion"
motion.Source = ${long(MOTION)}
motion:SetAttribute("UiKitE2E", true)
motion.Parent = shared
local ui = Instance.new("ModuleScript")
ui.Name = "Ui"
ui.Source = ${long(KIT)}
ui:SetAttribute("UiKitE2E", true)
ui.Parent = shared
return "seeded"`;

const CLEAN = `local RS = game:GetService("ReplicatedStorage")
for _, a in { "UiClose_Shop", "UiClose_Settings", "UiClose_Confirm" } do
  pcall(function() game:GetService("ContextActionService"):UnbindAction(a) end)
end
pcall(function() game:GetService("GuiService").SelectedObject = nil end)
local shared = RS:FindFirstChild("Shared")
if shared then
  for _, name in { "Ui", "Motion" } do
    local m = shared:FindFirstChild(name)
    if m and m:GetAttribute("UiKitE2E") then m:Destroy() end
  end
  if #shared:GetChildren() == 0 then shared:Destroy() end
end
local SG = game:GetService("StarterGui")
for _, name in { "Shop", "Settings", "Dialogs", "ShurikenLayoutProbe", "UiKitTextProbe" } do
  local g = SG:FindFirstChild(name)
  if g then g:Destroy() end
end
return "clean"`;

// Where Roblox put every shown GuiObject of each screen (relative to it, by path), and the width Roblox
// gave each (not TextScaled) text: its own TextBounds, in on-screen pixels.
const MEASURE = `local HttpService = game:GetService("HttpService")
local SG = game:GetService("StarterGui")
local out = { screens = {}, texts = {} }
for _, name in ${JSON.stringify(SCREENS).replace('[', '{').replace(']', '}')} do
  local gui = SG:FindFirstChild(name)
  if not gui then return HttpService:JSONEncode({ error = "no " .. name .. " screen" }) end
  local origin = gui.AbsolutePosition
  local boxes = {}
  local function walk(o, path)
    for _, c in o:GetChildren() do
      if c:IsA("GuiObject") and c.Visible then
        local p = path .. "." .. c.Name
        local a = c.AbsolutePosition - origin
        boxes[p] = { a.X, a.Y, c.AbsoluteSize.X, c.AbsoluteSize.Y }
        -- The width Roblox gave this text (on-screen pixels): what it sized the element with.
        if (c:IsA("TextLabel") or c:IsA("TextButton")) and c.Text ~= "" and not c.TextScaled then
          table.insert(out.texts, { text = c.Text, size = c.TextSize, bold = c.FontFace.Weight.Value >= 600, w = c.TextBounds.X })
        end
        walk(c, p)
      end
    end
  end
  walk(gui, gui.Name)
  out.screens[name] = { w = gui.AbsoluteSize.X, h = gui.AbsoluteSize.Y, boxes = boxes }
end
return HttpService:JSONEncode(out)`;

type Measured = { screens: Record<string, { w: number; h: number; boxes: Record<string, [number, number, number, number]> }>; texts: Array<{ text: string; size: number; bold: boolean; w: number }> };

describe.runIf(process.env.E2E === 'ui-kit')('the UI kit and the UI audit (live)', () => {
  it("lays the kit's shop, tabs and dialog out where Roblox does, and the audit finds no problems on phone, tablet or desktop", async () => {
    const match = process.env.STUDIO_MATCH;
    if (!match) throw new Error('Set STUDIO_MATCH to an open scratch place file (never a real game).');
    const core = await Core.create({ dataDir: mkdtempSync(join(tmpdir(), 'shuriken-uikit-e2e-')), resourcesDir: resolve(__dirname, '..', '..', 'resources'), appVersion: '0.1.0-e2e', integrations: false });
    await core.studio.start();
    const projectDir = mkdtempSync(join(tmpdir(), 'shuriken-uikit-project-'));
    try {
      const ctx = core.openProject(core.createProject({ name: 'UI kit E2E', rootPath: projectDir }).id);
      ctx.updateSettings({ robloxStudioMatch: match });
      core.studio.bind(match);
      const pid = await core.studio.runLuau('return tostring(game.PlaceId)', 'Edit', 20_000);
      if (!pid.ok) throw new Error(`Studio: ${pid.output}`);
      if (pid.output.trim() !== '0') throw new Error(`"${match}" is a published place: this test only runs on a local scratch file.`);
      await core.studio.runLuau(CLEAN, 'Edit');
      const seeded = await core.studio.runLuau(SEED, 'Edit');
      expect(seeded.output, seeded.output).toContain('seeded');
      const built = await core.studio.runLuau(EXAMPLE, 'Edit', 60_000);
      expect(built.output, built.output).toContain('built');

      // 1. Roblox's layout vs the engine's on the same screens, once things have settled (two reads agree).
      let measured: Measured | null = null;
      for (let i = 0; i < 10 && !measured; i++) {
        await sleep(800);
        const a = await core.studio.runLuau(MEASURE, 'Edit', 20_000);
        const b = await core.studio.runLuau(MEASURE, 'Edit', 20_000);
        const strip = (s: string) => s.replace(/"texts":\[.*$/, '');
        if (a.ok && strip(a.output) === strip(b.output) && !a.output.includes('"error"')) measured = JSON.parse(b.output.trim()) as Measured;
      }
      if (!measured) throw new Error('The screens never settled in StarterGui.');
      const widths = new Map(measured.texts.map((t) => [`${t.text}|${t.size}|${t.bold}`, t.w]));
      // Widths as drawn on these screens (all share one UIScale), so they're used as they are.
      const robloxText: Measure = (s, size, node) => widths.get(`${s}|${node.textSize}|${!!node.bold}`) ?? estimateText(s, size, node);
      const cap = await core.studio.runLuau(uiCaptureLuau({}), 'Edit', 45_000);
      const capture = JSON.parse(cap.output.trim()) as UiCapture;
      const off: string[] = [];
      let compared = 0;
      for (const name of SCREENS) {
        const screen = capture.screens.find((s) => s.name === name)!;
        expect(screen, `the ${name} screen was captured`).toBeTruthy();
        expect(screen.fit).toEqual({ ref: [1920, 1080], min: 0.8, max: 1.5, tenFoot: 1.25 });
        const m = measured.screens[name]!;
        const ours = new Map(layoutScreen(screen, { w: m.w, h: m.h, topbar: 0, side: 0 }, { measure: robloxText }).map((b) => [b.path, b]));
        for (const [path, [x, y, w, h]] of Object.entries(m.boxes)) {
          const b = ours.get(path);
          if (!b) {
            off.push(`${path}: not laid out by the engine`);
            continue;
          }
          compared++;
          const d = Math.max(Math.abs(b.x - x), Math.abs(b.y - y), Math.abs(b.w - w), Math.abs(b.h - h));
          if (d > 2) off.push(`${path}: Roblox ${[x, y, w, h].map(Math.round).join(',')} vs engine ${[b.x, b.y, b.w, b.h].map(Math.round).join(',')}`);
        }
      }
      console.log(`compared ${compared} elements on ${SCREENS.join(', ')}`);
      if (off.length) console.log(off.join('\n'));
      expect(compared).toBeGreaterThan(30);
      expect(off).toEqual([]);

      // 2. The audit on phone, tablet and desktop (its own text estimate).
      const audit = await core.tools.invoke('ui_audit', { source: 'edit' }, agent);
      expect(audit.isError, text(audit)).toBeFalsy();
      const findings = (audit.data as { findings: UiFinding[] }).findings.filter((f) => SCREENS.some((s) => f.path.startsWith(s)));
      console.log(findings.map((f) => `${f.severity} ${f.devices.join('/')} ${f.path}: ${f.message}`).join('\n') || 'no findings');
      expect(findings.filter((f) => f.severity === 'problem')).toEqual([]);
    } finally {
      await core.studio.runLuau(CLEAN, 'Edit').catch(() => undefined);
      await core.shutdown().catch(() => undefined);
    }
  }, 10 * 60 * 1000);
});
