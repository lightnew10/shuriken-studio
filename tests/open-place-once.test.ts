import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { Logger } from '../src/core/log';
import { RobloxStudioAdapter } from '../src/core/roblox/studio-adapter';

/**
 * On a restart with Studio closed, a project's own "open my place" and the watch for a Studio that went away each
 * launched the place (7 s apart; Studio takes about 20 s to show up in the list both look at). Two windows had it
 * open: the plugin's edits went into one, playtests ran in the other, and checks tested a stale copy.
 * No real Studio is started here.
 */
class Opener extends RobloxStudioAdapter {
  launches: string[] = [];
  /** How many looks at Studio's list pass before the launched place shows up in it. */
  appearsAfter = 2;
  windowOpen = false;
  private looks = 0;

  constructor() {
    super({} as never, new EventBus(), new Logger(null, null, 'error').scope('studio'), 'test');
    (this as unknown as { install: { versionFolder: string; studioVersion: string; mcpExe: null } }).install = { versionFolder: 'C:/Roblox/version-test', studioVersion: 'test', mcpExe: null };
    (this as unknown as { conn: { connect(): Promise<void> } }).conn = { connect: async () => undefined };
  }

  override get connected(): boolean {
    return true;
  }

  override async listStudios(): Promise<Array<{ id: string; name: string }>> {
    const there = (this.launches.length > 0 || this.windowOpen) && ++this.looks > this.appearsAfter;
    return there ? [{ id: 's1', name: 'arena.rbxlx' }] : [];
  }

  protected override launchStudio(_exe: string, file: string): void {
    this.launches.push(file);
  }

  protected override async placeWindowOpen(): Promise<boolean> {
    return this.windowOpen;
  }
}

const place = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'shuriken-open-')), 'arena.rbxlx');
  writeFileSync(file, '<roblox/>', 'utf8');
  return file;
};

describe('opening a place in Studio', () => {
  it('launches it once when two ask while it is still starting, and gives both the same window', async () => {
    const studio = new Opener();
    const file = place();
    const [a, b] = await Promise.all([studio.openPlace(file, 'arena.rbxlx', 30_000), studio.openPlace(file.toUpperCase().replace('ARENA.RBXLX', 'arena.rbxlx'), 'arena.rbxlx', 30_000)]);
    expect(studio.launches).toHaveLength(1);
    expect(a).toEqual({ id: 's1', name: 'arena.rbxlx' });
    expect(b).toBe(a);
    // Open already: nothing is launched.
    await studio.openPlace(file, 'arena.rbxlx', 30_000);
    expect(studio.launches).toHaveLength(1);
  }, 30_000);

  it('waits for a window that has the place open and has not connected yet, instead of opening a second one', async () => {
    const studio = new Opener();
    studio.windowOpen = true;
    expect(await studio.openPlace(place(), 'arena.rbxlx', 30_000)).toEqual({ id: 's1', name: 'arena.rbxlx' });
    expect(studio.launches).toEqual([]);
  }, 30_000);

  it('an open that failed is not handed to the next one who asks', async () => {
    const studio = new Opener();
    studio.appearsAfter = 1e9;
    const file = place();
    await expect(studio.openPlace(file, 'arena.rbxlx', 100)).rejects.toThrow(/did not report an instance/);
    // Studio came up after all: the next ask finds it (and is not answered with the old failure).
    studio.appearsAfter = 0;
    expect(await studio.openPlace(file, 'arena.rbxlx', 30_000)).toEqual({ id: 's1', name: 'arena.rbxlx' });
  }, 30_000);
});
