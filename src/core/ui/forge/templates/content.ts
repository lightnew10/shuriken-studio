/**
 * What a template shows before the game gives it its own words: a small, believable world per art direction (a pet
 * simulator for candy, an arena for ember, mechs for neon, a fantasy realm for parchment, a hangout for frost, a street
 * racer's garage for motorsport), and
 * readers that take the game's content over it, key by key.
 */

export interface Item {
  name: string;
  glyph: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';
  price?: string;
  /** A stat or a line about it. */
  stat?: string;
  count?: number;
  tag?: string;
}

export interface World {
  currency: { glyph: string; name: string; amount: string };
  premium: { glyph: string; name: string; amount: string };
  shop: { title: string; tabs: string[]; items: Item[]; featured: Item & { blurb: string; was: string; ends: string } };
  inventory: { title: string; items: Item[]; stats: Array<[string, string]> };
  abilities: Array<{ name: string; glyph: string; key: string; cd?: number }>;
  players: string[];
  quests: Array<{ name: string; detail: string; glyph: string; done: number; of: number; reward: string }>;
  game: { name: string; tagline: string };
  npc: { name: string; role: string; glyph: string; line: string; choices: string[] };
  stats: Array<[string, string, string]>;
}

const pets: Item[] = [
  { name: 'Bubbles', glyph: 'fish', rarity: 'common', price: '250', stat: 'x1.2 coins' },
  { name: 'Sky Pup', glyph: 'dog', rarity: 'rare', price: '1,200', stat: 'x1.6 coins' },
  { name: 'Star Cat', glyph: 'cat', rarity: 'epic', price: '4,800', stat: 'x2.4 coins', tag: 'NEW' },
  { name: 'Gold Bunny', glyph: 'rabbit', rarity: 'legendary', price: '12K', stat: 'x4 coins' },
  { name: 'Rainbow Bird', glyph: 'bird', rarity: 'mythic', price: '50K', stat: 'x9 coins' },
  { name: 'Turtle', glyph: 'turtle', rarity: 'common', price: '300', stat: 'x1.3 coins' },
  { name: 'Snail', glyph: 'snail', rarity: 'rare', price: '900', stat: 'x1.5 coins' },
  { name: 'Dragon', glyph: 'flame', rarity: 'mythic', price: '99K', stat: 'x12 coins' },
  { name: 'Bee', glyph: 'bug', rarity: 'common', price: '180', stat: 'x1.1 coins' },
  { name: 'Panda', glyph: 'paw-print', rarity: 'epic', price: '6,500', stat: 'x2.8 coins' },
  { name: 'Owl', glyph: 'feather', rarity: 'rare', price: '1,500', stat: 'x1.7 coins' },
  { name: 'Unicorn', glyph: 'sparkles', rarity: 'legendary', price: '25K', stat: 'x5 coins' },
];

const blades: Item[] = [
  { name: 'Ember Edge', glyph: 'sword', rarity: 'common', price: '400', stat: '+12 ATK' },
  { name: 'Ash Guard', glyph: 'shield', rarity: 'rare', price: '1,500', stat: '+30 DEF' },
  { name: 'Scorch Axe', glyph: 'axe', rarity: 'epic', price: '3,900', stat: '+41 ATK', tag: 'NEW' },
  { name: 'Sunfire', glyph: 'swords', rarity: 'legendary', price: '9,800', stat: '+66 ATK' },
  { name: 'Hellbrand', glyph: 'flame', rarity: 'mythic', price: '25K', stat: '+90 ATK' },
  { name: 'Iron Helm', glyph: 'hard-hat', rarity: 'common', price: '350', stat: '+10 DEF' },
  { name: 'Bloodstone', glyph: 'gem', rarity: 'epic', price: '4,200', stat: '+8% CRIT' },
  { name: 'Crown', glyph: 'crown', rarity: 'legendary', price: '15K', stat: '+20% XP' },
  { name: 'Hammer', glyph: 'hammer', rarity: 'rare', price: '1,100', stat: '+24 ATK' },
  { name: 'Bow', glyph: 'target', rarity: 'common', price: '500', stat: '+14 ATK' },
  { name: 'Skull Mask', glyph: 'skull', rarity: 'epic', price: '5,000', stat: '+15 DEF' },
  { name: 'Phoenix', glyph: 'bird', rarity: 'mythic', price: '40K', stat: 'Revive x1' },
];

