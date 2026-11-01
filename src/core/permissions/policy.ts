import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { EscalationMode, EscalationRules, PermissionMode } from '@shared/domain';
import { needsOwner, type OwnerNeed } from './owner-gate';
import { checkDeleteTargets, checkGitRepo, type DeleteStyle, type SafetyCheck } from './shell-safety';
import { SCRATCH_REL } from './scratch';

/** Risk classes for capability-layer tools. Each maps onto an escalation rule. */
export type PermissionClass =
  | 'read'
  | 'write_project'
  | 'roblox_read'
  | 'roblox_write'
  | 'destructive'
  | 'publish'
  | 'external'
  | 'spending'
  | 'security'
  | 'architecture';

export const DEFAULT_ESCALATION: EscalationRules = {
  destructiveOperations: 'ask',
  publishing: 'ask',
  majorArchitectureChanges: 'notify',
  securitySensitive: 'notify',
  externalCommunications: 'ask',
  spending: 'deny',
  repeatedFailures: 'ask',
  irreversibleChanges: 'ask',
  scopeExpansion: 'notify',
};

export interface PolicyDecision {
  outcome: 'allow' | 'deny' | 'ask';
  /** When the decision is `allow` but the rule says `notify`, the call proceeds and is flagged. */
  notify: boolean;
  reason: string;
  rule: keyof EscalationRules | null;
  /** Autonomous mode turned an `ask` into an `allow`: it runs, and the audit trail says it was auto-approved. */
  autoApproved?: boolean;
  /** Spends money or publishes the game: asks in every permission mode (see owner-gate.ts). */
  owner?: boolean;
}

const CLASS_RULE: Partial<Record<PermissionClass, keyof EscalationRules>> = {
  destructive: 'destructiveOperations',
  publish: 'publishing',
  external: 'externalCommunications',
  spending: 'spending',
  security: 'securitySensitive',
  architecture: 'majorArchitectureChanges',
};

function fromMode(mode: EscalationMode, rule: keyof EscalationRules, what: string): PolicyDecision {
  switch (mode) {
    case 'allow':
      return { outcome: 'allow', notify: false, reason: `${what} allowed by rule ${rule}`, rule };
    case 'notify':
      return { outcome: 'allow', notify: true, reason: `${what} allowed with notification (${rule})`, rule };
    case 'deny':
      return { outcome: 'deny', notify: true, reason: `${what} is not permitted (${rule} = deny)`, rule };
    case 'ask':
    default:
      return { outcome: 'ask', notify: true, reason: `${what} requires human approval (${rule})`, rule };
  }
}

/** Decide on a capability-layer tool call by its permission class. */
export function decideToolClass(cls: PermissionClass, rules: EscalationRules, what: string): PolicyDecision {
  const rule = CLASS_RULE[cls];
  if (!rule) return { outcome: 'allow', notify: false, reason: `${cls} operations are allowed`, rule: null };
  return fromMode(rules[rule], rule, what);
}

/** The owner-only decision (spends money / publishes): a project rule of `deny` still denies, nothing else lets it run. */
function ownerDecision(n: OwnerNeed, rules: EscalationRules): PolicyDecision {
  const base = fromMode(rules[n.rule], n.rule, n.what);
  return base.outcome === 'deny' ? base : { outcome: 'ask', notify: true, reason: n.reason, rule: n.rule, owner: true };
}

/**
 * A tool call's final decision under a permission mode. `base` is what the escalation rules say for its class,
 * `need` what `needsOwner` says about this very call:
 *  - denied stays denied, in every mode;
 *  - spending or publishing asks in every mode (and is never turned into an allow by a rule);
 *  - otherwise in autonomous mode an `ask` is granted on the spot and flagged `autoApproved` (the caller records it);
 *  - 'ask' mode: the rule's decision as it always was.
 */
export function resolveToolDecision(base: PolicyDecision, need: OwnerNeed | null, mode: PermissionMode, rules: EscalationRules): PolicyDecision {
  if (base.outcome === 'deny') return base;
  if (need) return ownerDecision(need, rules);
  if (base.outcome === 'ask' && mode === 'autonomous') return { outcome: 'allow', notify: true, autoApproved: true, reason: `Auto-approved (autonomous mode): ${base.reason}`, rule: base.rule };
  return base;
}

/** The tool-call decision for an agent: its class rule, the owner-only check on this call, and the permission mode. */
export function decideToolCall(input: { permission: PermissionClass; tool: string; title: string; args: unknown }, rules: EscalationRules, mode: PermissionMode): PolicyDecision {
  return resolveToolDecision(decideToolClass(input.permission, rules, input.title), needsOwner({ kind: 'tool', tool: input.tool, permission: input.permission, args: input.args }), mode, rules);
}

// ─── Built-in provider tools (file edits, shell) ────────────────────────────

