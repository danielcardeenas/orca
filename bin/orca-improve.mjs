#!/usr/bin/env node
/**
 * orca-improve — cómo un agente revisor archiva lo que propone.
 *
 * Hermano de orca-tell: un agente no tiene socket ni token del hub, tiene un
 * sistema de ficheros. Archivar una propuesta es dejar un fichero en
 * `<project>/.orca/improve/` y esperar a que el collector lo suba y escriba la
 * respuesta al lado.
 *
 *   orca-improve report --review rev_abc --file proposals.json
 *   cat proposals.json | orca-improve report --review rev_abc
 *   orca-improve report --review rev_abc --json '{"proposals":[…]}'
 *
 * El fichero es `{"proposals": [ … ]}`, o directamente el array. Cada
 * propuesta:
 *
 *   key         slug estable de la IDEA, minúsculas-con-guiones
 *   title       la idea en pocas palabras
 *   area        ui | usability | performance | reliability | cost | workflow | other
 *   kind        "observed" (EXIGE evidence) o "hypothesis" (EXIGE hypothesis)
 *   summary     una o dos frases
 *   detail      lo largo (opcional)
 *   evidence    array de cifras medidas, citadas como vinieron
 *   hypothesis  lo que estás suponiendo, en claro
 *   question    lo que sólo el operador puede decidir (opcional)
 *   impact      low | medium | high — SÓLO con fundamento
 *   effort      low | medium | high — SÓLO con fundamento
 *
 * Espera la respuesta y la imprime: cuántas entraron, cuántas se fundieron con
 * una propuesta que ya existía, y el motivo exacto de cada una que se rechazó.
 * Un motivo es algo que puedes corregir y volver a mandar en el mismo turno.
 *
 * Exit codes:
 *   0  archivado (al menos una propuesta entró o se fundió)
 *   1  mal uso, o JSON inválido
 *   2  ORCA no está corriendo aquí — dilo en tu resumen
 *   3  el hub rechazó el informe entero (el motivo va impreso)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { waitFor } from './lib/wait-for.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { sessionId } from './lib/whoami.mjs';

const argv = process.argv.slice(2);

/** Cuánto se espera al collector antes de rendirse. Un tic suyo es 1s. */
const ACK_TIMEOUT_MS = 30_000;

function usage(code = 1) {
  process.stdout.write(`orca-improve — file what an ORCA self-review proposes

  orca-improve report --review <review_id> [--file <path> | --json <text>]

  -r, --review <id>   the review you are answering (from your brief)
  -f, --file <path>   JSON file: {"proposals": [ … ]} or a bare array
  -j, --json <text>   the same JSON, inline
  -p, --project <dir> project root (default: git root, else cwd)
      --agent <id>    your session id, so ORCA attributes it right
      --json-out      machine-readable result

  With neither --file nor --json, the JSON is read from stdin.

  Exit: 0 filed · 1 bad usage · 2 ORCA not running · 3 refused
`);
  process.exit(code);
}

function parse(args) {
  const out = { verb: '', review: null, file: null, json: null, project: null, agent: sessionId(), jsonOut: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage(0);
    else if (a === '-r' || a === '--review') out.review = args[++i] ?? null;
    else if (a === '-f' || a === '--file') out.file = args[++i] ?? null;
    else if (a === '-j' || a === '--json') out.json = args[++i] ?? null;
    else if (a === '-p' || a === '--project') out.project = args[++i] ?? null;
    else if (a === '--agent') out.agent = args[++i] ?? null;
    else if (a === '--json-out') out.jsonOut = true;
    else if (!a.startsWith('-') && !out.verb) out.verb = a;
    else usage(1);
  }
  return out;
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function die(msg, code) {
  process.stderr.write(`orca-improve: ${msg}\n`);
  process.exit(code);
}

const opts = parse(argv);
if (opts.verb && opts.verb !== 'report') usage(1);
if (!opts.review) die('which review? pass --review <id> from your brief', 1);

const raw = opts.json ?? (opts.file ? readFileSync(opts.file, 'utf8') : readStdin());
if (!raw.trim()) die('nothing to file: pass --file, --json, or pipe the JSON in', 1);

let parsed;
try { parsed = JSON.parse(raw); } catch (err) {
  die(`that is not valid JSON: ${err.message}`, 1);
}
const proposals = Array.isArray(parsed) ? parsed : parsed?.proposals;
if (!Array.isArray(proposals) || proposals.length === 0) {
  die('expected {"proposals": [ … ]} with at least one proposal', 1);
}

const root = projectRoot(opts.project);
const dir = join(root, '.orca', 'improve');
// `.orca/` existe en cuanto ORCA vigila el proyecto; que no exista es la señal
// de que aquí no hay collector, y decirlo es más útil que dejar un fichero
// que nadie va a recoger.
if (!existsSync(join(root, '.orca'))) {
  die(`ORCA is not watching ${root}. Say what you found in your summary instead.`, 2);
}
mkdirSync(dir, { recursive: true });

const id = `imp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const file = join(dir, `${id}.json`);
const ackFile = join(dir, `${id}.ack.json`);
const body = JSON.stringify({
  reviewId: opts.review,
  ...(opts.agent ? { agentId: opts.agent } : {}),
  proposals,
});
// Escribir-y-renombrar: el collector vigila el directorio y no puede leer un
// fichero a medio escribir.
writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
renameSync(`${file}.tmp`, file);

const ack = await waitFor(dir, () => (existsSync(ackFile) ? readFileSync(ackFile, 'utf8') : null), ACK_TIMEOUT_MS);
if (ack === null) {
  // El fichero queda: el collector puede estar reiniciándose y lo recogerá.
  die(`filed, but ORCA did not confirm within ${ACK_TIMEOUT_MS / 1000}s. It is on disk at ${file}; do not file it again.`, 2);
}
rmSync(ackFile, { force: true });

let res;
try { res = JSON.parse(ack); } catch { res = { ok: false, error: 'unreadable answer from ORCA' }; }

if (opts.jsonOut) {
  process.stdout.write(JSON.stringify(res) + '\n');
} else if (res.ok) {
  const bits = [`${res.filed ?? 0} filed`, `${res.merged ?? 0} merged into existing proposals`];
  process.stdout.write(`${bits.join(', ')}.\n`);
  for (const why of res.rejected ?? []) process.stdout.write(`  refused: ${why}\n`);
  if ((res.rejected ?? []).length) {
    process.stdout.write('Fix those and run orca-improve again; the ones above are already in.\n');
  }
} else {
  process.stderr.write(`orca-improve: ${res.error ?? 'refused'}\n`);
  for (const why of res.rejected ?? []) process.stderr.write(`  refused: ${why}\n`);
}

process.exit(res.ok && ((res.filed ?? 0) + (res.merged ?? 0)) > 0 ? 0 : 3);
