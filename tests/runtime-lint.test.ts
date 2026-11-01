import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '@core/roblox/luau-toolchain';
import { RUNTIME_MODULE } from '@core/animation/luau';
import { FX_CLIENT_SCRIPT, FX_RUNTIME_FILES, motionFromSkill } from '@core/effects/effects-service';
import { AUDIO_RUNTIME_MODULE } from '@core/audio/audio-library';
import { LUAURC, SELENE_TOML } from '@core/projects/project-service';

// The generated runtime modules land in every project's synced code, so they must pass the same
// selene + strict luau-lsp checks agents' code does (a live run caught 21 problems once). Runs where
// the toolchain is installed (~/.local/bin) and Roblox type definitions exist (LUAU_TYPES or the app's).
const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const available = existsSync(bin('selene')) && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));

describe.skipIf(!available)('generated runtime modules', () => {
  it('pass selene and strict luau-lsp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-runtime-lint-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    for (const d of ['Shared', 'Client', 'Server']) mkdirSync(join(root, 'src', d), { recursive: true });
    writeFileSync(join(root, 'src/Shared/ShurikenAnimations.luau'), RUNTIME_MODULE);
    // The effects runtime is five sibling modules, beside the Motion module (skill roblox-ui-motion) its 2D parts use.
    for (const f of FX_RUNTIME_FILES) writeFileSync(join(root, 'src/Shared', `${f.module}.luau`), f.source);
    writeFileSync(join(root, 'src/Shared/Motion.luau'), motionFromSkill(readFileSync(join(__dirname, '..', 'resources', 'skills', 'roblox-ui-motion', 'SKILL.md'), 'utf8'))!);
    writeFileSync(join(root, 'src/Shared/ShurikenAudio.luau'), AUDIO_RUNTIME_MODULE);
    writeFileSync(join(root, 'src/Client/ShurikenEffects.client.luau'), FX_CLIENT_SCRIPT.replace('__REQUIRE__', 'game.ReplicatedStorage.Shared.ShurikenEffects'));
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.toolErrors).toEqual([]);
    expect(r.problems.map((p) => `${p.tool} ${p.file}:${p.line} ${p.code} ${p.message}`)).toEqual([]);
  }, 120_000);
});
