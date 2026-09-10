/**
 * The minimap: the whole field as the comp's radar, bottom-right.
 *
 * Regions as thin outlines with their codes, agents as dots in their state
 * colour, the viewport as a lime rectangle you can drag. Click anywhere to
 * fly there. It exists because at a thousand agents the field is a landscape,
 * and a landscape needs a map.
 */

import type { AgentState } from '../../shared/types.ts';
import { store } from '../store.ts';
import type { Console } from '../console.ts';
import { displayFont } from '../fonts.ts';

export interface MinimapHandle {
  toggle(): void;
  visible(): boolean;
  /** Called every frame; redraws at most every 100ms unless the view moved. */
  tick(): void;
}

const W = 232, H = 150, PAD = 10;

const DOT: Record<AgentState, string> = {
  booting: '#6a8cff', thinking: '#8fb8ff', working: '#c0f94a', blocked: '#f5a524',
  idle: '#6e736c', done: '#4a4e48', dead: '#ff2a12',
};

export function mountMinimap(host: HTMLElement, c: Console): MinimapHandle {
  const el = document.createElement('div');
  el.className = 'mmap';
  el.innerHTML = `<canvas data-mm width="${W}" height="${H}"></canvas><span class="mmap__k px px--tiny">FIELD · M</span>`;
  host.appendChild(el);
  const canvas = el.querySelector<HTMLCanvasElement>('[data-mm]')!;
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);

  let on = true;
  let lastDraw = 0;
  let lastKey = '';
  // World → map transform, recomputed each draw from the layout bounds.
  let sx = 1, sy = 1, ox = 0, oy = 0;

  function fit() {
    const b = c.field.layout().bounds;
    const v = c.field.viewRect();
    const minX = Math.min(b.minX, v.minX), maxX = Math.max(b.maxX, v.maxX);
    const minY = Math.min(b.minY, v.minY), maxY = Math.max(b.maxY, v.maxY);
    const w = Math.max(4, maxX - minX), h = Math.max(4, maxY - minY);
    const s = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h);
    sx = s; sy = -s;
    ox = W / 2 - ((minX + maxX) / 2) * s;
    oy = H / 2 + ((minY + maxY) / 2) * s;
  }
  const mx = (x: number) => ox + x * sx;
  const my = (y: number) => oy + y * sy;
  const toWorld = (px: number, py: number) => ({ x: (px - ox) / sx, y: (py - oy) / sy });

  function draw() {
    const lay = c.field.layout();
    const v = c.field.viewRect();
    fit();
    g.clearRect(0, 0, W, H);

    // Regions.
    g.lineWidth = 1;
    g.strokeStyle = '#2a2e38';
    // A canvas resolves no custom property; the chosen face is read per frame.
    g.font = `8px ${displayFont().stack}`;
    g.textBaseline = 'bottom';
    for (const r of lay.regions) {
      const x = mx(r.cx - r.hw), y = my(r.cy + r.hh);
      const w = r.hw * 2 * sx, h = r.hh * 2 * -sy;
      g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      g.fillStyle = r.blocked ? '#f5a524' : '#6a7068';
      g.fillText(r.code, Math.round(x), Math.round(y) - 1);
    }
    // Agents. Quiet ones first, so the loud ones paint on top.
    const agents = store.world.agents;
    const late: { x: number; y: number; col: string }[] = [];
    for (const s of lay.spots.values()) {
      const a = agents[s.id];
      if (!a) continue;
      const peer = a.state === 'blocked' && a.block?.kind === 'peer';
      const col = peer ? DOT.thinking : DOT[a.state];
      const x = Math.round(mx(s.x)), y = Math.round(my(s.y));
      if (a.state === 'blocked' && !peer) { late.push({ x, y, col }); continue; }
      g.fillStyle = col;
      g.fillRect(x, y, 2, 2);
    }
    for (const d of late) { g.fillStyle = d.col; g.fillRect(d.x - 1, d.y - 1, 3, 3); }
    // Viewport.
    g.strokeStyle = '#c0f94a';
    g.strokeRect(Math.round(mx(v.minX)) + 0.5, Math.round(my(v.maxY)) + 0.5, Math.round((v.maxX - v.minX) * sx), Math.round((v.maxY - v.minY) * -sy));
  }

  /* ── Interaction: click flies, drag pans ─────────────────────────── */
  let dragging = false;
  const goTo = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const p = toWorld(e.clientX - r.left, e.clientY - r.top);
    const v = c.field.viewRect();
    const dist = Math.max(3, Math.min(400, (v.maxX - v.minX) * 0.9));
    c.field.flyToPoint(p.x, p.y, dragging ? currentDistance() : dist);
  };
  function currentDistance(): number {
    // Keep the zoom while dragging the viewport rectangle around.
    const v = c.field.viewRect();
    const w = v.maxX - v.minX;
    return Math.max(1.4, w / (2 * Math.tan((30 * Math.PI) / 360) * (canvasAspect())));
  }
  const canvasAspect = () => Math.max(0.2, window.innerWidth / Math.max(1, window.innerHeight));
  canvas.addEventListener('pointerdown', (e) => { c.pushView(); dragging = true; canvas.setPointerCapture(e.pointerId); goTo(e); });
  canvas.addEventListener('pointermove', (e) => { if (dragging) goTo(e); });
  const end = (e: PointerEvent) => { if (!dragging) return; dragging = false; canvas.releasePointerCapture(e.pointerId); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    toggle() { on = !on; el.hidden = !on; },
    visible: () => on,
    tick() {
      if (!on) return;
      const now = performance.now();
      const v = c.field.viewRect();
      const key = `${v.minX.toFixed(1)}|${v.minY.toFixed(1)}|${v.maxX.toFixed(1)}|${store.world.rev}`;
      if (key === lastKey && now - lastDraw < 500) return;
      if (key !== lastKey || now - lastDraw > 250) { lastKey = key; lastDraw = now; draw(); }
    },
  };
}
