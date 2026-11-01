/**
 * "What works right now" lines about 3D modeling and Kiln, from plain facts so they can be tested: every
 * agent's context carries the first (the planner reads it when it plans models), the director's
 * state the second. Core reads the facts (the modeling engine's status, whether Kiln answers).
 */

export interface ModelingFacts {
  ready: boolean;
  detail: string;
  /** Models open at once. */
  max: number;
}

/** Kiln's state; null when this setup has no Kiln at all (tests, Kiln disabled by the environment). */
export interface KilnFacts {
  /** Kiln answers, so kiln_request (its copilot) works. */
  available: boolean;
  detail: string;
  /** Kiln is installed but not running, and Shuriken starts it when a model is requested. */
  startable?: boolean;
  /** Kiln builds that run at once (Shuriken's queue; the rest wait their turn). */
  buildsAtOnce?: number;
  /** The queue now: builds running and waiting, and what they are expected to take from here. */
  queue?: { running: number; queued: number; minutes?: number; usd?: number };
}

/** Everything a game needs modeled: Kiln builds all of it (a run once sent only "creatures and characters" there, and 15 mech parts were hand-written bpy). */
export const KILN_BUILDS = 'props, vehicles, characters, creatures, weapons, map pieces, set dressing';

/**
 * The modeling line of an agent's context: whether modeling can run, that Kiln builds every model
 * while it can be reached (hand-modeling in Blender is the fallback), and that each model or family
 * has its own Kiln project, so different models' work runs in parallel (planners once assumed "Kiln
 * is used by one agent at a time": false).
 */
export function modelingEnvironment(m: ModelingFacts, kiln: KilnFacts | null): string[] {
  if (!m.ready) return [`3D modeling: NOT available on this PC (${m.detail}) — plan no modeling work; use Creator Store models instead.`];
  const head = `3D modeling: ready (${m.detail}).`;
  if (kiln?.available || kiln?.startable) {
    const state = kiln.available ? "Kiln's copilot is AVAILABLE" : `Kiln isn't running (${kiln.detail}) and Shuriken starts it with the first kiln_request`;
    return [
      `${head} ${state}: Kiln builds EVERY model of the game (${KILN_BUILDS}). The modeler asks for the result with kiln_request (what it is, what it is for in the game, how it is seen, the must-haves) and brings Kiln's baked export in; nobody hand-models in Blender while Kiln can be reached. Every model, and every family of parts that must fit together, is its own Kiln project, so they build in parallel (up to ${kiln.buildsAtOnce ?? m.max} at once; the rest queue; one request per project at a time): plan them as separate tasks that don't wait for each other, except a family that is fitted against another one.`,
    ];
  }
  const blender = `Every model has its own Blender, so modelers for different models run in parallel (up to ${m.max} at once): plan them as separate tasks that don't wait for each other.`;
  if (kiln) {
    return [
      `${head} Kiln can't be reached (${kiln.detail}): kiln_request fails until the user starts Kiln (the Kiln page, the flame in the top bar), so for now modelers build in Blender themselves (the fallback: skills blender-props and blender-creatures) and say so. Still plan model tasks as requests for a result (what the game needs), so Kiln takes them once it runs. ${blender}`,
    ];
  }
  return [`${head} Kiln's copilot is not available in this setup, so modelers build in Blender themselves (skills blender-props and blender-creatures). ${blender}`];
}

/** The director's line about Kiln, so it answers "have Kiln make it" with what is true right now. */
export function kilnDirectorLine(kiln: KilnFacts | null): string {
  if (!kiln) return "Kiln (the user's Blender copilot app): not available in this setup.";
  if (kiln.available) {
    const q = kiln.queue;
    const busy = q && q.running + q.queued > 0 ? ` Building now: ${q.running} running, ${q.queued} waiting their turn${q.minutes ? ` (about ${q.minutes} min${q.usd ? ` and $${q.usd.toFixed(2)} of usage` : ''} to finish them, an estimate; count it into any time you give)` : ''}.` : '';
    return `Kiln (the user's Blender copilot app): running — its copilot builds every model for the team (it researches, models, textures, rigs and animates), and the user watches it in the Kiln dock.${busy}`;
  }
  if (kiln.startable) return `Kiln (the user's Blender copilot app): not running (${kiln.detail}) — Shuriken starts it in the background when the team needs a model.`;
  return `Kiln (the user's Blender copilot app): NOT running (${kiln.detail}) — Kiln work needs it; the user starts it from the Kiln page (the flame in the top bar).`;
}
