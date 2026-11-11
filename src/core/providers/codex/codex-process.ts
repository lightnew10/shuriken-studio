import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Resolve the executable, never pass prompts/config through cmd.exe or an npm shim. */
export function codexExecutable(): string {
  const names = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  if (process.platform === 'win32') {
    const npm = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex');
    const roots = [join(npm, 'node_modules', '@openai', 'codex-win32-x64', 'vendor'), join(npm, 'vendor')];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const platform of readdirSync(root)) {
        const exe = join(root, platform, 'bin', 'codex.exe');
        if (existsSync(exe)) return exe;
      }
    }
  }
  throw new Error('Codex executable unavailable. Shuriken supports Codex CLI 0.166.0.');
}

export function codexEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY)$/i.test(key)) delete env[key];
  }
  return env;
}

/** Only terminate the process tree we own; never discover/kill other Codex sessions. */
export async function stopCodexProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.on('error', () => { clearTimeout(timer); child.kill(); done(); });
      killer.on('close', () => { clearTimeout(timer); done(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function codexVersion(executable = codexExecutable()): string {
  const r = spawnSync(executable, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, env: codexEnvironment() });
  const v = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(r.stdout ?? '');
  if (r.status !== 0 || v?.[0] !== '0.166.0') throw new Error(`Unsupported Codex version (${v?.[0] ?? 'unknown'}); Shuriken currently supports 0.166.0.`);
  return v[0];
}

export async function executeCodexCommand(command: string, root: string, signal: AbortSignal, timeoutMs: number): Promise<{ ok: boolean; output: string; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, output: '', error: 'Controlled shell is qualified on Windows only' };
  return new Promise((done) => {
    if (signal.aborted) { done({ ok: false, output: '', error: 'Command stopped' }); return; }
    const filesystem = '{":minimal"="read",":workspace_roots"={"."="write",".git"="deny",".shuriken"="deny",".env"="deny","node_modules"="deny"}}';
    // No inherited named profile can append extra roots or override these permissions.
    const profile = 'shuriken-' + randomUUID();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|comspec|pathext|path|temp|tmp|userprofile|localappdata|appdata|programdata)$/i.test(key)));
    const windows = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? env.windir;
    if (!windows || !isAbsolute(windows)) { done({ ok: false, output: '', error: 'Windows system directory unavailable' }); return; }
    const powerShell = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(codexExecutable(), ['sandbox', '-P', profile, '-c', `permissions.${profile}.filesystem=${filesystem}`, '-c', `permissions.${profile}.network.enabled=false`, '-C', root, '--', powerShell, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { cwd: root, env, windowsHide: true, shell: false, stdio: 'pipe' });
    let output = '', settled = false;
    const finish = (ok: boolean, error?: string) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', stop); done({ ok, output, ...(error ? { error } : {}) }); };
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void stopCodexProcess(child).then(() => finish(false, 'Command stopped')); };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on('data', (b: Buffer) => { output = (output + b.toString('utf8')).slice(-100_000); }); child.stderr.on('data', (b: Buffer) => { output = (output + b.toString('utf8')).slice(-100_000); });
    child.on('error', () => finish(false, 'Sandbox could not start')); child.on('close', (code) => { if (!stopping) finish(code === 0, code === 0 ? undefined : 'Sandbox or command failed; no unsandboxed retry'); }); child.stdin.end();
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  });
}
