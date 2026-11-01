import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ForgeSpec } from '../forge';
import { roleOf, withState, type Direction, type ElementRequest } from '../kit';
import type { Color } from '../style';
import { glyphName, glyphSet } from '../../ui-glyphs';
import { propCtx, propSpec, type PropDef, type PropLook } from './kit';
import { PROP_LOOKS } from './looks';
import { PROP_ALIASES } from './names';
import { ITEMS } from './items';
import { REWARDS } from './rewards';
import { NATURE } from './nature';
import { FOOD } from './food';
import { POWER } from './power';
import { TREASURE } from './treasure';
import { VARIANTS } from './variants';
import { WEAPONS } from './weapons';
import { CREATURES } from './creatures';
import { VEHICLES } from './vehicles';
import { DINER } from './diner';
import { GEAR } from './gear';

/**
 * Props: game objects drawn as filled, shaded art — eggs, chests, potions, gems, coins, cash, keys, crowns, trophies,
 * scrolls, gifts, swords, shields, hearts, food, pets' paws, rockets, bombs, vehicles, diner food, survival gear and more
 * — in any art direction's style.
 * An icon skin whose glyph names a prop (`candy:icon:egg:epic`, `ember:icon:loot-crate`, `royal:icon:pet-egg`) is
 * drawn as the prop; a coin skin whose glyph names a currency prop (`candy:coin:gem`, `neon:coin:cash`) too; any
 * other glyph stays the direction's line-art sticker. A direction without a prop look keeps its own icons.
 */

export const PROPS: Record<string, PropDef> = { ...TREASURE, ...REWARDS, ...ITEMS, ...POWER, ...NATURE, ...FOOD, ...VARIANTS, ...WEAPONS, ...CREATURES, ...VEHICLES, ...DINER, ...GEAR };

export const PROP_NAMES: readonly string[] = Object.keys(PROPS).sort();

export { PROP_LOOKS, PROP_ALIASES, propCtx, propSpec };
export type { PropDef, PropLook };

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

/** The resources folder the bundled glyph catalogue is read from (as the Forge's shapes find it). */
const resourcesDir = (): string | null => process.env.SHURIKEN_RESOURCES ?? [join(__dirname, '..', '..', '..', '..', '..', 'resources'), join(__dirname, '..', '..', '..', '..', 'resources'), join(process.cwd(), 'resources')].find((d) => existsSync(join(d, 'ui-glyphs'))) ?? null;

const resolved = new Map<string, string | null>();

/** A name's prop by its own name or an alias (no catalogue). */
function direct(n: string): string | null {
  if (PROPS[n]) return n;
  const a = PROP_ALIASES[n];
  if (a && PROPS[a]) return a;
  return null;
}

/**
 * The prop a glyph name draws, or null: a prop's own name (which wins over a Lucide glyph of that name), an alias (game
 * words and Lucide names: "pet-egg", "loot-crate", "flask-conical", "zap"), its singular, or a game word from the glyph
 * catalogue (resources/ui-glyphs/game-icons.json) whose best glyph is a prop's.
 */
export function resolveProp(name: string | undefined): string | null {
  if (!name) return null;
  const n = norm(name);
  const hit = resolved.get(n);
  if (hit !== undefined) return hit;
  let out = direct(n) ?? (n.endsWith('s') ? direct(n.replace(/e?s$/, '')) ?? direct(n.slice(0, -1)) : null);
  if (!out) {
    try {
      const set = glyphSet(resourcesDir());
      const g = set ? glyphName(set, n) : null;
      out = g ? direct(g) : null;
    } catch {
      out = null;
    }
  }
  resolved.set(n, out);
  return out;
}

/** A request drawn as a prop in a look, or null when it isn't one (not an icon or coin, no prop for its glyph). */
export function propElement(look: PropLook, r: ElementRequest, accent?: Color): ForgeSpec | null {
  if (r.kind !== 'icon' && r.kind !== 'coin') return null;
  const name = resolveProp(r.glyph);
  const def = name ? PROPS[name] : undefined;
  if (!def || (r.kind === 'coin' && !def.currency) || Math.min(r.size[0], r.size[1]) < (look.minSide ?? 0)) return null;
  const spec = propSpec(def, propCtx(r, look, accent, def));
  const { state } = roleOf(r);
  return state === 'normal' ? spec : withState(spec, state, { press: 2, ...(look.grey ? { grey: look.grey, greyMix: 0.4 } : {}) });
}

/** Directions whose icons (and currency coins) draw props where one exists; a direction without a prop look is kept as is. */
export function withProps(directions: Record<string, Direction>): Record<string, Direction> {
  const out: Record<string, Direction> = {};
  for (const [id, d] of Object.entries(directions)) {
    const look = PROP_LOOKS[id];
    out[id] = look ? { ...d, element: (r, accent) => propElement(look, r, accent) ?? d.element(r, accent) } : d;
  }
  return out;
}
