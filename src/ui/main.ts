/**
 * ORCA console entry.
 *
 * Order matters here: the link opens first so the boot sequence has real
 * numbers to report by the time its POST log reaches the fleet lines, and the
 * console only becomes visible once boot hands over the screen.
 */

import './styles/tokens.css';
import './styles/boot.css';
import './styles/console.css';
import './styles/deck.css';
import './styles/ceo.css';
import './styles/feed.css';
import './styles/agent.css';
import './styles/interrupts.css';
import './styles/scene.css';

import gsap from 'gsap';
import { store } from './store.ts';
import { hub } from './net/client.ts';
import { runBoot } from './boot.ts';
import { mountRail } from './views/rail.ts';
import { mountDeck } from './views/deck.ts';
import { mountScene } from './views/scene.ts';
import { mountCeo } from './views/ceo.ts';
import { mountInterrupts } from './views/interrupts.ts';
import { mountFeed } from './views/feed.ts';
import { mountAgentDrawer } from './views/agent.ts';
import { drawBits, inlineORCA, sizeOf } from './gfx/logo.ts';
import { AGENT_STATES } from '../shared/types.ts';

type View = 'deck' | 'scene';

const app = document.getElementById('app')!;

/* ── Console shell ────────────────────────────────────────────────── */

app.innerHTML = `
  <div class="console" data-console>
    <header class="mast">
      <div class="mast__brand">
        <canvas data-mark></canvas>
        <span class="mast__link px" data-link>LINK</span>
      </div>
      <div class="gauges" data-gauges></div>
      <div class="mast__right">
        <div class="viewtog" data-viewtog>
          <button type="button" data-view="deck" class="is-on">DECK</button>
          <button type="button" data-view="scene">FLEET</button>
        </div>
      </div>
    </header>

    <div class="body">
      <aside class="rail" data-rail></aside>
      <main class="stage" data-stage>
        <div class="stage__view" data-view-deck></div>
        <div class="stage__view" data-view-scene hidden></div>
      </main>
      <aside class="side">
        <div class="side__ceo" data-ceo></div>
        <div class="side__interrupts" data-interrupts></div>
      </aside>
    </div>

    <footer class="feed" data-feed></footer>
    <div data-drawer></div>
  </div>
`;

const $ = <T extends HTMLElement>(s: string) => app.querySelector<T>(s)!;
const consoleEl = $('[data-console]');

/* Wordmark in the masthead. */
{
  const c = $('[data-mark]') as unknown as HTMLCanvasElement;
  const bits = inlineORCA();
  const cell = 2.4;
  const { w, h } = sizeOf(bits, cell);
  const dpr = Math.min(2, devicePixelRatio || 1);
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBits(ctx, bits, 0, 0, cell, '#e8ece4', 0.08);
}

/* ── Views ────────────────────────────────────────────────────────── */

mountRail($('[data-rail]'));
mountDeck($('[data-view-deck]'));
const scene = mountScene($('[data-view-scene]'));
mountCeo($('[data-ceo]'));
mountInterrupts($('[data-interrupts]'));
mountFeed($('[data-feed]'));
mountAgentDrawer($('[data-drawer]'));

/* ── View toggle. The 3D scene only renders while it is the stage. ── */

let view: View = (localStorage.getItem('orca.view') as View) || 'deck';
function setView(v: View) {
  view = v;
  $('[data-view-deck]').hidden = v !== 'deck';
  $('[data-view-scene]').hidden = v !== 'scene';
  for (const b of app.querySelectorAll<HTMLElement>('[data-viewtog] button')) {
    b.classList.toggle('is-on', b.dataset.view === v);
  }
  scene.setActive(v === 'scene');
  try { localStorage.setItem('orca.view', v); } catch { /* private mode */ }
}
$('[data-viewtog]').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-view]');
  if (b) setView(b.dataset.view as View);
});
setView(view);

/* ── Fleet gauges ─────────────────────────────────────────────────── */

