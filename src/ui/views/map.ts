/**
 * The map — what is waiting on what.
 *
 * The deck already answers "who is working" and "who needs me". The map only
 * earns its place by answering what the deck cannot: **how much work is dammed
 * up behind each unanswered question**, including yours.
 *
 * If T1 is waiting on K9, and K9 is waiting on you, then answering one question
 * releases two agents. That fact exists in the data today and is invisible
 * everywhere. Here it is a chain you can see, ending at a node labelled YOU.
 *
 * Three deliberate constraints, each one a lesson from the 3D version this
 * replaces:
 *
 *  - **No camera.** The same fleet lays out the same way every time. Spatial
 *    memory only works if the picture holds still.
 *  - **Nothing hidden.** Flat, orthogonal, no occlusion. A monitoring view
 *    where something can be behind something else is a monitoring view that
 *    lies.
 *  - **Only what is connected.** An agent with no parent, no child, no message
 *    and no block contributes nothing to a relationship view. It belongs in
 *    the deck, and leaving it out is what keeps this readable at eighty agents.
 */

import gsap from 'gsap';
import type { Agent, AgentMessage, AgentState, Collision } from '../../shared/types.ts';
import { store } from '../store.ts';

const NS = 'http://www.w3.org/2000/svg';

/* Geometry. Everything derives from these, so the whole map rescales here. */
const NODE_W = 84;
const NODE_H = 26;
const COL_GAP = 62;
const ROW_GAP = 20;
const PAD_X = 34;
const PAD_Y = 26;
/** The human sits in a band of their own above every project. */
const HUMAN_BAND = 74;

const STATE_COLOR: Record<AgentState, string> = {
  booting: 'var(--st-booting)',
  thinking: 'var(--st-thinking)',
  working: 'var(--st-working)',
  blocked: 'var(--st-blocked)',
  idle: 'var(--st-idle)',
  done: 'var(--st-done)',
  dead: 'var(--st-dead)',
};

type EdgeKind = 'lineage' | 'notice' | 'ask' | 'human' | 'collision';

interface Node {
  id: string;
  kind: 'agent' | 'human';
  agent: Agent | null;
  projectId: string;
  depth: number;
  x: number;
  y: number;
  /** The human node grows with the queue; everything else is NODE_W. */
  w: number;
}

interface Edge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** One line, shown on hover. */
  label: string;
  /** For an unanswered ask or an escalation: how long it has been waiting. */
  since: number | null;
}

interface Graph {
  nodes: Map<string, Node>;
  edges: Edge[];
  /** Agents blocked behind each terminus, transitively. */
  dammed: Map<string, string[]>;
  width: number;
  height: number;
}

export function mountMap(el: HTMLElement) {
  el.innerHTML = `
    <div class="map">
      <div class="map__head">
        <p class="px px--tiny" data-summary>NOTHING IS WAITING</p>
        <div class="map__legend px px--tiny">
          <span><i class="map__key map__key--lineage"></i>SPAWNED</span>
          <span><i class="map__key map__key--notice"></i>TOLD</span>
          <span><i class="map__key map__key--ask"></i>WAITING ON</span>
          <span><i class="map__key map__key--collision"></i>SAME FILE</span>
        </div>
      </div>
      <div class="map__scroll scroll" data-scroll>
        <svg class="map__svg" data-svg xmlns="${NS}"></svg>
      </div>
      <p class="map__empty px px--tiny" data-empty hidden>
        NOTHING IS CONNECTED YET.<br/>
        AGENTS APPEAR HERE WHEN THEY SPAWN EACH OTHER, TALK, BLOCK, OR TOUCH THE SAME FILE.
      </p>
    </div>
  `;

  const svg = el.querySelector<SVGSVGElement>('[data-svg]')!;
  const scroll = el.querySelector<HTMLElement>('[data-scroll]')!;
  const summaryEl = el.querySelector<HTMLElement>('[data-summary]')!;
  const emptyEl = el.querySelector<HTMLElement>('[data-empty]')!;

  /** Live SVG groups per node, so positions can be eased instead of jumping. */
  const nodeEls = new Map<string, SVGGElement>();
  let active = false;
  let dirty = false;

  const edgeLayer = document.createElementNS(NS, 'g');
  const nodeLayer = document.createElementNS(NS, 'g');
  svg.append(edgeLayer, nodeLayer);

  function paint() {
    if (!active) { dirty = true; return; }
    dirty = false;

    const g = buildGraph();
    svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
    svg.setAttribute('width', String(g.width));
    svg.setAttribute('height', String(g.height));

    emptyEl.hidden = g.nodes.size > 1;
    paintSummary(summaryEl, g);
    paintEdges(edgeLayer, g);
    paintNodes(nodeLayer, nodeEls, g);
  }

  /* Clicking a node opens the agent; the map is for seeing, the drawer for
     acting. Clicking the human node scrolls the interrupt queue into view. */
  svg.addEventListener('click', (ev) => {
    const node = (ev.target as Element).closest<SVGGElement>('[data-node-id]');
    if (!node) return;
    const id = node.dataset.nodeId!;
    if (id === 'human') {
      window.dispatchEvent(new CustomEvent('orca:open-escalation', { detail: {} }));
      return;
    }
    window.dispatchEvent(new CustomEvent('orca:open-agent', { detail: { id } }));
  });

  store.on((e) => {
    if (e.k === 'world' || e.k === 'agents' || e.k === 'projects'
      || e.k === 'escalations' || e.k === 'traffic') paint();
  });

  return {
    setActive(on: boolean) {
      active = on;
      if (on && (dirty || nodeEls.size === 0)) paint();
      // Nothing runs per-frame here: a static picture costs nothing to leave up.
      if (on) scroll.scrollTop = 0;
    },
  };
}

