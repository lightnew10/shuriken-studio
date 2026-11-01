import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UiNode } from '../src/shared/ui-layout';
import { roleFor } from '../src/core/agents/roles';
import { compactSchema } from '../src/core/capabilities/app-tools';
import type { ToolOutput } from '../src/core/capabilities/tool-registry';
import { DEFAULT_ESCALATION, decideFileWrite, decideShell } from '../src/core/permissions/policy';
import { SCRATCH_REL } from '../src/core/permissions/scratch';
import { drivePath } from '../src/core/permissions/shell-safety';
import { LuauToolchain } from '../src/core/roblox/luau-toolchain';
import { fillStudioArgs, needsStudioMode } from '../src/core/roblox/studio-call-args';
import { MAX_NODES, UI_PAGE, readUi, uiCaptureLuau, uiCapturePageLuau, type UiReader } from '../src/core/roblox/ui-capture';
import { coreHarness } from './helpers/make-core';
import { attachSim } from './helpers/studio-sim';

/** The small things the user's 8-hour build tripped over (finding 12). */
const makeCore = coreHarness();
const text = (r: ToolOutput) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const win = process.platform === 'win32';

describe('paths the shell gate reads', () => {
  it("reads Git Bash's /c/…, WSL's /mnt/c/… and Cygwin's /cygdrive/c/… as drive C, and leaves the rest alone", () => {
    expect(drivePath('/c/Users/me/Projects/game', 'win32')).toBe('C:\\Users/me/Projects/game');
    expect(drivePath('/mnt/c/Users/me', 'win32')).toBe('C:\\Users/me');
    expect(drivePath('/cygdrive/d/work', 'win32')).toBe('D:\\work');
    expect(drivePath('/c', 'win32')).toBe('C:\\');
    expect(drivePath('/c/', 'win32')).toBe('C:\\');
    for (const same of ['C:/Users\\me/Projects', 'src/Server', '../x', '/tmp/x', '/Users/me', '//server/share/x', '.shuriken/scratch']) expect(drivePath(same, 'win32')).toBe(same);
    // Another platform's /c/ is a folder named c.
    expect(drivePath('/c/Users/me', 'linux')).toBe('/c/Users/me');
  });

  it.skipIf(!win)('lets an autonomous run delete inside the project by any of those spellings, and still refuses outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'shuriken-paths-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'shuriken-paths-data-'));
    const auto = (cmd: string) => decideShell(cmd, DEFAULT_ESCALATION, { mode: 'autonomous', roots: [root, dataDir], cwd: root });
    const drive = root[0]!.toLowerCase();
    const tail = root.slice(2).replace(/\\/g, '/');
    const forms = { bash: `/${drive}${tail}`, wsl: `/mnt/${drive}${tail}`, cygwin: `/cygdrive/${drive}${tail}`, mixed: `${root[0]}:${tail.replace(/\//g, (_m, i: number) => (i % 2 ? '\\' : '/'))}`, forward: `${root[0]}:${tail}` };
    for (const [name, p] of Object.entries(forms)) {
      const d = auto(`rm -rf "${p}/.shuriken/tmp_tex"`);
      expect(d.outcome, `${name}: ${d.reason}`).toBe('allow');
      expect(d.autoApproved).toBe(true);
    }
    // The command of the logged build, as it was typed.
    expect(auto(`cd "${forms.bash}" && rm -rf build .shuriken/tmp_tex`).outcome).toBe('allow');
    expect(auto(`git -C "${forms.bash}" clean -fd`).outcome).toBe('allow');
    // Outside the project it is refused, whatever the spelling, and the reason names the real folder.
    for (const p of [`/${drive}/Windows/Temp/x`, `/mnt/${drive}/Users`, `${forms.bash}/../other`]) {
      const d = auto(`rm -rf "${p}"`);
      expect(d.outcome, p).toBe('deny');
      expect(d.reason).toMatch(/outside the project/);
      expect(d.reason).not.toMatch(new RegExp(`${drive.toUpperCase()}:\\\\${drive}\\\\`));
    }
    // The project folder itself and git's data stay protected.
    expect(auto(`rm -rf "${forms.bash}"`).outcome).toBe('deny');
    expect(auto(`rm -rf "${forms.bash}/.git"`).outcome).toBe('deny');
  });
});

