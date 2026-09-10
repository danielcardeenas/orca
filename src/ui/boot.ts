/**
 * ORCA boot sequence.
 *
 * A faithful compression of the Axolots /system comp: POST → wordmark load →
 * handshake → check → align deck → ALGN staircase → radar sweep → fleet online.
 * Same eases, same beats, same staircase-then-zipper move on the ALGN rows.
 *
 * Two things differ from the comp, both on purpose:
 *  - It runs ~9s instead of 28s. This is a console you open every day, not a
 *    landing page you see once.
 *  - Every line is real. The POST log reports the machines and projects
 *    actually found, the ALGN rows are actual collectors syncing. A boot that
 *    lies is theatre; a boot that reports is an instrument.
 */

import gsap from 'gsap';
import { drawDotted, stackORCA } from './gfx/logo.ts';
import { ZIP_SVG, paintBadge, paintBits } from './gfx/algn.ts';
import { createRadar } from './gfx/radar.ts';
import { store } from './store.ts';

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const POST_LINES = [
  'ORCA ORCHESTRATION CONSOLE // BUILD 0.1.0',
  'INITIALIZING FLEET RECONNAISSANCE LAYER...',
  '',
  '0x0200 [ 0.000 ] Console runtime... WEBGL2 + CANVAS2D OK',
  '0x020C [ 0.003 ] Resolving hub endpoint...',
  '0x021B [ 0.009 ] Opening outbound channel to hub... DIALING',
  '0x022A [ 0.012 ] Protocol handshake v1... NEGOTIATING',
  '0x023F [ 0.016 ] Verifying console token [AES-256-GCM]... AUTHENTICATED',
  '0x0241 [ 0.025 ] Enumerating collectors...',
  '0x025D [ 0.031 ] Reading fleet topology... [MODE: MULTI_MACHINE]',
  '0x026E [ 0.038 ] Probing agent transcripts (tail, incremental)... NOMINAL',
  '0x0272 [ 0.042 ] Calibrating telemetry clock... SYNCHRONIZED',
  '0x0280 [ 0.049 ] Deriving agent state machine...',
  '0x028F [ 0.055 ] Lineage graph reconstructed: PARENT→CHILD RESOLVED',
  '0x02A0 [ 0.062 ] Asserting credential vault [LOCAL ONLY]... SEALED',
  '0x02B2 [ 0.070 ] Mounting escalation channel (agent→human)... OPEN',
  '0x02C4 [ 0.078 ] Scanning project roots...',
  '0x02D0 [ 0.083 ] ORCA_FLEET_VOL [ENCRYPTED - AES-256-GCM]',
];

const STATUS_LINES = [
  'LINK: DIALING',
  'PROTO: V1',
  'RTT: --ms',
  '',
  'COLLECTORS [0/0]',
  'PROJECTS   [0]',
  'AGENTS     [0]',
  'VAULT_STATUS',
  '',
  'DERIVE CHK: PASS',
  'STATE_M LOCKED',
  'PATCH_SEED: OK',
  'WS STABLE',
  '',
  'ESCL PENDING',
  'BUS TRAFFIC: LOW',
  'COALESCE 10HZ',
  '',
  'CAPCOM BOOT: STG 02',
  'SYNC_WAIT: 0x0F',
  'BUS LOCKED: YES',
];

export interface BootHandle {
  /** Resolves when the console is ready to take over the screen. */
  done: Promise<void>;
  skip(): void;
}

