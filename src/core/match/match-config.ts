import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowIso } from '@shared/ids';
import type { SyncMap } from '../roblox/luau-toolchain';
import { sharedModuleLocation } from '../roblox/shared-module';
import { MATCH_RUNTIME_VERSION, matchModule } from './match-luau';

/**
 * Matchmade games (1.15.2): one place, two roles. Public servers of the place are the lobby, where players queue; a
 * matchmaker reserves private servers of the same place for the matches and sends the players there, and the match
 * sends them back. The game's code never writes its own queue or teleports: Shuriken generates ShurikenMatch from
 * this config (match-luau.ts), and the game writes what a match is (Match.onStart, Match.finish). In Studio, where
 * there are no teleports, a queue starts a test match in the same server, so the whole loop is playtested there.
 */

export interface MatchMode {
  /** Its name in code (Match.modes.Duel): PascalCase letters and digits. */
  key: string;
  /** What players see ("1v1 Duel"). */
  name: string;
  /** How many teams (2 for a duel or team match; a free-for-all is N teams of 1). */
  teams: number;
  /** Players per team. */
  teamSize: number;
  /** Players of close ratings play each other (the game keeps the ratings: Match.useRating). */
  ranked: boolean;
  /** After this long in the queue anyone may be matched with anyone (the rating window is gone). */
  maxWaitSec: number;
  /** How far apart two ratings may be at first, and how much wider that gets each second of waiting. */
  ratingWindow: number;
  ratingWidenPerSec: number;
  /** After this long a match starts with whoever is there, the empty places being bots (the game plays them); none: never. */
  botsAfterSec?: number;
}

export interface MatchConfig {
  modes: MatchMode[];
  /** How long a match server waits for its players before it starts with those who came. */
  startTimeoutSec: number;
  /** A player who drops out of a running match is offered to go back to it from the lobby. */
  rejoin: boolean;
  updatedAt: string;
}

export const MATCH_LIMITS = { modes: 8, teams: 12, teamSize: 12, players: 50, keyMax: 24, nameMax: 40 };

export const DEFAULT_MODE = { ranked: false, maxWaitSec: 90, ratingWindow: 100, ratingWidenPerSec: 5 } as const;

/** Problems that stop a config (errors) and things worth a second look (warnings). */
export function checkMatchConfig(c: MatchConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!c.modes.length) errors.push('at least one mode');
  if (c.modes.length > MATCH_LIMITS.modes) errors.push(`${c.modes.length} modes: keep it to ${MATCH_LIMITS.modes} (each has its own queue)`);
  const keys = new Set<string>();
  for (const m of c.modes) {
    const at = m.key || '(no key)';
    if (!/^[A-Z][A-Za-z0-9]{1,23}$/.test(m.key ?? '')) errors.push(`${at}: key is a PascalCase code name of 2-24 letters and digits ("Duel", "Squads4")`);
    if (keys.has(m.key)) errors.push(`${at}: two modes share this key`);
    keys.add(m.key);
    if (!m.name?.trim() || m.name.length > MATCH_LIMITS.nameMax) errors.push(`${at}: a name of 1-${MATCH_LIMITS.nameMax} characters`);
    if (!Number.isInteger(m.teams) || m.teams < 1 || m.teams > MATCH_LIMITS.teams) errors.push(`${at}: teams is 1-${MATCH_LIMITS.teams}`);
    if (!Number.isInteger(m.teamSize) || m.teamSize < 1 || m.teamSize > MATCH_LIMITS.teamSize) errors.push(`${at}: teamSize is 1-${MATCH_LIMITS.teamSize}`);
    if (m.teams * m.teamSize > MATCH_LIMITS.players) errors.push(`${at}: ${m.teams * m.teamSize} players in a match; at most ${MATCH_LIMITS.players}`);
    if (m.teams * m.teamSize < 2 && m.botsAfterSec === undefined) warnings.push(`${at}: a match of one player; set botsAfterSec, or it is a solo mode that needs no queue`);
    if (!(m.maxWaitSec >= 10 && m.maxWaitSec <= 900)) errors.push(`${at}: maxWaitSec is 10-900`);
    if (m.botsAfterSec !== undefined && !(m.botsAfterSec >= 5 && m.botsAfterSec <= 900)) errors.push(`${at}: botsAfterSec is 5-900`);
    if (!(m.ratingWindow >= 0) || !(m.ratingWidenPerSec >= 0)) errors.push(`${at}: ratingWindow and ratingWidenPerSec are 0 or more`);
    if (!m.ranked && (m.ratingWindow !== DEFAULT_MODE.ratingWindow || m.ratingWidenPerSec !== DEFAULT_MODE.ratingWidenPerSec)) warnings.push(`${at}: a rating window on a mode that isn't ranked does nothing`);
  }
  if (!(c.startTimeoutSec >= 10 && c.startTimeoutSec <= 120)) errors.push('startTimeoutSec is 10-120');
  return { errors, warnings };
}

/** The project's match setup (.shuriken/match/config.json) and the game's ShurikenMatch module written from it. */
export class MatchSetup {
  constructor(private readonly root: string) {}

  private file(): string {
    return join(this.root, '.shuriken', 'match', 'config.json');
  }

  get(): MatchConfig | null {
    try {
      return existsSync(this.file()) ? (JSON.parse(readFileSync(this.file(), 'utf8')) as MatchConfig) : null;
    } catch {
      return null;
    }
  }

  /** Saves the config (after checkMatchConfig) and writes the game's module. */
  save(c: Omit<MatchConfig, 'updatedAt'>, syncMap?: SyncMap): { file: string; requirePath: string } {
    const next: MatchConfig = { ...c, updatedAt: nowIso() };
    mkdirSync(dirname(this.file()), { recursive: true });
    const tmp = `${this.file()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file());
    return this.writeModule(next, syncMap);
  }

  static moduleLocation(syncMap: SyncMap | undefined): { file: string; requirePath: string } {
    return sharedModuleLocation(syncMap, 'ShurikenMatch');
  }

  writeModule(c: MatchConfig, syncMap?: SyncMap): { file: string; requirePath: string } {
    const loc = MatchSetup.moduleLocation(syncMap);
    const path = join(this.root, loc.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, matchModule(c), 'utf8');
    return loc;
  }

  /** Whether the game's module was written by an older runtime than this app's. */
  moduleStale(syncMap?: SyncMap): boolean {
    const path = join(this.root, MatchSetup.moduleLocation(syncMap).file);
    if (!existsSync(path)) return !!this.get();
    const m = /^-- ShurikenMatch v(\d+)/m.exec(readFileSync(path, 'utf8'));
    return !m || Number(m[1]) < MATCH_RUNTIME_VERSION;
  }
}
