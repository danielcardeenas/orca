/**
 * El handshake que no termina.
 *
 * Cuando el hub rechaza el token, la consola no tiene nada que enseñar ni
 * nada que mandar: lo que hubiera en pantalla sería el último mundo que
 * alcanzó a ver, congelado, y cada tecla iría a un socket que se cierra solo.
 * Antes esto se notaba de la peor manera posible —un ciclo de reconexión cada
 * pocos segundos, con su destello lima y su sonido de enlace, como si algo
 * bueno estuviera pasando— y no había forma de leer en la pantalla que el
 * problema era el token.
 *
 * Así que la consola se retira detrás del beat de handshake del arranque
 * (`boot.ts`, escena `pass`): el mismo rótulo y los mismos ocho bloques, con
 * las mismas clases, encendiéndose en dos ráfagas. Con una diferencia que es
 * el mensaje entero: **no completa**. En el arranque los ocho bloques dan
 * paso al barrido lima que dice «aceptado»; aquí se apagan y vuelven a
 * empezar, para siempre. Un handshake que no cierra es exactamente lo que
 * está pasando.
 *
 * No hay texto de error, ni campo, ni botón. No es una pantalla de login:
 * nada de lo que el operador escriba aquí puede arreglar esto —el token vive
 * en el disco del hub y en el `localStorage` de la consola— y ofrecer una
 * casilla sería prometer una salida que no existe. Tampoco se dice qué falló:
 * quien mira una consola ajena no tiene por qué enterarse de cómo se
 * autentica ésta. Lo que sí hace es tragarse el teclado y el ratón, para que
 * no queden órdenes escribiéndose contra un enlace que no existe.
 *
 * Se va sola: el cliente reintenta con backoff (`net/client.ts`), y en cuanto
 * el hub conteste una sola trama la pantalla se retira sin ceremonia.
 */

import gsap from 'gsap';
import { store } from './store.ts';

/** Los ocho bloques del beat, como en el arranque. */
const BLOCKS = 8;

export function mountHandshake(): () => void {
  const root = document.createElement('div');
  root.className = 'hs';
  root.hidden = true;
  root.innerHTML = `
    <p class="px px--title chroma">HANDSHAKE</p>
    <div class="pass hs__pass">
      ${Array.from({ length: BLOCKS }).map(() =>
        `<span class="glyph" data-hs-glyph><i></i><i></i><i></i><i></i></span>`).join('')}
    </div>
  `;
  document.body.appendChild(root);
  const glyphs = [...root.querySelectorAll<HTMLElement>('[data-hs-glyph]')];

  let loop: gsap.core.Timeline | null = null;
  let on = false;

  function start() {
    if (on) return;
    on = true;
    root.hidden = false;
    /*
     * Las dos ráfagas del arranque —cuatro rápidas, una pausa, cuatro más—
     * y luego a oscuras. Sin el barrido lima: ese es el que dice que el
     * saludo cerró, y aquí no cierra.
     */
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.5 });
    glyphs.forEach((g, i) => {
      const at = i < 4 ? i * 0.13 : 0.5 + (i - 4) * 0.1;
      tl.fromTo(g, { autoAlpha: 0, scale: 0.7 },
        { autoAlpha: 1, scale: 1, duration: 0.12, ease: 'back.out(2)' }, at);
    });
    tl.to(glyphs, { autoAlpha: 0, duration: 0.2 }, 1.5);
    loop = tl;
  }

  function stop() {
    if (!on) return;
    on = false;
    loop?.kill();
    loop = null;
    gsap.set(glyphs, { clearProps: 'all' });
    root.hidden = true;
  }

  /*
   * Nada se escribe detrás de esto. Los atajos de la consola escuchan en
   * `window` sin captura (`main.ts`), así que uno en captura sobre el mismo
   * blanco corre antes y los deja sin evento. El ratón lo para el propio
   * panel, que cubre la pantalla entera.
   */
  const swallow = (e: Event) => {
    if (!on) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    window.addEventListener(type, swallow, true);
  }

  const off = store.on((e) => { if (e.k === 'auth') (e.ok ? stop() : start()); });
  if (!store.authed()) start();

  return () => {
    off();
    stop();
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      window.removeEventListener(type, swallow, true);
    }
    root.remove();
  };
}
