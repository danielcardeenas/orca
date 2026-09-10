import { mountWakeLock } from './wake-lock.ts';
let wake: ReturnType<typeof mountWakeLock> | undefined;
export const deviceWake = () => wake ??= mountWakeLock();
/// <reference types="vite/client" />
/**
 * El registro del service worker.
 *
 * Proporciona arranque sin red y el receptor de notificaciones push.
 * La instalación depende del navegador; Chrome ya permite instalar desde
 * el menú sin exigir un handler de fetch (docs/PWA.md).
 *
 * Dos condiciones para registrarlo, y las dos importan:
 *
 *   Sólo en producción. En desarrollo Vite sirve módulos sin hash y una caché
 *   por delante convierte «edito y recargo» en «edito y veo lo de antes»,
 *   que es de las pérdidas de tiempo más caras que hay. Además el dev server
 *   vive en otro puerto que el hub (4478 vs 4479), así que ni siquiera es el
 *   mismo origen: lo que se instala es la consola construida que sirve el hub.
 *
 *   Sólo en contexto seguro. `navigator.serviceWorker` no existe sobre http
 *   fuera de localhost. Entrar al hub por la IP de la tailnet es exactamente
 *   ese caso, y por eso la consola se sirve por `tailscale serve` (ver
 *   docs/PWA.md): no es un detalle de despliegue, es la diferencia entre que
 *   esto exista o no.
 *
 * Y una tercera regla, que es doctrina de la consola y no del navegador: el
 * worker nuevo NO toma el mando solo. Se queda esperando, la píldora UPDATE
 * AVAILABLE se enciende (`hud/update.ts`) y el relevo ocurre en el clic. Una
 * consola que cambia de build a media frase pierde la frase.
 */

/** La promesa del registro, o null si aquí no toca. Se resuelve una vez. */
let reg: Promise<ServiceWorkerRegistration | null> | null = null;

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Registra el worker y avisa cuando hay uno esperando.
 *
 * `onUpdate` se llama cuando un worker nuevo llegó a `installed` habiendo ya
 * un controlador — es decir, cuando lo que hay instalado es un relevo, no la
 * primera instalación. La primera no avisa: no hay nada que actualizar.
 */
export function registerServiceWorker(onUpdate: (why: string) => void): void {
  deviceWake();
  if (!supported()) return;

  if (!import.meta.env.PROD) {
    /*
     * Un worker registrado en una sesión anterior sobre este mismo origen
     * seguiría sirviendo caché al dev server. Improbable —son puertos
     * distintos— pero el día que pase, el síntoma es «mis cambios no salen» y
     * la causa es invisible. Barato de descartar aquí.
     */
    void navigator.serviceWorker.getRegistrations()
      .then((all) => Promise.all(all.map((r) => r.unregister())))
      .catch(() => { /* nada que limpiar */ });
    return;
  }

  reg = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
  void reg.then((r) => {
    if (!r) return;
    // Ya había un relevo esperando de una carga anterior.
    if (r.waiting && navigator.serviceWorker.controller) onUpdate('build');
    r.addEventListener('updatefound', () => {
      const next = r.installing;
      if (!next) return;
      next.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) onUpdate('build');
      });
    });
  });
}

/** Cuánto se espera al relevo antes de recargar igual. */
const HANDOVER_MS = 1500;

/**
 * Da paso al worker que espera, si lo hay, y resuelve cuando ha tomado el
 * mando. La llama el clic de UPDATE AVAILABLE justo antes de recargar: sin
 * esto la recarga la serviría el worker viejo, con la caché vieja, y haría
 * falta un segundo clic para ver el build nuevo.
 *
 * Nunca rechaza y nunca se queda colgada: si no hay worker, si no hay relevo,
 * o si el relevo tarda, resuelve y la recarga sigue su camino. Recargar de
 * más es un incordio; no recargar es un botón que no hace nada.
 */
export async function activatePending(): Promise<void> {
  if (!supported() || !reg) return;
  const r = await reg;
  if (!r) return;
  // Puede que el build nuevo lo haya visto el centinela por el index y el
  // navegador aún no haya mirado /sw.js. Mirar ahora.
  await r.update().catch(() => { /* sin red: se recarga con lo que haya */ });
  const waiting = r.waiting;
  if (!waiting || !navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', done); resolve(); };
    const timer = setTimeout(done, HANDOVER_MS);
    navigator.serviceWorker.addEventListener('controllerchange', done);
    waiting.postMessage({ t: 'orca:activate' });
  });
}
