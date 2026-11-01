import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from '@shared/ids';
import type { EventBus } from '../events';
import type { ScopedLogger } from '../log';
import type { ProjectContext } from '../projects/project-service';
import type { CodeSync } from '../roblox/code-sync';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { OpenCloudStore, PushOutcome } from './open-cloud-store';
import { Storefront, itemHash, itemStatus } from './storefront';

/** The store items a message names, by key or by shown name, as whole words ("push the VIP pass" names VIP). */
export function namedItems(text: string, items: ReadonlyArray<{ key: string; name: string }>): string[] {
  const has = (w: string) => !!w.trim() && new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\p{L}\p{N}])`, 'iu').test(text);
  return items.filter((i) => has(i.key) || has(i.name)).map((i) => i.key);
}

/**
 * Puts the game's store on Roblox: each item that is a draft (or changed since it was pushed) is created (or updated)
 * as a game pass or developer product with its icon, and its Roblox id written into the game's ShurikenStore module,
 * which is synced. Only ever on the user's word: the Storefront page's Push button, or the user asking the director
 * (director.ts checks their own message). Never an agent's tool. The game must be published (its universe id comes
 * from the open place: game.GameId).
 */
export class StorePush {
  private running = false;

  constructor(
    private readonly d: {
      cloud: OpenCloudStore;
      studio: RobloxStudioAdapter;
      sync?: CodeSync;
      bus: EventBus;
      log: ScopedLogger;
    },
  ) {}

  /** The game's universe on Roblox, from the place open in Studio (0 or null: not published, or no Studio). */
  async universeId(): Promise<number | null> {
    if (!this.d.studio.connected) return null;
    const r = await this.d.studio.runLuau('return tostring(game.GameId)', 'Edit', 20_000).catch(() => null);
    const n = r?.ok ? Number(r.output.trim()) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** What a push would send now: the items not on Roblox yet or changed since (only `keys`, when given). */
  pending(ctx: ProjectContext, keys?: readonly string[]): string[] {
    return new Storefront(ctx.root)
      .catalog()
      .items.filter((i) => (itemStatus(i) === 'draft' || itemStatus(i) === 'changed') && (!keys?.length || keys.includes(i.key)))
      .map((i) => i.key);
  }

  /**
   * Puts the store as designed in the game (not on Roblox): writes the ShurikenStore module from the catalog and syncs
   * that one file to Studio when Studio is there.
   */
  async apply(ctx: ProjectContext): Promise<{ file: string; synced: boolean; note: string }> {
    const sf = new Storefront(ctx.root);
    const mod = sf.applyAll(ctx.extras().syncMap);
    let synced = false;
    if (this.d.sync && this.d.studio.connected) {
      try {
        await this.d.sync.push(ctx.root, ctx.extras().syncMap, { only: [mod.file], owner: 'storefront' });
        synced = true;
      } catch (e) {
        this.d.log.warn('Syncing the store module failed', (e as Error).message);
      }
    }
    ctx.audit.event({ kind: 'storefront.apply', title: 'The store was put in the game', detail: { file: mod.file, synced } });
    this.d.bus.emit('storefront.changed', { part: 'catalog' });
    return { file: mod.file, synced, note: synced ? `${mod.file} written and synced to Studio.` : `${mod.file} written; it reaches Studio with the next sync.` };
  }

  /**
   * `keys`: only these (the items the user named to the director). `confirmed`: the button's list as the user saw it,
   * each with its hash: an item changed since (an agent or a copilot at work) is not pushed unseen. Each item is saved
   * as soon as Roblox has it, into the catalog as it is then (others may have changed other items meanwhile).
   */
  async push(
    ctx: ProjectContext,
    opts: { keys?: string[]; confirmed?: Array<{ key: string; hash: string }>; by: 'button' | 'director' },
  ): Promise<{ ok: boolean; results: PushOutcome[]; summary: string; needsUser?: string; skipped?: string[] }> {
    if (this.running) return { ok: false, results: [], summary: 'A push is already under way.' };
    this.running = true;
    try {
      const sf = new Storefront(ctx.root);
      const map = ctx.extras().syncMap;
      let keys = this.pending(ctx, opts.confirmed ? opts.confirmed.map((c) => c.key) : opts.keys);
      const skipped: string[] = [];
      if (opts.confirmed) {
        const now = new Map(sf.catalog().items.map((i) => [i.key, itemHash(i)]));
        skipped.push(...keys.filter((k) => opts.confirmed!.find((c) => c.key === k)?.hash !== now.get(k)));
        keys = keys.filter((k) => !skipped.includes(k));
      }
      const changedNote = skipped.length ? ` Not pushed, changed since you looked: ${skipped.join(', ')} (look again, then push).` : '';
      if (!keys.length) return { ok: !skipped.length, results: [], summary: `${skipped.length ? 'Nothing was pushed.' : 'Everything in the store is on Roblox and up to date.'}${changedNote}`, skipped };
      if (!(await this.d.cloud.configured())) return { ok: false, results: [], summary: 'No Open Cloud API key is set.', needsUser: 'Add your Open Cloud API key in Settings → Roblox & Studio → Uploads to Roblox, with the Game Passes and Developer Products APIs (write) for this game.' };
      // The game on Roblox: the place open in Studio when it is the published one, else the game this project was
      // published as (recorded when it was published). Working on the local file and publishing it over the game
      // when ready is the usual way, and a local file knows no game: every push from it said "not published yet".
      const open = await this.universeId();
      const recorded = Number(ctx.extras().cloud?.universeId ?? 0);
      const universe = open ? open : Number.isFinite(recorded) && recorded > 0 ? recorded : open;
      if (universe === null) return { ok: false, results: [], summary: 'Studio is not open with the game.', needsUser: "Open the game's place in Studio: its universe on Roblox is read from it." };
      if (universe === 0) return { ok: false, results: [], summary: 'The game is not published yet.', needsUser: 'Publish the game to Roblox first (in Studio: File → Publish to Roblox): game passes and developer products belong to a published game. Shuriken remembers the game it was published as.' };
      // The store belongs to one game: never create half of it in another one.
      const elsewhere = [...new Set(sf.catalog().items.map((i) => i.roblox?.universeId).filter((u): u is number => typeof u === 'number' && u !== universe))];
      if (elsewhere.length)
        return {
          ok: false,
          results: [],
          summary: `The store is on another game on Roblox (universe ${elsewhere.join(', ')}), not the one open in Studio (${universe}).`,
          needsUser: "Open that game's place in Studio to push to it. Nothing was pushed.",
        };
      const results: PushOutcome[] = [];
      for (const key of keys) {
        const item = sf.catalog().items.find((i) => i.key === key);
        if (!item) continue;
        const icon = item.icon?.file ? join(sf.artDir(), item.icon.file) : null;
        const out = await this.d.cloud.push(universe, item, { icon: icon && existsSync(icon) ? icon : null });
        results.push(out);
        if (out.ok && out.id) {
          // Saved at once, into the catalog as it is now: an id Roblox gave is never lost to a later save.
          const fresh = sf.catalog();
          const now = fresh.items.find((i) => i.key === key);
          if (now) {
            now.roblox = { id: out.id, iconAssetId: out.iconAssetId ?? null, pushedAt: nowIso(), hash: itemHash(item), forSale: true, universeId: universe };
            sf.saveCatalog(fresh, map, { apply: [key] });
          }
        }
        // The key or the game needs the user: the rest would fail the same way.
        if (out.needsUser) break;
      }
      const mod = Storefront.moduleLocation(map);
      if (this.d.sync && this.d.studio.connected && results.some((r) => r.ok)) await this.d.sync.push(ctx.root, map, { only: [mod.file], owner: 'storefront' }).catch((e) => this.d.log.warn('Syncing the store module failed', (e as Error).message));
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const summary = [
        ok.length ? `On Roblox: ${ok.map((r) => `${r.key} (${r.created ? 'created' : 'updated'}, id ${r.id})`).join(', ')}.` : '',
        failed.length ? `Not pushed: ${failed.map((r) => `${r.key}: ${r.error}`).join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      ctx.audit.event({ kind: 'storefront.push', severity: failed.length ? 'warning' : 'success', title: `Store pushed to Roblox (${opts.by}): ${ok.length} ok, ${failed.length} not`, detail: { universe, results, skipped } });
      this.d.bus.emit('storefront.changed', { part: 'push' });
      const needs = failed.find((r) => r.needsUser);
      return { ok: !failed.length && !skipped.length, results, summary: `${summary}${changedNote}`, skipped, ...(needs ? { needsUser: needs.error } : {}) };
    } finally {
      this.running = false;
    }
  }
}