describe('the scratch folder', () => {
  it('exists in every project, is ignored by its git, and agents are told about it', async () => {
    const { ctx, root } = await makeCore({ respond: async () => null });
    expect(existsSync(join(root, SCRATCH_REL))).toBe(true);
    expect(ctx.dir).toBe(join(root, '.shuriken'));
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.shuriken/scratch/');
    const { ROLES } = await import('../src/core/agents/roles');
    for (const role of ['roblox-engineer', 'modeler', 'sound-designer']) {
      expect(ROLES[role]!.instructions.replace(/\s+/g, ' ')).toMatch(/Scratch files \(throwaway scripts, intermediate images and data\) go in \.shuriken\/scratch\/ inside the project: write and delete there freely/);
    }
  });

  it('agents may write and delete there; a write to the system Temp folder is refused with where to write instead', async () => {
    const { root } = await makeCore({ respond: async () => null });
    expect(decideFileWrite(join(root, SCRATCH_REL, 'seam.py'), [root]).outcome).toBe('allow');
    const temp = decideFileWrite(join(tmpdir(), '..', 'seam.py'), [root]);
    expect(temp.outcome).toBe('deny');
    expect(temp.reason).toMatch(/Write outside the project workspace is not permitted: .*seam\.py\. Scratch files .* go in \.shuriken\/scratch\/ inside the project: write and delete there freely/);
    const auto = (cmd: string) => decideShell(cmd, DEFAULT_ESCALATION, { mode: 'autonomous', roots: [root], cwd: root });
    mkdirSync(join(root, SCRATCH_REL, 'tmp_tex'), { recursive: true });
    expect(auto('rm -rf .shuriken/scratch/tmp_tex').outcome).toBe('allow');
    expect(auto('rm -rf .shuriken/scratch').outcome).toBe('allow');
    expect(auto('Remove-Item -Recurse -Force .shuriken\\scratch\\tmp_tex').outcome).toBe('allow');
    // The app's own data beside it stays out of reach.
    expect(auto('rm -rf .shuriken').outcome).toBe('deny');
    expect(decideFileWrite(join(root, '.shuriken', 'project.db'), [root]).outcome).toBe('deny');
  });
});

const ENUM_KEYS = ['None', 'Backspace', 'Tab', ...Array.from({ length: 240 }, (_, i) => `Key${i}`)];
const KEYBOARD = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['keyDown', 'keyUp', 'keyPress', 'textInput', 'wait'] }, key_code: { type: 'string', enum: ENUM_KEYS }, wait_time_ms: { type: 'number' }, instance_path: { type: 'string' } } },
    },
    datamodel_type: { type: 'string', enum: ['Client'] },
    studio_id: { type: 'string' },
  },
  required: ['actions', 'datamodel_type', 'studio_id'],
};
const SEARCH = { type: 'object', properties: { path: { type: 'string' }, datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] } }, required: ['datamodel_type'] };

