/**
 * Abrir y cerrar un detalle, en los dos paneles del HUD.
 *
 * Las reglas que se guardan aquí son las tres que un arreglo apresurado
 * rompería, y las tres se rompen en silencio: nadie ve un test rojo, se ve un
 * panel que late.
 *
 *   existe siempre   El detalle tiene que estar en el DOM aunque esté cerrado.
 *                    En AUTOMEJORA no estaba —`${open ? detailHtml(…) : ''}`—
 *                    y lo que no está no se puede descubrir con un gesto ni
 *                    recoger con otro: aparecía y desaparecía de golpe.
 *   sólo el clic     El pintado NO anima. Las dos listas se repintan con cada
 *                    empujón del hub y cada pocos segundos por los «2M»: una
 *                    fila abierta que se abriera otra vez en cada pasada sería
 *                    el panel latiendo delante de quien lo está leyendo, y una
 *                    que ya estaba abierta al montar entraría dando un
 *                    respingo.
 *   movimiento       Con `prefers-reduced-motion` no hay gesto y el detalle
 *   reducido         aparece o desaparece. Se quita el movimiento, nunca lo
 *                    que dice.
 *
 * Se leen del texto de los módulos porque son reglas de FORMA: montar los dos
 * paneles pediría un navegador, y el navegador ya los mira en
 * `hud-missions.shots.ts` y `hud-improve.shots.ts`. Lo que un ojo no ve en una
 * foto es que la animación se dispare en el repintado, que es justo esto.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ok, test, type TestModule } from './harness.ts';

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** Lo que hay entre `from` y `to` en un texto, para leer una función suelta. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`no encuentro «${a < 0 ? from : to}»`);
  return src.slice(a, b);
}

export default {
  suite: 'HUD · abrir y cerrar un detalle',
  tests: [
    test('misiones: el pintado no anima, el clic sí, y manda la intención y no el DOM', () => {
      const src = read('../src/ui/hud/missions.ts');
      const paint = between(src, 'function paintRow', 'function mountRow');
      const click = between(src, "if (t.closest('[data-peek]'))", 'return;');
      const setOpen = between(src, 'function setOpen', 'function paintRow');
      return ok('missions',
        // El repintado pasa por `setOpen` con `animate` en falso, siempre.
        paint.includes('setOpen(m, r, opened.has(r.id), false)')
        && !/setOpen\([^)]*, true\)/.test(paint)
        // El clic anima, y decide por lo que el operador quiere, no por lo que
        // el detalle enseñe a mitad de un cierre.
        && click.includes('setOpen(m, r, !opened.has(id), true)')
        // Y con movimiento reducido no hay gesto que jugar.
        && setOpen.includes('if (!animate || REDUCE.value || store.booting)'),
        `paint=${paint.includes('setOpen(m, r, opened.has(r.id), false)')} click=${click.includes('!opened.has(id), true')}`);
    }),

    test('automejora: el detalle está siempre en el DOM y sólo el clic lo anima', () => {
      const src = read('../src/ui/hud/improve.ts');
      const row = between(src, 'function rowHtml', 'export interface ImproveHandle');
      const paint = between(src, 'const fresh: HTMLElement[] = []', 'announce(shown.map');
      const gesture = between(src, 'function disclose(', '/* ── pintado');
      return ok('improve',
        // El detalle se pinta siempre; el `hidden` es lo que lo esconde.
        row.includes('${detailHtml(p, status, open)}')
        && !/\$\{open \? detailHtml/.test(row)
        // El pintado no llama nunca al gesto.
        && !paint.includes('disclose(')
        && gesture.includes('if (REDUCE.value || store.booting) { d.hidden = !on; return; }'),
        `row=${row.includes('${detailHtml(p, status, open)}')} paint=${!paint.includes('disclose(')}`);
    }),

    test('el gesto compartido devuelve la caja como la dejó el CSS, con y sin movimiento', () => {
      const src = read('../src/ui/gfx/algn.ts');
      const fn = between(src, 'export function algnDisclose', '/** La lista sin gesto');
      // Sin esto el detalle se queda con un alto en línea puesto a mano: el día
      // que su contenido creciera —una tripulación más, una respuesta más— la
      // caja seguiría midiendo lo de ayer y recortaría lo nuevo.
      const clears = [...fn.matchAll(/clearProps: 'height,opacity,visibility,overflow'/g)].length;
      return ok('algnDisclose',
        clears === 3 && fn.includes('if (reduce)') && fn.includes("gsap.killTweensOf(el)"),
        `clearProps ×${clears}`);
    }),
  ],
} satisfies TestModule;
