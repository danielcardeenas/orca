/**
 * The only zoom is the field camera.
 *
 * The console is one instrument filling the viewport: mast, HUD, dock and
 * windows are placed against the glass, and a page that scales under them
 * puts every one of them off its grid. Page zoom is not a smaller version of
 * the camera — it is the console coming apart.
 *
 * The browser offers page zoom on four separate channels, and `touch-action`
 * closes only one of them:
 *
 *   - two fingers on a touchscreen, and double tap → `touch-action`, declared
 *     on `<html>, <body>` in `tokens.css`. It used to live on `.field` alone,
 *     which is why a pinch on the HUD, a panel or a window in front scaled the
 *     whole page;
 *   - a trackpad pinch, which Chrome and Firefox report as a `wheel` with
 *     `ctrlKey` set — the same event the field reads as a camera zoom;
 *   - that same pinch under Safari/WebKit, which arrives as `gesturestart` /
 *     `gesturechange` / `gestureend` and ignores `touch-action` entirely;
 *   - ⌘+ / ⌘- / ⌘0, and the keypad's, on `keydown`.
 *
 * ## Where the barrier goes
 *
 * One listener per channel, on the document, in the **capture** phase, and
 * every one of them calls `preventDefault` and nothing else. Never
 * `stopPropagation`.
 *
 * That distinction is the whole design. Two zooms of our own ride the very
 * events suppressed here: the field camera (`field/field.ts`) and the image
 * viewer (`windows/kinds/file.ts`, which stops the pinch on its own pane on
 * purpose, so one gesture does not scale both the picture and the canvas
 * under it). Both are written in JavaScript, and a cancelled event still
 * reaches every listener — so cancelling the *default action* leaves them
 * working exactly as before. Swallowing the event instead would take the
 * viewer's zoom down with the browser's, which is why this file must never
 * grow a `stopPropagation`.
 *
 * Capture rather than bubble for the same reason in reverse: the viewer stops
 * the pinch from bubbling, so a bubble-phase listener would never see it and
 * the page would still scale over an image.
 */

/** With ⌘/Ctrl, these are the browser's zoom and never one of ours. */
const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0']);
/** The same three by position, for the keypad and for layouts where `key` differs. */
const ZOOM_CODES = new Set(['Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0']);

/** Close every native page-zoom channel. Call once, before anything mounts. */
export function lockPageZoom(): void {
  const opts = { capture: true, passive: false } as const;
  const stop = (e: Event) => e.preventDefault();

  document.addEventListener('wheel', (e) => {
    // A plain wheel is a pan, here and in the field. Only the pinch — which
    // the browser hands over as ctrl+wheel — would have scaled the page.
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }, opts);

  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, stop, opts);
  }

  document.addEventListener('keydown', (e) => {
    // ⌥ changes the chord into something else; leave it alone.
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (ZOOM_KEYS.has(e.key) || ZOOM_CODES.has(e.code)) e.preventDefault();
  }, opts);
}