/* ── Graph construction ───────────────────────────────────────────── */

/**
 * An agent belongs on the map only if it is part of a relationship. That is
 * what keeps eighty agents legible, and what makes this view a different tool
 * from the deck rather than a second copy of it.
 */
function isRelevant(a: Agent, traffic: AgentMessage[], collisions: Collision[]): boolean {
  if (a.state === 'blocked') return true;
  if (a.parentId) return true;
  if (a.childIds.length > 0) return true;
  if (traffic.some((m) => m.fromAgentId === a.id || m.toAgentId === a.id)) return true;
  if (collisions.some((c) => c.agentIds.includes(a.id))) return true;
  return false;
}

function buildGraph(): Graph {
  const w = store.world;
  const traffic = Object.values(w.messages ?? {});
  const collisions = Object.values(w.collisions ?? {})
    .filter((c) => !c.acknowledged);

  const agents = Object.values(w.agents)
    .filter((a) => a.state !== 'done' && a.state !== 'dead')
    .filter((a) => isRelevant(a, traffic, collisions));

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];

  /* ── Columns: one per project that has anything on the map ──────── */
  const byProject = new Map<string, Agent[]>();
  for (const a of agents) {
    const list = byProject.get(a.projectId);
    if (list) list.push(a); else byProject.set(a.projectId, [a]);
  }

  // Stable order: the rail's order, so the two views agree about where a
  // project lives. A map that reshuffles is a map you cannot learn.
  const columns = store.activeProjects()
    .filter((p) => byProject.has(p.id))
    .map((p) => p.id);

  /* Centre the column block. A map hugging the left edge of a wide screen
     reads as unfinished, and centring costs nothing since the layout is
     deterministic either way. */
  const blockW = Math.max(1, columns.length) * NODE_W
    + Math.max(0, columns.length - 1) * COL_GAP;
  const originX = PAD_X;

  let maxRows = 0;
  columns.forEach((projectId, col) => {
    const list = (byProject.get(projectId) ?? []).slice();
    // Parents above children; within a depth, the ones that need a human first.
    list.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if ((a.state === 'blocked') !== (b.state === 'blocked')) {
        return a.state === 'blocked' ? -1 : 1;
      }
      return a.callsign.localeCompare(b.callsign);
    });
    list.forEach((a, row) => {
      nodes.set(a.id, {
        id: a.id, kind: 'agent', agent: a, projectId, depth: a.depth,
        x: originX + col * (NODE_W + COL_GAP),
        y: PAD_Y + HUMAN_BAND + row * (NODE_H + ROW_GAP),
        w: NODE_W,
      });
    });
    maxRows = Math.max(maxRows, list.length);
  });

  /*
   * The human, centred over the columns.
   *
   * Its width grows with how many agents are waiting on it. That is not
   * decoration: eleven edges converging on one 84px box is a bundle nobody can
   * trace, and a node whose size *is* the size of your backlog both fixes the
   * convergence and says something true at a glance.
   */
  const width = Math.max(360, PAD_X * 2 + blockW);
  const waitingOnHuman = Object.values(w.agents)
    .filter((a) => a.state === 'blocked' && a.block && a.block.kind !== 'peer').length;
  const humanW = Math.min(360, Math.max(NODE_W, waitingOnHuman * 26));
  nodes.set('human', {
    id: 'human', kind: 'human', agent: null, projectId: '', depth: -1,
    x: Math.round(width / 2 - humanW / 2), y: PAD_Y, w: humanW,
  });

  /* ── Edges ──────────────────────────────────────────────────────── */

  for (const a of agents) {
    // Lineage. Quiet by design: it is context, not a call to action.
    if (a.parentId && nodes.has(a.parentId)) {
      edges.push({
        id: `l:${a.parentId}:${a.id}`, kind: 'lineage',
        from: a.parentId, to: a.id,
        label: `${nodes.get(a.parentId)?.agent?.callsign ?? '??'} spawned ${a.callsign}`,
        since: null,
      });
    }

    // Waiting on a human. This is what makes the human node the terminus of a
    // chain rather than decoration.
    if (a.state === 'blocked' && a.block && a.block.kind !== 'peer') {
      edges.push({
        id: `h:${a.id}`, kind: 'human', from: a.id, to: 'human',
        label: a.block.summary, since: a.block.since,
      });
    }

    // Waiting on another agent.
    if (a.state === 'blocked' && a.block?.kind === 'peer' && a.block.waitingOn) {
      const target = a.block.waitingOn;
      if (nodes.has(target)) {
        edges.push({
          id: `w:${a.id}:${target}`, kind: 'ask', from: a.id, to: target,
          label: a.block.summary, since: a.block.since,
        });
      }
    }
  }

  for (const m of traffic) {
    if (!nodes.has(m.fromAgentId)) continue;
    // An unanswered ask is already drawn as a wait via the sender's block; what
    // is left to draw is the traffic that did not block anybody.
    if (m.kind === 'ask' && m.answer === null) continue;
    const to = m.toAgentId;
    if (!to || !nodes.has(to)) continue;
    edges.push({
      id: `m:${m.id}`, kind: 'notice', from: m.fromAgentId, to,
      label: `${m.kind}: ${m.subject}`, since: null,
    });
  }

  for (const c of collisions) {
    const present = c.agentIds.filter((id) => nodes.has(id));
    for (let i = 0; i + 1 < present.length; i++) {
      edges.push({
        id: `c:${c.id}:${i}`, kind: 'collision',
        from: present[i]!, to: present[i + 1]!,
        label: `both writing ${c.path}`, since: c.firstSeen,
      });
    }
  }

  const height = PAD_Y * 2 + HUMAN_BAND + Math.max(1, maxRows) * (NODE_H + ROW_GAP);

  return { nodes, edges, dammed: computeDammed(nodes, edges), width, height };
}