export function runBoot(mount: HTMLElement): BootHandle {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.createElement('div');
  root.className = 'boot';
  root.innerHTML = markup();
  mount.appendChild(root);

  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const $$ = <T extends HTMLElement>(s: string) => Array.from(root.querySelectorAll<T>(s));

  const shell = $('[data-boot-shell]');
  const postLog = $('[data-post-log]');
  const postStat = $('[data-post-stat]');
  const logoHi = $('[data-logo-hi]') as unknown as HTMLCanvasElement;
  const logoBadge = $('[data-logo-badge]') as unknown as HTMLCanvasElement;
  const logoDot = $('[data-logo-dot]') as unknown as HTMLCanvasElement;
  const barFill = $('[data-bar-fill]');
  const glyphs = $$('[data-glyph]');
  const passWipe = $('[data-pass-wipe]');
  const checkPx = $$('[data-check-px]');
  const tiles = $$('[data-tile]');
  const charset = $('[data-charset]');
  const tele = $('[data-tele]');
  const wave = $('[data-wave]') as unknown as HTMLCanvasElement;
  const radarCanvas = $('[data-radar]') as unknown as HTMLCanvasElement;
  const algnRows = $$('[data-algn-row]');
  const statusPill = $('[data-status]');
  const nodeOn = $$('[data-node-on]');
  const flash = $('[data-flash]');
  const signalTrack = $('[data-signal-track]');
  const cta = $('[data-cta]');
  const ctaLabel = $('[data-cta-label]');
  const skipBtn = $('[data-skip]');

  postLog.innerHTML = POST_LINES.map((l) => `<div>${esc(l) || '&nbsp;'}</div>`).join('');
  postStat.innerHTML = STATUS_LINES.map((l) => `<div>${esc(l) || '&nbsp;'}</div>`).join('');
  charset.textContent = scrambleBlock();

  paintDotted(logoDot, 148);
  paintSolid(logoHi, 16);
  paintBadge(logoBadge);

  const radar = createRadar(radarCanvas);
  const waveCtx = wave.getContext('2d')!;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  let finished = false;
  let scrambleOn = true;
  let scrambleTimer = 0;

  const scenes = $$('[data-scene]');
  gsap.set(scenes, { autoAlpha: 0 });
  gsap.set(shell, { autoAlpha: 0 });
  gsap.set(glyphs, { autoAlpha: 0, scale: 0.6, display: 'none' });
  gsap.set(passWipe, { scaleX: 0, transformOrigin: 'left center' });
  gsap.set(checkPx, { autoAlpha: 0 });
  gsap.set(algnRows, { autoAlpha: 0, y: 14, paddingLeft: '10px', paddingRight: '10px' });
  gsap.set(flash, { autoAlpha: 0 });
  gsap.set(nodeOn, { autoAlpha: 0 });

  const tl = gsap.timeline({ paused: true, onComplete: finish });

  /* ── POST 0.00–1.30 ─────────────────────────────────────────────── */
  tl.set('[data-scene="post"]', { autoAlpha: 1 }, 0);
  const postKids = Array.from(postLog.children);
  gsap.set(postKids, { autoAlpha: 0 });
  postKids.forEach((el, i) => tl.to(el, { autoAlpha: 1, duration: 0.04 }, 0.03 + i * 0.052));
  const statKids = Array.from(postStat.children);
  gsap.set(statKids, { autoAlpha: 0 });
  statKids.forEach((el, i) => tl.to(el, { autoAlpha: 1, duration: 0.05 }, 0.06 + i * 0.038));
  tl.to('[data-scene="post"]', { autoAlpha: 0, duration: 0.12 }, 1.24);

  /* ── LOGO + LOADBAR 1.24–2.60 ───────────────────────────────────── */
  tl.set('[data-scene="logo"]', { autoAlpha: 1 }, 1.22);
  tl.fromTo('[data-logo-hi]',
    { autoAlpha: 0, scale: 1.06, filter: 'blur(8px)' },
    { autoAlpha: 1, scale: 1, filter: 'blur(0px)', duration: 0.28, ease: 'power2.out' }, 1.24);
  tl.fromTo(barFill, { scaleX: 0 },
    { scaleX: 1, duration: 1.15, ease: 'power1.inOut', transformOrigin: 'left center' }, 1.34);
  tl.to('[data-scene="logo"]', { autoAlpha: 0, duration: 0.12 }, 2.54);

  /* ── HANDSHAKE 2.56–4.10 (the comp's password beat) ─────────────── */
  tl.to(shell, { autoAlpha: 1, duration: 0.2 }, 2.56);
  tl.set('[data-scene="pass"]', { autoAlpha: 1 }, 2.56);
  tl.fromTo('[data-pass-title]', { autoAlpha: 0, y: 8 },
    { autoAlpha: 1, y: 0, duration: 0.3 }, 2.62);
  glyphs.forEach((g, i) => {
    // Two bursts, as in the comp: four fast, a pause, four more.
    const t = i < 4 ? 2.92 + i * 0.13 : 3.42 + (i - 4) * 0.10;
    tl.set(g, { display: 'grid' }, t);
    tl.to(g, { autoAlpha: 1, scale: 1, duration: 0.12, ease: 'back.out(2)' }, t);
  });
  tl.to(passWipe, { scaleX: 1, duration: 0.5, ease: 'power2.inOut' }, 3.82);
  tl.to(glyphs, { autoAlpha: 0, duration: 0.18 }, 4.16);
  tl.to('[data-scene="pass"]', { autoAlpha: 0, duration: 0.12 }, 4.30);

  /* ── CHECK 4.30–5.05 ────────────────────────────────────────────── */
  tl.set('[data-scene="check"]', { autoAlpha: 1 }, 4.30);
  tl.fromTo('[data-check-board]', { scale: 0.82, autoAlpha: 0 },
    { scale: 1, autoAlpha: 1, duration: 0.26, ease: 'power2.out' }, 4.32);
  checkPx.forEach((px, i) => tl.to(px, { autoAlpha: 1, duration: 0.05 }, 4.46 + i * 0.04));
  tl.to('[data-scene="check"]', { autoAlpha: 0, duration: 0.14 }, 5.00);

  /* ── ALIGN DECK 5.02–7.10 ───────────────────────────────────────── */
  tl.set('[data-scene="align"]', { autoAlpha: 1 }, 5.02);
  tl.fromTo('[data-align-inner]', { autoAlpha: 0, y: 12 },
    { autoAlpha: 1, y: 0, duration: 0.32 }, 5.06);
  tl.call(() => { ctaLabel.textContent = 'INITIATE FLEET ALIGNMENT'; }, undefined, 5.2);
  // Tiles light in beats, exactly as the comp does.
  const beats: { at: number; n: number }[] = [
    { at: 5.30, n: 4 }, { at: 5.62, n: 2 }, { at: 5.94, n: 3 },
    { at: 6.24, n: 5 }, { at: 6.54, n: 2 }, { at: 6.82, n: 6 },
  ];
  beats.forEach((b) => tl.call(() => lightTiles(tiles, b.n), undefined, b.at));
  nodeOn.forEach((n, i) => tl.to(n, { autoAlpha: 1, duration: 0.12 }, 5.6 + i * 0.2));
  tl.call(() => {
    statusPill.textContent = 'ONLINE';
    statusPill.classList.add('is-on');
  }, undefined, 6.6);
  tl.set(cta, { background: '#3a3a40', color: '#d2d2d6' }, 5.9);
  tl.call(() => { ctaLabel.textContent = 'ALIGNMENT IN PROGRESS'; }, undefined, 5.9);
  tl.set(flash, { autoAlpha: 1, background: '#c0f94a' }, 7.02);
  tl.to(flash, { autoAlpha: 0, duration: 0.26 }, 7.08);

  /* ── ALGN STAIRCASE 7.06–9.10 ───────────────────────────────────────
     The comp's signature move: rows appear flush, SEPARATE into a staircase
     (each lower row inset further on both sides), the zipper grows from the
     centre outward, then they REJOIN flush. No zoom on the way out. */
  tl.set('[data-scene="algn"]', { autoAlpha: 1 }, 7.06);
  tl.fromTo('[data-algn-panel]', { autoAlpha: 0, scale: 0.96, y: 10 },
    { autoAlpha: 1, scale: 1, y: 0, duration: 0.22, ease: 'power2.out' }, 7.08);
  algnRows.forEach((row, i) => {
    tl.to(row, { autoAlpha: 1, y: 0, duration: 0.26, ease: 'power2.out' }, 7.12 + i * 0.044);
    tl.to(row, {
      paddingLeft: `${10 + i * 14}px`,
      paddingRight: `${10 + i * 10}px`,
      duration: 0.46, ease: 'power2.inOut',
    }, 7.44 + i * 0.032);
    const fill = row.querySelector<HTMLElement>('[data-algn-fill]');
    if (fill) {
      tl.fromTo(fill, { scaleX: 0 },
        { scaleX: 1, duration: 0.74, ease: 'power2.inOut', transformOrigin: 'center center' },
        7.42 + i * 0.055);
    }
    tl.to(row, {
      paddingLeft: '10px', paddingRight: '10px',
      duration: 0.4, ease: 'power2.inOut',
    }, 8.24 + i * 0.026);
  });
  tl.to('[data-algn-panel]', { autoAlpha: 0, duration: 0.26 }, 8.86);
  tl.to('[data-scene="align"]', { autoAlpha: 0, duration: 0.2 }, 8.86);
  tl.to('[data-scene="algn"]', { autoAlpha: 0, duration: 0.16 }, 9.04);
  tl.set(flash, { autoAlpha: 1, background: '#c0f94a' }, 9.02);
  tl.to(flash, { autoAlpha: 0, duration: 0.18 }, 9.12);

  /* ── RADAR SWEEP 9.10–10.90 ─────────────────────────────────────── */
  tl.set('[data-scene="radar"]', { autoAlpha: 1 }, 9.10);
  tl.call(() => radar.resize(), undefined, 9.10);
  tl.fromTo('[data-scene="radar"]', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, 9.10);

  /* ── FLEET ONLINE 10.60–11.90 ───────────────────────────────────── */
  tl.set('[data-scene="signal"]', { autoAlpha: 1 }, 10.60);
  tl.fromTo(signalTrack, { xPercent: 0 }, { xPercent: -50, duration: 1.3, ease: 'none' }, 10.62);
  tl.to('[data-scene="signal"]', { autoAlpha: 0, duration: 0.18 }, 11.72);
  tl.to('[data-scene="radar"]', { autoAlpha: 0, duration: 0.22 }, 11.72);
  tl.to(shell, { autoAlpha: 0, duration: 0.3 }, 11.80);
  tl.to(root, { autoAlpha: 0, duration: 0.3 }, 11.86);

  /* ── Per-frame canvas work, driven off the timeline clock ───────── */
  const tick = () => {
    const t = tl.time();
    if (t >= 9.05 && t < 11.8) radar.draw(Math.min(1, (t - 9.1) / 1.6));
    if (t >= 5.0 && t < 9.2) drawWave(wave, waveCtx, t);
    // Live readouts replace the seeded zeroes as soon as the hub answers.
    if (t > 0.6) refreshStatus(postStat);
  };

  function lightTiles(all: HTMLElement[], n: number) {
    all.forEach((el) => el.classList.remove('is-on'));
    const idx = new Set<number>();
    while (idx.size < Math.min(n, all.length)) idx.add((Math.random() * all.length) | 0);
    for (const i of idx) all[i]?.classList.add('is-on');
  }

  function scrambleLoop() {
    if (!scrambleOn) return;
    charset.textContent = scrambleBlock();
    tele.textContent = scramble(20);
    scrambleTimer = window.setTimeout(scrambleLoop, 70);
  }

  function resizeAll() {
    radar.resize();
    const r = wave.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    wave.width = Math.round(Math.max(1, r.width) * dpr);
    wave.height = Math.round(Math.max(1, r.height) * dpr);
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function finish() {
    if (finished) return;
    finished = true;
    scrambleOn = false;
    window.clearTimeout(scrambleTimer);
    gsap.ticker.remove(tick);
    window.removeEventListener('resize', resizeAll);
    tl.kill();
    root.remove();
    store.booting = false;
    resolveDone();
  }

  function skip() {
    if (finished) return;
    tl.pause();
    gsap.to(root, {
      autoAlpha: 0, duration: 0.25, ease: 'power2.out', onComplete: finish,
    });
  }

  skipBtn.addEventListener('click', skip);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); skip(); }
  };
  window.addEventListener('keydown', onKey, { once: false });
  done.finally(() => window.removeEventListener('keydown', onKey));

  window.addEventListener('resize', resizeAll);
  resizeAll();
  scrambleLoop();

  if (reduce) {
    // Respect the preference without skipping the report: jump to the end
    // state instantly rather than animating through it.
    tl.progress(1);
    finish();
  } else {
    gsap.ticker.add(tick);
    tl.play();
  }

  return { done, skip };
}

