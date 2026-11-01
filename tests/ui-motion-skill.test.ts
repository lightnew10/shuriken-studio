import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@core/agents/roles';
import { COPILOT_ROLES, COPILOT_SKILLS } from '@core/copilots/copilot-roles';
import { parseSkillFile } from '@core/skills/skill-service';

// Skill roblox-ui-motion (the Motion module the Ui and Hud kits play through), skill roblox-ui-showpieces
// (loading, title, reward, round end, interaction patterns), the design process and the device matrix in
// roblox-ui-design, and how the UI copilot and the UI designer get them. The Luau itself is linted by
// tests/skills-lint.test.ts (every block, next to the modules it requires).
const SKILLS_DIR = join(__dirname, '..', 'resources', 'skills');
const read = (skill: string) => readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
const luaBlocks = (md: string) => [...md.matchAll(/```lua\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
const lines = (md: string) => md.trimEnd().split(/\r?\n/).length;

describe('skill roblox-ui-motion', () => {
  const md = read('roblox-ui-motion');
  const { meta, body } = parseSkillFile(md);
  const motion = luaBlocks(md)[0]!;

  it('follows the conventions of the other skills and stays a size the UI copilot can take whole', () => {
    expect(meta.name).toBe('roblox-ui-motion');
    expect(String(meta.description)).toMatch(/Read it before animating/);
    expect(Number(meta.version)).toBeGreaterThanOrEqual(1);
    expect(meta.tags).toEqual(expect.arrayContaining(['motion', 'animation', 'loading', 'reduce motion']));
    expect(meta.required_tools).toEqual(expect.arrayContaining(['luau_check', 'ui_audit']));
    // The copilot gets it in its first message beside three other skills: the module (~1,300 lines) plus
    // the API table, the rules and three recipes, nothing more.
    expect(lines(md)).toBeLessThanOrEqual(1600);
  });

  it('documents the stable API and the module has every piece of it', () => {
    for (const fn of ['tween', 'curve', 'bezier', 'path', 'spring', 'punch', 'shake', 'count', 'commas', 'short', 'enter', 'swap', 'fly', 'transition', 'scope', 'stats', 'reduced', 'setReduced']) {
      expect(motion, fn).toMatch(new RegExp(`function Motion\\.${fn}\\(`));
      expect(body, fn).toContain(`Motion.${fn}`);
    }
    for (const method of ['tween', 'timeline', 'keyframes', 'loop', 'pulse', 'float', 'spin', 'shimmer', 'flipbook', 'add', 'stop']) {
      expect(motion, method).toMatch(new RegExp(`\\n\\t${method}: \\(self: Scope`));
    }
    for (const token of ['hover', 'press', 'open', 'close', 'slideIn', 'slideOut', 'page', 'enter', 'pop', 'fade', 'bob']) expect(motion).toMatch(new RegExp(`\\n\\t${token} = TweenInfo\\.new`));
    expect(motion).toMatch(/^--!strict/);
    expect(motion.trimEnd()).toMatch(/return Motion$/);
  });

  it('follows Reduce Motion, from the player or the game, and stops loops when it turns on', () => {
    expect(motion).toMatch(/pcall\(function\(\)\s*return GuiService\.ReducedMotionEnabled\s*end\)/);
    expect(motion).toContain('GetPropertyChangedSignal("ReducedMotionEnabled"):Connect(stopLoopsIfReduced)');
    expect(motion).toMatch(/function Motion\.setReduced\(on: boolean\?\)\s*override = on\s*stopLoopsIfReduced\(\)/);
    // Tweens land at once (and still complete) under Reduce Motion.
    expect(motion).toMatch(/if reduced then\s*set\(target, goal\)\s*end\s*local tween = TweenService:Create\(target, if reduced then SNAP else info, goal\)/);
  });

  it('costs nothing when idle: one frame-step connection, made on demand and dropped when nothing needs it', () => {
    expect(motion.match(/RenderStepped:Connect/g)?.length).toBe(1);
    expect(motion).not.toMatch(/Heartbeat|PreRender|Stepped:Connect\(function/);
    expect(motion).toMatch(/local idle = next\(springs\) == nil and next\(books\) == nil and next\(clips\) == nil[\s\S]*?connection:Disconnect\(\)\s*stepper = nil/);
    // Loops are native repeating tweens, not per-frame Luau.
    expect(motion).toMatch(/TweenInfo\.new\(info\.Time, info\.EasingStyle, info\.EasingDirection, if info\.RepeatCount == 0 then -1 else info\.RepeatCount/);
    expect(motion).toContain('stepping = stepper ~= nil');
  });

  it('stops what a screen started when it closes, and marks running loops for ui_audit', () => {
    expect(motion).toMatch(/owner\.Destroying:Connect/);
    expect(motion).toMatch(/owner:IsA\("LayerCollector"\)[\s\S]*?GetPropertyChangedSignal\("Enabled"\)/);
    expect(motion).toMatch(/owner:IsA\("GuiObject"\)[\s\S]*?GetPropertyChangedSignal\("Visible"\)/);
    expect(motion).toContain('SetAttribute("MotionLoops"');
    // A loop's target being destroyed ends it too (an infinite tween would keep the instance alive).
    expect(motion).toContain('destroying = target.Destroying:Connect(stop)');
  });
});

describe('skill roblox-ui-showpieces', () => {
  const md = read('roblox-ui-showpieces');
  const { meta, body } = parseSkillFile(md);
  const blocks = luaBlocks(md);

  it('follows the conventions and holds every showpiece and pattern', () => {
    expect(meta.name).toBe('roblox-ui-showpieces');
    expect(String(meta.description)).toMatch(/Read it before building any of these/);
    expect(meta.tags).toEqual(expect.arrayContaining(['loading', 'title', 'reward', 'round end', 'tabs', 'carousel', 'drag']));
    for (const part of ['## Loading screen', '## Title screen and main menu', '## Reward reveal', '## Round end and level up', '## Interaction patterns', '## Verification']) expect(body).toContain(part);
    expect(blocks.length).toBe(9);
    for (const b of blocks) expect(b).toMatch(/^--!strict/);
  });

  it('the loading screen: ReplicatedFirst, real progress, limits, failures that never block, a handoff', () => {
    const [install, screen] = [blocks[0]!, blocks[1]!];
    expect(install).toContain('Parent = ReplicatedFirst');
    expect(install).toContain('WaitForChild("Motion"):Clone().Parent = screen');
    expect(screen).toContain('ReplicatedFirst:RemoveDefaultLoadingScreen()');
    expect(screen).toContain('ContentProvider:PreloadAsync(list, function(contentId: string, fetch: Enum.AssetFetchStatus)');
    expect(screen).toMatch(/fetch ~= Enum\.AssetFetchStatus\.Success/);
    expect(screen).toMatch(/local MIN_SECONDS = \d/);
    expect(screen).toMatch(/local MAX_SECONDS = \d+/);
    expect(screen).toContain('game:IsLoaded()');
    expect(screen).toContain('player:SetAttribute("LoadingScreenDone", true)');
    expect(screen).toContain('ScreenInsets = Enum.ScreenInsets.None');
    expect(screen).toContain('IsTenFootInterface()');
    expect(screen).toContain('Motion.reduced()');
  });

  it('the title, reward and round-end screens lay out per device and follow Reduce Motion', () => {
    const [title, reveal, roundEnd] = [blocks[2]!, blocks[3]!, blocks[4]!];
    expect(title).toContain('Ui.onDevice(screen');
    expect(title).toContain('GuiService.TouchControlsEnabled = false');
    expect(title).toContain('Motion.setReduced(');
    expect(title).toContain('LoadingScreenDone');
    expect(title).toContain('style = "iris"');
    expect(reveal).toContain('Motion.fly({');
    expect(reveal).toMatch(/device\.form == "phone"/);
    expect(reveal).toMatch(/if reduced then\s*reveal\(\)/);
    expect(roundEnd).toMatch(/local sideBySide = phone and not device\.portrait/);
    expect(roundEnd).toContain('Motion.count(');
  });

  it('the patterns give every input a way: drag or tap-tap or A-A, bumpers, swipe-to-close sheets', () => {
    const [tabs, carousel, drag, sheet] = [blocks[5]!, blocks[6]!, blocks[7]!, blocks[8]!];
    expect(tabs).toMatch(/window\.opened\.Event:Connect[\s\S]*?BindAction[\s\S]*?window\.closed\.Event:Connect[\s\S]*?UnbindAction/);
    expect(carousel).toContain('Instance.new("UIPageLayout")');
    expect(carousel).toContain('pages.Animated = not Motion.reduced()');
    expect(drag).toMatch(/pressedTouch and os\.clock\(\) - pressedTime < 0\.3/);
    expect(drag).toContain('Enum.KeyCode.ButtonB');
    expect(sheet).toContain('Ui.onDevice(screen, build)');
    expect(sheet).toMatch(/sheet = device\.form == "phone"/);
  });
});

describe('the design process and the device matrix', () => {
  const design = read('roblox-ui-design');
  const hud = read('roblox-game-hud');
  const refs = read('roblox-ui-references');
  const ui = luaBlocks(design)[0]!;
  const hudKit = luaBlocks(hud)[0]!;

  it('roblox-ui-design teaches the process early (workers get its first 14,000 characters) and covers every device', () => {
    const process = design.indexOf('## How a UI designer works');
    expect(process).toBeGreaterThan(0);
    expect(process).toBeLessThan(14_000);
    expect(design).toContain('## Devices and platforms');
    expect(design).toMatch(/Device emulator\*\* \(Test tab, Device\)/);
    expect(design).toMatch(/Agents can't switch it\s+on/);
    for (const canvas of ['945x415', '487x881', '1475x952', '1623x864']) expect(design).toContain(canvas);
    expect(refs).toContain('**Breakpoints**');
    expect(refs).toContain('## 13. Dated or modern');
  });

  it('both kits give a layout per form factor and a bigger fit on a TV, declared for ui_audit', () => {
    for (const [kit, name] of [[ui, 'Ui'], [hudKit, 'Hud']] as const) {
      expect(kit).toMatch(new RegExp(`function ${name}\\.device\\(screen: ScreenGui\\)`));
      expect(kit).toMatch(new RegExp(`function ${name}\\.onDevice\\(screen: ScreenGui`));
      expect(kit).toContain('GuiService:IsTenFootInterface()');
      expect(kit).toContain('SetAttribute("FitTenFoot"');
      expect(kit).toMatch(/short < 500 then "phone" elseif long < 1300 then "tablet" else "desktop"/);
    }
    expect(ui).toContain('function Ui.hint(');
    expect(ui).toContain('function Ui.strip(');
    expect(ui).toContain('b.SelectionImageObject = ring()');
    expect(hudKit).toContain('function Hud.counter(');
  });

  it('is wired in: the copilot starts with the Motion skill and is told where the showpieces are; so is the UI designer', () => {
    expect(COPILOT_SKILLS.ui).toEqual(expect.arrayContaining(['roblox-ui-design', 'roblox-game-hud', 'roblox-ui-references', 'roblox-ui-motion']));
    expect(COPILOT_SKILLS.ui).not.toContain('roblox-ui-showpieces'); // on demand: it is long
    const copilot = COPILOT_ROLES.ui.instructions;
    expect(copilot).toContain('roblox-ui-showpieces');
    expect(copilot).toContain('roblox-ui-motion');
    expect(copilot).toContain('How a UI designer works');
    const role = ROLES['ui-engineer']!.instructions;
    for (const skill of ['roblox-ui-design', 'roblox-game-hud', 'roblox-ui-motion', 'roblox-ui-showpieces', 'roblox-ui-references']) expect(role, skill).toContain(skill);
    expect(role).toContain('How a UI designer works');
    expect(role).toMatch(/upright phone/);
  });
});
