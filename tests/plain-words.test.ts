import { describe, expect, it } from 'vitest';
import { errorMeaning, goalTitle, hasJargon, isRawError, plainOption, plainText, scriptLabel, scrubRawErrors, shortTitle, withoutFiller } from '../src/shared/plain-words';
import { titleFromPrompt } from '../src/core/director/director';

/**
 * What the chat shows the game's owner carries no internal ids, file paths, coordinates, tool names or raw error
 * text. Every example here is a line or a card the user's chat showed as it was (audits of three projects).
 */
describe('plain text', () => {
  it('takes out ids, Studio instance ids, paths, coordinates and tool names', () => {
    expect(plainText('roblox_status lists two Studio instances (ids d93090f8… and 4be1c2a9…), both on the place')).toBe("Studio's status lists two Studio instances, both on the place");
    expect(plainText('Following your earlier answer (esc_01m482s1kzcxyqhgfqn2g76vp4, option B), I left the art ids.')).toBe('Following your earlier answer (option B), I left the art ids.');
    expect(plainText('Push PitUI.client.luau while the Store task holds it?')).toBe('Push the PitUI client script while the Store task holds it?');
    expect(plainText('What the code does now, in src/Client/DailyShrine.client.luau')).toBe('What the code does now, in the DailyShrine client script');
    expect(plainText('the generated src/Shared/ShurikenStore.luau does not exist')).toBe('the generated ShurikenStore module does not exist');
    expect(plainText('Moved the shrine to (0,120,38) so it faces the hole.')).toBe('Moved the shrine so it faces the hole.');
    expect(plainText('Spawn it at Vector3.new(10, 5, -3.5) please')).toBe('Spawn it please');
    expect(plainText("Every playtest fails: 'No open Studio instance matches. Open: Voxel Pit (placeId: 70000000000001)'")).not.toMatch(/70000000000001|placeId/);
    expect(plainText('All 74 icons are owned by group 30000001 (check PASS).')).toBe('All 74 icons are owned by group (check PASS).');
    expect(plainText('Studio is held by another agent (run_01m49m99sadqqxhk39msaz1c6h), in a playtest')).toBe('Studio is held by another agent, in a playtest');
    expect(plainText('the suite still fails for wkgkeby6:luau_assert:perk_tutorial_gone')).toBe('the suite still fails for perk tutorial gone');
    expect(plainText('Claude Code native binary not found at C:\\Users\\me\\AppData\\claude.exe')).toBe("The Claude Code program couldn't be found on this PC.");
    expect(plainText('mcp__shuriken__roblox_sync_push and task_run_checks hang')).toBe("the code sync and the task's checks hang");
  });

  it('leaves plain sentences exactly as they are', () => {
    for (const s of [
      'Blocked: Build the sword. Retrying with a different approach: Use a placeholder sword model and move on.',
      'Decided without asking you: Continue with the next milestone after "Lobby"? Yes: planning and building the next milestone from the roadmap.',
      'Your Claude account is at its usage limit until about 3:20 PM, so I can\'t answer yet.',
      'Paused until you resume: usage limit reached. Press Resume to carry on.',
      'The team was stopped. It is running again for this request.',
      'Well of Souls: a 2-player co-op dungeon',
    ]) {
      expect(plainText(s)).toBe(s);
      expect(hasJargon(s)).toBe(false);
    }
  });

  it('names scripts by what they are', () => {
    expect(scriptLabel('src/Client/Combat.client.luau')).toBe('the Combat client script');
    expect(scriptLabel('Round.server.luau')).toBe('the Round server script');
    expect(scriptLabel('src/Shared/Util.luau')).toBe('the Util module');
    expect(scriptLabel('src/Shared/Weapons/init.luau')).toBe('the Weapons module');
  });
});

