import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UiNode } from '../src/shared/ui-layout';
import { applySet, checkVersion, MOCK_DEVICES, resolveVersion, type MockNode } from '../src/shared/ui-mockup';
import { TEMPLATES } from '../src/core/ui/forge/templates/index';
import { formLayout } from '../src/core/ui/forge/templates/forms';
import { LOOK_IDS, lookOf } from '../src/core/ui/forge/templates/look';
import { asVersion, templateSubject } from '../src/core/ui/forge/templates/render';
import { amountOf } from '../src/core/ui/forge/templates/content';
import { parseSkin } from '../src/core/ui/forge/spec';
import { PROP_ALIASES, PROP_NAMES } from '../src/core/ui/forge/props/index';
import { skinForgeFor } from '../src/core/ui/forge/resolve';
import { glyphName, glyphSet } from '../src/core/ui/ui-glyphs';
import { labCheck } from '../src/core/ui/lab/lab';

// Screen templates: one call gives a complete screen in any art direction, laid out for every device form, wearing
// forged art; it must be a valid mockup, every skin must parse, and the UI Lab must find nothing to fix.

const IDS = ['shop', 'inventory', 'collection', 'hud-combat', 'hud-simulator', 'daily-rewards', 'battle-pass', 'round-end', 'quest-log', 'settings', 'leaderboard', 'codes', 'profile', 'title', 'dialogue', 'toasts', 'confirm-dialog'];
const DIRS = LOOK_IDS;
/** The whole template × direction matrix in the Lab takes minutes (skins are forged and worn): one direction per template unless asked. */
const FULL = !!process.env.FORGE_TEMPLATES_FULL;
const skins = skinForgeFor(join(tmpdir(), 'shuriken-forge-templates-test'));

const walk = (n: MockNode, f: (n: MockNode) => void) => {
  f(n);
  for (const k of n.kids ?? []) walk(k, f);
  for (const l of Object.values(n.forms ?? {})) {
    for (const k of l?.kids ?? []) walk(k, f);
    for (const p of Object.values(l?.set ?? {})) if (p && typeof p === 'object') walk(p as MockNode, f);
  }
};

