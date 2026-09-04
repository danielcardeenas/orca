/**
 * Tira de telemetría inferior — 26px de altura, siempre en movimiento.
 *
 * Es lo único de la consola que corre literalmente todo el día, así que está
 * escrita como un instrumento y no como una lista:
 *
 *  - Un solo `transform` por frame. Los items se posicionan una vez con `left`
 *    en coordenadas de mundo y la pista entera se desplaza; animar `left` o
 *    reconstruir la lista provocaría layout en cada frame, 24/7.
 *  - Los nodos se reciclan. Un item que sale por la izquierda vuelve al pool y
 *    se rellena con texto nuevo, así el DOM se estabiliza en ~20 nodos aunque
 *    pasen cientos de líneas por minuto.
 *  - Nunca está vacía ni quieta: sin telemetría muestra un scramble de glifos
 *    como el POST del arranque; con telemetría vieja la recicla en bucle.
 */

import type { FeedItem } from '../../shared/types.ts';
import { store } from '../store.ts';

/** Velocidad de desplazamiento. Lenta a propósito: es legible, no urgente. */
const SPEED_PX_S = 35;
/** Separación entre items, en px de mundo. */
const GAP = 34;
/** Cuánto pre-llenamos por la derecha y cuánto toleramos por la izquierda. */
const PAD = 160;
/** Cuántos items guardamos para reciclar cuando no llega nada nuevo. */
const HISTORY = 60;
/** Cadencia del scramble, la misma que usa el boot. */
const SCRAMBLE_MS = 70;
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Ancho estimado por carácter cuando no hay layout (tests, pestaña oculta). */
const CHAR_PX = 6;
/** A partir de aquí rebasamos las coordenadas para no acumular error en float. */
const REBASE_AT = 1e7;

interface Slot {
  node: HTMLElement;
  src: HTMLElement;
  txt: HTMLElement;
  /** Borde izquierdo en coordenadas de mundo. */
  x: number;
  w: number;
}

export interface FeedHandle {
  destroy(): void;
  /** Contadores para el arnés de pruebas: creados vs. colocados. */
  stats(): { created: number; placed: number; live: number; pooled: number };
}

