/**
 * The ALGN panel, shared.
 *
 * The boot's "FLEET ALIGNMENT INITIATING.." modal — a lime slab, a badge with
 * the wordmark, black rows whose zipper seats from the centre out — is the
 * console's word for things lining up. The launch window borrowed it for a
 * squad coming up; the HUD's mission panel wears it for what CAPCOM is on.
 *
 * The dress is global already (`.algn`, `.algn__head`, `.algn__badge` in
 * boot.css; `.algn-row`, `.algn-bar`, `.algn-zip` in tokens.css). What used
 * to live in copies was the zipper's SVG, the badge painter and the gesture
 * itself. This is the one copy of those, with the comp's own numbers —
 * medidas fotograma a fotograma sobre `docs/offworld.mp4`, no de oído.
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

/*
 * Medido sobre el comp (`docs/offworld.mp4`, 11.5–14.0 s), fila a fila:
 *
 *   11.57  la fila 1 aparece, entera y ya estrecha (294→784 de un slab 222→858)
 *   11.65  la 2, 11.73 la 3, … 12.15 la 8   ·   una cada 83 ms, sin fundido
 *   12.57  la fila 1 se ensancha a ras (238→840) mientras su cremallera asienta
 *   12.65  la 2, 12.73 la 3, … 13.15 la 8   ·   el mismo compás, 1 s después
 *   13.82  la última llega a ras: se acabó
 *
 * Tres cosas que el comp deja claras y la versión anterior no hacía. Lo que se
 * mueve son los BORDES de la barra, no su relleno: el texto viaja con el borde
 * en vez de deslizarse dentro de una barra quieta. El movimiento es de IDA:
 * las filas llegan estrechas y acaban a ras, no salen y vuelven — la escalera
 * que se ve a media animación es la onda, no un estado. Y la cremallera va
 * enganchada a ese mismo compás, no a uno propio.
 */

/** El compás del comp: una fila cada 83 ms, al llegar y al asentar. */
export const ALGN_BEAT = 0.083;
/** Lo que las filas esperan estrechas antes de que la onda llegue a la primera. */
export const ALGN_HOLD = 1.0;
/** Lo que tarda una fila en ensancharse hasta ras. */
export const ALGN_SEAT = 0.66;
/** Cuánto entra cada lado al llegar, en proporción del ancho: 72 px de 636. */
export const ALGN_INSET = '11.3%';
/** El paso del pulso: un empujón hacia dentro, sin llegar a la sangría de entrada. */
const ALGN_STEP = '4%';
/** Lo que tarda la lista en recogerse hasta la cabecera, y en volver a abrirse. */
export const ALGN_SHUT = 0.42;
/** Lo que tarda una fila en descubrirse de un lado al otro (`algnRowSweep`). */
export const ALGN_SWEEP = 0.34;
/** Lo que tarda una fila en irse: se estrecha y se apaga, más rápido que al llegar. */
const ALGN_GO = 0.26;
/** Todo el barrido de salida, por deprisa que se pliegue una lista larga. */
const ALGN_GO_ALL = 0.28;

/**
 * A row arriving: it appears whole and narrow on the comp's 83 ms beat, waits
 * while the rest land, and then widens to flush as its zipper seats.
 *
 * El fundido de 0.1 s no está en el comp —allí la fila es un corte seco, que a
 * 24 fps es lo mismo— pero a 60 Hz un corte se lee como un parpadeo. No hay
 * deslizamiento vertical: el comp no lo tiene.
 *
 * `reduce` lands the end state.
 */
export function algnRowIn(row: HTMLElement, i: number, reduce: boolean): void {
  if (reduce) { gsap.set(row, { autoAlpha: 1, y: 0, marginLeft: 0, marginRight: 0 }); return; }
  gsap.set(row, { autoAlpha: 0, y: 0, marginLeft: ALGN_INSET, marginRight: ALGN_INSET });
  gsap.to(row, { autoAlpha: 1, duration: 0.1, ease: 'none', delay: i * ALGN_BEAT });
  // Arranca despacio y se planta de golpe al final, como en el comp.
  gsap.to(row, {
    marginLeft: 0, marginRight: 0,
    duration: ALGN_SEAT, ease: 'power2.in', delay: ALGN_HOLD + i * ALGN_BEAT,
  });
}

