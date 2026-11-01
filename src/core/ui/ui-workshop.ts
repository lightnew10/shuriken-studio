import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditDevices, auditUi, layoutScreen, walkUi, UI_DEVICES, type UiSnapshot } from '@shared/ui-layout';
import { readUi, type UiCapture } from '../roblox/ui-capture';
import type { RobloxStudioAdapter } from '../roblox/studio-adapter';
import type { PlaytestLease } from '../roblox/playtest-lease';
import type { EventBus } from '../events';

/** `.shuriken/ui/`: the last capture (so the UI panel works while Studio is closed) and image thumbnails. */
export class UiStore {
  constructor(private readonly root: string) {}

  private get dir(): string {
    return join(this.root, '.shuriken', 'ui');
  }

  get(): UiSnapshot | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'snapshot.json'), 'utf8')) as UiSnapshot;
    } catch {
      return null;
    }
  }

  save(c: UiCapture): UiSnapshot {
    mkdirSync(this.dir, { recursive: true });
    // A landscape phone, a tablet, a desktop and a TV; a portrait phone too when the game allows portrait.
    const audited = auditDevices(c.orientation);
    const snap: UiSnapshot = { ...c, capturedAt: new Date().toISOString(), findings: auditUi(c.screens, audited), audited };
    writeFileSync(join(this.dir, 'snapshot.json'), JSON.stringify(snap));
    return snap;
  }

  imagePath(id: string): string {
    return join(this.dir, 'images', `${id}.png`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the game's UI from Studio. 'edit' reads StarterGui; 'playtest' starts a short playtest (or
 * uses the caller's own running one) and reads the player's PlayerGui once the scripts that build it
 * have settled; 'auto' reads StarterGui and falls back to a playtest when it has no ScreenGuis (UI
 * built at runtime, as the HUD kit does). The place itself is never changed.
 */
export async function captureUi(
  d: { studio: RobloxStudioAdapter; lease: PlaytestLease; bus: EventBus },
  opts: { source: 'auto' | 'edit' | 'playtest'; owner: string; signal?: AbortSignal },
): Promise<UiCapture> {
  // Page by page: a UI of more than about 300 elements doesn't fit in one answer from Studio (roblox/ui-capture.ts).
  const read = (playerGui: boolean): Promise<UiCapture> => readUi(d.studio, playerGui, opts.signal);
  // An agent waits its turn (up to 4 min) while someone else plays; the UI panel answers right away.
  const agent = opts.owner.startsWith('run_');
  const WAIT_MS = 4 * 60 * 1000;
  if (opts.source !== 'playtest') {
    if (agent && d.lease.holder && d.lease.holder.owner !== opts.owner) await d.lease.waitFree(opts.owner, WAIT_MS, opts.signal);
    const edit = await read(false);
    if (opts.source === 'edit' || edit.screens.length) return edit;
  }
  const holder = d.lease.holder;
  const ours = holder?.owner === opts.owner;
  if (!ours && !(agent ? await d.lease.acquire(opts.owner, WAIT_MS, opts.signal) : d.lease.tryAcquire(opts.owner))) {
    const now = d.lease.holder ?? holder;
    const who = now?.owner.startsWith('ui:') ? 'the UI panel' : now?.owner.startsWith('run_') ? 'an agent checking its work' : (now?.owner ?? 'another task');
    throw new Error(`Studio is in a playtest for ${who}; read the UI again when it has finished.`);
  }
  try {
    if (!ours) {
      await d.studio.setPlaying(true);
      d.bus.emit('roblox.changed', { reason: 'playtest:start' });
    }
    // Scripts build the UI as the player joins: wait until it stops changing (up to 20 s).
    let last: UiCapture | null = null;
    let why = '';
    let steadySince = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('Cancelled');
      try {
        const c = await read(true);
        if (!last || c.count !== last.count || c.screens.length !== last.screens.length) steadySince = Date.now();
        else if (c.screens.length && Date.now() - steadySince >= 1500) return c;
        last = c;
      } catch (e) {
        // The playing client may not be up yet; if it never answers, the last reason is what is reported.
        why = e instanceof Error ? e.message : String(e);
      }
      await sleep(700);
    }
    if (last) return last;
    throw new Error(`The playing client's UI couldn't be read in 20 s${why ? `: ${why.slice(0, 300)}` : " (the client didn't answer)"}.`);
  } finally {
    if (!ours) {
      await d.studio.setPlaying(false).catch(() => undefined);
      d.lease.release(opts.owner);
      d.bus.emit('roblox.changed', { reason: 'playtest:stop' });
    }
  }
}

/** A short outline of the UI for an agent: each screen's top elements and where they land on a phone and a desktop. */
export function uiOutline(snap: UiCapture, limit = 40): string[] {
  const lines: string[] = [];
  const r = (n: number) => Math.round(n);
  for (const s of snap.screens) {
    let count = 0;
    for (const _ of walkUi(s)) count++;
    lines.push(`${s.name}${s.enabled === false ? ' (disabled until a script shows it)' : ''}: ${count - 1} elements${s.ignoreInset ? ', ignores the top bar inset' : ''}`);
    const phone = layoutScreen(s, UI_DEVICES.phone);
    const desk = new Map(layoutScreen(s, UI_DEVICES.desktop).map((b) => [b.node.id, b]));
    for (const b of phone.filter((x) => x.depth <= 1).slice(0, 12)) {
      const d = desk.get(b.node.id);
      lines.push(`  ${'  '.repeat(b.depth)}${b.path} (${b.node.cls}${b.node.visible === false ? ', hidden' : ''}): phone ${r(b.x)},${r(b.y)} ${r(b.w)}×${r(b.h)}${d ? ` · desktop ${r(d.x)},${r(d.y)} ${r(d.w)}×${r(d.h)}` : ''}`);
      if (lines.length >= limit) return [...lines, '  …'];
    }
  }
  return lines;
}

/**
 * The Roblox images a UI uses, as data: URLs for the preview (the renderer only draws data: images).
 * Thumbnails come from Roblox's public thumbnails API and are cached in the project; built-in
 * rbxasset:// textures and images Roblox won't show come back null.
 */
export async function uiImages(store: UiStore, refs: string[], local?: (ref: string) => string | null): Promise<Record<string, string | null>> {
  const idOf = (ref: string) => /(?:rbxassetid:\/\/|[?&]id=)(\d+)/i.exec(ref)?.[1] ?? null;
  const out: Record<string, string | null> = {};
  const cached = (id: string) => {
    const p = store.imagePath(id);
    return existsSync(p) ? `data:image/png;base64,${readFileSync(p).toString('base64')}` : null;
  };
  const missing = new Set<string>();
  for (const ref of refs.slice(0, 300)) {
    const id = idOf(ref);
    // The project's own pictures (its icons, glyphs) need no network.
    out[ref] = id ? cached(id) : (local?.(ref) ?? null);
    if (id && !out[ref]) missing.add(id);
  }
  const ids = [...missing];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const res = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${batch.join(',')}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: Array<{ targetId: number; state: string; imageUrl: string | null }> };
      await Promise.all(
        (body.data ?? []).map(async (t) => {
          if (t.state !== 'Completed' || !t.imageUrl?.startsWith('https://')) return;
          const img = await fetch(t.imageUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
          if (!img?.ok) return;
          const p = store.imagePath(String(t.targetId));
          mkdirSync(join(p, '..'), { recursive: true });
          writeFileSync(p, Buffer.from(await img.arrayBuffer()));
        }),
      );
    } catch {
      // Offline or refused: those images show as placeholders.
    }
  }
  for (const ref of Object.keys(out)) {
    const id = idOf(ref);
    if (id && !out[ref]) out[ref] = cached(id);
  }
  return out;
}
