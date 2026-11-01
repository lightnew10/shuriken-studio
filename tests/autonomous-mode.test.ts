import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_ESCALATION, decideShell, decideToolCall } from '../src/core/permissions/policy';
import { effectivePermissionMode, needsOwner } from '../src/core/permissions/owner-gate';
import { ToolRegistry, type CallerContext } from '../src/core/capabilities/tool-registry';
import { Logger } from '../src/core/log';
import type { EscalationRules, PermissionMode } from '../src/shared/domain';
import { fakeWrite } from './helpers/fake-provider';
import { coreHarness } from './helpers/make-core';

/**
 * Permission modes (docs/ARCHITECTURE.md, "Permission modes"): in autonomous mode (the default) nothing waits
 * for the app's owner except spending money and publishing the game; "ask" is the behaviour from before.
 */

const makeCore = coreHarness();

const root = resolve(tmpdir(), 'shuriken-autonomy-project');
const dataDir = resolve(tmpdir(), 'shuriken-autonomy-data');
const auto = (cmd: string, rules: EscalationRules = DEFAULT_ESCALATION) => decideShell(cmd, rules, { mode: 'autonomous', roots: [root, dataDir], cwd: root });
const asking = (cmd: string, rules: EscalationRules = DEFAULT_ESCALATION) => decideShell(cmd, rules, { mode: 'ask', roots: [root, dataDir], cwd: root });

describe('permission mode', () => {
  it('is autonomous unless the project or the app says ask, and the project wins', () => {
    expect(effectivePermissionMode(undefined, undefined)).toBe('autonomous');
    expect(effectivePermissionMode(null, 'ask')).toBe('ask');
    expect(effectivePermissionMode('autonomous', 'ask')).toBe('autonomous');
    expect(effectivePermissionMode('ask', 'autonomous')).toBe('ask');
    expect(effectivePermissionMode('nonsense' as PermissionMode, 'nonsense' as PermissionMode)).toBe('autonomous');
  });

  it('is autonomous for new and existing projects and settings, and each can switch', async () => {
    const { core, ctx } = await makeCore({ respond: async () => null });
    // Nothing was ever saved about it: the default.
    expect(core.prefs.get().permissionMode).toBe('autonomous');
    expect(ctx.settings().permissionMode ?? null).toBeNull();
    expect(core.permissionMode()).toBe('autonomous');
    core.prefs.set({ permissionMode: 'ask' });
    expect(core.permissionMode()).toBe('ask');
    ctx.updateSettings({ permissionMode: 'autonomous' });
    expect(core.permissionMode()).toBe('autonomous');
    ctx.updateSettings({ permissionMode: null });
    expect(core.permissionMode()).toBe('ask');
    core.prefs.set({ permissionMode: 'garbage' as PermissionMode });
    expect(core.prefs.get().permissionMode).toBe('autonomous');
  });
});

