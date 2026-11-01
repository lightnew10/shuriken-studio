import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { coreHarness } from './helpers/make-core';

const makeCore = coreHarness();

describe('a project whose folder is gone', () => {
  it('is reported, not made again as an empty project, and the open one stays open', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const gone = core.createProject({ name: 'Gone game', rootPath: root });
    rmSync(root, { recursive: true, force: true });

    expect(() => core.openProject(gone.id)).toThrow(/"Gone game" isn't where it was: .* was moved or deleted/);
    await expect(core.switchProject(gone.id)).rejects.toThrow(/isn't where it was/);
    expect(existsSync(root)).toBe(false);
    expect(core.project).toBe(ctx);
  });

  it('opens again from where it was moved to', async () => {
    const { core } = await makeCore({ respond: async () => null });
    const root = mkdtempSync(join(tmpdir(), 'shuriken-proj-'));
    const game = core.createProject({ name: 'Moved game', rootPath: root });
    const to = `${root}-moved`;
    renameSync(root, to);
    expect(() => core.openProject(game.id)).toThrow(/isn't where it was/);

    // "Choose its folder…" registers the folder: the listed project follows it, same id.
    const again = core.projects.create({ name: '', rootPath: to, template: 'empty' });
    expect(again.id).toBe(game.id);
    expect(again.rootPath).toBe(resolve(to));
    expect((await core.switchProject(game.id)).root).toBe(resolve(to));
    expect(existsSync(root)).toBe(false);
  });
});
