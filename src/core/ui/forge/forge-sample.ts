import type { MockColor, MockNode } from '@shared/ui-mockup';
import { DIRECTIONS, inkFor, type Direction, type TextInk, type Variant } from './directions';
import type { Color } from './style';

/**
 * Each art direction's sample screen: a full shop window (title plate, balance, tabs, a grid of item cards in every
 * rarity with buy buttons, a NEW badge, a close button) worn in the direction's skins and written in its own inks,
 * in mockup format. The Forge's gallery shows it as the direction's card and the stage shows it big; "Make a mockup"
 * can start from it too.
 */

interface SampleContent {
  title: string;
  tabs: string[];
  currency: string;
  items: Array<[name: string, glyph: string, rarity: string, price: string]>;
}

/** Words and items in each direction's own genre (a pet shop for candy, an armory for ember…). */
export const SAMPLE_CONTENT: Record<string, SampleContent> = {
  candy: { title: 'PET SHOP', tabs: ['Pets', 'Eggs', 'Boosts', 'Passes'], currency: 'coins', items: [['Bubbles', 'fish', 'common', '250'], ['Sky Pup', 'dog', 'rare', '1,200'], ['Star Cat', 'cat', 'epic', '4,800'], ['Gold Bunny', 'rabbit', 'legendary', '12K'], ['Rainbow Bird', 'bird', 'mythic', '50K'], ['Turtle', 'turtle', 'common', '300'], ['Snail', 'snail', 'rare', '900'], ['Dragon', 'flame', 'mythic', '99K']] },
  ember: { title: 'ARMORY', tabs: ['Blades', 'Armor', 'Relics', 'Skins'], currency: 'flame', items: [['Ember Edge', 'sword', 'common', '400'], ['Ash Guard', 'shield', 'rare', '1,500'], ['Scorch Axe', 'axe', 'epic', '3,900'], ['Sunfire', 'swords', 'legendary', '9,800'], ['Hellbrand', 'flame', 'mythic', '25K'], ['Iron Helm', 'hard-hat', 'common', '350'], ['Bloodstone', 'gem', 'epic', '4,200'], ['Crown', 'crown', 'legendary', '15K']] },
  neon: { title: 'HANGAR', tabs: ['Mechs', 'Weapons', 'Cores', 'Decals'], currency: 'cpu', items: [['Scout', 'bot', 'common', '500'], ['Rail Gun', 'crosshair', 'rare', '2,100'], ['Plasma', 'zap', 'epic', '5,400'], ['Titan', 'shield', 'legendary', '14K'], ['Nova Core', 'atom', 'mythic', '40K'], ['Thruster', 'rocket', 'common', '700'], ['Radar', 'radar', 'rare', '1,800'], ['Warp', 'orbit', 'mythic', '60K']] },
  parchment: { title: 'Market', tabs: ['Arms', 'Potions', 'Scrolls', 'Mounts'], currency: 'crown', items: [['Longsword', 'sword', 'common', '120'], ['Elixir', 'flask-conical', 'rare', '340'], ['Tome', 'book-open', 'epic', '900'], ['Dragon Egg', 'egg', 'legendary', '2,400'], ['Phoenix', 'feather', 'mythic', '8,000'], ['Bow', 'target', 'common', '150'], ['Amulet', 'gem', 'rare', '600'], ['Griffin', 'bird', 'legendary', '3,100']] },
  frost: { title: 'Store', tabs: ['Featured', 'Avatar', 'Emotes', 'Passes'], currency: 'star', items: [['Hoodie', 'shirt', 'common', '80'], ['Shades', 'glasses', 'rare', '150'], ['Wave', 'hand', 'epic', '220'], ['Aura', 'sparkles', 'legendary', '480'], ['Halo', 'circle-dashed', 'mythic', '900'], ['Cap', 'graduation-cap', 'common', '60'], ['Boombox', 'speaker', 'rare', '300'], ['VIP', 'crown', 'legendary', '1,200']] },
  toybox: { title: 'BRICK SHOP', tabs: ['Bricks', 'Sets', 'Figures', 'Passes'], currency: 'blocks', items: [['Red Brick', 'box', 'common', '50'], ['Race Car', 'car', 'rare', '900'], ['Rocket', 'rocket', 'epic', '2,400'], ['Castle', 'castle', 'legendary', '8K'], ['Robot', 'bot', 'mythic', '25K'], ['Tree', 'trees', 'common', '120'], ['Plane', 'plane', 'rare', '1,100'], ['Crown', 'crown', 'mythic', '40K']] },
  grunge: { title: 'SUPPLIES', tabs: ['Tools', 'Meds', 'Traps', 'Keys'], currency: 'skull', items: [['Flashlight', 'flashlight', 'common', '80'], ['Medkit', 'briefcase-medical', 'rare', '300'], ['Crowbar', 'hammer', 'epic', '650'], ['Lantern', 'lamp', 'legendary', '1,400'], ['Cursed Key', 'key', 'mythic', '6,666'], ['Battery', 'battery', 'common', '40'], ['Bandage', 'bandage', 'rare', '150'], ['Talisman', 'eye', 'legendary', '2,000']] },
  aqua: { title: 'BAIT SHOP', tabs: ['Rods', 'Bait', 'Boats', 'Pets'], currency: 'shell', items: [['Starter Rod', 'fish', 'common', '100'], ['Shrimp', 'shrimp', 'rare', '450'], ['Anchor', 'anchor', 'epic', '1,800'], ['Sailboat', 'sailboat', 'legendary', '7,500'], ['Kraken', 'waves', 'mythic', '30K'], ['Shell', 'shell', 'common', '60'], ['Turtle', 'turtle', 'rare', '900'], ['Pearl', 'gem', 'legendary', '12K']] },
  forest: { title: 'Garden Shop', tabs: ['Seeds', 'Tools', 'Pets', 'Decor'], currency: 'leaf', items: [['Carrot', 'carrot', 'common', '20'], ['Sprout', 'sprout', 'rare', '150'], ['Shovel', 'shovel', 'epic', '600'], ['Apple Tree', 'apple', 'legendary', '2,500'], ['Fairy', 'sparkles', 'mythic', '9K'], ['Flower', 'flower', 'common', '40'], ['Pine', 'tree-pine', 'rare', '300'], ['Owl', 'bird', 'legendary', '4K']] },
  royal: { title: 'TREASURY', tabs: ['Crowns', 'Robes', 'Jewels', 'VIP'], currency: 'gem', items: [['Ring', 'circle', 'common', '500'], ['Scepter', 'wand', 'rare', '2,000'], ['Tiara', 'crown', 'epic', '6,000'], ['Castle', 'castle', 'legendary', '25K'], ['Dragon', 'flame', 'mythic', '99K'], ['Goblet', 'wine', 'common', '800'], ['Shield', 'shield', 'rare', '3,000'], ['Royal Pass', 'ticket', 'legendary', '40K']] },
  pixel: { title: 'ITEM SHOP', tabs: ['Power', 'Gear', 'Skins', 'Lives'], currency: 'coins', items: [['Shroom', 'circle-dot', 'common', '10'], ['Sword', 'sword', 'rare', '50'], ['Heart', 'heart', 'epic', '120'], ['Star', 'star', 'legendary', '300'], ['Ghost', 'ghost', 'mythic', '999'], ['Key', 'key', 'common', '25'], ['Bomb', 'bomb', 'rare', '80'], ['Crown', 'crown', 'legendary', '500']] },
  kawaii: { title: 'Sweet Shop', tabs: ['Treats', 'Pets', 'Bows', 'Passes'], currency: 'heart', items: [['Cupcake', 'cake-slice', 'common', '40'], ['Bunny', 'rabbit', 'rare', '300'], ['Kitty', 'cat', 'epic', '900'], ['Sundae', 'ice-cream-cone', 'legendary', '2,000'], ['Unicorn', 'sparkles', 'mythic', '9,999'], ['Cookie', 'cookie', 'common', '25'], ['Candy', 'candy', 'rare', '120'], ['Cloud', 'cloud', 'legendary', '3,000']] },
  tactical: { title: 'LOADOUT', tabs: ['Rifles', 'Pistols', 'Gear', 'Skins'], currency: 'medal', items: [['Sidearm', 'crosshair', 'common', '500'], ['Helmet', 'hard-hat', 'rare', '1,200'], ['Marksman', 'target', 'epic', '3,500'], ['Drone', 'plane', 'legendary', '9,000'], ['Airstrike', 'bomb', 'mythic', '30K'], ['Ammo', 'package', 'common', '150'], ['Vest', 'shield', 'rare', '2,000'], ['Radio', 'radio', 'legendary', '6,500']] },
  motorsport: { title: 'GARAGE', tabs: ['Cars', 'Wheels', 'Paint', 'Boosts'], currency: 'zap', items: [['Street Kart', 'car', 'common', '500'], ['Turbo', 'gauge', 'rare', '1,800'], ['Tuning Kit', 'wrench', 'epic', '4,500'], ['Gold Cup', 'trophy', 'legendary', '12K'], ['Hyper GT', 'car-front', 'mythic', '50K'], ['Fuel', 'fuel', 'common', '120'], ['Nitro', 'zap', 'rare', '900'], ['Champion', 'flag', 'legendary', '18K']] },
};

