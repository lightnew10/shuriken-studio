import type { MockNode, MockVersion } from '../../src/shared/ui-mockup';

/**
 * A complex HUD and menu in the mockup format (the worked example of skill roblox-ui-design): a sci-fi weapon
 * panel (a slanted, translucent shape with a glowing outline, a big ammo number over the reserve, a missile glyph,
 * a thin energy bar fading out at both ends round a lightning glyph) and a row of four menu buttons (a gradient
 * tinted by each one's colour, a coloured border and bottom lip, outlined text under a glyph, a NEW ribbon,
 * states for hover, press and selected).
 */
const menuButton = (name: string, label: string, glyph: string, color: string, order: number, extra: Partial<MockNode> = {}): MockNode => ({
  name,
  cls: 'ImageButton',
  order,
  size: [0, 168, 0, 150],
  bg: '#ffffff',
  corner: [0, 10],
  gradient: { rot: 90, colors: [
    [0, color],
    [1, '#1c1820'],
  ] },
  stroke: { color, px: 1, pos: 'Inner' },
  states: { hover: { scale: 1.04 }, press: { scale: 0.95 }, selected: { gradient: { rot: 90, colors: [
    [0, '#ffffff'],
    [1, color],
  ] }, stroke: [{ color: '#ffffff', px: 2, pos: 'Inner' }] } },
  kids: [
    { name: 'Lip', cls: 'Frame', anchor: [0, 1], pos: [0, 0, 1, 0], size: [1, 0, 0, 6], bg: color, corners: [
      [0, 0],
      [0, 0],
      [0, 10],
      [0, 10],
    ] },
    { name: 'Icon', cls: 'ImageLabel', anchor: [0.5, 0], pos: [0.5, 0, 0, 18], size: [0, 64, 0, 64], bgT: 1, image: `glyph:${glyph}`, imageColor: '#ffffff' },
    { name: 'Label', cls: 'TextLabel', anchor: [0.5, 1], pos: [0.5, 0, 1, -16], size: [1, -12, 0, 36], bgT: 1, text: label, textSize: 24, font: 'LuckiestGuy', textColor: '#ffffff', stroke: { color: '#1a0f08', px: 3, text: true } },
  ],
  ...extra,
});

export const scifiScreens = (): MockNode[] => [
  {
    name: 'Combat',
    kit: 'hud',
    kids: [
      {
        name: 'Weapon',
        cls: 'Frame',
        anchor: [1, 1],
        pos: [1, -24, 1, -24],
        size: [0, 330, 0, 120],
        bg: '$panel',
        bgT: 0.3,
        shape: { slant: [30, 0], cut: [0, 16, 0, 0] },
        gradient: { rot: 90, transp: [
          [0, 0],
          [1, 0.45],
        ] },
        stroke: [
          { color: '$cyan', px: 7, t: 0.8, z: 0 },
          { color: '$cyan', px: 1.5, pos: 'Inner', z: 1 },
        ],
        kids: [
          { name: 'Ammo', cls: 'TextLabel', anchor: [1, 0], pos: [1, -24, 0, 8], size: [0, 120, 0, 64], bgT: 1, text: '24', textSize: 64, font: 'Michroma', xAlign: 'Right', textColor: '#ffffff', stroke: { color: '$cyan', px: 1, t: 0.5, text: true } },
          { name: 'Reserve', cls: 'TextLabel', anchor: [1, 0], pos: [1, -26, 0, 74], size: [0, 120, 0, 26], bgT: 1, text: '/ 120', textSize: 24, font: 'Michroma', xAlign: 'Right', textColor: '$cyan' },
          { name: 'Missile', cls: 'ImageLabel', pos: [0, 54, 0, 22], size: [0, 76, 0, 76], bgT: 1, image: 'glyph:rocket', imageColor: '$cyan', rot: 45 },
        ],
      },
      {
        name: 'Energy',
        cls: 'Frame',
        anchor: [0.5, 1],
        pos: [0.5, 0, 1, -30],
        size: [0, 420, 0, 4],
        bg: '$cyan',
        gradient: { transp: [
          [0, 1],
          [0.35, 0],
          [0.65, 0],
          [1, 1],
        ] },
        shadow: { color: '$cyan', t: 0.4, blur: 10 },
        kids: [{ name: 'Bolt', cls: 'ImageLabel', anchor: [0.5, 0.5], pos: [0.5, 0, 0.5, 0], size: [0, 34, 0, 34], bgT: 1, image: 'glyph:zap', imageColor: '#ffffff' }],
      },
    ],
    // An upright phone has no room beside the weapon: the bar goes above it.
    forms: { phonePortrait: { set: { Energy: { size: [0, 300, 0, 4], pos: [0.5, 0, 1, -180] } } } },
  },
  {
    name: 'Menu',
    kit: 'ui',
    displayOrder: 10,
    kids: [
      {
        name: 'Row',
        cls: 'Frame',
        anchor: [0.5, 0],
        pos: [0.5, 0, 0, 24],
        size: [0, 720, 0, 150],
        bgT: 1,
        list: { dir: 'Horizontal', h: 'Center', v: 'Top', pad: [0, 16] },
        kids: [
          menuButton('Inventory', 'INVENTORY', 'backpack', '#b07a2a', 1, { badge: { text: 'NEW', style: 'ribbon' } }),
          menuButton('Shop', 'SHOP', 'store', '#d0507a', 2, { badge: { text: '3' } }),
          menuButton('Trade', 'TRADE', 'arrow-left-right', '#3fa860', 3),
          menuButton('Tasks', 'TASKS', 'clipboard-list', '#5a5ad8', 4),
        ],
      },
    ],
    // Upright, the four buttons make a square: two by two.
    forms: { phonePortrait: { set: { Row: { size: [0, 352, 0, 316], list: null, grid: { cell: [0, 168, 0, 150], pad: [0, 16, 0, 16], dir: 'Horizontal', h: 'Center', v: 'Top' } } } } },
  },
];

export const scifiVersion = (): MockVersion => ({
  id: 'A',
  note: 'a sci-fi weapon panel and four menu buttons',
  theme: { panel: '#0a1822', cyan: '#3fe0ff' },
  screens: scifiScreens(),
  motion: [{ play: 'enter', target: 'Menu.Row', from: 'up' }],
  createdAt: '2026-10-02T00:00:00.000Z',
});