/** Paths inside a project the agents must never write to directly. */
const PROTECTED_SEGMENTS = [`${sep}.git${sep}`, `${sep}.shuriken${sep}project.db`, `${sep}node_modules${sep}`];

export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function decideFileWrite(path: string, roots: string[]): PolicyDecision {
  const abs = resolve(path);
  if (!roots.some((r) => isInside(r, abs))) {
    return { outcome: 'deny', notify: true, reason: `Write outside the project workspace is not permitted: ${abs}. Scratch files (throwaway scripts, intermediate files) go in ${SCRATCH_REL}/ inside the project: write and delete there freely`, rule: null };
  }
  const withSep = abs + sep;
  if (PROTECTED_SEGMENTS.some((seg) => withSep.includes(seg))) {
    return { outcome: 'deny', notify: true, reason: `Protected path (git internals, app database, dependencies): ${abs}`, rule: null };
  }
  return { outcome: 'allow', notify: false, reason: 'Write inside project workspace', rule: null };
}

interface ShellPattern {
  re: RegExp;
  rule: keyof EscalationRules;
  what: string;
  /**
   * Autonomous mode runs a command the rule would ask about only when it is safe by this check:
   * 'delete' = everything it deletes is inside the project or app data folder, 'git' = it works on a
   * repository inside them, 'system' = never (a command that reaches the whole machine). Unset: fine.
   */
  autonomous?: { delete: DeleteStyle } | 'git' | 'system';
}

/** `git` with the global options that may come before its subcommand (`git -C dir reset --hard` is `git reset --hard`). */
const GIT = String.raw`\bgit(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[a-z-]+(?:=\S+)?))*`;
const gitRe = (rest: string): RegExp => new RegExp(`${GIT}\\s+${rest}`, 'i');

const SHELL_PATTERNS: ShellPattern[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, rule: 'destructiveOperations', what: 'recursive force delete (rm -rf)', autonomous: { delete: 'unix' } },
  { re: /\bremove-item\b[^|;]*-recurse/i, rule: 'destructiveOperations', what: 'recursive delete (Remove-Item -Recurse)', autonomous: { delete: 'ps' } },
  { re: /\b(rd|rmdir)\s+\/s\b/i, rule: 'destructiveOperations', what: 'recursive delete (rd /s)', autonomous: { delete: 'cmd' } },
  { re: /\bdel\s+\/[sq]/i, rule: 'destructiveOperations', what: 'bulk delete (del /s)', autonomous: { delete: 'cmd' } },
  { re: gitRe(String.raw`reset\s+--hard\b`), rule: 'irreversibleChanges', what: 'git reset --hard', autonomous: 'git' },
  { re: gitRe(String.raw`clean\s+-[a-z]*f`), rule: 'irreversibleChanges', what: 'git clean -f', autonomous: 'git' },
  { re: gitRe(String.raw`checkout\s+--\s+\.`), rule: 'irreversibleChanges', what: 'discard all working changes', autonomous: 'git' },
  { re: gitRe(String.raw`push\b`), rule: 'externalCommunications', what: 'git push' },
  { re: gitRe(String.raw`(?:branch\s+-D|tag\s+-d)\b`), rule: 'irreversibleChanges', what: 'delete git ref', autonomous: 'git' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/i, rule: 'publishing', what: 'package publish' },
  // The commands, not the words: `format D:` and `shutdown /s` are; Python's "{}".format(), PowerShell's
  // Get-Date -Format and executor.shutdown() are not (test 3 asked the user twice for such false alarms).
  { re: /\bformat(?:\.com)?\s+[a-z]:|\b(?:diskpart|bcdedit|restart-computer|stop-computer)\b|\bshutdown(?:\.exe)?\s+[/-][a-z]/i, rule: 'destructiveOperations', what: 'system-level command', autonomous: 'system' },
  { re: /\breg(\.exe)?\s+(add|delete)\b|\bset-itemproperty\b.*hk(lm|cu):/i, rule: 'securitySensitive', what: 'registry modification' },
  { re: /\b(set-executionpolicy|netsh|new-netfirewallrule)\b/i, rule: 'securitySensitive', what: 'security configuration change' },
  { re: /(curl|wget|invoke-webrequest|iwr)\b[^|]*\|\s*(sh|bash|iex|invoke-expression)/i, rule: 'securitySensitive', what: 'download-and-execute' },
  { re: /\b(Invoke-RestMethod|curl|wget)\b[^\n]*(-X\s*POST|--data|-Method\s+Post)/i, rule: 'externalCommunications', what: 'outbound HTTP POST' },
];

/**
 * Seconds a shell command spends just waiting (sleep, Start-Sleep, timeout /t, ping -n N localhost,
 * Thread.Sleep), 0 if none. In the logged runs agents slept 40–380 s at a time waiting for Studio.
 */
