/**
 * El clic derecho, con el dedo: mantener pulsado medio segundo.
 *
 * ORCA tiene un menú contextual bueno —lo que se puede hacer con lo que hay
 * debajo del puntero— y en un teléfono era inalcanzable: no hay botón derecho,
 * y el `contextmenu` que algunos navegadores sacan solos no llega a un canvas
 * WebGL ni es fiable entre plataformas (iOS no lo dispara sobre nada que no
 * sea un enlace o una imagen).
 *
 * ── Qué hace, exactamente ──────────────────────────────────────────
 *
 * Escucha un `pointerdown` de dedo o lápiz, espera `HOLD_MS` sin que se mueva
 * más de `SLOP` y entonces **dispara un `contextmenu` de verdad sobre el nodo
 * que hay bajo el dedo**. Ni una acción nueva, ni una tabla de opciones
 * paralela: el mismo evento que ya escuchan el campo, el chrome de una
 * ventana, la bandeja y las listas, sobre el mismo elemento que habría
 * recibido el clic derecho. Por eso el objetivo es siempre el correcto y por
 * eso no hay dos vocabularios que mantener.
 *
 * Se cablea **por superficie**, no en el documento: cada sitio que ya ofrece
 * menú contextual llama a `longPress(root)` una vez. Un oyente global que
 * fabricara `contextmenu` en cualquier parte metería el menú donde nadie lo
 * pidió —y encima taparía el gesto nativo de seleccionar texto.
 *
 * ── Qué NO hace ────────────────────────────────────────────────────
 *
 *  - **No bloquea el desplazamiento ni el zoom.** No llama a `preventDefault`
 *    en `pointerdown` ni en `pointermove`: el navegador sigue mandando en el
 *    scroll. Si el dedo se mueve, el gesto simplemente no llega a cumplirse.
 *  - **No toca el ratón.** Sólo `touch` y `pen`; en escritorio el clic derecho
 *    sigue siendo exactamente el de antes.
 *  - **No secuestra texto ni controles.** `SKIP` deja fuera inputs, áreas de
 *    texto, editables, enlaces, `iframe`, `pre` y terminales, que es donde el
 *    gesto largo del sistema ya sirve para algo (seleccionar, copiar, el menú
 *    del navegador). Cada superficie puede añadir lo suyo.
 *  - **No abre dos menús.** Si el navegador saca su `contextmenu` nativo antes,
 *    el temporizador se cancela y manda el nativo; si el nuestro sale primero,
 *    se traga el nativo que llegue justo detrás.
 *  - **No deja un clic suelto.** Al levantar el dedo el navegador dispara un
 *    `click` sobre lo que hay debajo —que ahora es el menú— y ese clic
 *    elegiría una fila sin querer. Se traga el primero que llegue.
 *
 * Se cancela con: movimiento, un segundo dedo (pinza), `pointercancel`,
 * `pointerup`, un scroll o una rueda, y al perder el foco la ventana. Esos tres
 * últimos son un solo oyente para toda la consola, no uno por superficie.
 */

/** Cuánto hay que aguantar. Medio segundo es el gesto que todo el mundo conoce. */
export const HOLD_MS = 500;
/** Cuánto se puede mover un dedo quieto antes de que deje de estarlo. */
export const SLOP = 10;
/** Ventana en la que un `click` o un `contextmenu` posteriores son del gesto. */
const AFTER_MS = 700;
/** Cuánto dura «esto viene de un dedo» para descartar el menú nativo. */
const NATIVE_MS = 1500;

/** Dónde el gesto largo del sistema ya hace algo útil y no se le quita. */
const SKIP = 'input, textarea, select, [contenteditable], a[href], iframe, pre, code, .term, .xterm';

/** Puesto mientras despachamos, para no confundir nuestro evento con el nativo. */
let firing = false;
/**
 * Los gestos a medias, de todas las superficies.
 *
 * Un scroll, una rueda o perder la ventana deshacen cualquiera que haya en
 * vuelo, y eso no depende de dónde empezó: un oyente por superficie sobre
 * `document` sería el mismo oyente repetido tantas veces como ventanas haya
 * abiertas, y quedaría colgado al cerrarlas.
 */
const pending = new Set<() => void>();
let watching = false;
function watchOnce(): void {
  if (watching) return;
  watching = true;
  const all = () => { for (const c of [...pending]) c(); };
  document.addEventListener('scroll', all, { capture: true, passive: true });
  window.addEventListener('wheel', all, { passive: true });
  window.addEventListener('blur', all);
}
/** Hasta cuándo un `click` o un `contextmenu` cuentan como cola del gesto. */
let swallowUntil = 0;

/**
 * Un solo guardián para toda la consola: se traga el `click` que sigue al
 * dedo levantado y el `contextmenu` nativo que llega detrás del nuestro. Vive
 * en captura y sólo dentro de la ventana de tiempo, así que fuera de un gesto
 * cumplido no ve nada.
 */
let guarded = false;
function guardOnce(): void {
  if (guarded) return;
  guarded = true;
  const stop = (e: Event) => {
    if (performance.now() > swallowUntil) return;
    if (e.type === 'contextmenu' && firing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'click') swallowUntil = 0;   // uno, y sólo uno
  };
  document.addEventListener('click', stop, true);
  document.addEventListener('contextmenu', stop, true);
}

