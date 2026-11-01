import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SYNC_MAP, LuauToolchain } from '../src/core/roblox/luau-toolchain';
import { LUAURC, SELENE_TOML } from '../src/core/projects/project-service';
import { uiCaptureLuau, uiCapturePageLuau } from '../src/core/roblox/ui-capture';

// The capture programs run in Studio, where a syntax slip would stop every ui_audit. They read more than they
// used to (several strokes, their positions and gradients, UIShadow, per-corner radii, gradient types), each newer
// property in a pcall; here they are parsed by luau-lsp where the toolchain is installed (as skills-lint does).
const bin = (t: string) => join(homedir(), '.local', 'bin', `${t}${process.platform === 'win32' ? '.exe' : ''}`);
const typesDir = process.env.LUAU_TYPES ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Shuriken Studio', 'luau-types');
const available = existsSync(bin('selene')) && existsSync(bin('luau-lsp')) && existsSync(join(typesDir, 'globalTypes.d.luau'));

describe.skipIf(!available)('the UI capture programs', () => {
  it('parse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-capture-'));
    writeFileSync(join(root, 'selene.toml'), SELENE_TOML);
    writeFileSync(join(root, '.luaurc'), LUAURC);
    mkdirSync(join(root, 'src', 'Server'), { recursive: true });
    writeFileSync(join(root, 'src/Server/Whole.server.luau'), `--!nocheck\n${uiCaptureLuau({ playerGui: false })}`);
    writeFileSync(join(root, 'src/Server/Page.server.luau'), `--!nocheck\n${uiCapturePageLuau({ playerGui: true, from: 0, budget: 80_000 })}`);
    const types = mkdtempSync(join(tmpdir(), 'shuriken-types-'));
    copyFileSync(join(typesDir, 'globalTypes.d.luau'), join(types, 'globalTypes.d.luau'));
    const r = await new LuauToolchain(types).check(root, DEFAULT_SYNC_MAP);
    expect(r.problems.filter((p) => /SyntaxError|parse_error/.test(p.code ?? ''))).toEqual([]);
  }, 120_000);
});
