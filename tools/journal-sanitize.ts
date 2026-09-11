/**
 * Saneado único del diario: aparta lo que un hub de pruebas escribió en el
 * del hub real.
 *
 *   npx tsx tools/journal-sanitize.ts            cuenta y no toca nada
 *   npx tsx tools/journal-sanitize.ts --apply    respaldo, y después aparta
 *   --dir=<journal>                              por defecto $ORCA_HOME/hub/journal
 *
 * Hasta el 2026-09-11 un hub de pruebas (`ORCA_HARNESS`) arrancado sin su
 * propio `ORCA_HOME` escribía su diario en ~/.orca/hub/journal, y el diario no
 * miraba la marca `synthetic` de la máquina. Las dos cosas están cerradas
 * —`harnessHomeRefusal` en src/hub/harness.ts y el filtro de `createJournal`—,
 * pero lo que ya estaba escrito seguía ahí: rotados enteros de 18.000
 * entradas del mock, y el informe de AUTOMEJORA contándolas como flota.
 *
 * Qué hace, en este orden, y por qué el orden:
 *
 *  1. RESPALDO antes de tocar nada, en `<hub>/journal-aparte/<fecha>/respaldo`:
 *     copia de cada rotado y de state.json. El vivo es un enlace duro al
 *     fichero de siempre, no una copia: el hub real lo sigue escribiendo, y
 *     tras el cambio el enlace se queda con TODO lo que el hub escribió en él,
 *     incluido lo que entrase mientras esto trabajaba. Una copia hecha un
 *     instante antes no tendría eso.
 *  2. Cada fichero se reescribe sin las entradas del fixture, a un temporal y
 *     con renombrado: un lector nunca ve un fichero a medias.
 *  3. Lo apartado va, línea a línea y sin cambiar un byte, a
 *     `<fecha>/apartadas.jsonl`. Nada se borra.
 *  4. Para el vivo, lo que el hub añadiera al fichero viejo durante el cambio
 *     se relee del enlace y se reparte igual. El hub abre el fichero por ruta
 *     en cada escritura, así que después del renombrado ya escribe en el nuevo.
 *  5. `informe.json` con los conteos de antes y después, por fichero y por
 *     máquina.
 *
 * Qué se aparta: las entradas cuyo `machineId` es una máquina del fixture de
 * `test/fake-collector.ts` (`isFixtureMachineId`: su flota y sus réplicas). No
 * una lista escrita aquí, y no la marca `synthetic`: una entrada vieja sólo
 * guarda el id, y la marca vivía en una máquina que ya no está en ningún
 * mundo. Una línea que no se entiende se queda donde estaba.
 *
 * Una segunda pasada no encuentra nada que apartar y no crea otro respaldo si
 * no hay nada que hacer; un directorio de salida que ya existe no se pisa.
 */

