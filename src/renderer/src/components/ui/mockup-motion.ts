import { EASE, commas, type PreviewStep } from '../../lib/mockup-board';

/**
 * Plays a mockup's motion on a drawn device (a UiCanvas inside `host`): the elements are found by their
 * data-ui-id, so nothing about the drawing changes when nothing plays. Returns the function that stops it
 * and puts everything back.
 */
export function playPreview(host: HTMLElement, steps: PreviewStep[]): () => void {
  const anims: Animation[] = [];
  const timers: number[] = [];
  const undo: Array<() => void> = [];
  const el = (id: number) => host.querySelector<HTMLElement>(`[data-ui-id="${id}"]`);
  const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
  for (const s of steps) {
    if (s.kind === 'animate') {
      const e = el(s.id);
      if (!e || typeof e.animate !== 'function') continue;
      const before = e.style.transformOrigin;
      e.style.transformOrigin = s.origin;
      undo.push(() => (e.style.transformOrigin = before));
      anims.push(e.animate(s.keyframes, s.options));
    } else if (s.kind === 'count') {
      const text = el(s.id)?.firstElementChild as HTMLElement | null;
      if (!text) continue;
      const html = text.innerHTML;
      undo.push(() => (text.innerHTML = html));
      // The number it counts from shows until its moment comes.
      text.textContent = commas(s.from);
      later(s.delay, () => {
        const t0 = performance.now();
        const tick = () => {
          const f = s.duration > 0 ? Math.min(1, (performance.now() - t0) / s.duration) : 1;
          const eased = 1 - (1 - f) * (1 - f); // Quad Out, as Motion.count
          text.textContent = commas(s.from + (s.to - s.from) * eased);
          if (f < 1) timers.push(window.requestAnimationFrame(tick) as unknown as number);
        };
        tick();
      });
    } else if (s.kind === 'shimmer') {
      const e = el(s.id);
      if (!e) continue;
      const band = document.createElement('div');
      band.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:inherit';
      const light = document.createElement('div');
      light.style.cssText = 'position:absolute;top:0;bottom:0;width:45%;background:linear-gradient(100deg,transparent,rgba(255,255,255,0.45),transparent);transform:translateX(-120%)';
      band.appendChild(light);
      e.appendChild(band);
      undo.push(() => band.remove());
      for (let i = 0; i < s.times; i++) later(s.delay + i * (s.every + 700), () => anims.push(light.animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(260%)' }], { duration: 700, easing: EASE.quadInOut })));
    } else if (s.kind === 'cover') {
      const device = host.querySelector<HTMLElement>('[data-ui-device]');
      if (!device) continue;
      const cover = document.createElement('div');
      cover.style.cssText = 'position:absolute;inset:0;background:#000;pointer-events:none;z-index:50;opacity:0';
      device.appendChild(cover);
      undo.push(() => cover.remove());
      const frames: Keyframe[] =
        s.style === 'wipe'
          ? [{ opacity: 1, transform: 'translateX(-100%)' }, { opacity: 1, transform: 'translateX(0%)', offset: 0.5 }, { opacity: 1, transform: 'translateX(100%)' }]
          : s.style === 'iris'
            ? [{ opacity: 1, clipPath: 'circle(0% at 50% 50%)' }, { opacity: 1, clipPath: 'circle(75% at 50% 50%)', offset: 0.5 }, { opacity: 1, clipPath: 'circle(0% at 50% 50%)' }]
            : [{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }];
      anims.push(cover.animate(frames, { duration: s.half * 2, delay: s.delay, easing: 'linear' }));
    }
  }
  return () => {
    for (const a of anims) a.cancel();
    for (const t of timers) {
      window.clearTimeout(t);
      window.cancelAnimationFrame(t);
    }
    for (const u of undo.reverse()) u();
  };
}