/**
 * Una fila que vuelve: entra en la fila que le toca y nada más.
 *
 * La onda —estrecha, espera, ensancha, cremallera— es la alineación del panel,
 * y una alineación se juega una vez. Plegar el panel y devolverlo no es alinear
 * nada: son filas que ya estaban, y repetirles el segundo y medio de gesto
 * convierte un plegado en una espera. Queda el compás, que es lo que dice «esto
 * llega ahora, y en este orden», y se acabó.
 */
export function algnRowBack(row: HTMLElement, i: number, reduce: boolean): void {
  gsap.killTweensOf(row);
  gsap.set(row, { autoAlpha: reduce ? 1 : 0, y: 0, marginLeft: 0, marginRight: 0 });
  if (reduce) return;
  gsap.to(row, { autoAlpha: 1, duration: 0.1, ease: 'none', delay: i * ALGN_BEAT });
}

/**
 * Una fila que se descubre: el barrido de AUTOMEJORA.
 *
 * El mismo compás del comp y el mismo principio —lo que se mueve es un BORDE,
 * y la fila llega entera detrás de él— pero no la onda: aquí no hay sangría,
 * ni espera de un segundo, ni cremallera. La fila se abre de izquierda a
 * derecha en su turno y ya está.
 *
 * Que no sea el mismo gesto es el asunto: el panel de misiones habla de la
 * FLOTA y se alinea; esta sección habla del INSTRUMENTO y por eso lleva color,
 * silueta y ahora también entrada propios. Dos paneles con el mismo gesto se
 * leen como el mismo panel.
 *
 * El `clip-path` se retira al acabar: dejarlo puesto recortaría el detalle de
 * la fila el día que alguien lo abriera.
 */
export function algnRowSweep(row: HTMLElement, i: number, reduce: boolean): void {
  gsap.killTweensOf(row);
  if (reduce) { gsap.set(row, { autoAlpha: 1, clearProps: 'clipPath' }); return; }
  gsap.fromTo(row,
    { autoAlpha: 1, clipPath: 'inset(0 100% 0 0)' },
    {
      clipPath: 'inset(0 0% 0 0)', duration: ALGN_SWEEP, ease: 'power2.out',
      delay: i * ALGN_BEAT, onComplete: () => gsap.set(row, { clearProps: 'clipPath' }),
    });
}

/** Cuándo asienta la cremallera de la fila `i` de una tanda que acaba de llegar. */
export const algnZipDelay = (i: number): number => ALGN_HOLD + i * ALGN_BEAT;

/**
 * A row whose line changed: one step in and back — the wave for one — so the
 * eye is told where to look without the panel breathing on its own.
 *
 * Sólo se matan los tweens del paso. `killTweensOf(row)`, a secas, mataba
 * también la entrada de `algnRowIn` —que tarda más de un segundo en
 * asentarse—, y una fila recién llegada que cambiaba de fase en ese hueco se
 * quedaba para siempre a media opacidad y estrecha: un blanco del alto de una
 * fila con su fantasma dentro. La entrada y el paso comparten propiedad, así
 * que el paso espera a que la entrada acabe en vez de pisarla.
 */
export function algnRowPulse(row: HTMLElement, reduce: boolean): void {
  if (reduce) return;
  if (gsap.isTweening(row)) return;
  gsap.killTweensOf(row, 'marginLeft,marginRight');
  gsap.timeline()
    .to(row, { marginLeft: ALGN_STEP, marginRight: ALGN_STEP, duration: 0.3, ease: 'power2.inOut' })
    .to(row, { marginLeft: 0, marginRight: 0, duration: 0.36, ease: 'power2.inOut' });
}

/** Un gesto en marcha, para quien tenga que cortarlo. Un timeline, sin decirlo. */
export interface AlgnGesture { kill(): void }