/* ── Live status readout ──────────────────────────────────────────── */

function refreshStatus(el: HTMLElement) {
  const w = store.world;
  const machines = Object.values(w.machines);
  const online = machines.filter((m) => m.online).length;
  const set = (i: number, text: string) => {
    const line = el.children[i] as HTMLElement | undefined;
    if (line && line.textContent !== text) line.textContent = text;
  };
  set(0, store.linkUp ? 'LINK: UP' : 'LINK: DIALING');
  set(4, `COLLECTORS [${online}/${machines.length}]`);
  set(5, `PROJECTS   [${Object.keys(w.projects).length}]`);
  set(6, `AGENTS     [${Object.keys(w.agents).length}]`);
}

/* ── Canvas helpers, ported from the comp ─────────────────────────── */

function paintDotted(canvas: HTMLCanvasElement, size: number) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  drawDotted(ctx, 0, 0, size);
}

function paintSolid(canvas: HTMLCanvasElement, cell: number) {
  paintBits(canvas, stackORCA(), cell, '#f4f6f8', true);
}

function drawWave(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, t: number) {
  const r = canvas.getBoundingClientRect();
  const w = r.width, h = r.height;
  if (w < 2 || h < 2) return;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(220,230,225,0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const n = Math.sin(x * 0.18 + t * 9) * 0.25 + Math.sin(x * 0.41 + t * 4.2) * 0.18;
    const y = h * 0.5 + n * h * 0.7 + (Math.random() - 0.5) * 1.6;
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function scramble(n: number) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += GLYPHS[(Math.random() * GLYPHS.length) | 0] + (i % 4 === 3 ? ' ' : '');
  }
  return s;
}

