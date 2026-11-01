import { describe, expect, it } from 'vitest';
import { bezier, commas, compileMotion, EASING_DIRECTIONS, EASING_STYLES, robloxEase, runSpring, sampleAt, short, speedFor, tweenAlpha, tweenLength, type LabMotion, type LabNode } from '../src/core/ui/lab/motion-sim';
import { checkFeel, factsOf, feelOf, measureMotion, type MotionFacts } from '../src/core/ui/lab/feel';
import { filmstrip, keyMoments, onionSkin } from '../src/core/ui/lab/filmstrip';
import { luauFeel } from '../src/core/ui/lab/motion-luau';
import { motionOf, resolveVersion, type MockNode } from '../src/shared/ui-mockup';
import type { UiNode } from '../src/shared/ui-layout';

// Motion played offline: TweenService easing, the Motion module's math, sampled screens, pictures and feel rules.

const screen = (kids: MockNode[]): UiNode[] => resolveVersion({ screens: [{ name: 'S', ignoreInset: true, kids }] }, 'phone').screens;
const find = (nodes: LabNode[], path: string): LabNode => {
  const [s, ...rest] = path.split('.');
  let n = nodes.find((x) => x.name === s)!;
  for (const name of rest) n = n.kids!.find((k) => k.name === name)!;
  return n;
};
const WINDOW: MockNode = { name: 'Window', cls: 'Frame', anchor: [0.5, 0.5], pos: [0.5, 0, 0.5, 0], size: [0, 300, 0, 200], bg: '#202830', corner: [0, 12], kids: [{ name: 'Title', cls: 'TextLabel', text: 'Shop', textSize: 24, size: [1, 0, 0, 40], bgT: 1, textColor: '#ffffff' }] };

describe('TweenService easing', () => {
  it('matches the known values', () => {
    expect(robloxEase('Quad', 'Out', 0.5)).toBeCloseTo(0.75, 10);
    expect(robloxEase('Quad', 'In', 0.5)).toBeCloseTo(0.25, 10);
    expect(robloxEase('Linear', 'InOut', 0.3)).toBeCloseTo(0.3, 10);
    expect(robloxEase('Sine', 'Out', 0.5)).toBeCloseTo(Math.SQRT1_2, 10);
    expect(robloxEase('Cubic', 'InOut', 0.25)).toBeCloseTo(0.0625, 10);
    // The pose easings measured in Studio (tests/animation.test.ts), which match TweenService.
    expect(robloxEase('Elastic', 'In', 0.75) * 90).toBeCloseTo(8.0, 1);
    expect(robloxEase('Elastic', 'Out', 0.25) * 90).toBeCloseTo(82.0, 1);
    expect(robloxEase('Bounce', 'In', 0.5) * 90).toBeCloseTo(21.1, 1);
    expect(robloxEase('Bounce', 'Out', 0.25) * 90).toBeCloseTo(42.5, 1);
  });

  it('Back Out overshoots by 10% with the standard constant, Elastic Out by about 37%', () => {
    let back = 0;
    let elastic = 0;
    for (let i = 0; i <= 2000; i++) {
      back = Math.max(back, robloxEase('Back', 'Out', i / 2000));
      elastic = Math.max(elastic, robloxEase('Elastic', 'Out', i / 2000));
    }
    expect(back).toBeCloseTo(1.1, 3);
    expect(elastic).toBeGreaterThan(1.3);
    expect(elastic).toBeLessThan(1.4);
  });

  it('starts at 0 and ends at 1 for every style and direction; InOut is symmetric', () => {
    for (const s of EASING_STYLES)
      for (const d of EASING_DIRECTIONS) {
        expect(robloxEase(s, d, 0), `${s} ${d}`).toBeCloseTo(0, 9);
        expect(robloxEase(s, d, 1), `${s} ${d}`).toBeCloseTo(1, 9);
      }
    for (const s of EASING_STYLES) expect(robloxEase(s, 'InOut', 0.3) + robloxEase(s, 'InOut', 0.7)).toBeCloseTo(1, 9);
  });

  it('plays DelayTime, repeats and Reverses as TweenInfo does', () => {
    const info = { time: 0.5, style: 'Sine' as const, direction: 'InOut' as const, repeat: -1, reverses: true };
    expect(tweenAlpha(info, 0.25)).toBeCloseTo(0.5, 9);
    expect(tweenAlpha(info, 0.5)).toBeCloseTo(1, 9);
    expect(tweenAlpha(info, 1)).toBeCloseTo(0, 9);
    expect(tweenAlpha({ time: 0.2, delay: 0.1 }, 0.05)).toBeNull();
    expect(tweenLength({ time: 0.2, delay: 0.1 })).toBeCloseTo(0.3, 9);
    expect(tweenLength(info)).toBe(Infinity);
  });
});