const mechs: Item[] = [
  { name: 'Scout', glyph: 'bot', rarity: 'common', price: '500', stat: 'SPD 82' },
  { name: 'Rail Gun', glyph: 'crosshair', rarity: 'rare', price: '2,100', stat: 'DMG 140' },
  { name: 'Plasma', glyph: 'zap', rarity: 'epic', price: '5,400', stat: 'DMG 210', tag: 'NEW' },
  { name: 'Titan', glyph: 'shield', rarity: 'legendary', price: '14K', stat: 'ARM 900' },
  { name: 'Nova Core', glyph: 'atom', rarity: 'mythic', price: '40K', stat: 'PWR x3' },
  { name: 'Thruster', glyph: 'rocket', rarity: 'common', price: '700', stat: 'SPD +20' },
  { name: 'Radar', glyph: 'radar', rarity: 'rare', price: '1,800', stat: 'RNG 300' },
  { name: 'Warp', glyph: 'orbit', rarity: 'mythic', price: '60K', stat: 'Blink' },
  { name: 'Drone', glyph: 'plane', rarity: 'rare', price: '2,600', stat: 'DMG 60' },
  { name: 'Battery', glyph: 'battery-charging', rarity: 'common', price: '400', stat: 'NRG +30' },
  { name: 'Visor', glyph: 'scan-eye', rarity: 'epic', price: '4,900', stat: 'CRIT +12%' },
  { name: 'Sat Link', glyph: 'satellite', rarity: 'legendary', price: '18K', stat: 'Scan map' },
];

const relics: Item[] = [
  { name: 'Longsword', glyph: 'sword', rarity: 'common', price: '120', stat: 'Might 12' },
  { name: 'Elixir', glyph: 'potion', rarity: 'rare', price: '340', stat: 'Heals 60' },
  { name: 'Tome', glyph: 'book', rarity: 'epic', price: '900', stat: 'Wisdom 30', tag: 'NEW' },
  { name: 'Dragon Egg', glyph: 'egg', rarity: 'legendary', price: '2,400', stat: 'Hatches' },
  { name: 'Phoenix', glyph: 'feather', rarity: 'mythic', price: '8,000', stat: 'Rebirth' },
  { name: 'Bow', glyph: 'target', rarity: 'common', price: '150', stat: 'Range 40' },
  { name: 'Amulet', glyph: 'gem', rarity: 'rare', price: '600', stat: 'Luck +5' },
  { name: 'Griffin', glyph: 'bird', rarity: 'legendary', price: '3,100', stat: 'Mount' },
  { name: 'Lantern', glyph: 'lamp', rarity: 'common', price: '90', stat: 'Light' },
  { name: 'Key', glyph: 'key-round', rarity: 'rare', price: '450', stat: 'Opens vaults' },
  { name: 'Crown', glyph: 'crown', rarity: 'epic', price: '1,800', stat: 'Charm 25' },
  { name: 'Wand', glyph: 'wand-sparkles', rarity: 'mythic', price: '9,500', stat: 'Arcane 80' },
];