export interface LongPressOpts {
  /** Selector extra que esta superficie no quiere tocar. */
  skip?: string;
  /** Última palabra: `false` deja pasar el gesto sin abrir nada. */
  allow?: (target: HTMLElement, e: PointerEvent) => boolean;
  /** Milisegundos de aguante. Para pruebas, sobre todo. */
  holdMs?: number;
}

/**
 * Cablea el gesto en una superficie. Devuelve cómo soltarlo.
 *
 * `root` es el elemento que ya escucha `contextmenu`; el evento se despacha
 * sobre el nodo real bajo el dedo, así que sube por su misma cadena y lo
 * recoge el mismo manejador.
 */
export function longPress(root: HTMLElement, opts: LongPressOpts = {}): () => void {
  const hold = opts.holdMs ?? HOLD_MS;
  const skip = opts.skip ? `${SKIP}, ${opts.skip}` : SKIP;
  guardOnce();

  let timer = 0;
  /*
   * Los dedos que hay abajo, por id y no por cuenta.
   *
   * Una cuenta se desincroniza en cuanto un `pointerup` no llega —un
   * `touchEnd` que suelta dos dedos a la vez, un `pointercancel` que el
   * navegador no entrega— y a partir de ahí cree que sobra un dedo y no vuelve
   * a abrir un menú nunca. El `pointerdown` primario empieza secuencia y
   * limpia, así que el estado no puede quedarse colgado.
   */
  const down = new Set<number>();
  /** Cuándo tocó un dedo esta superficie por última vez. */
  let touchedAt = -Infinity;
  let start: { x: number; y: number; id: number; target: HTMLElement } | null = null;

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    start = null;
    pending.delete(cancel);
  };

  const fire = (x: number, y: number, pressed: HTMLElement) => {
    timer = 0;
    start = null;
    pending.delete(cancel);
    /*
     * El objetivo es el de la PULSACIÓN, no el que haya bajo el dedo medio
     * segundo después. Entre una cosa y la otra el mundo se mueve —una lista
     * se repinta, el campo se recoloca— y abrir el menú de lo que pasaba por
     * ahí sería abrir el menú equivocado. Sólo se vuelve a preguntar cuando el
     * elemento pulsado ya no está en el árbol.
     */
    const el = pressed.isConnected && root.contains(pressed)
      ? pressed
      : document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || !root.contains(el)) return;
    // Vibración corta, cuando el aparato la tiene: el gesto se cumple sin que
    // haya nada que mirar todavía, y sin acuse no se sabe si ha pasado.
    try { navigator.vibrate?.(8); } catch { /* el navegador puede negarse */ }
    swallowUntil = performance.now() + AFTER_MS;
    firing = true;
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, composed: true,
      clientX: Math.round(x), clientY: Math.round(y), button: 2, buttons: 2,
      view: window,
    }));
    firing = false;
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if (e.isPrimary) down.clear();
    down.add(e.pointerId);
    // Un segundo dedo es una pinza, y una pinza no es una pulsación larga.
    if (down.size > 1) { cancel(); return; }
    const t = e.target as HTMLElement | null;
    if (!t || t.closest?.(skip)) return;
    if (opts.allow && !opts.allow(t, e)) return;
    touchedAt = performance.now();
    const x = e.clientX, y = e.clientY;
    start = { x, y, id: e.pointerId, target: t };
    pending.add(cancel);
    timer = window.setTimeout(() => fire(x, y, t), hold);
  };

  const onMove = (e: PointerEvent) => {
    // La marca de «esto viene de un dedo» se refresca mientras el dedo siga
    // ahí: el menú nativo puede llegar tarde en una secuencia larga, y fuera
    // de la ventana de tiempo se colaría justo cuando ya hemos cancelado.
    if (e.pointerType !== 'mouse' && down.size) touchedAt = performance.now();
    if (!start || e.pointerId !== start.id) return;
    if (Math.abs(e.clientX - start.x) > SLOP || Math.abs(e.clientY - start.y) > SLOP) cancel();
  };

  const onUp = (e: PointerEvent) => {
    down.delete(e.pointerId);
    cancel();
  };

  /*
   * Con el dedo, este gesto es la ÚNICA puerta al menú.
   *
   * Chromium saca su propio `contextmenu` a los ~500ms de una pulsación larga,
   * y lo saca también cuando nosotros hemos cancelado a propósito: con dos
   * dedos, con un toque cancelado por el sistema, con un arrastre. Dejarlo
   * pasar sería abrir el menú justo en los casos en los que se ha decidido que
   * no. Así que dentro de una secuencia táctil el nativo se traga, y lo que
   * abre menú es el nuestro, que sí sabe si el gesto se cumplió.
   *
   * El ratón no entra aquí: `touchedAt` sólo lo mueve un dedo, y un clic
   * derecho de escritorio llega con esa marca vieja o inexistente.
   */
  const onNative = (e: Event) => {
    if (firing) return;
    cancel();
    if (performance.now() - touchedAt < NATIVE_MS) { e.preventDefault(); e.stopPropagation(); }
  };

  root.addEventListener('pointerdown', onDown, { passive: true });
  root.addEventListener('pointermove', onMove, { passive: true });
  root.addEventListener('pointerup', onUp, { passive: true });
  root.addEventListener('pointercancel', onUp, { passive: true });
  root.addEventListener('contextmenu', onNative, true);
  watchOnce();

  return () => {
    cancel();
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onUp);
    root.removeEventListener('contextmenu', onNative, true);
  };
}
