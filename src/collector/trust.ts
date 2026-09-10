/**
 * Workspace trust: la puerta que Claude Code pone ANTES de los permisos.
 *
 * La primera vez que `claude` arranca en un directorio, pinta un diálogo
 * nativo —«Quick safety check: Is this a project you created or one you
 * trust?»— y no hace NADA hasta que alguien pulsa una tecla. Medido el
 * 2026-09-08 contra Claude Code 2.1.263:
 *
 *  - `--permission-mode bypassPermissions` NO lo salta: la confianza de la
 *    carpeta es anterior a los permisos de herramienta, y el flag sólo habla
 *    de los segundos.
 *  - La confianza NO se hereda del padre: `/Users/dan/projects` aceptado y
 *    `/Users/dan/projects/ventures` vuelve a preguntar.
 *  - Mientras el diálogo está en pantalla el CLI no crea su directorio en
 *    `~/.claude/projects`, así que no hay transcript, no hay deriver y ORCA es
 *    CIEGA: cinco agentes se quedaron 25 minutos ahí sin que nadie supiera por
 *    qué (ver `docs/NEW-PROJECT-LAUNCH.md`).
 *
 * El estado vive en `~/.claude.json`, bajo `projects["<ruta absoluta>"]
 * .hasTrustDialogAccepted`. Una entrada de un solo campo basta: el fichero de
 * esta máquina tiene varias así, escritas por el propio CLI.
 *
 * ── Por qué ORCA escribe ahí ──────────────────────────────────────────
 *
 * Escribir en el fichero de configuración del usuario no es gratis y no se
 * hace a la ligera. La razón por la que aquí sí se hace, y el porqué del
 * alcance tan estrecho:
 *
 *  1. El diálogo pregunta «¿confías en esta carpeta?» a una pantalla que nadie
 *     mira. En una flota autónoma no hay nadie delante: la pregunta no se
 *     contesta, se cuelga. Ese es el fallo que esto arregla.
 *  2. La decisión ya se tomó, y antes: un operador (o CAPCOM en su nombre)
 *     nombró esa ruta y pidió lanzar un agente ahí con permiso para editar y
 *     ejecutar. Conceder la confianza en ese mismo instante no añade poder
 *     ninguno sobre lo que el lanzamiento ya concede; sólo lo dice donde el
 *     CLI lo lee.
 *  3. El alcance es exactamente el del lanzamiento: la ruta EXACTA a la que se
 *     va a lanzar, ni su padre ni sus hijos, y sólo después de que la ruta haya
 *     pasado las guardas que ya existen (`launchable`, `excludedWorkspace`).
 *
 * Y lo que NO se hace, por lo mismo:
 *
 *  - No se toca nada más del fichero: se lee, se añade una clave, se escribe.
 *    Si el JSON no parsea, no se escribe (un fichero que no entendemos no se
 *    reescribe nunca).
 *  - No se degrada nada: si la entrada ya dice `true`, no hay escritura.
 *  - La escritura es atómica (temporal en el mismo directorio + `rename`) y
 *    optimista: se relee justo antes de renombrar y, si el fichero cambió
 *    debajo —otra sesión de Claude Code escribiendo—, se reintenta desde cero.
 *    El fichero está VIVO; un `writeFileSync` directo pierde el trabajo ajeno
 *    a medio escribir.
 *  - Se puede apagar: con `ORCA_TRUST_SPAWNS=0` ORCA no escribe, y entonces un
 *    lanzamiento sobre una carpeta sin confianza se RECHAZA con el porqué y el
 *    comando para arreglarlo, en vez de congelarse esperando a nadie.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { errText, log } from './util.ts';

const SCOPE = 'trust';

/** Dónde vive el estado de confianza. `CLAUDE_CONFIG_DIR` lo mueve entero. */
export function claudeConfigPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(env['CLAUDE_CONFIG_DIR'] ?? os.homedir(), '.claude.json');
}

/**
 * La clave con la que Claude Code indexa un directorio: su ruta REAL.
 *
 * Comprobado en el fichero de esta máquina, donde toda ruta bajo `/tmp`
 * aparece como `/private/tmp/…`: el CLI guarda el cwd ya resuelto. Sin
 * `realpath` una carpeta alcanzada por symlink se confiaría bajo una clave que
 * el CLI nunca va a mirar.
 */
