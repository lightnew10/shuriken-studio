import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentVersion, summarizeMockup, versionLabel, type MockNode } from '../src/shared/ui-mockup';
import { MockupStore } from '../src/core/ui/ui-mockups';

// The builder: "every fix makes a new version (A–E when only C and E matter)". A fix is made in place (the letter
// stays, the revision counts up, the one before is kept), superseded versions are retired out of the way, and a
// change can be checked and drawn without saving.

const screen = (title: number): MockNode[] => [{ name: 'Hud', kids: [{ name: 'Title', cls: 'TextLabel', text: 'Hi', textSize: title, size: [0, 200, 0, 40] }] }];
const store = () => new MockupStore(mkdtempSync(join(tmpdir(), 'shuriken-mock-')));

describe('versions', () => {
  it('fixes a version in place: same letter, the next revision, the one before kept', () => {
    const s = store();
    s.create({ title: 'Hud', versions: [{ note: 'a', screens: screen(20) }, { note: 'b', screens: screen(24) }] });
    const fixed = s.revise('hud', [{ version: 'b', set: { 'Hud.Title': { textSize: 30 } }, note: 'bigger title' }], 'copilot-ui');
    expect(fixed.errors).toEqual([]);
    const m = s.get('hud')!;
    expect(m.versions.map((v) => versionLabel(v))).toEqual(['A', 'B·2']);
    const b = m.versions[1]!;
    expect(b).toMatchObject({ id: 'B', rev: 2, note: 'bigger title' });
    expect(b.screens[0]!.kids![0]!.textSize).toBe(30);
    expect(b.history).toEqual([expect.objectContaining({ rev: 1, note: 'b', screens: screen(24) })]);
    // A fix with errors changes nothing; a fix of nothing is refused.
    expect(s.revise('hud', [{ version: 'B', set: { 'Hud.Titel': { textSize: 1 } } }]).errors[0]).toMatch(/no element Hud\.Titel .*Hud has Title/);
    expect(s.revise('hud', [{ version: 'C', note: 'x' }]).errors[0]).toMatch(/no version "C"/);
    expect(s.revise('hud', [{ version: 'A' }]).errors[0]).toMatch(/nothing to change/);
    expect(s.get('hud')!.versions[1]!.rev).toBe(2);
    // History keeps the last five.
    for (let i = 0; i < 7; i++) s.revise('hud', [{ version: 'A', set: { 'Hud.Title': { textSize: 10 + i } } }]);
    expect(s.get('hud')!.versions[0]!).toMatchObject({ rev: 8 });
    expect(s.get('hud')!.versions[0]!.history).toHaveLength(5);
  });

  it('retires superseded versions and brings them back, never the pick, what is in the game or the last one', () => {
    const s = store();
    s.create({ title: 'Hud', versions: [1, 2, 3, 4].map((n) => ({ note: `v${n}`, screens: screen(18 + n) })) });
    s.choose('hud', 'C');
    s.markApplied('hud', 'D');
    expect(s.retire('hud', ['a', 'B'], true).errors).toEqual([]);
    const m = s.get('hud')!;
    expect(m.versions.filter((v) => v.retired).map((v) => v.id)).toEqual(['A', 'B']);
    expect(summarizeMockup(m).versions.find((v) => v.id === 'A')).toMatchObject({ retired: true });
    expect(s.retire('hud', ['D'], true).errors).toEqual(['D is in the game: it stays']);
    expect(s.retire('hud', ['Z'], true).errors[0]).toMatch(/no version "Z"/);
    expect(s.retire('hud', ['A'], false).mockup!.versions[0]!.retired).toBeUndefined();
    // Picking a retired version brings it back; the newest that isn't retired is what shows without a pick.
    s.retire('hud', ['A'], true);
    expect(s.choose('hud', 'A')!.versions[0]!.retired).toBeUndefined();
    const only = store();
    only.create({ title: 'One', versions: [{ note: 'x', screens: screen(20) }, { note: 'y', screens: screen(22) }] });
    only.retire('one', ['B'], true);
    expect(currentVersion(only.get('one')!)!.id).toBe('A');
    expect(only.retire('one', ['A'], true).errors).toEqual(['every version would be retired: keep at least one']);
  });

  it('checks a change without saving it', () => {
    const s = store();
    const dry = s.create({ title: 'Dry', versions: [{ note: 'x', screens: screen(20) }], dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, errors: [] });
    expect(dry.mockup!.versions).toHaveLength(1);
    expect(s.get('dry')).toBeNull();
    s.create({ title: 'Dry', versions: [{ note: 'x', screens: screen(20) }] });
    expect(s.revise('dry', [{ version: 'A', set: { 'Hud.Title': { textSize: 40 } } }], undefined, true).revised![0]!.screens[0]!.kids![0]!.textSize).toBe(40);
    expect(s.addVersions('dry', [{ note: 'y', screens: screen(30) }], undefined, null, true).added).toHaveLength(1);
    expect(s.get('dry')!.versions).toHaveLength(1);
    expect(s.get('dry')!.versions[0]!.screens[0]!.kids![0]!.textSize).toBe(20);
    expect(existsSync(join((s as unknown as { root: string }).root, '.shuriken', 'ui', 'mockups'))).toBe(true);
    expect(readdirSync(join((s as unknown as { root: string }).root, '.shuriken', 'ui', 'mockups'))).toEqual(['dry.json']);
  });

  it('says a fixed version is not what was built', () => {
    const s = store();
    s.create({ title: 'Hud', versions: [{ note: 'a', screens: screen(20) }] });
    s.markApplied('hud', 'A', ['src/Client/Hud.client.luau']);
    const r = s.revise('hud', [{ version: 'A', set: { 'Hud.Title': { textSize: 26 } } }]);
    expect(r.warnings).toEqual(['A is in the game as it was before this fix: build it again to bring the fix in']);
    expect(s.markApplied('hud', 'A')!.applied).toMatchObject({ version: 'A', rev: 2 });
  });
});
