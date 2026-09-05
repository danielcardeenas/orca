/**
 * Fullscreen.
 *
 * The console is the whole viewport by contract; the browser's chrome is the
 * one thing left that is not an instrument. This asks the platform for the
 * screen and reports back, so the mast button, the `Z` key and `/full` all
 * read the same state. The field resizes itself through its own
 * ResizeObserver, so nothing here touches the renderer.
 *
 * Safari still needs the webkit prefix on the document side. Inside an
 * installed PWA with `display: fullscreen` the request is a no-op and the
 * state reads as on from the start.
 */

type Doc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type Root = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const doc = document as Doc;
const root = document.documentElement as Root;

export function fullscreenOn(): boolean {
  return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement)
    || window.matchMedia('(display-mode: fullscreen)').matches;
}

export function fullscreenAvailable(): boolean {
  return !!(root.requestFullscreen ?? root.webkitRequestFullscreen)
    && (doc.fullscreenEnabled ?? true);
}

/** Toggle. Resolves to the state after the request settled. */
export async function toggleFullscreen(): Promise<boolean> {
  try {
    if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
      await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.());
    } else {
      await (root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen?.());
    }
  } catch {
    // Refused outside a user gesture, or by the platform. The listener
    // below reports whatever really happened.
  }
  return fullscreenOn();
}

/** Called with the new state on every change; returns the unsubscribe. */
export function onFullscreen(fn: (on: boolean) => void): () => void {
  const h = () => fn(fullscreenOn());
  document.addEventListener('fullscreenchange', h);
  document.addEventListener('webkitfullscreenchange', h);
  const mq = window.matchMedia('(display-mode: fullscreen)');
  mq.addEventListener('change', h);
  return () => {
    document.removeEventListener('fullscreenchange', h);
    document.removeEventListener('webkitfullscreenchange', h);
    mq.removeEventListener('change', h);
  };
}
