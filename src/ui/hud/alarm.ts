/**
 * Alarm treatment.
 *
 * An agent crossing into `blocked` pulses an amber ring around the whole
 * screen once. The link coming back flashes lime, as the comp does when a
 * signal locks. Neither repeats; an alarm that keeps ringing is noise.
 */

import gsap from 'gsap';
import { store } from '../store.ts';
import { dur, EASE, REDUCE, T } from '../motion.ts';

export function mountAlarm(): () => void {
  const ring = document.createElement('div');
  ring.className = 'fx-alarm';
  document.body.appendChild(ring);
  const flash = document.querySelector<HTMLElement>('[data-alarm-flash]');
  let last = 0;

  const off = store.on((e) => {
    if (REDUCE.value) return;
    if (e.k === 'alarm' && e.on) {
      /*
       * Nada del arnés timbra. El anillo es una interrupción de pantalla
       * entera —el gesto más caro que hace la consola— y una máquina de
       * fixture bloquea cada pocos segundos mientras dure la prueba: el
       * anillo dejaría de significar «alguien te necesita» para significar
       * «hay pruebas corriendo». La pregunta sigue contando en el mástil y
       * en la cola, que es donde se mira. Ver `shared/synthetic.ts`.
       */
      if (store.fromHarness(store.knownAgent(e.agentId))) return;
      // Coalesce: ten agents blocking in one patch is one ring, not ten.
      const now = performance.now();
      if (now - last < 600) return;
      last = now;
      gsap.killTweensOf(ring);
      gsap.fromTo(ring, { opacity: 1, boxShadow: 'inset 0 0 0 0 rgba(245,165,36,0.9)' },
        { opacity: 0, boxShadow: 'inset 0 0 90px 12px rgba(245,165,36,0.0)', duration: dur(T.fly), ease: EASE.out });
    }
    if (e.k === 'link' && e.up && flash) {
      gsap.killTweensOf(flash);
      gsap.fromTo(flash, { opacity: 0.55 }, { opacity: 0, duration: dur(T.wipe), ease: EASE.out });
    }
  });
  return () => { off(); ring.remove(); };
}
