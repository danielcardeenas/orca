/**
 * Qué proyectos exigen disciplina de squad para que alguien les escriba.
 *
 * La política acordada es que todo cambio en el repositorio de ORCA pase por
 * un squad FORGE. Hasta ahora eso dependía de la disciplina del que lanza:
 * nada impedía un lanzamiento suelto sobre el repo que se saltara el brief de
 * fronteras, la exclusión de la publicación automática (`hub/publisher.ts`) y
 * el modo de permisos —las tres cosas que ya cuelgan del prefijo del squad—.
 * Una política que sólo existe en la cabeza de quien lanza no es una política;
 * es una costumbre, y se rompe el día que hay prisa.
 *
 * ── Por qué una marca por proyecto, y no el repositorio en duro ──────
 *
 * Escribirla contra ORCA obliga a tocar código la primera vez que se quiera la
 * misma disciplina en otro repositorio, y ya hay más proyectos en el mapa. Una
 * marca por proyecto cuesta lo mismo hoy y nada la segunda vez: se añade una
 * línea al fichero.
 *
 *   ~/.orca/hub/project-policy.json
 *   { "projects": { "<id o ruta del proyecto>": { "forgeOnly": true } } }
 *
 * La clave puede ser el `projectId` (`<máquina>/<slug>`) o la RUTA del
 * proyecto. Las dos, porque las dos aparecen: el id es lo que viaja en los
 * comandos, y la ruta es lo único que una persona reconoce y lo único que
 * sigue valiendo cuando el mismo repositorio está clonado en dos Macs con
 * `machineId` distintos.
 *
 * ── Nace APAGADA, y encenderla es un gesto aparte ───────────────────
 *
 * **Esto no escribe nada nunca.** Sin fichero, no hay marcas: la puerta queda
 * abierta para todos los proyectos y ningún lanzamiento cambia de
 * comportamiento por el hecho de que este código exista.
 *
 * La primera versión sembraba el fichero al arrancar con la raíz de este
 * checkout, y nacía con `forgeOnly: true`. Parecía cómodo y era una trampa: el
 * 2026-09-13 el hub del operador se relevó con ese código y se encontró la
 * puerta armada sobre su propio repositorio sin que nadie lo hubiera decidido,
 * y habría vuelto a pasar el día que la rama aterrizara en `main`, porque el
 * fichero sembrado seguía en disco. **Aceptar el código y encender la puerta
 * tienen que ser dos actos separados**, y el arranque no puede ser ninguno de
 * los dos: un efecto que ocurre por arrancar no lo decide nadie.
 *
 * Encenderla es escribir el fichero a mano, una vez, a sabiendas:
 *
 *   $ cat > ~/.orca/hub/project-policy.json <<'JSON'
 *   { "projects": { "/ruta/al/proyecto": { "forgeOnly": true } } }
 *   JSON
 *
 * y reiniciar el hub, que es cuando se lee. Quitarla es lo simétrico: borrar
 * la entrada, o el fichero entero.
 *
 * La marca sólo AÑADE restricción. Esa es la razón de que sea segura donde
 * está: nadie gana nada marcando un proyecto ajeno, igual que nadie gana nada
 * declarándose sintético (`shared/synthetic.ts`).
 */

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { forgeGateRefusal, isForgeSquad, spawnWrites } from '../shared/forge.ts';
import { HUB_DIR } from './persist.ts';

/**
 * El único nombre que se lee. Exacto y sin variantes a propósito: el fichero
 * del incidente del 13-09 quedó guardado al lado con otro nombre
 * (`…json.incidente-2026-09-13.evidencia`) y es evidencia, no configuración.
 * Nada aquí debe volver a leerlo.
 */
export const PROJECT_POLICY_FILE = 'project-policy.json';

/** Lo que se puede pedir de un proyecto. Hoy una cosa; el fichero admite más. */
export interface ProjectRules {
  /** Escribir aquí exige un squad FORGE. Leer, nunca. */
  forgeOnly?: boolean;
}

/** Una ruta se compara resuelta y sin barra final; un id, tal cual. */
function key(v: string): string {
  const t = v.trim();
  if (!t) return '';
  if (!t.includes(sep) || !t.startsWith(sep)) return t;
  const r = resolve(t);
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r;
}

