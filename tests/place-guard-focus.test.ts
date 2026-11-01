import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLACE_SAVE, PlaceGuard } from '../src/core/roblox/place-guard';
import { PlaytestLease } from '../src/core/roblox/playtest-lease';
import type { SavePlaceResult } from '../src/core/roblox/studio-window';
import { coreHarness } from './helpers/make-core';

const makeCore = coreHarness();
const savedSave = { ...PLACE_SAVE };
afterEach(() => Object.assign(PLACE_SAVE, savedSave));
const FOCUS: SavePlaceResult = { ok: false, focus: true, message: 'Windows did not bring the Studio window to the front, so no keys were sent. Save it in Studio with Ctrl+S.' };

async function setup() {
  const { core, ctx } = await makeCore({ respond: async () => null });
  core.orchestrator.pause();
  writeFileSync(join(ctx.root, 'arena.rbxlx'), '<roblox/>');
  ctx.updateExtras({ placeFile: 'arena.rbxlx' });
  const lease = new PlaytestLease();
  const saves: string[] = [];
  const state = { answer: FOCUS as SavePlaceResult };
  const guard = new PlaceGuard({
    project: () => ctx,
    studio: { connected: true, binding: 'arena.rbxlx' } as never,
    lease,
    bus: core.bus,
    log: core.log,
    autoSave: () => true,
    pushCode: async () => undefined,
    hold: () => undefined,
    autoSavesDir: mkdtempSync(join(tmpdir(), 'shuriken-autosaves-')),
    save: async (f) => {
      saves.push(f);
      return state.answer;
    },
    userBusy: async () => false,
  });
  const said = () => core.director.chat()!.list().filter((m) => /couldn't bring Studio to the front/.test(m.text)).length;
  const events = (kind: string) => ctx.audit.timeline({ limit: 100 }).filter((e) => e.kind === kind);
  return { core, ctx, lease, guard, saves, state, said, events };
}

describe('auto-save when Windows will not bring Studio to the front', () => {
  it('says so once and goes on: not asked again for a while, the user’s own Save still tries, and a save that works resets it', async () => {
    const { guard, saves, state, said, events } = await setup();
    const first = await guard.saveNow('checkpoint');
    expect(first).toMatchObject({ ok: false, focus: true });
    expect(saves).toHaveLength(1);
    expect(said()).toBe(1);
    expect(events('place.save.skipped')).toHaveLength(1);
    expect(events('place.save.failed')).toHaveLength(0); // not a failure of the place: no hourly warning either

    // The next unattended tries wait (ten minutes), without asking Studio's window again or saying it again.
    const periodic = await guard.saveNow('periodic');
    expect(periodic.message).toMatch(/Waiting: Windows wouldn't bring Studio to the front a moment ago/);
    expect(saves).toHaveLength(1);
    expect(said()).toBe(1);

    // The user pressing Save tries at once (and doesn't repeat the chat message).
    expect((await guard.saveNow('user', true)).focus).toBe(true);
    expect(saves).toHaveLength(2);
    expect(said()).toBe(1);

    // A save that works clears it; the same refusal soon after is not said again (on 2026-10-06 it was, four times in
    // a day, each time "I won't mention it again"), only once PLACE_SAVE.tellAgainMs has passed.
    state.answer = { ok: true, message: 'Saved arena.rbxlx.' };
    expect((await guard.saveNow('user', true)).ok).toBe(true);
    expect(guard.unsaved).toBe(false);
    state.answer = FOCUS;
    await guard.saveNow('checkpoint');
    expect(saves).toHaveLength(4);
    expect(said()).toBe(1);
    PLACE_SAVE.tellAgainMs = 0;
    await guard.saveNow('user', true);
    expect(saves).toHaveLength(5);
    expect(said()).toBe(2);
  });

  it("doesn't queue behind a playtest for a save nobody asked for, and doesn't call that a failure", async () => {
    const { guard, lease, saves, said, events } = await setup();
    lease.tryAcquire('run_playing');
    const t0 = Date.now();
    const r = await guard.saveNow('periodic');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/Studio is in a playtest; the save waits for a quieter moment/);
    expect(saves).toHaveLength(0);
    expect(lease.holder?.owner).toBe('run_playing');
    expect(lease.waiting).toBe(0);
    expect(said()).toBe(0);
    expect(events('place.save.failed')).toHaveLength(0);
    // When Studio is free it saves as before, and lets go of the lease.
    lease.release('run_playing');
    await guard.saveNow('periodic');
    expect(saves).toHaveLength(1);
    expect(lease.holder).toBeNull();
  });
});
