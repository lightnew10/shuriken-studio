import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeProvider, NO_SELF_UPDATE, restoreMovedBinary } from '../src/core/providers/claude/claude-provider';

// Minutes after a sign-in through the terminal, every agent of 1.11.1 and of 1.12 failed with "Claude Code native
// binary not found": Claude Code had updated itself, renamed the app's claude.exe to claude.exe.old.<time> and put
// nothing in its place.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'shuriken-claude-exe-'));
  dirs.push(d);
  return d;
};

describe("the Claude program Shuriken ships", () => {
  it('is told not to update itself wherever Shuriken starts it: sign-in, account checks, agent runs', async () => {
    expect(NO_SELF_UPDATE).toEqual({ DISABLE_AUTOUPDATER: '1' });
    const provider = new ClaudeProvider({ appVersion: 'test' } as never);
    expect(provider.accountEnv('C:/accounts/a1')).toEqual({ DISABLE_AUTOUPDATER: '1', CLAUDE_CONFIG_DIR: 'C:/accounts/a1' });
    const src = readFileSync(join(__dirname, '..', 'src', 'core', 'providers', 'claude', 'claude-runner.ts'), 'utf8');
    expect(src).toMatch(/env: \{ \.\.\.process\.env, DISABLE_AUTOUPDATER: '1'/);
    const own = readFileSync(join(__dirname, '..', 'src', 'core', 'providers', 'claude', 'claude-provider.ts'), 'utf8');
    expect(own.match(/\.\.\.NO_SELF_UPDATE/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('is put back when it renamed itself away: the newest copy, and only when the program is really missing', () => {
    const d = dir();
    const exe = join(d, 'claude.exe');
    expect(restoreMovedBinary(exe)).toBe(false);
    writeFileSync(join(d, 'claude.exe.old.1790912001630'), 'older');
    writeFileSync(join(d, 'claude.exe.old.1790915353094'), 'newest');
    writeFileSync(join(d, 'LICENSE.md'), 'x');
    expect(restoreMovedBinary(exe)).toBe(true);
    expect(readFileSync(exe, 'utf8')).toBe('newest');
    // The copies it moved away stay (they are its own to clean up), and a program that is there is left alone.
    expect(existsSync(join(d, 'claude.exe.old.1790915353094'))).toBe(true);
    writeFileSync(exe, 'current');
    expect(restoreMovedBinary(exe)).toBe(true);
    expect(readFileSync(exe, 'utf8')).toBe('current');
  });
});