const gaugeEl = $('[data-gauges]');
const GAUGES: { key: string; label: string; cls?: string }[] = [
  { key: 'working',  label: 'WORKING',  cls: 'is-working' },
  { key: 'thinking', label: 'THINKING' },
  { key: 'blocked',  label: 'BLOCKED',  cls: 'is-blocked' },
  { key: 'idle',     label: 'IDLE' },
  { key: 'dead',     label: 'DEAD',     cls: 'is-dead' },
  { key: 'cost',     label: 'SPEND' },
  { key: 'tps',      label: 'TOK/S' },
];
gaugeEl.innerHTML = GAUGES.map((g) =>
  `<div class="gauge ${g.cls ?? ''}" data-gauge="${g.key}">
     <span class="gauge__n">0</span><span class="gauge__k">${g.label}</span>
   </div>`).join('');

function paintGauges() {
  store.recomputeFleet();
  const f = store.world.fleet;
  const put = (k: string, v: string) => {
    const n = gaugeEl.querySelector<HTMLElement>(`[data-gauge="${k}"] .gauge__n`);
    if (n && n.textContent !== v) n.textContent = v;
  };
  for (const s of AGENT_STATES) put(s, String(f.byState[s] ?? 0));
  put('cost', '$' + f.costUSD.toFixed(2));
  put('tps', String(Math.round(f.tokensPerSec)));
  // A blocked agent tints the whole gauge row, so peripheral vision catches it.
  gaugeEl.classList.toggle('has-block', f.blocked > 0);
}

/* ── Link state ───────────────────────────────────────────────────── */

const linkEl = $('[data-link]');
function paintLink() {
  const up = store.linkUp;
  linkEl.textContent = up ? 'LINK UP' : 'LINK DOWN';
  linkEl.classList.toggle('is-up', up);
  linkEl.classList.toggle('is-down', !up);
  consoleEl.classList.toggle('is-down', !up);
}

/* ── The alarm ────────────────────────────────────────────────────────
   An agent entering `blocked` is the only event allowed to interrupt. It
   flashes the field amber once — the comp's breach flash, retuned — and
   nothing else in the console is permitted to do this. */

const alarmFlash = document.querySelector<HTMLElement>('[data-alarm-flash]')!;
function alarm() {
  gsap.killTweensOf(alarmFlash);
  gsap.set(alarmFlash, { background: 'var(--amber)', autoAlpha: 0.5 });
  gsap.to(alarmFlash, { autoAlpha: 0, duration: 0.5, ease: 'power2.out' });
}

store.on((e) => {
  switch (e.k) {
    case 'world':
    case 'agents':
      paintGauges();
      break;
    case 'link':
      paintLink();
      break;
    case 'alarm':
      if (e.on) alarm();
      break;
  }
});

/* ── Custom cursor ────────────────────────────────────────────────── */

const cursor = document.querySelector<HTMLElement>('[data-cursor]')!;
if (matchMedia('(pointer: fine)').matches) {
  let raf = 0, tx = 0, ty = 0, cx = 0, cy = 0;
  const loop = () => {
    // A little lag makes the reticle feel like a physical thing being aimed.
    cx += (tx - cx) * 0.35;
    cy += (ty - cy) * 0.35;
    cursor.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    raf = requestAnimationFrame(loop);
  };
  window.addEventListener('pointermove', (e) => {
    tx = e.clientX; ty = e.clientY;
    const over = (e.target as HTMLElement)?.closest?.('[data-agent-id], button, a');
    cursor.classList.toggle('is-target', !!over);
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });
} else {
  cursor.remove();
  document.body.style.cursor = 'auto';
}

/* ── Go ───────────────────────────────────────────────────────────── */

hub.connect();
paintLink();
paintGauges();

const skipBoot = new URL(location.href).searchParams.has('noboot');
if (skipBoot) {
  store.booting = false;
  consoleEl.classList.add('is-live');
} else {
  runBoot(document.body).done.then(() => {
    consoleEl.classList.add('is-live');
    gsap.fromTo(consoleEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5, ease: 'power2.out' });
    scene.setActive(view === 'scene');
  });
}

/* Expose a handle for the visual test harness to drive the console. */
(window as unknown as { __orca: unknown }).__orca = { store, hub, setView };