/** A direction's sample content (its own, else the pet shop). */
export const sampleOf = (direction: string): SampleContent => SAMPLE_CONTENT[direction] ?? SAMPLE_CONTENT.candy!;

/** The sample is laid out for this screen (a 1366×768 laptop): the stage and the gallery cards show it there. */
export const SAMPLE_DEVICE = 'laptop';

const col = (c: Color): MockColor => (Array.isArray(c) ? [c[0], c[1], c[2]] : c);

/** A text's colour, outline and font from one of the direction's inks. */
function inked(d: Direction, ink: TextInk, display: boolean): Partial<MockNode> {
  const font = ink.font ?? (display ? d.fonts.display : d.fonts.body);
  const weight = ink.weight ?? (display ? d.fonts.weightDisplay : d.fonts.weightBody) ?? 400;
  return {
    textColor: col(ink.color),
    font,
    ...(weight >= 700 ? { bold: true } : {}),
    ...(ink.stroke && (ink.strokePx ?? 0) > 0 ? { stroke: { color: col(ink.stroke), t: 0, px: ink.strokePx!, text: true } } : {}),
  };
}

/** A direction's sample screen, its skins tinted by an accent ("#rrggbb") when one is given. */
export function sampleScreens(directionId: string, accent?: string): MockNode[] {
  const d: Direction | undefined = DIRECTIONS[directionId];
  if (!d) throw new Error(`No art direction "${directionId}" (directions: ${Object.keys(DIRECTIONS).join(', ')})`);
  const t = sampleOf(directionId);
  const id = d.id;
  const tint = accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : null;
  const skin = (spec: string) => `${id}:${spec}${tint ? tint : ''}`;
  const label = (name: string, text: string, size: number, ink: Partial<MockNode>, p: Partial<MockNode> = {}): MockNode => ({ cls: 'TextLabel', name, text, textSize: size, bgT: 1, ...ink, ...p });

  // The shop window on a 1366×768 laptop.
  const W = 960;
  const H = 600;
  const plate = id === 'candy';
  const cards: MockNode[] = t.items.map(([name, glyph, rarity, price], i) => ({
    cls: 'Frame',
    name: `Card${i + 1}`,
    size: [0, 196, 0, 214],
    order: i,
    skin: skin(`card:${rarity}`),
    kids: [
      { cls: 'ImageLabel', name: 'Art', pos: [0.5, 0, 0, 14], anchor: [0.5, 0], size: [0, 96, 0, 96], bgT: 1, skin: skin(`icon:${glyph}:${rarity}`) },
      label('ItemName', name, plate ? 22 : 18, inked(d, inkFor(d, { kind: 'card', variant: rarity as Variant }), true), { pos: [0, 10, 0, 112], size: [1, -20, 0, 26] }),
      {
        cls: 'TextButton',
        name: 'Buy',
        pos: [0.5, 0, 1, -14],
        anchor: [0.5, 1],
        size: [0, 168, 0, 50],
        skin: skin('button:primary'),
        text: `      ${price}`,
        textSize: 22,
        ...inked(d, inkFor(d, { kind: 'button', variant: 'primary' }), true),
        states: { hover: { scale: 1.04 }, press: { scale: 0.95 } },
        kids: [{ cls: 'ImageLabel', name: 'Coin', pos: [0, 16, 0.5, 0], anchor: [0, 0.5], size: [0, 26, 0, 26], bgT: 1, z: 3, skin: skin(`coin:${t.currency}`) }],
      },
      ...(i === 4
        ? [
            {
              cls: 'Frame',
              name: 'New',
              pos: [1, 8, 0, -12],
              anchor: [1, 0],
              size: [0, 54, 0, 54],
              bgT: 1,
              z: 5,
              skin: skin('badge'),
              kids: [label('Tag', 'NEW', 15, inked(d, inkFor(d, { kind: 'badge' }), true), { size: [1, 0, 1, 0], z: 6, rot: -12 })],
            } satisfies MockNode,
          ]
        : []),
    ],
  }));
  const tabs: MockNode[] = t.tabs.map((name, i) => ({
    cls: 'TextButton',
    name: `Tab${i + 1}`,
    size: [0, 150, 0, 48],
    order: i,
    skin: skin(i === 0 ? 'tab:active' : 'tab:inactive'),
    text: name,
    textSize: 20,
    ...inked(d, inkFor(d, { kind: 'tab', variant: i === 0 ? 'active' : 'inactive' }), true),
  }));
  const headerW = plate ? W - 120 : W - 60;
  return [
    {
      name: 'Shop',
      insets: 'CoreUISafeInsets',
      kids: [
        // Over the top bar's strip too (the screen keeps below it), so the game behind dims evenly.
        { cls: 'Frame', name: 'Dim', pos: [0, 0, 0, -58], size: [1, 0, 1, 58], bg: [0, 0, 0], bgT: 0.6 },
        {
          cls: 'Frame',
          name: 'Window',
          pos: [0.5, 0, 0.5, 20],
          anchor: [0.5, 0.5],
          size: [0, W, 0, H],
          skin: skin('window'),
          kids: [
            { cls: 'Frame', name: 'Header', pos: [0.5, 0, 0, plate ? -26 : 14], anchor: [0.5, 0], size: [0, headerW, 0, 78], skin: skin('header') },
            { cls: 'ImageLabel', name: 'Title', pos: [0.5, 0, 0, plate ? -52 : 8], anchor: [0.5, 0], size: [0, 340, 0, plate ? 96 : 82], bgT: 1, z: 4, skin: skin(`title:${t.title}`) },
            { cls: 'ImageButton', name: 'Close', pos: [1, plate ? 18 : -18, 0, plate ? -18 : 22], anchor: [1, 0], size: [0, 58, 0, 58], bgT: 1, z: 5, skin: skin('close'), states: { hover: { scale: 1.06 }, press: { scale: 0.92 } } },
            {
              cls: 'Frame',
              name: 'Balance',
              pos: [0, 30, 0, 26],
              size: [0, 190, 0, 46],
              z: 4,
              skin: skin('pill'),
              kids: [
                { cls: 'ImageLabel', name: 'Coin', pos: [0, -6, 0.5, 0], anchor: [0, 0.5], size: [0, 52, 0, 52], bgT: 1, z: 5, skin: skin(`coin:${t.currency}`) },
                label('Amount', '48,250', 22, inked(d, inkFor(d, { kind: 'pill' }), true), { pos: [0, 56, 0, 0], size: [1, -66, 1, 0], xAlign: 'Left', z: 5 }),
              ],
            },
            { cls: 'Frame', name: 'Tabs', pos: [0.5, 0, 0, 108], anchor: [0.5, 0], size: [1, -80, 0, 52], bgT: 1, list: { dir: 'Horizontal', h: 'Center', v: 'Center', pad: [0, 12] }, kids: tabs },
            {
              cls: 'Frame',
              name: 'Grid',
              pos: [0.5, 0, 0, 176],
              anchor: [0.5, 0],
              size: [0, 4 * 196 + 3 * 18, 0, 2 * 214 + 18],
              bgT: 1,
              grid: { cell: [0, 196, 0, 214], pad: [0, 18, 0, 18], dir: 'Horizontal', h: 'Center', v: 'Top' },
              kids: cards,
            },
          ],
        },
      ],
    },
  ];
}
