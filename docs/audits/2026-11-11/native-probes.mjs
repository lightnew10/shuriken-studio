// No model calls. Exercise Windows subprocess behavior with our own short-lived child.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'shuriken-audit-native-'));
const result = { platform: process.platform };
const collect = (command, args) => new Promise((resolve, reject) => {
  const c = spawn(command, args, { shell: true, windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = '';
  c.stdout.on('data', (b) => { stdout += b; });
  c.stderr.on('data', (b) => { stderr += b; });
  c.on('error', reject);
  c.on('close', (code) => resolve({ code, stdout, stderr }));
  c.stdin.end();
});
try {
  const script = join(root, 'argv.cjs');
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const quoted = await collect('node', [script, 'C:\\Audit Folder\\schema.json']);
  result.spaceArgument = { exitCode: quoted.code, received: JSON.parse(quoted.stdout.trim()) };

  const sleeper = join(root, 'child.cjs');
  writeFileSync(sleeper, 'console.log(process.pid); setTimeout(()=>{},5000)');
  result.cancellation = await new Promise((resolve, reject) => {
    const wrapper = spawn('node', [sleeper], { shell: true, windowsHide: true, stdio: 'pipe' });
    wrapper.on('error', reject);
    wrapper.stdout.once('data', async (data) => {
      const childPid = Number(data.toString().trim());
      wrapper.kill();
      await new Promise((r) => setTimeout(r, 150));
      let descendantAlive = false;
      try { process.kill(childPid, 0); descendantAlive = true; } catch {}
      // Only the child created immediately above is stopped. No existing app is touched.
      if (descendantAlive) { try { process.kill(childPid); } catch {} }
      resolve({ descendantAliveAfterWrapperKill: descendantAlive });
    });
    wrapper.stdin.end();
  });

  const auth = await collect('codex', ['login', 'status']);
  result.authOutputChannel = {
    exitCode: auth.code, stdoutBytes: auth.stdout.length,
    statusOnStderr: /logged in/i.test(auth.stderr),
    apiKeyOnStdout: /api key/i.test(auth.stdout), apiKeyOnStderr: /api key/i.test(auth.stderr),
  };
  writeFileSync('docs/audits/2026-11-11/native-results.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  rmSync(root, { recursive: true, force: true });
}