const fits: Item[] = [
  { name: 'Hoodie', glyph: 'shirt', rarity: 'common', price: '80', stat: 'Top' },
  { name: 'Shades', glyph: 'glasses', rarity: 'rare', price: '150', stat: 'Face' },
  { name: 'Wave', glyph: 'hand', rarity: 'epic', price: '220', stat: 'Emote', tag: 'NEW' },
  { name: 'Aura', glyph: 'sparkles', rarity: 'legendary', price: '480', stat: 'Effect' },
  { name: 'Halo', glyph: 'circle-dashed', rarity: 'mythic', price: '900', stat: 'Head' },
  { name: 'Cap', glyph: 'graduation-cap', rarity: 'common', price: '60', stat: 'Head' },
  { name: 'Boombox', glyph: 'speaker', rarity: 'rare', price: '300', stat: 'Gear' },
  { name: 'VIP', glyph: 'crown', rarity: 'legendary', price: '1,200', stat: 'Pass' },
  { name: 'Skates', glyph: 'footprints', rarity: 'rare', price: '260', stat: 'Gear' },
  { name: 'Camera', glyph: 'camera', rarity: 'common', price: '120', stat: 'Gear' },
  { name: 'Heart Pop', glyph: 'heart', rarity: 'epic', price: '350', stat: 'Emote' },
  { name: 'Rainbow', glyph: 'rainbow', rarity: 'mythic', price: '1,500', stat: 'Trail' },
];

const cars: Item[] = [
  { name: 'Street Kart', glyph: 'car', rarity: 'common', price: '500', stat: 'SPD 120' },
  { name: 'Turbo', glyph: 'gauge', rarity: 'rare', price: '1,800', stat: '+12 HP' },
  { name: 'Tuning Kit', glyph: 'wrench', rarity: 'epic', price: '4,500', stat: '+8% grip', tag: 'NEW' },
  { name: 'Gold Cup', glyph: 'trophy', rarity: 'legendary', price: '12K', stat: 'Trophy' },
  { name: 'Hyper GT', glyph: 'car-front', rarity: 'mythic', price: '50K', stat: 'SPD 340' },
  { name: 'Fuel Can', glyph: 'fuel', rarity: 'common', price: '120', stat: '+20 fuel' },
  { name: 'Nitro', glyph: 'zap', rarity: 'rare', price: '900', stat: 'Boost 3 s' },
  { name: 'Race Flag', glyph: 'flag', rarity: 'legendary', price: '18K', stat: 'Emote' },
  { name: 'Rims', glyph: 'disc-3', rarity: 'rare', price: '1,400', stat: 'Wheels' },
  { name: 'Spoiler', glyph: 'wind', rarity: 'common', price: '350', stat: '+4% grip' },
  { name: 'Paint Job', glyph: 'spray-can', rarity: 'epic', price: '3,200', stat: 'Livery' },
  { name: 'V12', glyph: 'cog', rarity: 'mythic', price: '75K', stat: '+90 HP' },
];

