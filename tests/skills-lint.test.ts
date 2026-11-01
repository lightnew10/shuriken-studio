import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '@core/roblox/luau-toolchain';
import { LUAURC, SELENE_TOML } from '@core/projects/project-service';

// Agents copy skill examples into their games, where luau_check runs selene + strict luau-lsp with the
// new-project config. The workshop skills' examples must pass it (requires of the game's own modules
// can't resolve in this sandbox and are ignored). Runs where the toolchain is installed.
const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const available = existsSync(bin('selene')) && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));

/** Skill → the shared module its first example is (others are client/server scripts). */
const SKILLS: Record<string, string | null> = {
  'roblox-combat-feel': null,
  'roblox-environment-art': null,
  'roblox-ragdoll-knockback': 'Ragdoll',
  'roblox-game-hud': 'Hud',
  'roblox-ui-design': 'Ui',
  'roblox-animation-runtime': null,
  'roblox-vehicle-handling': 'Vehicle',
  'roblox-ui-motion': 'Motion',
  'roblox-ui-showpieces': null,
  'roblox-vfx': null,
  'roblox-onboarding': 'Guide',
};
/** Modules a skill's examples require from another skill, written into src/Shared beside its own (that skill's first block). */
const NEEDS: Record<string, Record<string, string>> = {
  'roblox-ui-design': { Motion: 'roblox-ui-motion' },
  'roblox-game-hud': { Motion: 'roblox-ui-motion' },
  'roblox-ui-motion': { Ui: 'roblox-ui-design' },
  'roblox-ui-showpieces': { Motion: 'roblox-ui-motion', Ui: 'roblox-ui-design' },
};
const firstBlock = (skill: string) => [...readFileSync(join(__dirname, '..', 'resources', 'skills', skill, 'SKILL.md'), 'utf8').matchAll(/```lua\r?\n([\s\S]*?)```/g)][0]![1]!;

describe.skipIf(!available)('workshop skill examples', () => {
  it('pass selene and strict luau-lsp', async () => {
    const problems: string[] = [];
    for (const [skill, shared] of Object.entries(SKILLS)) {
      const md = readFileSync(join(__dirname, '..', 'resources', 'skills', skill, 'SKILL.md'), 'utf8');
      const blocks = [...md.matchAll(/```lua\r?\n([\s\S]*?)```/g)].map((m) => m[1]!);
      expect(blocks.length, skill).toBeGreaterThan(0);
      const root = mkdtempSync(join(tmpdir(), 'shuriken-skill-lint-'));
      writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
      writeFileSync(join(root, '.luaurc'), LUAURC);
      for (const d of ['Shared', 'Client', 'Server']) mkdirSync(join(root, 'src', d), { recursive: true });
      for (const [module, from] of Object.entries(NEEDS[skill] ?? {})) writeFileSync(join(root, 'src/Shared', `${module}.luau`), firstBlock(from));
      blocks.forEach((b, i) => {
        if (shared && i === 0) writeFileSync(join(root, 'src/Shared', `${shared}.luau`), b);
        else writeFileSync(join(root, 'src/Server', `Example${i}.server.luau`), b);
      });
      const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
      copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
      const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
      expect(r.toolErrors, skill).toEqual([]);
      for (const p of r.problems) if (!/Unknown require/.test(p.message)) problems.push(`${skill} ${p.tool} ${p.file}:${p.line} ${p.code} ${p.message}`);
    }
    expect(problems).toEqual([]);
  }, 300_000);
});
