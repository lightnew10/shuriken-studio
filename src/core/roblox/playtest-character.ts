import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether a playtest waits for the player's character. Many games open in a menu (a garage, a lobby screen) and
 * spawn no character until the player deploys: in one build 103 of 262 playtests waited the full 15 s for a
 * character that was never going to come and then said spawning might be failing. The game says so itself
 * (Players.CharacterAutoLoads is off), and when it doesn't, the project's own playtests do: after one that got
 * no character, the next ones don't wait for one.
 */

/** How long a playtest waits for a character, and for the player to have joined when no character is expected (seconds). An object so a test can shorten it. */
export const CHARACTER_WAIT = { characterSec: 15, playerSec: 5, graceSec: 1.5 };

export interface CharacterWait {
  /** A character with a HumanoidRootPart was there. */
  character: boolean;
  /** A player had joined. */
  player: boolean;
  /** Players.CharacterAutoLoads when the wait ended. */
  autoLoads: boolean;
  /** Seconds spent waiting. */
  waited: number;
}

/**
 * Luau (Server DataModel): waits for the play-solo player's character. With `expect` true it waits up to
 * `characterSec` whatever the game says; with false it only waits for the player to have joined; with null it
 * waits for a character unless the game doesn't load one on join (CharacterAutoLoads off) or `skip` is set (the
 * project's last playtests got none).
 */
export function awaitCharacterLuau(expect: boolean | null, skip: boolean): string {
  return `
local Players = game:GetService("Players")
local expect = ${expect === null ? 'nil' : String(expect)}
local skip = ${String(skip)}
local t0 = os.clock()
local joined = nil
local function character()
  local p = Players:GetPlayers()[1]
  return p ~= nil and p.Character ~= nil and p.Character:FindFirstChild("HumanoidRootPart") ~= nil
end
local function wants()
  if expect ~= nil then return expect end
  return Players.CharacterAutoLoads and not skip
end
while not character() do
  local waited = os.clock() - t0
  local limit = if wants() then ${CHARACTER_WAIT.characterSec} else ${CHARACTER_WAIT.playerSec}
  if waited >= limit then break end
  -- No character is expected: the probes only need the player to have joined. When it is the project's history
  -- that says so (not the game), a character that still spawns gets a moment to show up, and the history is corrected.
  if not wants() and Players:GetPlayers()[1] ~= nil then
    joined = joined or os.clock()
    if expect == false or not Players.CharacterAutoLoads or os.clock() - joined >= ${CHARACTER_WAIT.graceSec} then break end
  end
  task.wait(0.2)
end
return game:GetService("HttpService"):JSONEncode({
  character = character(),
  player = Players:GetPlayers()[1] ~= nil,
  autoLoads = Players.CharacterAutoLoads,
  waited = math.floor((os.clock() - t0) * 10 + 0.5) / 10,
})`;
}

/** What the wait came to, as the playtest's result says it (null when the character was there: nothing to say). */
export function characterLine(w: CharacterWait | null, expect: boolean | null, skipped: boolean, misses: number): string | null {
  if (!w) return 'The wait for the player\'s character got no answer from the server; the probes ran as it was.';
  if (w.character) return null;
  const join = w.player ? '' : ' (the player had not joined yet either)';
  if (expect === true) return `No player character appeared within ${CHARACTER_WAIT.characterSec} s although one was expected (expect_character)${join}: the game hasn't spawned or deployed the player yet, or spawning fails.`;
  if (expect === false) return `Probes ran without a character (expect_character: false)${join}.`;
  if (!w.autoLoads) return `This game doesn't spawn a character on join (Players.CharacterAutoLoads is off); probes ran without one${join}. Pass expect_character: true when this playtest should wait for one (after a deploy your probe triggers, a test hook).`;
  if (skipped) return `This game doesn't spawn a character on join (none appeared in its last ${misses} playtest${misses === 1 ? '' : 's'}); probes ran without one${join}. Pass expect_character: true when this playtest should wait for one.`;
  return `No player character appeared within ${CHARACTER_WAIT.characterSec} s${join}, although Players.CharacterAutoLoads is on: either the game holds the player in a menu and removes the character, or spawning fails. The next playtests of this project don't wait for one; pass expect_character: true when one should.`;
}

/** The project's memory of it (`.shuriken/playtest.json`): how many playtests in a row got no character. */
export class CharacterHistory {
  private readonly file: string;

  constructor(projectDir: string) {
    this.file = join(projectDir, 'playtest.json');
  }

  /** Playtests in a row that got no character (0 after one that did, or with no history). */
  misses(): number {
    try {
      const n = (JSON.parse(readFileSync(this.file, 'utf8')) as { noCharacter?: unknown }).noCharacter;
      return typeof n === 'number' && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  }

  record(gotCharacter: boolean): void {
    try {
      writeFileSync(this.file, JSON.stringify({ noCharacter: gotCharacter ? 0 : this.misses() + 1 }), 'utf8');
    } catch {
      /* best effort: the next playtest waits once more */
    }
  }
}
