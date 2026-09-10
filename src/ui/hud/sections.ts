/**
 * La puerta a las dos secciones del HUD cuando no hay sitio para las dos.
 *
 * MISIONES vive arriba a la izquierda y AUTOMEJORA arriba a la derecha, cada
 * una con su color y su forma, y las dos flotando sobre el campo. Eso funciona
 * con 1400px de ancho. Por debajo no: dos losas de 360 y 400 se tocan primero
 * y se tapan después, así que las dos se apagaban con una media query — la de
 * misiones bajo 900px, la de automejora bajo 1180px. Apagarlas no es adaptarlas.
 * En un teléfono, ORCA se quedaba sin las dos secciones y sin manera de
 * llegar a ellas que no fuera un atajo de teclado o encontrar CAPCOM.
 *
 * Esta barra es la manera. Vive en el dock —abajo, al alcance del pulgar, por
 * encima de la línea de comando y por debajo de todo lo demás en z— y tiene un
 * botón por sección con su cuenta viva. Pulsar uno abre esa sección como
 * **hoja**: la misma sección, el mismo DOM y el mismo estado, recolocada por
 * CSS para ocupar el hueco entre el mástil y el dock.
 *
 * Tres reglas que salen de lo que el operador pidió:
 *
 *  - **Una a la vez.** El estado es `<body data-sheet="missions|improve|">`, un
 *    solo valor, así que dos hojas no pueden taparse: abrir una cierra la otra.
 *  - **Nunca permanente.** El mismo botón la cierra, `Escape` la cierra y tocar
 *    el campo la cierra. El canvas se recupera con un gesto.
 *  - **Nada se pierde.** No se mueve un solo nodo: la hoja es la sección de
 *    siempre con otra caja. Los borradores, las filas desplegadas y el scroll
 *    siguen donde estaban, y volver a una ventana ancha los devuelve intactos.
 *
 * Cada botón aparece sólo donde su sección está en modo hoja (CSS): MISIONES
 * bajo 900px, AUTOMEJORA bajo 1180px. En una pantalla intermedia la barra
 * enseña una sola puerta, que es exactamente la sección que allí no cabe.
 *
 * El teclado virtual se mide, no se adivina: `visualViewport` dice cuánto ha
 * subido el suelo y esto lo publica como `--kb`, para que la hoja y la barra se
 * apoyen encima del teclado en vez de quedarse debajo.
 */

import { store } from '../store.ts';
import { visibleMissions } from '../../shared/missions.ts';
import { openProposals } from '../../shared/improve.ts';
import { isOpen, missionRows } from './mission-status.ts';

export type SectionId = 'missions' | 'improve';

export interface SectionsHandle {
  el: HTMLElement;
  /** Abre una sección como hoja, o la cierra si ya lo estaba. */
  toggle(id: SectionId): void;
  open(id: SectionId): void;
  close(): void;
  /** Qué hoja está abierta, o null. */
  openSheet(): SectionId | null;
  /** ¿Esta sección se abre como hoja en el ancho actual? */
  sheetMode(id: SectionId): boolean;
  render(): void;
  dispose(): void;
}

/** Los paneles que esta barra abre. Se los pasa `main.ts`; nadie los importa. */
export interface SectionPanels {
  missions: HTMLElement;
  improve: HTMLElement;
}

const IDS: Record<SectionId, string> = { missions: 'hud-missions', improve: 'hud-improve' };

