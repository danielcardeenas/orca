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
import { ago, esc } from '../util.ts';
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

/**
 * La tarjeta de zoom medio (`shelfBadge`): el output más nuevo y la cuenta,
 * a píxeles fijos, colgada de la esquina inferior izquierda de la baldosa.
 * Sustituye a la fila entre 44 y 190 px de baldosa.
 */
export interface BadgeItem {
  /** El más nuevo, o null si el mundo aún no lo tiene. */
  art: Artifact | null;
  count: number;
  /** Esquina superior izquierda en píxeles del lienzo. La tarjeta mide lo que su CSS. */
  sx: number;
  sy: number;
}

/** La estantería de un agente, con sus fichas ya proyectadas. */
export interface ShelfItem {
  agentId: string;
  chips: ChipItem[];
  /** La tarjeta, cuando la baldosa está en el peldaño de la tarjeta y no en el de la fila. */
  badge: BadgeItem | null;
  /**
   * El agente ya no trabaja: la franja se atenúa con su baldosa. Un artefacto
   * de alguien que terminó sigue siendo su artefacto — lo que cambia es cuánta
   * atención pide, y eso es exactamente lo que hace la baldosa.
   */
  dim: boolean;
  /**
   * El puntero está sobre la baldosa de este agente: la franja entera se
   * enciende con sus tirantes (`tether.ts`), que es el hover en sentido
   * inverso — de la baldosa a lo que hizo.
   */
  hot: boolean;
}