/**
 * Who is stuck behind each thing others are waiting on.
 *
 * The walk itself lives on the store, because the number matters most on the
 * card where you answer, not on this picture. Here it only decides which nodes
 * get the count hung under them.
 */
function computeDammed(nodes: Map<string, Node>, edges: Edge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const targets = new Set<string>();
  for (const e of edges) {
    if (e.kind === 'ask' || e.kind === 'human') targets.add(e.to);
  }
  for (const target of targets) {
    if (target !== 'human' && !nodes.has(target)) continue;
    const behind = store.dammedBehind(target);
    if (behind.length > 0) out.set(target, behind);
  }
  return out;
}

/* ── Rendering ────────────────────────────────────────────────────── */

function paintSummary(el: HTMLElement, g: Graph) {
  const behindHuman = g.dammed.get('human')?.length ?? 0;
  const peerWaits = g.edges.filter((e) => e.kind === 'ask').length;
  const collisions = g.edges.filter((e) => e.kind === 'collision').length;

  /*
   * La edad de la espera más vieja.
   *
   * Sin ella todas las esperas se ven iguales, y una de dos minutos y otra de
   * dos horas piden cosas muy distintas. Es el único número de esta línea que
   * cambia lo que haces a continuación.
   */
  const waits = g.edges.filter((e) => e.kind === 'human' && e.since !== null);
  const oldest = waits.length
    ? Math.min(...waits.map((e) => e.since!))
    : null;

  const bits: string[] = [];
  if (behindHuman > 0) {
    const noun = behindHuman === 1 ? 'AGENT' : 'AGENTS';
    const age = oldest ? ` · OLDEST ${fmtAge(oldest).toUpperCase()}` : '';
    bits.push(`${behindHuman} ${noun} WAITING ON YOU${age}`);
  }
  if (peerWaits > 0) bits.push(`${peerWaits} WAITING ON EACH OTHER`);
  if (collisions > 0) bits.push(`${collisions} FILE CONFLICT${collisions === 1 ? '' : 'S'}`);

  const text = bits.length ? bits.join('  ·  ') : 'NOTHING IS WAITING';
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('is-alert', behindHuman > 0 || collisions > 0);
}

