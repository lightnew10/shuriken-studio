import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A test run's temporary folders (projects, data dirs, Blender workspaces, lint sandboxes) all go under
 * one folder of its own, removed when the run ends, instead of piling up in the system temp folder
 * (thousands of shuriken-* folders over a few days before this). The workers inherit TEMP/TMP.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-test-run-'));
  process.env.TEMP = root;
  process.env.TMP = root;
  process.env.TMPDIR = root;
  return () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // A file still held open (a Blender that is shutting down): the OS clears it later.
    }
  };
}
