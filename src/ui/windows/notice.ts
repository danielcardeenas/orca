/**
 * Avisos de la ventana de mando: una línea, hasta que interesen.
 *
 * Un traspaso y un contexto limpio dejan cada uno su acta, y son actas útiles
 * —dónde quedó la conversación anterior, qué se conservó— pero son referencia,
 * no alarma. Desplegadas ocupaban dos tercios del alto de la ventana entre las
 * dos, y la conversación viva quedaba en una franja de cuatro líneas; y la del
 * traspaso no se podía cerrar de ninguna manera, así que ese recorte era para
 * siempre. Aquí el estado normal es una línea con su título y su hora, se abre
 * con un clic y se descarta con otro.
 *
 * Lo recordado va por id del aviso, no por tipo: descartar el acta de un
 * traspaso no debe esconder la del siguiente, que es justo cuando hace falta
 * leerla. Y se recuerda en `localStorage`, que es de este navegador: el aviso
 * sigue en el hub y otra consola lo verá igual.
 */

import { esc } from '../util.ts';

const KEY = 'orca.capcom.notices';
/** Ids recordados. Se poda para que no crezca sin fin. */
const MAX = 60;

type State = { dismissed: string[]; opened: string[] };

function load(): State {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<State>;
    return { dismissed: raw.dismissed?.slice(-MAX) ?? [], opened: raw.opened?.slice(-MAX) ?? [] };
  } catch { return { dismissed: [], opened: [] }; }
}

let cache: State | null = null;
function state(): State { return (cache ??= load()); }
function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(state())); } catch { /* modo privado: vive en esta pestaña */ }
}

function remember(list: 'dismissed' | 'opened', id: string, on: boolean): void {
  const s = state();
  const next = s[list].filter((x) => x !== id);
  if (on) next.push(id);
  s[list] = next.slice(-MAX);
  save();
}

export function noticeDismissed(id: string): boolean { return state().dismissed.includes(id); }
export function dismissNotice(id: string): void { remember('dismissed', id, true); }
export function noticeOpen(id: string): boolean { return state().opened.includes(id); }
export function setNoticeOpen(id: string, on: boolean): void { remember('opened', id, on); }

/** Sólo para pruebas y para un borrado deliberado: olvida lo recordado. */
export function resetNotices(): void {
  cache = { dismissed: [], opened: [] };
  try { localStorage.removeItem(KEY); } catch { /* nada que olvidar */ }
}

export interface Notice {
  /** Estable por aviso concreto, no por tipo. */
  id: string;
  title: string;
  /** La segunda mitad de la línea plegada: modelos, estado, lo que resuma. */
  summary: string;
  when?: number;
  /** El cuerpo, ya escapado o construido por quien llama. */
  body: string;
  /** Botones del cuerpo, ya en HTML. */
  actions?: string;
  /** Clase extra para el contenedor. */
  className?: string;
  /** Cómo lo nombra un lector de pantalla. */
  ariaLabel?: string;
}

/**
 * El aviso entero, plegado salvo que se haya abierto antes.
 *
 * `<details>` nativo: se abre sin JS, teclado y lector de pantalla incluidos.
 * Quien lo monta sólo tiene que escuchar `toggle` y el clic de descartar.
 */
export function noticeHtml(n: Notice): string {
  const time = n.when === undefined ? ''
    : `<time datetime="${new Date(n.when).toISOString()}" title="${esc(new Date(n.when).toLocaleString())}">${new Date(n.when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>`;
  return `<aside class="notice${n.className ? ` ${esc(n.className)}` : ''}" data-notice="${esc(n.id)}"${n.ariaLabel ? ` aria-label="${esc(n.ariaLabel)}"` : ''}>
    <details class="notice__d"${noticeOpen(n.id) ? ' open' : ''}>
      <summary class="notice__head">
        <span class="notice__mark" aria-hidden="true"></span>
        <span class="px notice__title">${esc(n.title)}</span>
        <span class="mono notice__sum">${esc(n.summary)}</span>
        ${time}
      </summary>
      <div class="notice__body">
        <p class="mono">${n.body}</p>
        ${n.actions ? `<div class="notice__actions">${n.actions}</div>` : ''}
      </div>
    </details>
    <button class="notice__x" type="button" data-notice-dismiss="${esc(n.id)}" title="Dismiss this notice" aria-label="Dismiss this notice">×</button>
  </aside>`;
}
