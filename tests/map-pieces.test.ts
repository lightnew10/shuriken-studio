import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../src/core/agents/roles';
import { briefBody, footprintLine, renderBrief } from '../src/core/modeling/kiln-brief';

/**
 * The user's PvP dungeon build: the planner had the level designer build the whole map from parts and Roblox
 * terrain (stock Grass and Rock), with Kiln asked only for a small dressing kit. "This map looks straight out of
 * 2016 Roblox; the bank, the shop, the perks, literally everything could have been made in Kiln." And: Kiln
 * handles SEPARATE requests, Shuriken's team assembles them; not one whole-map request.
 */
const skill = (name: string) => readFileSync(join(__dirname, '..', 'resources', 'skills', name, 'SKILL.md'), 'utf8');

describe('a map piece on a Kiln brief', () => {
  it('adds one short line: a piece on its own, with its exact footprint', () => {
    // One fact and no orders: the origin, ground level and facing are Kiln's own defaults, the design is Kiln's.
    expect(footprintLine([32, 24], false)).toBe('A map piece on its own (no ground or base), footprint exactly 32 x 24 studs, front facing -Y.');
    expect(footprintLine([32, 24], false).length).toBeLessThan(110);
    const one = renderBrief({ text: 'The hub bank: a squat vault house.', footprint: [32, 24] }, { fields: true });
    expect(one).toBe(`The hub bank: a squat vault house.\n\n${footprintLine([32, 24], false)}`);
    // A kit: every piece fills the kit's cell.
    const kit = briefBody({ text: 'Cave tunnels.', family: 'Tunnels', members: [{ name: 'Straight' }, { name: 'Bend' }], footprint: [32, 32] }, { fields: true }).text;
    expect(kit).toContain('Separate models, exact top-level names: Straight, Bend.');
    expect(kit).toContain('Map pieces, each on its own (no ground or base), footprint exactly 32 x 32 studs each, front facing -Y.');
    expect(renderBrief({ text: 'A crate.' })).not.toMatch(/map piece/i);
  });
});

describe('who builds a map', () => {
  const planner = ROLES.executive!.instructions;
  const level = ROLES['level-designer']!.instructions;
  const env = ROLES['environment-artist']!.instructions;
  const critic = ROLES.critic!.instructions;

  it('the plan: a graybox, Kiln pieces in several tasks at once, then the assembly; never one whole-map request', () => {
    expect(planner).toMatch(/the map's GRAYBOX \(level-designer/);
    expect(planner).toMatch(/built by Kiln in SEPARATE pieces that Shuriken's team assembles; never plan it as parts,\s+Roblox terrain or one whole-map request/);
    expect(planner).toMatch(/each building or landmark players recognise \(a shop, a bank, an altar/);
    expect(planner).toMatch(/The\s+assembly task depends on the graybox and on the piece tasks/);
    expect(planner).not.toMatch(/terrain dressing/);
  });

  it('the level designer builds collision and measure, not the look', () => {
    expect(level).toMatch(/You build the GRAYBOX/);
    expect(level).toMatch(/no materials, no decoration, no Terrain/);
    expect(level).not.toMatch(/Terrain for ground/);
  });

  it('the environment artist gets the pieces from Kiln and assembles them', () => {
    expect(env).toMatch(/in separate pieces that you assemble/);
    expect(env).toMatch(/footprint: \[width, depth\]/);
    expect(env).toMatch(/Never Roblox Terrain, stock material textures or Creator Store models unless the\s+user asked for them/);
    expect(env).not.toMatch(/foliage and rocks may come from the Creator Store/);
  });

  it('the default look is custom-built, and the stock Roblox look fails a review', () => {
    for (const text of [level, env]) {
      expect(text).toMatch(/Default look — modern, clean and custom-built/);
      expect(text).toMatch(/stylised low-poly, chunky readable shapes, bevelled edges, flat\s+colours with soft gradients/);
      expect(text).toMatch(/No Roblox Terrain/);
      expect(text).not.toMatch(/Ground and landscapes use Terrain|free models \(trees, rocks/);
    }
    expect(critic).toMatch(/So does the stock Roblox look where the user asked for none/);
  });

  it('the skills say the same', () => {
    expect(skill('kiln-briefs')).toMatch(/## Map pieces: Kiln builds them one by one, your team assembles them/);
    expect(skill('kiln-briefs')).toMatch(/\*\*Kiln designs\s+it\.\*\* You add only the few facts the ASSEMBLY depends on/);
    expect(skill('roblox-environment-art')).toMatch(/\| A map or district \| NOT one request/);
    expect(skill('roblox-environment-art')).not.toMatch(/Creator Store \(`store_search`, scripts stripped\), else Kiln/);
    expect(skill('roblox-world-building')).toMatch(/What players see is not built here/);
  });
});