export function mountSections(host: HTMLElement, panels: SectionPanels): SectionsHandle {
  // Los ids viven aquí y no en cada panel porque son de esta relación: lo que
  // `aria-controls` de un botón tiene que poder nombrar.
  panels.missions.id = IDS.missions;
  panels.improve.id = IDS.improve;

  const el = document.createElement('nav');
  el.className = 'secbar';
  el.setAttribute('aria-label', 'sections');
  el.innerHTML = `
    <button class="secbar__b secbar__b--missions" type="button" data-sec="missions"
      aria-expanded="false" aria-controls="${IDS.missions}">
      <span class="px secbar__t">MISSIONS</span>
      <span class="secbar__n" data-n="missions">0</span>
    </button>
    <button class="secbar__b secbar__b--improve" type="button" data-sec="improve"
      aria-expanded="false" aria-controls="${IDS.improve}">
      <span class="px secbar__t">SELF-IMPROVEMENT</span>
      <span class="secbar__n" data-n="improve">0</span>
    </button>
    <button class="secbar__x" type="button" data-close aria-label="close section" hidden>×</button>
  `;
  host.appendChild(el);

  const buttons = new Map<SectionId, HTMLButtonElement>(
    (['missions', 'improve'] as SectionId[]).map((id) => [id, el.querySelector<HTMLButtonElement>(`[data-sec="${id}"]`)!]),
  );
  const closeBtn = el.querySelector<HTMLButtonElement>('[data-close]')!;

  function current(): SectionId | null {
    const v = document.body.dataset['sheet'];
    return v === 'missions' || v === 'improve' ? v : null;
  }

  function paintState() {
    const on = current();
    for (const [id, b] of buttons) {
      b.classList.toggle('is-on', on === id);
      b.setAttribute('aria-expanded', on === id ? 'true' : 'false');
    }
    closeBtn.hidden = !on;
    // El panel abierto se anuncia como región; el cerrado no está en el árbol
    // de accesibilidad porque CSS lo ha quitado.
    panels.missions.setAttribute('aria-hidden', on === 'missions' || !isSheet('missions') ? 'false' : 'true');
    panels.improve.setAttribute('aria-hidden', on === 'improve' || !isSheet('improve') ? 'false' : 'true');
  }

  /** ¿Esta sección está en modo hoja en el ancho actual? La CSS es la fuente. */
  function isSheet(id: SectionId): boolean {
    return matchMedia(id === 'missions' ? '(max-width: 900px)' : '(max-width: 1180px)').matches;
  }

  function open(id: SectionId) {
    document.body.dataset['sheet'] = id;
    paintState();
    // Traer el principio de la lista, que es lo que se viene a leer.
    (id === 'missions' ? panels.missions : panels.improve)
      .querySelector<HTMLElement>('.scroll')?.scrollTo({ top: 0 });
  }

  function close() {
    delete document.body.dataset['sheet'];
    paintState();
  }

  function toggle(id: SectionId) {
    if (current() === id) close(); else open(id);
  }

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) { close(); return; }
    const b = t.closest<HTMLElement>('[data-sec]');
    if (!b) return;
    b.blur();
    toggle(b.dataset['sec'] as SectionId);
  });

  /** La cuenta de cada botón: lo mismo que dice la cabecera de cada sección. */
  function render() {
    const rows = missionRows(visibleMissions(store.world.missions ?? {}), (id) => store.knownAgent(id));
    const openMissions = rows.filter((r) => isOpen(r.phase)).length;
    const nm = el.querySelector<HTMLElement>('[data-n="missions"]')!;
    nm.textContent = String(openMissions);
    buttons.get('missions')!.classList.toggle('has-open', openMissions > 0);

    const board = store.improve;
    const ni = el.querySelector<HTMLElement>('[data-n="improve"]')!;
    // Sin tablero todavía no hay cero que dar: un cero afirmaría que no hay
    // nada, y lo cierto es que no ha llegado.
    const n = board ? openProposals(board, Date.now()).length : null;
    ni.textContent = n === null ? '—' : String(n);
    buttons.get('improve')!.classList.toggle('has-open', (n ?? 0) > 0);
  }

  /* ── Cerrar sin buscar el botón ───────────────────────────────── */

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !current()) return;
    // Un input dentro de la hoja se queda con su Escape: primero se sale de la
    // caja, y sólo un Escape que no tiene dónde ir cierra la sección.
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);

  /**
   * Tocar el campo la cierra. En captura y sobre `pointerdown`, para que el
   * gesto que empieza a arrastrar el campo cierre la hoja antes de mover nada
   * y no haga las dos cosas a la vez.
   */
  const onDown = (e: PointerEvent) => {
    if (!current()) return;
    const t = e.target as HTMLElement | null;
    if (!t || t.closest('.secbar') || t.closest('.missions') || t.closest('.improve') || t.closest('.win')) return;
    close();
  };
  document.addEventListener('pointerdown', onDown, true);

  /**
   * El suelo cuando sale el teclado virtual.
   *
   * `visualViewport.height` baja al abrirse el teclado; la diferencia con la
   * ventana es lo que hay que subir la barra y el borde de abajo de la hoja
   * para que la caja donde se escribe no quede debajo del teclado. Se publica
   * como `--kb` en el root y lo consume la hoja en CSS.
   */
  const vv = window.visualViewport;
  const onViewport = () => {
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);
  onViewport();

  // Volver a una ventana ancha devuelve las dos secciones a su sitio: la hoja
  // ya no existe ahí, y dejar la marca puesta haría que una vuelta a estrecho
  // reabriera algo que el operador no pidió.
  const wide = matchMedia('(min-width: 1181px)');
  const onWide = () => { if (wide.matches) close(); };
  wide.addEventListener('change', onWide);

  const off = store.on((e) => {
    if (e.k === 'missions' || e.k === 'agents' || e.k === 'world' || e.k === 'improve') render();
  });
  paintState();
  render();

  return {
    el, toggle, open, close, render,
    openSheet: current,
    sheetMode: isSheet,
    dispose() {
      off();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
      wide.removeEventListener('change', onWide);
      el.remove();
    },
  };
}
