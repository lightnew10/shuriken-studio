import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LogRecord } from '../src/shared/events';
import { Logger } from '../src/core/log';
import { coreHarness } from './helpers/make-core';

/**
 * Every project window runs a core of its own, and all of them append to the same day's file. On 2026-10-07 a health
 * check passing in one window and failing in another sat side by side with nothing to tell them apart.
 */
const makeCore = coreHarness();

describe('core log lines', () => {
  it("carry the project of the window whose core wrote them, and the core's process id", () => {
    const dir = mkdtempSync(join(tmpdir(), 'shuriken-logs-'));
    const logger = new Logger(dir, null);
    logger.scope('core').info('Core starting');
    logger.setProject('hypixel-pit-style-game');
    logger.scope('studio').warn('No open Studio instance matches');
    logger.setProject(null);
    logger.scope('core').info('Project closed');
    const lines = readdirSync(dir)
      .sort()
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
      .map((l) => JSON.parse(l) as LogRecord);
    expect(lines.map((l) => l.project ?? null)).toEqual([null, 'hypixel-pit-style-game', null]);
    expect(lines.every((l) => l.pid === process.pid)).toBe(true);
  });

  it('a core labels them with the project it opens, renames and closes', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    core.logger.scope('test').info('with the project open');
    expect(core.logger.recent(1)[0]).toMatchObject({ project: 'Test Game', pid: process.pid });
    core.renameProject('Voxel Pit');
    core.logger.scope('test').info('renamed');
    expect(core.logger.recent(1)[0]!.project).toBe('Voxel Pit');
    core.closeProject();
    core.logger.scope('test').info('closed');
    expect(core.logger.recent(1)[0]!.project).toBeUndefined();
  });
});
