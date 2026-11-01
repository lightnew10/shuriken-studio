import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTPUT_SCHEMAS, ROLES, WORKSHOP_TOOLS } from '../src/core/agents/roles';
import { parseReview, registerUiLabReviewTool } from '../src/core/capabilities/ui-lab-review-tool';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { decodePng } from '../src/core/modeling/png';
import type { AgentRunner } from '../src/core/orchestrator/agent-runner';
import type { ProjectContext } from '../src/core/projects/project-service';
import { MockupStore, type VersionInput } from '../src/core/ui/ui-mockups';

// Blind judges named phone defects the Lab's rules passed (tiny grey secondary text, names dropped from phone tiles,
// rows touching, frames against the home indicator, two of six items in view, a badge over a word). ui_lab_review shows
// the version on two phones and the desktop to a fast vision model that did not design it, and reports what it saw.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project() {
  const root = mkdtempSync(join(tmpdir(), 'shuriken-review-'));
  dirs.push(root);
  mkdirSync(join(root, '.shuriken'), { recursive: true });
  const store = new MockupStore(root);
  const shop = (price: string): VersionInput => ({
    note: 'a small shop',
    screens: [
      {
        name: 'Shop',
        kids: [
          {
            cls: 'Frame',
            name: 'Window',
            pos: [0.5, 0, 0.5, 0],
            anchor: [0.5, 0.5],
            size: [0.6, 0, 0.7, 0],
            bg: '#1b2230',
            kids: [
              { cls: 'TextLabel', name: 'Title', pos: [0, 16, 0, 8], size: [1, -32, 0, 32], text: 'SWORD SHOP', textSize: 26 },
              { cls: 'TextLabel', name: 'Price', pos: [0, 16, 0, 52], size: [1, -32, 0, 18], text: price, textSize: 12, textColor: '#7a7f88' },
              { cls: 'TextButton', name: 'Buy', pos: [0.5, 0, 1, -16], anchor: [0.5, 1], size: [0, 160, 0, 44], text: 'BUY', textSize: 22, bg: '#2fbf5a' },
            ],
          },
        ],
      },
    ],
  });
  const made = store.create({ title: 'Sword shop', versions: [shop('250 coins')] });
  expect(made.errors).toEqual([]);
  const ctx = { root, dir: join(root, '.shuriken'), extras: () => ({}) } as unknown as ProjectContext;
  return { root, ctx, store, name: made.mockup!.name, shop };
}

type Def = { name: string; description: string; capability: string; permission: string; handler: (inv: { args: unknown; caller: unknown; signal: AbortSignal }) => Promise<ToolOutput> };

function tool(ctx: ProjectContext | null, runner: Pick<AgentRunner, 'run'> | null) {
  const defs = new Map<string, Def>();
  registerUiLabReviewTool({ register: (d: Def) => defs.set(d.name, d) } as never, { project: () => ctx, runner: () => runner, resourcesDir: null });
  const def = defs.get('ui_lab_review')!;
  const call = (args: Record<string, unknown>, caller: Record<string, unknown> = {}) => def.handler({ args, caller: { kind: 'agent', runId: 'run_t', taskId: null, role: 'copilot-ui', providerId: null, allowedTools: null, ...caller }, signal: new AbortController().signal });
  return { def, call };
}

const text = (o: ToolOutput) => o.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

/** A runner that answers like the fast model, and remembers what it was asked. */
function fakeRunner(answer: () => unknown, ok = true) {
  const seen: Array<{ role: string; images: Array<{ mediaType: string; data: string; caption?: string }>; directive: string }> = [];
  const runner = {
    run: async (spec: { role: { id: string }; images?: Array<{ mediaType: string; data: string; caption?: string }>; directive: string }) => {
      seen.push({ role: spec.role.id, images: spec.images ?? [], directive: spec.directive });
      return { completion: { ok, error: ok ? null : 'usage limit reached' }, structured: answer() };
    },
  } as unknown as Pick<AgentRunner, 'run'>;
  return { runner, seen };
}

const FOUND = {
  verdict: 'fix',
  findings: [
    { severity: 'warning', device: 'small phone', where: "the '250 coins' price", what: 'The price reads tiny and grey under the title.', fix: 'Make it 16 pt and lighter.' },
    { severity: 'problem', device: 'notch phone', where: 'the BUY button', what: 'It sits on the home indicator.', fix: 'Move it 12 pt up.' },
  ],
};

