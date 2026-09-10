#!/usr/bin/env node
/**
 * Lanza algo y apunta que es de ORCA, para que ORCA pueda recogerlo después.
 *
 *   node tools/lease.mjs --kind vite --port 4478 -- npx vite
 *
 * Envuelve un proceso hijo y escribe un **lease** en `~/.orca/leases/`: qué se
 * lanzó, con qué pid y a qué hora, desde dónde, qué puertos sirve, y **quién
 * lo lanzó** (este proceso). Lo renueva mientras vive y lo borra al salir.
 *
 * ── Por qué hace falta ─────────────────────────────────────────────
 *
 * El detector de restos (`src/shared/strays.ts`) daba por abandonado a un
 * proceso porque estaba reparentado a init. Eso no es prueba de nada: `nohup`,
 * `setsid` y `disown` dejan esa misma firma en un proceso sano que puede estar
 * sirviendo otra consola. Sin una anotación de quién lanzó qué, ORCA no puede
 * distinguir su propio resto del servidor de desarrollo de alguien — y la
 * respuesta correcta a esa duda es no tocar nada.
 *
 * Un lease sin borrar con su dueño muerto ES la evidencia: significa que quien
 * lo lanzó se fue de mala manera, que es exactamente cuando quedan restos. Si
 * el dueño sale limpiamente, borra el lease y no queda nada que recoger.
 *
 * El contrato vive en `src/shared/lease.ts`; los dos números de abajo están
 * duplicados aquí porque este fichero es JS suelto, y hay una prueba
 * (`test/strays.test.ts`) que los sostiene contra los de allí.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Debe coincidir con LEASE_RENEW_MS de src/shared/lease.ts. */
const RENEW_MS = 10_000;

const argv = process.argv.slice(2);
const cut = argv.indexOf('--');
if (cut < 0) {
  process.stderr.write('usage: node tools/lease.mjs --kind <k> [--port N] -- <command…>\n');
  process.exit(1);
}
const opts = argv.slice(0, cut);
const command = argv.slice(cut + 1);
if (command.length === 0) {
  process.stderr.write('lease: nothing to run after --\n');
  process.exit(1);
}
const kind = (opts[opts.indexOf('--kind') + 1] ?? 'child').replace(/[^a-z0-9-]/gi, '') || 'child';
const ports = opts.flatMap((a, i) => (a === '--port' ? [Number(opts[i + 1])] : [])).filter((n) => n > 0);

const dir = join(process.env['ORCA_HOME'] ?? join(homedir(), '.orca'), 'leases');
mkdirSync(dir, { recursive: true });

const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
const file = join(dir, `${kind}-${child.pid}.json`);

/** `[[dd-]hh:]mm:ss` desde que arrancó → el epoch en que arrancó. */
function startOf(pid) {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec((r.stdout ?? '').trim());
  if (!m) return null;
  const d = Number(m[1] ?? 0), h = Number(m[2] ?? 0), mi = Number(m[3] ?? 0), s = Number(m[4] ?? 0);
  return Date.now() - (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

const startedAt = startOf(child.pid);
const ownerStartedAt = startOf(process.pid);

function write() {
  const now = Date.now();
  const lease = {
    id: `${kind}-${child.pid}`, kind, pid: child.pid, startedAt,
    cwd: process.cwd(),
    ...(ports.length ? { ports } : {}),
    owner: { pid: process.pid, startedAt: ownerStartedAt, label: `${kind} launcher` },
    at: now, renewedAt: now,
  };
  try {
    writeFileSync(`${file}.tmp`, JSON.stringify(lease), { mode: 0o600 });
    // Escribir-y-renombrar: quien lo lee puede estar leyendo en este instante.
    spawnSync('mv', [`${file}.tmp`, file]);
  } catch { /* sin lease, el proceso simplemente nunca será recogible */ }
}

write();
const renew = setInterval(write, RENEW_MS);
renew.unref?.();

function bye(code) {
  clearInterval(renew);
  // El lease se borra al salir bien. Que quede es la señal que el detector
  // busca, y por eso NO se borra si morimos de una señal que no controlamos.
  try { rmSync(file, { force: true }); } catch { /* da igual */ }
  process.exit(code);
}

child.on('exit', (code, signal) => bye(signal ? 1 : (code ?? 0)));
child.on('error', (err) => { process.stderr.write(`lease: ${err.message}\n`); bye(1); });
// Las señales se pasan al hijo: quien para esto quiere parar aquello.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* ya se fue */ } });
}
