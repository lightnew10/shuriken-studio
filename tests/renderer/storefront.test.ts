import { describe, expect, it } from 'vitest';
import { countLine, pushLine, storefrontTabs, thumbStandings, type ArtEntry, type StoreItemView } from '../../src/renderer/src/lib/storefront';

const thumb = (name: string, at = '2026-10-03T00:00:00Z'): ArtEntry => ({ name, file: `thumbs/${name}.png`, note: '', at, by: 'thumbnail-artist' });
const item = (key: string, over: Partial<StoreItemView> = {}): StoreItemView => ({ key, kind: 'pass', name: key, description: '', price: 99, benefit: 'x', status: 'draft', ...over });

describe('the Storefront page', () => {
  it('shows the tabs the switches leave: the store with monetization, the words with copy, the pictures with either', () => {
    expect(storefrontTabs({ monetization: true, copy: true })).toEqual(['store', 'pictures', 'copy']);
    expect(storefrontTabs({ monetization: false, copy: true })).toEqual(['pictures', 'copy']);
    expect(storefrontTabs({ monetization: true, copy: false })).toEqual(['store', 'pictures']);
    expect(storefrontTabs({ monetization: false, copy: false })).toEqual([]);
  });

  it('lists the thumbnails as the judge left them: the pick, the runner-up, then the first to fall, then the unjudged', () => {
    const thumbs = [thumb('a'), thumb('b'), thumb('c'), thumb('d'), thumb('late', '2026-10-03T02:00:00Z')];
    const pick = { winner: 'b', rounds: [{ out: 'c', why: 'dark' }, { out: 'a', why: 'busy' }, { out: 'd', why: 'small text' }], why: 'reads at a glance', at: '', among: ['a', 'b', 'c', 'd'] };
    const s = thumbStandings(thumbs, pick);
    expect(s.map((t) => [t.name, t.place])).toEqual([
      ['b', 1],
      ['d', 2],
      ['a', 3],
      ['c', 4],
      ['late', null],
    ]);
    expect(s[0]!.why).toBe('reads at a glance');
    expect(s[3]!.why).toBe('dark');
    // The user picked another: theirs first, the judge's reasons kept, no places.
    const mine = thumbStandings(thumbs, { ...pick, winner: 'c', byUser: true });
    expect(mine.map((t) => [t.name, t.place])[0]).toEqual(['c', 1]);
    expect(mine.slice(1).every((t) => t.place === null)).toBe(true);
    expect(mine.find((t) => t.name === 'a')!.why).toBe('busy');
    // Not judged yet: newest first.
    expect(thumbStandings([thumb('x'), thumb('y', '2026-10-04T00:00:00Z')], undefined).map((t) => t.name)).toEqual(['y', 'x']);
  });

  it("says what a push would send, and counts against Roblox's limits", () => {
    const items = [item('VIP'), item('Coins', { kind: 'product' }), item('Gold', { status: 'changed' }), item('Old', { status: 'live' })];
    expect(pushLine(items, ['VIP', 'Coins', 'Gold'])).toBe('2 game passes and 1 developer product aren’t on Roblox yet (1 changed since pushed).');
    expect(pushLine(items, [])).toBe('Everything in the store is on Roblox and up to date.');
    expect(pushLine([], [])).toBe('');
    expect(countLine('Sound Wars', 50)).toEqual({ text: '10/50', tone: 'faint' });
    expect(countLine('x'.repeat(46), 50).tone).toBe('warn');
    expect(countLine('x'.repeat(51), 50).tone).toBe('bad');
  });
});