describe('shell commands', () => {
  it('a command that used to need approval is granted in autonomous mode and flagged as auto-approved', () => {
    for (const cmd of ['rm -rf build', 'Remove-Item -Recurse -Force .\\src\\old', 'git reset --hard HEAD~1', 'git push origin main', 'git clean -fd', 'curl -X POST https://example.com/hook -d x', `rm -rf ${join(root, 'out')}`, 'rd /s /q dist']) {
      const before = asking(cmd);
      const now = auto(cmd);
      expect(before.outcome, `${cmd} asks in ask mode`).toBe('ask');
      expect(now, cmd).toMatchObject({ outcome: 'allow', autoApproved: true });
      expect(now.reason).toMatch(/^Auto-approved \(autonomous mode\): /);
    }
    // Deleting inside the app's data folder is fine too.
    expect(auto(`rm -rf ${join(dataDir, 'cache')}`)).toMatchObject({ outcome: 'allow', autoApproved: true });
  });

  it('what the policy denies stays denied, and a destructive command outside the project is denied, not auto-approved', () => {
    // Denied outright today.
    expect(auto('sleep 120').outcome).toBe('deny');
    expect(decideShell('rm -rf src', { ...DEFAULT_ESCALATION, destructiveOperations: 'deny' }, { mode: 'autonomous', roots: [root], cwd: root }).outcome).toBe('deny');
    // `ask` before, a hard denial now: it reaches outside the project and the app's data folder.
    for (const cmd of [
      'rm -rf C:\\Users\\someone\\Documents',
      'rm -rf ..',
      'rm -rf ../other-project',
      'rm -rf $HOME/old',
      'rm -rf ~/old',
      'rm -rf "%USERPROFILE%\\x"',
      'Remove-Item -Recurse -Force C:\\Windows\\Temp\\x',
      'Remove-Item -Path $env:TEMP\\x -Recurse',
      'rd /s /q D:\\games',
      'del /s /q C:\\*',
      'rm -rf .',
      'rm -rf .git',
      `rm -rf ${join(root, '.shuriken')}`,
      `rm -rf ${dataDir}`,
      'cd .. && rm -rf build',
      'cd C:\\ && rm -rf Users',
      'git -C ..\\other reset --hard',
      'format D:',
      'shutdown /s /t 0',
      'diskpart',
    ]) {
      const d = auto(cmd);
      expect(d.outcome, cmd).toBe('deny');
      expect(d.autoApproved, cmd).toBeUndefined();
    }
    // Ask mode kept asking about all of them (the user sees the command).
    expect(asking('rm -rf C:\\Users\\someone\\Documents').outcome).toBe('ask');
    // One safe part must not hide an unsafe one.
    expect(auto('rm -rf build && rm -rf C:\\Users\\x').outcome).toBe('deny');
    expect(auto('rm -rf build; git reset --hard').outcome).toBe('allow');
  });

  it('spending money and publishing ask in every mode, with any rule except deny', () => {
    for (const cmd of ['npm publish', 'rojo upload --asset 123', 'rbxcloud experience publish -u 1 -p 2', 'curl -X POST "https://apis.roblox.com/universes/v1/1/places/2/versions?versionType=Published" -d @place.rbxl', 'wally publish']) {
      expect(auto(cmd), cmd).toMatchObject({ outcome: 'ask', owner: true });
      expect(asking(cmd), cmd).toMatchObject({ outcome: 'ask' });
      expect(auto(cmd, { ...DEFAULT_ESCALATION, publishing: 'allow' }).outcome, `${cmd} with publishing: allow`).toBe('ask');
      expect(auto(cmd, { ...DEFAULT_ESCALATION, publishing: 'deny' }).outcome, `${cmd} with publishing: deny`).toBe('deny');
    }
    expect(auto('curl -X POST https://economy.roblox.com/v1/purchases/products/123 -d x')).toMatchObject({ outcome: 'ask', owner: true });
    // Looks similar, is not: the words and ordinary git/npm use.
    expect(auto('npm run build').outcome).toBe('allow');
    expect(auto('git status').outcome).toBe('allow');
    expect(auto('git commit -m "publish notes"').outcome).toBe('allow');
  });

  it('ask mode (and a caller that names no mode) decides exactly as before', () => {
    expect(decideShell('rm -rf src', DEFAULT_ESCALATION).outcome).toBe('ask');
    expect(decideShell('git push origin main', DEFAULT_ESCALATION).outcome).toBe('ask');
    expect(decideShell('git status', DEFAULT_ESCALATION).outcome).toBe('allow');
    expect(decideShell('rm -rf src', { ...DEFAULT_ESCALATION, destructiveOperations: 'allow' }).outcome).toBe('allow');
    expect(asking('format D:').outcome).toBe('ask');
  });
});

