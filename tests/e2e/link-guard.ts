import { execSync } from 'node:child_process';
import { copyFileSync, utimesSync } from 'node:fs';

/**
 * The e2e tests that write Shuriken Link's plugin file take over the link of every Studio window: a running
 * Shuriken app's Studio then answers the test, not the app, and its agents' syncs and Luau fail ("No open
 * Studio instance matches …"). Refuse while the app runs (a real build lost four minutes of Studio this way).
 */
export function refuseWhileShurikenRuns(): void {
  let out = '';
  try {
    out = execSync('tasklist /FI "IMAGENAME eq Shuriken.exe" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
  } catch {
    return;
  }
  if (/Shuriken\.exe/i.test(out)) throw new Error('Shuriken is running: this test takes over Shuriken Link in every Studio window and would cut a running build off from Studio. Close the app first.');
}

/**
 * Puts the user's plugin file back with a new modified time. copyFileSync keeps the backup's old time on Windows,
 * and Studio did not reload the plugin in an open Edit session for it: that window kept the test's key and stayed
 * unlinked (measured 2026-10-03: "port … answered without this plugin's key; ignored").
 */
export function restorePlugin(backup: string, pluginFile: string): void {
  copyFileSync(backup, pluginFile);
  const now = new Date();
  utimesSync(pluginFile, now, now);
}
