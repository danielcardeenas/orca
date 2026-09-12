/**
 * The mast: wordmark, link, gauges, tools. Floating instruments on the glass,
 * not a bar. Every gauge opens the window that explains it.
 *
 * ── Motion (IDENTITY §6.3) ───────────────────────────────────────────
 *
 *   - **Counters land, they do not jump.** A number that changes scrambles
 *     for three frames of ~60 ms (A9, the comp's mixing glyph column) and
 *     then lands on the real value. Only the digits scramble, so `12.4M`
 *     keeps its shape and the column never reflows. `NEED YOU` is the one
 *     exception: it is amber, it is the queue, and it cuts — the alarm ring
 *     in `alarm.ts` is already the gesture that says it rose.
 *   - **Chords echo.** Every tool wears the chord that opens it in a `kbd`
 *     and now carries it in `data-key` as well. When the chord fires
 *     anywhere on the page, that `kbd` cuts to lime and falls back in
 *     `T.snap`. The mast never acts on the key — `main.ts` owns the
 *     keyboard; the mast only answers it.
 *
 * Reduced motion lands every counter on its value and echoes nothing.
 */

import gsap from 'gsap';
import { store } from '../store.ts';
import { EASE, REDUCE, T, dur } from '../motion.ts';
import { AGENT_STATES, type AgentState } from '../../shared/types.ts';
import { drawBits, inlineORCA, sizeOf } from '../gfx/logo.ts';
import { fullscreenOn, onFullscreen, toggleFullscreen } from './fullscreen.ts';
import type { Console } from '../console.ts';
import { esc, hexNoise, tokens } from '../util.ts';
import { ceilingTokens } from '../../shared/tokens.ts';
import { typing } from '../keys.ts';
import { mountClock } from './clock.ts';

/** ⌥C on a Mac, Alt+C elsewhere: the mast shows the chord that opens each window. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const alt = (k: string) => (MAC ? `⌥${k}` : `Alt+${k}`);

const GAUGES: { k: string; cls: string; cut?: boolean; pick: (f: ReturnType<typeof rollup>) => string }[] = [
  { k: 'WORKING', cls: 'is-working', pick: (f) => String(f.byState.working) },
  { k: 'THINKING', cls: '', pick: (f) => String(f.byState.thinking) },
  // The one counter that never scrambles: amber cuts, and the ring says it rose.
  { k: 'NEED YOU', cls: 'is-blocked', cut: true, pick: (f) => String(f.blocked) },
  { k: 'IDLE', cls: '', pick: (f) => String(f.byState.idle) },
  { k: 'DEAD', cls: 'is-dead', pick: (f) => String(f.byState.dead) },
  { k: 'TOKENS', cls: '', pick: (f) => tokens(f.tokens) },
  { k: 'TOK/S', cls: '', pick: (f) => String(Math.round(f.tokensPerSec)) },
];

/** A9 at counter scale: three frames of noise, then the number. */
const SCRAMBLE_FRAMES = 3;
const SCRAMBLE_MS = 60;
const DIGITS = '0123456789';

/**
 * Land `v` on `n`. The three scrambled frames keep every non-digit — the `M`,
 * the `.`, the `—` — so the width never moves and the eye keeps its column.
 *
 * `want` holds the value each element is heading for, because `render()` runs
 * on every patch and the element's own text is noise while it is landing.
 */
function lander() {
  const want = new Map<HTMLElement, string>();
  const timer = new Map<HTMLElement, number>();
  return (n: HTMLElement, v: string, cut: boolean) => {
    if (want.get(n) === v) return;
    const first = !want.has(n);
    want.set(n, v);
    const t = timer.get(n);
    if (t) { window.clearTimeout(t); timer.delete(n); }
    if (cut || first || REDUCE.value) { n.textContent = v; return; }
    let f = 0;
    const step = () => {
      if (++f > SCRAMBLE_FRAMES) { timer.delete(n); n.textContent = v; return; }
      n.textContent = v.replace(/[0-9]/g, () => DIGITS[(Math.random() * 10) | 0]!);
      timer.set(n, window.setTimeout(step, SCRAMBLE_MS));
    };
    step();
  };
}