describe('the one predicate: what always needs the owner', () => {
  it('names spending and publishing, whatever the mode', () => {
    expect(needsOwner({ kind: 'tool', tool: 'buy_it', permission: 'spending' })).toMatchObject({ why: 'spending' });
    expect(needsOwner({ kind: 'tool', tool: 'go_live', permission: 'publish' })).toMatchObject({ why: 'publishing' });
    expect(needsOwner({ kind: 'tool', tool: 'roblox_run_luau', permission: 'roblox_write', args: { code: 'game:GetService("AssetService"):SavePlaceAsync()' } })).toMatchObject({ why: 'publishing' });
    expect(needsOwner({ kind: 'tool', tool: 'roblox_run_luau', permission: 'roblox_write', args: { code: 'game:GetService("StudioPublishService"):PublishAs(1, 2, 3)' } })).toMatchObject({ why: 'publishing' });
    expect(needsOwner({ kind: 'tool', tool: 'roblox_run_luau', permission: 'roblox_write', args: { code: 'MarketplaceService:PerformPurchase(Enum.InfoType.Product, 12, 99, "x", true)' } })).toMatchObject({ why: 'spending' });
    expect(needsOwner({ kind: 'tool', tool: 'roblox_call', permission: 'roblox_write', args: { tool: 'publish_place', args: {} } })).toMatchObject({ why: 'publishing' });
    // Ordinary Studio work, the shop UI a game needs, and MessagingService are not.
    expect(needsOwner({ kind: 'tool', tool: 'roblox_run_luau', permission: 'roblox_write', args: { code: 'MessagingService:PublishAsync("t", "x") MarketplaceService:PromptPurchase(player, 123)' } })).toBeNull();
    expect(needsOwner({ kind: 'tool', tool: 'roblox_run_luau', permission: 'roblox_write', args: { code: 'workspace.Part.Anchored = true' } })).toBeNull();
    expect(needsOwner({ kind: 'tool', tool: 'roblox_explore', permission: 'roblox_read', args: { path: 'Workspace' } })).toBeNull();
    // cloud_luau_run acts on the published game: writing its live data counts, a read-only test does not.
    expect(needsOwner({ kind: 'tool', tool: 'cloud_luau_run', permission: 'external', args: { script: 'DataStoreService:GetDataStore("x"):SetAsync("k", 1)' } })).toMatchObject({ why: 'publishing' });
    expect(needsOwner({ kind: 'tool', tool: 'cloud_luau_run', permission: 'external', args: { script: 'return #game.Workspace:GetChildren() > 0' } })).toBeNull();
    // What an agent says to the owner.
    expect(needsOwner({ kind: 'text', text: 'Should I spend 400 Robux on this asset pack?' })).toMatchObject({ why: 'spending' });
    expect(needsOwner({ kind: 'text', text: 'Ready to publish the game to Roblox?' })).toMatchObject({ why: 'publishing' });
    expect(needsOwner({ kind: 'text', text: 'Should the lobby music be a sword fight theme or calm?' })).toBeNull();
    // A dollar figure is not spending: agents quote what work costs in usage. This one went to a sleeping user and
    // held a modeler ("about 3 hours and about $40 of Kiln time"); Kiln builds run "on the same subscription".
    expect(needsOwner({ kind: 'text', text: 'Splitting them into nine rigged projects takes about 3 hours and about $40 of Kiln time. Keep the families as delivered?' })).toBeNull();
    expect(needsOwner({ kind: 'text', text: 'Six Kiln builds are running on the same subscription; queue the rest?' })).toBeNull();
    // A price next to a word for paying is.
    expect(needsOwner({ kind: 'text', text: 'The asset pack is $12 to buy. Go ahead?' })).toMatchObject({ why: 'spending' });
    expect(needsOwner({ kind: 'text', text: 'Shall I purchase the plugin for $5?' })).toMatchObject({ why: 'spending' });
  });

  it('is applied to tool calls in both modes: an `external` tool is granted in autonomous mode unless it publishes', () => {
    const run = (args: unknown, mode: PermissionMode, rules = DEFAULT_ESCALATION) => decideToolCall({ permission: 'external', tool: 'cloud_luau_run', title: 'Run Luau on the published place', args }, rules, mode);
    expect(run({ script: 'return 1' }, 'ask')).toMatchObject({ outcome: 'ask' });
    expect(run({ script: 'return 1' }, 'autonomous')).toMatchObject({ outcome: 'allow', autoApproved: true });
    expect(run({ script: 'return 1' }, 'autonomous', { ...DEFAULT_ESCALATION, externalCommunications: 'deny' }).outcome).toBe('deny');
    expect(run({ script: 'DataStoreService:GetDataStore("x"):SetAsync("k", 1)' }, 'autonomous')).toMatchObject({ outcome: 'ask', owner: true });
    expect(run({ script: 'DataStoreService:GetDataStore("x"):SetAsync("k", 1)' }, 'autonomous', { ...DEFAULT_ESCALATION, externalCommunications: 'allow' })).toMatchObject({ outcome: 'ask', owner: true });
    // Spending is denied by default and can never be allowed by a rule or a mode.
    for (const mode of ['autonomous', 'ask'] as const) {
      expect(decideToolCall({ permission: 'spending', tool: 'buy', title: 'Buy', args: {} }, DEFAULT_ESCALATION, mode).outcome).toBe('deny');
      expect(decideToolCall({ permission: 'spending', tool: 'buy', title: 'Buy', args: {} }, { ...DEFAULT_ESCALATION, spending: 'ask' }, mode)).toMatchObject({ outcome: 'ask', owner: true });
      expect(decideToolCall({ permission: 'spending', tool: 'buy', title: 'Buy', args: {} }, { ...DEFAULT_ESCALATION, spending: 'allow' }, mode)).toMatchObject({ outcome: 'ask', owner: true });
      expect(decideToolCall({ permission: 'publish', tool: 'go', title: 'Publish', args: {} }, { ...DEFAULT_ESCALATION, publishing: 'allow' }, mode)).toMatchObject({ outcome: 'ask', owner: true });
    }
  });
});