describe("the Motion module's math", () => {
  it('solves cubic-bezier like CSS', () => {
    expect(bezier(0.42, 0, 0.58, 1)(0.5)).toBeCloseTo(0.5, 6);
    expect(bezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 6);
    expect(bezier(0.2, 0.8, 0.2, 1)(0.25)).toBeGreaterThan(0.7);
  });

  it('springs settle: a press dips without overshoot, a release bounces once and lands', () => {
    const press = runSpring([1], [0.95], { frequency: 9, damping: 1 });
    expect(press.settled).not.toBeNull();
    expect(press.settled! / 60).toBeLessThan(0.2);
    expect(Math.min(...press.frames.map((f) => f[0]!))).toBeGreaterThanOrEqual(0.95 - 1e-4);
    const release = runSpring([0.95], [1], { frequency: 5, damping: 0.45 });
    const peak = Math.max(...release.frames.map((f) => f[0]!));
    expect((peak - 1) / 0.05).toBeGreaterThan(0.15);
    expect((peak - 1) / 0.05).toBeLessThan(0.25);
    expect(release.frames[release.frames.length - 1]![0]).toBe(1);
    // A punch's kick swings out near its peak and comes back exactly to rest.
    const kick = runSpring([1], [1], { frequency: 4, damping: 0.35, v0: [speedFor(0.12, 4, 0.35)] });
    expect(Math.max(...kick.frames.map((f) => f[0]!))).toBeGreaterThan(1.09);
    expect(kick.frames[kick.frames.length - 1]![0]).toBe(1);
  });

  it('formats numbers as Motion.commas and Motion.short do', () => {
    expect(commas(1234567)).toBe('1,234,567');
    expect(commas(-1234.4)).toBe('-1,234');
    expect([short(999), short(1234), short(3400000), short(999999), short(100000)]).toEqual(['999', '1.2K', '3.4M', '999K', '100K']);
  });
});

