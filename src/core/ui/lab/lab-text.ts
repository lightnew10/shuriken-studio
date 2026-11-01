import { fontFor } from '../ui-fonts';
import type { FontPicker } from '../ui-render';
import type { TextKit } from './fidelity';
import { robloxFaceFor, robloxMeasure } from './roblox-fonts';

/**
 * Text as Roblox draws it: its own font files from the Studio install (`roblox-fonts.ts`), measured and placed the
 * way TextBounds adds up. Without an install, the stand-ins (and the picture says so).
 */
export const robloxFontPicker: FontPicker = (font, bold, italic, weight) => {
  const face = robloxFaceFor(font, bold, italic, weight);
  if (!face) return fontFor(font, bold, italic);
  return { font: face, standIn: face.exact ? '' : `${face.drawnFamily} ${face.weight} (${face.why})` };
};

export const LAB_KIT: TextKit = { id: 'lab', label: 'UI Lab (Roblox fonts, TextBounds model)', measure: robloxMeasure, fonts: robloxFontPicker };