/**
 * El panel que se recoge.
 *
 * Plegar era un corte: la lista pasaba a `display: none` y el panel daba un
 * salto hasta su cabecera. Aquí es el gesto de llegada al revés y en la mitad
 * de tiempo —cerrar se hace más deprisa que abrir—: las filas se van
 * estrechándose, de abajo arriba, y la lista se cierra tras ellas como una
 * persiana. Lo que se mueve sigue siendo lo mismo que en el comp, los BORDES
 * de la barra y el alto de la caja; nada se desliza dentro de nada.
 *
 * El barrido de salida tiene tope: una lista de treinta misiones plegada al
 * compás de 83 ms serían dos segundos y medio de espera para esconder algo, y
 * lo que se pide al plegar es que desaparezca.
 *
 * `done` corre al final —el `display: none` de verdad es cosa de quien llama,
 * que es quien sabe si el operador ya ha vuelto a desplegar— y también cuando
 * no hay gesto que jugar. Devuelve el gesto para poder cortarlo.
 */
export function algnFold(
  list: HTMLElement, rows: readonly HTMLElement[], reduce: boolean, done: () => void,
): AlgnGesture | null {
  gsap.killTweensOf(list);
  if (reduce || !rows.length) { algnFoldClear(list); done(); return null; }
  const tl = gsap.timeline({ onComplete: () => { algnFoldClear(list); done(); } });
  tl.to(rows, {
    autoAlpha: 0, marginLeft: ALGN_INSET, marginRight: ALGN_INSET,
    duration: ALGN_GO, ease: 'power2.in',
    stagger: { amount: Math.min(rows.length * ALGN_BEAT, ALGN_GO_ALL), from: 'end' },
  }, 0);
  // La persiana arranca con las primeras filas ya en marcha: si esperase a la
  // última, plegar serían dos gestos seguidos en vez de uno.
  tl.fromTo(list, { height: list.offsetHeight, overflow: 'hidden' },
    { height: 0, duration: ALGN_SHUT, ease: 'power2.inOut' }, 0.08);
  return tl;
}

/**
 * El panel que vuelve: la caja crece hasta el alto que la lista pide, al ritmo
 * al que se llena.
 *
 * Que crezca es lo que dice que hay más panel que antes —y lo que empuja a lo
 * que tenga debajo en vez de saltárselo—, pero no puede ir por detrás de las
 * filas: una fila ya encendida asomando fuera de una caja a medio abrir es
 * justo lo que se acaba de pedir ver, recortado. Por eso la duración sale del
 * número de piezas: la persiana va siempre un poco por delante del compás.
 *
 * Se mide en `auto` cada vez porque la lista crece y encoge entre un pliegue y
 * el siguiente, y arranca donde esté: plegar y desplegar a media animación es
 * un clic que el operador puede dar, y volver a empezar desde cero sería un
 * salto.
 */
export function algnUnfold(list: HTMLElement, parts: number, reduce: boolean): void {
  gsap.killTweensOf(list);
  const from = list.style.height ? list.offsetHeight : 0;
  if (reduce) { algnFoldClear(list); return; }
  gsap.set(list, { height: 'auto' });
  const to = list.offsetHeight;
  gsap.fromTo(list, { height: from, overflow: 'hidden' }, {
    height: to,
    // Por delante del compás, no a la par: la caja termina de abrirse antes de
    // que se encienda la última fila, así que lo que se llena es un hueco que
    // ya existe. `power3.out` se planta casi entera en el primer tercio.
    duration: Math.max(ALGN_SHUT * 0.6, Math.max(0, parts - 1) * ALGN_BEAT * 0.6),
    ease: 'power3.out',
    onComplete: () => algnFoldClear(list),
  });
}

/** La lista sin gesto encima y sin rastro de él: como la dejó el CSS. */
export function algnFoldClear(list: HTMLElement): void {
  gsap.killTweensOf(list);
  gsap.set(list, { clearProps: 'height,overflow' });
}

/** Seat the zipper to `scale` (0 empty … 1 full), from the centre, the boot's way. */
export function algnZipTo(zip: HTMLElement, scale: number, reduce: boolean, delay = 0): void {
  gsap.killTweensOf(zip);
  if (reduce) { gsap.set(zip, { scaleX: scale, transformOrigin: 'center center' }); return; }
  gsap.fromTo(zip, { scaleX: 0, transformOrigin: 'center center' },
    { scaleX: scale, duration: 0.74, ease: 'power2.inOut', delay });
}
