import { describe, expect, it } from 'vitest';
import { SMALL_FIX_FILES, lightReview } from '../src/core/orchestrator/review-policy';
import type { MethodResult } from '../src/core/verification/verifier';

// In the user's simple parkour game the critic ran 30 times and was a quarter of the build's cost, most of it on
// one- and two-file fixes whose playtest check had just passed; its four rejections that afternoon were on larger work.
const ok = (kind: MethodResult['kind'], name: string, passed: boolean | null = true): MethodResult => ({ kind, name, passed, output: '', evidenceId: null });
const fix = { kind: 'implement' as const, role: 'roblox-engineer', attempts: 1, acceptanceCriteria: ['Fallen bots respawn at their spawn point and the knockout is counted.'] };
const checks = [ok('static_analysis', 'static_analysis'), ok('playtest', 'bots_respawn'), ok('critic', 'critic', null)];

describe('when the checks are review enough', () => {
  it('a small code fix that a playtest proved needs no critic run', () => {
    expect(SMALL_FIX_FILES).toBe(4);
    expect(lightReview(fix, ['src/Server/Bots.server.luau'], checks)).toEqual({ why: 'A small code change (1 file) proven by its check bots_respawn: no separate review was needed.' });
    expect(lightReview(fix, ['src/Server/Bots.server.luau', 'src/Shared/Rounds.luau'], [...checks, ok('luau_assert', 'ko_counted')])!.why).toMatch(/2 files\) proven by 2 checks that run the game/);
  });

  it('the critic still reviews everything else', () => {
    const one = ['src/Server/Bots.server.luau'];
    // More than four files, or none, or something that isn't code.
    expect(lightReview(fix, ['a.luau', 'b.luau', 'c.luau', 'd.luau'], checks)!.why).toMatch(/^A small code change \(4 files\)/);
    expect(lightReview(fix, ['a.luau', 'b.luau', 'c.luau', 'd.luau', 'e.luau'], checks)).toBeNull();
    expect(lightReview(fix, [], checks)).toBeNull();
    expect(lightReview(fix, ['a.luau', 'world/arena.rbxm'], checks)).toBeNull();
    // Nothing ran the game.
    expect(lightReview(fix, one, [ok('static_analysis', 'static_analysis'), ok('critic', 'critic', null)])).toBeNull();
    // A check failed, was left undecided, or needs a look.
    expect(lightReview(fix, one, [...checks, ok('playtest', 'other', false)])).toBeNull();
    expect(lightReview(fix, one, [...checks, ok('perf', 'budget', null)])).toBeNull();
    expect(lightReview(fix, one, [...checks, ok('screenshot', 'hud')])).toBeNull();
    // Work that has to be looked at, security, QA and planning.
    for (const role of ['ui-engineer', 'vfx-artist', 'environment-artist', 'level-designer', 'modeler', 'animator', 'sound-designer', 'security-engineer', 'qa-engineer']) expect(lightReview({ ...fix, role }, one, checks), role).toBeNull();
    expect(lightReview({ ...fix, kind: 'test' }, one, checks)).toBeNull();
    // A second attempt (the first was rejected or failed) is reviewed.
    expect(lightReview({ ...fix, attempts: 2 }, one, checks)).toBeNull();
    // A criterion about looks.
    expect(lightReview({ ...fix, acceptanceCriteria: ['The beam visibly turns when steered.'] }, one, checks)).toBeNull();
  });
});