describe('sampled screens', () => {
  const screens = screen([WINDOW, { name: 'Coins', cls: 'TextLabel', text: '100', textSize: 20, pos: [0, 20, 0, 20], size: [0, 120, 0, 30], bgT: 1 }]);

  it('applies a punch, a count and an entrance at the moment asked', () => {
    const moves: LabMotion[] = [
      { kind: 'punch', target: 'S.Window' },
      { kind: 'count', target: 'S.Coins', from: 100, to: 2500, at: 0.1 },
      { kind: 'enter', target: 'S.Window.Title', from: 'up', delay: 0.05 },
    ];
    const tl = compileMotion(screens, moves);
    const at = (t: number, p: string) => find(tl.sample(t), p);
    expect(at(0, 'S.Window').scale ?? 1).toBe(1);
    expect(at(0.05, 'S.Window').scale!).toBeGreaterThan(1.05);
    expect(at(2, 'S.Window').scale).toBe(1);
    expect(at(0.1, 'S.Coins').text).toBe('100');
    expect(at(0.3, 'S.Coins').text).toMatch(/^\d,\d{3}$/);
    expect(at(2, 'S.Coins').text).toBe('2,500');
    // The title starts 24 points low and invisible, and rises into place.
    expect(at(0, 'S.Window.Title').pos![3]).toBe(24);
    expect(at(0, 'S.Window.Title').textT).toBe(1);
    expect(at(1, 'S.Window.Title').pos![3]).toBeCloseTo(0, 6);
    expect(at(1, 'S.Window.Title').textT).toBeCloseTo(0, 6);
    // The originals are untouched.
    expect(find(screens as LabNode[], 'S.Window').scale).toBeUndefined();
  });

  it('opens and closes a window as Ui.window does, and plays covers and flights', () => {
    const tl = compileMotion(screens, [
      { kind: 'open', target: 'S.Window', at: 0.2, hiddenBefore: true },
      { kind: 'close', target: 'S.Window', at: 1 },
      { kind: 'transition', style: 'fade', at: 2 },
      { kind: 'fly', from: 'S.Window', to: 'S.Coins', at: 3, count: 3 },
    ]);
    expect(find(tl.sample(0.1), 'S.Window').visible).toBe(false);
    expect(find(tl.sample(0.2), 'S.Window').scale).toBeCloseTo(0.92, 6);
    expect(find(tl.sample(0.5), 'S.Window').scale).toBeCloseTo(1, 6);
    expect(find(tl.sample(1.2), 'S.Window').visible).toBe(false);
    expect(tl.sample(2.3).some((s) => s.name.startsWith('MotionTransition'))).toBe(true);
    expect(tl.sample(2.7).some((s) => s.name.startsWith('MotionTransition'))).toBe(false);
    expect(find(tl.sample(3.1), 'MotionLayer').kids?.length).toBe(3);
    expect(tl.spans[2]!.blocks).toEqual([2, 2.6]);
  });

  it('follows Reduce Motion: entrances and punches do nothing, counts land at once', () => {
    const at = (t: number) => sampleAt(screens, [{ kind: 'enter', target: 'S.Window' }, { kind: 'punch', target: 'S.Coins' }, { kind: 'count', target: 'S.Coins', from: 1, to: 9 }], t, { reduced: true });
    const w = find(at(0), 'S.Window');
    expect(w.pos).toEqual([0.5, 0, 0.5, 0]);
    expect(w.bgT ?? 0).toBe(0);
    expect(find(at(0.05), 'S.Coins').scale ?? 1).toBe(1);
    expect(find(at(0), 'S.Coins').text).toBe('9');
  });

  it('fades a CanvasGroup with everything inside, and samples stay independent', () => {
    const tl = compileMotion(screens, [{ kind: 'tween', target: 'S.Window', info: { time: 0.2 }, goal: { GroupTransparency: 1 } }]);
    const mid = tl.sample(0.1);
    expect(find(mid, 'S.Window.Title').textT).toBeGreaterThan(0.5);
    expect(find(mid, 'S.Window').bgT).toBeGreaterThan(0.5);
    expect(find(tl.sample(0), 'S.Window.Title').textT ?? 0).toBe(0);
    expect(find(tl.sample(0.3), 'S.Window.Title').textT).toBeCloseTo(1, 6);
    // Untouched parts are shared, not copied.
    expect(find(tl.sample(0.1), 'S.Coins')).toBe(find(screens as LabNode[], 'S.Coins'));
  });

  it("plays a mockup's moves (its motion list and appear)", () => {
    const v = { screens: [{ name: 'S', ignoreInset: true, kids: [{ ...WINDOW, appear: 'pop' as const }] }], motion: [{ play: 'pulse' as const, target: 'S.Window.Title' }] };
    const tl = compileMotion(resolveVersion(v, 'phone').screens, motionOf(v));
    expect(tl.spans.map((s) => s.kind).sort()).toEqual(['enter', 'pulse']);
    expect(find(tl.sample(0), 'S.Window').scale).toBeCloseTo(0.6, 6);
    expect(tl.spans.find((s) => s.kind === 'pulse')!.loop).toBe(true);
  });
});

describe('pictures', () => {
  const screens = screen([WINDOW]);
  it('a filmstrip is the frames asked for, at the size they add up to', () => {
    const fs = filmstrip(screens, [{ kind: 'open', target: 'S.Window' }], { times: [0, 0.06, 0.18], frameWidth: 200, graphs: false });
    expect(fs.frames).toHaveLength(3);
    const pic = Math.round(fs.region.w * fs.scale);
    expect(fs.image.width).toBe(10 + 3 * (Math.max(200, pic) + 10));
    expect(fs.image.height).toBeGreaterThan(Math.round(fs.region.h * fs.scale));
    expect(fs.image.data.length).toBe(fs.image.width * fs.image.height * 4);
  });

  it('key moments catch the start, the first frame, the overshoot peak and the end', () => {
    const tl = compileMotion(screens, [{ kind: 'open', target: 'S.Window' }]);
    const k = keyMoments(tl);
    expect(k[0]!.t).toBe(0);
    expect(k[1]!.t).toBeCloseTo(1 / 60, 6);
    expect(k.some((f) => f.label.startsWith('peak +10%'))).toBe(true);
    expect(k[k.length - 1]!.t).toBeCloseTo(0.18, 6);
  });

  it('an onion skin traces the path of a slide', () => {
    const on = onionSkin(screens, [{ kind: 'enter', target: 'S.Window', from: 'left', distance: 40 }], { count: 4 });
    const xs = on.path.filter((p): p is [number, number] => !!p).map((p) => p[0]);
    expect(xs[xs.length - 1]! - xs[0]!).toBeCloseTo(40, 0);
    expect(on.image.width).toBeGreaterThan(100);
  });
});