describe('roblox_call fills in what the call plainly meant', () => {
  it('the DataModel an input tool works in, and a wait under the name Studio wants: the calls of the logged build', () => {
    // 07:11:40 — steps, key, seconds, no datamodel_type.
    const a = fillStudioArgs({ steps: [{ action: 'keyDown', key: 'W' }, { action: 'wait', seconds: 1.5 }, { action: 'keyUp', key: 'W' }] }, KEYBOARD, null);
    expect(a.args).toEqual({ actions: [{ action: 'keyDown', key_code: 'W' }, { action: 'wait', wait_time_ms: 1500 }, { action: 'keyUp', key_code: 'W' }], datamodel_type: 'Client' });
    expect(a.notes).toEqual(['"steps" → "actions"', '"key" → "key_code" in the steps', 'a wait\'s length → "wait_time_ms" in milliseconds', 'datamodel_type "Client" (the only one this tool works in)']);
    // 10:26:48 — "duration", already with datamodel_type.
    expect(fillStudioArgs({ datamodel_type: 'Client', actions: [{ action: 'wait', duration: 2 }] }, KEYBOARD, null).args).toEqual({ datamodel_type: 'Client', actions: [{ action: 'wait', wait_time_ms: 2000 }] });
    // 10:26:45 — steps with "type".
    expect(fillStudioArgs({ steps: [{ type: 'keyDown', key: 'W' }, { type: 'wait', seconds: 2 }] }, KEYBOARD, null).args.actions).toEqual([{ action: 'keyDown', key_code: 'W' }, { action: 'wait', wait_time_ms: 2000 }]);
    // 07:24:54 and 12:57:56 — one key at the top level.
    expect(fillStudioArgs({ key: 'LeftShift' }, KEYBOARD, null).args).toEqual({ actions: [{ action: 'keyPress', key_code: 'LeftShift' }], datamodel_type: 'Client' });
    expect(fillStudioArgs({ key: 'Return', action: 'press' }, KEYBOARD, null).args.actions).toEqual([{ action: 'keyPress', key_code: 'Return' }]);
    // Milliseconds stay milliseconds; a wait longer than Studio takes is cut, and said.
    const long = fillStudioArgs({ actions: [{ action: 'wait', ms: 300 }, { action: 'wait', seconds: 15 }] }, KEYBOARD, null);
    expect(long.args.actions).toEqual([{ action: 'wait', wait_time_ms: 300 }, { action: 'wait', wait_time_ms: 10000 }]);
    expect(long.notes.join(' ')).toMatch(/at most 10000/);
  });

  it("takes a tool's DataModel from Studio's mode when it works in several, and touches nothing that is already right or that it doesn't know", () => {
    expect(needsStudioMode({}, SEARCH)).toBe(true);
    expect(needsStudioMode({}, KEYBOARD)).toBe(false);
    expect(needsStudioMode({ datamodel_type: 'Edit' }, SEARCH)).toBe(false);
    expect(fillStudioArgs({ path: 'Workspace' }, SEARCH, ['Edit']).args).toEqual({ path: 'Workspace', datamodel_type: 'Edit' });
    expect(fillStudioArgs({ path: 'Workspace' }, SEARCH, ['Client', 'Server'])).toMatchObject({ args: { datamodel_type: 'Server' }, notes: ['datamodel_type "Server" (Studio\'s current mode)'] });
    expect(fillStudioArgs({ path: 'Workspace' }, SEARCH, null)).toEqual({ args: { path: 'Workspace' }, notes: [] });
    const right = { datamodel_type: 'Client', actions: [{ action: 'wait', wait_time_ms: 200 }] };
    expect(fillStudioArgs(right, KEYBOARD, null)).toEqual({ args: right, notes: [] });
    expect(fillStudioArgs({ assetId: 1 }, undefined, ['Edit'])).toEqual({ args: { assetId: 1 }, notes: [] });
    expect(fillStudioArgs({ steps: [1] }, { type: 'object', properties: { query: { type: 'string' } } }, ['Edit'])).toEqual({ args: { steps: [1] }, notes: [] });
  });

  it('through the tool: Studio gets the completed call, and the result says what was filled in', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const sim = attachSim(core);
    sim.mode = 'Play';
    core.lease.tryAcquire('run_me');
    core.capabilities.upsert({ id: 'roblox.user_keyboard_input', integration: 'roblox-studio', name: 'user_keyboard_input', status: 'healthy', schema: KEYBOARD });
    const agent = { kind: 'agent' as const, runId: 'run_me', taskId: null, role: 'qa-engineer', providerId: null, allowedTools: null };
    const r = await core.tools.invoke('roblox_call', { tool: 'user_keyboard_input', args: { steps: [{ action: 'keyDown', key: 'W' }, { action: 'wait', seconds: 1.5 }, { action: 'keyUp', key: 'W' }] } }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    const sent = sim.calls.find((c) => c.tool === 'user_keyboard_input')!;
    expect(sent.args).toMatchObject({ datamodel_type: 'Client', actions: [{ action: 'keyDown', key_code: 'W' }, { action: 'wait', wait_time_ms: 1500 }, { action: 'keyUp', key_code: 'W' }] });
    expect(sent.args).not.toHaveProperty('steps');
    expect(text(r)).toMatch(/Filled in for you: "steps" → "actions"; .*datamodel_type "Client" \(the only one this tool works in\)\. Pass them this way next time\./);
  });

  // A critic asked to prove a double jump tried VirtualInputManager in a probe, was refused, and reported it couldn't press keys.
  it('roblox_input: a reviewer presses keys in its own playtest, and is told to start one when none runs', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const sim = attachSim(core);
    core.capabilities.upsert({ id: 'roblox.user_keyboard_input', integration: 'roblox-studio', name: 'user_keyboard_input', status: 'healthy', schema: KEYBOARD });
    const critic = { kind: 'agent' as const, runId: 'run_critic', taskId: null, role: 'critic', providerId: null, allowedTools: new Set(roleFor('critic').appTools) };
    expect(roleFor('critic').appTools).toContain('roblox_input');
    expect(roleFor('critic').appTools).not.toContain('roblox_call');
    const none = await core.tools.invoke('roblox_input', { device: 'keyboard', actions: [{ action: 'keyPress', key: 'Space' }] }, critic);
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/No playtest is running.*roblox_playtest action "start"/);
    expect(sim.calls.some((c) => c.tool === 'user_keyboard_input')).toBe(false);
    sim.mode = 'Play';
    core.lease.tryAcquire('run_critic');
    const r = await core.tools.invoke('roblox_input', { device: 'keyboard', actions: [{ action: 'keyPress', key: 'Space' }, { action: 'wait', seconds: 0.2 }, { action: 'keyPress', key: 'Space' }] }, critic);
    expect(r.isError, text(r)).toBeFalsy();
    expect(sim.calls.find((c) => c.tool === 'user_keyboard_input')!.args).toMatchObject({ datamodel_type: 'Client', actions: [{ action: 'keyPress', key_code: 'Space' }, { action: 'wait', wait_time_ms: 200 }, { action: 'keyPress', key_code: 'Space' }] });
    expect(text(r)).toMatch(/Filled in for you: "key" → "key_code" in the steps/);
    await core.tools.invoke('roblox_input', { device: 'mouse', actions: [{ action: 'moveTo', x: 10, y: 20 }, { action: 'mouseButtonClick', mouse_button: 'left' }] }, critic);
    expect(sim.calls.some((c) => c.tool === 'user_mouse_input')).toBe(true);
  });

  it('the schema hint of a rejected call still shows the arguments after a long list of allowed values', () => {
    const hint = compactSchema(KEYBOARD);
    expect(hint).toContain('"… 235 more"');
    expect(hint).toContain('"datamodel_type":{"type":"string","enum":["Client"]}');
    expect(hint).toContain('wait_time_ms');
    expect(hint.length).toBeLessThan(900);
  });
});

