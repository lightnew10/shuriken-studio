import type { CoreEventMap, CoreEventName } from '@shared/events';

type Listener<K extends CoreEventName> = (payload: CoreEventMap[K]) => void;

/**
 * In-process typed event bus. Core services publish here; the RPC bridge forwards every event
 * to the UI; services may also subscribe to each other's events (e.g. the orchestrator reacts to
 * escalation responses).
 */
export class EventBus {
  private readonly listeners = new Map<CoreEventName, Set<Listener<any>>>();
  private readonly anyListeners = new Set<(channel: CoreEventName, payload: unknown) => void>();

  on<K extends CoreEventName>(channel: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  onAny(fn: (channel: CoreEventName, payload: unknown) => void): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  emit<K extends CoreEventName>(channel: K, payload: CoreEventMap[K]): void {
    for (const fn of this.listeners.get(channel) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        // A faulty listener must never break the publisher.
        console.error(`[events] listener for ${channel} threw`, e);
      }
    }
    for (const fn of this.anyListeners) {
      try {
        fn(channel, payload);
      } catch (e) {
        console.error('[events] any-listener threw', e);
      }
    }
  }
}
