import type { RGB, UiNode } from '@shared/ui-layout';

/**
 * The UI Lab's calibration set: screens built in Studio (through the Lab's own builder, `ui-luau.ts`) and drawn by
 * the Lab, so the two can be compared number for number (every element's box, every text's TextBounds) and pixel
 * for pixel (a screenshot of each visual screen). `tests/e2e/ui-lab-fidelity.e2e.ts` runs it.
 */

/** Faces measured: [family (FontFace family json name), weight]. */
export const CAL_FACES: Array<[string, number]> = [
  ['BuilderSans', 400], ['BuilderSans', 500], ['BuilderSans', 700], ['BuilderSans', 800],
  ['GothamSSm', 400], ['GothamSSm', 500], ['GothamSSm', 700], ['GothamSSm', 900],
  ['SourceSansPro', 300], ['SourceSansPro', 400], ['SourceSansPro', 600], ['SourceSansPro', 700],
  ['Montserrat', 400], ['Montserrat', 700], ['Montserrat', 900],
  ['FredokaOne', 400], ['LuckiestGuy', 400], ['Bangers', 400], ['DenkOne', 400],
  ['Oswald', 400], ['Oswald', 700], ['RobotoCondensed', 400], ['HighwayGothic', 400],
  ['Michroma', 400], ['Jura', 400], ['Sarpanch', 400], ['Sarpanch', 700], ['TitilliumWeb', 400], ['TitilliumWeb', 700], ['Zekton', 400],
  ['RobotoMono', 400], ['Inconsolata', 400], ['PressStart2P', 400],
  ['Roboto', 400], ['Roboto', 700], ['Arimo', 400], ['Arimo', 700], ['LegacyArial', 400], ['Nunito', 400], ['Ubuntu', 400], ['JosefinSans', 400],
  ['Merriweather', 400], ['Fondamento', 400], ['GrenzeGotisch', 400], ['SpecialElite', 400], ['RomanAntique', 400], ['AccanthisADFStd', 400], ['Guru', 400],
  ['PermanentMarker', 400], ['PatrickHand', 400], ['IndieFlower', 400], ['Kalam', 400], ['AmaticSC', 400], ['AmaticSC', 700], ['Creepster', 400], ['ComicNeueAngular', 700],
];

/** Strings: plain words, kerning pairs, a real button label, narrow and wide letters, digits. */
export const CAL_STRINGS = ['Hamburgefonstiv 0123', 'AVAWAY To. Te, Yo LT', 'Buy Golden Sword for 900 coins?', 'iiiii WWWWW 1,250'];
const ALL_SIZES = [12, 18, 24, 36, 60];
const FEW_SIZES = [14, 28, 48];

/** One text to measure: where it is in the measure screen, and what it is. */
export interface CalText {
  path: string;
  family: string;
  weight: number;
  size: number;
  text: string;
  wrapped?: { width: number };
  scaled?: { w: number; h: number };
}

const rgb = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
let ids = 1;
const node = (cls: string, name: string, props: Partial<UiNode> = {}, kids: UiNode[] = []): UiNode => ({ id: ids++, name, cls, ...props, ...(kids.length ? { kids } : {}) });

/**
 * The measure screens (about 200 texts each, so one build or read stays well inside what Studio takes in a call):
 * every face in every string at a few sizes (BuilderSans and Gotham, the faces games use most,
 * at every size), then wrapped texts and TextScaled boxes. Labels are wide boxes at the top left (overlapping does
 * not matter: only TextBounds is read).
 */