describe('feel', () => {
  it('flags a 1.2 s Linear open and passes the kit’s own open and close', () => {
    const screens = screen([WINDOW]);
    const bad = feelOf(compileMotion(screens, [{ kind: 'tween', target: 'S.Window', intent: 'open', from: { Scale: 0.5 }, goal: { Scale: 1 }, info: { time: 1.2, style: 'Linear', direction: 'In' } }]));
    expect(bad.findings.map((f) => `${f.rule}:${f.severity}`).sort()).toEqual(['linear-move:problem', 'open-slow:problem']);
    expect(bad.report).toContain('PROBLEM');
    const good = feelOf(compileMotion(screens, [{ kind: 'open', target: 'S.Window' }, { kind: 'close', target: 'S.Window', at: 1 }, { kind: 'enter', target: 'S.Window.Title' }]));
    expect(good.findings).toEqual([]);
  });

  it('measures overshoot, swings, speed and unreadable text', () => {
    const screens = screen([WINDOW]);
    const tl = compileMotion(screens, [{ kind: 'open', target: 'S.Window' }, { kind: 'spring', target: 'S.Window', goal: { Scale: 1.2 }, frequency: 4, damping: 0.2, at: 1 }, { kind: 'enter', target: 'S.Window.Title', delay: 0.7, at: 3 }]);
    const [open, spring, enter] = [0, 1, 2].map((i) => measureMotion(tl, i));
    expect(open!.overshootPct).toBeCloseTo(10, 0);
    expect(open!.peakSpeed).toBeGreaterThan(0);
    expect(spring!.swings).toBeGreaterThan(2);
    expect(enter!.unreadable!.seconds).toBeGreaterThan(0.6);
    const rules = checkFeel(factsOf(tl)).map((f) => f.rule);
    expect(rules).toContain('wobble');
    expect(rules).toContain('unreadable');
  });

  it('sees an element pushed past the screen edge while it moves', () => {
    // A UIScale grows about the AnchorPoint: a badge centred 20 points from the edge grows past it.
    const screens = screen([{ name: 'Badge', cls: 'Frame', anchor: [0.5, 0.5], pos: [1, -20, 0, 40], size: [0, 36, 0, 36], bg: '#ff0000' }]);
    const m = measureMotion(compileMotion(screens, [{ kind: 'punch', target: 'S.Badge', amount: 0.3 }]), 0);
    expect(m.offscreenFrames).toBeGreaterThan(0);
  });

  it('reads moves from Luau and judges only what the code states', () => {
    const bad = `local TweenService = game:GetService("TweenService")
local OPEN = TweenInfo.new(1.2, Enum.EasingStyle.Linear)
local function open(grow)
	grow.Scale = 0.5
	TweenService:Create(grow, OPEN, { Scale = 1 }):Play()
end
TweenService:Create(spin, TweenInfo.new(5, Enum.EasingStyle.Linear, Enum.EasingDirection.In, -1), { Rotation = 360 }):Play()`;
    const kit = `local Motion = require(script.Parent.Motion)
local OPEN = TweenInfo.new(0.18, Enum.EasingStyle.Back, Enum.EasingDirection.Out)
local CLOSE = TweenInfo.new(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.In)
local function open() Motion.tween(grow, OPEN, { Scale = 1 }) end
local function close() Motion.tween(grow, CLOSE, { Scale = 0.92 }) end
-- TweenInfo.new(9, Enum.EasingStyle.Linear) in a comment is ignored
b.MouseButton1Down:Connect(function() Motion.spring(press, { Scale = 0.95 }, 9, 1) end)
b.MouseButton1Up:Connect(function() Motion.spring(press, { Scale = 1 }, 5, 0.45) end)`;
    const r = luauFeel([{ path: 'src/Client/UI/Shop.luau', source: bad }]);
    // The open (Linear, 1.2 s, raw) and the spin (a raw loop played and dropped; it rotates without a Reduce Motion path).
    expect(r.findings.map((f) => f.rule).sort()).toEqual(['linear-move', 'loop-unstopped', 'open-slow', 'reduce-motion', 'reduce-motion']);
    expect(r.findings.find((f) => f.rule === 'open-slow')!.line).toBe(5);
    const k = luauFeel([{ path: 'src/Shared/Ui.luau', source: kit }]);
    expect(k.moves.length).toBe(4);
    expect(k.moves.map((m) => m.intent).sort()).toEqual(['close', 'open', 'press', 'release']);
    expect(k.findings).toEqual([]);
  });

  it('keeps every rule quiet on moves it cannot judge', () => {
    const unsure: MotionFacts = { where: 'x', label: 'x', kind: 'raw', intent: 'other', intentSure: false, props: ['BackgroundTransparency'], duration: 2, delay: 0, style: 'Quad', direction: 'Out', loop: false };
    expect(checkFeel([unsure])).toEqual([]);
  });
});