export function shellWaitSeconds(command: string): number {
  let s = 0;
  const add = (n: number) => (s = Math.max(s, n));
  for (const m of command.matchAll(/\b(?:sleep|timeout(?:\.exe)?\s+\/t)\s+(\d+(?:\.\d+)?)/gi)) add(Number(m[1]));
  for (const m of command.matchAll(/\bStart-Sleep\b([^;|&\n]*)/gi)) {
    const ms = /-(?:m|milliseconds)\s+(\d+)/i.exec(m[1]!);
    const sec = /(?:-(?:s|seconds)\s+)?(\d+(?:\.\d+)?)/i.exec(m[1]!);
    if (ms) add(Number(ms[1]) / 1000);
    else if (sec) add(Number(sec[1]));
  }
  for (const m of command.matchAll(/\bping(?:\.exe)?\s+(?:-n|-c)\s+(\d+)\s+(?:127\.0\.0\.1|localhost)/gi)) add(Number(m[1]) - 1);
  for (const m of command.matchAll(/Thread\]::Sleep\(\s*(\d+)\s*\)/gi)) add(Number(m[1]) / 1000);
  return s;
}

/** Where and how a shell command is decided (the permission modes: docs/ARCHITECTURE.md). */
export interface ShellContext {
  /** 'ask' (the default here) decides as it always did; 'autonomous' grants what is safe and refuses what is not. */
  mode?: PermissionMode;
  /** The folders a command may delete in on its own: the project folder and the app's data folder. */
  roots?: string[];
  /** The directory the shell starts in (the project folder). */
  cwd?: string;
}

/** Whether an autonomous run may do what this pattern's command does (it stays inside the project and app data folders). */
function autonomousCheck(p: ShellPattern, command: string, ctx: ShellContext): SafetyCheck {
  const roots = ctx.roots ?? [];
  const cwd = ctx.cwd ?? roots[0] ?? '';
  if (!p.autonomous) return { ok: true, why: '' };
  if (p.autonomous === 'system') return { ok: false, why: 'reaches the whole machine' };
  if (!cwd || roots.length === 0) return { ok: false, why: 'has no project folder to check it against' };
  if (p.autonomous === 'git') return checkGitRepo(p.re, command, roots, cwd);
  return checkDeleteTargets(p.autonomous.delete, p.re, command, roots, cwd);
}

export function decideShell(command: string, rules: EscalationRules, ctx: ShellContext = {}): PolicyDecision {
  if (shellWaitSeconds(command) >= 10) {
    return {
      outcome: 'deny',
      notify: false,
      reason:
        'no need to wait: Studio tools wait for Studio by themselves (another agent\'s playtest, a verification), a behaviour check is one call (roblox_playtest "run"), and screenshots come back on their own. Carry on with the next step; if Studio stays busy for minutes, do file work and come back to it. To wait for uploads, a Kiln turn or Studio on purpose, call wait_for (never a shell loop)',
      rule: null,
    };
  }
  // Spending money and publishing ask in every mode (a rule of deny still denies).
  const owner = needsOwner({ kind: 'shell', command });
  if (owner) return ownerDecision(owner, rules);
  if (ctx.mode !== 'autonomous') {
    for (const p of SHELL_PATTERNS) {
      if (p.re.test(command)) return fromMode(rules[p.rule], p.rule, p.what);
    }
    return { outcome: 'allow', notify: false, reason: 'Shell command within normal development scope', rule: null };
  }
  // Autonomous: every pattern the command matches is looked at (the first one must not hide a later one). A
  // denial stays a denial; what the rules would ask about runs, as auto-approved, when it stays inside the
  // project and app data folders — a destructive command that doesn't is refused outright, never granted.
  const granted: ShellPattern[] = [];
  let rest: PolicyDecision | null = null;
  for (const p of SHELL_PATTERNS) {
    if (!p.re.test(command)) continue;
    const d = fromMode(rules[p.rule], p.rule, p.what);
    if (d.outcome === 'deny') return d;
    if (d.outcome === 'allow') {
      rest ??= d;
      continue;
    }
    const safe = autonomousCheck(p, command, ctx);
    if (!safe.ok) {
      return {
        outcome: 'deny',
        notify: true,
        reason: `${p.what} ${safe.why}: refused (autonomous mode only runs these inside the project and the app's data folder). Use a literal path inside the project, or leave it out`,
        rule: p.rule,
      };
    }
    granted.push(p);
  }
  if (granted.length) return { outcome: 'allow', notify: true, autoApproved: true, reason: `Auto-approved (autonomous mode): ${granted.map((p) => p.what).join(', ')}`, rule: granted[0]!.rule };
  return rest ?? { outcome: 'allow', notify: false, reason: 'Shell command within normal development scope', rule: null };
}