export const MEASURE_PER_SCREEN = 200;
export function measureScreens(): { screens: UiNode[]; texts: CalText[] } {
  const texts: CalText[] = [];
  const screens: UiNode[] = [];
  let kids: UiNode[] = [];
  let i = 0;
  const add = (t: Omit<CalText, 'path'>) => {
    if (i % MEASURE_PER_SCREEN === 0) {
      kids = [];
      const screen = node('ScreenGui', `CalMeasure${screens.length + 1}`, { enabled: true, ignoreInset: true, displayOrder: 0 });
      screen.kids = kids;
      screens.push(screen);
    }
    const name = `T${i++}`;
    texts.push({ ...t, path: `${screens[screens.length - 1]!.name}.${name}` });
    const size: UiNode['size'] = t.wrapped ? [0, t.wrapped.width, 0, 400] : t.scaled ? [0, t.scaled.w, 0, t.scaled.h] : [0, 3000, 0, 200];
    kids.push(node('TextLabel', name, { pos: [0, 0, 0, 0], size, text: t.text, font: t.family, weight: t.weight, bold: t.weight >= 600, textSize: t.size, textColor: [255, 255, 255], xAlign: 'Left', yAlign: 'Top', wrapped: !!t.wrapped, scaled: !!t.scaled, bgT: 1 }));
  };
  for (const [family, weight] of CAL_FACES) {
    const sizes = family === 'BuilderSans' || family === 'GothamSSm' ? ALL_SIZES : FEW_SIZES;
    for (const size of sizes) for (const text of CAL_STRINGS) add({ family, weight, size, text });
  }
  const sentence = 'Collect coins to unlock new worlds, then rebirth for a permanent boost to everything.';
  for (const [family, weight] of [['BuilderSans', 400], ['BuilderSans', 700], ['GothamSSm', 500], ['FredokaOne', 400]] as Array<[string, number]>) {
    for (const width of [120, 240, 420]) add({ family, weight, size: 18, text: sentence, wrapped: { width } });
    for (const [w, h] of [[200, 40], [120, 60], [300, 24], [90, 90]] as Array<[number, number]>) add({ family, weight, size: 14, text: 'Claim 1,250', scaled: { w, h } });
  }
  return { screens, texts };
}

/**
 * Texts the font model was NOT fitted on (new strings, new sizes): the out-of-sample check of the TextBounds model,
 * one screen of up to MEASURE_PER_SCREEN labels per call like the measure screens.
 */
export const VERIFY_STRINGS = ['Rebirth x3 — +250% Coins', 'Mythical Dragon Egg', 'Welcome back, Player!', 'QUEST COMPLETE', 'Lv. 87  ·  0:59', 'You have 3 unclaimed rewards', 'WAVE 12/20', 'Claim 1,250 Gems'];
export const VERIFY_FACES: Array<[string, number]> = [['BuilderSans', 400], ['BuilderSans', 700], ['BuilderSans', 800], ['GothamSSm', 500], ['GothamSSm', 700], ['GothamSSm', 900], ['FredokaOne', 400], ['LuckiestGuy', 400], ['SourceSansPro', 600], ['Oswald', 700], ['Michroma', 400], ['Roboto', 400]];
export function verifyScreens(): { screens: UiNode[]; texts: CalText[] } {
  const texts: CalText[] = [];
  const screens: UiNode[] = [];
  let kids: UiNode[] = [];
  let i = 0;
  for (const [family, weight] of VERIFY_FACES)
    for (const size of [15, 22, 30, 44])
      for (const text of VERIFY_STRINGS) {
        if (i % MEASURE_PER_SCREEN === 0) {
          kids = [];
          const s = node('ScreenGui', `CalVerify${screens.length + 1}`, { enabled: true, ignoreInset: true });
          s.kids = kids;
          screens.push(s);
        }
        const name = `V${i++}`;
        texts.push({ family, weight, size, text, path: `${screens[screens.length - 1]!.name}.${name}` });
        kids.push(node('TextLabel', name, { size: [0, 3000, 0, 200], text, font: family, weight, bold: weight >= 600, textSize: size, textColor: [255, 255, 255], xAlign: 'Left', yAlign: 'Top', bgT: 1 }));
      }
  return { screens, texts };
}

