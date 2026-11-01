import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@core/agents/roles';
import { COPILOT_ROLES, COPILOT_SKILLS } from '@core/copilots/copilot-roles';
import { LUAURC, SELENE_TOML } from '@core/projects/project-service';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '@core/roblox/luau-toolchain';
import { parseSkillFile } from '@core/skills/skill-service';

// Skill roblox-ui-references (the look: tokens, palettes, genre layouts, motion, polish checklist) and the
// kit changes that came with it: the Ui and Hud kits follow the player's settings (PreferredInput, Reduce
// Motion, Background Transparency) and use UIShadow, each behind a pcall so older Studios still work.
const SKILLS_DIR = join(__dirname, '..', 'resources', 'skills');
const read = (skill: string) => readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
const luaBlocks = (md: string) => [...md.matchAll(/```lua\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);

describe('skill roblox-ui-references', () => {
  const md = read('roblox-ui-references');
  const { meta, body } = parseSkillFile(md);

  it('follows the conventions of the other skills', () => {
    expect(meta.name).toBe('roblox-ui-references');
    expect(String(meta.description).length).toBeGreaterThan(200);
    expect(String(meta.description)).toMatch(/read it before designing/i);
    expect(Number(meta.version)).toBeGreaterThanOrEqual(1);
    expect(meta.tags).toEqual(expect.arrayContaining(['ui', 'hud', 'palette', 'accessibility']));
    expect(meta.roblox_systems).toEqual(expect.arrayContaining(['UIShadow', 'GuiService']));
    expect(String(meta.version_applicability)).toMatch(/^Roblox Studio 0\.7/);
    expect(meta.required_tools).toContain('ui_audit');
  });

  it('stays dense: 350-510 lines (the UI copilot gets it in full in its first message)', () => {
    const lines = md.trimEnd().split(/\r?\n/).length;
    expect(lines).toBeGreaterThanOrEqual(350);
    expect(lines).toBeLessThanOrEqual(510);
  });

  it('has every part of the guide, marks conventions as conventions, and lists its sources', () => {
    for (const part of ['Facts that change decisions', 'device math', 'Quality rubric', 'Design tokens', 'Palettes', 'Rarity', 'Screen zones', 'Genre blueprints', 'Component specs', 'Motion spec', 'Sound cues', 'Input rules', 'budgets', 'Polish checklist', 'Dated or modern', 'Amateur mistakes', '## Sources']) {
      expect(body, part).toContain(part);
    }
    expect(body).toMatch(/Genre blueprints \[practice: conventions to adapt, not rules\]/);
    expect(body).toContain('https://create.roblox.com/docs/');
    expect(body).toContain('roblox-ui-design');
    expect(body).toContain('roblox-game-hud');
  });

  it('sends big 3D previews to a stage in the world, not a ViewportFrame', () => {
    expect(body).toMatch(/3D preview[^\n]*\n[^\n]*stage in the world\*\*, not a ViewportFrame/);
    expect(body).toContain('CameraType = Scriptable');
    expect(body).not.toContain('one live 3D preview (the detail panel)');
  });

  it('says a phone gets its own layout, not the desktop one scaled down', () => {
    expect(body).toMatch(/Shrinking the desktop layout onto a phone.*A phone gets its own layout/);
  });

  it('is wired in: a starting skill of the UI copilot, named in its prompt and in the UI designer role', () => {
    expect(COPILOT_SKILLS.ui).toContain('roblox-ui-references');
    expect(COPILOT_ROLES.ui.instructions).toContain('roblox-ui-references');
    expect(ROLES['ui-engineer']!.instructions).toContain('roblox-ui-references');
  });

  it('every starting skill of every copilot exists as a bundled skill', () => {
    for (const [id, names] of Object.entries(COPILOT_SKILLS)) {
      for (const name of names) expect(existsSync(join(SKILLS_DIR, name, 'SKILL.md')), `${id}: ${name}`).toBe(true);
    }
  });
});

describe('the Ui and Hud kits follow player preferences', () => {
  const ui = luaBlocks(read('roblox-ui-design'));
  const hud = luaBlocks(read('roblox-game-hud'));
  const motion = luaBlocks(read('roblox-ui-motion'))[0]!;

  it('Ui kit: PreferredInput (with the old check as fallback), Reduce Motion (through Motion), Background Transparency and UIShadow, each behind a pcall', () => {
    const kit = ui[0]!;
    expect(kit).toMatch(/local Ui = \{\}/);
    expect(kit).toContain('local Motion = require(script.Parent.Motion)');
    expect(kit).toMatch(/function Ui\.reducedMotion\(\): boolean\s*return Motion\.reduced\(\)/);
    expect(kit).toMatch(/pcall\(function\(\)\s*return UserInputService\.PreferredInput\s*end\)/);
    expect(kit).toContain('Enum.PreferredInput.Gamepad');
    expect(kit).toContain('Enum.PreferredInput.MicroGamepad');
    expect(kit).toContain('UserInputService:GetLastInputType()');
    expect(motion).toMatch(/pcall\(function\(\)\s*return GuiService\.ReducedMotionEnabled\s*end\)/);
    expect(kit).toMatch(/pcall\(function\(\)\s*return GuiService\.PreferredTransparency\s*end\)/);
    expect(kit).toMatch(/pcall\(function\(\)\s*local s = Instance\.new\("UIShadow"\)/);
    // Buttons tween through Ui.play (which snaps under Reduce Motion); the window's dim goes through Ui.alpha.
    expect(kit).not.toMatch(/TweenService:Create\((b|press), QUICK/);
    expect(kit).toContain('Ui.alpha(0.45)');
    expect(kit).toContain('Ui.shadow(root, 3)');
    expect(kit).toMatch(/function Ui\.(play|shadow|alpha|reducedMotion|onGamepad)\(/);
  });

  it('Hud kit: Reduce Motion (through Motion) and Background Transparency behind a pcall; panels and bar tweens use them', () => {
    const kit = hud[0]!;
    expect(kit).toMatch(/local Hud = \{\}/);
    expect(kit).toContain('local Motion = require(script.Parent.Motion)');
    expect(kit).toMatch(/function Hud\.reducedMotion\(\): boolean\s*return Motion\.reduced\(\)/);
    expect(kit).toMatch(/pcall\(function\(\)\s*return GuiService\.PreferredTransparency\s*end\)/);
    expect(kit.match(/Hud\.alpha\(Hud\.theme\.panelAlpha\)/g)?.length).toBe(4); // bar, cooldown slot, feed rows, counter
    expect(kit).not.toMatch(/\.BackgroundTransparency = Hud\.theme\.panelAlpha/);
    expect(kit).toContain('play(fill,');
    expect(kit).toContain('play(trail,');
  });

  it('keeps what the live kit checks (E2E=ui-kit, E2E=hud-kit) read from the skills', () => {
    expect(ui[1]).toContain('Ui.screen("Shop", 10, player:WaitForChild("PlayerGui"))');
    expect(ui[1]).toContain('ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("Buy") :: RemoteFunction');
    expect(hud[hud.length - 1]).toContain('Hud.screen("GameHud")');
    expect(hud.length).toBeGreaterThanOrEqual(2);
  });

  it('bumps the skill versions: installed copies only refresh from a higher one', () => {
    expect(Number(parseSkillFile(read('roblox-ui-design')).meta.version)).toBeGreaterThanOrEqual(3);
    expect(Number(parseSkillFile(read('roblox-game-hud')).meta.version)).toBeGreaterThanOrEqual(4);
  });
});

// The reference skill's examples are copied into games: they must pass selene and strict luau-lsp, next to the
// Ui kit they build on (the sandbox can't resolve the game's own requires; those are ignored). Runs where the
// toolchain is installed, like tests/skills-lint.test.ts.
const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const available = existsSync(bin('selene')) && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));

describe.skipIf(!available)('the reference skill examples', () => {
  it('pass selene and strict luau-lsp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-ui-refs-lint-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    for (const d of ['Shared', 'Client', 'Server']) mkdirSync(join(root, 'src', d), { recursive: true });
    writeFileSync(join(root, 'src/Shared/Ui.luau'), luaBlocks(read('roblox-ui-design'))[0]!);
    writeFileSync(join(root, 'src/Shared/Motion.luau'), luaBlocks(read('roblox-ui-motion'))[0]!);
    const blocks = luaBlocks(read('roblox-ui-references'));
    expect(blocks.length).toBeGreaterThanOrEqual(2); // the palette and the styling examples (the reward reveal moved to roblox-ui-showpieces)
    blocks.forEach((b, i) => writeFileSync(join(root, 'src/Client', `Example${i}.client.luau`), b));
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.toolErrors).toEqual([]);
    const problems = r.problems.filter((p) => !/Unknown require/.test(p.message)).map((p) => `${p.tool} ${p.file}:${p.line} ${p.code} ${p.message}`);
    expect(problems).toEqual([]);
  }, 300_000);
});
