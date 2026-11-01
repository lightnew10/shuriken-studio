import { z } from 'zod';
import type { ProjectContext } from '../projects/project-service';
import { DEFAULT_MODE, MATCH_LIMITS, MatchSetup, checkMatchConfig, type MatchMode } from '../match/match-config';
import { errorOutput, jsonOutput, type ToolRegistry } from './tool-registry';

export interface MatchToolDeps {
  project: () => ProjectContext | null;
}

const modeShape = z.strictObject({
  key: z.string().describe('Its name in code (Match.modes.Duel): PascalCase letters and digits'),
  name: z.string().max(MATCH_LIMITS.nameMax).describe('What players see ("1v1 Duel")'),
  teams: z.number().int().min(1).max(MATCH_LIMITS.teams),
  teamSize: z.number().int().min(1).max(MATCH_LIMITS.teamSize),
  ranked: z.boolean().optional().describe('Players of close ratings meet (the game gives its ratings with Match.useRating)'),
  maxWaitSec: z.number().optional().describe(`After this long anyone meets anyone (default ${DEFAULT_MODE.maxWaitSec})`),
  ratingWindow: z.number().optional().describe(`Ranked: how far apart two ratings may be at first (default ${DEFAULT_MODE.ratingWindow})`),
  ratingWidenPerSec: z.number().optional().describe(`Ranked: how much wider each second of waiting (default ${DEFAULT_MODE.ratingWidenPerSec})`),
  botsAfterSec: z.number().optional().describe('After this long a match starts with whoever is there and the empty places are bots the game plays; leave out for never'),
});

/**
 * Matchmade games (match/match-config.ts): the modes a game is played in, and the generated ShurikenMatch module that
 * runs the lobby, the queue, the matchmaker, the match servers and the way back. The gameplay engineer's.
 */
export function registerMatchTools(reg: ToolRegistry, d: MatchToolDeps): void {
  reg.register({
    name: 'match_setup',
    title: 'Set up the lobby, queue and match servers',
    description:
      'For a game played in matches (PvP rounds, ranked duels, team modes): one place, two roles. Public servers are the lobby, where players queue; the matchmaker reserves a private server of the same place for each match and sends its players there; Match.finish sends them back. Writes the game\'s ShurikenMatch module (src/Shared/ShurikenMatch.luau, skill "roblox-matchmaking") from the modes: each with a key, a shown name, teams, teamSize, and optionally ranked (close ratings meet, the window widening with the wait), maxWaitSec and botsAfterSec. The game writes what a match is: Match.onStart(fn(match)) with match.teams and match.bots, Match.finish(match, results). Never write your own queue, lock or teleport code. In Studio a queue starts a test match in the same server, so the whole loop is playtested there; teleports between servers only happen once the user publishes the game.',
    capability: 'app.match',
    permission: 'write_project',
    input: {
      modes: z.array(modeShape).min(1).max(MATCH_LIMITS.modes),
      startTimeoutSec: z.number().optional().describe('How long a match server waits for its players (default 30)'),
      rejoin: z.boolean().optional().describe('A player who drops out of a match may go back from the lobby (default true)'),
    },
    handler: async ({ args, caller }) => {
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const modes: MatchMode[] = args.modes.map((m) => ({
        key: m.key,
        name: m.name.trim(),
        teams: m.teams,
        teamSize: m.teamSize,
        ranked: m.ranked ?? DEFAULT_MODE.ranked,
        maxWaitSec: m.maxWaitSec ?? DEFAULT_MODE.maxWaitSec,
        ratingWindow: m.ratingWindow ?? DEFAULT_MODE.ratingWindow,
        ratingWidenPerSec: m.ratingWidenPerSec ?? DEFAULT_MODE.ratingWidenPerSec,
        ...(m.botsAfterSec !== undefined ? { botsAfterSec: m.botsAfterSec } : {}),
      }));
      const config = { modes, startTimeoutSec: args.startTimeoutSec ?? 30, rejoin: args.rejoin ?? true };
      const check = checkMatchConfig({ ...config, updatedAt: '' });
      if (check.errors.length) return errorOutput(`Nothing written. Fix these and call again:\n- ${check.errors.join('\n- ')}`);
      const loc = new MatchSetup(p.root).save(config, p.extras().syncMap);
      p.audit.event({ kind: 'match.setup', title: `Matches: ${modes.map((m) => `${m.name} (${m.teams}x${m.teamSize})`).join(', ')}`, runId: caller.runId, taskId: caller.taskId, role: caller.role, detail: { modes: modes.map((m) => m.key) } });
      return jsonOutput(
        { modes, file: loc.file, require: loc.requirePath },
        [
          `${loc.file} written: ${modes.map((m) => `${m.key} (${m.name}: ${m.teams} team${m.teams === 1 ? '' : 's'} of ${m.teamSize}${m.ranked ? ', ranked' : ''}${m.botsAfterSec !== undefined ? `, bots after ${m.botsAfterSec} s` : ''})`).join('; ')}.`,
          ...(check.warnings.length ? ['Look again:', ...check.warnings.map((w) => `- ${w}`)] : []),
          `Require it (${loc.requirePath}) from a server script at startup and from the client; sync with roblox_sync_push. The game's code: Match.onStart(fn(match)) sets up the arena for match.teams (and match.bots), Match.finish(match, results) after saving results; the lobby UI follows Match.state on the client. Test it in a playtest: Match.queue on the server starts a test match at once.`,
        ].join('\n'),
      );
    },
  });

  reg.register({
    name: 'match_get',
    title: 'The game’s match setup',
    description: "The game's modes (teams, team size, ranked, waits) and where its ShurikenMatch module is, or that the game has none.",
    capability: 'app.match',
    permission: 'read',
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const p = d.project();
      if (!p) return errorOutput('No project is open in Shuriken');
      const c = new MatchSetup(p.root).get();
      if (!c) return jsonOutput({ config: null }, 'No match setup yet: match_setup writes one for a game played in matches.');
      const loc = MatchSetup.moduleLocation(p.extras().syncMap);
      return jsonOutput({ config: c, file: loc.file, require: loc.requirePath });
    },
  });
}