const W: Record<string, World> = {
  motorsport: {
    currency: { glyph: 'cash', name: 'Cash', amount: '48,250' },
    premium: { glyph: 'gem', name: 'Gems', amount: '320' },
    shop: { title: 'GARAGE', tabs: ['Cars', 'Parts', 'Paint', 'Boosts'], items: cars, featured: { name: 'Vortex RS', glyph: 'car-front', rarity: 'legendary', price: '24,000', blurb: 'Top speed 340, drift kit', was: '48,000', ends: '02:14:09' } },
    inventory: { title: 'MY CARS', items: cars, stats: [['Speed', '312'], ['Grip', '88%'], ['Boost', '3.2 s']] },
    abilities: [{ name: 'Nitro', glyph: 'zap', key: 'Q' }, { name: 'Drift', glyph: 'wind', key: 'E', cd: 0.4 }, { name: 'Slipstream', glyph: 'rocket', key: 'R', cd: 0.7 }, { name: 'Reset', glyph: 'refresh-cw', key: 'F' }],
    players: ['DriftKing', 'NitroNova', 'Apex_Ace', 'TurboTam', 'Redline', 'GridGhost', 'Skidmark', 'PolePosition', 'Vroom', 'Chicane'],
    quests: [
      { name: 'Win 3 races', detail: 'Any track', glyph: 'flag', done: 2, of: 3, reward: '800' },
      { name: 'Drift 5 km', detail: 'Mountain Pass', glyph: 'wind', done: 5, of: 5, reward: '1,200' },
      { name: 'Beat the lap record', detail: 'Neon City', glyph: 'timer', done: 0, of: 1, reward: '2,500' },
      { name: 'Use nitro 20 times', detail: 'In races', glyph: 'zap', done: 12, of: 20, reward: '400' },
    ],
    game: { name: 'TURBO RUSH', tagline: 'Street racing' },
    npc: { name: 'Mags', role: 'Crew Chief', glyph: 'wrench', line: 'Your turbo is fitted and the tank is full. The Neon City Grand Prix starts in two minutes.', choices: ['Take me to the grid', 'Tune my car', 'Not yet'] },
    stats: [['Races', '1,284', 'flag'], ['Wins', '412', 'trophy'], ['Best lap', '1:12.4', 'timer'], ['Drift', '96 km', 'wind'], ['Cars', '23', 'car'], ['Hours', '188', 'clock']],
  },
  candy: {
    currency: { glyph: 'star', name: 'Coins', amount: '48,250' },
    premium: { glyph: 'gem', name: 'Gems', amount: '1,240' },
    shop: { title: 'PET SHOP', tabs: ['Pets', 'Eggs', 'Boosts', 'Passes'], items: pets, featured: { name: 'Lucky Unicorn', glyph: 'sparkles', rarity: 'legendary', price: '7,500', blurb: 'x5 coins, rainbow trail', was: '15,000', ends: '02:14:09' } },
    inventory: { title: 'MY PETS', items: pets, stats: [['Coins', 'x4.0'], ['Speed', '+25%'], ['Luck', '+12%']] },
    abilities: [{ name: 'Dash', glyph: 'wind', key: 'Q' }, { name: 'Magnet', glyph: 'magnet', key: 'E', cd: 0.6 }, { name: 'Boost', glyph: 'rocket', key: 'R' }, { name: 'Pet Call', glyph: 'paw-print', key: 'F', cd: 0.3 }],
    players: ['SugarRush', 'PetMaster99', 'Bubblegum', 'CoinKing', 'LuckyLlama', 'xX_Star_Xx', 'Mochi', 'TinyTitan', 'Pudding', 'Sprinkles'],
    quests: [
      { name: 'Hatch 10 eggs', detail: 'Any egg counts', glyph: 'egg', done: 7, of: 10, reward: '500' },
      { name: 'Collect 25K coins', detail: 'In the Candy Kingdom', glyph: 'coins', done: 25000, of: 25000, reward: '1,000' },
      { name: 'Find a legendary pet', detail: 'From the Golden Egg', glyph: 'sparkles', done: 0, of: 1, reward: '2,500' },
      { name: 'Play for 30 minutes', detail: 'Keep playing!', glyph: 'timer', done: 18, of: 30, reward: '300' },
    ],
    game: { name: 'PET PARTY', tagline: 'Collect them all!' },
    npc: { name: 'Professor Pip', role: 'Egg Expert', glyph: 'egg', line: 'Ooh, a Golden Egg! Hatch it at the nest and you might get a legendary friend.', choices: ['Show me the nest!', 'What can hatch?', 'Maybe later'] },
    stats: [['Pets hatched', '1,284', 'egg'], ['Coins earned', '12.4M', 'coins'], ['Rebirths', '37', 'refresh-cw'], ['Time played', '41h', 'clock'], ['Best pet', 'Dragon', 'flame'], ['Friends', '58', 'users']],
  },
  ember: {
    currency: { glyph: 'flame', name: 'Embers', amount: '48,250' },
    premium: { glyph: 'gem', name: 'Blood Gems', amount: '320' },
    shop: { title: 'ARMORY', tabs: ['Blades', 'Armor', 'Relics', 'Skins'], items: blades, featured: { name: 'Dragonfang', glyph: 'swords', rarity: 'mythic', price: '19,900', blurb: '+120 ATK, burn on hit', was: '39,800', ends: '02:14:09' } },
    inventory: { title: 'ARSENAL', items: blades, stats: [['Attack', '248'], ['Defense', '131'], ['Crit', '18%']] },
    abilities: [{ name: 'Slash', glyph: 'sword', key: 'Q' }, { name: 'Block', glyph: 'shield', key: 'E', cd: 0.45 }, { name: 'Dash', glyph: 'wind', key: 'R' }, { name: 'Inferno', glyph: 'flame', key: 'F', cd: 0.8 }],
    players: ['Ashborn', 'KillerQueen', 'RedReaper', 'Vex', 'Nightfall', 'BladeRunner', 'Cinder', 'Wrath', 'Obsidian', 'Kain'],
    quests: [
      { name: 'Win 3 duels', detail: 'In the Pit', glyph: 'swords', done: 2, of: 3, reward: '800' },
      { name: 'Deal 50K damage', detail: 'Any mode', glyph: 'flame', done: 50000, of: 50000, reward: '1,200' },
      { name: 'Get a 5-kill streak', detail: 'Without dying', glyph: 'skull', done: 3, of: 5, reward: '2,000' },
      { name: 'Block 40 hits', detail: 'With any shield', glyph: 'shield', done: 12, of: 40, reward: '400' },
    ],
    game: { name: 'EMBERFALL', tagline: 'Arena of Ash' },
    npc: { name: 'Gorran', role: 'Blacksmith', glyph: 'hammer', line: 'That blade has seen better days. Bring me five ember ores and I will forge it anew.', choices: ['Here are the ores', 'Where do I find ore?', 'Not now'] },
    stats: [['Kills', '3,912', 'skull'], ['Wins', '642', 'trophy'], ['K/D', '2.41', 'crosshair'], ['Best streak', '17', 'flame'], ['Damage', '8.1M', 'swords'], ['Hours', '212', 'clock']],
  },
  neon: {
    currency: { glyph: 'cpu', name: 'Credits', amount: '48,250' },
    premium: { glyph: 'hexagon', name: 'Cores', amount: '75' },
    shop: { title: 'HANGAR', tabs: ['Mechs', 'Weapons', 'Cores', 'Decals'], items: mechs, featured: { name: 'Specter MK-II', glyph: 'bot', rarity: 'legendary', price: '24,000', blurb: 'Stealth frame, cloak 6 s', was: '48,000', ends: '02:14:09' } },
    inventory: { title: 'LOADOUT', items: mechs, stats: [['Power', '1,840'], ['Armor', '920'], ['Speed', '88']] },
    abilities: [{ name: 'Boost', glyph: 'rocket', key: 'Q' }, { name: 'Shield', glyph: 'shield', key: 'E', cd: 0.5 }, { name: 'EMP', glyph: 'zap', key: 'R', cd: 0.75 }, { name: 'Scan', glyph: 'radar', key: 'F' }],
    players: ['N3XUS', 'Glitch', 'Vector_7', 'Cipher', 'Zero', 'Pulse', 'Quark', 'Ion', 'Hex', 'Static'],
    quests: [
      { name: 'Destroy 20 drones', detail: 'Sector 7', glyph: 'crosshair', done: 14, of: 20, reward: '900' },
      { name: 'Capture 3 relays', detail: 'Domination', glyph: 'radio-tower', done: 3, of: 3, reward: '1,500' },
      { name: 'Survive wave 15', detail: 'Horde', glyph: 'shield', done: 9, of: 15, reward: '2,200' },
      { name: 'Travel 10 km', detail: 'Any mech', glyph: 'route', done: 6, of: 10, reward: '350' },
    ],
    game: { name: 'NEON SIEGE', tagline: 'Mech warfare' },
    npc: { name: 'ARIA-7', role: 'Ship AI', glyph: 'bot', line: 'Commander, hostile signatures in Sector 7. Your Specter frame is fueled and ready to launch.', choices: ['Launch now', 'Show me the map', 'Stand by'] },
    stats: [['Kills', '5,207', 'crosshair'], ['Wins', '811', 'trophy'], ['Accuracy', '64%', 'target'], ['Waves', '412', 'shield'], ['Credits', '3.2M', 'cpu'], ['Hours', '188', 'clock']],
  },
  parchment: {
    currency: { glyph: 'crown', name: 'Gold', amount: '48,250' },
    premium: { glyph: 'gem', name: 'Runes', amount: '86' },
    shop: { title: 'Market', tabs: ['Arms', 'Potions', 'Scrolls', 'Mounts'], items: relics, featured: { name: 'Elder Staff', glyph: 'wand-sparkles', rarity: 'legendary', price: '4,800', blurb: 'Arcane +60, mana regen', was: '9,600', ends: '02:14:09' } },
    inventory: { title: 'Satchel', items: relics, stats: [['Might', '84'], ['Wisdom', '120'], ['Luck', '15']] },
    abilities: [{ name: 'Strike', glyph: 'sword', key: 'Q' }, { name: 'Ward', glyph: 'shield', key: 'E', cd: 0.4 }, { name: 'Fireball', glyph: 'flame', key: 'R', cd: 0.7 }, { name: 'Heal', glyph: 'heart', key: 'F' }],
    players: ['Sir Aldric', 'Morgana', 'Elowen', 'Thorne', 'Brannoc', 'Isolde', 'Corvin', 'Rowena', 'Fenwick', 'Mira'],
    quests: [
      { name: 'Slay the Bog Troll', detail: 'Murkwood Marsh', glyph: 'skull', done: 0, of: 1, reward: '600' },
      { name: 'Gather 12 moonherbs', detail: 'By night only', glyph: 'leaf', done: 12, of: 12, reward: '250' },
      { name: 'Deliver the letter', detail: 'To Elder Mira', glyph: 'mail', done: 0, of: 1, reward: '120' },
      { name: 'Clear the crypt', detail: 'Old Barrow', glyph: 'castle', done: 2, of: 5, reward: '1,000' },
    ],
    game: { name: 'Realm of Ash', tagline: 'A tale of the old kingdoms' },
    npc: { name: 'Elder Mira', role: 'Village Sage', glyph: 'book-open', line: 'Traveller, the bridge to Murkwood has fallen. Only the Ferryman knows the old ways now.', choices: ['Where is the Ferryman?', 'Tell me of Murkwood', 'Farewell'] },
    stats: [['Quests', '214', 'scroll-text'], ['Foes slain', '2,880', 'skull'], ['Gold found', '96K', 'crown'], ['Level', '42', 'star'], ['Mounts', '7', 'bird'], ['Hours', '133', 'clock']],
  },
  frost: {
    currency: { glyph: 'star', name: 'Stars', amount: '48,250' },
    premium: { glyph: 'gem', name: 'Gems', amount: '420' },
    shop: { title: 'Store', tabs: ['Featured', 'Avatar', 'Emotes', 'Passes'], items: fits, featured: { name: 'Neon Wings', glyph: 'feather', rarity: 'legendary', price: '650', blurb: 'Glowing wings, 4 colours', was: '1,300', ends: '02:14:09' } },
    inventory: { title: 'Closet', items: fits, stats: [['Items', '64'], ['Outfits', '9'], ['Likes', '1.2K']] },
    abilities: [{ name: 'Wave', glyph: 'hand', key: '1' }, { name: 'Dance', glyph: 'music', key: '2' }, { name: 'Sit', glyph: 'armchair', key: '3' }, { name: 'Photo', glyph: 'camera', key: '4' }],
    players: ['maya.k', 'jayden', 'skylar', 'nova', 'ellie_b', 'theo', 'zara', 'leo.xo', 'ivy', 'kai'],
    quests: [
      { name: 'Visit 3 hangouts', detail: 'Any server', glyph: 'map-pin', done: 2, of: 3, reward: '100' },
      { name: 'Make a friend', detail: 'Send a request', glyph: 'user-plus', done: 1, of: 1, reward: '50' },
      { name: 'Dress up 5 times', detail: 'Change an outfit', glyph: 'shirt', done: 3, of: 5, reward: '80' },
      { name: 'Get 10 likes', detail: 'On your house', glyph: 'heart', done: 4, of: 10, reward: '200' },
    ],
    game: { name: 'Hangout', tagline: 'Chill with friends' },
    npc: { name: 'Riley', role: 'Host', glyph: 'smile', line: 'Hey! Welcome to the rooftop party. Want a quick tour, or jump right in?', choices: ['Give me the tour', 'Jump right in', 'Who are you?'] },
    stats: [['Visits', '1,920', 'map-pin'], ['Friends', '84', 'users'], ['Likes', '12.4K', 'heart'], ['Outfits', '31', 'shirt'], ['Badges', '46', 'award'], ['Hours', '97', 'clock']],
  },
};