export interface ShelvesEvents {
  /** Clic en una ficha: se abre el artefacto donde está la ficha. */
  onOpenArtifact(id: string, x: number, y: number): void;
  /** Clic en el contador: el índice de ese agente, que es la galería. */
  onOpenGallery(agentId: string): void;
  /**
   * El puntero entra en una ficha, o sale de todas (`null, null`). Una ficha
   * normal trae su artefacto; el contador trae sólo al agente, porque no es
   * un output sino la puerta a todos los suyos. El campo lo usa para encender
   * el tirante de esa ficha y la baldosa de la que cuelga.
   */
  onHoverChip(artId: string | null, agentId: string | null): void;
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

/**
 * Qué lleva dentro la tarjeta: una miniatura del más nuevo (o su extensión,
 * si no la tiene) y la cuenta. Con uno solo no hay cuenta que decir.
 */
function badgeContent(b: BadgeItem): string {
  const a = b.art;
  const url = a ? chipSrc(a) : null;
  let thumb: string;
  if (a && a.kind === 'image' && url) thumb = `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" draggable="false" />`;
  else if (a && a.kind === 'video' && url) thumb = `<video src="${esc(url)}" muted playsinline preload="metadata"></video>`;
  else thumb = `<span class="chip__k">${esc(a ? opaqueLabel(a.path, a.bytes).split(' · ')[0] ?? '' : '')}</span>`;
  const n = b.count > 1 ? `<span class="chip__n">×${b.count}</span>` : '';
  return `<span class="badge__thumb">${thumb}</span>${n}`;
}

export function createShelves(layer: HTMLElement, ev: ShelvesEvents): ShelvesHandle {
  interface Rec { el: HTMLElement; sig: string }
  const live = new Map<string, Rec>();
  const pool: HTMLElement[] = [];
  /*
   * El pie de la ficha bajo el puntero: qué es y de cuándo, en una línea
   * debajo de la ficha. Uno solo para toda la capa, porque sólo hay un
   * puntero. No es una previsualización — la imagen no se infla, que es la
   * peor interacción posible sobre una baldosa que se está leyendo —, es el
   * título que el agente le puso y hace cuánto, que es lo que una ficha de
   * 33 px no puede decir por sí sola.
   */
  const cap = document.createElement('div');
  cap.className = 'chip-cap px px--tiny';
  cap.hidden = true;
  layer.appendChild(cap);
  /** La plaza (`agente:i`) de la ficha bajo el puntero, o null. */
  let hoverKey: string | null = null;

  function hoverTo(el: HTMLElement | null) {
    const key = el?.dataset.key ?? null;
    if (key === hoverKey) return;
    hoverKey = key;
    if (!el) { cap.hidden = true; ev.onHoverChip(null, null); return; }
    ev.onHoverChip(el.dataset.art ?? null, el.dataset.agent ?? null);
  }
  layer.addEventListener('pointerover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.chip-art, .chip-badge');
    if (el) hoverTo(el);
  });
  layer.addEventListener('pointerout', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.chip-art, .chip-badge');
    if (!el) return;
    // De la imagen al borde de la misma ficha no es salir de ella.
    const to = (e.relatedTarget as HTMLElement | null)?.closest?.<HTMLElement>('.chip-art, .chip-badge') ?? null;
    if (to !== el) hoverTo(null);
  });

  function take(): HTMLElement {
    const el = pool.pop();
    if (el) { el.hidden = false; return el; }
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'chip-art';
    // Una ficha se arrastra al campo: la misma carga que una miniatura de la
    // galería (`ARTIFACT_DND` en windows/kinds/gallery.ts), y el mismo drop
    // del campo, que coloca la superficie donde se suelta.
    d.draggable = true;
    layer.appendChild(d);
    return d;
  }

  layer.addEventListener('dragstart', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.chip-art, .chip-badge');
    const id = el?.dataset.art;
    const dt = e.dataTransfer;
    // El contador y la tarjeta de varios no son un artefacto: no hay nada que soltar.
    if (!el || !id || !dt) { e.preventDefault(); return; }
    dt.setData('text/orca-artifact', id);
    dt.setData('text/plain', id);
    dt.effectAllowed = 'copy';
    // Al arrastrar, el puntero sale de la ficha sin `pointerout`: se apaga a mano.
    hoverTo(null);
  });

  /*
   * El campo captura el puntero en su `pointerdown` para poder panear, y un
   * puntero capturado por la raíz se lleva también el `click`: la ficha no lo
   * veía nunca. Cortarlo aquí es lo que ya hace el rótulo de una isla, que es
   * el otro hijo DOM del campo que hay que poder pinchar. Un `pointerdown`
   * sobre una ficha no es el principio de un paneo.
   */
  layer.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.chip-art, .chip-badge')) e.stopPropagation();
  });

  /*
   * Un único oyente en la capa, no uno por ficha: una flota que declara mucho
   * recicla nodos por fotograma, y un oyente por nodo reciclado es una fuga.
   */
  layer.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.chip-art, .chip-badge');
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
          // De quién es esta ficha, siempre: el contador lo necesita para abrir
          // su galería, y una ficha que no sabe de quién es no se puede mirar
          // desde fuera — ni en el arnés ni en las herramientas del navegador.
          rec.el.dataset.agent = it.agentId;
          rec.el.dataset.key = key;
          const sig = `${c.art?.id ?? `+${c.more}`}|${c.art?.url ?? ''}|${c.art?.at ?? 0}|${it.dim ? 'd' : ''}|${it.hot ? 'h' : ''}`;
          if (sig !== rec.sig) {
            rec.sig = sig;
            rec.el.innerHTML = content(c);
            rec.el.className = 'chip-art'
              + (c.art ? '' : ' chip-art--more')
              + (it.dim ? ' is-dim' : '')
              + (it.hot ? ' is-hot' : '');
            if (c.art) {
              rec.el.dataset.art = c.art.id;
              rec.el.title = `${c.art.title} · ${c.art.path}`;
            } else {
              delete rec.el.dataset.art;
              rec.el.title = `${c.more} MORE · OPEN THE GALLERY`;
            }
          }
          const el = rec.el;
          el.style.transform = `translate3d(${Math.round(c.sx)}px, ${Math.round(c.sy)}px, 0)`;
          el.style.width = `${Math.round(c.px)}px`;
          el.style.height = `${Math.round(c.px)}px`;
          // El pie sigue a su ficha fotograma a fotograma: la cámara se mueve
          // con easing y un pie leído hace medio segundo cuelga del aire.
          if (key === hoverKey) {
            cap.textContent = c.art ? `${c.art.title} · ${ago(c.art.at)}` : `${c.more} MORE`;
            cap.style.transform = `translate3d(${Math.round(c.sx)}px, ${Math.round(c.sy + c.px + 3)}px, 0)`;
            cap.hidden = false;
          }
        }
        /*
         * La tarjeta de zoom medio: un nodo por agente, en la misma capa y el
         * mismo pool. Con un solo output lleva su `data-art` y se comporta
         * como una ficha (clic abre, hover enciende su hilo); con varios es
         * la puerta a la galería del agente, como el contador.
         */
        const b = it.badge;
        if (b && drawn < MAX_CHIPS) {
          const key = `${it.agentId}:badge`;
          want.add(key);
          drawn++;
          let rec = live.get(key);
          if (!rec) { rec = { el: take(), sig: '' }; live.set(key, rec); }
          rec.el.dataset.agent = it.agentId;
          rec.el.dataset.key = key;
          const sig = `badge|${b.art?.id ?? ''}|${b.art?.url ?? ''}|${b.count}|${it.dim ? 'd' : ''}|${it.hot ? 'h' : ''}`;
          if (sig !== rec.sig) {
            rec.sig = sig;
            rec.el.innerHTML = badgeContent(b);
            rec.el.className = 'chip-badge' + (it.dim ? ' is-dim' : '') + (it.hot ? ' is-hot' : '');
            if (b.count === 1 && b.art) {
              rec.el.dataset.art = b.art.id;
              rec.el.title = `${b.art.title} · ${b.art.path}`;
            } else {
              delete rec.el.dataset.art;
              rec.el.title = `${b.count} OUTPUTS · ${b.art?.title ?? ''} · OPEN THE GALLERY`;
            }
            // La tarjeta mide lo que su CSS, no lo que midió la ficha que usó este nodo.
            rec.el.style.width = '';
            rec.el.style.height = '';
          }
          rec.el.style.transform = `translate3d(${Math.round(b.sx)}px, ${Math.round(b.sy)}px, 0)`;
          if (key === hoverKey && b.art) {
            cap.textContent = `${b.art.title} · ${ago(b.art.at)}`;
            cap.style.transform = `translate3d(${Math.round(b.sx)}px, ${Math.round(b.sy + 25)}px, 0)`;
            cap.hidden = false;
          }
        }
      }
      for (const [key, rec] of live) {
        if (want.has(key)) continue;
        // La ficha bajo el puntero se va con el zoom o con el recorte: el
        // puntero ya no está sobre nada, y el campo tiene que saberlo.
        if (key === hoverKey) hoverTo(null);
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
      hoverKey = null;
    },
  };
}