describe('raw errors', () => {
  it('are recognized by their shape, not by words a person also uses', () => {
    expect(isRawError("Orchestrator error: Cannot read properties of undefined (reading 'slice')")).toBe(true);
    expect(isRawError('Illegal task transition done → verifying for task_01')).toBe(true);
    expect(isRawError('Claude Code native binary not found at C:\\x\\claude.exe')).toBe(true);
    expect(isRawError('The account is at its usage limit.')).toBe(false);
    expect(isRawError('It timed out after a minute.')).toBe(false);
    expect(errorMeaning("Orchestrator error: Cannot read properties of undefined (reading 'slice')")).toBe('something inside Shuriken went wrong (a bug in Shuriken)');
    expect(errorMeaning('Illegal task transition done → verifying')).toMatch(/a bug in Shuriken/);
  });

  it('become one plain clause inside a chat line, and the line as it was is kept', () => {
    const r = scrubRawErrors("I couldn't process that just now (Claude Code native binary not found at C:\\Users\\me\\claude.exe). Try again in a moment.");
    expect(r.text).toBe("I couldn't process that just now (the Claude Code program couldn't be found on this PC). Try again in a moment.");
    expect(r.technical).toMatch(/native binary not found/);
    const s = scrubRawErrors("Something went wrong reading your message: Cannot read properties of undefined (reading 'slice')");
    expect(s.text).toBe('Something went wrong reading your message: something inside Shuriken went wrong (a bug in Shuriken).');
    expect(scrubRawErrors('Your Claude account is at its usage limit.')).toEqual({ text: 'Your Claude account is at its usage limit.', technical: null });
  });
});

describe('answer buttons', () => {
  it('say what happens; the value sent back stays the option itself', () => {
    expect(plainOption('retry')).toBe('Try again');
    expect(plainOption('cancel')).toBe('Cancel it');
    expect(plainOption('B: keep the old ART ids, report the missing group image uploader')).toBe('Keep the old ART ids, report the missing group image uploader');
    expect(plainOption('Release the stale lock / stop run_01m49m99')).toBe('Release the stale lock / stop');
  });
});

describe('goal titles', () => {
  it('never start with the user\'s filler and name the change in six words or fewer', () => {
    expect(goalTitle('ugh the group rewards label is glitching out, get that fixed up')).toBe('Fix the group rewards label');
    expect(goalTitle('The bow aiming on mobile still needs work, please revamp it.')).toBe('Improve the bow aiming on mobile');
    expect(goalTitle('Not bad! But the jump is too floaty.')).toBe('The jump is too floaty');
    expect(goalTitle('Also, is it just me or does the sword feel slow?')).not.toMatch(/^(also|is it)/i);
    expect(goalTitle('Also, lets make the sword swing SFX more like a swoosh, lets make the hitmarker bigger')).toBe('Make the sword swing SFX');
    expect(goalTitle('ok')).toBe('Requested change');
    for (const t of ['ugh the group rewards label is glitching out', 'Also, Is it just me or is the lobby too dark', 'Not bad, add a shop next to the spawn', 'can you please lets add a daily reward']) {
      const title = goalTitle(t);
      expect(title.split(' ').length).toBeLessThanOrEqual(6);
      expect(title).not.toMatch(/^(ugh|also|not bad|can you|please|lets)\b/i);
    }
  });

  it('short titles cut at a colon and keep at most six words', () => {
    expect(shortTitle('Valor shop: permanent upgrades bought with Valor at a new lobby altar')).toBe('Valor shop');
    expect(shortTitle('Batch of 21 changes and a ship-ready game for every device')).toBe('Batch of 21 changes');
    expect(withoutFiller('Nice! Thanks. Now, add a leaderboard to the lobby.')).toBe('add a leaderboard to the lobby.');
  });

  it("a game's name from the start page's request drops the filler too", () => {
    expect(titleFromPrompt('A sword-fighting arena: drop in from a sky lobby, pick a blade, last one standing wins.')).toBe('Sword-fighting Arena');
    expect(titleFromPrompt('ugh ok so, make me a cozy fishing game where you catch rare fish')).toBe('Cozy Fishing Game');
    expect(titleFromPrompt('Not bad! Now build a tower defense with 5 towers')).toBe('Tower Defense');
  });
});