describe('screen templates', () => {
  it('are all there, each saying what it is for and what content it reads', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...IDS].sort());
    for (const t of Object.values(TEMPLATES)) {
      expect(t.label.length, t.id).toBeGreaterThan(2);
      expect(t.for.length, t.id).toBeGreaterThan(30);
      expect(t.contentShape.length, t.id).toBeGreaterThan(4);
    }
    for (const d of ['candy', 'ember', 'neon', 'parchment', 'frost']) expect(DIRS).toContain(d);
  });

  it('build a valid mockup in every direction, laid out on every device, wearing art that parses', () => {
    const glyphs = glyphSet(join(process.cwd(), 'resources'));
    for (const id of IDS)
      for (const direction of DIRS) {
        const out = TEMPLATES[id]!.build({ direction });
        const at = `${id} ${direction}`;
        expect(out.screens.length, at).toBeGreaterThan(0);
        const v = asVersion(out);
        const check = checkVersion(v);
        expect(check.errors, at).toEqual([]);
        // Every skin (and every state's skin) parses, and its glyph exists.
        const specs = new Set<string>();
        for (const s of out.screens)
          walk(s, (n) => {
            if (n.skin) specs.add(n.skin);
            for (const p of Object.values(n.states ?? {})) if (p?.skin) specs.add(p.skin);
          });
        expect(specs.size, at).toBeGreaterThan(5);
        for (const spec of specs) {
          const p = parseSkin(spec);
          expect('error' in p ? p.error : '', `${at}: ${spec}`).toBe('');
          // A glyph is a line-art icon or a prop (a filled object: an egg, a chest).
          if (glyphs && !('error' in p) && p.spec.glyph) expect(!!glyphName(glyphs, p.spec.glyph) || PROP_NAMES.includes(p.spec.glyph) || p.spec.glyph in PROP_ALIASES, `${at}: glyph ${p.spec.glyph}`).toBe(true);
        }
        // Each device gets the layout its form asks for.
        for (const d of MOCK_DEVICES) {
          const r = resolveVersion(v, d);
          expect(r.screens.length, `${at} ${d}`).toBe(out.screens.length);
        }
      }
  });

  it('lay every form out as small changes to one tree where they can (so a designer edits one design)', () => {
    let sets = 0;
    let own = 0;
    for (const id of IDS)
      for (const s of TEMPLATES[id]!.build({ direction: 'candy' }).screens)
        for (const l of Object.values(s.forms ?? {})) {
          if (l?.set) sets++;
          else if (l?.kids) own++;
        }
    expect(sets).toBeGreaterThan(own * 3);
    // A form's changes reproduce its tree exactly.
    const base: MockNode[] = [{ name: 'Window', cls: 'Frame', size: [0, 800, 0, 600], kids: [{ name: 'Title', cls: 'TextLabel', text: 'Shop', textSize: 30 }, { name: 'Grid', cls: 'Frame', grid: { cell: [0, 100, 0, 100], pad: [0, 8, 0, 8], dir: 'Horizontal', h: 'Center', v: 'Top' } }] }];
    const phone: MockNode[] = [{ name: 'Window', cls: 'Frame', size: [0, 700, 0, 330], kids: [{ name: 'Title', cls: 'TextLabel', text: 'Shop', textSize: 20 }, { name: 'Grid', cls: 'Frame', grid: { cell: [0, 80, 0, 80], pad: [0, 6, 0, 6], dir: 'Horizontal', h: 'Center', v: 'Top' } }, { name: 'Hint', cls: 'TextLabel', text: 'Swipe' }] }];
    const layout = formLayout('Shop', base, phone)!;
    expect(layout.set).toBeDefined();
    expect(JSON.stringify(applySet(base, layout.set!, 'Shop', []))).toBe(JSON.stringify(phone));
    // Children in another order can't be reached by changes: the form keeps its own.
    expect(formLayout('Shop', base, [{ ...phone[0]!, kids: [...phone[0]!.kids!].reverse() }])!.kids).toBeDefined();
  });

  it('take the game\'s content and accent', () => {
    const out = TEMPLATES.shop!.build({ direction: 'neon', accent: '#ff3366', content: { title: 'GARAGE', items: [{ name: 'Turbo', glyph: 'rocket', rarity: 'mythic', price: '9K' }], currency: { glyph: 'zap', amount: '1,000' } } });
    const json = JSON.stringify(out.screens);
    expect(json).toContain('neon:title:GARAGE#ff3366');
    expect(json).toContain('"Turbo"');
    expect(json).toContain('neon:coin:zap#ff3366');
    // 9K is more than the 1,000 the player has: the buy button starts disabled.
    const ids: string[] = [];
    for (const s of out.screens) walk(s, (n) => n.name === 'Buy' && n.state === 'disabled' && ids.push(n.name));
    expect(ids.length).toBeGreaterThan(0);
    expect(amountOf('12K')).toBe(12000);
    expect(amountOf('1,250')).toBe(1250);
    expect(lookOf('candy', '#00ff88').skin('button', 'primary', 'hover')).toBe('candy:button:primary:hover#00ff88');
    expect(() => TEMPLATES.shop!.build({ direction: 'nope' })).toThrow(/No art direction/);
  });

  it('keeps clear of Roblox\'s controls and the screen edges: nothing for the Lab to fix on an iPhone SE, a phone, tablet, desktop or TV', { timeout: 900_000 }, () => {
    const runs: Array<[string, string]> = [];
    IDS.forEach((id, i) => (FULL ? DIRS : [DIRS[i % DIRS.length]!]).forEach((d) => runs.push([id, d])));
    const problems: string[] = [];
    for (const [id, direction] of runs) {
      const out = TEMPLATES[id]!.build({ direction });
      const report = labCheck(templateSubject(`${id} ${direction}`, out), { devices: ['phone-small', 'phone', 'tablet', 'desktop', 'tv'], skins });
      for (const f of report.findings) if (f.severity === 'problem') problems.push(`${id} ${direction}: [${f.category}] ${f.path}: ${f.message} (${f.devices.join(', ')})`);
    }
    expect(problems).toEqual([]);
  });

  it('resolves every screen to UiNodes the renderer and the builder take', () => {
    const out = TEMPLATES['hud-combat']!.build({ direction: 'ember' });
    const phone = resolveVersion(asVersion(out), 'phone').screens as UiNode[];
    const hud = phone.find((s) => s.name === 'HUD')!;
    const names = new Set<string>();
    const all = (n: UiNode) => {
      names.add(n.name);
      for (const k of n.kids ?? []) all(k);
    };
    all(hud);
    for (const n of ['Abilities', 'Ability1', 'Ultimate', 'Vitals', 'Health', 'Match', 'KillFeed', 'Minimap']) expect(names.has(n), n).toBe(true);
    // Phones have no key hints (touch), desktops do.
    expect(names.has('KeyHint')).toBe(false);
    const desk = resolveVersion(asVersion(out), 'desktop').screens as UiNode[];
    expect(JSON.stringify(desk)).toContain('"KeyHint"');
  });
});