/** A playing client's PlayerGui for readUi: the paged program's walk, mirrored (depth first, ids in that order). */
class FakeGui implements UiReader {
  calls: Array<{ from: number; budget: number }> = [];
  /** Studio cuts an answer at this many characters. */
  cutAt = 100_000;
  /** Grows by one screen after this many pages (scripts still building the UI). */
  growAfter: number | null = null;
  fail: string | null = null;

  constructor(public screens: UiNode[]) {}

  private flat(): Array<UiNode & { parent: number }> {
    const out: Array<UiNode & { parent: number }> = [];
    let id = 0;
    const walk = (n: UiNode, parent: number) => {
      const { kids, ...own } = n;
      const mine = ++id;
      out.push({ ...own, id: mine, parent } as UiNode & { parent: number });
      for (const k of kids ?? []) walk(k, mine);
    };
    for (const s of this.screens) walk(s, 0);
    return out;
  }

  async runLuau(code: string): Promise<{ ok: boolean; output: string }> {
    if (this.fail) return { ok: false, output: this.fail };
    const from = Number(/local FROM, BUDGET = (\d+), (\d+)/.exec(code)![1]);
    const budget = Number(/local FROM, BUDGET = (\d+), (\d+)/.exec(code)![2]);
    this.calls.push({ from, budget });
    if (this.growAfter !== null && this.calls.length === this.growAfter + 1) this.screens = [...this.screens, { id: 0, name: 'Late', cls: 'ScreenGui' } as UiNode];
    const all = this.flat();
    const nodes: typeof all = [];
    let size = 0;
    let next = -1;
    for (const n of all) {
      if (n.id <= from) continue;
      const chars = JSON.stringify(n).length + 1;
      if (nodes.length && size + chars > budget) {
        next = n.id - 1;
        break;
      }
      nodes.push(n);
      size += chars;
    }
    const out = JSON.stringify({ source: 'PlayerGui', nodes, count: Math.min(all.length, MAX_NODES), truncated: all.length > MAX_NODES, from, next });
    return { ok: true, output: out.slice(0, this.cutAt) };
  }
}