import {
  appendFileSync, closeSync, copyFileSync, constants, existsSync, fstatSync, linkSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { JOURNAL_FILE } from '../src/hub/journal.ts';

/** Los rotados, con la misma forma que `Journal` (src/hub/journal.ts). */
const ROTATED = /^journal\.(\d{8}-\d{6})\.(\d+)\.jsonl$/;
const STATE_FILE = 'state.json';

export interface FileCount {
  name: string;
  before: number;
  kept: number;
  setAside: number;
  /** Líneas que no son JSON: se quedan donde estaban. */
  unparsed: number;
}

export interface SanitizeReport {
  dir: string;
  /** Dónde quedaron respaldo, apartadas e informe. Null en seco. */
  out: string | null;
  applied: boolean;
  files: FileCount[];
  before: number;
  kept: number;
  setAside: number;
  unparsed: number;
  setAsideByMachine: Record<string, number>;
  keptByMachine: Record<string, number>;
  /** Entradas que el hub escribió en el vivo mientras se cambiaba. */
  lateTail: number;
}

/** Los ficheros del diario, del más viejo al vivo, como los lee `Journal`. */
export function journalFiles(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const seq = (n: string): number => Number(ROTATED.exec(n)?.[2] ?? -1);
  const out = names.filter((n) => ROTATED.test(n)).sort((a, b) => seq(a) - seq(b));
  if (names.includes(JOURNAL_FILE)) out.push(JOURNAL_FILE);
  return out;
}

interface Split {
  kept: string[];
  aside: string[];
  unparsed: number;
  keptBy: Record<string, number>;
  asideBy: Record<string, number>;
}

/** Reparte líneas completas (sin el `\n`) entre las que se quedan y las apartadas. */
export function split(lines: readonly string[], isFixture: (machineId: string) => boolean): Split {
  const s: Split = { kept: [], aside: [], unparsed: 0, keptBy: {}, asideBy: {} };
  for (const line of lines) {
    if (!line.trim()) continue;
    let machineId: unknown = null;
    try { machineId = (JSON.parse(line) as { machineId?: unknown }).machineId ?? null; }
    catch { s.unparsed += 1; s.kept.push(line); continue; }
    const key = typeof machineId === 'string' ? machineId : '(sin máquina)';
    if (typeof machineId === 'string' && isFixture(machineId)) {
      s.aside.push(line);
      s.asideBy[key] = (s.asideBy[key] ?? 0) + 1;
    } else {
      s.kept.push(line);
      s.keptBy[key] = (s.keptBy[key] ?? 0) + 1;
    }
  }
  return s;
}

function add(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

const body = (lines: readonly string[]): string => (lines.length ? `${lines.join('\n')}\n` : '');

/** Lo que haya en `file` a partir de `from`, sólo hasta el último salto de línea. */
function readTail(file: string, from: number): { lines: string[]; bytes: number } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= from) return { lines: [], bytes: 0 };
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], bytes: 0 };
    return { lines: buf.subarray(0, end).toString('utf8').split('\n'), bytes: end + 1 };
  } finally { closeSync(fd); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function sanitizeJournal(o: {
  dir: string;
  isFixture: (machineId: string) => boolean;
  /** Sin esto, sólo cuenta. */
  apply?: boolean;
  /** Dónde dejar respaldo, apartadas e informe. Por defecto, junto al diario. */
  out?: string;
  now?: Date;
  /** Cuánto se espera a que el hub termine una escritura en vuelo sobre el vivo. */
  settleMs?: number;
}): Promise<SanitizeReport> {
  const names = journalFiles(o.dir);
  const report: SanitizeReport = {
    dir: o.dir, out: null, applied: false, files: [],
    before: 0, kept: 0, setAside: 0, unparsed: 0, setAsideByMachine: {}, keptByMachine: {}, lateTail: 0,
  };
  const tally = (name: string, s: Split): FileCount => {
    const c = { name, before: s.kept.length + s.aside.length, kept: s.kept.length, setAside: s.aside.length, unparsed: s.unparsed };
    report.files.push(c);
    report.before += c.before; report.kept += c.kept; report.setAside += c.setAside; report.unparsed += c.unparsed;
    add(report.setAsideByMachine, s.asideBy); add(report.keptByMachine, s.keptBy);
    return c;
  };

  // En seco, o sin nada que apartar: se cuenta y se sale sin escribir un byte.
  const dry = names.map((name) => ({ name, s: split(readFileSync(join(o.dir, name), 'utf8').split('\n'), o.isFixture) }));
  if (!o.apply || dry.every(({ s }) => s.aside.length === 0)) {
    for (const { name, s } of dry) tally(name, s);
    return report;
  }

  const stamp = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const out = o.out ?? join(dirname(o.dir), 'journal-aparte', stamp);
  if (existsSync(out)) throw new Error(`${out} ya existe: no se pisa un saneado anterior`);
  const backup = join(out, 'respaldo');
  mkdirSync(backup, { recursive: true });
  report.out = out;

  /* 1. Respaldo, entero, antes de reescribir nada. */
  for (const name of [...names, STATE_FILE]) {
    const src = join(o.dir, name);
    if (!existsSync(src)) continue;
    if (name === JOURNAL_FILE) linkSync(src, join(backup, name));
    else {
      copyFileSync(src, join(backup, name), constants.COPYFILE_EXCL);
      if (statSync(src).size !== statSync(join(backup, name)).size) throw new Error(`respaldo incompleto de ${name}`);
    }
  }

  /* 2 y 3. Cada fichero, sin el fixture; lo apartado, a su sitio. */
  const aside = join(out, 'apartadas.jsonl');
  writeFileSync(aside, '', { flag: 'wx' });
  for (const name of names) {
    const file = join(o.dir, name);
    const live = name === JOURNAL_FILE;
    // El vivo se lee por el enlace: es el mismo fichero, y lo seguirá siendo
    // cuando el renombrado deje la ruta apuntando al nuevo.
    const source = live ? join(backup, name) : file;
    const text = readFileSync(source);
    // Del vivo, sólo líneas completas: una a medio escribir se recoge después.
    const end = live ? text.lastIndexOf(0x0a) + 1 : text.length;
    const s = split(text.subarray(0, end).toString('utf8').split('\n'), o.isFixture);
    const tmp = `${file}.saneado`;
    writeFileSync(tmp, body(s.kept), { flag: 'wx' });
    appendFileSync(aside, body(s.aside));
    renameSync(tmp, file);
    const c = tally(name, s);

    if (!live) continue;
    /* 4. Lo que el hub escribió en el fichero viejo mientras tanto. */
    let read = end;
    for (let i = 0; i < 3; i += 1) {
      await sleep(o.settleMs ?? 250);
      const t = readTail(source, read);
      if (!t.bytes) continue;
      read += t.bytes;
      const late = split(t.lines, o.isFixture);
      appendFileSync(file, body(late.kept));
      appendFileSync(aside, body(late.aside));
      c.before += late.kept.length + late.aside.length; c.kept += late.kept.length; c.setAside += late.aside.length; c.unparsed += late.unparsed;
      report.before += late.kept.length + late.aside.length; report.kept += late.kept.length;
      report.setAside += late.aside.length; report.unparsed += late.unparsed;
      report.lateTail += late.kept.length + late.aside.length;
      add(report.setAsideByMachine, late.asideBy); add(report.keptByMachine, late.keptBy);
    }
  }

  report.applied = true;
  /* 5. El informe, junto a lo apartado. */
  writeFileSync(join(out, 'informe.json'), `${JSON.stringify({ at: (o.now ?? new Date()).toISOString(), ...report }, null, 2)}\n`, { flag: 'wx' });
  return report;
}

/* ── CLI ──────────────────────────────────────────────────────────── */

const runDirectly = (process.argv[1] ?? '').endsWith('journal-sanitize.ts');
if (runDirectly) {
  const { isFixtureMachineId } = await import('../test/fake-collector.ts');
  const dirFlag = process.argv.find((a) => a.startsWith('--dir='));
  const home = process.env['ORCA_HOME'] ?? join(homedir(), '.orca');
  const dir = dirFlag ? dirFlag.slice('--dir='.length) : join(home, 'hub', 'journal');
  const r = await sanitizeJournal({ dir, isFixture: isFixtureMachineId, apply: process.argv.includes('--apply') });
  for (const f of r.files) {
    console.log(`${f.name.padEnd(40)} ${String(f.before).padStart(6)} → ${String(f.kept).padStart(6)} quedan · ${String(f.setAside).padStart(6)} apartadas${f.unparsed ? ` · ${f.unparsed} ilegibles` : ''}`);
  }
  console.log(`total: ${r.before} entradas · ${r.kept} quedan · ${r.setAside} apartadas · ${r.unparsed} ilegibles`);
  console.log(`apartadas por máquina: ${JSON.stringify(r.setAsideByMachine)}`);
  console.log(`quedan por máquina: ${JSON.stringify(r.keptByMachine)}`);
  if (r.applied) console.log(`hecho: respaldo, apartadas e informe en ${r.out}${r.lateTail ? ` (${r.lateTail} escritas durante el cambio, repartidas igual)` : ''}`);
  else console.log(r.setAside ? 'en seco: nada tocado. --apply para apartar.' : 'nada que apartar.');
}
