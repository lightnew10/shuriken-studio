/**
 * One sound at a time for the whole window: the Audio page and the dashboard's Audio container play
 * through the same player, so a new sound replaces the one playing and clicking the playing one stops it.
 * Nothing here starts on its own: only `toggle` and `play` (a click, a key) make a sound.
 * The loader and the audio element are passed in, so tests drive it without a DOM (tests/renderer).
 */

/** The part of HTMLAudioElement the player uses. */
export interface AudioLike {
  play(): Promise<void>;
  pause(): void;
  loop: boolean;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  onended: ((ev: Event) => unknown) | null;
}

/** A sound as the player needs it. `version` (its updatedAt) makes a remade sound load again. */
export interface PlayableSound {
  name: string;
  looped: boolean;
  playable: boolean;
  version?: string;
}

export interface PlayerState {
  /** The sound loading or playing, or the one that failed to (null: silence). */
  name: string | null;
  /** Its take (0: the main one, 1…: variations). */
  take: number;
  status: 'idle' | 'loading' | 'playing';
  /** Why `name` didn't play (status idle). */
  error: string | null;
}

const IDLE: PlayerState = { name: null, take: 0, status: 'idle', error: null };
/** Loaded sounds kept for quick replays while moving through the list (data URLs: a track is a few MB). */
const CACHE = 8;

export class SoundPlayer {
  private st: PlayerState = IDLE;
  private el: AudioLike | null = null;
  /** Bumped by every play and stop: a load that finishes after another click is dropped. */
  private token = 0;
  private readonly subs = new Set<() => void>();
  private readonly cache = new Map<string, string>();

  constructor(private readonly deps: { load: (name: string, take: number) => Promise<string>; create: (url: string) => AudioLike }) {}

  get state(): PlayerState {
    return this.st;
  }

  /** The element playing now (for progress and seeking), if any. */
  get audio(): AudioLike | null {
    return this.st.status === 'playing' ? this.el : null;
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** Whether this sound (and take) is the one loading or playing. */
  isOn(name: string, take?: number): boolean {
    return this.st.name === name && this.st.status !== 'idle' && (take === undefined || this.st.take === take);
  }

  /** A click or Space: stops the sound when it's the one on (any take, unless one is named), else plays it (replacing any other). */
  toggle(s: PlayableSound, take?: number): Promise<void> {
    if (this.isOn(s.name, take)) {
      this.stop();
      return Promise.resolve();
    }
    return this.play(s, take ?? 0);
  }

  /** Plays a sound from the start (or from a fraction of it), replacing whatever plays. A sound that can't play here just stops the current one. */
  async play(s: PlayableSound, take = 0, from?: number): Promise<void> {
    this.halt();
    const my = ++this.token;
    if (!s.playable) return this.set(IDLE);
    this.set({ name: s.name, take, status: 'loading', error: null });
    try {
      const key = `${s.name}#${take}#${s.version ?? ''}`;
      let url = this.cache.get(key);
      if (url === undefined) {
        url = await this.deps.load(s.name, take);
        this.cache.set(key, url);
        while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
      }
      if (my !== this.token) return;
      const a = this.deps.create(url);
      a.loop = s.looped;
      a.onended = () => {
        if (my === this.token && !a.loop) this.set(IDLE);
      };
      this.el = a;
      await a.play();
      if (my !== this.token) return a.pause();
      if (from !== undefined && from > 0 && Number.isFinite(a.duration)) a.currentTime = Math.min(0.999, from) * a.duration;
      this.set({ name: s.name, take, status: 'playing', error: null });
    } catch (e) {
      if (my !== this.token) return;
      this.halt();
      this.set({ name: s.name, take, status: 'idle', error: (e as Error).message.replace(/^Error invoking remote method 'rpc': Error: /, '') });
    }
  }

  /** Silence (leaving a page, removing the sound). */
  stop(): void {
    this.token++;
    this.halt();
    if (this.st !== IDLE) this.set(IDLE);
  }

  /** Moves the playing sound to a fraction of its length. */
  seek(fraction: number): void {
    const a = this.audio;
    if (a && Number.isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(0.999, fraction)) * a.duration;
  }

  /** Forgets a sound's loaded audio (it was remade or removed). */
  forget(name: string): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${name}#`)) this.cache.delete(k);
  }

  private halt(): void {
    if (!this.el) return;
    this.el.onended = null;
    this.el.pause();
    this.el = null;
  }

  private set(next: PlayerState): void {
    this.st = next;
    for (const fn of this.subs) fn();
  }
}
