import type { MockMotion, MockNode } from '@shared/ui-mockup';

/** What a template is asked for: an art direction, an accent to re-tint it, and the game's own words and numbers. */
export interface TemplateInput {
  direction: string;
  accent?: string;
  content?: Record<string, unknown>;
}

/** A complete screen: its ScreenGuis (mockup format, a layout per device form), its motion, and notes for the builder. */
export interface TemplateOutput {
  screens: MockNode[];
  motion: MockMotion[];
  notes: string[];
}

export interface Template {
  id: string;
  label: string;
  /** What it suits. */
  for: string;
  /** The content keys it reads, in a line ("title, currency {glyph, amount}, tabs [..], items [{name, glyph, rarity, price}]"). */
  contentShape: string;
  build(i: TemplateInput): TemplateOutput;
}