/** Probes of what Roblox does with TextScaled (it didn't apply in the first Edit-mode run) and UIGradient.Type. */
export const PROBE_LUAU = `local SG = game:GetService("StarterGui")
local HttpService = game:GetService("HttpService")
local out = {}
local gui = Instance.new("ScreenGui")
gui.Name = "CalProbe"
gui.IgnoreGuiInset = true
gui.Parent = SG
local function label(name, scaledFirst, wrapped)
  local l = Instance.new("TextLabel")
  l.Name = name
  l.Size = UDim2.fromOffset(245, 70)
  l.Text = "CLAIM"
  l.FontFace = Font.new("rbxasset://fonts/families/GothamSSm.json", Enum.FontWeight.Heavy)
  l.TextSize = 14
  if scaledFirst then l.TextScaled = true end
  l.TextWrapped = wrapped
  l.Parent = gui
  return l
end
local a = label("BeforeParent", true, false)
local b = label("AfterParent", false, false)
local c = label("Wrapped", true, true)
task.wait(0.5)
b.TextScaled = true
task.wait(1)
for _, l in { a, b, c } do out[l.Name] = { l.TextBounds.X, l.TextBounds.Y, l.TextFits, l.TextScaled, l.AbsoluteSize.X, l.AbsoluteSize.Y } end
local g = Instance.new("UIGradient")
local okEnum, enumName = pcall(function() return tostring(Enum.UIGradientType) end)
out.gradientEnum = { okEnum, enumName }
local okSet, err = pcall(function() g.Type = Enum.UIGradientType.Radial end)
out.gradientSet = { okSet, tostring(err) }
local items = {}
pcall(function() for _, it in Enum.GradientType:GetEnumItems() do table.insert(items, it.Name) end end)
out.gradientTypes = items
local okRadial, errRadial = pcall(function() g.Type = Enum.GradientType.Radial end)
out.gradientRadial = { okRadial, tostring(errRadial), tostring(g.Type) }
local okRead, val = pcall(function() return tostring(g.Type) end)
out.gradientRead = { okRead, val }
local cam = workspace.CurrentCamera
out.viewport = { cam.ViewportSize.X, cam.ViewportSize.Y }
local ok2, inset = pcall(function() local a2, b2 = game:GetService("GuiService"):GetGuiInset() return { a2.X, a2.Y, b2.X, b2.Y } end)
out.guiInset = if ok2 then inset else nil
gui:Destroy()
return HttpService:JSONEncode(out)`;

// ─── Visual screens: what a game's UI is made of, full screen over an opaque backdrop ─────────────

const BG = rgb('#1b1d24');

function backdrop(): UiNode {
  return node('Frame', 'Backdrop', { pos: [0, 0, 0, 0], size: [1, 0, 1, 0], bg: BG, bgT: 0, z: 0 });
}

