/**
 * The ALGN panel, shared.
 *
 * The boot's "FLEET ALIGNMENT INITIATING.." modal — a lime slab, a badge with
 * the wordmark, black rows whose zipper seats from the centre out — is the
 * console's word for things lining up. The launch window borrowed it for a
 * squad coming up; the HUD's task panel wears it for what CAPCOM is on.
 *
 * The dress is global already (`.algn`, `.algn__head`, `.algn__badge` in
 * boot.css; `.algn-row`, `.algn-bar`, `.algn-zip` in tokens.css). What used
 * to live in copies was the zipper's SVG, the badge painter and the gesture
 * itself. This is the one copy of those, with the boot's numbers.
 */

import gsap from 'gsap';
import { drawBits, inlineORCA, sizeOf } from './logo.ts';

/** The comp's zipper: three lime bars that read as a plug seating. */
export const ZIP_SVG = `<svg viewBox="0 0 200 16" preserveAspectRatio="none">`
  + `<rect x="52" y="0" width="36" height="7" fill="#c0f94a"/>`
  + `<rect x="112" y="0" width="36" height="7" fill="#c0f94a"/>`
  + `<rect x="70" y="9" width="60" height="7" fill="#c0f94a"/>`
  + `</svg>`;

/** Paint a bitmap wordmark on a canvas, sized to fit, at device resolution. */
export function paintBits(
  canvas: HTMLCanvasElement, bits: string[], cell: number, color: string, glow = false,
): void {
  const { w, h } = sizeOf(bits, cell);
  const pad = cell * 0.5;
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round((w + pad * 2) * dpr);
  canvas.height = Math.round((h + pad * 2) * dpr);
  canvas.style.width = w + pad * 2 + 'px';
  canvas.style.height = h + pad * 2 + 'px';
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w + pad * 2, h + pad * 2);
  if (glow) {
    ctx.shadowColor = 'rgba(255,255,255,0.55)';
    ctx.shadowBlur = cell * 1.4;
  }
  drawBits(ctx, bits, pad, pad, cell, color, 0.08);
}

/** The badge in the panel's head: the inline wordmark, bone on ink. */
export function paintBadge(canvas: HTMLCanvasElement, cell = 2.2): void {
  paintBits(canvas, inlineORCA(), cell, '#e8ece4');
}

/* ── The gesture ──────────────────────────────────────────────────── */

/** The boot's flush inset; the staircase is measured from it. */
export const ALGN_PAD = 10;

/**
 * A row arriving: flush in on a 44 ms stagger, then the staircase (inset more
 * on the left than on the right), then flush again. Rows in the boot never
 * zoom on the way out, so neither does this. `reduce` lands the end state.
 */
export function algnRowIn(row: HTMLElement, i: number, reduce: boolean): void {
  if (reduce) { gsap.set(row, { autoAlpha: 1, y: 0, paddingLeft: ALGN_PAD, paddingRight: ALGN_PAD }); return; }
  gsap.set(row, { autoAlpha: 0, y: 14, paddingLeft: ALGN_PAD, paddingRight: ALGN_PAD });
  gsap.to(row, { autoAlpha: 1, y: 0, duration: 0.26, ease: 'power2.out', delay: i * 0.044 });
  gsap.to(row, {
    paddingLeft: ALGN_PAD + Math.min(i, 6) * 14, paddingRight: ALGN_PAD + Math.min(i, 6) * 10,
    duration: 0.46, ease: 'power2.inOut', delay: 0.34 + i * 0.032,
  });
  gsap.to(row, { paddingLeft: ALGN_PAD, paddingRight: ALGN_PAD, duration: 0.4, ease: 'power2.inOut', delay: 1.1 + i * 0.026 });
}

/**
 * A row whose line changed: one step out and back — the staircase for one —
 * so the eye is told where to look without the panel breathing on its own.
 */
export function algnRowPulse(row: HTMLElement, reduce: boolean): void {
  if (reduce) return;
  gsap.killTweensOf(row);
  gsap.timeline()
    .to(row, { paddingLeft: ALGN_PAD + 14, paddingRight: ALGN_PAD + 10, duration: 0.3, ease: 'power2.inOut' })
    .to(row, { paddingLeft: ALGN_PAD, paddingRight: ALGN_PAD, duration: 0.36, ease: 'power2.inOut' });
}

/** Seat the zipper to `scale` (0 empty … 1 full), from the centre, the boot's way. */
export function algnZipTo(zip: HTMLElement, scale: number, reduce: boolean, delay = 0): void {
  gsap.killTweensOf(zip);
  if (reduce) { gsap.set(zip, { scaleX: scale, transformOrigin: 'center center' }); return; }
  gsap.fromTo(zip, { scaleX: 0, transformOrigin: 'center center' },
    { scaleX: scale, duration: 0.74, ease: 'power2.inOut', delay });
}