/** A garage menu: a screen with `cards` part cards of a few elements each. */
function garage(cards: number): UiNode[] {
  const card = (i: number): UiNode =>
    ({ id: 0, name: `Weapon_${i}`, cls: 'ImageButton', visible: true, pos: [0, 0, 0, 0], size: [0, 160, 0, 200], anchor: [0, 0], z: 1, order: i, bg: [24, 26, 32], bgT: 0, image: `rbxassetid://${1000 + i}`, imageColor: [255, 255, 255], imageT: 0, scaleType: 'Fit', corner: [0, 8], kids: [
      { id: 0, name: 'Name', cls: 'TextLabel', visible: true, pos: [0, 8, 1, -36], size: [1, -16, 0, 28], anchor: [0, 0], z: 2, order: 0, bg: [0, 0, 0], bgT: 1, text: `Autocannon Mk ${i}`, textColor: [240, 240, 240], textT: 0, textSize: 18, scaled: false, wrapped: false, font: 'GothamBold', bold: true, italic: false, xAlign: 'Left', yAlign: 'Center', strokeT: 1, strokeColor: [0, 0, 0], rich: false },
      { id: 0, name: 'Price', cls: 'TextLabel', visible: true, pos: [1, -72, 0, 8], size: [0, 64, 0, 22], anchor: [0, 0], z: 2, order: 1, bg: [40, 120, 60], bgT: 0, text: `${i * 250}`, textColor: [255, 255, 255], textT: 0, textSize: 14, scaled: false, wrapped: false, font: 'Gotham', bold: false, italic: false, xAlign: 'Center', yAlign: 'Center', strokeT: 1, strokeColor: [0, 0, 0], rich: false, corner: [0, 6] },
    ] }) as unknown as UiNode;
  return [{ id: 0, name: 'GarageGui', cls: 'ScreenGui', enabled: true, ignoreInset: true, displayOrder: 5, kids: Array.from({ length: cards }, (_, i) => card(i + 1)) } as unknown as UiNode, { id: 0, name: 'HudReticleGui', cls: 'ScreenGui', enabled: true, displayOrder: 1 } as unknown as UiNode];
}

const count = (nodes: UiNode[]): number => nodes.reduce((n, x) => n + 1 + count(x.kids ?? []), 0);
const names = (nodes: UiNode[]): string[] => nodes.flatMap((x) => [x.name, ...names(x.kids ?? [])]);