/** Type specimen: faces, sizes, colours, outlines, rich text, alignments. */
function specimen(): UiNode {
  const rows: Array<[string, number, number, string, Partial<UiNode>]> = [
    ['BuilderSans', 800, 44, 'LEVEL UP!', { textColor: rgb('#ffd34d'), stroke: { color: [40, 20, 0], t: 0, px: 3, text: true } }],
    ['BuilderSans', 400, 20, 'Buy Golden Sword for 900 coins?', { textColor: [235, 235, 240] }],
    ['GothamSSm', 700, 26, 'Daily Rewards  ·  Day 3', { textColor: rgb('#7fd1ff') }],
    ['FredokaOne', 400, 40, '1,250,000', { textColor: [255, 255, 255], stroke: { color: [0, 0, 0], t: 0, px: 4, text: true } }],
    ['LuckiestGuy', 400, 36, 'VICTORY', { textColor: rgb('#ff5d5d'), strokeT: 0, strokeColor: [60, 0, 0] }],
    ['SourceSansPro', 600, 18, 'Settings  Audio  Controls  Graphics', { textColor: [200, 200, 210] }],
    ['Michroma', 400, 18, 'AMMO 30 / 120', { textColor: rgb('#9effa8') }],
    ['RobotoMono', 400, 18, '00:42.317', { textColor: [255, 255, 255] }],
  ];
  const kids: UiNode[] = [backdrop()];
  rows.forEach(([family, weight, size, text, extra], i) => {
    kids.push(node('TextLabel', `Row${i}`, { pos: [0, 24, 0, 16 + i * 62], size: [0.6, 0, 0, 56], text, font: family, weight, textSize: size, xAlign: 'Left', yAlign: 'Center', bgT: 1, z: 2, ...extra }));
  });
  kids.push(node('TextLabel', 'Rich', { pos: [0.62, 0, 0, 16], size: [0.36, 0, 0, 60], text: 'Earn <b>2x</b> <font color="#ffd34d">coins</font> for <i>10 minutes</i>', rich: true, font: 'BuilderSans', weight: 400, textSize: 20, textColor: [230, 230, 235], xAlign: 'Left', bgT: 1, z: 2 }));
  kids.push(node('TextLabel', 'Wrapped', { pos: [0.62, 0, 0, 90], size: [0.3, 0, 0, 120], text: 'Collect coins to unlock new worlds, then rebirth for a permanent boost to everything.', wrapped: true, font: 'BuilderSans', weight: 500, textSize: 18, textColor: [220, 220, 225], xAlign: 'Left', yAlign: 'Top', bg: [40, 44, 56], bgT: 0, z: 2 }));
  kids.push(node('TextLabel', 'Scaled', { pos: [0.62, 0, 0, 230], size: [0.3, 0, 0, 70], text: 'CLAIM', scaled: true, font: 'GothamSSm', weight: 900, textColor: [255, 255, 255], bg: rgb('#2fbf71'), bgT: 0, corner: [0, 12], z: 2 }));
  kids.push(node('TextLabel', 'Right', { pos: [0.62, 0, 0, 320], size: [0.3, 0, 0, 40], text: 'Aligned right', font: 'BuilderSans', weight: 700, textSize: 22, textColor: [255, 255, 255], xAlign: 'Right', bg: [60, 64, 80], bgT: 0, z: 2 }));
  kids.push(node('TextLabel', 'Truncated', { pos: [0.62, 0, 0, 376], size: [0, 180, 0, 32], text: 'xXDragonSlayer2009Xx_Pro', truncate: true, font: 'BuilderSans', weight: 500, textSize: 20, textColor: [255, 255, 255], bg: [60, 64, 80], bgT: 0, z: 2 }));
  return node('ScreenGui', 'CalSpecimen', { enabled: false, ignoreInset: true, displayOrder: 10 }, kids);
}