function paintEdges(layer: SVGGElement, g: Graph) {
  const want = new Map(g.edges.map((e) => [e.id, e]));
  for (const child of [...layer.children]) {
    const id = (child as SVGElement).dataset.edgeId;
    if (!id || !want.has(id)) child.remove();
  }

  // Reparto de entradas al nodo humano: cada espera entra por su propio punto.
  const humanEdges = g.edges.filter((e) => e.kind === 'human');
  const slotOf = new Map<string, number>();
  humanEdges
    .slice()
    .sort((p, q) => (g.nodes.get(p.from)?.x ?? 0) - (g.nodes.get(q.from)?.x ?? 0))
    .forEach((e, i) => {
      slotOf.set(e.id, humanEdges.length === 1 ? 0.5 : i / (humanEdges.length - 1));
    });

  for (const e of g.edges) {
    const a = g.nodes.get(e.from);
    const b = g.nodes.get(e.to);
    if (!a || !b) continue;

    let path = layer.querySelector<SVGPathElement>(`[data-edge-id="${cssEscape(e.id)}"]`);
    const fresh = !path;
    if (!path) {
      path = document.createElementNS(NS, 'path');
      path.dataset.edgeId = e.id;
      path.setAttribute('fill', 'none');
      const title = document.createElementNS(NS, 'title');
      path.appendChild(title);
      layer.appendChild(path);
    }
    path.setAttribute('class', `map__edge map__edge--${e.kind}`);
    path.setAttribute('d', route(a, b, e.kind, slotOf.get(e.id) ?? 0.5));
    const title = path.querySelector('title');
    if (title) {
      const age = e.since ? ` · ${fmtAge(e.since)}` : '';
      const text = e.label + age;
      if (title.textContent !== text) title.textContent = text;
    }
    if (fresh) {
      gsap.fromTo(path, { opacity: 0 }, { opacity: 1, duration: 0.24, ease: 'power2.out' });
    }
  }
}

/**
 * Orthogonal routing.
 *
 * Right angles, not curves: this world is drawn with straight lines and the
 * boot sequence's tree uses exactly this idiom. It also makes a cross-project
 * edge unmistakable — it is the only long horizontal run on the screen.
 */
function route(a: Node, b: Node, kind: EdgeKind, slot = 0.5): string {
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;

  if (kind === 'collision') {
    // A bracket to the left of both, so it reads as an annotation rather than
    // a flow: nothing is moving between these two, they are simply clashing.
    const x = Math.min(a.x, b.x) - 12;
    const y1 = a.y + NODE_H / 2;
    const y2 = b.y + NODE_H / 2;
    return `M ${a.x} ${y1} H ${x} V ${y2} H ${b.x}`;
  }

  if (kind === 'human') {
    // Up the side of its own column, then along under the human, then in at
    // its own slot. Eleven of these fan across the node instead of piling on
    // one point.
    const entry = b.x + 8 + slot * (b.w - 16);
    const lane = b.y + NODE_H + 14;
    return `M ${ax} ${a.y} V ${lane} H ${entry} V ${b.y + NODE_H}`;
  }

  if (Math.abs(ax - bx) < 1) {
    // Straight drop between parent and child.
    const top = a.y < b.y ? a : b;
    const bottom = a.y < b.y ? b : a;
    return `M ${ax} ${top.y + NODE_H} V ${bottom.y}`;
  }

  // Across columns: out of the side, along a lane between the columns, in.
  const fromRight = bx > ax;
  const x1 = fromRight ? a.x + a.w : a.x;
  const x2 = fromRight ? b.x : b.x + b.w;
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  const lane = x1 + (x2 - x1) / 2;
  return `M ${x1} ${y1} H ${lane} V ${y2} H ${x2}`;
}

function paintNodes(layer: SVGGElement, els: Map<string, SVGGElement>, g: Graph) {
  for (const [id, node] of els) {
    if (!g.nodes.has(id)) { node.remove(); els.delete(id); }
  }

  for (const [id, n] of g.nodes) {
    let el = els.get(id);
    const fresh = !el;
    if (!el) {
      el = buildNode(id, n);
      els.set(id, el);
      layer.appendChild(el);
    }
    updateNode(el, n, g);

    if (fresh) {
      el.setAttribute('transform', `translate(${n.x} ${n.y})`);
      gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: 'power2.out' });
    } else {
      // Positions ease so a re-layout reads as movement, not a jump cut.
      const cur = el.getAttribute('transform') ?? '';
      const want = `translate(${n.x} ${n.y})`;
      if (cur !== want) {
        gsap.to(el, {
          attr: { transform: want }, duration: 0.34, ease: 'power3.out',
        });
      }
    }
  }
}

