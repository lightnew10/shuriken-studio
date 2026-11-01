import { describe, expect, it } from 'vitest';
import { normalizeAccent } from '../../src/shared/ui-forge';
import { DEVICE_ASPECT, FORGE_DEFAULT, SAMPLE_ASPECT, designerMessage, forgeLink, inkOn, lookFor, pictureWidth, readPick } from '../../src/renderer/src/lib/forge';

// The UI page's Forge view: what the user picked survives a restart (and bad storage), links open it on a look or a
// template, pictures are asked for at the size they show, and "Ask the designer" hands the copilot the pick.

describe('the Forge view', () => {
  it('reads a pick back from storage, falling back where it is missing or wrong', () => {
    expect(readPick(null)).toEqual(FORGE_DEFAULT);
    expect(readPick({ direction: 'ember', accent: '#3FA9FF', screen: 'shop', device: 'tablet', stage: 'sheet', roblox: false, backdrop: 'game' })).toEqual({ direction: 'ember', accent: '#3fa9ff', screen: 'shop', device: 'tablet', stage: 'sheet', roblox: false, backdrop: 'game', genre: null });
    expect(readPick({ direction: '../x', accent: 'red', device: 'fridge', stage: 'x' })).toEqual(FORGE_DEFAULT);
    expect(normalizeAccent('#abc')).toBe('#aabbcc');
    expect(normalizeAccent('FF7A1A')).toBe('#ff7a1a');
    expect(normalizeAccent('#ff7a1')).toBeNull();
  });

  it('opens from links: a look, its elements, a template on a device', () => {
    expect(forgeLink('forge')).toEqual({});
    expect(forgeLink('forge.ember')).toEqual({ direction: 'ember' });
    expect(forgeLink('forge.ember.sheet')).toEqual({ direction: 'ember', stage: 'sheet' });
    expect(forgeLink('forge.neon.shop.phone')).toEqual({ direction: 'neon', screen: 'shop', stage: 'preview', device: 'phone' });
    expect(forgeLink('forge:neon:shop:tv')).toEqual({ direction: 'neon', screen: 'shop', stage: 'preview', device: 'tv' });
    expect(forgeLink('mockup:sword-shop')).toBeNull();
    expect(forgeLink('HUD')).toBeNull();
    expect(forgeLink(undefined)).toBeNull();
  });

  it('asks for pictures as big as they show on this screen, in steps a resize reuses', () => {
    // A 900×500 box holds a laptop picture 889 wide; on a 2× screen that's 1778 pixels, asked as 1792.
    expect(pictureWidth({ w: 900, h: 500 }, SAMPLE_ASPECT, 2)).toBe(1792);
    expect(pictureWidth({ w: 900, h: 500 }, SAMPLE_ASPECT, 1)).toBe(896);
    expect(pictureWidth({ w: 903, h: 501 }, SAMPLE_ASPECT, 1)).toBe(896);
    // A phone is wide: the box's width decides.
    expect(pictureWidth({ w: 700, h: 600 }, DEVICE_ASPECT.phone, 1)).toBe(704);
    expect(pictureWidth({ w: 10, h: 10 }, 1, 1)).toBe(192);
    expect(pictureWidth({ w: 5000, h: 5000 }, 1, 3)).toBe(1792);
  });

  it('writes what the look is for as two sentences', () => {
    expect(lookFor('simulators, pet collecting: thick ink outlines, glossy buttons')).toEqual({ games: 'For simulators, pet collecting.', looks: 'Thick ink outlines, glossy buttons.' });
    expect(lookFor('just a look')).toEqual({ games: '', looks: 'Just a look.' });
  });

  it('puts text that reads on a swatch', () => {
    expect(inkOn('#ffc93c')).toBe('#000000');
    expect(inkOn('#5b7cff')).toBe('#ffffff');
    expect(inkOn('#1c1714')).toBe('#ffffff');
  });

  it('hands the UI copilot the pick with the words, and how to wear the look', () => {
    const m = designerMessage({ direction: 'candy', name: 'Candy', tagline: 'chunky glossy simulator', accent: '#ff7ab8', screen: 'shop', screenLabel: 'Shop', device: 'phone', text: '  A pet shop with eggs and a VIP pass  ' });
    expect(m.text.startsWith('A pet shop with eggs and a VIP pass\n\nFrom the Forge: the Candy art direction (chunky glossy simulator), accent #ff7ab8, the Shop template on a phone')).toBe(true);
    expect(m.text).toContain('"candy:button:primary#ff7ab8"');
    expect(m.item).toBe('forge:candy#ff7ab8:shop');
    expect(m.note).toBe('the Forge: the Candy look tinted #ff7ab8, Shop on a phone');
    expect(m.picture).toBe('forge-candy-shop.png');
    const plain = designerMessage({ direction: 'frost', name: 'Frost', tagline: 'clean modern glass', accent: null, screen: 'sample', screenLabel: 'Store sample', device: 'tablet', text: '' });
    expect(plain.text.startsWith("Design my game's UI in this look.")).toBe(true);
    expect(plain.text).toContain('its sample screen on a laptop');
    expect(plain.text).toContain('"frost:button:primary"');
    expect(designerMessage({ direction: 'neon', name: 'Neon', tagline: 'sci-fi', accent: null, screen: 'shop', screenLabel: 'Shop', device: 'desktop', text: '' }).text.startsWith('Make me a shop for my game in this look.')).toBe(true);
    // The game's own UI: how to dress it in one step.
    const game = designerMessage({ direction: 'ember', name: 'Ember', tagline: 'forged metal', accent: '#3fa9ff', screen: 'game', screenLabel: 'Your game’s UI', device: 'phone', text: '' });
    expect(game.text.startsWith("Dress my game's UI in this look and polish it.")).toBe(true);
    expect(game.text).toContain("the game's own UI (as last read) dressed in it on a phone");
    expect(game.text).toContain('from "game" and reskin {direction: "ember", accent: "#3fa9ff"}');
    expect(readPick({ screen: 'game' }).screen).toBe('game');
  });
});