/** Boxes: corners, strokes in three positions, gradients, fades, shadows, rotation, borders, transparency. */
function shapes(): UiNode {
  const kids: UiNode[] = [backdrop()];
  const tile = (name: string, col: number, row: number, extra: Partial<UiNode>) =>
    kids.push(node('Frame', name, { pos: [0, 40 + col * 150, 0, 40 + row * 140], size: [0, 110, 0, 90], bg: rgb('#4a7dff'), bgT: 0, z: 2, ...extra }));
  tile('Square', 0, 0, {});
  tile('Round8', 1, 0, { corner: [0, 8] });
  tile('Round24', 2, 0, { corner: [0, 24] });
  tile('Pill', 3, 0, { corner: [1, 0] });
  tile('Corners', 4, 0, { corners: [[0, 30], [0, 0], [0, 30], [0, 0]] });
  tile('StrokeOuter', 0, 1, { corner: [0, 12], stroke: { color: [255, 255, 255], t: 0, px: 3, text: false } });
  tile('StrokeInner', 1, 1, { corner: [0, 12], stroke: { color: [255, 255, 255], t: 0, px: 3, text: false, pos: 'Inner' } });
  tile('StrokeCenter', 2, 1, { corner: [0, 12], stroke: { color: [255, 255, 255], t: 0, px: 6, text: false, pos: 'Center' } });
  tile('Glow', 3, 1, { corner: [0, 12], strokes: [{ color: rgb('#7fd1ff'), t: 0.75, px: 8, text: false, z: 0 }, { color: [255, 255, 255], t: 0, px: 2, text: false, z: 1 }] });
  tile('Border', 4, 1, { border: 3, borderColor: [255, 210, 0] });
  tile('Linear', 0, 2, { bg: [255, 255, 255], gradient: { rot: 0, colors: [[0, 255, 80, 80], [1, 80, 120, 255]] } });
  tile('Diagonal', 1, 2, { bg: [255, 255, 255], corner: [0, 16], gradient: { rot: 45, colors: [[0, 255, 211, 77], [0.5, 255, 120, 40], [1, 120, 20, 160]] } });
  tile('Fade', 2, 2, { gradient: { rot: 90, colors: [[0, 255, 255, 255], [1, 255, 255, 255]], transp: [[0, 0], [1, 1]] } });
  tile('Radial', 3, 2, { bg: [255, 255, 255], corner: [1, 0], gradient: { rot: 0, type: 'Radial', colors: [[0, 255, 255, 255], [1, 30, 60, 160]] } });
  tile('Shadow', 4, 2, { corner: [0, 14], shadow: { color: [0, 0, 0], t: 0.35, blur: 16, offset: [0, 6] } });
  tile('Rot15', 0, 3, { rot: 15, corner: [0, 10] });
  tile('Rot45', 1, 3, { rot: 45 });
  tile('Half', 2, 3, { bgT: 0.5 });
  tile('Clip', 3, 3, { clips: true, corner: [0, 12] });
  kids[kids.length - 1]!.kids = [node('Frame', 'Inside', { pos: [0, 40, 0, 30], size: [0, 120, 0, 90], bg: rgb('#ffd34d'), bgT: 0 })];
  tile('Layered', 4, 3, { bgT: 0.2, corner: [0, 20], stroke: { color: rgb('#ffd34d'), t: 0.2, px: 2, text: false } });
  return node('ScreenGui', 'CalShapes', { enabled: false, ignoreInset: true, displayOrder: 10 }, kids);
}

