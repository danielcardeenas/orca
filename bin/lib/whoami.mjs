/**
 * Quién soy: el id de sesión del agente que está llamando a este comando.
 *
 * Todo lo que un agente manda por ORCA —un mensaje, una pregunta, un
 * artefacto— se cuelga de un agente, y el único que puede decir de cuál es el
 * proceso que lo ejecuta. Cuando no lo dice, el collector cae en una
 * heurística razonable y equivocada: el agente vivo del proyecto con la
 * actividad más reciente. Con un agente por repo acierta siempre; con cinco en
 * el mismo checkout acierta por casualidad.
 *
 * Se midió el 2026-09-12, y el resultado es la razón de que este archivo
 * exista: dos artefactos publicados por un agente aparecieron en la consola
 * colgando de otros dos, uno de ellos su propio líder. Lo mismo explicaba los
 * indicativos cruzados en los mensajes de esa tarde.
 *
 * El orden va de la evidencia más fuerte a la más débil, y para en la primera
 * que sirva:
 *
 *  1. `--agent`, que lo dice el llamante. Lo resuelve cada comando, no esto.
 *  2. `CLAUDE_SESSION_ID`, cuando el CLI la exporta. Hoy, dentro de un agente
 *     de ORCA, viene vacía — pero es la respuesta correcta si aparece.
 *  3. `ORCA_PANE`, que pone el collector al lanzar a cualquier proveedor
 *     (`commands.ts`, `capcom.ts`, `worker-handoff.ts`). Es `orca-<sessionId>`,
 *     y por eso se valida: un pane puede llamarse de otras formas.
 *  4. La cadena de procesos. Último recurso, para un agente que ORCA no lanzó
 *     —el que el operador abre a mano en su repo—, donde no hay ninguna de las
 *     dos variables. Se sube de padre en padre buscando un `--session-id` en el
 *     argv; un proveedor que no use esa bandera simplemente no aparece, y
 *     entonces esto devuelve null sin romper nada.
 *
 * Y null es una respuesta legítima: significa «no lo sé», y el collector sigue
 * teniendo su heurística. Lo que no hace este módulo es inventar un id.
 */

import { execFileSync } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cuántos padres se suben antes de rendirse. Un agente está a dos o tres. */
const MAX_HOPS = 8;

/** Un id de sesión, o null. */
export function sessionId(env = process.env, { walk = true } = {}) {
  // Lo que el CLI exporta se acepta tal cual: es suyo, y otro proveedor puede
  // no usar un uuid. La forma sólo se exige donde hace falta (el pane).
  const direct = String(env.CLAUDE_SESSION_ID ?? '').trim();
  if (direct) return direct;

  const pane = clean(String(env.ORCA_PANE ?? '').replace(/^orca-/, ''));
  if (pane) return pane;

  return walk ? fromProcessTree() : null;
}

function clean(value) {
  const s = String(value ?? '').trim();
  return UUID.test(s) ? s : null;
}

/**
 * Sube por los padres buscando el `--session-id` con el que se lanzó el CLI.
 *
 * Es el argv de un proceso real que existe ahora mismo, no una ruta ni un
 * nombre adivinados en un texto: si ese proceso es nuestro padre, su sesión es
 * la nuestra. Todo error se traga a propósito — esto es el último recurso de
 * un comando que tiene otra cosa que hacer.
 */
function fromProcessTree() {
  let pid = process.ppid;
  for (let hop = 0; hop < MAX_HOPS && pid > 1; hop++) {
    let line = '';
    try {
      line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
    const cut = line.match(/^\s*(\d+)\s+([\s\S]*)$/);
    if (!cut) return null;
    const found = clean(cut[2].match(/--session-id[= ]+([0-9a-fA-F-]{36})/)?.[1]);
    if (found) return found;
    pid = Number(cut[1]);
  }
  return null;
}
