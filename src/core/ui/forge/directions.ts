import type { Direction } from './kit';
import { aqua } from './looks/aqua';
import { candy } from './looks/candy';
import { ember } from './looks/ember';
import { forest } from './looks/forest';
import { frost } from './looks/frost';
import { grunge } from './looks/grunge';
import { kawaii } from './looks/kawaii';
import { motorsport } from './looks/motorsport';
import { neon } from './looks/neon';
import { parchment } from './looks/parchment';
import { pixel } from './looks/pixel';
import { royal } from './looks/royal';
import { tactical } from './looks/tactical';
import { toybox } from './looks/toybox';
import { withProps } from './props';

/**
 * Art directions: complete, coherent looks for a game's UI, each a palette, its fonts, text inks for every surface and
 * a recipe for every kind of element — windows, headers, buttons (primary, secondary, danger, success, premium; normal,
 * hover, pressed, disabled, selected), tabs, cards, item slots, badges, ribbons, progress bars, currency pills, icon
 * frames, close buttons and title type — so one choice gives a whole screen a consistent, finished identity, and an
 * accent re-tints it for the game. Each direction lives in looks/<id>.ts; the shared contract is kit.ts. Icons (and
 * currency coins) whose glyph names a prop — an egg, a chest, a potion, a gem — are drawn as that filled object in the
 * direction's style (props/); other glyphs stay the direction's own sticker.
 */

export { BUTTON_ROLES, ELEMENT_KINDS, ELEMENT_STATES, RARITY, contrastRatio, inkContrast, inkFor, withState, type ButtonRole, type Direction, type ElementKind, type ElementRequest, type ElementState, type StateLook, type TextInk, type Variant } from './kit';

export const DIRECTIONS: Record<string, Direction> = withProps({ candy, ember, neon, parchment, frost, toybox, grunge, aqua, forest, royal, pixel, kawaii, tactical, motorsport });
