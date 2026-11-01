import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';
import { composeBlocker, noteMusicSearch } from '../src/core/capabilities/audio-tools';
import type { CallerContext } from '../src/core/capabilities/tool-registry';

/**
 * "For full audio tracks please prefer to source it elsewhere rather than synth, SFX too if quality stuff is
 * available with no copyright." The prompt alone didn't hold: in the first 1.13 build the planner wrote
 * "audio_music for an upbeat quirky warehouse loop and a jaunty delivery loop" into the audio task, and both tracks
 * were composed without one search for music.
 */
const agent = (runId: string, role = 'sound-designer'): CallerContext => ({ kind: 'agent', runId, taskId: null, role, providerId: null, allowedTools: null });

describe('composing music', () => {
  it('an agent is sent to look first, and told the three reasons that allow composing', () => {
    const no = composeBlocker(agent('run_1'), undefined)!;
    expect(no).toMatch(/^Music is found before it is composed\. Find it first: audio_find/);
    expect(no).toMatch(/why: "nothing_found" \(after that search, in this run\), "adaptive" .* or "user_asked"/);
    expect(no).toMatch(/A task that says "audio_music" names a tool, not a decision/);
  });

  it('"nothing found" is only true after a search for music in the same run', () => {
    expect(composeBlocker(agent('run_2'), 'nothing_found')).toMatch(/^No search for music was made in this run\./);
    // A search for voices is not a search for music.
    noteMusicSearch('run_2', ['cartoon gibberish angry voice', 'surprised gasp cartoon'], undefined);
    expect(composeBlocker(agent('run_2'), 'nothing_found')).not.toBeNull();
    noteMusicSearch('run_2', ['upbeat quirky warehouse music loop'], 45);
    expect(composeBlocker(agent('run_2'), 'nothing_found')).toBeNull();
    // Another run's search doesn't count.
    expect(composeBlocker(agent('run_3'), 'nothing_found')).not.toBeNull();
    // Long recordings asked for: that is a search for a track, whatever its words.
    noteMusicSearch('run_3', ['jaunty delivery'], 60);
    expect(composeBlocker(agent('run_3'), 'nothing_found')).toBeNull();
  });

  it('layered music and music the user asked for are composed without a search', () => {
    expect(composeBlocker(agent('run_4'), 'adaptive')).toBeNull();
    expect(composeBlocker(agent('run_4'), 'user_asked')).toBeNull();
  });

  it("the user's own Audio page and copilot compose whenever they like", () => {
    expect(composeBlocker({ kind: 'ui', runId: null, taskId: null, role: null, providerId: null, allowedTools: null }, undefined)).toBeNull();
    expect(composeBlocker(agent('run_5', 'copilot-audio'), undefined)).toBeNull();
  });

  it('the planner names the sounds, never the tool, and the sound designer sources first', () => {
    const planner = ROLES.executive!.instructions;
    expect(planner).toMatch(/sound-designer → found recordings first \(audio_find, then\s+audio_add or audio_import: all music and beds, and every effect a library has\)/);
    expect(planner).toMatch(/never the tool \("audio_music", "compose", "synthesize"\)/);
    const sound = ROLES['sound-designer']!.instructions;
    expect(sound).toMatch(/SOURCE FIRST, synthesize last/);
    expect(sound).toMatch(/Music is composed \(audio_music\) only when two searches found nothing that fits/);
  });
});
