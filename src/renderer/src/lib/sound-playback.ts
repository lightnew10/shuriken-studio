import { useEffect, useState, useSyncExternalStore } from 'react';
import { rpc } from './rpc';
import { SoundPlayer, type PlayerState } from './sound-player';

/** The window's one player (the Audio page and the dashboard's Audio container share it). */
export const soundPlayer = new SoundPlayer({
  load: (name, take) => rpc<string>('audio.data', { name, variation: take || undefined }),
  create: (url) => new Audio(url),
});

/** What plays now; re-renders when a sound starts, stops or fails. */
export function useNowPlaying(): PlayerState {
  return useSyncExternalStore(
    (fn) => soundPlayer.subscribe(fn),
    () => soundPlayer.state,
  );
}

/** How far the given sound has played (0–1), every frame while it plays; 0 otherwise. */
export function usePlayProgress(name: string | null, take = 0): number {
  const now = useNowPlaying();
  const on = !!name && now.name === name && now.take === take && now.status === 'playing';
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!on) {
      setProgress(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const a = soundPlayer.audio;
      setProgress(a && a.duration ? a.currentTime / a.duration : 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return progress;
}

/** Silence when the component showing the sounds goes away (leaving the page). */
export function useStopOnLeave(): void {
  useEffect(() => () => soundPlayer.stop(), []);
}
