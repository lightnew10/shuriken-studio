import type { VerificationMethod } from '@shared/domain';
import { checkName } from './test-service';

/**
 * Checks are written before the code they test exists, and some fail for a reason that is the probe's own: a
 * probe stored to run on the server that reads Players.LocalPlayer (nil there), fires a remote with FireServer
 * (client only) or reads the player's camera or input. Such a probe can never pass, whatever the game does, so
 * it is refused where checks are registered (plan_add_task, test_register, task_update_verification,
 * task_fix_probe) with a message that says where it belongs.
 */

/** Where a probe runs. */
export type ProbeSide = 'edit' | 'server' | 'client';

interface Rule {
  /** What the probe used, as the message names it. */
  what: string;
  /** Tested on the code without comments and without the contents of its strings. */
  code?: RegExp;
  /** Tested on the code without comments (strings kept): service names are strings. */
  text?: RegExp;
  why: string;
}

const service = (name: string) => new RegExp(`GetService\\(\\s*["']${name}["']\\s*\\)|\\bgame\\.${name}\\b`);

/** Only there for the player's own client: on the server (and in Edit) they are nil, error, or are not the player's. */
const CLIENT_ONLY: Rule[] = [
  { what: 'Players.LocalPlayer', code: /\.LocalPlayer\b/, why: 'it is nil on the server' },
  { what: 'workspace.CurrentCamera', code: /\.CurrentCamera\b/, why: "the player's camera exists only on their client" },
  { what: 'UserInputService', text: service('UserInputService'), why: 'input is read on the client only' },
  { what: ':FireServer(', code: /:FireServer\s*\(/, why: 'only a client can fire a remote at the server' },
  { what: ':InvokeServer(', code: /:InvokeServer\s*\(/, why: 'only a client can invoke the server' },
];

/** Only there for the server: a client can't see them or call them. */
const SERVER_ONLY: Rule[] = [
  { what: 'ServerScriptService', text: service('ServerScriptService'), why: 'a client cannot see its contents' },
  { what: 'ServerStorage', text: service('ServerStorage'), why: 'a client cannot see its contents' },
  { what: 'DataStoreService', text: service('DataStoreService'), why: 'data stores are reachable from the server only' },
  { what: ':FireClient(', code: /:FireClient\s*\(/, why: 'only the server can fire a remote at a client' },
  { what: ':FireAllClients(', code: /:FireAllClients\s*\(/, why: 'only the server can fire a remote at clients' },
  { what: '.OnServerEvent', code: /\.OnServerEvent\b/, why: 'it can be connected on the server only' },
  { what: '.OnServerInvoke', code: /\.OnServerInvoke\b/, why: 'it can be set on the server only' },
];

/** Edit mode has no player and nothing running: these can't work there either. */
const NOT_IN_EDIT: Rule[] = CLIENT_ONLY.filter((r) => r.what === 'Players.LocalPlayer' || r.what.startsWith(':'));

/** Luau without its comments; with `strings` false, string contents are emptied too (quotes kept). */
export function stripLuau(code: string, strings: boolean): string {
  let out = '';
  for (let i = 0; i < code.length; ) {
    const c = code[i]!;
    const long = /^(--)?\[(=*)\[/.exec(code.slice(i, i + 40));
    if (long && (long[1] || c === '[')) {
      const close = `]${long[2]}]`;
      const end = code.indexOf(close, i + long[0].length);
      const stop = end < 0 ? code.length : end + close.length;
      // A long comment goes; a long string keeps its place (and its text when strings are kept).
      if (!long[1]) out += strings ? code.slice(i, stop) : '""';
      else out += ' ';
      i = stop;
    } else if (c === '-' && code[i + 1] === '-') {
      const end = code.indexOf('\n', i);
      i = end < 0 ? code.length : end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      out += strings ? code.slice(i, Math.min(code.length, j + 1)) : `${c}${c}`;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** What `code`, run on `side`, uses that only exists on the other side: [what, why] pairs, each once. */
export function wrongSideUses(code: string, side: ProbeSide): Array<{ what: string; why: string }> {
  const rules = side === 'server' ? CLIENT_ONLY : side === 'client' ? SERVER_ONLY : NOT_IN_EDIT;
  const bare = stripLuau(code, false);
  const text = stripLuau(code, true);
  return rules.filter((r) => (r.code ? r.code.test(bare) : false) || (r.text ? r.text.test(text) : false)).map(({ what, why }) => ({ what, why }));
}

/** The probes of a check, with the side each runs on. */
export function probesOf(m: VerificationMethod): Array<{ side: ProbeSide; code: string; field: string }> {
  if (m.kind === 'luau_assert') return [{ side: m.datamodel ?? 'edit', code: m.luau, field: 'luau' }];
  if (m.kind === 'cloud_luau') return [{ side: 'server', code: m.luau, field: 'luau' }];
  if (m.kind === 'playtest') {
    return [...(m.luau ? [{ side: 'server' as const, code: m.luau, field: 'luau' }] : []), ...(m.clientLuau ? [{ side: 'client' as const, code: m.clientLuau, field: 'clientLuau' }] : [])];
  }
  return [];
}

const HOW_CLIENT = 'Register it as a client probe: a luau_assert with "datamodel":"client", or a playtest\'s "clientLuau" (its "luau" runs on the server). To check the same thing from the server, use the server\'s own objects: Players:GetPlayers()[1], the character, the attributes and values the client code replicates.';
const HOW_SERVER = 'Register it as a server probe: a luau_assert with "datamodel":"server", or a playtest\'s "luau" (its "clientLuau" runs on the client). A client probe checks what the player\'s client sees: PlayerGui, the camera, replicated instances and attributes.';
const HOW_EDIT = 'Edit mode has no player and nothing running. Register it as a probe that runs in a playtest: "datamodel":"client" for client code, "datamodel":"server" for server code, or a playtest with "luau" / "clientLuau".';

/**
 * Why a check can't be registered as it is (null when it can): one of its probes runs on a side where what it
 * uses doesn't exist. The message names the check, the side, what it used, and how to register it instead.
 */
export function lintCheck(m: VerificationMethod): string | null {
  for (const p of probesOf(m)) {
    const uses = wrongSideUses(p.code, p.side);
    if (!uses.length) continue;
    const where = p.side === 'edit' ? 'in Edit mode' : `on the ${p.side}`;
    const how = p.side === 'server' ? HOW_CLIENT : p.side === 'client' ? HOW_SERVER : HOW_EDIT;
    return `Check "${checkName(m)}" was not registered: its probe (${p.field}) runs ${where} but uses ${uses.map((u) => `${u.what} (${u.why})`).join(', ')}, so it could never pass whatever the game does. ${how}`;
  }
  return null;
}

/** The first refusal among several checks (null when all can be registered). */
export function lintChecks(methods: readonly VerificationMethod[]): string | null {
  for (const m of methods) {
    const r = lintCheck(m);
    if (r) return r;
  }
  return null;
}

/** A probe that tests nothing: its whole body returns PASS. */
export function isEmptyProbe(code: string): boolean {
  return /^\s*return\s*\(?\s*["']PASS[^"']*["']\s*\)?\s*;?\s*$/i.test(stripLuau(code, true));
}
