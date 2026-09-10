/**
 * Una caja de escribir un mensaje, y qué hace la tecla Enter en ella.
 *
 * En ORCA hay tres cajas de varias líneas que mandan un mensaje —la de CAPCOM,
 * la de una misión y la de un agente— y las tres tenían la misma regla: Enter
 * envía, shift+Enter salta línea. Esa regla es de un chat de escritorio y en un
 * teléfono es una trampa: el teclado del móvil trae una tecla de intro que
 * **es** el salto de línea, no hay shift que combinarle, y el operador que
 * quería escribir dos frases mandaba la primera a medias.
 *
 * La regla ahora, y es la misma en escritorio para no tener dos:
 *
 *   Enter            salta de línea. Siempre. No manda nunca.
 *   ⌘Enter / ⌃Enter  manda. Una vez, aunque se mantenga pulsado.
 *   el botón SEND    manda. Es lo único que hace falta saber en un táctil.
 *
 * `⌃Enter` vale igual que `⌘Enter` porque un teclado que no es de Mac no tiene
 * ⌘, y aprender un atajo que la mitad de los teclados no puede teclear no es
 * aprender un atajo.
 *
 * **La composición no se toca.** Escribir japonés, chino o coreano pasa por un
 * IME: la tecla Enter *confirma la palabra que se está componiendo* y no tiene
 * nada que ver con mandar. `isComposing` (y el `keyCode 229` de los navegadores
 * que no lo ponen) dice que estamos ahí, y ahí esto no hace nada.
 *
 * Sólo para cajas de VARIAS líneas. Un `<input>` de una sola línea —contestar
 * una escalación, hablarle a una flota— manda con Enter y así se queda: en una
 * caja sin salto de línea, Enter no tiene otro trabajo que hacer.
 */

const MAC = /Mac|iPhone|iPad/.test(
  (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform
  ?? navigator.platform ?? navigator.userAgent ?? '',
);

/**
 * Un aparato de sólo dedo: puntero grueso y ningún puntero fino en el sistema.
 *
 * Se pregunta por `any-pointer` y no por el ancho: un portátil con pantalla
 * táctil tiene teclado y la pista le sirve; un teléfono no, y ahí una pista de
 * teclado es una instrucción imposible de seguir.
 */
export function touchOnly(): boolean {
  return matchMedia('(any-pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
}

/** `⌘↵` o `Ctrl+↵`, y nada en un aparato sin teclado. */
export function sendChord(): string {
  if (touchOnly()) return '';
  return MAC ? '⌘↵' : 'Ctrl+↵';
}

/**
 * El texto de ayuda de una caja: qué se escribe y cómo se manda.
 * En táctil puro se queda en lo primero, porque lo segundo es el botón.
 */
export function composerHint(what: string): string {
  const chord = sendChord();
  return chord ? `${what} · ${chord} envía, enter salta línea` : what;
}

/**
 * ¿Esta pulsación es «manda»? Exportada porque hay cajas que no se pueden
 * cablear una a una —las que se repintan enteras en cada render— y escuchan
 * por delegación desde su lista.
 */
export function isSendChord(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.repeat) return false;
  // Componiendo con un IME: la tecla es de la palabra, no del envío.
  if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) return false;
  return e.metaKey || e.ctrlKey;          // Enter a secas salta línea: no se toca.
}

/**
 * Cablea la regla en una caja de varias líneas. Devuelve cómo soltarla.
 *
 * `send` se llama como mucho una vez por pulsación: `repeat` queda fuera, que
 * es lo que evita que mantener ⌘Enter mande el mismo mensaje diez veces.
 */
export function bindComposer(box: HTMLTextAreaElement, send: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!isSendChord(e)) return;
    e.preventDefault();
    e.stopPropagation();
    send();
  };
  box.addEventListener('keydown', onKey);
  return () => box.removeEventListener('keydown', onKey);
}