export class ProjectPolicy {
  private rules = new Map<string, ProjectRules>();

  /**
   * Lee el fichero si lo hay, y no lo crea si no lo hay.
   *
   * Un fichero que falta, uno vacío, uno ilegible y `file: null` (un hub en
   * proceso, una prueba) acaban todos en el mismo sitio: sin marcas, la puerta
   * abierta. Es la dirección segura del error — equivocarse deja pasar
   * lanzamientos, nunca los bloquea sin que nadie lo haya pedido.
   */
  constructor(file: string | null) {
    if (file) this.load(file);
  }

  private load(file: string): void {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, unknown> };
      for (const [k, v] of Object.entries(parsed.projects ?? {})) {
        if (typeof v !== 'object' || v === null) continue;
        const forgeOnly = (v as ProjectRules).forgeOnly === true;
        const kk = key(k);
        if (kk) this.rules.set(kk, { forgeOnly });
      }
    } catch { /* un fichero ilegible no tumba el hub; deja la puerta abierta */ }
  }

  /** Lo que hay, para enseñarlo. */
  list(): Record<string, ProjectRules> {
    return Object.fromEntries([...this.rules.entries()].map(([k, v]) => [k, { ...v }]));
  }

  /**
   * ¿Este proyecto exige FORGE para escribir? Se busca por id y por ruta: al
   * comando sólo le llega el id, pero la marca pudo escribirse con cualquiera
   * de los dos.
   */
  forgeOnly(project: { id?: string | null; path?: string | null } | null | undefined): boolean {
    if (!project) return false;
    for (const ref of [project.id, project.path]) {
      if (typeof ref !== 'string' || !ref) continue;
      if (this.rules.get(key(ref))?.forgeOnly === true) return true;
    }
    return false;
  }
}

/** Dónde vive por defecto. */
export function projectPolicyFile(dir: string = HUB_DIR): string {
  return resolve(dir, PROJECT_POLICY_FILE);
}

/**
 * La puerta, entera y pura: el rechazo, o null si el lanzamiento pasa.
 *
 * Tres reglas, en este orden, y el orden es la mitad del diseño:
 *
 *  1. Un proyecto sin marca no exige nada. La disciplina se pide donde se
 *     acordó, no en toda la flota.
 *  2. Un lanzamiento que no puede escribir pasa SIEMPRE (`spawnWrites`).
 *     Con esto, la pregunta de «¿un cambio que sólo toca documentación pasa
 *     por la puerta?» se disuelve: la puerta no mira ficheros, mira la
 *     capacidad de escribir, que sí se sabe antes de lanzar.
 *  3. Escribir exige el prefijo del squad. `isForgeSquad` cubre también a los
 *     hijos: el collector le pone al hijo el squad del padre
 *     (`planChild`, src/collector/spawns.ts: `who.squad ?? req.squad`), así
 *     que un miembro creado por un líder FORGE hereda la pertenencia y no
 *     necesita un caso aparte.
 *
 * Alcance temporal: se aplica a partir del lanzamiento, no del squad. Un squad
 * antiguo sin el prefijo que siga vivo sobre un proyecto marcado verá
 * rechazados sus lanzamientos hijos con escritura, y el rechazo le dice cómo
 * seguir. Es lo correcto: eximir a los vivos sería una puerta que se abre por
 * antigüedad, y lo que se quería cerrar es exactamente el lanzamiento suelto.
 */
export function forgeGate(
  cmd: { k: string; squad?: string | null; review?: boolean; permissionMode?: string | null },
  project: { id?: string | null; path?: string | null; code?: string | null } | null | undefined,
  policy: Pick<ProjectPolicy, 'forgeOnly'>,
): string | null {
  if (cmd.k !== 'spawn') return null;
  if (!policy.forgeOnly(project ?? null)) return null;
  if (!spawnWrites(cmd)) return null;
  if (isForgeSquad(cmd.squad)) return null;
  return forgeGateRefusal(project?.code || project?.id || 'this project', cmd.squad ?? null);
}
