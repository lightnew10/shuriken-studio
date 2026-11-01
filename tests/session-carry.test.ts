import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';
import { carryClaudeSession } from '../src/core/providers/claude/session-carry';
import { coreHarness } from './helpers/make-core';

/**
 * The active account reached its usage limit in the middle of two builds and the app moved to the other one. Every
 * run that was continued after that looked for its session under the new account ("No conversation found with
 * session ID …") and started over: four agents in twenty minutes, one of them 62 turns into its task.
 */
const makeCore = coreHarness();
const ID = 'c8bb5b43-73a2-409a-ba73-929b0fae2c9b';
const PROJECT = 'C--Users-me-Projects-game';

function account(): string {
  return mkdtempSync(join(tmpdir(), 'shuriken-acct-'));
}

describe('a session that another account left', () => {
  it('is copied to the account that continues it, with what its sub-agents left, and stays where it was', () => {
    const a = account();
    const b = account();
    const c = account();
    mkdirSync(join(a, 'projects', PROJECT, ID, 'subagents'), { recursive: true });
    writeFileSync(join(a, 'projects', PROJECT, `${ID}.jsonl`), '{"type":"user"}\n');
    writeFileSync(join(a, 'projects', PROJECT, ID, 'subagents', 'agent-1.jsonl'), '{"type":"assistant"}\n');
    mkdirSync(join(a, 'projects', 'C--another-project'), { recursive: true });

    expect(carryClaudeSession(ID, b, [c, a, b])).toBe('carried');
    expect(readFileSync(join(b, 'projects', PROJECT, `${ID}.jsonl`), 'utf8')).toBe('{"type":"user"}\n');
    expect(readFileSync(join(b, 'projects', PROJECT, ID, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('{"type":"assistant"}\n');
    expect(existsSync(join(a, 'projects', PROJECT, `${ID}.jsonl`))).toBe(true);
    // It is there now: nothing is copied a second time, and the account it came from is not asked.
    writeFileSync(join(b, 'projects', PROJECT, `${ID}.jsonl`), 'continued\n');
    expect(carryClaudeSession(ID, b, [a, b, c])).toBe('there');
    expect(readFileSync(join(b, 'projects', PROJECT, `${ID}.jsonl`), 'utf8')).toBe('continued\n');
  });

  it('is missing when no account has it, and nothing that is not a session id becomes a path', () => {
    const a = account();
    const b = account();
    expect(carryClaudeSession(ID, b, [a, b])).toBe('missing');
    mkdirSync(join(a, 'projects', PROJECT), { recursive: true });
    writeFileSync(join(a, 'projects', PROJECT, 'x.jsonl'), 'x');
    expect(carryClaudeSession('..\\..\\x', b, [a])).toBe('missing');
    expect(carryClaudeSession('x', b, [a])).toBe('missing');
    expect(existsSync(join(b, 'projects'))).toBe(false);
  });

  it('a run continued after a switch of accounts asks for its session to be brought over, and says so', async () => {
    const { core, ctx, provider } = await makeCore({ respond: async () => ({ status: 'implemented', summary: 'Went on.' }) });
    core.orchestrator.pause();
    core.accounts.setPolicy({ usePcLogin: false });
    const first = core.accounts.add('fake', 'Max A');
    const second = core.accounts.add('fake', 'Max B');
    core.accounts.update(first.id, { signedIn: true });
    core.accounts.update(second.id, { signedIn: true });
    core.accounts.setActive('fake', second.id);
    const asked: Array<{ id: string; to: string; from: string[] }> = [];
    let answer: 'there' | 'carried' | 'missing' = 'carried';
    (provider as unknown as { carrySession: (id: string, to: string, from: string[]) => string }).carrySession = (id, to, from) => {
      asked.push({ id, to, from });
      return answer;
    };
    const run = (resumeSessionId: string | null) => core.runner.run({ project: ctx, role: ROLES['roblox-engineer']!, task: null, signal: new AbortController().signal, directive: 'Go on.', resumeSessionId });
    const notices = () => ctx.audit.timeline({ limit: 50 }).filter((e) => e.kind === 'run.notice' && /a session that began on another account/.test(e.title));

    await run(ID);
    expect(asked).toEqual([{ id: ID, to: second.dir, from: [first.dir, second.dir, ''] }]);
    expect(provider.runs.at(-1)!.resumeSessionId).toBe(ID);
    expect(notices().map((e) => e.title)).toEqual(['Gameplay Engineer continues on Max B a session that began on another account']);

    // Already with this account: nothing is said. A run that continues nothing asks for nothing.
    answer = 'there';
    await run(ID);
    await run(null);
    expect(asked).toHaveLength(2);
    expect(notices()).toHaveLength(1);
  });
});
