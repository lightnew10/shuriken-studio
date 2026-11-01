import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Claude Code's config directory for an account folder ('' = the PC's own login). */
export function claudeConfigDir(accountDir: string): string {
  return accountDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Claude Code keeps a session (the conversation a run can be continued from) as files in the config directory of
 * the account that ran it: `projects/<project>/<session>.jsonl`, plus a `<session>/` folder beside it for what its
 * sub-agents and long tool results left. Each Shuriken account has its own config directory, so after a switch of
 * accounts (the active one reached its usage limit) a run that is continued looked for its session under the new
 * account, found none ("No conversation found with session ID …") and started over without what it knew: an
 * environment artist 62 turns into a task, in the build this was written after, four times in twenty minutes.
 *
 * This copies the session's files from whichever of `fromDirs` has them to `toDir`, under the same project name.
 * 'there': `toDir` has the session already. 'missing': no directory has it (the run starts fresh, as before).
 * The copy in the account it came from is left where it is.
 */
export function carryClaudeSession(sessionId: string, toDir: string, fromDirs: string[]): 'there' | 'carried' | 'missing' {
  // A session id is a UUID; anything else is not looked for (it becomes part of a path).
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return 'missing';
  const to = resolve(claudeConfigDir(toDir));
  const has = (config: string): string | null => {
    const projects = join(config, 'projects');
    if (!existsSync(projects)) return null;
    for (const project of readdirSync(projects)) {
      const file = join(projects, project, `${sessionId}.jsonl`);
      if (existsSync(file) && statSync(file).isFile()) return project;
    }
    return null;
  };
  if (has(to)) return 'there';
  for (const dir of fromDirs) {
    const from = resolve(claudeConfigDir(dir));
    if (from === to) continue;
    const project = has(from);
    if (!project) continue;
    const target = join(to, 'projects', project);
    mkdirSync(target, { recursive: true });
    cpSync(join(from, 'projects', project, `${sessionId}.jsonl`), join(target, `${sessionId}.jsonl`));
    const extra = join(from, 'projects', project, sessionId);
    if (existsSync(extra) && statSync(extra).isDirectory()) cpSync(extra, join(target, sessionId), { recursive: true });
    return 'carried';
  }
  return 'missing';
}