/** A realistic panel: a shop card window with header, price pill, buttons and outlined numbers. */
function panel(): UiNode {
  const card = (i: number, title: string, price: string, accent: string) =>
    node('Frame', `Card${i}`, { size: [0, 170, 0, 210], bg: [38, 42, 56], bgT: 0, corner: [0, 14], stroke: { color: rgb(accent), t: 0.3, px: 2, text: false }, order: i }, [
      node('Frame', 'Art', { pos: [0.5, 0, 0, 12], anchor: [0.5, 0], size: [0, 120, 0, 90], bg: [255, 255, 255], bgT: 0, corner: [0, 10], gradient: { rot: 90, colors: [[0, ...rgb(accent)], [1, 30, 30, 40]] } }),
      node('TextLabel', 'Title', { pos: [0, 12, 0, 110], size: [1, -24, 0, 26], text: title, font: 'BuilderSans', weight: 700, textSize: 20, textColor: [255, 255, 255], xAlign: 'Left', bgT: 1 }),
      node('TextButton', 'Buy', { pos: [0.5, 0, 1, -12], anchor: [0.5, 1], size: [1, -24, 0, 44], text: price, font: 'BuilderSans', weight: 800, textSize: 20, textColor: [255, 255, 255], bg: [255, 255, 255], bgT: 0, corner: [0, 10], gradient: { rot: 90, colors: [[0, 76, 217, 100], [1, 40, 160, 70]] }, stroke: { color: [20, 90, 40], t: 0, px: 2, text: false } }),
    ]);
  const win = node('Frame', 'Window', { pos: [0.5, 0, 0.5, 0], anchor: [0.5, 0.5], size: [0, 640, 0, 360], bg: [24, 26, 34], bgT: 0, corner: [0, 18], stroke: { color: [90, 96, 120], t: 0, px: 2, text: false }, shadow: { color: [0, 0, 0], t: 0.4, blur: 24, offset: [0, 8] }, z: 2 }, [
    node('TextLabel', 'Header', { pos: [0, 24, 0, 14], size: [0.5, 0, 0, 40], text: 'SHOP', font: 'FredokaOne', weight: 400, textSize: 34, textColor: [255, 255, 255], xAlign: 'Left', bgT: 1, stroke: { color: [0, 0, 0], t: 0, px: 3, text: true } }),
    node('Frame', 'Coins', { pos: [1, -64, 0, 18], anchor: [1, 0], size: [0, 150, 0, 36], bg: [12, 14, 20], bgT: 0.2, corner: [1, 0] }, [
      node('TextLabel', 'Amount', { pos: [0, 12, 0, 0], size: [1, -24, 1, 0], text: '12,480', font: 'GothamSSm', weight: 700, textSize: 20, textColor: rgb('#ffd34d'), xAlign: 'Right', bgT: 1 }),
    ]),
    node('TextButton', 'Close', { pos: [1, -14, 0, 14], anchor: [1, 0], size: [0, 40, 0, 40], text: 'X', font: 'BuilderSans', weight: 800, textSize: 22, textColor: [255, 255, 255], bg: rgb('#e5484d'), bgT: 0, corner: [0, 10] }),
    node('Frame', 'Cards', { pos: [0, 24, 0, 74], size: [1, -48, 1, -98], bgT: 1, list: { dir: 'Horizontal', h: 'Center', v: 'Top', pad: [0, 16] } }, [
      card(1, 'Golden Sword', '900', '#ffd34d'),
      card(2, 'Frost Bow', '1,250', '#7fd1ff'),
      card(3, 'Shadow Blade', '4,999', '#b48cff'),
    ]),
  ]);
  return node('ScreenGui', 'CalPanel', { enabled: false, ignoreInset: true, displayOrder: 10 }, [backdrop(), win]);
}