export function trustKey(dir: string): string {
  const resolved = path.resolve(dir);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

export type TrustVerdict =
  /** La entrada existe y dice que sí: `claude` arrancará sin preguntar. */
  | 'trusted'
  /** No hay entrada, o dice que no: habrá diálogo. */
  | 'untrusted'
  /** El fichero existe y no se puede leer o no parsea: no se afirma nada. */
  | 'unreadable';

export function trustOf(dir: string, file = claudeConfigPath()): TrustVerdict {
  const config = readConfig(file);
  if (config === 'missing') return 'untrusted';   // sin fichero no hay confianza
  if (config === 'bad') return 'unreadable';
  const entry = config.json['projects'];
  if (!isRecord(entry)) return 'untrusted';
  const project = entry[trustKey(dir)];
  return isRecord(project) && project['hasTrustDialogAccepted'] === true ? 'trusted' : 'untrusted';
}

export interface TrustGrant {
  ok: boolean;
  /** Hubo escritura. `ok` sin `changed` es "ya estaba confiada". */
  changed: boolean;
  detail: string;
}

/**
 * Marca ese directorio como confiado, sin destruir lo que ya hay.
 *
 * Reintenta si el fichero cambia debajo: otra sesión de Claude Code escribe su
 * `lastCost` cada pocos segundos, y una carrera perdida aquí sería trabajo
 * ajeno borrado.
 */
export function grantTrust(dir: string, file = claudeConfigPath(), attempts = 4): TrustGrant {
  const key = trustKey(dir);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const config = readConfig(file);
    if (config === 'bad') {
      return { ok: false, changed: false, detail: `${file} no es JSON legible: no lo reescribo` };
    }
    /*
     * Sin fichero no se crea uno. Que no exista significa que Claude Code
     * nunca ha corrido en esta máquina, y su primer arranque hace onboarding
     * y escribe ahí lo suyo: adelantarnos con un fichero de una sola clave es
     * inventarse su configuración, no responder a su diálogo.
     */
    if (config === 'missing') {
      return { ok: false, changed: false, detail: `${file} no existe: Claude Code no ha arrancado nunca aquí` };
    }
    const json = config.json;
    const projects = isRecord(json['projects']) ? { ...json['projects'] } : {};
    const current = isRecord(projects[key]) ? projects[key] : null;
    if (current?.['hasTrustDialogAccepted'] === true) {
      return { ok: true, changed: false, detail: `${key} ya estaba confiada` };
    }
    // Una entrada de un solo campo es válida: el CLI rellena el resto solo.
    projects[key] = { ...(current ?? {}), hasTrustDialogAccepted: true };
    const next = { ...json, projects };
    const wrote = writeAtomic(file, next, config.stamp);
    if (wrote === 'raced') continue;              // alguien escribió: releer y repetir
    if (wrote !== 'ok') return { ok: false, changed: false, detail: wrote };
    log('info', SCOPE, `carpeta confiada para Claude Code: ${key}`);
    return { ok: true, changed: true, detail: `confianza concedida a ${key} en ${file}` };
  }
  return { ok: false, changed: false, detail: `${file} cambia bajo cada intento; no lo reescribo` };
}

/** ¿Puede ORCA conceder la confianza sola? `ORCA_TRUST_SPAWNS=0` dice que no. */
export function trustGrantingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['ORCA_TRUST_SPAWNS'];
  return raw === undefined || !/^(0|no|off|false)$/i.test(raw.trim());
}

/* ── el fichero ───────────────────────────────────────────────────── */

/** mtime + tamaño: si alguno se mueve, el fichero se reescribió debajo. */
interface Stamp { mtimeMs: number; size: number }
type Config = { json: Record<string, unknown>; stamp: Stamp } | 'missing' | 'bad';

function readConfig(file: string): Config {
  let raw: string;
  let stamp: Stamp;
  try {
    const st = fs.statSync(file);
    stamp = { mtimeMs: st.mtimeMs, size: st.size };
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    log('warn', SCOPE, `no pude leer ${file}: ${errText(err)}`);
    return 'bad';
  }
  try {
    const json: unknown = JSON.parse(raw);
    if (!isRecord(json)) return 'bad';
    return { json, stamp };
  } catch (err) {
    log('warn', SCOPE, `${file} no parsea: ${errText(err)}`);
    return 'bad';
  }
}

function writeAtomic(file: string, value: Record<string, unknown>, expect: Stamp): 'ok' | 'raced' | string {
  const tmp = path.join(path.dirname(file), `.claude.json.orca-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  let fd: number | null = null;
  try {
    // El modo del original, tal cual: este fichero lleva credenciales de OAuth
    // en algunas instalaciones y no se le abren los permisos. El `preTrust`
    // anterior escribía 0644 fijo, que sobre un 0600 era una apertura silenciosa.
    const mode = fs.statSync(file).mode & 0o777;
    fd = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // Última mirada antes de pisar: si se movió, lo escrito ya está viejo.
    const now = fs.statSync(file);
    if (now.mtimeMs !== expect.mtimeMs || now.size !== expect.size) {
      fs.rmSync(tmp, { force: true });
      return 'raced';
    }
    fs.renameSync(tmp, file);
    return 'ok';
  } catch (err) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* ya cerrado */ }
    fs.rmSync(tmp, { force: true });
    return `no pude escribir ${file}: ${errText(err)}`;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
