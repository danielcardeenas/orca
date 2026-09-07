/**
 * Máquinas sintéticas: el arnés, marcado en el protocolo.
 *
 * `test/fake-collector.ts` habla el protocolo entero —levanta proyectos,
 * agentes que trabajan y agentes que ESCALAN preguntas— y el hub no tenía
 * forma de distinguir una pregunta de mentira de una de verdad. Arrancado
 * contra el hub real, sus agentes de fixture le pasaron al CAPCOM real nueve
 * minutos de preguntas inventadas ("¿subimos three.js a 0.185?") y se llevaron
 * su contexto por delante. El arnés cuesta lo que cuesta desarrollar; no puede
 * costar además el mando de la flota.
 *
 * La marca la pone la propia máquina en su `hello`. Que sea una declaración
 * del collector y no una deducción del hub es lo que la hace segura: sólo
 * quita permisos —nadie gana nada declarándose falso— y sigue en pie aunque
 * alguien arranque el mock a mano contra el puerto que sea, que es
 * exactamente cómo ocurrió.
 *
 * La regla es una cuarentena simétrica, no un filtro sobre CAPCOM: lo
 * sintético y lo real no se hablan en ninguna dirección. Un `say` que sale del
 * hub acaba pegado en un pane de tmux de verdad, y da igual si lo disparó una
 * escalación o un mensaje de un escuadrón que por casualidad se llama igual.
 * Dentro de su mundo el arnés conserva todo: sus escalaciones siguen llegando
 * a la consola —que es lo que hay que poder mirar y fotografiar— y llegarían
 * a un CAPCOM sintético si algún día el mock levanta uno.
 */

import type { Machine } from './types.ts';

/** ¿Es esta máquina parte del arnés? Sin máquina, no: el mundo real es el defecto. */
export function isSynthetic(m: Pick<Machine, 'synthetic'> | undefined | null): boolean {
  return m?.synthetic === true;
}

/**
 * ¿Viven las dos en el mismo mundo? Es la única pregunta que hace falta para
 * enrutar: dos sintéticas sí, dos reales sí, una de cada no.
 */
export function sameWorld(
  a: Pick<Machine, 'synthetic'> | undefined | null,
  b: Pick<Machine, 'synthetic'> | undefined | null,
): boolean {
  return isSynthetic(a) === isSynthetic(b);
}

/** Lo que se anota en el feed la primera vez que una máquina del arnés pregunta. */
export function syntheticNote(machineId: string): string {
  return `máquina sintética ${machineId}: sus preguntas se quedan en la cola del humano, no van al mando`;
}
