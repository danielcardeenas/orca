/**
 * Left rail: machines, then projects.
 *
 * This is the fleet's table of contents. It answers two questions without a
 * click — which machines are alive, and which projects want something — and
 * nothing else. Anything richer belongs on the stage.
 */

import type { Machine, Project } from '../../shared/types.ts';
import { AGENT_STATES } from '../../shared/types.ts';
import { store } from '../store.ts';

/** Selected project, or null for "the whole fleet". Read by the deck. */
export let selectedProject: string | null = null;

export function mountRail(el: HTMLElement) {
  el.innerHTML = `
    <div class="rail__head">
      <p class="px px--tiny">FLEET</p>
      <div class="rail__machines" data-machines></div>
    </div>
    <div class="rail__list scroll" data-projects></div>
  `;

  const machinesEl = el.querySelector<HTMLElement>('[data-machines]')!;
  const projectsEl = el.querySelector<HTMLElement>('[data-projects]')!;

  // Reconcile by id rather than re-rendering: this list repaints on every
  // patch, and blowing away the DOM would kill hover and scroll position.
  const machineNodes = new Map<string, HTMLElement>();
  const projectNodes = new Map<string, HTMLElement>();

  function paintMachines() {
    const list = store.machines();
    const seen = new Set<string>();
    for (const m of list) {
      seen.add(m.id);
      let node = machineNodes.get(m.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'machine';
        node.innerHTML = `<i class="machine__led"></i>
          <span class="machine__name px"></span>
          <span class="machine__n"></span>`;
        machineNodes.set(m.id, node);
        machinesEl.appendChild(node);
      }
      paintMachine(node, m);
    }
    for (const [id, node] of machineNodes) {
      if (!seen.has(id)) { node.remove(); machineNodes.delete(id); }
    }
    emptyState(machinesEl, list.length === 0, 'NO COLLECTORS');
  }

  function paintMachine(node: HTMLElement, m: Machine) {
    node.classList.toggle('is-online', m.online);
    const name = node.querySelector<HTMLElement>('.machine__name')!;
    const n = node.querySelector<HTMLElement>('.machine__n')!;
    const label = m.hostname.replace(/\.local$/, '');
    if (name.textContent !== label) name.textContent = label;
    const count = `${m.load.activeSessions}/${m.load.sessions}`;
    if (n.textContent !== count) n.textContent = count;
    node.title = `${m.hostname} · ${m.platform} · ${m.online ? 'online' : 'offline'}`;
  }

  function paintProjects() {
    const list = store.activeProjects();
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      let node = projectNodes.get(p.id);
      if (!node) {
        node = document.createElement('button');
        node.className = 'proj';
        node.setAttribute('type', 'button');
        node.dataset.projectId = p.id;
        node.innerHTML = `<span class="proj__code"></span>
          <span class="proj__name"></span>
          <span class="proj__meta"><span class="statebar"></span><span class="proj__n px px--tiny"></span></span>`;
        projectNodes.set(p.id, node);
      }
      paintProject(node, p);
      // Order changes as urgency changes; appendChild moves an existing node.
      projectsEl.appendChild(node);
    }
    for (const [id, node] of projectNodes) {
      if (!seen.has(id)) { node.remove(); projectNodes.delete(id); }
    }
    emptyState(projectsEl, list.length === 0, 'NO ACTIVE PROJECTS');
  }

  function paintProject(node: HTMLElement, p: Project) {
    const code = node.querySelector<HTMLElement>('.proj__code')!;
    const name = node.querySelector<HTMLElement>('.proj__name')!;
    const n = node.querySelector<HTMLElement>('.proj__n')!;
    const bar = node.querySelector<HTMLElement>('.statebar')!;

    if (code.textContent !== p.code) code.textContent = p.code;
    if (name.textContent !== p.name) name.textContent = p.name;
    const total = String(p.rollup.total);
    if (n.textContent !== total) n.textContent = total;

    node.classList.toggle('is-sel', selectedProject === p.id);
    node.classList.toggle('has-block', p.rollup.blocked > 0);
    node.title = `${p.path}${p.gitBranch ? ` · ${p.gitBranch}${p.gitDirty ? '*' : ''}` : ''}`;

    // The state bar is the whole story of a project in 40 pixels.
    const parts: string[] = [];
    for (const s of AGENT_STATES) {
      const c = p.rollup.byState[s];
      if (!c) continue;
      const pct = (c / Math.max(1, p.rollup.total)) * 100;
      parts.push(`<i data-s="${s}" style="width:${pct.toFixed(1)}%"></i>`);
    }
    const html = parts.join('');
    if (bar.innerHTML !== html) bar.innerHTML = html;
  }

  /**
   * Placeholder que convive con la reconciliación por id: se añade y se quita,
   * nunca reescribe el contenedor.
   */
  function emptyState(host: HTMLElement, show: boolean, text: string) {
    const existing = host.querySelector<HTMLElement>('.rail__empty');
    if (show && !existing) {
      const p = document.createElement('p');
      p.className = 'px px--tiny rail__empty';
      p.textContent = text;
      host.appendChild(p);
    } else if (!show && existing) {
      existing.remove();
    }
  }

  projectsEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-project-id]');
    if (!b) return;
    const id = b.dataset.projectId!;
    // Clicking the selected project clears the filter — back to the whole fleet.
    selectedProject = selectedProject === id ? null : id;
    paintProjects();
    window.dispatchEvent(new CustomEvent('orca:select-project', {
      detail: { id: selectedProject },
    }));
  });

  store.on((e) => {
    if (e.k === 'world') { paintMachines(); paintProjects(); }
    else if (e.k === 'machines') paintMachines();
    else if (e.k === 'projects' || e.k === 'agents') paintProjects();
  });

  paintMachines();
  paintProjects();
}
