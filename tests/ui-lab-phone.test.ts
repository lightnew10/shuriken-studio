import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditUi } from '../src/shared/ui-layout';
import type { MockVersion } from '../src/shared/ui-mockup';
import { labDevice, normalizeInsets, LAB_DEVICES } from '../src/core/ui/lab/devices';
import { labCheck, mockupSubject, withoutDecor, wornSubject } from '../src/core/ui/lab/lab';
import { phoneChecks } from '../src/core/ui/lab/phone';
import { robloxMeasure } from '../src/core/ui/lab/roblox-fonts';

// The phone defects blind judges named in rounds 3 and 4 of the UI Forge head-to-heads,
// on the designs they judged (tests/fixtures/ui-judged): the Lab passed every one of them before these checks.
const DIR = join(__dirname, 'fixtures', 'ui-judged');
const load = (name: string) => {
  const fx = JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as { title: string; version: Omit<MockVersion, 'createdAt' | 'note'> };
  return mockupSubject({ title: fx.title }, { ...fx.version, createdAt: '', note: '' } as MockVersion);
};
const phones = LAB_DEVICES.filter((d) => d.form === 'phone' && d.orientation === 'landscape');
const lab = (name: string) => phoneChecks(load(name), [...phones]).map((f) => f.message);
const audit = (name: string) => {
  // As the Lab audits: skins worn (their art draws and reaches past its box), the art itself left out.
  const s = withoutDecor(wornSubject(load(name)).subject);
  const se = labDevice('phone-small')!;
  return auditUi(s.screensOn(se).map(normalizeInsets), [{ ...se, phone: true }], robloxMeasure, { exactText: true }).map((f) => f.message);
};
const has = (list: string[], re: RegExp) => list.some((m) => re.test(m));

describe('phone checks on the designs blind judges marked down on phones', () => {
  it('has the judged designs', () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith('.json')).length).toBe(9);
  });

  it('finds item names the phone drops ("the tiles lose their item names") and a frame in the home indicator', () => {
    const f = lab('horror-forge4');
    expect(has(f, /lose their ItemName/)).toBe(true);
    expect(has(f, /into the home indicator/)).toBe(true);
  });

  it('finds labels the phone drops while what they name stays (the PAINT caption, the UPGRADE caption)', () => {
    expect(has(lab('racing-forge'), /drops \d+ labels .*"PAINT"/)).toBe(true);
    expect(has(lab('racing-lab'), /drops 1 label .*"PAINT/)).toBe(true);
  });

  it('finds a list that shows only 2 of its 6 rows on an iPhone SE, and notes one that shows half', () => {
    expect(has(lab('tycoon-forge'), /Only 2 of its 6 items show whole/)).toBe(true);
    expect(has(lab('tycoon-lab'), /3 of its 6 items show whole/)).toBe(true);
  });

  it('finds text that reads tiny on a phone (11.2 and 12.8 pt), rows spilling below the window, a pip under a button', () => {
    expect(has(audit('horror-lab'), /Text is 11.2 points on a phone/)).toBe(true);
    expect(has(audit('tycoon-lab'), /Text is 12.8 points on a phone/)).toBe(true);
    expect(has(audit('tycoon-forge4'), /Spills out of Upgrades.Window/)).toBe(true);
    expect(has(audit('racing-forge'), /Hidden under/)).toBe(true);
  });

  it('warns of paint swatches touching each other ("crowded, easy to tap the wrong colour")', { timeout: 120_000 }, () => {
    const touching = (name: string) =>
      labCheck(load(name), { devices: ['phone-small', 'phone-notch'] }).findings.some((f) => f.category === 'touch' && f.severity === 'warning' && /mm from .*(Swatch|Paint)/.test(`${f.path} ${f.message}`));
    expect(touching('racing-lab')).toBe(true);
    expect(touching('racing-forge4')).toBe(true);
  });

  it('stays quiet where the judges were: no safe-area or short-list findings on designs that fit', () => {
    for (const name of ['racing-forge4', 'racing-lab', 'horror-lab']) {
      const f = lab(name);
      expect(f.filter((m) => /safe area|items show whole/.test(m))).toEqual([]);
    }
  });
});
