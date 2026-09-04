/**
 * The deck: every agent in the fleet as an instrument tile.
 *
 * Sorting is the product. Blocked agents come first, always, because they are
 * the only ones that cost the operator anything by being ignored. Everything
 * below that is ordered by how much is happening, so the top of the deck is
 * where attention belongs and the bottom can be scrolled past forever.
 */

import gsap from 'gsap';
import type { Agent, AgentState } from '../../shared/types.ts';
import { store } from '../store.ts';
import { selectedProject } from './rail.ts';

/** Sort weight per state. Lower sorts first. */
const RANK: Record<AgentState, number> = {
  blocked: 0, working: 1, thinking: 2, booting: 3, idle: 4, done: 5, dead: 6,
};

const STATE_LABEL: Record<AgentState, string> = {
  booting: 'BOOTING', thinking: 'THINKING', working: 'WORKING',
  blocked: 'NEEDS YOU', idle: 'IDLE', done: 'DONE', dead: 'DEAD',
};

export function mountDeck(el: HTMLElement) {
  el.innerHTML = `
    <div class="deck">
      <div class="deck__head">
        <p class="px px--tiny" data-scope>ALL PROJECTS</p>
        <div class="deck__filters" data-filters>
          <button type="button" class="dfilter is-on" data-filter="live">LIVE</button>
          <button type="button" class="dfilter" data-filter="all">ALL</button>
          <button type="button" class="dfilter" data-filter="blocked">BLOCKED</button>
        </div>
      </div>
      <div class="deck__grid scroll" data-grid></div>
      <div class="deck__empty px px--tiny" data-empty hidden>NO AGENTS IN SCOPE</div>
    </div>
  `;

  const grid = el.querySelector<HTMLElement>('[data-grid]')!;
  const scopeEl = el.querySelector<HTMLElement>('[data-scope]')!;
  const emptyEl = el.querySelector<HTMLElement>('[data-empty]')!;
  const nodes = new Map<string, HTMLElement>();
  let filter: 'live' | 'all' | 'blocked' = 'live';

  el.querySelector('[data-filters]')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter as typeof filter;
    for (const x of el.querySelectorAll<HTMLElement>('[data-filter]')) {
      x.classList.toggle('is-on', x === b);
    }
    paint();
  });

  grid.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-agent-id]');
    if (!t) return;
    window.dispatchEvent(new CustomEvent('orca:open-agent', {
      detail: { id: t.dataset.agentId },
    }));
  });

  function inScope(a: Agent): boolean {
    if (selectedProject && a.projectId !== selectedProject) return false;
    if (filter === 'blocked') return a.state === 'blocked';
    if (filter === 'live') return a.state !== 'done' && a.state !== 'dead';
    return true;
  }

  function paint() {
    const list = Object.values(store.world.agents)
      .filter(inScope)
      .sort((a, b) => {
        if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] - RANK[b.state];
        // Within a state, the busiest first, then the most recently touched.
        if (b.metrics.tokensPerSec !== a.metrics.tokensPerSec) {
          return b.metrics.tokensPerSec - a.metrics.tokensPerSec;
        }
        return b.updatedAt - a.updatedAt;
      });

    const seen = new Set<string>();
    for (const a of list) {
      seen.add(a.id);
      let node = nodes.get(a.id);
      const fresh = !node;
      if (!node) {
        node = build(a);
        nodes.set(a.id, node);
      }
      update(node, a);
      grid.appendChild(node); // moves an existing node into its new slot
      if (fresh) {
        // The comp's glyph pop, reused: a tile arrives, it does not fade in.
        gsap.fromTo(node,
          { autoAlpha: 0, scale: 0.72 },
          { autoAlpha: 1, scale: 1, duration: 0.22, ease: 'back.out(2)' });
      }
    }
    for (const [id, node] of nodes) {
      if (seen.has(id)) continue;
      nodes.delete(id);
      gsap.to(node, {
        autoAlpha: 0, scale: 0.9, duration: 0.16, ease: 'power2.in',
        onComplete: () => node.remove(),
      });
    }

    const p = selectedProject ? store.world.projects[selectedProject] : null;
    const scope = p ? `${p.code} · ${p.name}` : 'ALL PROJECTS';
    if (scopeEl.textContent !== scope) scopeEl.textContent = scope;
    emptyEl.hidden = list.length > 0;
  }

  function build(a: Agent): HTMLElement {
    const node = document.createElement('article');
    node.className = 'atile';
    node.dataset.agentId = a.id;
    node.innerHTML = `
      <header class="atile__top">
        <span class="atile__call px"></span>
        <span class="atile__proj px px--tiny"></span>
        <span class="atile__spacer"></span>
        <span class="atile__state px px--tiny"></span>
      </header>
      <p class="atile__title mono"></p>
      <div class="atile__tool">
        <span class="atile__toolname px px--tiny"></span>
        <span class="atile__tooldetail mono"></span>
      </div>
      <div class="atile__act"><i></i></div>
      <footer class="atile__foot">
        <span class="atile__lineage px px--tiny"></span>
        <span class="atile__spacer"></span>
        <span class="atile__cost px px--tiny"></span>
        <span class="atile__tps px px--tiny"></span>
        <span class="atile__up px px--tiny"></span>
      </footer>
    `;
    return node;
  }

  function update(node: HTMLElement, a: Agent) {
    const prev = node.dataset.state as AgentState | undefined;
    if (prev !== a.state) {
      node.dataset.state = a.state;
      if (prev) flashState(node, a.state);
    }

    const set = (sel: string, text: string) => {
      const n = node.querySelector<HTMLElement>(sel);
      if (n && n.textContent !== text) n.textContent = text;
    };

    set('.atile__call', a.callsign);
    set('.atile__state', STATE_LABEL[a.state]);
    set('.atile__title', a.title || a.mission || 'UNTITLED SESSION');

    const proj = store.world.projects[a.projectId];
    set('.atile__proj', proj?.code ?? '··');

    // While working, the tool line is the most useful text on the tile; when
    // blocked it is replaced by what the agent wants, which matters more.
    const toolEl = node.querySelector<HTMLElement>('.atile__tool')!;
    if (a.state === 'blocked' && a.block) {
      toolEl.hidden = false;
      set('.atile__toolname', a.block.kind.toUpperCase());
      set('.atile__tooldetail', a.block.summary);
    } else if (a.state === 'working' && a.tool) {
      toolEl.hidden = false;
      set('.atile__toolname', a.tool.toUpperCase());
      set('.atile__tooldetail', a.toolDetail ?? '');
    } else {
      toolEl.hidden = true;
    }

    const kids = a.childIds.length;
    const lineage = kids ? `▽ ${kids} SPAWNED` : a.parentId ? '△ SUBAGENT' : '';
    set('.atile__lineage', lineage);

    set('.atile__cost', '$' + a.metrics.costUSD.toFixed(2));
    set('.atile__tps', a.metrics.tokensPerSec > 0
      ? Math.round(a.metrics.tokensPerSec) + '/S' : '');
    const running = a.state === 'working' || a.state === 'thinking' || a.state === 'booting';
    set('.atile__up', running ? fmtUptime(a.uptimeMs) : fmtAgo(a.updatedAt));

    // The activity bar carries speed, not progress. Faster agent, faster bar.
    // Nothing here ever fills to 100% — that would be a lie about completion.
    const act = node.querySelector<HTMLElement>('.atile__act')!;
    const live = a.state === 'working' || a.state === 'thinking';
    act.classList.toggle('is-live', live);
    if (live) {
      const tps = Math.min(60, a.metrics.tokensPerSec);
      // 2.4s at rest down to 0.5s flat out. Amplitude comes from the state
      // colour; speed is the only thing tokens/s is allowed to drive.
      const dur = 2.4 - (tps / 60) * 1.9;
      act.style.setProperty('--act-dur', dur.toFixed(2) + 's');
    }
  }

  /** A state change snaps — the comp never cross-fades an instrument. */
  function flashState(node: HTMLElement, to: AgentState) {
    const color = to === 'blocked' ? 'var(--amber)'
      : to === 'dead' ? 'var(--red)'
      : 'var(--lime)';
    gsap.killTweensOf(node);
    gsap.fromTo(node,
      { boxShadow: `inset 0 0 0 1px ${color}, 0 0 22px -6px ${color}` },
      { boxShadow: 'inset 0 0 0 0px transparent, 0 0 0px transparent',
        duration: 0.6, ease: 'power2.out', clearProps: 'boxShadow' });
  }

  window.addEventListener('orca:select-project', () => paint());
  store.on((e) => {
    if (e.k === 'world' || e.k === 'agents' || e.k === 'projects') paint();
  });
  paint();
}

/**
 * Cuánto hace que este agente se movió. Para todo lo que no está corriendo es
 * el dato útil: un uptime de 1512 horas es verdad y no dice nada, mientras que
 * "hace 3 min" y "hace 4 días" son decisiones distintas.
 */
function fmtAgo(at: number): string {
  if (!at) return '';
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return s + 'S AGO';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'M AGO';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'H AGO';
  return Math.floor(h / 24) + 'D AGO';
}

function fmtUptime(ms: number): string {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 'S';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'M';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'H ' + (m % 60) + 'M';
  return Math.floor(h / 24) + 'D';
}
