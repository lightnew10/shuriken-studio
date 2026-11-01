import type { ToolOutput } from '../capabilities/tool-registry';

/** What a rebuild of the place's animations came to. */
export interface AnimationRebuild {
  /** Studio's animations were rebuilt from the project's clips (ReplicatedStorage.ShurikenAnimations). */
  updated: boolean;
  /** The clips Studio has now. */
  built?: string[];
  failed?: Array<{ name: string; error: string }>;
  /** One sentence for whoever asked: what happened, or why Studio wasn't updated. */
  note: string;
}

/**
 * Keeps the place's animations in step with the project's clip files. Clips change in the files without
 * the place knowing — Kiln's clips coming in while the user animates, an agent's kiln_clip, an import —
 * and the place only changes when the animations are built again (the same build animation_build runs).
 * Changes that arrive close together share one build; a change that arrives during a build gets one more
 * after it; and a caller that needs to know can wait for the result. Never throws.
 */
export class AnimationRebuilder {
  private running: Promise<AnimationRebuild> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly d: {
      /** Whether the place can be built into right now (a project is open and Studio is connected). */
      ready: () => { ok: boolean; reason?: string };
      /** The build itself: the animation_build tool. */
      build: () => Promise<ToolOutput>;
    },
  ) {}

  /** Rebuild soon: changes close together share one build. */
  schedule(delayMs = 1500): void {
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.now();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Rebuild now (joins a build under way, which then runs once more so nothing is missed). */
  now(): Promise<AnimationRebuild> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ready = this.d.ready();
    if (!ready.ok) {
      return Promise.resolve({ updated: false, note: `Studio wasn't updated (${ready.reason ?? 'it is not connected'}): world/Animations.luau is current and builds with the next animation_build or world_rebuild.` });
    }
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<AnimationRebuild> {
    let last: AnimationRebuild;
    do {
      this.again = false;
      last = await this.once();
    } while (this.again);
    return last;
  }

  private async once(): Promise<AnimationRebuild> {
    try {
      return summarize(await this.d.build());
    } catch (e) {
      return { updated: false, note: `Rebuilding the animations in Studio failed: ${(e as Error).message}` };
    }
  }
}

/** animation_build's answer as an AnimationRebuild. */
export function summarize(out: ToolOutput): AnimationRebuild {
  const data = (out.data ?? null) as { built?: Array<{ name: string }>; failed?: Array<{ name: string; error: string }>; note?: string; uploads?: { uploaded?: Array<{ name: string }>; pending?: string[]; stillUploading?: string[]; failed?: Array<{ name: string; error: string }>; note?: string } } | null;
  const text = out.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim();
  if (!data) return { updated: false, note: text.slice(0, 400) || 'the build gave no answer' };
  const built = (data.built ?? []).map((b) => b.name);
  const failed = data.failed ?? [];
  const cleared = /no animations left/i.test(data.note ?? '');
  const updated = built.length > 0 || cleared;
  const note = updated
    ? `Studio's animations are rebuilt (${built.length} clip${built.length === 1 ? '' : 's'} in ReplicatedStorage.ShurikenAnimations)${failed.length ? `; ${failed.length} did not build: ${failed.map((f) => `${f.name} (${f.error.slice(0, 80)})`).join('; ')}` : ''}.`
    : `Studio wasn't updated: ${data.note ?? (failed.length ? failed.map((f) => `${f.name}: ${f.error.slice(0, 100)}`).join('; ') : 'nothing was built')}`;
  // Creature clips the build uploaded (the place carries their asset ids), or could not.
  const up = data.uploads;
  const said = up
    ? [
        up.uploaded?.length ? `uploaded ${up.uploaded.length} creature clip${up.uploaded.length === 1 ? '' : 's'} (${up.uploaded.map((u) => u.name).join(', ')})` : '',
        up.pending?.length || up.stillUploading?.length ? `${(up.pending?.length ?? 0) + (up.stillUploading?.length ?? 0)} still uploading (picked up on their own)` : '',
        up.failed?.length ? `${up.failed.length} could not upload (${up.failed.map((f) => `${f.name}: ${f.error.slice(0, 80)}`).join('; ')})` : '',
        up.note ?? '',
      ].filter(Boolean)
    : [];
  return { updated, built, ...(failed.length ? { failed } : {}), note: said.length ? `${note} ${said.join('; ')}.` : note };
}