/** The world a direction's templates show: its own, or the one its kind of game plays in. */
const WORLD_OF: Record<string, string> = { toybox: 'candy', kawaii: 'candy', aqua: 'candy', pixel: 'candy', forest: 'parchment', royal: 'parchment', grunge: 'ember', tactical: 'ember' };
export const worldOf = (direction: string): World => W[direction] ?? W[WORLD_OF[direction] ?? 'candy'] ?? W.candy!;

/** The game's content over the defaults. */
export class Content {
  constructor(private readonly c: Record<string, unknown> = {}) {}
  str(key: string, def: string): string {
    const v = this.c[key];
    return typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : def;
  }
  num(key: string, def: number): number {
    const v = this.c[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  }
  list<T>(key: string, def: T[], read: (x: Record<string, unknown>, d: T | undefined, i: number) => T): T[] {
    const v = this.c[key];
    if (!Array.isArray(v) || !v.length) return def;
    return v.map((x, i) => read(typeof x === 'object' && x ? (x as Record<string, unknown>) : { name: String(x) }, def[i], i));
  }
  strs(key: string, def: string[]): string[] {
    const v = this.c[key];
    return Array.isArray(v) && v.length ? v.map(String) : def;
  }
  obj(key: string): Record<string, unknown> {
    const v = this.c[key];
    return typeof v === 'object' && v && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }
}

const RAR = new Set(['common', 'rare', 'epic', 'legendary', 'mythic']);

/** An item from the game's content (name, glyph, rarity, price…), filled from a default. */
export function readItem(x: Record<string, unknown>, d: Item | undefined): Item {
  const s = (k: string, def?: string) => (typeof x[k] === 'string' && (x[k] as string).trim() ? (x[k] as string) : typeof x[k] === 'number' ? String(x[k]) : def);
  const rarity = s('rarity', d?.rarity ?? 'common')!;
  return {
    name: s('name', d?.name ?? 'Item')!,
    glyph: s('glyph', d?.glyph ?? 'star')!,
    rarity: (RAR.has(rarity) ? rarity : 'common') as Item['rarity'],
    ...(s('price', d?.price) ? { price: s('price', d?.price)! } : {}),
    ...(s('stat', d?.stat) ? { stat: s('stat', d?.stat)! } : {}),
    ...(typeof x.count === 'number' ? { count: x.count } : d?.count !== undefined ? { count: d.count } : {}),
    ...(s('tag', d?.tag) ? { tag: s('tag', d?.tag)! } : {}),
  };
}

/** A currency ({glyph, amount, name}) from the game's content. */
export function readCurrency(x: Record<string, unknown>, d: World['currency']): World['currency'] {
  return { glyph: typeof x.glyph === 'string' ? x.glyph : d.glyph, name: typeof x.name === 'string' ? x.name : d.name, amount: typeof x.amount === 'string' || typeof x.amount === 'number' ? String(x.amount) : d.amount };
}

/** A shown amount as a number ("1,200" → 1200, "12K" → 12000, "1.5M" → 1500000); NaN when it isn't one. */
export function amountOf(s: string | undefined): number {
  const m = /^\s*([\d.,]+)\s*([KMB])?/i.exec(s ?? '');
  if (!m) return NaN;
  const n = Number(m[1]!.replace(/,/g, ''));
  const k = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
  return n * k;
}
