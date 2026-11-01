import { join } from 'node:path';
import type { UiNode } from '@shared/ui-layout';
import { resolveVersion, type MockVersion } from '@shared/ui-mockup';
import type { RgbaImage } from '../../../modeling/png';
import { projectImages } from '../../ui-pictures';
import type { Backdrop } from '../../ui-render';
import { labDevice, type LabDevice } from '../../lab/devices';
import { formDevice, labView, mockupSubject, type LabSubject } from '../../lab/lab';
import { prepareSkins, skinForgeFor, type SkinForge } from '../resolve';
import type { TemplateOutput } from './types';

/**
 * Seeing a template: its output as a mockup version, laid out per device as the Lab does, every skin forged and worn,
 * drawn with Roblox's fonts and Roblox's own controls over it.
 */

/** A template's output as a mockup version. */
export function asVersion(out: TemplateOutput, note = 'From a screen template'): MockVersion {
  return { id: 'A', note, screens: out.screens, motion: out.motion, createdAt: new Date(0).toISOString() };
}

/** The Lab's subject for a template (screens as designed: skins stand as their plain fills). */
export const templateSubject = (title: string, out: TemplateOutput): LabSubject => mockupSubject({ title }, asVersion(out));

/** The same subject with every skin forged and worn (for pictures). */
export function wornSubject(title: string, out: TemplateOutput, sf: SkinForge = skinForgeFor(null)): LabSubject & { errors: string[] } {
  const v = asVersion(out);
  const errors: string[] = [];
  return {
    title,
    motion: v.motion ?? [],
    errors,
    screensOn: (dev: LabDevice) => {
      const p = prepareSkins(resolveVersion(v, formDevice(dev)).screens as UiNode[], sf);
      for (const e of p.errors) if (!errors.includes(e)) errors.push(e);
      return p.screens;
    },
  };
}

const resourcesDir = (): string => process.env.SHURIKEN_RESOURCES ?? join(process.cwd(), 'resources');

/** A template on a device as a player sees it: forged art, Roblox's fonts, Roblox's controls. */
export function renderTemplate(title: string, out: TemplateOutput, device: string, o: { backdrop?: Backdrop; scale?: number; sf?: SkinForge; roblox?: 'controls' | 'none' } = {}): { image: RgbaImage; errors: string[]; notes: string[] } {
  const dev = labDevice(device);
  if (!dev) throw new Error(`No device "${device}"`);
  const sf = o.sf ?? skinForgeFor(null);
  const subject = wornSubject(title, out, sf);
  const glyphs = projectImages('', resourcesDir());
  const images = (ref: string, px: number): RgbaImage | null => (ref.startsWith('skin:') ? sf.image(ref.slice(5)) : glyphs(ref, px));
  const view = labView(subject, dev, { images, roblox: o.roblox ?? 'controls', ...(o.backdrop ? { backdrop: o.backdrop } : {}), ...(o.scale ? { scale: o.scale } : {}) });
  return { image: view.image, errors: subject.errors, notes: view.notes };
}