/** Layouts: list with padding, grid, flex fill, automatic size, a scrolling frame. */
function layouts(): UiNode {
  const chip = (i: number, text: string) => node('TextLabel', `Chip${i}`, { size: [0, 0, 0, 34], auto: 'X', text, font: 'BuilderSans', weight: 500, textSize: 18, textColor: [255, 255, 255], bg: [70, 78, 100], bgT: 0, corner: [1, 0], padding: [[0, 0], [0, 14], [0, 0], [0, 14]], order: i });
  const cell = (i: number) => node('Frame', `Cell${i}`, { bg: i % 2 ? rgb('#4a7dff') : rgb('#2fbf71'), bgT: 0, corner: [0, 8], order: i });
  const kids: UiNode[] = [backdrop(),
    node('Frame', 'Chips', { pos: [0, 30, 0, 30], size: [0.9, 0, 0, 40], bgT: 1, list: { dir: 'Horizontal', h: 'Left', v: 'Center', pad: [0, 10] }, z: 2 }, ['All', 'Weapons', 'Pets', 'Boosts', 'Limited'].map((t, i) => chip(i, t))),
    node('Frame', 'Grid', { pos: [0, 30, 0, 100], size: [0, 360, 0, 250], bg: [30, 33, 44], bgT: 0, padding: [[0, 10], [0, 10], [0, 10], [0, 10]], grid: { cell: [0, 76, 0, 70], pad: [0, 10, 0, 10], dir: 'Horizontal', h: 'Left', v: 'Top' }, z: 2 }, Array.from({ length: 11 }, (_, i) => cell(i))),
    node('Frame', 'Bar', { pos: [0, 420, 0, 100], size: [0, 420, 0, 56], bg: [30, 33, 44], bgT: 0, corner: [0, 12], padding: [[0, 8], [0, 8], [0, 8], [0, 8]], list: { dir: 'Horizontal', h: 'Left', v: 'Center', pad: [0, 8], hFlex: 'Fill' }, z: 2 },
      ['Play', 'Shop', 'Pets', 'Quests'].map((t, i) => node('TextButton', t, { size: [0, 60, 1, 0], text: t, font: 'BuilderSans', weight: 700, textSize: 18, textColor: [255, 255, 255], bg: i === 0 ? rgb('#2fbf71') : [70, 78, 100], bgT: 0, corner: [0, 8], order: i }))),
    node('ScrollingFrame', 'Scroll', { pos: [0, 420, 0, 180], size: [0, 420, 0, 170], bg: [30, 33, 44], bgT: 0, canvas: [0, 0, 0, 480], clips: true, list: { dir: 'Vertical', h: 'Center', v: 'Top', pad: [0, 6] }, z: 2 },
      Array.from({ length: 9 }, (_, i) => node('TextLabel', `Row${i}`, { size: [1, -20, 0, 44], text: `Quest ${i + 1}: defeat ${5 * (i + 1)} slimes`, font: 'BuilderSans', weight: 400, textSize: 17, textColor: [230, 230, 235], xAlign: 'Left', bg: [52, 57, 74], bgT: 0, corner: [0, 6], padding: [[0, 0], [0, 0], [0, 0], [0, 12]], order: i }))),
  ];
  return node('ScreenGui', 'CalLayout', { enabled: false, ignoreInset: true, displayOrder: 10 }, kids);
}

/** The visual screens, in the order they are shown and photographed. */
export function visualScreens(): UiNode[] {
  return [specimen(), shapes(), panel(), layouts()];
}

/** Luau that reads every GuiObject's box (relative to its ScreenGui) and every text's TextBounds, as JSON. */
export function calMeasureLuau(screenNames: string[]): string {
  return `local HttpService = game:GetService("HttpService")
local SG = game:GetService("StarterGui")
local out = { screens = {} }
for _, name in { ${screenNames.map((n) => JSON.stringify(n)).join(', ')} } do
  local gui = SG:FindFirstChild(name)
  if gui then
    local origin = gui.AbsolutePosition
    local boxes, texts = {}, {}
    local function walk(o, path)
      for _, c in o:GetChildren() do
        if c:IsA("GuiObject") then
          local p = path .. "." .. c.Name
          local a = c.AbsolutePosition - origin
          boxes[p] = { a.X, a.Y, c.AbsoluteSize.X, c.AbsoluteSize.Y }
          if c:IsA("TextLabel") or c:IsA("TextButton") or c:IsA("TextBox") then
            texts[p] = { c.TextBounds.X, c.TextBounds.Y, c.TextFits }
          end
          walk(c, p)
        elseif c:IsA("Folder") then
          -- A folder's GUI objects draw relative to the nearest GUI ancestor (a skin's art lives in one).
          walk(c, path .. "." .. c.Name)
        end
      end
    end
    walk(gui, gui.Name)
    out.screens[name] = { w = gui.AbsoluteSize.X, h = gui.AbsoluteSize.Y, x = origin.X, y = origin.Y, boxes = boxes, texts = texts }
  end
end
return HttpService:JSONEncode(out)`;
}

/** Luau that shows one of the screens (or none) and hides the others. */
export function calShowLuau(screenNames: string[], show: string | null): string {
  return `local SG = game:GetService("StarterGui")
for _, name in { ${screenNames.map((n) => JSON.stringify(n)).join(', ')} } do
  local g = SG:FindFirstChild(name)
  if g then g.Enabled = (name == ${JSON.stringify(show ?? '')}) end
end
return "shown"`;
}