export function mountFeed(el: HTMLElement): FeedHandle {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  el.innerHTML = `
    <div class="feed__lane" data-lane>
      <div class="feed__track" data-track></div>
      <div class="feed__scramble px px--tiny" data-scramble hidden></div>
    </div>
  `;

  const lane = el.querySelector<HTMLElement>('[data-lane]')!;
  const track = el.querySelector<HTMLElement>('[data-track]')!;
  const scrambleEl = el.querySelector<HTMLElement>('[data-scramble]')!;

  /* ── Fuentes de items ───────────────────────────────────────────── */

  /** Items aún no mostrados, en orden de llegada. */
  const queue: FeedItem[] = [];
  /** Últimos items mostrados, para reciclar cuando la flota está callada. */
  const history: FeedItem[] = [];
  let cycle = 0;
  /** Último id consumido del store, para no re-encolar lo ya visto. */
  let lastId: string | null = null;

  function drain() {
    const feed = store.world.feed;
    if (!feed.length) return;
    let from = 0;
    if (lastId !== null) {
      const i = feed.findIndex((f) => f.id === lastId);
      // Si el id se salió del buffer del store, retomamos por la cola.
      from = i >= 0 ? i + 1 : Math.max(0, feed.length - 50);
    }
    for (let i = from; i < feed.length; i++) {
      const item = feed[i];
      if (item) queue.push(item);
    }
    const last = feed[feed.length - 1];
    if (last) lastId = last.id;
    // Una ráfaga enorme no debe volverse una cola de minutos.
    if (queue.length > 200) queue.splice(0, queue.length - 200);
  }

  function nextItem(): FeedItem | null {
    const fresh = queue.shift();
    if (fresh) {
      history.push(fresh);
      if (history.length > HISTORY) history.shift();
      return fresh;
    }
    if (!history.length) return null;
    const item = history[cycle % history.length];
    cycle = (cycle + 1) % Math.max(1, history.length);
    return item ?? null;
  }

  /* ── Nodos ──────────────────────────────────────────────────────── */

  const live: Slot[] = [];
  const pool: Slot[] = [];
  let created = 0;
  let placed = 0;

  function takeSlot(): Slot {
    const reused = pool.pop();
    if (reused) return reused;
    created++;
    const node = document.createElement('div');
    node.className = 'feed__item';
    // Posición absoluta: los items no participan en el layout de la pista, así
    // insertar uno nuevo no reflowea los que ya se están desplazando.
    node.style.position = 'absolute';
    node.style.top = '50%';
    node.style.transform = 'translateY(-50%)';
    const src = document.createElement('span');
    src.className = 'feed__src';
    const txt = document.createElement('span');
    txt.className = 'feed__txt';
    node.appendChild(src);
    node.appendChild(txt);
    return { node, src, txt, x: 0, w: 0 };
  }

  /** Coloca un item en el borde derecho del mundo conocido. */
  function place(item: FeedItem, x: number): Slot {
    const slot = takeSlot();
    slot.src.textContent = item.source;
    slot.txt.textContent = item.text;
    slot.node.dataset.lv = item.level;
    if (item.agentId) slot.node.dataset.agent = item.agentId;
    else delete slot.node.dataset.agent;
    slot.node.style.left = x + 'px';
    slot.x = x;
    if (!slot.node.parentNode) track.appendChild(slot.node);

    // offsetWidth es 0 sin layout (pestaña oculta, DOM de prueba): estimamos.
    slot.w = slot.node.offsetWidth || (item.source.length + item.text.length + 4) * CHAR_PX;

    if (item.level === 'alert') {
      // Reiniciar la animación en un nodo reciclado exige un reflow explícito.
      slot.node.classList.remove('is-flash');
      void slot.node.offsetWidth;
      slot.node.classList.add('is-flash');
    } else {
      slot.node.classList.remove('is-flash');
    }
    placed++;
    live.push(slot);
    return slot;
  }

  function release(slot: Slot) {
    slot.node.remove();
    slot.node.classList.remove('is-flash');
    pool.push(slot);
  }

  /* ── Bucle ──────────────────────────────────────────────────────── */

  let scrollX = 0;
  /** Borde derecho del último item colocado, en coordenadas de mundo. */
  let cursor = 0;
  let paused = false;
  let raf = 0;
  let lastT = 0;

  /** `hidden` se refleja a un atributo: escribirlo cada frame invalidaría
   *  estilo 60 veces por segundo para nada. */
  function setHidden(node: HTMLElement, v: boolean) {
    if (node.hidden !== v) node.hidden = v;
  }

  function laneWidth(): number {
    return lane.clientWidth || el.clientWidth || 1200;
  }

  function fill() {
    const limit = scrollX + laneWidth() + PAD;
    // Tope de seguridad: si todos los items midieran 0 esto no debe girar sin fin.
    let guard = 64;
    while (cursor < limit && guard-- > 0) {
      const item = nextItem();
      if (!item) break;
      // Si la tira se quedó sin nodos vivos, el siguiente item no debe aparecer
      // en medio del vidrio: arranca desde donde está la vista.
      const x = live.length ? cursor + GAP : Math.max(cursor + GAP, scrollX);
      const slot = place(item, x);
      cursor = slot.x + slot.w;
    }
  }

  function reap() {
    while (live.length) {
      const first = live[0];
      if (!first || first.x + first.w >= scrollX - PAD) break;
      live.shift();
      release(first);
    }
  }

  function rebase() {
    if (scrollX < REBASE_AT) return;
    const d = scrollX;
    scrollX = 0;
    cursor -= d;
    for (const s of live) {
      s.x -= d;
      s.node.style.left = s.x + 'px';
    }
  }

  function tick(t: number) {
    raf = requestAnimationFrame(tick);
    const dt = lastT ? Math.min(120, t - lastT) : 16;
    lastT = t;

    const empty = !live.length && !queue.length && !history.length;
    setHidden(scrambleEl, !empty);
    setHidden(track, empty);
    if (empty) return;

    if (!paused && !reduce && document.visibilityState !== 'hidden') {
      scrollX += (SPEED_PX_S * dt) / 1000;
    }
    fill();
    reap();
    rebase();
    if (reduce) {
      // Sin movimiento, al menos mostramos la cola más reciente.
      scrollX = Math.max(0, cursor - laneWidth());
    }
    track.style.transform = `translateX(${(-scrollX).toFixed(1)}px)`;
  }

  /* ── Scramble de reposo ─────────────────────────────────────────── */

  function scramble(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) {
      s += GLYPHS[(Math.random() * GLYPHS.length) | 0] + (i % 4 === 3 ? ' ' : '');
    }
    return s;
  }
  scrambleEl.textContent = scramble(48);
  const scrambleTimer = reduce ? 0 : window.setInterval(() => {
    if (scrambleEl.hidden) return; // no gastamos ciclos mientras hay telemetría
    scrambleEl.textContent = scramble(48);
  }, SCRAMBLE_MS);

  /* ── Interacción ────────────────────────────────────────────────── */

  const onEnter = () => { paused = true; el.classList.add('is-paused'); };
  const onLeave = () => { paused = false; el.classList.remove('is-paused'); };
  const onClick = (e: Event) => {
    const hit = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-agent]');
    const id = hit?.dataset.agent;
    if (!id) return;
    window.dispatchEvent(new CustomEvent('orca:open-agent', { detail: { id } }));
  };

  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('click', onClick);

  const off = store.on((e) => {
    if (e.k === 'feed') drain();
    else if (e.k === 'world') { lastId = null; drain(); }
  });

  drain();
  raf = requestAnimationFrame(tick);

  return {
    destroy() {
      off();
      cancelAnimationFrame(raf);
      if (scrambleTimer) window.clearInterval(scrambleTimer);
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick);
      el.textContent = '';
    },
    stats: () => ({ created, placed, live: live.length, pooled: pool.length }),
  };
}