function rollup() {
  const byState = Object.fromEntries(AGENT_STATES.map((s) => [s, 0])) as Record<AgentState, number>;
  let used = 0, tokensPerSec = 0, blocked = 0;
  for (const a of Object.values(store.world.agents)) {
    byState[a.state]++;
    used += ceilingTokens(a.metrics);
    tokensPerSec += a.metrics.tokensPerSec;
    if (a.state === 'blocked' && a.block?.kind !== 'peer') blocked++;
  }
  return { byState, tokens: used, tokensPerSec, blocked };
}

export function mountMast(host: HTMLElement, c: Console): { setTilt(on: boolean): void; setDeck(sort: string | null): void; dispose(): void } {
  const el = document.createElement('header');
  el.className = 'mast';
  el.innerHTML = `
    <div class="mast__brand"><canvas data-mark></canvas><span class="mast__link px" data-link>LINK</span></div>
    <div class="gauges">${GAUGES.map((g) => `<button class="gauge ${g.cls}" type="button" data-g="${g.k}"><span class="gauge__n">0</span><span class="gauge__k px">${g.k}</span></button>`).join('')}</div>
    <div class="mast__tools">
      <button class="tool" type="button" data-t="fleet" data-key="alt:KeyE">FLEET <kbd>${alt('E')}</kbd></button>
      <button class="tool" type="button" data-t="ceo" data-key="alt:KeyC">CAPCOM <kbd>${alt('C')}</kbd></button>
      <button class="tool tool--hold" type="button" data-t="talk" data-key="alt:KeyV" title="Hold to talk to CAPCOM · Esc to throw the line away">TALK <kbd>${alt('V')}</kbd></button>
      <button class="tool" type="button" data-t="queue" data-key="alt:KeyQ">QUEUE <span class="tool__n">0</span> <kbd>${alt('Q')}</kbd></button>
      <button class="tool" type="button" data-t="feed" data-key="alt:KeyF">FEED <kbd>${alt('F')}</kbd></button>
      <button class="tool" type="button" data-t="spawn" data-key="alt:KeyN">SPAWN <kbd>${alt('N')}</kbd></button>
      <button class="tool" type="button" data-t="launch" data-key="alt:KeyL">LAUNCH <kbd>${alt('L')}</kbd></button>
      <button class="tool" type="button" data-t="gallery" data-key="alt:KeyG">GALLERY <kbd>${alt('G')}</kbd></button>
      <button class="tool" type="button" data-t="timeline" data-key="alt:KeyT">TIME <kbd>${alt('T')}</kbd></button>
      <button class="tool" type="button" data-t="deck" data-key="KeyD"><span data-deck>DECK</span> <kbd>D</kbd></button>
      <button class="tool" type="button" data-t="tilt" data-key="KeyO">TILT <kbd>O</kbd></button>
      <button class="tool" type="button" data-t="frame" data-key="KeyF">FRAME <kbd>F</kbd></button>
      <button class="tool" type="button" data-t="full" data-key="KeyZ">FULL <kbd>Z</kbd></button>
      <button class="tool" type="button" data-t="music" data-key="alt:KeyM">MUSIC <kbd>${alt('M')}</kbd></button>
      <button class="tool" type="button" data-t="sfx" data-key="alt:KeyS">SFX <kbd>${alt('S')}</kbd></button>
      <button class="tool" type="button" data-t="help" data-key="alt:KeyH">? <kbd>${alt('H')}</kbd></button>
    </div>
  `;
  host.appendChild(el);
  // The clock holds the first row's right corner: after the gauges, before the
  // tools, in the flow. `clock.ts` says why that spot and not the tools row.
  const clock = mountClock(el, el.querySelector<HTMLElement>('.mast__tools')!);
  // Tele and bookmarks live inside the mast's flow, so when the mast wraps
  // at a narrow width nothing sits on top of anything.
  const tele = document.createElement('div');
  tele.className = 'tele px';
  el.appendChild(tele);

  // The wordmark, in pixels.
  const mark = el.querySelector<HTMLCanvasElement>('[data-mark]')!;
  const bits = inlineORCA();
  const cell = 3;
  const { w, h } = sizeOf(bits, cell);
  const dpr = Math.min(2, devicePixelRatio || 1);
  mark.width = w * dpr; mark.height = h * dpr;
  mark.style.width = `${w}px`; mark.style.height = `${h}px`;
  const g = mark.getContext('2d')!;
  g.scale(dpr, dpr);
  drawBits(g, bits, 0, 0, cell, '#e8ece4');

  const link = el.querySelector<HTMLElement>('[data-link]')!;
  const nums = el.querySelectorAll<HTMLElement>('.gauge__n');
  const gauges = el.querySelectorAll<HTMLElement>('.gauge');
  const queueN = el.querySelector<HTMLElement>('[data-t="queue"] .tool__n')!;
  const queueBtn = el.querySelector<HTMLElement>('[data-t="queue"]')!;
  const tiltBtn = el.querySelector<HTMLElement>('[data-t="tilt"]')!;
  const fullBtn = el.querySelector<HTMLElement>('[data-t="full"]')!;
  fullBtn.classList.toggle('is-on', fullscreenOn());
  onFullscreen((on) => fullBtn.classList.toggle('is-on', on));
  const deckBtn = el.querySelector<HTMLElement>('[data-t="deck"]')!;
  const deckLabel = el.querySelector<HTMLElement>('[data-deck]')!;
  /*
   * TALK is a hold, not a click: down listens, up sends, and a pointer that
   * leaves or is cancelled throws the line away. Where the browser cannot
   * listen at all — plain http, no engine — the button is not drawn: a tool
   * that cannot work is not a tool (hud/voice.ts says which it was).
   */
  const talkBtn = el.querySelector<HTMLButtonElement>('[data-t="talk"]')!;
  talkBtn.hidden = !c.voice.supported;
  talkBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!c.voice.start()) return;
    talkBtn.setPointerCapture(e.pointerId);
  });
  talkBtn.addEventListener('pointerup', () => c.voice.stop());
  talkBtn.addEventListener('pointercancel', () => c.voice.cancel());
  talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  const land = lander();

  function render() {
    const f = rollup();
    GAUGES.forEach((gg, i) => {
      const v = gg.pick(f);
      land(nums[i]!, v, !!gg.cut);
      gauges[i]!.classList.toggle('has-n', v !== '0' && v !== '$0.00');
    });
    const q = store.pending().length + store.blockedAgents().filter((a) => a.block?.kind !== 'peer' && !a.block?.escalationId).length;
    // The queue is the same amber fact as NEED YOU: it cuts.
    land(queueN, String(q), true);
    queueBtn.classList.toggle('has-n', q > 0);
    link.textContent = store.linkUp ? 'LINK UP' : 'LINK DOWN';
    link.classList.toggle('is-up', store.linkUp);
    link.classList.toggle('is-down', !store.linkUp);
  }

  el.querySelectorAll<HTMLElement>('[data-g]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.g;
    if (k === 'NEED YOU') c.openQueue();
    else if (k === 'DEAD' || k === 'IDLE' || k === 'WORKING' || k === 'THINKING') c.openFleet();
    else c.openCeo();
  }));
  /*
   * A window tool is a toggle: closed → open; open but not active → raise;
   * active → close. One button, one place, three states, and the operator
   * never has to hunt for the × of a window the mast opened.
   */
  const toggle = (key: string, open: () => void) => c.wm.toggleKey(key, open);
  el.querySelectorAll<HTMLElement>('[data-t]').forEach((b) => b.addEventListener('click', () => {
    switch (b.dataset.t) {
      case 'fleet': toggle('fleet', () => c.openFleet()); break;
      case 'ceo': toggle('ceo', () => c.openCeo()); break;
      case 'queue': toggle('queue', () => c.openQueue()); break;
      case 'feed': toggle('feed', () => c.openFeed()); break;
      case 'spawn': toggle('spawn:new', () => c.openSpawn()); break;
      case 'launch': toggle('launch', () => c.openLaunch()); break;
      case 'gallery': toggle('gallery', () => c.openGallery()); break;
      case 'timeline': toggle('timeline', () => c.openTimeline()); break;
      case 'sfx': toggle('sfx', () => c.openSfx()); break;
      case 'tilt': c.field.setTilt(!c.field.tilted()); tiltBtn.classList.toggle('is-on', c.field.tilted()); break;
      case 'frame': c.field.frameAll(); break;
      case 'full': void toggleFullscreen(); break;
      case 'deck': c.deck(); break;
      case 'help': toggle('help', () => c.openHelp()); break;
      case 'music': toggle('music', () => c.openMusic()); break;
    }
  }));

  /* ── The chord echo ──────────────────────────────────────────────
     One capture listener, no keys of its own. `main.ts` decides what a key
     does; if it did nothing here, the mast would be lying about it — hence
     the two gates: a chord never fires while the operator is typing, and a
     bare letter never fires while a window owns the keyboard. */
  const caps = new Map<string, HTMLElement>();
  el.querySelectorAll<HTMLElement>('[data-key]').forEach((b) => {
    const cap = b.querySelector<HTMLElement>('kbd');
    if (cap && b.dataset.key) caps.set(b.dataset.key, cap);
  });
  function echo(cap: HTMLElement) {
    gsap.killTweensOf(cap);
    cap.classList.add('is-echo');
    // The lime is a palette, so it cuts in. The fall is a shape, so it eases.
    gsap.fromTo(cap, { y: 2 }, {
      y: 0, duration: dur(T.snap), ease: EASE.out,
      onComplete: () => cap.classList.remove('is-echo'),
    });
  }
  const onChord = (e: KeyboardEvent) => {
    if (REDUCE.value || e.repeat || e.metaKey || e.ctrlKey) return;
    if (typing(e)) return;
    const cap = e.altKey
      ? caps.get(`alt:${e.code}`)
      : document.body.classList.contains('has-window') ? undefined : caps.get(e.code);
    if (cap) echo(cap);
  };
  window.addEventListener('keydown', onChord, true);

  const reduce = REDUCE.value;
  const teleTick = () => {
    const s = c.field.stats();
    tele.innerHTML = `${reduce ? '' : esc(hexNoise(4)) + '<br/>'}REV ${store.world.rev} · ${s.agents} AGENTS · ${s.drawn} DRAWN · ${s.segments} PIPES · ${s.fps} FPS`;
  };
  const t = window.setInterval(teleTick, 700);
  store.on((e) => { if (e.k === 'world' || e.k === 'agents' || e.k === 'escalations' || e.k === 'link' || e.k === 'fleet' as string) render(); });
  render();
  teleTick();
  return {
    setTilt(on) { tiltBtn.classList.toggle('is-on', on); },
    // Every timer the mast started, stopped: the clock's tick, the tele, the chord echo.
    dispose() { clock.stop(); window.clearInterval(t); window.removeEventListener('keydown', onChord, true); el.remove(); },
    // Only the label, never the whole button: the `kbd` is what the echo
    // holds a reference to, and a rewritten button would orphan it.
    setDeck(sort) { deckBtn.classList.toggle('is-on', !!sort); deckLabel.textContent = sort ? `DECK · ${sort.toUpperCase()}` : 'DECK'; },
  };
}
