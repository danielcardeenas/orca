/**
 * Marcar —no borrar— las lápidas que dejó el arnés en el archivo del hub.
 *
 *   npx tsx tools/archive-mark.ts            cuenta y no toca nada
 *   npx tsx tools/archive-mark.ts --apply    añade las marcas que falten
 *   --file=<archived.jsonl>                  por defecto $ORCA_HOME/hub/archived.jsonl
 *
 * Desde el 2026-09-13 una lápida guarda `synthetic` cuando su máquina lo
 * declaró (`shared/archive.ts`). Las de antes no: el campo no existía, y para
 * cuando alguien suma el archivo la máquina del fixture hace días que no está
 * en ningún mundo que se pueda consultar. En este hub eran 299 de 509, o sea
 * que cualquier cuenta agregada sobre el archivo —coste por proyecto,
 * terminados contra muertos, duración media— se hacía sobre una población
 * mitad inventada.
 *
 * Marca y no borra, y eso decide la forma: el archivo es append-only y sus
 * líneas no se reescriben nunca (`Unarchived` ya era una corrección hecha
 * añadiendo), así que esto AÑADE una línea `{id, at, synthetic, mark}` por
 * cada lápida del fixture. Nada se pierde, `loadArchived` las devuelve
 * marcadas, y quien quiera la serie completa la tiene entera en el mismo
 * fichero. Borrarlas habría cerrado la puerta a comprobar esto mismo más
 * adelante.
 *
 * Quién es del fixture: `isFixtureMachineId` de `test/fake-collector.ts` —su
 * flota y sus réplicas, sacadas de la misma regla y no de una lista escrita
 * aquí—, más cualquier lápida que YA venga marcada, que no se vuelve a
 * marcar. Es el mismo criterio que usó `tools/journal-sanitize.ts` con el
 * diario, y por la misma razón: en una lápida vieja sólo queda el id de la
 * máquina.
 *
 * Escribe mientras el hub escribe: cada línea entra con un `appendFileSync`
 * en O_APPEND al final del fichero, que es exactamente lo que hace el hub, y
 * ninguna de las dos toca lo ya escrito. Una segunda pasada no encuentra nada
 * que marcar.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isArchivedAgent, isSyntheticMark, isUnarchived, syntheticMark } from '../src/shared/archive.ts';
import { isFixtureMachineId } from '../test/fake-collector.ts';

export interface MarkReport {
  file: string;
  applied: boolean;
  /** Líneas del fichero, tal cual. */
  lines: number;
  /** Lápidas vigentes tras reproducir el archivo (lápida pone, `undo` quita). */
  live: number;
  /** De ésas, cuántas son del arnés y cuántas reales, ya contando las marcas. */
  synthetic: number;
  real: number;
  /** Las que había que marcar y no lo estaban. */
  marked: string[];
  /** Marcas que ya estaban en el fichero antes de esta pasada. */
  alreadyMarked: number;
  /** Lápidas del arnés por máquina. */
  byMachine: Record<string, number>;
  unparsed: number;
}

/**
 * Qué hay que marcar, leyendo el fichero entero.
 *
 * Reproduce el archivo igual que `PersistStore.loadArchived`: una lápida pone,
 * un `undo` quita, una marca corrige. Sólo se marcan lápidas VIGENTES: una que
 * un `undo` levantó ya no existe para nadie, y marcarla escribiría una
 * corrección sobre algo que no se lee.
 */
export function plan(text: string): Omit<MarkReport, 'file' | 'applied'> {
  const live = new Map<string, { machineId: string; synthetic: boolean }>();
  const marks = new Set<string>();
  let lines = 0;
  let unparsed = 0;
  let alreadyMarked = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    let v: unknown;
    try { v = JSON.parse(line); } catch { unparsed += 1; continue; }
    if (isUnarchived(v)) { live.delete(v.id); continue; }
    if (isSyntheticMark(v)) {
      alreadyMarked += 1;
      marks.add(v.id);
      const t = live.get(v.id);
      if (t) t.synthetic = true;
      continue;
    }
    if (isArchivedAgent(v)) {
      live.set(v.id, {
        machineId: typeof v.machineId === 'string' ? v.machineId : '',
        synthetic: v.synthetic === true || marks.has(v.id),
      });
    }
  }

  const marked: string[] = [];
  const byMachine: Record<string, number> = {};
  let synthetic = 0;
  for (const [id, t] of live) {
    const fixture = t.synthetic || (t.machineId !== '' && isFixtureMachineId(t.machineId));
    if (!fixture) continue;
    synthetic += 1;
    byMachine[t.machineId || '(sin máquina)'] = (byMachine[t.machineId || '(sin máquina)'] ?? 0) + 1;
    if (!t.synthetic) marked.push(id);
  }

  return { lines, live: live.size, synthetic, real: live.size - synthetic, marked, alreadyMarked, byMachine, unparsed };
}

export function run(file: string, apply: boolean, now = Date.now()): MarkReport {
  if (!existsSync(file)) throw new Error(`no existe: ${file}`);
  const report = { file, applied: false, ...plan(readFileSync(file, 'utf8')) };
  if (!apply || report.marked.length === 0) return report;
  // Una sola escritura en O_APPEND, como las del hub: ni se reescribe una
  // línea ni se abre el fichero para nada más que añadir al final.
  appendFileSync(file, report.marked.map((id) => JSON.stringify(syntheticMark(id, now))).join('\n') + '\n');
  return { ...report, applied: true };
}

function main(argv: string[]): void {
  const apply = argv.includes('--apply');
  const arg = argv.find((a) => a.startsWith('--file='));
  const home = process.env['ORCA_HOME'] || join(homedir(), '.orca');
  const file = arg ? arg.slice('--file='.length) : join(home, 'hub', 'archived.jsonl');

  const r = run(file, apply);
  console.log(`${r.file}`);
  console.log(`  líneas ${r.lines}${r.unparsed ? ` (${r.unparsed} ilegibles, intactas)` : ''}`);
  console.log(`  lápidas vigentes ${r.live}: ${r.real} reales, ${r.synthetic} del arnés`);
  for (const [m, n] of Object.entries(r.byMachine).sort((a, b) => b[1] - a[1])) console.log(`    ${m}: ${n}`);
  console.log(`  ya marcadas ${r.alreadyMarked}`);
  console.log(r.applied
    ? `  MARCADAS ahora ${r.marked.length}; no se borró ninguna línea`
    : r.marked.length === 0
      ? '  nada que marcar'
      : `  faltan ${r.marked.length} por marcar — repite con --apply`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
