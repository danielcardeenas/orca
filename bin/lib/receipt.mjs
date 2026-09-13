/**
 * El recibo de un mensaje: qué le pasó a lo que mandaste.
 *
 * Hasta hoy, `orca-tell` imprimía `sent:` en cuanto conseguía renombrar un
 * fichero en su propio disco, y eso era todo lo que el emisor llegaba a saber.
 * No había ninguna diferencia observable entre depositado, entregado y leído.
 * El 2026-09-13 se midió lo que eso cuesta: quince mensajes se quedaron en un
 * directorio que nadie vigilaba, los quince imprimieron `sent:` y salieron con
 * 0, y tres de ellos eran respuestas a preguntas bloqueantes. Nadie se enteró
 * durante cuarenta minutos, en los dos extremos del canal.
 *
 * El recibo es un fichero con el mismo stem que el mensaje, en un directorio
 * propio:
 *
 *   <project>/.orca/out/<stem>.json        el mensaje (el collector lo borra al recogerlo)
 *   <project>/.orca/receipts/<stem>.json   el recibo (se queda, y se actualiza)
 *
 * Directorio aparte y no `.orca/out/<stem>.receipt.json`, que es donde estaba
 * primero: el watcher de mensajes se lleva TODO `.json` del buzón de salida que
 * no acabe en `.answer.json` (`collector/messages.ts`, en `scan`), así que
 * trataba el recibo como un mensaje inválido y lo borraba en el mismo tick en
 * el que se escribía. Un recibo en el buzón de salida dura un segundo. Se midió.
 *
 * Lo escribe `orca-tell` en `filed` y lo va promoviendo el collector. La
 * decisión de diseño que hace que esto sirva para algo:
 *
 *   ausencia de recibo   nunca se envió
 *   `filed` y ya viejo   NADIE LO RECOGIÓ ← el fallo de hoy, ahora consultable
 *   `picked`             el collector lo tiene; el resto no se sabe con certeza
 *   `delivered`          está en el buzón de N destinatarios
 *   `undeliverable`      no llegó, y `detail` dice por qué
 *   `read`               alguien lo consumió
 *
 * Un no-entregado tenía que dejar de ser una AUSENCIA y pasar a ser un hecho
 * que se puede consultar. Un silencio no se distingue de un éxito; un `filed`
 * de hace diez minutos sí.
 *
 * `picked` existe por honestidad: cuando la entrega la hace el collector de
 * otra máquina, el de aquí no puede afirmar que llegó. Se queda corto en vez
 * de mentir, porque un recibo que miente es peor que uno incompleto — sobre un
 * recibo que miente se construyen las decisiones equivocadas de mañana.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Los estados, en el orden en que un mensaje los atraviesa. */
export const RECEIPT_STATES = ['filed', 'picked', 'delivered', 'undeliverable', 'read'];

/**
 * Cuánto puede tardar el collector en recoger antes de que `filed` deje de ser
 * normal y pase a ser un síntoma.
 *
 * Su bucle es de 1 s y además tiene un `fs.watch` encima, así que lo normal son
 * milisegundos. Treinta segundos es eso con muchísimo margen, y lo bastante
 * corto como para que un agente se entere dentro del mismo turno en el que
 * mandó el mensaje, que es el único momento en el que todavía puede hacer algo.
 */
export const PICKUP_GRACE_MS = 30_000;

/** Un recibo más viejo que esto ya no le importa a nadie y se barre solo. */
export const RECEIPT_TTL_MS = 24 * 3600_000;

/** Dónde viven los recibos de un proyecto. Ningún watcher mira aquí. */
export function receiptsDir(root) {
  return join(root, '.orca', 'receipts');
}

export function receiptPath(dir, stem) {
  return join(dir, `${stem}.json`);
}

export function readReceipt(dir, stem) {
  const file = receiptPath(dir, stem);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Escribe el recibo entero, con temporal propio y rename.
 *
 * El temporal lleva el pid: dos procesos escribiendo el mismo destino con el
 * mismo nombre temporal es exactamente la carrera que durante siete días
 * produjo 288 avisos de «no pude escribir el buzón» que no perdían un solo
 * mensaje y desviaron dos investigaciones.
 */
export function writeReceipt(dir, stem, receipt) {
  const file = receiptPath(dir, stem);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(receipt, null, 2));
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}

/** Una línea que un agente pueda leer sin abrir el fichero. */
export function describeReceipt(receipt, now = Date.now()) {
  if (!receipt) return 'no receipt: this was never filed from here';
  const age = Math.round((now - (receipt.at ?? now)) / 1000);
  switch (receipt.state) {
    case 'filed':
      return age * 1000 > PICKUP_GRACE_MS
        ? `NOT PICKED UP — filed ${age}s ago and no collector has taken it. `
          + 'It is sitting in a directory nobody is watching. Check you are not in a worktree ORCA does not know about, and say it in your summary rather than assuming it arrived.'
        : `filed ${age}s ago, waiting for the collector (normal for a few seconds)`;
    case 'picked':
      return `picked up by the collector ${age}s ago; delivery is out of this machine's hands`;
    case 'delivered':
      return `delivered to ${receipt.recipients?.length ?? '?'} recipient(s)`
        + (receipt.recipients?.length ? `: ${receipt.recipients.join(', ')}` : '');
    case 'undeliverable':
      return `NOT DELIVERED — ${receipt.detail ?? 'no reason recorded'}`;
    case 'read':
      return `read${receipt.recipients?.length ? ` by ${receipt.recipients.join(', ')}` : ''}`;
    default:
      return `unknown state "${receipt.state}"`;
  }
}

/**
 * Barre los recibos caducados y devuelve los que siguen varados — los mensajes
 * que nadie recogió.
 *
 * Se llama al mandar un mensaje nuevo, y no en un demonio aparte, porque el
 * momento en el que un agente puede hacer algo con esa información es el mismo
 * en el que está usando el canal. Un aviso que llega cuando ya nadie mira no
 * es un aviso.
 *
 * La comprobación es sobre el DISCO y no sobre la palabra de nadie: el
 * collector borra el fichero del buzón de salida en cuanto lo recoge, así que
 * un mensaje que ya no está ahí fue recogido, por definición. El emisor puede
 * cerrar ese primer salto él solo, sin que nadie coopere — y el recibo se
 * promueve a `picked` ahí mismo, que es la diferencia entre un mecanismo y una
 * promesa sobre lo que otro hará.
 *
 * Sin esto, un recibo se quedaba en `filed` para siempre mientras el lado del
 * collector no existiera, y el aviso saltaba en cada envío. Un aviso que salta
 * siempre no es un aviso: es ruido que enseña a ignorar la línea.
 */
export function sweepReceipts(dir, outDir, now = Date.now()) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const stranded = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    let receipt;
    try { receipt = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const at = receipt.at ?? statSync(file).mtimeMs;
    if (now - at > RECEIPT_TTL_MS) { rmSync(file, { force: true }); continue; }
    if (receipt.state !== 'filed' || now - at <= PICKUP_GRACE_MS) continue;

    if (outDir && !existsSync(join(outDir, `${receipt.msgId}.json`))) {
      // Ya no está en el buzón de salida: alguien se lo llevó.
      writeReceipt(dir, receipt.msgId, { ...receipt, state: 'picked', updatedAt: now });
      continue;
    }
    stranded.push(receipt);
  }
  return stranded;
}
