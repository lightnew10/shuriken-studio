import { describe, expect, it } from 'vitest';
import type { UiNode } from '../src/shared/ui-layout';
import { luauLong, uiBuildChunk, uiBuilderModule, uiDataJson, uiDataModule } from '../src/core/ui/lab/ui-luau';
import { MEASURE_PER_SCREEN, measureScreens, visualScreens } from '../src/core/ui/lab/calibration';

const screen: UiNode = {
  id: 1,
  name: 'HUD',
  cls: 'ScreenGui',
  kids: [{ id: 2, name: 'Coins', cls: 'TextLabel', text: 'a ]] b ]=] c', pos: [0, 10, 0, 10], size: [0, 200, 0, 40], bg: [20, 20, 20], loops: 2, states: { hover: { scale: 1.04 } } }],
};

describe('UI Lab builder (nodes → Luau)', () => {
  it('quotes data so no text can close the long string', () => {
    const s = 'x ]] y ]=] z ]==]';
    const q = luauLong(s);
    const eq = /^\[(=*)\[/.exec(q)![1]!;
    expect(q.slice(eq.length + 2, -(eq.length + 2))).toBe(s);
    expect(s.includes(`]${eq}]`)).toBe(false);
  });

  it('carries the nodes as JSON without runtime-only fields', () => {
    const data = JSON.parse(uiDataJson([screen])) as Array<Record<string, unknown>>;
    expect(data[0]!.name).toBe('HUD');
    const coins = (data[0]!.kids as Array<Record<string, unknown>>)[0]!;
    expect(coins.text).toBe('a ]] b ]=] c');
    expect(coins.loops).toBeUndefined();
    expect(coins.id).toBeUndefined();
    expect(uiDataModule([screen])).toContain('JSONDecode');
    expect(uiBuildChunk([screen], 'game:GetService("StarterGui")')).toContain('return "built " .. n');
  });

  it('builds every property the UI capture reads (the builder is the capture inverted)', () => {
    const src = uiBuilderModule();
    // Every UiNode field a capture fills (roblox/ui-capture.ts) or a mockup sets, except what only describes a run.
    const keys = ['enabled', 'ignoreInset', 'insets', 'displayOrder', 'global', 'visible', 'pos', 'size', 'anchor', 'rot', 'z', 'order', 'bg', 'bgT', 'border', 'borderColor', 'clips', 'auto', 'text', 'textColor', 'textT', 'textSize', 'scaled', 'wrapped', 'font', 'bold', 'weight', 'italic', 'xAlign', 'yAlign', 'strokeT', 'strokeColor', 'rich', 'truncate', 'lineHeight', 'image', 'imageColor', 'imageT', 'scaleType', 'slice', 'canvas', 'corner', 'corners', 'stroke', 'strokes', 'gradient', 'shadow', 'padding', 'list', 'grid', 'pages', 'flex', 'aspect', 'sizeMin', 'sizeMax', 'textMin', 'textMax', 'scale', 'fit', 'states'];
    const missing = keys.filter((k) => !new RegExp(`\\bn\\.${k}\\b`).test(src));
    expect(missing).toEqual([]);
    // A state's patch as the Lab draws it (withState): its strokes replace the element's (a selected ring), and the
    // normal look puts them back. Measured in Studio: a forced "selected" paint chip shows its ring.
    const patch = ['bg', 'bgT', 'textColor', 'textT', 'imageColor', 'imageT', 'rot', 'scale', 'skinArt', 'label', 'stroke', 'strokes', 'gradient', 'shadow'];
    expect(patch.filter((k) => !new RegExp(`\\b[pq]\\.${k}\\b`).test(src))).toEqual([]);
    expect(src).toContain('applyStrokes(s.o, s.mods, if p and (p.stroke or p.strokes) then strokeList(p) else strokeList(n))');
  });

  it('has a calibration set of hundreds of texts in Roblox faces and four visual screens', () => {
    const { screens, texts } = measureScreens();
    expect(texts.length).toBeGreaterThan(600);
    expect(screens.reduce((t, s) => t + s.kids!.length, 0)).toBe(texts.length);
    expect(Math.max(...screens.map((s) => s.kids!.length))).toBeLessThanOrEqual(MEASURE_PER_SCREEN);
    const v = visualScreens();
    expect(v.map((s) => s.name)).toEqual(['CalSpecimen', 'CalShapes', 'CalPanel', 'CalLayout']);
    for (const s of [...screens, ...v]) expect(uiBuildChunk([s], 'game:GetService("StarterGui")').length).toBeLessThan(80_000);
  });
});