describe('the phone reviewer', () => {
  it('shows the model the two phones and the desktop, and reports its findings with the pictures', async () => {
    const { ctx, name } = project();
    const { runner, seen } = fakeRunner(() => FOUND);
    const { def, call } = tool(ctx, runner);
    expect([def.capability, def.permission]).toEqual(['app.mockups', 'read']);
    expect(def.description.length).toBeLessThanOrEqual(2048);

    // A design turn may call it: it writes nothing.
    const r = await call({ mockup: name }, { drafts: true });
    expect(r.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.role).toBe('ui-phone-reviewer');
    expect(seen[0]!.images).toHaveLength(3);
    const sizes = seen[0]!.images.map((im) => {
      expect(im.mediaType).toBe('image/png');
      const png = decodePng(Buffer.from(im.data, 'base64'));
      return [png.width, png.height] as const;
    });
    // In-hand sharpness: the phones at 2 px per point (667 and 844 points wide), the desktop at half size; none over 1800 px.
    expect(sizes[0]![0]).toBeGreaterThanOrEqual(667 * 2);
    expect(sizes[1]![0]).toBeGreaterThanOrEqual(844 * 2);
    expect(sizes[2]![0]).toBeGreaterThanOrEqual(1920 / 2);
    expect(sizes[2]![0]).toBeLessThan(1920);
    for (const [w, h] of sizes) expect(Math.max(w, h)).toBeLessThanOrEqual(1800);
    expect(seen[0]!.images.map((im) => im.caption)).toEqual([expect.stringMatching(/^Image 1, the small phone/), expect.stringMatching(/^Image 2, the notch phone.*47 points/), expect.stringMatching(/^Image 3, reference only/)]);
    expect(seen[0]!.directive).toMatch(/Image 1.*Image 2.*Image 3/);

    // The findings, in lines an agent acts on, and the three pictures it judged.
    expect(text(r)).toMatch(/Phone review of Sword shop A[^\n]*: FIX, 1 problem, 1 warning/);
    expect(text(r)).toContain("warning [small phone] the '250 coins' price: The price reads tiny and grey under the title. Fix: Make it 16 pt and lighter.");
    expect(text(r)).toContain('PROBLEM [notch phone] the BUY button: It sits on the home indicator. Fix: Move it 12 pt up.');
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(r.data).toEqual({ verdict: 'fix', findings: FOUND.findings });
  }, 60_000);

  it('reviews a version once per session, and a new version again', async () => {
    const { ctx, name, store, shop } = project();
    const { runner, seen } = fakeRunner(() => ({ verdict: 'ready', findings: [] }));
    const { call } = tool(ctx, runner);
    const first = await call({ mockup: name });
    expect(text(first)).toMatch(/READY, 0 problems, 0 warnings/);
    expect((first.data as { verdict: string }).verdict).toBe('ready');
    // The same version again (and at the same moment): no second run, the same review and pictures.
    const [again, twice] = await Promise.all([call({ mockup: name }), call({ mockup: name, version: 'a' })]);
    expect(seen).toHaveLength(1);
    expect(text(again)).toMatch(/the same version as before/);
    expect(again.content.filter((c) => c.type === 'image')).toHaveLength(3);
    expect(twice.data).toEqual(first.data);
    // A new version is a new review; asking for the old one by its letter still finds the old review.
    expect(store.addVersions(name, [shop('999 coins')]).errors).toEqual([]);
    await call({ mockup: name });
    expect(seen).toHaveLength(2);
    await call({ mockup: name, version: 'A' });
    expect(seen).toHaveLength(2);
  }, 60_000);

  it('says it is unavailable, without failing, when there is no model to ask or no answer', async () => {
    const { ctx, name } = project();
    // No runner (tests, smoke runs, safe mode).
    const none = await tool(ctx, null).call({ mockup: name });
    expect(none.isError).toBeFalsy();
    expect(text(none)).toMatch(/phone reviewer is unavailable.*rely on ui_lab_check/);
    expect(none.data).toMatchObject({ verdict: null, findings: [], unavailable: true });
    // A failed run (a usage limit), no structured answer, a runner that throws (no provider).
    const limited = await tool(ctx, fakeRunner(() => null, false).runner).call({ mockup: name });
    expect(text(limited)).toMatch(/unavailable \(usage limit reached\): rely on ui_lab_check/);
    const empty = await tool(ctx, fakeRunner(() => null).runner).call({ mockup: name });
    expect(text(empty)).toMatch(/unavailable \(it gave no review\)/);
    const throwing = { run: async () => Promise.reject(new Error('no provider for role ui-phone-reviewer')) } as unknown as Pick<AgentRunner, 'run'>;
    const thrown = await tool(ctx, throwing).call({ mockup: name });
    expect(thrown.isError).toBeFalsy();
    expect(text(thrown)).toMatch(/unavailable \(no provider for role ui-phone-reviewer\)/);
    // Nothing was remembered from the runs that gave no review.
    const after = tool(ctx, fakeRunner(() => FOUND).runner);
    expect((await after.call({ mockup: name })).data).toMatchObject({ verdict: 'fix' });
    // What it can't find is an error, as in ui_lab_check.
    expect((await tool(null, null).call({ mockup: name })).isError).toBe(true);
    expect(text(await tool(ctx, null).call({ mockup: 'nope' }))).toMatch(/No mockup "nope"/);
    expect(text(await tool(ctx, null).call({ mockup: name, version: 'Q' }))).toMatch(/has no version Q \(versions: A\)/);
  }, 60_000);

  it('keeps only what the schema allows: at most 8 findings, and a problem is never ready', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ severity: i === 3 ? 'problem' : 'odd', device: i % 2 ? 'notch phone' : 'small phone', where: `tile ${i}`, what: `defect ${i}`, fix: 'x' }));
    const r = parseReview({ verdict: 'ready', findings: [...many, { severity: 'warning', where: 'x', what: '' }] })!;
    expect(r.findings).toHaveLength(8);
    expect(r.verdict).toBe('fix');
    expect(r.findings[0]).toEqual({ severity: 'warning', device: 'small phone', where: 'tile 0', what: 'defect 0', fix: 'x' });
    expect(r.findings[1]!.device).toBe('notch phone');
    expect(parseReview({ verdict: 'ready', findings: [] })).toEqual({ verdict: 'ready', findings: [] });
    expect(parseReview({ verdict: 'fix' })).toBeNull();
    expect(parseReview(null)).toBeNull();
  });

  it('is a small role on the fast model with no tools, and a UI workshop tool', () => {
    const role = ROLES['ui-phone-reviewer']!;
    expect([role.model, role.tier, role.builtinTools, role.appTools, role.output]).toEqual(['fast', 'chat', [], [], 'phone_review']);
    expect(role.instructions).toMatch(/30 cm/);
    expect(role.instructions).toMatch(/Nothing about taste/);
    expect(OUTPUT_SCHEMAS.phone_review).toMatchObject({ required: ['verdict', 'findings'] });
    expect(WORKSHOP_TOOLS.ui).toContain('ui_lab_review');
  });
});
