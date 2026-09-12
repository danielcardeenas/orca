/**
 * La estantería, dibujada: las fichas de lo que un agente hizo, bajo su baldosa.
 *
 * Son DOM proyectado sobre el lienzo, como los rótulos (`labels.ts`), y no
 * cuadros con textura como las superficies colocadas (`media.ts`). A propósito:
 * una textura sube el archivo entero a la GPU, y cuarenta imágenes a resolución
 * completa son mil setecientos megas de memoria de vídeo y un contexto de GL
 * caído. Un `<img>` lo decodifica el navegador, lo cachea, y se le puede poner
 * un techo en píxeles. Y de paso la ficha de glifo y el contador son CSS.
 *
 * La geometría y la cuenta no están aquí: están en `shelf.ts`, puras y probadas.
 * Aquí sólo viven el nodo, el pool y la proyección.
 */

import type { Artifact } from '../../shared/types.ts';
import { authedUrl } from '../net/client.ts';
import { esc } from '../util.ts';
import { opaqueLabel } from './surface.ts';

/** Una ficha lista para pintar: su sitio en la pantalla y lo que lleva dentro. */
export interface ChipItem {
  /** El artefacto, o null si es la ficha contador. */
  art: Artifact | null;
  /** Cuántos quedan detrás del contador; 0 en una ficha normal. */
  more: number;
  /** Esquina superior izquierda en píxeles del lienzo, y el lado de la ficha. */
  sx: number;
  sy: number;
  px: number;
}

/** La estantería de un agente, con sus fichas ya proyectadas. */
export interface ShelfItem {
  agentId: string;
  chips: ChipItem[];
  /**
   * El agente ya no trabaja: la franja se atenúa con su baldosa. Un artefacto
   * de alguien que terminó sigue siendo su artefacto — lo que cambia es cuánta
   * atención pide, y eso es exactamente lo que hace la baldosa.
   */
  dim: boolean;
}

export interface ShelvesEvents {
  /** Clic en una ficha: se abre el artefacto donde está la ficha. */
  onOpenArtifact(id: string, x: number, y: number): void;
  /** Clic en el contador: el índice de ese agente, que es la galería. */
  onOpenGallery(agentId: string): void;
}

export interface ShelvesHandle {
  update(items: ShelfItem[]): void;
  dispose(): void;
}

/**
 * Techo global de fichas dibujadas a la vez.
 *
 * Cuatro por agente y unas veinte estanterías en pantalla es el caso que se ve;
 * el techo está para el que no se ve. Pasado de aquí se dibujan las de los
 * agentes que salieron primero del recorte de la cámara, que son los que están
 * más cerca del centro de la vista.
 */
export const MAX_CHIPS = 96;

/** El `src` de la miniatura de una ficha. */
function chipSrc(a: Artifact): string | null {
  /*
   * Un único sitio para esto, porque aquí es donde entra la miniatura del hub
   * cuando exista (`/api/artifact/<id>?thumb=128`, la costura con la mitad de
   * la captura). Hasta entonces es el original con techo en CSS: el navegador
   * lo decodifica y lo cachea, que no es gratis pero tampoco es memoria de
   * vídeo, y las fichas se cuentan con los dedos.
   */
  return authedUrl(a.url);
}

/** Qué lleva dentro una ficha. */
function content(c: ChipItem): string {
  if (!c.art) return `<span class="chip__n">+${c.more}</span>`;
  const a = c.art;
  const url = chipSrc(a);
  if (a.kind === 'image' && url) {
    return `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" draggable="false" />`;
  }
  if (a.kind === 'video' && url) {
    /*
     * El primer fotograma y una marca, nunca un vídeo reproduciéndose. Con
     * `preload="metadata"` el navegador pinta el póster y no decodifica — lo
     * mismo que hace la galería. Un vídeo en bucle bajo cada baldosa se come un
     * decodificador de hardware por agente, y de ésos hay cuatro.
     */
    return `<video src="${esc(url)}" muted playsinline preload="metadata"></video>`
      + `<span class="chip__play">▶</span>`;
  }
  /*
   * Lo que no tiene miniatura posible dice qué es y cuánto pesa: un `.zip`, un
   * binario, una página web, un texto. Es todo lo que se puede decir con verdad
   * de ellos, y es más de lo que decía un rectángulo vacío.
   */
  return `<span class="chip__k">${esc(opaqueLabel(a.path, a.bytes))}</span>`;
}

export function createShelves(layer: HTMLElement, ev: ShelvesEvents): ShelvesHandle {
  interface Rec { el: HTMLElement; sig: string }
  const live = new Map<string, Rec>();
  const pool: HTMLElement[] = [];

  function take(): HTMLElement {
    const el = pool.pop();
    if (el) { el.hidden = false; return el; }
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'chip-art';
    layer.appendChild(d);
    return d;
  }

  /*
   * Un único oyente en la capa, no uno por ficha: una flota que declara mucho
   * recicla nodos por fotograma, y un oyente por nodo reciclado es una fuga.
   */
  layer.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.chip-art');
    if (!el) return;
    e.stopPropagation();
    const id = el.dataset.art;
    // La ficha contador lleva el agente, no un artefacto: abre su índice.
    if (id) ev.onOpenArtifact(id, e.clientX, e.clientY);
    else if (el.dataset.agent) ev.onOpenGallery(el.dataset.agent);
  });

  return {
    update(items) {
      const want = new Set<string>();
      let drawn = 0;
      for (const it of items) {
        for (let i = 0; i < it.chips.length; i++) {
          if (drawn >= MAX_CHIPS) break;
          const c = it.chips[i]!;
          // La clave es el agente y la plaza, no el artefacto: así una ficha
          // nueva reutiliza el nodo de la plaza en vez de crear otro.
          const key = `${it.agentId}:${i}`;
          want.add(key);
          drawn++;
          let rec = live.get(key);
          if (!rec) { rec = { el: take(), sig: '' }; live.set(key, rec); }
          const sig = `${c.art?.id ?? `+${c.more}`}|${c.art?.url ?? ''}|${c.art?.at ?? 0}|${it.dim ? 'd' : ''}`;
          if (sig !== rec.sig) {
            rec.sig = sig;
            rec.el.innerHTML = content(c);
            rec.el.className = 'chip-art'
              + (c.art ? '' : ' chip-art--more')
              + (it.dim ? ' is-dim' : '');
            if (c.art) {
              rec.el.dataset.art = c.art.id;
              delete rec.el.dataset.agent;
              rec.el.title = `${c.art.title} · ${c.art.path}`;
            } else {
              delete rec.el.dataset.art;
              rec.el.dataset.agent = it.agentId;
              rec.el.title = `${c.more} MORE · OPEN THE GALLERY`;
            }
          }
          const el = rec.el;
          el.style.transform = `translate3d(${Math.round(c.sx)}px, ${Math.round(c.sy)}px, 0)`;
          el.style.width = `${Math.round(c.px)}px`;
          el.style.height = `${Math.round(c.px)}px`;
        }
      }
      for (const [key, rec] of live) {
        if (want.has(key)) continue;
        rec.el.hidden = true;
        // Un nodo que vuelve al pool no se lleva su contenido: si lo hiciera,
        // la ficha siguiente enseñaría la imagen de otro agente durante un
        // fotograma, que es peor que un hueco.
        rec.el.innerHTML = '';
        rec.sig = '';
        pool.push(rec.el);
        live.delete(key);
      }
    },

    dispose() {
      layer.innerHTML = '';
      live.clear();
      pool.length = 0;
    },
  };
}