function buildNode(id: string, n: Node): SVGGElement {
  const g = document.createElementNS(NS, 'g');
  g.dataset.nodeId = id;
  g.setAttribute('class', n.kind === 'human' ? 'map__node map__node--human' : 'map__node');

  const box = document.createElementNS(NS, 'rect');
  box.setAttribute('class', 'map__box');
  box.setAttribute('width', String(n.w));
  box.setAttribute('height', String(NODE_H));
  g.appendChild(box);

  const edge = document.createElementNS(NS, 'rect');
  edge.setAttribute('class', 'map__stateedge');
  edge.setAttribute('width', '2');
  edge.setAttribute('height', String(NODE_H));
  g.appendChild(edge);

  const call = document.createElementNS(NS, 'text');
  call.setAttribute('class', 'map__call');
  call.setAttribute('x', '9');
  call.setAttribute('y', String(NODE_H / 2 + 4));
  g.appendChild(call);

  const code = document.createElementNS(NS, 'text');
  code.setAttribute('class', 'map__code');
  code.setAttribute('x', String(n.w - 8));
  code.setAttribute('y', String(NODE_H / 2 + 4));
  code.setAttribute('text-anchor', 'end');
  g.appendChild(code);

  /* The count of everything dammed behind this node, hung below it. This is
     the number the view exists to produce. */
  const dam = document.createElementNS(NS, 'text');
  dam.setAttribute('class', 'map__dam');
  dam.setAttribute('x', String(n.w / 2));
  // Bajo el nodo, salvo en el humano: ahí abajo va el carril por el que entran
  // todas las esperas, y la etiqueta quedaba tachada por sus propias aristas.
  dam.setAttribute('y', String(n.kind === 'human' ? -7 : NODE_H + 13));
  dam.setAttribute('text-anchor', 'middle');
  g.appendChild(dam);

  const title = document.createElementNS(NS, 'title');
  g.appendChild(title);
  return g;
}

function updateNode(el: SVGGElement, n: Node, g: Graph) {
  // El ancho del humano cambia con la cola; el resto es constante.
  const box0 = el.querySelector('.map__box')!;
  if (box0.getAttribute('width') !== String(n.w)) {
    box0.setAttribute('width', String(n.w));
    el.querySelector('.map__code')?.setAttribute('x', String(n.w - 8));
    el.querySelector('.map__dam')?.setAttribute('x', String(n.w / 2));
    if (n.kind === 'human') el.querySelector('.map__call')?.setAttribute('x', String(n.w / 2));
  }
  const call = el.querySelector('.map__call')!;
  const code = el.querySelector('.map__code')!;
  const dam = el.querySelector('.map__dam')!;
  const title = el.querySelector('title')!;
  const stateEdge = el.querySelector('.map__stateedge')!;

  if (n.kind === 'human') {
    call.setAttribute('x', String(n.w / 2));
    call.setAttribute('text-anchor', 'middle');
    setText(call, 'YOU');
    setText(code, '');
    stateEdge.setAttribute('fill', 'var(--amber)');
    const behind = g.dammed.get('human')?.length ?? 0;
    setText(dam, behind > 0 ? `${behind} BLOCKED BEHIND YOU` : '');
    setText(title, behind > 0
      ? `${behind} agents cannot continue until you answer`
      : 'nothing is waiting on you');
    el.classList.toggle('is-alert', behind > 0);
    return;
  }

  const a = n.agent!;
  const project = store.world.projects[a.projectId];
  setText(call, a.callsign);
  setText(code, project?.code ?? '');
  stateEdge.setAttribute('fill', STATE_COLOR[a.state]);
  el.dataset.state = a.state;

  const behind = g.dammed.get(a.id)?.length ?? 0;
  setText(dam, behind > 0 ? `${behind} BEHIND` : '');
  el.classList.toggle('is-alert', a.state === 'blocked');
  el.classList.toggle('is-dam', behind > 0);

  const wait = a.block ? ` · ${a.block.kind}: ${a.block.summary}` : '';
  setText(title, `${a.callsign} · ${a.state}${wait}\n${a.title}`);
}

/* ── Small helpers ────────────────────────────────────────────────── */

function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

function fmtAge(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/** Edge ids contain `:` and `#`, which are not valid bare CSS selectors. */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