describe('reading a big UI out of Studio (why ui_audit said "The playing client didn\'t answer")', () => {
  it('a real menu does not fit in one answer from Studio; read page by page it arrives whole, as the same tree', async () => {
    const gui = new FakeGui(garage(220));
    const total = count(gui.screens);
    expect(total).toBe(662);
    // In one piece this UI is far over what Studio returns: the answer came back cut, and JSON.parse threw every time.
    expect(JSON.stringify(gui.screens).length).toBeGreaterThan(120_000);
    const cap = await readUi(gui, true);
    expect(cap.count).toBe(total);
    expect(cap.truncated).toBe(false);
    expect(count(cap.screens)).toBe(total);
    expect(gui.calls.length).toBeGreaterThan(2);
    expect(gui.calls.every((c) => c.budget === UI_PAGE.chars)).toBe(true);
    // Screens in display order, children in their own order, every card with its two labels.
    expect(cap.screens.map((s) => s.name)).toEqual(['HudReticleGui', 'GarageGui']);
    const cards = cap.screens[1]!.kids!;
    expect(cards.map((c) => c.name)).toEqual(Array.from({ length: 220 }, (_, i) => `Weapon_${i + 1}`));
    expect(cards.every((c) => c.kids?.map((k) => k.name).join() === 'Name,Price')).toBe(true);
    expect(cards[219]!.kids![0]).toMatchObject({ text: 'Autocannon Mk 220', cls: 'TextLabel' });
    expect(names(cap.screens).sort()).toEqual(names(gui.screens).sort());
    expect(cap.screens[0]).not.toHaveProperty('parent');
  });

  it('a page Studio still cuts is asked for again at half the size', async () => {
    const gui = new FakeGui(garage(60));
    gui.cutAt = 30_000;
    const cap = await readUi(gui, true);
    expect(count(cap.screens)).toBe(count(gui.screens));
    expect(Math.min(...gui.calls.map((c) => c.budget))).toBe(20_000);
    gui.cutAt = 100;
    gui.calls = [];
    await expect(readUi(gui, true)).rejects.toThrow(/Studio's answer was cut off .*the UI could not be read/);
  });

  it('a UI that changes while its pages are read is read again; a read error is passed on as it is', async () => {
    const gui = new FakeGui(garage(220));
    gui.growAfter = 2;
    const cap = await readUi(gui, true);
    expect(cap.screens.map((s) => s.name)).toContain('Late');
    expect(count(cap.screens)).toBe(count(gui.screens));
    expect(gui.calls.filter((c) => c.from === 0)).toHaveLength(2);
    gui.fail = 'Client datamodel is not available in Edit mode';
    await expect(readUi(gui, true)).rejects.toThrow('Client datamodel is not available in Edit mode');
  });

  it('ui_audit reads a big menu from a playtest, and when it cannot it says why', async () => {
    const { core } = await makeCore({ respond: async () => null });
    core.orchestrator.pause();
    const sim = attachSim(core);
    const gui = new FakeGui(garage(220));
    sim.answer = async (code) => (code.includes('local FROM, BUDGET') ? (await gui.runLuau(code)).output : 'PASS');
    const agent = { kind: 'agent' as const, runId: 'run_ui', taskId: null, role: 'ui-engineer', providerId: null, allowedTools: null };
    const r = await core.tools.invoke('ui_audit', { source: 'playtest' }, agent);
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/GarageGui: 660 elements/);
    expect(sim.mode).toBe('Edit');
    expect(core.lease.holder).toBeNull();
  }, 60_000);

  it.skipIf(!existsSync(join(homedir(), '.local', 'bin', win ? 'selene.exe' : 'selene')))('the capture programs parse', async () => {
    const t = new LuauToolchain(tmpdir());
    expect(await t.parseErrors(uiCapturePageLuau({ playerGui: true, from: 0, budget: 80_000 }))).toEqual([]);
    expect(await t.parseErrors(uiCapturePageLuau({ from: 412, budget: 4000 }))).toEqual([]);
    expect(await t.parseErrors(uiCaptureLuau({ playerGui: true }))).toEqual([]);
    expect(await t.parseErrors(uiCaptureLuau({}))).toEqual([]);
  });
});
