/**
 * Whether a 3D view is worth drawing: its window shows (not minimized, covered by other windows or a project
 * window in the back: the page is hidden then) and its element is on screen with a size (not scrolled away,
 * not in a hidden container). A view draws nothing while it can't be seen; `onShow` lets it draw what it
 * missed when it shows again.
 */
export interface Visibility {
  visible(): boolean;
  dispose(): void;
}

export function watchVisibility(el: HTMLElement, onShow: () => void): Visibility {
  // Until the observer's first report (right after observe), the element counts as on screen.
  let onScreen = true;
  const io = new IntersectionObserver((entries) => {
    const was = onScreen;
    onScreen = entries.some((e) => e.isIntersecting);
    if (onScreen && !was && !document.hidden) onShow();
  });
  io.observe(el);
  const onPage = () => {
    if (onScreen && !document.hidden) onShow();
  };
  document.addEventListener('visibilitychange', onPage);
  return {
    visible: () => onScreen && !document.hidden,
    dispose: () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onPage);
    },
  };
}