describe('the tool gate (ToolRegistry)', () => {
  const caller: CallerContext = { kind: 'agent', runId: 'run_1', taskId: 't1', role: 'qa-engineer', providerId: null, allowedTools: null };

  function registry(mode: PermissionMode | undefined) {
    const asked: string[] = [];
    const events: Array<{ kind: string; title: string; detail?: unknown }> = [];
    const reg = new ToolRegistry(
      { rules: () => DEFAULT_ESCALATION, ...(mode ? { mode: () => mode } : {}), requestApproval: async (_c, tool) => (asked.push(tool), false), notify: () => undefined },
      { record: () => undefined },
      new Logger(null, null).scope('t'),
    );
    reg.attachAudit({ beginToolCall: () => 'a1', endToolCall: () => undefined, event: (e: { kind: string; title: string; detail?: unknown }) => events.push(e) } as never);
    const ran: string[] = [];
    const tool = (name: string, permission: 'external' | 'publish' | 'spending' | 'roblox_write') =>
      reg.register({ name, title: name, description: name, capability: 'test', permission, input: { script: z.string().optional() }, handler: async () => (ran.push(name), { content: [{ type: 'text', text: 'ran' }] }) });
    tool('cloud_luau_run', 'external');
    tool('go_live', 'publish');
    tool('roblox_run_luau', 'roblox_write');
    return { reg, asked, events, ran };
  }

  it('autonomous: an external tool runs, and the timeline records it auto-approved with its reason', async () => {
    const { reg, asked, events, ran } = registry('autonomous');
    const out = await reg.invoke('cloud_luau_run', { script: 'return 1' }, caller);
    expect(out.isError).toBeFalsy();
    expect(ran).toEqual(['cloud_luau_run']);
    expect(asked).toEqual([]);
    expect(events.find((e) => e.kind === 'policy.auto_approved')).toMatchObject({ title: 'Auto-approved: cloud_luau_run', detail: { tool: 'cloud_luau_run', rule: 'externalCommunications' } });
  });

  it('autonomous: publishing and a script that publishes still ask (and do not run)', async () => {
    const { reg, asked, ran } = registry('autonomous');
    for (const [tool, args] of [['go_live', {}], ['roblox_run_luau', { script: 'game:GetService("StudioPublishService"):PublishAs(1, 2, 3)' }], ['cloud_luau_run', { script: 'x:SetAsync("k", 1)' }]] as const) {
      const out = await reg.invoke(tool, args, caller);
      expect(out.isError, tool).toBe(true);
      expect(JSON.stringify(out.content), tool).toContain('Requires human approval');
    }
    expect(asked).toEqual(['go_live', 'roblox_run_luau', 'cloud_luau_run']);
    expect(ran).toEqual([]);
  });

  it('ask mode, and a registry with no mode, ask for the external tool as before', async () => {
    for (const mode of ['ask', undefined] as const) {
      const { reg, asked, ran, events } = registry(mode);
      const out = await reg.invoke('cloud_luau_run', { script: 'return 1' }, caller);
      expect(out.isError).toBe(true);
      expect(asked).toEqual(['cloud_luau_run']);
      expect(ran).toEqual([]);
      expect(events.some((e) => e.kind === 'policy.auto_approved')).toBe(false);
    }
  });
});