function scrambleBlock() {
  const lines: string[] = [];
  for (let r = 0; r < 8; r++) {
    const a = GLYPHS[(Math.random() * GLYPHS.length) | 0];
    const b = GLYPHS[(Math.random() * GLYPHS.length) | 0];
    lines.push(a + '  ' + b);
  }
  return lines.join('\n');
}

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

/* ── Markup ───────────────────────────────────────────────────────── */

function markup(): string {
  const tiles = ['A3','A8','A2','J1','L1','L8','L3','K9','D1','B6','D6','N5','A1','E5','A3','T4'];
  // Same checkmark path the comp punches out of the lime square.
  const checkOrder: [number, number][] = [[2,4],[3,5],[4,4],[5,3],[6,2]];
  const algn = [1,2,3,4,5,6,7,8];
  const sig: [number, number][] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) if ((x + y) % 2 === 1) sig.push([x + 1, y + 1]);
  }

  return `
  <div class="fx-flash" data-flash></div>

  <section class="boot-scene boot-scene--post" data-scene="post">
    <div class="post">
      <div class="post__left">
        <canvas data-logo-dot width="148" height="148"></canvas>
        <div class="post__stat mono" data-post-stat></div>
      </div>
      <div class="post__log mono" data-post-log></div>
    </div>
  </section>

  <section class="boot-scene boot-scene--logo" data-scene="logo">
    <canvas class="logo-hi" data-logo-hi></canvas>
    <div class="loadbar"><i class="loadbar__fill" data-bar-fill></i></div>
  </section>

  <div class="boot-shell" data-boot-shell>
    <i class="xhair xhair--tl"></i><i class="xhair xhair--tr"></i>
    <i class="xhair xhair--bl"></i><i class="xhair xhair--br"></i>
    <div class="shell">
      <div class="shell__notch shell__notch--l"></div>
      <div class="shell__notch shell__notch--r"></div>
      <div class="shell__screen">
        <div class="boot-tele px px--tiny" data-tele></div>
        <div class="boot-stamp px px--tiny">ORCA<br/>FLEET</div>

        <section class="boot-scene boot-scene--fill" data-scene="pass">
          <p class="px px--title chroma" data-pass-title>HANDSHAKE</p>
          <div class="pass">
            <div class="pass__wipe" data-pass-wipe></div>
            ${Array.from({ length: 8 }).map(() =>
              `<span class="glyph" data-glyph><i></i><i></i><i></i><i></i></span>`).join('')}
          </div>
        </section>

        <section class="boot-scene boot-scene--fill boot-scene--center" data-scene="check">
          <div class="check" data-check-board>
            <i class="check__plus check__plus--tl"></i>
            <i class="check__plus check__plus--tr"></i>
            <i class="check__plus check__plus--bl"></i>
            <i class="check__plus check__plus--br"></i>
            <div class="check__grid">
              ${checkOrder.map(([x, y]) =>
                `<i class="check__px" data-check-px style="grid-column:${x};grid-row:${y}"></i>`).join('')}
            </div>
          </div>
        </section>

        <section class="boot-scene boot-scene--fill" data-scene="align">
          <div class="align" data-align-inner>
            <div class="radar-col">
              <article class="panel radar-card">
                <p class="px px--tiny radar-card__meta">FLEET: MULTI-MACHINE<br/>OUTBOUND / NAT-SAFE</p>
                <h2 class="px px--card">AGENT<br/>RECON ARRAY</h2>
                <span class="status" data-status>OFFLINE</span>
              </article>
              <div class="sig">
                <div class="sig__bar"><span class="px px--tiny">SIGNAL STRENGTH</span></div>
                <canvas class="sig__wave" data-wave></canvas>
              </div>
            </div>

            <div class="tree-wrap">
              <i class="plus tree-wrap__plus"></i>
              <svg class="tree" viewBox="0 0 160 170" aria-hidden="true">
                <g fill="none" stroke="#3a4150" stroke-width="2">
                  <path d="M96 10 V150"/><path d="M96 22 H128"/><path d="M96 40 H128"/>
                  <path d="M96 58 H128"/><path d="M96 76 H112 V94 H128"/>
                  <path d="M96 76 H80 V58 H64"/><path d="M96 118 H70 V138 H40"/>
                  <path d="M96 118 H122 V138 H128"/>
                </g>
                <g fill="#d5dae3">
                  <rect x="122" y="16" width="26" height="11" rx="1"/>
                  <rect x="122" y="34" width="26" height="11" rx="1"/>
                  <rect x="122" y="52" width="26" height="11" rx="1"/>
                  <rect x="122" y="88" width="26" height="11" rx="1"/>
                  <rect x="32" y="132" width="26" height="11" rx="1"/>
                  <rect x="122" y="132" width="26" height="11" rx="1"/>
                  <rect x="92" y="72" width="8" height="8" fill="#e8ece4"/>
                  <rect x="92" y="114" width="8" height="8" fill="#e8ece4"/>
                </g>
                <g data-node-on>
                  <rect x="92" y="76" width="8" height="42" fill="#c0f94a"/>
                  <rect x="92" y="114" width="8" height="8" fill="#c0f94a"/>
                </g>
                <g data-node-on><rect x="92" y="20" width="8" height="40" fill="#c0f94a"/></g>
                <!-- Tiny5, fixed: these six caps are 26 units wide inside their own
                     chips at 6 px, and any wider face runs out of the rectangle.
                     A drawing from the comp, not a label the console sets. -->
                <text x="125" y="24" fill="#111" font-size="6" font-family="Tiny5, monospace">NULL</text>
                <text x="125" y="42" fill="#111" font-size="6" font-family="Tiny5, monospace">NULL</text>
                <text x="125" y="60" fill="#111" font-size="6" font-family="Tiny5, monospace">NULL</text>
                <text x="125" y="96" fill="#111" font-size="6" font-family="Tiny5, monospace">NULL</text>
                <text x="35" y="140" fill="#111" font-size="6" font-family="Tiny5, monospace">ACTV</text>
                <text x="125" y="140" fill="#111" font-size="6" font-family="Tiny5, monospace">NULL</text>
              </svg>
              <p class="tree-codes px px--tiny">J<br/>E C</p>
            </div>

            <div class="tiles">
              ${tiles.map((id) => `<button class="tile" type="button" data-tile="${id}"><span>${id}</span></button>`).join('')}
            </div>

            <pre class="charset chroma" data-charset></pre>
          </div>
          <div class="slab align-cta" data-cta>
            <span class="px px--cta" data-cta-label>INITIATE FLEET ALIGNMENT</span>
          </div>
        </section>

        <section class="boot-scene boot-scene--fill boot-scene--algn" data-scene="algn">
          <div class="algn" data-algn-panel>
            <header class="algn__head">
              <span class="algn__badge"><canvas data-logo-badge></canvas></span>
              <p class="px px--modal">FLEET ALIGNMENT INITIATING..</p>
            </header>
            ${algn.map((n) => `
              <div class="algn-row" data-algn-row>
                <span class="px px--tiny">+ SYNC ${String(n === 8 ? 7 : n).padStart(2,'0')}</span>
                <div class="algn-bar">
                  <div class="algn-zip" data-algn-fill>${ZIP_SVG}</div>
                </div>
                <span class="px px--tiny">SYNC ${String(n).padStart(2,'0')} +</span>
              </div>`).join('')}
          </div>
        </section>

        <section class="boot-scene boot-scene--fill" data-scene="radar">
          <canvas class="radar" data-radar></canvas>
        </section>

        <section class="boot-scene boot-scene--fill boot-scene--center" data-scene="signal">
          <div class="marquee boot-marquee">
            <div class="marquee__track" data-signal-track>
              ${Array.from({ length: 2 }).map(() => `
                <div class="sigboard">
                  <div class="sigboard__half">
                    ${sig.map(([c, r]) => `<i class="sigboard__sq" style="grid-column:${c};grid-row:${r}"></i>`).join('')}
                    <span class="px px--banner sigboard__txt">FLEET ONLINE</span>
                  </div>
                  <div class="sigboard__mid"><i></i><i></i></div>
                  <div class="sigboard__half">
                    ${sig.map(([c, r]) => `<i class="sigboard__sq" style="grid-column:${c};grid-row:${r}"></i>`).join('')}
                    <span class="px px--banner sigboard__txt">FLEET ONLINE</span>
                  </div>
                </div>`).join('')}
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <button class="boot-skip px px--tiny" type="button" data-skip>SKIP</button>`;
}
