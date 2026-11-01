import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { suggestionsOf } from '@shared/suggestions';
import { COPILOT_SUGGESTIONS } from '@core/copilots/copilot-roles';
import { kilnBrief, kilnFrom, referenceImage } from '@core/capabilities/kiln-tools';
import { hiddenToolsFor, ROLES } from '@core/agents/roles';
import type { CallerContext } from '@core/capabilities/tool-registry';

describe('suggestion bubbles', () => {
  it('reads plain-string bubbles from before and label/prompt ones, dropping what cannot be a bubble', () => {
    expect(suggestionsOf(['Fix the shop', { label: 'Faster', prompt: 'Make the shop open faster: preload the item cards.' }, { label: 'x'.repeat(70), prompt: 'y' }, { label: 'No prompt' }, 5, null])).toEqual([
      { label: 'Fix the shop', prompt: 'Fix the shop' },
      { label: 'Faster', prompt: 'Make the shop open faster: preload the item cards.' },
      { label: 'No prompt', prompt: 'No prompt' },
    ]);
    expect(suggestionsOf('nope')).toEqual([]);
  });

  it('gives every dock bubble a short label and a fuller, more specific request', () => {
    for (const [dock, list] of Object.entries(COPILOT_SUGGESTIONS)) {
      expect(list.length, dock).toBeGreaterThan(0);
      for (const s of list) {
        expect(s.label.length, s.label).toBeLessThanOrEqual(60);
        expect(s.prompt.length, s.label).toBeGreaterThan(s.label.length * 3);
      }
    }
  });
});

describe('briefing Kiln', () => {
  const caller = (over: Partial<CallerContext>): CallerContext => ({ kind: 'agent', runId: null, taskId: null, role: null, providerId: null, allowedTools: null, ...over });

  it('has Kiln research a specific subject on the web before it builds', () => {
    const b = kilnBrief('A Griever for my maze: scarier, wetter, spikier.', 'the Griever from The Maze Runner films');
    expect(b).toMatch(/^A Griever for my maze: scarier, wetter, spikier\.\n\nResearch first: before the blockout, do your research phase for the Griever from The Maze Runner films/);
    expect(b).toMatch(/reference_images/);
    // No subject named: Kiln still researches when the brief names a specific existing thing.
    expect(kilnBrief('A wooden crate')).toMatch(/If this names a specific existing subject/);
    expect(kilnBrief('Like these', undefined, 2)).toMatch(/The 2 attached images are references: match them/);
    // Then what survives into Roblox, and the craft left to Kiln.
    expect(b).toMatch(/Where it goes: a Roblox game[\s\S]*are your call: do what gets the best result for the goal, not a literal reading/);
  });

  it('says who the request is from', () => {
    expect(kilnFrom(caller({ role: 'modeler' }))).toBe('Shuriken 3D modeler');
    expect(kilnFrom(caller({ kind: 'ui' }))).toBe('Shuriken');
  });

  it('sends the project’s reference images and nothing from outside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-refs-'));
    writeFileSync(join(root, 'griever.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    writeFileSync(join(root, 'notes.txt'), 'x');
    const img = await referenceImage(root, 'griever.png');
    expect(img).toEqual({ name: 'griever.png', dataUrl: `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}` });
    await expect(referenceImage(root, '../elsewhere.png')).rejects.toThrow(/not a file of this project/);
    await expect(referenceImage(root, 'notes.txt')).rejects.toThrow(/not a png/);
  });

  it('lets the modeler brief Kiln as well as the animator', () => {
    expect(hiddenToolsFor(ROLES.modeler!)!.has('kiln_request')).toBe(false);
    expect(hiddenToolsFor(ROLES.modeler!)!.has('kiln_import')).toBe(false);
    expect(hiddenToolsFor(ROLES.animator!)!.has('kiln_request')).toBe(false);
    expect(hiddenToolsFor(ROLES.modeler!)!.has('audio_sfx')).toBe(true);
    expect(hiddenToolsFor(ROLES['level-designer']!)!.has('kiln_request')).toBe(true);
  });
});
