/**
 * Lo que ORCA lanzó, apuntado: quién es, quién lo posee, y hasta cuándo.
 *
 * Existe por un agujero concreto. El detector de restos daba por abandonado a
 * un proceso porque estaba reparentado a init (`ppid === 1`), y eso NO es
 * prueba de nada: `nohup`, `setsid`, `disown` y cualquier arranque
 * deliberadamente desatendido dejan exactamente esa firma en un proceso
 * perfectamente sano — que puede estar sirviendo otra consola en otro puerto.
 * Ofrecer terminarlo era ofrecer matar el servidor de alguien.
 *
 * Un lease invierte la pregunta. En vez de intentar adivinar si un proceso
 * desconocido sobra —que no se puede—, ORCA sólo se ofrece a terminar lo que
 * ELLA MISMA lanzó y anotó, y sólo cuando el que lo lanzó ya no está. Sin
 * lease no hay licencia: el proceso se enseña y no se toca, y el panel dice
 * por qué en vez de fingir un diagnóstico.
 *
 * ── El fichero ─────────────────────────────────────────────────────
 *
 *   ~/.orca/leases/<id>.json
 *
 * Lo escribe quien lanza (`tools/lease.mjs`, o el propio hub y collector para
 * sí mismos), lo RENUEVA mientras vive, y lo borra al salir limpiamente. Que
 * quede un lease sin borrar es justo la señal que interesa: significa que el
 * dueño se fue de mala manera, que es cuando quedan restos.
 *
 * ── Qué cuenta como «el dueño se fue» ──────────────────────────────
 *
 * Que su pid no esté, o que esté ocupado por otro proceso —pid y hora de
 * arranque, como en todo lo demás—. Y además el lease tiene que estar
 * caducado: un dueño vivo lo renueva, así que un lease fresco es prueba
 * positiva de lo contrario y protege al proceso aunque su pid no se encuentre
 * por lo que sea.
 */

/** Lo que se sabe de un proceso lanzado por ORCA. */
export interface Lease {
  /** Nombre del fichero, sin `.json`. Único por proceso. */
  id: string;
  /** Qué se lanzó: `vite`, `hub`, `collector`… Informativo. */
  kind: string;
  /** El proceso lanzado. `startedAt` es la mitad de su identidad. */
  pid: number;
  startedAt: number | null;
  /** Dónde corre, absoluto: es lo que ata el lease a un repositorio. */
  cwd: string;
  /** Puertos que sirve, si se saben al lanzarlo. */
  ports?: number[];
  /** Quién lo lanzó, y por tanto quién responde por él. */
  owner: { pid: number; startedAt: number | null; label: string };
  /** Cuándo se escribió, y cuándo se renovó por última vez. */
  at: number;
  renewedAt: number;
}

/**
 * Cada cuánto renueva el dueño, y a partir de cuándo un lease está caducado.
 *
 * Diez segundos de renovación y un minuto de caducidad: seis latidos perdidos.
 * El margen es ancho a propósito — un portátil que se suspende, un disco
 * ocupado o un proceso bajo carga se saltan un latido sin haberse muerto, y el
 * error caro es dar por muerto a un vivo.
 */
export const LEASE_RENEW_MS = 10_000;
export const LEASE_STALE_MS = 60_000;

/** Nombre de fichero para un lease. Sin barras ni sorpresas. */
export function leaseId(kind: string, pid: number): string {
  return `${kind.replace(/[^a-z0-9-]/gi, '')}-${pid}`.slice(0, 80);
}

/** ¿Es esto un lease legible? Lo escribe otro proceso: se valida, no se cree. */
export function isLease(v: unknown): v is Lease {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  const owner = l['owner'];
  return typeof l['id'] === 'string' && typeof l['kind'] === 'string'
    && typeof l['pid'] === 'number' && l['pid'] > 0
    && typeof l['cwd'] === 'string'
    && typeof l['at'] === 'number' && typeof l['renewedAt'] === 'number'
    && typeof owner === 'object' && owner !== null
    && typeof (owner as Record<string, unknown>)['pid'] === 'number';
}

/** El lease de este proceso exacto: pid Y hora de arranque. */
export function leaseFor(leases: Lease[], pid: number, startedAt: number | null, skewMs: number): Lease | null {
  return leases.find((l) => l.pid === pid
    && (l.startedAt === null || startedAt === null || Math.abs(l.startedAt - startedAt) <= skewMs)) ?? null;
}

/** Qué dice un lease sobre si su proceso se puede terminar. */
export type LeaseVerdict =
  /** Nadie lo anotó: ORCA no lo lanzó y no puede saber si sobra. */
  | { state: 'unleased' }
  /** El dueño sigue ahí, o el lease se renovó hace nada. */
  | { state: 'held'; why: string }
  /** El dueño se fue y el lease está caducado: esto es un resto. */
  | { state: 'abandoned'; why: string };

/**
 * ¿Se puede decir que este proceso quedó abandonado?
 *
 * Exige las dos cosas, y ninguna sola basta: el dueño ya no está —por pid y
 * hora de arranque, para que un pid reciclado no lo resucite— **y** el lease
 * lleva sin renovarse más de `LEASE_STALE_MS`. Un dueño vivo o un lease fresco
 * son prueba positiva de que el proceso se quiere, y ganan.
 */
export function leaseVerdict(
  lease: Lease | null,
  o: { now: number; alive(pid: number, startedAt: number | null): boolean },
): LeaseVerdict {
  if (!lease) return { state: 'unleased' };
  const age = o.now - lease.renewedAt;
  if (age < LEASE_STALE_MS) {
    return { state: 'held', why: `its ORCA lease was renewed ${Math.round(age / 1000)}s ago` };
  }
  if (o.alive(lease.owner.pid, lease.owner.startedAt)) {
    return { state: 'held', why: `${lease.owner.label} (pid ${lease.owner.pid}) launched it and is still running` };
  }
  return {
    state: 'abandoned',
    why: `ORCA launched it from ${lease.owner.label} (pid ${lease.owner.pid}), which is gone,`
      + ` and its lease has not been renewed for ${Math.round(age / 60_000)}m`,
  };
}