describe('agents running shell commands (AgentRunner.decide, through a real core)', () => {
  /** What the provider's permission callback says to `command`, run by an agent of the open project. */
  async function shell(command: string, mode: PermissionMode | null) {
    let answer: { allow: boolean; message?: string } | null = null;
    const { core, ctx, root: projectRoot } = await makeCore({
      respond: async (req, kind) => {
        if (kind === 'work') {
          answer = await req.permission({ tool: 'Bash', toolClass: 'shell', input: { command: command.replace('<ROOT>', req.cwd) } });
          return { status: 'implemented', summary: 'ran' };
        }
        return null;
      },
    });
    ctx.updateSettings({ permissionMode: mode, autonomy: 'manual' });
    core.orchestrator.attach(ctx);
    const task = ctx.tasks.create({ kind: 'implement', title: 'Clean up', objective: 'Clean up.', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['Done'], verification: [] });
    core.orchestrator.runNow(task.id);
    const t0 = Date.now();
    while (!answer && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
    return { answer: answer as { allow: boolean; message?: string } | null, ctx, core, root: projectRoot };
  }

  it('autonomous: `rm -rf` inside the project runs, with an auto-approved record carrying the command and the reason, and no card', async () => {
    const { answer, ctx } = await shell('rm -rf <ROOT>/build', 'autonomous');
    expect(answer).toMatchObject({ allow: true });
    const ev = ctx.audit.timeline({ limit: 100 }).find((e) => e.kind === 'policy.auto_approved');
    expect(ev?.title).toContain('rm -rf');
    expect(JSON.stringify(ev?.detail)).toContain('recursive force delete');
    expect(JSON.stringify(ev?.detail)).toContain('rm -rf');
    expect(ctx.governance.escalations('open')).toHaveLength(0);
  }, 40000);

  it('the default (no mode set anywhere) is autonomous', async () => {
    const { answer, ctx } = await shell('git push origin main', null);
    expect(answer).toMatchObject({ allow: true });
    expect(ctx.audit.timeline({ limit: 100 }).some((e) => e.kind === 'policy.auto_approved')).toBe(true);
    expect(ctx.governance.escalations('open')).toHaveLength(0);
  }, 40000);

  it('autonomous: a destructive command outside the project stays denied and files nothing', async () => {
    const { answer, ctx } = await shell('rm -rf C:\\Users', 'autonomous');
    expect(answer).toMatchObject({ allow: false });
    expect(answer?.message).toMatch(/Denied by Shuriken policy/);
    expect(ctx.audit.timeline({ limit: 100 }).some((e) => e.kind === 'policy.denied')).toBe(true);
    expect(ctx.governance.escalations('open')).toHaveLength(0);
  }, 40000);

  it('autonomous: publishing from the shell asks (an approval card) and does not run', async () => {
    const { answer, ctx } = await shell('npm publish', 'autonomous');
    expect(answer).toMatchObject({ allow: false });
    expect(answer?.message).toMatch(/Needs human approval/);
    const open = ctx.governance.escalations('open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'approval' });
  }, 40000);

  it('ask mode: `rm -rf` asks, with an approval card, as before', async () => {
    const { answer, ctx } = await shell('rm -rf <ROOT>/build', 'ask');
    expect(answer).toMatchObject({ allow: false });
    expect(answer?.message).toMatch(/Needs human approval/);
    expect(ctx.governance.escalations('open')).toHaveLength(1);
    expect(ctx.audit.timeline({ limit: 100 }).some((e) => e.kind === 'policy.auto_approved')).toBe(false);
  }, 40000);

  it('file writes outside the project are denied in both modes', async () => {
    for (const mode of ['autonomous', 'ask'] as const) {
      let ok: boolean | null = null;
      const { core, ctx } = await makeCore({
        respond: async (req, kind) => {
          if (kind === 'work') {
            ok = await fakeWrite(req, join('..', 'outside.txt'), 'x');
            return { status: 'implemented', summary: 'tried' };
          }
          return null;
        },
      });
      ctx.updateSettings({ permissionMode: mode, autonomy: 'manual' });
      core.orchestrator.attach(ctx);
      const task = ctx.tasks.create({ kind: 'implement', title: 'Write', objective: 'Write.', role: 'roblox-engineer', createdBy: 't', status: 'ready', acceptanceCriteria: ['Done'], verification: [] });
      core.orchestrator.runNow(task.id);
      const t0 = Date.now();
      while (ok === null && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
      expect(ok, mode).toBe(false);
    }
  }, 60000);
});

